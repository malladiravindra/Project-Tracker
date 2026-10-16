"""Strict parsing of query-string / path / body integers and months.

Everything that reaches the ORM from a URL goes through here, so out-of-range or malformed input becomes a
controlled HTTP 400 (the normal error envelope) instead of an OverflowError / ValueError / database error.
Only the *expected* failure modes are handled; nothing here swallows unrelated exceptions.
"""

import re

from rest_framework.exceptions import ValidationError

# SQLite (and most databases) store integer keys as signed 64-bit values.
ID_MAX = 2**63 - 1
# OFFSET beyond the 32-bit range is never legitimate for these lists.
OFFSET_MAX = 2**31 - 1

_MONTH = re.compile(r"(\d{4})-(\d{2})")


def parse_int(value, name, minimum, maximum, message=None):
    """Parse a non-negative base-10 integer written with ASCII digits only.

    Rejects signs, whitespace, non-ASCII digits (str.isdigit() accepts e.g. "²", which int() then rejects),
    and absurdly long digit strings (checked before int(), whose own length limit would raise ValueError).
    """
    message = message or f"{name} must be a whole number between {minimum} and {maximum}."
    text = str(value)
    if not (text.isascii() and text.isdigit()) or len(text) > len(str(maximum)) + 1:
        raise ValidationError({name: message})
    number = int(text)
    if not minimum <= number <= maximum:
        raise ValidationError({name: message})
    return number


def parse_id(value, name, message=None):
    return parse_int(value, name, 1, ID_MAX, message or f"{name} must be an id.")


def parse_month(value, name="month"):
    """YYYY-MM with a real year (0001-9999) and month (01-12). Returns (year, month)."""
    message = f"{name} must be YYYY-MM."
    match = _MONTH.fullmatch(value) if value.isascii() else None
    if not match:
        raise ValidationError({name: message})
    year, month = int(match.group(1)), int(match.group(2))
    if not (1 <= year <= 9999 and 1 <= month <= 12):
        raise ValidationError({name: message})
    return year, month
