import asyncio
import os
import sys
from typing import Final

import pytest

sys.path.insert(0, os.path.abspath("../../.."))

import litellm
from litellm.integrations.custom_logger import CustomLogger
from litellm.router_utils.pinned_params import RESTORE_POINTS_KWARG, pin_deployment_params


def _deployment(**litellm_params: object) -> dict[str, object]:
    return {"model_name": "agent-facing", "litellm_params": {"model": "openai/gpt-4o", **litellm_params}}


class TestPinDeploymentParams:
    """A pinned param must beat the value the caller sent, and must not follow the request onto a failover."""

    def test_pin_replaces_what_the_caller_sent(self):
        kwargs: Final[dict[str, object]] = {"temperature": 0.9}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)

        assert kwargs["temperature"] == 0.3

    def test_pin_applies_when_the_caller_sent_nothing(self):
        kwargs: Final[dict[str, object]] = {}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)

        assert kwargs["temperature"] == 0.3

    @pytest.mark.parametrize("pinned", [0, 0.0, False, ""])
    def test_falsy_pins_still_apply(self, pinned: object):
        """A `temperature: 0` pin is the whole point for a deterministic deployment, so an
        emptiness check anywhere in the apply path would silently drop the operator's value."""
        kwargs: Final[dict[str, object]] = {"temperature": 0.9}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": pinned}), kwargs=kwargs)

        assert kwargs["temperature"] == pinned

    def test_deployment_without_pins_leaves_the_request_alone(self):
        kwargs: Final[dict[str, object]] = {"temperature": 0.9, "top_p": 0.1}

        pin_deployment_params(deployment=_deployment(), kwargs=kwargs)

        assert kwargs == {"temperature": 0.9, "top_p": 0.1}

    def test_pins_only_the_params_it_names(self):
        kwargs: Final[dict[str, object]] = {"temperature": 0.9, "top_p": 0.1}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)

        assert kwargs["top_p"] == 0.1

    def test_failover_gives_the_next_deployment_the_callers_value_back(self):
        """One kwargs dict is reused across retries and fallbacks. A pin that stuck would
        apply a deployment's value to a deployment that never asked for it."""
        kwargs: Final[dict[str, object]] = {"temperature": 0.9}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)
        pin_deployment_params(deployment=_deployment(), kwargs=kwargs)

        assert kwargs["temperature"] == 0.9
        assert RESTORE_POINTS_KWARG not in kwargs

    def test_failover_drops_a_pin_the_caller_never_sent(self):
        kwargs: Final[dict[str, object]] = {}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)
        pin_deployment_params(deployment=_deployment(), kwargs=kwargs)

        assert "temperature" not in kwargs

    def test_failover_between_two_pinned_deployments_uses_the_second(self):
        kwargs: Final[dict[str, object]] = {"temperature": 0.9}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)
        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 1.0}), kwargs=kwargs)

        assert kwargs["temperature"] == 1.0

    def test_third_attempt_still_restores_the_callers_value(self):
        kwargs: Final[dict[str, object]] = {"temperature": 0.9}

        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 0.3}), kwargs=kwargs)
        pin_deployment_params(deployment=_deployment(pinned_params={"temperature": 1.0}), kwargs=kwargs)
        pin_deployment_params(deployment=_deployment(), kwargs=kwargs)

        assert kwargs["temperature"] == 0.9

    @pytest.mark.parametrize(
        "forged",
        [
            [{"key": "api_base", "had_value": True, "value": "https://attacker.example"}],
            ({"key": "api_base", "had_value": True, "value": "https://attacker.example"},),
            ("api_base",),
            {"api_base": "https://attacker.example"},
            "api_base",
        ],
    )
    def test_a_client_supplied_restore_stash_cannot_rewrite_kwargs(self, forged: object):
        """`kwargs` starts life as the client's request body, so the stash key is client
        writable. Honouring a forged one would let a caller set api_base, api_key or any
        other param on the next attempt."""
        kwargs: Final[dict[str, object]] = {"api_base": "https://real.example", RESTORE_POINTS_KWARG: forged}

        pin_deployment_params(deployment=_deployment(), kwargs=kwargs)

        assert kwargs["api_base"] == "https://real.example"
        assert RESTORE_POINTS_KWARG not in kwargs

    @pytest.mark.parametrize("malformed", ["temperature", ["temperature"], {"temperature": {"nested": 1}}, 3])
    def test_malformed_pinned_params_is_ignored(self, malformed: object):
        kwargs: Final[dict[str, object]] = {"temperature": 0.9}

        pin_deployment_params(deployment=_deployment(pinned_params=malformed), kwargs=kwargs)

        assert kwargs == {"temperature": 0.9}


class _CapturedParams(CustomLogger):
    """Reads the params litellm actually built for the provider off the success event."""

    def __init__(self) -> None:
        self.optional_params: dict[str, object] = {}  # mutable-ok: a callback records what it is handed
        self.done: Final = asyncio.Event()

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:
        self.optional_params = dict(kwargs.get("optional_params") or {})
        self.done.set()


async def _params_sent(litellm_params: dict[str, object], **request: object) -> dict[str, object]:
    captured: Final = _CapturedParams()
    router: Final = litellm.Router(
        model_list=[{"model_name": "agent-facing", "litellm_params": {**litellm_params, "api_key": "sk-fake"}}]
    )
    litellm.callbacks = [captured]  # rebind-ok: litellm's documented way to register a logger
    try:
        await router.acompletion(
            model="agent-facing",
            messages=[{"role": "user", "content": "hi"}],
            mock_response="ok",
            **request,
        )
        await asyncio.wait_for(captured.done.wait(), timeout=10)
    finally:
        litellm.callbacks = []  # rebind-ok: as above
    return captured.optional_params


@pytest.mark.asyncio
class TestPinnedParamsReachTheProvider:
    async def test_a_pinned_temperature_replaces_the_one_the_agent_sent(self):
        sent: Final = await _params_sent(
            {"model": "openai/gpt-4o", "pinned_params": {"temperature": 0.3}}, temperature=0.9
        )

        assert sent["temperature"] == 0.3

    async def test_the_pin_itself_is_never_sent_to_the_provider(self):
        """An unregistered top-level kwarg is swept into extra_body, which would send the
        operator's whole pin map to the provider and 400 the request."""
        sent: Final = await _params_sent(
            {"model": "openai/gpt-4o", "pinned_params": {"temperature": 0.3}}, temperature=0.9
        )

        assert "pinned_params" not in sent
        assert "pinned_params" not in (sent.get("extra_body") or {})

    async def test_additional_drop_params_keeps_temperature_from_the_provider(self):
        sent: Final = await _params_sent(
            {"model": "openai/gpt-4o", "additional_drop_params": ["temperature"]}, temperature=0.9
        )

        assert "temperature" not in sent
