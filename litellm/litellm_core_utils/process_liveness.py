"""Whether a process is still running, meaning the same thing on POSIX and Windows.

``os.kill(pid, 0)`` probes existence on POSIX only. On Windows signal 0 is
``CTRL_C_EVENT``, so CPython routes the call to ``GenerateConsoleCtrlEvent``: it can
deliver a real Ctrl+C to a console process group, and it never reports a dead PID.
So a PID alone cannot answer the question there, while a process we spawned ourselves
answers it on either platform through the handle its ``Popen`` already holds.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from enum import Enum
from typing import Final, Protocol, runtime_checkable


class Liveness(Enum):
    ALIVE = "alive"
    DEAD = "dead"
    UNKNOWN = "unknown"


@runtime_checkable
class ChildProcess(Protocol):
    """``subprocess.Popen`` seen through what a liveness check needs of it."""

    @property
    def pid(self) -> int: ...

    def poll(self) -> int | None: ...


def child_liveness(child: ChildProcess) -> Liveness:
    return Liveness.ALIVE if child.poll() is None else Liveness.DEAD


def pid_liveness(
    pid: int,
    *,
    platform_name: str = sys.platform,
    send_signal: Callable[[int, int], None] | None = None,
) -> Liveness:
    if platform_name == "win32":
        return Liveness.UNKNOWN
    send: Final = os.kill if send_signal is None else send_signal
    try:
        send(pid, 0)
    except ProcessLookupError:
        return Liveness.DEAD
    except PermissionError:
        return Liveness.ALIVE
    except OSError:
        return Liveness.UNKNOWN
    return Liveness.ALIVE
