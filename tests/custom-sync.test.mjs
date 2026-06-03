import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// These imports will FAIL until lib/sync-utils.mjs is created
import {
  getToolNodeName,
  buildVectorToolNode,
  buildGeminiEmbeddingsNode,
} from '../lib/sync-utils.mjs';

// ── getToolNodeName ──────────────────────────────────────────────────────────
describe('getToolNodeName', () => {
  test('wraps with search_ prefix and _tool suffix', () => {
    assert.equal(getToolNodeName('restaurants'), 'search_restaurants_tool');
  });

  test('replaces spaces with underscores', () => {
    assert.equal(getToolNodeName('my custom table'), 'search_my_custom_table_tool');
  });

  test('lowercases the name', () => {
    assert.equal(getToolNodeName('Hotels'), 'search_hotels_tool');
  });

  test('collapses multiple spaces', () => {
    assert.equal(getToolNodeName('surf  schools'), 'search_surf_schools_tool');
  });
});

// ── buildVectorToolNode ──────────────────────────────────────────────────────
describe('buildVectorToolNode', () => {
  const toolName = 'search_restaurants_tool';
  const neonTable = 'restaurants';
  let node;

  test('returns an object', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(typeof node, 'object');
  });

  test('name equals toolName', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(node.name, toolName);
  });

  test('type is vectorStorePGVector', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(node.type, '@n8n/n8n-nodes-langchain.vectorStorePGVector');
  });

  test('typeVersion is 1.3', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(node.typeVersion, 1.3);
  });

  test('mode is retrieve-as-tool', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(node.parameters.mode, 'retrieve-as-tool');
  });

  test('tableName param equals neonTable', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(node.parameters.tableName, neonTable);
  });

  test('uses Neon DB postgres credential', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(node.credentials.postgres.name, 'Neon DB');
  });

  test('has a non-empty toolDescription', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.ok(node.parameters.toolDescription?.length > 0);
  });

  test('has an id field (string)', () => {
    node = buildVectorToolNode(toolName, neonTable);
    assert.equal(typeof node.id, 'string');
    assert.ok(node.id.length > 0);
  });
});

// ── buildGeminiEmbeddingsNode ────────────────────────────────────────────────
describe('buildGeminiEmbeddingsNode', () => {
  const toolName = 'search_restaurants_tool';
  let node;

  test('returns an object', () => {
    node = buildGeminiEmbeddingsNode(toolName);
    assert.equal(typeof node, 'object');
  });

  test('name is toolName + _embeddings', () => {
    node = buildGeminiEmbeddingsNode(toolName);
    assert.equal(node.name, `${toolName}_embeddings`);
  });

  test('type is embeddingsGoogleGemini', () => {
    node = buildGeminiEmbeddingsNode(toolName);
    assert.equal(node.type, '@n8n/n8n-nodes-langchain.embeddingsGoogleGemini');
  });

  test('model is text-embedding-004', () => {
    node = buildGeminiEmbeddingsNode(toolName);
    assert.equal(node.parameters.modelName, 'text-embedding-004');
  });

  test('has a Google credential (googlePalmApi key)', () => {
    node = buildGeminiEmbeddingsNode(toolName);
    // n8n uses googlePalmApi as the credential key for Google AI / Gemini nodes
    assert.ok(node.credentials.googlePalmApi, 'missing googlePalmApi credential');
    assert.equal(typeof node.credentials.googlePalmApi.name, 'string');
  });

  test('has an id field', () => {
    node = buildGeminiEmbeddingsNode(toolName);
    assert.equal(typeof node.id, 'string');
    assert.ok(node.id.length > 0);
  });
});
