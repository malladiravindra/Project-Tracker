"""'Today' is the calendar date in settings.TIME_ZONE (Asia/Kolkata, UTC+05:30 by default). These tests pin the
clock to instants on either side of local midnight and check that every date-dependent result flips together."""

from datetime import date, datetime, timezone as dt_timezone
from unittest import mock

from django.test import override_settings
from django.utils import timezone

from tests.support import ApiTestCase
from members.models import Member
from projects.models import LEAD_ROLE, Project, ProjectMember
from tasks.models import Task

UTC = dt_timezone.utc
# 2026-06-01 23:59:59 IST and one second later.
BEFORE_MIDNIGHT = datetime(2026, 6, 1, 18, 29, 59, tzinfo=UTC)
AFTER_MIDNIGHT = datetime(2026, 6, 1, 18, 30, 0, tzinfo=UTC)
JUNE_1, JUNE_2 = date(2026, 6, 1), date(2026, 6, 2)


def frozen(instant):
    return mock.patch("django.utils.timezone.now", return_value=instant)


class TodayEndpointTests(ApiTestCase):
    def test_today_is_the_date_in_the_server_time_zone(self):
        with frozen(BEFORE_MIDNIGHT):
            body = self.get("/today/").data
        self.assertEqual(body["date"], "2026-06-01")
        self.assertEqual(body["time_zone"], "Asia/Kolkata")
        self.assertTrue(body["server_time"].startswith("2026-06-01T23:59:59"))
        self.assertTrue(body["server_time"].endswith("+05:30"))
        with frozen(AFTER_MIDNIGHT):
            body = self.get("/today/").data
        self.assertEqual(body["date"], "2026-06-02")
        self.assertTrue(body["server_time"].startswith("2026-06-02T00:00:00"))

    def test_today_differs_from_the_utc_date_late_in_the_utc_day(self):
        with frozen(datetime(2026, 6, 1, 20, 0, 0, tzinfo=UTC)):  # 01:30 on 2 June in IST
            self.assertEqual(self.get("/today/").data["date"], "2026-06-02")
            self.assertEqual(timezone.localdate(), JUNE_2)

    @override_settings(TIME_ZONE="America/Los_Angeles")
    def test_follows_the_configured_zone(self):
        with frozen(datetime(2026, 6, 1, 3, 0, 0, tzinfo=UTC)):  # still 31 May in Los Angeles
            body = self.get("/today/").data
        self.assertEqual((body["date"], body["time_zone"]), ("2026-05-31", "America/Los_Angeles"))

    def test_today_endpoint_has_no_required_input_and_is_get_only(self):
        self.assertEqual(self.get("/today/").status_code, 200)
        self.assertEqual(self.post("/today/").status_code, 405)


