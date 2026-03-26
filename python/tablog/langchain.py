"""
tablog LangChain callback handler.

Works without LangChain installed — the base class falls back to ``object``
when langchain_core is not available.

Usage::

    from tablog.langchain import TablogCallbackHandler
    handler = TablogCallbackHandler(source="my-rag-app")
    # pass handler to your LangChain chain/retriever
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence, Union

try:
    from langchain_core.callbacks import BaseCallbackHandler as _Base
except ImportError:
    _Base = object  # type: ignore

from tablog import _send_raw, _source as _default_source


class TablogCallbackHandler(_Base):  # type: ignore[misc]
    """LangChain callback handler that sends RAG events to tablog."""

    def __init__(self, source: Optional[str] = None) -> None:
        if _Base is not object:
            super().__init__()
        self._source = source or _default_source
        self._retriever_start: float = 0.0
        self._retriever_query: str = ""
        self._llm_start: float = 0.0
        self._llm_model: str = ""

    # ── Retriever ─────────────────────────────────────────────────────────

    def on_retriever_start(
        self,
        serialized: Dict[str, Any],
        query: str,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        self._retriever_start = time.time()
        self._retriever_query = query

    def on_retriever_end(
        self,
        documents: Sequence[Any],
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> None:
        duration_ms = int((time.time() - self._retriever_start) * 1000)
        docs = list(documents)

        top_score: Optional[float] = None
        results = []
        for doc in docs:
            metadata = getattr(doc, "metadata", {}) or {}
            score = metadata.get("score")
            if score is not None:
                try:
                    score = float(score)
                    if top_score is None or score > top_score:
                        top_score = score
                except (TypeError, ValueError):
                    score = None

            page_content = getattr(doc, "page_content", "") or ""
            results.append({
                "id": metadata.get("id"),
                "score": score,
                "text": page_content[:300],
            })

        event: Dict[str, Any] = {
            "type": "rag",
            "event": "retrieve",
            "source": self._source,
            "timestamp": int(time.time() * 1000),
            "query": self._retriever_query,
            "count": len(docs),
            "topScore": top_score,
            "results": results[:5],
            "duration_ms": duration_ms,
        }
        _send_raw(event)

        score_str = f"  top={top_score:.2f}" if top_score is not None else ""
        print(
            f"[{self._source}] retrieve  \"{self._retriever_query[:40]}\"  "
            f"{len(docs)} results{score_str}  {duration_ms}ms",
            flush=True,
        )

    # ── LLM ───────────────────────────────────────────────────────────────

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        self._llm_start = time.time()
        try:
            self._llm_model = serialized.get("id", [""])[-1]
        except (IndexError, TypeError):
            self._llm_model = ""

    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        tags: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> None:
        duration_ms = int((time.time() - self._llm_start) * 1000)

        tokens_in: Optional[int] = None
        tokens_out: Optional[int] = None
        try:
            usage = response.llm_output.get("token_usage", {})
            tokens_in = usage.get("prompt_tokens")
            tokens_out = usage.get("completion_tokens")
        except (AttributeError, TypeError):
            pass

        event: Dict[str, Any] = {
            "type": "rag",
            "event": "generate",
            "source": self._source,
            "timestamp": int(time.time() * 1000),
            "model": self._llm_model,
            "duration_ms": duration_ms,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }
        _send_raw(event)

        tok_str = f"  {tokens_in}→{tokens_out} tokens" if tokens_in is not None else ""
        print(
            f"[{self._source}] generate  {self._llm_model}  {duration_ms}ms{tok_str}",
            flush=True,
        )
