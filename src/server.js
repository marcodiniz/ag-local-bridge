'use strict';

const vscode = require('vscode');
const http = require('http');
const { log, sendJson, updateStatusBar } = require('./utils');
const { handleModels } = require('./handlers/models');
const { handleChatCompletions } = require('./handlers/chat');
const { handleProxy } = require('./handlers/proxy');
const { handleDebug } = require('./handlers/debug');

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

async function startServer(ctx) {
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  const port = config.get('port', 11435);
  if (ctx.server) await stopServer(ctx);

  ctx.server = http.createServer((req, res) => {
    handleRequest(ctx, req, res).catch((err) => {
      log(ctx, `Request error: ${err.message}`, true);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } });
    });
  });

  await new Promise((resolve, reject) => {
    ctx.server.listen(port, '127.0.0.1', () => {
      log(ctx, `✅ Server running on http://localhost:${port}`);
      updateStatusBar(ctx, true, port);
      resolve();
    });
    ctx.server.on('error', (err) => {
      log(ctx, `❌ Server failed: ${err.message}`, true);
      updateStatusBar(ctx, false);
      reject(err);
    });
  });
}

function stopServer(ctx) {
  return new Promise((resolve) => {
    if (!ctx.server) {
      resolve();
      return;
    }
    ctx.server.close(() => {
      ctx.server = null;
      updateStatusBar(ctx, false);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────
// Request Router
// ─────────────────────────────────────────────

/**
 * Check if an Origin header value is from localhost.
 * Allows http://localhost:<port> and http://127.0.0.1:<port>.
 */
function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

async function handleRequest(ctx, req, res) {
  // Only allow localhost origins — prevents arbitrary websites
  // from calling the API via browser fetch. Non-browser clients (curl, SDKs)
  // don't send Origin and are unaffected since we bind to 127.0.0.1 only.
  const origin = req.headers['origin'];
  if (origin) {
    if (!isLocalhostOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden: Invalid Origin', type: 'forbidden' } }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(origin ? 204 : 403);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    return handleModels(ctx, req, res);
  }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    return handleChatCompletions(ctx, req, res);
  }
  if (req.method === 'GET' && url.pathname === '/v1/debug') return handleDebug(ctx, req, res);
  if (req.method === 'GET' && url.pathname === '/v1/captures') {
    return sendJson(res, 200, { captures: ctx.capturedPayloads });
  }
  if (req.method === 'POST' && url.pathname === '/v1/proxy') return handleProxy(ctx, req, res);

  sendJson(res, 404, { error: { message: `Unknown: ${req.method} ${url.pathname}`, type: 'not_found' } });
}

module.exports = { startServer, stopServer, isLocalhostOrigin };
