// AG Local Bridge — VS Code Extension
// Exposes Antigravity as a local OpenAI-compatible HTTP API on localhost:11435
// 
// Architecture:
//   HTTP server (:11435) → discovers sidecar process → calls sidecar ConnectRPC → returns OpenAI response
//
// The sidecar (language_server_windows_x64.exe) runs a ConnectRPC server on a dynamic HTTPS port
// with CSRF tokens. We discover these from the process command line at runtime.

'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');

/** @type {http.Server | null} */
let server = null;
/** @type {vscode.OutputChannel} */
let outputChannel;
/** @type {vscode.StatusBarItem} */
let statusBarItem;

// Cached sidecar connection info
let sidecarInfo = null;
let sidecarInfoTimestamp = 0;
const SIDECAR_CACHE_TTL = 30000; // 30 seconds

// Concurrency guard variables
let chatRequestsInFlight = 0;
const MAX_CONCURRENT_REQUESTS = 3;
const chatRequestQueue = [];
const MAX_QUEUE_WAIT_MS = 60000;

// Rate limiting / loop-breaking
let lastResponseTimestamp = 0;
const MIN_REQUEST_INTERVAL_MS = 1000; // 1s cooldown between responses
let lastUserMessageHash = '';
let lastUserMessageTimestamp = 0;
const DEDUP_WINDOW_MS = 5000; // 5s dedup window

// CSRF token intercepted from Antigravity's own outgoing requests
let interceptedCsrf = null;
let interceptedPort = null;
let interceptedH2Sessions = new Map(); // port → { csrf, session }

// ─────────────────────────────────────────────
// Model Mapping: string ID → sidecar enum value
// ─────────────────────────────────────────────
const MODEL_MAP = {
    // Antigravity models (PLACEHOLDER_M enum values, 1000+ range)
    'antigravity-gemini-3-flash': { value: 1018, name: 'Gemini 3 Flash', owned_by: 'google', context: 1048576, output: 65536 },
    'antigravity-gemini-3.1-pro-high': { value: 1037, name: 'Gemini 3.1 Pro (High)', owned_by: 'google', context: 1048576, output: 65535 },
    'antigravity-gemini-3.1-pro-low': { value: 1036, name: 'Gemini 3.1 Pro (Low)', owned_by: 'google', context: 1048576, output: 65535 },
    'antigravity-claude-sonnet-4-6': { value: 1035, name: 'Claude Sonnet 4.6 (Thinking)', owned_by: 'anthropic', context: 200000, output: 64000 },
    'antigravity-claude-opus-4-6-thinking': { value: 1026, name: 'Claude Opus 4.6 (Thinking)', owned_by: 'anthropic', context: 200000, output: 64000 },
    'antigravity-gpt-oss-120b': { value: 342, name: 'GPT-OSS 120B (Medium)', owned_by: 'openai', context: 128000, output: 16384 },
    // Aliases for convenience
    'antigravity': { value: 1035, name: 'Antigravity (Default)', owned_by: 'antigravity', context: 200000, output: 64000, hidden: true },
};
const DEFAULT_MODEL_KEY = 'antigravity-claude-sonnet-4-6';

/** Extract text from OpenAI message content (handles both string and content-parts array).
 *  Skips image_url parts — those are handled separately by extractImages(). */
function extractText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => {
                // Skip image parts — they're handled by extractImages()
                if (p && typeof p === 'object' && p.type === 'image_url') return false;
                return true;
            })
            .map(p => {
                if (typeof p === 'string') return p;
                if (p && typeof p === 'object') {
                    if (p.type === 'text' && p.text) return p.text;
                    if (p.text) return p.text;
                    try { return JSON.stringify(p); } catch { return ''; }
                }
                return String(p);
            })
            .filter(t => t.length > 0)
            .join('\n');
    }
    if (typeof content === 'object') {
        if (content.text) return content.text;
        try { return JSON.stringify(content); } catch { return ''; }
    }
    return String(content || '');
}

/**
 * Extract images from OpenAI message content-parts array.
 * Supports:
 *   - data:image/png;base64,... URLs (inline base64)
 *   - https://... URLs (fetched and converted to base64)
 *   - file:///... URIs (read from disk)
 *
 * Returns array of sidecar ImageData objects: { base64Data, mimeType }
 * (JSON field names use camelCase for ConnectRPC JSON mapping)
 */
