from django.conf import settings
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from common.access import ALL_ROLES
from common.params import parse_int
from projects.rules import today

from . import logic


def _list(rows):
    return Response({"results": rows, "count": len(rows)})


class SummaryView(APIView):
    def get(self, request):
        return Response(logic.summary(today()))


class AttentionView(APIView):
    def get(self, request):
        return _list(logic.attention(today()))


class KeyDatesView(APIView):
    def get(self, request):
        raw = request.query_params.get("days", str(logic.KEY_DATE_DAYS))
        days = parse_int(raw, "days", 1, 366, "days must be a whole number between 1 and 366.")
        return _list(logic.key_dates(today(), days))


class TeamWorkloadView(APIView):
    def get(self, request):
        return _list(logic.team_workload(today()))


class DecisionsView(APIView):
    def get(self, request):
        return _list(logic.decisions(today()))


class WeeklyBriefView(APIView):
    def get(self, request):
        return Response(logic.weekly_brief(today()))


class TodayView(APIView):
    """The server's authoritative calendar date. All overdue / due-today / key-date logic uses this date,
    computed in settings.TIME_ZONE. Clients render dates relative to it, never to their own clock's date."""

    role_policy = {"GET": ALL_ROLES}

    def get(self, request):
        now = timezone.localtime()
        return Response(
            {
                "date": now.date().isoformat(),
                "time_zone": settings.TIME_ZONE,
                "server_time": now.isoformat(timespec="seconds"),
            }
        )
