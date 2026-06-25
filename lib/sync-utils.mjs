import { randomUUID } from 'node:crypto';

const NEON_CRED  = { id: 'm5bMUozFX7SSFtu1', name: 'Neon DB' };
const OPENAI_CRED = { id: 'VbZJ18ooHLyA1KnD', name: 'Clients OpenAI' };

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
 * Builds an n8n OpenAI embeddings node (text-embedding-ada-002, 1536-dim).
 */
export function buildOpenAiEmbeddingsNode(toolName) {
  return {
    id: randomUUID(),
    name: `${toolName}_embeddings`,
    type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi',
    typeVersion: 1.2,
    position: [1200, 580],
    parameters: {
      model: 'text-embedding-ada-002',
      options: {},
    },
    credentials: {
      openAiApi: OPENAI_CRED,
    },
  };
}
