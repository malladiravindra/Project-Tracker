from django.contrib import admin

from .models import DecisionRecord, Project, ProjectMember, ProjectObjective


class ProjectMemberInline(admin.TabularInline):
    model = ProjectMember
    extra = 0
    autocomplete_fields = ("member",)


class ProjectObjectiveInline(admin.TabularInline):
    model = ProjectObjective
    extra = 0


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "department", "lead", "phase", "progress", "start_date", "end_date")
    list_filter = ("phase", "department")
    search_fields = ("name", "department", "lead__name")
    ordering = ("id",)
    autocomplete_fields = ("lead",)
    readonly_fields = ("created_at", "updated_at")
    inlines = (ProjectMemberInline, ProjectObjectiveInline)


@admin.register(ProjectMember)
class ProjectMemberAdmin(admin.ModelAdmin):
    list_display = ("id", "project", "member", "role")
    list_filter = ("role",)
    search_fields = ("project__name", "member__name", "role")
    autocomplete_fields = ("project", "member")


@admin.register(ProjectObjective)
class ProjectObjectiveAdmin(admin.ModelAdmin):
    list_display = ("id", "project", "description")
    search_fields = ("project__name", "description")
    autocomplete_fields = ("project",)
    readonly_fields = ("created_at", "updated_at")


@admin.register(DecisionRecord)
class DecisionRecordAdmin(admin.ModelAdmin):
    """Audit history of manager decisions: view-only so records cannot be altered or removed here."""

    list_display = ("id", "title", "outcome", "project_name", "lead_name", "decision_date", "recorded_at")
    list_filter = ("outcome", "decision_date")
    search_fields = ("title", "project_name", "lead_name", "notes")
    ordering = ("-decision_date", "-recorded_at", "-id")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
