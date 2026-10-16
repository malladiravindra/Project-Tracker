from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from members.models import Member


class Phase(models.TextChoices):
    PLANNING = "Planning", "Planning"
    NOT_STARTED = "Not Started", "Not Started"
    IN_PROGRESS = "In Progress", "In Progress"
    UNDER_TESTING = "Under Testing", "Under Testing"
    AT_RISK = "At Risk", "At Risk"
    ON_HOLD = "On Hold", "On Hold"
    NO_UPDATES = "No Updates", "No Updates"
    COMPLETED = "Completed", "Completed"
    CANCELLED = "Cancelled", "Cancelled"


class Priority(models.TextChoices):
    LOW = "Low", "Low"
    MEDIUM = "Medium", "Medium"
    HIGH = "High", "High"
    CRITICAL = "Critical", "Critical"


LEAD_ROLE = "Project Lead"
DEFAULT_ROLE = "Team Member"
DEFAULT_DEPARTMENT = "General"


class Project(models.Model):
    name = models.CharField(max_length=200)
    department = models.CharField(max_length=120, default=DEFAULT_DEPARTMENT)
    client = models.CharField(max_length=120, blank=True, default="")  # "" = internal / no client
    lead = models.ForeignKey(Member, null=True, blank=True, on_delete=models.PROTECT, related_name="led_projects")
    phase = models.CharField(max_length=20, choices=Phase.choices, default=Phase.IN_PROGRESS)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    description = models.TextField(blank=True, default="")
    start_date = models.DateField(null=True, blank=True)  # optional
    end_date = models.DateField(null=True, blank=True)  # optional (the deadline)
    progress = models.PositiveSmallIntegerField(
        default=0, validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    decision = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(start_date__isnull=True)
                | models.Q(end_date__isnull=True)
                | models.Q(end_date__gt=models.F("start_date")),
                name="project_end_after_start",
            ),
            models.CheckConstraint(
                condition=models.Q(progress__gte=0, progress__lte=100), name="project_progress_0_100"
            ),
        ]

    def __str__(self):
        return self.name


class ProjectMember(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="memberships")
    member = models.ForeignKey(Member, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=120, default=DEFAULT_ROLE)

    class Meta:
        ordering = ["role", "member__name"]
        constraints = [
            models.UniqueConstraint(fields=["project", "member"], name="project_member_unique")
        ]

    def __str__(self):
        return f"{self.member} on {self.project} ({self.role})"


class ProjectObjective(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="objectives")
    description = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.description


class Outcome(models.TextChoices):
    APPROVED = "Approved", "Approved"
    REJECTED = "Rejected", "Rejected"
    DEFERRED = "Deferred", "Deferred"
    RESOLVED = "Resolved", "Resolved"


class DecisionRecord(models.Model):
    """What the manager decided on a pending project decision, with a snapshot of the project at that moment.

    Records are kept when the project is later deleted (the project link is cleared, the snapshot stays).
    """

    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL, related_name="decision_records")
    title = models.TextField()  # the decision that was asked for
    outcome = models.CharField(max_length=10, choices=Outcome.choices)
    notes = models.TextField(blank=True, default="")
    decision_date = models.DateField()
    recorded_at = models.DateTimeField(auto_now_add=True)
    # Snapshot of the project when the decision was made
    project_name = models.CharField(max_length=200)
    lead_name = models.CharField(max_length=120, blank=True, default="")
    health = models.CharField(max_length=12)
    deadline = models.DateField(null=True, blank=True)
    context = models.CharField(max_length=120)  # e.g. "71% done with 92% of the time used"
    # The activity entry written when the decision was resolved (used to undo it).
    event = models.OneToOneField("activity.ActivityLog", null=True, blank=True, on_delete=models.SET_NULL, related_name="decision_record")

    class Meta:
        ordering = ["-decision_date", "-recorded_at", "-id"]
        indexes = [models.Index(fields=["-decision_date"], name="decisionrecord_date")]

    def __str__(self):
        return f"{self.outcome}: {self.title}"
