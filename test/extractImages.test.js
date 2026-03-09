'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractImages } = require('../src/images');

// Stub context — extractImages uses ctx.outputChannel for logging file read errors
const stubCtx = { outputChannel: null };

describe('extractImages', () => {
  // ── Data URLs ──
  it('extracts base64 data from data: URL', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 1);
    assert.equal(result[0].base64Data, 'iVBORw0KGgo=');
    assert.equal(result[0].mimeType, 'image/png');
  });

  it('handles jpeg data URL', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ==' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 1);
    assert.equal(result[0].mimeType, 'image/jpeg');
    assert.equal(result[0].base64Data, '/9j/4AAQ==');
  });

  it('handles webp data URL', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'data:image/webp;base64,UklGR=' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 1);
    assert.equal(result[0].mimeType, 'image/webp');
  });

  it('ignores malformed data URL without base64 marker', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png,rawdata' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 0);
  });

  // ── Remote URLs ──
  it('marks http:// URLs as remoteUrl for async fetch', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'http://example.com/image.png' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 1);
    assert.equal(result[0].remoteUrl, 'http://example.com/image.png');
    assert.equal(result[0].base64Data, undefined);
  });

  it('marks https:// URLs as remoteUrl for async fetch', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'https://cdn.example.com/photo.jpg' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 1);
    assert.equal(result[0].remoteUrl, 'https://cdn.example.com/photo.jpg');
  });

  // ── File URIs ──
  // Note: file:// reading actually reads from disk, so we test the branch detection
  // but the file won't exist — the function catches the error gracefully
  it('attempts to read file:/// URI and handles missing file gracefully', () => {
    const content = [
      {
        type: 'image_url',
        image_url: { url: 'file:///C:/nonexistent/image.png' },
      },
    ];
    // Should not throw — errors are caught internally
    const result = extractImages(stubCtx, content);
    // File doesn't exist, so no image should be returned
    assert.equal(result.length, 0);
  });

  // ── Empty / invalid inputs ──
  it('returns empty array for null content', () => {
    assert.deepEqual(extractImages(stubCtx, null), []);
  });

  it('returns empty array for undefined content', () => {
    assert.deepEqual(extractImages(stubCtx, undefined), []);
  });

  it('returns empty array for string content', () => {
    assert.deepEqual(extractImages(stubCtx, 'just a string'), []);
  });

  it('returns empty array for empty array', () => {
    assert.deepEqual(extractImages(stubCtx, []), []);
  });

  it('skips non-image_url parts', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'audio', audio: {} },
    ];
    assert.deepEqual(extractImages(stubCtx, content), []);
  });

  it('skips image_url parts without url property', () => {
    const content = [
      { type: 'image_url', image_url: {} },
      { type: 'image_url', image_url: null },
      { type: 'image_url' },
    ];
    assert.deepEqual(extractImages(stubCtx, content), []);
  });

  // ── Multiple images ──
  it('extracts multiple images from mixed content', () => {
    const content = [
      { type: 'text', text: 'Look at these:' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aaa=' },
      },
      {
        type: 'image_url',
        image_url: { url: 'https://example.com/b.jpg' },
      },
    ];
    const result = extractImages(stubCtx, content);
    assert.equal(result.length, 2);
    assert.equal(result[0].base64Data, 'aaa=');
    assert.equal(result[1].remoteUrl, 'https://example.com/b.jpg');
  });
});
