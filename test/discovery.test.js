'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const os = require('os');
const { promisify } = require('util');

const discoveryModulePath = require.resolve('../src/sidecar/discovery');

function loadDiscoveryWithPlatform(platform, commandOutputs = {}) {
  const calls = [];
  const originalExecFile = childProcess.execFile;
  const originalPlatform = os.platform;

  const execFileStub = (file, args, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
    }

    calls.push({ file, args });
    const output = commandOutputs[file] || { stdout: '', stderr: '' };
    callback(null, output.stdout || '', output.stderr || '');
  };
  execFileStub[promisify.custom] = async (file, args) => {
    calls.push({ file, args });
    const output = commandOutputs[file] || { stdout: '', stderr: '' };
    return { stdout: output.stdout || '', stderr: output.stderr || '' };
  };

  childProcess.execFile = execFileStub;
  os.platform = () => platform;
  delete require.cache[discoveryModulePath];

  return {
    calls,
    discovery: require('../src/sidecar/discovery'),
    restore() {
      childProcess.execFile = originalExecFile;
      os.platform = originalPlatform;
      delete require.cache[discoveryModulePath];
    },
  };
}

function createCtx() {
  return {
    sidecarInfo: null,
    sidecarInfoTimestamp: 0,
    SIDECAR_CACHE_TTL: 0,
    outputChannel: { appendLine: () => {} },
  };
}

describe('discoverSidecar platform dispatch', () => {
  it('discovers the live linux x64 sidecar binary variant', async () => {
    const harness = loadDiscoveryWithPlatform('linux', {
      '/bin/ps': {
        stdout:
          'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\n' +
          'fedora 616032 0.0 0.1 123 456 ? Sl 11:18 0:03 /usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64 --enable_lsp --csrf_token 5772a62d-9302-4825-a701-1a85cbe3bc01 --extension_server_port 40759 --extension_server_csrf_token 00dc95ac-46dd-4443-8d5a-a2f33782bb02\n',
      },
      ss: {
        stdout:
          'State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess\n' +
          'LISTEN 0      511        127.0.0.1:40759      0.0.0.0:*    users:((\"language_server_linux_x64\",pid=616032,fd=30))\n' +
          'LISTEN 0      511        127.0.0.1:39201      0.0.0.0:*    users:((\"language_server_linux_x64\",pid=616032,fd=31))\n',
      },
    });

    try {
      const result = await harness.discovery.discoverSidecar(createCtx());
      assert.equal(result.extensionServerPort, 40759);
      assert.deepEqual(result.actualPorts, [40759, 39201]);
      assert.deepEqual(result.csrfTokens, [
        '5772a62d-9302-4825-a701-1a85cbe3bc01',
        '00dc95ac-46dd-4443-8d5a-a2f33782bb02',
      ]);
    } finally {
      harness.restore();
    }
  });

  it('prefers the Antigravity extension sidecar over a stray local binary', async () => {
    const harness = loadDiscoveryWithPlatform('linux', {
      '/bin/ps': {
        stdout:
          'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\n' +
          'root 612966 0.0 0.1 123 456 ? Sl 11:17 0:03 /usr/local/bin/language_server_linux_x64 --enable_lsp --lsp_port=36999 --extension_server_port 38943 --csrf_token e56fcd85-8ef7-4516-941f-424d98193c9f --server_port 43873\n' +
          'fedora-rog 639160 0.0 0.1 123 456 ? Sl 11:31 0:03 /usr/share/antigravity/resources/app/extensions/antigravity/bin/language_server_linux_x64 --enable_lsp --csrf_token 6830c0ad-2ffd-493b-913d-f0207685cf2c --extension_server_port 46237 --extension_server_csrf_token 1ad08e9c-3424-43ca-b40e-c42b6248f017 --random_port\n',
      },
      ss: {
        stdout:
          'State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess\n' +
          'LISTEN 0      511        127.0.0.1:46237      0.0.0.0:*    users:((\"antigravity\",pid=639041,fd=48))\n' +
          'LISTEN 0      4096       127.0.0.1:43405      0.0.0.0:*    users:((\"language_server\",pid=639160,fd=9))\n' +
          'LISTEN 0      4096       127.0.0.1:40935      0.0.0.0:*    users:((\"language_server\",pid=639160,fd=10))\n',
      },
    });

    try {
      const result = await harness.discovery.discoverSidecar(createCtx());
      assert.equal(result.pid, '639160');
      assert.equal(result.extensionServerPort, 46237);
      assert.deepEqual(result.actualPorts, [46237, 43405, 40935]);
      assert.deepEqual(result.csrfTokens, [
        '6830c0ad-2ffd-493b-913d-f0207685cf2c',
        '1ad08e9c-3424-43ca-b40e-c42b6248f017',
      ]);
    } finally {
      harness.restore();
    }
  });

  it('uses Linux process inspection on linux', async () => {
    const harness = loadDiscoveryWithPlatform('linux', {
      '/bin/ps': { stdout: 'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\n' },
    });

    try {
      const result = await harness.discovery.discoverSidecar(createCtx());
      assert.equal(result, null);
      assert.deepEqual(
        harness.calls.map((call) => call.file),
        ['/bin/ps'],
      );
      assert.ok(!harness.calls.some((call) => call.file === 'powershell.exe'));
    } finally {
      harness.restore();
    }
  });

  it('uses PowerShell process inspection on win32', async () => {
    const harness = loadDiscoveryWithPlatform('win32', {
      'powershell.exe': { stdout: '' },
    });

    try {
      const result = await harness.discovery.discoverSidecar(createCtx());
      assert.equal(result, null);
      assert.deepEqual(
        harness.calls.map((call) => call.file),
        ['powershell.exe'],
      );
      assert.ok(!harness.calls.some((call) => call.file === '/bin/ps'));
    } finally {
      harness.restore();
    }
  });
});
