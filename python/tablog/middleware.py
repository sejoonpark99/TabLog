"""
Network middleware for Python backends.

Usage:

    # FastAPI / Starlette (ASGI)
    from tablog.middleware import TablogMiddleware
    app.add_middleware(TablogMiddleware)

    # Flask (WSGI)
    from tablog.middleware import TablogFlaskMiddleware
    TablogFlaskMiddleware(app)
"""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Optional


def _send_network(
    source: str,
    method: str,
    url: str,
    status: int,
    duration_ms: int,
    request_size: int,
    response_size: int,
) -> None:
    from . import _queue, _connected, _initialized, _init, _source as _mod_source

    if not _initialized:
        _init()

    effective_source = source or _mod_source

    msg = {
        "type": "network",
        "source": effective_source,
        "method": method.upper(),
        "url": url,
        "status": status,
        "duration": duration_ms,
        "requestSize": request_size,
        "responseSize": response_size,
        "timestamp": int(time.time() * 1000),
        "direction": "incoming",
    }

    _queue.put(msg)
    print(
        f"[{effective_source}] ↙ {method.upper()} {url}  {status}  {duration_ms}ms",
        flush=True,
    )


class TablogMiddleware:
    """
    ASGI middleware for FastAPI, Starlette, and any ASGI-compatible framework.

        app.add_middleware(TablogMiddleware)
        app.add_middleware(TablogMiddleware, source="MyAPI")
    """

    def __init__(self, app: Any, source: Optional[str] = None) -> None:
        self.app = app
        from .detector import detect_framework
        self.source = source or os.environ.get("TABLOG_SOURCE") or detect_framework()

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        start = time.monotonic()
        method: str = scope.get("method", "GET")
        path: str = scope.get("path", "/")
        query: str = scope.get("query_string", b"").decode()
        url = f"{path}{'?' + query if query else ''}"

        request_size = 0

        async def receive_wrapper() -> dict:
            nonlocal request_size
            message = await receive()
            if message.get("type") == "http.request":
                request_size += len(message.get("body", b""))
            return message

        status_code = 200
        response_size = 0

        async def send_wrapper(message: dict) -> None:
            nonlocal status_code, response_size
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
            elif message["type"] == "http.response.body":
                response_size += len(message.get("body", b""))
            await send(message)

        await self.app(scope, receive_wrapper, send_wrapper)

        duration_ms = int((time.monotonic() - start) * 1000)
        _send_network(self.source, method, url, status_code, duration_ms, request_size, response_size)


class TablogFlaskMiddleware:
    """
    Flask middleware that captures request/response metrics.

        TablogFlaskMiddleware(app)
        # or as a Flask extension:
        ext = TablogFlaskMiddleware()
        ext.init_app(app)
    """

    def __init__(self, app: Any = None, source: Optional[str] = None) -> None:
        from .detector import detect_framework
        self.source = source or os.environ.get("TABLOG_SOURCE") or detect_framework()
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Any) -> None:
        app.before_request(self._before)
        app.after_request(self._after)

    def _before(self) -> None:
        try:
            import flask
            flask.g._tl_start = time.monotonic()
            flask.g._tl_req_size = flask.request.content_length or 0
        except Exception:
            pass

    def _after(self, response: Any) -> Any:
        try:
            import flask
            start = getattr(flask.g, "_tl_start", time.monotonic())
            req_size = getattr(flask.g, "_tl_req_size", 0)
            duration_ms = int((time.monotonic() - start) * 1000)
            _send_network(
                self.source,
                flask.request.method,
                flask.request.path,
                response.status_code,
                duration_ms,
                req_size,
                response.content_length or 0,
            )
        except Exception:
            pass
        return response
