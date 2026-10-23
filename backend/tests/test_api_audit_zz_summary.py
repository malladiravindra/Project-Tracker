"""Cross-cutting audit probes (methods, content types, credentials, CORS, URLs) and the audit summary.

This module sorts last, so by the time ZSummaryAudit runs every other audit module has recorded its probes. The summary
test (1) compares the URL resolver's real inventory with the probes that were executed, so an endpoint/method nobody
tested is reported, and (2) fails if any probe failed.
"""

import json
import os
import re

from django.urls import get_resolver
from rest_framework.test import APIClient
from rest_framework.views import APIView

from tests.audit_support import RESULTS, AuditCase, key
from tests.support import API, day
from updates.models import DailyUpdate

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


def inventory():
    """[(route_template, view_name, [methods])] for every APIView route (admin excluded), from the live resolver."""
    rows = []

    def walk(patterns, prefix=""):
        for p in patterns:
            if hasattr(p, "url_patterns"):
                walk(p.url_patterns, prefix + str(p.pattern))
                continue
            cls = getattr(p.callback, "cls", None)
            route = prefix + str(p.pattern)
            if cls and issubclass(cls, APIView) and not route.startswith("admin/"):
                tmpl = re.sub(r"<int:(\w+)>", lambda m: "<id>" if m.group(1) == "pk" else f"<{m.group(1)}>", "/" + route.removeprefix("api/"))  # probes name routes relative to API
                rows.append((tmpl, cls.__name__, [m.upper() for m in ("get", "post", "put", "patch", "delete") if hasattr(cls, m)]))

    walk(get_resolver().url_patterns)
    return rows


