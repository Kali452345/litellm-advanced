"""
Tests for per-credential quota routing (router_settings.enable_quota_routing).

When enabled, `rpm` / `rpd` on a deployment become hard caps rather than shuffle
weights: a credential with nothing left in the current window is dropped before
routing picks a deployment, the surviving pool is walked fullest credential
first so a conversation keeps landing on the same key, the winner's slot is
reserved before the request goes out, and a key that errors hands the request to
the next key inside the same call rather than back to the caller.
"""

import asyncio
import time
from collections import Counter

import pytest

import litellm
from litellm import Router
from litellm.exceptions import APIConnectionError, RateLimitError
from litellm.integrations.custom_logger import CustomLogger
from litellm.router_utils.cooldown_handlers import _async_get_cooldown_deployments
from litellm.router_utils.quota import ATTEMPTED_DEPLOYMENT_IDS_KEY
from litellm.types.router import RouterRateLimitError

MODEL = "gemini/gemini-2.5-flash"
OTHER_PROVIDER = "openai/gpt-4o-mini"
NEVER_HELD = 0.0
NEVER_LANDED = APIConnectionError(message="connection refused", llm_provider="gemini", model=MODEL)
PROVIDER_429 = RateLimitError(message="quota exceeded", llm_provider="gemini", model=MODEL)


class PinsToTheFirstCandidate(CustomLogger):
    """Stands in for the affinity and prompt-caching filters, which narrow the group to one deployment."""

    def __init__(self) -> None:
        super().__init__()
        self.offered: list[tuple[str, ...]] = []

    async def async_filter_deployments(
        self,
        model: str,
        healthy_deployments: list,
        messages: list | None,
        request_kwargs: dict | None = None,
        parent_otel_span: object | None = None,
    ) -> list[dict]:
        self.offered.append(tuple(candidate["model_info"]["id"] for candidate in healthy_deployments))
        return healthy_deployments[:1]


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


async def selected_id(router: Router, model: str = "group", *, request_kwargs: dict | None = None) -> str:
    """
    The deployment one request lands on.

    Hand several calls the same `request_kwargs` to walk them as one request, the way
    a retry inside `acompletion` does; the default is a fresh request every time.
    """
    chosen = await router.async_get_available_deployment(model=model, request_kwargs=request_kwargs or {})
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


async def test_a_pool_is_drained_one_credential_at_a_time_rather_than_shuffled():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=5),
        deployment("d2", api_key="k2", rpm=5),
        deployment("d3", api_key="k3", rpm=5),
    )

    picks = [await selected_id(router) for _ in range(12)]

    assert picks == ["d1"] * 5 + ["d2"] * 5 + ["d3"] * 2, (
        "a conversation only hits the provider's prompt cache while it keeps landing on the same "
        "key, so the pool drains one credential before it touches the next"
    )


async def test_a_pin_on_the_first_candidate_is_never_offered_a_spent_credential(monkeypatch: pytest.MonkeyPatch):
    pin = PinsToTheFirstCandidate()
    monkeypatch.setattr(litellm, "callbacks", [pin])
    router = quota_router(
        deployment("d1", api_key="k1", rpm=1),
        deployment("d2", api_key="k2", rpm=1),
    )

    assert await selected_id(router) == "d1"
    assert await selected_id(router) == "d2", (
        "a filter that narrows the group to one deployment has to be handed the keys that still "
        "have room, or it pins the spent one and the quota filter then empties the group"
    )

    assert pin.offered == [("d1", "d2"), ("d2",)]
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


async def test_a_failed_key_hands_the_request_to_the_next_key_in_the_same_call():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=5, mock_response=Exception("d1 is down")),
        deployment("d2", api_key="k2", rpm=5, mock_response="served by d2"),
    )

    response = await router.acompletion(model="group", messages=[{"role": "user", "content": "hi"}])

    assert response._hidden_params["model_id"] == "d2", (
        "the retry has to land on a key this request has not burned; ranking the pool fullest first "
        "otherwise hands the just failed key straight back, and a 500 does not cool it down"
    )
    assert response.choices[0].message.content == "served by d2", "the caller must never see the failure"


async def test_the_walk_crosses_providers_and_never_repeats_a_key_it_burned():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=5, mock_response=Exception("d1 is down")),
        deployment("d2", api_key="k2", rpm=5, mock_response=Exception("d2 is down")),
        deployment("d3", api_key="k3", model=OTHER_PROVIDER, rpm=5, mock_response="served by d3"),
    )

    response = await router.acompletion(model="group", messages=[{"role": "user", "content": "hi"}])

    assert response._hidden_params["model_id"] == "d3", (
        "every key the request already tried has to stay excluded, not just the last one, and the "
        "walk carries on into the next provider in the group"
    )


async def test_a_pool_that_has_been_fully_tried_surfaces_the_providers_error():
    router = quota_router(
        deployment("d1", api_key="k1", rpm=5, mock_response=Exception("d1 is down")),
        deployment("d2", api_key="k2", rpm=5, mock_response=Exception("d2 is down")),
    )

    with pytest.raises(litellm.InternalServerError):
        await router.acompletion(model="group", messages=[{"role": "user", "content": "hi"}])


async def test_the_retry_is_never_handed_a_key_whose_window_is_spent():
    router = quota_router(
        deployment("capped", api_key="k1", rpm=1),
        deployment("uncapped", api_key="k2"),
    )
    one_request: dict = {"metadata": {}}

    picks = [await selected_id(router, request_kwargs=one_request) for _ in range(3)]

    assert picks == ["capped", "uncapped", "uncapped"], (
        "already tried is soft so a request whose whole pool is tried still goes out, but a spent "
        "window stays a hard cap, so the third attempt must not fall back onto the capped key"
    )


async def test_a_pin_is_never_offered_the_key_the_request_just_failed_on(monkeypatch: pytest.MonkeyPatch):
    pin = PinsToTheFirstCandidate()
    monkeypatch.setattr(litellm, "callbacks", [pin])
    router = quota_router(
        deployment("d1", api_key="k1", rpm=5),
        deployment("d2", api_key="k2", rpm=5),
    )
    one_request: dict = {"metadata": {}}

    assert await selected_id(router, request_kwargs=one_request) == "d1"
    assert await selected_id(router, request_kwargs=one_request) == "d2", (
        "a filter that narrows the group to one deployment has to be handed the untried keys, or it "
        "pins the key that just failed and the retry repeats it"
    )

    assert pin.offered == [("d1", "d2"), ("d2",)]


async def test_the_same_request_filter_stays_out_of_a_router_that_is_not_quota_routed():
    router = Router(
        model_list=[
            deployment("d1", api_key="k1", order=1),
            deployment("d2", api_key="k2", order=2),
        ],
    )
    already_failed_over: dict = {"metadata": {ATTEMPTED_DEPLOYMENT_IDS_KEY: ["d1"]}}

    assert await selected_id(router, request_kwargs=already_failed_over) == "d1", (
        "weighted failover enforces its own exclusions hard, further down the pipeline, so softening "
        "them here would let its retry re-pick the deployment it just excluded"
    )