function extractImages(content) {
    if (!content || !Array.isArray(content)) return [];
    const images = [];
    for (const part of content) {
        if (!part || typeof part !== 'object' || part.type !== 'image_url') continue;
        const urlObj = part.image_url;
        if (!urlObj || !urlObj.url) continue;
        const url = urlObj.url;

        if (url.startsWith('data:')) {
            // data:image/png;base64,iVBOR...
            const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
            if (match) {
                images.push({ base64Data: match[2], mimeType: match[1] });
            }
        } else if (url.startsWith('file:///') || url.startsWith('file:\\\\')) {
            // Local file URI — read from disk
            try {
                const filePath = url.startsWith('file:///')
                    ? url.slice(8).replace(/\//g, path.sep)  // file:///C:/foo → C:\foo
                    : url.slice(8);
                const data = fs.readFileSync(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
                images.push({ base64Data: data.toString('base64'), mimeType: mimeMap[ext] || 'image/png' });
            } catch (e) {
                if (outputChannel) outputChannel.appendLine(`⚠️ Failed to read image file: ${e.message}`);
            }
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
            // Remote URL — will be fetched asynchronously later
            images.push({ remoteUrl: url });
        }
    }
    return images;
}

/**
 * Extract all images from all messages in a conversation.
 * Returns array of ImageData objects ready for the sidecar.
 */
async function extractAllImages(messages) {
    const allImages = [];
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const images = extractImages(msg.content);
        for (const img of images) {
            if (img.remoteUrl) {
                // Fetch remote image
                try {
                    const fetched = await fetchImageAsBase64(img.remoteUrl);
                    if (fetched) allImages.push(fetched);
                } catch (e) {
                    if (outputChannel) outputChannel.appendLine(`⚠️ Failed to fetch remote image: ${e.message}`);
                }
            } else {
                allImages.push(img);
            }
        }
    }
    return allImages;
}

/**
 * Fetch a remote image URL and return as { base64Data, mimeType }.
 * Uses Node's built-in https/http modules.
 */
function fetchImageAsBase64(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                return fetchImageAsBase64(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} fetching image`));
            }
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const contentType = res.headers['content-type'] || 'image/png';
                const mimeType = contentType.split(';')[0].trim();
                resolve({ base64Data: buf.toString('base64'), mimeType });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Image fetch timeout')); });
    });
}

function resolveModel(requestedModel) {
    if (!requestedModel || requestedModel === 'antigravity') return { key: DEFAULT_MODEL_KEY, ...MODEL_MAP[DEFAULT_MODEL_KEY] };
    if (MODEL_MAP[requestedModel]) return { key: requestedModel, ...MODEL_MAP[requestedModel] };
    // Try partial match (e.g. "claude-sonnet" matches "claude-sonnet-4.6")
    const lower = requestedModel.toLowerCase();
    for (const [k, v] of Object.entries(MODEL_MAP)) {
        if (k.includes(lower) || lower.includes(k)) return { key: k, ...v };
    }
    return { key: DEFAULT_MODEL_KEY, ...MODEL_MAP[DEFAULT_MODEL_KEY] };
}

// ─────────────────────────────────────────────
// Request Interceptors
// Capture the real CSRF token from Antigravity's
// outgoing calls to its sidecar server.
// Both extensions share the same Node.js process.
// ─────────────────────────────────────────────

// Hook https.request (HTTP/1.1)
const _originalHttpsRequest = https.request;
https.request = function interceptedRequest(optionsOrUrl, ...args) {
    try {
        const opts = typeof optionsOrUrl === 'string' ? new URL(optionsOrUrl) : optionsOrUrl;
        const host = opts.hostname || opts.host || '';
        const port = parseInt(opts.port) || 443;
        const csrfHeader = opts.headers && (opts.headers['x-csrf-token'] || opts.headers['X-Csrf-Token']);

        if (csrfHeader && (host === 'localhost' || host === '127.0.0.1') && port > 1024) {
            if (csrfHeader !== interceptedCsrf || port !== interceptedPort) {
                interceptedCsrf = csrfHeader;
                interceptedPort = port;
                if (outputChannel) {
                    outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] 🔑 [HTTPS] Intercepted CSRF for port ${port}: ${csrfHeader.substring(0, 8)}...`);
                }
            }
        }
    } catch { /* never break the original call */ }

    return _originalHttpsRequest.call(this, optionsOrUrl, ...args);
};

// Hook http.createServer to intercept requests handled by the extension server.
// When a request with x-codeium-csrf-token passes validation (gets 200), we capture the token.
const _originalCreateServer = http.createServer;
http.createServer = function interceptedCreateServer(...args) {
    const server = _originalCreateServer.apply(this, args);

    // Wrap the server's request handler to observe CSRF tokens
    const _originalEmit = server.emit.bind(server);
    server.emit = function (event, req, res) {
        if (event === 'request' && req && req.headers) {
            const csrf = req.headers['x-codeium-csrf-token'];
            if (csrf && csrf.length > 10) {
                // Wrap res.writeHead to check if this request was accepted (not 403)
                const _origWriteHead = res.writeHead.bind(res);
                res.writeHead = function (statusCode, ...whArgs) {
                    if (statusCode !== 403 && csrf !== interceptedCsrf) {
                        interceptedCsrf = csrf;
                        const addr = server.address();
                        if (addr && addr.port) interceptedPort = addr.port;
                        if (outputChannel) {
                            outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] 🔑 [SERVER] Captured CSRF from accepted request on port ${interceptedPort}: ${csrf.substring(0, 8)}...`);
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

// Captured payloads from the H2 interceptor (installed safely inside activate())
let capturedPayloads = [];
const MAX_CAPTURES = 20;

function installH2Interceptor() {
    try {
        const _originalH2Connect = http2.connect;
        http2.connect = function interceptedH2Connect(authority, ...args) {
            let session;
            try { session = _originalH2Connect.call(this, authority, ...args); }
            catch (e) { return _originalH2Connect.call(this, authority, ...args); }
            try {
                const authorityStr = String(authority);
                if (authorityStr.includes('localhost') || authorityStr.includes('127.0.0.1')) {
                    const _originalRequest = session.request.bind(session);
                    session.request = function interceptedH2Request(headers, ...reqArgs) {
                        let stream;
                        try { stream = _originalRequest(headers, ...reqArgs); }
                        catch (e) { return _originalRequest(headers, ...reqArgs); }
                        try {
                            const path = (headers && headers[':path']) || '';
                            if (path.includes('/exa.language_server_pb.LanguageServerService/') ||
                                path.includes('/exa.extension_server_pb.ExtensionServerService/')) {
                                const method = path.split('/').pop();
                                const ct = (headers && headers['content-type']) || '';
                                const chunks = [];
                                const _origWrite = stream.write.bind(stream);
                                stream.write = function (data, ...wArgs) {
                                    try { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch { }
                                    return _origWrite(data, ...wArgs);
                                };
                                const _origEnd = stream.end.bind(stream);
                                stream.end = function (data, ...eArgs) {
                                    try {
                                        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
                                        const fullPayload = Buffer.concat(chunks);
                                        capturedPayloads.push({
                                            ts: Date.now(), method, contentType: ct,
                                            payloadHex: fullPayload.toString('hex').substring(0, 10000),
                                            payloadUtf8: fullPayload.toString('utf8').substring(0, 5000),
                                            payloadLen: fullPayload.length
                                        });
                                        if (capturedPayloads.length > MAX_CAPTURES) capturedPayloads.shift();
                                        if (outputChannel && (method === 'SendUserCascadeMessage' || method === 'StartCascade')) {
                                            outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] 📡 [H2] ${method} ct=${ct} len=${fullPayload.length}`);
                                        }
                                    } catch { }
                                    return _origEnd(data, ...eArgs);
                                };
                            }
                        } catch { }
                        return stream;
                    };
                }
            } catch { }
            return session;
        };
        if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] 🔌 H2 interceptor installed`);
    } catch (e) {
        if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ⚠️ H2 interceptor failed: ${e.message}`);
    }
}
// ─────────────────────────────────────────────
// Activation
// ─────────────────────────────────────────────

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AG Local Bridge');
    context.subscriptions.push(outputChannel);
    installH2Interceptor(); // Hook http2 sessions to capture outgoing RPC payloads

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'agLocalBridge.showStatus';
    statusBarItem.tooltip = 'Antigravity Bridge — Click for status';
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('agLocalBridge.start', () => startServer()),
        vscode.commands.registerCommand('agLocalBridge.stop', () => stopServer()),
        vscode.commands.registerCommand('agLocalBridge.showStatus', () => showStatus()),
        vscode.commands.registerCommand('agLocalBridge.listModels', () => diagnoseModels()),
        vscode.commands.registerCommand('agLocalBridge.listCommands', () => diagnoseCommands()),
        vscode.commands.registerCommand('agLocalBridge.probeSidecar', () => probeSidecar())
    );

    log('Extension activated. Starting server...');
    startServer().catch((err) => log(`Startup error: ${err.message}`, true));
}

