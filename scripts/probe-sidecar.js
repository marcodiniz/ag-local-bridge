#!/usr/bin/env node
'use strict';

/**
 * Probe the Antigravity sidecar for raw LLM inference endpoints.
 *
 * This script discovers the running sidecar process (same logic as
 * the bridge extension) and then probes the most promising RPC
 * methods with minimal/empty payloads to discover their expected
 * request schemas from the error messages.
 *
 * Usage:
 *   node scripts/probe-sidecar.js
 *
 * The script requires Antigravity to be running.
 */

const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const os = require('os');

// ─── Sidecar Discovery (simplified for standalone use) ───

const SIDECAR_BINARY_NAMES = {
    win32: 'language_server_windows_x64.exe',
    darwin: 'language_server_macos',
    linux: 'language_server_linux',
};

async function discoverSidecar() {
    const platform = os.platform();
    const binaryName = SIDECAR_BINARY_NAMES[platform];
    if (!binaryName) throw new Error(`Unsupported platform: ${platform}`);

    let pid, commandLine;

    if (platform === 'win32') {
        // Use ConvertTo-Json to avoid Format-List wrapping issues with long command lines
        const psCmd = `Get-CimInstance Win32_Process -Filter "Name='${binaryName}'" | Select-Object ProcessId, @{N='CmdLine';E={$_.CommandLine}} | ConvertTo-Json`;
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
            encoding: 'utf8',
            timeout: 10000,
        });
        if (!stdout?.trim()) throw new Error('Sidecar process not found');
        let processes;
        try {
            processes = JSON.parse(stdout);
            if (!Array.isArray(processes)) processes = [processes];
        } catch {
            throw new Error('Could not parse sidecar process JSON');
        }
        // Prefer the ag-local-bridge workspace sidecar
        let proc = processes.find((p) => p.CmdLine && p.CmdLine.includes('ag_local_bridge'));
        if (!proc) proc = processes[0]; // Fall back to first
        if (!proc || !proc.CmdLine) throw new Error('Could not find sidecar process');
        pid = String(proc.ProcessId);
        commandLine = proc.CmdLine;
    } else {
        const { stdout } = await execFileAsync('/bin/ps', ['aux'], { encoding: 'utf8', timeout: 5000 });
        const line = stdout.split('\n').find((l) => l.includes(binaryName) && !l.includes('grep'));
        if (!line) throw new Error('Sidecar process not found');
        const parts = line.trim().split(/\s+/);
        pid = parts[1];
        commandLine = parts.slice(10).join(' ');
    }

    const extPortMatch = commandLine.match(/--extension_server_port\s+(\d+)/);
    const mainCsrfMatch = commandLine.match(/--csrf_token\s+([a-f0-9-]+)/);
    const extCsrfMatch = commandLine.match(/--extension_server_csrf_token\s+([a-f0-9-]+)/);

    // Find the HTTPS ports
    let actualPorts = [];
    if (platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000 });
            actualPorts = stdout
                .split('\n')
                .filter((l) => l.includes(pid) && l.includes('LISTENING'))
                .map((l) => {
                    const m = l.match(/127\.0\.0\.1:(\d+)/);
                    return m ? parseInt(m[1]) : null;
                })
                .filter(Boolean);
        } catch { }
    }

    // Find cert
    let certPath = null;
    const possibleCertPaths = [
        path.join(os.homedir(), '.antigravity', 'extensions'),
    ];
    // Try to find cert.pem in AG extension
    try {
        const extDir = path.join(os.homedir(), '.antigravity', 'extensions');
        const entries = fs.readdirSync(extDir);
        for (const entry of entries) {
            if (entry.startsWith('google.antigravity') || entry === 'antigravity') {
                const candidate = path.join(extDir, entry, 'dist', 'languageServer', 'cert.pem');
                if (fs.existsSync(candidate)) {
                    certPath = candidate;
                    break;
                }
            }
        }
    } catch { }
    // Try the app install location on Windows
    if (!certPath) {
        const appCert = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity',
            'resources', 'app', 'extensions', 'antigravity', 'dist', 'languageServer', 'cert.pem');
        if (fs.existsSync(appCert)) certPath = appCert;
    }

    const allPorts = [...new Set([
        ...(extPortMatch ? [parseInt(extPortMatch[1])] : []),
        ...actualPorts,
    ])];

    const csrfTokens = [];
    if (mainCsrfMatch) csrfTokens.push(mainCsrfMatch[1]);
    if (extCsrfMatch) csrfTokens.push(extCsrfMatch[1]);

    return {
        pid,
        extensionServerPort: extPortMatch ? parseInt(extPortMatch[1]) : null,
        actualPorts: allPorts,
        csrfTokens,
        certPath,
        commandLine,
    };
}

