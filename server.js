const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const N8N = 'https://all-in-n8n.up.railway.app/webhook';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Read all records from a Neon table
app.get('/api/records/:table', async (req, res) => {
  try {
    const r = await fetch(`${N8N}/admin-read?table=${req.params.table}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a record (n8n generates embedding and inserts)
app.post('/api/records', async (req, res) => {
  try {
    const r = await fetch(`${N8N}/ingest-record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a record
app.delete('/api/records/:table/:id', async (req, res) => {
  try {
    const r = await fetch(`${N8N}/admin-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: req.params.table, id: req.params.id }),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update = delete old + create new
app.put('/api/records/:table/:id', async (req, res) => {
  try {
    await fetch(`${N8N}/admin-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: req.params.table, id: req.params.id }),
    });
    const r = await fetch(`${N8N}/ingest-record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Admin panel on port ${PORT}`));
