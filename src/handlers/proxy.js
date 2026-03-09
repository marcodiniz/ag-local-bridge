'use strict';

const { sendJson, readBody } = require('../utils');
const { discoverSidecar } = require('../sidecar/discovery');
const { makeH2JsonCall } = require('../sidecar/rpc');

// ─────────────────────────────────────────────
// POST /v1/proxy — forward RPC to sidecar
// ─────────────────────────────────────────────

async function handleProxy(ctx, req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const method = payload.method || 'GetStatus';
  const rpcBody = payload.body || {};
  const info = await discoverSidecar(ctx);
  if (!info) return sendJson(res, 503, { error: 'Sidecar not found' });
  const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
  for (const port of lsPorts) {
    try {
      const result = await makeH2JsonCall(port, info.csrfTokens[0], info.certPath, method, rpcBody);
      return sendJson(res, 200, result);
    } catch (_e) {
      /* try next port */
    }
  }
  sendJson(res, 503, { error: 'No reachable LS port' });
}

module.exports = { handleProxy };
