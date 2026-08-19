'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchMediaAsBase64 } = require('../src/images');
const { clearH2Clients } = require('../src/sidecar/rpc');

describe('Hardening and Security checks', () => {
  describe('SSRF and Media processing limits', () => {
    it('blocks loopback and local URLs in fetchMediaAsBase64', async () => {
      await assert.rejects(
        fetchMediaAsBase64('http://localhost/image.png', 'image/png'),
        /Access to private\/loopback IP is forbidden/,
      );
      await assert.rejects(
        fetchMediaAsBase64('http://127.0.0.1/image.png', 'image/png'),
        /Access to private\/loopback IP is forbidden/,
      );
      await assert.rejects(
        fetchMediaAsBase64('http://192.168.1.50/image.png', 'image/png'),
        /Access to private\/loopback IP is forbidden/,
      );
      await assert.rejects(
        fetchMediaAsBase64('https://[::1]/image.png', 'image/png'),
        /Access to private\/loopback IP is forbidden/,
      );
    });

    it('rejects deeply nested redirects in fetchMediaAsBase64', async () => {
      // Mock redirect loop detection via high redirectDepth parameter directly
      await assert.rejects(
        fetchMediaAsBase64('https://example.com/image.png', 'image/png', 6),
        /Max redirect depth exceeded/,
      );
    });
  });

  describe('HTTP/2 Client pool cleanup', () => {
    it('runs clearH2Clients without throwing any errors', () => {
      assert.doesNotThrow(() => {
        clearH2Clients();
      });
    });
  });
});
