import asyncio
import datetime as dt
import logging

import pytest

from litellm.caching.dual_cache import DualCache
from litellm.router_utils.quota.counter import AtomicWindowCounter
from litellm.router_utils.quota.enforcement import (
    NOTHING_SPENT,
    QuotaEnforcer,
    QuotaRoutingSettings,
    warn_on_unenforced_quotas,
)

NOW = dt.datetime(2026, 9, 1, 14, 32, 30, tzinfo=dt.timezone.utc)
LOS_ANGELES = "America/Los_Angeles"
ROUTER_LOGGER = "LiteLLM Router"
SECONDS_TO_NEXT_MINUTE = 30
SECONDS_TO_NEXT_UTC_DAY = 34050


class Clock:
    """A clock the enforcer reads through, so a test can move time without patching."""

    def __init__(self, now: dt.datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> dt.datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += dt.timedelta(**delta)


class FakeSleep:
    """A sleep that moves the clock instead of the wall, and records what it was asked to wait."""

    def __init__(self, clock: Clock, *, moves_clock: bool = True) -> None:
        self.clock = clock
        self.moves_clock = moves_clock
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)
        if self.moves_clock:
            self.clock.advance(seconds=seconds)


def deployment(
    dep_id: str,
    *,
    api_key: str = "sk-quota-enforcement",
    model: str = "gemini/gemini-2.5-flash",
    rpm: int | None = None,
    rpd: int | None = None,
    top_level_rpm: int | None = None,
    model_info_rpm: int | None = None,
    **litellm_params: object,
) -> dict:
    params: dict = {"model": model, "api_key": api_key, **litellm_params}
    if rpm is not None:
        params["rpm"] = rpm
    if rpd is not None:
        params["rpd"] = rpd
    return {
        "model_name": "group",
        "litellm_params": params,
        "model_info": {"id": dep_id} | ({} if model_info_rpm is None else {"rpm": model_info_rpm}),
        **({} if top_level_rpm is None else {"rpm": top_level_rpm}),
    }


def enforcer(clock: Clock | None = None, **kwargs: object) -> QuotaEnforcer:
    return QuotaEnforcer(AtomicWindowCounter(DualCache()), clock=clock or Clock(), **kwargs)


async def exhausted(subject: QuotaEnforcer, pool: list[dict]) -> frozenset[str]:
    return (await subject.availability(pool)).exhausted_deployment_ids


async def ranked(subject: QuotaEnforcer, pool: list[dict]) -> tuple[str, ...]:
    return tuple(str(candidate["model_info"]["id"]) for candidate in await subject.most_spent_first(pool))


async def spend(subject: QuotaEnforcer, target: dict, times: int) -> None:
    for _ in range(times):
        assert await subject.reserve_first_available(target, [target]) is target


