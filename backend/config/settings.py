"""Django settings for the Project Tracker API."""

import os
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines); real environment variables win.

    Local development convenience only: on Vercel there is no .env file (it is git-ignored and never deployed);
    production values come from the Vercel dashboard's Environment Variables.
    """
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if value[:1] in ("'", '"') and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()  # inline comment after an unquoted value
        os.environ.setdefault(key.strip(), value)


# DJANGO_DOTENV_FILE lets the test-suite point at a non-existent file so a developer's .env cannot leak in.
_load_dotenv(Path(os.environ.get("DJANGO_DOTENV_FILE", BASE_DIR / ".env")))


def _env_list(name: str, default: str = "") -> list[str]:
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes", "on")


class ConfigurationError(RuntimeError):
    """Production configuration is missing or unsafe; refuse to start rather than run insecurely."""


# --- Environment -----------------------------------------------------------------------------------------
# Safe by default: anything that is not `manage.py` (gunicorn/uvicorn/wsgi/asgi, a bare import) is PRODUCTION
# unless DJANGO_ENV says otherwise. Running `python manage.py ...` on a developer machine defaults to
# development so `runserver` and the tests work without any configuration.
_default_env = "development" if Path(sys.argv[0]).name == "manage.py" else "production"
ENVIRONMENT = os.environ.get("DJANGO_ENV", _default_env).strip().lower()
if ENVIRONMENT not in ("development", "production"):
    raise ConfigurationError("DJANGO_ENV must be 'development' or 'production'.")
PRODUCTION = ENVIRONMENT == "production"

# Production NEVER runs with DEBUG, whatever DJANGO_DEBUG says (a stray DJANGO_DEBUG=true copied from the local
# .env into a hosting dashboard must not expose tracebacks and settings). A truthy value is reported, not obeyed.
if PRODUCTION:
    DEBUG = False
    if _env_bool("DJANGO_DEBUG", False):
        print("WARNING: DJANGO_DEBUG is set to true but is ignored in production; remove it from the environment.", file=sys.stderr)
else:
    DEBUG = _env_bool("DJANGO_DEBUG", default=True)

# --- API authentication --------------------------------------------------------------------------------------
# The API is private: JWT bearer tokens (`Authorization: Bearer <access token>`) plus role-based permissions
# (common/access.py). DJANGO_API_REQUIRE_AUTH=false removes both and makes the API anonymous; production then refuses
# to start unless DJANGO_ACKNOWLEDGE_NO_AUTH=true (access restricted outside the app and verified).
API_REQUIRE_AUTH = _env_bool("DJANGO_API_REQUIRE_AUTH", True)
API_AUTHENTICATION_CLASSES = ["rest_framework_simplejwt.authentication.JWTAuthentication"] if API_REQUIRE_AUTH else []
API_PERMISSION_CLASSES = ["common.access.RolePermission"] if API_REQUIRE_AUTH else ["rest_framework.permissions.AllowAny"]
# The production check below looks at what is actually configured, not at a flag: the API counts as protected only if
# a token authenticator is installed and the default permission is not AllowAny.
API_IS_PROTECTED = (
    "rest_framework_simplejwt.authentication.JWTAuthentication" in API_AUTHENTICATION_CLASSES
    and not any(p.endswith("AllowAny") for p in API_PERMISSION_CLASSES)
    and bool(API_PERMISSION_CLASSES)
)

# JWT lifetimes and signing. Tokens are signed with JWT_SIGNING_KEY if set, otherwise with DJANGO_SECRET_KEY. Both must
# stay in the environment; changing the key invalidates every issued token.
JWT_ACCESS_MINUTES = int(os.environ.get("JWT_ACCESS_MINUTES", "15"))
JWT_REFRESH_DAYS = int(os.environ.get("JWT_REFRESH_DAYS", "7"))
JWT_SIGNING_KEY = os.environ.get("JWT_SIGNING_KEY", "").strip()

_DEV_SECRET = "dev-only-insecure-key-change-me"
# SECRET_KEY (unprefixed) is accepted as an alias for DJANGO_SECRET_KEY; the prefixed name wins.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or os.environ.get("SECRET_KEY") or ("" if PRODUCTION else _DEV_SECRET)
ALLOWED_HOSTS = _env_list("DJANGO_ALLOWED_HOSTS", "" if PRODUCTION else "127.0.0.1,localhost")
# Vercel exposes this deployment's own exact host names (no scheme); they are allowed in addition to the list above.
# No wildcard such as ".vercel.app" is added: that would accept the host name of any other Vercel site.
for _name in ("VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"):
    _host = os.environ.get(_name, "").strip().lower()
    if _host and _host not in ALLOWED_HOSTS:
        ALLOWED_HOSTS.append(_host)
# Comma-separated, scheme included (https://app.example.org): origins allowed to POST to Django's own forms (admin).
CSRF_TRUSTED_ORIGINS = _env_list("CSRF_TRUSTED_ORIGINS", "")
CORS_ALLOWED_ORIGINS = _env_list(
    "CORS_ALLOWED_ORIGINS", "" if PRODUCTION else "http://localhost:3000,http://127.0.0.1:3000"
)

if PRODUCTION:
    problems = []
    if DEBUG:  # defensive: unreachable while DEBUG is forced off above
        problems.append("DJANGO_DEBUG must not be true in production")
    if len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5 or SECRET_KEY == _DEV_SECRET or SECRET_KEY.startswith("django-insecure"):
        problems.append("DJANGO_SECRET_KEY must be set to a random value of at least 50 characters")
    if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:
        problems.append("DJANGO_ALLOWED_HOSTS must list the real host names (no '*')")
    if any(not o.startswith("https://") or "*" in o for o in CSRF_TRUSTED_ORIGINS):
        problems.append("CSRF_TRUSTED_ORIGINS must list https:// origins only (no wildcards)")
    if not CORS_ALLOWED_ORIGINS or any(not o.startswith("https://") for o in CORS_ALLOWED_ORIGINS):
        problems.append("CORS_ALLOWED_ORIGINS must list the https:// origin(s) of the frontend")
    # Only applies when DJANGO_API_REQUIRE_AUTH=false: that API has NO authentication, every endpoint can read and modify all data. This flag does
    # not secure anything; it is a deliberate operator statement that access has ALREADY been restricted outside
    # the app (e.g. Vercel Deployment Protection / Password Protection on the public domain, a VPN, an IP
    # allow-list or an authenticating reverse proxy) and that this was verified. Never set it just to get past
    # this check. See README "Deploying to Vercel".
    if not API_IS_PROTECTED and not _env_bool("DJANGO_ACKNOWLEDGE_NO_AUTH", False):
        problems.append(
            "the API has no authentication (every endpoint is open to anyone who can reach it): restrict access "
            "outside the app first (Vercel Deployment Protection, VPN, firewall or an authenticating proxy), verify "
            "it from an unauthenticated client, and only then set DJANGO_ACKNOWLEDGE_NO_AUTH=true"
        )
    if JWT_SIGNING_KEY and len(JWT_SIGNING_KEY) < 50:
        problems.append("JWT_SIGNING_KEY, when set, must be a random value of at least 50 characters")
    if not 1 <= JWT_ACCESS_MINUTES <= 60 or not 1 <= JWT_REFRESH_DAYS <= 30:
        problems.append("JWT_ACCESS_MINUTES must be 1-60 and JWT_REFRESH_DAYS must be 1-30")
    if not os.environ.get("DATABASE_URL", "").strip() and os.environ.get("DJANGO_DB_ENGINE", "sqlite").strip().lower() != "postgresql":
        problems.append(
            "production requires PostgreSQL: set DATABASE_URL (SQLite is for local development only; serverless "
            "file systems are ephemeral and read-only)"
        )
    if problems:
        raise ConfigurationError("Unsafe or incomplete production configuration: " + "; ".join(problems) + ".")

    # HTTPS and cookie hardening. Set DJANGO_BEHIND_PROXY=true when a TLS-terminating proxy forwards
    # X-Forwarded-Proto; DJANGO_HSTS_SECONDS can be raised once HTTPS is confirmed to work.
    SECURE_SSL_REDIRECT = _env_bool("DJANGO_SSL_REDIRECT", True)
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "3600"))
    SECURE_CONTENT_TYPE_NOSNIFF = True
    if _env_bool("DJANGO_BEHIND_PROXY", False):
        SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",  # lets logout and refresh rotation revoke refresh tokens
    "common",
    "members",
    "projects",
    "tasks",
    "activity",
    "dashboard",
    "updates",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",  # serves /static/ (admin CSS) from the function
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# SQLite by default (local development). PostgreSQL is selected by EITHER:
#   - DATABASE_URL (postgres://user:password@host:port/name?sslmode=require): what Vercel's database integrations
#     (Neon, Supabase, ...) inject automatically; or
#   - DJANGO_DB_ENGINE=postgresql plus DJANGO_DB_NAME / _USER / _PASSWORD / _HOST / _PORT (environment only).
# DATABASE_URL wins when both are set. psycopg is in requirements.txt.
_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if _DATABASE_URL:
    _db = urlparse(_DATABASE_URL)
    if _db.scheme not in ("postgres", "postgresql"):
        raise ConfigurationError("DATABASE_URL must be a postgres:// or postgresql:// URL.")
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": unquote(_db.path.lstrip("/")),
            "USER": unquote(_db.username or ""),
            "PASSWORD": unquote(_db.password or ""),
            "HOST": _db.hostname or "",
            "PORT": str(_db.port or ""),
            "OPTIONS": {k: v[0] for k, v in parse_qs(_db.query).items() if k in ("sslmode", "channel_binding")},
        }
    }
elif os.environ.get("DJANGO_DB_ENGINE", "sqlite").strip().lower() == "postgresql":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ.get("DJANGO_DB_NAME", "project_tracker"),
            "USER": os.environ.get("DJANGO_DB_USER", ""),
            "PASSWORD": os.environ.get("DJANGO_DB_PASSWORD", ""),
            "HOST": os.environ.get("DJANGO_DB_HOST", "localhost"),
            "PORT": os.environ.get("DJANGO_DB_PORT", "5432"),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": os.environ.get("DJANGO_DB_PATH", BASE_DIR / "db.sqlite3"),
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-gb"

# "Today" for overdue / due-today / key-date logic is the calendar date in this zone.
TIME_ZONE = os.environ.get("DJANGO_TIME_ZONE", "Asia/Kolkata")
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
# collectstatic target (Vercel runs it at build time and serves the files from its CDN; needed for the /admin/ styling).
STATIC_ROOT = BASE_DIR / "staticfiles"
# Serve static files straight from the apps' static dirs (no collectstatic step is needed on Vercel's Python function).
WHITENOISE_USE_FINDERS = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# CORS_ALLOWED_ORIGINS is defined with the environment settings above.

REST_FRAMEWORK = {
    # Private API: a valid JWT and an allowed role are required for every endpoint (see API_* above, common/access.py).
    # The only anonymous views opt out explicitly in common/auth_views.py (login, refresh).
    "DEFAULT_AUTHENTICATION_CLASSES": API_AUTHENTICATION_CLASSES,
    "DEFAULT_PERMISSION_CLASSES": API_PERMISSION_CLASSES,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "UNAUTHENTICATED_USER": None,
    "EXCEPTION_HANDLER": "common.exceptions.api_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": ["common.throttling.WriteRateThrottle", "common.throttling.ReadRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "write": os.environ.get("DJANGO_THROTTLE_WRITE", "120/min"),
        "read": os.environ.get("DJANGO_THROTTLE_READ", "600/min"),
        "auth": os.environ.get("DJANGO_THROTTLE_AUTH", "10/min"),  # login and token refresh, per client address
    },
    # 0 = trust only REMOTE_ADDR; raise it only when that many trusted reverse proxies sit in front (see throttling.py).
    "NUM_PROXIES": int(os.environ.get("DJANGO_NUM_PROXIES", "0")),
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=JWT_ACCESS_MINUTES),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=JWT_REFRESH_DAYS),
    "ROTATE_REFRESH_TOKENS": True,  # every refresh issues a new refresh token ...
    "BLACKLIST_AFTER_ROTATION": True,  # ... and revokes the old one, so a stolen refresh token is usable once at most
    "UPDATE_LAST_LOGIN": False,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": JWT_SIGNING_KEY or SECRET_KEY,
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# Server-side logging: errors and the API's own warnings go to the console (stderr). Request bodies, tokens and
# personal data are never logged by this configuration; the "api" logger records only the view and exception type.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "loggers": {
        "api": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False},
    },
}
