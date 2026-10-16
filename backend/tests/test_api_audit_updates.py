"""Audit probes for the daily-updates and feedback endpoints - see audit_support.py."""

from activity.models import ActivityLog
from tests.audit_support import AuditCase
from tests.support import day
from updates.models import DailyUpdate, Feedback


class UpdateAudit(AuditCase):
    def setUp(self):
        self.proj = self.project(name="Portal")
        self.proj2 = self.project(name="Other")
        self.person = self.member(name="Dev One")

    def body(self, **extra):
        return {"employee_id": self.person.id, "project_id": self.proj.id, "date": day(0).isoformat(), "completed": ["Built it", "  "], "in_progress": ["API"], "next_steps": ["Ship"], "blockers": [], "notes": " ok ", "status": "On track", **extra}

    def make(self, **extra):
        return self.post("/daily-updates/", self.body(**extra))

    def test_updates(self):
        L, D, F = "/daily-updates/", "/daily-updates/<id>/", "/daily-updates/<id>/feedback/"

        def create():
            r = self.make()
            self.expect(r, 201)
            u = DailyUpdate.objects.get(pk=r.data["id"])
            self.assertEqual((u.completed, u.notes, u.status, u.review_status, u.employee_id, u.project_id), (["Built it"], "ok", "On track", "new", self.person.id, self.proj.id), "not persisted/cleaned")
            self.assertTrue(ActivityLog.objects.filter(action="update.shared").exists())
            return 201

        self.probe("POST", L, "valid", "creates, cleans blank lines, persists, logs", create)
        body = self.body()
        self.probe("POST", L, "valid", "status defaults to On track", lambda: self.assertEqual(self.post(L, {**{k: v for k, v in body.items() if k != "status"}, "date": day(-1).isoformat()}).data["status"], "On track") or 201)
        for field in ("employee_id", "project_id", "date"):
            self.bad("POST", L, L, {k: v for k, v in self.body().items() if k != field}, name=f"missing {field}")
        for extra in ({"employee_id": 999999}, {"project_id": 999999}, {"date": day(1).isoformat()}, {"date": "x"}, {"status": "Fine"}, {"completed": "text"}, {"completed": ["x" * 501]}, {"completed": ["x"] * 51}, {"notes": "n" * 2001}, {"completed": [], "in_progress": [], "next_steps": [], "blockers": [], "notes": ""}):
            self.bad("POST", L, L, self.body(**{"date": day(-3).isoformat(), **extra}))
        self.probe("POST", L, "business-rule", "duplicate person+project+day -> 409", lambda: self.envelope(self.make(), 409))
        self.probe("POST", L, "valid", "same person, other project, same day is allowed", lambda: self.expect(self.make(project_id=self.proj2.id), 201))

        def list_ok():
            r = self.get(L)
            self.expect(r, 200)
            self.assertEqual(r.data["count"], len(r.data["results"]))
            self.assertIn("new_count", r.data)
            row = r.data["results"][0]
            for k in ("id", "employee", "employee_name", "project", "project_name", "date", "completed", "in_progress", "next_steps", "blockers", "notes", "status", "review_status", "shared_at", "feedback"):
                self.assertIn(k, row)
            return 200

        self.probe("GET", L, "valid", "list shape + new_count", list_ok)
        self.make(date=day(-2).isoformat(), completed=["Special wording"])
        ids = lambda **p: [r["id"] for r in self.get(L, **p).data["results"]]
        self.probe("GET", L, "sort", "newest working day first", lambda: self.assertEqual([r["date"] for r in self.get(L).data["results"]], sorted([r["date"] for r in self.get(L).data["results"]], reverse=True)) or 200)
        self.probe("GET", L, "filter", "project/employee/date/review/q", lambda: (self.assertTrue(all(r["project"] == self.proj2.id for r in self.get(L, project=self.proj2.id).data["results"])), self.assertEqual(len(ids(date=day(-2).isoformat())), 1), self.assertEqual(len(ids(q="special WORDING")), 1), self.assertEqual(ids(review="feedback"), []), self.assertEqual(len(ids(employee=self.person.id)), len(ids())))[0] or 200)
        self.probe("GET", L, "paging", "limit/offset + total count; q results paged too", lambda: (lambda r: self.assertEqual((r.data["count"] > 1, len(r.data["results"]), r.data["limit"], r.data["offset"]), (True, 1, 1, 1)))(self.get(L, limit=1, offset=1)) or 200)
        for q in ({"review": "bogus"}, {"date": "x"}, {"project": "abc"}, {"employee": "abc"}, {"limit": 0}, {"limit": 100000}, {"offset": -1}):
            self.probe("GET", L, "invalid-query", f"{q} -> 400", lambda q=q: self.envelope(self.get(L, **q), 400))

        uid = ids()[0]
        self.probe("GET", D, "valid", "detail", lambda: self.assertEqual(self.get(f"/daily-updates/{uid}/").data["id"], uid) or 200)
        self.not_found("GET", D, "/daily-updates/999999/")
        self.probe("GET", D, "invalid-input", "huge numeric id -> 404", lambda: self.envelope(self.get("/daily-updates/" + "9" * 30 + "/"), 404))

        def review():
            u = DailyUpdate.objects.get(pk=uid)
            r = self.patch(f"/daily-updates/{uid}/", {"review_status": "reviewed"})
            self.expect(r, 200)
            u.refresh_from_db()
            self.assertEqual(u.review_status, "reviewed", "not persisted")
            return 200

        self.probe("PATCH", D, "valid", "mark reviewed persists", review)
        self.probe("PATCH", D, "valid", "edits content in place, no duplicate row", lambda: (lambda n: (self.expect(self.patch(f"/daily-updates/{uid}/", {"completed": ["Changed"], "status": "Blocked", "notes": ""}), 200), self.assertEqual(DailyUpdate.objects.get(pk=uid).completed, ["Changed"]), self.assertEqual(DailyUpdate.objects.count(), n)))(DailyUpdate.objects.count())[0])

        def never_downgrade():
            self.post(f"/daily-updates/{uid}/feedback/", {"type": "Suggestion", "content": "x"})
            r = self.patch(f"/daily-updates/{uid}/", {"review_status": "reviewed"})
            self.assertEqual(r.data["review_status"], "feedback")
            return 200

        self.probe("PATCH", D, "business-rule", "reviewed never downgrades feedback-given", never_downgrade)
        for body_ in ({"review_status": "new"}, {"review_status": "feedback"}, {"status": "Meh"}, {"completed": "x"}, {"notes": "n" * 2001}):
            self.bad("PATCH", D, f"/daily-updates/{uid}/", body_)

        def identity():
            before = DailyUpdate.objects.get(pk=uid)
            orig = (before.employee_id, before.project_id, before.date)
            r = self.patch(f"/daily-updates/{uid}/", {"employee_id": self.person.id + 99, "project_id": self.proj2.id, "date": day(-9).isoformat(), "shared_at": "2000-01-01T00:00:00Z"})
            self.expect(r, 200)
            u = DailyUpdate.objects.get(pk=uid)
            self.assertEqual((u.employee_id, u.project_id, u.date), orig)
            self.assertGreater(u.shared_at.year, 2000)
            return 200

        self.probe("PATCH", D, "security", "employee/project/date/shared_at cannot be changed", identity)
        self.not_found("PATCH", D, "/daily-updates/999999/", {"notes": "x"})

        # feedback
        fb = f"/daily-updates/{uid}/feedback/"

        def feedback_ok():
            r = self.post(fb, {"type": "Appreciation", "content": " Great "})
            self.expect(r, 201)
            f = Feedback.objects.filter(update_id=uid).latest("id")
            self.assertEqual((f.type, f.content, f.manager_name), ("Appreciation", "Great", "Manager"))
            self.assertEqual(DailyUpdate.objects.get(pk=uid).review_status, "feedback")
            self.assertTrue(ActivityLog.objects.filter(action="update.feedback").exists())
            return 201

        self.probe("POST", F, "valid", "adds feedback, trims, sets status, logs", feedback_ok)

        def appends():
            n = Feedback.objects.filter(update_id=uid).count()
            r = self.post(fb, {"type": "Next steps", "content": "More"})
            self.assertEqual(Feedback.objects.filter(update_id=uid).count(), n + 1)
            self.assertEqual([f["content"] for f in r.data["feedback"]][-1], "More")
            return 201

        self.probe("POST", F, "valid", "repeat feedback appends (earlier kept, oldest first)", appends)

        def actor():
            r = self.post(fb, {"type": "Suggestion", "content": "y", "manager_name": "Impostor", "update": 1, "update_id": 1})
            self.expect(r, 201)
            self.assertEqual(r.data["feedback"][-1]["manager_name"], "Manager")
            self.assertEqual(Feedback.objects.exclude(update_id=uid).count(), 0)
            return 201

        self.probe("POST", F, "security", "actor name and target update cannot be supplied by the caller", actor)
        for body_ in ({"type": "Suggestion", "content": "   "}, {"type": "Rant", "content": "x"}, {"content": "x"}, {"type": "Suggestion"}, {"type": "Suggestion", "content": "c" * 2001}, {}):
            self.bad("POST", F, fb, body_)
        self.not_found("POST", F, "/daily-updates/999999/feedback/", {"type": "Suggestion", "content": "x"})

        def relationships():
            self.delete(f"/projects/{self.proj2.id}/")  # project without tasks: removes its updates
            self.assertFalse(DailyUpdate.objects.filter(project_id=self.proj2.id).exists())
            self.assertEqual(self.delete(f"/members/{self.person.id}/").status_code, 409)
            return "204/409"

        self.probe("DELETE", "/projects/<id>/", "business-rule", "deleting a project removes its updates (no orphans); member with updates is kept", relationships)
