"""
MODEL QUOTA VISIBILITY

What each pool of keys has left, for an operator who wants to know why a request
went where it did.

GET /model/quota/usage - one entry per model name, listing every key behind it with
    what it has spent of its per-minute and per-day allowance, whether it is spent
    right now, and how many seconds until it can take another request

Read straight off the same counters routing reads, so this reports what selection
would do rather than a second copy of it. Advisory, like every read of those
counters: a count can be one request stale by the time it is serialized, and the
reservation on the way into a provider call stays the authority on whether a
request fits.

Nothing derived from an api key appears here. A key is identified by the deployment
id, the model string and the base url, never by the quota scope id, which is a
salted digest of the key itself.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Annotated, Final, Never

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from litellm.constants import DEFAULT_QUOTA_MAX_WAIT_SECONDS
from litellm.proxy._types import (
    CommonProxyErrors,
    UserAPIKeyAuth,
    user_api_key_has_admin_view,
)
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.router import Router
from litellm.router_utils.quota import AtomicWindowCounter, DeploymentQuotaUsage, QuotaEnforcer, QuotaWindowKind

router: Final = APIRouter(tags=["model quota visibility"])  # mutable-ok: fastapi types tags as list

_UNTYPED_MODEL_LIST_ADAPTER: Final = TypeAdapter(tuple[Mapping[str, object], ...])


class QuotaWindowUsage(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: QuotaWindowKind = Field(description="rpm for the minute window, rpd for the day window")
    limit: int
    used: int
    remaining: int
    seconds_until_reset: int = Field(description="When this window starts over, whether or not it is spent")
    timezone: str = Field(description="Which day boundary the rpd window counts to. Minute windows are always UTC")


class KeyQuotaUsage(BaseModel):
    model_config = ConfigDict(frozen=True, protected_namespaces=())

    model_id: str = Field(description="The deployment id this key serves this model under")
    litellm_model: str = Field(description="The model string the provider itself is sent")
    api_base: str | None = None
    exhausted: bool = Field(description="Whether any of this key's windows is spent, so routing will skip it")
    seconds_until_room: int | None = Field(
        default=None, description="When this key can take another request, null when it can right now"
    )
    windows: tuple[QuotaWindowUsage, ...] = Field(
        default=(), description="Empty when this key has no cap configured, so nothing meters it"
    )


class PoolQuotaUsage(BaseModel):
    model_config = ConfigDict(frozen=True, protected_namespaces=())

    model_name: str = Field(description="The name callers ask for, which every key below is rotated through")
    exhausted: bool = Field(description="Whether every key in this pool is spent, which is when a request fails")
    seconds_until_room: int | None = Field(
        default=None, description="When this pool gets a slot back, set only once every key in it is spent"
    )
    keys: tuple[KeyQuotaUsage, ...] = ()


class ModelQuotaUsageResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    enforced: bool = Field(
        description="Whether the router was built with enable_quota_routing. False means the caps below are "
        "reported as configured but nothing counts against them, so every count stays at zero"
    )
    max_wait_seconds: float = Field(
        description="How long a request is held when every key behind a model is spent. The live budget while "
        "enforcement is on, the default it would start with while it is off"
    )
    pools: tuple[PoolQuotaUsage, ...] = ()


class _QuotaUsageParams(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    model: str
    api_base: str | None = None


class _QuotaUsageModelInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str | None = None


class _QuotaUsageView(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    model_name: str
    litellm_params: _QuotaUsageParams
    model_info: _QuotaUsageModelInfo = Field(default_factory=_QuotaUsageModelInfo)


@dataclass(frozen=True, slots=True)
class _PoolMember:
    model_name: str
    key: KeyQuotaUsage


def derive_quota_usage(
    *,
    deployments: Sequence[Mapping[str, object]],
    usage: Sequence[DeploymentQuotaUsage],
    enforced: bool,
    max_wait_seconds: float = DEFAULT_QUOTA_MAX_WAIT_SECONDS,
) -> ModelQuotaUsageResponse:
    """
    Group per-deployment counter reads into one entry per model name.

    `usage` is one row per deployment in the order they were passed, which is what
    `QuotaEnforcer.usage` returns, so the two zip. A deployment that cannot be read
    well enough to name is dropped rather than reported without an identity.
    """
    members: Final = tuple(
        member
        for member in (_member(deployment, row) for deployment, row in zip(deployments, usage, strict=True))
        if member is not None
    )
    names: Final = tuple(dict.fromkeys(member.model_name for member in members))
    return ModelQuotaUsageResponse(
        enforced=enforced,
        max_wait_seconds=max_wait_seconds,
        pools=tuple(
            _pool(model_name=name, keys=tuple(member.key for member in members if member.model_name == name))
            for name in names
        ),
    )


def _pool(*, model_name: str, keys: Sequence[KeyQuotaUsage]) -> PoolQuotaUsage:
    """
    A pool is spent only when every key in it is, which is the point of pooling them.

    `seconds_until_room` follows the router's own rule: it is reported only for a pool
    with nothing left, where waiting is honest, and it is the soonest second any one
    key frees up.
    """
    exhausted: Final = all(key.exhausted for key in keys)
    soonest: Final = min((key.seconds_until_room for key in keys if key.seconds_until_room is not None), default=None)
    return PoolQuotaUsage(
        model_name=model_name,
        exhausted=exhausted,
        seconds_until_room=soonest if exhausted else None,
        keys=tuple(keys),
    )


def _member(deployment: Mapping[str, object], row: DeploymentQuotaUsage) -> _PoolMember | None:
    try:
        view: Final = _QuotaUsageView.model_validate(deployment)
    except ValidationError:
        return None
    if view.model_info.id is None:
        return None
    return _PoolMember(
        model_name=view.model_name,
        key=KeyQuotaUsage(
            model_id=view.model_info.id,
            litellm_model=view.litellm_params.model,
            api_base=view.litellm_params.api_base,
            exhausted=row.exhausted,
            seconds_until_room=row.seconds_until_room,
            windows=tuple(
                QuotaWindowUsage(
                    kind=window.kind,
                    limit=window.limit,
                    used=window.used,
                    remaining=window.remaining,
                    seconds_until_reset=window.seconds_until_reset,
                    timezone=window.timezone_name,
                )
                for window in row.windows
            ),
        ),
    )


class _ErrorBody(BaseModel):
    error: str


def _raise_http(*, status_code: int, body: _ErrorBody) -> Never:
    raise HTTPException(status_code=status_code, detail=body.model_dump(exclude_none=True))


def _raise_unless_admin_view(user_api_key_dict: UserAPIKeyAuth) -> None:
    if not user_api_key_has_admin_view(user_api_key_dict):
        _raise_http(
            status_code=status.HTTP_403_FORBIDDEN, body=_ErrorBody(error=CommonProxyErrors.not_allowed_access.value)
        )


def _live_router() -> Router:
    from litellm.proxy.proxy_server import llm_router

    if llm_router is None:
        _raise_http(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            body=_ErrorBody(error=CommonProxyErrors.no_llm_router.value),
        )
    return llm_router


async def quota_usage_of(live: Router) -> ModelQuotaUsageResponse:
    """
    Read a live router's quota counters.

    A router without quota routing has no enforcer, so the counters are read through
    one built here. The configured caps still come back, which is how an operator sees
    that the zeros are the flag being off rather than a pool nobody has used yet, and
    the hold budget that comes back is the one enforcement would start with.
    """
    deployments: Final = _UNTYPED_MODEL_LIST_ADAPTER.validate_python(live.model_list or ())
    reader: Final = live.quota_enforcer or QuotaEnforcer(AtomicWindowCounter(live.cache))
    return derive_quota_usage(
        deployments=deployments,
        usage=await reader.usage(deployments),
        enforced=live.quota_enforcer is not None,
        max_wait_seconds=reader.max_wait_seconds,
    )


@router.get(
    "/model/quota/usage",
    description="What each pool of keys has spent and has left of its per-minute and per-day allowance",
    response_model=ModelQuotaUsageResponse,
)
async def get_model_quota_usage(
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> ModelQuotaUsageResponse:
    """
    ```bash
    curl -X GET 'http://0.0.0.0:4000/model/quota/usage' -H 'Authorization: Bearer sk-1234'
    ```
    """
    _raise_unless_admin_view(user_api_key_dict)
    return await quota_usage_of(_live_router())
