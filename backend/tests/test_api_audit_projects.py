"""Audit probes for the projects endpoints (list/detail/history/tasks/team/objectives) - see audit_support.py."""

from activity.models import ActivityLog
from tests.audit_support import AuditCase
from tests.support import day
from projects.models import Project, ProjectMember, ProjectObjective
from tasks.models import Task


class ProjectAudit(AuditCase):
    def setUp(self):
        self.lead = self.member(name="Lead One")
        self.other = self.member(name="Other Two")

    def body(self, **extra):
        return {"name": "Fresh", "client": "Acme", "lead_id": self.lead.id, "start_date": day(-5).isoformat(), "end_date": day(30).isoformat(), **extra}

    def test_projects_list_create_detail(self):
        L, D = "/projects/", "/projects/<id>/"
        a = self.project(lead=self.lead, name="Off", start=-50, end=10, progress=10)
        b = self.project(lead=self.lead, name="Ok", start=-50, end=40, progress=54)
        self.project(lead=self.lead, name="Idle", start=5, end=60)
        names = lambda **p: [r["name"] for r in self.get(L, **p).data["results"]]

        def listing():
            res = self.get(L)
            self.expect(res, 200)
            self.assertEqual(res.data["count"], 3)
            for k in ("id", "name", "department", "lead", "lead_name", "phase", "start_date", "end_date", "progress", "decision", "health", "time_used"):
                self.assertIn(k, res.data["results"][0])
            self.assertNotIn("objectives", res.data["results"][0])
            return 200

        self.probe("GET", L, "valid", "list shape (summary rows)", listing)
        self.probe("GET", L, "valid", "detail=1 adds objectives/members/open_tasks", lambda: self.assertTrue(all(k in self.get(L, detail=1).data["results"][0] for k in ("objectives", "members", "open_tasks"))) or 200)
        self.probe("GET", L, "filter", "health filter", lambda: self.assertEqual((names(health="off-track"), names(health="not-started"), names(health="on-track")), (["Off"], ["Idle"], ["Ok"])) or 200)
        self.probe("GET", L, "sort", "sort attention|deadline|progress|name", lambda: self.assertEqual((names(sort="attention"), names(sort="deadline"), names(sort="progress"), names(sort="name")), (["Off", "Ok", "Idle"], ["Off", "Ok", "Idle"], ["Ok", "Off", "Idle"], ["Idle", "Off", "Ok"])) or 200)
        self.probe("GET", L, "invalid-query", "health=bogus -> 400", lambda: self.envelope(self.get(L, health="bogus"), 400))
        self.probe("GET", L, "invalid-query", "sort=bogus -> 400", lambda: self.envelope(self.get(L, sort="bogus"), 400))

        def create():
            res = self.post(L, self.body())
            self.expect(res, 201)
            p = Project.objects.get(pk=res.data["id"])
            self.assertEqual((p.phase, p.progress, p.department), ("In Progress", 0, "General"))
            self.assertTrue(ProjectMember.objects.filter(project=p, member=self.lead, role="Project Lead").exists(), "lead membership missing")
            self.assertTrue(ActivityLog.objects.filter(project=p, action="project.created").exists())
            self.assertEqual(self.get(f"/projects/{p.id}/").data["name"], "Fresh")
            return 201

        self.probe("POST", L, "valid", "creates, lead membership, activity, persisted", create)
        self.probe("POST", L, "valid", "future start -> Not Started", lambda: self.assertEqual(self.post(L, self.body(name="Later", start_date=day(3).isoformat())).data["phase"], "Not Started") or 201)
        self.bad("POST", L, L, {k: v for k, v in self.body().items() if k != "name"}, name="missing name")
        for field in ("lead_id", "start_date", "end_date"):  # optional
            self.probe("POST", L, "valid", f"missing {field} -> 201", lambda field=field: self.expect(self.post(L, {k: v for k, v in self.body(name=f"No {field}").items() if k != field}), 201))
        for extra in ({"name": " "}, {"name": "x" * 201}, {"lead_id": 999999}, {"lead_id": "abc"}, {"start_date": "31-12-2026"}, {"end_date": day(-5).isoformat()}, {"end_date": day(-9).isoformat()}, {"description": "d" * 5001}, {"department": "d" * 121}):
            self.bad("POST", L, L, self.body(**extra))

        def no_residue():
            n = Project.objects.count()
            self.post(L, self.body(end_date=day(-9).isoformat()))
            self.assertEqual(Project.objects.count(), n)
            return 400

        self.probe("POST", L, "invalid-input", "rejected request creates nothing", no_residue)

        D1 = f"/projects/{a.id}/"
        self.probe("GET", D, "valid", "detail incl. objectives/members/open_tasks", lambda: self.assertTrue(all(k in self.get(D1).data for k in ("objectives", "members", "open_tasks", "health", "time_used"))) or 200)
        self.not_found("GET", D, "/projects/999999/")
        self.probe("GET", D, "invalid-input", "huge numeric id -> 404", lambda: self.envelope(self.get("/projects/" + "9" * 30 + "/"), 404))

        def patch_ok():
            res = self.patch(D1, {"name": "Renamed", "department": "Fin", "description": "d", "phase": "At Risk", "lead_id": self.other.id, "start_date": day(-60).isoformat(), "end_date": day(20).isoformat(), "progress": 33, "decision": "Approve X"})
            self.expect(res, 200)
            a.refresh_from_db()
            self.assertEqual((a.name, a.department, a.phase, a.lead_id, a.progress, a.decision), ("Renamed", "Fin", "At Risk", self.other.id, 33, "Approve X"), "not persisted")
            self.assertEqual(ProjectMember.objects.get(project=a, member=self.other).role, "Project Lead")
            self.assertEqual(ProjectMember.objects.get(project=a, member=self.lead).role, "Team Member", "old lead not demoted")
            kinds = set(ActivityLog.objects.filter(project=a).values_list("action", flat=True))
            self.assertTrue({"project.renamed", "project.phase", "project.lead", "project.progress", "decision.requested", "project.deadline", "project.start"} <= kinds, kinds)
            return 200

        self.probe("PATCH", D, "valid", "all fields persist; lead rules; one activity per change", patch_ok)

        def patch_noop():
            n = ActivityLog.objects.count()
            self.expect(self.patch(f"/projects/{b.id}/", {}), 200)
            self.expect(self.patch(f"/projects/{b.id}/", {"progress": b.progress}), 200)
            self.assertEqual(ActivityLog.objects.count(), n)
            return 200

        self.probe("PATCH", D, "valid", "unchanged values write no activity", patch_noop)

        def protected():
            r = self.patch(f"/projects/{b.id}/", {"id": 5000, "health": "bogus", "created_at": "2000-01-01T00:00:00Z"})
            self.expect(r, 200)
            self.assertEqual(r.data["id"], b.id)
            self.assertNotEqual(r.data["health"], "bogus")
            return 200

        self.probe("PATCH", D, "security", "id/created_at/health cannot be overwritten", protected)
        for body in ({"phase": "Done"}, {"progress": -1}, {"progress": 101}, {"progress": "x"}, {"progress": 5.5}, {"name": " "}, {"lead_id": 999999}, {"end_date": day(-100).isoformat()}, {"start_date": day(100).isoformat()}, {"decision": "d" * 1001}, {"start_date": "nope"}):
            self.bad("PATCH", D, f"/projects/{b.id}/", body)
        self.not_found("PATCH", D, "/projects/999999/", {"progress": 5})

        def delete_ok():
            p = self.project(lead=self.lead, name="Disposable")
            ProjectObjective.objects.create(project=p, description="o")
            self.expect(self.delete(f"/projects/{p.id}/"), 204)
            self.assertFalse(Project.objects.filter(pk=p.id).exists())
            self.assertFalse(ProjectObjective.objects.filter(project_id=p.id).exists(), "objective orphaned")
            self.assertFalse(ProjectMember.objects.filter(project_id=p.id).exists(), "membership orphaned")
            self.assertFalse(ActivityLog.objects.filter(project_id=p.id).exists(), "history orphaned")
            self.assertTrue(ActivityLog.objects.filter(action="project.deleted", entity_id=p.id).exists())
            self.assertEqual(self.delete(f"/projects/{p.id}/").status_code, 404)
            return "204 then 404"

        self.probe("DELETE", D, "valid", "removes project + objectives + memberships; logs; repeat -> 404", delete_ok)

        def delete_blocked():
            p = self.project(lead=self.lead, name="Busy")
            self.task(project=p, owner=self.lead)
            self.envelope(self.delete(f"/projects/{p.id}/"), 409)
            self.assertTrue(Project.objects.filter(pk=p.id).exists())
            self.assertEqual(Task.objects.filter(project=p).count(), 1)
            return 409

        self.probe("DELETE", D, "business-rule", "project with tasks -> 409, nothing removed", delete_blocked)
        self.not_found("DELETE", D, "/projects/999999/")

    def test_projects_history_tasks(self):
        H, T = "/projects/<id>/history/", "/projects/<id>/tasks/"
        a = self.project(lead=self.lead, name="A")
        b = self.project(lead=self.lead, name="B")
        self.patch(f"/projects/{b.id}/", {"progress": 5})
        self.patch(f"/projects/{b.id}/", {"progress": 6})

        def history():
            r = self.get(f"/projects/{b.id}/history/")
            self.expect(r, 200)
            self.assertEqual(r.data["results"][0]["description"], "You updated progress from 5% to 6%")
            self.assertTrue(all(x["project"] == b.id for x in r.data["results"]))
            return 200

        self.probe("GET", H, "valid", "newest first, scoped to the project", history)

        def paging():
            r = self.get(f"/projects/{b.id}/history/", limit=1, offset=1)
            self.assertEqual((r.data["count"] >= 2, len(r.data["results"]), r.data["limit"], r.data["offset"]), (True, 1, 1, 1))
            return 200

        self.probe("GET", H, "paging", "limit/offset window + total count", paging)
        for q in ({"limit": 0}, {"limit": "x"}, {"offset": -1}, {"offset": "1.5"}):
            self.probe("GET", H, "invalid-query", f"{q} -> 400", lambda q=q: self.envelope(self.get(f"/projects/{b.id}/history/", **q), 400))
        self.probe("GET", H, "paging", "limit above max is capped, not an error", lambda: self.assertEqual(self.get(f"/projects/{b.id}/history/", limit=100000).data["limit"], 200) or 200)
        self.not_found("GET", H, "/projects/999999/history/")

        self.task(project=b, owner=self.lead, title="mine")
        self.task(project=a, owner=self.lead, title="theirs")

        def ptasks():
            r = self.get(f"/projects/{b.id}/tasks/")
            self.expect(r, 200)
            self.assertEqual([x["title"] for x in r.data["results"]], ["mine"])
            self.assertIn("counts", r.data)
            return 200

        self.probe("GET", T, "valid", "only this project's tasks, with counts", ptasks)
        self.probe("GET", T, "invalid-query", "priority=bogus -> 400", lambda: self.envelope(self.get(f"/projects/{b.id}/tasks/", priority="bogus"), 400))
        self.probe("GET", T, "invalid-query", "status=bogus -> 400", lambda: self.envelope(self.get(f"/projects/{b.id}/tasks/", status="bogus"), 400))
        self.not_found("GET", T, "/projects/999999/tasks/")

    def test_projects_team_and_objectives(self):
        M, MD = "/projects/<id>/members/", "/projects/<id>/members/<member_id>/"
        O, OD = "/projects/<id>/objectives/", "/projects/<id>/objectives/<objective_id>/"
        a = self.project(lead=self.lead, name="A")
        b = self.project(lead=self.lead, name="B")
        pb = f"/projects/{b.id}/members/"

        def team():
            r = self.get(pb)
            self.expect(r, 200)
            self.assertEqual(r.data["results"][0]["role"], "Project Lead")
            return 200

        self.probe("GET", M, "valid", "lists team with roles", team)
        self.not_found("GET", M, "/projects/999999/members/")

        def add_member():
            res = self.post(pb, {"member_id": self.other.id, "role": "  QA  "})
            self.expect(res, 201)
            self.assertEqual(ProjectMember.objects.get(project=b, member=self.other).role, "QA")
            self.assertTrue(any(m["member_id"] == self.other.id for m in res.data["members"]))
            return 201

        self.probe("POST", M, "valid", "adds member, role trimmed, persisted, returns project", add_member)

        def default_role():
            m = self.member(name="Third")
            self.expect(self.post(pb, {"member_id": m.id}), 201)
            self.assertEqual(ProjectMember.objects.get(project=b, member=m).role, "Team Member")
            return 201

        self.probe("POST", M, "valid", "role defaults to Team Member", default_role)
        self.bad("POST", M, pb, {"member_id": self.other.id}, name="already on the project")
        self.bad("POST", M, pb, {}, name="missing member_id")
        self.bad("POST", M, pb, {"member_id": 999999}, name="unknown member")
        self.bad("POST", M, pb, {"member_id": self.other.id, "role": "r" * 121}, name="role too long")
        self.not_found("POST", M, "/projects/999999/members/", {"member_id": self.other.id})

        def remove_member():
            self.expect(self.delete(f"{pb}{self.other.id}/"), 204)
            self.assertFalse(ProjectMember.objects.filter(project=b, member=self.other).exists())
            self.assertEqual(self.delete(f"{pb}{self.other.id}/").status_code, 404)
            return "204 then 404"

        self.probe("DELETE", MD, "valid", "removes membership; repeat -> 404", remove_member)
        self.probe("DELETE", MD, "business-rule", "project lead cannot be removed -> 409", lambda: self.envelope(self.delete(f"{pb}{self.lead.id}/"), 409))
        self.not_found("DELETE", MD, "/projects/999999/members/1/")
        self.probe("DELETE", MD, "invalid-input", "huge member id -> 400/404 envelope (no 500)", lambda: self.assertIn(self.delete(f"{pb}{'9' * 30}/").status_code, (400, 404)) or 400)

        po = f"/projects/{b.id}/objectives/"

        def add_obj():
            res = self.post(po, {"description": "  Ship   it "})
            self.expect(res, 201)
            self.assertTrue(ProjectObjective.objects.filter(project=b, description="Ship it").exists())
            self.assertEqual(res.data["objectives"][-1]["description"], "Ship it")
            return 201

        self.probe("POST", O, "valid", "adds objective (whitespace collapsed), persisted", add_obj)
        self.bad("POST", O, po, {"description": "  "}, name="blank")
        self.bad("POST", O, po, {}, name="missing description")
        self.bad("POST", O, po, {"description": "x" * 501}, name="too long")
        self.not_found("POST", O, "/projects/999999/objectives/", {"description": "x"})
        obj = ProjectObjective.objects.filter(project=b).first()
        other_obj = ProjectObjective.objects.create(project=a, description="theirs")

        def edit_obj():
            self.expect(self.patch(f"{po}{obj.id}/", {"description": "Changed"}), 200)
            obj.refresh_from_db()
            self.assertEqual(obj.description, "Changed")
            self.assertTrue(ActivityLog.objects.filter(action="objective.updated").exists())
            return 200

        self.probe("PATCH", OD, "valid", "edits and persists, logs", edit_obj)

        def same_text():
            n = ActivityLog.objects.count()
            self.expect(self.patch(f"{po}{obj.id}/", {"description": "Changed"}), 200)
            self.assertEqual(ActivityLog.objects.count(), n)
            return 200

        self.probe("PATCH", OD, "valid", "same text is a no-op", same_text)
        self.bad("PATCH", OD, f"{po}{obj.id}/", {"description": ""}, name="blank")
        self.bad("PATCH", OD, f"{po}{obj.id}/", {}, name="missing description")
        self.not_found("PATCH", OD, f"{po}999999/", {"description": "x"})

        def patch_foreign():
            self.envelope(self.patch(f"{po}{other_obj.id}/", {"description": "hijack"}), 404)
            self.assertEqual(ProjectObjective.objects.get(pk=other_obj.id).description, "theirs")
            return 404

        def delete_foreign():
            self.envelope(self.delete(f"{po}{other_obj.id}/"), 404)
            self.assertTrue(ProjectObjective.objects.filter(pk=other_obj.id).exists())
            return 404

        self.probe("PATCH", OD, "security", "objective of another project -> 404, untouched", patch_foreign)
        self.probe("DELETE", OD, "security", "objective of another project -> 404, kept", delete_foreign)

        def delete_obj():
            self.expect(self.delete(f"{po}{obj.id}/"), 204)
            self.assertFalse(ProjectObjective.objects.filter(pk=obj.id).exists())
            self.assertEqual(self.delete(f"{po}{obj.id}/").status_code, 404)
            return "204 then 404"

        self.probe("DELETE", OD, "valid", "removes objective, persisted; repeat -> 404", delete_obj)
        self.not_found("DELETE", OD, f"{po}999999/")
