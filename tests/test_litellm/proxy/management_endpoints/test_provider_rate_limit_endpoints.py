"""
Tests for the provider rate limit probe.

What walking one key until the provider refuses reports back, and how a failure from
the provider is read.
"""

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from litellm.exceptions import RateLimitError
from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.management_endpoints.provider_rate_limit_endpoints import (
    Accepted,
    AttemptOutcome,
    ProbeRateLimitRequest,
    ProbeSettings,
    RateLimited,
    Refused,
    attempt_outcome_from,
    probe_provider_rate_limit,
    probe_rate_limit,
)


class _Provider:
    """Accepts `cap` requests per run and rate limits every one after that."""

    def __init__(self, cap: int, *, retry_after_seconds: float | None = None):
        self.cap = cap
        self.retry_after_seconds = retry_after_seconds
        self.sent = 0

    async def attempt(self) -> AttemptOutcome:
        self.sent += 1
        if self.sent > self.cap:
            return RateLimited(
                message="429 RESOURCE_EXHAUSTED",
                rate_limit_type="requests",
                retry_after_seconds=self.retry_after_seconds,
            )
        return Accepted()


class _Clock:
    """A clock that advances by `step` on every read, so a deadline can be reached without waiting."""

    def __init__(self, step: float = 0.0):
        self.step = step
        self.reading = 0.0

    def read(self) -> float:
        self.reading += self.step
        return self.reading


def _rate_limit_error(
    message: str, *, headers: dict[str, str] | None = None, rate_limit_type: str | None = None
) -> RateLimitError:
    return RateLimitError(
        message=message,
        llm_provider="gemini",
        model="gemini/gemini-2.5-flash",
        response=httpx.Response(status_code=429, headers=headers, request=httpx.Request("POST", "https://x.test")),
        rate_limit_type=rate_limit_type,
    )


async def test_reports_what_the_provider_accepted_before_it_rate_limited():
    provider = _Provider(cap=5)

    report = await probe_rate_limit(
        settings=ProbeSettings(max_requests=60, wave_size=4),
        attempt=provider.attempt,
        now=_Clock().read,
    )

    assert (report.outcome, report.accepted) == ("rate_limited", 5)
    assert report.requests_sent == 8


async def test_a_key_with_nothing_left_is_not_reported_as_a_cap_of_zero():
    """Nothing was measured, so the number must not read as a cap the user would type in."""
    report = await probe_rate_limit(
        settings=ProbeSettings(max_requests=60), attempt=_Provider(cap=0).attempt, now=_Clock().read
    )

    assert (report.outcome, report.accepted) == ("already_limited", 0)


async def test_a_provider_that_never_refuses_reports_a_floor_and_stops_at_the_ceiling():
    provider = _Provider(cap=999)

    report = await probe_rate_limit(
        settings=ProbeSettings(max_requests=10, wave_size=4), attempt=provider.attempt, now=_Clock().read
    )

    assert (report.outcome, report.accepted) == ("ceiling_reached", 10)
    assert provider.sent == 10


async def test_the_walk_stops_when_the_minute_it_has_to_fit_inside_runs_out():
    provider = _Provider(cap=999)

    report = await probe_rate_limit(
        settings=ProbeSettings(max_requests=200, wave_size=4, window_seconds=10),
        attempt=provider.attempt,
        now=_Clock(step=6).read,
    )

    assert report.outcome == "deadline_reached"
    assert report.accepted == provider.sent
    assert provider.sent < 200


async def test_a_failure_that_is_not_a_rate_limit_stops_the_walk_and_repeats_what_was_said():
    async def attempt() -> AttemptOutcome:
        return Refused(message="401 API key not valid")

    report = await probe_rate_limit(settings=ProbeSettings(max_requests=60), attempt=attempt, now=_Clock().read)

    assert (report.outcome, report.accepted) == ("refused", 0)
    assert report.message == "401 API key not valid"


