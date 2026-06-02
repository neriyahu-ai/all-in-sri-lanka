# Data Model & Ingestion Guide

## Knowledge Base

All data is stored in Neon PostgreSQL with pgvector. Each table uses the same schema:

```sql
id        UUID    PRIMARY KEY  (auto-generated)
embedding vector(1536)         (text-embedding-ada-002)
text      TEXT                 (Hebrew free-text, searchable)
metadata  JSONB                (structured fields)
```

Similarity search: `embedding <=> query_vector` (cosine distance), top-4 results per query.

---

## Tables

### `hotels` — 51 records

**Source:** `מלונות-Grid view.csv`

**Text format:**
```
סוג: <type> | שם: <name> | איש קשר: <contact> | טלפון: <phone> | מיקום: <location> | wifi: <yes/no> | תיאור: <desc> | מחיר ממוצע: <price> | דירוג Booking: <rating>
```

**Metadata:**
```json
{ "source": "hotels", "name": "...", "location": "..." }
```

**CSV columns:** Name, Place's Name, Contact Name, Place's Number, Location, Is there wifi?, Description, Average price per night, Booking rating

---

### `attractions` — 52 records

**Source:** `אטרקציות-Grid view.csv`

**Text format:** Formatted from Airtable fields (Hebrew)

**Metadata:**
```json
{ "source": "attractions", "name": "...", "location": "..." }
```

---

### `qna` — 139 records

**Source:** `שאלות תשובות כללי-Grid view.csv`

**Text format:**
```
שאלה: <question> תשובה: <answer>
```

**Metadata:**
```json
{ "source": "qna", "topic": "..." }
```

**CSV columns:** נושא (topic), שאלה (question), תשובה (answer)

---

### `n8n_chat_histories` — grows per session

**Managed by:** n8n `memoryPostgresChat` node

**Message types stored:**

```json
// Human message
{ "type": "human", "content": "אני מחפש מלון", "additional_kwargs": {} }

// AI message (with tool call)
{ "type": "ai", "content": "", "tool_calls": [{"name": "hotels", "args": {"input": "מלון"}}] }

// Tool result
{ "type": "tool", "name": "hotels", "content": "[{\"response\": [...]}]" }

// AI final response
{ "type": "ai", "content": "מצאתי לך מלון...", "tool_calls": [] }
```

**Query to inspect a session:**
```sql
SELECT id, message->>'type' as type, LEFT(message->>'content', 100)
FROM n8n_chat_histories
WHERE session_id = 'your-session-id'
ORDER BY id;
```

---

## Re-ingestion Guide

### When to re-ingest

- New hotels/attractions added to Airtable CSV
- Existing records updated
- Embeddings need to be regenerated (model change — rare)

### Steps

1. **Export updated CSV from Airtable** → save to `sri-lanka/` directory

2. **Prepare data** (run locally):
```python
# prepare_data.py
import csv, json

hotels = []
with open('מלונות-Grid view.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        text = f"סוג: מלון | שם: {row['Name']} | טלפון: {row[\"Place's Number\"]} | ..."
        hotels.append({
            "pageContent": text,
            "metadata": {"source": "hotels", "name": row['Name'], "location": row["Place's Name"]}
        })

with open('/tmp/hotels_data.json', 'w') as f:
    json.dump(hotels, f, ensure_ascii=False)
```

3. **Truncate old data** (if replacing all):
```sql
TRUNCATE TABLE hotels;
-- or for incremental: no truncation needed
```

4. **Run ingestion** (`ingest_neon_v2.py`):
```python
# For each item:
# 1. Call OpenRouter embeddings API
vec = embed(item["pageContent"])  # returns list of 1536 floats

# 2. Insert via psql
sql = f"INSERT INTO hotels (embedding, text, metadata) VALUES ('{vec_str}'::vector, '{text}', '{meta}'::jsonb);"
subprocess.run(["psql", NEON_CONN, "-c", sql])
```

5. **Verify:**
```sql
SELECT COUNT(*) FROM hotels;
-- Should match number of CSV rows
```

---

## Embedding Configuration

| Setting | Value |
|---------|-------|
| Model | `text-embedding-ada-002` |
| Provider | OpenAI (via "Clients OpenAI" credential in n8n) |
| Dimensions | 1536 |
| Batch size | 1 (sequential, 150ms delay between calls) |
| Ingestion rate | ~7 records/second |

**Total ingestion time:** ~27 seconds for all 242 records (51 + 52 + 139)

---

## Data Quality Notes

- All text is in Hebrew — queries must also be in Hebrew for best results (the system prompt instructs the agent accordingly)
- Phone numbers are stored as-is from Airtable (format varies: some with country code, some without)
- The QnA data comes from traveler forums — accuracy is not guaranteed (the tool description explicitly states this)
- Driver data (`נהגים-Grid view.csv`) is reference only — driver bookings go through a webhook, not vector search
