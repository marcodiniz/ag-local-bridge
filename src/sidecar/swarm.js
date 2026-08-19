'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { log, verboseLog } = require('../utils');
const { makeH2JsonCall } = require('./rpc');

// ─────────────────────────────────────────────
// Multi-Sidecar Swarm Discovery & Round-Robin
//
// Discovers ALL running language_server processes,
// probes each for H2 health, and provides a
// round-robin iterator for load-balanced inference.
// ─────────────────────────────────────────────

const SIDECAR_BINARY_NAMES = {
  win32: ['language_server_windows_x64.exe'],
  darwin: ['language_server_macos_arm', 'language_server_macos'],
  linux: ['language_server_linux_x64'],
};

/** @typedef {{ pid: string, port: number, csrf: string, certPath: string|null }} SwarmMember */

let _swarmCache = null;
let _swarmCacheTimestamp = 0;
const SWARM_CACHE_TTL = 120000; // 2 minutes — sidecars don't change often

let _swarmRoundRobin = 0;

// Persistent quota cooldown tracking (PID -> { bucket: timestamp })
const _cooldowns = new Map();

/**
 * Maps a model enum to its respective quota bucket.
 */
function getQuotaBucket(modelEnum) {
  // Enum values are defined in src/models.js
  // 'antigravity-gemini-3.1-pro-high' (1037), 'antigravity-gemini-3.1-pro-low' (1036)
  if (modelEnum === 1037 || modelEnum === 1036) return 'pro';
  // 'antigravity-claude-opus-4-6-thinking' (1026), 'antigravity-claude-sonnet-4-6' (1035), 'antigravity-gpt-oss-120b' (342)
  if (modelEnum === 1026 || modelEnum === 1035 || modelEnum === 342) return 'premium';
  // 'antigravity-gemini-3-flash' (1018)
  if (modelEnum === 1018) return 'flash';

  return 'default';
}

function markSwarmMemberExhausted(pid, modelEnum) {
  const bucket = getQuotaBucket(modelEnum);
  if (!_cooldowns.has(pid)) {
    _cooldowns.set(pid, {});
  }
  const cooldowns = _cooldowns.get(pid);
  cooldowns[bucket] = Date.now() + 3600000; // 1 hour cool-off
}

function getSwarmCooldowns() {
  const result = {};
  for (const [pid, buckets] of _cooldowns.entries()) {
    result[pid] = {};
    for (const [bucket, timestamp] of Object.entries(buckets)) {
      const remainingMs = timestamp - Date.now();
      if (remainingMs > 0) {
        result[pid][bucket] = Math.round(remainingMs / 1000) + 's';
      }
    }
    if (Object.keys(result[pid]).length === 0) delete result[pid];
  }
  return result;
}

/**
 * Discover ALL running sidecar processes and extract their connection info.
 * Returns an array of SwarmMembers, each representing one inference-capable sidecar.
 *
 * Filters out LSP-only sidecars (those with --enable_lsp) since they cannot
 * serve GetModelResponse.
 */
async function discoverSwarm(ctx) {
  if (_swarmCache && Date.now() - _swarmCacheTimestamp < SWARM_CACHE_TTL) {
    return _swarmCache;
  }

  try {
    const members = await _discoverAllSidecars(ctx);
    if (members.length > 0) {
      _swarmCache = members;
      _swarmCacheTimestamp = Date.now();
    }
    return members;
  } catch (err) {
    log(ctx, `❌ Swarm discovery failed: ${err.message}`);
    return _swarmCache || [];
  }
}

/**
 * Get the next sidecar from the round-robin pool.
 * If the chosen one fails, the caller should call `markSwarmMemberFailed()`
 * and call this again to get the next one.
 */
function getNextSwarmMember(members, modelEnum) {
  if (!members || members.length === 0) return null;

  const bucket = getQuotaBucket(modelEnum);
  const now = Date.now();

  // Try up to members.length times to find a non-exhausted member
  for (let i = 0; i < members.length; i++) {
    _swarmRoundRobin = (_swarmRoundRobin + 1) % members.length;
    const candidate = members[_swarmRoundRobin];

    // Check if this candidate is exhausted for this specific bucket
    const cooldowns = _cooldowns.get(candidate.pid);
    if (!cooldowns || !cooldowns[bucket] || cooldowns[bucket] < now) {
      return candidate;
    }
  }

  // ALL members are exhausted for this bucket
  return 'ALL_EXHAUSTED';
}

