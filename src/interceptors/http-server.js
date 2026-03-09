'use strict';

const http = require('http');
const { log } = require('../utils');

// ─────────────────────────────────────────────
// HTTP createServer Interceptor
// Observes CSRF tokens on accepted requests
// to Antigravity's local HTTP server.
// ─────────────────────────────────────────────

/** Patch http.createServer — observe CSRF tokens on accepted requests */
function createInterceptedCreateServer(ctx) {
  return function interceptedCreateServer(...args) {
    const server = ctx._originalCreateServer.apply(this, args);

    // Wrap the server's request handler to observe CSRF tokens
    const _originalEmit = server.emit.bind(server);
    server.emit = function (event, req, res) {
      if (event === 'request' && req && req.headers) {
        const csrf = req.headers['x-codeium-csrf-token'];
        if (csrf && csrf.length > 10) {
          // Wrap res.writeHead to check if this request was accepted (not 403)
          const _origWriteHead = res.writeHead.bind(res);
          res.writeHead = function (statusCode, ...whArgs) {
            if (statusCode !== 403 && csrf !== ctx.interceptedCsrf) {
              ctx.interceptedCsrf = csrf;
              const addr = server.address();
              if (addr && addr.port) ctx.interceptedPort = addr.port;
              if (ctx.outputChannel) {
                ctx.outputChannel.appendLine(
                  `[${new Date().toISOString().slice(11, 23)}] 🔑 [SERVER] Captured CSRF from accepted request on port ${ctx.interceptedPort}: ${csrf.substring(0, 8)}...`,
                );
              }
            }
            return _origWriteHead(statusCode, ...whArgs);
          };
        }
      }
      return _originalEmit(event, req, res);
    };

    return server;
  };
}

function install(ctx) {
  ctx._originalCreateServer = http.createServer;
  ctx._interceptedCreateServer = createInterceptedCreateServer(ctx);
  http.createServer = ctx._interceptedCreateServer;
  log(ctx, `🔌 HTTP createServer interceptor installed`);
}

function uninstall(ctx) {
  // Only restore if the current value is still OUR patch.
  if (ctx._originalCreateServer && http.createServer === ctx._interceptedCreateServer) {
    http.createServer = ctx._originalCreateServer;
  }
  ctx._originalCreateServer = null;
  ctx._interceptedCreateServer = null;
  log(ctx, `🔌 HTTP createServer interceptor removed`);
}

module.exports = { install, uninstall };
