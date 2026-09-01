"""
Tests for per-credential quota routing (router_settings.enable_quota_routing).

When enabled, `rpm` / `rpd` on a deployment become hard caps rather than shuffle
weights: a credential with nothing left in the current window is dropped before
routing picks a deployment, and the winner's slot is reserved before the request
goes out.
"""

import asyncio
from collections import Counter

import pytest

from litellm import Router
from litellm.router_utils.cooldown_handlers import _async_get_cooldown_deployments
from litellm.types.router import RouterRateLimitError

MODEL = "gemini/gemini-2.5-flash"


def deployment(dep_id: str, *, api_key: str, model_name: str = "group", **litellm_params: object) -> dict:
    return {
        "model_name": model_name,
        "litellm_params": {"model": MODEL, "api_key": api_key, **litellm_params},
        "model_info": {"id": dep_id},
    }


async def selected_id(router: Router, model: str = "group") -> str:
    chosen = await router.async_get_available_deployment(model=model, request_kwargs={})
    return chosen["model_info"]["id"]


async def test_a_spent_credential_is_not_selected_again_in_the_same_window():
    router = Router(
        model_list=[
            deployment("d1", api_key="k1", rpm=1),
            deployment("d2", api_key="k2", rpm=1),
        ],
        enable_quota_routing=True,
    )

    assert {await selected_id(router), await selected_id(router)} == {"d1", "d2"}

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_quota_filtering_runs_before_order_so_a_spent_tier_hands_off():
    router = Router(
        model_list=[
            deployment("primary", api_key="k1", rpm=2, order=1),
            deployment("secondary", api_key="k2", rpm=2, order=2),
        ],
        enable_quota_routing=True,
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
    router = Router(
        model_list=[
            deployment("d1", api_key="shared", model_name="group-a", rpm=2, quota_scope="credential"),
            deployment("d2", api_key="shared", model_name="group-b", rpm=2, quota_scope="credential"),
        ],
        enable_quota_routing=True,
    )

    assert await selected_id(router, "group-a") == "d1"
    assert await selected_id(router, "group-b") == "d2"

    for model_name in ("group-a", "group-b"):
        with pytest.raises(RouterRateLimitError):
            await selected_id(router, model_name)


async def test_requests_in_flight_together_spend_the_pool_exactly_once():
    router = Router(
        model_list=[
            deployment("d1", api_key="k1", rpm=2),
            deployment("d2", api_key="k2", rpm=2),
        ],
        enable_quota_routing=True,
    )

    picks = Counter(await asyncio.gather(*(selected_id(router) for _ in range(4))))

    assert picks == Counter({"d1": 2, "d2": 2}), (
        "four requests over two 2/min keys must fill both keys, not overshoot one and refuse the rest"
    )
    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_a_daily_cap_is_enforced_alongside_the_minute_cap():
    router = Router(
        model_list=[deployment("d1", api_key="k1", rpm=10, rpd=2)],
        enable_quota_routing=True,
    )

    assert [await selected_id(router) for _ in range(2)] == ["d1", "d1"]

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_a_strategy_that_selects_through_a_selector_also_reserves():
    router = Router(
        model_list=[
            deployment("d1", api_key="k1", rpm=1),
            deployment("d2", api_key="k2", rpm=1),
        ],
        routing_strategy="least-busy",
        enable_quota_routing=True,
    )

    assert {await selected_id(router), await selected_id(router)} == {"d1", "d2"}

    with pytest.raises(RouterRateLimitError):
        await selected_id(router)


async def test_a_deployment_without_limits_absorbs_the_overflow():
    router = Router(
        model_list=[
            deployment("capped", api_key="k1", rpm=1, order=1),
            deployment("uncapped", api_key="k2", order=2),
        ],
        enable_quota_routing=True,
    )

    picks = [await selected_id(router) for _ in range(4)]

    assert picks == ["capped", "uncapped", "uncapped", "uncapped"]


async def test_spent_credentials_are_healthy_so_they_are_never_cooled_down():
    router = Router(
        model_list=[
            deployment("d1", api_key="k1", rpm=1),
            deployment("d2", api_key="k2", rpm=1),
        ],
        enable_quota_routing=True,
        cooldown_time=600,
    )

    assert {await selected_id(router), await selected_id(router)} == {"d1", "d2"}
    with pytest.raises(RouterRateLimitError):
        await selected_id(router)

    assert await _async_get_cooldown_deployments(litellm_router_instance=router, parent_otel_span=None) == [], (
        "a key at its per-minute cap comes back when the window rolls, so cooling it down would hold it out for "
        "cooldown_time and would drag the rest of the credential's deployments down with it"
    )
