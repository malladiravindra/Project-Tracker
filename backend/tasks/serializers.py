from rest_framework import serializers

from common.limits import TASK_NOTE_MAX
from members.models import Member
from projects.models import Project
from projects.rules import today as today_fn

from . import rules
from .models import Priority, State, Task

BLOCKED_NOTE_MESSAGE = "Say what the task is waiting on, so others can help unblock it."
WORK_DATE_INVALID = "Enter the work date as a valid date."


class _TaskRulesMixin:
    """The blocked-needs-a-note rule lives here once and applies to create and update alike."""

    def _check_blocked(self, state, note):
        if state == State.BLOCKED and not (note or "").strip():
            raise serializers.ValidationError({"note": BLOCKED_NOTE_MESSAGE})


class TaskCreateSerializer(_TaskRulesMixin, serializers.Serializer):
    title = serializers.CharField(
        max_length=300, error_messages={"blank": "Give the task a name.", "required": "Give the task a name."}
    )
    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), source="project", error_messages={"does_not_exist": "Choose a project."}
    )
    owner_id = serializers.PrimaryKeyRelatedField(
        queryset=Member.objects.all(), source="owner", error_messages={"does_not_exist": "Choose an owner from the team."}
    )
    # Omitted work_date means today (the model default); past and future dates are accepted.
    work_date = serializers.DateField(required=False, error_messages={"invalid": WORK_DATE_INVALID})
    due_date = serializers.DateField(required=False, allow_null=True, default=None, error_messages={"invalid": "Pick a valid due date."})
    priority = serializers.ChoiceField(choices=Priority.choices, required=False, default=Priority.MEDIUM)
    state = serializers.ChoiceField(choices=State.choices, required=False, default=State.NOT_STARTED)
    note = serializers.CharField(required=False, allow_blank=True, default="", max_length=TASK_NOTE_MAX)

    def validate_title(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Give the task a name.")
        return value

    def validate_note(self, value):
        return value.strip()

    def validate(self, attrs):
        self._check_blocked(attrs["state"], attrs["note"])
        return attrs


class TaskUpdateSerializer(_TaskRulesMixin, serializers.Serializer):
    title = serializers.CharField(max_length=300, required=False, error_messages={"blank": "Give the task a name."})
    owner_id = serializers.PrimaryKeyRelatedField(
        queryset=Member.objects.all(), source="owner", required=False, error_messages={"does_not_exist": "Choose an owner from the team."}
    )
    work_date = serializers.DateField(required=False, error_messages={"invalid": WORK_DATE_INVALID})
    due_date = serializers.DateField(required=False, allow_null=True, error_messages={"invalid": "Pick a valid due date."})
    priority = serializers.ChoiceField(choices=Priority.choices, required=False)
    state = serializers.ChoiceField(choices=State.choices, required=False)
    note = serializers.CharField(required=False, allow_blank=True, max_length=TASK_NOTE_MAX)
    # Accepted only to give a clear error: a task cannot change project.
    project_id = serializers.IntegerField(required=False)

    def validate_title(self, value):
        value = " ".join(value.split())
        if not value:
            raise serializers.ValidationError("Give the task a name.")
        return value

    def validate_note(self, value):
        return value.strip()

    def validate_project_id(self, value):
        if value != self.instance.project_id:
            raise serializers.ValidationError("A task cannot be moved to another project.")
        return value

    def validate(self, attrs):
        state = attrs.get("state", self.instance.state)
        note = attrs["note"] if "note" in attrs else self.instance.note
        self._check_blocked(state, note)
        attrs.pop("project_id", None)
        return attrs


def task_payload(task: Task, on=None) -> dict:
    """Output shape. Expects project and owner via select_related."""
    on = on or today_fn()
    return {
        "id": task.id,
        "title": task.title,
        "project": task.project_id,
        "project_name": task.project.name,
        "owner": task.owner_id,
        "owner_name": task.owner.name,
        "work_date": task.work_date.isoformat(),
        "due_date": task.due_date.isoformat() if task.due_date else None,
        "due_offset": rules.due_offset(task, on),
        "state": task.state,
        "priority": task.priority,
        "note": task.note,
        "group": rules.group(task, on),
        "bucket": rules.bucket(task, on),
        "due_label": rules.due_label(task, on),
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }
