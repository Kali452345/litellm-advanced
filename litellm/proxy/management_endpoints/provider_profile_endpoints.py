"""
PROVIDER PROFILE MANAGEMENT

Putting one more API key behind a provider that is already set up, without retyping
what that provider's deployments look like.

GET /provider/profiles - what each provider is set up with: its base url, the models
    its keys serve, the per-minute and per-day cap on each, and how many keys are
    already behind it
POST /provider/keys - add another key to a provider, creating one deployment per model
    that provider serves, under the same public model names, so the new key joins the
    pools the old ones are already rotating through
POST /provider/keys/models - serve another model with a key that is already set up,
    creating one deployment under a new public model name with the same credential,
    so one key can serve several models without its secret ever leaving the server

A profile is derived from the live model list rather than stored, so the first
deployment an operator creates for a provider is what saves its shape, and there is no
second copy of it to go stale. Every field a profile reports is what its deployments
agree on: where they disagree the field comes back null, so a value is never inherited
from whichever deployment happened to be first.
"""

from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from types import MappingProxyType
from typing import Annotated, Final, Never, TypeAlias, TypeVar, assert_never

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from litellm.exceptions import BadRequestError
from litellm.litellm_core_utils.get_llm_provider_logic import get_llm_provider
from litellm.proxy._types import (
    CommonProxyErrors,
    LitellmUserRoles,
    ProxyException,
    UserAPIKeyAuth,
    user_api_key_has_admin_view,
)
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth
from litellm.router_utils.quota import resolve_quota_scope
from litellm.types.router import Deployment, LiteLLM_Params, PinnedParamValue, QuotaScopeMode

router: Final = APIRouter(tags=["provider profile management"])  # mutable-ok: fastapi types tags as list

_ValueT: Final = TypeVar("_ValueT")

_UNTYPED_MODEL_LIST_ADAPTER: Final = TypeAdapter(tuple[Mapping[str, object], ...])


class ProviderProfileModel(BaseModel):
    model_config = ConfigDict(frozen=True, protected_namespaces=())

    model_name: str = Field(description="The name callers ask for, shared by every key behind this provider")
    litellm_model: str = Field(description="The model string the provider itself is sent")
    rpm: int | None = Field(default=None, description="Requests per minute one key gets, null when the keys disagree")
    rpd: int | None = Field(default=None, description="Requests per day one key gets, null when the keys disagree")
    pinned_params: Mapping[str, PinnedParamValue] | None = Field(
        default=None,
        description="Params this model is sent regardless of what the caller asked for, for a provider that rejects "
        "a value clients hardcode. Null when the keys disagree",
    )
    additional_drop_params: tuple[str, ...] | None = Field(
        default=None,
        description="Params never forwarded to this model, for a provider that rejects them outright. Null when the "
        "keys disagree",
    )


class ProviderProfile(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: str
    api_base: str | None = None
    api_version: str | None = None
    custom_llm_provider: str | None = Field(
        default=None,
        description="How the provider's deployments resolve their model strings, null when they disagree",
    )
    quota_scope: QuotaScopeMode | None = None
    quota_reset_timezone: str | None = None
    key_count: int = Field(description="How many distinct credentials already serve these models")
    models: tuple[ProviderProfileModel, ...] = ()


class ProviderProfilesResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    profiles: tuple[ProviderProfile, ...] = ()


class AddProviderKeyRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str = Field(min_length=1, description="The provider to add the key to, as reported by /provider/profiles")
    api_key: str = Field(min_length=1, repr=False, description="The new key")
    api_base: str | None = Field(
        default=None,
        description="The new key's base url. Omit it to inherit the provider's, or send null for the provider's own "
        "default, which is what a provider reached at both its own url and a custom one needs",
    )
    models: tuple[str, ...] | None = Field(
        default=None,
        min_length=1,
        description="Which of the provider's model names to serve, defaulting to all of them",
    )
    rpm: int | None = Field(default=None, ge=0, description="Overrides the per-minute cap copied from the provider")
    rpd: int | None = Field(default=None, ge=0, description="Overrides the per-day cap copied from the provider")
    quota_scope: QuotaScopeMode | None = Field(
        default=None,
        description="Whether the caps count per model this key serves ('credential_model') or once across all of "
        "them ('credential'), which is what a provider metering the whole account needs. Omitted copies what the "
        "provider's existing keys use",
    )


class AddedModel(BaseModel):
    model_config = ConfigDict(frozen=True, protected_namespaces=())

    model_name: str
    litellm_model: str
    model_id: str | None = None
    error: str | None = None


class AddKeyModelRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", protected_namespaces=())

    model_id: str = Field(description="The deployment whose credential serves the new model")
    model_name: str = Field(min_length=1, description="The public name callers ask for")
    litellm_model: str = Field(min_length=1, description="The model string the provider itself is sent")


class AddProviderKeyResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: str
    api_base: str | None = None
    models: tuple[AddedModel, ...] = ()


@dataclass(frozen=True, slots=True)
class ProviderKeyPlan:
    provider: str
    api_base: str | None
    deployments: tuple[Deployment, ...]


@dataclass(frozen=True, slots=True)
class UnknownProvider:
    provider: str
    configured: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SeveralApiBases:
    provider: str
    api_bases: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class UnknownModels:
    provider: str
    unknown: tuple[str, ...]
    configured: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class KeyAlreadyConfigured:
    provider: str


@dataclass(frozen=True, slots=True)
class KeySourceCredential:
    """The credential and shape one deployment serves with, copied onto another model."""

    api_key: str | None
    litellm_credential_name: str | None
    api_base: str | None
    api_version: str | None
    custom_llm_provider: str | None
    rpm: int | None
    rpd: int | None
    quota_scope: QuotaScopeMode | None
    quota_scope_id: str | None
    quota_reset_timezone: str | None
    pinned_params: Mapping[str, PinnedParamValue] | None
    additional_drop_params: tuple[str, ...] | None


@dataclass(frozen=True, slots=True)
class KeyModelPlan:
    model_name: str
    litellm_model: str
    deployment: Deployment


@dataclass(frozen=True, slots=True)
class UnknownDeployment:
    model_id: str


@dataclass(frozen=True, slots=True)
class CredentialUnreadable:
    model_id: str


@dataclass(frozen=True, slots=True)
class TeamScopedSource:
    model_id: str


@dataclass(frozen=True, slots=True)
class ModelAlreadyServed:
    model_name: str


KeyModelRejected: TypeAlias = UnknownDeployment | CredentialUnreadable | TeamScopedSource | ModelAlreadyServed


PlanRejected: TypeAlias = UnknownProvider | SeveralApiBases | UnknownModels | KeyAlreadyConfigured


@dataclass(frozen=True, slots=True)
class DeploymentCreated:
    model_id: str


@dataclass(frozen=True, slots=True)
class DeploymentRejected:
    reason: str


CreateOutcome: TypeAlias = DeploymentCreated | DeploymentRejected


class _ProviderParams(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    model: str
    custom_llm_provider: str | None = None
    api_base: str | None = None
    api_key: str | None = Field(default=None, repr=False)
    api_version: str | None = None
    litellm_credential_name: str | None = None
    rpm: int | None = None
    rpd: int | None = None
    quota_scope: QuotaScopeMode | None = None
    quota_scope_id: str | None = None
    quota_reset_timezone: str | None = None
    pinned_params: Mapping[str, PinnedParamValue] | None = None
    additional_drop_params: tuple[str, ...] | None = None


class _ProviderModelInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str | None = None
    rpm: int | None = None
    rpd: int | None = None


class _ProviderDeploymentView(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    model_name: str
    litellm_params: _ProviderParams
    model_info: _ProviderModelInfo = Field(default_factory=_ProviderModelInfo)
    rpm: int | None = None
    rpd: int | None = None


class _CreatedModel(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    model_id: str


@dataclass(frozen=True, slots=True)
class _ProviderDeployment:
    provider: str
    model_name: str
    params: _ProviderParams
    rpm: int | None
    rpd: int | None
    credential_scope_id: str


def derive_provider_profiles(model_list: Sequence[Mapping[str, object]]) -> tuple[ProviderProfile, ...]:
    """
    What each provider is set up with, one profile per base url it is reached at.

    Nothing derived from an api key leaves here: `key_count` counts distinct credential
    scopes without reporting the scope ids, which are salted digests of the keys.
    """
    parsed: Final = _parse_deployments(model_list)
    groups: Final = tuple(dict.fromkeys((deployment.provider, deployment.params.api_base) for deployment in parsed))
    return tuple(
        _profile(
            provider=provider,
            api_base=api_base,
            members=tuple(
                deployment
                for deployment in parsed
                if (deployment.provider, deployment.params.api_base) == (provider, api_base)
            ),
        )
        for provider, api_base in groups
    )


def _profile(*, provider: str, api_base: str | None, members: Sequence[_ProviderDeployment]) -> ProviderProfile:
    return ProviderProfile(
        provider=provider,
        api_base=api_base,
        api_version=_unanimous(member.params.api_version for member in members),
        custom_llm_provider=_unanimous(member.params.custom_llm_provider for member in members),
        quota_scope=_unanimous_quota_scope(members),
        quota_reset_timezone=_unanimous(member.params.quota_reset_timezone for member in members),
        key_count=len(frozenset(member.credential_scope_id for member in members)),
        models=_profile_models(members),
    )


def _profile_models(members: Sequence[_ProviderDeployment]) -> tuple[ProviderProfileModel, ...]:
    pairs: Final = tuple(dict.fromkeys((member.model_name, member.params.model) for member in members))
    return tuple(
        _profile_model(model_name=model_name, litellm_model=litellm_model, members=members)
        for model_name, litellm_model in pairs
    )


def _profile_model(
    *, model_name: str, litellm_model: str, members: Sequence[_ProviderDeployment]
) -> ProviderProfileModel:
    serving: Final = tuple(
        member for member in members if (member.model_name, member.params.model) == (model_name, litellm_model)
    )
    return ProviderProfileModel(
        model_name=model_name,
        litellm_model=litellm_model,
        rpm=_unanimous(member.rpm for member in serving),
        rpd=_unanimous(member.rpd for member in serving),
        pinned_params=_unanimous_pins(serving),
        additional_drop_params=_unanimous(_dropped(member.params) for member in serving),
    )


def _parse_deployments(model_list: Sequence[Mapping[str, object]]) -> tuple[_ProviderDeployment, ...]:
    return tuple(
        deployment for deployment in (_parse_deployment(entry) for entry in model_list) if deployment is not None
    )


def _parse_deployment(entry: Mapping[str, object]) -> _ProviderDeployment | None:
    """A deployment litellm cannot name a provider for is skipped: a call to it fails the same way."""
    try:
        view: Final = _ProviderDeploymentView.model_validate(entry)
    except ValidationError:
        return None
    provider: Final = _provider_of(view.litellm_params)
    if provider is None:
        return None
    return _ProviderDeployment(
        provider=provider,
        model_name=view.model_name,
        params=view.litellm_params,
        rpm=_first_set(view.rpm, view.litellm_params.rpm, view.model_info.rpm),
        rpd=_first_set(view.rpd, view.litellm_params.rpd, view.model_info.rpd),
        credential_scope_id=_credential_scope_id(
            api_base=view.litellm_params.api_base,
            api_key=view.litellm_params.api_key,
            deployment_id=view.model_info.id or "",
            quota_scope_id=view.litellm_params.quota_scope_id,
            litellm_credential_name=view.litellm_params.litellm_credential_name,
        ),
    )


def _provider_of(params: _ProviderParams) -> str | None:
    try:
        _, provider, _, _ = get_llm_provider(model=params.model, custom_llm_provider=params.custom_llm_provider)
    except BadRequestError:
        return None
    return provider.strip().lower() or None


def _credential_scope_id(
    *,
    api_base: str | None,
    api_key: str | None,
    deployment_id: str = "",
    quota_scope_id: str | None = None,
    litellm_credential_name: str | None = None,
) -> str:
    return resolve_quota_scope(
        mode="credential",
        litellm_model=None,
        deployment_id=deployment_id,
        quota_scope_id=quota_scope_id,
        litellm_credential_name=litellm_credential_name,
        api_base=api_base,
        api_key=api_key,
    ).scope_id


def _unanimous(values: Iterable[_ValueT]) -> _ValueT | None:
    distinct: Final = frozenset(values)
    return next(iter(distinct)) if len(distinct) == 1 else None


def _unanimous_quota_scope(members: Sequence[_ProviderDeployment]) -> QuotaScopeMode | None:
    scopes: Final[tuple[QuotaScopeMode | None, ...]] = tuple(member.params.quota_scope for member in members)
    return _unanimous(scopes)


def _unanimous_pins(members: Sequence[_ProviderDeployment]) -> Mapping[str, PinnedParamValue] | None:
    agreed: Final = _unanimous(_pinned(member.params) for member in members)
    return MappingProxyType(dict(agreed)) if agreed else None


def _pinned(params: _ProviderParams) -> tuple[tuple[str, PinnedParamValue], ...]:
    """The pins in a fixed order, so two deployments pinning the same values agree on them."""
    pins: Final = params.pinned_params
    return tuple(sorted(pins.items())) if pins else ()


def _dropped(params: _ProviderParams) -> tuple[str, ...] | None:
    """The dropped params in a fixed order, since dropping is membership and order means nothing."""
    drops: Final = params.additional_drop_params
    return tuple(sorted(drops)) if drops else None


def _drop_list(drops: tuple[str, ...] | None) -> list[str] | None:  # mutable-ok: `_should_drop_param` needs a `list`
    return list(drops) if drops else None  # mutable-ok: a tuple would silently drop nothing


def _first_set(*values: int | None) -> int | None:
    return next((value for value in values if value is not None), None)


def plan_provider_key(
    request: AddProviderKeyRequest, model_list: Sequence[Mapping[str, object]]
) -> ProviderKeyPlan | PlanRejected:
    """
    The deployments that put `request.api_key` behind everything its provider serves.

    `api_base` is a tri-state. Omitted inherits the base url the provider's existing
    deployments use, and is refused when they use more than one. Sent as null means the
    provider's own default url, which is the only way to reach the default-url pool of a
    provider that is also reached at a custom url.

    `quota_scope_id` is deliberately not copied from them. That param is an operator
    saying several deployments share one account, so copying it onto a new key would
    count two keys against one counter and spend half of what the pool really has.

    `quota_scope` is copied unless the request names one, since whether a key's caps
    count per model or once across all of them is a fact about the provider's metering
    rather than about the key.

    `pinned_params` and `additional_drop_params` are copied per model, since a model
    rejecting a param rejects it whichever key sent it. Without the copy a new key would
    be the one deployment in the pool that forwards it, and the request that failed over
    to that key would get the provider error the override exists to prevent.
    """
    parsed: Final = _parse_deployments(model_list)
    provider: Final = request.provider.strip().lower()
    members: Final = tuple(deployment for deployment in parsed if deployment.provider == provider)
    if not members:
        return UnknownProvider(
            provider=provider, configured=tuple(dict.fromkeys(deployment.provider for deployment in parsed))
        )
    bases: Final = tuple(dict.fromkeys(member.params.api_base for member in members))
    chose_base: Final = "api_base" in request.model_fields_set
    if not chose_base and len(bases) > 1:
        return SeveralApiBases(provider=provider, api_bases=tuple(base for base in bases if base is not None))
    entries: Final = _profile_models(members)
    served: Final = frozenset(entry.model_name for entry in entries)
    unknown: Final = tuple(name for name in (request.models or ()) if name not in served)
    if unknown:
        return UnknownModels(
            provider=provider, unknown=unknown, configured=tuple(entry.model_name for entry in entries)
        )
    api_base: Final = request.api_base if chose_base else next(iter(bases), None)
    if _credential_scope_id(api_base=api_base, api_key=request.api_key) in frozenset(
        member.credential_scope_id for member in members
    ):
        return KeyAlreadyConfigured(provider=provider)
    return ProviderKeyPlan(
        provider=provider,
        api_base=api_base,
        deployments=_planned_deployments(request=request, api_base=api_base, members=members, entries=entries),
    )


def _planned_deployments(
    *,
    request: AddProviderKeyRequest,
    api_base: str | None,
    members: Sequence[_ProviderDeployment],
    entries: Sequence[ProviderProfileModel],
) -> tuple[Deployment, ...]:
    api_version: Final = _unanimous(member.params.api_version for member in members)
    custom_llm_provider: Final = _unanimous(member.params.custom_llm_provider for member in members)
    quota_scope: Final = request.quota_scope or _unanimous_quota_scope(members)
    quota_reset_timezone: Final = _unanimous(member.params.quota_reset_timezone for member in members)
    return tuple(
        Deployment(
            model_name=entry.model_name,
            litellm_params=LiteLLM_Params(
                model=entry.litellm_model,
                api_key=request.api_key,
                api_base=api_base,
                api_version=api_version,
                custom_llm_provider=custom_llm_provider,
                rpm=_first_set(request.rpm, entry.rpm),
                rpd=_first_set(request.rpd, entry.rpd),
                quota_scope=quota_scope,
                quota_reset_timezone=quota_reset_timezone,
                pinned_params=entry.pinned_params,
                additional_drop_params=_drop_list(entry.additional_drop_params),
            ),
        )
        for entry in entries
        if request.models is None or entry.model_name in request.models
    )


def plan_key_model(
    request: AddKeyModelRequest, *, source: KeySourceCredential, model_list: Sequence[Mapping[str, object]]
) -> KeyModelPlan | KeyModelRejected:
    """
    The deployment that serves `request.model_name` with `source`'s credential.

    Everything about how the credential reaches the provider is copied: the base
    url, the version, the resolution, the caps, the metering scope and the param
    pins. `quota_scope_id` is copied too, unlike the new-key flow: this is the
    same credential, so sharing its counter is correct rather than double
    counting. Only the names change, to the model asked for.

    A model the same credential already serves under the same public name is
    refused, since creating it again would only split one pool into twins.
    """
    if _credential_serves_model(source=source, model_name=request.model_name, model_list=model_list):
        return ModelAlreadyServed(model_name=request.model_name)
    return KeyModelPlan(
        model_name=request.model_name,
        litellm_model=request.litellm_model,
        deployment=Deployment(
            model_name=request.model_name,
            litellm_params=LiteLLM_Params(
                model=request.litellm_model,
                api_key=source.api_key,
                api_base=source.api_base,
                api_version=source.api_version,
                custom_llm_provider=source.custom_llm_provider,
                litellm_credential_name=source.litellm_credential_name,
                rpm=source.rpm,
                rpd=source.rpd,
                quota_scope=source.quota_scope,
                quota_scope_id=source.quota_scope_id,
                quota_reset_timezone=source.quota_reset_timezone,
                pinned_params=source.pinned_params,
                additional_drop_params=_drop_list(source.additional_drop_params),
            ),
        ),
    )


def _credential_serves_model(
    *, source: KeySourceCredential, model_name: str, model_list: Sequence[Mapping[str, object]]
) -> bool:
    """Whether this credential already serves this public name, by key or vault name."""
    return any(
        _same_credential(deployment, source=source) and deployment.model_name == model_name
        for deployment in _parse_deployments(model_list)
    )


def _same_credential(deployment: _ProviderDeployment, *, source: KeySourceCredential) -> bool:
    if deployment.params.api_base != source.api_base:
        return False
    if source.api_key is not None:
        return deployment.params.api_key == source.api_key
    return (
        deployment.params.api_key is None
        and deployment.params.litellm_credential_name == source.litellm_credential_name
    )


async def apply_provider_key(
    *,
    plan: ProviderKeyPlan,
    create: Callable[[Deployment], Awaitable[CreateOutcome]],
) -> AddProviderKeyResponse:
    """
    Create the planned deployments one at a time, reporting each on its own.

    One at a time because every create reloads the router from the database, and per
    model because a provider that rejects one model should not cost the operator the
    other five. Each model name is read before its create runs, since writing a
    deployment encrypts its params in place.
    """
    identities: Final = tuple(
        (deployment.model_name, deployment.litellm_params.model) for deployment in plan.deployments
    )
    outcomes: Final = tuple([await create(deployment) for deployment in plan.deployments])
    return AddProviderKeyResponse(
        provider=plan.provider,
        api_base=plan.api_base,
        models=tuple(
            _added(model_name=model_name, litellm_model=litellm_model, outcome=outcome)
            for (model_name, litellm_model), outcome in zip(identities, outcomes, strict=True)
        ),
    )


def _added(*, model_name: str, litellm_model: str, outcome: CreateOutcome) -> AddedModel:
    match outcome:
        case DeploymentCreated(model_id=model_id):
            return AddedModel(model_name=model_name, litellm_model=litellm_model, model_id=model_id)
        case DeploymentRejected(reason=reason):
            return AddedModel(model_name=model_name, litellm_model=litellm_model, error=reason)
        case _:
            assert_never(outcome)


async def _create_via_model_new(deployment: Deployment, *, user_api_key_dict: UserAPIKeyAuth) -> CreateOutcome:
    """
    Hand the deployment to POST /model/new rather than writing it here.

    That is what encrypts the key at rest, checks the caller may add the model, reloads
    the router and writes the audit log, none of which should have a second implementation.
    """
    from litellm.proxy.management_endpoints.model_management_endpoints import add_new_model

    try:
        model_id: Final = _created_model_id(
            await add_new_model(model_params=deployment, user_api_key_dict=user_api_key_dict)
        )
    except ProxyException as e:
        return DeploymentRejected(reason=str(e))
    if model_id is None:
        return DeploymentRejected(reason="the deployment was not written to the database")
    return DeploymentCreated(model_id=model_id)


def _created_model_id(created: object) -> str | None:
    try:
        validated: Final = _CreatedModel.model_validate(created, from_attributes=True)
    except ValidationError:
        return None
    return validated.model_id


class _ErrorBody(BaseModel):
    error: str
    api_bases: tuple[str, ...] | None = None
    configured_providers: tuple[str, ...] | None = None
    configured_models: tuple[str, ...] | None = None


def _raise_http(*, status_code: int, body: _ErrorBody) -> Never:
    raise HTTPException(status_code=status_code, detail=body.model_dump(exclude_none=True))


def _raise_public(rejected: PlanRejected) -> Never:
    status_code, body = _public_failure(rejected)
    _raise_http(status_code=status_code, body=body)


def _public_failure(rejected: PlanRejected) -> tuple[int, _ErrorBody]:
    match rejected:
        case UnknownProvider(provider=provider, configured=configured):
            return status.HTTP_404_NOT_FOUND, _ErrorBody(
                error=f"no deployment is configured for provider '{provider}', so there is nothing to copy. "
                "add this provider's first model with POST /model/new, then its later keys land here",
                configured_providers=configured,
            )
        case SeveralApiBases(provider=provider, api_bases=api_bases):
            return status.HTTP_400_BAD_REQUEST, _ErrorBody(
                error=f"provider '{provider}' is reached at more than one base url, so pass api_base to say which one "
                "the new key uses, or null for the provider's own default",
                api_bases=api_bases,
            )
        case UnknownModels(provider=provider, unknown=unknown, configured=configured):
            return status.HTTP_400_BAD_REQUEST, _ErrorBody(
                error=f"provider '{provider}' does not serve {', '.join(unknown)}",
                configured_models=configured,
            )
        case KeyAlreadyConfigured(provider=provider):
            return status.HTTP_409_CONFLICT, _ErrorBody(error=f"that key already serves provider '{provider}'")
        case _:
            assert_never(rejected)


def _raise_unless_admin_view(user_api_key_dict: UserAPIKeyAuth) -> None:
    if not user_api_key_has_admin_view(user_api_key_dict):
        _raise_http(
            status_code=status.HTTP_403_FORBIDDEN, body=_ErrorBody(error=CommonProxyErrors.not_allowed_access.value)
        )


def _live_model_list() -> tuple[Mapping[str, object], ...]:
    from litellm.proxy.proxy_server import llm_router

    if llm_router is None:
        _raise_http(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            body=_ErrorBody(error=CommonProxyErrors.no_llm_router.value),
        )
    return _UNTYPED_MODEL_LIST_ADAPTER.validate_python(llm_router.model_list or ())


@router.get(
    "/provider/profiles",
    description="What each configured provider is set up with, so putting another key behind it is one call",
    response_model=ProviderProfilesResponse,
)
async def list_provider_profiles(
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> ProviderProfilesResponse:
    """
    ```bash
    curl -X GET 'http://0.0.0.0:4000/provider/profiles' -H 'Authorization: Bearer sk-1234'
    ```
    """
    _raise_unless_admin_view(user_api_key_dict)
    return ProviderProfilesResponse(profiles=derive_provider_profiles(_live_model_list()))


@router.post(
    "/provider/keys",
    description="Put another api key behind a provider, one deployment per model that provider serves",
    response_model=AddProviderKeyResponse,
)
async def add_provider_key(
    request: AddProviderKeyRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> AddProviderKeyResponse:
    """
    ```bash
    curl -X POST 'http://0.0.0.0:4000/provider/keys' -H 'Authorization: Bearer sk-1234' \\
      -H 'Content-Type: application/json' \\
      -d '{"provider": "gemini", "api_key": "AIza...", "rpm": 5, "rpd": 100}'
    ```
    """
    if user_api_key_dict.user_role != LitellmUserRoles.PROXY_ADMIN:
        _raise_http(
            status_code=status.HTTP_403_FORBIDDEN, body=_ErrorBody(error=CommonProxyErrors.not_allowed_access.value)
        )
    planned: Final = plan_provider_key(request, _live_model_list())
    match planned:
        case ProviderKeyPlan():
            return await apply_provider_key(
                plan=planned, create=partial(_create_via_model_new, user_api_key_dict=user_api_key_dict)
            )
        case _:
            _raise_public(planned)


def _raise_key_model_public(rejected: KeyModelRejected) -> Never:
    status_code, body = _key_model_failure(rejected)
    _raise_http(status_code=status_code, body=body)


def _key_model_failure(rejected: KeyModelRejected) -> tuple[int, _ErrorBody]:
    match rejected:
        case UnknownDeployment(model_id=model_id):
            return status.HTTP_404_NOT_FOUND, _ErrorBody(error=f"no deployment is stored with id '{model_id}'")
        case CredentialUnreadable(model_id=model_id):
            return status.HTTP_500_INTERNAL_SERVER_ERROR, _ErrorBody(
                error=f"the credential on deployment '{model_id}' cannot be read, so it cannot be copied. "
                "Check that the salt key matches the one that stored it"
            )
        case TeamScopedSource():
            return status.HTTP_400_BAD_REQUEST, _ErrorBody(
                error="team models are owned by the team flow and cannot seed a shared deployment"
            )
        case ModelAlreadyServed(model_name=model_name):
            return status.HTTP_409_CONFLICT, _ErrorBody(
                error=f"this key already serves '{model_name}', so there is nothing to add"
            )
        case _:
            assert_never(rejected)


def _source_credential(row: Mapping[str, object]) -> KeySourceCredential | None:
    """The credential a stored row serves with, decrypted for copying.

    Reads through the same view the profiles use, so caps kept wherever a
    deployment carries them (top level, params, or model info) copy over.
    Returns None when a stored string key cannot be decrypted. A deployment with
    no key (provider defaults or environment) copies as keyless, which is the
    same way it serves today. `os.environ` references round-trip untouched.
    """
    from litellm.proxy.common_utils.encrypt_decrypt_utils import decrypt_value_helper

    try:
        view: Final = _ProviderDeploymentView.model_validate(row)
    except ValidationError:
        return None
    params: Final = view.litellm_params
    api_key: Final = params.api_key
    decrypted: Final[str | None] = (
        api_key if api_key is None else decrypt_value_helper(value=api_key, key="api_key", exception_type="debug")
    )
    if isinstance(api_key, str) and not isinstance(decrypted, str):
        return None
    return KeySourceCredential(
        api_key=decrypted,
        litellm_credential_name=params.litellm_credential_name,
        api_base=params.api_base,
        api_version=params.api_version,
        custom_llm_provider=params.custom_llm_provider,
        rpm=_first_set(view.rpm, params.rpm, view.model_info.rpm),
        rpd=_first_set(view.rpd, params.rpd, view.model_info.rpd),
        quota_scope=params.quota_scope,
        quota_scope_id=params.quota_scope_id,
        quota_reset_timezone=params.quota_reset_timezone,
        pinned_params=params.pinned_params,
        additional_drop_params=tuple(params.additional_drop_params) if params.additional_drop_params else None,
    )


def _source_team_id(row: Mapping[str, object]) -> str | None:
    """The team a stored row belongs to, when it belongs to one."""
    model_info: Final = row.get("model_info")
    if not isinstance(model_info, dict):
        return None
    team_id: Final = model_info.get("team_id")
    return team_id if isinstance(team_id, str) and team_id else None


async def _stored_row(model_id: str) -> Mapping[str, object] | None:
    """The stored deployment row, or None when no row carries this id."""
    from litellm.proxy.proxy_server import prisma_client
    from litellm.repositories.model_repository import ModelRepository

    if prisma_client is None:
        _raise_http(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            body=_ErrorBody(error=CommonProxyErrors.db_not_connected_error.value),
        )
    row: Final = await ModelRepository(prisma_client).table.find_unique(where={"model_id": model_id})
    if row is None:
        return None
    dumped: Final = row.model_dump()
    return dumped if isinstance(dumped, dict) else None


@router.post(
    "/provider/keys/models",
    description="Serve another model with a key that is already set up, under a new public model name",
    response_model=AddedModel,
)
async def add_key_model(
    request: AddKeyModelRequest,
    user_api_key_dict: Annotated[UserAPIKeyAuth, Depends(user_api_key_auth)],
) -> AddedModel:
    """
    ```bash
    curl -X POST 'http://0.0.0.0:4000/provider/keys/models' -H 'Authorization: Bearer sk-1234' \\
      -H 'Content-Type: application/json' \\
      -d '{"model_id": "3f2c...", "model_name": "smart", "litellm_model": "gemini/gemini-2.5-pro"}'
    ```
    """
    if user_api_key_dict.user_role != LitellmUserRoles.PROXY_ADMIN:
        _raise_http(
            status_code=status.HTTP_403_FORBIDDEN, body=_ErrorBody(error=CommonProxyErrors.not_allowed_access.value)
        )
    stored: Final = await _stored_row(request.model_id)
    if stored is None:
        _raise_http(status_code=status.HTTP_404_NOT_FOUND, body=_ErrorBody(error="no deployment is stored with id"))
    if _source_team_id(stored) is not None:
        _raise_key_model_public(TeamScopedSource(model_id=request.model_id))
    source: Final = _source_credential(stored)
    if source is None:
        _raise_key_model_public(CredentialUnreadable(model_id=request.model_id))
    planned: Final = plan_key_model(request, source=source, model_list=_live_model_list())
    match planned:
        case KeyModelPlan(deployment=deployment):
            outcome: Final = await _create_via_model_new(deployment, user_api_key_dict=user_api_key_dict)
            return _added(model_name=planned.model_name, litellm_model=planned.litellm_model, outcome=outcome)
        case _:
            _raise_key_model_public(planned)
