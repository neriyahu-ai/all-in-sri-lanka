# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run server locally (port 3000)
npm test           # Run all tests (Node built-in test runner, ESM)
node --test tests/custom-sync.test.mjs   # Run a single test file
```

Deploy to Railway (auto-deploys on push, or manually):
```bash
railway up --service 60f09de4-f427-458e-93be-9e384a815362
```

Trigger a Neon sync for a table:
```bash
curl -X POST https://admin-panel-production-106f.up.railway.app/api/sync/<airtableTableId>
curl https://admin-panel-production-106f.up.railway.app/api/sync-status/<jobId>
```

Query Neon directly:
```bash
psql "postgresql://neondb_owner:npg_XlCfkx6nbMc1@ep-red-dust-aqzjle9q-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require" -c "SELECT ..."
```

---

## Architecture

### System Overview

```
Airtable (source data)
    │  admin.html → /api/airtable proxy
    │  /api/sync/:tableId (background job)
    ▼
server.js (Express, Railway)
    │  built-in tables → n8n /webhook/ingest-record
    │  GEMINI_EMBED_TABLES → embedWithGemini() → n8n /webhook/ingest-record
    ▼
Neon PostgreSQL (pgvector)
    hotels(1536) · attractions(1536) · qna(1536)   ← OpenAI ada-002
    drivers(3072)                                   ← Gemini gemini-embedding-001
    n8n_chat_histories
    ▼
n8n Travel Assistant (4veLlcqXhyjLgRWh)
    AI Agent (DeepSeek) + 4× vectorStorePGVector tools + memoryPostgresChat(n8n_chat_histories)
