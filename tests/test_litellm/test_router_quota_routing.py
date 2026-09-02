"""
Tests for per-credential quota routing (router_settings.enable_quota_routing).

When enabled, `rpm` / `rpd` on a deployment become hard caps rather than shuffle
weights: a credential with nothing left in the current window is dropped before
routing picks a deployment, and the winner's slot is reserved before the request
goes out.
"""

import asyncio
import time
from collections import Counter

import pytest

from litellm import Router
from litellm.exceptions import APIConnectionError, RateLimitError
from litellm.router_utils.cooldown_handlers import _async_get_cooldown_deployments
from litellm.types.router import RouterRateLimitError

MODEL = "gemini/gemini-2.5-flash"
NEVER_HELD = 0.0
NEVER_LANDED = APIConnectionError(message="connection refused", llm_provider="gemini", model=MODEL)
PROVIDER_429 = RateLimitError(message="quota exceeded", llm_provider="gemini", model=MODEL)


def deployment(dep_id: str, *, api_key: str, model_name: str = "group", **litellm_params: object) -> dict:
    return {
        "model_name": model_name,
        "litellm_params": {"model": MODEL, "api_key": api_key, **litellm_params},
        "model_info": {"id": dep_id},
    }


def failure_kwargs(dep_id: str, *, metadata: dict, exception: Exception) -> dict:
    return {
        "model": "group",
        "exception": exception,
        "litellm_params": {
            "model": MODEL,
            "metadata": {"model_group": "group", **metadata},
            "model_info": {"id": dep_id},
        },
    }


def quota_router(*deployments: dict, quota_max_wait_seconds: float = NEVER_HELD, **settings: object) -> Router:
    """A quota-routed router that, by default, refuses a spent pool instead of waiting on a real window."""
    return Router(
        model_list=list(deployments),
        enable_quota_routing=True,
        quota_max_wait_seconds=quota_max_wait_seconds,
        **settings,
    )


async def selected_id(router: Router, model: str = "group") -> str:
    chosen = await router.async_get_available_deployment(model=model, request_kwargs={})
    return chosen["model_info"]["id"]


async def test_a_spent_credential_is_not_selected_again_in_the_same_window():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=1),
        deployment("d2", api_key="k2", rpm=1),
    )

    assert {await selected_id(router), await selected_id(router)} == {"d1", "d2"}

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_quota_filtering_runs_before_order_so_a_spent_tier_hands_off():
    router = quota_router(
        deployment("primary", api_key="k1", rpm=2, order=1),
        deployment("secondary", api_key="k2", rpm=2, order=2),
    )

    picks = [await selected_id(router) for _ in range(4)]

    assert picks == ["primary", "primary", "secondary", "secondary"], (
        "order must keep a request on one key until that key is spent, then drain the next tier"
    )
    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_quota_routing_is_off_by_default_so_rpm_stays_a_shuffle_weight():
    router = Router(
        model_list=[
            deployment("d1", api_key="k1", rpm=1),
            deployment("d2", api_key="k2", rpm=1),
        ],
    )

    picks = Counter([await selected_id(router) for _ in range(20)])

    assert sum(picks.values()) == 20, "with quota routing off, rpm must not cap anything"
    assert router.quota_enforcer is None


async def test_one_credential_behind_two_model_groups_shares_one_allowance():
    router = quota_router(
        deployment("d1", api_key="shared", model_name="group-a", rpm=2, quota_scope="credential"),
        deployment("d2", api_key="shared", model_name="group-b", rpm=2, quota_scope="credential"),
    )

    assert await selected_id(router, "group-a") == "d1"
    assert await selected_id(router, "group-b") == "d2"

    for model_name in ("group-a", "group-b"):
        with pytest.raises(RouterRateLimitError):
            await selected_id(router, model_name)


