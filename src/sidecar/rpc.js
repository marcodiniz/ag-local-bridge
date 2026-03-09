'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');

// ─────────────────────────────────────────────
// ConnectRPC communication with the sidecar
// ─────────────────────────────────────────────

/** Make a H2+JSON ConnectRPC call to the LanguageServerService (with automatic retry on transient connect failures) */
async function makeH2JsonCall(port, csrf, certPath, method, body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await _makeH2JsonCallOnce(port, csrf, certPath, method, body);
    } catch (e) {
      // Retry on transient H2 connect errors (empty message = TLS/socket race)
      if (attempt < retries && (e.message.includes('H2 connect:') || e.message.includes('H2 timeout'))) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

function _makeH2JsonCallOnce(port, csrf, certPath, method, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let ca;
    try {
      ca = certPath ? fs.readFileSync(certPath) : undefined;
    } catch {
      /* ignore */
    }
    const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
    let totalBody = '';
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
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrf,
      });
      req.on('response', (h) => {
        status = h[':status'];
      });
      req.on('data', (d) => {
        totalBody += d.toString('utf8');
      });
      req.on('end', () => {
        client.close();
        if (status === 200) {
          try {
            settle(resolve, JSON.parse(totalBody));
          } catch {
            settle(resolve, totalBody);
          }
        } else {
          settle(reject, new Error(`HTTP ${status}: ${totalBody.substring(0, 150)}`));
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
    }, 10000);
  });
}

/** Make a streaming H2+JSON ConnectRPC call to the LanguageServerService (for SendUserCascadeMessage etc.) */
function makeH2StreamingCall(port, csrf, certPath, method, body) {
  const payload = JSON.stringify(body);
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
        'content-type': 'application/json',
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
  makeConnectRpcCallOnPort,
};
