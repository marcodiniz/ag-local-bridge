'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { log } = require('../utils');

// ─────────────────────────────────────────────
// Sidecar Discovery (cross-platform)
// Finds the running language_server process and
// extracts ports, CSRF tokens, and cert path.
//
// Platform strategies:
//   Windows – Get-CimInstance Win32_Process (PowerShell)
//   macOS   – ps aux + lsof -iTCP -sTCP:LISTEN
//   Linux   – ps aux + ss -tlnp
// ─────────────────────────────────────────────

/**
 * Binary names the Antigravity sidecar has shipped as, per platform.
 */
const SIDECAR_BINARY_NAMES = {
  win32: ['language_server_windows_x64.exe'],
  darwin: ['language_server_macos_arm', 'language_server_macos'],
  linux: ['language_server_linux_x64', 'language_server_linux'],
};

/**
 * @typedef {Object} ProcessInfo
 * @property {string} pid
 * @property {string} commandLine
 * @property {string} user
 */

/**
 * @typedef {Object} PlatformStrategy
 * @property {() => Promise<ProcessInfo|null>} findProcess
 * @property {(pid: string) => Promise<number[]>} findListeningPorts
 */

function rankProcessCandidate(proc) {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return null;
    }
  })();

  let score = 0;
  if (proc.commandLine.includes('/resources/app/extensions/antigravity/bin/')) score += 100;
  if (proc.commandLine.includes('--extension_server_csrf_token')) score += 50;
  if (proc.commandLine.includes('--random_port')) score += 20;
  if (proc.commandLine.includes('--server_port')) score += 10;
  if (user && proc.user === user) score += 30;
  if (proc.commandLine.startsWith('/usr/local/bin/')) score -= 40;
  return score;
}

function chooseBestProcess(candidates) {
  if (!candidates || candidates.length === 0) return null;
  return [...candidates].sort((a, b) => rankProcessCandidate(b) - rankProcessCandidate(a))[0];
}

// ─────────────────────────────────────────────
// Windows strategy  (PowerShell Get-CimInstance)
// ─────────────────────────────────────────────

