# All In Sri Lanka — Session Summary

## מהות הפרויקט

בוט שיחה לתיירות בסרי לנקה. המשתמש שואל שאלות ("מה מחיר נהג ל-3 ימים?", "מה לראות בקנדי?") והבוט מחפש בבסיס ידע עם semantic search ועונה בעברית/אנגלית.

---

## URLs ומשאבים

| שירות | URL | הערות |
|-------|-----|-------|
| **Admin Panel** | https://admin-panel-production-106f.up.railway.app | ממשק ניהול הנתונים |
| **Admin Panel — Sync API** | `POST /api/sync/:tableId` | מחזיר `{ jobId }` |
| **Admin Panel — Sync Status** | `GET /api/sync-status/:jobId` | פולינג עד לסיום |
| **n8n** | https://all-in-n8n.up.railway.app | Workflow engine |
| **n8n Webhook (public)** | https://all-in-n8n.up.railway.app/webhook | ingestion + admin webhooks |
| **n8n REST API (internal)** | https://all-in-n8n.up.railway.app/rest | `/rest/login` + session cookie |
| **n8n Public API** | https://all-in-n8n.up.railway.app/api/v1/ | `X-N8N-API-KEY` header |
| **Airtable Base** | https://airtable.com/appRQcniFTsieCxkl | `BASE_ID = appRQcniFTsieCxkl` |
| **Neon DB (pooler)** | `ep-red-dust-aqzjle9q-pooler.c-8.us-east-1.aws.neon.tech/neondb` | PostgreSQL + pgvector |
| **Railway Project** | https://railway.com (service ID: `60f09de4-f427-458e-93be-9e384a815362`) | hosting ל-server.js |

---

## ארכיטקטורה

```
admin.html (SPA, no credentials in browser)
    │  כל קריאות Airtable → /api/airtable/:table/:id (proxy בשרת)
    │  שיחות בוט → /api/conversations
    ▼
server.js (Express, Railway)
    │  /api/airtable — proxy ל-Airtable (AIRTABLE_API_KEY בשרת)
    │  /api/conversations — query ל-Neon n8n_chat_histories
    │  /api/sync → built-in tables → n8n /webhook/ingest-record
    │  /api/sync → GEMINI_EMBED_TABLES → embedWithGemini() → n8n
    ▼
Neon PostgreSQL + pgvector
    hotels      (1536d) — OpenAI text-embedding-ada-002
    attractions (1536d) — OpenAI text-embedding-ada-002
    qna         (1536d) — OpenAI text-embedding-ada-002
    drivers     (3072d) — Google gemini-embedding-001
    custom      (3072d) — Google gemini-embedding-001
    n8n_chat_histories  — שיחות בוט (session_id, message JSONB)
    ▼
n8n Travel Assistant — 4veLlcqXhyjLgRWh
    AI Agent (DeepSeek deepseek-v4-flash) + 4× vectorStorePGVector tools
    + memoryPostgresChat → n8n_chat_histories
```

---

## n8n Workflows

| Workflow ID | שם | תפקיד |
|------------|-----|--------|
| `4veLlcqXhyjLgRWh` | test | **הבוט הפעיל** (DeepSeek + Postgres memory + 4 search tools); webhookId: `cd147b7a-d9e9-4ca2-850b-9c38cfa45aa2` |
| `fYiguXcH5HThI1m7` | All In Sri Lanka — Travel Assistant | Legacy GPT-4o bot — לא בשימוש |
| `u85IKWjfSam7fgAr` | All In Sri Lanka — Data Ingestion | `ingest-record` webhook handler |
| `pgaZHQ2eyN0xEDXy` | All In Admin — Read Records | קריאת רשומות מ-Neon |
| `ki0qogTXTIYd0JBy` | All In Admin — Delete Record | מחיקה לפי ID |
| `OTvufAVSyx1HLUJg` | All In Admin — Clear Table | TRUNCATE טבלה |
| `hq9jfJtkBk8k7jDZ` | All In Admin — Create Neon Table | CREATE TABLE עם pgvector |

---

## Airtable Table IDs

