'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { formatMessagesAsPrompt, parseToolCalls } = require(path.join(__dirname, '..', 'src', 'sidecar', 'raw'));

// ─── formatMessagesAsPrompt ───

describe('formatMessagesAsPrompt', () => {
  it('formats simple messages with role labels', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
    ];
    const prompt = formatMessagesAsPrompt(messages, null);
    assert.ok(prompt.includes('[System]'), 'Should contain [System] label');
    assert.ok(prompt.includes('[User]'), 'Should contain [User] label');
    assert.ok(prompt.includes('You are a helpful assistant.'), 'Should contain system content');
    assert.ok(prompt.includes('What is 2+2?'), 'Should contain user content');
  });

  it('includes tool definitions when tools are provided', () => {
    const messages = [{ role: 'user', content: 'Read a file' }];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ];
    const prompt = formatMessagesAsPrompt(messages, tools);
    assert.ok(prompt.includes('Available Tools'), 'Should contain tool header');
    assert.ok(prompt.includes('read_file'), 'Should contain tool name');
    assert.ok(prompt.includes('<tool_call>'), 'Should contain tool_call format instruction');
  });

  it('formats tool call history and tool results', () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file' },
      },
    ];
    const messages = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Read package.json' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path": "package.json"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '{"name": "example"}' },
      { role: 'user', content: 'What is the name field?' },
    ];
    const prompt = formatMessagesAsPrompt(messages, tools);
    assert.ok(prompt.includes('[Tool Result: read_file]'), 'Should contain tool result');
    assert.ok(prompt.includes('{"name": "example"}'), 'Should contain tool result content');
    assert.ok(prompt.includes('What is the name field?'), 'Should contain follow-up question');
  });
});

// ─── parseToolCalls ───

describe('parseToolCalls', () => {
  it('returns content unchanged when no tool calls present', () => {
    const result = parseToolCalls('Hello, world!');
    assert.equal(result.content, 'Hello, world!');
    assert.equal(result.toolCalls, null);
  });

  it('extracts a single tool call and strips it from content', () => {
    const result = parseToolCalls(
      'I\'ll read that file for you.\n<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>',
    );
    assert.equal(result.content, "I'll read that file for you.");
    assert.ok(result.toolCalls !== null);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'read_file');
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).path, 'package.json');
  });

  it('extracts multiple tool calls', () => {
    const result = parseToolCalls(
      '<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call>\n' +
        '<tool_call>{"name": "read_file", "arguments": {"path": "b.js"}}</tool_call>\n' +
        'Let me look at both files.',
    );
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.content, 'Let me look at both files.');
  });

  it('returns null content when only tool calls are present', () => {
    const result = parseToolCalls('<tool_call>{"name": "bash", "arguments": {"command": "ls -la"}}</tool_call>');
    assert.ok(result.content === null || result.content === '');
    assert.equal(result.toolCalls.length, 1);
  });

  it('gracefully handles invalid JSON in tool call blocks', () => {
    const result = parseToolCalls('Hello\n<tool_call>not json</tool_call>\nWorld');
    assert.equal(result.toolCalls, null, 'Invalid JSON should result in no tool calls');
    assert.ok(result.content.includes('Hello'), 'Should preserve surrounding text');
  });

  it('extracts native XML tool format (Claude/Minimax)', () => {
    const xml = `
<minimax:tool_call>
<invoke>
<tool_name>seq-prod_SeqSearch</tool_name>
<parameter name="filter">@Timestamp > Now() - 1d</parameter>
<parameter name="count">15</parameter>
</invoke>
</minimax:tool_call>
Here is my search.
    `;
    const result = parseToolCalls(xml);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'seq-prod_SeqSearch');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    assert.equal(args.filter, '@Timestamp > Now() - 1d');
    assert.equal(args.count, '15');
    assert.equal(result.content, 'Here is my search.');
  });

  it('extracts native Claude 3 tool use XML format', () => {
    const xml = `
<function_calls>
<tool_use>
<name>get_weather</name>
<input>
<location>San Francisco, CA</location>
<unit>fahrenheit</unit>
</input>
</tool_use>
</function_calls>
The weather should be nice.
    `;
    const result = parseToolCalls(xml);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'get_weather');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    assert.equal(args.location, 'San Francisco, CA');
    assert.equal(args.unit, 'fahrenheit');
    assert.equal(result.content, 'The weather should be nice.');
  });
});
