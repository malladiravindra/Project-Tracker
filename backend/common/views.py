from django.http import JsonResponse
from django.http.response import HttpResponseRedirectBase
from django.urls import Resolver404, resolve
from django.views.decorators.csrf import csrf_exempt


class HttpResponsePermanentRedirectKeepMethod(HttpResponseRedirectBase):
    status_code = 308


def server_error(request, *args, **kwargs):
    """Django's handler500 (used when DEBUG is off): JSON for API URLs only, Django's plain HTML 500 page for everything else
    (admin, browser URLs); never a stack trace. The full traceback is logged server-side by Django's django.request logger."""
    if request.path.startswith("/api/"):
        return JsonResponse(
            {"error": {"code": "server_error", "message": "Something went wrong on the server.", "fields": {}}}, status=500
        )
    from django.views.defaults import server_error as default

    return default(request, *args, **kwargs)


@csrf_exempt
def api_not_found(request, path=""):
    """Fallback for any unknown URL under /api/ (mounted only at api/; URLs outside /api/ get Django's standard HTML 404).

    - A URL that only lacks its trailing slash is redirected with 308, which (unlike 301/302) keeps the HTTP
      method and body, so a POST to /tasks is not silently turned into a GET.
    - Everything else gets the standard JSON error envelope.
    """
    if not request.path.endswith("/"):
        try:
            match = resolve(request.path_info + "/")
        except Resolver404:
            match = None
        if match is not None and match.func is not api_not_found:
            target = request.path + "/"
            query = request.META.get("QUERY_STRING")
            return HttpResponsePermanentRedirectKeepMethod(f"{target}?{query}" if query else target)
    return JsonResponse(
        {"error": {"code": "not_found", "message": "No such API endpoint.", "fields": {}}}, status=404
    )
