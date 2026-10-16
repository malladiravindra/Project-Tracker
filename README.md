# Project Tracker

An executive dashboard for projects, tasks, deadlines and team workload.

| Folder | What it is |
|---|---|
| `frontend/` | Next.js 16 / React 19 / Tailwind 4 app |
| `backend/` | Django 5 + Django REST Framework API, SQLite (`backend/db.sqlite3`) |
| `empty.txt` | Frontend audit and backend specification (fields, rules, endpoints, test results, open decisions) |

The two apps run separately. The frontend talks to the backend only through the REST API under `/api/v1/`.

## Requirements, database setup and the first administrator

- Python 3.12+ (tested on 3.14), Node.js 20+ (tested on 24) with npm 10+. Install with `pip install -r backend/requirements.txt` and `npm install` in `frontend/`.
- Database: SQLite by default (`backend/db.sqlite3`, local only). Set `DATABASE_URL` (PostgreSQL, e.g. Neon) in `backend/.env` to use a real server. Credentials come only from the environment; see `backend/.env.example`.
- Create or update tables: `python manage.py migrate` (run from `backend/`). `python manage.py makemigrations --check` should report no changes.
- Create the first administrator (idempotent; the password is stored as a salted PBKDF2 hash and never printed):

  ```bash
  # Option 1: prompt for the password (hidden)
  python manage.py ensure_admin --username <admin-username>
  # Option 2: from the environment (placeholders; choose your own values)
  INITIAL_ADMIN_USERNAME=<admin-username> INITIAL_ADMIN_PASSWORD=<strong-password> python manage.py ensure_admin
  ```

  If the username already exists nothing is changed. `--reset-password` replaces only that account's password. Change any initial password before a production deployment. Django superusers always have the Admin role.
- All data (members, projects, tasks, decisions, daily updates, activity) is stored by the Django API in the configured database; the frontend keeps only the sign-in tokens in `sessionStorage` and the theme in `localStorage`.
- Tests: `python manage.py test` (backend, from `backend/`; set `DJANGO_DOTENV_FILE=/nonexistent` to force the throwaway SQLite test setup instead of your `.env` database), and in `frontend/`: `npm test`, `npm run lint`, `npx tsc --noEmit`, and `NEXT_PUBLIC_API_URL=<api url> npm run build` (the production build requires that variable).
- Known limitation: `npm install` prints an ESLint 9 deprecation notice. ESLint 9 is in maintenance; ESLint 10 is blocked until `eslint-plugin-react`, `-jsx-a11y` and `-import` (pulled in by `eslint-config-next`) declare support for it.

