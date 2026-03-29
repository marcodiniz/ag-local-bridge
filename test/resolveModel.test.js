'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveModel, MODEL_MAP, DEFAULT_MODEL_KEY } = require('../src/models');

describe('resolveModel', () => {
  // ── Exact match ──
  it('resolves exact model key', () => {
    const result = resolveModel('antigravity-gemini-3-flash');
    assert.equal(result.key, 'antigravity-gemini-3-flash');
    assert.equal(result.value, 1018);
    assert.equal(result.owned_by, 'google');
  });

  it('resolves another exact model key', () => {
    const result = resolveModel('antigravity-claude-sonnet-4-6');
    assert.equal(result.key, 'antigravity-claude-sonnet-4-6');
    assert.equal(result.value, 1035);
    assert.equal(result.owned_by, 'anthropic');
  });

  it('resolves hidden alias "antigravity" to default model', () => {
    const result = resolveModel('antigravity');
    assert.equal(result.key, DEFAULT_MODEL_KEY);
    assert.equal(result.value, MODEL_MAP[DEFAULT_MODEL_KEY].value);
  });

  // ── Partial match ──
  it('resolves partial match — substring of model key', () => {
    const result = resolveModel('claude-sonnet');
    assert.equal(result.key, 'antigravity-claude-sonnet-4-6');
    assert.equal(result.value, 1035);
  });

  it('resolves partial match — model key is substring of input', () => {
    const result = resolveModel('antigravity-gemini-3-flash-latest');
    assert.equal(result.key, 'antigravity-gemini-3-flash');
  });

  it('resolves case-insensitive partial match', () => {
    const result = resolveModel('CLAUDE-SONNET');
    assert.equal(result.key, 'antigravity-claude-sonnet-4-6');
  });

  // ── Default fallback ──
  it('returns default for null input', () => {
    const result = resolveModel(null);
    assert.equal(result.key, DEFAULT_MODEL_KEY);
    assert.equal(result.value, MODEL_MAP[DEFAULT_MODEL_KEY].value);
  });

  it('returns default for undefined input', () => {
    const result = resolveModel(undefined);
    assert.equal(result.key, DEFAULT_MODEL_KEY);
  });

  it('returns default for empty string input', () => {
    const result = resolveModel('');
    assert.equal(result.key, DEFAULT_MODEL_KEY);
  });

  it('returns default for completely unknown model', () => {
    const result = resolveModel('gpt-4-turbo-preview-2024');
    assert.equal(result.key, DEFAULT_MODEL_KEY);
  });

  // ── Result shape ──
  it('result includes key and all MODEL_MAP properties', () => {
    const result = resolveModel('antigravity-gpt-oss-120b');
    assert.equal(result.key, 'antigravity-gpt-oss-120b');
    assert.equal(result.value, 342);
    assert.equal(result.name, 'GPT-OSS 120B (Medium)');
    assert.equal(result.owned_by, 'openai');
    assert.equal(result.context, 128000);
    assert.equal(result.output, 16384);
  });

  // ── Short-form aliases (for Anthropic / Gemini API compatibility) ──
  it('resolves short-form alias claude-sonnet-4-6', () => {
    const result = resolveModel('claude-sonnet-4-6');
    assert.equal(result.value, 1035);
    assert.equal(result.owned_by, 'anthropic');
  });

  it('resolves short-form alias claude-opus-4-6-thinking', () => {
    const result = resolveModel('claude-opus-4-6-thinking');
    assert.equal(result.value, 1026);
  });

  it('resolves short-form alias gemini-3.1-pro-high', () => {
    const result = resolveModel('gemini-3.1-pro-high');
    assert.equal(result.value, 1037);
    assert.equal(result.owned_by, 'google');
  });

  it('resolves short-form alias gemini-3.1-pro-low', () => {
    const result = resolveModel('gemini-3.1-pro-low');
    assert.equal(result.value, 1036);
  });

  it('resolves short-form alias gemini-3-flash-agent', () => {
    const result = resolveModel('gemini-3-flash-agent');
    assert.equal(result.value, 1018);
  });

  it('resolves short-form alias gpt-oss-120b-medium', () => {
    const result = resolveModel('gpt-oss-120b-medium');
    assert.equal(result.value, 342);
  });
});
