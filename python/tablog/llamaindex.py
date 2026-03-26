"""
tablog LlamaIndex event handler for the 0.10+ instrumentation API.

Works without LlamaIndex installed — the base class falls back to ``object``
when llama_index is not available.

Usage::

    from tablog.llamaindex import tablog_dispatcher
    dispatcher = tablog_dispatcher(source="my-rag-app")
    # handler is now registered with the root LlamaIndex dispatcher
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

try:
    from llama_index.core.instrumentation.event_handlers import BaseEventHandler
    from llama_index.core.instrumentation.events import BaseEvent
    _Base = BaseEventHandler
    _BaseEvent = BaseEvent
except ImportError:
    _Base = object  # type: ignore
    _BaseEvent = object  # type: ignore

from tablog import _send_raw, _source as _default_source


class TablogEventHandler(_Base):  # type: ignore[misc]
    """LlamaIndex instrumentation event handler that sends RAG events to tablog."""

    def __init__(self, source: Optional[str] = None) -> None:
        if _Base is not object:
            super().__init__()
        self._source = source or _default_source
        # Track LLMPredictStartEvent times keyed by span_id / id
        self._llm_start_times: Dict[str, float] = {}

    @classmethod
    def class_name(cls) -> str:
        return "TablogEventHandler"

    def handle(self, event: Any, **kwargs: Any) -> None:
        """Dispatch to the appropriate handler by event class name."""
        event_type = type(event).__name__
        if event_type == "RetrievalStartEvent":
            self._on_retrieval_start(event)
        elif event_type == "RetrievalEndEvent":
            self._on_retrieval_end(event)
        elif event_type == "LLMPredictStartEvent":
            self._on_llm_start(event)
        elif event_type == "LLMPredictEndEvent":
            self._on_llm_end(event)

    # ── Retrieval ─────────────────────────────────────────────────────────

    def _on_retrieval_start(self, event: Any) -> None:
        # Store start time keyed by event id so we can compute duration on end
        event_id = str(getattr(event, "id_", "") or getattr(event, "id", "") or "")
        self._llm_start_times[f"ret_{event_id}"] = time.time()

    def _on_retrieval_end(self, event: Any) -> None:
        event_id = str(getattr(event, "id_", "") or getattr(event, "id", "") or "")
        start = self._llm_start_times.pop(f"ret_{event_id}", None)
        duration_ms = int((time.time() - start) * 1000) if start is not None else 0

        # query
        query: str = ""
        query_obj = getattr(event, "query", None)
        if query_obj is not None:
            query = str(getattr(query_obj, "query_str", query_obj) or "")

        # nodes
        nodes = list(getattr(event, "nodes", None) or [])
        count = len(nodes)

        top_score: Optional[float] = None
        results = []
        for node_with_score in nodes:
            score = getattr(node_with_score, "score", None)
            if score is not None:
                try:
                    score = float(score)
                    if top_score is None or score > top_score:
                        top_score = score
                except (TypeError, ValueError):
                    score = None

            node = getattr(node_with_score, "node", node_with_score)
            text = str(getattr(node, "text", "") or getattr(node, "get_content", lambda: "")())
            node_id = getattr(node, "node_id", None) or getattr(node, "id_", None)
            results.append({
                "id": str(node_id) if node_id is not None else None,
                "score": score,
                "text": text[:300],
            })

        payload: Dict[str, Any] = {
            "type": "rag",
            "event": "retrieve",
            "source": self._source,
            "timestamp": int(time.time() * 1000),
            "query": query,
            "count": count,
            "topScore": top_score,
            "results": results[:5],
            "duration_ms": duration_ms,
        }
        _send_raw(payload)

        score_str = f"  top={top_score:.2f}" if top_score is not None else ""
        print(
            f"[{self._source}] retrieve  \"{query[:40]}\"  "
            f"{count} results{score_str}  {duration_ms}ms",
            flush=True,
        )

    # ── LLM predict ───────────────────────────────────────────────────────

    def _on_llm_start(self, event: Any) -> None:
        event_id = str(getattr(event, "id_", "") or getattr(event, "id", "") or "")
        self._llm_start_times[f"llm_{event_id}"] = time.time()

    def _on_llm_end(self, event: Any) -> None:
        event_id = str(getattr(event, "id_", "") or getattr(event, "id", "") or "")
        start = self._llm_start_times.pop(f"llm_{event_id}", None)
        duration_ms = int((time.time() - start) * 1000) if start is not None else 0

        model: str = ""
        tokens_in: Optional[int] = None
        tokens_out: Optional[int] = None

        # Try to extract model and token usage from the output
        output = getattr(event, "output", None)
        if output is not None:
            raw = getattr(output, "raw", None)
            if raw is not None:
                try:
                    usage = raw.get("usage") or {}
                    tokens_in = usage.get("prompt_tokens")
                    tokens_out = usage.get("completion_tokens")
                    model = raw.get("model", "")
                except (AttributeError, TypeError):
                    pass

        payload: Dict[str, Any] = {
            "type": "rag",
            "event": "generate",
            "source": self._source,
            "timestamp": int(time.time() * 1000),
            "model": model,
            "duration_ms": duration_ms,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }
        _send_raw(payload)

        tok_str = f"  {tokens_in}→{tokens_out} tokens" if tokens_in is not None else ""
        print(
            f"[{self._source}] generate  {model}  {duration_ms}ms{tok_str}",
            flush=True,
        )


def tablog_dispatcher(source: str | None = None) -> TablogEventHandler:
    """
    Create a :class:`TablogEventHandler` and register it with the root
    LlamaIndex dispatcher (if llama_index is installed).

    Returns the handler so callers can keep a reference if needed.
    """
    handler = TablogEventHandler(source=source)
    try:
        from llama_index.core.instrumentation import get_dispatcher
        get_dispatcher().add_event_handler(handler)
    except ImportError:
        pass
    return handler
