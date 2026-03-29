'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Import internals we want to unit-test directly
const { handleCountTokens } = require('../src/handlers/anthropic');

// We need to test the conversion helpers — expose them by re-requiring the module
// and checking the exported public functions indirectly via integration.
// For pure unit tests of the conversion logic, we import and test the module.

// ── Minimal mock helpers ──

function makeRes(body = '') {
  const res = {
    _status: null,
    _headers: {},
    _body: '',
    _ended: false,
    setHeader(k, v) {
      this._headers[k] = v;
    },
    writeHead(code) {
      this._status = code;
    },
    write(chunk) {
      this._body += chunk;
    },
    end(chunk) {
      if (chunk) this._body += chunk;
      this._ended = true;
    },
    get headersSent() {
      return this._status !== null;
    },
    get writableEnded() {
      return this._ended;
    },
  };
  return res;
}

function makeReq(body) {
  const buf = Buffer.from(body);
  const req = {
    headers: {},
    _buf: buf,
    _pos: 0,
    on(event, cb) {
      if (event === 'data') cb(buf);
      if (event === 'end') cb();
      return this;
    },
  };
  return req;
}

// ── Tests ──

describe('handleCountTokens', () => {
  it('returns 200 with input_tokens: 0', async () => {
    const ctx = { outputChannel: { appendLine() {} } };
    const req = makeReq('{}');
    const res = makeRes();
    await handleCountTokens(ctx, req, res);
    assert.equal(res._status, 200);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.input_tokens, 0);
  });

  it('handles empty body gracefully', async () => {
    const ctx = { outputChannel: { appendLine() {} } };
    const req = makeReq('');
    const res = makeRes();
    await handleCountTokens(ctx, req, res);
    assert.equal(res._status, 200);
  });
});

describe('Anthropic message conversion', () => {
  // We test through parseAnthropicMessages indirectly by importing the module functions.
  // The actual conversion we validate by importing the handler module and calling helpers.

  it('correctly identifies short-form claude model alias', () => {
    const { resolveModel } = require('../src/models');
    const resolved = resolveModel('claude-sonnet-4-6');
    assert.equal(resolved.value, 1035);
  });

  it('correctly identifies gemini short-form alias', () => {
    const { resolveModel } = require('../src/models');
    const resolved = resolveModel('gemini-3.1-pro-high');
    assert.equal(resolved.value, 1037);
  });
});

describe('Gemini path parser', () => {
  const { parseGeminiPath } = require('../src/handlers/gemini');

  it('parses streamGenerateContent suffix', () => {
    const { model, isStream } = parseGeminiPath('/v1beta/models/gemini-3.1-pro-high:streamGenerateContent');
    assert.equal(model, 'gemini-3.1-pro-high');
    assert.equal(isStream, true);
  });

  it('parses generateContent suffix', () => {
    const { model, isStream } = parseGeminiPath('/v1beta/models/gemini-3.1-pro-high:generateContent');
    assert.equal(model, 'gemini-3.1-pro-high');
    assert.equal(isStream, false);
  });

  it('parses path without operation suffix', () => {
    const { model } = parseGeminiPath('/v1beta/models/gemini-3.1-pro-low');
    assert.equal(model, 'gemini-3.1-pro-low');
  });

  it('returns null model for unrecognised path', () => {
    const { model } = parseGeminiPath('/v1/chat/completions');
    assert.equal(model, null);
  });
});
