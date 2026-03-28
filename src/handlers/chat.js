'use strict';

const vscode = require('vscode');
const { randomUUID } = require('crypto');
const {
  log,
  verboseLog,
  sendJson,
  setupStreamResponse,
  readBody,
  buildStreamChunk,
  buildCompletion,
} = require('../utils');
const { extractText, extractAllImages } = require('../images');
const { resolveModel } = require('../models');
const { resolveWorkspace } = require('../workspace');
const { callRawInference } = require('../sidecar/raw');

// Map numeric model enum values → GetModelResponse string enum
const VALUE_TO_MODEL_ENUM = {
  1018: 'MODEL_PLACEHOLDER_M18', // Flash
  1037: 'MODEL_PLACEHOLDER_M37', // Pro High
  1036: 'MODEL_PLACEHOLDER_M36', // Pro Low
  1035: 'MODEL_PLACEHOLDER_M35', // Sonnet
  1026: 'MODEL_PLACEHOLDER_M26', // Opus
  342: 'MODEL_PLACEHOLDER_M42', // GPT-OSS 120B
};

// ─────────────────────────────────────────────
// POST /v1/chat/completions
// ─────────────────────────────────────────────

async function handleChatCompletions(ctx, req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
  }

  // Debug: log incoming request payload (verbose only)
  verboseLog(ctx, `📥 Request body (${body.length} bytes): ${body.substring(0, 500)}`);

  const isStream = payload.stream === true;
  const messages = payload.messages || [];
  const completionId = `chatcmpl-${randomUUID()}`;

  // Safeguard: detect [object Object] serialization corruption
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => extractText(m.content));
  const allCorrupted = userTexts.length > 0 && userTexts.every((t) => /^\[object Object\]/.test(t));
  if (allCorrupted) {
    log(ctx, `⚠️ [object Object] DETECTED — upstream caller is not serializing messages properly!`, true);
    log(ctx, `⚠️ Raw messages: ${JSON.stringify(messages).substring(0, 300)}`);
    return sendJson(res, 400, {
      error: {
        message:
          'Messages contain "[object Object]" — the caller is not serializing message objects to JSON properly. Check that content is a string or valid content-parts array.',
        type: 'invalid_request',
        raw_messages: messages.slice(0, 3),
      },
    });
  }

  // ── Rate limiting: prevent feedback loops ──
  const now = Date.now();
  const timeSinceLastResponse = now - ctx.lastResponseTimestamp;
  if (timeSinceLastResponse < ctx.MIN_REQUEST_INTERVAL_MS) {
    log(
      ctx,
      `🛑 Rate limited — only ${timeSinceLastResponse}ms since last response (min ${ctx.MIN_REQUEST_INTERVAL_MS}ms)`,
    );
    return sendJson(res, 429, {
      error: {
        message: `Rate limited: please wait ${Math.ceil((ctx.MIN_REQUEST_INTERVAL_MS - timeSinceLastResponse) / 1000)}s before sending another request.`,
        type: 'rate_limit',
      },
    });
  }

  // ── Duplicate detection: same LAST message within dedup window ──
  // We hash the last message rather than just the last user message, because during tool execution,
  // the client sends tool results (with role="tool") causing the last *user* message to seem identical.
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : { role: 'none', content: '' };
  const lastMsgText = `${lastMsg.role}:${extractText(lastMsg.content)}`;
  const msgHash = lastMsgText.substring(0, 500);
  if (msgHash === ctx.lastUserMessageHash && now - ctx.lastUserMessageTimestamp < ctx.DEDUP_WINDOW_MS) {
    log(ctx, `🛑 Duplicate message rejected (same message within ${ctx.DEDUP_WINDOW_MS / 1000}s)`);
    return sendJson(res, 429, {
      error: { message: 'Duplicate message detected — identical request within dedup window.', type: 'rate_limit' },
    });
  }
  ctx.lastUserMessageHash = msgHash;
  ctx.lastUserMessageTimestamp = now;

  // Resolve model from request
  const resolved = resolveModel(payload.model);
  log(ctx, `📡 Model: ${resolved.key} (enum=${resolved.value})`);

  // Resolve workspace
  const { workspaceDir, workspaceUri } = resolveWorkspace(ctx, messages, payload, req);

  // ── Concurrency guard: limit parallel requests ──
  if (ctx.chatRequestsInFlight >= ctx.MAX_CONCURRENT_REQUESTS) {
    log(
      ctx,
      `🛑 Request rejected — ${ctx.chatRequestsInFlight} requests already in flight (max ${ctx.MAX_CONCURRENT_REQUESTS})`,
    );
    const busyMsg = '[Too many concurrent requests. Please wait and try again.]';
    if (isStream) {
      setupStreamResponse(res);
      res.write(`data: ${JSON.stringify({ error: { message: busyMsg, type: 'rate_limit' } })}\n\n`);
      res.end();
    } else {
      sendJson(res, 429, { error: { message: busyMsg, type: 'rate_limit' } });
    }
    return;
  }

  ctx.chatRequestsInFlight++;
  log(ctx, `📡 Requests in flight: ${ctx.chatRequestsInFlight}`);

  let keepAliveTimer = null;
  let preStreamTimer = null;
  let headersSentForStream = false;

  const initiateStream = () => {
    if (isStream && !headersSentForStream) {
      setupStreamResponse(res);
      headersSentForStream = true;
    }
  };

  if (isStream) {
    // Force stream headers after 2 seconds to prevent client TTFB (Time To First Byte) timeouts.
    // This still allows fast upstream errors (<2s) to cleanly return HTTP 429 codes with headers.
    preStreamTimer = setTimeout(() => {
      initiateStream();
    }, 2000);

    keepAliveTimer = setInterval(() => {
      initiateStream();
      res.write(': keep-alive\n\n');
    }, 4500);
  }

  try {
    await _handleChatCompletionsInner(
      ctx,
      res,
      isStream,
      initiateStream,
      headersSentForStream,
      messages,
      completionId,
      resolved,
      workspaceDir,
      workspaceUri,
      payload,
    );
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (preStreamTimer) clearTimeout(preStreamTimer);
    ctx.chatRequestsInFlight--;
    ctx.lastResponseTimestamp = Date.now();
  }
}

