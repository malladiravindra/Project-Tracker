from django.db import models
from django.utils import timezone

from members.models import Member
from projects.models import Project


class State(models.TextChoices):
    NOT_STARTED = "not-started", "Not Started"
    IN_PROGRESS = "in-progress", "In Progress"
    BLOCKED = "blocked", "Blocked"
    DONE = "done", "Done"


class Priority(models.TextChoices):
    CRITICAL = "Critical", "Critical"
    HIGH = "High", "High"
    MEDIUM = "Medium", "Medium"
    LOW = "Low", "Low"


class Task(models.Model):
    title = models.CharField(max_length=300)
    project = models.ForeignKey(Project, on_delete=models.PROTECT, related_name="tasks")
    owner = models.ForeignKey(Member, on_delete=models.PROTECT, related_name="tasks")
    # The day the work was (or is being) done. Can be in the past, so earlier work can be recorded later;
    # separate from the optional deadline and from created_at.
    work_date = models.DateField(default=timezone.localdate, db_index=True)
    due_date = models.DateField(null=True, blank=True)  # optional deadline
    state = models.CharField(max_length=12, choices=State.choices, default=State.NOT_STARTED)
    priority = models.CharField(max_length=8, choices=Priority.choices, default=Priority.MEDIUM)
    note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = [models.F("due_date").asc(nulls_last=True), "id"]  # tasks without a deadline last
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(state="blocked") | ~models.Q(note=""),
                name="task_blocked_requires_note",
            )
        ]

    def __str__(self):
        return self.title
