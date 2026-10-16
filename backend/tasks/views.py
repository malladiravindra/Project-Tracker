from django.db import transaction
from django.db.models import Q
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from activity.services import log
from common.access import ALL_ROLES, STAFF_ROLES, assert_task_access, is_staff_role, member_id_of, visible_project_ids
from projects.rules import today as today_fn
from updates.tasklink import sync as sync_daily_update

from .models import State, Task
from .queries import filter_tasks, group_counts
from .serializers import TaskCreateSerializer, TaskUpdateSerializer, task_payload


def fmt_date(d) -> str:
    return f"{d.day} {d.strftime('%b %Y')}" if d else "none"


def get_task(pk, lock=False) -> Task:
    qs = Task.objects.select_related("project", "owner")
    if lock:
        qs = qs.select_for_update(of=("self",))  # lock the task row only (no-op on SQLite)
    try:
        return qs.get(pk=pk)
    except Task.DoesNotExist:
        raise NotFound("Task not found.")


MEMBER_EDITABLE_FIELDS = {"state", "note"}  # an employee may update the status and note of their own tasks, nothing else


def scoped_tasks(user):
    """Staff roles see every task; an employee sees the tasks of their projects and the tasks they own."""
    if is_staff_role(user):
        return Task.objects.all()
    return Task.objects.filter(Q(project_id__in=visible_project_ids(user)) | Q(owner_id=member_id_of(user)))


def list_tasks_response(queryset, params, counts_base=None):
    on = today_fn()
    filtered, error = filter_tasks(queryset.select_related("project", "owner"), params, on)
    if error:
        raise ValidationError({"detail": error})
    rows = [task_payload(t, on) for t in filtered]
    return Response({"results": rows, "count": len(rows), "counts": group_counts(on, counts_base)})


class TaskListView(APIView):
    role_policy = {"GET": ALL_ROLES, "POST": STAFF_ROLES}

    def get(self, request):
        base = scoped_tasks(request.user)
        return list_tasks_response(base, request.query_params, counts_base=None if is_staff_role(request.user) else base)

    @transaction.atomic
    def post(self, request):
        ser = TaskCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        task = Task.objects.create(**ser.validated_data)
        log("task.created", "task", task.id, f"You added “{task.title}”", project=task.project)
        sync_daily_update(task.owner_id, task.project_id, task.work_date)
        return Response(task_payload(get_task(task.pk)), status=201)


class TaskDetailView(APIView):
    role_policy = {"GET": ALL_ROLES, "PATCH": ALL_ROLES, "DELETE": STAFF_ROLES}

    def get(self, request, pk):
        task = get_task(pk)
        assert_task_access(request.user, task, write=False)
        return Response(task_payload(task))

    @transaction.atomic
    def patch(self, request, pk):
        task = get_task(pk, lock=True)
        assert_task_access(request.user, task, write=True)
        if not is_staff_role(request.user) and not set(request.data) <= MEMBER_EDITABLE_FIELDS:
            raise PermissionDenied("You can only update the status and note of your tasks.")
        ser = TaskUpdateSerializer(task, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        original_title = task.title
        before = (task.owner_id, task.project_id, task.work_date)
        state_before = task.state
        changes = []

        if "title" in data and data["title"] != task.title:
            changes.append(f"renamed to “{data['title']}”")
        if "owner" in data and data["owner"] != task.owner:
            changes.append(f"owner {task.owner.name} -> {data['owner'].name}")
        if "work_date" in data and data["work_date"] != task.work_date:
            changes.append(f"work date {fmt_date(task.work_date)} -> {fmt_date(data['work_date'])}")
        if "due_date" in data and data["due_date"] != task.due_date:
            changes.append(f"due {fmt_date(task.due_date)} -> {fmt_date(data['due_date'])}")
        if "priority" in data and data["priority"] != task.priority:
            changes.append(f"priority {task.priority} -> {data['priority']}")
        if "state" in data and data["state"] != task.state:
            changes.append(f"status {State(task.state).label} -> {State(data['state']).label}")
        if "note" in data and data["note"] != task.note:
            changes.append("note updated" if data["note"] else "note removed")

        for field, value in data.items():
            setattr(task, field, value)
        if changes:
            # Only the fields in this request are written, so a concurrent edit of a different field is not undone.
            task.save(update_fields=[*data.keys(), "updated_at"])
            log(
                "task.updated",
                "task",
                task.id,
                f"You updated “{original_title}”: {', '.join(changes)}",
                project=task.project,
            )
            # Keep Daily Work Updates in line: the old owner/day may lose this task, the new one gains it.
            after = (task.owner_id, task.project_id, task.work_date)
            if after != before:
                sync_daily_update(*before, touched=False)
            sync_daily_update(*after, touched=after != before or task.state != state_before)
        return Response(task_payload(get_task(pk)))

    @transaction.atomic
    def delete(self, request, pk):
        task = get_task(pk)
        title, task_id, project = task.title, task.id, task.project
        key = (task.owner_id, task.project_id, task.work_date)
        task.delete()  # its history is purged (activity.signals); one audit line replaces it
        log("task.deleted", "task", task_id, f"You deleted “{title}”", project=project)
        sync_daily_update(*key, touched=False)
        return Response(status=204)


class TaskCompleteView(APIView):
    role_policy = {"POST": ALL_ROLES}

    @transaction.atomic
    def post(self, request, pk):
        task = get_task(pk)
        assert_task_access(request.user, task, write=True)
        if task.state != State.DONE:
            task.state = State.DONE
            task.save()
            log("task.completed", "task", task.id, f"You marked “{task.title}” as Done", project=task.project)
            sync_daily_update(task.owner_id, task.project_id, task.work_date)
        return Response(task_payload(get_task(pk)))
