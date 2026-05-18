'use strict';

const { randomUUID } = require('crypto');
const { sendJson, readBody } = require('../utils');
const { handleChatCompletions } = require('./openai');

function normalizeResponsesInput(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: 'system', content: instructions });

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    messages.push({ role: 'user', content: input === null || input === undefined ? '' : String(input) });
    return messages;
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const msg = { role: item.role || 'user', content: item.content || '' };
      if (Array.isArray(item.content)) {
        const fnCallPart = item.content.find((p) => p && p.type === 'function_call');
        if (fnCallPart) {
          msg.content = null;
          msg.tool_calls = [
            {
              id: fnCallPart.call_id || fnCallPart.id,
              type: 'function',
              function: {
                name: fnCallPart.name || '',
                arguments:
                  typeof fnCallPart.arguments === 'string'
                    ? fnCallPart.arguments
                    : JSON.stringify(fnCallPart.arguments || {}),
              },
            },
          ];
        }
        const fnOutputPart = item.content.find((p) => p && p.type === 'function_call_output');
        if (fnOutputPart) {
          msg.role = 'tool';
          msg.tool_call_id = fnOutputPart.call_id || fnOutputPart.id;
          msg.content =
            typeof fnOutputPart.output === 'string'
              ? fnOutputPart.output
              : JSON.stringify(fnOutputPart.output !== undefined ? fnOutputPart.output : {});
        }
      }
      messages.push(msg);
      continue;
    }

    if (item.role) {
      messages.push({ role: item.role, content: item.content || item.text || '' });
      continue;
    }

    if (item.type === 'input_text') {
      messages.push({ role: 'user', content: [{ type: 'input_text', text: item.text || '' }] });
      continue;
    }

    if (item.type === 'input_image' || item.type === 'input_audio' || item.type === 'input_file') {
      messages.push({ role: 'user', content: [item] });
      continue;
    }

    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id,
            type: 'function',
            function: {
              name: item.name || '',
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
            },
          },
        ],
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content:
          typeof item.output === 'string' ? item.output : JSON.stringify(item.output !== undefined ? item.output : {}),
      });
      continue;
    }
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
}

function responsesToChatPayload(payload) {
  return {
    model: payload.model,
    messages: normalizeResponsesInput(payload.input, payload.instructions),
    stream: payload.stream === true,
    tools: payload.tools,
    tool_choice: payload.tool_choice,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_tokens || payload.max_output_tokens,
    max_output_tokens: payload.max_output_tokens,
  };
}

