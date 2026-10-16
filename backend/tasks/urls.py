from django.urls import path

from .views import TaskCompleteView, TaskDetailView, TaskListView

urlpatterns = [
    path("", TaskListView.as_view()),
    path("<int:pk>/", TaskDetailView.as_view()),
    path("<int:pk>/complete/", TaskCompleteView.as_view()),
]
