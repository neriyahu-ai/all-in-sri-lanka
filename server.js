const express = require('express');
const path = require('path');

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

    // Create in Neon
    const neonRes = await fetch(`${N8N}/admin-create-table`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName: neonName }),
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
      const payloads = records.map(r => resolvedMapper(r.fields));
      const BATCH = 5;
      for (let i = 0; i < payloads.length; i += BATCH) {
        await Promise.all(payloads.slice(i, i + BATCH).map(p =>
          fetch(`${N8N}/ingest-record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p),
          })
        ));
        syncStatus[jobId].synced += Math.min(BATCH, payloads.length - i);
      }

      syncStatus[jobId].done = true;
    } catch (e) {
      syncStatus[jobId].done = true;
      syncStatus[jobId].error = e.message;
    }
  })();
});

// Poll sync job status
app.get('/api/sync-status/:jobId', (req, res) => {
  const s = syncStatus[req.params.jobId];
  if (!s) return res.status(404).json({ error: 'job not found' });
  res.json(s);
});

app.listen(PORT, () => console.log(`Admin panel [AIRTABLE PROXY] on port ${PORT}`));
