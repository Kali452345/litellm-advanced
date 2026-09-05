"""
Tests for the provider profile endpoints.

What a provider's profile reports, what planning another key for it produces, and
what applying that plan reports back.
"""

import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.management_endpoints.provider_profile_endpoints import (
    AddProviderKeyRequest,
    DeploymentCreated,
    DeploymentRejected,
    KeyAlreadyConfigured,
    PlanRejected,
    ProviderKeyPlan,
    SeveralApiBases,
    UnknownModels,
    UnknownProvider,
    _raise_public,
    add_provider_key,
    apply_provider_key,
    derive_provider_profiles,
    list_provider_profiles,
    plan_provider_key,
)
from litellm.router_utils.quota import DEFAULT_QUOTA_SCOPE_MODE, resolve_quota_scope
from litellm.types.router import Deployment


def _entry(
    model_name: str,
    model: str,
    api_key: str | None = None,
    deployment_id: str = "",
    **params: object,
) -> dict[str, object]:
    return {
        "model_name": model_name,
        "litellm_params": {"model": model, "api_key": api_key, **params},
        "model_info": {"id": deployment_id or f"{model_name}-{api_key}"},
    }


def _profile_of(model_list: list[dict[str, object]], provider: str):
    return next(profile for profile in derive_provider_profiles(model_list) if profile.provider == provider)


def _model_of(model_list: list[dict[str, object]], provider: str, model_name: str):
    return next(entry for entry in _profile_of(model_list, provider).models if entry.model_name == model_name)


def test_profile_reports_the_caps_its_keys_agree_on_and_nothing_where_they_disagree():
    model_list = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", rpm=5, rpd=100),
        _entry("flash", "gemini/gemini-2.5-flash", "k2", rpm=5, rpd=100),
        _entry("pro", "gemini/gemini-2.5-pro", "k1", rpm=2, rpd=50),
        _entry("pro", "gemini/gemini-2.5-pro", "k2", rpm=9, rpd=50),
    ]

    flash = _model_of(model_list, "gemini", "flash")
    pro = _model_of(model_list, "gemini", "pro")

    assert (flash.rpm, flash.rpd) == (5, 100)
    assert (pro.rpm, pro.rpd) == (None, 50)


def test_profile_counts_credentials_not_deployments():
    """One key serving three model groups is one key, not three."""
    one_key = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1"),
        _entry("pro", "gemini/gemini-2.5-pro", "k1"),
        _entry("flash-lite", "gemini/gemini-2.5-flash-lite", "k1"),
    ]

    assert _profile_of(one_key, "gemini").key_count == 1
    assert _profile_of([*one_key, _entry("flash", "gemini/gemini-2.5-flash", "k2")], "gemini").key_count == 2


def test_two_deployments_sharing_one_account_count_as_one_key():
    """`quota_scope_id` is an operator saying these two spend from one allowance."""
    model_list = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", quota_scope_id="one-account"),
        _entry("flash", "gemini/gemini-2.5-flash", "k2", quota_scope_id="one-account"),
    ]

    assert _profile_of(model_list, "gemini").key_count == 1


def test_a_provider_reached_at_two_base_urls_has_two_profiles():
    model_list = [
        _entry("gpt", "openai/gpt-5", "k1", api_base="https://one.example.com"),
        _entry("gpt", "openai/gpt-5", "k2", api_base="https://two.example.com"),
    ]

    profiles = derive_provider_profiles(model_list)

    assert [profile.api_base for profile in profiles] == ["https://one.example.com", "https://two.example.com"]
    assert {profile.provider for profile in profiles} == {"openai"}


def test_profile_reports_neither_the_key_nor_the_digest_of_it():
    secret = "sk-do-not-report-this"
    model_list = [_entry("flash", "gemini/gemini-2.5-flash", secret, quota_scope_id="an-account-name")]
    scope_id = resolve_quota_scope(
        mode="credential", litellm_model=None, deployment_id="", quota_scope_id="an-account-name"
    ).scope_id

    dumped = _profile_of(model_list, "gemini").model_dump_json()

    assert secret not in dumped
    assert scope_id not in dumped
    assert "an-account-name" not in dumped


def test_a_deployment_no_provider_can_be_named_for_is_left_out():
    model_list = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1"),
        _entry("mystery", "not-a-provider/whatever", "k2"),
    ]

    assert [profile.provider for profile in derive_provider_profiles(model_list)] == ["gemini"]


