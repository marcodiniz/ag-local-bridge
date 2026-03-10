'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getPlatformStrategy, SIDECAR_BINARY_NAMES } = require('../src/sidecar/discovery');

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
