"""
Quota enforcement for router deployment selection.

Two hooks, deliberately asymmetric:

- The read side, `availability` and `most_spent_first`, is advisory. Each reads
  every candidate's counters in one round trip, so selection can drop the keys
  whose minute or day allowance is already spent and rank what is left. Two
  concurrent requests can both pass it with one slot left, which is fine,
  because it decides nothing on its own.
- `reserve_first_available` is the authority. It consumes the allowance
  atomically for the deployment that selection landed on, and when a concurrent
  request took the last slot it falls forward to another candidate instead of
  failing the request.

`wait_for_capacity` and `refund_reservation` are what keep a spent pool from
turning into an error the caller has to handle: one waits out a window that rolls
over in seconds, the other gives back a slot the request never spent.

A key at its per-minute cap is healthy, so none of this touches cooldown state.
Cooling it down would key on `model_info.id` and leave a credential's other
deployments hammering the same spent key, and it would hold the key out of
rotation for `cooldown_time` rather than until the window rolls over.
"""

import asyncio
import datetime as dt
import random
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from math import inf
from typing import Final, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from litellm._logging import verbose_router_logger
from litellm.constants import DEFAULT_QUOTA_MAX_WAIT_SECONDS
from litellm.router_utils.quota.counter import (
    AtomicWindowCounter,
    QuotaDescriptor,
    ReserveBlocked,
    ReserveGranted,
    build_descriptors,
)
from litellm.router_utils.quota.scope import DEFAULT_QUOTA_SCOPE_MODE, QuotaScope, resolve_quota_scope
from litellm.router_utils.quota.window import UnknownQuotaTimezoneError
from litellm.types.router import QuotaScopeMode

_DeploymentT: Final = TypeVar("_DeploymentT", bound=Mapping[str, object])

_QUOTA_PARAM_NAMES: Final = ("rpd", "quota_scope", "quota_scope_id", "quota_reset_timezone")

# Strategies `Router.async_get_available_deployment` hands off to the sync path,
# which has no reservation step. Anything not listed here reaches the async path.
_STRATEGIES_WITHOUT_QUOTA_ENFORCEMENT: Final = frozenset({"usage-based-routing", "lar1"})

_HOLD_PAD_SECONDS: Final = 0.25
_HOLD_JITTER_SECONDS: Final = 0.5

_UNMETERED_RATIO: Final = -1.0


