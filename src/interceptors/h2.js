'use strict';

const http2 = require('http2');
const { log } = require('../utils');

// ─────────────────────────────────────────────
// H2 Session Interceptor
// Captures outgoing ConnectRPC payloads from
// Antigravity's H2 sessions to the sidecar.
// ─────────────────────────────────────────────

function install(ctx) {
  try {
    const _originalH2Connect = http2.connect;
    http2.connect = function interceptedH2Connect(authority, ...args) {
      let session;
      try {
        session = _originalH2Connect.call(this, authority, ...args);
      } catch (_e) {
        return _originalH2Connect.call(this, authority, ...args);
      }
      try {
        const authorityStr = String(authority);
        if (authorityStr.includes('localhost') || authorityStr.includes('127.0.0.1')) {
          const _originalRequest = session.request.bind(session);
          session.request = function interceptedH2Request(headers, ...reqArgs) {
            let stream;
            try {
              stream = _originalRequest(headers, ...reqArgs);
            } catch (_e) {
              return _originalRequest(headers, ...reqArgs);
            }
            try {
              const path = (headers && headers[':path']) || '';
              if (
                path.includes('/exa.language_server_pb.LanguageServerService/') ||
                path.includes('/exa.extension_server_pb.ExtensionServerService/')
              ) {
                const method = path.split('/').pop();
                const ct = (headers && headers['content-type']) || '';
                const chunks = [];
                const _origWrite = stream.write.bind(stream);
                stream.write = function (data, ...wArgs) {
                  try {
                    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                  } catch {}
                  return _origWrite(data, ...wArgs);
                };
                const _origEnd = stream.end.bind(stream);
                stream.end = function (data, ...eArgs) {
                  try {
                    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                    const fullPayload = Buffer.concat(chunks);
                    ctx.capturedPayloads.push({
                      ts: Date.now(),
                      method,
                      contentType: ct,
                      payloadHex: fullPayload.toString('hex').substring(0, 10000),
                      payloadUtf8: fullPayload.toString('utf8').substring(0, 5000),
                      payloadLen: fullPayload.length,
                    });
                    if (ctx.capturedPayloads.length > ctx.MAX_CAPTURES) ctx.capturedPayloads.shift();
                    if (ctx.outputChannel && (method === 'SendUserCascadeMessage' || method === 'StartCascade')) {
                      ctx.outputChannel.appendLine(
                        `[${new Date().toISOString().slice(11, 23)}] 📡 [H2] ${method} ct=${ct} len=${fullPayload.length}`,
                      );
                    }
                  } catch {}
                  return _origEnd(data, ...eArgs);
                };
              }
            } catch {}
            return stream;
          };
        }
      } catch {}
      return session;
    };
    log(ctx, `🔌 H2 interceptor installed`);
  } catch (e) {
    log(ctx, `⚠️ H2 interceptor failed: ${e.message}`);
  }
}

module.exports = { install };
