"""Shared helpers for the endpoint-by-endpoint API audit (see test_api_audit_*.py).

Every probe sends a real HTTP request through DRF's APIClient (full URL routing, middleware, parsers, serializers,
views, ORM, isolated test database) and records what was observed, per endpoint and HTTP method. Nothing here is
inferred from route definitions. When AUDIT_OUT is set, the observations are written to that JSON file, which is the
raw material for the report in empty.txt; the audit also fails the test run if any probe fails.
"""

import json
import os

from django.core.cache import cache
from tests.support import API, ApiTestCase

RESULTS: dict = {}  # "METHOD /route/" -> [probe dicts]


def key(method, route):
    return f"{method} {route}"


class AuditCase(ApiTestCase):
    """Probe helper: run a check, record pass/fail and the HTTP status(es) seen."""

    def probe(self, method, route, category, name, fn):
        entry = {"category": category, "name": name, "ok": True, "http": "", "detail": ""}
        cache.clear()  # the audit checks endpoint behaviour; throttling has its own tests (test_reliability.py)
        try:
            seen = fn()
            entry["http"] = str(seen) if seen is not None else ""
        except AssertionError as e:
            entry.update(ok=False, detail=str(e).splitlines()[0][:300])
        except Exception as e:  # a server exception is itself a finding
            entry.update(ok=False, detail=f"{type(e).__name__}: {str(e)[:250]}")
        RESULTS.setdefault(key(method, route), []).append(entry)
        return entry["ok"]

    # --- request helpers returning the response ---
    def req(self, method, path, data=None, **kw):
        c = getattr(self.client, method.lower())
        if method in ("GET", "DELETE"):
            return c(f"{API}{path}", data or {}, **kw) if method == "GET" else c(f"{API}{path}", **kw)
        return c(f"{API}{path}", data if data is not None else {}, format="json", **kw)

    def expect(self, res, status):
        self.assertEqual(res.status_code, status, f"expected {status}, got {res.status_code}: {getattr(res, 'data', '')}")
        return res.status_code

    def envelope(self, res, status):
        """Standard JSON error envelope: {"error": {"code", "message", "fields"}}."""
        self.expect(res, status)
        err = res.json()["error"]
        self.assertTrue(err.get("code") and err.get("message") is not None and isinstance(err.get("fields"), dict), f"bad envelope {err}")
        return res.status_code

    def bad(self, method, route, path, data, status=400, name=None):
        return self.probe(
            method, route, "invalid-input", name or f"invalid payload {json.dumps(data, default=str)[:70]}",
            lambda: self.envelope(self.req(method, path, data), status),
        )

    def not_found(self, method, route, path, data=None):
        return self.probe(method, route, "missing-id", "nonexistent record -> 404 envelope", lambda: self.envelope(self.req(method, path, data), 404))


def write_results():
    out = os.environ.get("AUDIT_OUT")
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(RESULTS, fh, indent=1)
