'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const MEDIA_PART_TYPES = new Set([
  'image_url',
  'input_image',
  'input_audio',
  'input_file',
  'audio_url',
  'video_url',
  'file_url',
]);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

function mimeFromPath(filePath, fallback = 'application/octet-stream') {
  return MIME_BY_EXT[path.extname(filePath || '').toLowerCase()] || fallback;
}

// ─────────────────────────────────────────────
// Text Extraction
// ─────────────────────────────────────────────

/** Extract text from OpenAI/Responses message content. Media parts are handled separately. */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => !(p && typeof p === 'object' && MEDIA_PART_TYPES.has(p.type)))
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && p.text) return p.text;
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
// Media Extraction
// ─────────────────────────────────────────────

function readFileUri(url) {
  if (url.startsWith('file:///')) return url.slice(8).replace(/\//g, path.sep);
  if (url.startsWith('file:\\\\')) return url.slice(8);
  return null;
}

function mediaFromDataUrl(url) {
  const match = String(url || '').match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { base64Data: match[2], mimeType: match[1] };
}

function mediaFromFile(ctx, filePath, mimeType) {
  try {
    const data = fs.readFileSync(filePath);
    return { base64Data: data.toString('base64'), mimeType: mimeType || mimeFromPath(filePath) };
  } catch (e) {
    if (ctx.outputChannel) ctx.outputChannel.appendLine(`⚠️ Failed to read media file: ${e.message}`);
    return null;
  }
}

function mediaRefFromUrl(url, mimeType) {
  if (!url) return null;
  const value = String(url);
  if (value.startsWith('data:')) return mediaFromDataUrl(value);
  const filePath = readFileUri(value);
  if (filePath) return { filePath, mimeType };
  if (value.startsWith('http://') || value.startsWith('https://')) return { remoteUrl: value, mimeType };
  return null;
}

function extractMediaPart(ctx, part) {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'image_url') {
    const ref = mediaRefFromUrl(part.image_url && part.image_url.url, part.mime_type);
    if (ref && ref.filePath) {
      return mediaFromFile(ctx, ref.filePath, ref.mimeType || mimeFromPath(ref.filePath, 'image/png'));
    }
    return ref;
  }

  if (part.type === 'input_image') {
    const ref = mediaRefFromUrl(part.image_url || part.url || part.file_url, part.mime_type);
    if (ref && ref.filePath) {
      return mediaFromFile(ctx, ref.filePath, ref.mimeType || mimeFromPath(ref.filePath, 'image/png'));
    }
    return ref;
  }

  if (part.type === 'input_audio') {
    if (part.input_audio && part.input_audio.data) {
      const format = part.input_audio.format || 'wav';
      return {
        base64Data: part.input_audio.data,
        mimeType: part.mime_type || MIME_BY_EXT[`.${format}`] || `audio/${format}`,
      };
    }
    if (part.data) {
      const format = part.format || 'wav';
      return { base64Data: part.data, mimeType: part.mime_type || MIME_BY_EXT[`.${format}`] || `audio/${format}` };
    }
    const ref = mediaRefFromUrl(part.audio_url || part.url || part.file_url, part.mime_type);
    if (ref && ref.filePath) {
      return mediaFromFile(ctx, ref.filePath, ref.mimeType || mimeFromPath(ref.filePath, 'audio/mpeg'));
    }
    return ref;
  }

  if (part.type === 'input_file') {
    if (part.file_data) {
      const parsed = mediaFromDataUrl(part.file_data);
      if (parsed) return parsed;
      return { base64Data: part.file_data, mimeType: part.mime_type || mimeFromPath(part.filename) };
    }
    const ref = mediaRefFromUrl(part.file_url || part.url, part.mime_type || mimeFromPath(part.filename));
    if (ref && ref.filePath) return mediaFromFile(ctx, ref.filePath, ref.mimeType);
    return ref;
  }

  if (part.type === 'audio_url' || part.type === 'video_url' || part.type === 'file_url') {
    const url = part.url || (part[part.type] && part[part.type].url);
    const ref = mediaRefFromUrl(url, part.mime_type);
    if (ref && ref.filePath) return mediaFromFile(ctx, ref.filePath, ref.mimeType || mimeFromPath(ref.filePath));
    return ref;
  }

  return null;
}

function extractMedia(ctx, content) {
  if (!content || !Array.isArray(content)) return [];
  const media = [];
  for (const part of content) {
    const item = extractMediaPart(ctx, part);
    if (item) media.push(item);
  }
  return media;
}

function extractImages(ctx, content) {
  return extractMedia(ctx, content).filter(
    (item) => item.remoteUrl || item.filePath || String(item.mimeType || '').startsWith('image/'),
  );
}

async function extractAllMedia(ctx, messages) {
  const allMedia = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const media = extractMedia(ctx, msg.content);
    for (const item of media) {
      if (item.remoteUrl) {
        try {
          const fetched = await fetchMediaAsBase64(item.remoteUrl, item.mimeType);
          if (fetched) allMedia.push(fetched);
        } catch (e) {
          if (ctx.outputChannel) ctx.outputChannel.appendLine(`⚠️ Failed to fetch remote media: ${e.message}`);
        }
      } else {
        allMedia.push(item);
      }
    }
  }
  return allMedia;
}

async function extractAllImages(ctx, messages) {
  const media = await extractAllMedia(ctx, messages);
  return media.filter((item) => String(item.mimeType || '').startsWith('image/'));
}

function fetchMediaAsBase64(url, fallbackMimeType) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchMediaAsBase64(res.headers.location, fallbackMimeType).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching media`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || fallbackMimeType || 'application/octet-stream';
        const mimeType = contentType.split(';')[0].trim();
        resolve({ base64Data: buf.toString('base64'), mimeType });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Media fetch timeout'));
    });
  });
}

function fetchImageAsBase64(url) {
  return fetchMediaAsBase64(url, 'image/png');
}

module.exports = {
  extractText,
  extractMedia,
  extractAllMedia,
  extractImages,
  extractAllImages,
  fetchMediaAsBase64,
  fetchImageAsBase64,
};
