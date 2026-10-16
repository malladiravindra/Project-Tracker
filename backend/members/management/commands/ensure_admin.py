"""Idempotent initial-administrator setup.

    INITIAL_ADMIN_USERNAME=<name> INITIAL_ADMIN_PASSWORD=<password> python manage.py ensure_admin
    python manage.py ensure_admin --username <name>        # prompts for the password (hidden)

Creates a superuser (Django superusers are always the Admin role) with a salted PBKDF2 hash. Safe to re-run:
  - the username does not exist  -> it is created;
  - the username already exists  -> NOTHING is changed (password and privileges are left alone), unless
    --reset-password is given, which replaces the password hash only. It never creates a second account.
Matching is case-sensitive, like Django's own login. The password is never printed or logged.
"""

import getpass
import os

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Create the initial administrator account if it does not exist (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument("--username", default=None, help="Defaults to $INITIAL_ADMIN_USERNAME.")
        parser.add_argument("--reset-password", action="store_true", help="Replace the password of an EXISTING account.")

    def handle(self, *args, **opts):
        User = get_user_model()
        username = (opts["username"] or os.environ.get("INITIAL_ADMIN_USERNAME") or "").strip()
        if not username:
            raise CommandError("Set INITIAL_ADMIN_USERNAME or pass --username.")

        existing = User.objects.filter(username=username).first()
        if existing and not opts["reset_password"]:
            self.stdout.write(f"User '{username}' already exists; nothing changed (use --reset-password to replace the password).")
            return

        password = os.environ.get("INITIAL_ADMIN_PASSWORD")
        if not password:
            if not self.stdin_is_tty():
                raise CommandError("Set INITIAL_ADMIN_PASSWORD, or run interactively to be prompted.")
            password = getpass.getpass("Password: ")
            if password != getpass.getpass("Password (again): "):
                raise CommandError("Passwords do not match.")
        try:
            validate_password(password, user=existing)
        except ValidationError as exc:
            raise CommandError("Password rejected: " + " ".join(exc.messages))

        if existing:
            existing.set_password(password)
            existing.is_active = True
            existing.save(update_fields=["password", "is_active"])
            self.stdout.write(f"Password replaced for existing user '{username}'.")
            return
        User.objects.create_superuser(username=username, email="", password=password)
        self.stdout.write(f"Administrator '{username}' created.")

    @staticmethod
    def stdin_is_tty() -> bool:
        import sys

        return sys.stdin is not None and sys.stdin.isatty()
