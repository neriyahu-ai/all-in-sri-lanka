const express = require('express');
const path = require('path');
const { createRequire } = require('module');

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
const AT_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appRQcniFTsieCxkl';
const N8N = 'https://all-in-n8n.up.railway.app/webhook';

// Built-in tables: Airtable ID → Neon table name (for sync)
const BUILTIN_NEON = {
  tbl81JyV8LSgrcJtr: 'hotels',
  tblwQrQEphUK8PphM: 'attractions',
  tblfKu8Xgja3ObS5F: 'qna',
  tbluqVYPy7ng3qKJB: 'drivers',
};

// Field ID → ingest payload key for built-in tables
const BUILTIN_MAP = {
  tbl81JyV8LSgrcJtr: f => ({ type:'hotels', name:f['fldBx8qZR7IwaXL5n']||'', place_name:f['fldNSi5FmXtVjXMdC']||'', contact_name:f['flddt1mtCe8SyqLeT']||'', phone:f['fld2d8WgxmABllAm5']||'', location:f['fldtjA9doG2MDQCEl']||'', wifi:f['fldCkClyE9mKMmRcP']||'', description:f['fldysYK1Zcx7TwyLO']||'', price:f['fldS6keLJdoarzqSo']||'', rating:f['fldoLnFs1AYm7mJpL']||'' }),
  tblwQrQEphUK8PphM: f => ({ type:'attractions', name:f['fldWyHNf8irp0WHy6']||'', domain:f['fld2lh3OcwXz6Xi4a']||'', phone:f['fld0h3jhso29CraNB']||'', location:f['fldSZQv3JRHXo3Heu']||'', notes:f['fldRE421H2Gpv06Tm']||'', address:f['fldGjjzeMUKypCaYy']||'' }),
  tblfKu8Xgja3ObS5F: f => ({ type:'qna', topic:f['fldOhEDpWC2jekXq3']||'', question:f['fld4nFuEZPdTALZGG']||'', answer:f['fldk6dZ8zSEvEcaZn']||'' }),
  tbluqVYPy7ng3qKJB: f => ({ type:'drivers', company:f['fldaUyf4Mti0wqvD9']||'', contact:f['fldUjQ2QBXoBXfStM']||'', phone:f['fld51YqHfIl41rcB8']||'', notes:f['fldCEVqSt3gTwj4v3']||'' }),
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

    // Create in Neon — custom tables use gemini-embedding-001 (3072-dim)
    const neonRes = await fetch(`${N8N}/admin-create-table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName: neonName, dimensions: 3072 }),
    });
    const neonData = await neonRes.json();

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

      // 3. Clear Neon + wait for worker DELETE to finish
      await fetch(`${N8N}/admin-clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: neonTable }),
      });
      await new Promise(r => setTimeout(r, 4000));

      // 4. Re-ingest in batches of 5
      const isCustom = !BUILTIN_NEON[tableId];
      const payloads = records.map(r => resolvedMapper(r.fields));
      const BATCH = 5;
      for (let i = 0; i < payloads.length; i += BATCH) {
        await Promise.all(payloads.slice(i, i + BATCH).map(p => {
          if (isCustom) {
            // Custom tables: embed with Gemini (768-dim), insert via ingest-record
            return embedWithGemini(p._rawText || JSON.stringify(p))
              .then(vec => fetch(`${N8N}/ingest-record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: neonTable,
                  _embedding: vec,
                  _rawText: p._rawText,
                  _metadata: p._metadata,
                }),
              }))
              .catch(() => {}); // don't abort on single record failure
          }
          return fetch(`${N8N}/ingest-record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
          });
        }));
        syncStatus[jobId].synced += Math.min(BATCH, payloads.length - i);
      }

      syncStatus[jobId].done = true;

      // 5. For custom tables: add search tool node to n8n workflow
      if (!BUILTIN_NEON[tableId]) {
        await addToolNodeToWorkflow(neonTable).catch(e =>
          console.error('addToolNode failed:', e.message)
        );
      }
    } catch (e) {
      syncStatus[jobId].done = true;
      syncStatus[jobId].error = e.message;
    }
  })();
});

// ── Gemini embedding (768-dim) ────────────────────────────────────
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

// ── Add vectorStorePGVector + Gemini embeddings node to n8n workflow ─
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
  const embedNode  = utils.buildGeminiEmbeddingsNode(toolName);

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

app.listen(PORT, () => console.log(`Admin panel [AIRTABLE PROXY] on port ${PORT}`));
