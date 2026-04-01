'use strict';

const vscode = require('vscode');
const http = require('http');
const { log, sendJson, updateStatusBar } = require('./utils');
const { handleModels } = require('./handlers/models');
const { handleChatCompletions } = require('./handlers/chat');
const { handleAnthropicMessages, handleCountTokens } = require('./handlers/anthropic');
const { handleGeminiGenerateContent, parseGeminiPath } = require('./handlers/gemini');
const { handleProxy } = require('./handlers/proxy');
const { handleDebug } = require('./handlers/debug');

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

async function startServer(ctx) {
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  const basePort = config.get('port', 11435);
  if (ctx.server) await stopServer(ctx);

  ctx.server = http.createServer((req, res) => {
    handleRequest(ctx, req, res).catch((err) => {
      log(ctx, `Request error: ${err.message}`, true);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } });
      } else if (!res.writableEnded) {
        // If it's a stream, send an error chunk and end it
        res.write(`data: {"error": "${err.message.replace(/"/g, '\\"')}"}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  });

  // Prevent Node's default idle timeout from breaking long-running LLM inferences
  ctx.server.timeout = 0;
  ctx.server.keepAliveTimeout = 0;

  let bound = false;
  const maxRetries = 10;
  for (let offset = 0; offset <= maxRetries; offset++) {
    const port = basePort + offset;
    try {
      await new Promise((resolve, reject) => {
        function onError(err) {
          if (err.code === 'EADDRINUSE') {
            resolve(false);
          } else {
            reject(err);
          }
        }
        ctx.server.once('error', onError);
        ctx.server.listen(port, '127.0.0.1', () => {
          ctx.server.removeListener('error', onError);
          log(ctx, `✅ Server running on http://localhost:${port}`);
          updateStatusBar(ctx, true, port);
          resolve(true);
        });
      });

      if (ctx.server.listening) {
        bound = true;
        // Attach persistent error handler after a successful bind
        ctx.server.on('error', (err) => {
          log(ctx, `❌ Server runtime error: ${err.message}`, true);
          updateStatusBar(ctx, false);
        });
        break;
      }
    } catch (err) {
      log(ctx, `❌ Server startup failed: ${err.message}`, true);
      updateStatusBar(ctx, false);
      throw err;
    }
  }

  if (!bound) {
    const errMsg = `listen EADDRINUSE: Exhausted ${maxRetries} sequential ports starting at ${basePort}`;
    log(ctx, `❌ Server failed: ${errMsg}`, true);
    updateStatusBar(ctx, false);
    throw new Error(errMsg);
  }
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
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

  // ── Anthropic-compatible endpoints ──
  // POST /v1/messages — full Anthropic Messages API
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    return handleAnthropicMessages(ctx, req, res);
  }
  // POST /v1/messages/count_tokens — preflight mock for Claude CLI / Cherry Studio
  if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    return handleCountTokens(ctx, req, res);
  }

  // ── Gemini-native endpoints ──
  // POST /v1beta/models/:model:generateContent
  // POST /v1beta/models/:model:streamGenerateContent
  if (req.method === 'POST' && url.pathname.startsWith('/v1beta/models/')) {
    const { model, isStream } = parseGeminiPath(url.pathname);
    req._geminiStream = isStream;
    return handleGeminiGenerateContent(ctx, req, res, model);
  }

  if (req.method === 'GET' && url.pathname === '/v1/debug') return handleDebug(ctx, req, res);
  if (req.method === 'GET' && url.pathname === '/v1/captures') {
    return sendJson(res, 200, { captures: ctx.capturedPayloads });
  }
  if (req.method === 'POST' && url.pathname === '/v1/proxy') return handleProxy(ctx, req, res);

  sendJson(res, 404, { error: { message: `Unknown: ${req.method} ${url.pathname}`, type: 'not_found' } });
}

module.exports = { startServer, stopServer, isLocalhostOrigin };
