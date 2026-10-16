"""Audit probes for the tasks and activity endpoints - see audit_support.py."""

from activity.models import ActivityLog
from tests.audit_support import AuditCase
from tests.support import day
from tasks.models import Task


class TaskAudit(AuditCase):
    def setUp(self):
        self.lead = self.member(name="Lead One")
        self.other = self.member(name="Other Two")
        self.proj = self.project(lead=self.lead, name="Alpha")
        self.proj2 = self.project(lead=self.other, name="Beta")

    def body(self, **extra):
        return {"title": "Do it", "project_id": self.proj.id, "owner_id": self.lead.id, "due_date": day(3).isoformat(), **extra}

    def test_tasks(self):
        L, D, C = "/tasks/", "/tasks/<id>/", "/tasks/<id>/complete/"
        od = self.task(project=self.proj, owner=self.lead, title="overdue one", due=-2, priority="High")
        self.task(project=self.proj, owner=self.lead, title="due today", due=0)
        self.task(project=self.proj2, owner=self.other, title="blocked one", due=4, state="blocked", note="waiting")
        self.task(project=self.proj2, owner=self.other, title="later one", due=20, priority="Low")
        self.task(project=self.proj, owner=self.other, title="finished", due=-9, state="done")
        titles = lambda **p: sorted(r["title"] for r in self.get(L, **p).data["results"])

        # the "counts" object is computed over ALL tasks per group; assert the exact expected values separately
        def counts():
            c = self.get(L).data["counts"]
            self.assertEqual((c["overdue"], c["today"], c["blocked"], c["later"], c["done"]), (1, 1, 1, 1, 1))
            return 200

        def shape():
            r = self.get(L)
            self.expect(r, 200)
            self.assertEqual(r.data["count"], 4)
            self.assertEqual(r.data["results"][0]["title"], "overdue one", "ordered by due date")
            for k in ("id", "title", "project", "project_name", "owner", "owner_name", "due_date", "due_offset", "state", "priority", "note", "group", "bucket", "due_label"):
                self.assertIn(k, r.data["results"][0])
            return 200

        self.probe("GET", L, "valid", "open tasks (done excluded), shape, due-date order", shape)
        self.probe("GET", L, "valid", "group counts object is exact", counts)
        self.probe("GET", L, "filter", "status=all|done|blocked|in-progress", lambda: self.assertEqual((len(titles(status="all")), titles(status="done"), titles(status="blocked"), titles(status="in-progress")), (5, ["finished"], ["blocked one"], [])) or 200)
        self.probe("GET", L, "filter", "q matches title/owner/project", lambda: self.assertEqual((titles(q="later"), titles(q="other two"), titles(q="beta")), (["later one"], ["blocked one", "later one"], ["blocked one", "later one"])) or 200)
        self.probe("GET", L, "filter", "project + owner + priority filters", lambda: self.assertEqual((titles(project=self.proj2.id), titles(owner=self.lead.id), titles(priority="High")), (["blocked one", "later one"], ["due today", "overdue one"], ["overdue one"])) or 200)
        self.probe("GET", L, "filter", "group filter", lambda: self.assertEqual((titles(group="overdue"), titles(group="today"), titles(group="blocked"), titles(group="later")), (["overdue one"], ["due today"], ["blocked one"], ["later one"])) or 200)
        self.probe("GET", L, "filter", "due_from/due_to/month", lambda: self.assertEqual((titles(due_from=day(10).isoformat()), titles(due_to=day(-1).isoformat()), len(titles(month=day(0).isoformat()[:7], status="all")) > 0), (["later one"], ["overdue one"], True)) or 200)
        for q in ({"status": "bogus"}, {"group": "bogus"}, {"project": "abc"}, {"owner": "-1"}, {"due_from": "x"}, {"due_to": "31/12/2026"}, {"month": "2026-13"}, {"month": "abc"}):
            self.probe("GET", L, "invalid-query", f"{q} -> 400", lambda q=q: self.envelope(self.get(L, **q), 400))
        self.probe("GET", L, "invalid-query", "priority=bogus -> 400", lambda: self.envelope(self.get(L, priority="bogus"), 400))

        def create():
            r = self.post(L, self.body(title="  New   task ", note=" n "))
            self.expect(r, 201)
            t = Task.objects.get(pk=r.data["id"])
            self.assertEqual((t.title, t.state, t.priority, t.note, t.project_id, t.owner_id), ("New task", "not-started", "Medium", "n", self.proj.id, self.lead.id), "not persisted")
            self.assertTrue(ActivityLog.objects.filter(action="task.created", entity_id=t.id).exists())
            return 201

        self.probe("POST", L, "valid", "creates with defaults, trims, persists, logs", create)
        self.probe("POST", L, "valid", "explicit priority/state accepted", lambda: (lambda r: (self.expect(r, 201), self.assertEqual((r.data["priority"], r.data["state"]), ("High", "in-progress"))))(self.post(L, self.body(priority="High", state="in-progress")))[0])
        self.probe("POST", L, "business-rule", "blocked without note -> 400; with note -> 201", lambda: (self.envelope(self.post(L, self.body(state="blocked")), 400), self.expect(self.post(L, self.body(state="blocked", note="why")), 201))[0])
        for field in ("title", "project_id", "owner_id"):  # due_date is optional
            self.bad("POST", L, L, {k: v for k, v in self.body().items() if k != field}, name=f"missing {field}")
        for extra in ({"title": "  "}, {"title": "x" * 301}, {"project_id": 999999}, {"owner_id": 999999}, {"project_id": "abc"}, {"due_date": "tomorrow"}, {"due_date": ""}, {"priority": "Urgent"}, {"state": "paused"}, {"note": "n" * 2001}, {"title": ["a"]}):
            self.bad("POST", L, L, self.body(**extra))

        def no_residue():
            n = Task.objects.count()
            self.post(L, self.body(priority="Urgent"))
            self.assertEqual(Task.objects.count(), n)
            return 400

        self.probe("POST", L, "invalid-input", "rejected request creates nothing", no_residue)

        # detail
        self.probe("GET", D, "valid", "detail incl. derived group/label", lambda: (lambda r: (self.expect(r, 200), self.assertEqual((r.data["group"], r.data["due_label"], r.data["due_offset"]), ("overdue", "2 days overdue", -2))))(self.get(f"/tasks/{od.id}/"))[0])
        self.not_found("GET", D, "/tasks/999999/")
        self.probe("GET", D, "invalid-input", "huge numeric id -> 404", lambda: self.envelope(self.get("/tasks/" + "9" * 30 + "/"), 404))

        # patch
        def patch_ok():
            r = self.patch(f"/tasks/{od.id}/", {"title": "Renamed", "owner_id": self.other.id, "due_date": day(5).isoformat(), "priority": "Low", "state": "in-progress", "note": "n"})
            self.expect(r, 200)
            od.refresh_from_db()
            self.assertEqual((od.title, od.owner_id, od.due_date, od.priority, od.state, od.note), ("Renamed", self.other.id, day(5), "Low", "in-progress", "n"), "not persisted")
            self.assertTrue(ActivityLog.objects.filter(action="task.updated", entity_id=od.id).exists())
            return 200

        self.probe("PATCH", D, "valid", "all fields persist + one activity entry", patch_ok)

        def patch_noop():
            n = ActivityLog.objects.count()
            self.expect(self.patch(f"/tasks/{od.id}/", {}), 200)
            self.expect(self.patch(f"/tasks/{od.id}/", {"priority": "Low"}), 200)
            self.assertEqual(ActivityLog.objects.count(), n)
            return 200

        self.probe("PATCH", D, "valid", "unchanged values write no activity", patch_noop)
        self.probe("PATCH", D, "business-rule", "blocked needs a note (new or existing)", lambda: (self.envelope(self.patch(f"/tasks/{od.id}/", {"state": "blocked", "note": ""}), 400), self.expect(self.patch(f"/tasks/{od.id}/", {"state": "blocked", "note": "x"}), 200), self.envelope(self.patch(f"/tasks/{od.id}/", {"note": ""}), 400))[0])
        self.probe("PATCH", D, "business-rule", "task cannot move to another project -> 400", lambda: (self.envelope(self.patch(f"/tasks/{od.id}/", {"project_id": self.proj2.id}), 400), self.assertEqual(Task.objects.get(pk=od.id).project_id, self.proj.id))[0])
        self.probe("PATCH", D, "valid", "project_id equal to current is accepted", lambda: self.expect(self.patch(f"/tasks/{od.id}/", {"project_id": self.proj.id, "state": "in-progress"}), 200))

        def protected():
            r = self.patch(f"/tasks/{od.id}/", {"id": 99999, "group": "done", "created_at": "2000-01-01T00:00:00Z"})
            self.expect(r, 200)
            self.assertEqual(r.data["id"], od.id)
            self.assertNotEqual(r.data["group"], "done")
            return 200

        self.probe("PATCH", D, "security", "id/derived fields cannot be overwritten", protected)
        for body in ({"title": ""}, {"owner_id": 999999}, {"due_date": "x"}, {"priority": "Urgent"}, {"state": "paused"}, {"note": "n" * 2001}):
            self.bad("PATCH", D, f"/tasks/{od.id}/", body)
        self.not_found("PATCH", D, "/tasks/999999/", {"title": "x"})

        # complete
        def complete():
            t = self.task(project=self.proj, owner=self.lead, title="to finish", due=1)
            r = self.post(f"/tasks/{t.id}/complete/")
            self.expect(r, 200)
            t.refresh_from_db()
            self.assertEqual(t.state, "done", "not persisted")
            n = ActivityLog.objects.filter(action="task.completed").count()
            self.expect(self.post(f"/tasks/{t.id}/complete/"), 200)
            self.assertEqual(ActivityLog.objects.filter(action="task.completed").count(), n, "repeat must not log again")
            return 200

        self.probe("POST", C, "valid", "marks done, persists, idempotent (one log)", complete)
        self.probe("POST", C, "valid", "blocked task can be completed", lambda: (lambda t: (self.expect(self.post(f"/tasks/{t.id}/complete/"), 200), self.assertEqual(Task.objects.get(pk=t.id).state, "done")))(self.task(project=self.proj, owner=self.lead, state="blocked", note="x"))[0])
        self.not_found("POST", C, "/tasks/999999/complete/")

        # delete
        def delete_ok():
            t = self.task(project=self.proj, owner=self.lead, title="bye")
            self.expect(self.delete(f"/tasks/{t.id}/"), 204)
            self.assertFalse(Task.objects.filter(pk=t.id).exists())
            self.assertEqual(list(ActivityLog.objects.filter(entity_type="task", entity_id=t.id).values_list("action", flat=True)), ["task.deleted"])
            self.assertEqual(self.delete(f"/tasks/{t.id}/").status_code, 404)
            return "204 then 404"

        self.probe("DELETE", D, "valid", "removes task, logs, repeat -> 404", delete_ok)
        self.not_found("DELETE", D, "/tasks/999999/")

    def test_activity(self):
        A = "/activity/"
        for n in range(5):
            self.post("/tasks/", self.body(title=f"t{n}"))

        def listing():
            r = self.get(A)
            self.expect(r, 200)
            self.assertEqual(r.data["count"], ActivityLog.objects.count())
            self.assertEqual(r.data["results"][0]["description"], "You added “t4”", "newest first")
            for k in ("id", "action", "entity_type", "entity_id", "project", "description", "created_at"):
                self.assertIn(k, r.data["results"][0])
            return 200

        self.probe("GET", A, "valid", "newest first with full row shape", listing)
        self.probe("GET", A, "paging", "limit/offset windows do not overlap", lambda: (lambda a, b: self.assertFalse({r["id"] for r in a} & {r["id"] for r in b}))(self.get(A, limit=2).data["results"], self.get(A, limit=2, offset=2).data["results"]) or 200)
        self.probe("GET", A, "paging", "limit above max capped at 200; offset past end -> empty", lambda: (self.assertEqual(self.get(A, limit=99999).data["limit"], 200), self.assertEqual(self.get(A, offset=10000).data["results"], []))[0] or 200)
        for q in ({"limit": 0}, {"limit": "x"}, {"limit": "-5"}, {"offset": -1}, {"offset": "1e3"}, {"offset": "9" * 30}):
            self.probe("GET", A, "invalid-query", f"{q} -> 400", lambda q=q: self.envelope(self.get(A, **q), 400))
