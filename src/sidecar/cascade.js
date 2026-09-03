'use strict';

const path = require('path');
const { log, verboseLog } = require('../utils');
const { extractText } = require('../images');
const { discoverSidecar } = require('./discovery');
const { makeH2JsonCall, makeH2ProtoCall, makeH2ProtoStreamingCall } = require('./rpc');
const { encodeProto, decodeProto } = require('./proto');

// ─────────────────────────────────────────────
// Proto-compatible Metadata builder
// Matches exa.codeium_common_pb.Metadata
// ─────────────────────────────────────────────

function buildMetadata(ctx) {
  return {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    extensionVersion: '0.2.0',
    os: process.platform,
    sessionId: ctx.sessionId || '',
  };
}

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

/**
 * Delete a Cascade trajectory from the sidecar DB to prevent polluting the IDE's "Past Conversations".
 */
async function deleteCascadeTrajectory(ctx, cascadeId) {
  if (!cascadeId) return;
  try {
    const info = await discoverSidecar(ctx);
    if (!info) return;
    const mainCsrf = info.csrfTokens[0];
    const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
    for (const port of lsPorts) {
      try {
        await makeH2JsonCall(port, mainCsrf, info.certPath, 'DeleteCascadeTrajectory', { cascadeId });
        verboseLog(ctx, `🗑️ Cascade trajectory purged: ${cascadeId.substring(0, 8)}`);
        break;
      } catch (e) {
        verboseLog(ctx, `  DeleteCascadeTrajectory on port ${port} failed: ${e.message}`);
      }
    }
  } catch (err) {
    verboseLog(ctx, `⚠️ Failed to delete cascade trajectory ${cascadeId}: ${err.message}`);
  }
}

async function dispatchCascadeMessage(
  ctx,
  messages,
  modelValue = 1035,
  workspaceDir = null,
  workspaceUri = null,
  images = [],
) {
  const info = await discoverSidecar(ctx);
  if (!info) throw new Error('Sidecar not discovered');

  const userMessage = messages
    .filter((m) => m.role === 'user')
    .map((m) => extractText(m.content))
    .join('\n');
  const mainCsrf = info.csrfTokens[0];
  const vlog = (msg) => verboseLog(ctx, msg);

  // Find a working LS port
  const lsPorts = info.actualPorts.filter((p) => p !== info.extensionServerPort);
  let lsPort = null;
  for (const port of lsPorts) {
    try {
      await makeH2JsonCall(port, mainCsrf, info.certPath, 'GetStatus', {});
      lsPort = port;
      break;
    } catch (e) {
      vlog(`  port ${port} failed: ${e.message.substring(0, 40)}`);
    }
  }
  if (!lsPort) throw new Error('No reachable LS port');

  const convKey = getConversationKey(messages, workspaceDir);
  let cascadeId = null;

  if (ctx.cascadePromises && ctx.cascadePromises.has(convKey)) {
    vlog(`  ♻️ Awaiting concurrent cascade creation for conv: ${convKey.replace(/\n/g, '')}...`);
    cascadeId = await ctx.cascadePromises.get(convKey);
    vlog(`  ♻️ Concurrently Reused cascade: ${cascadeId.substring(0, 8)}`);
  } else if (
    ctx.activeCascades &&
    ctx.activeCascades.has(convKey) &&
    Date.now() - ctx.activeCascades.get(convKey).lastUsed < 1000 * 60 * 60 * 4
  ) {
    cascadeId = ctx.activeCascades.get(convKey).id;
    ctx.activeCascades.get(convKey).lastUsed = Date.now();
    vlog(`  ♻️ Reused existing conversation: ${cascadeId.substring(0, 8)}`);
  } else {
    const promise = (async () => {
      const startPayload = {
        metadata: buildMetadata(ctx),
        source: 18, // CORTEX_TRAJECTORY_SOURCE_AGENT_API (prevents indexing into IDE Past Conversations)
      };
      if (workspaceUri) {
        startPayload.workspaceUris = [workspaceUri];
      }
      const startBytes = encodeProto('exa.language_server_pb.StartCascadeRequest', startPayload);
      const respBytes = await makeH2ProtoCall(lsPort, mainCsrf, info.certPath, 'StartCascade', startBytes);
      const startResult = decodeProto('exa.language_server_pb.StartCascadeResponse', respBytes);
      const newId = startResult && startResult.cascadeId;

      if (!newId) throw new Error('StartCascade failed to return cascadeId');
      return newId;
    })();

    if (ctx.cascadePromises) ctx.cascadePromises.set(convKey, promise);
    try {
      cascadeId = await promise;
      if (ctx.activeCascades) ctx.activeCascades.set(convKey, { id: cascadeId, lastUsed: Date.now() });
      log(ctx, `  🆕 New Cascade created: ${cascadeId.substring(0, 8)}`);
    } catch (err) {
      if (ctx.cascadePromises) ctx.cascadePromises.delete(convKey);
      throw err;
    } finally {
      if (ctx.cascadePromises) ctx.cascadePromises.delete(convKey);
    }
  }

  // Send message
  const conversationalConfig = { agenticMode: false };
  if (workspaceUri) {
    conversationalConfig.overrideWorkspaceDirExperimentalUseOnly = workspaceUri;
  }
  const sendPayload = {
    cascadeId,
    items: [{ text: userMessage }],
    metadata: buildMetadata(ctx),
    clientType: 0, // CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_UNSPECIFIED
    messageOrigin: 0, // AGENT_MESSAGE_ORIGIN_UNSPECIFIED
    cascadeConfig: {
      plannerConfig: {
        conversational: conversationalConfig,
        requestedModel: { model: modelValue },
      },
    },
  };
  // Inject images via the `media` field (field 14) with raw bytes.
  // The `images` field (field 6) is deprecated and silently ignored by the sidecar.
  if (images && images.length > 0) {
    sendPayload.media = images.map((img) => ({
      mimeType: img.mimeType || 'image/png',
      inlineData: new Uint8Array(Buffer.from(img.base64Data, 'base64')),
    }));
    vlog(`  🖼️ Injected ${images.length} image(s) via media field into payload`);
  }

  const sendBytes = encodeProto('exa.language_server_pb.SendUserCascadeMessageRequest', sendPayload);
  await makeH2ProtoStreamingCall(lsPort, mainCsrf, info.certPath, 'SendUserCascadeMessage', sendBytes);
  log(ctx, `  ✅ SendUserCascadeMessage dispatched`);
  vlog(`  📦 Payload: ${JSON.stringify(sendPayload).substring(0, 1000)}`);

  return { info, lsPort, mainCsrf, cascadeId, convKey };
}

