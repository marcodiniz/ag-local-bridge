'use strict';

const { randomUUID } = require('crypto');

/**
 * Shared mutable state for the AG Local Bridge extension.
 *
 * All state that was previously scattered as module-level `let` variables
 * in the monolithic extension.js is consolidated here. A single context
 * object is created in activate() and passed to every module.
 */
function createContext() {
  return {
    // Identity (for Metadata proto payloads)
    sessionId: randomUUID(),
    extensionVersion: '1.1.0',

    // VS Code UI
    /** @type {import('vscode').OutputChannel | null} */
    outputChannel: null,
    /** @type {import('vscode').StatusBarItem | null} */
    statusBarItem: null,

    // HTTP server
    /** @type {import('http').Server | null} */
    server: null,

    // Sidecar discovery cache
    sidecarInfo: null,
    sidecarInfoTimestamp: 0,
    SIDECAR_CACHE_TTL: 30000, // 30 seconds

    // Concurrency guard
    chatRequestsInFlight: 0,
    MAX_CONCURRENT_REQUESTS: 3,

    // Rate limiting / loop-breaking
    lastResponseTimestamp: 0,
    MIN_REQUEST_INTERVAL_MS: 1000, // 1s cooldown between responses
    lastUserMessageHash: '',
    lastUserMessageTimestamp: 0,
    DEDUP_WINDOW_MS: 5000, // 5s dedup window

    // CSRF token intercepted from Antigravity's own outgoing requests
    interceptedCsrf: null,
    interceptedPort: null,

    // Interceptor originals (stored for uninstall)
    _originalHttpsRequest: null,
    _originalCreateServer: null,

    // H2 interceptor captured payloads
    capturedPayloads: [],
    MAX_CAPTURES: 20,

    // Cascade conversation state
    isWorkspaceSwitching: false,
    activeCascades: new Map(), // convKey -> { id, lastUsed }
    cascadePromises: new Map(), // convKey -> Promise<string>
  };
}

module.exports = { createContext };