function chatToResponsesPayload(chat, originalModel) {
  const choice = chat && chat.choices && chat.choices[0];
  const message = (choice && choice.message) || {};
  const text = message.content || '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const id = `resp_${randomUUID()}`;

  const output = [];
  if (text || toolCalls.length === 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const toolCall of toolCalls) {
    const callId = toolCall.id || `call_${randomUUID()}`;
    const fn = toolCall.function || {};
    output.push({
      id: callId,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: fn.name || '',
      arguments: fn.arguments || '{}',
    });
  }

  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  if (chat && chat.usage) {
    const u = chat.usage;
    usage = {
      input_tokens: u.input_tokens !== undefined ? u.input_tokens : u.prompt_tokens || 0,
      output_tokens: u.output_tokens !== undefined ? u.output_tokens : u.completion_tokens || 0,
      total_tokens: u.total_tokens !== undefined ? u.total_tokens : (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    };
  }

  return {
    id,
    object: 'response',
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: (chat && chat.model) || originalModel,
    output,
    output_text: text,
    usage,
  };
}

function patchResponse(res, onJson) {
  const originalSetHeader = res.setHeader.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  const originalEnd = res.end.bind(res);
  const headers = new Map();
  let statusCode = 200;

  res.setHeader = (name, value) => {
    headers.set(String(name).toLowerCase(), [name, value]);
    return res;
  };
  res.writeHead = (code, headerObj) => {
    statusCode = code;
    if (headerObj) {
      for (const [name, value] of Object.entries(headerObj)) headers.set(String(name).toLowerCase(), [name, value]);
    }
    return res;
  };
  res.end = (chunk) => {
    let body = chunk ? Buffer.from(chunk).toString('utf8') : '';
    if (statusCode >= 200 && statusCode < 300) {
      try {
        body = JSON.stringify(onJson(JSON.parse(body)));
      } catch {
        // Preserve original body if the chat handler emitted non-JSON.
      }
    }
    for (const [, [name, value]] of headers) originalSetHeader(name, value);
    originalWriteHead(statusCode);
    return originalEnd(body);
  };
}

function patchResponsesStream(res, model) {
  const originalWrite = res.write.bind(res);
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  let started = false;
  let sequence = 0;
  let fullText = '';
  const toolCallsByIndex = new Map();

  function writeEvent(event, data) {
    return originalWrite(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function makeResponse(status, output = []) {
    return {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output,
      parallel_tool_calls: true,
      tool_choice: 'auto',
    };
  }

  function getToolCallState(deltaToolCall, fallbackIndex) {
    const index = Number.isInteger(deltaToolCall.index) ? deltaToolCall.index : fallbackIndex;
    let state = toolCallsByIndex.get(index);
    if (!state) {
      state = {
        index,
        id: deltaToolCall.id || `call_${randomUUID()}`,
        name: '',
        arguments: '',
      };
      toolCallsByIndex.set(index, state);
    }

    if (deltaToolCall.id) state.id = deltaToolCall.id;
    const fn = deltaToolCall.function || {};
    if (fn.name) state.name = fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments.length > 0) state.arguments += fn.arguments;
    return state;
  }

  function start() {
    if (started) return;
    started = true;
    const response = makeResponse('in_progress');
    const item = { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    writeEvent('response.created', { type: 'response.created', response, sequence_number: sequence++ });
    writeEvent('response.in_progress', { type: 'response.in_progress', response, sequence_number: sequence++ });
    writeEvent('response.output_item.added', {
      type: 'response.output_item.added',
      item,
      output_index: 0,
      sequence_number: sequence++,
    });
    writeEvent('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
      sequence_number: sequence++,
    });
  }

  function finish() {
    start();
    writeEvent('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: fullText,
      sequence_number: sequence++,
    });
    writeEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: fullText, annotations: [] },
      sequence_number: sequence++,
    });
    const message = {
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    };
    writeEvent('response.output_item.done', {
      type: 'response.output_item.done',
      item: message,
      output_index: 0,
      sequence_number: sequence++,
    });

    const output = [message];
    const toolCalls = [...toolCallsByIndex.values()].sort((a, b) => a.index - b.index);
    for (const toolCall of toolCalls) {
      if (!toolCall.name) continue;
      const item = {
        id: toolCall.id,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments || '{}',
      };
      const outputIndex = output.length;
      writeEvent('response.output_item.added', {
        type: 'response.output_item.added',
        item,
        output_index: outputIndex,
        sequence_number: sequence++,
      });
      writeEvent('response.output_item.done', {
        type: 'response.output_item.done',
        item,
        output_index: outputIndex,
        sequence_number: sequence++,
      });
      output.push(item);
    }

    writeEvent('response.completed', {
      type: 'response.completed',
      response: makeResponse('completed', output),
      sequence_number: sequence++,
    });
  }

  res.write = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    const matches = [...text.matchAll(/^data:\s*(.+)$/gm)];
    if (matches.length === 0) return originalWrite(chunk);

    let wrote = false;
    for (const match of matches) {
      const data = match[1].trim();
      if (data === '[DONE]') {
        finish();
        wrote = true;
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          writeEvent('response.failed', {
            type: 'response.failed',
            response: { ...makeResponse('failed'), error: parsed.error },
            sequence_number: sequence++,
          });
          wrote = true;
          continue;
        }
        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (delta && delta.content) {
          start();
          fullText += delta.content;
          writeEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: delta.content,
            sequence_number: sequence++,
          });
          wrote = true;
        }

        if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          start();
          for (let idx = 0; idx < delta.tool_calls.length; idx += 1) {
            getToolCallState(delta.tool_calls[idx], idx);
          }
          wrote = true;
        }
      } catch {
        originalWrite(chunk);
        wrote = true;
      }
    }
    if (!wrote) {
      originalWrite(': keepalive\n\n');
    }
    return true;
  };
}

function createBodyRequest(req, payload) {
  const body = JSON.stringify(payload);
  const listeners = new Map();
  return {
    ...req,
    headers: req.headers,
    method: req.method,
    url: req.url,
    on(event, cb) {
      listeners.set(event, cb);
      if (event === 'data') process.nextTick(() => cb(Buffer.from(body)));
      if (event === 'end') process.nextTick(() => cb());
      return this;
    },
    destroy() {
      listeners.clear();
    },
  };
}

async function handleResponses(ctx, req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
  }

  const chatPayload = responsesToChatPayload(payload);
  const chatReq = createBodyRequest(req, chatPayload);

  if (!chatPayload.stream) {
    patchResponse(res, (chat) => chatToResponsesPayload(chat, payload.model));
  } else {
    patchResponsesStream(res, payload.model);
  }

  return handleChatCompletions(ctx, chatReq, res);
}

module.exports = {
  handleResponses,
  normalizeResponsesInput,
  responsesToChatPayload,
  chatToResponsesPayload,
};
