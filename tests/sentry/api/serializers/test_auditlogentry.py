from django.utils import timezone

from sentry import audit_log
from sentry.api.serializers import AuditLogEntrySerializer, serialize
from sentry.models import AuditLogEntry
from sentry.testutils import TestCase


class AuditLogEntrySerializerTest(TestCase):
    def test_simple(self):
        datetime = timezone.now()
        log = AuditLogEntry.objects.create(
            organization=self.organization,
            event=audit_log.get_event_id("TEAM_ADD"),
            actor=self.user,
            datetime=datetime,
            data={"slug": "New Team"},
        )

        serializer = AuditLogEntrySerializer()
        result = serialize(log, serializer)

        assert result["event"] == "team.create"
        assert result["actor"]["username"] == self.user.username
        assert result["dateCreated"] == datetime

    def test_scim_logname(self):
        uuid_prefix = "681d6e"
        user = self.create_user(
            username=f"scim-internal-integration-{uuid_prefix}-ad37e179-501c-4639-bc83-9780ca1",
            email="",
        )
        log = AuditLogEntry.objects.create(
            organization=self.organization,
            event=audit_log.get_event_id("TEAM_REMOVE"),
            actor=user,
            datetime=timezone.now(),
            data={"slug": "Old Team"},
        )

        serializer = AuditLogEntrySerializer()
        result = serialize(log, serializer)

        assert result["actor"]["name"] == "SCIM Internal Integration (" + uuid_prefix + ")"
