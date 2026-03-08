// Ag Local Bridge — VS Code Extension
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

// Cached LM models (discovered via vscode.lm)
let cachedModels = [];
let modelPollInterval = null;

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
                                            payloadHex: fullPayload.toString('hex').substring(0, 2000),
                                            payloadUtf8: fullPayload.toString('utf8').substring(0, 500),
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
    outputChannel = vscode.window.createOutputChannel('Ag Local Bridge');
    context.subscriptions.push(outputChannel);
    installH2Interceptor(); // Hook http2 sessions to capture outgoing RPC payloads

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravityBridge.showStatus';
    statusBarItem.tooltip = 'Antigravity Bridge — Click for status';
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('agLocalBridge.start', () => startServer()),
        vscode.commands.registerCommand('agLocalBridge.stop', () => stopServer()),
        vscode.commands.registerCommand('agLocalBridge.showStatus', () => showStatus()),
        vscode.commands.registerCommand('agLocalBridge.listModels', () => diagnoseModels()),
        vscode.commands.registerCommand('antigravityBridge.listCommands', () => diagnoseCommands()),
        vscode.commands.registerCommand('antigravityBridge.probeSidecar', () => probeSidecar())
    );

    log('Extension activated. Starting server...');
    startServer().catch((err) => log(`Startup error: ${err.message}`, true));

    // Listen for LM model changes (Antigravity may register models lazily)
    if (vscode.lm && typeof vscode.lm.onDidChangeChatModels === 'function') {
        context.subscriptions.push(
            vscode.lm.onDidChangeChatModels(() => {
                log('📡 vscode.lm models changed — refreshing cache');
                refreshModelCache();
            })
        );
    }

    // Poll for models periodically (some LMs register after extensions activate)
    refreshModelCache();
    modelPollInterval = setInterval(refreshModelCache, 10000);
    context.subscriptions.push({ dispose: () => clearInterval(modelPollInterval) });

    // Trigger Antigravity agent initialization to nudge model registration
    setTimeout(async () => {
        try { await vscode.commands.executeCommand('antigravity.initializeAgent'); } catch { /* ignore */ }
        try { await vscode.commands.executeCommand('antigravity.agentSidePanel.open'); } catch { /* ignore */ }
        setTimeout(refreshModelCache, 3000);
    }, 2000);
}

async function refreshModelCache() {
    try {
        if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') return;
        const models = await vscode.lm.selectChatModels({});
        if (models && models.length > 0 && cachedModels.length === 0) {
            log(`🎉 Found ${models.length} LM model(s): ${models.map(m => m.id || m.name).join(', ')}`);
        }
        cachedModels = models || [];
    } catch { /* ignore polling errors */ }
}

