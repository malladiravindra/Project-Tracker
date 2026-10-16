from activity.models import ActivityLog
from tests.support import ApiTestCase


class ActivityApiTests(ApiTestCase):
    def test_empty_feed(self):
        res = self.get("/activity/")
        self.assertEqual(res.status_code, 200)
        self.assertEqual((res.data["results"], res.data["count"]), ([], 0))

    def test_feed_is_newest_first_and_includes_all_events(self):
        project = self.project()
        self.post("/members/", {"name": "New Hire", "title": "Dev", "department": "Eng", "email": "hire@example.com", "status": "active", "employment_type": "full_time", "start_date": "2026-01-05"})
        self.post("/tasks/", {"title": "T1", "project_id": project.id, "owner_id": project.lead_id,
                              "due_date": "2030-01-01"})
        self.patch(f"/projects/{project.id}/", {"progress": 10})
        texts = [e["description"] for e in self.get("/activity/").data["results"]]
        self.assertEqual(texts[0], "You updated progress from 0% to 10%")
        self.assertEqual(texts[1], "You added “T1”")
        self.assertEqual(texts[2], "You added New Hire (Dev, Eng) to the team")
        self.assertEqual(len(texts), 3)

    def test_one_event_row_serves_both_feeds(self):
        project = self.project()
        self.patch(f"/projects/{project.id}/", {"progress": 10})
        self.assertEqual(ActivityLog.objects.count(), 1)
        self.assertEqual(self.get("/activity/").data["count"], 1)
        self.assertEqual(self.get(f"/projects/{project.id}/history/").data["count"], 1)

    def test_project_history_only_contains_that_project(self):
        a, b = self.project(name="A"), self.project(name="B")
        self.patch(f"/projects/{a.id}/", {"progress": 10})
        self.patch(f"/projects/{b.id}/", {"progress": 20})
        hist = self.get(f"/projects/{a.id}/history/").data["results"]
        self.assertEqual([h["description"] for h in hist], ["You updated progress from 0% to 10%"])

    def test_paging(self):
        for i in range(5):
            ActivityLog.objects.create(action="x", entity_type="t", description=f"event {i}")
        page = self.get("/activity/", limit=2, offset=1).data
        self.assertEqual([e["description"] for e in page["results"]], ["event 3", "event 2"])
        self.assertEqual((page["count"], page["limit"], page["offset"]), (5, 2, 1))
        self.assertEqual(self.get("/activity/", limit=0).status_code, 400)
        self.assertEqual(self.get("/activity/", offset="x").status_code, 400)
        self.assertEqual(self.get("/activity/", limit=9999).data["limit"], 200)

    def test_events_removed_with_entity(self):
        project = self.project()
        t = self.task(project=project, title="Temp")
        ActivityLog.objects.create(action="x", entity_type="t", description="unrelated")
        ActivityLog.objects.create(action="task.created", entity_type="task", entity_id=t.id, project=project, description="You added “Temp”")
        self.delete(f"/tasks/{t.id}/")
        task_rows = ActivityLog.objects.filter(entity_type="task", entity_id=t.id)
        self.assertEqual([e.description for e in task_rows], ["You deleted “Temp”"])
        ActivityLog.objects.create(action="project.updated", entity_type="project", entity_id=project.id, project=project, description="edit")
        self.delete(f"/projects/{project.id}/")
        texts = [e.description for e in ActivityLog.objects.order_by("id")]
        self.assertEqual(texts, ["unrelated", f"You deleted the project {project.name}"])

    def test_history_removed_when_deleted_outside_the_api(self):
        # e.g. from the Django admin, which does not go through the delete views
        project = self.project()
        t = self.task(project=project)
        ActivityLog.objects.create(action="task.created", entity_type="task", entity_id=t.id, project=project, description="t")
        ActivityLog.objects.create(action="project.created", entity_type="project", entity_id=project.id, description="p")
        t.delete()
        project.delete()
        self.assertFalse(ActivityLog.objects.exists())
