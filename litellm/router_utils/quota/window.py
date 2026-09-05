"""
Calendar-aligned windows for per-credential request quotas.

The window label lives inside the counter key, so a window resets because the
key changes rather than because a TTL fired. That makes the expiry pure garbage
collection: a clock skew or a DST transition can shift when the old key is
reclaimed, but it can never reset a live counter early and over-issue requests.
"""

import datetime as dt
import math
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from litellm.constants import QUOTA_COUNTER_KEY_PREFIX

QuotaWindowKind: TypeAlias = Literal["rpm", "rpd"]

MINUTE_WINDOW_SECONDS: Final = 60
DAY_WINDOW_SECONDS: Final = 86400
DEFAULT_QUOTA_TIMEZONE: Final = "UTC"

_MINUTE_LABEL_FORMAT: Final = "%H-%M"
_DAY_LABEL_FORMAT: Final = "%Y-%m-%d"


class UnknownQuotaTimezoneError(ValueError):
    """Raised when `quota_reset_timezone` is not a timezone `zoneinfo` can load."""

    def __init__(self, timezone_name: str) -> None:
        super().__init__(
            f"quota_reset_timezone={timezone_name!r} is not a loadable IANA timezone. "
            "Use a name like 'America/Los_Angeles'. On a host without a system tz "
            "database (Windows), install the 'tzdata' package."
        )
        self.timezone_name: Final = timezone_name


@dataclass(frozen=True, slots=True)
class QuotaWindow:
    kind: QuotaWindowKind
    label: str
    timezone_name: str
    seconds_until_reset: int


def resolve_quota_timezone(timezone_name: str | None) -> dt.tzinfo:
    """
    Load a quota reset timezone, defaulting to UTC.

    UTC short-circuits to `datetime.timezone.utc` so the default path never
    needs a tz database on disk.
    """
    name: Final = timezone_name or DEFAULT_QUOTA_TIMEZONE
    if name.upper() == DEFAULT_QUOTA_TIMEZONE:
        return dt.timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise UnknownQuotaTimezoneError(name) from exc


def minute_window(now: dt.datetime) -> QuotaWindow:
    """
    The UTC minute `now` falls in.

    Minute windows ignore `quota_reset_timezone` because every timezone offset
    in use is a whole number of minutes, so a local minute boundary and a UTC
    one are the same instant.
    """
    utc_now: Final = now.astimezone(dt.timezone.utc)
    elapsed: Final = utc_now.second + utc_now.microsecond / 1_000_000
    return QuotaWindow(
        kind="rpm",
        label=utc_now.strftime(_MINUTE_LABEL_FORMAT),
        timezone_name=DEFAULT_QUOTA_TIMEZONE,
        seconds_until_reset=max(1, math.ceil(MINUTE_WINDOW_SECONDS - elapsed)),
    )


def day_window(now: dt.datetime, timezone_name: str | None = None) -> QuotaWindow:
    """The local calendar day `now` falls in, per `timezone_name` (default UTC)."""
    resolved_name: Final = timezone_name or DEFAULT_QUOTA_TIMEZONE
    tz: Final = resolve_quota_timezone(timezone_name)
    local_now: Final = now.astimezone(tz)
    next_midnight: Final = dt.datetime.combine(
        local_now.date() + dt.timedelta(days=1),
        dt.time.min,
        tzinfo=tz,
    )
    # Subtract in UTC. Same-zone datetime arithmetic is wall-clock arithmetic, so
    # doing it in local time would report 24h for a day that DST made 23h long.
    elapsed_to_midnight: Final = next_midnight.astimezone(dt.timezone.utc) - local_now.astimezone(dt.timezone.utc)
    return QuotaWindow(
        kind="rpd",
        label=local_now.strftime(_DAY_LABEL_FORMAT),
        timezone_name=resolved_name,
        seconds_until_reset=max(1, math.ceil(elapsed_to_midnight.total_seconds())),
    )


def counter_key(scope_key_prefix: str, window: QuotaWindow) -> str:
    """
    Build the cache key for one window of one quota scope.

    `scope_key_prefix` is wrapped in a Redis Cluster hash tag by the caller
    (see `QuotaScope.key_prefix`) so a scope's rpm and rpd keys land on the same
    slot and can be reserved in one atomic script call.
    """
    if window.kind == "rpd":
        return f"{QUOTA_COUNTER_KEY_PREFIX}:{scope_key_prefix}:rpd:{window.label}:{window.timezone_name}"
    return f"{QUOTA_COUNTER_KEY_PREFIX}:{scope_key_prefix}:rpm:{window.label}"
