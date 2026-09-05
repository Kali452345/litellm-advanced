"""
Tests for reading real provider caps back out of the refusals already logged.

A refusal recorded at a count of six proves the provider accepted five, so five is the
number these tests expect to come out. The readings that prove nothing, a refusal with
nothing counting behind it and a window that rolled over, have to stay out of the bound.
"""

import datetime as dt
import json
from collections.abc import Mapping, Sequence
from typing import Final

import pytest

from litellm.proxy.spend_tracking.deployment_error_logs import (
    DeploymentErrorContext,
    QuotaSnapshot,
    QuotaWindowAtFailure,
    error_row,
)
from litellm.proxy.spend_tracking.observed_rate_limits import (
    RefusedAttempt,
    derive_observed_limits,
    read_refusals,
    refused_attempt,
)
from litellm.router_utils.quota import QuotaWindowKind

_SINCE: Final = dt.datetime(2026, 9, 5, tzinfo=dt.timezone.utc)


def _refusal(
    *,
    used: int,
    limit: int = 10,
    kind: QuotaWindowKind = "rpm",
    model_id: str = "d1",
    enforced: bool = True,
    minute: int = 0,
    retry_after: float | None = None,
    windows: Sequence[QuotaWindowAtFailure] | None = None,
) -> RefusedAttempt:
    return RefusedAttempt(
        model_id=model_id,
        model_group="flash-pool",
        litellm_model_name="gemini-2.5-flash",
        api_base="https://generativelanguage.googleapis.com",
        at=_SINCE + dt.timedelta(minutes=minute),
        context=DeploymentErrorContext(
            retry_after_seconds=retry_after,
            quota_enforced=enforced,
            quota_windows=tuple(windows)
            if windows is not None
            else (QuotaWindowAtFailure(kind=kind, limit=limit, used=used),),
        ),
    )


def _derive(*refusals: RefusedAttempt):
    return derive_observed_limits(refusals=refusals, since=_SINCE)


def test_the_suggested_cap_is_one_below_the_tightest_refusal():
    """Six refused proves five allowed, and the tightest of many readings is the bound."""
    observed = _derive(_refusal(used=8), _refusal(used=6, minute=1), _refusal(used=7, minute=2))

    (key,) = observed.keys
    (window,) = key.windows
    assert (window.lowest_count_at_refusal, window.highest_count_at_refusal) == (6, 8)
    assert window.suggested_limit == 5
    assert (window.refusals, key.refusals, observed.refusals_read) == (3, 3, 3)
    assert observed.unmetered_refusals == 0


def test_a_refusal_logged_with_nothing_counting_bounds_nothing():
    """Enforcement off means the counters never moved, so its count is not a reading."""
    observed = _derive(_refusal(used=4, enforced=False))

    assert observed.keys == ()
    assert (observed.refusals_read, observed.unmetered_refusals) == (1, 1)


def test_a_window_that_rolled_over_before_the_read_bounds_nothing():
    observed = _derive(_refusal(used=0))

    assert observed.keys == ()
    assert observed.unmetered_refusals == 1


def test_a_useless_reading_does_not_drag_a_real_one_down():
    observed = _derive(_refusal(used=0), _refusal(used=6, minute=1))

    (key,) = observed.keys
    (window,) = key.windows
    assert window.suggested_limit == 5
    assert (window.refusals, observed.unmetered_refusals) == (1, 1)


def test_each_window_is_bounded_on_its_own():
    """A daily cap and a per-minute cap are different numbers and different fixes."""
    observed = _derive(
        _refusal(
            used=6,
            windows=(
                QuotaWindowAtFailure(kind="rpm", limit=5, used=6),
                QuotaWindowAtFailure(kind="rpd", limit=100, used=51),
            ),
        )
    )

    (key,) = observed.keys
    assert {window.kind: window.suggested_limit for window in key.windows} == {"rpm": 5, "rpd": 50}


def test_a_cap_that_moved_is_reported_as_the_provider_last_had_it():
    """The newest refusal wins whichever order the rows arrive in."""
    older: Final = _refusal(used=6, limit=5, minute=0)
    newer: Final = _refusal(used=9, limit=8, minute=5)

    for refusals in ((older, newer), (newer, older)):
        (key,) = derive_observed_limits(refusals=refusals, since=_SINCE).keys
        (window,) = key.windows
        assert window.configured_limit == 8
        assert (window.suggested_limit, key.last_refusal) == (5, newer.at)


