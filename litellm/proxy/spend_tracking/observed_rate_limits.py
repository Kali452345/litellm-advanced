"""
What a provider actually allowed, read back out of the rows a refusal left behind.

The failure log records how much of its allowance a key had spent at the instant the
provider turned it down. That count is the measurement: a refusal at a count of six
proves the provider accepted five, so five is the number to put in Requests Per Minute.
Many refusals give many bounds and the tightest one wins.

Unlike `/provider/rate_limit/probe`, nothing is sent to a provider here. The traffic
that produced these rows was already paid for, so the same figure comes out for free,
and it keeps coming as caps change under a key.

Two readings prove nothing and are dropped rather than averaged in. A refusal logged
while quota routing was off has no counter behind it, and a count of zero means the
window rolled over between the provider's answer and the read, so neither bounds
anything. `unmetered_refusals` reports how many were set aside, which is what says a
pool needs enforcement switched on before this view can say anything about it.
"""

import datetime as dt
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from litellm._logging import verbose_proxy_logger
from litellm.proxy.spend_tracking.deployment_error_logs import DeploymentErrorContext, QuotaWindowAtFailure
from litellm.repositories.table_repositories import ErrorLogsRepository
from litellm.router_utils.quota import QuotaWindowKind

RATE_LIMIT_STATUS_CODE: Final = "429"
DEFAULT_LOOKBACK_HOURS: Final = 24
DEFAULT_ROW_LIMIT: Final = 5000