function deactivate() {
    stopServer();
}

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

async function startServer() {
    const config = vscode.workspace.getConfiguration('antigravityBridge');
    const port = config.get('port', 11435);
    if (server) await stopServer();

    server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
            log(`Request error: ${err.message}`, true);
            if (!res.headersSent) sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } });
        });
    });

    await new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => {
            log(`✅ Server running on http://localhost:${port}`);
            updateStatusBar(true, port);
            resolve();
        });
        server.on('error', (err) => {
            log(`❌ Server failed: ${err.message}`, true);
            updateStatusBar(false);
            reject(err);
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        if (!server) { resolve(); return; }
        server.close(() => { server = null; updateStatusBar(false); resolve(); });
    });
}

// ─────────────────────────────────────────────
// Request Router
// ─────────────────────────────────────────────

async function handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return handleModels(req, res);
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) return handleChatCompletions(req, res);
    if (req.method === 'GET' && url.pathname === '/v1/debug') return handleDebug(req, res);
    if (req.method === 'GET' && url.pathname === '/v1/captures') return sendJson(res, 200, { captures: capturedPayloads });
    if (req.method === 'POST' && url.pathname === '/v1/proxy') return handleProxy(req, res);

    sendJson(res, 404, { error: { message: `Unknown: ${req.method} ${url.pathname}`, type: 'not_found' } });
}

// ─────────────────────────────────────────────
// GET /v1/models
// ─────────────────────────────────────────────

async function handleModels(req, res) {
    const data = Object.entries(MODEL_MAP)
        .filter(([, m]) => !m.hidden)
        .map(([id, m]) => ({
            id,
            object: 'model',
            created: 1700000000,
            owned_by: m.owned_by,
        }));
    sendJson(res, 200, { object: 'list', data });
}

// ─────────────────────────────────────────────
// POST /v1/chat/completions
// ─────────────────────────────────────────────

