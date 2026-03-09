'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isLocalhostOrigin } = require('../src/server');

describe('isLocalhostOrigin', () => {
  // ── Allowed origins ──
  it('allows http://localhost', () => {
    assert.equal(isLocalhostOrigin('http://localhost'), true);
  });

  it('allows http://localhost:3000', () => {
    assert.equal(isLocalhostOrigin('http://localhost:3000'), true);
  });

  it('allows http://localhost:8080', () => {
    assert.equal(isLocalhostOrigin('http://localhost:8080'), true);
  });

  it('allows http://127.0.0.1', () => {
    assert.equal(isLocalhostOrigin('http://127.0.0.1'), true);
  });

  it('allows http://127.0.0.1:5173', () => {
    assert.equal(isLocalhostOrigin('http://127.0.0.1:5173'), true);
  });

  // ── Rejected origins ──
  it('rejects https://evil.com', () => {
    assert.equal(isLocalhostOrigin('https://evil.com'), false);
  });

  it('rejects http://evil.com', () => {
    assert.equal(isLocalhostOrigin('http://evil.com'), false);
  });

  it('rejects https://localhost (wrong protocol)', () => {
    assert.equal(isLocalhostOrigin('https://localhost'), false);
  });

  it('rejects https://localhost:3000 (wrong protocol)', () => {
    assert.equal(isLocalhostOrigin('https://localhost:3000'), false);
  });

  it('rejects http://localhost.evil.com (subdomain attack)', () => {
    assert.equal(isLocalhostOrigin('http://localhost.evil.com'), false);
  });

  it('rejects http://0.0.0.0', () => {
    assert.equal(isLocalhostOrigin('http://0.0.0.0'), false);
  });

  it('rejects null', () => {
    assert.equal(isLocalhostOrigin(null), false);
  });

  it('rejects undefined', () => {
    assert.equal(isLocalhostOrigin(undefined), false);
  });

  it('rejects empty string', () => {
    assert.equal(isLocalhostOrigin(''), false);
  });

  it('rejects malformed URL', () => {
    assert.equal(isLocalhostOrigin('not-a-url'), false);
  });
});
