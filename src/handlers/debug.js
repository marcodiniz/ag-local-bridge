'use strict';

const vscode = require('vscode');
const { log, sendJson } = require('../utils');
const { MODEL_MAP, DEFAULT_MODEL_KEY } = require('../models');
const { discoverSidecar } = require('../sidecar/discovery');
const { makeH2JsonCall, makeConnectRpcCallOnPort } = require('../sidecar/rpc');

// ─────────────────────────────────────────────
// Debug & Diagnostics
// ─────────────────────────────────────────────

async function handleDebug(ctx, req, res) {
  const result = { sidecar: {}, interceptedAuth: {}, lm: {}, chatAPI: {} };

  // Intercepted CSRF
  result.interceptedAuth = {
    hasCsrf: !!ctx.interceptedCsrf,
    csrfPrefix: ctx.interceptedCsrf ? ctx.interceptedCsrf.substring(0, 8) + '...' : null,
    port: ctx.interceptedPort,
  };

  // Bridge Status
  result.bridge = {
    chatRequestsInFlight: ctx.chatRequestsInFlight,
    lastUserMessageHash: ctx.lastUserMessageHash,
    timeSinceLastResponseSec: Math.round((Date.now() - ctx.lastResponseTimestamp) / 1000),
    uptimeSec: Math.round((Date.now() - (ctx.lastResponseTimestamp || Date.now())) / 1000), // approximate
  };

  // Sidecar
  const info = await discoverSidecar(ctx);
  result.sidecar = info || { error: 'Not found' };

  // LM
  try {
    if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
      const models = await vscode.lm.selectChatModels({});
      result.lm = {
        available: true,
        models: (models || []).map((m) => ({ id: m.id, vendor: m.vendor, family: m.family, name: m.name })),
      };
    }
  } catch (e) {
    result.lm = { error: e.message };
  }

  // Chat
  result.chatAPI = { available: !!(vscode.chat && typeof vscode.chat.createChatParticipant === 'function') };

  // Test sidecar connectivity
  if (info) {
    result.sidecar.connectTests = [];
    // Test ExtensionServerService on ext port
    const extCsrf = info.csrfTokens[info.csrfTokens.length - 1]; // extension_server_csrf_token
    try {
      const _testResult = await makeConnectRpcCallOnPort(
        info.extensionServerPort,
        extCsrf,
        info.certPath,
        '/exa.extension_server_pb.ExtensionServerService/PlaySound',
        '{}',
      );
      result.sidecar.connectTests.push({
        port: info.extensionServerPort,
        service: 'ExtensionServerService',
        success: true,
      });
    } catch (e) {
      result.sidecar.connectTests.push({
        port: info.extensionServerPort,
        service: 'ExtensionServerService',
        success: false,
        error: e.message.substring(0, 100),
      });
    }
    // Test LanguageServerService on HTTPS ports (uses mainCsrf = csrfTokens[0])
    const mainCsrf = info.csrfTokens[0]; // --csrf_token
    for (const port of info.actualPorts.filter((p) => p !== info.extensionServerPort)) {
      try {
        const _testResult = await makeConnectRpcCallOnPort(
          port,
          mainCsrf,
          info.certPath,
          '/exa.language_server_pb.LanguageServerService/GetAvailableCascadePlugins',
          '{}',
        );
        result.sidecar.connectTests.push({
          port,
          service: 'LanguageServerService',
          success: true,
          sample: typeof _testResult === 'object' ? Object.keys(_testResult).join(',') : 'string',
        });
      } catch (e) {
        result.sidecar.connectTests.push({
          port,
          service: 'LanguageServerService',
          success: false,
          error: e.message.substring(0, 100),
        });
      }
    }
  }

  sendJson(res, 200, result);
}

