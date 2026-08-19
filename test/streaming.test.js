'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { getStreamingMode, shouldStreamViaCascade } = require('../src/utils');

describe('Streaming Mode Decision Logic', () => {
  beforeEach(() => {
    vscode.workspace.__resetConfig();
  });

  it('defaults to smart mode when unconfigured', () => {
    const ctx = {};
    assert.equal(getStreamingMode(ctx), 'smart');
  });

  describe('smart mode', () => {
    beforeEach(() => {
      vscode.workspace.__setConfig('agLocalBridge', 'streamingMode', 'smart');
    });

    it('routes pure streaming chat to Cascade (true)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: false, hasNumericModelValue: true });
      assert.equal(result, true);
    });

    it('routes non-streaming requests to Raw (false)', () => {
      const result = shouldStreamViaCascade({}, { stream: false, hasTools: false, hasNumericModelValue: true });
      assert.equal(result, false);
    });

    it('routes tool-calling streaming requests to Raw (false)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: true, hasNumericModelValue: true });
      assert.equal(result, false);
    });

    it('routes requests without numeric model value to Raw (false)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: false, hasNumericModelValue: false });
      assert.equal(result, false);
    });
  });

  describe('raw mode', () => {
    beforeEach(() => {
      vscode.workspace.__setConfig('agLocalBridge', 'streamingMode', 'raw');
    });

    it('routes pure streaming chat to Raw (false)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: false, hasNumericModelValue: true });
      assert.equal(result, false);
    });

    it('routes tool calls to Raw (false)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: true, hasNumericModelValue: true });
      assert.equal(result, false);
    });
  });

  describe('cascade mode', () => {
    beforeEach(() => {
      vscode.workspace.__setConfig('agLocalBridge', 'streamingMode', 'cascade');
    });

    it('routes streaming chat to Cascade (true)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: false, hasNumericModelValue: true });
      assert.equal(result, true);
    });

    it('routes tool calls to Cascade when forced (true)', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: true, hasNumericModelValue: true });
      assert.equal(result, true);
    });

    it('routes non-streaming to false', () => {
      const result = shouldStreamViaCascade({}, { stream: false, hasTools: false, hasNumericModelValue: true });
      assert.equal(result, false);
    });

    it('returns false if no numeric model value exists', () => {
      const result = shouldStreamViaCascade({}, { stream: true, hasTools: false, hasNumericModelValue: false });
      assert.equal(result, false);
    });
  });
});
