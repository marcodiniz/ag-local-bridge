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

  // Write to temporary global disk if explicit configuration is enabled (for debugging)
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  if (config.get('logToFile', false)) {
    try {
      const logFilePath = path.join(os.tmpdir(), 'ag-local-bridge.log');
      fs.appendFileSync(logFilePath, `[${ts}] ${msg}\n`, 'utf8');
    } catch {
      // ignore filesystem errors for log files
    }
  }
}

/** Log only when agLocalBridge.logRequests is enabled (verbose/debug output) */
function verboseLog(ctx, msg) {
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  if (config.get('logRequests', false)) log(ctx, msg);
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

module.exports = {
  log,
  verboseLog,
  updateStatusBar,
  setupStreamResponse,
  sendJson,
  readBody,
  buildStreamChunk,
  buildCompletion,
};