class ObservedWindow(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: QuotaWindowKind = Field(description="rpm for the minute window, rpd for the day window")
    configured_limit: int = Field(description="What this window was capped at when the most recent refusal landed")
    refusals: int = Field(description="Refusals that carried a usable count for this window")
    lowest_count_at_refusal: int = Field(description="The smallest spend this window held when a refusal arrived")
    highest_count_at_refusal: int = Field(
        description="The largest one, which is worth comparing against the lowest: a spread means the ceiling moves, "
        "and a single repeated number means it is a hard cap"
    )
    suggested_limit: int = Field(
        description="One below the lowest refusal, so the highest figure this key is proven to accept. Zero means "
        "even the first request of a window was refused, so no per-window cap will fit under this ceiling"
    )


class ObservedKeyLimits(BaseModel):
    model_config = ConfigDict(frozen=True, protected_namespaces=())

    model_id: str = Field(description="The deployment id of the key that was refused")
    model_group: str = Field(description="The name callers ask for, which this key is one of the pool behind")
    litellm_model_name: str = Field(description="The model string the provider itself was sent")
    api_base: str = ""
    refusals: int = Field(description="Refusals behind these windows")
    last_refusal: dt.datetime
    longest_retry_after_seconds: float | None = Field(
        default=None,
        description="The longest wait any of these refusals asked for. Seconds point at the minute window, hours at "
        "a daily cap that no amount of rotation clears before tomorrow",
    )
    windows: tuple[ObservedWindow, ...] = ()


class ObservedRateLimitsResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    since: dt.datetime = Field(description="Refusals older than this were not read")
    refusals_read: int
    unmetered_refusals: int = Field(
        description="Refusals with no usable count behind them, from quota routing being off, a key with no cap "
        "configured, or a window that rolled over as the refusal was recorded"
    )
    keys: tuple[ObservedKeyLimits, ...] = ()


@dataclass(frozen=True, slots=True)
class RefusedAttempt:
    """One refusal, with the identity of the key and what its counters read."""

    model_id: str
    model_group: str
    litellm_model_name: str
    api_base: str
    at: dt.datetime
    context: DeploymentErrorContext


class _ErrorLogRow(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True, protected_namespaces=())

    model_id: str = ""
    model_group: str = ""
    litellm_model_name: str = ""
    api_base: str = ""
    end_time: dt.datetime = Field(validation_alias="endTime")
    request_kwargs: object = None


def refused_attempt(row: object) -> RefusedAttempt | None:
    """One database row as a refusal, or None when it cannot be read as one."""
    try:
        view: Final = _ErrorLogRow.model_validate(row)
    except ValidationError as e:
        verbose_proxy_logger.debug("Skipping an unreadable error log row: %s", e)
        return None
    context: Final = _context_of(view.request_kwargs)
    if context is None or not view.model_id:
        return None
    return RefusedAttempt(
        model_id=view.model_id,
        model_group=view.model_group,
        litellm_model_name=view.litellm_model_name,
        api_base=view.api_base,
        at=view.end_time,
        context=context,
    )


def _context_of(raw: object) -> DeploymentErrorContext | None:
    """
    The quota facts back out of the json column.

    Written as a json string, so that is what usually comes back, but a driver that
    hands over the decoded object is just as valid and both parse the same way.
    """
    try:
        if isinstance(raw, str):
            return DeploymentErrorContext.model_validate_json(raw)
        return DeploymentErrorContext.model_validate(raw)
    except ValidationError:
        return None


def _usable(window: QuotaWindowAtFailure) -> bool:
    return window.used > 0


def _measured(attempt: RefusedAttempt) -> bool:
    return attempt.context.quota_enforced and any(_usable(window) for window in attempt.context.quota_windows)


def derive_observed_limits(*, refusals: Sequence[RefusedAttempt], since: dt.datetime) -> ObservedRateLimitsResponse:
    """Group refusals by the key that was refused and bound each of its windows."""
    measured: Final = tuple(attempt for attempt in refusals if _measured(attempt))
    model_ids: Final = tuple(dict.fromkeys(attempt.model_id for attempt in measured))
    return ObservedRateLimitsResponse(
        since=since,
        refusals_read=len(refusals),
        unmetered_refusals=len(refusals) - len(measured),
        keys=tuple(
            _key_limits(tuple(attempt for attempt in measured if attempt.model_id == model_id))
            for model_id in model_ids
        ),
    )


def _key_limits(attempts: Sequence[RefusedAttempt]) -> ObservedKeyLimits:
    latest: Final = max(attempts, key=lambda attempt: attempt.at)
    kinds: Final = tuple(
        dict.fromkeys(
            window.kind for attempt in attempts for window in attempt.context.quota_windows if _usable(window)
        )
    )
    return ObservedKeyLimits(
        model_id=latest.model_id,
        model_group=latest.model_group,
        litellm_model_name=latest.litellm_model_name,
        api_base=latest.api_base,
        refusals=len(attempts),
        last_refusal=latest.at,
        longest_retry_after_seconds=max(
            (
                attempt.context.retry_after_seconds
                for attempt in attempts
                if attempt.context.retry_after_seconds is not None
            ),
            default=None,
        ),
        windows=tuple(_window(kind=kind, attempts=attempts) for kind in kinds),
    )


def _window(*, kind: QuotaWindowKind, attempts: Sequence[RefusedAttempt]) -> ObservedWindow:
    seen: Final = tuple(
        (attempt.at, window)
        for attempt in attempts
        for window in attempt.context.quota_windows
        if window.kind == kind and _usable(window)
    )
    counts: Final = tuple(window.used for _, window in seen)
    newest: Final = max(seen, key=lambda pair: pair[0])[1]
    return ObservedWindow(
        kind=kind,
        configured_limit=newest.limit,
        refusals=len(seen),
        lowest_count_at_refusal=min(counts),
        highest_count_at_refusal=max(counts),
        suggested_limit=min(counts) - 1,
    )


def refusals_since(since: dt.datetime) -> Mapping[str, object]:
    """The filter that finds rate limit refusals, matching how the spend panels find them."""
    return {"startTime": {"gte": since}, "status_code": RATE_LIMIT_STATUS_CODE}  # mutable-ok: prisma needs dicts


async def read_refusals(
    prisma_client: object, *, since: dt.datetime, limit: int = DEFAULT_ROW_LIMIT
) -> tuple[RefusedAttempt, ...]:
    """The refusals in the window, newest first, dropping the rows that cannot be read."""
    rows: Final = await ErrorLogsRepository(prisma_client).table.find_many(
        where=refusals_since(since),
        order={"startTime": "desc"},  # mutable-ok: prisma needs dicts
        take=limit,
    )
    return tuple(attempt for attempt in (refused_attempt(row) for row in rows) if attempt is not None)
