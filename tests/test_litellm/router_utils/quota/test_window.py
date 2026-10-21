import datetime as dt

import pytest

from litellm.router_utils.quota.window import (
    UnknownQuotaTimezoneError,
    counter_key,
    day_window,
    minute_window,
    resolve_quota_timezone,
)

LOS_ANGELES = "America/Los_Angeles"


def utc(*args: int) -> dt.datetime:
    return dt.datetime(*args, tzinfo=dt.timezone.utc)


def test_minute_label_is_stable_within_a_minute_and_changes_across_it():
    early = minute_window(utc(2026, 9, 1, 14, 32, 0))
    late = minute_window(utc(2026, 9, 1, 14, 32, 59))
    next_minute = minute_window(utc(2026, 9, 1, 14, 33, 0))

    assert early.label == late.label == "14-32"
    assert next_minute.label == "14-33"


def test_minute_reset_counts_down_and_never_reaches_zero():
    assert minute_window(utc(2026, 9, 1, 14, 32, 0)).seconds_until_reset == 60
    assert minute_window(utc(2026, 9, 1, 14, 32, 30)).seconds_until_reset == 30
    assert minute_window(utc(2026, 9, 1, 14, 32, 59)).seconds_until_reset == 1

    mid_second = dt.datetime(2026, 9, 1, 14, 32, 59, 500_000, tzinfo=dt.timezone.utc)
    assert minute_window(mid_second).seconds_until_reset == 1


def test_minute_window_normalises_non_utc_input():
    tz = resolve_quota_timezone(LOS_ANGELES)
    local = dt.datetime(2026, 9, 1, 7, 32, 15, tzinfo=tz)

    assert minute_window(local).label == minute_window(local.astimezone(dt.timezone.utc)).label
    assert minute_window(local).timezone_name == "UTC"


def test_day_label_follows_the_configured_timezone_not_utc():
    # 06:30 UTC on 2026-09-02 is still 2026-09-01 in Los Angeles.
    moment = utc(2026, 9, 2, 6, 30, 0)

    assert day_window(moment).label == "2026-09-02"
    assert day_window(moment, LOS_ANGELES).label == "2026-09-01"


def test_day_window_rolls_over_at_local_midnight():
    # 2026-09-01 23:59:30 in Los Angeles is 2026-09-02 06:59:30 UTC.
    before = day_window(utc(2026, 9, 2, 6, 59, 30), LOS_ANGELES)
    after = day_window(utc(2026, 9, 2, 7, 0, 0), LOS_ANGELES)

    assert before.label == "2026-09-01"
    assert before.seconds_until_reset == 30
    assert after.label == "2026-09-02"
    assert after.seconds_until_reset == 86400


def test_day_window_shortens_across_a_spring_forward():
    # 2026-03-08 is 23 hours long in Los Angeles: the local day loses an hour to DST.
    start_of_short_day = utc(2026, 3, 8, 8, 0, 0)
    window = day_window(start_of_short_day, LOS_ANGELES)

    assert window.label == "2026-03-08"
    assert window.seconds_until_reset == 23 * 3600


def test_day_window_lengthens_across_a_fall_back():
    # 2026-11-01 is 25 hours long in Los Angeles.
    start_of_long_day = utc(2026, 11, 1, 7, 0, 0)
    window = day_window(start_of_long_day, LOS_ANGELES)

    assert window.label == "2026-11-01"
    assert window.seconds_until_reset == 25 * 3600


def test_utc_resolves_without_a_system_tz_database():
    assert resolve_quota_timezone(None) is dt.timezone.utc
    assert resolve_quota_timezone("UTC") is dt.timezone.utc
    assert resolve_quota_timezone("utc") is dt.timezone.utc


def test_unknown_timezone_is_rejected_rather_than_silently_defaulting_to_utc():
    with pytest.raises(UnknownQuotaTimezoneError) as raised:
        resolve_quota_timezone("Mars/Olympus_Mons")

    assert raised.value.timezone_name == "Mars/Olympus_Mons"

    with pytest.raises(UnknownQuotaTimezoneError):
        day_window(utc(2026, 9, 1, 0, 0, 0), "Mars/Olympus_Mons")


def test_counter_key_shape_puts_the_hash_tag_first_and_scopes_the_day_by_timezone():
    prefix = "{key:abc123:gemini/gemini-2.5-flash}"
    moment = utc(2026, 9, 2, 6, 59, 30)

    minute_key = counter_key(prefix, minute_window(moment))
    day_key = counter_key(prefix, day_window(moment, LOS_ANGELES))

    assert minute_key == "litellm_quota:{key:abc123:gemini/gemini-2.5-flash}:rpm:06-59"
    assert day_key == "litellm_quota:{key:abc123:gemini/gemini-2.5-flash}:rpd:2026-09-01:America/Los_Angeles"

    for key in (minute_key, day_key):
        assert key.index("{") < key.index("}")
        assert key.count("{") == 1


def test_day_keys_for_the_same_date_in_different_timezones_do_not_collide():
    moment = utc(2026, 9, 2, 6, 30, 0)
    prefix = "{key:abc123}"

    utc_key = counter_key(prefix, day_window(moment))
    la_key = counter_key(prefix, day_window(moment, LOS_ANGELES))
    tokyo_key = counter_key(prefix, day_window(moment, "Asia/Tokyo"))

    assert len({utc_key, la_key, tokyo_key}) == 3
