from django.db import transaction
from django.db.models import Q
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from activity.services import log
from common.access import ADMIN_ONLY, ALL_ROLES, STAFF_ROLES, is_staff_role, member_id_of
from common.exceptions import Conflict
from common.params import parse_id
from projects.models import DEFAULT_ROLE, LEAD_ROLE, Project, ProjectMember
from projects.rules import today as today_fn

from .models import Member
from .serializers import MemberWriteSerializer, member_payload, with_stats


SHOW_VALUES = ("all", "stretched", "overdue", "blocked")
OPTIONAL_FIELDS = ("load", "email", "phone", "status", "employment_type", "start_date")
EDITABLE_FIELDS = ("name", "title", "department", *OPTIONAL_FIELDS)
SORT_VALUES = ("stretched", "name", "tasks")


def _shown(value) -> str:
    return "(none)" if value in ("", None) else str(value)


def get_member(pk, lock=False) -> Member:
    qs = with_stats(Member.objects.all())
    if lock:
        qs = qs.select_for_update()  # no-op on SQLite
    try:
        return qs.get(pk=pk)
    except Member.DoesNotExist:
        raise NotFound("Member not found.")


class MemberListView(APIView):
    role_policy = {"GET": STAFF_ROLES, "POST": ADMIN_ONLY}  # the directory holds contact details

    def get(self, request):
        params = request.query_params
        qs = Member.objects.all()
        if q := params.get("q", "").strip():
            qs = qs.filter(
                Q(name__icontains=q)
                | Q(title__icontains=q)
                | Q(department__icontains=q)
                | Q(email__icontains=q)
                | Q(memberships__project__name__icontains=q)
            ).distinct()
        if project := params.get("project"):
            qs = qs.filter(memberships__project_id=parse_id(project, "project"))
        show = params.get("show", "all")
        if show not in SHOW_VALUES:
            raise ValidationError({"show": "show must be all, stretched, overdue or blocked."})
        sort = params.get("sort", "stretched")
        if sort not in SORT_VALUES:
            raise ValidationError({"sort": "sort must be stretched, name or tasks."})
        on = today_fn()
        rows = [member_payload(m, on) for m in with_stats(qs)]

        if show == "stretched":
            rows = [r for r in rows if r["stretched"]]
        elif show == "overdue":
            rows = [r for r in rows if r["overdue_tasks"] > 0]
        elif show == "blocked":
            rows = [r for r in rows if r["blocked_tasks"] > 0]

        if sort == "name":
            rows.sort(key=lambda r: r["name"].lower())
        elif sort == "tasks":
            rows.sort(key=lambda r: (-r["open_tasks"], -r["load"]))
        else:
            rows.sort(key=lambda r: -r["load"])
        return Response({"results": rows, "count": len(rows)})

    @transaction.atomic
    def post(self, request):
        ser = MemberWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        member = Member.objects.create(
            name=data["name"],
            title=data["title"],
            department=data["department"],
            **{field: data[field] for field in OPTIONAL_FIELDS if field in data},
        )
        log(
            "member.created",
            "member",
            member.id,
            f"You added {member.name} ({member.title}, {member.department}) to the team",
        )
        for item in data.get("memberships", []):
            ProjectMember.objects.create(project=item["project"], member=member, role=item["role"])
            log(
                "membership.added",
                "project",
                item["project"].id,
                f"You added {member.name} to the team as {item['role']}",
                project=item["project"],
            )
        return Response(member_payload(get_member(member.pk)), status=201)


