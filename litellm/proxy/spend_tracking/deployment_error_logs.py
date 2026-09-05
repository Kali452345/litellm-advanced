"""
One durable row per failed provider attempt, so a key pool can be tuned after the fact.

A rotating pool hides failures on purpose: the request that a spent key refused is
retried on another one and the caller sees a success, so nothing in the response says
which key refused, how often, or at what count. That is exactly the information needed
to set `rpm` and `rpd` to what a provider actually allows, and until it is written down
somewhere it is gone the moment the retry succeeds.

Each row lands in `LiteLLM_ErrorLogs`, a table the proxy already reads in three places
and has never written, so this needs no migration and lights up the exception panels
that were reading an empty table. The columns hold the identity of the attempt and what
went wrong; `request_kwargs` holds the quota facts, above all how many requests the
refused key had spent of its window when the provider turned it down.

Two things make that count trustworthy. It is read at the moment of the failure, which
`litellm.utils` awaits inline before the router retries, so the counter still holds this
attempt's own increment. And the row records whether quota routing was enforcing at the
time, because a count of zero from a pool with enforcement off means nothing was
counting rather than that the provider refused the first request.

The write itself is buffered and drained by one debounced task. That same inline await
is on the failover path, so an insert there would slow down every retry the pool makes.
"""

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Protocol

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, computed_field

from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_logger import CustomLogger
from litellm.litellm_core_utils.safe_json_dumps import safe_dumps
from litellm.repositories.table_repositories import ErrorLogsRepository
from litellm.router_utils.quota import AtomicWindowCounter, QuotaEnforcer, QuotaWindowKind

_MESSAGE_LIMIT: Final = 2000
_DRAIN_DELAY_SECONDS: Final = 0.5
_QUEUE_LIMIT: Final = 2048
_FAILURE: Final = "failure"


def error_logging_enabled() -> bool:
    """
    Whether failures may be written to the database.

    One switch for every error-log writer, so `general_settings.disable_error_logs`
    silences the spend-log failure row and this table together.
    """
    from litellm.proxy.proxy_server import general_settings

    return general_settings.get("disable_error_logs") is not True


class QuotaWindowAtFailure(BaseModel):
    """What one of the refused key's windows read when the provider turned it down."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    kind: QuotaWindowKind
    limit: int
    used: int


@dataclass(frozen=True, slots=True)
class QuotaSnapshot:
    enforced: bool
    windows: tuple[QuotaWindowAtFailure, ...]


NO_QUOTA: Final = QuotaSnapshot(enforced=False, windows=())


class DeploymentErrorContext(BaseModel):
    """
    The `request_kwargs` column: everything the table has no column of its own for.

    Nothing here is derived from an api key. The quota scope id is a salted digest of
    the credential and never leaves the counter keys, so a key is identified by its
    deployment id and base url, the same way the rest of the quota surface does it.
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    trace_id: str | None = Field(
        default=None, description="Groups every attempt of one request, so a retry chain reads as one story"
    )
    custom_llm_provider: str | None = None
    rate_limit_category: str | None = None
    rate_limit_type: str | None = None
    retry_after_seconds: float | None = None
    quota_enforced: bool = False
    quota_windows: tuple[QuotaWindowAtFailure, ...] = ()


class DeploymentErrorRow(BaseModel):
    """One `LiteLLM_ErrorLogs` row, keyed by its own field names so a dump is the column set."""

    model_config = ConfigDict(frozen=True, protected_namespaces=())

    request_id: str
    start_time: dt.datetime = Field(serialization_alias="startTime")
    end_time: dt.datetime = Field(serialization_alias="endTime")
    api_base: str = ""
    model_group: str = ""
    litellm_model_name: str = ""
    model_id: str = ""
    exception_type: str = ""
    exception_string: str = ""
    status_code: str = ""
    context: DeploymentErrorContext = Field(default_factory=DeploymentErrorContext, exclude=True)

    @computed_field
    @property
    def request_kwargs(self) -> str:
        return safe_dumps(self.context.model_dump())


class _ErrorInformation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    error_code: str | None = None
    error_class: str | None = None
    error_message: str | None = None
    error_rate_limit_category: str | None = None
    error_rate_limit_type: str | None = None


