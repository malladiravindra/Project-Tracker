"""Single write path for audit events, so every mutation logs the same way."""

from .models import ActivityLog


def log(action, entity_type, entity_id, description, project=None, **details):
    return ActivityLog.objects.create(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        project=project,
        description=description,
        details=details,
    )
