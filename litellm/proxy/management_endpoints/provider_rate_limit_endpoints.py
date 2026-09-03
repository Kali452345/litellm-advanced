"""
PROVIDER RATE LIMIT PROBE

What a provider's per-minute request cap actually is, for the providers that never
publish the figure.

POST /provider/rate_limit/probe - send requests to one api key until the provider
    answers with a rate limit, and report how many it accepted before that

The accepted count is the cap, so it is the number that goes into Requests Per Minute
for that key. Only real requests can learn it, so the probe spends the key's allowance
and whatever those requests cost. It calls the provider directly rather than through
the router, since the router would reserve quota for every request and would fail the
measurement over onto a different key.

A probe that never sees a rate limit reports a floor rather than a cap: the count it
reached is all that was proven. The whole walk has to fit inside one minute, because a
minute rolling over refills the allowance and no rate limit would ever arrive, so it
stops at a deadline short of that and says which of the two happened.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from typing import Annotated, Final, Literal, TypeAlias

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from typing_extensions import ReadOnly, TypedDict

from litellm.exceptions import RateLimitError, validate_rate_limit_type
from litellm.proxy._types import CommonProxyErrors, LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.types.llms.openai import ChatCompletionUserMessage

router: Final = APIRouter(tags=["provider profile management"])  # mutable-ok: fastapi types tags as list

_WAVE_SIZE: Final = 4
_WINDOW_SECONDS: Final = 50.0
_ATTEMPT_TIMEOUT_SECONDS: Final = 15.0
_MESSAGE_LIMIT: Final = 400

ProbeOutcome: TypeAlias = Literal["rate_limited", "already_limited", "ceiling_reached", "deadline_reached", "refused"]


class ProbeRateLimitRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", protected_namespaces=())

    model: str = Field(min_length=1, description="The provider's own model string, as /provider/profiles reports it")
    api_key: str = Field(min_length=1, repr=False, description="The key to measure")
    api_base: str | None = Field(default=None, description="Where to reach it, or null for the provider's own url")
    api_version: str | None = Field(default=None, description="Api version, for the providers that need one")
    max_requests: int = Field(
        default=60,
        ge=1,
        le=200,
        description="Give up after this many accepted requests, so a key with a high cap cannot run forever",
    )


class RateLimitProbeResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    outcome: ProbeOutcome
    accepted: int = Field(
        description="Requests the provider accepted, which is its per-minute cap when the outcome is rate_limited "
        "and a floor under it otherwise"
    )
    requests_sent: int = Field(description="Requests the probe spent in total, including the refused ones")
    seconds_elapsed: float
    rate_limit_type: str | None = Field(
        default=None,
        description="Which ceiling the provider names, when it names one: requests, tokens or concurrent_requests",
    )
    retry_after_seconds: float | None = Field(
        default=None,
        description="What the provider's retry-after asked for, which tells a per-minute cap from a per-day one",
    )
    message: str | None = Field(default=None, description="What the provider said, with the probed key redacted out")


@dataclass(frozen=True, slots=True)
class Accepted:
    """The provider answered the request."""


@dataclass(frozen=True, slots=True)
class RateLimited:
    message: str
    rate_limit_type: str | None
    retry_after_seconds: float | None


@dataclass(frozen=True, slots=True)
class Refused:
    message: str


AttemptOutcome: TypeAlias = Accepted | RateLimited | Refused


@dataclass(frozen=True, slots=True)
class ProbeSettings:
    max_requests: int
    wave_size: int = _WAVE_SIZE
    window_seconds: float = _WINDOW_SECONDS


@dataclass(frozen=True, slots=True)
class ProbeCall:
    model: str
    api_key: str
    api_base: str | None
    api_version: str | None
    timeout_seconds: float


class _ErrorDetail(TypedDict):
    error: ReadOnly[str]


async def probe_rate_limit(
    *,
    settings: ProbeSettings,
    attempt: Callable[[], Awaitable[AttemptOutcome]],
    now: Callable[[], float],
) -> RateLimitProbeResponse:
    return await _walk(settings=settings, attempt=attempt, now=now, started=now(), accepted=0, sent=0)


async def _walk(
    *,
    settings: ProbeSettings,
    attempt: Callable[[], Awaitable[AttemptOutcome]],
    now: Callable[[], float],
    started: float,
    accepted: int,
    sent: int,
) -> RateLimitProbeResponse:
    if accepted >= settings.max_requests:
        return _report(outcome="ceiling_reached", accepted=accepted, sent=sent, elapsed=now() - started)
    elapsed: Final = now() - started
    if elapsed >= settings.window_seconds:
        return _report(outcome="deadline_reached", accepted=accepted, sent=sent, elapsed=elapsed)
    wave: Final = min(settings.wave_size, settings.max_requests - accepted)
    outcomes: Final = await asyncio.gather(*(attempt() for _ in range(wave)))
    landed: Final = accepted + sum(1 for outcome in outcomes if isinstance(outcome, Accepted))
    spent: Final = sent + wave
    limited: Final = next((outcome for outcome in outcomes if isinstance(outcome, RateLimited)), None)
    if limited is not None:
        return _report(
            outcome="rate_limited" if landed > 0 else "already_limited",
            accepted=landed,
            sent=spent,
            elapsed=now() - started,
            rate_limit_type=limited.rate_limit_type,
            retry_after_seconds=limited.retry_after_seconds,
            message=limited.message,
        )
    refused: Final = next((outcome for outcome in outcomes if isinstance(outcome, Refused)), None)
    if refused is not None:
        return _report(outcome="refused", accepted=landed, sent=spent, elapsed=now() - started, message=refused.message)
    return await _walk(settings=settings, attempt=attempt, now=now, started=started, accepted=landed, sent=spent)


def _report(
    *,
    outcome: ProbeOutcome,
    accepted: int,
    sent: int,
    elapsed: float,
    rate_limit_type: str | None = None,
    retry_after_seconds: float | None = None,
    message: str | None = None,
) -> RateLimitProbeResponse:
    return RateLimitProbeResponse(
        outcome=outcome,
        accepted=accepted,
        requests_sent=sent,
        seconds_elapsed=round(elapsed, 1),
        rate_limit_type=rate_limit_type,
        retry_after_seconds=retry_after_seconds,
        message=message,
    )


def attempt_outcome_from(error: BaseException, *, api_key: str) -> RateLimited | Refused:
    message: Final = str(error).replace(api_key, "***")[:_MESSAGE_LIMIT]
    if isinstance(error, RateLimitError):
        return RateLimited(
            message=message,
            rate_limit_type=validate_rate_limit_type(error.rate_limit_type),
            retry_after_seconds=_retry_after_seconds(error),
        )
    return Refused(message=message)


def _retry_after_seconds(error: RateLimitError) -> float | None:
    try:
        return float(error.response.headers["retry-after"])
    except (KeyError, ValueError):
        return None


async def _one_attempt(call: ProbeCall) -> AttemptOutcome:
    from litellm.main import acompletion  # pyright: ignore[reportUnknownVariableType]  # messages is a bare list

    message: Final[ChatCompletionUserMessage] = {"role": "user", "content": "1"}
    try:
        await acompletion(
            model=call.model,
            messages=[message],  # mutable-ok: litellm types messages as list
            max_tokens=1,
            timeout=call.timeout_seconds,
            api_key=call.api_key,
            api_base=call.api_base,
            api_version=call.api_version,
            num_retries=0,
            max_retries=0,
        )
    except Exception as error:  # noqa: BLE001  # every way a provider can fail is a reading, not a crash
        return attempt_outcome_from(error, api_key=call.api_key)
    return Accepted()


@router.post(
    "/provider/rate_limit/probe",
    description="Send requests to one api key until the provider rate limits it, and report how many it accepted",
    response_model=RateLimitProbeResponse,
)
async def probe_provider_rate_limit(
    request: ProbeRateLimitRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> RateLimitProbeResponse:
    """
    ```bash
    curl -X POST 'http://0.0.0.0:4000/provider/rate_limit/probe' -H 'Authorization: Bearer sk-1234' \\
      -H 'Content-Type: application/json' \\
      -d '{"model": "gemini/gemini-2.5-flash", "api_key": "AIza..."}'
    ```
    """
    if user_api_key_dict.user_role != LitellmUserRoles.PROXY_ADMIN:
        detail: Final[_ErrorDetail] = {"error": CommonProxyErrors.not_allowed_access.value}
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)
    call: Final = ProbeCall(
        model=request.model,
        api_key=request.api_key,
        api_base=request.api_base,
        api_version=request.api_version,
        timeout_seconds=_ATTEMPT_TIMEOUT_SECONDS,
    )
    return await probe_rate_limit(
        settings=ProbeSettings(max_requests=request.max_requests),
        attempt=partial(_one_attempt, call),
        now=time.monotonic,
    )
