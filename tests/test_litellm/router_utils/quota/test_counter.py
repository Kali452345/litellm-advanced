import asyncio
import datetime as dt
from itertools import count
from typing import Final, NoReturn

import fakeredis
import pytest
from redis.asyncio import Redis
from redis.backoff import NoBackoff
from redis.retry import Retry

from litellm.caching.dual_cache import DualCache
from litellm.caching.redis_cache import RedisCache
from litellm.router_utils.quota.counter import (
    AtomicWindowCounter,
    QuotaDescriptor,
    ReserveBlocked,
    ReserveGranted,
    build_descriptors,
)
from litellm.router_utils.quota.scope import resolve_quota_scope
from litellm.types.router import QuotaScopeMode

API_KEY = "sk-quota-counter-test"
MODEL = "gemini/gemini-2.5-flash"
NOW = dt.datetime(2026, 9, 1, 14, 32, 30, tzinfo=dt.timezone.utc)

# RedisCache caches its per-script executor under a key derived from its connection
# kwargs, so a fresh port per instance keeps one test's fakeredis from being reused
# by the next.
_PORTS = count(41000)


class _FakeBackedRedisCache(RedisCache):
    """
    A RedisCache whose async client is an in-process fakeredis server.

    RedisCache.__init__ pings the sync client, which nothing answers here. Retries
    are disabled so that attempt fails in milliseconds instead of backing off for
    ~9 seconds per instance.
    """

    def __init__(self) -> None:
        super().__init__(
            host="127.0.0.1",
            port=str(next(_PORTS)),
            socket_timeout=0.05,
            socket_connect_timeout=0.05,
            retry=Retry(NoBackoff(), 0),
        )
        self._fake: Final = fakeredis.FakeAsyncRedis()

    def init_async_client(self) -> Redis:
        return self._fake


class _UnreachableRedisCache(_FakeBackedRedisCache):
    def init_async_client(self) -> NoReturn:
        raise ConnectionError("redis is down")


@pytest.fixture
def fake_redis_cache() -> _FakeBackedRedisCache:
    return _FakeBackedRedisCache()


@pytest.fixture(params=["in_memory", "redis"])
def counter(request: pytest.FixtureRequest) -> AtomicWindowCounter:
    if request.param == "in_memory":
        return AtomicWindowCounter(DualCache())
    return AtomicWindowCounter(DualCache(redis_cache=_FakeBackedRedisCache()))


def descriptors(
    *,
    rpm: int | None = None,
    rpd: int | None = None,
    now: dt.datetime = NOW,
    litellm_model: str = MODEL,
    mode: QuotaScopeMode = "credential_model",
    api_key: str = API_KEY,
    quota_reset_timezone: str | None = None,
) -> tuple[QuotaDescriptor, ...]:
    scope = resolve_quota_scope(
        mode=mode,
        litellm_model=litellm_model,
        deployment_id="deployment-1",
        api_key=api_key,
    )
    return build_descriptors(
        scope=scope,
        rpm=rpm,
        rpd=rpd,
        now=now,
        quota_reset_timezone=quota_reset_timezone,
    )


async def test_reserve_grants_up_to_the_limit_then_blocks(counter: AtomicWindowCounter):
    minute = descriptors(rpm=3)

    results = [await counter.reserve(minute) for _ in range(4)]

    assert [type(result) for result in results] == [
        ReserveGranted,
        ReserveGranted,
        ReserveGranted,
        ReserveBlocked,
    ]
    assert [r.counts[minute[0].key] for r in results[:3] if isinstance(r, ReserveGranted)] == [1, 2, 3]


async def test_concurrent_reserves_never_exceed_the_limit(counter: AtomicWindowCounter):
    minute = descriptors(rpm=5)

    results = await asyncio.gather(*(counter.reserve(minute) for _ in range(50)))

    granted = [result for result in results if isinstance(result, ReserveGranted)]
    assert len(granted) == 5
    assert sorted(result.counts[minute[0].key] for result in granted) == [1, 2, 3, 4, 5]
    assert (await counter.peek([minute[0].key]))[minute[0].key] == 5


async def test_reserve_is_all_or_nothing_when_the_day_is_exhausted(counter: AtomicWindowCounter):
    both = descriptors(rpm=10, rpd=3)
    minute_key, day_key = both[0].key, both[1].key

    for _ in range(3):
        assert isinstance(await counter.reserve(both), ReserveGranted)

    blocked = await counter.reserve(both)

    assert isinstance(blocked, ReserveBlocked)
    assert blocked.descriptor.key == day_key
    assert blocked.descriptor.window.kind == "rpd"
    assert blocked.current == 3
    counts = await counter.peek([minute_key, day_key])
    assert counts[minute_key] == 3, "the minute counter must not be charged for a request the day cap rejected"
    assert counts[day_key] == 3


async def test_reserve_is_all_or_nothing_when_the_minute_is_exhausted(counter: AtomicWindowCounter):
    both = descriptors(rpm=2, rpd=100)
    minute_key, day_key = both[0].key, both[1].key

    for _ in range(2):
        assert isinstance(await counter.reserve(both), ReserveGranted)

    blocked = await counter.reserve(both)

    assert isinstance(blocked, ReserveBlocked)
    assert blocked.descriptor.window.kind == "rpm"
    counts = await counter.peek([minute_key, day_key])
    assert counts[minute_key] == 2
    assert counts[day_key] == 2, "the day counter must not be charged for a request the minute cap rejected"