// ─── H2 RPC Caller ───

function makeH2Call(port, csrf, certPath, servicePath, body, timeoutMs = 10000) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        let ca;
        try {
            ca = certPath ? fs.readFileSync(certPath) : undefined;
        } catch { }

        const client = http2.connect(`https://localhost:${port}`, { ca, rejectUnauthorized: false });
        let totalBody = '';
        let status;
        let headers = {};
        let settled = false;

        const settle = (fn, val) => {
            if (!settled) {
                settled = true;
                fn(val);
            }
        };

        client.on('error', (err) => settle(reject, err));

        client.on('connect', () => {
            const req = client.request({
                ':method': 'POST',
                ':path': servicePath,
                'content-type': 'application/json',
                'connect-protocol-version': '1',
                'x-codeium-csrf-token': csrf,
            });

            req.on('response', (h) => {
                status = h[':status'];
                headers = h;
            });
            req.on('data', (d) => {
                totalBody += d.toString('utf8');
            });
            req.on('end', () => {
                client.close();
                let parsed;
                try {
                    parsed = JSON.parse(totalBody);
                } catch {
                    parsed = totalBody;
                }
                settle(resolve, { status, headers, body: parsed });
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
            } catch { }
            settle(reject, new Error('Timeout'));
        }, timeoutMs);
    });
}

// ─── Probe Definitions ───

// Methods to probe on LanguageServerService (main HTTPS port)
const LS_METHODS = [
    // #1: Most promising — raw LLM inference
    {
        name: 'GetModelResponse',
        path: '/exa.language_server_pb.LanguageServerService/GetModelResponse',
        payloads: [
            {},
            { prompt: 'Hello' },
            { messages: [{ role: 'user', content: 'Hello' }] },
            { message: 'Hello', modelName: 'claude-3.5-sonnet' },
        ],
    },
    // #2: Model statuses
    {
        name: 'GetModelStatuses',
        path: '/exa.language_server_pb.LanguageServerService/GetModelStatuses',
        payloads: [{}],
    },
    // #3: Model configs
    {
        name: 'GetCascadeModelConfigs',
        path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigs',
        payloads: [{}],
    },
    // #4: Model config data (extended info?)
    {
        name: 'GetCascadeModelConfigData',
        path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData',
        payloads: [{}],
    },
    // #5: Command model configs
    {
        name: 'GetCommandModelConfigs',
        path: '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs',
        payloads: [{}],
    },
    // #6: Available plugins
    {
        name: 'GetAvailableCascadePlugins',
        path: '/exa.language_server_pb.LanguageServerService/GetAvailableCascadePlugins',
        payloads: [{}],
    },
    // #7: Status
    {
        name: 'GetStatus',
        path: '/exa.language_server_pb.LanguageServerService/GetStatus',
        payloads: [{}],
    },
    // #8: Get chat message
    {
        name: 'GetChatMessage',
        path: '/exa.language_server_pb.LanguageServerService/GetChatMessage',
        payloads: [
            {},
            {
                chatMessages: [
                    { text: 'Say hello in one word', role: 'user', source: 'USER' }
                ],
            },
            {
                chatMessages: [
                    { author: 1, text: 'Say hello in one word' }
                ],
            },
        ],
    },
    // #9: Handle streaming command (used for autocomplete, but has model inference)
    {
        name: 'HandleStreamingCommand',
        path: '/exa.language_server_pb.LanguageServerService/HandleStreamingCommand',
        payloads: [{}],
    },
    // #10: Run a specific tool
    {
        name: 'RunTool',
        path: '/exa.language_server_pb.LanguageServerService/RunTool',
        payloads: [{}],
    },
];

// Methods on ChatClientServerService (may be on extension_server_port)
const CHAT_CLIENT_METHODS = [
    {
        name: 'StartChatClientRequestStream',
        path: '/exa.chat_client_server_pb.ChatClientServerService/StartChatClientRequestStream',
        payloads: [
            {},
            { clientType: 0 },
            { clientType: 'EXTENSION' },
        ],
    },
];

// ─── Main ───

