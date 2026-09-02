"""
The marker that lets a failed request give its quota slot back.

Only the moment of the reservation travels with the request. A counter key holds a
salted digest of the credential, and request metadata reaches the logs, so the
refund path rebuilds the keys from the deployment rather than carrying them.

The marker is also what says a reservation exists at all. Several selection paths
never reserve, among them the sync path, pass-through, and a pinned deployment, and
refunding a slot those requests never took would hand out capacity the pool does
not have.
"""

import datetime as dt
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from litellm.exceptions import APIConnectionError, Timeout

QUOTA_RESERVED_AT_KEY: Final = "_litellm_quota_reserved_at"

_METADATA_CHANNELS: Final = ("metadata", "litellm_metadata")


class _StampChannel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reserved_at: float | None = Field(default=None, alias=QUOTA_RESERVED_AT_KEY)


class _StampedModelInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str | int | None = None


class _StampedParams(BaseModel):
    model_config = ConfigDict(extra="ignore", protected_namespaces=())

    metadata: _StampChannel = Field(default_factory=_StampChannel)
    litellm_metadata: _StampChannel = Field(default_factory=_StampChannel)
    model_info: _StampedModelInfo = Field(default_factory=_StampedModelInfo)


class _StampedRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    metadata: _StampChannel = Field(default_factory=_StampChannel)
    litellm_metadata: _StampChannel = Field(default_factory=_StampChannel)
    litellm_params: _StampedParams = Field(default_factory=_StampedParams)


@dataclass(frozen=True, slots=True)
class Reservation:
    deployment_id: str
    reserved_at: dt.datetime


def mark_reservation(request_kwargs: Mapping[str, object], *, reserved_at: dt.datetime) -> None:
    """
    Stamp the request so its failure callback can find the reservation.

    Writes only into a metadata channel litellm already put on the request, which
    is the same dict the call carries into logging, so a request that never had one
    does not grow one here.
    """
    for channel in (request_kwargs.get(name) for name in _METADATA_CHANNELS):
        if isinstance(channel, dict):
            channel[QUOTA_RESERVED_AT_KEY] = reserved_at.timestamp()


def read_reservation(kwargs: Mapping[str, object]) -> Reservation | None:
    """The quota slot a failed request is holding, when it holds one."""
    try:
        request: Final = _StampedRequest.model_validate(kwargs)
    except ValidationError:
        return None
    stamp: Final = next(
        (
            channel.reserved_at
            for channel in (
                request.metadata,
                request.litellm_metadata,
                request.litellm_params.metadata,
                request.litellm_params.litellm_metadata,
            )
            if channel.reserved_at is not None
        ),
        None,
    )
    deployment_id: Final = request.litellm_params.model_info.id
    if stamp is None or deployment_id is None:
        return None
    return Reservation(
        deployment_id=str(deployment_id),
        reserved_at=dt.datetime.fromtimestamp(stamp, dt.timezone.utc),
    )


def request_never_reached_provider(exception: object) -> bool:
    """
    Whether the provider is known not to have counted the request.

    A connection error never landed. A timeout is the request we stopped waiting
    for, which the provider may well have served, so refunding it can overshoot
    the real cap by one; giving the slot back is still the better trade, because a
    request that produced nothing should not cost a free tier one of five per
    minute. Everything else, a provider 429 above all, was counted upstream, and
    counting less than the provider does means overshooting the cap on every call.
    """
    return isinstance(exception, (APIConnectionError, Timeout))
