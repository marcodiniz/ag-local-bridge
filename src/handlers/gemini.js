'use strict';

const { log, sendJson, readBody } = require('../utils');
const { resolveModel } = require('../models');
const { callRawInference } = require('../sidecar/raw');

// Map numeric model enum values → GetModelResponse string enum (same as chat.js)
const VALUE_TO_MODEL_ENUM = {
  1018: 'MODEL_PLACEHOLDER_M18', // Flash
  1037: 'MODEL_PLACEHOLDER_M37', // Pro High
  1036: 'MODEL_PLACEHOLDER_M36', // Pro Low
  1035: 'MODEL_PLACEHOLDER_M35', // Sonnet
  1026: 'MODEL_PLACEHOLDER_M26', // Opus
  342: 'MODEL_PLACEHOLDER_M42', // GPT-OSS 120B
};

// ─────────────────────────────────────────────
// Gemini → OpenAI message conversion
// Gemini uses `contents[].parts[].text`
// ─────────────────────────────────────────────

/**
 * Convert Gemini-format `contents` to OpenAI-format messages.
 * Gemini roles: 'user' | 'model'  →  OpenAI roles: 'user' | 'assistant'
 */
function geminiContentsToOpenAi(contents, systemInstruction) {
  const messages = [];

  // systemInstruction is { parts: [{ text }] } in Gemini native format
  if (systemInstruction) {
    const sysParts = systemInstruction.parts || [];
    const sysText = sysParts.map((p) => p.text || '').join('');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const item of contents || []) {
    const role = item.role === 'model' ? 'assistant' : 'user';
    const parts = item.parts || [];
    const text = parts.map((p) => p.text || '').join('');
    messages.push({ role, content: text });
  }

  return messages;
}

/**
 * Convert Gemini tool declarations to OpenAI tool format.
 * Gemini: { functionDeclarations: [{ name, description, parameters }] }
 */
function geminiToolsToOpenAi(tools) {
  if (!tools || tools.length === 0) return null;

  const openAiTools = [];
  for (const toolGroup of tools) {
    const declarations = toolGroup.functionDeclarations || toolGroup.function_declarations || [];
    for (const decl of declarations) {
      openAiTools.push({
        type: 'function',
        function: {
          name: decl.name,
          description: decl.description || '',
          parameters: decl.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return openAiTools.length > 0 ? openAiTools : null;
}

// ─────────────────────────────────────────────
// Gemini response builders
// ─────────────────────────────────────────────

function buildGeminiResponse(text, toolCalls, modelKey) {
  const parts = [];

  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      let args;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
  } else if (text) {
    parts.push({ text });
  }

  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: toolCalls && toolCalls.length > 0 ? 'STOP' : 'STOP',
        index: 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
    modelVersion: modelKey,
  };
}

// ─────────────────────────────────────────────
// POST /v1beta/models/:model:generateContent
// POST /v1beta/models/:model:streamGenerateContent
// ─────────────────────────────────────────────

async function handleGeminiGenerateContent(ctx, req, res, modelFromPath) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { code: 400, message: 'Invalid JSON', status: 'INVALID_ARGUMENT' } });
  }

  // Detect streaming from URL suffix (already stripped by router, stored in req._geminiStream)
  const isStream = req._geminiStream === true;

  // Resolve model — modelFromPath comes from the URL like "gemini-3.1-pro-high"
  const resolved = resolveModel(modelFromPath || payload.model);
  log(ctx, `📡 [Gemini] Model: ${resolved.key} (enum=${resolved.value})`);

  const modelEnum = VALUE_TO_MODEL_ENUM[resolved.value];
  if (!modelEnum) {
    const msg = `No raw model enum mapping for value ${resolved.value}.`;
    return sendJson(res, 400, { error: { code: 400, message: msg, status: 'INVALID_ARGUMENT' } });
  }

  // Convert Gemini → OpenAI format
  const openAiMessages = geminiContentsToOpenAi(
    payload.contents,
    payload.systemInstruction || payload.system_instruction,
  );
  const openAiTools = geminiToolsToOpenAi(payload.tools);

  // Rate limit guard
  const now = Date.now();
  if (now - ctx.lastResponseTimestamp < ctx.MIN_REQUEST_INTERVAL_MS) {
    return sendJson(res, 429, {
      error: { code: 429, message: 'Rate limited — please wait.', status: 'RESOURCE_EXHAUSTED' },
    });
  }

  ctx.chatRequestsInFlight++;
  log(ctx, `📡 [Gemini] Requests in flight: ${ctx.chatRequestsInFlight}`);

  try {
    log(ctx, `🧠 [Gemini] Trying raw inference (${modelEnum})...`);
    const raw = await callRawInference(ctx, openAiMessages, modelEnum, openAiTools);

    if (!raw || (!raw.content && !raw.toolCalls)) {
      throw new Error('Raw inference returned empty content');
    }

    log(ctx, `✅ [Gemini] Raw inference succeeded (${(raw.content || '').length} chars)`);
    const responseBody = buildGeminiResponse(raw.content || '', raw.toolCalls, resolved.key);

    if (isStream) {
      // Gemini streaming: each chunk is a JSON object separated by newlines, wrapped in array brackets
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.writeHead(200);
      // For simplicity, write the whole response as a single chunk wrapped in an array
      res.write('[\n' + JSON.stringify(responseBody) + '\n]\n');
      res.end();
    } else {
      sendJson(res, 200, responseBody);
    }
  } catch (err) {
    log(ctx, `⚠️ [Gemini] Raw inference failed: ${err.message}`);
    const isRateLimit =
      err.message.includes('capacity') ||
      err.message.includes('429') ||
      err.message.includes('RESOURCE_EXHAUSTED') ||
      err.message.toLowerCase().includes('sse read timed out') ||
      err.message.includes('H2 connect') ||
      err.message.includes('H2 timeout') ||
      err.message.includes('Sidecar not discovered') ||
      err.message.includes('No reachable LS port') ||
      err.message.includes('empty content');
    const status = isRateLimit ? 429 : 502;
    const errBody = {
      error: {
        code: status,
        message: `Upstream error: ${err.message}`,
        status: isRateLimit ? 'RESOURCE_EXHAUSTED' : 'INTERNAL',
      },
    };
    if (!res.headersSent) sendJson(res, status, errBody);
  } finally {
    ctx.chatRequestsInFlight--;
    ctx.lastResponseTimestamp = Date.now();
  }
}

/**
 * Parse the model name from a Gemini-style URL path.
 * Strips the operation suffix `:generateContent` / `:streamGenerateContent`.
 * e.g. "/v1beta/models/gemini-3.1-pro-high:streamGenerateContent" → "gemini-3.1-pro-high"
 *
 * @param {string} pathname
 * @returns {{ model: string|null, isStream: boolean }}
 */
function parseGeminiPath(pathname) {
  // Match /v1beta/models/<model-name>[:operation]
  const match = pathname.match(/\/v1beta\/models\/([^/:]+)(?::(\w+))?/);
  if (!match) return { model: null, isStream: false };
  const model = match[1];
  const operation = match[2] || '';
  const isStream = operation === 'streamGenerateContent';
  return { model, isStream };
}

module.exports = { handleGeminiGenerateContent, parseGeminiPath };