class FailedCall(BaseModel):
    """The part of a failed call's standard logging payload that a row is built from."""

    model_config = ConfigDict(extra="ignore", frozen=True, protected_namespaces=())

    status: str
    trace_id: str | None = None
    litellm_call_id: str | None = None
    custom_llm_provider: str | None = None
    start_time: float = Field(validation_alias="startTime")
    end_time: float = Field(validation_alias="endTime")
    model: str = ""
    model_id: str | None = None
    model_group: str | None = None
    api_base: str = ""
    error_str: str | None = None
    error_information: _ErrorInformation = Field(default_factory=_ErrorInformation)


class _LoggedRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    standard_logging_object: FailedCall | None = None


def failed_call_in(kwargs: Mapping[str, object]) -> FailedCall | None:
    """
    The failed call a logging callback was handed, or None if this was not one.

    The payload is built by the failure handler itself, so a callback that cannot find
    one is looking at something other than a failed llm call and has nothing to write.
    """
    try:
        logged: Final = _LoggedRequest.model_validate(kwargs)
    except ValidationError as e:
        verbose_proxy_logger.debug("Not writing an error log row, unreadable logging payload: %s", e)
        return None
    call: Final = logged.standard_logging_object
    return call if call is not None and call.status == _FAILURE else None


def error_row(*, call: FailedCall, snapshot: QuotaSnapshot, retry_after: float | None) -> DeploymentErrorRow:
    """
    Build the row for one failed attempt.

    `request_id` names the attempt rather than the request: a router retry keeps the
    same `litellm_call_id`, so the deployment it landed on and the instant it ended are
    what separate one attempt's row from the next one's. That also makes the row
    idempotent, so an attempt logged twice cannot count as two refusals.
    """
    info: Final = call.error_information
    return DeploymentErrorRow(
        request_id=f"{call.litellm_call_id or call.trace_id or ''}:{call.model_id or ''}:{call.end_time:.3f}",
        start_time=dt.datetime.fromtimestamp(call.start_time, dt.timezone.utc),
        end_time=dt.datetime.fromtimestamp(call.end_time, dt.timezone.utc),
        api_base=call.api_base,
        model_group=call.model_group or "",
        litellm_model_name=call.model,
        model_id=call.model_id or "",
        exception_type=info.error_class or "",
        exception_string=(info.error_message or call.error_str or "")[:_MESSAGE_LIMIT],
        status_code=info.error_code or "",
        context=DeploymentErrorContext(
            trace_id=call.trace_id,
            custom_llm_provider=call.custom_llm_provider,
            rate_limit_category=info.error_rate_limit_category,
            rate_limit_type=info.error_rate_limit_type,
            retry_after_seconds=retry_after,
            quota_enforced=snapshot.enforced,
            quota_windows=snapshot.windows,
        ),
    )


class _ErrorHeaders(BaseModel):
    """An exception's own headers, and the ones on the response it carries."""

    model_config = ConfigDict(extra="ignore", from_attributes=True)

    headers: Mapping[str, str] | None = None
    response: "_ErrorHeaders | None" = None


def _retry_after(headers: Mapping[str, str] | None) -> str | None:
    return None if headers is None else headers.get("retry-after") or headers.get("Retry-After")


def retry_after_seconds(exception: object) -> float | None:
    """
    How long the provider asked us to wait, when it said.

    Worth having next to the count: a retry-after in minutes says the ceiling that was
    hit is the per-minute one, and one in hours says the refusal came from a daily cap
    that no amount of rotation will clear before tomorrow.
    """
    try:
        view: Final = _ErrorHeaders.model_validate(exception)
    except ValidationError:
        return None
    raw: Final = _retry_after(view.response.headers if view.response else None) or _retry_after(view.headers)
    try:
        return None if raw is None else float(raw)
    except ValueError:
        return None


class QuotaReader(Protocol):
    async def __call__(self, model_id: str) -> QuotaSnapshot: ...


class RowWriter(Protocol):
    async def __call__(self, rows: Sequence[DeploymentErrorRow]) -> None: ...


