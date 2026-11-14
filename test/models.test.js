'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { handleModels, handleGeminiModels } = require('../src/handlers/models');

function createMockRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    end(data) {
      this.body = data ? JSON.parse(data) : null;
      return this;
    },
  };
}

describe('handleModels', () => {
  it('returns OpenAI-format models list containing Gemini 3.7 and 3.8 models', async () => {
    const ctx = {};
    const req = {};
    const res = createMockRes();

    await handleModels(ctx, req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.object, 'list');
    assert.ok(Array.isArray(res.body.data));

    const modelIds = res.body.data.map((m) => m.id);
    assert.ok(modelIds.includes('antigravity-gemini-4-argon-high'));
    assert.ok(modelIds.includes('antigravity-gemini-4-argon-medium'));
    assert.ok(modelIds.includes('antigravity-gemini-4-argon-low'));
    assert.ok(modelIds.includes('antigravity-gemini-4-hydrogen-xhigh'));
    assert.ok(modelIds.includes('antigravity-gemini-4-hydrogen-high'));
    assert.ok(modelIds.includes('antigravity-gemini-4-hydrogen-medium'));
    assert.ok(modelIds.includes('antigravity-gemini-4-hydrogen-low'));
    assert.ok(modelIds.includes('antigravity-gemini-4-carbon-high'));
    assert.ok(modelIds.includes('antigravity-gemini-4-carbon-medium'));
    assert.ok(modelIds.includes('antigravity-gemini-4-carbon-low'));
    assert.ok(modelIds.includes('antigravity-gemini-4-carbon'));
    assert.ok(modelIds.includes('antigravity-gemini-pro-orchestrator-g1-pro'));
    assert.ok(modelIds.includes('antigravity-gemini-3.8-flash-high'));
    assert.ok(modelIds.includes('antigravity-gemini-3.8-flash-medium'));
    assert.ok(modelIds.includes('antigravity-gemini-3.8-flash-low'));
    assert.ok(modelIds.includes('antigravity-gemini-3.7-flash-high'));
    assert.ok(modelIds.includes('antigravity-gemini-3.7-flash-medium'));
    assert.ok(modelIds.includes('antigravity-gemini-3.7-flash-low'));
    for (const fam of ['opus', 'sonnet']) {
      for (const tier of ['low', 'medium', 'high']) {
        assert.ok(modelIds.includes(`antigravity-claude-${fam}-5-5-${tier}`));
      }
    }
  });
});

describe('handleGeminiModels', () => {
  it('returns Gemini-format models list containing Gemini 3.7, 3.8, and 4 models', async () => {
    const ctx = {};
    const req = {};
    const res = createMockRes();

    await handleGeminiModels(ctx, req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.models));

    const names = res.body.models.map((m) => m.name);
    assert.ok(names.includes('models/antigravity-gemini-4-argon-high'));
    assert.ok(names.includes('models/antigravity-gemini-4-argon-medium'));
    assert.ok(names.includes('models/antigravity-gemini-4-argon-low'));
    assert.ok(names.includes('models/antigravity-gemini-4-hydrogen-xhigh'));
    assert.ok(names.includes('models/antigravity-gemini-4-hydrogen-high'));
    assert.ok(names.includes('models/antigravity-gemini-4-hydrogen-medium'));
    assert.ok(names.includes('models/antigravity-gemini-4-hydrogen-low'));
    assert.ok(names.includes('models/antigravity-gemini-4-carbon-high'));
    assert.ok(names.includes('models/antigravity-gemini-4-carbon-medium'));
    assert.ok(names.includes('models/antigravity-gemini-4-carbon-low'));
    assert.ok(names.includes('models/antigravity-gemini-4-carbon'));
    assert.ok(names.includes('models/antigravity-gemini-3.8-flash-high'));
    assert.ok(names.includes('models/antigravity-gemini-3.8-flash-medium'));
    assert.ok(names.includes('models/antigravity-gemini-3.8-flash-low'));
    assert.ok(names.includes('models/antigravity-gemini-3.7-flash-high'));
    assert.ok(names.includes('models/antigravity-gemini-3.7-flash-medium'));
    assert.ok(names.includes('models/antigravity-gemini-3.7-flash-low'));
  });
});
