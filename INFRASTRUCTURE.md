# Infrastructure

## Services Overview

| Service | Provider | URL | Role |
|---------|----------|-----|------|
| n8n | Railway (`all in server`) | `all-in-n8n.up.railway.app` | Workflow engine + bot runtime |
| n8n Worker | Railway | — | Executes background jobs |
| Database | Neon (serverless Postgres) | `ep-red-dust-aqzjle9q-pooler.c-8.us-east-1.aws.neon.tech` | Vector search + chat history |
| Code repository | GitHub (`neriyahu-ai`) | `github.com/neriyahu-ai/all-in-sri-lanka` | Source of truth |

---

## n8n

- **Instance:** `https://all-in-n8n.up.railway.app` (Railway, Southeast Asia region)
- **Workflow ID:** `fYiguXcH5HThI1m7`
- **Workflow name:** `All In Sri Lanka — Travel Assistant`
- **Nodes:** 11 (single-agent architecture)
- **Active:** Yes

### Credentials configured in n8n

| Name | Type | Used by |
|------|------|---------|
| `Clients OpenAI` | OpenAI API | GPT-4o (agent LLM) + ada-002 (embeddings) |
| `Neon DB` | PostgreSQL | Vector search + chat memory |

### Execution history

Executions are stored in n8n's internal DB and accessible via:
```
GET /rest/executions?workflowId=fYiguXcH5HThI1m7&limit=N
```

---

## Neon (PostgreSQL + pgvector)

**Connection string:**
```
postgresql://neondb_owner:***@ep-red-dust-aqzjle9q-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require
```

### Tables

#### `hotels` — 51 rows
```sql
CREATE TABLE hotels (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  embedding vector(1536),   -- text-embedding-ada-002
  text      TEXT,           -- pageContent: "סוג: X | שם: Y | טלפון: Z | ..."
  metadata  JSONB           -- { source, name, location }
);
```

#### `attractions` — 52 rows
```sql
CREATE TABLE attractions (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  embedding vector(1536),
  text      TEXT,
  metadata  JSONB           -- { source, name, location, ... }
);
```

#### `qna` — 139 rows
```sql
CREATE TABLE qna (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  embedding vector(1536),
  text      TEXT,           -- "שאלה: X תשובה: Y"
  metadata  JSONB           -- { source, topic }
);
```

#### `n8n_chat_histories` — grows per session
```sql
CREATE TABLE n8n_chat_histories (
  id         SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  message    JSONB NOT NULL   -- { type: human|ai|tool, content, tool_calls?, ... }
);
```

### Embedding model

All vectors use `text-embedding-ada-002` (OpenAI / OpenRouter), 1536 dimensions.
Similarity search uses cosine distance via pgvector's `<=>` operator.

---

## Railway Project

**Project:** `all in` (workspace: `all in server`)
**Account:** `neriyahu.ai@gmail.com`

### Active services

| Service | Image | URL | Status |
|---------|-------|-----|--------|
| Primary | `n8nio/n8n` | `all-in-n8n.up.railway.app` | ● Online |
| Worker | `n8nio/n8n` | — | ● Online |
| Chatwoot | railwayapp-templates/chatwoot | `all-in-chat.up.railway.app` | ● Online |
| Postgis | `postgis/postgis:16-3.5` | — | ● Online |
| Postgres | `pgvector/pgvector:pg16` | — | ● Online |
| Redis / Valkey | various | — | ● Online |

> **Flowise and FlowiseWorker were removed** — replaced by the n8n workflow.

---

## Data Ingestion Pipeline

The `/tmp/ingest_neon_v2.py` script (not in repo — one-time run) populated the vector tables:

```python
# For each record in CSV:
# 1. Format as text string (Hebrew)
# 2. Call OpenRouter embeddings API (text-embedding-ada-002)
# 3. INSERT INTO <table> (embedding, text, metadata) via psql subprocess
```

To re-ingest or update data:
1. Edit the source CSV files
2. Run `prepare_data.py` → generates `/tmp/hotels_data.json`, `/tmp/qna_data.json`
3. Run `ingest_neon_v2.py` (truncate table first if replacing all data)

---

## GitHub Repository

**URL:** `https://github.com/neriyahu-ai/all-in-sri-lanka`
**Branch:** `main`
**Account:** `neriyahu-ai` (neriyahu.ai@gmail.com)

### Contents

| File | Description |
|------|-------------|
| `PROJECT.md` | Project overview and architecture |
| `INFRASTRUCTURE.md` | This file |
| `METHODOLOGY.md` | Engineering decisions and methodology |
| `DATA.md` | Data model and ingestion guide |
| `workflow.mjs` | n8n workflow builder code (SDK format) |
| `tests/workflow.test.mjs` | Workflow structure tests |
| `allin backup Chatflow.json` | Original Flowise chatflow (source of truth) |
| `*.csv` | Source data (Hebrew): hotels, attractions, QnA, drivers |
| `.env` | ⛔ Not committed — contains DB + API credentials |