class DeploymentErrorLogger(CustomLogger):
    """
    Writes one row per failed provider attempt, off the critical path.

    Fires once per attempt, including the ones the router retries away from, which is
    the point: the refusal that rotation hid is the one worth recording.
    """

    def __init__(
        self,
        *,
        write: RowWriter,
        read_quota: QuotaReader,
        drain_delay_seconds: float = _DRAIN_DELAY_SECONDS,
        queue_limit: int = _QUEUE_LIMIT,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._write: Final = write
        self._read_quota: Final = read_quota
        self._drain_delay_seconds: Final = drain_delay_seconds
        self._sleep: Final = sleep
        self._queue: Final[asyncio.Queue[DeploymentErrorRow]] = asyncio.Queue(maxsize=queue_limit)
        self._drain: asyncio.Task[None] | None = None

    async def async_log_failure_event(
        self,
        kwargs: Mapping[str, object],
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        if not error_logging_enabled():
            return
        call: Final = failed_call_in(kwargs)
        if call is None:
            return
        row: Final = error_row(
            call=call,
            snapshot=await self._read_quota(call.model_id) if call.model_id else NO_QUOTA,
            retry_after=retry_after_seconds(kwargs.get("exception")),
        )
        try:
            self._queue.put_nowait(row)
        except asyncio.QueueFull:
            verbose_proxy_logger.warning("Error log buffer is full, dropping a failed attempt on %s", row.model_id)
            return
        if self._drain is None or self._drain.done():
            self._drain = asyncio.create_task(self._drain_buffer())

    async def flush(self) -> None:
        """Write what is buffered right now, without waiting out the debounce."""
        rows: Final = tuple(self._queue.get_nowait() for _ in range(self._queue.qsize()))
        if not rows:
            return
        try:
            await self._write(rows)
        except Exception as e:  # noqa: BLE001  # a diagnostic row must never fail a request or kill the drain
            verbose_proxy_logger.warning("Could not write %d error log row(s): %s", len(rows), e)

    async def _drain_buffer(self) -> None:
        """
        Wait for the retry storm to settle, then write it in one statement.

        A pool failing over walks several keys for one request, and each attempt is
        awaited before the next one starts, so the whole chain arrives within the
        debounce and lands as a single insert.
        """
        while not self._queue.empty():
            await self._sleep(self._drain_delay_seconds)
            await self.flush()


_DEPLOYMENT_ADAPTER: Final = TypeAdapter(Mapping[str, object])


async def live_quota_snapshot(model_id: str) -> QuotaSnapshot:
    """
    What the refused key's counters read, taken from the router serving traffic.

    Read here rather than handed down from the router because this runs inline before
    the retry, so the counter still holds this attempt's own increment. A router with
    quota routing off has no enforcer, so one is built here to report the configured
    caps against counts of zero, and `enforced` is what tells those zeros apart from a
    key that genuinely had room.
    """
    from litellm.proxy.proxy_server import llm_router

    if llm_router is None:
        return NO_QUOTA
    deployment: Final = llm_router.get_model_info(model_id)
    if deployment is None:
        return NO_QUOTA
    reader: Final = llm_router.quota_enforcer or QuotaEnforcer(AtomicWindowCounter(llm_router.cache))
    rows: Final = await reader.usage((_DEPLOYMENT_ADAPTER.validate_python(deployment),))
    return QuotaSnapshot(
        enforced=llm_router.quota_enforcer is not None,
        windows=tuple(
            QuotaWindowAtFailure(kind=window.kind, limit=window.limit, used=window.used)
            for row in rows
            for window in row.windows
        ),
    )


async def write_error_rows(rows: Sequence[DeploymentErrorRow]) -> None:
    """
    One insert for everything the debounce collected.

    `skip_duplicates` is what makes a replayed attempt harmless: the row id names the
    attempt, so an insert that has already landed is dropped instead of counting as a
    second refusal. The dumps have to stay real dicts because prisma's query builder
    decides what is a nested object by `isinstance(value, dict)`.
    """
    from litellm.proxy.proxy_server import prisma_client

    written: Final = await ErrorLogsRepository(prisma_client).table.create_many(
        data=tuple(row.model_dump(by_alias=True) for row in rows), skip_duplicates=True
    )
    verbose_proxy_logger.debug("Wrote %d of %d failed provider attempt(s)", written, len(rows))


def deployment_error_logger() -> DeploymentErrorLogger:
    """The logger the proxy registers, wired to the live router and the live database."""
    return DeploymentErrorLogger(write=write_error_rows, read_quota=live_quota_snapshot)