```

### server.js — The Admin Panel Backend

Express app deployed on Railway at `admin-panel-production-106f.up.railway.app`.

**Key constants:**
- `BASE_ID = 'appRQcniFTsieCxkl'` — Airtable base
- `N8N = 'https://all-in-n8n.up.railway.app/webhook'` — n8n webhooks
- `N8N_BOT_WORKFLOW = '4veLlcqXhyjLgRWh'` — production travel bot (DeepSeek + Postgres memory); also used by `addToolNodeToWorkflow()`
- `BUILTIN_NEON` — maps Airtable table IDs → Neon table names
- `BUILTIN_MAP` — maps Airtable table IDs → payload formatter functions
- `GEMINI_EMBED_TABLES` — subset of `BUILTIN_NEON` that use Gemini embedding instead of n8n's ingest path

**Sync flow (`/api/sync/:tableId`):**
1. Returns immediately with `{ jobId }`, runs in background
2. Fetches all records from Airtable (paginated, `returnFieldsByFieldId=true`)
3. If table is in `GEMINI_EMBED_TABLES`: calls `embedWithGemini()` locally, sends `{ type, _embedding, _rawText, _metadata }` to n8n
4. Otherwise: sends formatted payload directly to n8n `ingest-record` (n8n embeds with OpenAI ada-002)
5. For `GEMINI_EMBED_TABLES` or custom tables: calls `addToolNodeToWorkflow()` to inject a `vectorStorePGVector` + `embeddingsGoogleGemini` node pair into the bot workflow
6. Poll status via `/api/sync-status/:jobId`

**`lib/sync-utils.mjs`** — ESM module (imported dynamically in server.js):
- `getToolNodeName(tableName)` → `"search_<slug>_tool"`
- `buildVectorToolNode(toolName, neonTable)` → n8n node object
- `buildGeminiEmbeddingsNode(toolName)` → n8n node object

### Embedding Strategy

| Table | Model | Dimensions | Ingested via |
|-------|-------|-----------|--------------|
| hotels, attractions, qna | OpenAI `text-embedding-ada-002` | 1536 | n8n `ingest-record` webhook |
| drivers | Google `gemini-embedding-001` | 3072 | `embedWithGemini()` in server.js → n8n with `_embedding` |
| custom tables | Google `gemini-embedding-001` | 3072 | `embedWithGemini()` in server.js → n8n with `_embedding` |

**Critical:** embedding model at query time must match ingest time. Hotels/attractions/qna use `embeddingsOpenAi` nodes in n8n; drivers uses `embeddingsGoogleGemini`.

### n8n Workflows

| ID | Name | Purpose |
|----|------|---------|
| `4veLlcqXhyjLgRWh` | test | **Production travel bot** (DeepSeek + Postgres memory + 4 search tools); chatTrigger webhookId: `cd147b7a-d9e9-4ca2-850b-9c38cfa45aa2` |
| `fYiguXcH5HThI1m7` | All In Sri Lanka — Travel Assistant | Legacy GPT-4o bot — not in use |
| `u85IKWjfSam7fgAr` | All In Sri Lanka — Data Ingestion | `ingest-record` webhook handler |
| `pgaZHQ2eyN0xEDXy` | All In Admin — Read Records | Admin panel read queries |
| `ki0qogTXTIYd0JBy` | All In Admin — Delete Record | Delete by ID |
| `OTvufAVSyx1HLUJg` | All In Admin — Clear Table | TRUNCATE a table |
| `hq9jfJtkBk8k7jDZ` | All In Admin — Create Neon Table | CREATE TABLE with pgvector |

**n8n API access:**
- Internal REST (`/rest/`): requires `n8n-auth` cookie obtained via `POST /rest/login` with email/password. Session expires in 7 days.
- Public API (`/api/v1/`): `X-N8N-API-KEY` header — key is in `.env`. Settings object only accepts `{ executionOrder: 'v1' }`, any extra field causes 400.
- `typeVersion` must be exact — wrong values cause `"Cannot read properties of undefined (reading 'supplyData')"` runtime errors.

### Admin Panel (admin.html)

Single-page app served as a static file. All data access goes through server REST API — no credentials in the browser.

**Server endpoints used by admin.html:**
- `GET/POST/PATCH/DELETE /api/airtable/:table/:id?` — Airtable proxy (server holds the API key)
- `GET /api/conversations` — list all bot chat sessions (from `n8n_chat_histories`)
- `GET /api/conversations/:sessionId` — full message thread for a session
- `POST /api/sync/:tableId` + `GET /api/sync-status/:jobId` — sync Airtable → Neon

The "🔄 סנכרן לNeon" button in the Drivers section calls `/api/sync/tbluqVYPy7ng3qKJB` and polls `/api/sync-status/:jobId` every 2 seconds.

### Neon Airtable Field IDs

All Airtable field access uses field IDs (not names), fetched with `returnFieldsByFieldId=true`. Field IDs are defined in:
- `server.js` — `BUILTIN_MAP` (server-side sync)
- `admin.html` — `FIELDS` object (browser-side display/edit)

Both must stay in sync when Airtable schema changes.

---

## Environment Variables (Railway)

| Variable | Used by |
|----------|---------|
| `AIRTABLE_API_KEY` | server.js — all Airtable API calls (proxied to browser via `/api/airtable`) |
| `GOOGLE_API_KEY` | server.js — `embedWithGemini()` |
| `NEON_DATABASE_URL` | server.js — `neonPool` (pg client) for `/api/conversations` |

`.env` (local, not committed) contains `N8N_API_KEY` and `N8N_API_URL` for programmatic workflow updates.

---

## Important Constraints

- **n8n ingest does not support `drivers` type natively** — Data Ingestion (`u85IKWjfSam7fgAr`) handles drivers only when `_embedding` is pre-computed and included in the payload. The `Prepare Text` node passes through `_embedding` if present; `Build SQL` uses it directly.
- **SQL injection mitigation in Build SQL:** table names are validated against an `ALLOWED` whitelist; text/metadata use `''` escaping.
- **`lib/sync-utils.mjs` is ESM** — loaded dynamically in `getSyncUtils()` because server.js is CommonJS.
- **Railway timeout:** `/api/sync` responds immediately with a jobId; the actual sync runs as a detached async IIFE.
