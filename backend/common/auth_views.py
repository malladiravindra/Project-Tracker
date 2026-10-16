"""JWT login, token refresh, logout and "who am I".

PUBLIC (no JWT required, by design; these two are the only anonymous endpoints):
  POST /api/auth/token/          username + password -> access and refresh tokens. The password is verified by
                                 Django's authentication backend; inactive users and wrong passwords get 401.
  POST /api/auth/token/refresh/  a valid, unexpired, not-blacklisted refresh token -> a new access token (and a rotated
                                 refresh token; the old one is blacklisted).
Everything else under /api/ requires `Authorization: Bearer <access token>` (see REST_FRAMEWORK in settings).
Login and refresh are throttled per client address to slow password guessing.
"""

from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .access import ALL_ROLES, member_id_of, role_of


class AuthRateThrottle(AnonRateThrottle):
    scope = "auth"  # DEFAULT_THROTTLE_RATES["auth"]; keyed by client address


class LoginView(TokenObtainPairView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [AuthRateThrottle]


class RefreshView(TokenRefreshView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [AuthRateThrottle]


class LogoutSerializer(serializers.Serializer):
    refresh = serializers.CharField()


class LogoutView(APIView):
    """Blacklists the caller's own refresh token so it can no longer be used. Requires a valid access token."""

    permission_classes = [IsAuthenticated]
    role_policy = {"POST": ALL_ROLES}

    def post(self, request):
        ser = LogoutSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            token = RefreshToken(ser.validated_data["refresh"])
            if str(token.get("user_id")) != str(request.user.pk):
                raise TokenError("not your token")
            token.blacklist()
        except TokenError:
            body = {"error": {"code": "invalid_token", "message": "Invalid refresh token.", "fields": {}}}
            return Response(body, status=status.HTTP_400_BAD_REQUEST)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    """Who the server believes you are (from the verified token), for the frontend to show or hide features."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(
            {"username": request.user.get_username(), "role": role_of(request.user), "member_id": member_id_of(request.user)}
        )
