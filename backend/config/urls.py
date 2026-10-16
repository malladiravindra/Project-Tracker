from django.contrib import admin
from django.urls import include, path, re_path

from common.auth_views import LoginView, LogoutView, MeView, RefreshView
from common.views import api_not_found
from dashboard.views import TodayView, WeeklyBriefView
from projects.views import DecisionHistoryListView

handler500 = "common.views.server_error"

# Only /admin/ and /api/ exist. There is deliberately no route for "/" or a catch-all outside /api/, so browser
# URLs such as "/" or "/unknown/" get Django's standard HTML 404 page.
urlpatterns = [
    path("admin/", admin.site.urls),
    # Authentication. The only anonymous endpoints: auth/token/ and auth/token/refresh/ (common/auth_views.py)
    path("api/auth/token/", LoginView.as_view()),
    path("api/auth/token/refresh/", RefreshView.as_view()),
    path("api/auth/logout/", LogoutView.as_view()),
    path("api/auth/me/", MeView.as_view()),
    path("api/members/", include("members.urls")),
    path("api/projects/", include("projects.urls")),
    path("api/tasks/", include("tasks.urls")),
    path("api/activity/", include("activity.urls")),
    path("api/daily-updates/", include("updates.urls")),
    path("api/dashboard/", include("dashboard.urls")),
    # Single endpoints that do not belong to an app prefix
    path("api/decision-history/", DecisionHistoryListView.as_view()),
    path("api/today/", TodayView.as_view()),
    path("api/weekly-brief/", WeeklyBriefView.as_view()),
    # Must stay last: any unknown URL under /api/ (JSON 404, or a 308 when only the trailing slash is missing).
    re_path(r"^api/(?P<path>.*)$", api_not_found),
]
