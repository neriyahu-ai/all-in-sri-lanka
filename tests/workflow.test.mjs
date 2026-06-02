/**
 * TDD Tests — All In Sri Lanka n8n Hybrid Workflow
 *
 * RED phase: all tests fail because workflow.mjs doesn't exist yet.
 * GREEN phase: after workflow.mjs is created, all tests should pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_FILE = resolve(__dir, '..', 'workflow.mjs');

// ── helper: read file once if it exists ─────────────────────────────────────
function readWorkflow() {
  if (!existsSync(WORKFLOW_FILE)) return null;
  return readFileSync(WORKFLOW_FILE, 'utf8');
}

const code = readWorkflow();

// ── 1. File existence ────────────────────────────────────────────────────────
describe('File', () => {
  test('workflow.mjs exists', () => {
    assert.ok(existsSync(WORKFLOW_FILE), 'workflow.mjs not found — create it first');
  });
});

// ── 2. Entry point ───────────────────────────────────────────────────────────
describe('Chat Trigger', () => {
  test('has a Chat Trigger node', () => {
    assert.ok(code, 'workflow.mjs is empty or missing');
    assert.ok(
      code.includes('@n8n/n8n-nodes-langchain.chatTrigger'),
      'Missing chatTrigger node'
    );
  });

  test('chat trigger is public + hostedChat', () => {
    assert.ok(code?.includes('hostedChat'), 'chatTrigger must use hostedChat mode');
    assert.ok(code?.includes("public: true") || code?.includes('public:true'), 'chatTrigger must be public');
  });
});

// ── 3. Hybrid Classifier ─────────────────────────────────────────────────────
describe('Classifier (Hybrid)', () => {
  test('has a classifier AI Agent node', () => {
    assert.ok(
      code?.includes('@n8n/n8n-nodes-langchain.agent'),
      'Missing agent node'
    );
  });

  test('uses gpt-4o-mini for classification', () => {
    assert.ok(
      code?.includes('gpt-4o-mini'),
      'Classifier must use gpt-4o-mini (not gpt-4o)'
    );
  });

  test('has a structured output parser for intent', () => {
    assert.ok(
      code?.includes('@n8n/n8n-nodes-langchain.outputParserStructured'),
      'Missing outputParserStructured node'
    );
  });

  test('intent schema includes hotel/attraction/qna/driver/general', () => {
    assert.ok(code?.includes('"intent"'), 'Intent schema must have "intent" field');
    assert.ok(code?.includes('hotel'), 'Intent schema must include hotel');
    assert.ok(code?.includes('attraction'), 'Intent schema must include attraction');
    assert.ok(code?.includes('qna') || code?.includes('QnA'), 'Intent schema must include qna');
    assert.ok(code?.includes('driver'), 'Intent schema must include driver');
    assert.ok(code?.includes('general'), 'Intent schema must include general');
  });

  test('classifier maxIterations is 1', () => {
    assert.ok(
      code?.includes('maxIterations: 1'),
      'Classifier must have maxIterations: 1 to prevent looping'
    );
  });
});

// ── 4. Switch routing ────────────────────────────────────────────────────────
describe('Switch Router', () => {
  test('has a Switch node', () => {
    // SDK uses switchCase() helper which compiles to n8n-nodes-base.switch
    assert.ok(
      code?.includes('n8n-nodes-base.switch') || code?.includes('switchCase('),
      'Missing switch node (expected switchCase() or n8n-nodes-base.switch)'
    );
  });

  test('switch routes all 4 intents + fallback', () => {
    assert.ok(code?.includes("outputKey: 'hotel'") || code?.includes('outputKey:"hotel"') || code?.includes("hotel"), 'Missing hotel route');
    assert.ok(code?.includes("outputKey: 'attraction'") || code?.includes('attraction'), 'Missing attraction route');
    assert.ok(code?.includes("outputKey: 'qna'") || code?.includes("'qna'") || code?.includes('"qna"'), 'Missing qna route');
    assert.ok(code?.includes("outputKey: 'driver'") || code?.includes('driver'), 'Missing driver route');
    assert.ok(code?.includes('general') || code?.includes('fallback'), 'Missing general/fallback route');
  });
});

// ── 5. PGVector (Neon) Tools ─────────────────────────────────────────────────
describe('PGVector (Neon) Vector Stores', () => {
  test('has 3 vectorStorePGVector nodes (hotels, attractions, qna)', () => {
    const count = (code?.match(/@n8n\/n8n-nodes-langchain\.vectorStorePGVector/g) || []).length;
    assert.ok(count >= 3, `Expected at least 3 PGVector nodes, found ${count}`);
  });

  test('uses retrieve-as-tool mode for vector stores', () => {
    assert.ok(
      code?.includes('retrieve-as-tool'),
      'Vector stores must use retrieve-as-tool mode for agent tools'
    );
  });

  test('has correct table names: hotels, attractions, qna', () => {
    assert.ok(code?.includes("'hotels'") || code?.includes('"hotels"'), 'Missing hotels table');
    assert.ok(code?.includes("'attractions'") || code?.includes('"attractions"'), 'Missing attractions table');
    assert.ok(code?.includes("'qna'") || code?.includes('"qna"'), 'Missing qna table');
  });

  test('uses postgres credential (not supabaseApi)', () => {
    assert.ok(
      code?.includes('postgres:') && !code?.includes('supabaseApi:'),
      'Must use postgres credential type for Neon, not supabaseApi'
    );
  });

  test('uses text-embedding-ada-002', () => {
    assert.ok(
      code?.includes('text-embedding-ada-002'),
      'Must use text-embedding-ada-002 (matching Flowise original)'
    );
  });
});

// ── 6. Synthesis Agents ──────────────────────────────────────────────────────
describe('Synthesis Agents', () => {
  test('uses gpt-4o for synthesis (not mini)', () => {
    assert.ok(
      code?.includes("'gpt-4o'") || code?.includes('"gpt-4o"') || code?.includes("value: 'gpt-4o'"),
      'Synthesis agents must use gpt-4o'
    );
  });

  test('has buffer window memory nodes', () => {
    assert.ok(
      code?.includes('@n8n/n8n-nodes-langchain.memoryBufferWindow'),
      'Missing memoryBufferWindow node'
    );
  });

  test('temperature is 0.3 for synthesis (matching Flowise)', () => {
    assert.ok(
      code?.includes('temperature: 0.3') || code?.includes('temperature:0.3'),
      'Synthesis agents must have temperature 0.3'
    );
  });

  test('system prompt contains "all in sri lanka"', () => {
    assert.ok(
      code?.toLowerCase().includes('all in sri lanka'),
      'System prompt must reference "all in sri lanka"'
    );
  });
});

// ── 7. Driver Tool ───────────────────────────────────────────────────────────
describe('Driver Tool', () => {
  test('has HTTP Request Tool for driver bookings', () => {
    assert.ok(
      code?.includes('n8n-nodes-base.httpRequestTool') || code?.includes('httpRequestTool'),
      'Missing HTTP Request Tool for driver bookings'
    );
  });
});

// ── 8. Supabase URL ──────────────────────────────────────────────────────────
describe('Configuration', () => {
  test('Neon host is documented in code', () => {
    assert.ok(
      code?.includes('neon.tech'),
      'Neon host must be documented in a comment (ep-*.neon.tech)'
    );
  });
});
