'use strict';

const { randomUUID } = require('crypto');
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
// Anthropic → OpenAI message conversion
// ─────────────────────────────────────────────

/**
 * Convert Anthropic-format messages to OpenAI-format messages.
 * Anthropic uses `content` as a string OR an array of content blocks.
 * Tool calls in Anthropic flow are `tool_use` blocks in assistant messages,
 * and `tool_result` blocks in user messages.
 */
function anthropicMessagesToOpenAi(system, messages) {
  const result = [];

  if (system) {
    result.push({ role: 'system', content: typeof system === 'string' ? system : extractAnthropicText(system) });
  }

  for (const msg of messages) {
    const role = msg.role; // 'user' | 'assistant'
    const content = msg.content;

    if (typeof content === 'string') {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: '' });
      continue;
    }

    // Process content blocks
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text || '');
      } else if (block.type === 'tool_use') {
        // Anthropic assistant tool call → OpenAI tool_calls
        toolCalls.push({
          id: block.id || `call_${randomUUID()}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
          },
        });
      } else if (block.type === 'tool_result') {
        // Anthropic user tool result → OpenAI tool role message
        const resultContent = Array.isArray(block.content)
          ? block.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .filter(Boolean)
              .join('\n')
          : block.content || '';
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          name: block.tool_use_id || 'tool',
          content: resultContent,
        });
      }
    }

    if (toolResults.length > 0) {
      // User message containing tool results → emit each as a separate `tool` message
      result.push(...toolResults);
    } else if (toolCalls.length > 0) {
      // Assistant message with tool calls
      const msg = { role: 'assistant', content: textParts.join('') || null };
      msg.tool_calls = toolCalls;
      result.push(msg);
    } else {
      result.push({ role, content: textParts.join('') });
    }
  }

  return result;
}

/**
 * Convert Anthropic tool definitions to OpenAI tool format.
 */
function anthropicToolsToOpenAi(tools) {
  if (!tools || tools.length === 0) return null;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function extractAnthropicText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return '';
}

// ─────────────────────────────────────────────
// Anthropic SSE response builders
// ─────────────────────────────────────────────

function buildAnthropicMessage(id, model) {
  return {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function writeAnthropicEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─────────────────────────────────────────────
// POST /v1/messages
// ─────────────────────────────────────────────

async function handleAnthropicMessages(ctx, req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
  }

  const isStream = payload.stream === true;
  const msgId = randomUUID().replace(/-/g, '').substring(0, 24);

  // Resolve model
  const resolved = resolveModel(payload.model);
  log(ctx, `📡 [Anthropic] Model: ${resolved.key} (enum=${resolved.value})`);

  const modelEnum = VALUE_TO_MODEL_ENUM[resolved.value];
  if (!modelEnum) {
    const msg = `No raw model enum mapping for value ${resolved.value}.`;
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: msg } });
  }

  // Convert Anthropic → OpenAI format
  const openAiMessages = anthropicMessagesToOpenAi(payload.system, payload.messages || []);
  const openAiTools = anthropicToolsToOpenAi(payload.tools);

  // Rate limit guard (reuse same limits as OpenAI endpoint)
  const now = Date.now();
  if (now - ctx.lastResponseTimestamp < ctx.MIN_REQUEST_INTERVAL_MS) {
    const errBody = { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited — please wait.' } };
    return sendJson(res, 429, errBody);
  }

  ctx.chatRequestsInFlight++;
  log(ctx, `📡 [Anthropic] Requests in flight: ${ctx.chatRequestsInFlight}`);

  let keepAliveTimer = null;
  let preStreamTimer = null;
  let headersSentForStream = false;

  const initiateStream = () => {
    if (isStream && !headersSentForStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.writeHead(200);

      // message_start
      writeAnthropicEvent(res, 'message_start', {
        type: 'message_start',
        message: buildAnthropicMessage(msgId, resolved.key),
      });
      headersSentForStream = true;
    }
  };

  if (isStream) {
    // Force stream headers after 2 seconds to prevent client TTFB timeouts.
    preStreamTimer = setTimeout(() => {
      initiateStream();
    }, 2000);

    // Send a ping event every 4.5s to reset client read timeouts and surface eventual 429s/errors
    keepAliveTimer = setInterval(() => {
      initiateStream();
      writeAnthropicEvent(res, 'ping', { type: 'ping' });
    }, 4500);
  }

  try {
    log(ctx, `🧠 [Anthropic] Trying raw inference (${modelEnum})...`);
    const raw = await callRawInference(ctx, openAiMessages, modelEnum, openAiTools);

    if (!raw || (!raw.content && !raw.toolCalls)) {
      throw new Error('Raw inference returned empty content');
    }

    const responseText = raw.content || '';
    log(ctx, `✅ [Anthropic] Raw inference succeeded (${responseText.length} chars)`);

    if (isStream) {
      initiateStream(); // Ensure stream has started

      if (raw.toolCalls && raw.toolCalls.length > 0) {
        // Emit each tool call as a tool_use block
        for (let i = 0; i < raw.toolCalls.length; i++) {
          const tc = raw.toolCalls[i];
          writeAnthropicEvent(res, 'content_block_start', {
            type: 'content_block_start',
            index: i,
            content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
          });
          writeAnthropicEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' },
          });
          writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: i });
        }
        writeAnthropicEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
      } else {
        // Stream text in chunks
        writeAnthropicEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });

        // Send text as a single delta (we have the full response already)
        if (responseText) {
          writeAnthropicEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: responseText },
          });
        }
        writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        writeAnthropicEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
      }

      writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' });
      res.end();
    } else {
      // Non-streaming Anthropic response
      const content = [];
      if (raw.toolCalls && raw.toolCalls.length > 0) {
        for (const tc of raw.toolCalls) {
          let input;
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            input = {};
          }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      if (responseText) {
        content.push({ type: 'text', text: responseText });
      }
      const response = {
        id: `msg_${msgId}`,
        type: 'message',
        role: 'assistant',
        model: resolved.key,
        content,
        stop_reason: raw.toolCalls ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      sendJson(res, 200, response);
    }
  } catch (err) {
    log(ctx, `⚠️ [Anthropic] Raw inference failed: ${err.message}`);
    const isRateLimit =
      err.message.includes('capacity') ||
      err.message.includes('429') ||
      err.message.includes('RESOURCE_EXHAUSTED') ||
      err.message.toLowerCase().includes('sse read timed out') ||
      err.message.includes('H2 connect') ||
      err.message.includes('H2 timeout') ||
      err.message.includes('Sidecar not discovered') ||
      err.message.includes('No reachable LS port');
    const status = isRateLimit ? 429 : 502;
    const errType = isRateLimit ? 'rate_limit_error' : 'api_error';
    const errBody = { type: 'error', error: { type: errType, message: `Upstream error: ${err.message}` } };
    if (!res.headersSent) {
      sendJson(res, status, errBody);
    } else if (!res.writableEnded) {
      writeAnthropicEvent(res, 'error', errBody);
      res.end();
    }
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (preStreamTimer) clearTimeout(preStreamTimer);
    ctx.chatRequestsInFlight--;
    ctx.lastResponseTimestamp = Date.now();
  }
}

// ─────────────────────────────────────────────
// POST /v1/messages/count_tokens  (mock)
// Claude CLI and Cherry Studio send this before every conversation.
// Return a plausible mock so they don't abort.
// ─────────────────────────────────────────────

async function handleCountTokens(ctx, req, res) {
  // Consume the body so the socket stays clean
  try {
    await readBody(req);
  } catch {
    // ignore
  }
  log(ctx, '📡 [Anthropic] count_tokens preflight — returning mock');
  sendJson(res, 200, { input_tokens: 0 });
}

module.exports = { handleAnthropicMessages, handleCountTokens };