def _sync_memberships(member: Member, wanted: list) -> None:
    """Make the member's project list match `wanted` exactly: add, re-role and remove in one step.

    A project the member leads cannot be dropped and keeps its lead role; change the lead on the project first.
    """
    current = {m.project_id: m for m in ProjectMember.objects.filter(member=member).select_related("project")}
    # Partial updates skip serializer defaults, so a missing role is filled in here.
    wanted_by_project = {item["project"].pk: {**item, "role": item.get("role") or DEFAULT_ROLE} for item in wanted}
    led = set(Project.objects.filter(lead=member).values_list("pk", flat=True))

    problems = []
    for project_id in led:
        item = wanted_by_project.get(project_id)
        if item is None:
            problems.append(
                f"{member.name} leads {current[project_id].project.name if project_id in current else 'a project'}. "
                "Change the project lead before removing them from it."
            )
        elif item["role"] != LEAD_ROLE and project_id in current and current[project_id].role == LEAD_ROLE:
            problems.append(f"{member.name} leads {item['project'].name}, so their role there stays {LEAD_ROLE}.")
    if problems:
        raise ValidationError({"memberships": problems})

    for project_id, membership in current.items():
        if project_id not in wanted_by_project:
            membership.delete()
            log(
                "membership.removed",
                "project",
                project_id,
                f"You removed {member.name} from the team",
                project=membership.project,
            )
    for project_id, item in wanted_by_project.items():
        membership = current.get(project_id)
        if membership is None:
            ProjectMember.objects.create(project=item["project"], member=member, role=item["role"])
            log(
                "membership.added",
                "project",
                project_id,
                f"You added {member.name} to the team as {item['role']}",
                project=item["project"],
            )
        elif membership.role != item["role"]:
            before = membership.role
            membership.role = item["role"]
            membership.save(update_fields=["role"])
            log(
                "membership.updated",
                "project",
                project_id,
                f"You changed {member.name}'s role from {before} to {item['role']}",
                project=item["project"],
            )


class MemberDetailView(APIView):
    role_policy = {"GET": ALL_ROLES, "PATCH": STAFF_ROLES, "DELETE": ADMIN_ONLY}

    def get(self, request, pk):
        if not is_staff_role(request.user) and pk != member_id_of(request.user):
            raise NotFound("Member not found.")  # an employee can read only their own record
        return Response(member_payload(get_member(pk)))

    @transaction.atomic
    def patch(self, request, pk):
        member = get_member(pk, lock=True)
        ser = MemberWriteSerializer(member, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        changes = []
        changed_fields = []
        for field in EDITABLE_FIELDS:
            if field in ser.validated_data and ser.validated_data[field] != getattr(member, field):
                before, after = getattr(member, field), ser.validated_data[field]
                changes.append(f"{field.replace('_', ' ')} {_shown(before)} -> {_shown(after)}")
                setattr(member, field, ser.validated_data[field])
                changed_fields.append(field)
        if changes:
            member.save(update_fields=[*changed_fields, "updated_at"])
            log("member.updated", "member", member.id, f"You updated {member.name}: {', '.join(changes)}")
        if "memberships" in ser.validated_data:
            _sync_memberships(member, ser.validated_data["memberships"])
        return Response(member_payload(get_member(pk)))

    @transaction.atomic
    def delete(self, request, pk):
        member = get_member(pk)
        led = Project.objects.filter(lead=member).count()
        owned = member.tasks.count()
        updates = member.daily_updates.count()
        if led or owned or updates:
            parts = []
            if led:
                parts.append(f"leads {led} project{'' if led == 1 else 's'}")
            if owned:
                parts.append(f"owns {owned} task{'' if owned == 1 else 's'}")
            if updates:
                parts.append(f"has shared {updates} daily update{'' if updates == 1 else 's'}")
            raise Conflict(f"{member.name} {' and '.join(parts)}. Reassign their work before removing this person.")
        name, member_id = member.name, member.id
        member.delete()
        log("member.deleted", "member", member_id, f"You removed {name} from the team")
        return Response(status=204)


class DepartmentListView(APIView):
    def get(self, request):
        names = set(Member.objects.values_list("department", flat=True))
        names |= set(Project.objects.values_list("department", flat=True))
        names.discard("")
        ordered = sorted(names, key=str.lower)
        return Response({"results": ordered, "count": len(ordered)})
