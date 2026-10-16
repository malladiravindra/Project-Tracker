"""Regression tests for the unhandled-exception findings: hostile or malformed input at the URL/body boundary must
produce a controlled 400/404 in the standard error envelope, never an exception (HTTP 500)."""

from tests.support import API, ApiTestCase, day

HUGE = "9" * 25
VERY_LONG = "9" * 5000  # longer than int() will convert from str
NEGATIVE = "-9" + "9" * 24
UNICODE_DIGIT = "²"  # "²": str.isdigit() is True, int() fails
ARABIC_DIGIT = "٣"  # Arabic-indic three


class Envelope:
    def assert_envelope(self, response, status=400, field=None):
        self.assertEqual(response.status_code, status, getattr(response, "content", b"")[:200])
        body = response.json()
        self.assertEqual(set(body), {"error"})
        self.assertEqual(set(body["error"]), {"code", "message", "fields"})
        self.assertTrue(body["error"]["message"])
        if field:
            self.assertIn(field, body["error"]["fields"])


class QueryParameterTests(Envelope, ApiTestCase):
    def test_tasks_project_and_owner(self):
        for param in ("project", "owner"):
            for bad in (HUGE, VERY_LONG, NEGATIVE, UNICODE_DIGIT, ARABIC_DIGIT, "abc", "1.5", " 1", "0"):
                with self.subTest(param=param, value=bad[:12]):
                    self.assert_envelope(self.get("/tasks/", **{param: bad}), 400, param)

    def test_tasks_valid_ids_still_filter(self):
        project = self.project()
        self.task(project=project, title="mine")
        other = self.project(name="Other")
        self.task(project=other, title="theirs")
        titles = [t["title"] for t in self.get("/tasks/", project=project.id).data["results"]]
        self.assertEqual(titles, ["mine"])
        self.assertEqual(self.get("/tasks/", project=9223372036854775807).data["count"], 0)  # largest valid id

    def test_tasks_month_is_strict(self):
        for bad in ("0000-01", "99999-01", "2026-13", "2026-00", "2026-1", "26-01", "2026/01", "2026-01-01",
                    "abc", " 2026-01", "٢٠٢٦-01", "10000-01"):
            with self.subTest(month=bad):
                self.assert_envelope(self.get("/tasks/", month=bad), 400, "month")

    def test_tasks_month_valid(self):
        project = self.project()
        task = self.task(project=project, due=0)
        self.assertEqual(self.get("/tasks/", month=task.due_date.strftime("%Y-%m")).data["count"], 1)
        for edge in ("0001-01", "9999-12"):
            self.assertEqual(self.get("/tasks/", month=edge).status_code, 200)

    def test_tasks_dates(self):
        for param in ("due_from", "due_to"):
            for bad in ("0000-01-01", "2026-13-01", "x", "2026-1-1", "99999-01-01", "٢٠٢٦-01-01"):
                with self.subTest(param=param, value=bad):
                    self.assert_envelope(self.get("/tasks/", **{param: bad}), 400, None)

    def test_members_project(self):
        for bad in (HUGE, VERY_LONG, NEGATIVE, UNICODE_DIGIT, "abc", "0"):
            with self.subTest(value=bad[:12]):
                self.assert_envelope(self.get("/members/", project=bad), 400, "project")
        project = self.project()
        self.assertEqual(self.get("/members/", project=project.id).data["count"], 1)

    def test_activity_offset_and_limit(self):
        for param in ("offset", "limit"):
            for bad in (HUGE, VERY_LONG, NEGATIVE, UNICODE_DIGIT, "abc", "1.5", ""):
                if bad == "" and param == "offset":
                    continue
                with self.subTest(param=param, value=bad[:12]):
                    res = self.get("/activity/", **{param: bad}) if bad else self.get("/activity/", **{param: ""})
                    self.assert_envelope(res, 400, param)
        self.assertEqual(self.get("/activity/", limit=0).status_code, 400)
        self.assertEqual(self.get("/activity/", offset=2**31 - 1).status_code, 200)  # largest accepted offset
        self.assertEqual(self.get("/activity/", offset=2**31).status_code, 400)

    def test_project_history_and_tasks_share_the_same_validation(self):
        project = self.project()
        for path, param, bad in (
            (f"/projects/{project.id}/history/", "offset", HUGE),
            (f"/projects/{project.id}/history/", "limit", UNICODE_DIGIT),
            (f"/projects/{project.id}/tasks/", "owner", HUGE),
            (f"/projects/{project.id}/tasks/", "project", NEGATIVE),
            (f"/projects/{project.id}/tasks/", "month", "0000-01"),
            (f"/projects/{project.id}/tasks/", "month", "99999-01"),
        ):
            with self.subTest(path=path, param=param):
                self.assert_envelope(self.get(path, **{param: bad}), 400, param)

    def test_key_dates_days(self):
        for bad in (HUGE, VERY_LONG, NEGATIVE, UNICODE_DIGIT, ARABIC_DIGIT, "0", "367", "abc"):
            with self.subTest(value=bad[:12]):
                self.assert_envelope(self.get("/dashboard/key-dates/", days=bad), 400, "days")
        self.assertEqual(self.get("/dashboard/key-dates/", days=366).status_code, 200)

    def test_query_string_with_sql_like_text_is_just_text(self):
        self.assertEqual(self.get("/tasks/", q="'; DROP TABLE tasks_task; --").status_code, 200)
        self.assertEqual(self.get("/members/", q="%' OR 1=1 --").status_code, 200)