async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Antigravity Sidecar RPC Probe                  ║');
    console.log('║  Discovering raw LLM inference endpoints         ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // 1. Discover sidecar
    console.log('─── Discovering Sidecar ───');
    let info;
    try {
        info = await discoverSidecar();
    } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exit(1);
    }
    console.log(`  PID:    ${info.pid}`);
    console.log(`  Ports:  ${info.actualPorts.join(', ')}`);
    console.log(`  Tokens: ${info.csrfTokens.map((t) => t.substring(0, 8) + '...').join(', ')}`);
    console.log(`  Cert:   ${info.certPath || 'not found'}`);
    console.log();

    // 2. Determine which port is the LS port (not extension_server_port)
    const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
    const mainCsrf = info.csrfTokens[0]; // --csrf_token
    const extCsrf = info.csrfTokens[info.csrfTokens.length - 1]; // extension_server_csrf_token

    if (lsPorts.length === 0) {
        console.log('⚠️  No LS ports found (only extension_server_port). Will try all ports.');
        lsPorts.push(...info.actualPorts);
    }

    // 3. Probe LanguageServerService methods on LS ports
    console.log('─── Probing LanguageServerService Methods ───\n');
    const results = [];

    for (const method of LS_METHODS) {
        console.log(`📡 ${method.name}`);
        console.log(`   Path: ${method.path}`);

        let probed = false;
        for (const port of lsPorts) {
            for (const payload of method.payloads) {
                const label = JSON.stringify(payload).substring(0, 80);
                try {
                    const res = await makeH2Call(port, mainCsrf, info.certPath, method.path, payload);
                    const bodyStr = typeof res.body === 'object' ? JSON.stringify(res.body, null, 2).substring(0, 500) : String(res.body).substring(0, 500);
                    console.log(`   ✅ port=${port} payload=${label}`);
                    console.log(`      Status: ${res.status}`);
                    console.log(`      Body: ${bodyStr}`);
                    results.push({ method: method.name, port, status: res.status, body: res.body, payload });
                    probed = true;
                    break; // If one port works, don't try the others
                } catch (e) {
                    console.log(`   ❌ port=${port} payload=${label} → ${e.message.substring(0, 120)}`);
                    results.push({ method: method.name, port, error: e.message, payload });
                }
            }
            if (probed) break;
        }
        console.log();
    }

    // 4. Probe ChatClientServerService on extension_server_port AND LS ports
    console.log('─── Probing ChatClientServerService Methods ───\n');
    const allPorts = [...new Set([...info.actualPorts])];
    const allCsrfs = [...new Set([mainCsrf, extCsrf].filter(Boolean))];

    for (const method of CHAT_CLIENT_METHODS) {
        console.log(`📡 ${method.name}`);
        console.log(`   Path: ${method.path}`);

        for (const port of allPorts) {
            for (const csrf of allCsrfs) {
                for (const payload of method.payloads) {
                    const label = `port=${port} csrf=${csrf.substring(0, 8)}... payload=${JSON.stringify(payload).substring(0, 60)}`;
                    try {
                        const res = await makeH2Call(port, csrf, info.certPath, method.path, payload);
                        const bodyStr = typeof res.body === 'object' ? JSON.stringify(res.body, null, 2).substring(0, 500) : String(res.body).substring(0, 500);
                        console.log(`   ✅ ${label}`);
                        console.log(`      Status: ${res.status}`);
                        console.log(`      Body: ${bodyStr}`);
                        results.push({ method: method.name, port, csrf: csrf.substring(0, 8), status: res.status, body: res.body });
                    } catch (e) {
                        console.log(`   ❌ ${label} → ${e.message.substring(0, 100)}`);
                    }
                }
            }
        }
        console.log();
    }

    // 5. Summary
    console.log('═══════════════════════════════════════════════');
    console.log('SUMMARY — Successful Probes:');
    console.log('═══════════════════════════════════════════════');
    const successes = results.filter((r) => r.status === 200);
    if (successes.length === 0) {
        console.log('  No 200 responses received.');
        console.log('  Check error messages above for schema hints.');
    } else {
        for (const s of successes) {
            console.log(`  ✅ ${s.method} (port ${s.port})`);
            const bodyStr = typeof s.body === 'object' ? JSON.stringify(s.body, null, 2).substring(0, 300) : String(s.body).substring(0, 300);
            console.log(`     ${bodyStr}`);
        }
    }

    // Save full results
    const outPath = path.join(os.tmpdir(), 'ag-probe-results.json');
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nFull results saved to: ${outPath}`);
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
