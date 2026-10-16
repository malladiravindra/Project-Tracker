from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models.functions import Lower

MAX_LOAD = 200
STRETCHED_THRESHOLD = 100  # load strictly above this counts as "stretched"


class Status(models.TextChoices):
    ACTIVE = "active", "Active"
    ON_LEAVE = "on_leave", "On leave"
    INACTIVE = "inactive", "Inactive"


class EmploymentType(models.TextChoices):
    FULL_TIME = "full_time", "Full-time"
    PART_TIME = "part_time", "Part-time"
    CONTRACT = "contract", "Contract"
    INTERN = "intern", "Intern"


class Member(models.Model):
    name = models.CharField(max_length=120)
    title = models.CharField(max_length=120)
    department = models.CharField(max_length=120)
    email = models.EmailField(max_length=254, blank=True, default="")  # stored lower-case; "" = not given
    phone = models.CharField(max_length=32, blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    employment_type = models.CharField(
        max_length=16, choices=EmploymentType.choices, default=EmploymentType.FULL_TIME
    )
    start_date = models.DateField(null=True, blank=True)
    load = models.PositiveSmallIntegerField(
        default=60, validators=[MinValueValidator(0), MaxValueValidator(MAX_LOAD)]
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(Lower("name"), name="member_name_ci_unique"),
            models.UniqueConstraint(
                Lower("email"), condition=~models.Q(email=""), name="member_email_ci_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(load__gte=0, load__lte=MAX_LOAD), name="member_load_0_200"
            ),
        ]

    def __str__(self):
        return self.name

    @property
    def stretched(self) -> bool:
        return self.load > STRETCHED_THRESHOLD


class Role(models.TextChoices):
    ADMIN = "admin", "Admin"
    MANAGER = "manager", "Manager"
    MEMBER = "member", "Team member"


class UserProfile(models.Model):
    """Links a login (Django user) to a role and, for team members, to their own Member record.

    The role and the linked member are set only by an administrator (Django admin), never by the client.
    A user without a profile (and who is not a superuser) has no access to any API data.
    """

    user = models.OneToOneField("auth.User", on_delete=models.CASCADE, related_name="profile")
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.MEMBER)
    member = models.OneToOneField(
        Member, null=True, blank=True, on_delete=models.SET_NULL, related_name="user_profile",
        help_text="The employee record this login belongs to. Required for the Team member role to see anything.",
    )

    def __str__(self):
        return f"{self.user.get_username()} ({self.role})"
