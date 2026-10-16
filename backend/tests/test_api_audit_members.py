"""Audit probes for the members endpoints (see audit_support.py)."""

from activity.models import ActivityLog
from tests.audit_support import AuditCase, json
from tests.support import API, day
from members.models import Member
from projects.models import ProjectMember
from updates.models import DailyUpdate


class MemberAudit(AuditCase):
    def setUp(self):
        self.lead = self.member(name="Lead One", department="Ops", load=120)
        self.proj = self.project(lead=self.lead, name="Alpha")
        self.other = self.member(name="Other Two", title="QA", department="Engineering", load=50)

    def test_members(self):
        L, D = "/members/", "/members/<id>/"
        self.task(project=self.proj, owner=self.lead, due=-3, title="late")
        self.task(project=self.proj, owner=self.other, state="blocked", note="waiting", title="stuck")

        # GET list
        def listing():
            res = self.get(L)
            self.expect(res, 200)
            self.assertEqual(res.data["count"], 2)
            row = next(r for r in res.data["results"] if r["name"] == "Lead One")
            for k in ("id", "name", "title", "department", "load", "stretched", "open_tasks", "overdue_tasks", "blocked_tasks", "projects", "work"):
                self.assertIn(k, row)
            self.assertTrue(row["stretched"] and row["overdue_tasks"] == 1 and row["projects"][0]["project_name"] == "Alpha")
            return 200
        self.probe("GET", L, "valid", "list with computed stats", listing)
        names = lambda **p: [r["name"] for r in self.get(L, **p).data["results"]]
        self.probe("GET", L, "filter", "q matches name/title/department/project", lambda: self.assertEqual((names(q="qa"), names(q="alpha"), names(q="zzz")), (["Other Two"], ["Lead One"], [])) or 200)
        self.probe("GET", L, "filter", "project filter", lambda: self.assertEqual(names(project=self.proj.id), ["Lead One"]) or 200)
        self.probe("GET", L, "filter", "show=stretched|overdue|blocked", lambda: self.assertEqual((names(show="stretched"), names(show="overdue"), names(show="blocked")), (["Lead One"], ["Lead One"], ["Other Two"])) or 200)
        self.probe("GET", L, "sort", "sort=name|tasks|stretched ordering", lambda: self.assertEqual((names(sort="name"), names(sort="stretched")), (["Lead One", "Other Two"], ["Lead One", "Other Two"])) or 200)
        self.probe("GET", L, "invalid-query", "project=abc -> 400", lambda: self.envelope(self.get(L, project="abc"), 400))
        self.probe("GET", L, "invalid-query", "project=huge id -> 400", lambda: self.envelope(self.get(L, project="9" * 30), 400))
        self.probe("GET", L, "invalid-query", "show=bogus -> 400", lambda: self.envelope(self.get(L, show="bogus"), 400))
        self.probe("GET", L, "invalid-query", "sort=bogus -> 400", lambda: self.envelope(self.get(L, sort="bogus"), 400))

        # POST
        good = {"name": "New Person", "title": "Analyst", "department": "Finance", "load": 70, "email": "new.person@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}
        def create():
            res = self.post(L, good)
            self.expect(res, 201)
            self.assertTrue(Member.objects.filter(name="New Person", load=70).exists(), "not persisted")
            self.assertEqual(self.get(f"/members/{res.data['id']}/").data["title"], "Analyst")
            self.assertTrue(ActivityLog.objects.filter(action="member.created").exists())
            return 201
        self.probe("POST", L, "valid", "creates, persists, logs activity", create)
        self.probe("POST", L, "valid", "default load 60 when omitted", lambda: self.assertEqual(self.post(L, {"name": "Dflt", "title": "T", "department": "D", "email": "dflt@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"}).data["load"], 60) or 201)
        def with_memberships():
            res = self.post(L, {"name": "Teamed", "title": "T", "department": "D", "email": "teamed@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05", "memberships": [{"project_id": self.proj.id, "role": " QA lead "}]})
            self.expect(res, 201)
            self.assertEqual(ProjectMember.objects.get(project=self.proj, member_id=res.data["id"]).role, "QA lead")
            return 201
        self.probe("POST", L, "valid", "memberships created with the member", with_memberships)
        for field in ("name", "title", "department", "email", "status", "employment_type", "start_date"):
            self.bad("POST", L, L, {k: v for k, v in good.items() if k != field}, name=f"missing {field}")
            if field in ("name", "title", "department", "email"):
                self.bad("POST", L, L, {**good, field: "   "}, name=f"blank {field}")
        for load in ("abc", -1, 201, 3.5, []):
            self.bad("POST", L, L, {**good, "name": "Loady", "load": load}, name=f"load={load!r}")
        self.bad("POST", L, L, {**good, "name": "x" * 121}, name="name too long")
        self.bad("POST", L, L, {**good, "name": "lead one"}, name="duplicate name (case-insensitive)")
        self.bad("POST", L, L, {**good, "name": ["a"]}, name="name wrong type (list)")
        self.bad("POST", L, L, {**good, "name": "Mem1", "memberships": [{"project_id": 999999}]}, name="membership to missing project")
        self.bad("POST", L, L, {**good, "name": "Mem2", "memberships": [{"project_id": self.proj.id}, {"project_id": self.proj.id}]}, name="same project twice")
        def atomic():
            before = Member.objects.count()
            self.assertEqual(self.post(L, {**good, "name": "Atomic", "memberships": [{"project_id": 999999}]}).status_code, 400)
            self.assertEqual(Member.objects.count(), before, "member left behind after rejected request")
            return 400
        self.probe("POST", L, "invalid-input", "rejected request leaves nothing behind", atomic)
        self.probe("POST", L, "invalid-input", "non-JSON content type -> 415", lambda: self.envelope(self.client.post(f"{API}{L}", "name=x", content_type="text/plain"), 415))
        self.probe("POST", L, "invalid-input", "malformed JSON -> 400", lambda: self.envelope(self.client.post(f"{API}{L}", "{bad", content_type="application/json"), 400))
        self.probe("POST", L, "invalid-input", "non-object JSON body -> 400", lambda: self.envelope(self.client.post(f"{API}{L}", "[1]", content_type="application/json"), 400))

        # departments
        DP = "/members/departments/"
        def depts():
            res = self.get(DP)
            self.expect(res, 200)
            self.assertEqual(res.data["results"], sorted(set(res.data["results"]), key=str.lower))
            self.assertTrue({"Ops", "Engineering", "General"} <= set(res.data["results"]), "must include member and project departments")
            self.assertEqual(res.data["count"], len(res.data["results"]))
            return 200
        self.probe("GET", DP, "valid", "union of member + project departments, sorted, unique", depts)

        # GET detail
        def detail():
            res = self.get(f"/members/{self.lead.id}/")
            self.expect(res, 200)
            self.assertEqual((res.data["name"], len(res.data["work"])), ("Lead One", 1))
            return 200
        self.probe("GET", D, "valid", "detail with projects and open work", detail)
        self.not_found("GET", D, "/members/999999/")
        self.probe("GET", D, "invalid-input", "huge numeric id -> 404 (no 500)", lambda: self.envelope(self.get("/members/" + "9" * 30 + "/"), 404))
        self.probe("GET", D, "invalid-input", "non-numeric id -> 404 envelope", lambda: self.envelope(self.get("/members/abc/"), 404))

        # PATCH
        def patch_ok():
            res = self.patch(f"/members/{self.other.id}/", {"title": "Senior QA", "load": 90, "department": " Quality "})
            self.expect(res, 200)
            self.other.refresh_from_db()
            self.assertEqual((self.other.title, self.other.load, self.other.department), ("Senior QA", 90, "Quality"), "not persisted")
            self.assertTrue(ActivityLog.objects.filter(action="member.updated").exists())
            return 200
        self.probe("PATCH", D, "valid", "partial update persists + logs", patch_ok)
        def noop():
            before = ActivityLog.objects.count()
            self.expect(self.patch(f"/members/{self.other.id}/", {}), 200)
            self.assertEqual(ActivityLog.objects.count(), before)
            return 200
        self.probe("PATCH", D, "valid", "empty body is a no-op (no activity)", noop)
        self.probe("PATCH", D, "valid", "keeping own name is allowed", lambda: self.expect(self.patch(f"/members/{self.other.id}/", {"name": "other two"}), 200))
        def protected():
            res = self.patch(f"/members/{self.other.id}/", {"id": 9999, "created_at": "2000-01-01T00:00:00Z", "stretched": True})
            self.expect(res, 200)
            self.assertEqual(res.data["id"], self.other.id)
            self.assertFalse(res.data["stretched"], "derived field overwritten")
            return 200
        self.probe("PATCH", D, "security", "protected/derived fields cannot be overwritten", protected)
        for body in ({"load": 999}, {"load": "x"}, {"name": "lead one"}, {"name": ""}, {"title": " "}, {"department": ""}):
            self.bad("PATCH", D, f"/members/{self.other.id}/", body)
        self.not_found("PATCH", D, "/members/999999/", {"title": "x"})

        # DELETE
        def delete_ok():
            m = self.member(name="Disposable")
            ProjectMember.objects.create(project=self.proj, member=m, role="Advisor")
            self.expect(self.delete(f"/members/{m.id}/"), 204)
            self.assertFalse(Member.objects.filter(pk=m.id).exists(), "still in database")
            self.assertFalse(ProjectMember.objects.filter(member_id=m.id).exists(), "membership orphaned")
            self.assertEqual(self.delete(f"/members/{m.id}/").status_code, 404)
            self.assertTrue(ActivityLog.objects.filter(action="member.deleted").exists())
            return "204 then 404"
        self.probe("DELETE", D, "valid", "removes member + memberships, logs, repeat -> 404", delete_ok)
        self.probe("DELETE", D, "business-rule", "leads a project -> 409, member kept", lambda: (self.envelope(self.delete(f"/members/{self.lead.id}/"), 409), self.assertTrue(Member.objects.filter(pk=self.lead.id).exists()))[0])
        self.probe("DELETE", D, "business-rule", "owns a task -> 409, member kept", lambda: (self.envelope(self.delete(f"/members/{self.other.id}/"), 409), self.assertTrue(Member.objects.filter(pk=self.other.id).exists()))[0])
        def with_update():
            m = self.member(name="Reporter")
            DailyUpdate.objects.create(employee=m, project=self.proj, date=day(0), completed=["x"])
            return self.envelope(self.delete(f"/members/{m.id}/"), 409)
        self.probe("DELETE", D, "business-rule", "has daily updates -> 409 (no 500)", with_update)
        self.not_found("DELETE", D, "/members/999999/")
