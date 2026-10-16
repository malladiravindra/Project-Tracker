from django.urls import path

from . import views

urlpatterns = [
    path("", views.ProjectListView.as_view()),
    path("<int:pk>/", views.ProjectDetailView.as_view()),
    path("<int:pk>/history/", views.ProjectHistoryView.as_view()),
    path("<int:pk>/tasks/", views.ProjectTaskListView.as_view()),
    path("<int:pk>/members/", views.ProjectMemberListView.as_view()),
    path("<int:pk>/members/<int:member_id>/", views.ProjectMemberDetailView.as_view()),
    path("<int:pk>/objectives/", views.ProjectObjectiveListView.as_view()),
    path("<int:pk>/objectives/<int:objective_id>/", views.ProjectObjectiveDetailView.as_view()),
    path("<int:pk>/decision/", views.ProjectDecisionView.as_view()),
    path("<int:pk>/decision/resolve/", views.ProjectDecisionResolveView.as_view()),
    path("<int:pk>/decision/undo/", views.ProjectDecisionUndoView.as_view()),
]
