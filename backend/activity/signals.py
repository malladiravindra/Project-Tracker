"""Deleting a project or task removes its history, whichever path deleted it (API, admin, shell).

The delete views then add a single "You deleted ..." line, so the feed still shows that it happened.
"""

from django.db.models import Q
from django.db.models.signals import pre_delete
from django.dispatch import receiver

from projects.models import Project
from tasks.models import Task

from .models import ActivityLog


@receiver(pre_delete, sender=Task)
def purge_task_history(sender, instance, **kwargs):
    ActivityLog.objects.filter(entity_type="task", entity_id=instance.pk).delete()


@receiver(pre_delete, sender=Project)
def purge_project_history(sender, instance, **kwargs):
    # pre_delete: the rows still point at the project, before the FK is set to NULL.
    ActivityLog.objects.filter(Q(project_id=instance.pk) | Q(entity_type="project", entity_id=instance.pk)).delete()
