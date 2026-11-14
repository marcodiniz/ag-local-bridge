'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveModel,
  MODEL_MAP,
  DEFAULT_MODEL_KEY,
  VALUE_TO_MODEL_ENUM,
  MODEL_ENUM_TO_VALUE,
} = require('../src/models');

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

  it('resolves Gemini 3.5 Flash tiers', () => {
    assert.equal(resolveModel('antigravity-gemini-3.5-flash').value, 1084);
    assert.equal(resolveModel('antigravity-gemini-3.5-flash-medium').value, 1020);
    assert.equal(resolveModel('antigravity-gemini-3.5-flash-low').value, 1187);
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

  // ── Unknown models ──
  it('returns null for completely unknown model', () => {
    const result = resolveModel('gpt-4-turbo-preview-2024');
    assert.equal(result, null);
  });

  it('returns null for unknown antigravity-prefixed model', () => {
    // Regression: the bare 'antigravity' alias used to partial-match any
    // 'antigravity-*' id, silently routing unknown models to the default model.
    const result = resolveModel('antigravity-gemini-9.9-ultra');
    assert.equal(result, null);
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
    assert.equal(result.context, 1000000);
    assert.equal(result.output, 128000);
  });

  it('resolves short-form alias claude-opus-4-6-thinking', () => {
    const result = resolveModel('claude-opus-4-6-thinking');
    assert.equal(result.value, 1026);
    assert.equal(result.context, 1000000);
    assert.equal(result.output, 128000);
  });

  it('resolves short-form alias gemini-3.8-flash-high', () => {
    const result = resolveModel('gemini-3.8-flash-high');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
    assert.equal(result.owned_by, 'google');
  });

  it('resolves short-form alias gemini-3.8-flash-medium', () => {
    const result = resolveModel('gemini-3.8-flash-medium');
    assert.equal(result.value, 1319);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M319');
  });

  it('resolves short-form alias gemini-3.8-flash-low', () => {
    const result = resolveModel('gemini-3.8-flash-low');
    assert.equal(result.value, 1320);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M320');
  });

  it('resolves short-form alias gemini-3.8-flash', () => {
    const result = resolveModel('gemini-3.8-flash');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
  });

  it('resolves short-form alias gemini-3.8', () => {
    const result = resolveModel('gemini-3.8');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
  });

  it('resolves alias gemini-3.8-thinking', () => {
    const result = resolveModel('gemini-3.8-thinking');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
  });

  it('resolves alias gemini-3.8-flash-thinking', () => {
    const result = resolveModel('gemini-3.8-flash-thinking');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
  });

  it('resolves alias antigravity-gemini-3.8', () => {
    const result = resolveModel('antigravity-gemini-3.8');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
  });

  it('resolves alias antigravity-gemini-3.8-flash', () => {
    const result = resolveModel('antigravity-gemini-3.8-flash');
    assert.equal(result.value, 1318);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M318');
  });

  it('resolves short-form alias gemini-3.7-flash-high', () => {
    const result = resolveModel('gemini-3.7-flash-high');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
    assert.equal(result.owned_by, 'google');
  });

  it('resolves short-form alias gemini-3.7-flash-medium', () => {
    const result = resolveModel('gemini-3.7-flash-medium');
    assert.equal(result.value, 1299);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M299');
  });

  it('resolves short-form alias gemini-3.7-flash-low', () => {
    const result = resolveModel('gemini-3.7-flash-low');
    assert.equal(result.value, 1300);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M300');
  });

  it('resolves short-form alias gemini-3.7-flash', () => {
    const result = resolveModel('gemini-3.7-flash');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
  });

  it('resolves short-form alias gemini-3.7', () => {
    const result = resolveModel('gemini-3.7');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
  });

  it('resolves alias gemini-3.7-thinking', () => {
    const result = resolveModel('gemini-3.7-thinking');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
  });

  it('resolves alias gemini-3.7-flash-thinking', () => {
    const result = resolveModel('gemini-3.7-flash-thinking');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
  });

  it('resolves alias antigravity-gemini-3.7', () => {
    const result = resolveModel('antigravity-gemini-3.7');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
  });

  it('resolves alias antigravity-gemini-3.7-flash', () => {
    const result = resolveModel('antigravity-gemini-3.7-flash');
    assert.equal(result.value, 1298);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M298');
  });

  it('resolves short-form alias gemini-3.6-flash-high', () => {
    const result = resolveModel('gemini-3.6-flash-high');
    assert.equal(result.value, 1071);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M71');
  });

  it('resolves short-form alias gemini-3.5-flash-high', () => {
    const result = resolveModel('gemini-3.5-flash-high');
    assert.equal(result.value, 1084);
    assert.equal(result.modelEnum, 'MODEL_PLACEHOLDER_M84');
  });

  it('resolves short-form alias gemini-3.1-pro-high', () => {
    const result = resolveModel('gemini-3.1-pro-high');
    assert.equal(result.value, 1037);
    assert.equal(result.owned_by, 'google');
    assert.equal(result.context, 1048576);
    assert.equal(result.output, 65536);
  });

  it('resolves short-form alias gemini-3.1-pro-low', () => {
    const result = resolveModel('gemini-3.1-pro-low');
    assert.equal(result.value, 1036);
  });

  it('resolves short-form alias gemini-3-flash-agent', () => {
    const result = resolveModel('gemini-3-flash-agent');
    assert.equal(result.value, 1018);
  });

  it('resolves gemini-3.5-flash aliases and exact models', () => {
    assert.equal(resolveModel('antigravity-gemini-3.5-flash').value, 1084);
    assert.equal(resolveModel('antigravity-gemini-3.5-flash-high').value, 1084);
    assert.equal(resolveModel('antigravity-gemini-3.5-flash-medium').value, 1020);
    assert.equal(resolveModel('antigravity-gemini-3.5-flash-low').value, 1187);

    assert.equal(resolveModel('gemini-3.5-flash').value, 1084);
    assert.equal(resolveModel('gemini-3.5-flash-high').value, 1084);
    assert.equal(resolveModel('gemini-3.5-flash-medium').value, 1020);
    assert.equal(resolveModel('gemini-3.5-flash-low').value, 1187);
  });

  it('resolves short-form alias gpt-oss-120b-medium', () => {
    const result = resolveModel('gpt-oss-120b-medium');
    assert.equal(result.value, 342);
  });

  it('resolves Claude Opus 5.5 tiers and aliases', () => {
    assert.equal(resolveModel('antigravity-claude-opus-5-5-low').modelEnum, 'MODEL_PLACEHOLDER_M400');
    assert.equal(resolveModel('antigravity-claude-opus-5-5-medium').modelEnum, 'MODEL_PLACEHOLDER_M401');
    assert.equal(resolveModel('antigravity-claude-opus-5-5-high').modelEnum, 'MODEL_PLACEHOLDER_M402');
    assert.equal(resolveModel('claude-opus-5-5-low').value, 1400);
    assert.equal(resolveModel('claude-opus-5-5-medium').value, 1401);
    assert.equal(resolveModel('claude-opus-5-5-high').value, 1402);
    assert.equal(resolveModel('claude-opus-5-5').value, 1402);
    assert.equal(resolveModel('claude-opus-5-5').owned_by, 'anthropic');
    assert.equal(resolveModel('claude-opus-5-5').context, 1000000);
    assert.equal(resolveModel('claude-opus-5-5').output, 128000);
    assert.equal(resolveModel('antigravity-claude-sonnet-5-5-low').context, 1000000);
    assert.equal(resolveModel('antigravity-claude-sonnet-5-5-low').output, 128000);
  });

  it('resolves Claude Sonnet 5.5 tiers and aliases', () => {
    assert.equal(resolveModel('antigravity-claude-sonnet-5-5-low').modelEnum, 'MODEL_PLACEHOLDER_M403');
    assert.equal(resolveModel('antigravity-claude-sonnet-5-5-medium').modelEnum, 'MODEL_PLACEHOLDER_M404');
    assert.equal(resolveModel('antigravity-claude-sonnet-5-5-high').modelEnum, 'MODEL_PLACEHOLDER_M405');
    assert.equal(resolveModel('claude-sonnet-5-5-low').value, 1403);
    assert.equal(resolveModel('claude-sonnet-5-5-medium').value, 1404);
    assert.equal(resolveModel('claude-sonnet-5-5-high').value, 1405);
    assert.equal(resolveModel('claude-sonnet-5-5').value, 1405);
    assert.equal(resolveModel('claude-opus-5.5').value, 1402);
    assert.equal(resolveModel('claude-sonnet-5.5').value, 1405);
  });

  it('resolves Gemini 4 Argon tiers and aliases', () => {
    assert.equal(resolveModel('antigravity-gemini-4-argon-high').modelEnum, 'MODEL_PLACEHOLDER_M417');
    assert.equal(resolveModel('antigravity-gemini-4-argon-medium').modelEnum, 'MODEL_PLACEHOLDER_M418');
    assert.equal(resolveModel('antigravity-gemini-4-argon-low').modelEnum, 'MODEL_PLACEHOLDER_M419');
    assert.equal(resolveModel('gemini-4-argon-high').value, 1417);
    assert.equal(resolveModel('gemini-4-argon-medium').value, 1418);
    assert.equal(resolveModel('gemini-4-argon-low').value, 1419);
    assert.equal(resolveModel('gemini-4-argon').value, 1417);
    assert.equal(resolveModel('antigravity-gemini-4-argon').value, 1417);
    assert.equal(resolveModel('gemini-pro-orchestrator-g1-pro').value, 1668);
  });

  it('resolves Gemini 4 Hydrogen tiers and aliases', () => {
    assert.equal(resolveModel('antigravity-gemini-4-hydrogen-xhigh').modelEnum, 'MODEL_PLACEHOLDER_M528');
    assert.equal(resolveModel('antigravity-gemini-4-hydrogen-high').modelEnum, 'MODEL_PLACEHOLDER_M525');
    assert.equal(resolveModel('antigravity-gemini-4-hydrogen-medium').modelEnum, 'MODEL_PLACEHOLDER_M526');
    assert.equal(resolveModel('antigravity-gemini-4-hydrogen-low').modelEnum, 'MODEL_PLACEHOLDER_M527');
    assert.equal(resolveModel('gemini-4-hydrogen-xhigh').value, 1528);
    assert.equal(resolveModel('gemini-4-hydrogen-high').value, 1525);
    assert.equal(resolveModel('gemini-4-hydrogen-medium').value, 1526);
    assert.equal(resolveModel('gemini-4-hydrogen-low').value, 1527);
    assert.equal(resolveModel('gemini-4-hydrogen').value, 1525);
    assert.equal(resolveModel('antigravity-gemini-4-hydrogen').value, 1525);
  });

  it('resolves Gemini 4 Carbon tiers and aliases', () => {
    assert.equal(resolveModel('antigravity-gemini-4-carbon-high').modelEnum, 'MODEL_PLACEHOLDER_M427');
    assert.equal(resolveModel('antigravity-gemini-4-carbon-medium').modelEnum, 'MODEL_PLACEHOLDER_M437');
    assert.equal(resolveModel('antigravity-gemini-4-carbon-low').modelEnum, 'MODEL_PLACEHOLDER_M438');
    assert.equal(resolveModel('antigravity-gemini-4-carbon').modelEnum, 'MODEL_PLACEHOLDER_M670');
    assert.equal(resolveModel('gemini-4-carbon-high').value, 1427);
    assert.equal(resolveModel('gemini-4-carbon-medium').value, 1437);
    assert.equal(resolveModel('gemini-4-carbon-low').value, 1438);
    assert.equal(resolveModel('gemini-4-carbon').value, 1670);
  });

  it('keeps enum lookup tables in sync for Claude 5.5 and Gemini 4', () => {
    for (const v of [
      1400, 1401, 1402, 1403, 1404, 1405, 1417, 1418, 1419, 1427, 1437, 1438, 1525, 1526, 1527, 1528, 1668, 1670,
    ]) {
      const name = `MODEL_PLACEHOLDER_M${v - 1000}`;
      assert.equal(VALUE_TO_MODEL_ENUM[v], name);
      assert.equal(MODEL_ENUM_TO_VALUE[name], v);
    }
  });
});
