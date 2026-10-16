"""Tasks feed Daily Work Updates.

Every (owner, project, work date) that has tasks gets a daily update. Its task items are not copied into the
update: they are read from the tasks whenever the update is returned, so edits, renames and deletes show up at once.
A report someone shared by hand keeps its own lists; the task items are merged in after them.
"""

from collections import defaultdict

from django.db import IntegrityError, transaction

from tasks.models import State, Task

from .models import DailyUpdate, ReviewStatus


def tasks_by_key(updates) -> dict:
    """Tasks for each update's (employee, project, date), in one query."""
    keys = {(u.employee_id, u.project_id, u.date) for u in updates}
    if not keys:
        return {}
    rows = Task.objects.filter(
        owner_id__in={k[0] for k in keys},
        project_id__in={k[1] for k in keys},
        work_date__in={k[2] for k in keys},
    ).order_by("id")
    out = defaultdict(list)
    for t in rows:
        key = (t.owner_id, t.project_id, t.work_date)
        if key in keys:
            out[key].append(t)
    return out


def _is_empty(update: DailyUpdate) -> bool:
    """Nothing typed by hand and no manager feedback: safe to drop when its tasks are gone."""
    return (
        not (update.completed or update.in_progress or update.next_steps or update.blockers or update.notes)
        and not update.feedback.exists()
    )


def sync(employee_id, project_id, day, touched: bool = True) -> None:
    """Bring the daily update for one (employee, project, day) in line with its tasks.

    touched: the change is news for the manager (a task added or its status changed). An update already
    marked Reviewed then goes back to New so the change is seen; feedback that was given stays.
    """
    has_tasks = Task.objects.filter(owner_id=employee_id, project_id=project_id, work_date=day).exists()
    update = DailyUpdate.objects.filter(employee_id=employee_id, project_id=project_id, date=day).first()
    if has_tasks:
        if update is None:
            try:
                with transaction.atomic():
                    DailyUpdate.objects.create(employee_id=employee_id, project_id=project_id, date=day, from_tasks=True)
            except IntegrityError:
                pass  # created concurrently; nothing else to do
        elif touched and update.review_status == ReviewStatus.REVIEWED:
            update.review_status = ReviewStatus.NEW
            update.save(update_fields=["review_status", "updated_at"])
    elif update is not None and update.from_tasks and _is_empty(update):
        update.delete()


def _merged(manual: list, extra: list) -> list:
    seen = {s.casefold() for s in manual}
    return [*manual, *(x for x in extra if x.casefold() not in seen)]


def task_fields(update: DailyUpdate, tasks: list) -> dict:
    """The update's lists and status with its tasks merged in."""
    by_state = defaultdict(list)
    for t in tasks:
        by_state[t.state].append(t)
    blocked = [f"{t.title}: {t.note}" if t.note else t.title for t in by_state[State.BLOCKED]]
    return {
        "completed": _merged(update.completed, [t.title for t in by_state[State.DONE]]),
        "in_progress": _merged(update.in_progress, [t.title for t in by_state[State.IN_PROGRESS]]),
        "next_steps": _merged(update.next_steps, [t.title for t in by_state[State.NOT_STARTED]]),
        "blockers": _merged(update.blockers, blocked),
        "status": "Blocked" if blocked else update.status,
        "tasks": [{"id": t.id, "title": t.title, "state": t.state, "priority": t.priority} for t in tasks],
    }
