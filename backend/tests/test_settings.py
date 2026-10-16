"""Production-configuration safety. Each case imports config.settings in a fresh interpreter with a controlled
environment, because settings are evaluated once at import time."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
GOOD_KEY = "k8s-Zp3vQx9LmN2rT7wYb4HdF6gJ1cA5eU0oIiKsXn8Rt3yV2zPq"  # 50+ chars, many distinct characters, test only

PROBE = (
    "import json, config.settings as s;"
    "print(json.dumps({k: getattr(s, k, None) for k in ('ENVIRONMENT','DEBUG','ALLOWED_HOSTS','CORS_ALLOWED_ORIGINS',"
    "'SECURE_SSL_REDIRECT','SESSION_COOKIE_SECURE','CSRF_COOKIE_SECURE','SECURE_HSTS_SECONDS','SECURE_PROXY_SSL_HEADER')}))"
)


def load_settings(extra_env, argv0="-c"):
    """Import config.settings with only the given environment (no inherited DJANGO_*/CORS_* variables)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DJANGO_", "CORS_"))}
    env.pop("DATABASE_URL", None)
    env["DJANGO_DOTENV_FILE"] = os.devnull  # a developer's backend/.env must not leak into these isolated checks
    env.update(extra_env)
    env["PYTHONPATH"] = str(BACKEND)
    code = f"import sys; sys.argv[0] = {argv0!r};" + PROBE
    with tempfile.TemporaryDirectory() as cwd:
        return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, cwd=cwd, timeout=60)


PROD = {
    "DJANGO_ENV": "production",
    "DJANGO_SECRET_KEY": GOOD_KEY,
    "DJANGO_ALLOWED_HOSTS": "tracker.example.org",
    "CORS_ALLOWED_ORIGINS": "https://tracker.example.org",
    "DATABASE_URL": "postgresql://user:pass@db.example.org:5432/tracker?sslmode=require",
}


