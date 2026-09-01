"""
Quota enforcement for router deployment selection.

Two hooks, deliberately asymmetric:

- `exhausted_deployment_ids` is advisory. It reads every candidate's counters in
  one round trip so selection never lands on a key whose minute or day allowance
  is already spent. Two concurrent requests can both pass it with one slot left,
  which is fine, because it decides nothing on its own.
- `reserve_first_available` is the authority. It consumes the allowance
  atomically for the deployment that selection landed on, and when a concurrent
  request took the last slot it falls forward to another candidate instead of
  failing the request.

A key at its per-minute cap is healthy, so neither hook touches cooldown state.
Cooling it down would key on `model_info.id` and leave a credential's other
deployments hammering the same spent key, and it would hold the key out of
rotation for `cooldown_time` rather than until the window rolls over.
"""

import datetime as dt
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from litellm._logging import verbose_router_logger
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


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class QuotaEnforcer:
    def __init__(
        self,
        counter: AtomicWindowCounter,
        *,
        default_scope_mode: QuotaScopeMode = DEFAULT_QUOTA_SCOPE_MODE,
        clock: Callable[[], dt.datetime] = _utc_now,
    ) -> None:
        self._counter: Final = counter
        self._default_scope_mode: Final = default_scope_mode
        self._clock: Final = clock

    async def exhausted_deployment_ids(self, deployments: Sequence[Mapping[str, object]]) -> frozenset[str]:
        """
        Ids of the deployments that have no room left for another request.

        One batched read covers the whole candidate list, so the cost is a single
        round trip no matter how many keys a model group fans out to.
        """
        quotas: Final = self._candidate_quotas(deployments)
        if not quotas:
            return frozenset()
        counts: Final = await self._counter.peek(
            tuple(descriptor.key for quota in quotas for descriptor in quota.descriptors)
        )
        return frozenset(
            quota.deployment_id
            for quota in quotas
            if quota.deployment_id is not None
            and any(counts.get(descriptor.key, 0) >= descriptor.limit for descriptor in quota.descriptors)
        )

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
