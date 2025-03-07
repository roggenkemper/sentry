from __future__ import annotations

from abc import ABC
from typing import Any, Callable, Mapping, Sequence

from sentry.integrations.slack.message_builder import SLACK_URL_FORMAT
from sentry.models import Event, Group, Project, Rule, Team, User
from sentry.notifications.notifications.base import BaseNotification
from sentry.types.integrations import EXTERNAL_PROVIDERS, ExternalProviders
from sentry.utils.http import absolute_uri


class AbstractMessageBuilder(ABC):
    pass


def format_actor_options(actors: Sequence[Team | User]) -> Sequence[Mapping[str, str]]:
    sort_func: Callable[[Mapping[str, str]], Any] = lambda actor: actor["text"]
    return sorted((format_actor_option(actor) for actor in actors), key=sort_func)


def format_actor_option(actor: Team | User) -> Mapping[str, str]:
    if isinstance(actor, User):
        return {"text": actor.get_display_name(), "value": f"user:{actor.id}"}
    if isinstance(actor, Team):
        return {"text": f"#{actor.slug}", "value": f"team:{actor.id}"}

    raise NotImplementedError


def build_attachment_title(obj: Group | Event) -> str:
    ev_metadata = obj.get_event_metadata()
    ev_type = obj.get_event_type()

    if ev_type == "error" and "type" in ev_metadata:
        title = ev_metadata["type"]

    elif ev_type == "csp":
        title = f'{ev_metadata["directive"]} - {ev_metadata["uri"]}'

    else:
        title = obj.title

    # Explicitly typing to satisfy mypy.
    title_str: str = title
    return title_str


def get_title_link(
    group: Group,
    event: Event | None,
    link_to_event: bool,
    issue_details: bool,
    notification: BaseNotification | None,
    provider: ExternalProviders = ExternalProviders.SLACK,
) -> str:
    if event and link_to_event:
        url = group.get_absolute_url(
            params={"referrer": EXTERNAL_PROVIDERS[provider]}, event_id=event.event_id
        )

    elif issue_details and notification:
        referrer = notification.get_referrer(provider)
        url = group.get_absolute_url(params={"referrer": referrer})

    else:
        url = group.get_absolute_url(params={"referrer": EXTERNAL_PROVIDERS[provider]})

    # Explicitly typing to satisfy mypy.
    url_str: str = url
    return url_str


def build_attachment_text(group: Group, event: Event | None = None) -> Any | None:
    # Group and Event both implement get_event_{type,metadata}
    obj = event if event is not None else group
    ev_metadata = obj.get_event_metadata()
    ev_type = obj.get_event_type()

    if ev_type == "error":
        return ev_metadata.get("value") or ev_metadata.get("function")
    else:
        return None


def build_rule_url(rule: Any, group: Group, project: Project) -> str:
    org_slug = group.organization.slug
    project_slug = project.slug
    rule_url = f"/organizations/{org_slug}/alerts/rules/{project_slug}/{rule.id}/details/"

    # Explicitly typing to satisfy mypy.
    url: str = absolute_uri(rule_url)
    return url


def build_footer(
    group: Group,
    project: Project,
    rules: Sequence[Rule] | None = None,
    url_format: str = SLACK_URL_FORMAT,
) -> str:
    footer = f"{group.qualified_short_id}"
    if rules:
        rule_url = build_rule_url(rules[0], group, project)
        footer += f" via {url_format.format(text=rules[0].label, url=rule_url)}"

        if len(rules) > 1:
            footer += f" (+{len(rules) - 1} other)"

    return footer
