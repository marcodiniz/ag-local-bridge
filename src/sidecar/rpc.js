'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');

const caCache = new Map();

function getCachedCa(certPath) {
  if (!certPath) return undefined;
  if (caCache.has(certPath)) return caCache.get(certPath);
  try {
    const ca = fs.readFileSync(certPath);
    caCache.set(certPath, ca);
    return ca;
  } catch {
    caCache.set(certPath, undefined);
    return undefined;
  }
}

const h2Clients = new Map();

function getH2Client(port, csrf, certPath) {
  const key = `${port}:${csrf}:${certPath || ''}`;
  if (h2Clients.has(key)) {
    const client = h2Clients.get(key);
    if (!client.closed && !client.destroyed) {
      return client;
    }
    h2Clients.delete(key);
  }

  const client = http2.connect(`https://localhost:${port}`, {
    ca: getCachedCa(certPath),
    rejectUnauthorized: false,
  });

  client.on('error', () => {
    h2Clients.delete(key);
    try {
      client.close();
    } catch {}
  });

  client.on('close', () => {
    h2Clients.delete(key);
  });

  client.on('goaway', () => {
    h2Clients.delete(key);
    try {
      client.close();
    } catch {}
  });

  h2Clients.set(key, client);
  return client;
}

function clearH2Clients() {
  for (const [key, client] of h2Clients.entries()) {
    try {
      if (!client.closed && !client.destroyed) {
        client.close();
      }
    } catch {}
    h2Clients.delete(key);
  }
}

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
    let client;
    try {
      client = getH2Client(port, csrf, certPath);
    } catch (err) {
      return reject(new Error('H2 connect: ' + err.message));
    }

    let req;
    let status;
    const chunks = [];
    let settled = false;
    let timer = null;

    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        fn(val);
      }
    };

    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/exa.language_server_pb.LanguageServerService/${method}`,
        'content-type': contentType,
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrf,
      });
    } catch (err) {
      return settle(reject, new Error('H2 connect: ' + err.message));
    }

    req.on('response', (h) => {
      status = h[':status'];
    });

    req.on('data', (d) => {
      chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (status === 200) {
        settle(resolve, body);
      } else {
        settle(reject, new Error(`HTTP ${status}: ${body.toString('utf8').substring(0, 1000)}`));
      }
    });

    req.on('error', (e) => {
      settle(reject, e);
    });

    req.write(payload);
    req.end();

    timer = setTimeout(() => {
      if (!settled) {
        try {
          req.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
        settle(reject, new Error('H2 timeout'));
      }
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
    let client;
    try {
      client = getH2Client(port, csrf, certPath);
    } catch (err) {
      return reject(new Error('H2 connect: ' + err.message));
    }

    let req;
    let status;
    const chunks = [];

    const timer = setTimeout(() => {
      resolve(); // streaming RPC — timeout is normal, means server started streaming
    }, 30000);

    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/exa.language_server_pb.LanguageServerService/${method}`,
        'content-type': contentType,
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrf,
      });
    } catch (err) {
      clearTimeout(timer);
      return reject(new Error('H2 connect: ' + err.message));
    }

    req.on('response', (h) => {
      status = h[':status'];
    });

    req.on('data', (d) => {
      chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    });

    req.on('end', () => {
      clearTimeout(timer);
      if (status === 200) resolve();
      else {
        const body = Buffer.concat(chunks).toString('utf8');
        reject(new Error(`HTTP ${status}: ${body.substring(0, 1000)}`));
      }
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      if (status === 200 || chunks.length > 0) resolve();
      else reject(e);
    });

    req.write(payload);
    req.end();
  });
}

/** Retry wrapper for transient H2 connect/timeout errors */
async function _withRetry(fn, retries = 2, retryOnTimeout = true) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.message || '';
      const isTimeout = msg.includes('H2 timeout');
      const isTransient =
        msg.includes('H2 connect:') ||
        msg.includes('socket hang up') ||
        msg.includes('ECONNRESET') ||
        msg.includes('EPIPE') ||
        msg.includes('Client session is closed') ||
        msg.includes('stream closed') ||
        msg.includes('Stream closed') ||
        msg.includes('cancel');

      // Don't retry on timeout if caller set a custom (long) timeout — the request legitimately failed
      if (attempt < retries && (isTransient || (isTimeout && retryOnTimeout))) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1))); // faster retry spacing
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
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 1000)}`));
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
              reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 1000)}`));
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
  clearH2Clients,
};