function deactivate() {
    if (modelPollInterval) clearInterval(modelPollInterval);
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

    const isStream = payload.stream === true;
    const messages = payload.messages || [];
    const completionId = `chatcmpl-${randomUUID()}`;

    // Strategy order: sidecar ConnectRPC → vscode.lm → command dispatch

    // Resolve model from request
    const resolved = resolveModel(payload.model);
    log(`📡 Model: ${resolved.key} (enum=${resolved.value})`);

    // Tier 1: Direct sidecar ConnectRPC call
    try {
        const result = await callSidecarChat(messages, resolved.value);
        if (result) {
            if (isStream) {
                setupStreamResponse(res);
                res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, resolved.key, result))}\n\n`);
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

    // Tier 2: vscode.lm API (use cached models or fresh query)
    try {
        if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
            const models = cachedModels.length > 0 ? cachedModels : await vscode.lm.selectChatModels({});
            if (models && models.length > 0) {
                const model = models[0];
                const lmMessages = messages.map((m) =>
                    m.role === 'assistant'
                        ? vscode.LanguageModelChatMessage.Assistant(m.content)
                        : vscode.LanguageModelChatMessage.User(m.content)
                );
                const tokenSource = new vscode.CancellationTokenSource();
                const response = await model.sendRequest(lmMessages, {}, tokenSource.token);
                let fullText = '';
                for await (const chunk of response.stream) {
                    if (chunk instanceof vscode.LanguageModelTextPart) fullText += chunk.value;
                }
                if (isStream) {
                    setupStreamResponse(res);
                    res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, model.id || 'antigravity', fullText))}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    sendJson(res, 200, buildCompletion(completionId, model.id || 'antigravity', fullText));
                }
                return;
            }
        }
    } catch (err) {
        log(`⚠️ vscode.lm failed: ${err.message}`);
    }

    // Tier 3: Command dispatch (fire-and-forget, returns acknowledgement)
    try {
        const userMessage = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
        await vscode.commands.executeCommand('antigravity.executeCascadeAction', { type: 'sendMessage', message: userMessage });
        const text = '[Message dispatched to Antigravity agent panel. Check the Antigravity chat panel for the response.]';
        if (isStream) {
            setupStreamResponse(res);
            res.write(`data: ${JSON.stringify(buildStreamChunk(completionId, 'antigravity', text))}\n\n`);
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
async function callSidecarChat(messages, modelValue = 1035) {
    const info = discoverSidecar();
    if (!info) throw new Error('Sidecar not discovered');

    const userMessage = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const mainCsrf = info.csrfTokens[0];
    const flog = (msg) => { log(msg); try { fs.appendFileSync('C:/Users/User/bridge-debug.log', `[${new Date().toISOString()}] ${msg}\n`); } catch { } };

    // Find a working LS port
    const lsPorts = info.actualPorts.filter(p => p !== info.extensionServerPort);
    let lsPort = null;
    for (const port of lsPorts) {
        try { await makeH2JsonCall(port, mainCsrf, info.certPath, 'GetStatus', {}); lsPort = port; break; }
        catch (e) { flog(`  port ${port} failed: ${e.message.substring(0, 40)}`); }
    }
    if (!lsPort) throw new Error('No reachable LS port');
    flog(`  Using LS port: ${lsPort}`);

    // Retry loop: start fresh cascade on each attempt (capacity errors leave error steps)
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 10000;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            flog(`  ⏳ Retry ${attempt + 1}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s backoff...`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }

        // Start a fresh cascade for each attempt
        const startResult = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'StartCascade', {});
        const cascadeId = startResult && startResult.cascadeId;
        if (!cascadeId) throw new Error('StartCascade did not return a cascadeId');
        flog(`  🆕 Cascade: ${cascadeId.substring(0, 8)} (attempt ${attempt + 1})`);

        // Send message — model:334 = Claude 4.5 Sonnet Thinking (verified working)
        const sendPayload = {
            cascadeId,
            items: [{ text: userMessage }],
            cascadeConfig: {
                plannerConfig: {
                    plannerTypeConfig: { conversational: {} },
                    requestedModel: { model: modelValue },
                },
            },
        };
        try {
            await makeH2StreamingCall(lsPort, mainCsrf, info.certPath, 'SendUserCascadeMessage', sendPayload);
            flog(`  ✅ SendUserCascadeMessage dispatched (attempt ${attempt + 1})`);
        } catch (e) {
            flog(`  ⚠️ SendUserCascadeMessage failed: ${e.message.substring(0, 60)}`);
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
                        shouldRetry = true;
                    } else {
                        flog(`  ⚠️ IDLE with no PLANNER_RESPONSE after ${elapsed}s`);
                        shouldRetry = true;
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


/** Make a H2+JSON ConnectRPC call to the LanguageServerService */
function makeH2JsonCall(port, csrf, certPath, method, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        let ca;
        try { ca = certPath ? fs.readFileSync(certPath) : undefined; } catch { /* ignore */ }
        const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
        let totalBody = '';
        let status;
        client.on('error', (err) => { reject(new Error('H2 connect: ' + err.message)); });
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
                    try { resolve(JSON.parse(totalBody)); }
                    catch { resolve(totalBody); }
                } else {
                    reject(new Error(`HTTP ${status}: ${totalBody.substring(0, 150)}`));
                }
            });
            req.on('error', (e) => { client.close(); reject(e); });
            req.write(payload);
            req.end();
        });
        setTimeout(() => { try { client.close(); } catch { } reject(new Error('H2 timeout')); }, 10000);
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
        client.on('error', (err) => { reject(new Error('H2 connect: ' + err.message)); });
        const timer = setTimeout(() => {
            try { client.close(); } catch { }
            resolve(); // streaming RPC — timeout is normal, means server started streaming
        }, 5000);
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
                client.close();
                if (status === 200) resolve();
                else {
                    const body = Buffer.concat(chunks).toString('utf8');
                    reject(new Error(`HTTP ${status}: ${body.substring(0, 150)}`));
                }
            });
            req.on('error', (e) => {
                clearTimeout(timer);
                // Stream error after receiving data = normal for streaming RPCs
                client.close();
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
    log('─── vscode.lm Models ───');
    if (!vscode.lm) { log('❌ API not available'); return; }
    try {
        const models = await vscode.lm.selectChatModels({});
        if (!models || models.length === 0) { log('⚠️ No models registered'); return; }
        models.forEach((m) => log(`  ✅ ${m.id} | ${m.vendor}/${m.family} "${m.name}"`));
    } catch (e) { log(`❌ ${e.message}`); }
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

    log('─── Ag Local Bridge Status ───');
    log(`  Server: ${server ? `✅ http://localhost:${port}` : '❌ Stopped'}`);
    log(`  Sidecar: ${info ? `✅ port ${info.extensionServerPort}` : '❌ Not found'}`);
    log(`  vscode.lm: ${vscode.lm ? '✅' : '❌'}`);
}

// ─────────────────────────────────────────────
// Response Builders
// ─────────────────────────────────────────────

function buildStreamChunk(id, model, content) {
    return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] };
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
