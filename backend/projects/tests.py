from datetime import date, timedelta

from activity.models import ActivityLog
from tests.support import ApiTestCase, day
from projects import rules
from projects.models import DecisionRecord, Project, ProjectMember


class ProjectRulesTests(ApiTestCase):
    """Pure derived-value rules, pinned to a fixed date."""

    ON = date(2026, 1, 1)

    def p(self, start, end, progress):
        return Project(
            start_date=self.ON + timedelta(days=start),
            end_date=self.ON + timedelta(days=end),
            progress=progress,
        )

    def test_time_used_clamps_and_rounds(self):
        self.assertEqual(rules.time_used(self.p(-30, 70, 0), self.ON), 30)
        self.assertEqual(rules.time_used(self.p(10, 50, 0), self.ON), 0)  # not started: clamped up
        self.assertEqual(rules.time_used(self.p(-100, -10, 0), self.ON), 100)  # finished: clamped down
        self.assertEqual(rules.time_used(self.p(-1, 7, 0), self.ON), 13)  # 12.5 rounds up, like JS

    def test_health_thresholds(self):
        # half of the schedule used, so gap = 50 - progress
        cases = {50: "on-track", 47: "on-track", 46: "watch", 35: "watch", 34: "off-track"}
        for progress, expected in cases.items():
            self.assertEqual(rules.health(self.p(-50, 50, progress), self.ON), expected, progress)

    def test_health_not_started_only_when_no_time_and_no_progress(self):
        self.assertEqual(rules.health(self.p(10, 50, 0), self.ON), "not-started")
        self.assertEqual(rules.health(self.p(10, 50, 5), self.ON), "on-track")
        self.assertEqual(rules.health(self.p(-10, 50, 0), self.ON), "off-track")  # 17% used, 0% done


