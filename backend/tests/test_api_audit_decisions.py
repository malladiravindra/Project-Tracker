"""Audit probes for the decision endpoints (set/resolve/undo/history) - see audit_support.py."""

from activity.models import ActivityLog
from tests.audit_support import AuditCase
from tests.support import day
from projects.models import DecisionRecord


class DecisionAudit(AuditCase):
    def setUp(self):
        self.p = self.project(name="Dec", start=-50, end=50, progress=71)
        self.q = self.project(name="Other")
        self.base = f"/projects/{self.p.id}/decision/"

    def pend(self, text="Approve it"):
        self.patch(self.base, {"decision": text})

    def test_decisions(self):
        DEC, RES, UND, HIST = "/projects/<id>/decision/", "/projects/<id>/decision/resolve/", "/projects/<id>/decision/undo/", "/decision-history/"

        def set_it():
            self.assertEqual(self.patch(self.base, {"decision": "  Approve it "}).data["decision"], "Approve it")
            self.p.refresh_from_db()
            self.assertEqual(self.p.decision, "Approve it")
            self.assertTrue(ActivityLog.objects.filter(action="decision.requested").exists())
            return 200

        def clear_it():
            self.assertEqual(self.patch(self.base, {"decision": ""}).data["decision"], "")
            self.assertTrue(ActivityLog.objects.filter(action="decision.cleared").exists())
            return 200

        self.probe("PATCH", DEC, "valid", "sets (trimmed), persists, logs decision.requested", set_it)
        self.probe("PATCH", DEC, "valid", "clears (empty string), logs decision.cleared", clear_it)
        self.bad("PATCH", DEC, self.base, {}, name="missing decision")
        self.bad("PATCH", DEC, self.base, {"decision": "d" * 1001}, name="too long")
        self.not_found("PATCH", DEC, "/projects/999999/decision/", {"decision": "x"})
        self.pend()

        def resolve_ok():
            res = self.post(f"{self.base}resolve/", {"outcome": "Approved", "notes": " ok ", "decision_date": day(-1).isoformat()})
            self.expect(res, 200)
            rec = DecisionRecord.objects.get()
            self.assertEqual((rec.outcome, rec.notes, rec.decision_date, rec.project_id, rec.project_name, rec.title), ("Approved", "ok", day(-1), self.p.id, "Dec", "Approve it"))
            self.assertEqual(rec.context, "71% done with 50% of the time used")
            self.p.refresh_from_db()
            self.assertEqual(self.p.decision, "", "decision still pending")
            self.assertTrue(ActivityLog.objects.filter(pk=res.data["activity_id"], action="decision.resolved").exists())
            return 200

        def repeat():
            self.envelope(self.post(f"{self.base}resolve/", {"outcome": "Approved"}), 400)
            self.assertEqual(DecisionRecord.objects.count(), 1)
            return 400

        self.probe("POST", RES, "valid", "saves record + snapshot, clears pending, logs", resolve_ok)
        self.probe("POST", RES, "business-rule", "repeat resolve -> 400, still one record", repeat)
        self.pend()

        def bare():
            r = self.post(f"{self.base}resolve/", {})
            self.expect(r, 200)
            self.assertEqual((r.data["record"]["outcome"], r.data["record"]["decision_date"]), ("Resolved", day(0).isoformat()))
            return 200

        self.probe("POST", RES, "valid", "bare body defaults to Resolved/today", bare)
        self.pend()
        for body in ({"outcome": "Maybe"}, {"outcome": 5}, {"decision_date": day(1).isoformat()}, {"decision_date": "x"}, {"decision_date": "2026-13-45"}, {"notes": "n" * 2001}):
            self.bad("POST", RES, f"{self.base}resolve/", body)

        def still_pending():
            self.p.refresh_from_db()
            self.assertEqual(self.p.decision, "Approve it")
            self.assertEqual(DecisionRecord.objects.count(), 2)
            return 400

        self.probe("POST", RES, "invalid-input", "rejected request keeps the decision pending, no record", still_pending)
        self.not_found("POST", RES, "/projects/999999/decision/resolve/", {})
        self.bad("POST", RES, f"/projects/{self.q.id}/decision/resolve/", {"outcome": "Approved"}, name="project without pending decision")

        def hist():
            r = self.get(HIST)
            self.expect(r, 200)
            self.assertEqual(r.data["count"], 2)
            for k in ("id", "project", "title", "outcome", "notes", "decision_date", "recorded_at", "project_name", "lead", "health", "deadline", "context", "activity_id"):
                self.assertIn(k, r.data["results"][0])
            self.assertGreaterEqual(r.data["results"][0]["decision_date"], r.data["results"][1]["decision_date"])
            return 200

        self.probe("GET", HIST, "valid", "newest decision first; full record shape", hist)

        def filters():
            hq = lambda **p: self.get(HIST, **p).data["count"]
            self.assertEqual(hq(outcome="Approved"), 1)
            self.assertEqual(hq(project=self.p.id), 2)
            self.assertEqual(hq(project=self.q.id), 0)
            self.assertEqual(hq(lead=self.p.lead.name), 2)
            self.assertEqual(hq(**{"from": day(0).isoformat()}), 1)
            self.assertEqual(hq(to=day(-1).isoformat()), 1)
            self.assertEqual(hq(q="approve"), 2)
            return 200

        self.probe("GET", HIST, "filter", "outcome/project/lead/from/to/q filters", filters)
        self.probe("GET", HIST, "paging", "limit/offset", lambda: self.assertEqual((lambda r: (r.data["count"], len(r.data["results"])))(self.get(HIST, limit=1)), (2, 1)) or 200)
        for q in ({"outcome": "Nope"}, {"project": "abc"}, {"from": "x"}, {"to": "2026-99-99"}, {"limit": 0}, {"limit": 99999}, {"offset": "x"}):
            self.probe("GET", HIST, "invalid-query", f"{q} -> 400", lambda q=q: self.envelope(self.get(HIST, **q), 400))

        self.pend()
        act = self.post(f"{self.base}resolve/", {"outcome": "Deferred"}).data["activity_id"]

        def undo_ok():
            res = self.post(f"{self.base}undo/", {"activity_id": act})
            self.expect(res, 200)
            self.assertEqual(res.data["project"]["decision"], "Approve it")
            self.assertFalse(DecisionRecord.objects.filter(outcome="Deferred").exists(), "record kept")
            self.assertFalse(ActivityLog.objects.filter(pk=act).exists())
            self.assertEqual(DecisionRecord.objects.count(), 2, "other records must survive")
            return 200

        self.probe("POST", UND, "valid", "restores decision, removes only that record", undo_ok)
        self.probe("POST", UND, "business-rule", "repeat undo -> 404", lambda: self.envelope(self.post(f"{self.base}undo/", {"activity_id": act}), 404))

        def bad_ids():
            self.envelope(self.post(f"{self.base}undo/", {}), 404)
            self.envelope(self.post(f"{self.base}undo/", {"activity_id": "x"}), 400)
            self.envelope(self.post(f"{self.base}undo/", {"activity_id": 0}), 400)
            return "404/400/400"

        self.probe("POST", UND, "invalid-input", "missing id -> 404; non-numeric/zero id -> 400", bad_ids)
        act2 = self.post(f"{self.base}resolve/", {"outcome": "Rejected"}).data["activity_id"]

        def foreign():
            self.envelope(self.post(f"/projects/{self.q.id}/decision/undo/", {"activity_id": act2}), 404)
            self.assertEqual(DecisionRecord.objects.filter(outcome="Rejected").count(), 1)
            return 404

        self.probe("POST", UND, "security", "another project's URL cannot undo it -> 404", foreign)
        self.patch(self.base, {"decision": "Newer"})
        self.probe("POST", UND, "business-rule", "refused while a new decision is pending -> 409", lambda: self.envelope(self.post(f"{self.base}undo/", {"activity_id": act2}), 409))
        self.not_found("POST", UND, "/projects/999999/decision/undo/", {"activity_id": 1})
