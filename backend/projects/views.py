from datetime import date

from django.db import transaction
from django.db.models import Q
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from activity.models import ActivityLog
from activity.services import log
from activity.views import activity_page
from common.access import ALL_ROLES, STAFF_ROLES, assert_project_visible, is_staff_role, visible_project_ids
from common.exceptions import Conflict
from common.limits import LIST_DEFAULT_LIMIT as DEFAULT_LIMIT, LIST_MAX_LIMIT as MAX_LIMIT
from common.params import OFFSET_MAX, parse_id, parse_int
from tasks.models import Task
from tasks.views import fmt_date, list_tasks_response

from . import rules
from .models import DEFAULT_ROLE, LEAD_ROLE, DecisionRecord, Outcome, Phase, Project, ProjectMember, ProjectObjective
from .serializers import (
    DecisionResolveSerializer,
    DecisionSerializer,
    DecisionUndoSerializer,
    MembershipCreateSerializer,
    ObjectiveSerializer,
    ProjectCreateSerializer,
    ProjectUpdateSerializer,
    decision_record_payload,
    project_payload,
    with_related,
)

HEALTH_VALUES = ("off-track", "watch", "on-track", "not-started")


def get_project(pk, detail: bool = True, lock: bool = False) -> Project:
    """lock=True takes a row lock (inside a transaction) so concurrent resolve/undo requests on one project
    run one after the other instead of both acting on the same stale decision."""
    try:
        if lock:
            return Project.objects.select_for_update().get(pk=pk)
        return with_related(Project.objects.all(), detail=detail).get(pk=pk)
    except Project.DoesNotExist:
        raise NotFound("Project not found.")


def _for_user(user, payload: dict) -> dict:
    """The manager's private decision note is not shown to employees."""
    if not is_staff_role(user):
        payload = {**payload, "decision": ""}
    return payload


def detail_response(pk, status=200, user=None):
    payload = project_payload(get_project(pk), detail=True)
    return Response(payload if user is None else _for_user(user, payload), status=status)


def _set_lead_membership(project: Project, new_lead, old_lead):
    """Lead rules: old lead stays on the team as a regular member; new lead becomes Project Lead.

    Either may be None (the project has no lead before or after the change).
    """
    if old_lead is not None and (new_lead is None or old_lead.pk != new_lead.pk):
        ProjectMember.objects.filter(project=project, member=old_lead).update(role=DEFAULT_ROLE)
    if new_lead is not None:
        ProjectMember.objects.update_or_create(
            project=project, member=new_lead, defaults={"role": LEAD_ROLE}
        )


class ProjectListView(APIView):
    role_policy = {"GET": ALL_ROLES, "POST": STAFF_ROLES}

    def get(self, request):
        params = request.query_params
        on = rules.today()
        # ?detail=1 returns objectives, members and open tasks too (saves one request per project).
        detail = params.get("detail", "").lower() in ("1", "true")
        visible = visible_project_ids(request.user)
        base = Project.objects.all() if visible is None else Project.objects.filter(id__in=visible)
        rows = [_for_user(request.user, project_payload(p, on, detail=detail)) for p in with_related(base, detail=detail)]

        health = params.get("health", "all")
        if health != "all":
            if health not in HEALTH_VALUES:
                raise ValidationError({"health": "health must be all, off-track, watch, on-track or not-started."})
            rows = [r for r in rows if r["health"] == health]

        sort = params.get("sort", "attention")
        if sort == "deadline":
            rows.sort(key=lambda r: (r["end_date"] is None, r["end_date"] or ""))  # no deadline last
        elif sort == "progress":
            rows.sort(key=lambda r: -r["progress"])
        elif sort == "name":
            rows.sort(key=lambda r: r["name"].lower())
        elif sort == "attention":
            rows.sort(key=lambda r: (rules.HEALTH_RANK[r["health"]], r["end_date"] is None, r["end_date"] or ""))
        else:
            raise ValidationError({"sort": "sort must be attention, deadline, progress or name."})
        return Response({"results": rows, "count": len(rows)})

    @transaction.atomic
    def post(self, request):
        ser = ProjectCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if "phase" not in data:
            start = data["start_date"]
            data["phase"] = Phase.PLANNING if start is None else Phase.NOT_STARTED if start > rules.today() else Phase.IN_PROGRESS
        project = Project.objects.create(progress=0, **data)
        if project.lead:
            ProjectMember.objects.create(project=project, member=project.lead, role=LEAD_ROLE)
        log("project.created", "project", project.id, f"You created {project.name}" + (f" for {project.client}" if project.client else ""), project=project)
        return detail_response(project.pk, status=201)


