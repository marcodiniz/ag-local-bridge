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
 * Binary name the Antigravity sidecar ships as, per platform.
 */
const SIDECAR_BINARY_NAMES = {
  win32: 'language_server_windows_x64.exe',
  darwin: 'language_server_macos',
  linux: 'language_server_linux',
};

/**
 * @typedef {Object} ProcessInfo
 * @property {string} pid
 * @property {string} commandLine
 */

/**
 * @typedef {Object} PlatformStrategy
 * @property {() => Promise<ProcessInfo|null>} findProcess
 * @property {(pid: string) => Promise<number[]>} findListeningPorts
 */

// ─────────────────────────────────────────────
// Windows strategy  (PowerShell Get-CimInstance)
// ─────────────────────────────────────────────

function windowsStrategy(binaryName) {
  return {
    async findProcess() {
      // Use Get-CimInstance Win32_Process (preferred over deprecated wmic)
      const psCmd = `Get-CimInstance Win32_Process -Filter "Name='${binaryName}'" | Select-Object ProcessId,CommandLine | Format-List`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        encoding: 'utf8',
        timeout: 10000,
      });

      if (!stdout || !stdout.trim()) return null;

      const pidMatch = stdout.match(/ProcessId\s*:\s*(\d+)/);
      const cmdMatch = stdout.match(/CommandLine\s*:\s*(.+)/);

      if (!pidMatch || !cmdMatch) return null;

      return { pid: pidMatch[1], commandLine: cmdMatch[1].trim() };
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

function darwinStrategy(binaryName) {
  return {
    async findProcess() {
      const { stdout } = await execFileAsync('/bin/ps', ['aux'], { encoding: 'utf8', timeout: 5000 });

      // Find the line that contains the actual binary (skip the grep line)
      const line = stdout.split('\n').find((l) => l.includes(binaryName) && !l.includes('grep'));
      if (!line) return null;

      // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      // Reconstruct full command line from column 10 onward
      const commandLine = parts.slice(10).join(' ');

      return { pid, commandLine };
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

function linuxStrategy(binaryName) {
  return {
    async findProcess() {
      const { stdout } = await execFileAsync('/bin/ps', ['aux'], { encoding: 'utf8', timeout: 5000 });

      const line = stdout.split('\n').find((l) => l.includes(binaryName) && !l.includes('grep'));
      if (!line) return null;

      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      const commandLine = parts.slice(10).join(' ');

      return { pid, commandLine };
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
 * @returns {{ strategy: PlatformStrategy, binaryName: string }}
 */
function getPlatformStrategy() {
  const platform = os.platform();
  const binaryName = SIDECAR_BINARY_NAMES[platform];

  if (!binaryName) {
    throw new Error(`Unsupported platform for sidecar discovery: ${platform}`);
  }

  const factories = {
    win32: windowsStrategy,
    darwin: darwinStrategy,
    linux: linuxStrategy,
  };

  return { strategy: factories[platform](binaryName), binaryName };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

async function discoverSidecar(ctx) {
  if (ctx.sidecarInfo && Date.now() - ctx.sidecarInfoTimestamp < ctx.SIDECAR_CACHE_TTL) return ctx.sidecarInfo;

  try {
    const { strategy, binaryName } = getPlatformStrategy();

    // 1. Find the sidecar process
    const proc = await strategy.findProcess();
    if (!proc) {
      log(ctx, `⚠️ Sidecar process not found (looking for ${binaryName} on ${os.platform()})`);
      return null;
    }

    const { pid, commandLine } = proc;

    // 2. Parse flags from the command line
    const extPortMatch = commandLine.match(/--extension_server_port\s+(\d+)/);
    const extCsrfMatch = commandLine.match(/--extension_server_csrf_token\s+([a-f0-9-]+)/);
    const mainCsrfMatch = commandLine.match(/--csrf_token\s+([a-f0-9-]+)/);

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
    const portsToTry = [...new Set([parseInt(extPortMatch[1]), ...actualPorts])];

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
      `✅ Sidecar discovered on ${os.platform()}: PID=${pid} ports=[${portsToTry.join(',')}] tokens=${csrfTokens.length} cert=${certPath ? 'yes' : 'no'}`,
    );
    return ctx.sidecarInfo;
  } catch (err) {
    log(ctx, `❌ Sidecar discovery failed: ${err.message}`, true);
    return null;
  }
}

module.exports = { discoverSidecar, SIDECAR_BINARY_NAMES };
