"""Throttling, database-conflict handling, safe 500s and lost-update protection."""

from unittest import mock

from django.db import IntegrityError
from django.db.models import ProtectedError
from django.test import override_settings
from rest_framework.test import APIClient
from rest_framework.throttling import SimpleRateThrottle

from tests.support import API, ApiTestCase, day
from members.models import Member
from projects.models import Project
from tasks.models import Task


class ThrottleTests(ApiTestCase):
    def rates(self, write, read):
        return mock.patch.object(SimpleRateThrottle, "THROTTLE_RATES", {"write": write, "read": read})

    def test_default_limits_do_not_get_in_the_way_of_a_dashboard_refresh(self):
        # One dashboard load is about 15 GETs; ten refreshes in a row must all succeed under the real defaults.
        for _ in range(10):
            for path in ("/members/", "/projects/", "/tasks/", "/activity/", "/dashboard/summary/", "/today/"):
                self.assertEqual(self.get(path).status_code, 200)
        self.assertEqual(self.post("/members/", {"name": "A", "title": "T", "department": "D", "email": "a@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}).status_code, 201)

    def test_writes_are_limited_with_429_retry_after_and_json_envelope(self):
        with self.rates("3/min", "600/min"):
            for n in range(3):
                self.assertEqual(self.post("/members/", {"name": f"P{n}", "title": "T", "department": "D", "email": f"p{n}@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}).status_code, 201)
            res = self.post("/members/", {"name": "P9", "title": "T", "department": "D", "email": "p9@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"})
            self.assertEqual(res.status_code, 429)
            self.assertEqual(res.json()["error"]["code"], "throttled")
            self.assertIn("Retry-After", res)
            self.assertEqual(Member.objects.count(), 3, "a throttled write must not be executed")
            # all write methods share the bucket
            self.assertEqual(self.patch("/members/1/", {"load": 10}).status_code, 429)
            self.assertEqual(self.delete("/members/1/").status_code, 429)
            # reads have their own bucket and keep working
            self.assertEqual(self.get("/members/").status_code, 200)

    def test_reads_are_limited_separately(self):
        with self.rates("120/min", "4/min"):
            for _ in range(4):
                self.assertEqual(self.get("/today/").status_code, 200)
            self.assertEqual(self.get("/today/").status_code, 429)
            self.assertEqual(self.post("/members/", {"name": "A", "title": "T", "department": "D", "email": "a@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}).status_code, 201)

    def test_forwarded_for_header_cannot_be_used_to_dodge_the_limit(self):
        with self.rates("2/min", "600/min"):
            for n in range(2):
                self.client.post(f"{API}/members/", {"name": f"P{n}", "title": "T", "department": "D", "email": f"p{n}@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}, format="json", HTTP_X_FORWARDED_FOR=f"10.0.0.{n}")
            res = self.client.post(f"{API}/members/", {"name": "P9", "title": "T", "department": "D", "email": "p9@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}, format="json", HTTP_X_FORWARDED_FOR="10.9.9.9")
            self.assertEqual(res.status_code, 429)

    def test_validation_errors_count_towards_the_limit_too(self):
        with self.rates("2/min", "600/min"):
            self.assertEqual(self.post("/members/", {}).status_code, 400)
            self.assertEqual(self.post("/members/", {}).status_code, 400)
            self.assertEqual(self.post("/members/", {}).status_code, 429)


class ErrorHandlingTests(ApiTestCase):
    def test_database_conflict_on_create_is_a_409_not_a_500(self):
        with mock.patch.object(Member.objects, "create", side_effect=IntegrityError("UNIQUE constraint failed: secret_value")):
            with self.assertLogs("api", level="WARNING") as logs:
                res = self.post("/members/", {"name": "Racer", "title": "T", "department": "D", "email": "racer@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"})
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["error"]["code"], "conflict")
        self.assertNotIn("secret_value", res.content.decode(), "database text must not reach the client")
        self.assertNotIn("secret_value", "\n".join(logs.output), "database text must not be logged")
        self.assertIn("IntegrityError", logs.output[0])
        self.assertFalse(Member.objects.filter(name="Racer").exists())

    def test_protected_relation_conflict_is_a_409(self):
        person = self.member(name="Removable")
        with mock.patch.object(Member, "delete", side_effect=ProtectedError("protected", [])):
            res = self.delete(f"/members/{person.id}/")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["error"]["code"], "conflict")

    def test_programming_errors_are_not_swallowed_and_never_leak_details(self):
        client = APIClient(raise_request_exception=False)
        client.force_authenticate(self.user)
        with override_settings(DEBUG=False):
            with mock.patch("members.views.MemberListView.get", side_effect=RuntimeError("internal-secret-detail")):
                with self.assertLogs("django.request", level="ERROR") as logs:
                    res = client.get(f"{API}/members/")
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res["Content-Type"], "application/json")
        body = res.content.decode()
        self.assertIn("server_error", body)
        self.assertNotIn("internal-secret-detail", body)
        self.assertNotIn("Traceback", body)
        self.assertTrue(any("internal-secret-detail" in line for line in logs.output), "the error must still be logged server-side")

    def test_malformed_input_never_reaches_a_500(self):
        for path in ("/members/", "/projects/", "/tasks/", "/daily-updates/"):
            for body, ctype in (("{", "application/json"), ("[]", "application/json"), ("null", "application/json"), ("\x00", "application/json")):
                res = self.client.post(f"{API}{path}", body, content_type=ctype)
                self.assertIn(res.status_code, (400, 415), (path, body, res.status_code))
        for path in ("/members/", "/projects/", "/tasks/", "/activity/", "/decision-history/", "/daily-updates/"):
            for query in ("limit=%00", "offset=9999999999999999999999", "q=%E2%82%AC" + "x" * 5000, "project=1e9", "month=%ff"):
                res = self.client.get(f"{API}{path}?{query}")
                self.assertLess(res.status_code, 500, (path, query, res.status_code))


class LostUpdateTests(ApiTestCase):
    """A PATCH writes only the fields it was given, so an edit made to another field between the read and the write
    (by another request) is not undone. The interleaving is forced by editing the row inside the validation step."""

    def interleave(self, serializer, **elsewhere_changes_model):
        model, pk, changes = elsewhere_changes_model["model"], elsewhere_changes_model["pk"], elsewhere_changes_model["changes"]
        original = serializer.is_valid

        def is_valid(self_, *a, **kw):
            result = original(self_, *a, **kw)
            model.objects.filter(pk=pk).update(**changes)  # "another request" commits in the middle
            return result

        return mock.patch.object(serializer, "is_valid", is_valid)

    def test_task_patch_keeps_a_concurrent_change_to_another_field(self):
        from tasks.serializers import TaskUpdateSerializer

        t = self.task(title="Original", due=3)
        with self.interleave(TaskUpdateSerializer, model=Task, pk=t.pk, changes={"title": "Changed elsewhere"}):
            self.assertEqual(self.patch(f"/tasks/{t.id}/", {"priority": "High"}).status_code, 200)
        t.refresh_from_db()
        self.assertEqual((t.priority, t.title), ("High", "Changed elsewhere"))

    def test_member_patch_keeps_a_concurrent_change_to_another_field(self):
        from members.serializers import MemberWriteSerializer

        m = self.member(name="Pat", load=50)
        with self.interleave(MemberWriteSerializer, model=Member, pk=m.pk, changes={"title": "Changed elsewhere"}):
            self.assertEqual(self.patch(f"/members/{m.id}/", {"load": 80}).status_code, 200)
        m.refresh_from_db()
        self.assertEqual((m.load, m.title), (80, "Changed elsewhere"))

    def test_project_patch_keeps_a_concurrent_change_to_another_field(self):
        from projects.serializers import ProjectUpdateSerializer

        p = self.project(name="Proj", progress=10)
        with self.interleave(ProjectUpdateSerializer, model=Project, pk=p.pk, changes={"description": "Changed elsewhere"}):
            self.assertEqual(self.patch(f"/projects/{p.id}/", {"progress": 40}).status_code, 200)
        p.refresh_from_db()
        self.assertEqual((p.progress, p.description), (40, "Changed elsewhere"))

    def test_updated_at_still_moves_on_patch(self):
        t = self.task()
        before = Task.objects.get(pk=t.pk).updated_at
        self.patch(f"/tasks/{t.id}/", {"due_date": day(9).isoformat()})
        self.assertGreater(Task.objects.get(pk=t.pk).updated_at, before)
