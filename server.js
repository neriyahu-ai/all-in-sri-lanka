require('dotenv').config();
const express = require('express');
const path = require('path');
const { createRequire } = require('module');
const { Pool } = require('pg');

// ESM helper — sync-utils.mjs is loaded dynamically in async context
let syncUtils = null;
async function getSyncUtils() {
  if (!syncUtils) {
    const { getToolNodeName, buildVectorToolNode, buildGeminiEmbeddingsNode } =
      await import('./lib/sync-utils.mjs');
    syncUtils = { getToolNodeName, buildVectorToolNode, buildGeminiEmbeddingsNode };
  }
  return syncUtils;
}

const app = express();
const PORT = process.env.PORT || 3000;

const neonPool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL ||
    'postgresql://neondb_owner:npg_XlCfkx6nbMc1@ep-red-dust-aqzjle9q-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false },
});
const AT_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appRQcniFTsieCxkl';
const STAGING_BASE = 'appJUuX2pvERkZD7W';
const N8N = 'https://all-in-n8n.up.railway.app/webhook';

// Built-in tables: Airtable ID → Neon table name (for sync)
const BUILTIN_NEON = {
  tbl81JyV8LSgrcJtr: 'hotels',
  tblwQrQEphUK8PphM: 'attractions',
  tblfKu8Xgja3ObS5F: 'qna',
  tbluqVYPy7ng3qKJB: 'drivers',
};

// Tables that use Gemini embedding (vector 3072) instead of n8n ingest-record
const GEMINI_EMBED_TABLES = new Set([]);

// Custom table registry: airtableId → neonTable name (in-memory, resets on restart)
// Persisted when POST /api/tables creates a new table
const customTableRegistry = {};

