"""Uniform JSON error envelope: {"error": {"code", "message", "fields"}}."""

import logging

from django.db import IntegrityError
from django.db.models import ProtectedError
from rest_framework import status
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.response import Response
from rest_framework.views import exception_handler

logger = logging.getLogger("api")


class Conflict(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "The request conflicts with the current state."
    default_code = "conflict"


def _flatten(detail):
    if isinstance(detail, (list, tuple)):
        return [str(m) for m in detail]
    return [str(detail)]


def api_exception_handler(exc, context):
    # Expected database conflicts become a clean 409. Only these two specific exception types are handled: a race
    # on a unique value (two requests creating the same name) or a protected relation deleted in between. The
    # transaction around the view has already been rolled back. The exception text is NOT logged or returned because
    # on some databases it contains the offending data values.
    if isinstance(exc, (IntegrityError, ProtectedError)):
        view = type(context.get("view")).__name__
        logger.warning("Database conflict (%s) in %s", type(exc).__name__, view)
        return Response(
            {"error": {"code": "conflict", "message": "The request conflicts with existing data. Reload and try again.", "fields": {}}},
            status=status.HTTP_409_CONFLICT,
        )
    response = exception_handler(exc, context)
    if response is None:
        return None

    fields = {}
    if isinstance(exc, ValidationError):
        data = response.data
        if isinstance(data, dict):
            fields = {k: _flatten(v) for k, v in data.items()}
            first = next(iter(fields.values()), ["Invalid request."])
            message = first[0]
        else:
            fields = {"non_field_errors": _flatten(data)}
            message = fields["non_field_errors"][0]
        code = "validation_error"
    else:
        message = str(getattr(exc, "detail", "Request failed."))
        code = getattr(exc, "default_code", "error")

    response.data = {"error": {"code": code, "message": message, "fields": fields}}
    return response
