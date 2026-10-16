from rest_framework import serializers

from common.limits import DAILY_UPDATE_ITEM_MAX, DAILY_UPDATE_ITEMS_MAX, DAILY_UPDATE_NOTES_MAX, FEEDBACK_MAX
from members.models import Member
from projects.models import Project
from projects.rules import today

from .models import DailyUpdate, FeedbackType, OverallStatus, ReviewStatus


def _clean_items(items):
    """Trim each line, drop blanks."""
    return [" ".join(i.split()) for i in items if i.strip()]


def _list_field():
    return serializers.ListField(
        child=serializers.CharField(max_length=DAILY_UPDATE_ITEM_MAX, allow_blank=True),
        required=False,
        max_length=DAILY_UPDATE_ITEMS_MAX,
    )


class DailyUpdateWriteSerializer(serializers.Serializer):
    employee_id = serializers.PrimaryKeyRelatedField(
        queryset=Member.objects.all(), source="employee", error_messages={"does_not_exist": "That person is not on the team."}
    )
    project_id = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(), source="project", error_messages={"does_not_exist": "That project does not exist."}
    )
    date = serializers.DateField()
    completed = _list_field()
    in_progress = _list_field()
    next_steps = _list_field()
    blockers = _list_field()
    notes = serializers.CharField(required=False, allow_blank=True, max_length=DAILY_UPDATE_NOTES_MAX)
    status = serializers.ChoiceField(choices=OverallStatus.choices, required=False)

    def validate_date(self, value):
        if value > today():
            raise serializers.ValidationError("An update can't be dated in the future.")
        return value

    def validate_notes(self, value):
        return value.strip()

    def validate(self, attrs):
        for name in ("completed", "in_progress", "next_steps", "blockers"):
            if name in attrs:
                attrs[name] = _clean_items(attrs[name])
        if self.instance is None and not any(attrs.get(n) for n in ("completed", "in_progress", "next_steps", "blockers", "notes")):
            raise serializers.ValidationError({"completed": "Add at least one item or a note to the update."})
        return attrs


class DailyUpdateEditSerializer(DailyUpdateWriteSerializer):
    """Partial edit. The employee, project and date identify the update and cannot be changed;
    `review_status` may only mark an update as reviewed (feedback sets itself when feedback is added)."""

    employee_id = None
    project_id = None
    date = None
    review_status = serializers.ChoiceField(choices=[(ReviewStatus.REVIEWED, "Reviewed")], required=False)


class FeedbackSerializer(serializers.Serializer):
    type = serializers.ChoiceField(choices=FeedbackType.choices)
    content = serializers.CharField(
        max_length=FEEDBACK_MAX, error_messages={"blank": "Write some feedback first.", "required": "Write some feedback first."}
    )

    def validate_content(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Write some feedback first.")
        return value


def update_payload(u: DailyUpdate, tasks: list | None = None) -> dict:
    """Expects employee, project and feedback prefetched. `tasks`: this update's tasks (looked up when omitted)."""
    from .tasklink import task_fields, tasks_by_key

    if tasks is None:
        tasks = tasks_by_key([u]).get((u.employee_id, u.project_id, u.date), [])
    merged = task_fields(u, tasks)
    return {
        "id": u.id,
        "employee": u.employee_id,
        "employee_name": u.employee.name,
        "project": u.project_id,
        "project_name": u.project.name,
        "date": u.date.isoformat(),
        "completed": merged["completed"],
        "in_progress": merged["in_progress"],
        "next_steps": merged["next_steps"],
        "blockers": merged["blockers"],
        "notes": u.notes,
        "status": merged["status"],
        "from_tasks": u.from_tasks,
        "tasks": merged["tasks"],
        "review_status": u.review_status,
        "shared_at": u.shared_at,
        "feedback": [
            {
                "id": f.id,
                "type": f.type,
                "content": f.content,
                "manager_name": f.manager_name,
                "created_at": f.created_at,
            }
            for f in u.feedback.all()
        ],
    }
