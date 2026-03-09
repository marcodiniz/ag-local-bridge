'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { log } = require('./utils');
const { extractText } = require('./images');

// ─────────────────────────────────────────────
// Workspace Detection
// Resolves the workspace directory from the request
// payload, headers, or VS Code workspace folders.
// ─────────────────────────────────────────────

/**
 * Resolve the workspace directory and file URI from the request context.
 *
 * Priority: request body > header > message content heuristics > VS Code workspace
 *
 * @param {object} ctx - Shared context
 * @param {object[]} messages - OpenAI-format messages array
 * @param {object} payload - Parsed request body
 * @param {object} req - HTTP request (for headers)
 * @returns {{ workspaceDir: string|null, workspaceUri: string|null }}
 */
function resolveWorkspace(ctx, messages, payload, req) {
  let workspaceDir = payload.workspace_dir || req.headers['x-workspace-dir'] || null;

  if (!workspaceDir) {
    try {
      // Combine system and user text for keyword/path scanning
      const sysMsgs = messages
        .filter((m) => m.role === 'system')
        .map((m) => extractText(m.content))
        .join('\n');
      const usrMsgs = messages
        .filter((m) => m.role === 'user')
        .map((m) => extractText(m.content))
        .join('\n');
      const allText = sysMsgs + '\n' + usrMsgs;

      // 1. Look for explicit directory mentions from OpenCode/Cursor system prompt
      const explicitMatch = allText.match(
        /(?:working in.*?directory|current workspace|workspace directory).*?([a-zA-Z]:\\[^\s"'>]+)/i,
      );
      if (explicitMatch) {
        const candidate = explicitMatch[1].trim();
        if (fs.existsSync(candidate)) {
          workspaceDir = candidate;
        }
      }

      // 2. Look for .sln absolute paths (common in C# projects if passed in prompt)
      if (!workspaceDir) {
        const slnMatch = allText.match(/([a-zA-Z]:\\[^\s"'>]+\.sln)/i);
        if (slnMatch && fs.existsSync(slnMatch[1])) {
          workspaceDir = path.dirname(slnMatch[1]);
        }
      }

      // 3. Fallback: Score sibling directories by mentions in the text
      if (!workspaceDir) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0 && folders[0].uri.scheme === 'file') {
          const currentRoot = folders[0].uri.fsPath;
          const parentDir = path.dirname(currentRoot);
          if (fs.existsSync(parentDir)) {
            const siblings = fs
              .readdirSync(parentDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => ({ path: path.join(parentDir, d.name), name: d.name }));

            let bestMatch = null;
            let bestScore = 0;
            for (const { path: p, name } of siblings) {
              if (name.length < 4) continue; // Ignore very short directory names

              // Only match whole words, case-insensitive
              const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const score = (allText.match(new RegExp(`\\b${escapedName}\\b`, 'gi')) || []).length;
              if (score > bestScore) {
                bestScore = score;
                bestMatch = p;
              }
            }
            if (bestMatch && bestScore > 0) {
              workspaceDir = bestMatch;
              log(ctx, `📂 Guessed workspace from prompt keywords: ${workspaceDir}`);
            }
          }
        }
      }
    } catch (e) {
      log(ctx, `⚠️ Workspace auto-detect failed: ${e.message}`);
    }
  }

  if (!workspaceDir) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0 && folders[0].uri.scheme === 'file') {
      workspaceDir = folders[0].uri.fsPath;
    }
  }

  // Convert to file:/// URI format (what the sidecar expects)
  let workspaceUri = null;
  if (workspaceDir) {
    workspaceUri = 'file:///' + workspaceDir.replace(/\\/g, '/');
    log(ctx, `📂 Workspace: ${workspaceDir} -> ${workspaceUri}`);
  } else {
    log(ctx, `⚠️ No workspace dir resolved — Antigravity may pick a random project`);
  }

  return { workspaceDir, workspaceUri };
}

module.exports = { resolveWorkspace };
