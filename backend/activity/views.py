from rest_framework.response import Response
from rest_framework.views import APIView

from common.params import OFFSET_MAX, parse_int

from .models import ActivityLog

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _int_param(params, name, default, minimum):
    raw = params.get(name)
    if raw is None:
        return default
    return parse_int(raw, name, minimum, OFFSET_MAX, f"{name} must be a whole number of at least {minimum}.")


def activity_row(entry: ActivityLog) -> dict:
    return {
        "id": entry.id,
        "action": entry.action,
        "entity_type": entry.entity_type,
        "entity_id": entry.entity_id,
        "project": entry.project_id,
        "description": entry.description,
        "created_at": entry.created_at,
    }


def activity_page(queryset, params) -> Response:
    """Newest first, paged with limit/offset."""
    limit = min(_int_param(params, "limit", DEFAULT_LIMIT, 1), MAX_LIMIT)
    offset = _int_param(params, "offset", 0, 0)
    total = queryset.count()
    rows = [activity_row(e) for e in queryset[offset : offset + limit]]
    return Response({"results": rows, "count": total, "limit": limit, "offset": offset})


class ActivityListView(APIView):
    def get(self, request):
        return activity_page(ActivityLog.objects.all(), request.query_params)
