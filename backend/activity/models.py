from django.db import models


class ActivityLog(models.Model):
    """One row per event; the global feed is all rows, a project's history is its rows."""

    action = models.CharField(max_length=40)
    entity_type = models.CharField(max_length=20)
    entity_id = models.PositiveBigIntegerField(null=True, blank=True)
    project = models.ForeignKey(
        "projects.Project", null=True, blank=True, on_delete=models.SET_NULL, related_name="activity"
    )
    description = models.TextField()
    details = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["project", "-created_at"])]

    def __str__(self):
        return self.description
