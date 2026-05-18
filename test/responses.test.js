'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeResponsesInput,
  responsesToChatPayload,
  chatToResponsesPayload,
} = require('../src/handlers/responses');

describe('Responses API adapter', () => {
  it('converts string input into a user chat message', () => {
    const messages = normalizeResponsesInput('hello', 'be brief');
    assert.deepEqual(messages, [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('preserves Responses content parts including multimedia', () => {
    const payload = responsesToChatPayload({
      model: 'antigravity-claude-sonnet-4-6',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'data:image/png;base64,aaa=' },
            { type: 'input_audio', input_audio: { data: 'bbb=', format: 'wav' } },
          ],
        },
      ],
      max_output_tokens: 123,
    });
    assert.equal(payload.model, 'antigravity-claude-sonnet-4-6');
    assert.equal(payload.max_tokens, 123);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].content[1].type, 'input_image');
    assert.equal(payload.messages[0].content[2].type, 'input_audio');
  });

  it('converts chat completions into Responses shape and translates token counts', () => {
    const response = chatToResponsesPayload(
      {
        id: 'chatcmpl-1',
        created: 123,
        model: 'test-model',
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      'fallback-model',
    );
    assert.equal(response.object, 'response');
    assert.equal(response.model, 'test-model');
    assert.equal(response.output_text, 'hello');
    assert.equal(response.output[0].content[0].type, 'output_text');
    assert.equal(response.usage.input_tokens, 1);
    assert.equal(response.usage.output_tokens, 2);
    assert.equal(response.usage.total_tokens, 3);
  });

  it('normalizes Responses input with function_call and function_call_output parts', () => {
    const inputParts = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            name: 'get_weather',
            call_id: 'call-123',
            arguments: '{"location":"London"}',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'function_call_output',
            call_id: 'call-123',
            output: '{"temp": 15}',
          },
        ],
      },
    ];
    const messages = normalizeResponsesInput(inputParts);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'assistant');
    assert.deepEqual(messages[0].tool_calls, [
      {
        id: 'call-123',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"London"}',
        },
      },
    ]);
    assert.equal(messages[1].role, 'tool');
    assert.equal(messages[1].tool_call_id, 'call-123');
    assert.equal(messages[1].content, '{"temp": 15}');
  });
});
