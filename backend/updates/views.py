from datetime import date

from django.db import IntegrityError, transaction
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from activity.services import log
from common.access import ALL_ROLES, is_staff_role, member_id_of
from common.exceptions import Conflict
from common.limits import LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT
from common.params import OFFSET_MAX, parse_id, parse_int

from .models import DailyUpdate, Feedback, ReviewStatus
from .serializers import DailyUpdateEditSerializer, DailyUpdateWriteSerializer, FeedbackSerializer, update_payload
from .tasklink import tasks_by_key


def _payloads(updates) -> list:
    """Payloads for many updates, fetching all their tasks in one query."""
    updates = list(updates)
    found = tasks_by_key(updates)
    return [update_payload(u, found.get((u.employee_id, u.project_id, u.date), [])) for u in updates]

DUPLICATE_MESSAGE = "An update from this person for this project and day already exists. Edit it instead."


def _queryset():
    return DailyUpdate.objects.select_related("employee", "project").prefetch_related("feedback")


def get_update(pk, lock=False) -> DailyUpdate:
    qs = DailyUpdate.objects.select_for_update() if lock else _queryset()  # locking must not join the prefetches
    try:
        return qs.get(pk=pk)
    except DailyUpdate.DoesNotExist:
        raise NotFound("Daily update not found.")


def _parse_day(params, name):
    raw = params.get(name)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise ValidationError({name: f"{name} must be a date (YYYY-MM-DD)."})


class DailyUpdateListView(APIView):
    role_policy = {"GET": ALL_ROLES, "POST": ALL_ROLES}

    def get(self, request):
        params = request.query_params
        qs = _queryset()
        staff = is_staff_role(request.user)
        if not staff:  # an employee sees only their own updates
            qs = qs.filter(employee_id=member_id_of(request.user))
        if project := params.get("project"):
            qs = qs.filter(project_id=parse_id(project, "project"))
        if employee := params.get("employee"):
            qs = qs.filter(employee_id=parse_id(employee, "employee"))
        if on := _parse_day(params, "date"):
            qs = qs.filter(date=on)
        review = params.get("review", "all")
        if review != "all":
            if review not in ReviewStatus.values:
                raise ValidationError({"review": "review must be all, new, reviewed or feedback."})
            qs = qs.filter(review_status=review)
        limit = parse_int(params.get("limit", LIST_DEFAULT_LIMIT), "limit", 1, LIST_MAX_LIMIT, f"limit must be between 1 and {LIST_MAX_LIMIT}.")
        offset = parse_int(params.get("offset", 0), "offset", 0, OFFSET_MAX, "offset must be a whole number.")
        q = params.get("q", "").strip().lower()
        if not q:
            total = qs.count()
            rows = _payloads(qs[offset : offset + limit])
        else:
            # Text lives in JSON lists, which SQL LIKE cannot search portably: match in Python, then cut the page.
            matches = [
                r
                for r in _payloads(qs)
                if q in " ".join([r["project_name"], r["employee_name"], r["notes"], *r["completed"], *r["in_progress"], *r["next_steps"], *r["blockers"]]).lower()
            ]
            total = len(matches)
            rows = matches[offset : offset + limit]
        new_qs = DailyUpdate.objects.filter(review_status=ReviewStatus.NEW)
        new_count = (new_qs if staff else new_qs.filter(employee_id=member_id_of(request.user))).count()
        return Response({"results": rows, "count": total, "limit": limit, "offset": offset, "new_count": new_count})

    @transaction.atomic
    def post(self, request):
        ser = DailyUpdateWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if not is_staff_role(request.user) and data["employee"].pk != member_id_of(request.user):
            raise PermissionDenied("You can only share updates for yourself.")
        if DailyUpdate.objects.filter(employee=data["employee"], project=data["project"], date=data["date"]).exists():
            raise Conflict(DUPLICATE_MESSAGE)
        try:
            with transaction.atomic():
                update = DailyUpdate.objects.create(**data)
        except IntegrityError:  # a concurrent request created the same update between the check and the insert
            raise Conflict(DUPLICATE_MESSAGE)
        log(
            "update.shared",
            "update",
            update.id,
            f"{update.employee.name} shared a daily update on {update.project.name}",
            project=update.project,
        )
        return Response(update_payload(get_update(update.pk)), status=201)


def _own_or_staff(user, update):
    if not is_staff_role(user) and update.employee_id != member_id_of(user):
        raise NotFound("Daily update not found.")


class DailyUpdateDetailView(APIView):
    role_policy = {"GET": ALL_ROLES, "PATCH": ALL_ROLES}

    def get(self, request, pk):
        update = get_update(pk)
        _own_or_staff(request.user, update)
        return Response(update_payload(update))

    @transaction.atomic
    def patch(self, request, pk):
        update = get_update(pk, lock=True)
        _own_or_staff(request.user, update)
        if not is_staff_role(request.user) and "review_status" in request.data:
            raise PermissionDenied("Only a manager can review updates.")
        ser = DailyUpdateEditSerializer(update, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = dict(ser.validated_data)
        # Marking as reviewed only moves New -> Reviewed; later states are never downgraded.
        if data.pop("review_status", None) == ReviewStatus.REVIEWED and update.review_status == ReviewStatus.NEW:
            update.review_status = ReviewStatus.REVIEWED
        for field, value in data.items():
            setattr(update, field, value)
        update.save()
        return Response(update_payload(get_update(pk)))


class DailyUpdateFeedbackView(APIView):
    @transaction.atomic
    def post(self, request, pk):
        update = get_update(pk, lock=True)
        ser = FeedbackSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        Feedback.objects.create(
            update=update,
            type=data["type"],
            content=data["content"],
        )
        update.review_status = ReviewStatus.FEEDBACK
        update.save()
        log(
            "update.feedback",
            "update",
            update.id,
            f"You gave feedback on {update.employee.name}'s update for {update.project.name}",
            project=update.project,
        )
        return Response(update_payload(get_update(pk)), status=201)
