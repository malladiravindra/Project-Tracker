from django.contrib import admin

from .models import ActivityLog


@admin.register(ActivityLog)
class ActivityLogAdmin(admin.ModelAdmin):
    """Immutable audit trail: view-only in admin."""

    list_display = ("id", "created_at", "action", "entity_type", "entity_id", "project", "description")
    list_filter = ("action", "entity_type")
    search_fields = ("description", "action", "project__name")
    ordering = ("-created_at", "-id")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
