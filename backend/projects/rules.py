"""Derived project values. Nothing here is stored; it is computed from current records."""

import math
from datetime import date

from django.utils import timezone

OFF_TRACK_GAP = 15
WATCH_GAP = 3


def today() -> date:
    return timezone.localdate()


def start_offset(project, on: date) -> int | None:
    """Days until the start; None when the project has no start date."""
    return None if project.start_date is None else (project.start_date - on).days


def end_offset(project, on: date) -> int | None:
    """Days until the deadline; None when the project has no deadline."""
    return None if project.end_date is None else (project.end_date - on).days


def time_used(project, on: date) -> int:
    """% of the schedule elapsed, clamped to 0-100 (JS Math.round semantics: .5 rounds up).

    Without both dates there is no schedule, so 0: health then follows progress alone.
    """
    if project.start_date is None or project.end_date is None:
        return 0
    total = (project.end_date - project.start_date).days
    pct = math.floor(-start_offset(project, on) / total * 100 + 0.5)
    return min(100, max(0, pct))


def health(project, on: date) -> str:
    used = time_used(project, on)
    if used == 0 and project.progress == 0:
        return "not-started"
    gap = used - project.progress
    if gap > OFF_TRACK_GAP:
        return "off-track"
    if gap > WATCH_GAP:
        return "watch"
    return "on-track"


HEALTH_RANK = {"off-track": 0, "watch": 1, "on-track": 2, "not-started": 3}
