"""
Tests for the failed-attempt error log.

What lands in `LiteLLM_ErrorLogs` when a provider refuses a key, above all the count
that key had spent of its window, since that count is the whole reason for the row.
"""

import asyncio
import datetime as dt
import json
from collections.abc import Sequence
from typing import Final

import pytest

from litellm.proxy.spend_tracking.deployment_error_logs import (
    NO_QUOTA,
    DeploymentErrorLogger,
    DeploymentErrorRow,
    FailedCall,
    QuotaSnapshot,
    QuotaWindowAtFailure,
    error_row,
    failed_call_in,
    retry_after_seconds,
)

_COLUMNS: Final = frozenset(
    {
        "request_id",
        "startTime",
        "endTime",
        "api_base",
        "model_group",
        "litellm_model_name",
        "model_id",
        "request_kwargs",
        "exception_type",
        "exception_string",
        "status_code",
    }
)

_REFUSED: Final = QuotaSnapshot(enforced=True, windows=(QuotaWindowAtFailure(kind="rpm", limit=5, used=6),))


def _payload(
    *,
    model_id: str = "d1",
    end_time: float = 1_800_000_010.5,
    status: str = "failure",
    message: str = "429 RESOURCE_EXHAUSTED",
    call_id: str = "call-1",
) -> dict[str, object]:
    return {
        "standard_logging_object": {
            "status": status,
            "litellm_call_id": call_id,
            "startTime": 1_800_000_000.0,
            "endTime": end_time,
            "model": "gemini-2.5-flash",
            "model_id": model_id,
            "model_group": "flash-pool",
            "api_base": "https://generativelanguage.googleapis.com",
            "custom_llm_provider": "gemini",
            "error_information": {
                "error_code": "429",
                "error_class": "RateLimitError",
                "error_message": message,
                "error_rate_limit_category": "key",
                "error_rate_limit_type": "requests",
            },
        }
    }


def _call(*, message: str) -> FailedCall:
    return FailedCall.model_validate(_payload(message=message)["standard_logging_object"])


class _Writer:
    """Collects every insert, so a test can count them and read what they carried."""

    def __init__(self, *, fail_times: int = 0):
        self.inserts: tuple[tuple[DeploymentErrorRow, ...], ...] = ()
        self.fail_times = fail_times

    async def __call__(self, rows: Sequence[DeploymentErrorRow]) -> None:
        self.inserts = (*self.inserts, tuple(rows))
        if len(self.inserts) <= self.fail_times:
            raise RuntimeError("database is down")


class _Counters:
    """Reports one refused window, and remembers which keys were asked about."""

    def __init__(self, snapshot: QuotaSnapshot = _REFUSED):
        self.snapshot = snapshot
        self.asked: tuple[str, ...] = ()

    async def __call__(self, model_id: str) -> QuotaSnapshot:
        self.asked = (*self.asked, model_id)
        return self.snapshot


def _logger(writer: _Writer, counters: _Counters, *, queue_limit: int = 16) -> DeploymentErrorLogger:
    """A logger whose debounce is a no-op, so a drain finishes within the test."""

    async def _no_wait(_seconds: float) -> None:
        return None

    return DeploymentErrorLogger(
        write=writer, read_quota=counters, drain_delay_seconds=0.0, queue_limit=queue_limit, sleep=_no_wait
    )


async def _log(logger: DeploymentErrorLogger, *payloads: dict[str, object]) -> None:
    """Report every payload, then let the debounced drain run without waiting on a clock."""
    for payload in payloads:
        await logger.async_log_failure_event(payload, None, None, None)
    for _ in range(10):
        await asyncio.sleep(0)


def _context(row: DeploymentErrorRow) -> dict[str, object]:
    return json.loads(row.model_dump(by_alias=True)["request_kwargs"])


async def test_a_refusal_records_the_count_its_key_had_already_spent():
    """The count is the measurement: a refusal at 6 proves the provider took 5."""
    writer, counters = _Writer(), _Counters()

    await _log(_logger(writer, counters), _payload())

    (row,) = writer.inserts[0]
    assert counters.asked == ("d1",)
    assert _context(row)["quota_windows"] == [{"kind": "rpm", "limit": 5, "used": 6}]
    assert _context(row)["quota_enforced"] is True


async def test_a_row_carries_every_column_the_error_log_table_has():
    writer = _Writer()

    await _log(_logger(writer, _Counters()), _payload())

    (row,) = writer.inserts[0]
    columns = row.model_dump(by_alias=True)
    assert set(columns) == _COLUMNS
    assert columns["status_code"] == "429"
    assert columns["model_id"] == "d1"
    assert columns["model_group"] == "flash-pool"
    assert columns["endTime"] == dt.datetime.fromtimestamp(1_800_000_010.5, dt.timezone.utc)