def test_refusals_are_bounded_per_key_not_per_pool():
    """Two keys behind one model name have their own caps, so mixing them invents a bound."""
    observed = _derive(_refusal(used=6, model_id="d1"), _refusal(used=21, model_id="d2", minute=1))

    assert {key.model_id: key.windows[0].suggested_limit for key in observed.keys} == {"d1": 5, "d2": 20}


def test_the_longest_wait_a_provider_asked_for_comes_back():
    """Seconds point at the minute window, hours at a daily cap rotation cannot clear."""
    observed = _derive(_refusal(used=6, retry_after=30.0), _refusal(used=7, retry_after=3600.0, minute=1))

    (key,) = observed.keys
    assert key.longest_retry_after_seconds == 3600.0


def test_a_refusal_that_named_no_wait_reports_none():
    (key,) = _derive(_refusal(used=6)).keys

    assert key.longest_retry_after_seconds is None


def _logged_row(*, used: int = 6, model_id: str = "d1", decoded: bool = False) -> dict[str, object]:
    """A row exactly as the failure logger writes it, so both halves are held to one shape."""
    from litellm.proxy.spend_tracking.deployment_error_logs import FailedCall

    row: Final = error_row(
        call=FailedCall.model_validate(
            {
                "status": "failure",
                "litellm_call_id": "call-1",
                "startTime": 1_800_000_000.0,
                "endTime": 1_800_000_010.5,
                "model": "gemini-2.5-flash",
                "model_id": model_id,
                "model_group": "flash-pool",
                "api_base": "https://generativelanguage.googleapis.com",
                "error_information": {"error_code": "429", "error_class": "RateLimitError"},
            }
        ),
        snapshot=QuotaSnapshot(enforced=True, windows=(QuotaWindowAtFailure(kind="rpm", limit=5, used=used),)),
        retry_after=27.0,
    )
    columns: Final = row.model_dump(by_alias=True)
    return {**columns, "request_kwargs": json.loads(columns["request_kwargs"])} if decoded else columns


@pytest.mark.parametrize("decoded", [False, True])
def test_a_row_the_failure_logger_wrote_reads_back_as_the_same_reading(decoded: bool):
    """The two halves have to agree on the json shape, whether the driver decodes it or not."""
    attempt = refused_attempt(_logged_row(decoded=decoded))

    assert attempt is not None
    (key,) = _derive(attempt).keys
    assert key.model_id == "d1"
    assert key.litellm_model_name == "gemini-2.5-flash"
    assert key.longest_retry_after_seconds == 27.0
    assert key.windows[0].suggested_limit == 5


def test_a_refusal_with_no_key_behind_it_is_dropped():
    """Nothing to tune, since the row cannot say which key was refused."""
    assert refused_attempt(_logged_row(model_id="")) is None


@pytest.mark.parametrize("broken", [{"endTime": "not a time"}, {"request_kwargs": "{{{"}])
def test_a_row_that_cannot_be_read_is_dropped_rather_than_guessed_at(broken: Mapping[str, object]):
    assert refused_attempt({**_logged_row(), **broken}) is None


def test_a_row_from_before_this_feature_shipped_is_dropped():
    """The table has always been read and never written, so old rows have no quota facts."""
    assert refused_attempt({"model_id": "d1", "startTime": _SINCE}) is None


class _Table:
    """Stands in for the error log table, remembering how it was queried."""

    def __init__(self, rows: Sequence[Mapping[str, object]]):
        self.rows = rows
        self.query: Mapping[str, object] = {}

    async def find_many(self, **kwargs: object) -> Sequence[Mapping[str, object]]:
        self.query = kwargs
        return self.rows


class _Db:
    def __init__(self, table: _Table):
        self.litellm_errorlogs = table


class _Prisma:
    def __init__(self, table: _Table):
        self.db = _Db(table)


async def test_only_rate_limit_refusals_inside_the_window_are_read():
    """Every other failure in the table is noise for this question, so the database drops it."""
    table = _Table((_logged_row(), _logged_row(model_id="")))
    prisma = _Prisma(table)

    attempts = await read_refusals(prisma, since=_SINCE, limit=200)

    assert table.query["where"] == {"startTime": {"gte": _SINCE}, "status_code": "429"}
    assert table.query["order"] == {"startTime": "desc"}
    assert table.query["take"] == 200
    assert [attempt.model_id for attempt in attempts] == ["d1"]
