from tests.support import ApiTestCase, day
from dashboard import logic
from projects.rules import today


class DashboardTests(ApiTestCase):
    def build(self):
        """An off-track, a watch, an on-track and a not-started project, with a spread of tasks."""
        vik = self.member(name="Vik", load=118)
        sne = self.member(name="Sne", load=92)
        erp = self.project(vik, name="ERP", start=-90, end=8, progress=71, decision="Approve date")
        budget = self.project(sne, name="Budget", start=-31, end=5, progress=80, decision="Confirm targets")
        brand = self.project(sne, name="Brand", start=-20, end=25, progress=44)
        idle = self.project(vik, name="Idle", start=10, end=120, progress=0)
        self.task(erp, vik, "late a", due=-2, state="in-progress")
        self.task(budget, sne, "late b", due=-1, state="in-progress")
        self.task(erp, sne, "stuck", due=4, state="blocked", note="vendor late")
        self.task(erp, vik, "today t", due=0)
        self.task(brand, sne, "soon t", due=2)
        self.task(idle, vik, "far t", due=18)
        self.task(erp, vik, "done t", due=-8, state="done")
        return erp, budget, brand, idle

    def test_empty_database_returns_zeroes_and_empty_lists(self):
        self.assertEqual(
            self.get("/dashboard/summary/").data,
            {"total": 0, "in_flight": 0, "not_started": 0, "off_track": 0, "watch": 0, "on_track": 0,
             "overdue": 0, "due_today": 0, "blocked": 0, "stretched": 0},
        )
        for path in ("attention", "key-dates", "team-workload", "decisions"):
            self.assertEqual(self.get(f"/dashboard/{path}/").data, {"results": [], "count": 0}, path)

    def test_summary_counts_come_from_records(self):
        self.build()
        s = self.get("/dashboard/summary/").data
        self.assertEqual((s["total"], s["in_flight"], s["not_started"]), (4, 3, 1))
        self.assertEqual((s["off_track"], s["watch"], s["on_track"]), (1, 1, 1))
        self.assertEqual((s["overdue"], s["due_today"], s["blocked"]), (2, 1, 1))
        self.assertEqual(s["stretched"], 1)

    def test_summary_reacts_to_changes(self):
        erp, *_ = self.build()
        self.assertEqual(self.get("/dashboard/summary/").data["off_track"], 1)
        self.patch(f"/projects/{erp.id}/", {"progress": 100})
        self.assertEqual(self.get("/dashboard/summary/").data["off_track"], 0)

    def test_attention_order_and_text(self):
        self.build()
        items = self.get("/dashboard/attention/").data["results"]
        self.assertEqual(
            [i["key"][0] + ":" + i["title"] for i in items],
            ["p:ERP", "t:late a", "t:late b", "t:stuck", "p:Budget", "t:today t"],
        )
        self.assertEqual(items[0]["marker"], "square-red")
        self.assertEqual(items[0]["label"], "Off track")
        self.assertTrue(items[0]["subtitle"].startswith("Behind schedule: 71% done with 92% of the time used."))
        self.assertIn("1 task overdue", items[0]["subtitle"])
        self.assertEqual(items[1]["label"], "2 days overdue")
        self.assertEqual(items[3]["subtitle"], "Sne · ERP · vendor late")
        self.assertEqual(items[3]["ref"]["kind"], "task")
        self.assertEqual(items[4]["label"], "Needs watching")

    def test_key_dates_window_and_order(self):
        self.build()
        rows = self.get("/dashboard/key-dates/").data["results"]
        self.assertEqual([r["title"] for r in rows], ["Budget deadline", "ERP deadline", "Idle starts", "Brand deadline"])
        self.assertEqual([r["offset"] for r in rows], [5, 8, 10, 25])
        self.assertEqual(rows[0]["date"], day(5).isoformat())
        self.assertEqual(len(self.get("/dashboard/key-dates/", days=14).data["results"]), 3)
        self.assertEqual(self.get("/dashboard/key-dates/", days=0).status_code, 400)
        self.assertEqual(self.get("/dashboard/key-dates/", days="x").status_code, 400)

    def test_key_dates_inclusive_edges(self):
        self.project(name="Ends today", start=-10, end=0 + 1)  # end tomorrow, not today (end > start)
        on = today()
        self.assertEqual(len(logic.key_dates(on, 1)), 1)
        self.assertEqual(logic.key_dates(on, 1)[0]["offset"], 1)

    def test_team_workload(self):
        self.build()
        rows = self.get("/dashboard/team-workload/").data["results"]
        by = {r["name"]: r for r in rows}
        self.assertEqual(by["Vik"]["open"], ["overdue", "soon", "later"])
        self.assertEqual(by["Sne"]["open"], ["overdue", "blocked", "soon"])
        self.assertTrue(by["Vik"]["stretched"])
        self.assertFalse(by["Sne"]["stretched"])

    def test_workload_hides_people_without_open_tasks(self):
        self.member(name="Idle Person")
        self.assertEqual(self.get("/dashboard/team-workload/").data["count"], 0)

    def test_decisions_sorted_by_health_then_deadline(self):
        self.build()
        rows = self.get("/dashboard/decisions/").data["results"]
        self.assertEqual([r["name"] for r in rows], ["ERP", "Budget"])
        self.assertEqual(rows[0]["health"], "off-track")
        self.assertEqual(rows[0]["lead"], "Vik")
        self.assertEqual(rows[0]["end_offset"], 8)

    def test_decision_resolution_removes_it_from_dashboard(self):
        erp, *_ = self.build()
        self.post(f"/projects/{erp.id}/decision/resolve/")
        self.assertEqual([r["name"] for r in self.get("/dashboard/decisions/").data["results"]], ["Budget"])

    def test_weekly_brief_sections(self):
        self.build()
        brief = self.get("/weekly-brief/").data
        self.assertEqual(brief["generated_on"], day(0).isoformat())
        self.assertEqual(
            brief["stats"],
            {"projects_at_risk": 2, "overdue": 2, "blocked": 1, "decisions": 2, "due_in_7_days": 3},
        )
        self.assertEqual([p["name"] for p in brief["attention_projects"]], ["ERP", "Budget"])
        self.assertEqual([t["title"] for t in brief["late_tasks"]], ["late a", "late b", "stuck"])
        self.assertEqual([p["name"] for p in brief["on_track_projects"]], ["Brand"])
        self.assertEqual([t["title"] for t in brief["completed_tasks"]], ["done t"])
        self.assertEqual([m["name"] for m in brief["stretched_people"]], ["Vik"])
        self.assertEqual(len(brief["key_dates"]), 3)
        self.assertEqual(brief["summary"]["total"], 4)

    def test_weekly_brief_empty(self):
        brief = self.get("/weekly-brief/").data
        self.assertEqual(brief["stats"]["projects_at_risk"], 0)
        self.assertEqual(brief["late_tasks"], [])
