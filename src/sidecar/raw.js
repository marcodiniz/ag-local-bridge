'use strict';

const { log, verboseLog } = require('../utils');
const { extractText } = require('../images');
const { discoverSidecar } = require('./discovery');
const { makeH2JsonCall, clearH2Clients } = require('./rpc');
const { callSidecarChat } = require('./cascade');
const { discoverSwarm, getNextSwarmMember, invalidateSwarmCache, markSwarmMemberExhausted } = require('./swarm');

// Map raw-inference string enum → sidecar numeric model value
const MODEL_ENUM_TO_VALUE = {
  MODEL_PLACEHOLDER_M18: 1018,
  MODEL_PLACEHOLDER_M16: 1016, // Corregido: Pro High
  MODEL_PLACEHOLDER_M36: 1036,
  MODEL_PLACEHOLDER_M35: 1035,
  MODEL_PLACEHOLDER_M26: 1026,
  MODEL_PLACEHOLDER_M20: 1020, // Nuevo: Gemini 3.5 Medium
  MODEL_PLACEHOLDER_M133: 1133, // Nuevo: Gemini 3.5 High
  MODEL_PLACEHOLDER_M187: 1187, // Nuevo: Gemini 3.5 Low
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 342,
};

// ─────────────────────────────────────────────
// Raw Inference via GetModelResponse
// Bypasses Cascade entirely — pure LLM inference.
//
// Schema (decoded from sidecar protobuf):
//   Request:  { prompt: string, model: string }
//   Response: { response: string }
// ─────────────────────────────────────────────

/**
 * Format OpenAI-style messages into a single prompt string for GetModelResponse.
 *
 * The raw endpoint only accepts a flat prompt, so we concatenate all messages
 * with role labels. Tool definitions and results are formatted inline.
 */
function formatMessagesAsPrompt(messages, tools) {
  const parts = [];

  // If tools are provided, add them as a system-level block
  if (tools && tools.length > 0) {
    parts.push('# Available Tools\n');
    parts.push('When you need to use a tool, respond with EXACTLY this format (one per line):');
    parts.push('<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>\n');
    parts.push('You may include multiple tool calls. After all tool calls, you may include additional text.');
    parts.push('The human will execute the tools and return the results enclosed in <observation> tags.');
    parts.push(
      'CRITICAL: Do NOT simulate tool execution. Do NOT generate <observation> tags yourself. Stop and wait for the human to return the results.\n',
    );
    for (const tool of tools) {
      if (tool.type === 'function' && tool.function) {
        const fn = tool.function;
        parts.push(`## ${fn.name}`);
        if (fn.description) parts.push(fn.description);
        if (fn.parameters) {
          parts.push('Parameters: ' + JSON.stringify(fn.parameters, null, 2));
        }
        parts.push('');
      }
    }
    parts.push('---\n');
  }

  // Format each message with role label
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = extractText(msg.content);

    if (role === 'system') {
      parts.push(`[System]\n${content}\n`);
    } else if (role === 'user') {
      parts.push(`[User]\n${content}\n`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Format assistant tool calls so the model sees the conversation flow
        const toolCallTexts = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return `<tool_call>{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}</tool_call>`;
        });
        parts.push(`[Assistant]\n${content || ''}${toolCallTexts.join('\n')}\n`);
      } else {
        parts.push(`[Assistant]\n${content}\n`);
      }
    } else if (role === 'tool') {
      // Tool results are shown with their tool_call_id for context, enclosed in observation tags
      // to satisfy models that are heavily fine-tuned on XML schema flows (Claude, Minimax)
      const toolName = msg.name || msg.tool_call_id || 'tool';
      parts.push(`<observation>\n[Tool Result: ${toolName}]\n${content}\n</observation>\n`);
    }
  }

  return parts.join('\n');
}