| Table ID | שם טבלה | Neon table | מודל embedding |
|----------|---------|-----------|----------------|
| `tbl81JyV8LSgrcJtr` | Hotels | `hotels` | OpenAI ada-002 (1536d) |
| `tblwQrQEphUK8PphM` | Attractions | `attractions` | OpenAI ada-002 (1536d) |
| `tblfKu8Xgja3ObS5F` | Q&A | `qna` | OpenAI ada-002 (1536d) |
| `tbluqVYPy7ng3qKJB` | Drivers | `drivers` | Gemini gemini-embedding-001 (3072d) |

---

## כלים ושירותים

| כלי | תפקיד |
|-----|--------|
| **Airtable** | מקור נתונים — מלונות, אטרקציות, נהגים, Q&A |
| **Neon** | PostgreSQL serverless + pgvector |
| **n8n** | Workflow engine — ingestion, bot, admin operations |
| **Railway** | Hosting ל-server.js |
| **Google Gemini** | `gemini-embedding-001` (3072d) — נהגים + custom tables |
| **OpenAI** | `text-embedding-ada-002` (1536d) לטבלאות hotels/attractions/qna |
| **DeepSeek** | `deepseek-v4-flash` — מודל הבוט |
| **LangSmith** | tracing לכל שיחות הבוט — project: `sri-lanka-roni` |
| **Express.js** | Admin backend (server.js, CommonJS) |

---

## שלבי הבנייה

| Commit | מה נבנה |
|--------|---------|
| `77d5c00` | n8n workflow ראשוני + Neon + chatflow JSON |
| `8a64633` | docs מלאים — PROJECT, DATA, INFRASTRUCTURE, METHODOLOGY |
| `b4bade2` | Admin panel — `admin.html` + `server.js` עם proxy ל-Airtable |
| `0d1150c` / `a47c195` | Refactor: קריאה/כתיבה דרך Neon via n8n webhooks |
| `ddc5563` | Railway redeploy trigger |
| `d575e6c` | ניסוי: DeepSeek + Redis לבוט |
| `f7d1ec1` | Background sync + jobId polling (פתרון Railway timeout) |
| `ec079b3` | Custom table sync — Gemini embedding + הזרקת tool nodes |
| `e7acbc4` | תיקון ל-`gemini-embedding-001` (3072d) + `GOOGLE_API_KEY` |
| `b0cab06` | CLAUDE.md מלא עם כל הארכיטקטורה |

---

## אתגרים שנפתרו

**Railway timeout** — sync ארוך מחזיר `{ jobId }` מיד. העבודה רצה ב-async IIFE ברקע. הלקוח מפלל `/api/sync-status/:jobId` כל 2 שניות.

**שני מודלי embedding** — טבלאות ישנות (ada-002/1536d) נשארות כמו שהן; טבלאות חדשות (Gemini/3072d) מוטמעות בשרת לפני השליחה ל-n8n. חייב להתאים בין זמן ingestion לזמן query.

**Dynamic tool injection** — כשמסנכרנים טבלה חדשה, `addToolNodeToWorkflow()` מוסיפה `vectorStorePGVector` + `embeddingsGoogleGemini` ישירות ל-workflow הבוט דרך n8n REST API.

**n8n API quirks** — `typeVersion` חייב מדויק; settings מקבל רק `{ executionOrder }`. Internal `/rest/` עם cookie session vs Public `/api/v1/` עם API key.

---

## REST API Endpoints (server.js)

| Endpoint | Method | תפקיד |
|----------|--------|--------|
| `/api/airtable/:table/:id?` | ALL | Proxy ל-Airtable (מחזיק את ה-API key בשרת) |
| `/api/sync/:tableId` | POST | סנכרון Airtable → Neon (רקע, מחזיר jobId) |
| `/api/sync-status/:jobId` | GET | סטטוס sync |
| `/api/tables` | GET | רשימת טבלאות מ-Airtable meta |
| `/api/tables` | POST | יצירת טבלה חדשה (Airtable + Neon) |
| `/api/conversations` | GET | רשימת sessions מ-`n8n_chat_histories` |
| `/api/conversations/:sessionId` | GET | כל הודעות session |

---

## סטטוס נוכחי (2026-06-07)

- **deployed:** server.js ב-Railway, n8n workflows פעילים
- **Bot:** DeepSeek + Postgres memory, LangSmith tracing פעיל
- **Admin panel:** כל URLs עוברים דרך REST API — אין credentials בדפדפן
- **שיחות:** לשונית "שיחות" בadmin panel, sessions מ-n8n_chat_histories