class GlobalAudit(AuditCase):
    def setUp(self):
        self.lead = self.member(name="Lead One")
        self.proj = self.project(lead=self.lead, name="Alpha")
        self.tsk = self.task(project=self.proj, owner=self.lead)
        self.upd = DailyUpdate.objects.create(employee=self.lead, project=self.proj, date=day(0), completed=["x"])

    def concrete(self, tmpl):
        ids = {"<id>": None, "<member_id>": self.lead.id, "<objective_id>": 1}
        base = {"/projects/": self.proj.id, "/tasks/": self.tsk.id, "/members/": self.lead.id, "/daily-updates/": self.upd.id}
        pk = next((v for k, v in base.items() if tmpl.startswith(k)), 1)
        out = tmpl.replace("<id>", str(pk))
        for ph, val in ids.items():
            out = out.replace(ph, str(val if val is not None else 1))
        return out

    def test_unsupported_methods_and_credentials(self):
        for tmpl, _view, allowed in inventory():
            url = self.concrete(tmpl)
            denied = [m for m in METHODS if m not in allowed]

            def unsupported(denied=denied, url=url):
                seen = []
                for m in denied:
                    res = self.client.generic(m, f"{API}{url}", "{}", content_type="application/json")
                    self.assertEqual(res.status_code, 405, f"{m} -> {res.status_code}")
                    self.assertTrue(res.json()["error"]["message"], "no JSON error body")
                    self.assertIn("Allow", res, "405 without Allow header")
                    seen.append(m)
                return f"405 for {','.join(seen)}"

            for m in allowed:
                self.probe(m, tmpl, "unsupported-method", "other methods -> 405 JSON envelope with Allow header", unsupported)

            # Use independent clients: ApiTestCase's default client is force-authenticated.
            probe_method = "GET" if "GET" in allowed else None
            if probe_method:
                def rejects_credentials(url=url):
                    anon = APIClient().get(f"{API}{url}")
                    invalid = APIClient()
                    invalid.credentials(HTTP_AUTHORIZATION="Bearer invalid-token")
                    with_header = invalid.get(f"{API}{url}")
                    self.assertEqual(anon.status_code, 401)
                    self.assertEqual(with_header.status_code, 401)
                    self.assertIn("Bearer", anon["WWW-Authenticate"])
                    return f"{anon.status_code} without credentials; {with_header.status_code} with an invalid token"

                self.probe("GET", tmpl, "authentication", "anonymous and invalid-token requests are rejected", rejects_credentials)

    def test_content_types(self):
        targets = [
            ("POST", "/members/", "/members/"), ("PATCH", "/members/<id>/", "/members/<id>/"), ("POST", "/projects/", "/projects/"),
            ("PATCH", "/projects/<id>/", "/projects/<id>/"), ("POST", "/projects/<id>/members/", "/projects/<id>/members/"),
            ("POST", "/projects/<id>/objectives/", "/projects/<id>/objectives/"), ("PATCH", "/projects/<id>/decision/", "/projects/<id>/decision/"),
            ("POST", "/projects/<id>/decision/resolve/", "/projects/<id>/decision/resolve/"), ("POST", "/tasks/", "/tasks/"),
            ("PATCH", "/tasks/<id>/", "/tasks/<id>/"), ("POST", "/daily-updates/", "/daily-updates/"), ("PATCH", "/daily-updates/<id>/", "/daily-updates/<id>/"),
            ("POST", "/daily-updates/<id>/feedback/", "/daily-updates/<id>/feedback/"),
        ]
        for method, route, tmpl in targets:
            url = self.concrete(tmpl)

            def wrong_type(method=method, url=url):
                res = self.client.generic(method, f"{API}{url}", "a=1", content_type="application/x-www-form-urlencoded")
                return self.envelope(res, 415)

            def malformed(method=method, url=url):
                res = self.client.generic(method, f"{API}{url}", "{not json", content_type="application/json")
                return self.envelope(res, 400)

            self.probe(method, route, "content-type", "form-encoded body -> 415 envelope", wrong_type)
            self.probe(method, route, "invalid-input", "malformed JSON -> 400 envelope", malformed)

    def test_urls_and_cors(self):
        T = "/tasks/"

        def slash():
            get = self.client.get(f"{API}/tasks")
            self.assertEqual((get.status_code, get["Location"]), (308, f"{API}/tasks/"))
            post = self.client.post(f"{API}/tasks", {}, format="json")
            self.assertEqual(post.status_code, 308, "must keep method/body (not 301/302)")
            return "308"

        self.probe("GET", T, "url", "missing trailing slash redirects with 308 (method preserved)", slash)
        self.probe("GET", T, "url", "unknown API path -> JSON 404 envelope", lambda: self.envelope(self.client.get(f"{API}/nope/"), 404))

        def cors_allowed():
            res = self.client.options(f"{API}{T}", HTTP_ORIGIN="http://localhost:3000", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res["Access-Control-Allow-Origin"], "http://localhost:3000")
            return 200

        def cors_denied():
            res = self.client.get(f"{API}{T}", HTTP_ORIGIN="https://evil.example")
            self.assertNotIn("Access-Control-Allow-Origin", res)
            res = self.client.options(f"{API}{T}", HTTP_ORIGIN="https://evil.example", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST")
            self.assertNotIn("Access-Control-Allow-Origin", res)
            return "no CORS header"

        self.probe("GET", T, "cors", "configured frontend origin is allowed on preflight", cors_allowed)
        self.probe("GET", T, "cors", "foreign origin gets no CORS headers", cors_denied)


class ZSummaryAudit(AuditCase):
    def test_summary(self):
        inv = inventory()
        expected = {key(m, r) for r, _v, methods in inv for m in methods}
        untested = sorted(expected - set(RESULTS))
        out = os.environ.get("AUDIT_OUT")
        if out:
            with open(out, "w", encoding="utf-8") as fh:
                json.dump({"inventory": [{"route": r, "view": v, "methods": m} for r, v, m in inv], "results": RESULTS}, fh, indent=1)
        failures = [f"{k} | {e['category']} | {e['name']} | {e['detail']}" for k, v in sorted(RESULTS.items()) for e in v if not e["ok"]]
        self.assertEqual(untested, [], "endpoint/method pairs with no executed probe")
        self.assertEqual(failures, [], "failed probes:\n" + "\n".join(failures))
