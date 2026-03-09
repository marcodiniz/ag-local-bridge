'use strict';

const { MODEL_MAP } = require('../models');
const { sendJson } = require('../utils');

// ─────────────────────────────────────────────
// GET /v1/models
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

module.exports = { handleModels };
