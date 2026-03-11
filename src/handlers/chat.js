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
const { callSidecarChat } = require('../sidecar/cascade');
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

async function dispatchViaAntigravityCommand(userMessage) {
  const allCommands = await vscode.commands.getCommands(true);
  const command = ['antigravity.executeCascadeAction'].find((candidate) => allCommands.includes(candidate));

  if (!command) {
    const relatedCommands = allCommands.filter(
      (name) =>
        name.toLowerCase().includes('antigravity') ||
        name.toLowerCase().includes('jetski') ||
        name.toLowerCase().includes('cascade'),
    );
    const sample = relatedCommands.slice(0, 8).join(', ') || 'none';
    throw new Error(`No supported Antigravity command-dispatch command found. Related commands: ${sample}`);
  }

  await vscode.commands.executeCommand(command, {
    type: 'sendMessage',
    message: userMessage,
  });
}

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

  // ── Duplicate detection: same LAST user message within dedup window ──
  const lastUserMsg = userTexts.length > 0 ? userTexts[userTexts.length - 1].trim() : '';
  const msgHash = lastUserMsg.substring(0, 500);
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
      res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, busyMsg))}\n\n`);
      res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, null, 'stop'))}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sendJson(res, 429, { error: { message: busyMsg, type: 'rate_limit' } });
    }
    return;
  }

  ctx.chatRequestsInFlight++;
  log(ctx, `📡 Requests in flight: ${ctx.chatRequestsInFlight}`);
  try {
    await _handleChatCompletionsInner(
      ctx,
      res,
      isStream,
      messages,
      completionId,
      resolved,
      workspaceDir,
      workspaceUri,
      payload,
    );
  } finally {
    ctx.chatRequestsInFlight--;
    ctx.lastResponseTimestamp = Date.now();
  }
}

async function _handleChatCompletionsInner(
  ctx,
  res,
  isStream,
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

  // Tier 0: Raw inference (GetModelResponse — bypasses Cascade entirely)
  const modelEnum = VALUE_TO_MODEL_ENUM[resolved.value];
  if (modelEnum) {
    try {
      log(ctx, `🧠 Trying raw inference (${modelEnum})...`);
      const raw = await callRawInference(ctx, messages, modelEnum, tools);
      if (raw && (raw.content || raw.toolCalls)) {
        const text = raw.content || '';
        log(ctx, `✅ Raw inference succeeded (${text.length} chars)`);
        if (isStream) {
          setupStreamResponse(res);
          if (raw.toolCalls) {
            // Stream tool calls in OpenAI format
            const chunk = buildStreamChunk(completionId, resolved.key, text || null, null);
            chunk.choices[0].delta.tool_calls = raw.toolCalls;
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, text))}\n\n`);
          }
          res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, null, 'stop'))}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const completion = buildCompletion(completionId, resolved.key, text);
          if (raw.toolCalls) {
            completion.choices[0].message.tool_calls = raw.toolCalls;
          }
          sendJson(res, 200, completion);
        }
        return;
      }
    } catch (err) {
      log(ctx, `⚠️ Raw inference failed: ${err.message}`);
    }
  } else {
    log(ctx, `⚠️ No raw model enum mapping for value ${resolved.value}, skipping raw mode`);
  }

  // Tier 1: Cascade (StartCascade → SendUserCascadeMessage → poll)
  try {
    const result = await callSidecarChat(ctx, messages, resolved.value, workspaceDir, workspaceUri, images);
    if (result) {
      if (isStream) {
        setupStreamResponse(res);
        res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, result))}\n\n`);
        res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, null, 'stop'))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        sendJson(res, 200, buildCompletion(completionId, resolved.key, result));
      }
      return;
    }
  } catch (err) {
    log(ctx, `⚠️ Cascade call failed: ${err.message}`);
  }

  // Tier 2: Command dispatch (fire-and-forget, returns acknowledgement)
  // NOTE: This can create a feedback loop if the dispatched command routes back through the bridge.
  try {
    const userMessage = messages
      .filter((m) => m.role === 'user')
      .map((m) => extractText(m.content))
      .join('\n');
    log(ctx, `⚠️ Falling back to Tier 2 command dispatch (sidecar unavailable)`);
    await dispatchViaAntigravityCommand(userMessage);
    const text = '[Message dispatched to Antigravity agent panel. Check the Antigravity chat panel for the response.]';
    if (isStream) {
      setupStreamResponse(res);
      res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, 'antigravity', text))}\n\n`);
      res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, 'antigravity', null, 'stop'))}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sendJson(res, 200, buildCompletion(completionId, 'antigravity', text));
    }
    return;
  } catch (err) {
    log(ctx, `⚠️ Command dispatch failed: ${err.message}`);
  }

  sendJson(res, 503, {
    error: {
      message: 'All tiers failed. Run "Antigravity Bridge: Probe Sidecar" from Command Palette.',
      type: 'service_unavailable',
    },
  });
}

module.exports = { handleChatCompletions };