class ProjectDetailView(APIView):
    role_policy = {"GET": ALL_ROLES, "PATCH": STAFF_ROLES, "DELETE": STAFF_ROLES}

    def get(self, request, pk):
        assert_project_visible(request.user, pk)
        return detail_response(pk, user=request.user)

    @transaction.atomic
    def patch(self, request, pk):
        project = get_project(pk, lock=True)
        ser = ProjectUpdateSerializer(project, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        events = []
        name = project.name

        if "name" in data and data["name"] != project.name:
            events.append(("project.renamed", f"You renamed {project.name} to {data['name']}"))
            name = data["name"]
        if "department" in data and data["department"] != project.department:
            events.append(("project.updated", f"You changed the domain of {name} to {data['department']}"))
        if "client" in data and data["client"] != project.client:
            events.append(
                ("project.updated", f"You changed the client of {name} to {data['client']}" if data["client"] else f"You removed the client of {name}")
            )
        if "priority" in data and data["priority"] != project.priority:
            events.append(("project.priority", f"You changed the priority of {name} from {project.priority} to {data['priority']}"))
        if "description" in data and data["description"] != project.description:
            events.append(("project.updated", f"You updated the description of {name}"))
        if "phase" in data and data["phase"] != project.phase:
            events.append(("project.phase", f"You changed {name} from {project.phase} to {data['phase']}"))
        new_lead_id = data["lead"].pk if data.get("lead") else None
        if "lead" in data and new_lead_id != project.lead_id:
            if project.lead is None:
                text = f"You made {data['lead'].name} the project lead of {name}"
            elif data["lead"] is None:
                text = f"You removed {project.lead.name} as the project lead of {name}"
            else:
                text = f"You changed the project lead from {project.lead.name} to {data['lead'].name}"
            events.append(("project.lead", text))
        if "start_date" in data and data["start_date"] != project.start_date:
            text = f"You moved the start date to {fmt_date(data['start_date'])}" if data["start_date"] else "You removed the start date"
            events.append(("project.start", text))
        if "end_date" in data and data["end_date"] != project.end_date:
            text = f"You moved the deadline to {fmt_date(data['end_date'])}" if data["end_date"] else "You removed the deadline"
            events.append(("project.deadline", text))
        if "progress" in data and data["progress"] != project.progress:
            events.append(
                ("project.progress", f"You updated progress from {project.progress}% to {data['progress']}%")
            )
        if "decision" in data and data["decision"] != project.decision:
            if data["decision"]:
                events.append(("decision.requested", f"You asked for a decision on {name}: {data['decision']}"))
            else:
                events.append(("decision.cleared", f"You cleared the decision on {name}"))

        old_lead = project.lead
        for field, value in data.items():
            setattr(project, field, value)
        if events:
            # Only the fields in this request are written, so a concurrent edit of a different field is not undone.
            project.save(update_fields=[*data.keys(), "updated_at"])
            if project.lead_id != (old_lead.pk if old_lead else None):
                _set_lead_membership(project, project.lead, old_lead)
            for action, text in events:
                log(action, "project", project.id, text, project=project)
        return detail_response(pk)

    @transaction.atomic
    def delete(self, request, pk):
        project = get_project(pk, detail=False)
        task_count = Task.objects.filter(project=project).count()
        if task_count:
            raise Conflict(
                f"{project.name} still has {task_count} task{'' if task_count == 1 else 's'}. "
                "Delete or finish them before deleting the project."
            )
        name, project_id = project.name, project.id
        project.delete()  # memberships and objectives cascade; its history is purged (activity.signals)
        log("project.deleted", "project", project_id, f"You deleted the project {name}")
        return Response(status=204)


class ProjectHistoryView(APIView):
    def get(self, request, pk):
        get_project(pk, detail=False)
        return activity_page(ActivityLog.objects.filter(project_id=pk), request.query_params)


class ProjectTaskListView(APIView):
    role_policy = {"GET": ALL_ROLES}

    def get(self, request, pk):
        assert_project_visible(request.user, pk)
        get_project(pk, detail=False)
        counts = None if is_staff_role(request.user) else Task.objects.filter(project_id=pk)
        return list_tasks_response(Task.objects.filter(project_id=pk), request.query_params, counts_base=counts)


class ProjectMemberListView(APIView):
    role_policy = {"GET": ALL_ROLES, "POST": STAFF_ROLES}

    def get(self, request, pk):
        assert_project_visible(request.user, pk)
        project = get_project(pk)
        rows = [
            {"id": m.id, "member_id": m.member_id, "name": m.member.name, "role": m.role}
            for m in project.memberships.all()
        ]
        return Response({"results": rows, "count": len(rows)})

    @transaction.atomic
    def post(self, request, pk):
        project = get_project(pk, detail=False)
        ser = MembershipCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        member, role = ser.validated_data["member"], ser.validated_data["role"]
        if ProjectMember.objects.filter(project=project, member=member).exists():
            raise ValidationError({"member_id": f"{member.name} is already on this project."})
        ProjectMember.objects.create(project=project, member=member, role=role)
        log("membership.added", "project", project.id, f"You added {member.name} to the team", project=project)
        return detail_response(pk, status=201)


class ProjectMemberDetailView(APIView):
    @transaction.atomic
    def delete(self, request, pk, member_id):
        member_id = parse_id(member_id, "member_id")
        project = get_project(pk, detail=False)
        try:
            membership = ProjectMember.objects.select_related("member").get(
                project=project, member_id=member_id
            )
        except ProjectMember.DoesNotExist:
            raise NotFound("That person is not on this project.")
        if membership.member_id == project.lead_id:
            raise Conflict("The project lead cannot be removed from the team. Change the lead first.")
        name = membership.member.name
        membership.delete()
        log("membership.removed", "project", project.id, f"You removed {name} from the team", project=project)
        return Response(status=204)


class ProjectObjectiveListView(APIView):
    @transaction.atomic
    def post(self, request, pk):
        project = get_project(pk, detail=False)
        ser = ObjectiveSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        objective = ProjectObjective.objects.create(project=project, **ser.validated_data)
        log(
            "objective.added",
            "project",
            project.id,
            f"You added the objective “{objective.description}”",
            project=project,
        )
        return detail_response(pk, status=201)


class ProjectObjectiveDetailView(APIView):
    def _get(self, pk, objective_id):
        objective_id = parse_id(objective_id, "objective_id")
        project = get_project(pk, detail=False)
        try:
            return project, ProjectObjective.objects.get(project=project, pk=objective_id)
        except ProjectObjective.DoesNotExist:
            raise NotFound("Objective not found.")

    @transaction.atomic
    def patch(self, request, pk, objective_id):
        project, objective = self._get(pk, objective_id)
        ser = ObjectiveSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        new = ser.validated_data["description"]
        if new != objective.description:
            old = objective.description
            objective.description = new
            objective.save()
            log(
                "objective.updated",
                "project",
                project.id,
                f"You changed the objective “{old}” to “{new}”",
                project=project,
            )
        return detail_response(pk)

    @transaction.atomic
    def delete(self, request, pk, objective_id):
        project, objective = self._get(pk, objective_id)
        text = objective.description
        objective.delete()
        log("objective.removed", "project", project.id, f"You removed the objective “{text}”", project=project)
        return Response(status=204)


class ProjectDecisionView(APIView):
    @transaction.atomic
    def patch(self, request, pk):
        project = get_project(pk, detail=False)
        ser = DecisionSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        new = ser.validated_data["decision"]
        if new != project.decision:
            project.decision = new
            project.save()
            if new:
                log("decision.requested", "project", project.id, f"You asked for a decision on {project.name}: {new}", project=project)
            else:
                log("decision.cleared", "project", project.id, f"You cleared the decision on {project.name}", project=project)
        return detail_response(pk)


class ProjectDecisionResolveView(APIView):
    """Record the manager's outcome on the pending decision; the decision then leaves the pending list."""

    @transaction.atomic
    def post(self, request, pk):
        project = get_project(pk, detail=False, lock=True)
        ser = DecisionResolveSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if not project.decision:
            raise ValidationError({"decision": "There is no pending decision on this project."})
        on = rules.today()
        text = project.decision
        outcome, notes = data["outcome"], data["notes"]
        description = f"You decided “{text}” on {project.name}: {outcome}" + (f" ({notes})" if notes else "")
        project.decision = ""
        project.save()
        event = log("decision.resolved", "project", project.id, description, project=project, decision=text)
        record = DecisionRecord.objects.create(
            project=project,
            title=text,
            outcome=outcome,
            notes=notes,
            decision_date=data.get("decision_date") or on,
            project_name=project.name,
            lead_name=project.lead.name if project.lead else "",
            health=rules.health(project, on),
            deadline=project.end_date,
            context=f"{project.progress}% done with {rules.time_used(project, on)}% of the time used",
            event=event,
        )
        payload = project_payload(get_project(pk), detail=True)
        return Response(
            {"project": payload, "activity_id": event.id, "record": decision_record_payload(record)}, status=200
        )


class ProjectDecisionUndoView(APIView):
    """Restore a resolved decision. Only the project's latest resolve event can be undone,
    and only while no new decision has been entered."""

    @transaction.atomic
    def post(self, request, pk):
        project = get_project(pk, detail=False, lock=True)
        ser = DecisionUndoSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        activity_id = ser.validated_data.get("activity_id")
        event = ActivityLog.objects.filter(
            project=project, action="decision.resolved", pk=activity_id or 0
        ).first()
        if event is None:
            raise NotFound("There is no resolved decision to undo.")
        latest = ActivityLog.objects.filter(project=project, action="decision.resolved").first()
        if latest.pk != event.pk:
            raise Conflict("A newer decision has been resolved since; this one can no longer be undone.")
        if project.decision:
            raise Conflict("A new decision has already been entered on this project.")
        project.decision = event.details["decision"]
        project.save()
        DecisionRecord.objects.filter(event=event).delete()
        event.delete()  # the resolution is withdrawn, so it leaves the history
        return Response({"project": project_payload(get_project(pk), detail=True)})


def _parse_day(params, name):
    raw = params.get(name)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValidationError({name: f"{name} must be a date (YYYY-MM-DD)."})


class DecisionHistoryListView(APIView):
    """Decisions the manager has recorded, newest decision first. Read-only: records are created by
    resolving a pending decision and withdrawn by undoing it."""

    def get(self, request):
        params = request.query_params
        qs = DecisionRecord.objects.all()
        outcome = params.get("outcome", "all")
        if outcome != "all":
            if outcome not in Outcome.values:
                raise ValidationError({"outcome": "outcome must be all, " + ", ".join(v.lower() for v in Outcome.values) + "."})
            qs = qs.filter(outcome=outcome)
        if project := params.get("project"):
            qs = qs.filter(project_id=parse_id(project, "project"))
        if lead := params.get("lead"):
            qs = qs.filter(lead_name=lead)
        if start := _parse_day(params, "from"):
            qs = qs.filter(decision_date__gte=start)
        if end := _parse_day(params, "to"):
            qs = qs.filter(decision_date__lte=end)
        if q := params.get("q", "").strip():
            qs = qs.filter(Q(title__icontains=q) | Q(project_name__icontains=q) | Q(notes__icontains=q))
        total = qs.count()
        limit = parse_int(params.get("limit", DEFAULT_LIMIT), "limit", 1, MAX_LIMIT, f"limit must be between 1 and {MAX_LIMIT}.")
        offset = parse_int(params.get("offset", 0), "offset", 0, OFFSET_MAX, "offset must be a whole number.")
        rows = [decision_record_payload(r) for r in qs[offset : offset + limit]]
        return Response({"results": rows, "count": total, "limit": limit, "offset": offset})