def test_a_cap_is_read_from_wherever_the_deployment_carries_it():
    top_level = {
        "model_name": "flash",
        "litellm_params": {"model": "gemini/gemini-2.5-flash", "api_key": "k1", "rpm": 3},
        "model_info": {"id": "a", "rpm": 4},
        "rpm": 7,
    }
    model_info_only = {
        "model_name": "pro",
        "litellm_params": {"model": "gemini/gemini-2.5-pro", "api_key": "k1"},
        "model_info": {"id": "b", "rpd": 250},
    }

    assert _model_of([top_level], "gemini", "flash").rpm == 7
    assert _model_of([model_info_only], "gemini", "pro").rpd == 250


def test_profile_reports_the_param_overrides_its_keys_agree_on():
    model_list = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", pinned_params={"temperature": 0.3}),
        _entry("flash", "gemini/gemini-2.5-flash", "k2", pinned_params={"temperature": 0.3}),
        _entry("pro", "gemini/gemini-2.5-pro", "k1", additional_drop_params=["temperature"]),
        _entry("pro", "gemini/gemini-2.5-pro", "k2", additional_drop_params=["temperature"]),
    ]

    flash = _model_of(model_list, "gemini", "flash")
    pro = _model_of(model_list, "gemini", "pro")

    assert flash.pinned_params == {"temperature": 0.3}
    assert flash.additional_drop_params is None
    assert pro.additional_drop_params == ("temperature",)
    assert pro.pinned_params is None


def test_the_same_overrides_written_in_a_different_order_still_agree():
    model_list = [
        _entry(
            "flash",
            "gemini/gemini-2.5-flash",
            "k1",
            pinned_params={"temperature": 0.3, "top_p": 0.1},
            additional_drop_params=["temperature", "seed"],
        ),
        _entry(
            "flash",
            "gemini/gemini-2.5-flash",
            "k2",
            pinned_params={"top_p": 0.1, "temperature": 0.3},
            additional_drop_params=["seed", "temperature"],
        ),
    ]

    flash = _model_of(model_list, "gemini", "flash")

    assert flash.pinned_params == {"temperature": 0.3, "top_p": 0.1}
    assert flash.additional_drop_params == ("seed", "temperature")


def test_an_override_only_some_keys_carry_is_not_reported_as_the_models():
    model_list = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", pinned_params={"temperature": 0.3}),
        _entry("flash", "gemini/gemini-2.5-flash", "k2", pinned_params={"temperature": 1}),
        _entry("pro", "gemini/gemini-2.5-pro", "k1", additional_drop_params=["temperature"]),
        _entry("pro", "gemini/gemini-2.5-pro", "k2"),
    ]

    assert _model_of(model_list, "gemini", "flash").pinned_params is None
    assert _model_of(model_list, "gemini", "pro").additional_drop_params is None


def test_a_model_with_no_override_reports_none_rather_than_an_empty_one():
    """An empty container and a missing one are the same absence, so they have to agree."""
    model_list = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", pinned_params={}, additional_drop_params=[]),
        _entry("flash", "gemini/gemini-2.5-flash", "k2"),
    ]

    flash = _model_of(model_list, "gemini", "flash")

    assert flash.pinned_params is None
    assert flash.additional_drop_params is None


def _plan(model_list: list[dict[str, object]], **request: object) -> ProviderKeyPlan:
    planned = plan_provider_key(AddProviderKeyRequest.model_validate(request), model_list)
    assert isinstance(planned, ProviderKeyPlan)
    return planned


def _planned(plan: ProviderKeyPlan, model_name: str) -> Deployment:
    return next(deployment for deployment in plan.deployments if deployment.model_name == model_name)


_POOL = [
    _entry("flash", "gemini/gemini-2.5-flash", "k1", rpm=5, rpd=100),
    _entry("pro", "gemini/gemini-2.5-pro", "k1", rpm=2),
    _entry("flash", "gemini/gemini-2.5-flash", "k2", rpm=5, rpd=100),
]


def test_a_new_key_joins_every_pool_the_provider_already_serves():
    plan = _plan(_POOL, provider="gemini", api_key="k3")

    assert [deployment.model_name for deployment in plan.deployments] == ["flash", "pro"]
    assert [deployment.litellm_params.model for deployment in plan.deployments] == [
        "gemini/gemini-2.5-flash",
        "gemini/gemini-2.5-pro",
    ]
    assert {deployment.litellm_params.api_key for deployment in plan.deployments} == {"k3"}


