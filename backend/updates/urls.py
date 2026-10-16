from django.urls import path

from . import views

urlpatterns = [
    path("", views.DailyUpdateListView.as_view()),
    path("<int:pk>/", views.DailyUpdateDetailView.as_view()),
    path("<int:pk>/feedback/", views.DailyUpdateFeedbackView.as_view()),
]
