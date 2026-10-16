import django.utils.timezone
from django.db import migrations, models


def backfill_work_date(apps, schema_editor):
    """Existing tasks get the (server-local) day they were created as their work date."""
    Task = apps.get_model("tasks", "Task")
    for task in Task.objects.filter(work_date__isnull=True).only("id", "created_at"):
        Task.objects.filter(pk=task.pk).update(work_date=django.utils.timezone.localdate(task.created_at))


class Migration(migrations.Migration):

    dependencies = [
        ("tasks", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="work_date",
            field=models.DateField(null=True),
        ),
        migrations.RunPython(backfill_work_date, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="task",
            name="work_date",
            field=models.DateField(db_index=True, default=django.utils.timezone.localdate),
        ),
        migrations.AlterField(
            model_name="task",
            name="due_date",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="task",
            name="priority",
            field=models.CharField(
                choices=[("Critical", "Critical"), ("High", "High"), ("Medium", "Medium"), ("Low", "Low")],
                default="Medium",
                max_length=8,
            ),
        ),
        migrations.AlterModelOptions(
            name="task",
            options={"ordering": [models.F("due_date").asc(nulls_last=True), "id"]},
        ),
    ]
