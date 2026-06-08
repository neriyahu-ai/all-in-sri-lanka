import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// This import FAILS until server.js exports createApp
import { createApp } from '../server.js';

const WEBHOOK_URL = 'https://all-in-n8n.up.railway.app/webhook/cd147b7a-d9e9-4ca2-850b-9c38cfa45aa2/chat';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let server;
let baseUrl;

async function get(path) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + path, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

before(async () => {
  const app = createApp();
  server = app.listen(0); // random free port
  await new Promise(r => server.once('listening', r));
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
});

after(() => server?.close());

// ── /bot endpoint ────────────────────────────────────────────────────────────

describe('GET /bot', () => {
  test('returns HTTP 200', async () => {
    const { status } = await get('/bot');
    assert.equal(status, 200);
  });

  test('returns HTML with a valid UUID v4 session_id', async () => {
    const { body } = await get('/bot');
    const match = body.match(/SESSION_ID\s*=\s*'([^']+)'/);
    assert.ok(match, 'SESSION_ID not found in HTML');
    assert.match(match[1], UUID_RE, 'SESSION_ID is not a valid UUID v4');
  });

  test('each request produces a different session_id', async () => {
    const extract = body => body.match(/SESSION_ID\s*=\s*'([^']+)'/)?.[1];
    const [r1, r2, r3] = await Promise.all([get('/bot'), get('/bot'), get('/bot')]);
    const ids = [r1, r2, r3].map(r => extract(r.body));
    assert.ok(ids.every(Boolean), 'Some responses missing SESSION_ID');
    const unique = new Set(ids);
    assert.equal(unique.size, 3, `Expected 3 unique IDs, got: ${[...unique].join(', ')}`);
  });

  test('HTML contains the correct n8n webhook URL', async () => {
    const { body } = await get('/bot');
    assert.ok(body.includes(WEBHOOK_URL), 'Webhook URL not found in HTML');
  });

  test('HTML is a full page with input element', async () => {
    const { body } = await get('/bot');
    assert.ok(body.includes('<textarea'), 'No textarea input in HTML');
    assert.ok(body.includes('</html>'), 'Response is not a complete HTML page');
  });
});
