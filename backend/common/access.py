"""Role-based access control for the API.

Roles (members.models.Role) come from the user's server-side UserProfile, never from the request:
  - admin:   everything, including creating and deleting employees. Django superusers are always admins.
  - manager: read everything; create, change and delete projects, tasks, decisions and teams; edit employees.
  - member:  an employee. Sees only the projects they are on and the tasks in them, may update the status/note of
             tasks they own and share their own daily updates. No dashboards, reports, activity or directory.
A signed-in user without a role gets 403 on everything. Unauthenticated requests get 401 (JWTAuthentication).

Every view declares who may call which HTTP method with `role_policy`; a view or method that does not say is
STAFF_ROLES only (admin + manager), so a new endpoint is private by default. Views that admit the `member` role
must also scope the data to that user (see the helpers below).
"""

from django.core.exceptions import ObjectDoesNotExist
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import BasePermission

ADMIN, MANAGER, MEMBER = "admin", "manager", "member"
ALL_ROLES = frozenset({ADMIN, MANAGER, MEMBER})
STAFF_ROLES = frozenset({ADMIN, MANAGER})
ADMIN_ONLY = frozenset({ADMIN})


def profile_of(user):
    try:
        return user.profile
    except (ObjectDoesNotExist, AttributeError):
        return None


def role_of(user):
    """The user's role, or None when unauthenticated, inactive or without an assigned role."""
    if user is None or not user.is_authenticated or not user.is_active:
        return None
    if user.is_superuser:
        return ADMIN
    profile = profile_of(user)
    return profile.role if profile else None


def is_staff_role(user) -> bool:
    return role_of(user) in STAFF_ROLES


def member_id_of(user):
    profile = profile_of(user)
    return profile.member_id if profile else None


class RolePermission(BasePermission):
    message = "Your role does not allow this action."

    def has_permission(self, request, view):
        role = role_of(request.user)
        if role is None:
            return False
        method = "GET" if request.method in ("HEAD", "OPTIONS") else request.method
        policy = getattr(view, "role_policy", None) or {}
        return role in policy.get(method, policy.get("*", STAFF_ROLES))


def visible_project_ids(user):
    """None = every project (staff roles); otherwise the ids of the projects this employee is on."""
    if is_staff_role(user):
        return None
    from projects.models import ProjectMember

    mid = member_id_of(user)
    return set() if mid is None else set(ProjectMember.objects.filter(member_id=mid).values_list("project_id", flat=True))


def assert_project_visible(user, project_id):
    ids = visible_project_ids(user)
    if ids is not None and project_id not in ids:
        raise NotFound("Project not found.")  # 404, not 403: do not reveal that it exists


def assert_task_access(user, task, *, write):
    """Read: the task's project is visible to the user (or they own the task). Write: staff, or the task's owner."""
    if is_staff_role(user):
        return
    ids = visible_project_ids(user)
    mine = task.owner_id == member_id_of(user)
    if not (mine or task.project_id in ids):
        raise NotFound("Task not found.")
    if write and not mine:
        raise PermissionDenied("You can only change tasks that are assigned to you.")