def quota_records(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [record.getMessage() for record in caplog.records if record.name == ROUTER_LOGGER]


async def test_a_deployment_without_limits_is_never_exhausted():
    subject = enforcer()
    pool = [deployment("d1")]

    for _ in range(5):
        assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    assert await exhausted(subject, pool) == frozenset()


async def test_a_deployment_is_reported_exhausted_only_once_its_limit_is_reached():
    subject = enforcer()
    pool = [deployment("d1", rpm=2)]

    assert await exhausted(subject, pool) == frozenset()
    await subject.reserve_first_available(pool[0], pool)
    assert await exhausted(subject, pool) == frozenset(), "one of two requests spent is not exhausted"
    await subject.reserve_first_available(pool[0], pool)
    assert await exhausted(subject, pool) == {"d1"}


async def test_reservation_falls_forward_to_the_next_candidate():
    subject = enforcer()
    pool = [deployment("d1", api_key="k1", rpm=1), deployment("d2", api_key="k2", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[0], pool) is pool[1]
    assert await subject.reserve_first_available(pool[0], pool) is None


async def test_the_selected_candidate_is_charged_whatever_its_position():
    subject = enforcer()
    pool = [deployment("d1", api_key="k1", rpm=1), deployment("d2", api_key="k2", rpm=1)]

    assert await subject.reserve_first_available(pool[1], pool) is pool[1]

    assert await exhausted(subject, pool) == {"d2"}, (
        "the reservation must land on the deployment selection chose, not on the first candidate"
    )


async def test_falling_forward_charges_the_next_candidate_exactly_once():
    subject = enforcer()
    spent, fresh = deployment("d1", api_key="k1", rpm=1), deployment("d2", api_key="k2", rpm=2)
    pool = [spent, fresh]

    await subject.reserve_first_available(spent, pool)
    assert await subject.reserve_first_available(spent, pool) is fresh

    assert await subject.reserve_first_available(spent, pool) is fresh, (
        "the blocked candidate must not charge the one it fell forward to more than once"
    )
    assert await subject.reserve_first_available(spent, pool) is None


async def test_concurrent_reservations_never_exceed_the_pool_allowance():
    subject = enforcer()
    pool = [deployment("d1", api_key="k1", rpm=3), deployment("d2", api_key="k2", rpm=3)]

    results = await asyncio.gather(*(subject.reserve_first_available(pool[0], pool) for _ in range(10)))

    granted = [result for result in results if result is not None]
    assert len(granted) == 6
    assert sum(1 for result in granted if result is pool[0]) == 3
    assert sum(1 for result in granted if result is pool[1]) == 3


async def test_one_credential_serving_two_models_shares_one_allowance():
    subject = enforcer()
    pool = [
        deployment("d1", api_key="shared", model="gemini/gemini-2.5-flash", rpm=1, quota_scope="credential"),
        deployment("d2", api_key="shared", model="gemini/gemini-2.5-pro", rpm=1, quota_scope="credential"),
    ]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    assert await subject.reserve_first_available(pool[1], pool) is None, (
        "quota_scope='credential' must meter the key once, not once per model"
    )
    assert await exhausted(subject, pool) == {"d1", "d2"}


async def test_the_default_scope_meters_each_model_of_a_credential_separately():
    subject = enforcer()
    pool = [
        deployment("d1", api_key="shared", model="gemini/gemini-2.5-flash", rpm=1),
        deployment("d2", api_key="shared", model="gemini/gemini-2.5-pro", rpm=1),
    ]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[1], pool) is pool[1]
    assert await exhausted(subject, pool) == {"d1", "d2"}


async def test_two_deployments_of_one_credential_and_model_share_one_allowance():
    subject = enforcer()
    pool = [deployment("d1", api_key="shared", rpm=2), deployment("d2", api_key="shared", rpm=2)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[1], pool) is pool[1]

    assert await subject.reserve_first_available(pool[0], pool) is None, (
        "counters key on the credential, so a second deployment of the same key must not double the cap"
    )


async def test_a_minute_cap_resets_when_the_minute_rolls_over():
    clock = Clock()
    subject = enforcer(clock)
    pool = [deployment("d1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[0], pool) is None

    clock.advance(minutes=1)

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]


async def test_a_daily_cap_holds_across_minutes():
    clock = Clock()
    subject = enforcer(clock)
    pool = [deployment("d1", rpd=2)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    clock.advance(hours=3)
    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    assert await subject.reserve_first_available(pool[0], pool) is None, "a new minute must not refill the day"
    assert await exhausted(subject, pool) == {"d1"}


async def test_a_daily_cap_resets_on_the_configured_zone_s_day_boundary():
    clock = Clock(dt.datetime(2026, 9, 1, 6, 0, tzinfo=dt.timezone.utc))
    subject = enforcer(clock)
    pool = [deployment("d1", rpd=1, quota_reset_timezone=LOS_ANGELES)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[0], pool) is None

    clock.advance(hours=2)

    assert await subject.reserve_first_available(pool[0], pool) is pool[0], (
        "23:00 and 01:00 in the configured zone are different days, even inside one UTC day"
    )


async def test_an_unloadable_timezone_still_enforces_the_daily_cap(caplog: pytest.LogCaptureFixture):
    subject = enforcer()
    pool = [deployment("d1", rpd=1, quota_reset_timezone="Mars/Olympus_Mons")]

    with caplog.at_level(logging.ERROR, logger=ROUTER_LOGGER):
        assert await subject.reserve_first_available(pool[0], pool) is pool[0]
        assert await subject.reserve_first_available(pool[0], pool) is None

    assert any("Mars/Olympus_Mons" in message for message in quota_records(caplog))


@pytest.mark.parametrize(
    ("limits", "expected_reservations"),
    [
        ({"top_level_rpm": 1, "rpm": 5, "model_info_rpm": 9}, 1),
        ({"rpm": 2, "model_info_rpm": 9}, 2),
        ({"model_info_rpm": 3}, 3),
    ],
)
async def test_the_highest_precedence_limit_that_is_set_wins(limits: dict, expected_reservations: int):
    subject = enforcer()
    pool = [deployment("d1", **limits)]

    granted = 0
    while await subject.reserve_first_available(pool[0], pool) is not None:
        granted += 1
        assert granted <= 12, "the configured limit was not enforced at all"

    assert granted == expected_reservations


async def test_an_unreadable_limit_fails_open(caplog: pytest.LogCaptureFixture):
    subject = enforcer()
    pool = [
        {
            "model_name": "group",
            "litellm_params": {"model": "gemini/gemini-2.5-flash", "api_key": "k1", "rpm": "not-a-number"},
            "model_info": {"id": "d1"},
        }
    ]

    with caplog.at_level(logging.ERROR, logger=ROUTER_LOGGER):
        for _ in range(3):
            assert await subject.reserve_first_available(pool[0], pool) is pool[0]
        assert await exhausted(subject, pool) == frozenset()

    assert any("unreadable field(s)" in message for message in quota_records(caplog))


async def test_a_validation_failure_never_logs_the_offending_value(caplog: pytest.LogCaptureFixture):
    subject = enforcer()
    pool = [
        {
            "model_name": "group",
            "litellm_params": {"model": "gemini/gemini-2.5-flash", "api_key": "sk-must-not-be-logged", "rpm": 2.5},
            "model_info": {"id": "d1"},
        }
    ]

    with caplog.at_level(logging.ERROR, logger=ROUTER_LOGGER):
        await exhausted(subject, pool)

    logged = " ".join(quota_records(caplog))
    assert "sk-must-not-be-logged" not in logged
    assert "2.5" not in logged


async def test_a_counter_key_is_never_logged_when_a_reservation_is_blocked(caplog: pytest.LogCaptureFixture):
    subject = enforcer()
    pool = [deployment("d1", api_key="k1", rpm=1), deployment("d2", api_key="k2", rpm=1)]

    with caplog.at_level(logging.DEBUG, logger=ROUTER_LOGGER):
        await subject.reserve_first_available(pool[0], pool)
        assert await subject.reserve_first_available(pool[0], pool) is pool[1]

    logged = " ".join(quota_records(caplog))
    assert "litellm_quota:" not in logged, "a counter key identifies a credential, so it must stay out of the logs"


def test_declared_quota_params_warn_when_quota_routing_is_off(caplog: pytest.LogCaptureFixture):
    with caplog.at_level(logging.WARNING, logger=ROUTER_LOGGER):
        warn_on_unenforced_quotas(
            model_list=[deployment("d1", rpd=100)],
            routing_strategy="simple-shuffle",
            enable_quota_routing=False,
        )

    assert any("enable_quota_routing=False" in message for message in quota_records(caplog))


def test_a_plain_rpm_weight_does_not_warn_when_quota_routing_is_off(caplog: pytest.LogCaptureFixture):
    with caplog.at_level(logging.WARNING, logger=ROUTER_LOGGER):
        warn_on_unenforced_quotas(
            model_list=[deployment("d1", rpm=100)],
            routing_strategy="simple-shuffle",
            enable_quota_routing=False,
        )

    assert quota_records(caplog) == [], "rpm alone is the long-standing shuffle weight, so it must not warn"


@pytest.mark.parametrize("strategy", ["usage-based-routing", "lar1"])
def test_a_strategy_that_selects_on_the_sync_path_warns(strategy: str, caplog: pytest.LogCaptureFixture):
    with caplog.at_level(logging.WARNING, logger=ROUTER_LOGGER):
        warn_on_unenforced_quotas(
            model_list=[deployment("d1", rpm=5)],
            routing_strategy=strategy,
            enable_quota_routing=True,
        )

    assert any(strategy in message for message in quota_records(caplog))


@pytest.mark.parametrize("strategy", ["simple-shuffle", "usage-based-routing-v2", "latency-based-routing"])
def test_a_supported_strategy_does_not_warn(strategy: str, caplog: pytest.LogCaptureFixture):
    with caplog.at_level(logging.WARNING, logger=ROUTER_LOGGER):
        warn_on_unenforced_quotas(
            model_list=[deployment("d1", rpm=5, rpd=50)],
            routing_strategy=strategy,
            enable_quota_routing=True,
        )

    assert quota_records(caplog) == []


async def test_a_pool_that_is_out_for_seconds_is_waited_out():
    clock = Clock()
    sleeping = FakeSleep(clock)
    subject = enforcer(clock, sleep=sleeping)
    pool = [deployment("d1", api_key="k1", rpm=1), deployment("d2", api_key="k2", rpm=1)]

    for _ in range(2):
        assert await subject.reserve_first_available(pool[0], pool) is not None

    held = await subject.wait_for_capacity(pool)

    assert sleeping.waits == [pytest.approx(SECONDS_TO_NEXT_MINUTE, abs=1)], (
        "a fully spent pool whose minute rolls over in seconds must wait for it, not fail the request"
    )
    assert held.exhausted_deployment_ids == frozenset()
    assert held.seconds_until_reset is None


async def test_a_pool_with_room_left_is_never_waited_out():
    clock = Clock()
    sleeping = FakeSleep(clock)
    subject = enforcer(clock, sleep=sleeping)
    pool = [deployment("d1", api_key="k1", rpm=1), deployment("d2", api_key="k2", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    availability = await subject.wait_for_capacity(pool)

    assert sleeping.waits == []
    assert availability.exhausted_deployment_ids == {"d1"}
    assert availability.seconds_until_reset is None, "one spent key out of two is nothing to wait for"


async def test_a_day_cap_is_reported_rather_than_waited_out():
    clock = Clock()
    sleeping = FakeSleep(clock)
    subject = enforcer(clock, sleep=sleeping)
    pool = [deployment("d1", rpd=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    availability = await subject.wait_for_capacity(pool)

    assert sleeping.waits == [], "no request may be held for hours waiting on a day boundary"
    assert availability.exhausted_deployment_ids == {"d1"}
    assert availability.seconds_until_reset == SECONDS_TO_NEXT_UTC_DAY


async def test_the_caller_s_own_deadline_caps_the_hold():
    clock = Clock()
    sleeping = FakeSleep(clock)
    subject = enforcer(clock, sleep=sleeping)
    pool = [deployment("d1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    availability = await subject.wait_for_capacity(pool, max_wait_seconds=5)

    assert sleeping.waits == [], "holding 30s for a caller who times out in 5 only wastes the wait"
    assert availability.seconds_until_reset == SECONDS_TO_NEXT_MINUTE


async def test_the_configured_ceiling_caps_the_hold():
    clock = Clock()
    sleeping = FakeSleep(clock)
    subject = enforcer(clock, sleep=sleeping, max_wait_seconds=5)
    pool = [deployment("d1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    availability = await subject.wait_for_capacity(pool)

    assert sleeping.waits == []
    assert availability.seconds_until_reset == SECONDS_TO_NEXT_MINUTE


async def test_capacity_that_never_arrives_is_reported_after_one_hold():
    clock = Clock()
    sleeping = FakeSleep(clock, moves_clock=False)
    subject = enforcer(clock, sleep=sleeping)
    pool = [deployment("d1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    availability = await subject.wait_for_capacity(pool)

    assert len(sleeping.waits) == 1, "one hold per request, so a stuck window cannot pin a request forever"
    assert availability.exhausted_deployment_ids == {"d1"}
    assert availability.seconds_until_reset == SECONDS_TO_NEXT_MINUTE


async def test_the_fullest_credential_is_offered_first():
    subject = enforcer()
    pool = [deployment("d1", api_key="k1", rpm=5), deployment("d2", api_key="k2", rpm=5)]

    await spend(subject, pool[1], 3)

    assert await ranked(subject, pool) == ("d2", "d1"), (
        "a pool has to drain one credential before it moves on, or the provider's prompt cache "
        "cold-misses on every request"
    )


async def test_a_credential_with_no_quota_is_the_last_resort():
    subject = enforcer()
    pool = [deployment("uncapped", api_key="k1"), deployment("fresh", api_key="k2", rpm=5)]

    assert await ranked(subject, pool) == ("fresh", "uncapped"), (
        "an unmetered key is the overflow the pool spills into, so it ranks behind every metered "
        "one even when none of them has been touched"
    )


async def test_a_fresh_pool_keeps_the_order_it_was_given():
    subject = enforcer()
    pool = [deployment(f"d{index}", api_key=f"k{index}", rpm=5) for index in range(1, 5)]

    assert await ranked(subject, pool) == ("d1", "d2", "d3", "d4"), (
        "nothing is spent, so there is nothing to rank on; reshuffling here is the random pick "
        "that stickiness exists to replace"
    )


async def test_the_fraction_spent_decides_rather_than_the_raw_count():
    subject = enforcer()
    roomy = deployment("roomy", api_key="k1", rpm=100)
    tight = deployment("tight", api_key="k2", rpm=5)

    await spend(subject, roomy, 10)
    await spend(subject, tight, 1)

    assert await ranked(subject, [roomy, tight]) == ("tight", "roomy"), (
        "10 of 100 is a tenth of the allowance and 1 of 5 is a fifth, so ranking on requests "
        "served would drain the roomy key and strand the tight one"
    )


async def test_the_tightest_window_decides_rather_than_the_loosest():
    subject = enforcer()
    day_bound = deployment("day-bound", api_key="k1", rpm=100, rpd=4)
    even = deployment("even", api_key="k2", rpm=10, rpd=10)

    await spend(subject, day_bound, 2)
    await spend(subject, even, 1)

    assert await ranked(subject, [day_bound, even]) == ("day-bound", "even"), (
        "half the day allowance is gone against a fiftieth of the minute, so scoring the loosest "
        "window keeps feeding the key that runs out first"
    )


async def test_a_credential_with_a_zero_allowance_is_ranked_without_dividing_by_it():
    subject = enforcer()
    pool = [deployment("blocked", api_key="k1", rpm=0), deployment("open", api_key="k2", rpm=5)]

    assert await ranked(subject, pool) == ("blocked", "open")
    assert await exhausted(subject, pool) == {"blocked"}, "a key allowed nothing can never be selected"


async def test_a_pool_is_drained_one_credential_at_a_time():
    subject = enforcer()
    pool = [deployment(f"d{index}", api_key=f"k{index}", rpm=5) for index in range(1, 4)]
    served: list[str] = []

    for _ in range(15):
        rotation = await subject.most_spent_first(pool)
        reserved = await subject.reserve_first_available(rotation[0], rotation)
        assert reserved is not None
        served.append(str(reserved["model_info"]["id"]))

    assert served == ["d1"] * 5 + ["d2"] * 5 + ["d3"] * 5, (
        "rotation belongs at the moment a key runs out of allowance, not on every request"
    )
    assert await subject.reserve_first_available(pool[0], pool) is None, "15 of 15 slots are gone"


async def test_a_refund_gives_the_slot_back():
    subject = enforcer()
    pool = [deployment("d1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[0], pool) is None

    await subject.refund_reservation(pool[0], reserved_at=NOW)

    assert await subject.reserve_first_available(pool[0], pool) is pool[0], (
        "a request that never reached the provider must not cost the credential a slot"
    )


async def test_a_refund_credits_the_window_the_request_charged():
    clock = Clock()
    subject = enforcer(clock)
    pool = [deployment("d1", rpm=1)]
    charged_at = clock.now

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    clock.advance(minutes=1)
    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    await subject.refund_reservation(pool[0], reserved_at=charged_at)

    assert await subject.reserve_first_available(pool[0], pool) is None, (
        "refunding against the current minute would credit the window the retry is spending"
    )


async def test_a_refund_gives_back_every_window_the_request_charged():
    clock = Clock()
    subject = enforcer(clock)
    pool = [deployment("d1", rpm=2, rpd=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    await subject.refund_reservation(pool[0], reserved_at=clock.now)

    assert await subject.reserve_first_available(pool[0], pool) is pool[0], (
        "the day counter stayed charged, so a refund only healed the minute"
    )


async def test_repeated_refunds_cannot_mint_capacity():
    subject = enforcer()
    pool = [deployment("d1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    for _ in range(3):
        await subject.refund_reservation(pool[0], reserved_at=NOW)

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]
    assert await subject.reserve_first_available(pool[0], pool) is None, (
        "refunds must floor at zero, or a retried failure callback hands out free slots"
    )


async def test_usage_reports_what_a_key_has_spent_and_has_left():
    subject = enforcer()
    pool = [deployment("d1", rpm=5)]

    await spend(subject, pool[0], 2)

    (row,) = await subject.usage(pool)
    (window,) = row.windows
    assert (window.kind, window.limit, window.used, window.remaining) == ("rpm", 5, 2, 3)
    assert not row.exhausted
    assert row.seconds_until_room is None


async def test_usage_reports_one_row_per_deployment_in_the_order_given():
    subject = enforcer()
    pool = [deployment("d1", rpm=5), deployment("d2"), deployment("d3", rpd=100, api_key="sk-other")]

    rows = await subject.usage(pool)

    assert tuple(row.deployment_id for row in rows) == ("d1", "d2", "d3"), (
        "a caller zips these rows back onto its own deployment list, so order and length are the contract"
    )


async def test_usage_reports_no_window_for_a_key_with_no_cap():
    subject = enforcer()
    pool = [deployment("d1")]

    await spend(subject, pool[0], 3)

    (row,) = await subject.usage(pool)
    assert row.windows == ()
    assert not row.exhausted, "an unmetered key has nothing to spend, so it can always take another request"
    assert row.seconds_until_room is None


async def test_usage_reports_when_a_spent_key_frees_up():
    subject = enforcer()
    pool = [deployment("d1", rpm=1)]

    await spend(subject, pool[0], 1)

    (row,) = await subject.usage(pool)
    assert (row.exhausted, row.seconds_until_room) == (True, SECONDS_TO_NEXT_MINUTE)
    assert row.windows[0].remaining == 0


async def test_a_key_blocked_on_both_windows_reports_the_day_boundary():
    subject = enforcer()
    pool = [deployment("d1", rpm=1, rpd=1)]

    await spend(subject, pool[0], 1)

    (row,) = await subject.usage(pool)
    assert row.seconds_until_room == SECONDS_TO_NEXT_UTC_DAY, (
        "the minute rolling over buys nothing while the day cap is still spent"
    )


async def test_lowering_a_cap_below_what_is_already_spent_reports_no_headroom():
    subject = enforcer()
    pool = [deployment("d1", rpm=5)]
    await spend(subject, pool[0], 3)

    pool[0]["litellm_params"]["rpm"] = 2

    (row,) = await subject.usage(pool)
    assert (row.windows[0].used, row.windows[0].remaining) == (3, 0), "remaining must floor at zero, never go negative"
    assert row.exhausted


async def test_usage_reports_a_shared_credential_against_every_deployment_that_spends_it():
    subject = enforcer()
    pool = [
        deployment("d1", rpm=5, quota_scope="credential"),
        deployment("d2", rpm=5, quota_scope="credential", model="gemini/gemini-2.5-pro"),
    ]

    await spend(subject, pool[0], 1)

    rows = await subject.usage(pool)
    assert tuple(row.windows[0].used for row in rows) == (1, 1), (
        "both deployments read the one counter, which is why the pool reports exhaustion rather than a spend total"
    )


async def test_usage_never_carries_the_api_key_or_the_counter_key():
    subject = enforcer()
    pool = [deployment("d1", rpm=5, api_key="sk-quota-usage-secret")]

    rows = await subject.usage(pool)

    assert "sk-quota-usage-secret" not in str(rows)
    assert "litellm_quota" not in str(rows), "a counter key holds the scope digest, so it may not be reported"


async def test_an_empty_pool_reports_nothing_spent():
    assert await enforcer().availability([]) == NOTHING_SPENT


async def test_a_lowered_wait_reaches_the_enforcer_the_pool_is_already_counting_on():
    cache = DualCache()
    clock = Clock()
    sleeping = FakeSleep(clock)
    running = QuotaEnforcer(AtomicWindowCounter(cache), clock=clock, sleep=sleeping, max_wait_seconds=75)
    pool = [deployment("d1", rpm=1)]
    await spend(running, pool[0], 1)

    updated = QuotaRoutingSettings(quota_max_wait_seconds=0.0).enforcer(cache=cache, current=running)

    assert updated is not None
    held = await updated.wait_for_capacity(pool)
    assert sleeping.waits == [], "a wait lowered to zero must refuse a spent pool rather than hold it"
    assert held.exhausted_deployment_ids == {"d1"}, "what the pool spent before the update has to still count"
    assert updated.now() == clock.now, "counters are keyed on the clock, so the injected one has to carry over"


async def test_a_raised_wait_reaches_the_enforcer_without_rebuilding_it():
    cache = DualCache()
    clock = Clock()
    sleeping = FakeSleep(clock)
    running = QuotaEnforcer(AtomicWindowCounter(cache), clock=clock, sleep=sleeping, max_wait_seconds=0.0)
    pool = [deployment("d1", rpm=1)]
    await spend(running, pool[0], 1)

    updated = QuotaRoutingSettings(quota_max_wait_seconds=75).enforcer(cache=cache, current=running)

    assert updated is not None
    held = await updated.wait_for_capacity(pool)
    assert sleeping.waits == [pytest.approx(SECONDS_TO_NEXT_MINUTE, abs=1)], (
        "the new budget has to reach the enforcer already in use, sleep and all, instead of a fresh one"
    )
    assert held.exhausted_deployment_ids == frozenset()


async def test_a_wait_that_cannot_be_read_costs_the_wait_and_not_the_flag(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.WARNING, logger=ROUTER_LOGGER)

    settings = QuotaRoutingSettings.read_from(
        {"enable_quota_routing": "true", "quota_max_wait_seconds": "a minute and a half", "redis_password": "sk-secret"}
    )

    assert settings == QuotaRoutingSettings(enable_quota_routing=True), (
        "the flag decides whether a pool is capped at all, so an unreadable wait beside it must not cost it"
    )
    assert quota_records(caplog) == [
        "Ignoring router setting 'quota_max_wait_seconds', which could not be read as a quota setting"
    ]
    assert "sk-secret" not in caplog.text, "these settings arrive alongside secrets, so no value may be logged"