// Field ID → ingest payload key for built-in tables
const BUILTIN_MAP = {
  tbl81JyV8LSgrcJtr: f => ({ type:'hotels', name:f['fldBx8qZR7IwaXL5n']||'', place_name:f['fldNSi5FmXtVjXMdC']||'', contact_name:f['flddt1mtCe8SyqLeT']||'', phone:f['fld2d8WgxmABllAm5']||'', location:f['fldtjA9doG2MDQCEl']||'', wifi:f['fldCkClyE9mKMmRcP']||'', description:f['fldysYK1Zcx7TwyLO']||'', price:f['fldS6keLJdoarzqSo']||'', rating:f['fldoLnFs1AYm7mJpL']||'' }),
  tblwQrQEphUK8PphM: f => ({ type:'attractions', name:f['fldWyHNf8irp0WHy6']||'', domain:f['fld2lh3OcwXz6Xi4a']||'', phone:f['fld0h3jhso29CraNB']||'', location:f['fldSZQv3JRHXo3Heu']||'', notes:f['fldRE421H2Gpv06Tm']||'', address:f['fldGjjzeMUKypCaYy']||'' }),
  tblfKu8Xgja3ObS5F: f => ({ type:'qna', topic:f['fldOhEDpWC2jekXq3']||'', question:f['fld4nFuEZPdTALZGG']||'', answer:f['fldk6dZ8zSEvEcaZn']||'' }),
  tbluqVYPy7ng3qKJB: f => ({ type:'drivers', company:f['fldaUyf4Mti0wqvD9']||'', contact:f['fldUjQ2QBXoBXfStM']||'', phone:f['fld51YqHfIl41rcB8']||'', notes:f['fldCEVqSt3gTwj4v3']||'', driverName:f['fldsmpfSH4LlTJdcG']||'', driverPhone:f['fldYpQMEUcB45vgph']||'', email:f['fldaxmnOr9toWUDNS']||'', vehicle:f['fldtkOTkPbwSwP1W4']||'', languages:(f['fldSOaHsCeqxq2BLX']||[]).join(', '), rating:f['fldmYMg33kHsgTLoV']||'' }),
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Airtable proxy ────────────────────────────────────────────────
app.all('/api/airtable/:table/:id?', async (req, res) => {
  if (!AT_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not set' });
  const { table, id } = req.params;
  let url = `https://api.airtable.com/v0/${BASE_ID}/${table}`;
  if (id) url += '/' + id;
  const qs = new URLSearchParams(req.query).toString();
  if (qs) url += '?' + qs;
  const opts = { method: req.method, headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' } };
  if (['POST','PATCH','PUT'].includes(req.method) && Object.keys(req.body).length)
    opts.body = JSON.stringify(req.body);
  try {
    const r = await fetch(url, opts);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Staging Airtable proxy ──────────────────────────────────────────
app.all('/api/staging/:table/:id?', async (req, res) => {
  if (!AT_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not set' });
  const { table, id } = req.params;
  let url = `https://api.airtable.com/v0/${STAGING_BASE}/${table}`;
  if (id) url += '/' + id;
  const qs = new URLSearchParams(req.query).toString();
  if (qs) url += '?' + qs;
  const opts = { method: req.method, headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' } };
  if (['POST','PATCH','PUT'].includes(req.method) && Object.keys(req.body).length)
    opts.body = JSON.stringify(req.body);
  try {
    const r = await fetch(url, opts);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List all tables (from Airtable meta) ─────────────────────────
app.get('/api/tables', async (req, res) => {
  if (!AT_KEY) return res.status(500).json({ error: 'no key' });
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
      { headers: { 'Authorization': `Bearer ${AT_KEY}` } });
    const d = await r.json();
    // Return id, name, fields summary
    const tables = (d.tables || []).map(t => ({
      id: t.id,
      name: t.name,
      neonTable: BUILTIN_NEON[t.id] || null,
      fields: (t.fields || []).map(f => ({ id: f.id, name: f.name, type: f.type, options: f.options })),
    }));

    // Merge custom table mappings persisted by the create-table endpoint
    if (typeof customTableRegistry === 'object') {
      for (const t of tables) {
        if (!t.neonTable && customTableRegistry[t.id]) {
          t.neonTable = customTableRegistry[t.id];
        }
      }
    }
    res.json(tables);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create new table in Airtable + Neon ──────────────────────────
app.post('/api/tables', async (req, res) => {
  if (!AT_KEY) return res.status(500).json({ error: 'no key' });
  const { name, neonName, fields } = req.body;
  if (!name || !neonName || !fields?.length) return res.status(400).json({ error: 'name, neonName, fields required' });

  try {
    // Create in Airtable
    const atFields = fields.map(f => {
      const base = { name: f.name, type: f.type };
      if (f.type === 'singleSelect' && f.options?.length)
        base.options = { choices: f.options.map(o => ({ name: o })) };
      if (f.type === 'number') base.options = { precision: 0 };
      return base;
    });

    const atRes = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fields: atFields }),
    });
    const atData = await atRes.json();
    if (!atRes.ok) return res.status(atRes.status).json({ error: atData.error?.message || 'Airtable error' });

    // Create in Neon — custom tables use OpenAI ada-002 (1536-dim)
    const neonRes = await fetch(`${N8N}/admin-create-table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName: neonName, dimensions: 1536 }),
    });
    const neonData = await neonRes.json();

    customTableRegistry[atData.id] = neonName;
    res.json({ success: true, airtableId: atData.id, neonTable: neonName, created: neonData.created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sync table: Airtable → Neon (responds immediately, runs in bg) ─
const syncStatus = {};

app.post('/api/sync/:tableId', async (req, res) => {
  const { tableId } = req.params;
  if (!AT_KEY) return res.status(500).json({ error: 'no key' });

  let neonTable = BUILTIN_NEON[tableId] || req.body?.neonTable;
  if (!neonTable) return res.status(400).json({ error: 'neonTable required' });
  const mapper = BUILTIN_MAP[tableId] || null;

  const jobId = Date.now().toString();
  syncStatus[jobId] = { done: false, synced: 0, total: 0, error: null };

  // Respond immediately so Railway doesn't timeout
  res.json({ started: true, jobId, table: neonTable });

  // Run sync in background
  (async () => {
    try {
      // 1. Fetch all records from Airtable
      let records = [], offset;
      do {
        const qs = `pageSize=100&returnFieldsByFieldId=true${offset ? '&offset=' + offset : ''}`;
        const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}?${qs}`,
          { headers: { 'Authorization': `Bearer ${AT_KEY}` } });
        const d = await r.json();
        records = records.concat(d.records || []);
        offset = d.offset;
      } while (offset);

      syncStatus[jobId].total = records.length;

      // 2. Build generic mapper for custom tables
      let resolvedMapper = mapper;
      if (!resolvedMapper) {
        const metaD = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`,
          { headers: { 'Authorization': `Bearer ${AT_KEY}` } }).then(r => r.json());
        const tbl = (metaD.tables || []).find(t => t.id === tableId);
        const fieldMap = {};
        if (tbl) tbl.fields.forEach(f => { fieldMap[f.id] = f.name; });
        resolvedMapper = f => ({
          type: neonTable,
          _rawText: Object.entries(f).map(([k, v]) => `${fieldMap[k] || k}: ${v}`).join(' | '),
          _metadata: { source: neonTable, name: f[Object.keys(f)[0]] || '' },
        });
      }

      // 3. Clear Neon
      if (GEMINI_EMBED_TABLES.has(tableId)) {
        // Gemini tables are managed directly — n8n admin-clear doesn't know about them
        // The ingest-record endpoint handles upsert; we rely on it replacing data
      } else {
        await fetch(`${N8N}/admin-clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: neonTable }),
        });
        await new Promise(r => setTimeout(r, 4000));
      }

      // 4. Re-ingest in batches of 5
      const useGemini = GEMINI_EMBED_TABLES.has(tableId);
      const payloads = records.map(r => resolvedMapper(r.fields));
      const BATCH = 5;
      for (let i = 0; i < payloads.length; i += BATCH) {
        await Promise.all(payloads.slice(i, i + BATCH).map(p => {
          if (useGemini) {
            // Gemini tables: embed locally (3072-dim), insert via ingest-record
            const rawText = p._rawText || buildGeminiText(p, neonTable);
            const meta = p._metadata || { source: neonTable, name: p.driverName || p.contact || p.name || '' };
            return embedWithGemini(rawText)
              .then(vec => fetch(`${N8N}/ingest-record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: neonTable,
                  _embedding: vec,
                  _rawText: rawText,
                  _metadata: meta,
                }),
              }))
              .catch(() => {});
          }
          return fetch(`${N8N}/ingest-record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
          });
        }));
        syncStatus[jobId].synced += Math.min(BATCH, payloads.length - i);
      }

      // 5. Add search tool node to n8n workflow (custom tables only — builtins already have tools)
      if (!BUILTIN_NEON[tableId]) {
        await addToolNodeToWorkflow(neonTable).catch(e =>
          console.error('addToolNode failed:', e.message)
        );
      }

      syncStatus[jobId].done = true;
    } catch (e) {
      syncStatus[jobId].done = true;
      syncStatus[jobId].error = e.message;
    }
  })();
});

// ── Build text for Gemini-embedded tables ────────────────────────
function buildGeminiText(p, tableType) {
  if (tableType === 'drivers') {
    const parts = [`נהג: ${p.driverName || p.contact || ''}`];
    if (p.company)     parts.push(`חברה: ${p.company}`);
    if (p.phone)       parts.push(`טלפון: ${p.phone}`);
    if (p.driverPhone) parts.push(`טלפון נהג: ${p.driverPhone}`);
    if (p.vehicle)     parts.push(`רכב: ${p.vehicle}`);
    if (p.languages)   parts.push(`שפות: ${p.languages}`);
    if (p.rating)      parts.push(`דירוג: ${p.rating}`);
    if (p.notes)       parts.push(`הערות: ${p.notes}`);
    return parts.join(' | ');
  }
  return Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(' | ');
}

// ── Gemini embedding (3072-dim) ────────────────────────────────────
async function embedWithGemini(text) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    }
  );
  const d = await res.json();
  if (!res.ok) throw new Error(d.error?.message || 'Gemini embed failed');
  return d.embedding.values; // float[]
}

