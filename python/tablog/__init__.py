"""
tablog — universal logging function for Python.

Usage:
    from tablog import tablog

    tablog("user logged in")
    tablog("query result:", {"rows": 42})

Logs route to the tablog terminal server (ws://localhost:4242 by default).
Falls back to print() with a [Source] prefix if the server is unreachable.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import threading
import time
from queue import Empty, Queue
from typing import Any, Optional

from .detector import detect_framework

_DEFAULT_PORT = 4242

# ── Module-level state (initialised lazily) ───────────────────────────────
_source: str = "Python"
_port: int = _DEFAULT_PORT
_queue: Queue[dict] = Queue()
_connected = False
_initialized = False
_lock = threading.Lock()


def _get_port() -> int:
    return int(os.environ.get("TABLOG_PORT", str(_DEFAULT_PORT)))


def _serialize(*args: Any) -> str:
    parts: list[str] = []
    for arg in args:
        if isinstance(arg, str):
            parts.append(arg)
        else:
            try:
                parts.append(json.dumps(arg, ensure_ascii=False, default=str))
            except Exception:
                parts.append(repr(arg))
    return " ".join(parts)


def _ws_worker(port: int) -> None:
    """Background daemon thread — maintains a persistent WebSocket connection."""
    global _connected

    try:
        import websocket  # websocket-client
    except ImportError:
        # websocket-client not installed — stay in offline/fallback mode
        return

    while True:
        try:
            ws = websocket.create_connection(
                f"ws://localhost:{port}",
                timeout=3,
                suppress_origin=True,
            )
            _connected = True

            while True:
                try:
                    msg = _queue.get(timeout=0.5)
                    ws.send(json.dumps(msg))
                except Empty:
                    try:
                        ws.ping()
                    except Exception:
                        break
                except Exception:
                    break

            try:
                ws.close()
            except Exception:
                pass
        except Exception:
            pass

        _connected = False
        time.sleep(2)


def _init() -> None:
    global _initialized, _source, _port

    with _lock:
        if _initialized:
            return
        _initialized = True
        _source = detect_framework()
        _port = _get_port()

        t = threading.Thread(target=_ws_worker, args=(_port,), daemon=True)
        t.start()


def _send_raw(event: dict) -> None:
    """Send a pre-built event dict. Used by framework integrations."""
    if not _initialized:
        _init()
    _queue.put(event)


# ── Public API ────────────────────────────────────────────────────────────

def tablog(*args: Any) -> None:
    """
    Universal logging function — drop-in replacement for print().

        tablog("hello world")
        tablog("data:", {"key": "value"})
    """
    if not _initialized:
        _init()

    message = _serialize(*args)

    # Capture caller location
    frame = inspect.stack()[1]
    caller_file = os.path.basename(frame.filename)
    caller_line = frame.lineno

    msg = {
        "type": "log",
        "source": _source,
        "message": message,
        "level": "log",
        "timestamp": int(time.time() * 1000),
        "file": caller_file,
        "line": caller_line,
    }
    _queue.put(msg)
    print(f"[{_source}] {message}", flush=True)


def init(source: Optional[str] = None, port: Optional[int] = None) -> None:
    """
    Explicitly initialise tablog with custom options.
    Called automatically on first tablog() call if not called manually.
    """
    global _initialized, _source, _port

    with _lock:
        if _initialized:
            if source:
                _source = source
            if port:
                _port = port
            return

        _initialized = True
        _source = source or detect_framework()
        _port = port or _get_port()

        t = threading.Thread(target=_ws_worker, args=(_port,), daemon=True)
        t.start()


__all__ = ["tablog", "init", "_send_raw"]
