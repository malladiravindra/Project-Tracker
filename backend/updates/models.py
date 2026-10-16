from django.db import models

from members.models import Member
from projects.models import Project


class OverallStatus(models.TextChoices):
    ON_TRACK = "On track", "On track"
    AT_RISK = "At risk", "At risk"
    BLOCKED = "Blocked", "Blocked"


class ReviewStatus(models.TextChoices):
    NEW = "new", "New"
    REVIEWED = "reviewed", "Reviewed"
    FEEDBACK = "feedback", "Feedback given"


class FeedbackType(models.TextChoices):
    SUGGESTION = "Suggestion", "Suggestion"
    APPRECIATION = "Appreciation", "Appreciation"
    IMPROVEMENT = "Improvement required", "Improvement required"
    NEXT_STEPS = "Next steps", "Next steps"


class DailyUpdate(models.Model):
    """What an employee did on one project on one working day, shared with the manager for review."""

    employee = models.ForeignKey(Member, on_delete=models.PROTECT, related_name="daily_updates")
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="daily_updates")
    date = models.DateField()  # the working day the update covers
    completed = models.JSONField(default=list, blank=True)
    in_progress = models.JSONField(default=list, blank=True)
    next_steps = models.JSONField(default=list, blank=True)
    blockers = models.JSONField(default=list, blank=True)
    notes = models.TextField(blank=True, default="")
    status = models.CharField(max_length=10, choices=OverallStatus.choices, default=OverallStatus.ON_TRACK)
    review_status = models.CharField(max_length=10, choices=ReviewStatus.choices, default=ReviewStatus.NEW)
    # Created automatically because the employee logged tasks for this project and day (see updates/tasklink.py).
    from_tasks = models.BooleanField(default=False)
    shared_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date", "-shared_at", "-id"]
        indexes = [
            models.Index(fields=["project", "-date"], name="dailyupdate_project_date"),
            models.Index(fields=["review_status"], name="dailyupdate_review_status"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["employee", "project", "date"], name="daily_update_unique_per_day")
        ]

    def __str__(self):
        return f"{self.employee} on {self.project} ({self.date})"


class Feedback(models.Model):
    update = models.ForeignKey(DailyUpdate, on_delete=models.CASCADE, related_name="feedback")
    manager_name = models.CharField(max_length=120, default="Manager")
    type = models.CharField(max_length=24, choices=FeedbackType.choices)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self):
        return f"{self.type} on update {self.update_id}"
