"""Auto-detect the Python web framework in use."""

import os
import sys


def detect_framework() -> str:
    source = os.environ.get("TABLOG_SOURCE")
    if source:
        return source

    modules = sys.modules

    if "fastapi" in modules:
        return "FastAPI"
    if "flask" in modules:
        return "Flask"
    if "django.core" in modules or "django" in modules:
        return "Django"
    if "starlette" in modules:
        return "Starlette"
    if "aiohttp" in modules:
        return "aiohttp"
    if "tornado" in modules:
        return "Tornado"
    if "sanic" in modules:
        return "Sanic"
    if "litestar" in modules:
        return "Litestar"

    return "Python"
