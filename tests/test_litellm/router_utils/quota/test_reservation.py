import datetime as dt

import pytest

from litellm.exceptions import (
    APIConnectionError,
    APIError,
    AuthenticationError,
    InternalServerError,
    RateLimitError,
    ServiceUnavailableError,
    Timeout,
)
from litellm.router_utils.quota.reservation import (
    ATTEMPTED_DEPLOYMENT_IDS_KEY,
    QUOTA_RESERVED_AT_KEY,
    mark_attempted_deployment,
    mark_reservation,
    read_attempted_deployment_ids,
    read_reservation,
    request_never_reached_provider,
)

RESERVED_AT = dt.datetime(2026, 9, 1, 14, 32, 30, tzinfo=dt.timezone.utc)
DEPLOYMENT_ID = "d1"
MODEL = "gemini/gemini-2.5-flash"


def deployment(dep_id: str | int | None) -> dict:
    return {"litellm_params": {"model": MODEL}, "model_info": {} if dep_id is None else {"id": dep_id}}


def request_with(channel: str, *, deployment_id: str | None = DEPLOYMENT_ID) -> dict:
    return {
        channel: {},
        "litellm_params": {
            "model": MODEL,
            "model_info": {} if deployment_id is None else {"id": deployment_id},
        },
    }


def failure_kwargs(**stamp: object) -> dict:
    return {
        "litellm_params": {"model": MODEL, "model_info": {"id": DEPLOYMENT_ID}},
        **stamp,
    }


@pytest.mark.parametrize(
    "exception",
    [
        APIConnectionError(message="connection refused", llm_provider="gemini", model=MODEL),
        Timeout(message="read timed out", model=MODEL, llm_provider="gemini"),
    ],
)
def test_a_call_that_produced_nothing_is_refundable(exception: Exception):
    assert request_never_reached_provider(exception) is True


@pytest.mark.parametrize(
    "exception",
    [
        RateLimitError(message="429", llm_provider="gemini", model=MODEL),
        ServiceUnavailableError(message="503", llm_provider="gemini", model=MODEL),
        InternalServerError(message="500", llm_provider="gemini", model=MODEL),
        AuthenticationError(message="401", llm_provider="gemini", model=MODEL),
        APIError(status_code=400, message="bad request", llm_provider="gemini", model=MODEL),
        ValueError("not an llm error at all"),
        None,
    ],
)
def test_a_call_the_provider_answered_is_not_refundable(exception: object):
    assert request_never_reached_provider(exception) is False, (
        "the provider counted this request, so refunding it would overshoot the cap on every call"
    )


@pytest.mark.parametrize("channel", ["metadata", "litellm_metadata"])
def test_a_stamped_request_reads_back_the_reservation(channel: str):
    request = request_with(channel)

    mark_reservation(request, reserved_at=RESERVED_AT)
    reservation = read_reservation(request)

    assert reservation is not None
    assert reservation.deployment_id == DEPLOYMENT_ID
    assert reservation.reserved_at == RESERVED_AT


def test_the_stamp_is_a_bare_timestamp_so_it_survives_json_logging():
    request = request_with("metadata")

    mark_reservation(request, reserved_at=RESERVED_AT)

    assert request["metadata"][QUOTA_RESERVED_AT_KEY] == RESERVED_AT.timestamp()
    assert isinstance(request["metadata"][QUOTA_RESERVED_AT_KEY], float)


def test_marking_never_grows_a_metadata_channel_the_request_did_not_have():
    request = {"litellm_params": {"model": MODEL, "model_info": {"id": DEPLOYMENT_ID}}}

    mark_reservation(request, reserved_at=RESERVED_AT)

    assert request == {"litellm_params": {"model": MODEL, "model_info": {"id": DEPLOYMENT_ID}}}


def test_a_stamp_nested_under_litellm_params_is_still_found():
    kwargs = {
        "litellm_params": {
            "model": MODEL,
            "model_info": {"id": DEPLOYMENT_ID},
            "metadata": {QUOTA_RESERVED_AT_KEY: RESERVED_AT.timestamp()},
        }
    }

    reservation = read_reservation(kwargs)

    assert reservation is not None, "logging moves the request metadata under litellm_params"
    assert reservation.reserved_at == RESERVED_AT


def test_an_unreserved_request_reads_as_nothing_to_refund():
    assert read_reservation(failure_kwargs(metadata={"model_group": "group"})) is None, (
        "several selection paths never reserve, so an unstamped request must not be credited"
    )


def test_a_stamp_without_a_deployment_id_reads_as_nothing_to_refund():
    request = request_with("metadata", deployment_id=None)

    mark_reservation(request, reserved_at=RESERVED_AT)

    assert read_reservation(request) is None, "a refund needs the deployment whose counters were charged"


@pytest.mark.parametrize("stamp", ["not-a-timestamp", None, {}, []])
def test_an_unreadable_stamp_reads_as_nothing_to_refund(stamp: object):
    assert read_reservation(failure_kwargs(metadata={QUOTA_RESERVED_AT_KEY: stamp})) is None


def test_kwargs_that_are_not_a_request_read_as_nothing_to_refund():
    assert read_reservation({"metadata": "a string, not a channel", "litellm_params": 7}) is None


@pytest.mark.parametrize("channel", ["metadata", "litellm_metadata"])
def test_a_marked_deployment_reads_back_as_already_tried(channel: str):
    request = {channel: {}}

    mark_attempted_deployment(request, deployment=deployment(DEPLOYMENT_ID))

    assert read_attempted_deployment_ids(request) == frozenset({DEPLOYMENT_ID})


def test_every_key_the_request_burned_stays_marked_not_just_the_last_one():
    request = {"metadata": {}}

    mark_attempted_deployment(request, deployment=deployment("d1"))
    mark_attempted_deployment(request, deployment=deployment("d2"))

    assert read_attempted_deployment_ids(request) == frozenset({"d1", "d2"}), (
        "a third attempt has to skip both keys the request already spent a slot on"
    )


def test_the_marker_is_weighted_failovers_own_exclusion_list():
    request = {"metadata": {ATTEMPTED_DEPLOYMENT_IDS_KEY: ["already-failed-over"]}}

    mark_attempted_deployment(request, deployment=deployment("d1"))

    assert request["metadata"][ATTEMPTED_DEPLOYMENT_IDS_KEY] == ["already-failed-over", "d1"], (
        "both walks read one accumulator, so a key burned by a retry stays skipped when the request "
        "escalates into weighted failover, and the other way round"
    )
    assert all(isinstance(dep_id, str) for dep_id in request["metadata"][ATTEMPTED_DEPLOYMENT_IDS_KEY]), (
        "the marker travels through JSON logging"
    )


def test_marking_never_grows_a_metadata_channel_the_request_did_not_have_either():
    request: dict = {}

    mark_attempted_deployment(request, deployment=deployment(DEPLOYMENT_ID))

    assert request == {}
    assert read_attempted_deployment_ids(request) == frozenset()


def test_a_deployment_without_an_id_marks_nothing():
    request = {"metadata": {}}

    mark_attempted_deployment(request, deployment=deployment(None))

    assert request == {"metadata": {}}, "an id-less deployment cannot be excluded, so it must not be recorded"


@pytest.mark.parametrize("marker", ["not-a-list", 7, [None], {"d1": True}])
def test_an_unreadable_marker_reads_as_nothing_tried(marker: object):
    assert read_attempted_deployment_ids({"metadata": {ATTEMPTED_DEPLOYMENT_IDS_KEY: marker}}) == frozenset()
