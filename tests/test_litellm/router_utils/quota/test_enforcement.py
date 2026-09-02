import asyncio
import datetime as dt
import logging

import pytest

from litellm.caching.dual_cache import DualCache
from litellm.router_utils.quota.counter import AtomicWindowCounter
from litellm.router_utils.quota.enforcement import QuotaEnforcer, warn_on_unenforced_quotas

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


async def test_selection_only_sees_the_candidates_with_room_left():
    subject = enforcer()
    spent = deployment("spent", api_key="k1", rpm=1)
    open_key = deployment("open", api_key="k2", rpm=1)
    uncapped = deployment("uncapped", api_key="k3")
    pool = [spent, open_key, uncapped]

    assert await subject.reserve_first_available(spent, [spent]) is spent

    candidates, reset_seconds = await subject.candidates_with_capacity(pool)

    assert candidates == (open_key, uncapped), "a spent key must be gone before selection weighs the pool"
    assert reset_seconds is None, "there is room left, so there is nothing to report a retry-after for"


async def test_a_pool_with_nothing_left_yields_no_candidates_and_a_retry_after():
    clock = Clock()
    subject = enforcer(clock, sleep=FakeSleep(clock, moves_clock=False))
    pool = [deployment("d1", api_key="k1", rpm=1)]

    assert await subject.reserve_first_available(pool[0], pool) is pool[0]

    candidates, reset_seconds = await subject.candidates_with_capacity(pool)

    assert candidates == ()
    assert reset_seconds == SECONDS_TO_NEXT_MINUTE, (
        "a caller left with nothing has to be told the second the pool frees up, or it retries blind"
    )


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
