"""
All-or-nothing reservation against calendar-aligned quota counters.

`reserve` increments every window a request consumes only if all of them have
headroom, so a request that is about to be rejected for exceeding the daily cap
does not burn a slot in the minute cap on the way out.

Two backends, both authoritative:

- With Redis, one Lua script does the check and the increment in a single atomic
  call. Every key for a scope carries the same hash tag, so the call stays on one
  Redis Cluster slot.
- Without Redis, the same two passes run against the in-memory cache under a lock
  held across both. Single-process deployments are the normal SDK case, so this
  is a real path and not a degraded mode.

The window is encoded in the key, so there is no window bookkeeping here: a new
minute or a new local day is simply a new key, and the TTL only reclaims the old
one.
"""

import asyncio
import datetime as dt
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass
from itertools import chain
from types import MappingProxyType
from typing import Final, Protocol, TypeAlias

from pydantic import TypeAdapter, ValidationError

from litellm._logging import verbose_router_logger
from litellm.caching.dual_cache import DualCache
from litellm.constants import QUOTA_COUNTER_TTL_GRACE_SECONDS
from litellm.router_utils.quota.scope import QuotaScope
from litellm.router_utils.quota.window import QuotaWindow, counter_key, day_window, minute_window

_RESERVE_SCRIPT: Final = """
local descriptor_count = #KEYS

for i = 1, descriptor_count do
    local limit = tonumber(ARGV[(i - 1) * 2 + 1])
    local current = tonumber(redis.call('GET', KEYS[i]) or '0')
    if current + 1 > limit then
        return { 1, i, current, limit }
    end
end

local granted = { 0 }
for i = 1, descriptor_count do
    granted[i + 1] = redis.call('INCRBY', KEYS[i], 1)
    if redis.call('TTL', KEYS[i]) < 0 then
        redis.call('EXPIRE', KEYS[i], tonumber(ARGV[(i - 1) * 2 + 2]))
    end
end
return granted
"""

_REFUND_SCRIPT: Final = """
for i = 1, #KEYS do
    if tonumber(redis.call('GET', KEYS[i]) or '0') > 0 then
        redis.call('DECRBY', KEYS[i], 1)
    end
end
return 1
"""

_BLOCKED: Final = 1

_RESERVE_REPLY_ADAPTER: Final = TypeAdapter(tuple[int, ...])
_COUNTS_ADAPTER: Final = TypeAdapter(dict[str, int | None])
_LOCAL_COUNTS_ADAPTER: Final = TypeAdapter(tuple[float | None, ...])


class _RedisScript(Protocol):
    def __call__(self, keys: Sequence[str], args: Sequence[str | bytes | int | float]) -> Awaitable[object]: ...


@dataclass(frozen=True, slots=True)
class QuotaDescriptor:
    key: str
    limit: int
    window: QuotaWindow

    @property
    def ttl_seconds(self) -> int:
        """
        How long the counter outlives its window.

        The grace exists because a node whose clock lags still writes the
        previous label for a moment. Over-holding a stale key costs nothing,
        since a key stops being consulted the instant its label stops matching.
        """
        return self.window.seconds_until_reset + QUOTA_COUNTER_TTL_GRACE_SECONDS


@dataclass(frozen=True, slots=True)
class ReserveGranted:
    counts: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class ReserveBlocked:
    descriptor: QuotaDescriptor
    current: int


ReserveResult: TypeAlias = ReserveGranted | ReserveBlocked


def build_descriptors(
    *,
    scope: QuotaScope,
    rpm: int | None,
    rpd: int | None,
    now: dt.datetime,
    quota_reset_timezone: str | None = None,
) -> tuple[QuotaDescriptor, ...]:
    """Descriptors for the windows a single request on `scope` would consume."""
    minute: Final = minute_window(now) if rpm is not None else None
    day: Final = day_window(now, quota_reset_timezone) if rpd is not None else None
    return tuple(
        QuotaDescriptor(key=counter_key(scope.key_prefix, window), limit=limit, window=window)
        for window, limit in ((minute, rpm), (day, rpd))
        if window is not None and limit is not None
    )