class PathIdTests(Envelope, ApiTestCase):
    def test_member_id_on_project_member_delete(self):
        project = self.project()
        for bad in (HUGE, "9223372036854775808"):
            with self.subTest(value=bad[:12]):
                self.assert_envelope(self.delete(f"/projects/{project.id}/members/{bad}/"), 400, "member_id")
        # more digits than Python will convert: the URL converter refuses it, so no route matches -> JSON 404
        self.assert_envelope(self.delete(f"/projects/{project.id}/members/{VERY_LONG}/"), 404)
        # zero and unknown-but-valid ids behave like before
        self.assert_envelope(self.delete(f"/projects/{project.id}/members/0/"), 400, "member_id")
        self.assert_envelope(self.delete(f"/projects/{project.id}/members/999999/"), 404)

    def test_negative_ids_do_not_match_any_route(self):
        self.assert_envelope(self.delete("/projects/1/members/-5/"), 404)

    def test_objective_id_on_patch_and_delete(self):
        project = self.project()
        base = f"/projects/{project.id}/objectives/"
        self.assert_envelope(self.patch(f"{base}{HUGE}/", {"description": "x"}), 400, "objective_id")
        self.assert_envelope(self.delete(f"{base}{HUGE}/"), 400, "objective_id")

    def test_huge_ids_in_detail_paths_are_404_not_500(self):
        for path in (f"/members/{HUGE}/", f"/projects/{HUGE}/", f"/tasks/{HUGE}/", f"/projects/{HUGE}/history/",
                     f"/projects/{HUGE}/tasks/", f"/projects/{HUGE}/members/", f"/tasks/{HUGE}/complete/"):
            with self.subTest(path=path):
                self.assert_envelope(self.get(path) if not path.endswith("complete/") else self.post(path), 404)

    def test_huge_ids_in_json_bodies(self):
        project = self.project()
        huge = int(HUGE)
        cases = [
            ("post", "/tasks/", {"title": "x", "project_id": huge, "owner_id": project.lead_id, "due_date": "2030-01-01"}),
            ("post", "/tasks/", {"title": "x", "project_id": project.id, "owner_id": huge, "due_date": "2030-01-01"}),
            ("post", f"/projects/{project.id}/members/", {"member_id": huge}),
            ("post", "/projects/", {"name": "n", "client": "c", "lead_id": huge, "start_date": "2030-01-01", "end_date": "2030-02-01"}),
            ("patch", f"/projects/{project.id}/", {"lead_id": huge}),
            ("post", "/members/", {"name": "N", "title": "t", "department": "d", "memberships": [{"project_id": huge}]}),
        ]
        for method, path, body in cases:
            with self.subTest(path=path, body=body):
                res = getattr(self, method)(path, body)
                self.assertEqual(res.status_code, 400)

    def test_decision_undo_body_validation(self):
        project = self.project()
        path = f"/projects/{project.id}/decision/undo/"
        for body in ({"activity_id": int(HUGE)}, {"activity_id": "abc"}, {"activity_id": -1}, {"activity_id": 0},
                     {"activity_id": 1.5}, {"activity_id": [1]}):
            with self.subTest(body=body):
                self.assert_envelope(self.post(path, body), 400, "activity_id")
        # a JSON array / scalar body is a 400, not an AttributeError
        for raw in ("[]", "[1,2]", '"text"', "7", "null"):
            with self.subTest(raw=raw):
                res = self.client.post(f"{API}{path}", data=raw, content_type="application/json")
                self.assertEqual(res.status_code, 400, raw)
        # unchanged behaviour: missing or unknown id -> 404 "nothing to undo"
        self.assert_envelope(self.post(path, {}), 404)
        self.assert_envelope(self.post(path, {"activity_id": 12345}), 404)

    def test_non_object_json_bodies_are_400_everywhere(self):
        project = self.project()
        task = self.task(project=project)
        member = self.member(name="Body Test")
        targets = [
            ("post", "/members/"), ("patch", f"/members/{member.id}/"),
            ("post", "/projects/"), ("patch", f"/projects/{project.id}/"), ("patch", f"/projects/{project.id}/decision/"),
            ("post", f"/projects/{project.id}/members/"), ("post", f"/projects/{project.id}/objectives/"),
            ("post", "/tasks/"), ("patch", f"/tasks/{task.id}/"),
        ]
        for method, path in targets:
            for raw in ("[]", '"x"', "5", "null"):
                with self.subTest(method=method, path=path, raw=raw):
                    res = getattr(self.client, method)(f"{API}{path}", data=raw, content_type="application/json")
                    self.assertEqual(res.status_code, 400)


