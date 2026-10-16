from rest_framework import serializers

from common.limits import PROJECT_DECISION_MAX, PROJECT_DESCRIPTION_MAX
from common.params import ID_MAX
from members.models import Member
from tasks import rules as task_rules

from . import rules
from .models import DEFAULT_DEPARTMENT, DEFAULT_ROLE, DecisionRecord, Outcome, Phase, Priority, Project

DEADLINE_MESSAGE = "The deadline must be after the start date."
PHASE_MESSAGE = "Status must be one of: " + ", ".join(Phase.values) + "."
PRIORITY_MESSAGE = "Priority must be one of: " + ", ".join(Priority.values) + "."


def _clean(value: str) -> str:
    return " ".join(value.split())


class ProjectCreateSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=200, error_messages={"blank": "Enter a project name.", "required": "Enter a project name."}
    )
    department = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")
    client = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")  # "" = no client
    lead_id = serializers.PrimaryKeyRelatedField(
        queryset=Member.objects.all(), source="lead", required=False, allow_null=True, default=None,
        error_messages={"does_not_exist": "Choose a project lead from the team."},
    )
    start_date = serializers.DateField(required=False, allow_null=True, default=None)
    end_date = serializers.DateField(required=False, allow_null=True, default=None)
    # Omitted phase: derived from the start date (Not Started / In Progress; Planning when there is none).
    phase = serializers.ChoiceField(
        choices=Phase.choices, required=False, error_messages={"invalid_choice": PHASE_MESSAGE}
    )
    priority = serializers.ChoiceField(
        choices=Priority.choices, required=False, default=Priority.MEDIUM, error_messages={"invalid_choice": PRIORITY_MESSAGE}
    )
    description = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=PROJECT_DESCRIPTION_MAX
    )

    def validate_name(self, value):
        value = _clean(value)
        if not value:
            raise serializers.ValidationError("Enter a project name.")
        return value

    def validate_department(self, value):
        return _clean(value) or DEFAULT_DEPARTMENT

    def validate_client(self, value):
        return _clean(value)

    def validate_description(self, value):
        return value.strip()

    def validate(self, attrs):
        start, end = attrs["start_date"], attrs["end_date"]
        if start and end and end <= start:
            raise serializers.ValidationError({"end_date": DEADLINE_MESSAGE})
        return attrs


class ProjectUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    department = serializers.CharField(max_length=120, required=False)
    client = serializers.CharField(max_length=120, required=False, allow_blank=True)
    description = serializers.CharField(required=False, allow_blank=True, max_length=PROJECT_DESCRIPTION_MAX)
    phase = serializers.ChoiceField(choices=Phase.choices, required=False, error_messages={"invalid_choice": PHASE_MESSAGE})
    priority = serializers.ChoiceField(
        choices=Priority.choices, required=False, error_messages={"invalid_choice": PRIORITY_MESSAGE}
    )
    lead_id = serializers.PrimaryKeyRelatedField(queryset=Member.objects.all(), source="lead", required=False, allow_null=True)
    start_date = serializers.DateField(required=False, allow_null=True)
    end_date = serializers.DateField(required=False, allow_null=True)
    progress = serializers.IntegerField(
        required=False,
        min_value=0,
        max_value=100,
        error_messages={"min_value": "Progress must be between 0 and 100.", "max_value": "Progress must be between 0 and 100."},
    )
    decision = serializers.CharField(required=False, allow_blank=True, max_length=PROJECT_DECISION_MAX)

    def validate_name(self, value):
        value = _clean(value)
        if not value:
            raise serializers.ValidationError("Enter a project name.")
        return value

    def validate_department(self, value):
        return _clean(value) or DEFAULT_DEPARTMENT

    def validate_client(self, value):
        return _clean(value)

    def validate_description(self, value):
        return value.strip()

    def validate_decision(self, value):
        return value.strip()

    def validate(self, attrs):
        start = attrs.get("start_date", self.instance.start_date)
        end = attrs.get("end_date", self.instance.end_date)
        if start and end and end <= start:
            raise serializers.ValidationError({"end_date": DEADLINE_MESSAGE})
        return attrs


class DecisionSerializer(serializers.Serializer):
    decision = serializers.CharField(allow_blank=True, max_length=PROJECT_DECISION_MAX)

    def validate_decision(self, value):
        return value.strip()