async function probeSidecar(ctx) {
  ctx.outputChannel.show();
  log(ctx, '─── Probing Sidecar ───');
  const info = await discoverSidecar(ctx);
  if (!info) {
    log(ctx, '❌ Sidecar not found');
    return;
  }
  log(ctx, `PID: ${info.pid}`);
  log(ctx, `Ports: ${info.actualPorts.join(', ')}`);
  log(ctx, `Tokens: ${info.csrfTokens.map((t) => t.substring(0, 8) + '...').join(', ')}`);
  log(ctx, `Cert: ${info.certPath || 'not found'}`);

  const testPath = '/exa.extension_server.ExtensionServer/GetAvailableCascadePlugins';
  for (const port of info.actualPorts) {
    for (const csrf of info.csrfTokens) {
      try {
        const r = await makeConnectRpcCallOnPort(port, csrf, info.certPath, testPath, '{}');
        log(ctx, `✅ port=${port} token=${csrf.substring(0, 8)}... → ${JSON.stringify(r).substring(0, 200)}`);
      } catch (e) {
        log(ctx, `❌ port=${port} token=${csrf.substring(0, 8)}... → ${e.message}`);
      }
    }
  }
}

async function diagnoseModels(ctx) {
  ctx.outputChannel.show();

  // 1. Show bridge MODEL_MAP (the models available via the OpenAI-compatible API)
  log(ctx, '─── AG Local Bridge Models ───');
  const visible = Object.entries(MODEL_MAP).filter(([, m]) => !m.hidden);
  if (visible.length === 0) {
    log(ctx, '⚠️ No models configured in MODEL_MAP');
  } else {
    log(ctx, `  ${visible.length} model(s) available:`);
    for (const [id, m] of visible) {
      log(ctx, `  ✅ ${id}  →  enum=${m.value}  "${m.name}"  (${m.owned_by}, ctx=${m.context}, out=${m.output})`);
    }
    log(ctx, `  Default: ${DEFAULT_MODEL_KEY}`);
  }

  // 2. Check sidecar connectivity
  log(ctx, '─── Sidecar Status ───');
  const info = await discoverSidecar(ctx);
  if (!info) {
    log(ctx, '  ❌ Sidecar not found');
  } else {
    log(ctx, `  PID: ${info.pid}`);
    log(ctx, `  Ports: ${info.actualPorts.join(', ')}`);
    log(ctx, `  Cert: ${info.certPath ? 'yes' : 'no'}`);
    // Quick connectivity test on LS port
    const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
    let connected = false;
    for (const port of lsPorts) {
      try {
        await makeH2JsonCall(port, info.csrfTokens[0], info.certPath, 'GetStatus', {});
        log(ctx, `  ✅ LS port ${port} — connected`);
        connected = true;
        break;
      } catch (e) {
        log(ctx, `  ❌ LS port ${port} — ${e.message.substring(0, 60)}`);
      }
    }
    if (connected) {
      log(ctx, '  → Models above should work via POST /v1/chat/completions');
    } else {
      log(ctx, '  ⚠️ No reachable LS port — sidecar calls will fail');
    }
  }
}

async function diagnoseCommands(ctx) {
  ctx.outputChannel.show();
  log(ctx, '─── Antigravity Commands ───');
  const all = await vscode.commands.getCommands(true);
  all
    .filter(
      (c) =>
        c.toLowerCase().includes('antigravity') ||
        c.toLowerCase().includes('jetski') ||
        c.toLowerCase().includes('cascade'),
    )
    .forEach((c) => log(ctx, `  ${c}`));
}

async function showStatus(ctx) {
  ctx.outputChannel.show();
  const config = vscode.workspace.getConfiguration('agLocalBridge');
  const port = config.get('port', 11435);
  const info = await discoverSidecar(ctx);

  log(ctx, '─── AG Local Bridge Status ───');
  log(ctx, `  Server: ${ctx.server ? `✅ http://localhost:${port}` : '❌ Stopped'}`);
  log(ctx, `  Sidecar: ${info ? `✅ port ${info.extensionServerPort}` : '❌ Not found'}`);
}

module.exports = { handleDebug, probeSidecar, diagnoseModels, diagnoseCommands, showStatus };
