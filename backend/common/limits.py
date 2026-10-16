"""Maximum lengths for free-text fields, enforced by the serializers.

The database columns for these fields are unbounded TEXT (changing them would need a migration of existing
data); the limits below are validation limits only. Chosen to be generous for real use while keeping a single
request, an activity-log line and the weekly brief a sensible size.
"""

PROJECT_DESCRIPTION_MAX = 5000  # a few paragraphs
PROJECT_DECISION_MAX = 1000  # one decision statement; it is also copied into activity text
TASK_NOTE_MAX = 2000  # "what is it waiting on"
DAILY_UPDATE_ITEM_MAX = 500  # one line of a daily update (completed / in progress / next step / blocker)
DAILY_UPDATE_ITEMS_MAX = 50  # lines per section
DAILY_UPDATE_NOTES_MAX = 2000
LIST_DEFAULT_LIMIT = 500  # rows per page for decision history and daily updates (the UI loads the newest page)
LIST_MAX_LIMIT = 1000
FEEDBACK_MAX = 2000
