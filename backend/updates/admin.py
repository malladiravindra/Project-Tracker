from django.contrib import admin

from .models import DailyUpdate, Feedback

admin.site.register(DailyUpdate)
admin.site.register(Feedback)
