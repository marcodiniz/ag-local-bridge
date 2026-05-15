'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRetryAfter, extractProviderError } = require('../src/utils');

describe('parseRetryAfter', () => {
  it('parses seconds-only format', () => {
    assert.equal(parseRetryAfter('reset after 45s'), 47); // 45 + 2
  });

  it('parses minutes and seconds format', () => {
    assert.equal(parseRetryAfter('reset after 42m41s'), 2563); // (42 * 60) + 41 + 2
  });

  it('parses short lengths but enforces a minimum of 10 seconds', () => {
    assert.equal(parseRetryAfter('reset after 5ms'), 10); // 5+2=7, falls back to min 10
  });

  it('enforces a minimum of 10 seconds', () => {
    assert.equal(parseRetryAfter('reset after 2s'), 10);
  });

  it('returns default 10 seconds if no match', () => {
    assert.equal(parseRetryAfter('quota exhausted'), 10);
    assert.equal(parseRetryAfter(null), 10);
    assert.equal(parseRetryAfter({}), 10);
  });
});

describe('extractProviderError', () => {
  it('extracts nested JSON message string and rewrites RESOURCE_EXHAUSTED', () => {
    const raw = 'HTTP 500: {"code":"unknown","message":"RESOURCE_EXHAUSTED (code 429): You have exhausted..."}';
    assert.equal(
      extractProviderError(raw),
      "Google API Rate Limit (TPM/RPM) exceeded. Please wait a minute for limits to reset, or reduce your context size. (Google's raw error: RESOURCE_EXHAUSTED (code 429): You have exhausted...)",
    );
  });

  it('extracts normal nested JSON message string', () => {
    const raw = 'HTTP 500: {"code":"unknown","message":"Some other error occurred"}';
    assert.equal(extractProviderError(raw), 'Some other error occurred');
  });

  it('returns raw message if not JSON', () => {
    const raw = 'HTTP 502: Bad Gateway';
    assert.equal(extractProviderError(raw), 'HTTP 502: Bad Gateway');
  });

  it('returns raw message if JSON has no message property', () => {
    const raw = 'HTTP 500: {"error":"something went wrong"}';
    assert.equal(extractProviderError(raw), raw);
  });

  it('returns fallback string for non-string input', () => {
    assert.equal(extractProviderError(null), 'null');
    assert.equal(extractProviderError(undefined), 'undefined');
    assert.equal(extractProviderError({}), '[object Object]');
  });
});