class TextLengthTests(ApiTestCase):
    def test_description_decision_and_note_limits(self):
        from common.limits import PROJECT_DECISION_MAX, PROJECT_DESCRIPTION_MAX, TASK_NOTE_MAX

        lead = self.member()
        base = {"name": "P", "client": "Acme", "lead_id": lead.id, "start_date": day(-1).isoformat(), "end_date": day(9).isoformat()}
        self.assertEqual(self.post("/projects/", {**base, "description": "d" * PROJECT_DESCRIPTION_MAX}).status_code, 201)
        self.assertEqual(self.post("/projects/", {**base, "description": "d" * (PROJECT_DESCRIPTION_MAX + 1)}).status_code, 400)
        project = self.project(name="Q")
        for limit, body_key, path in ((PROJECT_DECISION_MAX, "decision", f"/projects/{project.id}/"),
                                       (PROJECT_DECISION_MAX, "decision", f"/projects/{project.id}/decision/"),
                                       (PROJECT_DESCRIPTION_MAX, "description", f"/projects/{project.id}/")):
            self.assertEqual(self.patch(path, {body_key: "x" * limit}).status_code, 200, (path, body_key))
            self.assertEqual(self.patch(path, {body_key: "x" * (limit + 1)}).status_code, 400, (path, body_key))
        task = self.task(project=project)
        self.assertEqual(self.patch(f"/tasks/{task.id}/", {"note": "n" * TASK_NOTE_MAX}).status_code, 200)
        self.assertEqual(self.patch(f"/tasks/{task.id}/", {"note": "n" * (TASK_NOTE_MAX + 1)}).status_code, 400)
        res = self.post("/tasks/", {"title": "t", "project_id": project.id, "owner_id": project.lead_id,
                                    "due_date": "2030-01-01", "state": "blocked", "note": "n" * (TASK_NOTE_MAX + 1)})
        self.assertEqual(res.status_code, 400)