/**
 * Parse tool calls from the LLM's raw text response.
 * Looks for <tool_call>...</tool_call> blocks and extracts them.
 *
 * Hallucination fence: only the portion of the response *before* the first
 * <observation> tag is parsed.  When a raw-inference model runs a self-contained
 * ReAct loop in one shot it generates:
 *   <tool_call>A</tool_call>
 *   <observation>fake result</observation>   ← hallucinated
 *   <tool_call>B based on fake A</tool_call> ← unreliable!
 * Discarding everything from the first <observation> onward enforces proper
 * single-step turn-based tool calling: the client executes real tool(s),
 * sends real results back, and the model generates the next step using
 * actual data — the same as OpenAI / Anthropic tool calling.
 *
 * @returns {{ content: string, toolCalls: Array|null }}
 */
function parseToolCalls(responseText) {
  const toolCalls = [];

  // ── Hallucination fence ─────────────────────────────────────────────────
  // Only consider text before the first <observation> tag.
  const firstObsIdx = responseText.search(/<observation>/i);
  const parseText = firstObsIdx !== -1 ? responseText.substring(0, firstObsIdx) : responseText;

  // Parse 1: Custom JSON `<tool_call>` format
  const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match;
  while ((match = toolCallRegex.exec(parseText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      toolCalls.push({
        index: toolCalls.length,
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: {
          name: parsed.name,
          arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {}),
        },
      });
    } catch {
      // If JSON parsing fails, skip this tool call
    }
  }

  // Parse 2: Native XML format used by Claude/Minimax (`<invoke>` blocks)
  // Supports `<minimax:tool_call><invoke>...</invoke></minimax:tool_call>` or direct `<invoke>`
  const invokeRegex = /<invoke>\s*<tool_name>([\s\S]*?)<\/tool_name>([\s\S]*?)<\/invoke>/g;
  while ((match = invokeRegex.exec(parseText)) !== null) {
    const fnName = match[1].trim();
    const paramBlock = match[2];
    const args = {};
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramBlock)) !== null) {
      args[pMatch[1]] = pMatch[2].trim();
    }
    toolCalls.push({
      index: toolCalls.length,
      id: `call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  // Parse 3: Native Claude 3 format (`<tool_use>` blocks)
  // `<tool_use>\n<name>tool_name</name>\n<input>\n<param_name>value</param_name>\n</input>\n</tool_use>`
  const toolUseRegex = /<tool_use>\s*<name>([\s\S]*?)<\/name>\s*<input>([\s\S]*?)<\/input>\s*<\/tool_use>/g;
  while ((match = toolUseRegex.exec(parseText)) !== null) {
    const fnName = match[1].trim();
    const paramBlock = match[2];
    const args = {};
    // Extract everything that looks like `<param_key>param_value</param_key>`
    const paramRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramBlock)) !== null) {
      args[pMatch[1]] = pMatch[2].trim();
    }
    toolCalls.push({
      index: toolCalls.length,
      id: `call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  // Remove tool blocks from the pre-fence text to get the pure conversational text.
  // Anything after firstObsIdx is hallucinated ReAct continuation — already excluded.
  let content = parseText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '');
  content = content.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, ''); // Common wrapper
  content = content.replace(/<invoke>[\s\S]*?<\/invoke>/g, '');
  content = content.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '');
  content = content.trim();

  return {
    content: content || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

const swarmQueues = new Map();
let inferenceStartMutex = Promise.resolve();

/**
 * Serialize GetModelResponse calls per sidecar PID: only ONE runs at a time per sidecar,
 * with a 2-second cooldown between consecutive calls. This prevents the sidecar
 * from returning RESOURCE_EXHAUSTED under parallel request spikes, while still
 * allowing concurrent execution across different sidecars in swarm mode.
 */
function enqueueInferenceForMember(pid, fn) {
  let queue = swarmQueues.get(pid);
  if (!queue) {
    queue = Promise.resolve();
  }

  let resolve, reject;
  const resultPromise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const nextQueue = queue
    .then(async () => {
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    })
    .catch(() => {});

  swarmQueues.set(pid, nextQueue);
  return resultPromise;
}

function getRawEndpointKey(info, csrf) {
  return `${info.pid}:${csrf}:${(info.actualPorts || []).join(',')}`;
}

function getCandidatePorts(info) {
  return [
    ...new Set([...(info.actualPorts || []).filter((p) => p !== info.extensionServerPort), info.extensionServerPort]),
  ];
}

async function callGetModelResponseOnPort(ctx, info, csrf, port, prompt, modelEnum, timeoutMs) {
  return makeH2JsonCall(
    port,
    csrf,
    info.certPath,
    'GetModelResponse',
    {
      prompt,
      model: modelEnum,
    },
    1,
    timeoutMs,
  );
}

function clearRawEndpoint(ctx) {
  ctx.rawInferenceEndpoint = null;
  clearH2Clients();
}

/**
 * Call the sidecar's GetModelResponse for raw LLM inference.
 *
 * @param {Object} ctx - Bridge context
 * @param {Array} messages - OpenAI-format messages
 * @param {string} modelEnum - Model enum string (e.g. 'MODEL_PLACEHOLDER_M18')
 * @param {Array|null} tools - OpenAI tool definitions
 * @param {Array} images - Array of extracted image objects
 * @returns {{ content: string|null, toolCalls: Array|null }}
 */
async function callRawInference(ctx, messages, modelEnum, tools = null, images = []) {
  if (images && images.length > 0) {
    log(ctx, `🖼️ Images detected! Raw inference does not support vision. Routing to Cascade API...`);
    const numericModelValue = MODEL_ENUM_TO_VALUE[modelEnum] || 1035;
    // Cascade is the ONLY endpoint that natively supports the 'media' field for images.
    const text = await callSidecarChat(ctx, messages, numericModelValue, null, null, images);
    return { content: text, toolCalls: null };
  }

  // ── Swarm-aware discovery ──────────────────────────────────────────────
  // Try to discover all sidecars (multi-account pool). If the swarm has
  // multiple members, round-robin across them. Falls back to single-sidecar
  // discovery if swarm discovery finds nothing.
  const swarmMembers = await discoverSwarm(ctx);
  const useSwarm = swarmMembers.length > 1;

  if (useSwarm) {
    log(ctx, `🐝 Swarm mode: ${swarmMembers.length} sidecars available — using round-robin`);
  }

  // Single-sidecar fallback: use the original discovery path
  const info = useSwarm ? null : await discoverSidecar(ctx);
  if (!useSwarm && !info) throw new Error('Sidecar not discovered');

  if (!useSwarm && (!info.csrfTokens || info.csrfTokens.length === 0)) {
    throw new Error('Sidecar discovered but no CSRF tokens available');
  }

  // Format the prompt
  const prompt = formatMessagesAsPrompt(messages, tools);

  log(ctx, `🧠 Raw inference: ${prompt.length} chars, model=${modelEnum}, tools=${tools ? tools.length : 0}`);

  // Call GetModelResponse with an extended timeout.
  const INFERENCE_TIMEOUT_MS = 900000; // 15 minutes

  // ── Swarm round-robin path ────────────────────────────────────────────
  if (useSwarm) {
    return _callRawInferenceSwarm(ctx, swarmMembers, prompt, modelEnum, tools, INFERENCE_TIMEOUT_MS);
  }

  // ── Single-sidecar path (original logic) ──────────────────────────────
  return _callRawInferenceSingle(ctx, info, prompt, modelEnum, tools, INFERENCE_TIMEOUT_MS);
}

/**
 * Swarm round-robin inference: try each member in turn until one succeeds.
 * On RESOURCE_EXHAUSTED, automatically rotate to the next member.
 */
async function _callRawInferenceSwarm(ctx, members, prompt, modelEnum, tools, timeoutMs) {
  const totalMembers = members.length;
  let lastError = null;

  // Try every member in the swarm (starting from the round-robin position)
  for (let i = 0; i < totalMembers; i++) {
    const numericModelValue = MODEL_ENUM_TO_VALUE[modelEnum] || 1035;
    const member = getNextSwarmMember(members, numericModelValue);

    if (member === 'ALL_EXHAUSTED') {
      log(ctx, `⚠️ 🐝 All swarm members exhausted for model enum ${numericModelValue}.`);
      return {
        content: `⚠️ **Rate Limit Exceeded**: All ${members.length} available Antigravity accounts are currently out of quota for this model tier. Please wait a while or switch to a different model tier (e.g. Gemini 3 Flash).`,
        toolCalls: null,
      };
    }

    if (!member) continue;

    try {
      // Stagger concurrent inference starts with rejection guard
      await new Promise((resolve) => {
        inferenceStartMutex = inferenceStartMutex
          .then(() => {
            resolve();
          })
          .catch(() => {
            resolve();
          })
          .then(() => new Promise((r) => setTimeout(r, ctx.RAW_INFERENCE_START_SPACING_MS || 100)));
      });

      log(ctx, `🐝 Trying sidecar PID=${member.pid} port=${member.port} (${i + 1}/${totalMembers})`);

      const result = await enqueueInferenceForMember(member.pid, () =>
        makeH2JsonCall(
          member.port,
          member.csrf,
          member.certPath,
          'GetModelResponse',
          { prompt, model: modelEnum },
          1,
          timeoutMs,
        ),
      );

      const responseText = (result && result.response) || '';
      verboseLog(ctx, `🧠 Raw response dump (${responseText.length} chars)`, responseText);
      log(ctx, `🧠 Raw response: ${responseText.length} chars (from PID=${member.pid})`);

      // Check for quota exhaustion — flag specific bucket and rotate
      if (
        responseText.includes('RESOURCE_EXHAUSTED') ||
        responseText.includes("Method doesn't allow unregistered callers")
      ) {
        log(ctx, `⚠️ 🐝 Sidecar PID=${member.pid} quota exhausted — flagging for 1 hour & rotating...`);
        markSwarmMemberExhausted(member.pid, MODEL_ENUM_TO_VALUE[modelEnum] || 1035);
        lastError = new Error(`Upstream API failed: ${responseText.substring(0, 200)}`);
        continue;
      }

      if (responseText.trim().length === 0) {
        return {
          content:
            '⚠️ **Inference Blocked**: The model returned an empty response. This usually occurs when the prompt triggers a Google API safety filter (e.g. sensitive code, PII, or security flags) or encounters a silent internal error. Please modify your prompt and try again.',
          toolCalls: null,
        };
      }

      // Auth failure — skip this sidecar
      const isAuthError =
        responseText.length < 500 &&
        (responseText.includes('PERMISSION_DENIED') ||
          responseText.includes('Verify your account') ||
          responseText.includes('403 Forbidden') ||
          /^(?:HTTP )?401\b/i.test(responseText.trim()));

      if (isAuthError) {
        log(ctx, `⚠️ 🐝 Auth failure on PID=${member.pid} — rotating...`);
        lastError = new Error(`Auth failure: ${responseText.substring(0, 200)}`);
        continue;
      }

      // Success!
      if (tools && tools.length > 0) {
        return parseToolCalls(responseText);
      }
      return { content: responseText, toolCalls: null };
    } catch (err) {
      const errMsg = err.message || '';
      log(ctx, `⚠️ 🐝 Sidecar PID=${member.pid} failed: ${errMsg.substring(0, 100)} — rotating...`);
      lastError = err;

      // Connection-level errors: keep trying next member
      const isConnectionError =
        errMsg.includes('H2 connect') ||
        errMsg.includes('H2 timeout') ||
        errMsg.includes('socket hang up') ||
        errMsg.includes('ECONNRESET') ||
        errMsg.includes('canceled') ||
        errMsg.includes('SSL') ||
        errMsg.includes('EPIPE');

      if (isConnectionError) continue;

      // RESOURCE_EXHAUSTED in the error message (thrown by our own code above)
      if (errMsg.includes('RESOURCE_EXHAUSTED')) continue;

      // Unknown error — don't keep rotating, throw immediately
      throw err;
    }
  }

  // All members exhausted
  invalidateSwarmCache();
  throw lastError || new Error('All swarm members exhausted');
}

/**
 * Original single-sidecar inference path (unchanged from before).
 */
async function _callRawInferenceSingle(ctx, info, prompt, modelEnum, tools, timeoutMs) {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 5000;
  const triedAccountEmails = new Set();

  try {
    const vscode = require('vscode');
    const activeAccount = await vscode.commands.executeCommand('ag.getActiveAccount');
    if (activeAccount && activeAccount.email) {
      triedAccountEmails.add(activeAccount.email);
    }
  } catch (e) {
    // Switchboard not active or initialized
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const mainCsrf = info.csrfTokens ? info.csrfTokens[0] : null;
    if (!mainCsrf) {
      throw new Error('Sidecar discovered but no CSRF tokens available');
    }
    const endpointKey = getRawEndpointKey(info, mainCsrf);
    const candidatePorts = getCandidatePorts(info);

    if (attempt > 0) {
      log(ctx, `⏳ Retry ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s backoff...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    try {
      // Slightly stagger concurrent inference requests with rejection guard
      await new Promise((resolve) => {
        inferenceStartMutex = inferenceStartMutex
          .then(() => {
            resolve();
          })
          .catch(() => {
            resolve();
          })
          .then(() => new Promise((r) => setTimeout(r, ctx.RAW_INFERENCE_START_SPACING_MS || 100)));
      });

      const cached = ctx.rawInferenceEndpoint;
      const portsToTry =
        cached && cached.key === endpointKey
          ? [cached.port, ...candidatePorts.filter((p) => p !== cached.port)]
          : candidatePorts;

      let result;
      let lastError = null;
      for (const port of portsToTry) {
        try {
          result = await enqueueInferenceForMember(info.pid, () =>
            callGetModelResponseOnPort(ctx, info, mainCsrf, port, prompt, modelEnum, timeoutMs),
          );
          ctx.rawInferenceEndpoint = { key: endpointKey, port, lastUsed: Date.now() };
          break;
        } catch (err) {
          lastError = err;
          if (cached && cached.port === port) clearRawEndpoint(ctx);
          const msg = String(err && err.message ? err.message : err);
          const shouldFailover =
            msg.includes('H2 connect') ||
            msg.includes('H2 timeout') ||
            msg.includes('WRONG_VERSION_NUMBER') ||
            msg.includes('SSL routines') ||
            msg.includes('disconnected') ||
            msg.includes('EPIPE') ||
            msg.includes('socket hang up') ||
            msg.includes('ECONNRESET') ||
            msg.includes('HTTP 500') ||
            msg.includes('internal error');
          if (!shouldFailover) break;
        }
      }

      if (!result) {
        ctx.sidecarInfo = null;
        ctx.sidecarInfoTimestamp = 0;
        clearRawEndpoint(ctx);
        throw lastError || new Error('No reachable raw inference port');
      }

      const responseText = (result && result.response) || '';
      verboseLog(ctx, `🧠 Raw response dump (${responseText.length} chars)`, responseText);
      log(ctx, `🧠 Raw response: ${responseText.length} chars`);

      // Check if upstream silently returned a Google API proxy error as plaintext.
      // Only flag short responses (< 1000 chars) — longer responses are valid completions
      // where the model may quote these strings while discussing error-handling code.
      if (
        responseText.length < 1000 &&
        (responseText.includes("Method doesn't allow unregistered callers") ||
          responseText.includes('RESOURCE_EXHAUSTED'))
      ) {
        throw new Error(`Upstream API failed: ${responseText.substring(0, 200)}`);
      }

      if (responseText.trim().length === 0) {
        return {
          content:
            '⚠️ **Inference Blocked**: The model returned an empty response. This usually occurs when the prompt triggers a Google API safety filter (e.g. sensitive code, PII, or security flags) or encounters a silent internal error. Please modify your prompt and try again.',
          toolCalls: null,
        };
      }

      const isAuthError =
        responseText.length < 500 &&
        (responseText.includes('PERMISSION_DENIED') ||
          responseText.includes('Verify your account') ||
          responseText.includes('403 Forbidden') ||
          /^(?:HTTP )?401\b/i.test(responseText.trim()));

      if (isAuthError) {
        log(ctx, '⚠️ Auth failure detected in raw response — invalidating sidecar cache to force re-discovery');
        ctx.sidecarInfo = null;
        ctx.sidecarInfoTimestamp = 0;
        throw new Error(`Auth failure (sidecar cache cleared): ${responseText.substring(0, 200)}`);
      }

      if (tools && tools.length > 0) {
        return parseToolCalls(responseText);
      }
      return { content: responseText, toolCalls: null };
    } catch (err) {
      const errMsg = err.message || '';
      const isRateLimitOrAuth =
        errMsg.includes('RESOURCE_EXHAUSTED') ||
        errMsg.includes("Method doesn't allow unregistered callers") ||
        errMsg.includes('Auth failure') ||
        errMsg.includes('PERMISSION_DENIED') ||
        errMsg.includes('Forbidden') ||
        errMsg.includes('401') ||
        errMsg.includes('403') ||
        errMsg.includes('WRONG_VERSION_NUMBER') ||
        errMsg.includes('SSL routines') ||
        errMsg.includes('Upstream model provider error') ||
        errMsg.includes('pending stream has been canceled');

      if (isRateLimitOrAuth) {
        let accounts = [];
        let activeAccount = null;
        try {
          const vscode = require('vscode');
          accounts = (await vscode.commands.executeCommand('ag.getAccounts')) || [];
          activeAccount = await vscode.commands.executeCommand('ag.getActiveAccount');
        } catch (e) {
          log(ctx, `⚠️ Switchboard commands not available: ${e.message}`);
        }

        if (accounts.length > 1) {
          const currentIndex = activeAccount
            ? accounts.findIndex((a) => a.id === activeAccount.id || a.email === activeAccount.email)
            : 0;

          let nextAccount = null;
          for (let offset = 1; offset <= accounts.length; offset++) {
            const idx = (currentIndex + offset) % accounts.length;
            const candidate = accounts[idx];
            if (candidate && candidate.email && !triedAccountEmails.has(candidate.email)) {
              nextAccount = candidate;
              break;
            }
          }

          if (nextAccount) {
            log(
              ctx,
              `🔄 Rate limit/Auth issue encountered (${errMsg.substring(0, 100)}). Rotating silently to next account: ${nextAccount.email}`,
            );
            try {
              const vscode = require('vscode');
              const success = await vscode.commands.executeCommand('ag.switchAccount', nextAccount.id, true);
              if (success) {
                triedAccountEmails.add(nextAccount.email);
                log(ctx, `⏳ Waiting 2 seconds for account switch to propagate to sidecar...`);
                await new Promise((r) => setTimeout(r, 2000));

                // Clear discovery cache to force re-discovery
                ctx.sidecarInfo = null;
                ctx.sidecarInfoTimestamp = 0;
                clearRawEndpoint(ctx);

                // Re-discover sidecar for the new account!
                const freshInfo = await discoverSidecar(ctx);
                if (freshInfo && freshInfo.csrfTokens && freshInfo.csrfTokens.length > 0) {
                  info = freshInfo;
                }

                // Reset attempt counter so we get full retries on the new account
                attempt = 0;
                continue;
              } else {
                log(ctx, `❌ Failed to switch to account: ${nextAccount.email}`);
              }
            } catch (switchErr) {
              log(ctx, `❌ Error calling switchAccount: ${switchErr.message}`);
            }
          } else {
            log(ctx, `❌ All tracked accounts (${accounts.length}) have been exhausted.`);
          }
        }
      }

      const isRetryable =
        errMsg.includes('RESOURCE_EXHAUSTED') ||
        errMsg.includes('model not found') ||
        errMsg.includes('unknown model key');

      if (attempt < MAX_RETRIES && isRetryable) {
        log(ctx, `⚠️ Raw inference attempt ${attempt + 1} failed: ${errMsg.substring(0, 100)}`);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { callRawInference, formatMessagesAsPrompt, parseToolCalls };
