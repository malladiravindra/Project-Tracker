"""Dashboard calculations, computed from database records on every call.

All functions take `on` (the calendar date) so tests can pin "today".
"""

from datetime import timedelta

from members.models import Member
from projects import rules as project_rules
from projects.models import Project
from tasks import rules as task_rules
from tasks.models import Task

KEY_DATE_DAYS = 30
BRIEF_KEY_DATE_DAYS = 14
DUE_SOON_DAYS = 7


def _projects():
    return list(Project.objects.select_related("lead").order_by("id"))


def _tasks():
    return sorted(Task.objects.select_related("project", "owner"), key=task_rules.sort_key)


def summary(on) -> dict:
    projects, tasks = _projects(), _tasks()
    health = [project_rules.health(p, on) for p in projects]
    buckets = [task_rules.bucket(t, on) for t in tasks]
    not_started = health.count("not-started")
    return {
        "total": len(projects),
        "in_flight": len(projects) - not_started,
        "not_started": not_started,
        "off_track": health.count("off-track"),
        "watch": health.count("watch"),
        "on_track": health.count("on-track"),
        "overdue": buckets.count("overdue"),
        "due_today": buckets.count("today"),
        "blocked": buckets.count("blocked"),
        "stretched": Member.objects.filter(load__gt=100).count(),
    }


def _plural(n, word):
    suffix = "" if n == 1 else "s"
    return f"{n} {word}{suffix}"


def _project_item(p, status, on, overdue_by_project):
    overdue = overdue_by_project.get(p.id, 0)
    overdue_text = f"{_plural(overdue, 'task')} overdue" if overdue else ""
    used = project_rules.time_used(p, on)
    if status == "off-track":
        subtitle = f"Behind schedule: {p.progress}% done with {used}% of the time used."
        if overdue_text:
            subtitle += f" {overdue_text}"
    else:
        subtitle = overdue_text or f"{p.progress}% done with {used}% of the time used"
    return {
        "key": f"p-{p.id}",
        "marker": "square-red" if status == "off-track" else "triangle-amber",
        "title": p.name,
        "subtitle": subtitle,
        "label": "Off track" if status == "off-track" else "Needs watching",
        "ref": {"kind": "project", "id": p.id},
    }


def _task_item(t, marker, on):
    return {
        "key": f"t-{t.id}",
        "marker": marker,
        "title": t.title,
        "subtitle": " · ".join(x for x in [t.owner.name, t.project.name, t.note] if x),
        "label": task_rules.due_label(t, on),
        "ref": {"kind": "task", "id": t.id},
    }


def attention(on) -> list:
    """Off-track projects, overdue tasks (earliest first), blocked tasks, watch projects, due today."""
    projects, tasks = _projects(), _tasks()
    status = {p.id: project_rules.health(p, on) for p in projects}
    by_bucket = {}
    for t in tasks:
        by_bucket.setdefault(task_rules.bucket(t, on), []).append(t)
    overdue_by_project = {}
    for t in by_bucket.get("overdue", []):
        overdue_by_project[t.project_id] = overdue_by_project.get(t.project_id, 0) + 1
    return [
        *[_project_item(p, "off-track", on, overdue_by_project) for p in projects if status[p.id] == "off-track"],
        *[_task_item(t, "dot-red", on) for t in by_bucket.get("overdue", [])],
        *[_task_item(t, "dot-purple", on) for t in by_bucket.get("blocked", [])],
        *[_project_item(p, "watch", on, overdue_by_project) for p in projects if status[p.id] == "watch"],
        *[_task_item(t, "dot-orange", on) for t in by_bucket.get("today", [])],
    ]


def key_dates(on, within_days=KEY_DATE_DAYS) -> list:
    """Project deadlines (today..N days) and starts (tomorrow..N days), soonest first."""
    rows = []
    for p in _projects():
        end = project_rules.end_offset(p, on)
        start = project_rules.start_offset(p, on)
        if end is not None and 0 <= end <= within_days:
            rows.append(("end", p, end))
        if start is not None and 0 < start <= within_days:
            rows.append(("start", p, start))
    rows.sort(key=lambda r: r[2])
    return [
        {
            "key": f"{p.id}-{kind}",
            "date": (on + timedelta(days=offset)).isoformat(),
            "offset": offset,
            "title": f"{p.name} deadline" if kind == "end" else f"{p.name} starts",
            "lead": p.lead.name if p.lead else "",
            "project_id": p.id,
        }
        for kind, p, offset in rows
    ]


def team_workload(on) -> list:
    order = ["overdue", "blocked", "soon", "later"]
    open_by_member = {}
    for t in _tasks():
        if t.state != "done":
            open_by_member.setdefault(t.owner_id, []).append(task_rules.workload_kind(t, on))
    rows = []
    for m in Member.objects.all():
        kinds = sorted(open_by_member.get(m.id, []), key=order.index)
        if kinds:
            rows.append(
                {
                    "id": m.id,
                    "name": m.name,
                    "title": m.title,
                    "department": m.department,
                    "load": m.load,
                    "stretched": m.stretched,
                    "open": kinds,
                }
            )
    rows.sort(key=lambda r: -len(r["open"]))
    return rows


def decisions(on) -> list:
    rows = [p for p in _projects() if p.decision.strip()]
    rows.sort(key=lambda p: (project_rules.HEALTH_RANK[project_rules.health(p, on)], p.end_date is None, p.end_date or on))
    return [
        {
            "project_id": p.id,
            "name": p.name,
            "decision": p.decision,
            "health": project_rules.health(p, on),
            "lead": p.lead.name if p.lead else "",
            "end_date": p.end_date.isoformat() if p.end_date else None,
            "end_offset": project_rules.end_offset(p, on),
        }
        for p in rows
    ]


def weekly_brief(on) -> dict:
    from projects.serializers import project_payload
    from tasks.serializers import task_payload

    projects, tasks = _projects(), _tasks()
    health = {p.id: project_rules.health(p, on) for p in projects}
    at_risk = [p for p in projects if health[p.id] in ("off-track", "watch")]
    at_risk.sort(key=lambda p: 0 if health[p.id] == "off-track" else 1)
    late = [t for t in tasks if task_rules.group(t, on) in ("overdue", "blocked")]
    late.sort(key=lambda t: (0 if task_rules.group(t, on) == "overdue" else 1, *task_rules.sort_key(t)))
    stretched = list(Member.objects.filter(load__gt=100).order_by("-load"))
    decision_rows = decisions(on)
    due_in_week = sum(
        1
        for t in tasks
        if t.state != "done" and (d := task_rules.due_offset(t, on)) is not None and 0 <= d <= DUE_SOON_DAYS
    )
    return {
        "generated_on": on.isoformat(),
        "summary": summary(on),
        "stats": {
            "projects_at_risk": len(at_risk),
            "overdue": sum(1 for t in late if task_rules.group(t, on) == "overdue"),
            "blocked": sum(1 for t in late if t.state == "blocked"),
            "decisions": len(decision_rows),
            "due_in_7_days": due_in_week,
        },
        "decisions": decision_rows,
        "attention_projects": [project_payload(p, on) for p in at_risk],
        "late_tasks": [task_payload(t, on) for t in late],
        "key_dates": key_dates(on, BRIEF_KEY_DATE_DAYS),
        "stretched_people": [
            {"id": m.id, "name": m.name, "title": m.title, "department": m.department, "load": m.load}
            for m in stretched
        ],
        "on_track_projects": [project_payload(p, on) for p in projects if health[p.id] == "on-track"],
        "completed_tasks": [{"id": t.id, "title": t.title} for t in tasks if t.state == "done"],
    }
