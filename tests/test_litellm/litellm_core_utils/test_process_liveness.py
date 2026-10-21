"""Pin ``litellm.litellm_core_utils.process_liveness``.

Symbols pinned here:
  - ``Liveness``
  - ``child_liveness``
  - ``pid_liveness``

These run on every platform: the whole point of the module is that the answer
means the same thing on POSIX and on Windows, where signal 0 is ``CTRL_C_EVENT``
rather than a probe.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from unittest.mock import MagicMock

import pytest

from litellm.litellm_core_utils.process_liveness import (
    Liveness,
    child_liveness,
    pid_liveness,
)


@dataclass(frozen=True, slots=True)
class FakeChild:
    pid: int
    exit_code: int | None

    def poll(self) -> int | None:
        return self.exit_code


def test_pid_liveness_never_signals_on_windows() -> None:
    send_signal = MagicMock()
    result = pid_liveness(4242, platform_name="win32", send_signal=send_signal)
    assert (result, send_signal.call_count) == (Liveness.UNKNOWN, 0)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (None, Liveness.ALIVE),
        (ProcessLookupError(), Liveness.DEAD),
        (PermissionError(), Liveness.ALIVE),
        (OSError(87, "The parameter is incorrect"), Liveness.UNKNOWN),
    ],
)
def test_pid_liveness_maps_posix_signal_outcomes(
    error: BaseException | None, expected: Liveness
) -> None:
    send_signal = MagicMock(side_effect=error)
    result = pid_liveness(555, platform_name="linux", send_signal=send_signal)
    assert (result, send_signal.call_args.args) == (expected, (555, 0))


def test_child_liveness_is_alive_while_the_process_has_not_exited() -> None:
    assert child_liveness(FakeChild(pid=1, exit_code=None)) is Liveness.ALIVE


@pytest.mark.parametrize("exit_code", [0, 1, -15])
def test_child_liveness_is_dead_for_every_exit_code(exit_code: int) -> None:
    assert child_liveness(FakeChild(pid=1, exit_code=exit_code)) is Liveness.DEAD


def test_probing_a_real_child_leaves_it_running_and_then_reports_its_exit() -> None:
    child = subprocess.Popen(
        [sys.executable, "-c", "import sys; sys.stdin.read()"],
        stdin=subprocess.PIPE,
    )
    try:
        while_running = tuple(child_liveness(child) for _ in range(3))
        by_pid_while_running = pid_liveness(child.pid)
        assert child.stdin is not None
        child.stdin.close()
        exit_code = child.wait(timeout=30)
        after_exit = child_liveness(child)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=30)

    assert (while_running, exit_code, after_exit) == (
        (Liveness.ALIVE, Liveness.ALIVE, Liveness.ALIVE),
        0,
        Liveness.DEAD,
    )
    expected_by_pid = (
        Liveness.UNKNOWN if sys.platform == "win32" else Liveness.ALIVE
    )
    assert by_pid_while_running is expected_by_pid
