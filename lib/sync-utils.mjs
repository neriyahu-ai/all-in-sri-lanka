import { randomUUID } from 'node:crypto';

const NEON_CRED   = { id: 'm5bMUozFX7SSFtu1', name: 'Neon DB' };
// n8n credential type for Google AI / Gemini is 'googlePalmApi'
const GEMINI_CRED = { id: 'bkU7n0OvPLR6K3Yw', name: 'Google Gemini' };

/**
 * Converts a table name to a valid n8n tool node name.
 * e.g. "My Table" → "search_my_table_tool"
 */
export function getToolNodeName(tableName) {
  const slug = tableName.trim().toLowerCase().replace(/\s+/g, '_');
  return `search_${slug}_tool`;
}

/**
 * Builds an n8n vectorStorePGVector node configured as a retrieval tool.
 */
export function buildVectorToolNode(toolName, neonTable) {
  return {
    id: randomUUID(),
    name: toolName,
    type: '@n8n/n8n-nodes-langchain.vectorStorePGVector',
    typeVersion: 1.3,
    position: [1400, 460],
    parameters: {
      mode: 'retrieve-as-tool',
      toolDescription: `Search the ${neonTable} knowledge base for relevant information.`,
      tableName: neonTable,
      options: {},
    },
    credentials: {
      postgres: NEON_CRED,
    },
  };
}

/**
 * Builds an n8n Google Gemini embeddings node (text-embedding-004, 768-dim).
 */
export function buildGeminiEmbeddingsNode(toolName) {
  return {
    id: randomUUID(),
    name: `${toolName}_embeddings`,
    type: '@n8n/n8n-nodes-langchain.embeddingsGoogleGemini',
    typeVersion: 1,
    position: [1200, 580],
    parameters: {
      modelName: 'text-embedding-004',
      options: {},
    },
    credentials: {
      googlePalmApi: GEMINI_CRED,
    },
  };
}