class ProductionSettingsTests(unittest.TestCase):
    def assert_refuses(self, env, fragment, argv0="-c"):
        result = load_settings(env, argv0)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("ConfigurationError", result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertNotIn(GOOD_KEY, result.stderr)  # never echo secrets

    def test_valid_production_configuration_loads_and_is_hardened(self):
        result = load_settings(PROD)
        self.assertEqual(result.returncode, 0, result.stderr)
        s = json.loads(result.stdout)
        self.assertEqual(s["ENVIRONMENT"], "production")
        self.assertFalse(s["DEBUG"])
        self.assertEqual(s["ALLOWED_HOSTS"], ["tracker.example.org"])
        self.assertTrue(s["SECURE_SSL_REDIRECT"])
        self.assertTrue(s["SESSION_COOKIE_SECURE"] and s["CSRF_COOKIE_SECURE"])
        self.assertGreater(s["SECURE_HSTS_SECONDS"], 0)
        self.assertIsNone(s["SECURE_PROXY_SSL_HEADER"])

    def test_default_without_any_environment_is_production_and_fails_safely(self):
        # No DJANGO_ENV at all (e.g. started by gunicorn/wsgi): must NOT fall back to debug/dev settings.
        self.assert_refuses({}, "DJANGO_SECRET_KEY")

    def test_missing_or_weak_secret_key(self):
        for key in (None, "", "short", "dev-only-insecure-key-change-me", "django-insecure-" + "x1y2z3" * 10, "a" * 60):
            env = {k: v for k, v in PROD.items() if k != "DJANGO_SECRET_KEY"}
            if key is not None:
                env["DJANGO_SECRET_KEY"] = key
            with self.subTest(key=(key or "")[:8]):
                self.assert_refuses(env, "DJANGO_SECRET_KEY")

    def test_debug_is_always_off_in_production(self):
        for value in ("true", "1", "yes", "on", "false", ""):
            with self.subTest(value=value):
                result = load_settings({**PROD, "DJANGO_DEBUG": value})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(json.loads(result.stdout)["DEBUG"])
        self.assertIn("ignored in production", load_settings({**PROD, "DJANGO_DEBUG": "true"}).stderr)

    def test_allowed_hosts_required_and_no_wildcard(self):
        env = {k: v for k, v in PROD.items() if k != "DJANGO_ALLOWED_HOSTS"}
        self.assert_refuses(env, "DJANGO_ALLOWED_HOSTS")
        self.assert_refuses({**PROD, "DJANGO_ALLOWED_HOSTS": "*"}, "DJANGO_ALLOWED_HOSTS")
        self.assert_refuses({**PROD, "DJANGO_ALLOWED_HOSTS": "good.example.org,*"}, "DJANGO_ALLOWED_HOSTS")

    def test_cors_origins_required_and_https_only(self):
        env = {k: v for k, v in PROD.items() if k != "CORS_ALLOWED_ORIGINS"}
        self.assert_refuses(env, "CORS_ALLOWED_ORIGINS")
        self.assert_refuses({**PROD, "CORS_ALLOWED_ORIGINS": "http://localhost:3000"}, "CORS_ALLOWED_ORIGINS")

    def test_authenticated_api_needs_no_acknowledgement(self):
        self.assertEqual(load_settings(PROD).returncode, 0)

    def test_secret_key_alias_and_vercel_hosts(self):
        env = {k: v for k, v in PROD.items() if k not in ("DJANGO_SECRET_KEY", "DJANGO_ALLOWED_HOSTS")}
        result = load_settings({**env, "SECRET_KEY": GOOD_KEY, "VERCEL_URL": "my-app-abc123.vercel.app"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["ALLOWED_HOSTS"], ["my-app-abc123.vercel.app"])

    def test_csrf_trusted_origins_are_https_only(self):
        self.assert_refuses({**PROD, "CSRF_TRUSTED_ORIGINS": "http://app.example.org"}, "CSRF_TRUSTED_ORIGINS")
        self.assert_refuses({**PROD, "CSRF_TRUSTED_ORIGINS": "https://*.example.org"}, "CSRF_TRUSTED_ORIGINS")
        self.assertEqual(load_settings({**PROD, "CSRF_TRUSTED_ORIGINS": "https://app.example.org"}).returncode, 0)

    def test_jwt_settings_are_validated_in_production(self):
        self.assert_refuses({**PROD, "JWT_SIGNING_KEY": "too-short"}, "JWT_SIGNING_KEY")
        self.assert_refuses({**PROD, "JWT_ACCESS_MINUTES": "100000"}, "JWT_ACCESS_MINUTES")
        self.assert_refuses({**PROD, "JWT_REFRESH_DAYS": "0"}, "JWT_REFRESH_DAYS")
        self.assertEqual(load_settings({**PROD, "JWT_SIGNING_KEY": GOOD_KEY, "JWT_ACCESS_MINUTES": "10"}).returncode, 0)

    def test_open_api_must_be_acknowledged_explicitly(self):
        open_api = {**PROD, "DJANGO_API_REQUIRE_AUTH": "false"}
        self.assert_refuses(open_api, "DJANGO_ACKNOWLEDGE_NO_AUTH")
        self.assert_refuses({**open_api, "DJANGO_ACKNOWLEDGE_NO_AUTH": "false"}, "DJANGO_ACKNOWLEDGE_NO_AUTH")
        self.assertEqual(load_settings({**open_api, "DJANGO_ACKNOWLEDGE_NO_AUTH": "true"}).returncode, 0)

    def test_production_refuses_sqlite(self):
        env = {k: v for k, v in PROD.items() if k != "DATABASE_URL"}
        self.assert_refuses(env, "DATABASE_URL")

    def test_all_problems_are_reported_together(self):
        result = load_settings({"DJANGO_ENV": "production"})
        for fragment in ("DJANGO_SECRET_KEY", "DJANGO_ALLOWED_HOSTS", "CORS_ALLOWED_ORIGINS", "DATABASE_URL"):
            self.assertIn(fragment, result.stderr)

    def test_invalid_environment_name(self):
        self.assert_refuses({"DJANGO_ENV": "staging"}, "DJANGO_ENV")

    def test_proxy_header_is_opt_in(self):
        result = load_settings({**PROD, "DJANGO_BEHIND_PROXY": "true"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["SECURE_PROXY_SSL_HEADER"], ["HTTP_X_FORWARDED_PROTO", "https"])

    def test_ssl_redirect_can_be_disabled_explicitly_only(self):
        result = load_settings({**PROD, "DJANGO_SSL_REDIRECT": "false"})
        self.assertFalse(json.loads(result.stdout)["SECURE_SSL_REDIRECT"])


class DevelopmentSettingsTests(unittest.TestCase):
    def test_manage_py_defaults_to_development_without_configuration(self):
        result = load_settings({}, argv0="manage.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        s = json.loads(result.stdout)
        self.assertEqual(s["ENVIRONMENT"], "development")
        self.assertTrue(s["DEBUG"])
        self.assertEqual(s["ALLOWED_HOSTS"], ["127.0.0.1", "localhost"])
        self.assertEqual(s["CORS_ALLOWED_ORIGINS"], ["http://localhost:3000", "http://127.0.0.1:3000"])
        self.assertIsNone(s["SECURE_SSL_REDIRECT"])  # production hardening is not applied in development

    def test_explicit_environment_overrides_the_manage_py_default(self):
        result = load_settings({"DJANGO_ENV": "production"}, argv0="manage.py")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ConfigurationError", result.stderr)

    def test_the_running_test_process_is_in_development(self):
        from django.conf import settings

        self.assertEqual(settings.ENVIRONMENT, "development")
