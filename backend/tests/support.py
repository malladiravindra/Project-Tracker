"""Test helpers: build records with dates relative to today, like the frontend's offsets."""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from members.models import Member, Role, UserProfile
from projects.models import LEAD_ROLE, Project, ProjectMember
from tasks.models import Task

API = "/api"  # every endpoint is under /api/: /api/members/, /api/tasks/, ...


def make_user(username, role, member=None, password=None):
    """A login with a role (and, for the Team member role, the employee record it belongs to)."""
    user = get_user_model().objects.create_user(username, password=password, is_staff=False)
    UserProfile.objects.create(user=user, role=role, member=member)
    return user


def day(offset: int):
    return timezone.localdate() + timedelta(days=offset)


class ApiTestCase(APITestCase):
    def _pre_setup(self):
        super()._pre_setup()
        cache.clear()  # throttle counters live in the cache; every test starts with a clean slate
        # The API requires login: every test acts as this signed-in user unless it calls self.client.force_authenticate(None).
        self.user = make_user("tester", Role.ADMIN)
        self.client.force_authenticate(self.user)

    def member(self, name="Test Person", title="Engineer", department="Engineering", load=60):
        return Member.objects.create(name=name, title=title, department=department, load=load)

    def project(self, lead=None, name="Test Project", start=-10, end=10, progress=0, **extra):
        lead = lead or self.member(name=f"Lead of {name}")
        project = Project.objects.create(
            name=name, lead=lead, start_date=day(start), end_date=day(end), progress=progress, **extra
        )
        ProjectMember.objects.create(project=project, member=lead, role=LEAD_ROLE)
        return project

    def task(self, project=None, owner=None, title="Do it", due=1, state="not-started", note="", **extra):
        project = project or self.project()
        owner = owner or project.lead
        return Task.objects.create(
            title=title, project=project, owner=owner, due_date=None if due is None else day(due), state=state, note=note, **extra
        )

    def get(self, path, **params):
        return self.client.get(f"{API}{path}", params, format="json")

    def post(self, path, data=None):
        return self.client.post(f"{API}{path}", data or {}, format="json")

    def patch(self, path, data):
        return self.client.patch(f"{API}{path}", data, format="json")

    def delete(self, path):
        return self.client.delete(f"{API}{path}")