class AtomicWindowCounter:
    def __init__(self, dual_cache: DualCache) -> None:
        self._dual_cache: Final = dual_cache
        self._local_lock: Final = asyncio.Lock()

    async def reserve(self, descriptors: Sequence[QuotaDescriptor]) -> ReserveResult:
        """
        Consume one request against every descriptor, or none of them.

        A Redis failure degrades to the in-memory counter rather than failing the
        request, which enforces the cap per process instead of per cluster. That
        is the safer of the two wrong answers while Redis is down.
        """
        if not descriptors:
            return ReserveGranted(counts=MappingProxyType({}))
        script: Final = self._redis_script(_RESERVE_SCRIPT)
        if script is None:
            return await self._reserve_local(descriptors)
        try:
            return await self._reserve_redis(script, descriptors)
        except Exception as e:  # noqa: BLE001  # any Redis/Lua failure falls back to the local counter, never fails
            verbose_router_logger.warning("Quota reserve via Redis failed, using the local counter: %s", e)
            return await self._reserve_local(descriptors)

    async def refund(self, descriptors: Sequence[QuotaDescriptor]) -> None:
        """Give back a reservation the request never spent. Best effort."""
        if not descriptors:
            return
        script: Final = self._redis_script(_REFUND_SCRIPT)
        if script is None:
            await self._refund_local(descriptors)
            return
        try:
            await script(keys=tuple(descriptor.key for descriptor in descriptors), args=())
        except Exception as e:  # noqa: BLE001  # a refund is best effort; the local counter is the fallback of record
            verbose_router_logger.warning("Quota refund via Redis failed, using the local counter: %s", e)
            await self._refund_local(descriptors)

    async def peek(self, keys: Sequence[str]) -> Mapping[str, int]:
        """
        Current counts, missing keys reading as 0.

        Advisory only: selection and reporting use it, but `reserve` is the
        authority on whether a request fits.
        """
        if not keys:
            return MappingProxyType({})
        redis_cache: Final = self._dual_cache.redis_cache
        if redis_cache is None:
            return await self._peek_local(keys)
        raw: Final[object] = await redis_cache.async_batch_get_cache(keys)
        try:
            validated: Final = _COUNTS_ADAPTER.validate_python(raw)
        except ValidationError as e:
            verbose_router_logger.warning("Unreadable quota counters in Redis: %s", e)
            return await self._peek_local(keys)
        # A healthy mget still returns an entry per key, holding None for the ones
        # Redis does not have, so an empty reply means the call itself failed. Read
        # the local counters instead, since that is where `reserve` just fell back to.
        if not validated:
            return await self._peek_local(keys)
        return MappingProxyType({key: validated.get(key) or 0 for key in keys})

    def _redis_script(self, script: str) -> _RedisScript | None:
        redis_cache: Final = self._dual_cache.redis_cache
        if redis_cache is None:
            return None
        return redis_cache.async_register_script(script)

    async def _reserve_redis(
        self,
        script: _RedisScript,
        descriptors: Sequence[QuotaDescriptor],
    ) -> ReserveResult:
        raw: Final = await script(
            keys=tuple(descriptor.key for descriptor in descriptors),
            args=tuple(chain.from_iterable((descriptor.limit, descriptor.ttl_seconds) for descriptor in descriptors)),
        )
        reply: Final = _RESERVE_REPLY_ADAPTER.validate_python(raw)
        if reply[0] == _BLOCKED:
            return ReserveBlocked(descriptor=descriptors[reply[1] - 1], current=reply[2])
        return ReserveGranted(
            counts=MappingProxyType(
                {descriptor.key: count for descriptor, count in zip(descriptors, reply[1:], strict=True)}
            )
        )

    async def _reserve_local(self, descriptors: Sequence[QuotaDescriptor]) -> ReserveResult:
        async with self._local_lock:
            counts: Final = await self._peek_local(tuple(descriptor.key for descriptor in descriptors))
            blocked: Final = next(
                (descriptor for descriptor in descriptors if counts.get(descriptor.key, 0) + 1 > descriptor.limit),
                None,
            )
            if blocked is not None:
                return ReserveBlocked(descriptor=blocked, current=counts.get(blocked.key, 0))
            return ReserveGranted(
                counts=MappingProxyType(
                    {descriptor.key: await self._bump_local(descriptor, 1) for descriptor in descriptors}
                )
            )

    async def _refund_local(self, descriptors: Sequence[QuotaDescriptor]) -> None:
        async with self._local_lock:
            counts: Final = await self._peek_local(tuple(descriptor.key for descriptor in descriptors))
            for descriptor in descriptors:
                if counts.get(descriptor.key, 0) > 0:
                    await self._bump_local(descriptor, -1)

    async def _bump_local(self, descriptor: QuotaDescriptor, delta: int) -> int:
        updated: Final = await self._dual_cache.async_increment_cache(
            key=descriptor.key,
            value=delta,
            ttl=descriptor.ttl_seconds,
            local_only=True,
        )
        return int(updated) if updated is not None else 0

    async def _peek_local(self, keys: Sequence[str]) -> Mapping[str, int]:
        raw: Final = await self._dual_cache.in_memory_cache.async_batch_get_cache(keys)
        zeros: Final = MappingProxyType({key: 0 for key in keys})
        try:
            values: Final = _LOCAL_COUNTS_ADAPTER.validate_python(raw)
        except ValidationError as e:
            verbose_router_logger.warning("Unreadable local quota counters: %s", e)
            return zeros
        if len(values) != len(keys):
            return zeros
        return MappingProxyType({key: int(value or 0) for key, value in zip(keys, values, strict=True)})
