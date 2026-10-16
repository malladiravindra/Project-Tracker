"""JWT authentication, role-based permissions and object-level access.

The shared ApiTestCase signs in an admin with force_authenticate (so the other test modules exercise the API as an
admin). Every test here instead uses a REAL token obtained from /api/auth/token/ or built by simplejwt, and sends it
in the Authorization header, exactly as the frontend will.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from members.models import Member, Role, UserProfile
from projects.models import Project
from tasks.models import Task
from updates.models import DailyUpdate

from .support import API, ApiTestCase, day, make_user

PASSWORD = "a-long-test-pw-123"

# Every read-only endpoint outside the per-record routes (staff-only unless noted).
STAFF_READ_PATHS = [
    "/members/", "/members/departments/", "/activity/", "/dashboard/summary/", "/dashboard/attention/",
    "/dashboard/key-dates/", "/dashboard/team-workload/", "/dashboard/decisions/", "/decision-history/", "/weekly-brief/",
]
SHARED_READ_PATHS = ["/projects/", "/tasks/", "/daily-updates/", "/today/", "/auth/me/"]


def bearer(client, token):
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


def token_for(user):
    return str(AccessToken.for_user(user))


class JwtApiCase(ApiTestCase):
    """ApiTestCase without the automatic admin sign-in: requests carry only the credentials a test gives them."""

    def setUp(self):
        self.client.force_authenticate(None)
        self.anon = APIClient()

    def as_user(self, user):
        client = APIClient()
        return bearer(client, token_for(user))


class AnonymousAndBadTokenTests(JwtApiCase):
    def setUp(self):
        super().setUp()
        self.person = self.member(name="Private Person")
        self.proj = self.project(name="Private Project", lead=self.person)
        self.work = self.task(project=self.proj)
        self.admin = make_user("boss", Role.ADMIN)

    def all_paths(self):
        return STAFF_READ_PATHS + SHARED_READ_PATHS[:-2] + [
            f"/members/{self.person.id}/", f"/projects/{self.proj.id}/", f"/projects/{self.proj.id}/tasks/",
            f"/projects/{self.proj.id}/members/", f"/projects/{self.proj.id}/history/", f"/tasks/{self.work.id}/",
        ]

    def test_no_token_gives_401_on_every_protected_read(self):
        for path in self.all_paths() + ["/today/", "/auth/me/"]:
            with self.subTest(path=path):
                res = self.anon.get(f"{API}{path}")
                self.assertEqual(res.status_code, 401, path)
                self.assertIn("Bearer", res["WWW-Authenticate"])
                self.assertNotIn("Private", res.content.decode())

    def test_no_token_gives_401_on_every_write(self):
        calls = [
            ("post", "/members/", {"name": "X"}), ("patch", f"/members/{self.person.id}/", {"title": "X"}),
            ("delete", f"/members/{self.person.id}/", None), ("post", "/projects/", {"name": "X"}),
            ("patch", f"/projects/{self.proj.id}/", {"name": "X"}), ("delete", f"/projects/{self.proj.id}/", None),
            ("post", "/tasks/", {"title": "X"}), ("patch", f"/tasks/{self.work.id}/", {"title": "X"}),
            ("delete", f"/tasks/{self.work.id}/", None), ("post", f"/tasks/{self.work.id}/complete/", {}),
            ("post", "/daily-updates/", {}), ("post", f"/projects/{self.proj.id}/decision/resolve/", {"outcome": "Approved"}),
            ("post", "/auth/logout/", {"refresh": "x"}),
        ]
        for method, path, body in calls:
            with self.subTest(method=method, path=path):
                res = getattr(self.anon, method)(f"{API}{path}", body, format="json") if body is not None else getattr(self.anon, method)(f"{API}{path}")
                self.assertEqual(res.status_code, 401)
        self.assertTrue(Member.objects.filter(pk=self.person.pk).exists())
        self.assertTrue(Task.objects.filter(pk=self.work.pk).exists())

    def test_garbage_and_tampered_tokens_are_rejected(self):
        good = token_for(self.admin)
        header, payload, signature = good.split(".")
        tampered = f"{header}.{payload}.{signature[:-4]}AAAA"
        for token in ("not-a-jwt", "a.b.c", "", tampered):
            with self.subTest(token=token[:12]):
                res = bearer(APIClient(), token).get(f"{API}/members/")
                self.assertEqual(res.status_code, 401)

    def test_token_signed_with_another_key_is_rejected(self):
        import jwt

        forged = jwt.encode({"user_id": str(self.admin.pk), "token_type": "access", "exp": 4102444800, "jti": "x"}, "attacker-key" * 6, algorithm="HS256")
        self.assertEqual(bearer(APIClient(), forged).get(f"{API}/members/").status_code, 401)

    def test_unsigned_alg_none_token_is_rejected(self):
        import base64
        import json

        def b64(d):
            return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

        forged = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'user_id': str(self.admin.pk), 'token_type': 'access', 'exp': 4102444800, 'jti': 'y'})}."
        self.assertEqual(bearer(APIClient(), forged).get(f"{API}/members/").status_code, 401)

    def test_expired_token_is_rejected(self):
        token = AccessToken.for_user(self.admin)
        token.set_exp(from_time=timezone.now() - timedelta(hours=1), lifetime=timedelta(minutes=1))
        self.assertEqual(bearer(APIClient(), str(token)).get(f"{API}/members/").status_code, 401)

    def test_refresh_token_cannot_be_used_as_an_access_token(self):
        refresh = str(RefreshToken.for_user(self.admin))
        self.assertEqual(bearer(APIClient(), refresh).get(f"{API}/members/").status_code, 401)

    def test_token_of_a_deactivated_user_is_rejected(self):
        token = token_for(self.admin)
        get_user_model().objects.filter(pk=self.admin.pk).update(is_active=False)
        self.assertEqual(bearer(APIClient(), token).get(f"{API}/members/").status_code, 401)

    def test_user_ids_or_roles_in_the_request_are_ignored(self):
        member_user = make_user("emp", Role.MEMBER, member=self.person)
        client = self.as_user(member_user)
        res = client.get(f"{API}/members/", HTTP_X_USER_ID=str(self.admin.pk), HTTP_X_ROLE="admin")
        self.assertEqual(res.status_code, 403)
        self.assertEqual(client.get(f"{API}/members/?role=admin&user_id={self.admin.pk}").status_code, 403)


class LoginAndRefreshTests(JwtApiCase):
    def setUp(self):
        super().setUp()
        self.user = make_user("alice", Role.MANAGER, password=PASSWORD)

    def login(self, username="alice", password=PASSWORD):
        return self.anon.post(f"{API}/auth/token/", {"username": username, "password": password}, format="json")

    def test_login_with_valid_credentials_issues_tokens_that_work(self):
        res = self.login()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(set(res.json()), {"access", "refresh"})
        me = bearer(APIClient(), res.json()["access"]).get(f"{API}/auth/me/")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], "alice")
        self.assertEqual(me.json()["role"], "manager")

    def test_wrong_password_unknown_user_and_inactive_user_get_no_token(self):
        get_user_model().objects.create_user("gone", password=PASSWORD, is_active=False)
        for username, password in (("alice", "wrong"), ("nobody", PASSWORD), ("gone", PASSWORD)):
            with self.subTest(username=username):
                res = self.login(username, password)
                self.assertEqual(res.status_code, 401)
                self.assertNotIn("access", res.json())

    def test_blank_credentials_are_rejected(self):
        res = self.login("alice", "")
        self.assertEqual(res.status_code, 400)
        self.assertNotIn("access", res.json())

    def test_refresh_issues_a_new_access_token_and_rotates_the_refresh_token(self):
        tokens = self.login().json()
        res = self.anon.post(f"{API}/auth/token/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(bearer(APIClient(), res.json()["access"]).get(f"{API}/auth/me/").status_code, 200)
        # the old refresh token was blacklisted by rotation: it works only once
        again = self.anon.post(f"{API}/auth/token/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(again.status_code, 401)

    def test_refresh_rejects_invalid_and_access_tokens(self):
        tokens = self.login().json()
        for token in ("garbage", tokens["access"]):
            res = self.anon.post(f"{API}/auth/token/refresh/", {"refresh": token}, format="json")
            self.assertEqual(res.status_code, 401)

    def test_logout_revokes_the_refresh_token(self):
        tokens = self.login().json()
        client = bearer(APIClient(), tokens["access"])
        self.assertEqual(client.post(f"{API}/auth/logout/", {"refresh": tokens["refresh"]}, format="json").status_code, 204)
        res = self.anon.post(f"{API}/auth/token/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(res.status_code, 401)

    def test_cannot_log_out_someone_elses_refresh_token(self):
        other = make_user("bob", Role.MANAGER, password=PASSWORD)
        theirs = str(RefreshToken.for_user(other))
        res = self.as_user(self.user).post(f"{API}/auth/logout/", {"refresh": theirs}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.anon.post(f"{API}/auth/token/refresh/", {"refresh": theirs}, format="json").status_code, 200)

    def test_login_is_rate_limited(self):
        codes = [self.login("alice", "wrong").status_code for _ in range(12)]
        self.assertIn(429, codes)
        self.assertEqual(self.login().status_code, 429)  # even the right password waits out the limit


class PublicEndpointTests(JwtApiCase):
    def test_there_is_no_health_endpoint(self):
        self.assertEqual(self.anon.get(f"{API}/health/").status_code, 404)

    def test_login_and_refresh_are_reachable_without_a_token(self):
        self.assertEqual(self.anon.post(f"{API}/auth/token/", {}, format="json").status_code, 400)
        self.assertEqual(self.anon.post(f"{API}/auth/token/refresh/", {}, format="json").status_code, 400)

    def test_unknown_api_paths_stay_a_json_404(self):
        self.assertEqual(self.anon.get(f"{API}/nothing-here/").status_code, 404)


class RoleTests(JwtApiCase):
    """admin / manager / team member, with two projects: the employee is only on the first."""

    def setUp(self):
        super().setUp()
        self.alice = self.member(name="Alice Employee")
        self.bob = self.member(name="Bob Colleague")
        self.carol = self.member(name="Carol Outsider")
        self.p1 = self.project(name="Alpha", lead=self.bob)
        self.p2 = self.project(name="Beta", lead=self.carol)
        from projects.models import ProjectMember

        ProjectMember.objects.create(project=self.p1, member=self.alice, role="Team Member")
        self.mine = self.task(project=self.p1, owner=self.alice, title="Alice task")
        self.teammates = self.task(project=self.p1, owner=self.bob, title="Bob task in my project")
        self.hidden = self.task(project=self.p2, owner=self.carol, title="Carol hidden task")
        self.emp = make_user("alice", Role.MEMBER, member=self.alice)
        self.mgr = make_user("manager", Role.MANAGER)
        self.adm = make_user("admin", Role.ADMIN)
        self.emp_c, self.mgr_c, self.adm_c = (self.as_user(u) for u in (self.emp, self.mgr, self.adm))

    # ---- staff roles
    def test_staff_roles_can_read_everything(self):
        for client in (self.mgr_c, self.adm_c):
            for path in STAFF_READ_PATHS + SHARED_READ_PATHS:
                with self.subTest(path=path):
                    self.assertEqual(client.get(f"{API}{path}").status_code, 200, path)
            self.assertEqual(len(client.get(f"{API}/projects/").json()["results"]), 2)

    def test_manager_can_manage_projects_and_tasks_but_not_create_or_delete_employees(self):
        res = self.mgr_c.post(f"{API}/projects/", {"name": "Gamma", "lead_id": self.bob.id, "start_date": day(0).isoformat(), "end_date": day(30).isoformat()}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self.mgr_c.patch(f"{API}/tasks/{self.hidden.id}/", {"title": "Renamed"}, format="json").status_code, 200)
        self.assertEqual(self.mgr_c.post(f"{API}/members/", {"name": "New"}, format="json").status_code, 403)
        self.assertEqual(self.mgr_c.delete(f"{API}/members/{self.alice.id}/").status_code, 403)
        self.assertEqual(self.mgr_c.patch(f"{API}/members/{self.alice.id}/", {"title": "Senior"}, format="json").status_code, 200)

    def test_only_admin_can_create_and_delete_employees(self):
        body = {"name": "New Person", "title": "T", "department": "D", "email": "n@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}
        self.assertEqual(self.adm_c.post(f"{API}/members/", body, format="json").status_code, 201)
        spare = self.member(name="Spare")
        self.assertEqual(self.adm_c.delete(f"{API}/members/{spare.id}/").status_code, 204)

    def test_superuser_is_an_admin_without_a_profile(self):
        root = get_user_model().objects.create_superuser("root", password=PASSWORD)
        self.assertEqual(self.as_user(root).get(f"{API}/auth/me/").json()["role"], "admin")
        self.assertEqual(self.as_user(root).get(f"{API}/members/").status_code, 200)

    def test_user_without_a_role_gets_nothing(self):
        user = get_user_model().objects.create_user("norole", password=PASSWORD)
        client = self.as_user(user)
        for path in STAFF_READ_PATHS + SHARED_READ_PATHS[:-1]:
            with self.subTest(path=path):
                self.assertEqual(client.get(f"{API}{path}").status_code, 403)

    # ---- employee: reads are scoped to their own projects and records
    def test_employee_sees_only_their_projects_and_tasks(self):
        projects = self.emp_c.get(f"{API}/projects/").json()["results"]
        self.assertEqual([p["name"] for p in projects], ["Alpha"])
        titles = {t["title"] for t in self.emp_c.get(f"{API}/tasks/?status=all").json()["results"]}
        self.assertEqual(titles, {"Alice task", "Bob task in my project"})

    def test_employee_task_counts_do_not_leak_other_projects(self):
        counts = self.emp_c.get(f"{API}/tasks/").json()["counts"]
        staff_counts = self.adm_c.get(f"{API}/tasks/").json()["counts"]
        self.assertLess(sum(counts.values()), sum(staff_counts.values()))

    def test_employee_cannot_open_another_project_or_its_data(self):
        for path in (f"/projects/{self.p2.id}/", f"/projects/{self.p2.id}/tasks/", f"/projects/{self.p2.id}/members/", f"/tasks/{self.hidden.id}/"):
            with self.subTest(path=path):
                self.assertEqual(self.emp_c.get(f"{API}{path}").status_code, 404)
        self.assertEqual(self.emp_c.get(f"{API}/projects/{self.p1.id}/").status_code, 200)
        self.assertEqual(self.emp_c.get(f"{API}/projects/{self.p1.id}/tasks/").status_code, 200)

    def test_employee_does_not_see_the_manager_decision_note(self):
        Project.objects.filter(pk=self.p1.pk).update(decision="Confidential decision")
        self.assertNotIn("Confidential", self.emp_c.get(f"{API}/projects/{self.p1.id}/").content.decode())
        self.assertNotIn("Confidential", self.emp_c.get(f"{API}/projects/").content.decode())
        self.assertIn("Confidential", self.mgr_c.get(f"{API}/projects/{self.p1.id}/").content.decode())

    def test_employee_is_denied_reports_directory_and_activity(self):
        for path in STAFF_READ_PATHS + [f"/projects/{self.p1.id}/history/"]:
            with self.subTest(path=path):
                self.assertEqual(self.emp_c.get(f"{API}{path}").status_code, 403, path)

    def test_employee_can_read_only_their_own_member_record(self):
        self.assertEqual(self.emp_c.get(f"{API}/members/{self.alice.id}/").status_code, 200)
        self.assertEqual(self.emp_c.get(f"{API}/members/{self.bob.id}/").status_code, 404)

    # ---- employee: writes
    def test_employee_can_update_status_and_note_of_their_own_task(self):
        res = self.emp_c.patch(f"{API}/tasks/{self.mine.id}/", {"state": "in-progress", "note": "started"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.mine.refresh_from_db()
        self.assertEqual((self.mine.state, self.mine.note), ("in-progress", "started"))
        self.assertEqual(self.emp_c.post(f"{API}/tasks/{self.mine.id}/complete/").status_code, 200)

    def test_employee_cannot_change_other_fields_of_their_task(self):
        for body in ({"title": "Hijacked"}, {"owner_id": self.bob.id}, {"priority": "High"}, {"state": "done", "title": "x"}):
            with self.subTest(body=body):
                self.assertEqual(self.emp_c.patch(f"{API}/tasks/{self.mine.id}/", body, format="json").status_code, 403)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.title, "Alice task")

    def test_employee_cannot_modify_a_colleagues_or_hidden_task(self):
        self.assertEqual(self.emp_c.patch(f"{API}/tasks/{self.teammates.id}/", {"state": "done"}, format="json").status_code, 403)
        self.assertEqual(self.emp_c.post(f"{API}/tasks/{self.teammates.id}/complete/").status_code, 403)
        self.assertEqual(self.emp_c.patch(f"{API}/tasks/{self.hidden.id}/", {"state": "done"}, format="json").status_code, 404)
        self.assertEqual(self.emp_c.post(f"{API}/tasks/{self.hidden.id}/complete/").status_code, 404)
        for task in (self.teammates, self.hidden):
            task.refresh_from_db()
            self.assertNotEqual(task.state, "done")

    def test_employee_cannot_create_or_delete_anything_structural(self):
        calls = [
            ("post", "/projects/", {"name": "X"}), ("patch", f"/projects/{self.p1.id}/", {"name": "X"}),
            ("delete", f"/projects/{self.p1.id}/", None), ("post", "/tasks/", {"title": "X"}),
            ("delete", f"/tasks/{self.mine.id}/", None), ("post", "/members/", {"name": "X"}),
            ("patch", f"/members/{self.alice.id}/", {"title": "CEO"}, ), ("delete", f"/members/{self.alice.id}/", None),
            ("post", f"/projects/{self.p1.id}/members/", {"member_id": self.carol.id}),
            ("post", f"/projects/{self.p1.id}/objectives/", {"description": "X"}),
            ("post", f"/projects/{self.p1.id}/decision/resolve/", {"outcome": "Approved"}),
        ]
        for method, path, body in calls:
            with self.subTest(method=method, path=path):
                client = self.emp_c
                res = client.delete(f"{API}{path}") if method == "delete" else getattr(client, method)(f"{API}{path}", body, format="json")
                self.assertEqual(res.status_code, 403)
        self.assertTrue(Project.objects.filter(pk=self.p1.pk).exists())
        self.assertTrue(Task.objects.filter(pk=self.mine.pk).exists())
        self.assertEqual(Member.objects.get(pk=self.alice.pk).title, "Engineer")

    def test_employee_with_no_linked_member_record_sees_nothing(self):
        orphan = self.as_user(make_user("orphan", Role.MEMBER))
        self.assertEqual(orphan.get(f"{API}/projects/").json()["results"], [])
        self.assertEqual(orphan.get(f"{API}/tasks/?status=all").json()["results"], [])
        self.assertEqual(orphan.get(f"{API}/daily-updates/").json()["results"], [])

    # ---- daily updates
    def _update(self, member, project):
        return DailyUpdate.objects.create(employee=member, project=project, date=day(0), completed=["x"])

    def test_employee_sees_and_edits_only_their_own_daily_updates(self):
        mine, theirs = self._update(self.alice, self.p1), self._update(self.bob, self.p1)
        rows = self.emp_c.get(f"{API}/daily-updates/").json()
        self.assertEqual([r["id"] for r in rows["results"]], [mine.id])
        self.assertEqual(self.emp_c.get(f"{API}/daily-updates/{mine.id}/").status_code, 200)
        self.assertEqual(self.emp_c.get(f"{API}/daily-updates/{theirs.id}/").status_code, 404)
        self.assertEqual(self.emp_c.patch(f"{API}/daily-updates/{theirs.id}/", {"notes": "x"}, format="json").status_code, 404)
        self.assertEqual(self.emp_c.patch(f"{API}/daily-updates/{mine.id}/", {"review_status": "reviewed"}, format="json").status_code, 403)
        self.assertEqual(self.emp_c.post(f"{API}/daily-updates/{mine.id}/feedback/", {"type": "comment", "content": "x"}, format="json").status_code, 403)
        self.assertEqual(self.mgr_c.get(f"{API}/daily-updates/").json()["count"], 2)

    def test_employee_cannot_post_an_update_for_someone_else(self):
        body = {"employee_id": self.bob.id, "project_id": self.p1.id, "date": day(0).isoformat(), "completed": ["x"]}
        self.assertEqual(self.emp_c.post(f"{API}/daily-updates/", body, format="json").status_code, 403)
        self.assertEqual(DailyUpdate.objects.count(), 0)
        body["employee_id"] = self.alice.id
        self.assertEqual(self.emp_c.post(f"{API}/daily-updates/", body, format="json").status_code, 201)
