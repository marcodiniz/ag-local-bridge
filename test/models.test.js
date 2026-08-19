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
  it('returns OpenAI-format models list containing Gemini 3.7 models', async () => {
    const ctx = {};
    const req = {};
    const res = createMockRes();

    await handleModels(ctx, req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.object, 'list');
    assert.ok(Array.isArray(res.body.data));

    const modelIds = res.body.data.map((m) => m.id);
    assert.ok(modelIds.includes('antigravity-gemini-3.7-flash-high'));
    assert.ok(modelIds.includes('antigravity-gemini-3.7-flash-medium'));
    assert.ok(modelIds.includes('antigravity-gemini-3.7-flash-low'));
  });
});

describe('handleGeminiModels', () => {
  it('returns Gemini-format models list containing Gemini 3.7 models', async () => {
    const ctx = {};
    const req = {};
    const res = createMockRes();

    await handleGeminiModels(ctx, req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.models));

    const names = res.body.models.map((m) => m.name);
    assert.ok(names.includes('models/antigravity-gemini-3.7-flash-high'));
    assert.ok(names.includes('models/antigravity-gemini-3.7-flash-medium'));
    assert.ok(names.includes('models/antigravity-gemini-3.7-flash-low'));
  });
});
