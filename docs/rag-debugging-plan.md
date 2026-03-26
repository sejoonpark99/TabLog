# RAG Debugging — Plan

## What tablog captures today (automatic)

If your RAG pipeline makes HTTP calls, the network middleware already captures:

| Call | Captured automatically |
|---|---|
| OpenAI / Anthropic embedding API | method, URL, status, latency, response size |
| Pinecone / Weaviate / Chroma REST | method, URL, status, latency |
| LLM generation (OpenAI, Anthropic) | method, URL, status, latency, response size |

So the timing of every external call is already visible in tablog with no extra setup.
`/slow` and `/trace` already work for these.

---

## What tablog cannot see today

- What was actually **retrieved** — the chunks, document IDs, similarity scores
- How the **prompt was constructed** — which chunks were included, token counts
- **Reranking** — which results were filtered out and why
- **Whether retrieval or generation caused a bad answer** — the hardest RAG question

These require hooking into the pipeline internals, not just the HTTP layer.

---

## Plan: RAG-specific Python middleware

A zero-config integration layer for the two major Python RAG frameworks.
No manual `tablog()` calls needed — just add the hook once.

### LangChain

```python
from tablog.langchain import TablogCallbackHandler

llm = ChatOpenAI(callbacks=[TablogCallbackHandler()])
retriever = vectorstore.as_retriever()
chain = RetrievalQA.from_chain_type(llm=llm, retriever=retriever,
                                     callbacks=[TablogCallbackHandler()])
```

### LlamaIndex

```python
from tablog.llamaindex import TablogEventHandler

Settings.callback_manager = CallbackManager([TablogEventHandler()])
```

---

## Events to capture per framework

### Retrieval

```json
{
  "type": "rag",
  "event": "retrieve",
  "source": "MyRAGApp",
  "query": "what is the refund policy?",
  "topK": 5,
  "results": [
    { "id": "doc_42", "score": 0.91, "text": "Refunds are processed within..." },
    { "id": "doc_17", "score": 0.84, "text": "To request a refund..." }
  ],
  "duration_ms": 38
}
```

### Reranking (if used)

```json
{
  "type": "rag",
  "event": "rerank",
  "source": "MyRAGApp",
  "inputCount": 10,
  "outputCount": 3,
  "dropped": ["doc_5", "doc_8", "doc_12"],
  "duration_ms": 12
}
```

### Prompt construction

```json
{
  "type": "rag",
  "event": "prompt",
  "source": "MyRAGApp",
  "chunks_used": 3,
  "tokens_context": 1842,
  "tokens_total": 2100,
  "truncated": false
}
```

### Generation

```json
{
  "type": "rag",
  "event": "generate",
  "source": "MyRAGApp",
  "model": "gpt-4o",
  "tokens_in": 2100,
  "tokens_out": 187,
  "duration_ms": 1240,
  "finish_reason": "stop"
}
```

---

## New HTTP endpoints for RAG debugging

### `GET /rag`

All RAG pipeline events in order. Shows the complete flow for every query.

```
GET /rag
GET /rag?since=5m
GET /rag?source=MyRAGApp
```

Response: retrieval → rerank → prompt → generate chains, grouped by query.

### `GET /rag/trace?query=refund`

Full trace for a specific query — every step, timings, what was retrieved,
what made it into the prompt, what the model saw.

```json
{
  "query": "what is the refund policy?",
  "steps": [
    { "event": "retrieve", "duration_ms": 38, "topK": 5, "topScore": 0.91 },
    { "event": "rerank",   "duration_ms": 12, "kept": 3, "dropped": 2 },
    { "event": "prompt",   "tokens": 2100, "chunks": 3, "truncated": false },
    { "event": "generate", "duration_ms": 1240, "tokens_out": 187 }
  ],
  "total_ms": 1290,
  "retrieved": [...],
  "prompt_chunks": [...]
}
```

### `GET /rag/quality`

Surfaces potential quality issues automatically:

- Queries where top retrieval score < 0.7 (low confidence retrieval)
- Queries where context was truncated (lost chunks)
- Queries with high latency (>3s end-to-end)
- Queries where generation finished with `finish_reason: length` (cut off)

```
GET /rag/quality
```

### `GET /rag/slow?ms=2000`

RAG queries slower than threshold, broken down by which step was slow
(retrieval vs reranking vs generation).

---

## Terminal display

RAG events in the tablog stream render as a distinct type:

```
[MyRAGApp]  retrieve  "what is the refund policy?"  5 results  top=0.91  38ms
[MyRAGApp]  rerank    5→3 results  12ms
[MyRAGApp]  prompt    2100 tokens  3 chunks
[MyRAGApp]  generate  gpt-4o  1240ms  187 tokens
```

Color-coded: retrieval in blue, generation in magenta, warnings in yellow
(low score, truncated context, slow).

---

## Implementation order

1. **`python/tablog/langchain.py`** — LangChain `BaseCallbackHandler` subclass
   - Hook: `on_retriever_end`, `on_llm_start`, `on_llm_end`, `on_chain_end`
   - Send RAG events over the existing WebSocket connection

2. **`python/tablog/llamaindex.py`** — LlamaIndex `BaseEventHandler` subclass
   - Hook into `RetrieveEvent`, `LLMPredictEvent`, `LLMPredictEndEvent`

3. **`src/server.ts`** — Accept `type: "rag"` messages alongside log/network

4. **`src/formatter.ts`** — `formatRag()` for terminal display

5. **`src/cli.ts`** — `/rag`, `/rag/trace`, `/rag/quality`, `/rag/slow` endpoints

6. **`src/filter.ts`** — Include/exclude RAG events from `/change` menu

---

## Why this matters

RAG bugs are almost never in the application code. They're in:
- **Retrieval quality** — wrong chunks coming back
- **Context construction** — right chunks, wrong order or truncated
- **Prompt design** — the model ignoring the context

Today you debug these by adding print statements throughout your pipeline.
With tablog RAG middleware, one `curl localhost:4242/rag/trace?query=...`
shows the complete picture of what happened for any query.