async function _handleChatCompletionsInner(
  ctx,
  res,
  isStream,
  initiateStream,
  headersSentForStream,
  messages,
  completionId,
  resolved,
  workspaceDir,
  workspaceUri,
  payload,
) {
  // Extract images from OpenAI-format messages (base64 data URLs, remote URLs, file URIs)
  let images = [];
  try {
    images = await extractAllImages(ctx, messages);
    if (images.length > 0) {
      log(ctx, `🖼️ Extracted ${images.length} image(s) from messages`);
    }
  } catch (e) {
    log(ctx, `⚠️ Image extraction failed: ${e.message}`);
  }

  const tools = payload.tools && payload.tools.length > 0 ? payload.tools : null;
  const modelEnum = VALUE_TO_MODEL_ENUM[resolved.value];

  if (!modelEnum) {
    const errorMsg = `No raw model enum mapping for value ${resolved.value}. Raw inference unavailable.`;
    log(ctx, `⚠️ ${errorMsg}`);
    const errPayload = { error: { message: errorMsg, type: 'invalid_request' } };
    if (isStream && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: errPayload.error })}\n\n`);
      res.end();
    } else if (!res.headersSent) {
      sendJson(res, 400, errPayload);
    }
    return;
  }

  try {
    log(ctx, `🧠 Trying raw inference (${modelEnum})...`);
    const raw = await callRawInference(ctx, messages, modelEnum, tools);
    if (raw && (raw.content || raw.toolCalls)) {
      const text = raw.content || '';
      log(ctx, `✅ Raw inference succeeded (${text.length} chars)`);
      if (isStream) {
        initiateStream();
        if (raw.toolCalls) {
          // Stream tool calls in OpenAI format
          const chunk = buildStreamChunk(completionId, resolved.key, text || null, null);
          chunk.choices[0].delta.tool_calls = raw.toolCalls;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, text))}\n\n`);
        }
        const finishReason = raw.toolCalls ? 'tool_calls' : 'stop';
        res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, null, finishReason))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const completion = buildCompletion(completionId, resolved.key, text);
        if (raw.toolCalls) {
          completion.choices[0].message.tool_calls = raw.toolCalls;
          completion.choices[0].finish_reason = 'tool_calls';
        }
        sendJson(res, 200, completion);
      }
      return;
    }
    throw new Error('Raw inference returned empty content or no tool calls');
  } catch (err) {
    log(ctx, `⚠️ Raw inference failed: ${err.message}`);

    // Enforce 429 for rate limit / capacity errors, otherwise 502 for general upstream/H2 crashes
    const isRateLimit =
      err.message.includes('capacity') || err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED');
    const status = isRateLimit ? 429 : 502;
    const errType = isRateLimit ? 'rate_limit' : 'server_error';

    let retryAfterSecs = 10;
    const match = err.message.match(/reset after (\d+)s/);
    if (match) {
      retryAfterSecs = parseInt(match[1], 10) + 2;
    }

    log(ctx, `🛑 Upstream API error/capacity — returning ${status} to caller (Retry-After: ${retryAfterSecs}s)`);

    const errPayload = {
      error: {
        message: `Upstream model provider error: ${err.message}`,
        type: errType,
      },
    };

    // If we haven't sent stream headers yet, we can send a true HTTP error.
    // The client SDK will correctly read the HTTP status code and Retry-After header.
    if (isStream && headersSentForStream) {
      res.write(`data: ${JSON.stringify({ error: errPayload.error })}\n\n`);
      res.end();
    } else if (!res.headersSent) {
      res.setHeader('Retry-After', String(retryAfterSecs));
      sendJson(res, status, errPayload);
    }
  }
}

module.exports = { handleChatCompletions };
