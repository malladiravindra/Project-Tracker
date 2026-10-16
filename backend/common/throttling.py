"""Request throttling.

Two per-client buckets, applied to every API view through REST_FRAMEWORK["DEFAULT_THROTTLE_CLASSES"]:
  - write: POST / PUT / PATCH / DELETE (default 120 per minute),
  - read:  GET / HEAD / OPTIONS         (default 600 per minute; one dashboard load is about 15 requests).
Both are generous for a person using the dashboard and exist to stop scripts and runaway clients. The limits are
configurable with DJANGO_THROTTLE_WRITE / DJANGO_THROTTLE_READ ("N/min", "N/sec", "N/hour", "N/day").

The client is identified by REMOTE_ADDR. X-Forwarded-For is NOT trusted unless DJANGO_NUM_PROXIES says how many
trusted proxies sit in front (otherwise any caller could dodge the limit by sending a different header each time).
Counters live in Django's cache: the default per-process cache is enough for one server process; with several
workers or servers configure a shared cache (Redis, Memcached), otherwise each worker counts separately.
This is application-level protection only and is not a substitute for network-level controls (firewall, reverse
proxy limits, VPN) in front of the API.
"""

from rest_framework.throttling import SimpleRateThrottle

SAFE = ("GET", "HEAD", "OPTIONS")


class _MethodRateThrottle(SimpleRateThrottle):
    def applies(self, request) -> bool:
        raise NotImplementedError

    def get_cache_key(self, request, view):
        if not self.applies(request):
            return None
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class WriteRateThrottle(_MethodRateThrottle):
    scope = "write"

    def applies(self, request) -> bool:
        return request.method not in SAFE


class ReadRateThrottle(_MethodRateThrottle):
    scope = "read"

    def applies(self, request) -> bool:
        return request.method in SAFE
