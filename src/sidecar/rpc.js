'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');

// ─────────────────────────────────────────────
// ConnectRPC communication with the sidecar
// ─────────────────────────────────────────────

/**
 * Low-level H2 ConnectRPC unary call.
 * Both JSON and Proto callers delegate here — the only difference is
 * `contentType`, the serialised `payload` buffer, and how the caller
 * interprets the returned `Buffer`.
 */
function _makeH2UnaryCallOnce(port, csrf, certPath, method, contentType, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let ca;
    try {
      ca = certPath ? fs.readFileSync(certPath) : undefined;
    } catch {
      /* ignore */
    }
    const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
    const chunks = [];
    let status;
    let settled = false;
    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        fn(val);
      }
    };
    client.on('error', (err) => {
      settle(reject, new Error('H2 connect: ' + err.message));
    });
    client.on('connect', () => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/exa.language_server_pb.LanguageServerService/${method}`,
        'content-type': contentType,
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrf,
      });
      req.on('response', (h) => {
        status = h[':status'];
      });
      req.on('data', (d) => {
        chunks.push(d);
      });
      req.on('end', () => {
        client.close();
        const body = Buffer.concat(chunks);
        if (status === 200) {
          settle(resolve, body);
        } else {
          settle(reject, new Error(`HTTP ${status}: ${body.toString('utf8').substring(0, 150)}`));
        }
      });
      req.on('error', (e) => {
        client.close();
        settle(reject, e);
      });
      req.write(payload);
      req.end();
    });
    setTimeout(() => {
      try {
        client.close();
      } catch {}
      settle(reject, new Error('H2 timeout'));
    }, timeoutMs);
  });
}

/**
 * Low-level H2 ConnectRPC streaming call (server-streaming).
 * The server streams responses after receiving our single request frame.
 * Timeout resolution (not rejection) is intentional — the sidecar starts
 * processing asynchronously and we poll for results separately.
 */
function _makeH2StreamingCallOnce(port, csrf, certPath, method, contentType, payload) {
  return new Promise((resolve, reject) => {
    let ca;
    try {
      ca = certPath ? fs.readFileSync(certPath) : undefined;
    } catch {
      /* ignore */
    }
    const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
    let status;
    const chunks = [];

    const timer = setTimeout(() => {
      try {
        client.close();
      } catch {}
      resolve(); // streaming RPC — timeout is normal, means server started streaming
    }, 30000);

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('H2 connect: ' + err.message));
    });

    client.on('connect', () => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/exa.language_server_pb.LanguageServerService/${method}`,
        'content-type': contentType,
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrf,
      });
      req.on('response', (h) => {
        status = h[':status'];
      });
      req.on('data', (d) => {
        chunks.push(d);
      });
      req.on('end', () => {
        clearTimeout(timer);
        try {
          client.close();
        } catch {}
        if (status === 200) resolve();
        else {
          const body = Buffer.concat(chunks).toString('utf8');
          reject(new Error(`HTTP ${status}: ${body.substring(0, 150)}`));
        }
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        try {
          client.close();
        } catch {}
        if (status === 200 || chunks.length > 0) resolve();
        else reject(e);
      });
      req.write(payload);
      req.end();
    });
  });
}

/** Retry wrapper for transient H2 connect/timeout errors */
async function _withRetry(fn, retries = 2, retryOnTimeout = true) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isTimeout = e.message.includes('H2 timeout');
      const isConnect = e.message.includes('H2 connect:');
      // Don't retry on timeout if caller set a custom (long) timeout — the request legitimately failed
      if (attempt < retries && (isConnect || (isTimeout && retryOnTimeout))) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ─────────────────────────────────────────────
// Public: JSON calls
// ─────────────────────────────────────────────

/** Make a unary H2+JSON ConnectRPC call (with automatic retry) */
async function makeH2JsonCall(port, csrf, certPath, method, body, retries = 2, timeoutMs = 10000) {
  const payload = Buffer.from(JSON.stringify(body));
  // If caller set a custom timeout (e.g. for inference), don't retry on timeout — the request ran its full duration
  const retryOnTimeout = timeoutMs <= 10000;
  const raw = await _withRetry(
    () => _makeH2UnaryCallOnce(port, csrf, certPath, method, 'application/json', payload, timeoutMs),
    retries,
    retryOnTimeout,
  );
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return raw.toString('utf8');
  }
}

/** Make a streaming H2+JSON ConnectRPC call */
function makeH2StreamingCall(port, csrf, certPath, method, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return _makeH2StreamingCallOnce(port, csrf, certPath, method, 'application/json', payload);
}

// ─────────────────────────────────────────────
// Public: Proto calls
// ─────────────────────────────────────────────

/** Make a unary H2+Proto ConnectRPC call (with automatic retry) */
async function makeH2ProtoCall(port, csrf, certPath, method, protoBytes, retries = 2) {
  const payload = Buffer.from(protoBytes);
  const raw = await _withRetry(
    () => _makeH2UnaryCallOnce(port, csrf, certPath, method, 'application/proto', payload),
    retries,
  );
  return new Uint8Array(raw);
}

/** Make a streaming H2+Proto ConnectRPC call */
function makeH2ProtoStreamingCall(port, csrf, certPath, method, protoBytes) {
  const payload = Buffer.from(protoBytes);
  return _makeH2StreamingCallOnce(port, csrf, certPath, method, 'application/proto', payload);
}

// ─────────────────────────────────────────────
// Legacy: HTTP/1.1 ConnectRPC (with HTTPS→HTTP fallback)
// ─────────────────────────────────────────────

function makeConnectRpcCallOnPort(port, csrf, certPath, servicePath, payload) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port,
      path: servicePath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
    };

    if (certPath) {
      try {
        options.ca = fs.readFileSync(certPath);
      } catch {
        /* ignore */
      }
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      // If HTTPS fails, try HTTP
      if (
        err.code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
        err.message.includes('SSL') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('disconnected') ||
        err.message.includes('EPIPE')
      ) {
        const httpOpts = { ...options };
        delete httpOpts.ca;
        delete httpOpts.rejectUnauthorized;
        const httpReq = http.request(httpOpts, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(body));
              } catch {
                resolve(body);
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
            }
          });
        });
        httpReq.on('error', reject);
        httpReq.setTimeout(10000, () => {
          httpReq.destroy(new Error('Timeout'));
        });
        httpReq.write(payload);
        httpReq.end();
      } else {
        reject(err);
      }
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error('Timeout'));
    });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  makeH2JsonCall,
  makeH2StreamingCall,
  makeH2ProtoCall,
  makeH2ProtoStreamingCall,
  makeConnectRpcCallOnPort,
};
