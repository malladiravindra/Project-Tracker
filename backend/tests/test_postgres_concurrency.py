"""Concurrency tests that need a real multi-connection database (PostgreSQL).

They are SKIPPED on SQLite (the default), where writers are serialised by the file lock, so a lost-update or
duplicate-record race cannot be reproduced and a pass would prove nothing. To run them:

    pip install "psycopg[binary]"
    export DJANGO_DB_ENGINE=postgresql DJANGO_DB_NAME=... DJANGO_DB_USER=... DJANGO_DB_PASSWORD=... DJANGO_DB_HOST=localhost
    python manage.py test tests.test_postgres_concurrency

(Django creates and drops a separate `test_<name>` database; the real database is not touched.)
As of the last review these tests had NOT been executed anywhere: no PostgreSQL server or driver was available.
"""

import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from django.db import connection, connections
from django.test import TransactionTestCase

from rest_framework.test import APIClient

from tests.support import API, day, make_user
from members.models import Member, Role
from projects.models import DecisionRecord, LEAD_ROLE, Project, ProjectMember
from tasks.models import Task
from updates.models import DailyUpdate

IS_POSTGRES = connection.vendor == "postgresql"


def race(calls):
    """Run the callables at the same moment on separate threads/connections; return their results in order."""
    barrier = threading.Barrier(len(calls))

    def run(call):
        try:
            barrier.wait(timeout=10)
            return call()
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return [f.result(timeout=60) for f in [pool.submit(run, c) for c in calls]]


@unittest.skipUnless(IS_POSTGRES, "needs PostgreSQL (see module docstring); not run on SQLite")
class PostgresConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = make_user("tester", Role.ADMIN)
        self.lead = Member.objects.create(name="Lead", title="T", department="D")
        self.project = Project.objects.create(name="P", lead=self.lead, start_date=day(-10), end_date=day(10))
        ProjectMember.objects.create(project=self.project, member=self.lead, role=LEAD_ROLE)

    def client_call(self, method, path, data=None):
        def call():
            c = APIClient()
            c.force_authenticate(self.user)
            return getattr(c, method)(f"{API}{path}", data or {}, format="json").status_code

        return call

    def test_two_identical_daily_updates_create_exactly_one(self):
        body = {"employee_id": self.lead.id, "project_id": self.project.id, "date": day(0).isoformat(), "completed": ["x"]}
        codes = sorted(race([self.client_call("post", "/daily-updates/", body)] * 2))
        self.assertEqual(codes, [201, 409])
        self.assertEqual(DailyUpdate.objects.count(), 1)

    def test_two_identical_member_names_create_exactly_one(self):
        body = {"name": "Same Name", "title": "T", "department": "D", "email": "same@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}
        codes = sorted(race([self.client_call("post", "/members/", body)] * 2))
        self.assertEqual(codes, [201, 409])  # the loser hits the unique constraint: 409, never 500
        self.assertEqual(Member.objects.filter(name="Same Name").count(), 1)

    def test_a_decision_is_resolved_once(self):
        Project.objects.filter(pk=self.project.pk).update(decision="Approve it")
        path = f"/projects/{self.project.id}/decision/resolve/"
        codes = sorted(race([self.client_call("post", path, {"outcome": "Approved"})] * 3))
        self.assertEqual(codes, [200, 400, 400])
        self.assertEqual(DecisionRecord.objects.count(), 1)

    def test_a_resolution_is_undone_once(self):
        Project.objects.filter(pk=self.project.pk).update(decision="Approve it")
        authed = APIClient()
        authed.force_authenticate(self.user)
        resolved = authed.post(f"{API}/projects/{self.project.id}/decision/resolve/", {"outcome": "Approved"}, format="json")
        path = f"/projects/{self.project.id}/decision/undo/"
        codes = sorted(race([self.client_call("post", path, {"activity_id": resolved.data["activity_id"]})] * 3))
        self.assertEqual(codes, [200, 404, 404])
        self.assertEqual(DecisionRecord.objects.count(), 0)

    def test_concurrent_patches_of_different_fields_are_both_kept(self):
        task = Task.objects.create(title="T", project=self.project, owner=self.lead, due_date=day(3))
        calls = [self.client_call("patch", f"/tasks/{task.id}/", {"priority": "High"}), self.client_call("patch", f"/tasks/{task.id}/", {"title": "Renamed"})]
        self.assertEqual(race(calls), [200, 200])
        task.refresh_from_db()
        self.assertEqual((task.priority, task.title), ("High", "Renamed"))