class ProjectApiTests(ApiTestCase):
    def valid(self, lead, **extra):
        return {
            "name": "New Thing",
            "client": "Acme",
            "lead_id": lead.id,
            "start_date": day(-5).isoformat(),
            "end_date": day(30).isoformat(),
            **extra,
        }

    def test_create_applies_defaults_membership_and_log(self):
        lead = self.member()
        res = self.post("/projects/", self.valid(lead))
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data["phase"], "In Progress")
        self.assertEqual(res.data["department"], "General")
        self.assertEqual(res.data["progress"], 0)
        self.assertEqual(res.data["members"][0]["role"], "Project Lead")
        self.assertEqual(res.data["objectives"], [])
        self.assertEqual(res.data["start_offset"], -5)
        self.assertTrue(ActivityLog.objects.filter(description="You created New Thing for Acme").exists())

    def test_create_defaults_priority(self):
        res = self.post("/projects/", self.valid(self.member()))
        self.assertEqual((res.data["priority"], res.data["client"]), ("Medium", "Acme"))

    def test_client_is_optional_and_can_be_cleared(self):
        lead = self.member()
        for i, client in enumerate((None, "", "   ")):
            body = self.valid(lead, name=f"No client {i}")
            if client is None:
                del body["client"]
            else:
                body["client"] = client
            res = self.post("/projects/", body)
            self.assertEqual(res.status_code, 201, client)
            self.assertEqual(res.data["client"], "")
        self.assertTrue(ActivityLog.objects.filter(description="You created No client 0").exists())
        project = self.project(name="P", client="Globex")
        res = self.patch(f"/projects/{project.id}/", {"client": " "})
        self.assertEqual(res.status_code, 200)
        project.refresh_from_db()
        self.assertEqual(project.client, "")
        self.assertTrue(ActivityLog.objects.filter(description="You removed the client of P").exists())

    def test_create_with_status_priority_and_client(self):
        res = self.post(
            "/projects/",
            self.valid(self.member(), phase="Planning", priority="Critical", client="  Acme   Corp ", description=" Scope "),
        )
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(
            (res.data["phase"], res.data["priority"], res.data["client"], res.data["description"]),
            ("Planning", "Critical", "Acme Corp", "Scope"),
        )
        self.assertTrue(ActivityLog.objects.filter(description="You created New Thing for Acme Corp").exists())

    def test_create_rejects_unknown_status_and_priority(self):
        lead = self.member()
        for extra, field in (({"phase": "Paused"}, "phase"), ({"priority": "Urgent"}, "priority")):
            res = self.post("/projects/", self.valid(lead, **extra))
            self.assertEqual(res.status_code, 400, extra)
            self.assertIn(field, res.data["error"]["fields"])
        self.assertEqual(Project.objects.count(), 0)

    def test_patch_priority_client_and_new_phases_are_logged(self):
        project = self.project(name="P")
        res = self.patch(f"/projects/{project.id}/", {"priority": "High", "client": "Globex", "phase": "Cancelled"})
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual((res.data["priority"], res.data["client"], res.data["phase"]), ("High", "Globex", "Cancelled"))
        texts = set(ActivityLog.objects.values_list("description", flat=True))
        self.assertIn("You changed the priority of P from Medium to High", texts)
        self.assertIn("You changed the client of P to Globex", texts)
        self.assertIn("You changed P from In Progress to Cancelled", texts)

    def test_future_start_means_not_started(self):
        lead = self.member()
        res = self.post("/projects/", self.valid(lead, start_date=day(3).isoformat()))
        self.assertEqual(res.data["phase"], "Not Started")

    def test_create_validation(self):
        lead = self.member()
        res = self.post("/projects/", self.valid(lead, end_date=day(-5).isoformat()))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error"]["message"], "The deadline must be after the start date.")
        self.assertEqual(self.post("/projects/", {}).status_code, 400)
        self.assertEqual(self.post("/projects/", self.valid(lead, lead_id=9999)).status_code, 400)
        self.assertEqual(self.post("/projects/", self.valid(lead, name="  ")).status_code, 400)
        self.assertEqual(Project.objects.count(), 0)

    def test_list_filters_and_sorts(self):
        off = self.project(name="Off", start=-50, end=10, progress=10)
        ok = self.project(name="Ok", start=-50, end=40, progress=50)
        idle = self.project(name="Idle", start=5, end=60, progress=0)
        names = lambda **p: [r["name"] for r in self.get("/projects/", **p).data["results"]]
        self.assertEqual(names(), ["Off", "Ok", "Idle"])
        self.assertEqual(names(health="off-track"), ["Off"])
        self.assertEqual(names(health="not-started"), ["Idle"])
        self.assertEqual(names(sort="deadline"), ["Off", "Ok", "Idle"])
        self.assertEqual(names(sort="progress"), ["Ok", "Off", "Idle"])
        self.assertEqual(names(sort="name"), ["Idle", "Off", "Ok"])
        self.assertEqual(self.get("/projects/", health="bogus").status_code, 400)
        self.assertEqual(self.get("/projects/", sort="bogus").status_code, 400)
        self.assertEqual(self.get("/projects/").data["results"][0]["health"], "off-track")

    def test_detail_and_404(self):
        project = self.project()
        self.task(project=project, due=2)
        self.task(project=project, due=3, state="done")
        res = self.get(f"/projects/{project.id}/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data["open_tasks"]), 1)
        self.assertEqual(self.get("/projects/9999/").status_code, 404)

    def test_patch_fields_logs_and_validation(self):
        project = self.project(name="P", start=-10, end=10)
        path = f"/projects/{project.id}/"
        res = self.patch(path, {"phase": "At Risk", "progress": 40, "end_date": day(20).isoformat()})
        self.assertEqual(res.status_code, 200)
        self.assertEqual((res.data["phase"], res.data["progress"]), ("At Risk", 40))
        texts = set(project.activity.values_list("description", flat=True))
        self.assertIn("You changed P from In Progress to At Risk", texts)
        self.assertIn("You updated progress from 0% to 40%", texts)
        self.assertTrue(any(t.startswith("You moved the deadline to") for t in texts))
        self.assertEqual(self.patch(path, {"progress": 101}).status_code, 400)
        self.assertEqual(self.patch(path, {"progress": -1}).status_code, 400)
        self.assertEqual(self.patch(path, {"phase": "Nope"}).status_code, 400)
        self.assertEqual(self.patch(path, {"end_date": project.start_date.isoformat()}).status_code, 400)
        self.assertEqual(self.patch(path, {"start_date": day(30).isoformat()}).status_code, 400)
        self.assertEqual(self.patch(path, {"progress": 40}).status_code, 200)  # no change, no new log

    def test_patch_without_change_logs_nothing(self):
        project = self.project()
        before = ActivityLog.objects.count()
        self.patch(f"/projects/{project.id}/", {"phase": project.phase})
        self.assertEqual(ActivityLog.objects.count(), before)

    def test_lead_change_reroles_members(self):
        project = self.project(name="P")
        old = project.lead
        new = self.member(name="New Lead")
        res = self.patch(f"/projects/{project.id}/", {"lead_id": new.id})
        self.assertEqual(res.status_code, 200)
        roles = {m["name"]: m["role"] for m in res.data["members"]}
        self.assertEqual(roles, {old.name: "Team Member", "New Lead": "Project Lead"})
        # existing member promoted: no duplicate row
        third = self.member(name="Third")
        self.post(f"/projects/{project.id}/members/", {"member_id": third.id, "role": "QA"})
        res = self.patch(f"/projects/{project.id}/", {"lead_id": third.id})
        self.assertEqual(ProjectMember.objects.filter(project=project, member=third).count(), 1)
        self.assertEqual({m["name"]: m["role"] for m in res.data["members"]}["Third"], "Project Lead")
        self.assertEqual(ProjectMember.objects.filter(project=project, role="Project Lead").count(), 1)
        self.assertIn(
            f"You changed the project lead from New Lead to Third",
            project.activity.values_list("description", flat=True),
        )

    def test_members_add_remove_rules(self):
        project = self.project()
        person = self.member(name="Pat")
        base = f"/projects/{project.id}/members/"
        res = self.post(base, {"member_id": person.id})
        self.assertEqual(res.status_code, 201)
        self.assertEqual([m for m in res.data["members"] if m["name"] == "Pat"][0]["role"], "Team Member")
        dup = self.post(base, {"member_id": person.id})
        self.assertEqual(dup.status_code, 400)
        self.assertEqual(self.post(base, {"member_id": 9999}).status_code, 400)
        self.assertEqual(self.get(base).data["count"], 2)
        # the lead cannot be removed
        res = self.delete(f"{base}{project.lead_id}/")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(self.delete(f"{base}{person.id}/").status_code, 204)
        self.assertEqual(self.delete(f"{base}{person.id}/").status_code, 404)
        texts = set(project.activity.values_list("description", flat=True))
        self.assertIn("You added Pat to the team", texts)
        self.assertIn("You removed Pat from the team", texts)

    def test_removing_member_keeps_their_tasks(self):
        project = self.project()
        person = self.member(name="Pat")
        self.post(f"/projects/{project.id}/members/", {"member_id": person.id})
        t = self.task(project=project, owner=person)
        self.delete(f"/projects/{project.id}/members/{person.id}/")
        t.refresh_from_db()
        self.assertEqual(t.owner_id, person.id)

    def test_objectives_crud(self):
        project = self.project()
        base = f"/projects/{project.id}/objectives/"
        res = self.post(base, {"description": "  Ship   it "})
        self.assertEqual(res.status_code, 201)
        obj = res.data["objectives"][0]
        self.assertEqual(obj["description"], "Ship it")
        self.assertEqual(self.post(base, {"description": "  "}).status_code, 400)
        res = self.patch(f"{base}{obj['id']}/", {"description": "Ship it fast"})
        self.assertEqual(res.data["objectives"][0]["description"], "Ship it fast")
        self.assertEqual(self.patch(f"{base}{obj['id']}/", {"description": ""}).status_code, 400)
        self.assertEqual(self.patch(f"{base}9999/", {"description": "x"}).status_code, 404)
        self.assertEqual(self.delete(f"{base}{obj['id']}/").status_code, 204)
        self.assertEqual(self.get(f"/projects/{project.id}/").data["objectives"], [])

    def test_decision_set_clear_resolve_undo(self):
        project = self.project(name="P")
        base = f"/projects/{project.id}/decision/"
        res = self.patch(base, {"decision": " Approve it "})
        self.assertEqual(res.data["decision"], "Approve it")
        res = self.post(f"{base}resolve/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["project"]["decision"], "")
        activity_id = res.data["activity_id"]
        self.assertEqual(self.post(f"{base}resolve/").status_code, 400)  # nothing pending now
        undo = self.post(f"{base}undo/", {"activity_id": activity_id})
        self.assertEqual(undo.data["project"]["decision"], "Approve it")
        self.assertFalse(ActivityLog.objects.filter(pk=activity_id).exists())
        # undo is a one-shot
        self.assertEqual(self.post(f"{base}undo/", {"activity_id": activity_id}).status_code, 404)
        # clearing via PATCH
        self.assertEqual(self.patch(base, {"decision": ""}).data["decision"], "")
        self.assertTrue(project.activity.filter(action="decision.cleared").exists())

    def test_undo_refused_when_new_decision_entered(self):
        project = self.project()
        base = f"/projects/{project.id}/decision/"
        self.patch(base, {"decision": "A"})
        activity_id = self.post(f"{base}resolve/").data["activity_id"]
        self.patch(base, {"decision": "B"})
        self.assertEqual(self.post(f"{base}undo/", {"activity_id": activity_id}).status_code, 409)

    def test_history_and_tasks_endpoints(self):
        project = self.project()
        other = self.project(name="Other")
        self.task(project=project, title="Mine")
        self.task(project=other, title="Not mine")
        self.patch(f"/projects/{project.id}/", {"progress": 5})
        hist = self.get(f"/projects/{project.id}/history/")
        self.assertEqual(hist.status_code, 200)
        self.assertEqual(hist.data["results"][0]["description"], "You updated progress from 0% to 5%")
        titles = [t["title"] for t in self.get(f"/projects/{project.id}/tasks/").data["results"]]
        self.assertEqual(titles, ["Mine"])
        self.assertEqual(self.get("/projects/9999/history/").status_code, 404)
        self.assertEqual(self.get("/projects/9999/tasks/").status_code, 404)

    def test_delete_project_rules(self):
        project = self.project(name="Gone")
        obj_path = f"/projects/{project.id}/objectives/"
        self.post(obj_path, {"description": "x"})
        t = self.task(project=project)
        res = self.delete(f"/projects/{project.id}/")
        self.assertEqual(res.status_code, 409)
        self.assertTrue(Project.objects.filter(pk=project.id).exists())
        t.delete()
        self.assertEqual(self.delete(f"/projects/{project.id}/").status_code, 204)
        self.assertFalse(Project.objects.filter(pk=project.id).exists())
        self.assertFalse(ProjectMember.objects.filter(project_id=project.id).exists())
        # its history is removed along with it
        self.assertFalse(ActivityLog.objects.filter(project_id=project.id).exists())
        self.assertTrue(ActivityLog.objects.filter(description="You deleted the project Gone").exists())
        self.assertEqual(self.delete(f"/projects/{project.id}/").status_code, 404)

    def test_persistence_across_requests(self):
        lead = self.member()
        pid = self.post("/projects/", self.valid(lead)).data["id"]
        self.patch(f"/projects/{pid}/", {"progress": 33})
        self.client.cookies.clear()
        self.assertEqual(self.get(f"/projects/{pid}/").data["progress"], 33)
        self.assertEqual(Project.objects.get(pk=pid).progress, 33)

    def test_lead_and_dates_are_optional(self):
        res = self.post("/projects/", {"name": "Bare"})
        self.assertEqual(res.status_code, 201)
        d = res.data
        self.assertEqual((d["lead"], d["lead_name"], d["start_date"], d["end_date"]), (None, "", None, None))
        self.assertEqual((d["start_offset"], d["end_offset"], d["time_used"], d["health"]), (None, None, 0, "not-started"))
        self.assertEqual((d["phase"], d["member_count"]), ("Planning", 0))
        pid = d["id"]
        # Lists, sorting and the dashboard cope with a project that has none of them.
        self.project(name="Dated")
        for sort in ("attention", "deadline", "progress", "name"):
            self.assertEqual(self.get("/projects/", sort=sort).status_code, 200, sort)
        self.assertEqual([r["name"] for r in self.get("/projects/", sort="deadline").data["results"]], ["Dated", "Bare"])
        for path in ("summary", "attention", "key-dates", "decisions"):
            self.assertEqual(self.get(f"/dashboard/{path}/").status_code, 200, path)
        # Add, then remove, a lead and dates.
        lead = self.member(name="Lia")
        self.patch(f"/projects/{pid}/", {"lead_id": lead.id, "start_date": day(-1).isoformat(), "end_date": day(9).isoformat()})
        self.assertTrue(ProjectMember.objects.filter(project_id=pid, member=lead, role="Project Lead").exists())
        res = self.patch(f"/projects/{pid}/", {"lead_id": None, "start_date": None, "end_date": None})
        self.assertEqual(res.status_code, 200)
        self.assertEqual((res.data["lead"], res.data["start_date"], res.data["end_date"]), (None, None, None))
        self.assertEqual(ProjectMember.objects.get(project_id=pid, member=lead).role, "Team Member")
        texts = set(ActivityLog.objects.filter(project_id=pid).values_list("description", flat=True))
        self.assertTrue({"You made Lia the project lead of Bare", "You removed Lia as the project lead of Bare",
                         "You removed the start date", "You removed the deadline"} <= texts)
        # A decision on it is still recorded.
        self.patch(f"/projects/{pid}/", {"decision": "Go?"})
        res = self.post(f"/projects/{pid}/decision/resolve/", {"outcome": "Approved"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual((res.data["record"]["lead"], res.data["record"]["deadline"]), ("", None))
        self.assertEqual(self.get("/projects/", sort="deadline").status_code, 200)


class DecisionHistoryApiTests(ApiTestCase):
    def pending(self, **kwargs):
        project = self.project(**kwargs)
        self.patch(f"/projects/{project.id}/decision/", {"decision": "Approve the plan"})
        return project

    def resolve(self, project, **body):
        return self.post(f"/projects/{project.id}/decision/resolve/", body)

    def test_resolve_records_outcome_notes_date_and_snapshot(self):
        project = self.pending(name="ERP", start=-50, end=50, progress=71)
        res = self.resolve(project, outcome="Approved", notes=" Go ahead ", decision_date=day(-2).isoformat())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["project"]["decision"], "")
        rec = res.data["record"]
        self.assertEqual(rec["outcome"], "Approved")
        self.assertEqual(rec["notes"], "Go ahead")
        self.assertEqual(rec["decision_date"], day(-2).isoformat())
        self.assertEqual(rec["title"], "Approve the plan")
        self.assertEqual(rec["project_name"], "ERP")
        self.assertEqual(rec["context"], "71% done with 50% of the time used")
        self.assertEqual(rec["deadline"], day(50).isoformat())
        self.assertEqual(rec["activity_id"], res.data["activity_id"])
        self.assertEqual(DecisionRecord.objects.count(), 1)

    def test_resolve_defaults_to_resolved_today(self):
        project = self.pending()
        rec = self.resolve(project).data["record"]
        self.assertEqual(rec["outcome"], "Resolved")
        self.assertEqual(rec["decision_date"], day(0).isoformat())

    def test_resolve_validation_keeps_the_decision_pending(self):
        project = self.pending()
        self.assertEqual(self.resolve(project, outcome="Maybe").status_code, 400)
        res = self.resolve(project, decision_date=day(1).isoformat())
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data["error"]["message"], "The decision date can't be in the future.")
        self.assertEqual(self.resolve(project, decision_date="not-a-date").status_code, 400)
        self.assertEqual(DecisionRecord.objects.count(), 0)
        project.refresh_from_db()
        self.assertEqual(project.decision, "Approve the plan")

    def test_cannot_resolve_without_pending_decision(self):
        project = self.project()
        self.assertEqual(self.resolve(project, outcome="Approved").status_code, 400)
        self.assertEqual(DecisionRecord.objects.count(), 0)

    def test_history_list_filters_and_order(self):
        a = self.pending(name="Alpha")
        b = self.pending(name="Beta")
        self.resolve(a, outcome="Approved", decision_date=day(-5).isoformat(), notes="fine")
        self.resolve(b, outcome="Rejected", decision_date=day(-1).isoformat())
        rows = self.get("/decision-history/").data["results"]
        self.assertEqual([r["project_name"] for r in rows], ["Beta", "Alpha"])  # newest decision first
        names = lambda **p: [r["project_name"] for r in self.get("/decision-history/", **p).data["results"]]
        self.assertEqual(names(outcome="Approved"), ["Alpha"])
        self.assertEqual(names(project=a.id), ["Alpha"])
        self.assertEqual(names(lead=b.lead.name), ["Beta"])
        self.assertEqual(names(**{"from": day(-3).isoformat()}), ["Beta"])
        self.assertEqual(names(to=day(-3).isoformat()), ["Alpha"])
        self.assertEqual(names(q="fine"), ["Alpha"])
        self.assertEqual(self.get("/decision-history/", outcome="Nope").status_code, 400)
        self.assertEqual(self.get("/decision-history/", **{"from": "x"}).status_code, 400)
        self.assertEqual(self.get("/decision-history/", project="abc").status_code, 400)

    def test_history_is_read_only(self):
        self.assertEqual(self.post("/decision-history/", {}).status_code, 405)
        self.assertEqual(self.delete("/decision-history/").status_code, 405)

    def test_undo_removes_the_record(self):
        project = self.pending()
        activity_id = self.resolve(project, outcome="Deferred").data["activity_id"]
        self.assertEqual(self.get("/decision-history/").data["count"], 1)
        undo = self.post(f"/projects/{project.id}/decision/undo/", {"activity_id": activity_id})
        self.assertEqual(undo.status_code, 200)
        self.assertEqual(self.get("/decision-history/").data["count"], 0)
        project.refresh_from_db()
        self.assertEqual(project.decision, "Approve the plan")

    def test_record_survives_project_deletion(self):
        project = self.pending(name="Gone")
        self.resolve(project, outcome="Approved")
        self.assertEqual(self.delete(f"/projects/{project.id}/").status_code, 204)
        rows = self.get("/decision-history/").data["results"]
        self.assertEqual(rows[0]["project_name"], "Gone")
        self.assertIsNone(rows[0]["project"])

    def test_resolve_and_undo_are_idempotent_and_project_scoped(self):
        mine = self.pending(name="Mine")
        other = self.pending(name="Other")
        first = self.resolve(mine, outcome="Approved")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.resolve(mine, outcome="Approved").status_code, 400)  # repeated resolve: nothing pending
        self.assertEqual(DecisionRecord.objects.count(), 1)
        activity_id = first.data["activity_id"]
        # another project's endpoint cannot undo this project's decision
        self.assertEqual(self.post(f"/projects/{other.id}/decision/undo/", {"activity_id": activity_id}).status_code, 404)
        self.assertEqual(DecisionRecord.objects.count(), 1)
        self.assertEqual(self.post(f"/projects/{mine.id}/decision/undo/", {"activity_id": activity_id}).status_code, 200)
        self.assertEqual(self.post(f"/projects/{mine.id}/decision/undo/", {"activity_id": activity_id}).status_code, 404)  # repeated undo
        other.refresh_from_db()
        self.assertEqual(other.decision, "Approve the plan")  # untouched

    def test_only_the_latest_resolution_can_be_undone(self):
        project = self.pending()
        first = self.resolve(project, outcome="Approved").data["activity_id"]
        self.patch(f"/projects/{project.id}/decision/", {"decision": "Second"})
        second = self.resolve(project, outcome="Rejected").data["activity_id"]
        self.assertEqual(self.post(f"/projects/{project.id}/decision/undo/", {"activity_id": first}).status_code, 409)
        self.assertEqual(self.get("/decision-history/").data["count"], 2)
        self.assertEqual(self.post(f"/projects/{project.id}/decision/undo/", {"activity_id": second}).status_code, 200)

    def test_history_is_paged(self):
        for n in range(3):
            self.resolve(self.pending(name=f"P{n}"), outcome="Approved")
        res = self.get("/decision-history/", limit=2, offset=2)
        self.assertEqual((res.data["count"], len(res.data["results"])), (3, 1))
        for bad in ({"limit": 0}, {"limit": 5000}, {"offset": "x"}):
            self.assertEqual(self.get("/decision-history/", **bad).status_code, 400, bad)

    def test_page_boundaries(self):
        for n in range(3):
            self.resolve(self.pending(name=f"B{n}"), outcome="Approved")
        past_end = self.get("/decision-history/", offset=3)
        self.assertEqual((past_end.status_code, past_end.data["results"], past_end.data["count"]), (200, [], 3))
        self.assertEqual(len(self.get("/decision-history/", limit=3).data["results"]), 3)
        self.assertEqual(self.get("/decision-history/", limit=1000).status_code, 200)
        self.assertEqual(self.get("/decision-history/", limit=1001).status_code, 400)
        ids = [r["id"] for off in (0, 1, 2) for r in self.get("/decision-history/", limit=1, offset=off).data["results"]]
        self.assertEqual(len(ids), len(set(ids)))