async function handleChatCompletions(req, res) {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); }
    catch { return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } }); }

    // Debug: log incoming request payload
    log(`📥 Request body (${body.length} bytes): ${body.substring(0, 500)}`);

    const isStream = payload.stream === true;
    const messages = payload.messages || [];
    const completionId = `chatcmpl-${randomUUID()}`;

    // Safeguard: detect [object Object] serialization corruption
    const userTexts = messages.filter(m => m.role === 'user').map(m => extractText(m.content));
    const allCorrupted = userTexts.length > 0 && userTexts.every(t => /^\[object Object\]/.test(t));
    if (allCorrupted) {
        log(`⚠️ [object Object] DETECTED — upstream caller is not serializing messages properly!`, true);
        log(`⚠️ Raw messages: ${JSON.stringify(messages).substring(0, 300)}`);
        return sendJson(res, 400, {
            error: {
                message: 'Messages contain "[object Object]" — the caller is not serializing message objects to JSON properly. Check that content is a string or valid content-parts array.',
                type: 'invalid_request',
                raw_messages: messages.slice(0, 3),
            }
        });
    }

    // ── Rate limiting: prevent feedback loops ──
    const now = Date.now();
    const timeSinceLastResponse = now - lastResponseTimestamp;
    if (timeSinceLastResponse < MIN_REQUEST_INTERVAL_MS) {
        log(`🛑 Rate limited — only ${timeSinceLastResponse}ms since last response (min ${MIN_REQUEST_INTERVAL_MS}ms)`);
        return sendJson(res, 429, {
            error: { message: `Rate limited: please wait ${Math.ceil((MIN_REQUEST_INTERVAL_MS - timeSinceLastResponse) / 1000)}s before sending another request.`, type: 'rate_limit' }
        });
    }

    // ── Duplicate detection: same LAST user message within dedup window ──
    const lastUserMsg = userTexts.length > 0 ? userTexts[userTexts.length - 1].trim() : '';
    const msgHash = lastUserMsg.substring(0, 500);
    if (msgHash === lastUserMessageHash && (now - lastUserMessageTimestamp) < DEDUP_WINDOW_MS) {
        log(`🛑 Duplicate message rejected (same message within ${DEDUP_WINDOW_MS / 1000}s)`);
        return sendJson(res, 429, {
            error: { message: 'Duplicate message detected — identical request within dedup window.', type: 'rate_limit' }
        });
    }
    lastUserMessageHash = msgHash;
    lastUserMessageTimestamp = now;

    // Resolve model from request
    const resolved = resolveModel(payload.model);
    log(`📡 Model: ${resolved.key} (enum=${resolved.value})`);

    // Resolve workspace directory: request body > header > VS Code workspace
    let workspaceDir = payload.workspace_dir || req.headers['x-workspace-dir'] || null;

    if (!workspaceDir) {
        try {
            // Combine system and user text for keyword/path scanning
            const sysMsgs = messages.filter(m => m.role === 'system').map(m => extractText(m.content)).join('\n');
            const usrMsgs = messages.filter(m => m.role === 'user').map(m => extractText(m.content)).join('\n');
            const allText = sysMsgs + '\n' + usrMsgs;

            // 1. Look for explicit directory mentions from OpenCode/Cursor system prompt
            const explicitMatch = allText.match(/(?:working in.*?directory|current workspace|workspace directory).*?([a-zA-Z]:\\[^\s"'>]+)/i);
            if (explicitMatch) {
                const candidate = explicitMatch[1].trim();
                if (fs.existsSync(candidate)) {
                    workspaceDir = candidate;
                }
            }

            // 2. Look for .sln absolute paths (common in C# projects if passed in prompt)
            if (!workspaceDir) {
                const slnMatch = allText.match(/([a-zA-Z]:\\[^\s"'>]+\.sln)/i);
                if (slnMatch && fs.existsSync(slnMatch[1])) {
                    workspaceDir = path.dirname(slnMatch[1]);
                }
            }

            // 3. Fallback: Score sibling directories by mentions in the text
            if (!workspaceDir) {
                const folders = vscode.workspace.workspaceFolders;
                if (folders && folders.length > 0 && folders[0].uri.scheme === 'file') {
                    const currentRoot = folders[0].uri.fsPath;
                    const parentDir = path.dirname(currentRoot);
                    if (fs.existsSync(parentDir)) {
                        const siblings = fs.readdirSync(parentDir, { withFileTypes: true })
                            .filter(d => d.isDirectory())
                            .map(d => ({ path: path.join(parentDir, d.name), name: d.name }));

                        let bestMatch = null;
                        let bestScore = 0;
                        for (const { path: p, name } of siblings) {
                            if (name.length < 4) continue; // Ignore very short directory names

                            // Only match whole words, case-insensitive
                            const score = (allText.match(new RegExp(`\\b${name}\\b`, 'gi')) || []).length;
                            if (score > bestScore) {
                                bestScore = score;
                                bestMatch = p;
                            }
                        }
                        if (bestMatch && bestScore > 0) {
                            workspaceDir = bestMatch;
                            log(`📂 Guessed workspace from prompt keywords: ${workspaceDir}`);
                        }
                    }
                }
            }
        } catch (e) {
            log(`⚠️ Workspace auto-detect failed: ${e.message}`);
        }
    }

    if (!workspaceDir) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0 && folders[0].uri.scheme === 'file') {
            workspaceDir = folders[0].uri.fsPath;
        }
    }

    // Convert to file:/// URI format (what the sidecar expects)
    let workspaceUri = null;
    if (workspaceDir) {
        workspaceUri = 'file:///' + workspaceDir.replace(/\\/g, '/');
        log(`📂 Workspace: ${workspaceDir} -> ${workspaceUri}`);
    } else {
        log(`⚠️ No workspace dir resolved — Antigravity may pick a random project`);
    }

    // ── Concurrency guard: limit parallel requests ──
    if (chatRequestsInFlight >= MAX_CONCURRENT_REQUESTS) {
        log(`🛑 Request rejected — ${chatRequestsInFlight} requests already in flight (max ${MAX_CONCURRENT_REQUESTS})`);
        const busyMsg = '[Too many concurrent requests. Please wait and try again.]';
        if (isStream) {
            setupStreamResponse(res);
            res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, busyMsg))}\n\n`);
            res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, null, 'stop'))}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            sendJson(res, 429, { error: { message: busyMsg, type: 'rate_limit' } });
        }
        return;
    }

    chatRequestsInFlight++;
    log(`📡 Requests in flight: ${chatRequestsInFlight}`);
    try {
        await _handleChatCompletionsInner(res, isStream, messages, completionId, resolved, workspaceDir, workspaceUri);
    } finally {
        chatRequestsInFlight--;
        lastResponseTimestamp = Date.now();
        // Drain ALL queued requests (reject them) — don't chain them
        while (chatRequestQueue.length > 0) {
            const queued = chatRequestQueue.shift();
            queued(); // resolve with false (timeout will have fired)
        }
    }
}

async function _handleChatCompletionsInner(res, isStream, messages, completionId, resolved, workspaceDir, workspaceUri) {
    // Extract images from OpenAI-format messages (base64 data URLs, remote URLs, file URIs)
    let images = [];
    try {
        images = await extractAllImages(messages);
        if (images.length > 0) {
            log(`🖼️ Extracted ${images.length} image(s) from messages`);
        }
    } catch (e) {
        log(`⚠️ Image extraction failed: ${e.message}`);
    }

    // Tier 1: Direct sidecar ConnectRPC call
    try {
        const result = await callSidecarChat(messages, resolved.value, workspaceDir, workspaceUri, images);
        if (result) {
            if (isStream) {
                setupStreamResponse(res);
                res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, result))}\n\n`);
                res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, null, 'stop'))}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                sendJson(res, 200, buildCompletion(completionId, resolved.key, result));
            }
            return;
        }
    } catch (err) {
        log(`⚠️ Sidecar call failed: ${err.message}`);
    }

    // Tier 2: Command dispatch (fire-and-forget, returns acknowledgement)
    // NOTE: This can create a feedback loop if the dispatched command routes back through the bridge.
    try {
        const userMessage = messages.filter((m) => m.role === 'user').map((m) => extractText(m.content)).join('\n');
        log(`⚠️ Falling back to Tier 2 command dispatch (sidecar unavailable)`);
        await vscode.commands.executeCommand('antigravity.executeCascadeAction', { type: 'sendMessage', message: userMessage });
        const text = '[Message dispatched to Antigravity agent panel. Check the Antigravity chat panel for the response.]';
        if (isStream) {
            setupStreamResponse(res);
            res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, 'antigravity', text))}\n\n`);
            res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, 'antigravity', null, 'stop'))}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            sendJson(res, 200, buildCompletion(completionId, 'antigravity', text));
        }
        return;
    } catch (err) {
        log(`⚠️ Command dispatch failed: ${err.message}`);
    }

    sendJson(res, 503, { error: { message: 'All tiers failed. Run "Antigravity Bridge: Probe Sidecar" from Command Palette.', type: 'service_unavailable' } });
}

// ─────────────────────────────────────────────
// POST /v1/proxy — forward RPC to sidecar
// ─────────────────────────────────────────────

async function handleProxy(req, res) {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    const method = payload.method || 'GetStatus';
    const rpcBody = payload.body || {};
    const info = discoverSidecar();
    if (!info) return sendJson(res, 503, { error: 'Sidecar not found' });
    const lsPorts = info.actualPorts.filter(p => p !== info.extensionServerPort);
    for (const port of lsPorts) {
        try {
            const result = await makeH2JsonCall(port, info.csrfTokens[0], info.certPath, method, rpcBody);
            return sendJson(res, 200, result);
        } catch (e) { /* try next port */ }
    }
    sendJson(res, 503, { error: 'No reachable LS port' });
}

// ─────────────────────────────────────────────
// Sidecar Discovery & Communication
// ─────────────────────────────────────────────

function discoverSidecar() {
    if (sidecarInfo && (Date.now() - sidecarInfoTimestamp) < SIDECAR_CACHE_TTL) return sidecarInfo;

    try {
        // Get process command line
        const output = execSync(
            'wmic process where "name=\'language_server_windows_x64.exe\'" get ProcessId,CommandLine /format:list',
            { encoding: 'utf8', timeout: 5000 }
        );

        const extPortMatch = output.match(/--extension_server_port\s+(\d+)/);
        const extCsrfMatch = output.match(/--extension_server_csrf_token\s+([a-f0-9-]+)/);
        const mainCsrfMatch = output.match(/--csrf_token\s+([a-f0-9-]+)/);
        const pidMatch = output.match(/ProcessId=(\d+)/);

        if (!extPortMatch) {
            log('⚠️ Could not find sidecar extension_server_port');
            return null;
        }

        // Find actual listening ports via netstat
        let actualPorts = [];
        if (pidMatch) {
            try {
                const netstatOutput = execSync(`netstat -ano`, { encoding: 'utf8', timeout: 5000 });
                const pid = pidMatch[1];
                const lines = netstatOutput.split('\n').filter(l =>
                    l.includes(pid) && l.includes('LISTENING')
                );
                actualPorts = lines.map(l => {
                    const m = l.match(/127\.0\.0\.1:(\d+)/);
                    return m ? parseInt(m[1]) : null;
                }).filter(Boolean);
            } catch { /* ignore netstat errors */ }
        }

        // Find cert
        const agExt = vscode.extensions.getExtension('google.antigravity');
        let certPath = null;
        if (agExt) {
            const candidate = path.join(agExt.extensionPath, 'dist', 'languageServer', 'cert.pem');
            if (fs.existsSync(candidate)) certPath = candidate;
        }

        // Collect all tokens to try (main CSRF first — that's what the HTTPS server validates against)
        const csrfTokens = [];
        if (mainCsrfMatch) csrfTokens.push(mainCsrfMatch[1]);
        if (extCsrfMatch) csrfTokens.push(extCsrfMatch[1]);

        // Collect all ports to try (extension_server_port FIRST, then actual listening ports)
        const portsToTry = [...new Set([parseInt(extPortMatch[1]), ...actualPorts])];

        sidecarInfo = {
            extensionServerPort: parseInt(extPortMatch[1]),
            actualPorts: portsToTry,
            csrfTokens,
            certPath,
            pid: pidMatch ? pidMatch[1] : null,
        };
        sidecarInfoTimestamp = Date.now();

        log(`✅ Sidecar discovered: PID=${sidecarInfo.pid} ports=[${portsToTry.join(',')}] tokens=${csrfTokens.length} cert=${certPath ? 'yes' : 'no'}`);
        return sidecarInfo;
    } catch (err) {
        log(`❌ Sidecar discovery failed: ${err.message}`, true);
        return null;
    }
}

/**
 * Call the sidecar via Cascade:
 *  1. StartCascade → get a new cascadeId
 *  2. SendUserCascadeMessage with confirmed working JSON schema
 *  3. Poll GetCascadeTrajectory until PLANNER_RESPONSE + IDLE
 *  4. Return response text
 *
 * Reverse-engineered from the extension bundle. Key findings:
 *  - requestedModel: { alias: 8 } = MODEL_ALIAS_RECOMMENDED (Gemini 2.5 Pro)
 *  - plannerTypeConfig: { conversational: {} } = conversational cascade mode
 *  - items: [{ text: message }] = user message items array
 */
// Global Mutex for workspace switching
let isWorkspaceSwitching = false;

// Conversation Continuity
const activeCascades = new Map(); // convKey -> { id, lastUsed }
const cascadePromises = new Map(); // convKey -> Promise<string>

function getConversationKey(messages, workspaceDir) {
    const userMsgs = messages.filter(m => m.role === 'user').map(m => extractText(m.content));
    const prefix = workspaceDir ? path.basename(workspaceDir) : 'default';
    if (userMsgs.length === 0) return `${prefix}_system_${Date.now()}`;
    return `${prefix}_${String(userMsgs[0]).substring(0, 50)}`;
}

async function callSidecarChat(messages, modelValue = 1035, workspaceDir = null, workspaceUri = null, images = []) {
    const info = discoverSidecar();
    if (!info) throw new Error('Sidecar not discovered');

    let userMessage = messages.filter((m) => m.role === 'user').map((m) => extractText(m.content)).join('\n');
    const mainCsrf = info.csrfTokens[0];
    const flog = (msg) => { log(msg); try { fs.appendFileSync('C:/Users/User/bridge-debug.log', `[${new Date().toISOString()}] ${msg}\n`); } catch { } };

    // Save images to temp files so the agent can view them with its tools
    const savedImagePaths = [];
    if (images && images.length > 0) {
        const tmpDir = path.join(require('os').tmpdir(), 'ag-bridge-images');
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { }
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!img.base64Data) continue;
            const ext = (img.mimeType || 'image/png').split('/')[1] || 'png';
            const fileName = `bridge_image_${Date.now()}_${i}.${ext}`;
            const filePath = path.join(tmpDir, fileName);
            try {
                fs.writeFileSync(filePath, Buffer.from(img.base64Data, 'base64'));
                savedImagePaths.push(filePath);
                flog(`  🖼️ Saved image ${i + 1} to: ${filePath}`);
            } catch (e) {
                flog(`  ⚠️ Failed to save image: ${e.message}`);
            }
        }
        // Prepend image references to the user message so the agent knows to look at them
        if (savedImagePaths.length > 0) {
            const imageRefs = savedImagePaths.map((p, i) =>
                `[Attached Image ${i + 1}]: ${p.replace(/\\/g, '/')}`
            ).join('\n');
            userMessage = `${imageRefs}\n\n${userMessage}`;
            flog(`  🖼️ Prepended ${savedImagePaths.length} image path(s) to message`);
        }
    }

    // Find a working LS port
    const lsPorts = info.actualPorts.filter(p => p !== info.extensionServerPort);
    let lsPort = null;
    for (const port of lsPorts) {
        try { await makeH2JsonCall(port, mainCsrf, info.certPath, 'GetStatus', {}); lsPort = port; break; }
        catch (e) { flog(`  port ${port} failed: ${e.message.substring(0, 40)}`); }
    }
    if (!lsPort) throw new Error('No reachable LS port');

    const convKey = getConversationKey(messages, workspaceDir);
    let cascadeId = null;

    // Retry loop: start fresh cascade on each attempt (capacity errors leave error steps)
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 10000;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            flog(`  ⏳ Retry ${attempt + 1}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s backoff...`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }

        // --- CONVERSATION MULTIPLEXING ---
        if (cascadePromises.has(convKey)) {
            flog(`  ♻️ Awaiting concurrent cascade creation for conv: ${convKey.replace(/\n/g, '')}...`);
            cascadeId = await cascadePromises.get(convKey);
            flog(`  ♻️ Concurrently Reused cascade: ${cascadeId.substring(0, 8)}`);
        } else if (activeCascades.has(convKey) && (Date.now() - activeCascades.get(convKey).lastUsed < 1000 * 60 * 60 * 4)) {
            cascadeId = activeCascades.get(convKey).id;
            activeCascades.get(convKey).lastUsed = Date.now();
            flog(`  ♻️ Reused existing conversation: ${cascadeId.substring(0, 8)}`);
        } else {
            // Must create a new Cascade. Lock the workspace globally to prevent race conditions across parallel conversations!
            const promise = (async () => {
                while (isWorkspaceSwitching) await new Promise(r => setTimeout(r, 100));
                isWorkspaceSwitching = true;
                try {
                    let originalFolders = null;
                    if (workspaceDir) {
                        const targetUri = vscode.Uri.file(workspaceDir);
                        const currentFolders = vscode.workspace.workspaceFolders || [];
                        const currentFsPaths = currentFolders.map(f => f.uri.fsPath);

                        // Strict match ensures we drop "playground" if it's open alongside the target
                        const isStrictMatch = currentFsPaths.length === 1 && currentFsPaths[0] === workspaceDir;

                        if (!isStrictMatch) {
                            originalFolders = currentFolders.map(f => ({ uri: f.uri, name: f.name }));
                            const success = vscode.workspace.updateWorkspaceFolders(
                                0, currentFolders.length,
                                { uri: targetUri, name: path.basename(workspaceDir) }
                            );
                            if (success) {
                                flog(`  📂 Switched workspace strictly to: ${workspaceDir}`);
                                await new Promise(r => setTimeout(r, 1000)); // Crucial LSP propagation delay
                            } else {
                                flog(`  ⚠️ updateWorkspaceFolders failed`);
                                originalFolders = null;
                            }
                        } else {
                            flog(`  📂 Workspace already exclusively correct: ${workspaceDir}`);
                        }
                    }

                    const startPayload = {};
                    if (workspaceUri) {
                        startPayload.workspacePaths = [workspaceUri];
                        startPayload.workspaceRootPath = workspaceDir;
                    }
                    const startResult = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'StartCascade', startPayload);
                    const newId = startResult && startResult.cascadeId;

                    if (originalFolders && originalFolders.length > 0) {
                        const current = vscode.workspace.workspaceFolders || [];
                        vscode.workspace.updateWorkspaceFolders(0, current.length, ...originalFolders);
                        flog(`  ♻️ Restored ${originalFolders.length} workspace folders`);
                    }

                    if (!newId) throw new Error('StartCascade failed to return cascadeId');
                    return newId;
                } finally {
                    isWorkspaceSwitching = false;
                }
            })();

            cascadePromises.set(convKey, promise);
            try {
                cascadeId = await promise;
                activeCascades.set(convKey, { id: cascadeId, lastUsed: Date.now() });
                flog(`  🆕 New Cascade created: ${cascadeId.substring(0, 8)} (attempt ${attempt + 1})`);
            } catch (err) {
                cascadePromises.delete(convKey);
                throw err;
            } finally {
                cascadePromises.delete(convKey);
            }
        }

        // Send message
        const conversationalConfig = {};
        if (workspaceUri) {
            conversationalConfig.overrideWorkspaceDirExperimentalUseOnly = workspaceUri;
        }
        const sendPayload = {
            cascadeId,
            items: [{ text: userMessage }],
            cascadeConfig: {
                plannerConfig: {
                    plannerTypeConfig: { conversational: conversationalConfig },
                    requestedModel: { model: modelValue },
                },
            },
        };
        // Include images in the sidecar payload
        // Strategy: send via multiple fields for maximum compatibility:
        //   - images: repeated ImageData (uses base64_data + mime_type)
        //   - media: repeated Media (uses inline_data as bytes + mime_type)
        if (images && images.length > 0) {
            // Legacy ImageData field (base64_data = string)
            sendPayload.images = images.map(img => ({
                base64Data: img.base64Data,
                base64_data: img.base64Data,
                mimeType: img.mimeType,
                mime_type: img.mimeType,
            }));
            // Newer Media field (inline_data = bytes encoded as base64)
            sendPayload.media = images.map(img => ({
                mimeType: img.mimeType,
                mime_type: img.mimeType,
                payload: { case: 'inlineData', value: img.base64Data },
                inlineData: img.base64Data,
                inline_data: img.base64Data,
            }));
            const totalKb = Math.round(images.reduce((s, i) => s + (i.base64Data || '').length, 0) / 1024);
            flog(`  🖼️ Including ${images.length} image(s) in payload (~${totalKb}KB base64)`);
        }
        // Also add workspace paths at top level using file URI format
        if (workspaceUri) {
            sendPayload.workspacePaths = [workspaceUri];
            sendPayload.workspacePathsMigrateMeToUris = [workspaceUri];
        }
        try {
            await makeH2StreamingCall(lsPort, mainCsrf, info.certPath, 'SendUserCascadeMessage', sendPayload);
            flog(`  ✅ SendUserCascadeMessage dispatched (attempt ${attempt + 1})`);
            flog(`  📦 Payload: ${JSON.stringify(sendPayload).substring(0, 1000)}`);
        } catch (e) {
            flog(`  ⚠️ SendUserCascadeMessage failed: ${e.message.substring(0, 60)}`);
            activeCascades.delete(convKey);
            continue; // retry with fresh cascade
        }

        // Poll trajectory until PLANNER_RESPONSE + IDLE
        const pollStart = Date.now();
        const maxWait = 60000;
        let shouldRetry = false;
        while (Date.now() - pollStart < maxWait) {
            await new Promise(r => setTimeout(r, 1500));
            const elapsed = Math.round((Date.now() - pollStart) / 1000);
            try {
                const traj = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'GetCascadeTrajectory', { cascadeId });
                const steps = (traj && traj.trajectory && traj.trajectory.steps) || [];
                const status = traj && traj.status;
                flog(`  [poll ${elapsed}s] steps=${steps.length} status=${status}`);

                if (steps.length > 0 && status === 'CASCADE_RUN_STATUS_IDLE') {
                    // Look for response text in PLANNER_RESPONSE steps
                    for (const step of [...steps].reverse()) {
                        if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
                        const pr = step.plannerResponse;
                        if (!pr) continue;
                        const text = pr.modifiedResponse || pr.response || pr.content || pr.thinking;
                        if (text && text.trim().length >= 3) {
                            flog(`✅ Response ready (${text.length} chars, attempt ${attempt + 1})`);
                            return text.trim();
                        }
                    }
                    // Check for capacity error → retry with fresh cascade
                    if (steps.some(s => s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' && JSON.stringify(s.errorMessage || '').toLowerCase().includes('capacity'))) {
                        flog(`  ⚠️ Capacity error (attempt ${attempt + 1}), will retry...`);
                        activeCascades.delete(convKey);
                        shouldRetry = true;
                    } else {
                        flog(`  ⚠️ IDLE with no PLANNER_RESPONSE after ${elapsed}s`);
                        activeCascades.delete(convKey);
                        shouldRetry = false; // Fail fast to Tier 2 instead of spamming duplicates
                    }
                    break;
                }
            } catch (e) {
                flog(`  [poll error] ${e.message.substring(0, 80)}`);
            }
        }
        if (!shouldRetry) break;
    }
    throw new Error(`Cascade failed after ${MAX_RETRIES} attempts (model capacity exhausted)`);
}




/** Extract AI response text from a GetCascadeTrajectory result */
function extractCascadeResponse(traj) {
    if (!traj) return null;
    const steps = (traj.trajectory && traj.trajectory.steps) || [];
    // Walk steps in reverse, find the last PLANNER_RESPONSE with content
    for (const step of [...steps].reverse()) {
        if (!step || step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
        const pr = step.plannerResponse;
        if (!pr) continue;
        const text = pr.modifiedResponse || pr.response || pr.content;
        if (typeof text === 'string' && text.trim().length > 3) return text.trim();
    }
    return null;
}


/** Make a H2+JSON ConnectRPC call to the LanguageServerService (with automatic retry on transient connect failures) */
async function makeH2JsonCall(port, csrf, certPath, method, body, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await _makeH2JsonCallOnce(port, csrf, certPath, method, body);
        } catch (e) {
            // Retry on transient H2 connect errors (empty message = TLS/socket race)
            if (attempt < retries && (e.message.includes('H2 connect:') || e.message.includes('H2 timeout'))) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
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
        try { ca = certPath ? fs.readFileSync(certPath) : undefined; } catch { /* ignore */ }
        const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
        let totalBody = '';
        let status;
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
        client.on('error', (err) => { settle(reject, new Error('H2 connect: ' + err.message)); });
        client.on('connect', () => {
            const req = client.request({
                ':method': 'POST',
                ':path': `/exa.language_server_pb.LanguageServerService/${method}`,
                'content-type': 'application/json',
                'connect-protocol-version': '1',
                'x-codeium-csrf-token': csrf,
            });
            req.on('response', (h) => { status = h[':status']; });
            req.on('data', (d) => { totalBody += d.toString('utf8'); });
            req.on('end', () => {
                client.close();
                if (status === 200) {
                    try { settle(resolve, JSON.parse(totalBody)); }
                    catch { settle(resolve, totalBody); }
                } else {
                    settle(reject, new Error(`HTTP ${status}: ${totalBody.substring(0, 150)}`));
                }
            });
            req.on('error', (e) => { client.close(); settle(reject, e); });
            req.write(payload);
            req.end();
        });
        setTimeout(() => { try { client.close(); } catch { } settle(reject, new Error('H2 timeout')); }, 10000);
    });
}

/** Make a streaming H2+JSON ConnectRPC call to the LanguageServerService (for SendUserCascadeMessage etc.) */
function makeH2StreamingCall(port, csrf, certPath, method, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        let ca;
        try { ca = certPath ? fs.readFileSync(certPath) : undefined; } catch { /* ignore */ }
        const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
        let status, chunks = [];

        const timer = setTimeout(() => {
            try { client.close(); } catch { }
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
            req.on('response', (h) => { status = h[':status']; });
            req.on('data', (d) => { chunks.push(d); });
            req.on('end', () => {
                clearTimeout(timer);
                try { client.close(); } catch { }
                if (status === 200) resolve();
                else {
                    const body = Buffer.concat(chunks).toString('utf8');
                    reject(new Error(`HTTP ${status}: ${body.substring(0, 150)}`));
                }
            });
            req.on('error', (e) => {
                clearTimeout(timer);
                try { client.close(); } catch { }
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
            try { options.ca = fs.readFileSync(certPath); } catch { /* ignore */ }
        }

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode === 200) {
                    try { resolve(JSON.parse(body)); } catch { resolve(body); }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
                }
            });
        });

        req.on('error', (err) => {
            // If HTTPS fails, try HTTP
            if (err.code === 'ERR_SSL_WRONG_VERSION_NUMBER' || err.message.includes('SSL') || err.message.includes('ECONNRESET') || err.message.includes('disconnected') || err.message.includes('EPIPE')) {
                const httpOpts = { ...options };
                delete httpOpts.ca;
                delete httpOpts.rejectUnauthorized;
                const httpReq = http.request(httpOpts, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode === 200) {
                            try { resolve(JSON.parse(body)); } catch { resolve(body); }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
                        }
                    });
                });
                httpReq.on('error', reject);
                httpReq.setTimeout(10000, () => { httpReq.destroy(new Error('Timeout')); });
                httpReq.write(payload);
                httpReq.end();
            } else {
                reject(err);
            }
        });
        req.setTimeout(10000, () => { req.destroy(new Error('Timeout')); });
        req.write(payload);
        req.end();
    });
}

// ─────────────────────────────────────────────
// Debug & Diagnostics
// ─────────────────────────────────────────────

async function handleDebug(req, res) {
    const result = { sidecar: {}, interceptedAuth: {}, lm: {}, chatAPI: {} };

    // Intercepted CSRF
    result.interceptedAuth = {
        hasCsrf: !!interceptedCsrf,
        csrfPrefix: interceptedCsrf ? interceptedCsrf.substring(0, 8) + '...' : null,
        port: interceptedPort,
    };

    // Sidecar
    const info = discoverSidecar();
    result.sidecar = info || { error: 'Not found' };

    // LM
    try {
        if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
            const models = await vscode.lm.selectChatModels({});
            result.lm = { available: true, models: (models || []).map((m) => ({ id: m.id, vendor: m.vendor, family: m.family, name: m.name })) };
        }
    } catch (e) { result.lm = { error: e.message }; }

    // Chat
    result.chatAPI = { available: !!(vscode.chat && typeof vscode.chat.createChatParticipant === 'function') };

    // Test sidecar connectivity
    if (info) {
        result.sidecar.connectTests = [];
        // Test ExtensionServerService on ext port
        const extCsrf = info.csrfTokens[info.csrfTokens.length - 1]; // extension_server_csrf_token
        try {
            const testResult = await makeConnectRpcCallOnPort(info.extensionServerPort, extCsrf, info.certPath, '/exa.extension_server_pb.ExtensionServerService/PlaySound', '{}');
            result.sidecar.connectTests.push({ port: info.extensionServerPort, service: 'ExtensionServerService', success: true });
        } catch (e) {
            result.sidecar.connectTests.push({ port: info.extensionServerPort, service: 'ExtensionServerService', success: false, error: e.message.substring(0, 100) });
        }
        // Test LanguageServerService on HTTPS ports (uses mainCsrf = csrfTokens[0])
        const mainCsrf = info.csrfTokens[0]; // --csrf_token
        for (const port of info.actualPorts.filter(p => p !== info.extensionServerPort)) {
            try {
                const testResult = await makeConnectRpcCallOnPort(port, mainCsrf, info.certPath, '/exa.language_server_pb.LanguageServerService/GetAvailableCascadePlugins', '{}');
                result.sidecar.connectTests.push({ port, service: 'LanguageServerService', success: true, sample: typeof testResult === 'object' ? Object.keys(testResult).join(',') : 'string' });
            } catch (e) {
                result.sidecar.connectTests.push({ port, service: 'LanguageServerService', success: false, error: e.message.substring(0, 100) });
            }
        }
    }

    sendJson(res, 200, result);
}

async function probeSidecar() {
    outputChannel.show();
    log('─── Probing Sidecar ───');
    const info = discoverSidecar();
    if (!info) { log('❌ Sidecar not found'); return; }
    log(`PID: ${info.pid}`);
    log(`Ports: ${info.actualPorts.join(', ')}`);
    log(`Tokens: ${info.csrfTokens.map(t => t.substring(0, 8) + '...').join(', ')}`);
    log(`Cert: ${info.certPath || 'not found'}`);

    const testPath = '/exa.extension_server.ExtensionServer/GetAvailableCascadePlugins';
    for (const port of info.actualPorts) {
        for (const csrf of info.csrfTokens) {
            try {
                const r = await makeConnectRpcCallOnPort(port, csrf, info.certPath, testPath, '{}');
                log(`✅ port=${port} token=${csrf.substring(0, 8)}... → ${JSON.stringify(r).substring(0, 200)}`);
            } catch (e) {
                log(`❌ port=${port} token=${csrf.substring(0, 8)}... → ${e.message}`);
            }
        }
    }
}

async function diagnoseModels() {
    outputChannel.show();

    // 1. Show bridge MODEL_MAP (the models available via the OpenAI-compatible API)
    log('─── AG Local Bridge Models ───');
    const visible = Object.entries(MODEL_MAP).filter(([, m]) => !m.hidden);
    if (visible.length === 0) {
        log('⚠️ No models configured in MODEL_MAP');
    } else {
        log(`  ${visible.length} model(s) available:`);
        for (const [id, m] of visible) {
            log(`  ✅ ${id}  →  enum=${m.value}  "${m.name}"  (${m.owned_by}, ctx=${m.context}, out=${m.output})`);
        }
        log(`  Default: ${DEFAULT_MODEL_KEY}`);
    }

    // 2. Check sidecar connectivity
    log('─── Sidecar Status ───');
    const info = discoverSidecar();
    if (!info) {
        log('  ❌ Sidecar not found');
    } else {
        log(`  PID: ${info.pid}`);
        log(`  Ports: ${info.actualPorts.join(', ')}`);
        log(`  Cert: ${info.certPath ? 'yes' : 'no'}`);
        // Quick connectivity test on LS port
        const lsPorts = info.actualPorts.filter(p => p !== info.extensionServerPort);
        let connected = false;
        for (const port of lsPorts) {
            try {
                await makeH2JsonCall(port, info.csrfTokens[0], info.certPath, 'GetStatus', {});
                log(`  ✅ LS port ${port} — connected`);
                connected = true;
                break;
            } catch (e) {
                log(`  ❌ LS port ${port} — ${e.message.substring(0, 60)}`);
            }
        }
        if (connected) {
            log('  → Models above should work via POST /v1/chat/completions');
        } else {
            log('  ⚠️ No reachable LS port — sidecar calls will fail');
        }
    }

}

async function diagnoseCommands() {
    outputChannel.show();
    log('─── Antigravity Commands ───');
    const all = await vscode.commands.getCommands(true);
    all.filter((c) => c.toLowerCase().includes('antigravity') || c.toLowerCase().includes('jetski') || c.toLowerCase().includes('cascade'))
        .forEach((c) => log(`  ${c}`));
}

async function showStatus() {
    outputChannel.show();
    const config = vscode.workspace.getConfiguration('antigravityBridge');
    const port = config.get('port', 11435);
    const info = discoverSidecar();

    log('─── AG Local Bridge Status ───');
    log(`  Server: ${server ? `✅ http://localhost:${port}` : '❌ Stopped'}`);
    log(`  Sidecar: ${info ? `✅ port ${info.extensionServerPort}` : '❌ Not found'}`);
}

// ─────────────────────────────────────────────
// Response Builders
// ─────────────────────────────────────────────

function buildStreamChunk(id, model, content, finishReason = null) {
    const delta = content !== null ? { role: 'assistant', content } : {};
    return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function buildCompletion(id, model, content) {
    return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function setupStreamResponse(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);
}

function sendJson(res, code, payload) {
    const body = JSON.stringify(payload);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(code);
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function log(msg, isError = false) {
    if (typeof msg === 'object') {
        try { msg = JSON.stringify(msg); } catch { msg = String(msg); }
    }
    const ts = new Date().toISOString().slice(11, 23);
    outputChannel.appendLine(`[${ts}] ${msg}`);
    if (isError) console.error(`[ag-bridge] ${msg}`);
}

function updateStatusBar(running, port) {
    statusBarItem.text = running ? `$(radio-tower) AG Bridge :${port}` : '$(warning) AG Bridge OFF';
    statusBarItem.backgroundColor = running ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBarItem.show();
}

module.exports = { activate, deactivate };
