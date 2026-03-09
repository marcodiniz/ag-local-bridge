// AG Local Bridge — VS Code Extension
// Exposes Antigravity as a local OpenAI-compatible HTTP API on localhost:11435
//
// Architecture:
//   HTTP server (:11435) → discovers sidecar process → calls sidecar ConnectRPC → returns OpenAI response
//
// The sidecar (language_server_{platform}) runs a ConnectRPC server on a dynamic HTTPS port
// with CSRF tokens. We discover these from the process command line at runtime.
// Binary names: Windows=language_server_windows_x64.exe, macOS=language_server_macos, Linux=language_server_linux

'use strict';

const vscode = require('vscode');
const { createContext } = require('./context');
const { log } = require('./utils');
const httpsInterceptor = require('./interceptors/https');
const httpServerInterceptor = require('./interceptors/http-server');
const h2Interceptor = require('./interceptors/h2');
const { startServer, stopServer } = require('./server');
const { showStatus, diagnoseModels, diagnoseCommands, probeSidecar } = require('./handlers/debug');

/** @type {ReturnType<typeof createContext>} */
let ctx;

// ─────────────────────────────────────────────
// Activation
// ─────────────────────────────────────────────

function activate(context) {
  ctx = createContext();

  ctx.outputChannel = vscode.window.createOutputChannel('AG Local Bridge');
  context.subscriptions.push(ctx.outputChannel);

  // Hook interceptors (must be before sidecar calls)
  httpsInterceptor.install(ctx);
  httpServerInterceptor.install(ctx);
  h2Interceptor.install(ctx);

  ctx.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  ctx.statusBarItem.command = 'agLocalBridge.showStatus';
  ctx.statusBarItem.tooltip = 'Antigravity Bridge — Click for status';
  context.subscriptions.push(ctx.statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('agLocalBridge.start', () => startServer(ctx)),
    vscode.commands.registerCommand('agLocalBridge.stop', () => stopServer(ctx)),
    vscode.commands.registerCommand('agLocalBridge.showStatus', () => showStatus(ctx)),
    vscode.commands.registerCommand('agLocalBridge.listModels', () => diagnoseModels(ctx)),
    vscode.commands.registerCommand('agLocalBridge.listCommands', () => diagnoseCommands(ctx)),
    vscode.commands.registerCommand('agLocalBridge.probeSidecar', () => probeSidecar(ctx)),
  );

  log(ctx, 'Extension activated. Starting server...');
  startServer(ctx).catch((err) => log(ctx, `Startup error: ${err.message}`, true));

  // Prune stale activeCascades entries every 30 minutes
  const CASCADE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
  const pruneInterval = setInterval(
    () => {
      const cutoff = Date.now() - CASCADE_MAX_AGE_MS;
      let pruned = 0;
      for (const [key, entry] of ctx.activeCascades) {
        if (entry.lastUsed < cutoff) {
          ctx.activeCascades.delete(key);
          pruned++;
        }
      }
      if (pruned > 0) log(ctx, `🧹 Pruned ${pruned} stale cascade(s) from activeCascades`);
    },
    30 * 60 * 1000,
  ); // every 30 minutes
  context.subscriptions.push({ dispose: () => clearInterval(pruneInterval) });
}

function deactivate() {
  httpsInterceptor.uninstall(ctx);
  httpServerInterceptor.uninstall(ctx);
  stopServer(ctx);
}

module.exports = { activate, deactivate };
