import datetime as dt

import pytest
from fastapi import HTTPException

from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.management_endpoints.model_quota_endpoints import (
    derive_quota_usage,
    get_model_quota_usage,
    quota_usage_of,
)
from litellm.router import Router
from litellm.router_utils.quota.enforcement import DeploymentQuotaUsage, WindowUsage

SECRET = "sk-model-quota-visibility"


def deployment(dep_id: str, *, model_name: str = "group", model: str = "gemini/gemini-3.7-flash", **params) -> dict:
    return {
        "model_name": model_name,
        "litellm_params": {"model": model, "api_key": SECRET, **params},
        "model_info": {"id": dep_id},
    }


def minute(*, limit: int, used: int, resets_in: int = 30) -> WindowUsage:
    return WindowUsage(kind="rpm", limit=limit, used=used, timezone_name="UTC", seconds_until_reset=resets_in)


def day(*, limit: int, used: int, resets_in: int = 3600, timezone_name: str = "UTC") -> WindowUsage:
    return WindowUsage(kind="rpd", limit=limit, used=used, timezone_name=timezone_name, seconds_until_reset=resets_in)


def usage(dep_id: str | None, *windows: WindowUsage) -> DeploymentQuotaUsage:
    return DeploymentQuotaUsage(deployment_id=dep_id, windows=windows)


def test_every_key_behind_one_model_name_is_one_pool():
    reported = derive_quota_usage(
        deployments=[deployment("d1"), deployment("d2", api_key="sk-second")],
        usage=[usage("d1", minute(limit=5, used=1)), usage("d2", minute(limit=5, used=4))],
        enforced=True,
    )

    (pool,) = reported.pools
    assert pool.model_name == "group"
    assert tuple(key.model_id for key in pool.keys) == ("d1", "d2")
    assert tuple(key.windows[0].used for key in pool.keys) == (1, 4)


def test_two_model_names_are_two_pools():
    reported = derive_quota_usage(
        deployments=[deployment("d1", model_name="fast"), deployment("d2", model_name="smart")],
        usage=[usage("d1", minute(limit=5, used=0)), usage("d2", minute(limit=5, used=0))],
        enforced=True,
    )

    assert tuple(pool.model_name for pool in reported.pools) == ("fast", "smart")


def test_a_pool_is_spent_only_once_every_key_in_it_is():
    with_room = derive_quota_usage(
        deployments=[deployment("d1"), deployment("d2")],
        usage=[usage("d1", minute(limit=1, used=1)), usage("d2", minute(limit=5, used=2))],
        enforced=True,
    )
    fully_spent = derive_quota_usage(
        deployments=[deployment("d1"), deployment("d2")],
        usage=[usage("d1", minute(limit=1, used=1)), usage("d2", minute(limit=5, used=5))],
        enforced=True,
    )

    assert with_room.pools[0].exhausted is False, "one spent key out of two is the rotation working, not a failure"
    assert fully_spent.pools[0].exhausted is True


def test_a_spent_pool_reports_the_soonest_key_to_free_up():
    reported = derive_quota_usage(
        deployments=[deployment("d1"), deployment("d2")],
        usage=[
            usage("d1", day(limit=1, used=1, resets_in=3600)),
            usage("d2", minute(limit=1, used=1, resets_in=12)),
        ],
        enforced=True,
    )

    assert reported.pools[0].seconds_until_room == 12


def test_a_pool_with_room_left_reports_no_wait():
    reported = derive_quota_usage(
        deployments=[deployment("d1"), deployment("d2")],
        usage=[usage("d1", minute(limit=1, used=1)), usage("d2", minute(limit=5, used=0))],
        enforced=True,
    )

    assert reported.pools[0].seconds_until_room is None, (
        "a wait is only honest for a pool with nothing left; here the next request goes to the other key"
    )
    assert reported.pools[0].keys[0].seconds_until_room == 30, "the spent key still reports its own boundary"


