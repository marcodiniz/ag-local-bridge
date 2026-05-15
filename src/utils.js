'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────

function log(ctx, msg, isError = false) {
  if (typeof msg === 'object') {
    try {
      msg = JSON.stringify(msg);
    } catch {
      msg = String(msg);
    }
  }
  const ts = new Date().toISOString().slice(11, 23);
  if (ctx.outputChannel) ctx.outputChannel.appendLine(`[${ts}] ${msg}`);
  if (isError) console.error(`[ag-bridge] ${msg}`);

  // Write to temporary global disk if verbose Request Logging is enabled in settings (for deep debugging)
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  if (config.get('logRequests', false)) {
    try {
      const logFilePath = path.join(os.tmpdir(), 'ag-local-bridge.log');
      fs.appendFileSync(logFilePath, `[${ts}] ${msg}\n`, 'utf8');
    } catch {
      // ignore filesystem errors for log files
    }
  }
}

/** Log only when agLocalBridge.logRequests is enabled (verbose/debug output) */
function verboseLog(ctx, msg, fullContent = null) {
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  if (config.get('logRequests', false)) {
    log(ctx, msg);

    // If a massive payload was provided, append it explicitly to a separate payload file, nicely formatted
    if (fullContent !== null) {
      try {
        let formattedContent = fullContent;
        if (typeof fullContent === 'string') {
          try {
            formattedContent = JSON.stringify(JSON.parse(fullContent), null, 2);
          } catch {
            // not valid JSON, leave as is
          }
        } else if (typeof fullContent === 'object') {
          try {
            formattedContent = JSON.stringify(fullContent, null, 2);
          } catch {
            // fallback
          }
        }

        const payloadLogPath = path.join(os.tmpdir(), 'ag-local-bridge-payloads.log');
        const ts = new Date().toISOString().slice(11, 23);
        fs.appendFileSync(
          payloadLogPath,
          `\n--- [${ts}] FULL PAYLOAD DUMP ---\n${formattedContent}\n--- [END PAYLOAD DUMP] ---\n`,
          'utf8',
        );
      } catch {
        // ignore filesystem errors for log files
      }
    }
  }
}

// ─────────────────────────────────────────────
// Status Bar
// ─────────────────────────────────────────────

function updateStatusBar(ctx, running, port) {
  if (!ctx.statusBarItem) return;
  ctx.statusBarItem.text = running ? `$(radio-tower) AG Bridge :${port}` : '$(warning) AG Bridge OFF';
  ctx.statusBarItem.backgroundColor = running ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  ctx.statusBarItem.show();
}

// ─────────────────────────────────────────────
// HTTP Response Helpers
// ─────────────────────────────────────────────

function setupStreamResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.writeHead(200);
  if (res.flushHeaders) res.flushHeaders();
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(body);
}

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (c) => {
      totalBytes += c.length;
      if (totalBytes > maxBytes) {
        req.destroy(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// OpenAI Response Builders
// ─────────────────────────────────────────────

function buildStreamChunk(id, model, content, finishReason = null) {
  const delta = content !== null ? { role: 'assistant', content } : {};
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function buildCompletion(id, model, content) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ─────────────────────────────────────────────
// Error Parsing Helpers
// ─────────────────────────────────────────────

/**
 * Extracts a sensible Retry-After value from a sidecar rate limit message.
 * Handles formats like 'reset after 42m41s' or 'reset after 45s'.
 */
function parseRetryAfter(message) {
  if (typeof message !== 'string') return 10;
  // Match either 'reset after 42m41s' or 'reset after 41s'
  const match = message.match(/reset after (?:(\d+)m)?(\d+)s/);
  if (match) {
    const mins = parseInt(match[1] || '0', 10);
    const secs = parseInt(match[2] || '0', 10);
    return Math.max(10, mins * 60 + secs + 2);
  }
  return 10;
}

/**
 * Extracts the inner provider error message from a raw sidecar error string.
 * Example input: 'HTTP 500: {"code":"unknown","message":"RESOURCE_EXHAUSTED (code 429): You have exhausted..."}'
 * Output: 'RESOURCE_EXHAUSTED (code 429): You have exhausted...'
 */
function extractProviderError(message) {
  if (typeof message !== 'string') return String(message);
  let extracted = message;
  try {
    const jsonMatch = message.match(/HTTP \d+: (\{[\s\S]*\})/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed && typeof parsed.message === 'string') {
        extracted = parsed.message;
      }
    } else {
      const msgMatch = message.match(/"message"\s*:\s*"([^"]+)"/);
      if (msgMatch) {
        extracted = msgMatch[1];
      }
    }
  } catch {
    // If parsing fails, fall back to regex
    const msgMatch = message.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch) {
      extracted = msgMatch[1];
    }
  }

  // Clarify Google's confusing 'check quota' message which is actually a TPM/RPM rate limit
  if (extracted.includes('RESOURCE_EXHAUSTED')) {
    return `Google API Rate Limit (TPM/RPM) exceeded. Please wait a minute for limits to reset, or reduce your context size. (Google's raw error: ${extracted})`;
  }
  return extracted;
}

module.exports = {
  log,
  verboseLog,
  updateStatusBar,
  setupStreamResponse,
  sendJson,
  readBody,
  buildStreamChunk,
  buildCompletion,
  parseRetryAfter,
  extractProviderError,
};