def test_a_new_key_never_inherits_a_shared_account_marker():
    """Copying `quota_scope_id` would count two keys against one allowance."""
    pool = [_entry("flash", "gemini/gemini-2.5-flash", "k1", rpm=5, quota_scope_id="one-account")]

    plan = _plan(pool, provider="gemini", api_key="k2")

    assert _planned(plan, "flash").litellm_params.quota_scope_id is None
    assert _planned(plan, "flash").litellm_params.rpm == 5


def test_the_caps_come_from_the_provider_unless_the_request_gives_its_own():
    copied = _plan(_POOL, provider="gemini", api_key="k3")
    overridden = _plan(_POOL, provider="gemini", api_key="k4", rpm=1, rpd=20)

    assert (_planned(copied, "flash").litellm_params.rpm, _planned(copied, "flash").litellm_params.rpd) == (5, 100)
    assert (_planned(copied, "pro").litellm_params.rpm, _planned(copied, "pro").litellm_params.rpd) == (2, None)
    assert (_planned(overridden, "pro").litellm_params.rpm, _planned(overridden, "pro").litellm_params.rpd) == (1, 20)


def test_a_new_key_takes_over_the_param_overrides_of_every_model_it_serves():
    """A key that forwarded a param the model rejects would fail every request that failed over to it."""
    pool = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", pinned_params={"temperature": 0.3}),
        _entry("pro", "gemini/gemini-2.5-pro", "k1", additional_drop_params=["temperature"]),
    ]

    plan = _plan(pool, provider="gemini", api_key="k2")

    assert _planned(plan, "flash").litellm_params.pinned_params == {"temperature": 0.3}
    assert _planned(plan, "flash").litellm_params.additional_drop_params is None
    assert _planned(plan, "pro").litellm_params.additional_drop_params == ["temperature"]
    assert _planned(plan, "pro").litellm_params.pinned_params is None


def test_an_override_the_provider_keys_disagree_on_is_not_inherited():
    pool = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", pinned_params={"temperature": 0.3}),
        _entry("flash", "gemini/gemini-2.5-flash", "k2", pinned_params={"temperature": 1}),
    ]

    plan = _plan(pool, provider="gemini", api_key="k3")

    assert _planned(plan, "flash").litellm_params.pinned_params is None


def test_an_inherited_override_reaches_the_deployment_in_the_shape_litellm_reads():
    """`_should_drop_param` checks `isinstance(..., list)`, so a tuple would silently drop nothing."""
    pool = [_entry("flash", "gemini/gemini-2.5-flash", "k1", additional_drop_params=["temperature"])]

    params = _planned(_plan(pool, provider="gemini", api_key="k2"), "flash").litellm_params

    assert isinstance(params.additional_drop_params, list)


def _counted_window(deployment: Deployment) -> str:
    """The counter key the router would meter this deployment's requests through."""
    params = deployment.litellm_params
    return resolve_quota_scope(
        mode=params.quota_scope or DEFAULT_QUOTA_SCOPE_MODE,
        litellm_model=params.model,
        deployment_id="",
        quota_scope_id=params.quota_scope_id,
        api_base=params.api_base,
        api_key=params.api_key,
    ).key_prefix


def test_one_key_across_several_models_is_metered_per_model_by_default():
    """A provider that publishes a limit per model gives each of them its own allowance."""
    plan = _plan(_POOL, provider="gemini", api_key="k3")

    assert _counted_window(_planned(plan, "flash")) != _counted_window(_planned(plan, "pro"))


def test_a_key_the_provider_meters_as_one_account_counts_its_models_into_one_window():
    plan = _plan(_POOL, provider="gemini", api_key="k3", quota_scope="credential", rpm=5)

    assert _counted_window(_planned(plan, "flash")) == _counted_window(_planned(plan, "pro"))
    assert {deployment.litellm_params.quota_scope for deployment in plan.deployments} == {"credential"}


def test_the_quota_scope_is_copied_from_the_provider_unless_the_request_gives_its_own():
    pool = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", rpm=5, quota_scope="credential"),
        _entry("pro", "gemini/gemini-2.5-pro", "k1", rpm=5, quota_scope="credential"),
    ]

    copied = _plan(pool, provider="gemini", api_key="k2")
    overridden = _plan(pool, provider="gemini", api_key="k3", quota_scope="credential_model")

    assert {deployment.litellm_params.quota_scope for deployment in copied.deployments} == {"credential"}
    assert {deployment.litellm_params.quota_scope for deployment in overridden.deployments} == {"credential_model"}
    assert _counted_window(_planned(overridden, "flash")) != _counted_window(_planned(overridden, "pro"))