function windowsStrategy(binaryNames) {
  return {
    async findProcess() {
      for (const binaryName of binaryNames) {
        // Use Get-CimInstance Win32_Process (preferred over deprecated wmic)
        const psCmd = `Get-CimInstance Win32_Process -Filter "Name='${binaryName}'" | Select-Object ProcessId,CommandLine | Format-List`;
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          encoding: 'utf8',
          timeout: 10000,
        });

        if (!stdout || !stdout.trim()) continue;

        const pidMatch = stdout.match(/ProcessId\s*:\s*(\d+)/);
        const cmdMatch = stdout.match(/CommandLine\s*:\s*(.+)/);

        if (pidMatch && cmdMatch) {
          return { pid: pidMatch[1], commandLine: cmdMatch[1].trim(), user: '' };
        }
      }

      return null;
    },

    async findListeningPorts(pid) {
      try {
        const { stdout } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000 });
        return stdout
          .split('\n')
          .filter((l) => l.includes(pid) && l.includes('LISTENING'))
          .map((l) => {
            const m = l.match(/127\.0\.0\.1:(\d+)/);
            return m ? parseInt(m[1]) : null;
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

// ─────────────────────────────────────────────
// macOS strategy  (ps aux + lsof)
// ─────────────────────────────────────────────

function darwinStrategy(binaryNames) {
  return {
    async findProcess() {
      const { stdout } = await execFileAsync('/bin/ps', ['aux'], { encoding: 'utf8', timeout: 5000 });

      const candidates = stdout
        .split('\n')
        .filter((l) => binaryNames.some((binaryName) => l.includes(binaryName)) && !l.includes('grep'))
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return {
            user: parts[0],
            pid: parts[1],
            commandLine: parts.slice(10).join(' '),
          };
        })
        .filter((proc) => proc.pid && proc.commandLine);

      return chooseBestProcess(candidates);
    },

    async findListeningPorts(pid) {
      try {
        const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP', '-a', '-p', pid], {
          encoding: 'utf8',
          timeout: 5000,
        });
        return stdout
          .split('\n')
          .map((l) => {
            const m = l.match(/(?:127\.0\.0\.1|\*|localhost):(\d+)/);
            return m ? parseInt(m[1]) : null;
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

// ─────────────────────────────────────────────
// Linux strategy  (ps aux + ss)
// ─────────────────────────────────────────────

function linuxStrategy(binaryNames) {
  return {
    async findProcess() {
      const { stdout } = await execFileAsync('/bin/ps', ['aux'], { encoding: 'utf8', timeout: 5000 });

      const candidates = stdout
        .split('\n')
        .filter((l) => binaryNames.some((binaryName) => l.includes(binaryName)) && !l.includes('grep'))
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return {
            user: parts[0],
            pid: parts[1],
            commandLine: parts.slice(10).join(' '),
          };
        })
        .filter((proc) => proc.pid && proc.commandLine);

      return chooseBestProcess(candidates);
    },

    async findListeningPorts(pid) {
      try {
        const { stdout } = await execFileAsync('ss', ['-tlnp'], { encoding: 'utf8', timeout: 5000 });
        // ss output includes "pid=<N>" in each line — filter for our process
        return stdout
          .split('\n')
          .filter((l) => l.includes(`pid=${pid}`))
          .map((l) => {
            const m = l.match(/(?:127\.0\.0\.1|\*|0\.0\.0\.0):(\d+)/);
            return m ? parseInt(m[1]) : null;
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

// ─────────────────────────────────────────────
// Strategy factory
// ─────────────────────────────────────────────

/**
 * Return the correct strategy for the current platform.
 * @returns {{ strategy: PlatformStrategy, binaryNames: string[] }}
 */
function getPlatformStrategy() {
  const platform = os.platform();
  const binaryNames = SIDECAR_BINARY_NAMES[platform];

  if (!binaryNames) {
    throw new Error(`Unsupported platform for sidecar discovery: ${platform}`);
  }

  const factories = {
    win32: windowsStrategy,
    darwin: darwinStrategy,
    linux: linuxStrategy,
  };

  return { strategy: factories[platform](binaryNames), binaryNames };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

async function discoverSidecar(ctx) {
  if (ctx.sidecarInfo && Date.now() - ctx.sidecarInfoTimestamp < ctx.SIDECAR_CACHE_TTL) return ctx.sidecarInfo;

  try {
    const { strategy, binaryNames } = getPlatformStrategy();

    // 1. Find the sidecar process
    const proc = await strategy.findProcess();
    if (!proc) {
      log(ctx, `⚠️ Sidecar process not found (looking for ${binaryNames.join(', ')} on ${os.platform()})`);
      return null;
    }

    const { pid, commandLine } = proc;

    // 2. Parse flags from the command line
    const extPortMatch = commandLine.match(/--extension_server_port\s+(\d+)/);
    const extCsrfMatch = commandLine.match(/--extension_server_csrf_token\s+([a-f0-9-]+)/);
    const mainCsrfMatch = commandLine.match(/--csrf_token\s+([a-f0-9-]+)/);
    const serverPortMatch = commandLine.match(/--server_port\s+(\d+)/);
    const lspPortMatch = commandLine.match(/--lsp_port[= ](\d+)/);

    if (!extPortMatch) {
      log(ctx, '⚠️ Could not find sidecar extension_server_port');
      return null;
    }

    // 3. Discover listening ports via platform-specific tool
    const actualPorts = await strategy.findListeningPorts(pid);

    // 4. Find cert
    const agExt = vscode.extensions.getExtension('google.antigravity');
    let certPath = null;
    if (agExt) {
      const candidate = path.join(agExt.extensionPath, 'dist', 'languageServer', 'cert.pem');
      if (fs.existsSync(candidate)) certPath = candidate;
    }

    // 5. Collect tokens (main CSRF first — that's what the HTTPS server validates)
    const csrfTokens = [];
    if (mainCsrfMatch) csrfTokens.push(mainCsrfMatch[1]);
    if (extCsrfMatch) csrfTokens.push(extCsrfMatch[1]);

    // 6. Collect ports (extension_server_port first, then any discovered listening ports)
    const portsToTry = [
      ...new Set(
        [
          parseInt(extPortMatch[1]),
          serverPortMatch && parseInt(serverPortMatch[1]),
          lspPortMatch && parseInt(lspPortMatch[1]),
          ...actualPorts,
        ].filter(Boolean),
      ),
    ];

    ctx.sidecarInfo = {
      extensionServerPort: parseInt(extPortMatch[1]),
      actualPorts: portsToTry,
      csrfTokens,
      certPath,
      pid,
    };
    ctx.sidecarInfoTimestamp = Date.now();

    log(
      ctx,
      `✅ Sidecar discovered on ${platform}: PID=${pid} ports=[${portsToTry.join(',')}] tokens=${csrfTokens.length} cert=${certPath ? 'yes' : 'no'}`,
    );
    return ctx.sidecarInfo;
  } catch (err) {
    log(ctx, `❌ Sidecar discovery failed: ${err.message}`, true);
    return null;
  }
}

module.exports = { discoverSidecar, SIDECAR_BINARY_NAMES, getPlatformStrategy };
