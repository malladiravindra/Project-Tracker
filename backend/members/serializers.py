import re

from rest_framework import serializers

from projects.models import DEFAULT_ROLE, Project
from projects.rules import today as today_fn
from tasks import rules as task_rules

from .models import MAX_LOAD, EmploymentType, Member, Status

LOAD_MESSAGE = f"Capacity must be between 0 and {MAX_LOAD}%."
# Django range validators apply %-formatting to their message, so a literal % is doubled there.
LOAD_RANGE_MESSAGE = LOAD_MESSAGE.replace("%", "%%")
EMAIL_MESSAGE = "Enter a valid email address, e.g. name@company.com."
PHONE_MESSAGE = "Enter a valid phone number: 7 to 15 digits, optionally starting with +."
PHONE_CHARS = re.compile(r"^\+?[0-9 ()\-.]+$")


def _clean(value: str) -> str:
    return " ".join(value.split())


class MembershipInputSerializer(serializers.Serializer):
    project_id = serializers.PrimaryKeyRelatedField(queryset=Project.objects.all(), source="project")
    role = serializers.CharField(required=False, allow_blank=True, default=DEFAULT_ROLE)

    def validate_role(self, value):
        return _clean(value) or DEFAULT_ROLE


class MemberWriteSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=120,
        error_messages={"blank": "Enter the employee's full name.", "required": "Enter the employee's full name."},
    )
    title = serializers.CharField(
        max_length=120, error_messages={"blank": "Enter a job title.", "required": "Enter a job title."}
    )
    department = serializers.CharField(
        max_length=120,
        error_messages={"blank": "Choose or type a department.", "required": "Choose or type a department."},
    )
    load = serializers.IntegerField(
        required=False,
        min_value=0,
        max_value=MAX_LOAD,
        error_messages={"min_value": LOAD_RANGE_MESSAGE, "max_value": LOAD_RANGE_MESSAGE, "invalid": LOAD_MESSAGE},
    )
    email = serializers.EmailField(
        max_length=254,
        error_messages={
            "invalid": EMAIL_MESSAGE,
            "max_length": EMAIL_MESSAGE,
            "blank": "Enter a work email address.",
            "required": "Enter a work email address.",
        },
    )
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    status = serializers.ChoiceField(
        choices=Status.choices,
        error_messages={
            "invalid_choice": "Status must be active, on_leave or inactive.",
            "required": "Choose a status.",
            "blank": "Choose a status.",
        },
    )
    employment_type = serializers.ChoiceField(
        choices=EmploymentType.choices,
        error_messages={
            "invalid_choice": "Employment type must be full_time, part_time, contract or intern.",
            "required": "Choose an employment type.",
            "blank": "Choose an employment type.",
        },
    )
    start_date = serializers.DateField(
        error_messages={
            "invalid": "Enter the start date as YYYY-MM-DD.",
            "required": "Enter a start date.",
            "null": "Enter a start date.",
        }
    )
    memberships = MembershipInputSerializer(many=True, required=False, write_only=True)

    def validate_name(self, value):
        value = _clean(value)
        if not value:
            raise serializers.ValidationError("Enter the employee's full name.")
        clash = Member.objects.filter(name__iexact=value)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError(f"{value} is already on the team.")
        return value

    def validate_title(self, value):
        value = _clean(value)
        if not value:
            raise serializers.ValidationError("Enter a job title.")
        return value

    def validate_department(self, value):
        value = _clean(value)
        if not value:
            raise serializers.ValidationError("Choose or type a department.")
        return value

    def validate_email(self, value):
        value = value.strip().lower()
        if not value:
            raise serializers.ValidationError("Enter a work email address.")
        clash = Member.objects.filter(email__iexact=value)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if owner := clash.first():
            raise serializers.ValidationError(f"{value} is already used by {owner.name}.")
        return value

    def validate_phone(self, value):
        value = _clean(value)
        if not value:
            return ""
        digits = sum(c.isdigit() for c in value)
        if not PHONE_CHARS.match(value) or not 7 <= digits <= 15:
            raise serializers.ValidationError(PHONE_MESSAGE)
        return value

    def validate_memberships(self, value):
        seen = set()
        for item in value:
            if item["project"].pk in seen:
                raise serializers.ValidationError("A project can only be listed once.")
            seen.add(item["project"].pk)
        return value


def member_payload(member: Member, on=None) -> dict:
    """Output shape. Expects tasks (with project) and memberships (with project) prefetched."""
    on = on or today_fn()
    open_tasks = [t for t in member.tasks.all() if t.state != "done"]
    open_tasks.sort(key=task_rules.sort_key)
    return {
        "id": member.id,
        "name": member.name,
        "title": member.title,
        "department": member.department,
        "email": member.email,
        "phone": member.phone,
        "status": member.status,
        "employment_type": member.employment_type,
        "start_date": member.start_date.isoformat() if member.start_date else None,
        "load": member.load,
        "stretched": member.stretched,
        "open_tasks": len(open_tasks),
        "overdue_tasks": sum(1 for t in open_tasks if task_rules.bucket(t, on) == "overdue"),
        "blocked_tasks": sum(1 for t in open_tasks if t.state == "blocked"),
        "projects": [
            {"project_id": m.project_id, "project_name": m.project.name, "role": m.role}
            for m in sorted(member.memberships.all(), key=lambda m: m.project.name)
        ],
        "work": [
            {
                "id": t.id,
                "title": t.title,
                "project_id": t.project_id,
                "project_name": t.project.name,
                "work_date": t.work_date.isoformat(),
                "due_date": t.due_date.isoformat() if t.due_date else None,
                "due_offset": task_rules.due_offset(t, on),
                "state": t.state,
                "priority": t.priority,
            }
            for t in open_tasks
        ],
        "created_at": member.created_at,
        "updated_at": member.updated_at,
    }


def with_stats(queryset):
    return queryset.prefetch_related("tasks__project", "memberships__project")
