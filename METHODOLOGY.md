# Methodology

## Design Principles

### 1. Single Agent over Multi-Agent Routing

The original Flowise chatflow used a **classifier → router → 5 specialized agents** pattern. This was rebuilt in n8n as a **single agent with 4 tools**.

**Why:**
- Multi-agent routing breaks global memory — each agent has its own history
- A single GPT-4o agent with well-described tools makes better routing decisions than a gpt-4o-mini classifier
- Simpler to debug: one execution path, one memory, one system prompt
- Fewer LLM calls per request (no pre-classification step)

**Trade-off:** Slightly higher per-token cost (GPT-4o vs gpt-4o-mini for classification), but better conversation quality and context continuity.

---

### 2. Persistent Memory in Neon

n8n's default `memoryBufferWindow` is **in-process only** — it resets on every new execution. This made every message a fresh conversation.

**Fix:** Replaced with `memoryPostgresChat` backed by Neon PostgreSQL.

- Session key: `sessionId` (passed in request body)
- Storage: `n8n_chat_histories` table, one row per message
- Window: last 20 message pairs loaded on each request
- Cross-topic: one memory node = one history regardless of which tool is called

**Key insight:** With 5 separate memory nodes (one per agent), even if all write to the same Neon table with the same `sessionId`, the timing and ordering of loads/saves between agents is not guaranteed. A single memory node eliminates the race.

---

### 3. Direct DB Ingestion over n8n Pipelines

n8n's `vectorStorePGVector` node in **insert mode** requires a `documentDefaultDataLoader` sub-node, which requires a `textSplitter` sub-node. Feeding data through webhook → PGVector via n8n failed consistently with sub-node resolution errors.

**Fix:** Bypass n8n entirely for ingestion.

```
CSV → Python formatter → OpenRouter embeddings API → psql INSERT
```

This is faster, simpler, and more debuggable. The n8n workflow only handles **retrieval** (the `retrieve-as-tool` mode), never insertion.

---

### 4. Embedding Model Consistency

All three vector tables (`hotels`, `attractions`, `qna`) use `text-embedding-ada-002` (1536 dimensions). The n8n retrieval nodes also embed queries using `text-embedding-ada-002` via the "Clients OpenAI" credential.

Using any other model for ingestion would produce incompatible vectors — queries would return garbage results.

---

### 5. Tool Naming

Tool names are the node names in n8n. OpenAI receives them as function names in tool_calls. Clean, lowercase names (`hotels`, `attractions`, `qna`, `drivers`) make the LLM's tool selection more reliable and the conversation history more readable.

---

## Architecture Evolution

| Phase | What | Why changed |
|-------|------|-------------|
| Original | Flowise: 1 agent + 3 Supabase vector stores | Platform migration to n8n |
| v1 | n8n: classifier → 5 agents | Direct port of Flowise architecture |
| v2 | n8n: 1 agent + 4 tools + per-agent memoryPostgresChat | Fix routing, add persistence |
| v3 (current) | n8n: 1 agent + 4 tools + 1 global memoryPostgresChat | Fix cross-topic memory loss |

---

## n8n API Patterns

n8n exposes two APIs with different capabilities:

| API | Path | Auth | Notes |
|-----|------|------|-------|
| Public API v1 | `/api/v1/` | `X-N8N-API-KEY` header | Create/update/delete workflows. `settings` only accepts `executionOrder`. Cannot PUT `/rest/` paths. |
| Internal REST | `/rest/` | `n8n-auth` cookie (session) | Access executions, full workflow details, activation. Cookie expires in 7 days. |

**Workflow update via API v1 — allowed fields:**
```json
{
  "name": "...",
  "nodes": [...],
  "connections": {...},
  "settings": { "executionOrder": "v1" }
}
```
Any extra field in `settings` causes a `400` error.

**typeVersion matters:** Each node type has a specific `typeVersion` that must match what n8n expects. Wrong versions cause `"Cannot read properties of undefined (reading 'supplyData')"`.

| Node type | typeVersion |
|-----------|-------------|
| `chatTrigger` | 1.4 |
| `agent` | 3.1 |
| `lmChatOpenAi` | 1.3 |
| `memoryPostgresChat` | 1 |
| `vectorStorePGVector` | 1.3 |
| `embeddingsOpenAi` | 1.2 |
| `httpRequestTool` | 4.4 |

---

## Execution Flow (per message)

```
1. Chat Trigger receives { chatInput, sessionId }
2. Agent loads last 20 messages from Neon (by sessionId)
3. Agent sends: [system_prompt] + [history] + [new message] to GPT-4o
4. GPT-4o decides which tool(s) to call
5. For vector tools: embed query (ada-002) → cosine search in Neon → return top-K results
6. For drivers tool: POST to webhook with order details
7. GPT-4o formulates final response
8. Memory node saves [human message + ai response] to Neon
9. Response returned to caller
```

**Typical latency:** 3–15 seconds depending on number of tool calls.

---

## Testing Approach

The bot is tested by sending real HTTP requests to the live webhook and inspecting:
1. **Response quality** — does the answer make sense?
2. **Tool usage** — does `n8n_chat_histories` show the expected `tool_calls`?
3. **Memory continuity** — does the bot remember context from earlier in the session?
4. **Execution logs** — n8n's `/rest/executions` shows per-node timing and status

No unit tests exist for the n8n workflow itself (the platform doesn't support it). The `tests/workflow.test.mjs` file validates workflow structure (node presence, connections) using the n8n SDK.
