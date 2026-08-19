'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { log } = require('../utils');
const { makeH2JsonCall, clearH2Clients } = require('./rpc');

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
  linux: ['language_server_linux'],
};

/**
 * @typedef {Object} ProcessInfo
 * @property {string} pid
 * @property {string} commandLine
 * @property {string} user
 */

/**
 * @typedef {Object} PlatformStrategy
 * @property {(currentWorkspaceId: string|null) => Promise<ProcessInfo|null>} findProcess
 * @property {(pid: string) => Promise<number[]>} findListeningPorts
 */

/**
 * Encode a VS Code workspace fsPath to the sidecar's --workspace_id format.
 * Reverse-engineered from observed sidecar command lines:
 *   'x:/code/marcodiniz/ag-local-bridge' → 'file_x_3A_code_marcodiniz_ag_local_bridge'
 *
 * Algorithm: normalize to forward slashes → strip leading slash →
 *   replace ':' with '_3A_', '/' with '_', '-' with '_' → prefix 'file_'.
 */
function encodeWorkspaceId(fsPath) {
  // Normalize backslashes to forward slashes, strip any leading slash.
  const p = fsPath.replace(/\\/g, '/').replace(/^\//, '');
  // On Windows the path looks like 'x:/code/...'. The sidecar encodes the ':/' root
  // separator as '_3A_' (absorbing the slash), then maps remaining '/' and '-' to '_'.
  return (
    'file_' +
    p
      .replace(/:\//, '_3A_') // Windows 'drive:/' root separator — absorb the slash into '_3A_'
      .replace(/:/g, '_3A_') // any remaining bare ':' (safety fallback)
      .replace(/\//g, '_') // path directory separators
      .replace(/-/g, '_') // hyphens
  );
}

/**
 * Return the encoded --workspace_id for the currently active VS Code workspace folder,
 * or null if no folder is open. Used to disambiguate multiple sidecar instances.
 */
function getCurrentWorkspaceId() {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return encodeWorkspaceId(folders[0].uri.fsPath);
  } catch {
    return null;
  }
}

function rankProcessCandidate(proc, currentWorkspaceId) {
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

  // Prefer workspace-attached sidecars over the bare global instance (no --workspace_id).
  if (proc.commandLine.includes('--enable_lsp')) score += 30;

  // Strongly prefer the sidecar whose --workspace_id matches the current VS Code workspace.
  // Case-insensitive to guard against Windows drive-letter casing differences (C: vs c:).
  if (currentWorkspaceId) {
    const wsMatch = proc.commandLine.match(/--workspace_id\s+(\S+)/);
    if (wsMatch && wsMatch[1].toLowerCase() === currentWorkspaceId.toLowerCase()) {
      score += 200;
    }
  }

  return score;
}

function chooseBestProcess(candidates, currentWorkspaceId) {
  if (!candidates || candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => rankProcessCandidate(b, currentWorkspaceId) - rankProcessCandidate(a, currentWorkspaceId),
  )[0];
}

async function probeH2LanguageServerPorts(ports, extensionServerPort, csrf, certPath) {
  if (!csrf) return [];
  const lsPorts = ports.filter((p) => p !== extensionServerPort);
  const results = await Promise.all(
    lsPorts.map(async (port) => {
      try {
        await makeH2JsonCall(port, csrf, certPath, 'GetAvailableCascadePlugins', {}, 0, 1500);
        return port;
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

// ─────────────────────────────────────────────
// Windows strategy  (PowerShell Get-CimInstance)
// ─────────────────────────────────────────────

async function execWithFallback(cmdBase, cmdAbsolute, args, options) {
  try {
    return await execFileAsync(cmdBase, args, options);
  } catch (err) {
    if (err.code === 'ENOENT' && cmdAbsolute) {
      return await execFileAsync(cmdAbsolute, args, options);
    }
    throw err;
  }
}

function windowsStrategy(binaryNames) {
  return {
    async findProcess(currentWorkspaceId) {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklistExe = `${sysRoot}\\System32\\tasklist.exe`;
      const wmicExe = `${sysRoot}\\System32\\wbem\\wmic.exe`;
      const powershellExe = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

      for (const binaryName of binaryNames) {
        // Strategy 1 (fastest): tasklist to find PIDs, then wmic for each PID's command line.
        // tasklist is near-instant and doesn't go through WMI.
        try {
          const { stdout: taskOut } = await execWithFallback(
            'tasklist',
            tasklistExe,
            ['/FI', `IMAGENAME eq ${binaryName}`, '/FO', 'CSV', '/NH'], // RESTORED FILTER
            { encoding: 'utf8', timeout: 3000 },
          );
          if (taskOut && taskOut.trim() && !taskOut.includes('No tasks')) {
            const pids = taskOut
              .trim()
              .split('\n')
              .map((line) => {
                const m = line.match(/"[^"]+","(\d+)"/);
                return m ? m[1] : null;
              })
              .filter(Boolean);

            // Get command line for each PID (wmic for a single PID is fast)
            const candidates = [];
            for (const pid of pids) {
              try {
                const { stdout: cmdOut } = await execWithFallback(
                  'wmic',
                  wmicExe,
                  ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/FORMAT:LIST'],
                  { encoding: 'utf8', timeout: 3000 },
                );
                const cmdMatch = cmdOut && cmdOut.match(/CommandLine=(.+)/);
                if (cmdMatch) {
                  candidates.push({ pid, commandLine: cmdMatch[1].trim(), user: '' });
                }
              } catch (_err) {
                // wmic failed for this PID — skip it
              }
            }

            const best = chooseBestProcess(candidates, currentWorkspaceId);
            if (best) return best;
          }
        } catch (_err) {
          // tasklist or wmic unavailable — fall through
        }

        // Strategy 2: wmic full scan (fast-ish, no PowerShell startup overhead)
        try {
          const { stdout } = await execWithFallback(
            'wmic',
            wmicExe,
            ['process', 'where', `Name='${binaryName}'`, 'get', 'ProcessId,CommandLine', '/FORMAT:CSV'],
            { encoding: 'utf8', timeout: 5000 },
          );
          if (stdout && stdout.trim()) {
            // CSV format: Node,CommandLine,ProcessId (header line + data lines)
            const lines = stdout
              .trim()
              .split('\n')
              .filter((l) => l.trim() && !l.startsWith('Node'));
            const candidates = lines
              .map((line) => {
                // CSV: hostname,commandline,pid — but commandline may contain commas
                const parts = line.trim().split(',');
                if (parts.length < 3) return null;
                const pid = parts[parts.length - 1].trim();
                // Everything between first and last comma is the command line
                const commandLine = parts.slice(1, -1).join(',').trim();
                return pid && commandLine ? { pid, commandLine, user: '' } : null;
              })
              .filter(Boolean);

            const best = chooseBestProcess(candidates, currentWorkspaceId);
            if (best) return best;
          }
        } catch (_err) {
          // wmic may not be available on newer Windows — fall through to PowerShell
        }

        // Strategy 3: PowerShell Get-CimInstance (slowest but universally available)
        try {
          const psCmd = `Get-CimInstance Win32_Process -Filter "Name='${binaryName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
          const { stdout } = await execWithFallback(
            'powershell.exe',
            powershellExe,
            ['-NoProfile', '-NonInteractive', '-Command', psCmd],
            { encoding: 'utf8', timeout: 10000 },
          );

          if (!stdout || !stdout.trim()) continue;

          let parsed = JSON.parse(stdout.trim());
          // ConvertTo-Json returns an object when there's 1 result, array when >1
          if (!Array.isArray(parsed)) parsed = [parsed];

          const candidates = parsed
            .filter((p) => p.ProcessId && p.CommandLine)
            .map((p) => ({
              pid: String(p.ProcessId),
              commandLine: p.CommandLine,
              user: '',
            }));

          const best = chooseBestProcess(candidates, currentWorkspaceId);
          if (best) return best;
        } catch (_err) {
          // All strategies failed for this binary name — try next
        }
      }

      return null;
    },

    async findListeningPorts(pid) {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      const netstatExe = `${sysRoot}\\System32\\netstat.exe`;
      try {
        const { stdout } = await execWithFallback('netstat', netstatExe, ['-ano'], { encoding: 'utf8', timeout: 5000 });
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
    async findProcess(currentWorkspaceId) {
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

      return chooseBestProcess(candidates, currentWorkspaceId);
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
    async findProcess(currentWorkspaceId) {
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

      return chooseBestProcess(candidates, currentWorkspaceId);
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
 * Return the correct strategy for the given (or current) platform.
 * @param {string} [platformOverride] - Optional platform string; defaults to os.platform().
 * @returns {{ strategy: PlatformStrategy, binaryNames: string[], primaryBinaryName: string, platform: string }}
 */
function getPlatformStrategy(platformOverride) {
  const platform = platformOverride || os.platform();
  const binaryNames = SIDECAR_BINARY_NAMES[platform];

  if (!binaryNames) {
    throw new Error(`Unsupported platform for sidecar discovery: ${platform}`);
  }

  const factories = {
    win32: windowsStrategy,
    darwin: darwinStrategy,
    linux: linuxStrategy,
  };

  return {
    strategy: factories[platform](binaryNames),
    binaryNames,
    primaryBinaryName: binaryNames[0],
    platform,
  };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

let _discoveryInFlight = null;

async function discoverSidecar(ctx) {
  if (ctx.sidecarInfo && Date.now() - ctx.sidecarInfoTimestamp < ctx.SIDECAR_CACHE_TTL) return ctx.sidecarInfo;

  // Serialize concurrent discovery calls — only one PowerShell/wmic process at a time.
  // All concurrent callers share the same in-flight promise.
  if (_discoveryInFlight) return _discoveryInFlight;

  _discoveryInFlight = _discoverSidecarOnce(ctx).finally(() => {
    _discoveryInFlight = null;
  });
  return _discoveryInFlight;
}

async function _discoverSidecarOnce(ctx) {
  clearH2Clients();
  try {
    const { strategy, binaryNames } = getPlatformStrategy();
    const currentWorkspaceId = getCurrentWorkspaceId();

    // 1. Find the sidecar process — prefer the one matching this workspace
    const proc = await strategy.findProcess(currentWorkspaceId);
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
      log(ctx, `⚠️ Could not find sidecar extension_server_port (PID=${pid}, cmdLine=${commandLine.length} chars)`);
      log(ctx, `⚠️ CommandLine: ${commandLine.substring(0, 300)}`);
      return null;
    }

    // 3. Discover listening ports via platform-specific tool
    const actualPorts = await strategy.findListeningPorts(pid);

    // 4. Find cert
    let certPath = null;
    const agExt = vscode.extensions.getExtension('google.antigravity');
    if (agExt) {
      const candidate = path.join(agExt.extensionPath, 'dist', 'languageServer', 'cert.pem');
      if (fs.existsSync(candidate)) certPath = candidate;
    }
    if (!certPath) {
      const candidatePaths = [
        path.join(
          os.homedir(),
          'AppData',
          'Local',
          'Programs',
          'Antigravity IDE',
          'resources',
          'app',
          'extensions',
          'antigravity',
          'dist',
          'languageServer',
          'cert.pem',
        ),
        path.join(
          os.homedir(),
          'AppData',
          'Local',
          'Programs',
          'Antigravity',
          'resources',
          'app',
          'extensions',
          'antigravity',
          'dist',
          'languageServer',
          'cert.pem',
        ),
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          certPath = p;
          break;
        }
      }
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

    const extensionServerPort = parseInt(extPortMatch[1]);
    const h2HealthyPorts = await probeH2LanguageServerPorts(portsToTry, extensionServerPort, csrfTokens[0], certPath);
    const orderedPorts = [
      extensionServerPort,
      ...h2HealthyPorts,
      ...portsToTry.filter((p) => p !== extensionServerPort && !h2HealthyPorts.includes(p)),
    ];

    ctx.sidecarInfo = {
      extensionServerPort,
      actualPorts: orderedPorts,
      h2HealthyPorts,
      csrfTokens,
      certPath,
      pid,
    };
    ctx.sidecarInfoTimestamp = Date.now();

    const wsMatchNote = currentWorkspaceId
      ? proc.commandLine.match(/--workspace_id\s+(\S+)/)?.[1] === currentWorkspaceId
        ? ' (workspace match ✅)'
        : ' (workspace mismatch ⚠️)'
      : '';
    log(
      ctx,
      `✅ Sidecar discovered on ${os.platform()}: PID=${pid} ports=[${orderedPorts.join(',')}] h2=[${h2HealthyPorts.join(',')}] tokens=${csrfTokens.length} cert=${certPath ? 'yes' : 'no'}${wsMatchNote}`,
    );
    return ctx.sidecarInfo;
  } catch (err) {
    log(ctx, `❌ Sidecar discovery failed: ${err.message}`, true);
    return null;
  }
}

module.exports = { discoverSidecar, SIDECAR_BINARY_NAMES, getPlatformStrategy, encodeWorkspaceId };
