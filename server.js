const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AT_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appRQcniFTsieCxkl';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Proxy Airtable API — key stays server-side
app.all('/api/airtable/:table/:id?', async (req, res) => {
  if (!AT_KEY) return res.status(500).json({ error: 'AIRTABLE_API_KEY not set' });

  const { table, id } = req.params;
  let url = `https://api.airtable.com/v0/${BASE_ID}/${table}`;
  if (id) url += '/' + id;
  const qs = new URLSearchParams(req.query).toString();
  if (qs) url += '?' + qs;

  const opts = {
    method: req.method,
    headers: { 'Authorization': `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
  };
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && Object.keys(req.body).length) {
    opts.body = JSON.stringify(req.body);
  }

  try {
    const r = await fetch(url, opts);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Admin panel on port ${PORT}`));