class UnknownRouteAndSlashTests(Envelope, ApiTestCase):
    def test_unknown_api_urls_return_json_envelope(self):
        for method in ("get", "post", "patch", "delete"):
            with self.subTest(method=method):
                res = getattr(self.client, method)(f"{API}/does/not/exist/")
                self.assert_envelope(res, 404)
                self.assertEqual(res.json()["error"]["code"], "not_found")
                self.assertTrue(res["Content-Type"].startswith("application/json"))
        self.assert_envelope(self.client.get(f"{API}/members/abc/"), 404)
        self.assert_envelope(self.client.get(f"{API}/"), 404)

    def test_urls_outside_api_return_django_html_404(self):
        for path in ("/", "/unknown-path/", "/members/", "/tasks", "/does/not/exist/"):
            for method in ("get", "post"):
                with self.subTest(path=path, method=method):
                    res = getattr(self.client, method)(path)
                    self.assertEqual(res.status_code, 404)
                    self.assertTrue(res["Content-Type"].startswith("text/html"))
                    self.assertNotIn("not_found", res.content.decode())

    def test_admin_still_served(self):
        res = self.client.get("/admin/")
        self.assertEqual((res.status_code, res["Location"]), (302, "/admin/login/?next=/admin/"))

    def test_missing_trailing_slash_redirects_with_308_keeping_method(self):
        for method, path in (("get", f"{API}/members"), ("post", f"{API}/tasks"), ("patch", f"{API}/tasks/1"),
                             ("delete", f"{API}/projects/1")):
            with self.subTest(path=path):
                res = getattr(self.client, method)(path)
                self.assertEqual(res.status_code, 308)
                self.assertEqual(res["Location"], path + "/")
        res = self.client.get(f"{API}/tasks?status=all&q=x")
        self.assertEqual((res.status_code, res["Location"]), (308, f"{API}/tasks/?status=all&q=x"))

    def test_post_with_trailing_slash_is_unaffected(self):
        project = self.project()
        res = self.post("/tasks/", {"title": "ok", "project_id": project.id, "owner_id": project.lead_id,
                                    "due_date": "2030-01-01"})
        self.assertEqual(res.status_code, 201)

    def test_following_the_308_performs_the_original_post(self):
        project = self.project()
        res = self.client.post(f"{API}/tasks", {"title": "via308", "project_id": project.id,
                                                  "owner_id": project.lead_id, "due_date": "2030-01-01"},
                               format="json", follow=True)
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.json()["title"], "via308")

    def test_not_found_for_real_endpoints_keeps_the_same_envelope(self):
        self.assert_envelope(self.get("/tasks/999999/"), 404)
        self.assert_envelope(self.client.put(f"{API}/tasks/1/", {}, format="json"), 405)


class ProjectListDetailOptionTests(ApiTestCase):
    def test_detail_option_adds_objectives_members_open_tasks(self):
        project = self.project()
        self.post(f"/projects/{project.id}/objectives/", {"description": "Obj"})
        self.task(project=project)
        plain = self.get("/projects/").data["results"][0]
        detailed = self.get("/projects/", detail=1).data["results"][0]
        self.assertNotIn("objectives", plain)
        self.assertEqual(detailed["objectives"][0]["description"], "Obj")
        self.assertEqual(len(detailed["members"]), 1)
        self.assertEqual(len(detailed["open_tasks"]), 1)
        # identical to the single-project detail endpoint
        single = self.get(f"/projects/{project.id}/").data
        for key in ("objectives", "members", "open_tasks", "health", "time_used", "start_offset"):
            self.assertEqual(detailed[key], single[key], key)