def test_a_scope_the_request_does_not_name_is_not_invented_where_the_keys_disagree():
    pool = [
        _entry("flash", "gemini/gemini-2.5-flash", "k1", rpm=5, quota_scope="credential"),
        _entry("pro", "gemini/gemini-2.5-pro", "k1", rpm=5, quota_scope="credential_model"),
    ]

    plan = _plan(pool, provider="gemini", api_key="k2")

    assert {deployment.litellm_params.quota_scope for deployment in plan.deployments} == {None}


def test_a_key_can_be_put_behind_some_of_the_models_only():
    plan = _plan(_POOL, provider="gemini", api_key="k3", models=["pro"])

    assert [deployment.model_name for deployment in plan.deployments] == ["pro"]


def test_the_base_url_and_version_are_copied_when_the_provider_agrees_on_them():
    pool = [
        _entry("gpt", "azure/gpt-5", "k1", api_base="https://one.example.com", api_version="2024-06-01"),
        _entry("embed", "azure/text-embedding-3", "k1", api_base="https://one.example.com", api_version="2024-06-01"),
    ]

    plan = _plan(pool, provider="azure", api_key="k2")

    assert plan.api_base == "https://one.example.com"
    assert {deployment.litellm_params.api_base for deployment in plan.deployments} == {"https://one.example.com"}
    assert {deployment.litellm_params.api_version for deployment in plan.deployments} == {"2024-06-01"}


def test_a_key_at_its_own_base_url_still_serves_the_models_the_provider_serves():
    pool = [_entry("gpt", "azure/gpt-5", "k1", api_base="https://one.example.com", api_version="2024-06-01")]

    plan = _plan(pool, provider="azure", api_key="k2", api_base="https://two.example.com")

    assert plan.api_base == "https://two.example.com"
    assert [deployment.litellm_params.model for deployment in plan.deployments] == ["azure/gpt-5"]
    assert {deployment.litellm_params.api_version for deployment in plan.deployments} == {"2024-06-01"}


def test_a_provider_with_no_deployments_says_which_ones_are_configured():
    rejected = plan_provider_key(AddProviderKeyRequest(provider="cohere", api_key="k1"), _POOL)

    assert rejected == UnknownProvider(provider="cohere", configured=("gemini",))


def test_a_key_that_already_serves_the_provider_is_rejected():
    rejected = plan_provider_key(AddProviderKeyRequest(provider="gemini", api_key="k2"), _POOL)

    assert rejected == KeyAlreadyConfigured(provider="gemini")


def test_the_same_key_at_another_base_url_is_a_new_key():
    pool = [_entry("gpt", "openai/gpt-5", "k1", api_base="https://one.example.com")]

    plan = _plan(pool, provider="openai", api_key="k1", api_base="https://two.example.com")

    assert plan.api_base == "https://two.example.com"


def test_a_provider_at_several_base_urls_asks_which_one_the_new_key_uses():
    pool = [
        _entry("gpt", "azure/gpt-5", "k1", api_base="https://one.example.com"),
        _entry("gpt", "azure/gpt-5", "k2", api_base="https://two.example.com"),
    ]

    rejected = plan_provider_key(AddProviderKeyRequest(provider="azure", api_key="k3"), pool)

    assert rejected == SeveralApiBases(
        provider="azure", api_bases=("https://one.example.com", "https://two.example.com")
    )


def test_a_null_base_url_puts_the_key_on_the_providers_own_url_rather_than_asking():
    """A provider reached at both a custom url and its own has no other way to name the second."""
    pool = [
        _entry("chat", "openai/gpt-5", "k1", api_base="https://gateway.example.com"),
        _entry("chat", "openai/gpt-5", "k2"),
    ]

    plan = _plan(pool, provider="openai", api_key="k3", api_base=None)

    assert plan.api_base is None
    assert _planned(plan, "chat").litellm_params.api_base is None


def test_models_the_provider_does_not_serve_are_rejected_with_the_ones_it_does():
    rejected = plan_provider_key(AddProviderKeyRequest(provider="gemini", api_key="k3", models=("pro", "ultra")), _POOL)

    assert rejected == UnknownModels(provider="gemini", unknown=("ultra",), configured=("flash", "pro"))


