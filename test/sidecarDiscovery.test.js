'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getPlatformStrategy, SIDECAR_BINARY_NAMES, encodeWorkspaceId } = require('../src/sidecar/discovery');

describe('getPlatformStrategy', () => {
  it('uses explicit Apple Silicon-aware binary names on darwin', () => {
    const result = getPlatformStrategy('darwin');

    assert.equal(result.platform, 'darwin');
    assert.deepEqual(result.binaryNames, ['language_server_macos_arm', 'language_server_macos']);
    assert.equal(result.primaryBinaryName, 'language_server_macos_arm');
  });

  it('uses the Windows binary only on win32', () => {
    const result = getPlatformStrategy('win32');

    assert.equal(result.platform, 'win32');
    assert.deepEqual(result.binaryNames, ['language_server_windows_x64.exe']);
    assert.equal(result.primaryBinaryName, 'language_server_windows_x64.exe');
  });

  it('keeps the exported platform binary map in sync', () => {
    assert.deepEqual(SIDECAR_BINARY_NAMES.darwin, ['language_server_macos_arm', 'language_server_macos']);
    assert.deepEqual(SIDECAR_BINARY_NAMES.win32, ['language_server_windows_x64.exe']);
    assert.deepEqual(SIDECAR_BINARY_NAMES.linux, ['language_server_linux']);
  });

  it('throws for unsupported platforms', () => {
    assert.throws(() => getPlatformStrategy('freebsd'), /Unsupported platform/);
  });
});

describe('encodeWorkspaceId', () => {
  it('encodes a Windows path with drive letter (real observed example)', () => {
    // Observed: PID 309976 had --workspace_id file_x_3A_code_marcodiniz_ag_local_bridge
    assert.equal(
      encodeWorkspaceId('x:\\code\\marcodiniz\\ag-local-bridge'),
      'file_x_3A_code_marcodiniz_ag_local_bridge',
    );
  });

  it('encodes a Windows path supplied with forward slashes', () => {
    assert.equal(encodeWorkspaceId('x:/code/marcodiniz/ag-local-bridge'), 'file_x_3A_code_marcodiniz_ag_local_bridge');
  });

  it('encodes a second Windows workspace (MetePower)', () => {
    // Observed: PID 228604 had --workspace_id file_x_3A_code_marcodiniz_MetePower
    assert.equal(encodeWorkspaceId('x:\\code\\marcodiniz\\MetePower'), 'file_x_3A_code_marcodiniz_MetePower');
  });

  it('is case-insensitive safe — uppercase drive letter normalises identically', () => {
    // Drive letter casing must not break disambiguation; callers compare toLowerCase()
    const lower = encodeWorkspaceId('x:\\code\\project');
    const upper = encodeWorkspaceId('X:\\code\\project');
    assert.equal(lower.toLowerCase(), upper.toLowerCase());
  });

  it('encodes a macOS/Linux absolute path', () => {
    assert.equal(encodeWorkspaceId('/home/user/my-project'), 'file_home_user_my_project');
  });

  it('strips a leading slash before encoding', () => {
    // '/home/user/proj' and 'home/user/proj' should yield the same result
    assert.equal(encodeWorkspaceId('/home/user/proj'), encodeWorkspaceId('home/user/proj'));
  });
});
