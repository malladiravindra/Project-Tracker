"""Audit probes for the dashboard, today and weekly-brief endpoints - see audit_support.py.

Expected figures are worked out by hand from a small controlled data set, not copied from the code under test.
"""

from django.utils import timezone

from tests.audit_support import AuditCase
from tests.support import day


class DashboardAudit(AuditCase):
    def setUp(self):
        self.m1 = self.member(name="Lead One", load=120)
        self.m2 = self.member(name="Other Two", load=50)
        # health: P1 off-track (50/100 days used = 83% vs 10% done), P2 on-track (83% used... see below), P3 not started
        self.p1 = self.project(lead=self.m1, name="P1 off", start=-50, end=10, progress=10)  # 83% used, gap 73 -> off-track
        self.p2 = self.project(lead=self.m2, name="P2 ok", start=-50, end=40, progress=55)  # 56% used, gap 1 -> on-track
        self.p3 = self.project(lead=self.m2, name="P3 idle", start=5, end=60)  # not started
        self.p4 = self.project(lead=self.m1, name="P4 watch", start=-50, end=50, progress=45)  # 50% used, gap 5 -> watch
        self.t_over = self.task(project=self.p1, owner=self.m1, title="overdue", due=-2)
        self.t_today = self.task(project=self.p1, owner=self.m1, title="today", due=0)
        self.t_block = self.task(project=self.p2, owner=self.m2, title="blocked", due=3, state="blocked", note="waiting")
        self.t_later = self.task(project=self.p2, owner=self.m2, title="later", due=20)
        self.t_done = self.task(project=self.p2, owner=self.m2, title="finished", due=-5, state="done")
        self.patch(f"/projects/{self.p1.id}/decision/", {"decision": "Pick a date"})
        self.patch(f"/projects/{self.p4.id}/decision/", {"decision": "Approve spend"})

    def test_summary(self):
        S = "/dashboard/summary/"

        def valid():
            r = self.get(S)
            self.expect(r, 200)
            expected = {"total": 4, "in_flight": 3, "not_started": 1, "off_track": 1, "watch": 1, "on_track": 1, "overdue": 1, "due_today": 1, "blocked": 1, "stretched": 1}
            self.assertEqual(r.data, expected)
            return 200

        self.probe("GET", S, "valid", "all ten figures match the hand-computed values", valid)

        def reflects_change():
            self.patch(f"/tasks/{self.t_over.id}/", {"state": "done"})
            self.assertEqual(self.get(S).data["overdue"], 0, "stale after a write")
            return 200

        self.probe("GET", S, "persistence", "reflects writes immediately (no stale cache)", reflects_change)

    def test_attention_key_dates_workload_decisions(self):
        A, K, W, D = "/dashboard/attention/", "/dashboard/key-dates/", "/dashboard/team-workload/", "/dashboard/decisions/"

        def attention():
            r = self.get(A)
            self.expect(r, 200)
            self.assertEqual([x["key"] for x in r.data["results"]], [f"p-{self.p1.id}", f"t-{self.t_over.id}", f"t-{self.t_block.id}", f"p-{self.p4.id}", f"t-{self.t_today.id}"])
            self.assertEqual([x["marker"] for x in r.data["results"]], ["square-red", "dot-red", "dot-purple", "triangle-amber", "dot-orange"])
            self.assertEqual(r.data["results"][1]["label"], "2 days overdue")
            self.assertEqual(r.data["count"], 5)
            return 200

        self.probe("GET", A, "valid", "order and markers: off-track, overdue, blocked, watch, due today", attention)

        def key_dates():
            r = self.get(K)
            self.expect(r, 200)
            self.assertEqual([(x["key"], x["offset"]) for x in r.data["results"]], [(f"{self.p3.id}-start", 5), (f"{self.p1.id}-end", 10)])
            wide = self.get(K, days=45)
            self.assertIn(f"{self.p2.id}-end", [x["key"] for x in wide.data["results"]])
            self.assertEqual(self.get(K, days=4).data["results"], [])
            return 200

        self.probe("GET", K, "valid", "deadlines and starts inside the window, soonest first", key_dates)
        for q in ({"days": 0}, {"days": 367}, {"days": "abc"}, {"days": "-1"}, {"days": "9" * 30}):
            self.probe("GET", K, "invalid-query", f"{q} -> 400", lambda q=q: self.envelope(self.get(K, **q), 400))

        def workload():
            r = self.get(W)
            self.expect(r, 200)
            by = {x["name"]: x for x in r.data["results"]}
            self.assertEqual(by["Lead One"]["open"], ["overdue", "soon"])
            self.assertEqual(by["Other Two"]["open"], ["blocked", "later"], "done tasks must be excluded, kinds sorted by urgency")
            self.assertTrue(by["Lead One"]["stretched"] and not by["Other Two"]["stretched"])
            return 200

        self.probe("GET", W, "valid", "open task kinds per person; done excluded; stretched flag", workload)

        def only_people_with_work():
            self.member(name="Idle Person")
            self.assertNotIn("Idle Person", [x["name"] for x in self.get(W).data["results"]])
            return 200

        self.probe("GET", W, "valid", "people without open tasks are omitted", only_people_with_work)

        def decisions():
            r = self.get(D)
            self.expect(r, 200)
            self.assertEqual([x["name"] for x in r.data["results"]], ["P1 off", "P4 watch"], "ordered by health then deadline")
            self.assertEqual(r.data["results"][0]["health"], "off-track")
            self.patch(f"/projects/{self.p1.id}/decision/", {"decision": ""})
            self.assertEqual([x["name"] for x in self.get(D).data["results"]], ["P4 watch"])
            return 200

        self.probe("GET", D, "valid", "pending decisions ordered by health; cleared ones leave", decisions)

    def test_today_and_brief(self):
        T, B = "/today/", "/weekly-brief/"

        def today():
            r = self.get(T)
            self.expect(r, 200)
            self.assertEqual(r.data["date"], timezone.localdate().isoformat())
            self.assertEqual(r.data["time_zone"], "Asia/Kolkata")
            self.assertIn("server_time", r.data)
            return 200

        self.probe("GET", T, "valid", "server date and zone", today)

        def brief():
            r = self.get(B)
            self.expect(r, 200)
            d = r.data
            self.assertEqual(d["generated_on"], day(0).isoformat())
            self.assertEqual(d["stats"], {"projects_at_risk": 2, "overdue": 1, "blocked": 1, "decisions": 2, "due_in_7_days": 2})
            self.assertEqual([p["name"] for p in d["attention_projects"]], ["P1 off", "P4 watch"])
            self.assertEqual([t["title"] for t in d["late_tasks"]], ["overdue", "blocked"])
            self.assertEqual([p["name"] for p in d["on_track_projects"]], ["P2 ok"])
            self.assertEqual([m["name"] for m in d["stretched_people"]], ["Lead One"])
            self.assertEqual([t["title"] for t in d["completed_tasks"]], ["finished"])
            self.assertEqual(d["summary"]["total"], 4)
            self.assertEqual({k["title"] for k in d["key_dates"]}, {"P1 off deadline", "P3 idle starts"})
            return 200

        self.probe("GET", B, "valid", "stats and every list match hand-computed values", brief)

        def empty():
            from projects.models import Project
            from tasks.models import Task

            Task.objects.all().delete()
            Project.objects.all().delete()
            r = self.get(B)
            self.expect(r, 200)
            self.assertEqual(r.data["stats"], {"projects_at_risk": 0, "overdue": 0, "blocked": 0, "decisions": 0, "due_in_7_days": 0})
            return 200

        self.probe("GET", B, "empty-state", "empty database returns zeros, not an error", empty)
        self.probe("GET", "/dashboard/summary/", "empty-state", "empty database returns zeros", lambda: self.assertEqual(self.get("/dashboard/summary/").data["total"], 0) or 200)