async function callSidecarChat(
  ctx,
  messages,
  modelValue = 1035,
  workspaceDir = null,
  workspaceUri = null,
  images = [],
) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let lastUpstreamError = null;
  let session = null;

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log(ctx, `  ⏳ Retry ${attempt + 1}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s backoff...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      try {
        session = await dispatchCascadeMessage(ctx, messages, modelValue, workspaceDir, workspaceUri, images);
      } catch (e) {
        log(ctx, `  ⚠️ SendUserCascadeMessage failed: ${e.message.substring(0, 60)}`);
        const convKey = getConversationKey(messages, workspaceDir);
        if (ctx.activeCascades) ctx.activeCascades.delete(convKey);
        continue;
      }

      const { info, lsPort, mainCsrf, cascadeId, convKey } = session;
      const vlog = (msg) => verboseLog(ctx, msg);

      // Poll trajectory until PLANNER_RESPONSE + IDLE
      const pollStart = Date.now();
      const maxWait = 300000; // Wait up to 5 minutes
      let shouldRetry = false;

      while (Date.now() - pollStart < maxWait) {
        const elapsedMs = Date.now() - pollStart;
        const pollDelay = elapsedMs < 10000 ? ctx.CASCADE_POLL_INTERVAL_MS || 350 : 1000;
        await new Promise((r) => setTimeout(r, pollDelay));
        const elapsed = Math.round((Date.now() - pollStart) / 1000);

        try {
          const traj = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'GetCascadeTrajectory', { cascadeId });
          const steps = (traj && traj.trajectory && traj.trajectory.steps) || [];
          const status = traj && traj.status;
          vlog(`  [poll ${elapsed}s] steps=${steps.length} status=${status}`);

          if (steps.length > 0 && status === 'CASCADE_RUN_STATUS_IDLE') {
            // Look for response text in PLANNER_RESPONSE steps
            for (const step of [...steps].reverse()) {
              if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
              const pr = step.plannerResponse;
              if (!pr) continue;
              const text = pr.modifiedResponse || pr.response || pr.content;
              if (text && text.trim().length >= 1) {
                log(ctx, `✅ Response ready (${text.length} chars, attempt ${attempt + 1})`);
                return text.trim();
              }
            }

            // Check for capacity or other upstream errors
            let hasCapacityError = false;
            let upstreamError = null;
            for (const s of steps) {
              if (s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
                const msg = s.errorMessage ? s.errorMessage.message || JSON.stringify(s.errorMessage) : '';
                if (msg.toLowerCase().includes('capacity')) {
                  hasCapacityError = true;
                }
                upstreamError = msg;
              }
            }

            if (hasCapacityError) {
              log(ctx, `  🛑 Capacity error (attempt ${attempt + 1}), failing fast`);
              if (ctx.activeCascades) ctx.activeCascades.delete(convKey);
              shouldRetry = false;
            } else if (upstreamError) {
              log(ctx, `  🛑 Upstream error: ${upstreamError}`);
              if (ctx.activeCascades) ctx.activeCascades.delete(convKey);
              lastUpstreamError = upstreamError;
              verboseLog(
                ctx,
                `GetCascadeTrajectory full trajectory on upstream failure: ${JSON.stringify(traj, null, 2)}`,
              );
              shouldRetry = false;
            } else {
              log(ctx, `  ⚠️ IDLE with no PLANNER_RESPONSE after ${elapsed}s`);
              if (ctx.activeCascades) ctx.activeCascades.delete(convKey);
              shouldRetry = false;
            }
            break;
          }
        } catch (e) {
          vlog(`  [poll error] ${e.message.substring(0, 80)}`);
        }
      }
      if (!shouldRetry) break;
    }

    if (lastUpstreamError) {
      throw new Error(`Cascade failed: Cascade upstream error: ${lastUpstreamError}`);
    }
    throw new Error(`Cascade failed after ${MAX_RETRIES} attempts (model capacity exhausted)`);
  } finally {
    if (session && session.cascadeId) {
      deleteCascadeTrajectory(ctx, session.cascadeId).catch(() => {});
    }
  }
}

/**
 * Async generator that yields text deltas and reasoning from Cascade trajectory polling for low TTFB streaming.
 */
async function* callSidecarChatStream(
  ctx,
  messages,
  modelValue = 1035,
  workspaceDir = null,
  workspaceUri = null,
  images = [],
) {
  let session = null;
  try {
    session = await dispatchCascadeMessage(ctx, messages, modelValue, workspaceDir, workspaceUri, images);
    const { info, lsPort, mainCsrf, cascadeId, convKey } = session;
    const vlog = (msg) => verboseLog(ctx, msg);

    const pollStart = Date.now();
    const maxWait = 300000;
    let emittedContentLength = 0;
    let emittedThinkingLength = 0;

    while (Date.now() - pollStart < maxWait) {
      const elapsedMs = Date.now() - pollStart;
      const pollDelay = elapsedMs < 10000 ? ctx.CASCADE_POLL_INTERVAL_MS || 250 : 500;
      await new Promise((r) => setTimeout(r, pollDelay));
      const elapsed = Math.round((Date.now() - pollStart) / 1000);

      try {
        const traj = await makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'GetCascadeTrajectory', { cascadeId });
        const steps = (traj && traj.trajectory && traj.trajectory.steps) || [];
        const status = traj && traj.status;
        vlog(`  [stream poll ${elapsed}s] steps=${steps.length} status=${status}`);

        // Check current planner response steps and yield deltas
        for (const step of [...steps].reverse()) {
          if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
          const pr = step.plannerResponse;
          if (!pr) continue;

          const thinking = pr.thinking || '';
          const response = pr.modifiedResponse || pr.response || pr.content || '';

          if (thinking && thinking.length > emittedThinkingLength) {
            const reasoningDelta = thinking.substring(emittedThinkingLength);
            emittedThinkingLength = thinking.length;
            yield { delta: null, reasoning: reasoningDelta };
          }

          if (response && response.length > emittedContentLength) {
            const contentDelta = response.substring(emittedContentLength);
            emittedContentLength = response.length;
            yield { delta: contentDelta, reasoning: null };
          }
          break; // only process the latest planner response step
        }

        if (steps.length > 0 && status === 'CASCADE_RUN_STATUS_IDLE') {
          // Yield any remaining delta on completion
          for (const step of [...steps].reverse()) {
            if (step.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
            const pr = step.plannerResponse;
            if (!pr) continue;

            const thinking = pr.thinking || '';
            const response = pr.modifiedResponse || pr.response || pr.content || '';

            if (thinking && thinking.length > emittedThinkingLength) {
              const reasoningDelta = thinking.substring(emittedThinkingLength);
              emittedThinkingLength = thinking.length;
              yield { delta: null, reasoning: reasoningDelta };
            }

            if (response && response.length > emittedContentLength) {
              const contentDelta = response.substring(emittedContentLength);
              emittedContentLength = response.length;
              yield { delta: contentDelta, reasoning: null };
            }
            break;
          }

          // Check for capacity or upstream error
          let hasCapacityError = false;
          let upstreamError = null;
          for (const s of steps) {
            if (s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
              const msg = s.errorMessage ? s.errorMessage.message || JSON.stringify(s.errorMessage) : '';
              if (msg.toLowerCase().includes('capacity')) {
                hasCapacityError = true;
              }
              upstreamError = msg;
            }
          }

          if (hasCapacityError) {
            if (ctx.activeCascades) ctx.activeCascades.delete(convKey);
            throw new Error('Cascade capacity exhausted');
          } else if (upstreamError) {
            if (ctx.activeCascades) ctx.activeCascades.delete(convKey);
            throw new Error(`Cascade upstream error: ${upstreamError}`);
          }

          return;
        }
      } catch (e) {
        vlog(`  [stream poll error] ${e.message.substring(0, 80)}`);
        if (e.message.includes('Cascade')) throw e;
      }
    }

    throw new Error('Cascade stream timed out after 5 minutes');
  } finally {
    if (session && session.cascadeId) {
      deleteCascadeTrajectory(ctx, session.cascadeId).catch(() => {});
    }
  }
}

module.exports = { getConversationKey, callSidecarChat, callSidecarChatStream, deleteCascadeTrajectory };
