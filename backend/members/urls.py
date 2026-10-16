from django.urls import path

from .views import DepartmentListView, MemberDetailView, MemberListView

urlpatterns = [
    path("", MemberListView.as_view()),
    path("departments/", DepartmentListView.as_view()),
    path("<int:pk>/", MemberDetailView.as_view()),
]
