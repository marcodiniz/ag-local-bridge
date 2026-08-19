'use strict';

// ─────────────────────────────────────────────
// Model Mapping: string ID → sidecar enum value
// ─────────────────────────────────────────────

const MODEL_MAP = {
  // Antigravity models (PLACEHOLDER_M enum values, 1000+ range)
  'antigravity-gemini-3-flash': {
    value: 1018,
    name: 'Gemini 3 Flash',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
  },
  'antigravity-gemini-3.5-flash': {
    value: 1133,
    name: 'Gemini 3.5 Flash',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
  },
  'antigravity-gemini-3.5-flash-high': {
    value: 1133,
    name: 'Gemini 3.5 Flash (High)',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
  },
  'antigravity-gemini-3.5-flash-medium': {
    value: 1020,
    name: 'Gemini 3.5 Flash (Medium)',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
  },
  'antigravity-gemini-3.5-flash-low': {
    value: 1187,
    name: 'Gemini 3.5 Flash (Low)',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
  },
  'antigravity-gemini-3.1-pro-high': {
    value: 1016,
    name: 'Gemini 3.1 Pro (High)',
    owned_by: 'google',
    context: 1048576,
    output: 65535,
  },
  'antigravity-gemini-3.1-pro-low': {
    value: 1036,
    name: 'Gemini 3.1 Pro (Low)',
    owned_by: 'google',
    context: 1048576,
    output: 65535,
  },
  'antigravity-claude-sonnet-4-6': {
    value: 1035,
    name: 'Claude Sonnet 4.6 (Thinking)',
    owned_by: 'anthropic',
    context: 200000,
    output: 64000,
  },
  'antigravity-claude-opus-4-6-thinking': {
    value: 1026,
    name: 'Claude Opus 4.6 (Thinking)',
    owned_by: 'anthropic',
    context: 200000,
    output: 64000,
  },
  'antigravity-gpt-oss-120b': {
    value: 342,
    name: 'GPT-OSS 120B (Medium)',
    owned_by: 'openai',
    context: 128000,
    output: 16384,
  },
  // Aliases for convenience
  antigravity: {
    value: 1035,
    name: 'Antigravity (Default)',
    owned_by: 'antigravity',
    context: 200000,
    output: 64000,
    hidden: true,
  },
  // Short-form aliases (without 'antigravity-' prefix) — compatible with other tools / lbjlaq naming
  'gemini-3-flash-agent': {
    value: 1018,
    name: 'Gemini 3 Flash',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
    hidden: true,
  },
  'gemini-3.5-flash': {
    value: 1133,
    name: 'Gemini 3.5 Flash',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
    hidden: true,
  },
  'gemini-3.5-flash-high': {
    value: 1133,
    name: 'Gemini 3.5 Flash (High)',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
    hidden: true,
  },
  'gemini-3.5-flash-medium': {
    value: 1020,
    name: 'Gemini 3.5 Flash (Medium)',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
    hidden: true,
  },
  'gemini-3.5-flash-low': {
    value: 1187,
    name: 'Gemini 3.5 Flash (Low)',
    owned_by: 'google',
    context: 1048576,
    output: 65536,
    hidden: true,
  },
  'gemini-3.1-pro-high': {
    value: 1016,
    name: 'Gemini 3.1 Pro (High)',
    owned_by: 'google',
    context: 1048576,
    output: 65535,
    hidden: true,
  },
  'gemini-3.1-pro-low': {
    value: 1036,
    name: 'Gemini 3.1 Pro (Low)',
    owned_by: 'google',
    context: 1048576,
    output: 65535,
    hidden: true,
  },
  'claude-sonnet-4-6': {
    value: 1035,
    name: 'Claude Sonnet 4.6 (Thinking)',
    owned_by: 'anthropic',
    context: 200000,
    output: 64000,
    hidden: true,
  },
  'claude-opus-4-6-thinking': {
    value: 1026,
    name: 'Claude Opus 4.6 (Thinking)',
    owned_by: 'anthropic',
    context: 200000,
    output: 64000,
    hidden: true,
  },
  'gpt-oss-120b-medium': {
    value: 342,
    name: 'GPT-OSS 120B (Medium)',
    owned_by: 'openai',
    context: 128000,
    output: 16384,
    hidden: true,
  },
};

const DEFAULT_MODEL_KEY = 'antigravity-claude-sonnet-4-6';

function resolveModel(requestedModel) {
  if (!requestedModel || requestedModel === 'antigravity') {
    return { key: DEFAULT_MODEL_KEY, ...MODEL_MAP[DEFAULT_MODEL_KEY] };
  }
  if (MODEL_MAP[requestedModel]) return { key: requestedModel, ...MODEL_MAP[requestedModel] };
  // Try partial match (e.g. "claude-sonnet" matches "claude-sonnet-4.6")
  const lower = requestedModel.toLowerCase();
  for (const [k, v] of Object.entries(MODEL_MAP)) {
    // Skip the bare 'antigravity' alias here: every 'antigravity-*' id contains it,
    // so any unknown 'antigravity-<model>' would silently resolve to the default model.
    if (k === 'antigravity') continue;
    if (k.includes(lower) || lower.includes(k)) return { key: k, ...v };
  }
  // Unknown model: return null so handlers can reply 404. Falling back to the
  // default model here would mean callers believe they are talking to the model
  // they asked for while actually getting the default — undiagnosable misrouting.
  return null;
}

module.exports = { MODEL_MAP, DEFAULT_MODEL_KEY, resolveModel };