/**
 * Invalidate the swarm cache so the next call to discoverSwarm() re-scans.
 */
function invalidateSwarmCache() {
  _swarmCache = null;
  _swarmCacheTimestamp = 0;
}

// ─────────────────────────────────────────────
// Internal: platform-specific process scanning
// ─────────────────────────────────────────────

async function _discoverAllSidecars(ctx) {
  const platform = os.platform();
  const binaryNames = SIDECAR_BINARY_NAMES[platform];
  if (!binaryNames) {
    log(ctx, `⚠️ Unsupported platform for swarm discovery: ${platform}`);
    return [];
  }

  // Find ALL sidecar processes
  let procs;
  if (platform === 'win32') {
    procs = await _findAllProcessesWindows(binaryNames);
  } else {
    procs = await _findAllProcessesUnix(binaryNames);
  }

  if (procs.length === 0) {
    log(ctx, '⚠️ No sidecar processes found for swarm');
    return [];
  }

  // Filter to inference-capable sidecars (exclude --enable_lsp ones)
  const inferenceSidecars = procs.filter((p) => !p.commandLine.includes('--enable_lsp'));

  // Find cert path
  let certPath = null;
  try {
    const agExt = vscode.extensions.getExtension('google.antigravity');
    if (agExt) {
      const candidate = path.join(agExt.extensionPath, 'dist', 'languageServer', 'cert.pem');
      if (fs.existsSync(candidate)) certPath = candidate;
    }
  } catch {
    // VS Code API may not be available in test
  }

  // Extract port + CSRF from each, probe health
  const members = [];
  for (const proc of inferenceSidecars) {
    const portMatch = proc.commandLine.match(/--extension_server_port\s+(\d+)/);
    const csrfMatch = proc.commandLine.match(/--csrf_token\s+([a-f0-9-]+)/);

    if (!portMatch || !csrfMatch) continue;

    const port = parseInt(portMatch[1]);
    const csrf = csrfMatch[1];

    // Quick H2 health probe
    try {
      await makeH2JsonCall(port, csrf, certPath, 'GetAvailableCascadePlugins', {}, 0, 2000);
      members.push({ pid: proc.pid, port, csrf, certPath });
    } catch {
      verboseLog(ctx, `⚠️ Swarm probe failed for PID=${proc.pid} port=${port} — skipping`);
    }
  }

  log(
    ctx,
    `🐝 Swarm discovered: ${members.length} healthy inference sidecars out of ${inferenceSidecars.length} candidates`,
  );
  for (const m of members) {
    verboseLog(ctx, `  🐝 PID=${m.pid} port=${m.port} csrf=${m.csrf.substring(0, 8)}...`);
  }

  return members;
}

async function _findAllProcessesUnix(binaryNames) {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['aux'], {
      encoding: 'utf8',
      timeout: 5000,
    });

    return stdout
      .split('\n')
      .filter((l) => binaryNames.some((b) => l.includes(b)) && !l.includes('grep'))
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          user: parts[0],
          pid: parts[1],
          commandLine: parts.slice(10).join(' '),
        };
      })
      .filter((proc) => proc.pid && proc.commandLine);
  } catch {
    return [];
  }
}

async function _findAllProcessesWindows(binaryNames) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershellExe = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  const allProcs = [];
  for (const binaryName of binaryNames) {
    try {
      const psCmd = `Get-CimInstance Win32_Process -Filter "Name='${binaryName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        encoding: 'utf8',
        timeout: 10000,
      });

      if (!stdout || !stdout.trim()) continue;

      let parsed = JSON.parse(stdout.trim());
      if (!Array.isArray(parsed)) parsed = [parsed];

      for (const p of parsed) {
        if (p.ProcessId && p.CommandLine) {
          allProcs.push({
            pid: String(p.ProcessId),
            commandLine: p.CommandLine,
            user: '',
          });
        }
      }
    } catch {
      // PowerShell failed — try next binary name
    }
  }
  return allProcs;
}

module.exports = {
  discoverSwarm,
  getNextSwarmMember,
  invalidateSwarmCache,
  getQuotaBucket,
  markSwarmMemberExhausted,
  getSwarmCooldowns,
};
