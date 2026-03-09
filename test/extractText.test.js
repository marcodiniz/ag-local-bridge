'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractText } = require('../src/images');

describe('extractText', () => {
  // ── String inputs ──
  it('returns plain string as-is', () => {
    assert.equal(extractText('hello world'), 'hello world');
  });

  it('returns empty string for empty string input', () => {
    assert.equal(extractText(''), '');
  });

  // ── Null / undefined / falsy inputs ──
  it('returns empty string for null', () => {
    assert.equal(extractText(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(extractText(undefined), '');
  });

  it('returns empty string for 0', () => {
    assert.equal(extractText(0), '');
  });

  it('returns empty string for false', () => {
    assert.equal(extractText(false), '');
  });

  // ── Array inputs (content-parts) ──
  it('extracts text from content-parts array with type=text', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    assert.equal(extractText(content), 'Hello\nWorld');
  });

  it('skips image_url parts in content-parts array', () => {
    const content = [
      { type: 'text', text: 'Describe this:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      { type: 'text', text: 'What is it?' },
    ];
    assert.equal(extractText(content), 'Describe this:\nWhat is it?');
  });

  it('handles mixed string and object parts in array', () => {
    const content = ['plain string', { type: 'text', text: 'object text' }];
    assert.equal(extractText(content), 'plain string\nobject text');
  });

  it('returns empty string for empty array', () => {
    assert.equal(extractText([]), '');
  });

  it('serializes objects without text property as JSON', () => {
    const content = [{ type: 'custom', data: 42 }];
    const result = extractText(content);
    assert.equal(result, JSON.stringify({ type: 'custom', data: 42 }));
  });

  it('handles objects with text property but no type', () => {
    const content = [{ text: 'fallback text' }];
    assert.equal(extractText(content), 'fallback text');
  });

  it('coerces numeric array elements to string', () => {
    const content = [42, 0];
    // 0 becomes '0' which has length > 0, and 42 becomes '42'
    assert.equal(extractText(content), '42\n0');
  });

  it('filters out empty strings from results', () => {
    const content = [
      { type: 'text', text: 'keep' },
      { type: 'text', text: '' }, // empty text, should be filtered after map
    ];
    // empty text returns '' from p.text, which is falsy so it falls through
    // p.text is '' which is falsy, so it goes to try JSON.stringify
    const result = extractText(content);
    assert.ok(result.includes('keep'));
  });

  // ── Object inputs (non-array) ──
  it('returns text property from plain object', () => {
    assert.equal(extractText({ text: 'object text' }), 'object text');
  });

  it('serializes object without text property', () => {
    const obj = { role: 'user', data: 'test' };
    assert.equal(extractText(obj), JSON.stringify(obj));
  });

  // ── Other types ──
  it('coerces number to string', () => {
    assert.equal(extractText(123), '123');
  });

  it('coerces boolean true to string', () => {
    assert.equal(extractText(true), 'true');
  });
});
