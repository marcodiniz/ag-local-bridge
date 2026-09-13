'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http2 = require('node:http2');
const { makeH2JsonCall, clearH2Clients } = require('../src/sidecar/rpc');

it('rejects premature H2 close immediately and reports timeout transport state', async (t) => {
  let stream;
  t.mock.method(http2, 'connect', () => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = () => {
      stream = new EventEmitter();
      stream.write = () => {};
      stream.end = () => {};
      stream.close = () => {};
      return stream;
    };
    return client;
  });
  try {
    const closed = makeH2JsonCall(12345, 'test', null, 'GetModelResponse', {}, 0, 1000);
    stream.emit('close');
    await assert.rejects(closed, /H2 stream closed before response completed/);
    const timeout = makeH2JsonCall(12345, 'test', null, 'GetModelResponse', {}, 0, 10);
    stream.emit('response', { ':status': 200 });
    stream.emit('data', Buffer.from('abc'));
    await assert.rejects(timeout, /H2 timeout: GetModelResponse port=12345 status=200 bytes=3 elapsed=10ms/);
  } finally {
    clearH2Clients();
  }
});
