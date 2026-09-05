"""Per-deployment param values that replace what the caller sent.

Everything else in a deployment's ``litellm_params`` is only a default:
``Router._completion`` merges them *under* the request kwargs, so a caller that
sends the param always wins. Pinning inverts that precedence for the named
params, which is what lets an operator serve an agent harness that hardcodes a
value its provider rejects, without the harness knowing.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from pydantic import BaseModel, TypeAdapter, ValidationError

from litellm._logging import verbose_router_logger
from litellm.types.router import PinnedParamValue

PINNED_PARAMS_FIELD: Final = "pinned_params"

# Per-attempt state on the caller's kwargs dict, registered in
# `all_litellm_params` so it never reaches a provider body or a cache key.
RESTORE_POINTS_KWARG: Final = "_litellm_pinned_params_restore"

_NO_PINS: Final[Mapping[str, PinnedParamValue]] = MappingProxyType({})


class _PinCarrier(BaseModel):
    """The one field this module reads out of a deployment's untyped ``litellm_params``."""

    pinned_params: Mapping[str, PinnedParamValue] | None = None


_PIN_CARRIER_ADAPTER: Final[TypeAdapter[_PinCarrier | None]] = TypeAdapter(_PinCarrier | None)
_STASH_ADAPTER: Final[TypeAdapter[tuple[object, ...]]] = TypeAdapter(tuple[object, ...])


@dataclass(frozen=True, slots=True)
class _RestorePoint:
    """What the caller's kwargs held for one key before a pin replaced it."""

    key: str
    had_value: bool
    value: object


def _pinned_params_of(deployment: Mapping[str, object]) -> Mapping[str, PinnedParamValue]:
    try:
        carrier: Final = _PIN_CARRIER_ADAPTER.validate_python(deployment.get("litellm_params"))
    except ValidationError as malformed:
        verbose_router_logger.warning("ignoring malformed %s: %s", PINNED_PARAMS_FIELD, malformed)
        return _NO_PINS
    return (carrier.pinned_params if carrier else None) or _NO_PINS


def _restore_points_of(stashed: object) -> tuple[_RestorePoint, ...]:
    """Only points this module stashed.

    ``kwargs`` starts as the client's request body on a proxy call, so a client can
    send this key. A JSON body cannot produce ``_RestorePoint`` instances, so an
    isinstance check is what stops a forged stash from writing arbitrary kwargs
    (``api_base``, ``api_key``, ...) onto the next attempt.
    """
    if stashed is None:
        return ()
    try:
        elements: Final = _STASH_ADAPTER.validate_python(stashed)
    except ValidationError:
        return ()
    return tuple(point for point in elements if isinstance(point, _RestorePoint))


def pin_deployment_params(
    deployment: Mapping[str, object],
    kwargs: dict[str, object],  # mutable-ok: the router hands this seam its live per-attempt kwargs dict
) -> None:
    """Apply ``deployment``'s pinned params to ``kwargs``, undoing the previous attempt's.

    A retry or fallback reuses one kwargs dict across deployments, so the values the
    caller sent are put back before the next deployment's pins go on. Without that,
    one deployment's pin would silently follow the request onto every later one.
    """
    for point in _restore_points_of(kwargs.pop(RESTORE_POINTS_KWARG, None)):
        if point.had_value:
            kwargs[point.key] = point.value  # rebind-ok: the router reads back the dict it passed
        else:
            kwargs.pop(point.key, None)

    pinned: Final = _pinned_params_of(deployment)
    if not pinned:
        return

    restore_points: Final = tuple(
        _RestorePoint(key=key, had_value=key in kwargs, value=kwargs.get(key)) for key in pinned
    )
    kwargs[RESTORE_POINTS_KWARG] = restore_points  # rebind-ok: per-attempt state the next attempt has to see
    kwargs.update(pinned)
    verbose_router_logger.debug("[PINNED PARAMS] applied %s", pinned)
