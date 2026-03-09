'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// Text Extraction
// ─────────────────────────────────────────────

/** Extract text from OpenAI message content (handles both string and content-parts array).
 *  Skips image_url parts — those are handled separately by extractImages(). */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => {
        // Skip image parts — they're handled by extractImages()
        if (p && typeof p === 'object' && p.type === 'image_url') return false;
        return true;
      })
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (p.type === 'text' && p.text) return p.text;
          if (p.text) return p.text;
          try {
            return JSON.stringify(p);
          } catch {
            return '';
          }
        }
        return String(p);
      })
      .filter((t) => t.length > 0)
      .join('\n');
  }
  if (typeof content === 'object') {
    if (content.text) return content.text;
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return String(content || '');
}

// ─────────────────────────────────────────────
// Image Extraction
// ─────────────────────────────────────────────

/**
 * Extract images from OpenAI message content-parts array.
 * Supports:
 *   - data:image/png;base64,... URLs (inline base64)
 *   - https://... URLs (fetched and converted to base64)
 *   - file:///... URIs (read from disk)
 *
 * Returns array of sidecar ImageData objects: { base64Data, mimeType }
 * (JSON field names use camelCase for ConnectRPC JSON mapping)
 */
function extractImages(ctx, content) {
  if (!content || !Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || part.type !== 'image_url') continue;
    const urlObj = part.image_url;
    if (!urlObj || !urlObj.url) continue;
    const url = urlObj.url;

    if (url.startsWith('data:')) {
      // data:image/png;base64,iVBOR...
      const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        images.push({ base64Data: match[2], mimeType: match[1] });
      }
    } else if (url.startsWith('file:///') || url.startsWith('file:\\\\\\\\')) {
      // Local file URI — read from disk
      try {
        const filePath = url.startsWith('file:///')
          ? url.slice(8).replace(/\//g, path.sep) // file:///C:/foo → C:\foo
          : url.slice(8);
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mimeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
        };
        images.push({ base64Data: data.toString('base64'), mimeType: mimeMap[ext] || 'image/png' });
      } catch (e) {
        if (ctx.outputChannel) ctx.outputChannel.appendLine(`⚠️ Failed to read image file: ${e.message}`);
      }
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // Remote URL — will be fetched asynchronously later
      images.push({ remoteUrl: url });
    }
  }
  return images;
}

/**
 * Extract all images from all messages in a conversation.
 * Returns array of ImageData objects ready for the sidecar.
 */
async function extractAllImages(ctx, messages) {
  const allImages = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const images = extractImages(ctx, msg.content);
    for (const img of images) {
      if (img.remoteUrl) {
        // Fetch remote image
        try {
          const fetched = await fetchImageAsBase64(img.remoteUrl);
          if (fetched) allImages.push(fetched);
        } catch (e) {
          if (ctx.outputChannel) ctx.outputChannel.appendLine(`⚠️ Failed to fetch remote image: ${e.message}`);
        }
      } else {
        allImages.push(img);
      }
    }
  }
  return allImages;
}

/**
 * Fetch a remote image URL and return as { base64Data, mimeType }.
 * Uses Node's built-in https/http modules.
 */
function fetchImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return fetchImageAsBase64(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/png';
        const mimeType = contentType.split(';')[0].trim();
        resolve({ base64Data: buf.toString('base64'), mimeType });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Image fetch timeout'));
    });
  });
}

module.exports = {
  extractText,
  extractImages,
  extractAllImages,
  fetchImageAsBase64,
};