async def test_blocked_result_carries_the_reset_horizon_of_the_exhausted_window(counter: AtomicWindowCounter):
    both = descriptors(rpm=1, rpd=1000)

    assert isinstance(await counter.reserve(both), ReserveGranted)
    blocked = await counter.reserve(both)

    assert isinstance(blocked, ReserveBlocked)
    assert blocked.descriptor.limit == 1
    assert blocked.descriptor.window.seconds_until_reset == 30


async def test_refund_returns_the_reservation(counter: AtomicWindowCounter):
    both = descriptors(rpm=2, rpd=2)

    assert isinstance(await counter.reserve(both), ReserveGranted)
    await counter.refund(both)

    assert isinstance(await counter.reserve(both), ReserveGranted)
    assert isinstance(await counter.reserve(both), ReserveGranted)
    assert isinstance(await counter.reserve(both), ReserveBlocked)


async def test_refund_is_symmetric_across_both_windows(counter: AtomicWindowCounter):
    both = descriptors(rpm=10, rpd=10)
    keys = [descriptor.key for descriptor in both]

    for _ in range(4):
        await counter.reserve(both)
    for _ in range(4):
        await counter.refund(both)

    assert await counter.peek(keys) == {key: 0 for key in keys}


async def test_refund_floors_at_zero_instead_of_going_negative(counter: AtomicWindowCounter):
    minute = descriptors(rpm=2)

    await counter.refund(minute)
    await counter.refund(minute)

    assert (await counter.peek([minute[0].key]))[minute[0].key] == 0
    assert isinstance(await counter.reserve(minute), ReserveGranted)
    assert isinstance(await counter.reserve(minute), ReserveGranted)
    assert isinstance(await counter.reserve(minute), ReserveBlocked)


async def test_a_new_minute_starts_from_zero(counter: AtomicWindowCounter):
    at_3259 = descriptors(rpm=2, now=dt.datetime(2026, 9, 1, 14, 32, 59, tzinfo=dt.timezone.utc))
    at_3300 = descriptors(rpm=2, now=dt.datetime(2026, 9, 1, 14, 33, 0, tzinfo=dt.timezone.utc))

    assert at_3259[0].key != at_3300[0].key
    for _ in range(2):
        assert isinstance(await counter.reserve(at_3259), ReserveGranted)
    assert isinstance(await counter.reserve(at_3259), ReserveBlocked)

    assert isinstance(await counter.reserve(at_3300), ReserveGranted)


async def test_one_credential_serving_two_models_shares_the_counter_in_credential_mode(
    counter: AtomicWindowCounter,
):
    flash = descriptors(rpm=2, mode="credential", litellm_model="gemini/gemini-2.5-flash")
    pro = descriptors(rpm=2, mode="credential", litellm_model="gemini/gemini-2.5-pro")

    assert flash[0].key == pro[0].key
    assert isinstance(await counter.reserve(flash), ReserveGranted)
    assert isinstance(await counter.reserve(pro), ReserveGranted)
    assert isinstance(await counter.reserve(flash), ReserveBlocked)


async def test_one_credential_serving_two_models_splits_the_counter_in_credential_model_mode(
    counter: AtomicWindowCounter,
):
    flash = descriptors(rpm=1, litellm_model="gemini/gemini-2.5-flash")
    pro = descriptors(rpm=1, litellm_model="gemini/gemini-2.5-pro")

    assert flash[0].key != pro[0].key
    assert isinstance(await counter.reserve(flash), ReserveGranted)
    assert isinstance(await counter.reserve(pro), ReserveGranted)
    assert isinstance(await counter.reserve(flash), ReserveBlocked)


async def test_different_credentials_do_not_share_a_counter(counter: AtomicWindowCounter):
    first = descriptors(rpm=1, api_key="sk-first")
    second = descriptors(rpm=1, api_key="sk-second")

    assert isinstance(await counter.reserve(first), ReserveGranted)
    assert isinstance(await counter.reserve(second), ReserveGranted)
    assert isinstance(await counter.reserve(first), ReserveBlocked)


async def test_reserving_nothing_is_granted(counter: AtomicWindowCounter):
    result = await counter.reserve(())

    assert isinstance(result, ReserveGranted)
    assert result.counts == {}


async def test_peek_reads_zero_for_untouched_keys(counter: AtomicWindowCounter):
    both = descriptors(rpm=5, rpd=5)
    keys = [descriptor.key for descriptor in both]

    assert await counter.peek(keys) == {key: 0 for key in keys}
    assert await counter.peek([]) == {}


async def test_redis_sets_a_ttl_that_survives_later_increments(fake_redis_cache: _FakeBackedRedisCache):
    counter = AtomicWindowCounter(DualCache(redis_cache=fake_redis_cache))
    minute = descriptors(rpm=10)
    client = fake_redis_cache.init_async_client()

    await counter.reserve(minute)
    ttl_after_first = await client.ttl(minute[0].key)
    for _ in range(3):
        await counter.reserve(minute)
    ttl_after_more = await client.ttl(minute[0].key)

    assert 0 < ttl_after_first <= minute[0].ttl_seconds
    assert 0 < ttl_after_more <= ttl_after_first
    assert await client.get(minute[0].key) == b"4"


async def test_a_dead_redis_falls_back_to_local_enforcement_instead_of_failing_open():
    counter = AtomicWindowCounter(DualCache(redis_cache=_UnreachableRedisCache()))
    minute = descriptors(rpm=2)

    results = [await counter.reserve(minute) for _ in range(3)]

    assert [isinstance(result, ReserveGranted) for result in results] == [True, True, False]
    assert (await counter.peek([minute[0].key]))[minute[0].key] == 2

    await counter.refund(minute)

    assert isinstance(await counter.reserve(minute), ReserveGranted)
