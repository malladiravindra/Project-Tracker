"""Derived task values (urgency groups, labels). Computed from real dates, never stored."""

from datetime import date

OPEN_GROUPS = ("overdue", "today", "next2", "week", "later", "blocked")
ALL_GROUPS = OPEN_GROUPS + ("done",)


def due_offset(task, on: date) -> int | None:
    """Days until the deadline (negative = overdue); None when the task has no deadline."""
    return None if task.due_date is None else (task.due_date - on).days


def task_date(task) -> date:
    """The date a task is grouped by: its deadline, or its work date when it has none."""
    return task.due_date or task.work_date


def date_offset(task, on: date) -> int:
    """Days from `on` to the task's date (negative = in the past)."""
    return (task_date(task) - on).days


def sort_key(task):
    """Earliest task date first."""
    return (task_date(task), task.id)


def group(task, on: date) -> str:
    """done/blocked override the date-based groups."""
    if task.state == "done":
        return "done"
    if task.state == "blocked":
        return "blocked"
    d = date_offset(task, on)
    if d < 0:
        return "overdue"
    if d == 0:
        return "today"
    if d <= 2:
        return "next2"
    if d <= 7:
        return "week"
    return "later"


def bucket(task, on: date) -> str:
    """Coarser grouping used by summary/attention: overdue, today, blocked, upcoming, done."""
    if task.state == "done":
        return "done"
    if task.state == "blocked":
        return "blocked"
    d = date_offset(task, on)
    if d < 0:
        return "overdue"
    return "today" if d == 0 else "upcoming"


def workload_kind(task, on: date) -> str:
    b = bucket(task, on)
    if b in ("overdue", "blocked"):
        return b
    return "soon" if date_offset(task, on) <= 7 else "later"


def due_label(task, on: date) -> str:
    if task.state == "done":
        return "Done"
    if task.state == "blocked":
        return "Blocked"
    d = due_offset(task, on)
    if d is None:
        w = date_offset(task, on)
        if w == 0:
            return "Today's work"
        if w < 0:
            return f"Work date {-w} day{'' if w == -1 else 's'} ago"
        return f"Work date in {w} day{'' if w == 1 else 's'}"
    if d < 0:
        return f"{-d} day{'' if d == -1 else 's'} overdue"
    if d == 0:
        return "Due today"
    if d == 1:
        return "Due tomorrow"
    return f"Due in {d} days"