// ── Add vectorStorePGVector + OpenAI embeddings node to n8n workflow ─
const N8N_BOT_WORKFLOW = '4veLlcqXhyjLgRWh';
const N8N_INTERNAL = 'https://all-in-n8n.up.railway.app/rest';

async function addToolNodeToWorkflow(neonTable) {
  const utils = await getSyncUtils();
  const toolName = utils.getToolNodeName(neonTable);

  // Login to get cookie
  const cookieRes = await fetch(`${N8N_INTERNAL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrLdapLoginId: 'neronline100@gmail.com', password: 'Neronline100@gmail.com1' }),
  });
  const setCookie = cookieRes.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];

  // Fetch current workflow
  const wfRes = await fetch(`${N8N_INTERNAL}/workflows/${N8N_BOT_WORKFLOW}`, {
    headers: { 'Cookie': cookie },
  });
  const wf = (await wfRes.json()).data;

  // Skip if node already exists
  if (wf.nodes.some(n => n.name === toolName)) return { skipped: true };

  // Build new nodes
  const vectorNode = utils.buildVectorToolNode(toolName, neonTable);
  const embedNode  = utils.buildOpenAiEmbeddingsNode(toolName);

  const agentName = wf.nodes.find(n => n.type.includes('agent'))?.name || 'AI Agent';

  // Patch workflow
  const updatedNodes = [...wf.nodes, vectorNode, embedNode];
  const updatedConns = {
    ...wf.connections,
    [embedNode.name]:  { ai_embedding: [[{ node: vectorNode.name, type: 'ai_embedding', index: 0 }]] },
    [vectorNode.name]: { ai_tool:      [[{ node: agentName,       type: 'ai_tool',      index: 0 }]] },
  };

  await fetch(`${N8N_INTERNAL}/workflows/${N8N_BOT_WORKFLOW}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
    body: JSON.stringify({
      name: wf.name,
      nodes: updatedNodes,
      connections: updatedConns,
      settings: wf.settings || { executionOrder: 'v1' },
    }),
  });

  return { added: toolName };
}