def test_a_key_with_no_cap_keeps_the_pool_alive():
    reported = derive_quota_usage(
        deployments=[deployment("d1"), deployment("d2")],
        usage=[usage("d1", minute(limit=1, used=1)), usage("d2")],
        enforced=True,
    )

    assert reported.pools[0].exhausted is False, "an unmetered key is the overflow a spent pool spills into"
    assert reported.pools[0].keys[1].windows == ()


def test_a_key_is_identified_by_its_deployment_and_base_url():
    reported = derive_quota_usage(
        deployments=[deployment("d1", model="gemini/gemini-3.1-pro-preview", api_base="https://example.test/v1")],
        usage=[usage("d1", minute(limit=5, used=0))],
        enforced=True,
    )

    key = reported.pools[0].keys[0]
    assert (key.model_id, key.litellm_model, key.api_base) == (
        "d1",
        "gemini/gemini-3.1-pro-preview",
        "https://example.test/v1",
    )


def test_a_day_window_reports_the_zone_its_boundary_is_counted_in():
    reported = derive_quota_usage(
        deployments=[deployment("d1", quota_reset_timezone="America/Los_Angeles")],
        usage=[usage("d1", day(limit=100, used=90, resets_in=7200, timezone_name="America/Los_Angeles"))],
        enforced=True,
    )

    window = reported.pools[0].keys[0].windows[0]
    assert (window.kind, window.timezone, window.remaining, window.seconds_until_reset) == (
        "rpd",
        "America/Los_Angeles",
        10,
        7200,
    )


def test_a_deployment_without_an_id_is_left_out():
    nameless = deployment("d2") | {"model_info": {}}

    reported = derive_quota_usage(
        deployments=[deployment("d1"), nameless],
        usage=[usage("d1", minute(limit=5, used=0)), usage(None, minute(limit=5, used=0))],
        enforced=True,
    )

    assert tuple(key.model_id for key in reported.pools[0].keys) == ("d1",), (
        "a key with no id cannot be acted on, so reporting it as a pool member would mislead"
    )


def test_the_response_carries_neither_the_key_nor_a_digest_of_it():
    dumped = derive_quota_usage(
        deployments=[deployment("d1", quota_scope_id="account-42")],
        usage=[usage("d1", minute(limit=5, used=2))],
        enforced=True,
    ).model_dump_json()

    assert SECRET not in dumped
    assert "account-42" not in dumped, "a scope id names the account a key spends from, so it stays internal"


async def test_a_router_with_quota_routing_reports_what_a_request_spent():
    live = Router(model_list=[deployment("d1", rpm=5)], enable_quota_routing=True)
    assert live.quota_enforcer is not None
    assert await live.quota_enforcer.reserve_first_available(live.model_list[0], live.model_list) is not None

    reported = await quota_usage_of(live)

    assert reported.enforced is True
    window = reported.pools[0].keys[0].windows[0]
    assert (window.used, window.remaining) == (1, 4), "this must read the counters routing itself writes"


async def test_a_router_without_quota_routing_still_reports_its_configured_caps():
    live = Router(model_list=[deployment("d1", rpm=5, rpd=100)])

    reported = await quota_usage_of(live)

    assert reported.enforced is False, "nothing counts against these caps, and the answer has to say so"
    assert tuple((window.kind, window.limit, window.used) for window in reported.pools[0].keys[0].windows) == (
        ("rpm", 5, 0),
        ("rpd", 100, 0),
    )


async def test_a_day_boundary_is_reported_from_the_configured_zone():
    live = Router(
        model_list=[deployment("d1", rpd=100, quota_reset_timezone="America/Los_Angeles")],
        enable_quota_routing=True,
    )

    reported = await quota_usage_of(live)

    window = reported.pools[0].keys[0].windows[0]
    assert window.timezone == "America/Los_Angeles"
    assert 0 < window.seconds_until_reset <= dt.timedelta(days=1).total_seconds()


async def test_reading_quota_usage_is_denied_to_a_role_without_the_admin_view():
    with pytest.raises(HTTPException) as denied:
        await get_model_quota_usage(user_api_key_dict=UserAPIKeyAuth(user_role=LitellmUserRoles.INTERNAL_USER))

    assert denied.value.status_code == 403