class MidnightBoundaryTests(ApiTestCase):
    def setUp(self):
        self.lead = Member.objects.create(name="Boundary Lead", title="Lead", department="Ops")

    def make_project(self, name, start, end, progress=0):
        project = Project.objects.create(name=name, lead=self.lead, start_date=start, end_date=end, progress=progress)
        ProjectMember.objects.create(project=project, member=self.lead, role=LEAD_ROLE)
        return project

    def make_task(self, title, due, state="in-progress", note=""):
        project = Project.objects.first() or self.make_project("Host", date(2026, 5, 1), date(2026, 7, 1))
        return Task.objects.create(title=title, project=project, owner=self.lead, due_date=due, state=state, note=note)

    def task_rows(self):
        return {t["title"]: t for t in self.get("/tasks/", status="all").data["results"]}

    def test_task_due_today_becomes_overdue_at_local_midnight(self):
        self.make_task("due june 1", JUNE_1)
        with frozen(BEFORE_MIDNIGHT):
            row = self.task_rows()["due june 1"]
            summary = self.get("/dashboard/summary/").data
            counts = self.get("/tasks/").data["counts"]
        self.assertEqual((row["group"], row["bucket"], row["due_label"], row["due_offset"]), ("today", "today", "Due today", 0))
        self.assertEqual((summary["due_today"], summary["overdue"]), (1, 0))
        self.assertEqual((counts["today"], counts["overdue"]), (1, 0))
        with frozen(AFTER_MIDNIGHT):
            row = self.task_rows()["due june 1"]
            summary = self.get("/dashboard/summary/").data
            counts = self.get("/tasks/").data["counts"]
            attention = self.get("/dashboard/attention/").data["results"]
        self.assertEqual((row["group"], row["bucket"], row["due_label"], row["due_offset"]), ("overdue", "overdue", "1 day overdue", -1))
        self.assertEqual((summary["due_today"], summary["overdue"]), (0, 1))
        self.assertEqual((counts["today"], counts["overdue"]), (0, 1))
        self.assertEqual([a["label"] for a in attention if a["key"].startswith("t-")], ["1 day overdue"])

    def test_task_due_tomorrow_becomes_due_today(self):
        self.make_task("due june 2", JUNE_2)
        with frozen(BEFORE_MIDNIGHT):
            row = self.task_rows()["due june 2"]
        self.assertEqual((row["group"], row["due_label"]), ("next2", "Due tomorrow"))
        with frozen(AFTER_MIDNIGHT):
            row = self.task_rows()["due june 2"]
        self.assertEqual((row["group"], row["due_label"]), ("today", "Due today"))

    def test_group_boundaries_around_midnight(self):
        for offset in (-1, 0, 1, 2, 3, 7, 8):
            self.make_task(f"d{offset}", date.fromordinal(JUNE_1.toordinal() + offset))
        with frozen(BEFORE_MIDNIGHT):
            before = {t: r["group"] for t, r in self.task_rows().items()}
        with frozen(AFTER_MIDNIGHT):
            after = {t: r["group"] for t, r in self.task_rows().items()}
        self.assertEqual(before, {"d-1": "overdue", "d0": "today", "d1": "next2", "d2": "next2", "d3": "week",
                                  "d7": "week", "d8": "later"})
        # one day later every boundary shifts by one
        self.assertEqual(after, {"d-1": "overdue", "d0": "overdue", "d1": "today", "d2": "next2", "d3": "next2",
                                 "d7": "week", "d8": "week"})

    def test_done_and_blocked_tasks_ignore_the_date(self):
        self.make_task("done late", JUNE_1, state="done")
        self.make_task("blocked late", JUNE_1, state="blocked", note="waiting")
        with frozen(AFTER_MIDNIGHT):
            rows = self.task_rows()
        self.assertEqual((rows["done late"]["group"], rows["blocked late"]["group"]), ("done", "blocked"))

    def test_project_ending_today_is_a_key_date_until_midnight_then_drops_out(self):
        self.make_project("Ends june 1", date(2026, 4, 1), JUNE_1, progress=100)
        with frozen(BEFORE_MIDNIGHT):
            keys = self.get("/dashboard/key-dates/").data["results"]
            project = self.get("/projects/").data["results"][0]
        self.assertEqual([(k["title"], k["offset"], k["date"]) for k in keys], [("Ends june 1 deadline", 0, "2026-06-01")])
        self.assertEqual((project["end_offset"], project["time_used"], project["health"]), (0, 100, "on-track"))
        with frozen(AFTER_MIDNIGHT):
            keys = self.get("/dashboard/key-dates/").data["results"]
            project = self.get("/projects/").data["results"][0]
        self.assertEqual(keys, [])
        self.assertEqual(project["end_offset"], -1)

    def test_project_starting_tomorrow_is_listed_then_started_today_is_not(self):
        self.make_project("Starts june 2", JUNE_2, date(2026, 8, 1))
        with frozen(BEFORE_MIDNIGHT):
            keys = self.get("/dashboard/key-dates/").data["results"]
            project = self.get("/projects/").data["results"][0]
        self.assertEqual([(k["title"], k["offset"]) for k in keys], [("Starts june 2 starts", 1)])
        self.assertEqual((project["start_offset"], project["health"]), (1, "not-started"))
        with frozen(AFTER_MIDNIGHT):
            keys = self.get("/dashboard/key-dates/").data["results"]
            project = self.get("/projects/").data["results"][0]
        self.assertEqual(keys, [])  # a start date of today is no longer "upcoming"
        self.assertEqual(project["start_offset"], 0)
        self.assertEqual(project["health"], "not-started")  # 0% of the time used and 0% done

    def test_project_starting_today_counts_one_day_of_schedule_tomorrow(self):
        project = self.make_project("Fresh", JUNE_2, date(2026, 6, 12), progress=0)
        with frozen(AFTER_MIDNIGHT):
            self.assertEqual(self.get(f"/projects/{project.id}/").data["time_used"], 0)
        with frozen(datetime(2026, 6, 2, 18, 30, 0, tzinfo=UTC)):  # 3 June 00:00 IST
            data = self.get(f"/projects/{project.id}/").data
        self.assertEqual((data["time_used"], data["health"]), (10, "watch"))  # 1 of 10 days used, 0% done: gap 10

    def test_project_creation_phase_depends_on_the_server_date(self):
        with frozen(BEFORE_MIDNIGHT):
            res = self.post("/projects/", {"name": "Starts tomorrow", "client": "Acme", "lead_id": self.lead.id,
                                           "start_date": "2026-06-02", "end_date": "2026-07-02"})
        self.assertEqual(res.data["phase"], "Not Started")
        with frozen(AFTER_MIDNIGHT):
            res = self.post("/projects/", {"name": "Starts today", "client": "Acme", "lead_id": self.lead.id,
                                           "start_date": "2026-06-02", "end_date": "2026-07-02"})
        self.assertEqual(res.data["phase"], "In Progress")

    def test_workload_and_weekly_brief_use_the_same_date(self):
        self.make_task("late soon", JUNE_1)
        with frozen(BEFORE_MIDNIGHT):
            self.assertEqual(self.get("/dashboard/team-workload/").data["results"][0]["open"], ["soon"])
            brief = self.get("/weekly-brief/").data
        self.assertEqual((brief["generated_on"], brief["stats"]["overdue"]), ("2026-06-01", 0))
        with frozen(AFTER_MIDNIGHT):
            self.assertEqual(self.get("/dashboard/team-workload/").data["results"][0]["open"], ["overdue"])
            brief = self.get("/weekly-brief/").data
        self.assertEqual((brief["generated_on"], brief["stats"]["overdue"]), ("2026-06-02", 1))
        self.assertEqual([t["title"] for t in brief["late_tasks"]], ["late soon"])

    def test_task_due_dates_are_stored_and_returned_as_absolute_iso_dates(self):
        task = self.make_task("abs", date(2031, 2, 3))
        with frozen(BEFORE_MIDNIGHT):
            first = self.task_rows()["abs"]
        with frozen(AFTER_MIDNIGHT):
            second = self.task_rows()["abs"]
        self.assertEqual((first["due_date"], second["due_date"]), ("2031-02-03", "2031-02-03"))
        self.assertNotEqual(first["due_offset"], second["due_offset"])  # offsets move, the stored date does not
        task.refresh_from_db()
        self.assertEqual(task.due_date, date(2031, 2, 3))
