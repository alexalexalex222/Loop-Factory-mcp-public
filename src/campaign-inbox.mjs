import { join } from 'node:path';
import { sha256 } from './util.mjs';

export const CAMPAIGN_TARGET_INBOX = 'inbox-targets.json';
export const DEFAULT_IDLE_POLL_MS = 1000;
const MAX_IDLE_POLL_MS = 60_000;
const MAX_INBOX_TARGETS = 100;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function archiveStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function normalizeCampaignIdlePollMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_POLL_MS;
  return Math.min(MAX_IDLE_POLL_MS, Math.max(250, Math.floor(parsed)));
}

function normalizeTarget(target, index) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return { ok: false, reason: `targets[${index}] must be an object` };
  }
  if (!['mine', 'improve'].includes(target.kind)) {
    return { ok: false, reason: `targets[${index}].kind must be "mine" or "improve"` };
  }
  if (target.routes != null && (
    !Array.isArray(target.routes)
    || target.routes.length === 0
    || target.routes.some((route) => typeof route !== 'string' || !route.trim())
  )) {
    return { ok: false, reason: `targets[${index}].routes must be a non-empty string array when provided` };
  }
  if (target.benchmark != null && (
    !target.benchmark
    || typeof target.benchmark !== 'object'
    || Array.isArray(target.benchmark)
  )) {
    return { ok: false, reason: `targets[${index}].benchmark must be an object when provided` };
  }
  if (target.kind === 'improve'
    && !String(target.loop || '').trim()
    && !String(target.baselineContent || '').trim()) {
    return { ok: false, reason: `targets[${index}] improve work needs loop or baselineContent` };
  }
  return { ok: true, target: JSON.parse(JSON.stringify(target)) };
}

export function validateCampaignTargetInbox(payload, runId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'target inbox payload must be an object' };
  }
  if (payload.runId != null && payload.runId !== runId) {
    return { ok: false, reason: `target inbox runId "${payload.runId}" does not match "${runId}"` };
  }
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
    return { ok: false, reason: 'target inbox must contain at least one target' };
  }
  if (payload.targets.length > MAX_INBOX_TARGETS) {
    return { ok: false, reason: `target inbox exceeds the ${MAX_INBOX_TARGETS}-target safety limit` };
  }
  const targets = [];
  for (let index = 0; index < payload.targets.length; index++) {
    const checked = normalizeTarget(payload.targets[index], index);
    if (!checked.ok) return checked;
    targets.push(checked.target);
  }
  return { ok: true, targets };
}

export function campaignTargetInboxPath(store, runId) {
  return join(store.runDir(runId), CAMPAIGN_TARGET_INBOX);
}

function defaultSleep(ms) {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}

export function createCampaignIdleWait({
  store,
  runId,
  pollMs = DEFAULT_IDLE_POLL_MS,
  log = () => {},
  sleep = defaultSleep
}) {
  const delayMs = normalizeCampaignIdlePollMs(pollMs);

  const consume = () => {
    const raw = store.readRunFile(runId, CAMPAIGN_TARGET_INBOX);
    if (raw == null) return null;
    const sourceSha256 = sha256(raw);
    const stamp = archiveStamp();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      const archivedAs = `inbox-targets.invalid-${stamp}.json`;
      store.moveRunFile(runId, CAMPAIGN_TARGET_INBOX, archivedAs);
      log(`target_inbox_rejected invalid JSON (${error.message}); archived as ${archivedAs}`);
      return null;
    }
    const checked = validateCampaignTargetInbox(payload, runId);
    if (!checked.ok) {
      const archivedAs = `inbox-targets.rejected-${stamp}.json`;
      store.moveRunFile(runId, CAMPAIGN_TARGET_INBOX, archivedAs);
      log(`target_inbox_rejected ${checked.reason}; archived as ${archivedAs}`);
      return null;
    }
    const archivedAs = `inbox-targets.applied-${stamp}.json`;
    store.moveRunFile(runId, CAMPAIGN_TARGET_INBOX, archivedAs);
    log(`target_inbox_applied ${checked.targets.length} target(s); sha256 ${sourceSha256}`);
    return {
      targets: checked.targets,
      sourceSha256,
      archivedAs
    };
  };

  return () => {
    const immediate = consume();
    if (immediate) return immediate;
    sleep(delayMs);
    return consume();
  };
}
