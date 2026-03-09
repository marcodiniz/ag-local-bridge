'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildStreamChunk, buildCompletion } = require('../src/utils');

describe('buildStreamChunk', () => {
  it('builds a chunk with content', () => {
    const chunk = buildStreamChunk('chatcmpl-123', 'test-model', 'Hello');
    assert.equal(chunk.id, 'chatcmpl-123');
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.model, 'test-model');
    assert.equal(typeof chunk.created, 'number');
    assert.ok(chunk.created > 0);
    assert.equal(chunk.choices.length, 1);
    assert.equal(chunk.choices[0].index, 0);
    assert.equal(chunk.choices[0].delta.role, 'assistant');
    assert.equal(chunk.choices[0].delta.content, 'Hello');
    assert.equal(chunk.choices[0].finish_reason, null);
  });

  it('builds a stop chunk (content=null, finishReason=stop)', () => {
    const chunk = buildStreamChunk('chatcmpl-456', 'test-model', null, 'stop');
    assert.deepEqual(chunk.choices[0].delta, {});
    assert.equal(chunk.choices[0].finish_reason, 'stop');
  });

  it('defaults finishReason to null when not specified', () => {
    const chunk = buildStreamChunk('id', 'model', 'text');
    assert.equal(chunk.choices[0].finish_reason, null);
  });

  it('includes correct OpenAI object type', () => {
    const chunk = buildStreamChunk('id', 'model', 'text');
    assert.equal(chunk.object, 'chat.completion.chunk');
  });

  it('created timestamp is a Unix epoch in seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const chunk = buildStreamChunk('id', 'model', 'text');
    const after = Math.floor(Date.now() / 1000);
    assert.ok(chunk.created >= before);
    assert.ok(chunk.created <= after);
  });
});

describe('buildCompletion', () => {
  it('builds a complete non-streaming response', () => {
    const comp = buildCompletion('chatcmpl-789', 'test-model', 'Hello world');
    assert.equal(comp.id, 'chatcmpl-789');
    assert.equal(comp.object, 'chat.completion');
    assert.equal(comp.model, 'test-model');
    assert.equal(typeof comp.created, 'number');
    assert.ok(comp.created > 0);
    assert.equal(comp.choices.length, 1);
    assert.equal(comp.choices[0].index, 0);
    assert.equal(comp.choices[0].message.role, 'assistant');
    assert.equal(comp.choices[0].message.content, 'Hello world');
    assert.equal(comp.choices[0].finish_reason, 'stop');
  });

  it('includes usage object with token counts', () => {
    const comp = buildCompletion('id', 'model', 'text');
    assert.ok(comp.usage);
    assert.equal(typeof comp.usage.prompt_tokens, 'number');
    assert.equal(typeof comp.usage.completion_tokens, 'number');
    assert.equal(typeof comp.usage.total_tokens, 'number');
  });

  it('includes correct OpenAI object type', () => {
    const comp = buildCompletion('id', 'model', 'text');
    assert.equal(comp.object, 'chat.completion');
  });

  it('finish_reason is always "stop"', () => {
    const comp = buildCompletion('id', 'model', '');
    assert.equal(comp.choices[0].finish_reason, 'stop');
  });

  it('created timestamp is a Unix epoch in seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const comp = buildCompletion('id', 'model', 'text');
    const after = Math.floor(Date.now() / 1000);
    assert.ok(comp.created >= before);
    assert.ok(comp.created <= after);
  });

  it('handles empty content string', () => {
    const comp = buildCompletion('id', 'model', '');
    assert.equal(comp.choices[0].message.content, '');
  });
});