async def test_requests_in_flight_together_spend_the_pool_exactly_once():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=2),
        deployment("d2", api_key="k2", rpm=2),
    )

    picks = Counter(await asyncio.gather(*(selected_id(router) for _ in range(4))))

    assert picks == Counter({"d1": 2, "d2": 2}), (
        "four requests over two 2/min keys must fill both keys, not overshoot one and refuse the rest"
    )
    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_a_daily_cap_is_enforced_alongside_the_minute_cap():
    router = quota_router(deployment("d1", api_key="k1", rpm=10, rpd=2))

    assert [await selected_id(router) for _ in range(2)] == ["d1", "d1"]

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_a_strategy_that_selects_through_a_selector_also_reserves():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=1),
        deployment("d2", api_key="k2", rpm=1),
        routing_strategy="least-busy",
    )

    assert {await selected_id(router), await selected_id(router)} == {"d1", "d2"}

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_a_deployment_without_limits_absorbs_the_overflow():
    router = quota_router(
        deployment("capped", api_key="k1", rpm=1, order=1),
        deployment("uncapped", api_key="k2", order=2),
    )

    picks = [await selected_id(router) for _ in range(4)]

    assert picks == ["capped", "uncapped", "uncapped", "uncapped"]


async def test_spent_credentials_are_healthy_so_they_are_never_cooled_down():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=1),
        deployment("d2", api_key="k2", rpm=1),
        cooldown_time=600,
    )

    assert {await selected_id(router), await selected_id(router)} == {"d1", "d2"}
    with pytest.raises(RouterRateLimitError):
        await selected_id(router)

    assert await _async_get_cooldown_deployments(litellm_router_instance=router, parent_otel_span=None) == [], (
        "a key at its per-minute cap comes back when the window rolls, so cooling it down would hold it out for "
        "cooldown_time and would drag the rest of the credential's deployments down with it"
    )


async def test_the_retry_after_names_the_quota_window_not_an_unrelated_cooldown():
    router = quota_router(deployment("d1", api_key="k1", rpm=1), cooldown_time=600)

    assert await selected_id(router) == "d1"

    with pytest.raises(RouterRateLimitError) as raised:
        await selected_id(router)

    assert 0 < raised.value.cooldown_time <= 60, (
        "the caller must be told the second the window rolls over, not a cooldown that says nothing about quota"
    )


async def test_a_clients_own_timeout_caps_how_long_a_spent_pool_is_held():
    router = quota_router(deployment("d1", api_key="k1", rpm=1), quota_max_wait_seconds=75)
    impatient_client = {"timeout": 0.01}

    assert await router.async_get_available_deployment(model="group", request_kwargs=impatient_client) is not None

    started = time.monotonic()
    with pytest.raises(RouterRateLimitError):
        await router.async_get_available_deployment(model="group", request_kwargs=impatient_client)

    assert time.monotonic() - started < 1, (
        "a caller that gives up in 10ms must not be held for the minute window to roll over"
    )


async def test_a_call_that_never_reached_the_provider_gives_its_slot_back():
    router = quota_router(deployment("d1", api_key="k1", rpd=1))
    request_metadata: dict = {}

    await router.async_get_available_deployment(model="group", request_kwargs={"metadata": request_metadata})
    with pytest.raises(RouterRateLimitError):
        await selected_id(router)

    await router.async_deployment_callback_on_failure(
        kwargs=failure_kwargs("d1", metadata=request_metadata, exception=NEVER_LANDED),
        completion_response=None,
        start_time=None,
        end_time=None,
    )

    assert await selected_id(router) == "d1", "a day slot the provider never counted must come back to the pool"


async def test_a_provider_rate_limit_leaves_the_slot_spent():
    router = quota_router(deployment("d1", api_key="k1", rpd=1))
    request_metadata: dict = {}

    await router.async_get_available_deployment(model="group", request_kwargs={"metadata": request_metadata})
    await router.async_deployment_callback_on_failure(
        kwargs=failure_kwargs("d1", metadata=request_metadata, exception=PROVIDER_429),
        completion_response=None,
        start_time=None,
        end_time=None,
    )

    with pytest.raises(RouterRateLimitError, match="No deployments available"):
        await selected_id(router)


async def test_a_failure_with_no_reservation_marker_refunds_nothing():
    router = quota_router(deployment("d1", api_key="k1", rpd=1))

    assert await selected_id(router) == "d1"
    await router.async_deployment_callback_on_failure(
        kwargs=failure_kwargs("d1", metadata={}, exception=NEVER_LANDED),
        completion_response=None,
        start_time=None,
        end_time=None,
    )

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)
