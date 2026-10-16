from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.models import User

from .models import Member, UserProfile


@admin.register(Member)
class MemberAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "title", "department", "load", "created_at")
    list_filter = ("department",)
    search_fields = ("name", "title", "department")
    ordering = ("name",)
    readonly_fields = ("created_at", "updated_at")


class UserProfileInline(admin.StackedInline):
    model = UserProfile
    can_delete = False
    verbose_name_plural = "Project Tracker role"


class UserAdmin(BaseUserAdmin):
    """Roles are assigned here, by an administrator only."""

    inlines = [UserProfileInline]


admin.site.unregister(User)
admin.site.register(User, UserAdmin)