async def test_a_retry_chain_lands_as_one_insert():
    """A pool failing over refuses several keys for one request, and that is one write."""
    writer = _Writer()

    await _log(
        _logger(writer, _Counters()),
        _payload(model_id="d1"),
        _payload(model_id="d2"),
        _payload(model_id="d3"),
    )

    assert [len(insert) for insert in writer.inserts] == [3]
    assert [row.model_id for row in writer.inserts[0]] == ["d1", "d2", "d3"]


async def test_the_row_id_names_the_attempt_not_the_request():
    """A retry keeps one call id, so only the key it landed on separates the two rows."""
    writer = _Writer()

    await _log(
        _logger(writer, _Counters()),
        _payload(model_id="d1", call_id="one-request"),
        _payload(model_id="d2", call_id="one-request"),
    )

    first, second = writer.inserts[0]
    assert first.request_id != second.request_id


async def test_the_same_attempt_reported_twice_keeps_one_id():
    writer = _Writer()

    await _log(_logger(writer, _Counters()), _payload(), _payload())

    first, second = writer.inserts[0]
    assert first.request_id == second.request_id


async def test_a_call_that_did_not_fail_is_not_written():
    writer = _Writer()

    await _log(_logger(writer, _Counters()), _payload(status="success"))

    assert writer.inserts == ()


async def test_a_payload_that_is_not_an_llm_call_is_not_written():
    writer = _Writer()

    await _log(_logger(writer, _Counters()), {"cache_hit": True})

    assert writer.inserts == ()


async def test_nothing_is_written_while_error_logs_are_disabled(monkeypatch: pytest.MonkeyPatch):
    """One switch silences the spend-log failure row and this table together."""
    from litellm.proxy.proxy_server import general_settings

    monkeypatch.setitem(general_settings, "disable_error_logs", True)
    writer = _Writer()

    await _log(_logger(writer, _Counters()), _payload())

    assert writer.inserts == ()


async def test_a_full_buffer_drops_an_attempt_rather_than_failing_the_request():
    writer = _Writer()
    logger = _logger(writer, _Counters(), queue_limit=1)

    await logger.async_log_failure_event(_payload(model_id="d1"), None, None, None)
    await logger.async_log_failure_event(_payload(model_id="d2"), None, None, None)
    for _ in range(10):
        await asyncio.sleep(0)

    assert [row.model_id for insert in writer.inserts for row in insert] == ["d1"]


async def test_a_failed_insert_does_not_wedge_the_logger():
    """A database blip loses those rows, and the next refusal still gets written."""
    writer = _Writer(fail_times=1)
    logger = _logger(writer, _Counters())

    await _log(logger, _payload(model_id="d1"))
    await _log(logger, _payload(model_id="d2"))

    assert [row.model_id for insert in writer.inserts for row in insert] == ["d1", "d2"]


async def test_a_failure_on_no_particular_key_records_no_quota_window():
    """Nothing counted it, so there is no count to read and none is invented."""
    writer, counters = _Writer(), _Counters()

    await _log(_logger(writer, counters), _payload(model_id=""))

    (row,) = writer.inserts[0]
    assert counters.asked == ()
    assert _context(row)["quota_enforced"] is False
    assert _context(row)["quota_windows"] == []


def test_a_long_provider_message_is_cut_to_fit_the_column():
    row = error_row(call=_call(message="x" * 9000), snapshot=NO_QUOTA, retry_after=None)

    assert len(row.exception_string) == 2000


class _Refusal(Exception):
    """A provider error carrying headers where an sdk exception carries them."""

    def __init__(self, *, headers: dict[str, str] | None = None, response_headers: dict[str, str] | None = None):
        super().__init__("429")
        self.headers = headers
        self.response = None if response_headers is None else _Refusal(headers=response_headers)


@pytest.mark.parametrize(
    ("refusal", "expected"),
    [
        (_Refusal(headers={"retry-after": "41"}), 41.0),
        (_Refusal(headers={"Retry-After": "41.5"}), 41.5),
        (_Refusal(response_headers={"retry-after": "3600"}), 3600.0),
        (_Refusal(headers={"retry-after": "1"}, response_headers={"retry-after": "60"}), 60.0),
        (_Refusal(headers={"retry-after": "Wed, 21 Oct 2015 07:28:00 GMT"}), None),
        (_Refusal(), None),
        (None, None),
    ],
)
def test_the_wait_a_provider_asked_for_is_read_off_its_headers(refusal: object, expected: float | None):
    assert retry_after_seconds(refusal) == expected


async def test_a_refusal_carries_the_wait_the_provider_asked_for():
    writer = _Writer()
    logger = _logger(writer, _Counters())

    await logger.async_log_failure_event(
        {**_payload(), "exception": _Refusal(headers={"retry-after": "27"})}, None, None, None
    )
    for _ in range(10):
        await asyncio.sleep(0)

    (row,) = writer.inserts[0]
    assert _context(row)["retry_after_seconds"] == 27.0


def test_a_successful_call_is_not_a_failed_one():
    assert failed_call_in(_payload(status="success")) is None
    assert failed_call_in(_payload()) is not None