// ── Poll sync job status
app.get('/api/sync-status/:jobId', (req, res) => {
  const s = syncStatus[req.params.jobId];
  if (!s) return res.status(404).json({ error: 'job not found' });
  res.json(s);
});

// ── Staging table IDs ──────────────────────────────────────────────
const STAGING_TABLES = {
  hotels: 'tbley8ucQErKnVC2d',
  attractions: 'tblyvTjMtywW6RQuM',
  drivers: 'tbl54Wol8O0DDg3f7',
  qa: 'tblzN9BOc4ifOJSa2',
};

// ── Staging Neon table names ──────────────────────────────────────
const STAGING_NEON = {
  hotels: 'hotels_v3',
  attractions: 'attractions_v3',
  drivers: 'drivers_v3',
  qa: 'qa_v3',
};

// ── Neon-only staging tables (no Airtable backing) ─────────────────
const NEON_STAGING_TABLES = {
  'qa-curated': 'qa_staging_curated',
};

app.get('/api/neon-staging/:type', async (req, res) => {
  const table = NEON_STAGING_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown type: ' + req.params.type });
  try {
    const { rows } = await neonPool.query(`SELECT id, metadata FROM ${table} ORDER BY id`);
    res.json({ records: rows.map(r => ({ id: r.id, fields: r.metadata })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/neon-staging/:type', async (req, res) => {
  const table = NEON_STAGING_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown type: ' + req.params.type });
  try {
    const meta = { ...(req.body.fields || {}), source: table };
    const { rows } = await neonPool.query(
      `INSERT INTO ${table} (text, metadata) VALUES ($1, $2) RETURNING id`,
      ['', JSON.stringify(meta)]
    );
    res.json({ created: true, id: rows[0].id, fields: meta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/neon-staging/:type/:id', async (req, res) => {
  const table = NEON_STAGING_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown type: ' + req.params.type });
  try {
    const { rows } = await neonPool.query(`SELECT metadata FROM ${table} WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const merged = { ...rows[0].metadata, ...(req.body.fields || {}) };
    await neonPool.query(`UPDATE ${table} SET metadata = $1 WHERE id = $2`, [JSON.stringify(merged), req.params.id]);
    res.json({ updated: true, id: req.params.id, fields: merged });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rebuild the searchable `text` blob from `metadata` for every row (applies edits/deletes)
app.post('/api/neon-staging-sync/:type', async (req, res) => {
  const table = NEON_STAGING_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown type: ' + req.params.type });
  try {
    const { rows } = await neonPool.query(`SELECT id, metadata FROM ${table}`);
    for (const r of rows) {
      const m = r.metadata || {};
      const parts = [];
      if (m.question) parts.push(`question: ${m.question}`);
      if (m.answer) parts.push(`answer: ${m.answer}`);
      if (m.topic) parts.push(`topic: ${m.topic}`);
      parts.push(`source: ${m.source || table}`);
      await neonPool.query(`UPDATE ${table} SET text = $1 WHERE id = $2`, [parts.join(' | '), r.id]);
    }
    res.json({ synced: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/neon-staging/:type/:id', async (req, res) => {
  const table = NEON_STAGING_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: 'Unknown type: ' + req.params.type });
  try {
    await neonPool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    res.json({ deleted: true, id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Staging field IDs → human-readable labels for building text
const STAGING_FIELD_LABELS = {
  hotels: [
    ['fldFVVJ258ujY4zgZ', 'name'],
    ['fld0iwt6sFarAP9m7', 'location'],
    ['fldNZLObOvG7SlX2y', 'price_range'],
    ['fldt6onSC78ypVVcd', 'phone'],
    ['fldLYWCfNBziV7NBd', 'notes'],
    ['fldHkrl6kpEGJjylU', 'source'],
  ],
  attractions: [
    ['fldzXo1rodgcqqIum', 'name'],
    ['fldOTPCq0BYMJCWc6', 'location'],
    ['flddHNOhT0g0eHMF0', 'subtype'],
    ['fldqSZAzoTO492qOF', 'price'],
    ['fldE2jojQUzu4bpaQ', 'notes'],
    ['fldLKZ6DmWYAWIuXU', 'source'],
  ],
  drivers: [
    ['fldJrKXIq4dQoyzGp', 'name'],
    ['fldrxC249eaOBeMug', 'phone'],
    ['fldJ0reuUJWiEumfC', 'location'],
    ['fldew7aJfMLvPBj9m', 'price_notes'],
    ['fldoJF99Kd39xcUwe', 'notes'],
    ['fldlaQgGrWSOLU1dk', 'source'],
  ],
  qa: [
    ['flduKSkhJ2FtXwasr', 'question'],
    ['fldywtYrmPGXP3vD2', 'answer'],
    ['fldwexDGfxkuuNiL7', 'topic'],
    ['fldvDEeCRateACCYB', 'source'],
  ],
};

function safeTruncate(v, maxLen) {
  let s = String(v).slice(0, maxLen || 200);
  // Remove incomplete surrogate pair at the boundary
  const last = s.length - 1;
  if (last >= 0) {
    const code = s.charCodeAt(last);
    if (code >= 0xD800 && code <= 0xDBFF) s = s.slice(0, -1);
  }
  return s;
}

// ── Sync staging Airtable → staging Neon ─────────────────────────
app.post('/api/sync-staging/:type', async (req, res) => {
  const { type } = req.params;
  const stagingTableId = STAGING_TABLES[type];
  const neonTable = STAGING_NEON[type];
  const labels = STAGING_FIELD_LABELS[type];
  if (!stagingTableId || !neonTable || !labels) return res.status(400).json({ error: 'Unknown type: ' + type });

  const jobId = Date.now().toString();
  syncStatus[jobId] = { done: false, synced: 0, total: 0, error: null };
  res.json({ started: true, jobId });

  (async () => {
    try {
      // Read from staging Airtable
      let records = [], offset;
      do {
        const qs = 'pageSize=100&returnFieldsByFieldId=true' + (offset ? '&offset=' + offset : '');
        const r = await fetch(`https://api.airtable.com/v0/${STAGING_BASE}/${stagingTableId}?${qs}`,
          { headers: { 'Authorization': `Bearer ${AT_KEY}` } });
        if (!r.ok) throw new Error('Staging fetch failed: ' + r.status);
        const d = await r.json();
        records = records.concat(d.records || []);
        offset = d.offset;
      } while (offset);

      syncStatus[jobId].total = records.length;

      // Build text + metadata for each record
      const sourceFid = labels.find(([_, l]) => l === 'source')?.[0];
      const rows = records.map(rec => {
        const f = rec.fields || {};
        const parts = [];
        const meta = {};
        for (const [fid, label] of labels) {
          const val = f[fid];
          if (val == null || val === '') continue;
          if (label === 'source') {
            parts.push(`source: ${safeTruncate(val)}`);
            continue;
          }
          parts.push(`${label}: ${val}`);
          meta[label] = val;
        }
        const src = sourceFid ? f[sourceFid] : '';
        if (src) meta.source_chat = safeTruncate(src);
        meta.source = neonTable;
        return { text: parts.join(' | '), metadata: meta };
      });

      // Truncate + bulk insert (batched)
      const client = await neonPool.connect();
      try {
        await client.query(`TRUNCATE TABLE ${neonTable}`);
        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const vals = batch.flatMap(r => [r.text, JSON.stringify(r.metadata)]);
          const placeholders = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(',');
          await client.query(
            `INSERT INTO ${neonTable} (text, metadata) VALUES ${placeholders}`,
            vals
          );
          syncStatus[jobId].synced = Math.min(i + BATCH, rows.length);
        }
      } finally {
        client.release();
      }

      syncStatus[jobId].synced = rows.length;
      syncStatus[jobId].done = true;
    } catch (e) {
      console.error('Staging sync error:', e);
      syncStatus[jobId].done = true;
      syncStatus[jobId].error = e.message;
    }
    // Clean up old status entries after 5 min
    setTimeout(() => delete syncStatus[jobId], 300000);
  })();
});

// ── Production table mappings for approve flow ────────────────────
const PROD_TABLES = {
  hotels: 'tbl81JyV8LSgrcJtr',
  attractions: 'tblwQrQEphUK8PphM',
  drivers: 'tbluqVYPy7ng3qKJB',
  qa: 'tblfKu8Xgja3ObS5F',
};

const PROD_NEON = {
  hotels: 'hotels',
  attractions: 'attractions',
  drivers: 'drivers',
  qa: 'qna',
};

const STAGING_TO_PROD_FIELD = {
  hotels: {
    'fldFVVJ258ujY4zgZ': 'fldNSi5FmXtVjXMdC',
    'fld0iwt6sFarAP9m7': 'fldtjA9doG2MDQCEl',
    'fldNZLObOvG7SlX2y': 'fldS6keLJdoarzqSo',
    'fldt6onSC78ypVVcd': 'fld2d8WgxmABllAm5',
    'fldLYWCfNBziV7NBd': 'fldysYK1Zcx7TwyLO',
  },
  attractions: {
    'fldzXo1rodgcqqIum': 'fldWyHNf8irp0WHy6',
    'fldOTPCq0BYMJCWc6': 'fldSZQv3JRHXo3Heu',
    'flddHNOhT0g0eHMF0': 'fld2lh3OcwXz6Xi4a',
    'fldqSZAzoTO492qOF': 'fld0yJdQ5cUn83L65',
    'fldE2jojQUzu4bpaQ': 'fldRE421H2Gpv06Tm',
  },
  drivers: {
    'fldJrKXIq4dQoyzGp': 'fldUjQ2QBXoBXfStM',
    'fldrxC249eaOBeMug': 'fld51YqHfIl41rcB8',
    'fldoJF99Kd39xcUwe': 'fldCEVqSt3gTwj4v3',
  },
  qa: {
    'fldwexDGfxkuuNiL7': 'fldOhEDpWC2jekXq3',
    'flduKSkhJ2FtXwasr': 'fld4nFuEZPdTALZGG',
    'fldywtYrmPGXP3vD2': 'fldk6dZ8zSEvEcaZn',
  },
};

// ── Approve selected staging records → production ─────────────────
app.post('/api/approve/:type', async (req, res) => {
  const { type } = req.params;
  const { recordIds } = req.body || {};
  if (!Array.isArray(recordIds) || !recordIds.length)
    return res.status(400).json({ error: 'recordIds array required' });

  const prodTable = PROD_TABLES[type];
  const neonTable = PROD_NEON[type];
  const fieldMap = STAGING_TO_PROD_FIELD[type];
  const stagingTableId = STAGING_TABLES[type];
  const labels = STAGING_FIELD_LABELS[type];
  if (!prodTable || !neonTable || !fieldMap || !stagingTableId || !labels)
    return res.status(400).json({ error: 'Unknown type: ' + type });

  const results = { approved: 0, errors: [] };

  for (const recordId of recordIds) {
    try {
      // 1. Fetch from staging Airtable
      const r = await fetch(`https://api.airtable.com/v0/${STAGING_BASE}/${stagingTableId}/${recordId}?returnFieldsByFieldId=true`,
        { headers: { 'Authorization': `Bearer ${AT_KEY}` } });
      if (!r.ok) { results.errors.push({ recordId, error: `Staging fetch failed: ${r.status}` }); continue; }
      const rec = (await r.json());
      const f = rec.fields || {};

      // 2. Map fields to production field IDs
      const prodFields = {};
      for (const [stagFid, prodFid] of Object.entries(fieldMap)) {
        const val = f[stagFid];
        if (val != null && val !== '') prodFields[prodFid] = val;
      }

      // 3. Create in production Airtable
      const p = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${prodTable}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: prodFields }),
      });
      if (!p.ok) {
        const errBody = await p.json().catch(() => ({}));
        results.errors.push({ recordId, error: `Prod Airtable create failed: ${JSON.stringify(errBody)}` });
        continue;
      }

      // 4. Send to n8n ingest-record for embedding (non-fatal)
      try {
        const prodCreated = await p.json();
        const prodRecordId = prodCreated.id;
        const formatter = BUILTIN_MAP[prodTable];
        const useGemini = GEMINI_EMBED_TABLES.has(prodTable);

        if (formatter) {
          const prodFetch = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${prodTable}/${prodRecordId}?returnFieldsByFieldId=true`,
            { headers: { 'Authorization': `Bearer ${AT_KEY}` } });
          if (prodFetch.ok) {
            const prodData = await prodFetch.json();
            const prodFields = prodData.fields || {};
            const ingestPayload = formatter(prodFields);

            if (useGemini) {
              const rawText = buildGeminiText(ingestPayload, neonTable);
              const meta = { source: neonTable };
              const vec = await embedWithGemini(rawText);
              await fetch(`${N8N}/ingest-record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: neonTable, _embedding: vec, _rawText: rawText, _metadata: meta }),
              });
            } else {
              await fetch(`${N8N}/ingest-record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ingestPayload),
              });
            }
          }
        }
      } catch (_e) {
        console.warn(`Approve: Neon ingest skipped for ${type}/${recordId}: ${_e.message}`);
      }

      // 5. Delete from staging Airtable
      await fetch(`https://api.airtable.com/v0/${STAGING_BASE}/${stagingTableId}/${recordId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${AT_KEY}` },
      });

      results.approved++;
    } catch (e) {
      results.errors.push({ recordId, error: e.message });
    }
  }

  res.json(results);
});

