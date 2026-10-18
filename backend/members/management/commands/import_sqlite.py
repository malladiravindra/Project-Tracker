"""Copy application data from a local SQLite file into the configured (default) database, without touching anything there.

    python manage.py import_sqlite backups/sqlite-copy.sqlite3            # DRY RUN: reads both, writes nothing
    python manage.py import_sqlite backups/sqlite-copy.sqlite3 --apply    # inserts inside ONE transaction

Rules (safe to re-run):
  - Rows are inserted with their original primary keys, in foreign-key order (members, projects, memberships,
    objectives, decision records, tasks, activity, daily updates, feedback).
  - A row whose id is already in the target is NEVER updated or deleted: if its content is identical it counts as
    "already present", otherwise it is a CONFLICT. Case-insensitive unique name/email clashes are conflicts too.
  - Any conflict or dangling foreign key aborts the whole run before anything is written.
  - Django's own tables, auth users, sessions and tokens are not copied (users need an approved reconciliation plan).
  - PostgreSQL id sequences are advanced past the imported ids afterwards.
The SQLite file is opened read-only. Passwords and connection strings are never printed.
"""

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, connection, connections, models, transaction

SRC = "sqlite_src"
# (app_label.ModelName, ...) in dependency order; the first four cover everything that exists today.
MODELS = [
    "members.Member",
    "projects.Project",
    "projects.ProjectMember",
    "projects.ProjectObjective",
    "activity.ActivityLog",
    "projects.DecisionRecord",
    "tasks.Task",
    "updates.DailyUpdate",
    "updates.Feedback",
]


def _register_source(path: Path) -> None:
    connections.databases[SRC] = {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": f"file:{path.as_posix()}?mode=ro",
        "OPTIONS": {"uri": True},
        "ATOMIC_REQUESTS": False,
        "AUTOCOMMIT": True,
        "CONN_MAX_AGE": 0,
        "CONN_HEALTH_CHECKS": False,
        "TIME_ZONE": None,
        "USER": "", "PASSWORD": "", "HOST": "", "PORT": "",
        "TEST": {},
    }


def _snapshot(obj) -> dict:
    return {f.attname: getattr(obj, f.attname) for f in obj._meta.concrete_fields}


class Command(BaseCommand):
    help = "Copy application rows from a SQLite file into the default database (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("sqlite_path")
        parser.add_argument("--apply", action="store_true", help="Write the rows (default: report only).")

    def handle(self, *args, sqlite_path, apply, **opts):
        path = Path(sqlite_path).resolve()
        if not path.is_file():
            raise CommandError(f"SQLite file not found: {path}")
        _register_source(path)

        from django.apps import apps

        # created_at/updated_at must keep their original values, not "now" (auto_now_add runs inside bulk_create).
        for label in MODELS:
            for f in apps.get_model(label)._meta.concrete_fields:
                if isinstance(f, models.DateTimeField | models.DateField):
                    f.auto_now = f.auto_now_add = False

        self.stdout.write(f"Target: {connection.vendor} database '{connection.settings_dict['NAME']}' (host not shown)")
        plan, problems = [], []
        src_ids, dst_ids = {}, {}
        for label in MODELS:
            model = apps.get_model(label)
            try:
                rows = list(model.objects.using(SRC).order_by("pk"))
            except DatabaseError as exc:  # table absent in the source
                self.stdout.write(f"  {label}: not in source ({type(exc).__name__}); skipped")
                continue
            existing = {o.pk: o for o in model.objects.using("default").filter(pk__in=[r.pk for r in rows])}
            src_ids[label] = {r.pk for r in rows}
            dst_ids[label] = set(model.objects.using("default").values_list("pk", flat=True))
            new, same = [], 0
            for r in rows:
                cur = existing.get(r.pk)
                if cur is None:
                    new.append(r)
                elif _snapshot(cur) == _snapshot(r):
                    same += 1
                else:
                    problems.append(f"{label} id={r.pk}: id exists in target with different content")
            plan.append((model, label, new))
            self.stdout.write(f"  {label}: source={len(rows)} new={len(new)} already-identical={same}")

        # Case-insensitive unique name/email among new members vs target and each other.
        from members.models import Member

        seen_names = {n.lower() for n in Member.objects.values_list("name", flat=True)}
        seen_mail = {e.lower() for e in Member.objects.values_list("email", flat=True) if e}
        for model, label, new in plan:
            if model is Member:
                for m in new:
                    if m.name.lower() in seen_names:
                        problems.append(f"members.Member id={m.pk}: name already used (case-insensitive)")
                    if m.email and m.email.lower() in seen_mail:
                        problems.append(f"members.Member id={m.pk}: email already used (case-insensitive)")
                    seen_names.add(m.name.lower())
                    seen_mail.add(m.email.lower())

        # Dangling foreign keys: every referenced id must exist in the target already or arrive in this run.
        for model, label, new in plan:
            for f in model._meta.concrete_fields:
                if not f.is_relation or f.related_model._meta.label not in MODELS:
                    continue
                target_label = f.related_model._meta.label
                ok = src_ids.get(target_label, set()) | dst_ids.get(target_label, set())
                for r in new:
                    v = getattr(r, f.attname)
                    if v is not None and v not in ok:
                        problems.append(f"{label} id={r.pk}: {f.name}={v} references a missing {target_label}")

        if problems:
            self.stdout.write(self.style.ERROR(f"{len(problems)} problem(s); nothing written:"))
            for p in problems:
                self.stdout.write(f"  - {p}")
            raise CommandError("Resolve the conflicts above; no rows were written.")

        total = sum(len(n) for _, _, n in plan)
        if not apply:
            self.stdout.write(self.style.SUCCESS(f"Dry run OK: {total} row(s) would be inserted, no conflicts. Re-run with --apply."))
            return

        with transaction.atomic(using="default"):
            for model, label, new in plan:
                if new:
                    model.objects.using("default").bulk_create(new)
            if connection.vendor == "postgresql":
                with connection.cursor() as cur:
                    for sql in connection.ops.sequence_reset_sql(self.style, [m for m, _, _ in plan]):
                        cur.execute(sql)
        self.stdout.write(self.style.SUCCESS(f"Applied: {total} row(s) inserted in one transaction; sequences reset."))