async def test_every_created_deployment_is_reported_with_its_id():
    plan = _plan(_POOL, provider="gemini", api_key="k3")

    async def create(deployment: Deployment) -> DeploymentCreated:
        return DeploymentCreated(model_id=f"id-{deployment.model_name}")

    response = await apply_provider_key(plan=plan, create=create)

    assert response.provider == "gemini"
    assert [(added.model_name, added.model_id, added.error) for added in response.models] == [
        ("flash", "id-flash", None),
        ("pro", "id-pro", None),
    ]


async def test_one_model_the_provider_rejects_does_not_lose_the_others():
    plan = _plan(_POOL, provider="gemini", api_key="k3")

    async def create(deployment: Deployment):
        if deployment.model_name == "flash":
            return DeploymentRejected(reason="that model is not on this key's tier")
        return DeploymentCreated(model_id="id-pro")

    response = await apply_provider_key(plan=plan, create=create)

    assert [(added.model_name, added.model_id, added.error) for added in response.models] == [
        ("flash", None, "that model is not on this key's tier"),
        ("pro", "id-pro", None),
    ]


async def test_the_models_reported_are_the_ones_planned_not_what_writing_them_left_behind():
    """Writing a deployment encrypts its params in place, so the report is taken first."""
    plan = _plan(_POOL, provider="gemini", api_key="k3")

    async def create(deployment: Deployment) -> DeploymentCreated:
        deployment.litellm_params.model = "gAAAAABn-ciphertext"
        return DeploymentCreated(model_id=f"id-{deployment.model_name}")

    response = await apply_provider_key(plan=plan, create=create)

    assert [added.litellm_model for added in response.models] == [
        "gemini/gemini-2.5-flash",
        "gemini/gemini-2.5-pro",
    ]


async def test_one_deployment_is_written_at_a_time():
    """Every write reloads the router from the database, so two in flight race each other."""
    plan = _plan(_POOL, provider="gemini", api_key="k3")
    order: list[str] = []

    async def create(deployment: Deployment) -> DeploymentCreated:
        order.append(f"start {deployment.model_name}")
        await asyncio.sleep(0)
        order.append(f"done {deployment.model_name}")
        return DeploymentCreated(model_id=f"id-{deployment.model_name}")

    await apply_provider_key(plan=plan, create=create)

    assert order == ["start flash", "done flash", "start pro", "done pro"]


@pytest.mark.parametrize(
    ("rejected", "expected_status"),
    [
        (UnknownProvider(provider="cohere", configured=("gemini",)), 404),
        (SeveralApiBases(provider="azure", api_bases=("https://one.example.com", "https://two.example.com")), 400),
        (UnknownModels(provider="gemini", unknown=("ultra",), configured=("flash",)), 400),
        (KeyAlreadyConfigured(provider="gemini"), 409),
    ],
)
def test_each_rejection_answers_with_its_own_status_and_names_the_provider(
    rejected: PlanRejected, expected_status: int
):
    with pytest.raises(HTTPException) as raised:
        _raise_public(rejected)

    assert raised.value.status_code == expected_status
    assert rejected.provider in str(raised.value.detail)


async def test_reading_profiles_is_denied_to_a_role_without_the_admin_view():
    with pytest.raises(HTTPException) as raised:
        await list_provider_profiles(user_api_key_dict=UserAPIKeyAuth(user_role=LitellmUserRoles.INTERNAL_USER))

    assert raised.value.status_code == 403


@pytest.mark.parametrize(
    "role",
    [
        LitellmUserRoles.PROXY_ADMIN_VIEW_ONLY,
        LitellmUserRoles.ORG_ADMIN,
        LitellmUserRoles.INTERNAL_USER,
    ],
)
async def test_adding_a_key_is_denied_to_every_role_but_the_proxy_admin(role: LitellmUserRoles):
    with pytest.raises(HTTPException) as raised:
        await add_provider_key(
            AddProviderKeyRequest(provider="gemini", api_key="k1"),
            user_api_key_dict=UserAPIKeyAuth(user_role=role),
        )

    assert raised.value.status_code == 403


@pytest.mark.parametrize("field", ["langfuse_host", "aws_web_identity_token", "vertex_credentials"])
def test_a_credential_field_outside_the_schema_is_refused(field: str):
    """This route carries a base url on purpose, so the request-body blocklist skips it and
    the schema is the only thing left refusing the rest of what that blocklist covers."""
    with pytest.raises(ValidationError):
        AddProviderKeyRequest(**{"provider": "gemini", "api_key": "k1", field: "https://attacker.test"})
