from django.urls import path

from . import views

urlpatterns = [
    path("summary/", views.SummaryView.as_view()),
    path("attention/", views.AttentionView.as_view()),
    path("key-dates/", views.KeyDatesView.as_view()),
    path("team-workload/", views.TeamWorkloadView.as_view()),
    path("decisions/", views.DecisionsView.as_view()),
]