// ── Conversations: list sessions ──────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  try {
    const { rows } = await neonPool.query(`
      SELECT
        session_id,
        COUNT(*) AS msg_count,
        MIN(id)  AS first_id,
        MAX(id)  AS last_id,
        (SELECT message->>'content'
         FROM n8n_chat_histories h2
         WHERE h2.session_id = h1.session_id AND h2.message->>'type' = 'human'
         ORDER BY h2.id LIMIT 1) AS first_human_msg
      FROM n8n_chat_histories h1
      GROUP BY session_id
      ORDER BY last_id DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Conversations: messages for a session ─────────────────────────
app.get('/api/conversations/:sessionId', async (req, res) => {
  try {
    const { rows } = await neonPool.query(
      'SELECT id, message FROM n8n_chat_histories WHERE session_id = $1 ORDER BY id',
      [req.params.sessionId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot chat API — server owns Neon persistence ──────────────────
const N8N_CHAT = 'https://all-in-n8n.up.railway.app/webhook/7cb5cf63-c6eb-4837-86ad-e266d2d50a5b';

app.post('/api/bot/chat', async (req, res) => {
  const { sessionId, message, system_prompt, source } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: 'sessionId required' });
  if (!message   || typeof message   !== 'string') return res.status(400).json({ error: 'message required' });
  if (system_prompt !== undefined && typeof system_prompt !== 'string') {
    return res.status(400).json({ error: 'system_prompt must be a string' });
  }
  if (typeof system_prompt === 'string' && system_prompt.length > 20000) {
    return res.status(400).json({ error: 'system_prompt is too long' });
  }

  try {
    // 1. Save human message to Neon immediately
    await neonPool.query(
      'INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2)',
      [sessionId, JSON.stringify({ type: 'human', content: message })]
    );

    // 2. Call n8n — it reads context from Neon via Postgres memory node
    const n8nRes = await fetch(N8N_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The GHL workflow expects the inbound message envelope used by its webhook.
      body: JSON.stringify({
        message: { body: message },
        phone: sessionId,
        contact_id: process.env.N8N_ADMIN_CONTACT_ID || sessionId,
        source: source || 'admin',
        system_prompt: system_prompt || '',
      }),
    });
    const n8nData = await n8nRes.json();
    const output = n8nData.output || '';

    // 3. Save AI response to Neon (server guarantees persistence regardless of n8n memory)
    if (output) {
      await neonPool.query(
        'INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2)',
        [sessionId, JSON.stringify({ type: 'ai', content: output })]
      );
    }

    res.json({ output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bot chat page (new session on every load) ─────────────────────
app.get('/bot', (req, res) => {
  const sessionId = require('crypto').randomUUID();
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>All In Sri Lanka — Travel Bot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; font-family: 'Segoe UI', Arial, sans-serif; background: #f0f4f8; }
    body { display: flex; flex-direction: column; height: 100vh; }
    #header { background: linear-gradient(135deg, #1a6b3a, #2d9e5f); color: #fff; padding: 14px 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    #header h1 { font-size: 1.2rem; font-weight: 600; }
    #header p  { font-size: .8rem; opacity: .85; margin-top: 2px; }
    #prompt-panel { background: #fff; padding: 12px 16px; border-bottom: 1px solid #e0e0e0; }
    #prompt-panel label { display: block; font-size: .82rem; font-weight: 600; margin-bottom: 6px; }
    #system-prompt { width: 100%; min-height: 74px; resize: vertical; border: 1px solid #ccc; border-radius: 10px; padding: 8px 11px; font: .85rem/1.45 'Segoe UI', Arial, sans-serif; direction: rtl; }
    #system-prompt:focus { outline: none; border-color: #2d9e5f; }
    #prompt-panel small { display: block; color: #777; margin-top: 5px; font-size: .72rem; }
    #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .msg { display: flex; align-items: flex-end; gap: 8px; max-width: 80%; }
    .msg.user { align-self: flex-start; flex-direction: row-reverse; }
    .msg.bot  { align-self: flex-end; }
    .bubble { padding: 10px 14px; border-radius: 18px; line-height: 1.5; font-size: .95rem; white-space: pre-wrap; word-break: break-word; }
    .msg.user .bubble { background: #1a6b3a; color: #fff; border-bottom-right-radius: 4px; }
    .msg.bot  .bubble { background: #fff; color: #222; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    .avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; flex-shrink: 0; }
    #typing { display: none; align-self: flex-end; }
    .dots span { display: inline-block; width: 7px; height: 7px; background: #aaa; border-radius: 50%; margin: 0 2px; animation: bounce .9s infinite; }
    .dots span:nth-child(2) { animation-delay: .15s; }
    .dots span:nth-child(3) { animation-delay: .3s; }
    @keyframes bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }
    #input-bar { display: flex; gap: 10px; padding: 12px 16px; background: #fff; border-top: 1px solid #e0e0e0; }
    #input-bar textarea { flex: 1; resize: none; border: 1px solid #ccc; border-radius: 22px; padding: 10px 16px; font-size: .95rem; font-family: inherit; outline: none; line-height: 1.4; max-height: 120px; overflow-y: auto; direction: rtl; }
    #input-bar textarea:focus { border-color: #2d9e5f; }
    #input-bar button { width: 44px; height: 44px; border-radius: 50%; border: none; background: #1a6b3a; color: #fff; font-size: 1.2rem; cursor: pointer; flex-shrink: 0; transition: background .2s; }
    #input-bar button:hover { background: #2d9e5f; }
    #input-bar button:disabled { background: #ccc; cursor: default; }
  </style>
</head>
<body>
<div id="header"><h1>🌴 All In Sri Lanka</h1><p>שאל אותי כל שאלה על טיול בסרי לנקה</p></div>
<div id="prompt-panel">
  <label for="system-prompt">System Prompt לסוכן (אופציונלי)</label>
  <textarea id="system-prompt" placeholder="השאר ריק כדי שהסוכן יפעל ללא System Prompt מותאם..."></textarea>
  <small>נשמר בדפדפן ונשלח בכל הודעה; אינו נשמר בזיכרון השיחה.</small>
</div>
<div id="messages">
  <div class="msg bot"><div class="avatar">🌴</div><div class="bubble">שלום! אני הבוט של All In Sri Lanka 😊<br>אשמח לעזור לך בתכנון הטיול — שאל אותי על מלונות, אטרקציות, נהגים או כל שאלה אחרת!</div></div>
</div>
<div class="msg bot" id="typing"><div class="avatar">🌴</div><div class="bubble"><div class="dots"><span></span><span></span><span></span></div></div></div>
<div id="input-bar">
  <textarea id="msg-input" rows="1" placeholder="כתוב הודעה..." onkeydown="handleKey(event)"></textarea>
  <button id="send-btn" onclick="send()">&#10148;</button>
</div>
<script>
  const SESSION_ID = '${sessionId}';
  const WEBHOOK = '/api/bot/chat';
  const messages = document.getElementById('messages');
  const typing = document.getElementById('typing');
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const systemPrompt = document.getElementById('system-prompt');
  systemPrompt.value = localStorage.getItem('admin_ai_system_prompt') || '';
  systemPrompt.addEventListener('input', () => localStorage.setItem('admin_ai_system_prompt', systemPrompt.value));

  function addMsg(text, role) {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = '<div class="avatar">' + (role==='bot'?'🌴':'👤') + '</div><div class="bubble">' + text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>') + '</div>';
    messages.appendChild(d);
    messages.scrollTop = messages.scrollHeight;
  }

  function handleKey(e) { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send(); } }

  async function send() {
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = ''; input.style.height = '';
    addMsg(text, 'user');
    sendBtn.disabled = true;
    messages.appendChild(typing); typing.style.display = 'flex';
    messages.scrollTop = messages.scrollHeight;
    try {
      const r = await fetch(WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({sessionId:SESSION_ID, message:text, source:'admin', system_prompt:systemPrompt.value}) });
      const d = await r.json();
      typing.style.display = 'none';
      addMsg(d.output || 'שגיאה בתשובה', 'bot');
    } catch(e) {
      typing.style.display = 'none';
      addMsg('שגיאה בחיבור לבוט. נסה שוב.', 'bot');
    }
    sendBtn.disabled = false; input.focus();
  }

  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(input.scrollHeight,120)+'px'; });
</script>
</body>
</html>`);
});

function createApp() { return app; }
module.exports.createApp = createApp;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Admin panel [AIRTABLE PROXY] on port ${PORT}`));
}