class _QuotaLitellmParams(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    model: str | None = None
    rpm: int | None = None
    rpd: int | None = None
    api_base: str | None = None
    api_key: str | None = Field(default=None, repr=False)
    litellm_credential_name: str | None = None
    quota_scope: QuotaScopeMode | None = None
    quota_scope_id: str | None = None
    quota_reset_timezone: str | None = None


class _QuotaModelInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str | None = None
    rpm: int | None = None
    rpd: int | None = None


class _QuotaDeploymentView(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    rpm: int | None = None
    rpd: int | None = None
    litellm_params: _QuotaLitellmParams = Field(default_factory=_QuotaLitellmParams)
    model_info: _QuotaModelInfo = Field(default_factory=_QuotaModelInfo)


@dataclass(frozen=True, slots=True)
class _CandidateQuota:
    deployment_id: str | None
    descriptors: tuple[QuotaDescriptor, ...]


@dataclass(frozen=True, slots=True)
class QuotaAvailability:
    """
    What selection has to skip, and when the pool gets capacity back.

    `seconds_until_reset` is set only when every candidate is spent, the one case
    where waiting or reporting a retry-after is honest. It is the soonest second any
    one of them frees up, so a key blocked on both its minute and its day cap
    reports the day boundary rather than the minute it cannot use.
    """

    exhausted_deployment_ids: frozenset[str]
    seconds_until_reset: int | None


NOTHING_SPENT: Final = QuotaAvailability(exhausted_deployment_ids=frozenset(), seconds_until_reset=None)


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


async def _asyncio_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


class QuotaEnforcer:
    def __init__(
        self,
        counter: AtomicWindowCounter,
        *,
        default_scope_mode: QuotaScopeMode = DEFAULT_QUOTA_SCOPE_MODE,
        max_wait_seconds: float = DEFAULT_QUOTA_MAX_WAIT_SECONDS,
        clock: Callable[[], dt.datetime] = _utc_now,
        sleep: Callable[[float], Awaitable[None]] = _asyncio_sleep,
    ) -> None:
        self._counter: Final = counter
        self._default_scope_mode: Final = default_scope_mode
        self._max_wait_seconds: Final = max_wait_seconds
        self._clock: Final = clock
        self._sleep: Final = sleep

    def now(self) -> dt.datetime:
        """The clock the counters are keyed on, for a caller that has to stamp a reservation."""
        return self._clock()

    async def availability(self, deployments: Sequence[Mapping[str, object]]) -> QuotaAvailability:
        """
        Which deployments have no room left for another request.

        One batched read covers the whole candidate list, so the cost is a single
        round trip no matter how many keys a model group fans out to.
        """
        quotas: Final = self._candidate_quotas(deployments)
        if not quotas:
            return NOTHING_SPENT
        counts: Final = await self._counter.peek(
            tuple(descriptor.key for quota in quotas for descriptor in quota.descriptors)
        )
        blocked: Final = tuple(
            (
                quota.deployment_id,
                tuple(
                    descriptor.window.seconds_until_reset
                    for descriptor in quota.descriptors
                    if counts.get(descriptor.key, 0) >= descriptor.limit
                ),
            )
            for quota in quotas
        )
        exhausted: Final = frozenset(
            deployment_id for deployment_id, resets in blocked if resets and deployment_id is not None
        )
        return QuotaAvailability(
            exhausted_deployment_ids=exhausted,
            seconds_until_reset=(
                min(max(resets) for _, resets in blocked if resets) if len(exhausted) == len(deployments) else None
            ),
        )

    async def wait_for_capacity(
        self,
        deployments: Sequence[Mapping[str, object]],
        *,
        max_wait_seconds: float | None = None,
    ) -> QuotaAvailability:
        """
        Availability, waiting out a window that rolls over in seconds.

        A pool that is spent for the next few seconds is a wait rather than a
        failure: the harness driving this router cannot see a slightly slower
        response, and it very much can see a 429. One hold is enough, because the
        boundary the sleep lands past is where every minute counter starts over. A
        day cap never resolves inside the budget, so it falls straight through and
        the caller fails fast. The jitter keeps a burst of held requests from
        hitting the counters in the same instant.
        """
        first: Final = await self.availability(deployments)
        budget: Final = min(self._max_wait_seconds, inf if max_wait_seconds is None else max_wait_seconds)
        if first.seconds_until_reset is None or first.seconds_until_reset > budget:
            return first
        verbose_router_logger.info(
            "Every candidate is at its quota, holding this request %ss for the window to roll over",
            first.seconds_until_reset,
        )
        await self._sleep(first.seconds_until_reset + _HOLD_PAD_SECONDS + random.uniform(0, _HOLD_JITTER_SECONDS))
        return await self.availability(deployments)

    async def most_spent_first(self, deployments: Sequence[_DeploymentT]) -> tuple[_DeploymentT, ...]:
        """
        The candidates ordered by how much of their allowance is gone, fullest first.

        Stickiness, not fairness. A pool of free keys drains one credential before
        it touches the next, so a conversation keeps landing on the same key and the
        provider's prompt cache keeps hitting. Least-used-first is round robin,
        which cold-misses that cache on every request.

        A candidate scores on its worst window, so a key at 4/5 for the minute
        outranks one that has spent half of its day. Deployments with no quota
        configured score below every metered one and sort last, which leaves them
        as the overflow the pool spills into.
        """
        now: Final = self._clock()
        descriptors: Final = tuple(self._descriptors_for(deployment, now) for deployment in deployments)
        counts: Final = await self._counter.peek(tuple(descriptor.key for group in descriptors for descriptor in group))
        ranked: Final = sorted(
            range(len(deployments)),
            key=lambda index: _spent_ratio(descriptors[index], counts),
            reverse=True,
        )
        return tuple(deployments[index] for index in ranked)

    async def reserve_first_available(
        self,
        selected: _DeploymentT,
        candidates: Sequence[_DeploymentT],
    ) -> _DeploymentT | None:
        """
        Consume a request slot on `selected`, falling forward through `candidates`.

        Returns the deployment the slot was taken on, or None when every
        candidate is spent, which is the caller's cue to raise its usual
        no-deployments error rather than sleeping on a retry.
        """
        now: Final = self._clock()
        for candidate in (selected, *(other for other in candidates if other is not selected)):
            match await self._counter.reserve(self._descriptors_for(candidate, now)):
                case ReserveGranted():
                    return candidate
                case ReserveBlocked(descriptor=blocked, current=current):
                    verbose_router_logger.debug(
                        "Quota spent on a candidate deployment (%s: %s/%s), trying the next one",
                        blocked.window.kind,
                        current,
                        blocked.limit,
                    )
        return None

    async def refund_reservation(self, deployment: Mapping[str, object], *, reserved_at: dt.datetime) -> None:
        """
        Give back a slot the request took and never spent.

        The windows come from `reserved_at` rather than from now, so a request that
        fails after the minute rolled over credits the window it actually charged.
        """
        await self._counter.refund(self._descriptors_for(deployment, reserved_at))

    def _candidate_quotas(self, deployments: Sequence[Mapping[str, object]]) -> tuple[_CandidateQuota, ...]:
        now: Final = self._clock()
        return tuple(
            quota
            for quota in (self._candidate_quota(deployment, now) for deployment in deployments)
            if quota is not None
        )

    def _candidate_quota(self, deployment: Mapping[str, object], now: dt.datetime) -> _CandidateQuota | None:
        view: Final = _parse_deployment(deployment)
        if view is None:
            return None
        descriptors: Final = self._descriptors_for_view(view, now)
        if not descriptors:
            return None
        return _CandidateQuota(deployment_id=view.model_info.id, descriptors=descriptors)

    def _descriptors_for(self, deployment: Mapping[str, object], now: dt.datetime) -> tuple[QuotaDescriptor, ...]:
        view: Final = _parse_deployment(deployment)
        if view is None:
            return ()
        return self._descriptors_for_view(view, now)

    def _descriptors_for_view(self, view: _QuotaDeploymentView, now: dt.datetime) -> tuple[QuotaDescriptor, ...]:
        rpm: Final = _first_set(view.rpm, view.litellm_params.rpm, view.model_info.rpm)
        rpd: Final = _first_set(view.rpd, view.litellm_params.rpd, view.model_info.rpd)
        if rpm is None and rpd is None:
            return ()
        scope: Final = resolve_quota_scope(
            mode=view.litellm_params.quota_scope or self._default_scope_mode,
            litellm_model=view.litellm_params.model,
            deployment_id=view.model_info.id or "",
            quota_scope_id=view.litellm_params.quota_scope_id,
            litellm_credential_name=view.litellm_params.litellm_credential_name,
            api_base=view.litellm_params.api_base,
            api_key=view.litellm_params.api_key,
        )
        return _build_descriptors(
            scope=scope,
            rpm=rpm,
            rpd=rpd,
            now=now,
            quota_reset_timezone=view.litellm_params.quota_reset_timezone,
        )


def warn_on_unenforced_quotas(
    *,
    model_list: Sequence[Mapping[str, object]],
    routing_strategy: str | None,
    enable_quota_routing: bool,
) -> None:
    """
    Warn about the two ways a configured quota silently does nothing.

    Both are startup-time misconfigurations, and both look identical to a working
    setup at runtime: requests keep succeeding past the cap.
    """
    if not enable_quota_routing:
        if any(_declares_quota_params(deployment) for deployment in model_list):
            verbose_router_logger.warning(
                "Deployments declare quota params (%s) but the router was built with "
                "enable_quota_routing=False, so no per-credential quota is enforced.",
                ", ".join(_QUOTA_PARAM_NAMES),
            )
        return
    if routing_strategy in _STRATEGIES_WITHOUT_QUOTA_ENFORCEMENT:
        verbose_router_logger.warning(
            "enable_quota_routing=True has no effect for routing_strategy=%r, which selects "
            "deployments on the sync path. Use one of: simple-shuffle, usage-based-routing-v2, "
            "cost-based-routing, latency-based-routing, least-busy.",
            routing_strategy,
        )


def _declares_quota_params(deployment: Mapping[str, object]) -> bool:
    view: Final = _parse_deployment(deployment)
    return view is not None and not view.litellm_params.model_fields_set.isdisjoint(_QUOTA_PARAM_NAMES)


def _parse_deployment(deployment: Mapping[str, object]) -> _QuotaDeploymentView | None:
    try:
        return _QuotaDeploymentView.model_validate(deployment)
    except ValidationError as e:
        # Locations only. A validation message would echo the offending value,
        # and one of the fields read here is the api key.
        verbose_router_logger.error(
            "Ignoring quota config on a deployment, unreadable field(s): %s",
            tuple(error["loc"] for error in e.errors(include_input=False, include_url=False)),
        )
        return None


def _spent_ratio(descriptors: Sequence[QuotaDescriptor], counts: Mapping[str, int]) -> float:
    """
    How much of the tightest window's allowance is gone.

    A deployment with nothing metered scores below any real ratio, so it ranks
    after every metered one, and a zero limit reads as full rather than dividing
    by it.
    """
    return max(
        (
            counts.get(descriptor.key, 0) / descriptor.limit if descriptor.limit > 0 else inf
            for descriptor in descriptors
        ),
        default=_UNMETERED_RATIO,
    )


def _build_descriptors(
    *,
    scope: QuotaScope,
    rpm: int | None,
    rpd: int | None,
    now: dt.datetime,
    quota_reset_timezone: str | None,
) -> tuple[QuotaDescriptor, ...]:
    try:
        return build_descriptors(scope=scope, rpm=rpm, rpd=rpd, now=now, quota_reset_timezone=quota_reset_timezone)
    except UnknownQuotaTimezoneError as e:
        # Fall back to a UTC day rather than dropping the cap: enforcing the right
        # count on the wrong boundary beats not enforcing it at all.
        verbose_router_logger.error("%s Counting the day window in UTC instead.", e)
        return build_descriptors(scope=scope, rpm=rpm, rpd=rpd, now=now, quota_reset_timezone=None)


def _first_set(*values: int | None) -> int | None:
    return next((value for value in values if value is not None), None)
