'use strict';

require('./setup');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const raw = require(path.join(__dirname, '..', 'src', 'sidecar', 'raw'));
const { getRawHttpStatus } = require(path.join(__dirname, '..', 'src', 'handlers', 'openai'));
const swarm = require(path.join(__dirname, '..', 'src', 'sidecar', 'swarm'));

const {
  formatMessagesAsPrompt,
  budgetMessagesForRaw,
  getRawPromptStats,
  assertRawPromptBudget,
  throwIfAborted,
  MAX_RAW_PROMPT_CHARS,
} = raw;

// ─── Schema integrity: compact but complete ───

describe('raw tool schema integrity', () => {
  it('keeps full nested schema (required/enum) in compact single-line JSON', () => {
    const params = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'] },
        nested: { type: 'object', properties: { depth: { type: 'integer' } } },
      },
      required: ['mode'],
    };
    const tools = [{ type: 'function', function: { name: 'run_it', description: 'Run it', parameters: params } }];
    const prompt = formatMessagesAsPrompt([{ role: 'user', content: 'hi' }], tools);
    const compact = JSON.stringify(params);
    assert.ok(prompt.includes(compact), 'Should embed the complete compact schema');
    assert.ok(prompt.includes('"required"'), 'Should keep required fields');
    assert.ok(prompt.includes('"enum"'), 'Should keep enums');
    assert.ok(!prompt.includes(JSON.stringify(params, null, 2)), 'Should not pretty-print schemas');
  });
});

// ─── Newest tool exchange preservation ───

describe('budgetMessagesForRaw', () => {
  function exchange(id, resultContent) {
    return [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name: 'tool_a', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: id, name: 'tool_a', content: resultContent },
    ];
  }

  it('leaves short histories untouched', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      ...exchange('call_1', 'small result'),
      { role: 'user', content: 'thanks' },
    ];
    const out = budgetMessagesForRaw(messages, null);
    assert.equal(out.truncatedCount, 0);
    assert.equal(out.messages.length, messages.length);
  });

  it('trims older tool results but preserves the newest exchange intact', () => {
    const older = 'O'.repeat(6000);
    const newest = 'N'.repeat(6000);
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      ...exchange('call_old', older),
      { role: 'user', content: 'second' },
      ...exchange('call_new', newest),
      { role: 'user', content: 'latest question' },
    ];
    const out = budgetMessagesForRaw(messages, null);
    assert.equal(out.truncatedCount, 1);
    // System + latest user untouched
    assert.equal(out.messages[0].content, 'sys');
    assert.equal(out.messages[out.messages.length - 1].content, 'latest question');
    // Older result trimmed with marker
    const olderOut = out.messages.find((m) => m.tool_call_id === 'call_old');
    assert.ok(olderOut.content.length < older.length, 'Older result should be trimmed');
    assert.ok(olderOut.content.includes('[older tool result truncated]'));
    // Newest result byte-identical
    const newestOut = out.messages.find((m) => m.tool_call_id === 'call_new');
    assert.equal(newestOut.content, newest);
  });

  it('never drops messages, only trims', () => {
    const messages = [
      { role: 'user', content: 'a' },
      ...exchange('c1', 'x'.repeat(5000)),
      ...exchange('c2', 'y'.repeat(5000)),
    ];
    const out = budgetMessagesForRaw(messages, null);
    assert.equal(out.messages.length, messages.length);
  });
});

// ─── Prompt stats + budget ───

describe('getRawPromptStats / assertRawPromptBudget', () => {
  it('reports component sizes consistent with the built prompt', () => {
    const tools = [{ type: 'function', function: { name: 't', description: 'desc', parameters: { type: 'object' } } }];
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'tool', tool_call_id: 'c1', name: 't', content: 'result-body' },
    ];
    const prompt = formatMessagesAsPrompt(messages, tools);
    const stats = getRawPromptStats(messages, tools, prompt);
    assert.equal(stats.totalChars, prompt.length);
    assert.equal(stats.toolCount, 1);
    assert.ok(stats.schemaChars > 0);
    assert.ok(stats.toolResultChars >= 'result-body'.length);
    assert.ok(stats.historyChars >= 'hello'.length);
  });

  it('throws a 413-contract error when over budget', () => {
    try {
      assertRawPromptBudget('x'.repeat(100), 10);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.match(err.message, /context_length_exceeded/);
      assert.equal(err.code, 'context_length_exceeded');
      assert.equal(err.statusCode, 413);
    }
  });

  it('passes prompts within budget', () => {
    assert.equal(assertRawPromptBudget('ok', MAX_RAW_PROMPT_CHARS), 'ok');
  });
});

// ─── HTTP status mapping ───

describe('getRawHttpStatus', () => {
  it('maps oversized prompts to 413 invalid_request (no retry)', () => {
    const err = new Error('context_length_exceeded: too big');
    err.code = 'context_length_exceeded';
    err.statusCode = 413;
    const mapped = getRawHttpStatus(err);
    assert.equal(mapped.status, 413);
    assert.equal(mapped.errType, 'invalid_request');
    assert.equal(mapped.retryAfterSecs, 0);
  });

  it('keeps rate-limit errors at 429', () => {
    const mapped = getRawHttpStatus(new Error('H2 timeout after 120s'));
    assert.equal(mapped.status, 429);
    assert.equal(mapped.errType, 'rate_limit');
  });

  it('maps unknown errors to 502', () => {
    const mapped = getRawHttpStatus(new Error('something weird'));
    assert.equal(mapped.status, 502);
    assert.equal(mapped.errType, 'server_error');
  });
});

// ─── Cancellation ───

describe('throwIfAborted', () => {
  it('throws on aborted signal, passes otherwise', () => {
    assert.throws(() => throwIfAborted({ aborted: true }), /Client disconnected/);
    assert.doesNotThrow(() => throwIfAborted({ aborted: false }));
    assert.doesNotThrow(() => throwIfAborted(null));
    assert.doesNotThrow(() => throwIfAborted(undefined));
  });
});

// ─── Swarm alternate-port discovery ───

describe('getSwarmCandidatePorts', () => {
  it('returns extension_server_port first, then server_port and lsp_port', () => {
    const cmd =
      'language_server_windows_x64.exe --extension_server_port 57188 --server_port 57191 --lsp_port=49790 --csrf_token aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.deepEqual(swarm.getSwarmCandidatePorts(cmd), [57188, 57191, 49790]);
  });

  it('dedupes repeated ports and handles missing flags', () => {
    const cmd =
      'language_server_windows_x64.exe --extension_server_port 57188 --csrf_token aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.deepEqual(swarm.getSwarmCandidatePorts(cmd), [57188]);
    assert.deepEqual(swarm.getSwarmCandidatePorts('no flags here'), []);
  });
});
