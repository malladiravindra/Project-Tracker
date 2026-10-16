import os
from io import StringIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from rest_framework.test import APIClient

PW = "Setup-Pass-731!"  # test-only value


def run(**env):
    out = StringIO()
    with mock.patch.dict(os.environ, env, clear=False):
        call_command("ensure_admin", stdout=out)
    return out.getvalue()


class EnsureAdminTests(TestCase):
    def test_creates_hashed_superuser_and_can_log_in_over_the_api(self):
        out = run(INITIAL_ADMIN_USERNAME="Boss", INITIAL_ADMIN_PASSWORD=PW)
        self.assertNotIn(PW, out)
        user = get_user_model().objects.get(username="Boss")
        self.assertTrue(user.is_superuser)
        self.assertNotIn(PW, user.password)
        self.assertTrue(user.password.startswith("pbkdf2_"))
        c = APIClient()
        ok = c.post("/api/auth/token/", {"username": "Boss", "password": PW}, format="json")
        self.assertEqual(ok.status_code, 200)
        c.credentials(HTTP_AUTHORIZATION="Bearer " + ok.data["access"])
        self.assertEqual(c.get("/api/auth/me/").data["role"], "admin")
        bad = APIClient().post("/api/auth/token/", {"username": "Boss", "password": "wrong"}, format="json")
        self.assertEqual(bad.status_code, 401)

    def test_protected_resource_requires_login(self):
        self.assertEqual(APIClient().get("/api/projects/").status_code, 401)

    def test_rerun_is_idempotent_and_keeps_existing_password(self):
        run(INITIAL_ADMIN_USERNAME="Boss", INITIAL_ADMIN_PASSWORD=PW)
        out = run(INITIAL_ADMIN_USERNAME="Boss", INITIAL_ADMIN_PASSWORD="Different-Pass-912!")
        self.assertIn("nothing changed", out)
        self.assertEqual(get_user_model().objects.filter(username="Boss").count(), 1)
        self.assertTrue(get_user_model().objects.get(username="Boss").check_password(PW))

    def test_reset_password_flag_replaces_only_the_password(self):
        run(INITIAL_ADMIN_USERNAME="Boss", INITIAL_ADMIN_PASSWORD=PW)
        with mock.patch.dict(os.environ, {"INITIAL_ADMIN_USERNAME": "Boss", "INITIAL_ADMIN_PASSWORD": "Different-Pass-912!"}):
            call_command("ensure_admin", "--reset-password", stdout=StringIO())
        u = get_user_model().objects.get(username="Boss")
        self.assertTrue(u.check_password("Different-Pass-912!"))
        self.assertTrue(u.is_superuser)

    def test_rejects_weak_password_and_missing_username(self):
        with self.assertRaises(CommandError):
            run(INITIAL_ADMIN_USERNAME="Boss", INITIAL_ADMIN_PASSWORD="123")
        self.assertFalse(get_user_model().objects.filter(username="Boss").exists())
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("INITIAL_ADMIN_USERNAME", None)
            with self.assertRaises(CommandError):
                call_command("ensure_admin", stdout=StringIO())
