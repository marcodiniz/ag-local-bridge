'use strict';

const { MODEL_MAP } = require('../models');
const { sendJson } = require('../utils');

// ─────────────────────────────────────────────
// GET /v1/models & /models
// ─────────────────────────────────────────────

async function handleModels(ctx, req, res) {
  const data = Object.entries(MODEL_MAP)
    .filter(([, m]) => !m.hidden)
    .map(([id, m]) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: m.owned_by,
    }));
  sendJson(res, 200, { object: 'list', data });
}

// ─────────────────────────────────────────────
// GET /v1beta/models
// ─────────────────────────────────────────────

async function handleGeminiModels(ctx, req, res) {
  const models = Object.entries(MODEL_MAP)
    .filter(([, m]) => !m.hidden)
    .map(([id, m]) => ({
      name: `models/${id}`,
      version: '001',
      displayName: m.name,
      description: m.name,
      inputTokenLimit: m.context || 1048576,
      outputTokenLimit: m.output || 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    }));
  sendJson(res, 200, { models });
}

module.exports = { handleModels, handleGeminiModels };