async def test_a_rate_limit_beside_another_failure_in_one_wave_is_the_one_reported():
    outcomes = iter([Accepted(), Refused(message="503 overloaded"), RateLimited("429", "requests", None), Accepted()])

    async def attempt() -> AttemptOutcome:
        return next(outcomes)

    report = await probe_rate_limit(
        settings=ProbeSettings(max_requests=60, wave_size=4), attempt=attempt, now=_Clock().read
    )

    assert (report.outcome, report.accepted) == ("rate_limited", 2)


async def test_carries_which_ceiling_the_provider_named_and_when_it_frees_up():
    report = await probe_rate_limit(
        settings=ProbeSettings(max_requests=60, wave_size=1),
        attempt=_Provider(cap=1, retry_after_seconds=42).attempt,
        now=_Clock().read,
    )

    assert (report.rate_limit_type, report.retry_after_seconds) == ("requests", 42)


def test_the_probed_key_is_redacted_out_of_what_the_provider_said():
    outcome = attempt_outcome_from(_rate_limit_error("quota exceeded for key AIzaSecret"), api_key="AIzaSecret")

    assert "AIzaSecret" not in outcome.message
    assert "quota exceeded for key ***" in outcome.message


def test_a_rate_limit_carries_the_providers_retry_after_and_the_ceiling_it_named():
    outcome = attempt_outcome_from(
        _rate_limit_error("slow down", headers={"retry-after": "42"}, rate_limit_type="requests"), api_key="k"
    )

    assert isinstance(outcome, RateLimited)
    assert (outcome.rate_limit_type, outcome.retry_after_seconds) == ("requests", 42.0)


@pytest.mark.parametrize("retry_after", ["Wed, 21 Oct 2015 07:28:00 GMT", ""])
def test_a_retry_after_that_is_not_a_number_of_seconds_is_dropped(retry_after: str):
    outcome = attempt_outcome_from(_rate_limit_error("slow down", headers={"retry-after": retry_after}), api_key="k")

    assert isinstance(outcome, RateLimited)
    assert outcome.retry_after_seconds is None


def test_a_ceiling_the_provider_invented_is_dropped_rather_than_echoed():
    outcome = attempt_outcome_from(_rate_limit_error("slow down", rate_limit_type="bananas"), api_key="k")

    assert isinstance(outcome, RateLimited)
    assert outcome.rate_limit_type is None


def test_any_other_failure_is_a_refusal_rather_than_a_rate_limit():
    outcome = attempt_outcome_from(ValueError("no such model"), api_key="k")

    assert isinstance(outcome, Refused)
    assert "no such model" in outcome.message


@pytest.mark.parametrize(
    "role",
    [
        LitellmUserRoles.PROXY_ADMIN_VIEW_ONLY,
        LitellmUserRoles.ORG_ADMIN,
        LitellmUserRoles.INTERNAL_USER,
    ],
)
async def test_probing_is_denied_to_every_role_but_the_proxy_admin(role: LitellmUserRoles):
    """It spends the key's allowance and real money, so a read-only admin cannot start one."""
    with pytest.raises(HTTPException) as raised:
        await probe_provider_rate_limit(
            ProbeRateLimitRequest(model="gemini/gemini-2.5-flash", api_key="k1"),
            user_api_key_dict=UserAPIKeyAuth(user_role=role),
        )

    assert raised.value.status_code == 403


@pytest.mark.parametrize("field", ["langfuse_host", "aws_web_identity_token", "vertex_credentials"])
def test_a_credential_field_outside_the_schema_is_refused(field: str):
    """This route carries a base url on purpose, so the request-body blocklist skips it and
    the schema is the only thing left refusing the rest of what that blocklist covers."""
    with pytest.raises(ValidationError):
        ProbeRateLimitRequest(**{"model": "gemini/gemini-2.5-flash", "api_key": "k1", field: "https://attacker.test"})