DECISION_NOTES_MAX = 2000
DATE_FUTURE_MESSAGE = "The decision date can't be in the future."


class DecisionResolveSerializer(serializers.Serializer):
    """Outcome of a pending decision. All fields optional so a bare resolve still works (Resolved, today)."""

    outcome = serializers.ChoiceField(choices=Outcome.choices, required=False, default=Outcome.RESOLVED)
    notes = serializers.CharField(required=False, allow_blank=True, default="", max_length=DECISION_NOTES_MAX)
    decision_date = serializers.DateField(required=False)

    def validate_notes(self, value):
        return value.strip()

    def validate_decision_date(self, value):
        if value > rules.today():
            raise serializers.ValidationError(DATE_FUTURE_MESSAGE)
        return value


def decision_record_payload(rec: DecisionRecord) -> dict:
    return {
        "id": rec.id,
        "project": rec.project_id,
        "title": rec.title,
        "outcome": rec.outcome,
        "notes": rec.notes,
        "decision_date": rec.decision_date.isoformat(),
        "recorded_at": rec.recorded_at,
        "project_name": rec.project_name,
        "lead": rec.lead_name,
        "health": rec.health,
        "deadline": rec.deadline.isoformat() if rec.deadline else None,
        "context": rec.context,
        "activity_id": rec.event_id,
    }


class DecisionUndoSerializer(serializers.Serializer):
    # Optional: a missing id keeps the old behaviour (404 "nothing to undo"); a malformed one is a 400.
    activity_id = serializers.IntegerField(required=False, min_value=1, max_value=ID_MAX)


class MembershipCreateSerializer(serializers.Serializer):
    member_id = serializers.PrimaryKeyRelatedField(
        queryset=Member.objects.all(), source="member", error_messages={"does_not_exist": "That person is not on the team."}
    )
    role = serializers.CharField(max_length=120, required=False, allow_blank=True, default=DEFAULT_ROLE)

    def validate_role(self, value):
        return _clean(value) or DEFAULT_ROLE


class ObjectiveSerializer(serializers.Serializer):
    description = serializers.CharField(
        max_length=500, error_messages={"blank": "Enter an objective.", "required": "Enter an objective."}
    )

    def validate_description(self, value):
        value = _clean(value)
        if not value:
            raise serializers.ValidationError("Enter an objective.")
        return value


def project_payload(project: Project, on=None, detail: bool = False) -> dict:
    """Output shape. Expects lead, memberships(member) prefetched; detail also objectives, tasks."""
    on = on or rules.today()
    data = {
        "id": project.id,
        "name": project.name,
        "department": project.department,
        "client": project.client,
        "lead": project.lead_id,
        "lead_name": project.lead.name if project.lead else "",
        "phase": project.phase,
        "priority": project.priority,
        "description": project.description,
        "start_date": project.start_date.isoformat() if project.start_date else None,
        "end_date": project.end_date.isoformat() if project.end_date else None,
        "start_offset": rules.start_offset(project, on),
        "end_offset": rules.end_offset(project, on),
        "progress": project.progress,
        "decision": project.decision,
        "time_used": rules.time_used(project, on),
        "health": rules.health(project, on),
        "member_count": len(project.memberships.all()),
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }
    if detail:
        open_tasks = sorted(
            (t for t in project.tasks.all() if t.state != "done"), key=task_rules.sort_key
        )
        data["objectives"] = [
            {"id": o.id, "description": o.description} for o in project.objectives.all()
        ]
        data["members"] = [
            {"id": m.id, "member_id": m.member_id, "name": m.member.name, "role": m.role}
            for m in project.memberships.all()
        ]
        data["open_tasks"] = [
            {
                "id": t.id,
                "title": t.title,
                "owner": t.owner_id,
                "owner_name": t.owner.name,
                "work_date": t.work_date.isoformat(),
                "due_date": t.due_date.isoformat() if t.due_date else None,
                "due_offset": task_rules.due_offset(t, on),
                "state": t.state,
                "priority": t.priority,
            }
            for t in open_tasks
        ]
    return data


def with_related(queryset, detail: bool = False):
    queryset = queryset.select_related("lead").prefetch_related("memberships__member")
    if detail:
        queryset = queryset.prefetch_related("objectives", "tasks__owner")
    return queryset
