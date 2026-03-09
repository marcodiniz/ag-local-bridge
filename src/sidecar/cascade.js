'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('../utils');
const { extractText } = require('../images');
const { discoverSidecar } = require('./discovery');
const { makeH2JsonCall, makeH2StreamingCall } = require('./rpc');

// ─────────────────────────────────────────────
// Cascade Conversations
// StartCascade → SendUserCascadeMessage → poll GetCascadeTrajectory
// ─────────────────────────────────────────────

function getConversationKey(messages, workspaceDir) {
  const userMsgs = messages.filter((m) => m.role === 'user').map((m) => extractText(m.content));
  const prefix = workspaceDir ? path.basename(workspaceDir) : 'default';
  if (userMsgs.length === 0) return `${prefix}_system_${Date.now()}`;
  return `${prefix}_${String(userMsgs[0]).substring(0, 50)}`;
}

async function callSidecarChat(
  ctx,
  messages,
  modelValue = 1035,
  workspaceDir = null,
  workspaceUri = null,
  images = [],
) {
  const info = await discoverSidecar(ctx);
  if (!info) throw new Error('Sidecar not discovered');

  let userMessage = messages
    .filter((m) => m.role === 'user')
    .map((m) => extractText(m.content))
    .join('\n');
  const mainCsrf = info.csrfTokens[0];
  const flog = (msg) => {
    log(ctx, msg);
    try {
      fs.appendFileSync(path.join(os.tmpdir(), 'ag-bridge-debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };

  // Save images to temp files so the agent can view them with its tools
  const savedImagePaths = [];
  if (images && images.length > 0) {
    const tmpDir = path.join(os.tmpdir(), 'ag-bridge-images');
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch {}
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img.base64Data) continue;
      const ext = (img.mimeType || 'image/png').split('/')[1] || 'png';
      const fileName = `bridge_image_${Date.now()}_${i}.${ext}`;
      const filePath = path.join(tmpDir, fileName);
      try {
        fs.writeFileSync(filePath, Buffer.from(img.base64Data, 'base64'));
        savedImagePaths.push(filePath);
        flog(`  🖼️ Saved image ${i + 1} to: ${filePath}`);
      } catch (e) {
        flog(`  ⚠️ Failed to save image: ${e.message}`);
      }
    }
    // Prepend image references to the user message so the agent knows to look at them
    if (savedImagePaths.length > 0) {
      const imageRefs = savedImagePaths.map((p, i) => `[Attached Image ${i + 1}]: ${p.replace(/\\/g, '/')}`).join('\n');
      userMessage = `${imageRefs}\n\n${userMessage}`;
      flog(`  🖼️ Prepended ${savedImagePaths.length} image path(s) to message`);
    }
  }

  // Find a working LS port
  const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
  let lsPort = null;
  for (const port of lsPorts) {
    try {
      await makeH2JsonCall(port, mainCsrf, info.certPath, 'GetStatus', {});
      lsPort = port;
      break;
    } catch (e) {
      flog(`  port ${port} failed: ${e.message.substring(0, 40)}`);
    }
  }
  if (!lsPort) throw new Error('No reachable LS port');

  const convKey = getConversationKey(messages, workspaceDir);
  let cascadeId = null;

  // Retry loop: start fresh cascade on each attempt (capacity errors leave error steps)
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 10000;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      flog(`  ⏳ Retry ${attempt + 1}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s backoff...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    // --- CONVERSATION MULTIPLEXING ---
    if (ctx.cascadePromises.has(convKey)) {
      flog(`  ♻️ Awaiting concurrent cascade creation for conv: ${convKey.replace(/\n/g, '')}...`);
      cascadeId = await ctx.cascadePromises.get(convKey);
      flog(`  ♻️ Concurrently Reused cascade: ${cascadeId.substring(0, 8)}`);
    } else if (
      ctx.activeCascades.has(convKey) &&
      Date.now() - ctx.activeCascades.get(convKey).lastUsed < 1000 * 60 * 60 * 4
    ) {
      cascadeId = ctx.activeCascades.get(convKey).id;
      ctx.activeCascades.get(convKey).lastUsed = Date.now();
      flog(`  ♻️ Reused existing conversation: ${cascadeId.substring(0, 8)}`);
    } else {
      // Must create a new Cascade. Lock the workspace globally to prevent race conditions across parallel conversations!
      const promise = (async () => {
        while (ctx.isWorkspaceSwitching) await new Promise((r) => setTimeout(r, 100));
        ctx.isWorkspaceSwitching = true;
        try {
          let originalFolders = null;
          if (workspaceDir) {
            const targetUri = vscode.Uri.file(workspaceDir);
            const currentFolders = vscode.workspace.workspaceFolders || [];
            const currentFsPaths = currentFolders.map((f) => f.uri.fsPath);

            // Strict match ensures we drop "playground" if it's open alongside the target
            const isStrictMatch = currentFsPaths.length === 1 && currentFsPaths[0] === workspaceDir;

            if (!isStrictMatch) {
              originalFolders = currentFolders.map((f) => ({ uri: f.uri, name: f.name }));
              const success = vscode.workspace.updateWorkspaceFolders(0, currentFolders.length, {
                uri: targetUri,
                name: path.basename(workspaceDir),
              });
              if (success) {
                flog(`  📂 Switched workspace strictly to: ${workspaceDir}`);
                await new Promise((r) => setTimeout(r, 1000)); // Crucial LSP propagation delay
              } else {
                flog(`  ⚠️ updateWorkspaceFolders failed`);
                originalFolders = null;
              }
            } else {
              flog(`  📂 Workspace already exclusively correct: ${workspaceDir}`);
            }
          }

          const startPayload = {};
          if (workspaceUri) {
            startPayload.workspacePaths = [workspaceUri];
            startPayload.workspaceRootPath = workspaceDir;
          }
          const startResult = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'StartCascade', startPayload);
          const newId = startResult && startResult.cascadeId;

          if (originalFolders && originalFolders.length > 0) {
            const current = vscode.workspace.workspaceFolders || [];
            vscode.workspace.updateWorkspaceFolders(0, current.length, ...originalFolders);
            flog(`  ♻️ Restored ${originalFolders.length} workspace folders`);
          }

          if (!newId) throw new Error('StartCascade failed to return cascadeId');
          return newId;
        } finally {
          ctx.isWorkspaceSwitching = false;
        }
      })();

      ctx.cascadePromises.set(convKey, promise);
      try {
        cascadeId = await promise;
        ctx.activeCascades.set(convKey, { id: cascadeId, lastUsed: Date.now() });
        flog(`  🆕 New Cascade created: ${cascadeId.substring(0, 8)} (attempt ${attempt + 1})`);
      } catch (err) {
        ctx.cascadePromises.delete(convKey);
        throw err;
      } finally {
        ctx.cascadePromises.delete(convKey);
      }
    }

    // Send message
    const conversationalConfig = {};
    if (workspaceUri) {
      conversationalConfig.overrideWorkspaceDirExperimentalUseOnly = workspaceUri;
    }
    const sendPayload = {
      cascadeId,
      items: [{ text: userMessage }],
      cascadeConfig: {
        plannerConfig: {
          plannerTypeConfig: { conversational: conversationalConfig },
          requestedModel: { model: modelValue },
        },
      },
    };
    // NOTE: images are handled via temp files — paths are prepended to userMessage above.
    // The proto `images`/`media` fields cause HTTP 400 unmarshal errors, so we don't send them.
    if (images && images.length > 0) {
      flog(`  🖼️ ${images.length} image(s) referenced as temp file paths in message text`);
    }
    // Also add workspace paths at top level using file URI format
    if (workspaceUri) {
      sendPayload.workspacePaths = [workspaceUri];
      sendPayload.workspacePathsMigrateMeToUris = [workspaceUri];
    }
    try {
      await makeH2StreamingCall(lsPort, mainCsrf, info.certPath, 'SendUserCascadeMessage', sendPayload);
      flog(`  ✅ SendUserCascadeMessage dispatched (attempt ${attempt + 1})`);
      flog(`  📦 Payload: ${JSON.stringify(sendPayload).substring(0, 1000)}`);
    } catch (e) {
      flog(`  ⚠️ SendUserCascadeMessage failed: ${e.message.substring(0, 60)}`);
      ctx.activeCascades.delete(convKey);
      continue; // retry with fresh cascade
    }

    // Poll trajectory until PLANNER_RESPONSE + IDLE
    const pollStart = Date.now();
    const maxWait = 60000;
    let shouldRetry = false;
    while (Date.now() - pollStart < maxWait) {
      await new Promise((r) => setTimeout(r, 1500));
      const elapsed = Math.round((Date.now() - pollStart) / 1000);
      try {
        const traj = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'GetCascadeTrajectory', { cascadeId });
        const steps = (traj && traj.trajectory && traj.trajectory.steps) || [];
        const status = traj && traj.status;
        flog(`  [poll ${elapsed}s] steps=${steps.length} status=${status}`);

        if (steps.length > 0 && status === 'CASCADE_RUN_STATUS_IDLE') {
          // Look for response text in PLANNER_RESPONSE steps
          for (const step of [...steps].reverse()) {
            if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
            const pr = step.plannerResponse;
            if (!pr) continue;
            const text = pr.modifiedResponse || pr.response || pr.content || pr.thinking;
            if (text && text.trim().length >= 3) {
              flog(`✅ Response ready (${text.length} chars, attempt ${attempt + 1})`);
              return text.trim();
            }
          }
          // Check for capacity error → retry with fresh cascade
          if (
            steps.some(
              (s) =>
                s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' &&
                JSON.stringify(s.errorMessage || '')
                  .toLowerCase()
                  .includes('capacity'),
            )
          ) {
            flog(`  ⚠️ Capacity error (attempt ${attempt + 1}), will retry...`);
            ctx.activeCascades.delete(convKey);
            shouldRetry = true;
          } else {
            flog(`  ⚠️ IDLE with no PLANNER_RESPONSE after ${elapsed}s`);
            ctx.activeCascades.delete(convKey);
            shouldRetry = false; // Fail fast to Tier 2 instead of spamming duplicates
          }
          break;
        }
      } catch (e) {
        flog(`  [poll error] ${e.message.substring(0, 80)}`);
      }
    }
    if (!shouldRetry) break;
  }
  throw new Error(`Cascade failed after ${MAX_RETRIES} attempts (model capacity exhausted)`);
}

module.exports = { getConversationKey, callSidecarChat };
