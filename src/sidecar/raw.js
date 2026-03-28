'use strict';

const { log } = require('../utils');
const { extractText } = require('../images');
const { discoverSidecar } = require('./discovery');
const { makeH2JsonCall } = require('./rpc');

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
    parts.push('You may include multiple tool calls. After all tool calls, you may include additional text.\n');
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
      // Tool results are shown with their tool_call_id for context
      const toolName = msg.name || msg.tool_call_id || 'tool';
      parts.push(`[Tool Result: ${toolName}]\n${content}\n`);
    }
  }

  return parts.join('\n');
}

/**
 * Parse tool calls from the LLM's raw text response.
 * Looks for <tool_call>...</tool_call> blocks and extracts them.
 *
 * @returns {{ content: string, toolCalls: Array|null }}
 */
function parseToolCalls(responseText) {
  const toolCalls = [];

  // Parse 1: Custom JSON `<tool_call>` format
  const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match;
  while ((match = toolCallRegex.exec(responseText)) !== null) {
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
  while ((match = invokeRegex.exec(responseText)) !== null) {
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

  // Remove tool blocks from content to get the pure conversational text
  let content = responseText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '');
  content = content.replace(/<invoke>[\s\S]*?<\/invoke>/g, '');
  content = content.trim();

  return {
    content: content || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

/**
 * Call the sidecar's GetModelResponse for raw LLM inference.
 *
 * @param {Object} ctx - Bridge context
 * @param {Array} messages - OpenAI-format messages
 * @param {string} modelEnum - Model enum string (e.g. 'MODEL_PLACEHOLDER_M18')
 * @param {Array|null} tools - OpenAI tool definitions
 * @returns {{ content: string|null, toolCalls: Array|null }}
 */
async function callRawInference(ctx, messages, modelEnum, tools = null) {
  const info = await discoverSidecar(ctx);
  if (!info) throw new Error('Sidecar not discovered');

  if (!info.csrfTokens || info.csrfTokens.length === 0) {
    throw new Error('Sidecar discovered but no CSRF tokens available');
  }
  const mainCsrf = info.csrfTokens[0];

  // Find a working LS port
  const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
  let lsPort = null;
  for (const port of lsPorts) {
    try {
      await makeH2JsonCall(port, mainCsrf, info.certPath, 'GetStatus', {});
      lsPort = port;
      break;
    } catch {
      // try next port
    }
  }
  if (!lsPort) throw new Error('No reachable LS port');

  // Format the prompt
  const prompt = formatMessagesAsPrompt(messages, tools);
  log(ctx, `🧠 Raw inference: ${prompt.length} chars, model=${modelEnum}, tools=${tools ? tools.length : 0}`);

  // Call GetModelResponse with an extended timeout.
  // Large prompts or slow thinking models can take several minutes.
  const INFERENCE_TIMEOUT_MS = 900000; // 15 minutes
  const result = await makeH2JsonCall(
    lsPort,
    mainCsrf,
    info.certPath,
    'GetModelResponse',
    {
      prompt,
      model: modelEnum,
    },
    1,
    INFERENCE_TIMEOUT_MS,
  );

  const responseText = (result && result.response) || '';
  log(ctx, `🧠 Raw response: ${responseText.length} chars`);

  // Check if upstream silently returned a Google API proxy error as plaintext
  if (
    responseText.includes("Method doesn't allow unregistered callers") ||
    responseText.includes('RESOURCE_EXHAUSTED')
  ) {
    throw new Error(`Upstream API failed: ${responseText.substring(0, 200)}`);
  }

  // Parse tool calls from the response if tools were provided
  if (tools && tools.length > 0) {
    return parseToolCalls(responseText);
  }

  return { content: responseText, toolCalls: null };
}

module.exports = { callRawInference, formatMessagesAsPrompt, parseToolCalls };