## Run the backend (http://127.0.0.1:8000)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # optional for local development
python manage.py migrate        # creates backend/db.sqlite3
python manage.py runserver
```

`python manage.py ...` runs in **development** mode (debug on, localhost only, CORS for `localhost:3000`).
Anything else that loads the settings (gunicorn, uvicorn, wsgi/asgi) runs in **production** mode and
**refuses to start** unless `DJANGO_SECRET_KEY` (random, 50+ characters), `DJANGO_ALLOWED_HOSTS`,
`CORS_ALLOWED_ORIGINS` (https only), `DATABASE_URL` (PostgreSQL; SQLite is local-only) and
`DJANGO_ACKNOWLEDGE_NO_AUTH=true` are set. See `backend/.env.example`.
`DJANGO_TIME_ZONE` (default `Asia/Kolkata`) decides what "today" means for overdue / due-today logic; the frontend
follows the server's time zone, not the browser's.

Tests (they use a throw-away test database, never `db.sqlite3`):

```bash
cd backend
python manage.py test
DJANGO_ENV=production python manage.py check --deploy   # set the production variables first (see .env.example)
```

The database starts empty. Add people first (Team tab), then projects and tasks.

## Run the frontend (http://localhost:3000)

```bash
cd frontend
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=https://django-ten-ruby.vercel.app (or http://127.0.0.1:8000)
npm ci
npm run dev
```

`NEXT_PUBLIC_API_URL` (the backend origin, no `/api`) is read at build time, so set it before `npm run build` too.
Start the backend first; the dashboard shows an error with a Retry button when the API is unreachable.
Other commands: `npm run lint`, `npx tsc --noEmit`, `npm test` (Node's built-in test runner, no extra packages), `npm run build`.

## API overview

All endpoints are under `/api/`: `members/`, `projects/` (with `history/`, `tasks/`, `members/`, `objectives/`, `decision/`;
`?detail=1` on the list), `tasks/` (with `complete/`), `dashboard/*`, `today/`, `weekly-brief/`, `activity/`.
Errors are JSON: `{"error": {"code", "message", "fields"}}`. A URL that only lacks its trailing slash is redirected with `308`.
The full endpoint, field and validation reference is in `empty.txt`.

## Security status

The API requires a JWT and enforces roles (see "Login" below). Earlier notes in `empty.txt` describe the old, open API.

### Login (JWT authentication and roles)

Every `/api/` endpoint requires `Authorization: Bearer <access token>`. **Public endpoints (the only ones):**
`POST /api/auth/token/` (login) and `POST /api/auth/token/refresh/`. Both are rate-limited. There is no health endpoint.

- `POST /api/auth/token/` with `{"username", "password"}` returns `{"access", "refresh"}` (access lasts
  `JWT_ACCESS_MINUTES`, default 15; refresh lasts `JWT_REFRESH_DAYS`, default 7).
- `POST /api/auth/token/refresh/` with `{"refresh"}` returns a new access token and rotates the refresh token (the old
  one is revoked). `POST /api/auth/logout/` (with the access token) revokes a refresh token. `GET /api/auth/me/` shows
  the verified username, role and member id.
- Roles live on the server (Django admin: User > "Project Tracker role"), never in the request.
  **admin**: everything. **manager**: read everything, manage projects/tasks/decisions/teams, edit employees (cannot
  create or delete them). **member** (an employee, linked to their Member record): sees only their own projects and
  the tasks in them, may change the status/note of their own tasks and share their own daily updates; no dashboards,
  reports, activity, directory or decision notes. A login with no role gets 403.
- Create the first admin with `python manage.py createsuperuser`, then add users and roles in `/admin/`.
- The existing frontend has no login screen and does not send a token, so it receives 401 until it is updated to call
  `/api/auth/token/` and send the Bearer header. Response formats are unchanged.

### Required access control if the API is ever made anonymous

(Only relevant with `DJANGO_API_REQUIRE_AUTH=false`.)

`DJANGO_ACKNOWLEDGE_NO_AUTH=true` does **not** secure anything. It is a deliberate statement by the operator that
access to the API has **already been restricted outside the app and verified**. Until then, leave it unset (the
production build then refuses to start, which is intended). Acceptable external controls: Vercel Deployment
Protection / Password Protection on the production domain, a VPN, an IP allow-list, or an authenticating reverse proxy.
Verify with an unauthenticated request (`curl -i https://<domain>/api/members/` must NOT return data).

## Deploying to Vercel

The backend and the frontend are **two separate Vercel projects** from this one repository.

### Backend project (Django)

Vercel's Django support finds `manage.py`, reads `WSGI_APPLICATION` from the settings and builds one function; no
`vercel.json` or `api/` folder is needed. Static files (admin CSS) are collected and served by Vercel.

- **Framework Preset:** Django. **Root Directory:** `backend`. Build, Install and Output commands: leave at the defaults.
- **Deployment Protection:** turn Vercel Authentication **off** for this project. JWT is the access control, and
  Vercel's login page would block the frontend's requests.
- **Environment variables** (Settings > Environment Variables, Production; local `backend/.env` is never deployed):
  `DJANGO_ENV=production`, `DJANGO_SECRET_KEY` (random, 50+ characters), `DATABASE_URL` (PostgreSQL, `sslmode=require`),
  `DJANGO_ALLOWED_HOSTS` (the backend domain, no `*`), `CORS_ALLOWED_ORIGINS` (`https://<frontend domain>`),
  `CSRF_TRUSTED_ORIGINS` (optional, https only), `DJANGO_BEHIND_PROXY=true`. Optional: `JWT_ACCESS_MINUTES`,
  `JWT_REFRESH_DAYS`, `JWT_SIGNING_KEY`, `DJANGO_THROTTLE_WRITE|READ|AUTH`.
  Do **not** set `DJANGO_DEBUG` (ignored in production) or `DJANGO_ACKNOWLEDGE_NO_AUTH`.
- **Database:** before the first deploy run `cd backend && python manage.py migrate` against the production
  `DATABASE_URL` (set in your shell only, never committed), then `python manage.py createsuperuser`, then assign roles
  in `/admin/`.
- **After a deploy:** `/` returns a Django 404 (there is no root route), `/admin/login/` returns 200,
  `/api/members/` returns 401 JSON without a token, and `POST /api/auth/token/` with real credentials returns tokens.
  Vercel's own "NOT_FOUND" page means the request never reached Django (check Root Directory and the build log).

### Frontend project (Next.js)

Root Directory `frontend`, Next.js preset, `NEXT_PUBLIC_API_URL=https://<backend domain>` (origin only; `/api` is added by the app). The frontend needs a
login screen that calls `/api/auth/token/` and sends the Bearer token before it can show data.
