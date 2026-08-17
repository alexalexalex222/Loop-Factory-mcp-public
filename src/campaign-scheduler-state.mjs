import { isSafeId, sha256 } from './util.mjs';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';

export const CAMPAIGN_SCHEDULER_SCHEMA = 'campaign-scheduler-checkpoint-v1';
export const CAMPAIGN_SCHEDULER_LEDGER = 'campaign-scheduler-checkpoints-v1.jsonl';
export const CAMPAIGN_SCHEDULER_LOCK = 'campaign-scheduler-checkpoints-v1.lock';

const CHECKPOINT_STATUSES = new Set([
  'INITIALIZED',
  'TARGET_STARTED',
  'TARGET_COMPLETED',
  'IDLE',
  'WOKE',
  'CAP_REACHED',
  'QUEUE_DRAINED',
  'OPERATOR_STOP',
  'BLOCKED'
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_LEDGER_ENTRIES = 100_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const STALE_LOCK_MS = 5 * 60 * 1000;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalCampaignSchedulerJson(value) {
  return JSON.stringify(canonicalize(value));
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function validNullableString(value, maximum = 500) {
  return value == null || (typeof value === 'string' && value.length <= maximum);
}

function validTarget(target) {
  return plainObject(target)
    && ['mine', 'improve'].includes(target.kind)
    && canonicalCampaignSchedulerJson(target).length <= MAX_SNAPSHOT_BYTES;
}

function validSafeIdList(values) {
  return Array.isArray(values)
    && values.length <= 10_000
    && values.every(isSafeId)
    && new Set(values).size === values.length;
}

function validStringList(values, maximum = 10_000) {
  return Array.isArray(values)
    && values.length <= maximum
    && values.every((value) => typeof value === 'string' && value.length <= 250)
    && new Set(values).size === values.length;
}

const SNAPSHOT_KEYS = Object.freeze([
  'queue',
  'activeTarget',
  'stones',
  'pendingPromotions',
  'bankedPromotionKeys',
  'batchesTotal',
  'improveIndex',
  'findingsAccepted',
  'findingsRejected',
  'invalidAttempts',
  'benchmarkLocked',
  'baselineSamples',
  'latestSubRunId',
  'seenFindings',
  'seenMinedCandidates',
  'coverage',
  'miningExhausted',
  'idle',
  'idleReason',
  'idleCycles',
  'lastMiningFingerprint',
  'allRunIds'
]);

export function validateCampaignSchedulerSnapshot(snapshot) {
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)) {
    return refused(
      'SCHEDULER_SNAPSHOT_SCHEMA',
      'Scheduler snapshot keys do not match campaign-scheduler-checkpoint-v1.'
    );
  }
  const copy = cloneJson(snapshot);
  if (!copy || !exactKeys(copy, SNAPSHOT_KEYS)) {
    return refused('SCHEDULER_SNAPSHOT_JSON', 'Scheduler snapshot must be plain JSON.');
  }
  const bytes = Buffer.byteLength(canonicalCampaignSchedulerJson(copy));
  if (bytes > MAX_SNAPSHOT_BYTES) {
    return refused('SCHEDULER_SNAPSHOT_TOO_LARGE', 'Scheduler snapshot exceeds the 8 MiB safety limit.');
  }
  if (!Array.isArray(copy.queue) || copy.queue.length > 10_000 || copy.queue.some((target) => !validTarget(target))) {
    return refused('SCHEDULER_QUEUE_INVALID', 'Scheduler queue contains malformed or excessive targets.');
  }
  if (copy.activeTarget != null && (
    !exactKeys(copy.activeTarget, ['target', 'childRunId', 'batchesAtStart', 'invalidAttemptsAtStart'])
    || !validTarget(copy.activeTarget.target)
    || (copy.activeTarget.childRunId != null && !isSafeId(copy.activeTarget.childRunId))
    || !validCount(copy.activeTarget.batchesAtStart)
    || !validCount(copy.activeTarget.invalidAttemptsAtStart)
    || (copy.activeTarget.target.kind === 'improve' && !isSafeId(copy.activeTarget.childRunId))
    || (copy.activeTarget.target.kind === 'mine' && copy.activeTarget.childRunId != null)
  )) {
    return refused('SCHEDULER_ACTIVE_TARGET_INVALID', 'The in-flight scheduler target is malformed.');
  }
  if (!Array.isArray(copy.stones) || copy.stones.length > 10_000
      || copy.stones.some((stone) => !plainObject(stone))) {
    return refused('SCHEDULER_STONES_INVALID', 'Scheduler Stones must be bounded plain records.');
  }
  if (!Array.isArray(copy.pendingPromotions) || copy.pendingPromotions.length > 10_000
      || copy.pendingPromotions.some((item) => (
        !plainObject(item)
        || !isSafeId(item.runId)
        || !isSafeId(item.hypothesisId)
        || !isSafeId(item.reviewId)
        || !isSafeId(item.loop)
      ))) {
    return refused('SCHEDULER_PROMOTIONS_INVALID', 'Pending promotion state is malformed.');
  }
  if (!validStringList(copy.bankedPromotionKeys)
      || !validStringList(copy.seenFindings)
      || !validStringList(copy.seenMinedCandidates)
      || !validSafeIdList(copy.allRunIds)) {
    return refused('SCHEDULER_SET_INVALID', 'Scheduler set state is malformed or duplicated.');
  }
  if (![copy.batchesTotal, copy.improveIndex, copy.findingsAccepted,
    copy.findingsRejected, copy.invalidAttempts, copy.baselineSamples,
    copy.idleCycles].every(validCount)) {
    return refused('SCHEDULER_COUNTER_INVALID', 'Scheduler counters must be non-negative integers.');
  }
  if (![copy.benchmarkLocked, copy.miningExhausted, copy.idle].every((value) => typeof value === 'boolean')) {
    return refused('SCHEDULER_FLAG_INVALID', 'Scheduler flags must be boolean.');
  }
  if (copy.latestSubRunId != null && !isSafeId(copy.latestSubRunId)) {
    return refused('SCHEDULER_CHILD_RUN_INVALID', 'latestSubRunId is invalid.');
  }
  if (!validNullableString(copy.idleReason)
      || (copy.lastMiningFingerprint != null && !SHA256_RE.test(copy.lastMiningFingerprint))) {
    return refused('SCHEDULER_IDLE_INVALID', 'Scheduler idle state is malformed.');
  }
  if (!Array.isArray(copy.coverage) || copy.coverage.length > 10_000
      || copy.coverage.some((item) => !plainObject(item))) {
    return refused('SCHEDULER_COVERAGE_INVALID', 'Scheduler coverage must be bounded plain records.');
  }
  return ok({ snapshot: copy, snapshotSha256: sha256(canonicalCampaignSchedulerJson(copy)) });
}

export function campaignSchedulerConfigSha256(config = {}) {
  const copy = cloneJson(config);
  if (!copy) return null;
  return sha256(canonicalCampaignSchedulerJson(copy));
}

function checkpointPayload({ runId, sequence, createdAt, configSha256, previousCheckpointSha256, status, snapshot, snapshotSha256 }) {
  return {
    schemaVersion: CAMPAIGN_SCHEDULER_SCHEMA,
    runId,
    sequence,
    createdAt,
    configSha256,
    previousCheckpointSha256,
    status,
    snapshotSha256,
    snapshot
  };
}

export function createCampaignSchedulerCheckpoint({
  runId,
  configSha256,
  previousCheckpoint = null,
  status,
  snapshot,
  createdAt
} = {}) {
  if (!isSafeId(runId) || !SHA256_RE.test(String(configSha256 || ''))
      || !CHECKPOINT_STATUSES.has(status)
      || typeof createdAt !== 'string' || !createdAt) {
    return refused('SCHEDULER_CHECKPOINT_INPUT', 'Scheduler checkpoint identity, status, or timestamp is invalid.');
  }
  const checked = validateCampaignSchedulerSnapshot(snapshot);
  if (checked.status !== 'OK') return checked;
  if (previousCheckpoint != null && (
    previousCheckpoint.schemaVersion !== CAMPAIGN_SCHEDULER_SCHEMA
    || previousCheckpoint.runId !== runId
    || previousCheckpoint.configSha256 !== configSha256
    || !Number.isInteger(previousCheckpoint.sequence)
    || !SHA256_RE.test(String(previousCheckpoint.checkpointSha256 || ''))
  )) {
    return refused('SCHEDULER_PREVIOUS_INVALID', 'Previous scheduler checkpoint is invalid or belongs to another campaign.');
  }
  const payload = checkpointPayload({
    runId,
    sequence: previousCheckpoint ? previousCheckpoint.sequence + 1 : 0,
    createdAt,
    configSha256,
    previousCheckpointSha256: previousCheckpoint?.checkpointSha256 || null,
    status,
    snapshot: checked.snapshot,
    snapshotSha256: checked.snapshotSha256
  });
  return ok({
    checkpoint: {
      ...payload,
      checkpointSha256: sha256(canonicalCampaignSchedulerJson(payload))
    }
  });
}

function validateCheckpoint(record, { runId, configSha256, previousCheckpoint }) {
  if (!exactKeys(record, [
    'schemaVersion', 'runId', 'sequence', 'createdAt', 'configSha256',
    'previousCheckpointSha256', 'status', 'snapshotSha256', 'snapshot',
    'checkpointSha256'
  ])) {
    return refused('SCHEDULER_LEDGER_SCHEMA', 'Scheduler ledger record has unexpected keys.');
  }
  const built = createCampaignSchedulerCheckpoint({
    runId,
    configSha256,
    previousCheckpoint,
    status: record.status,
    snapshot: record.snapshot,
    createdAt: record.createdAt
  });
  if (built.status !== 'OK') return built;
  if (canonicalCampaignSchedulerJson(built.checkpoint)
      !== canonicalCampaignSchedulerJson(record)) {
    return refused('SCHEDULER_LEDGER_HASH_MISMATCH', 'Scheduler ledger hash chain or payload does not reverify.');
  }
  return ok({ checkpoint: built.checkpoint });
}

export function parseCampaignSchedulerLedger(raw, { runId, configSha256 } = {}) {
  if (!isSafeId(runId) || !SHA256_RE.test(String(configSha256 || ''))) {
    return refused('SCHEDULER_LEDGER_INPUT', 'A safe run ID and config hash are required.');
  }
  if (raw == null || raw === '') return ok({ checkpoints: [], checkpoint: null });
  const lines = String(raw).split('\n').filter((line) => line.trim() !== '');
  if (lines.length > MAX_LEDGER_ENTRIES) {
    return refused('SCHEDULER_LEDGER_TOO_LARGE', 'Scheduler ledger exceeds the checkpoint safety limit.');
  }
  const checkpoints = [];
  let previousCheckpoint = null;
  for (let index = 0; index < lines.length; index++) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      return refused('SCHEDULER_LEDGER_JSON', `Scheduler checkpoint ${index} is not valid JSON.`);
    }
    const checked = validateCheckpoint(record, { runId, configSha256, previousCheckpoint });
    if (checked.status !== 'OK') return { ...checked, checkpointIndex: index };
    checkpoints.push(checked.checkpoint);
    previousCheckpoint = checked.checkpoint;
  }
  return ok({ checkpoints, checkpoint: checkpoints.at(-1) || null });
}

export function loadCampaignSchedulerCheckpoint({ store, runId, config } = {}) {
  const configSha256 = campaignSchedulerConfigSha256(config);
  if (!store || !configSha256) {
    return refused('SCHEDULER_LOAD_INPUT', 'Store and JSON campaign config are required.');
  }
  const raw = store.readRunFile(runId, CAMPAIGN_SCHEDULER_LEDGER);
  const parsed = parseCampaignSchedulerLedger(raw, { runId, configSha256 });
  return parsed.status === 'OK' ? { ...parsed, configSha256 } : parsed;
}

function acquireSchedulerLock(store, runId) {
  const lockPath = join(store.runDir(runId), CAMPAIGN_SCHEDULER_LOCK);
  if (existsSync(lockPath)) {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > STALE_LOCK_MS) {
        renameSync(lockPath, `${lockPath}.stale-${Date.now()}`);
      }
    } catch {
      return refused('SCHEDULER_LOCK_INSPECTION_FAILED', 'Scheduler lock could not be inspected safely.');
    }
  }
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, token);
    closeSync(fd);
    return ok({ lockPath, token });
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return refused(
      error?.code === 'EEXIST' ? 'SCHEDULER_LEDGER_LOCKED' : 'SCHEDULER_LOCK_FAILED',
      error?.code === 'EEXIST'
        ? 'Another parent process is checkpointing this campaign.'
        : 'Scheduler checkpoint lock could not be acquired.'
    );
  }
}

function releaseSchedulerLock(lock) {
  if (!lock?.lockPath || !existsSync(lock.lockPath)) return;
  try {
    if (readFileSync(lock.lockPath, 'utf8') === lock.token) unlinkSync(lock.lockPath);
  } catch { /* a failed release becomes a stale lock and is recovered later */ }
}

export function appendCampaignSchedulerCheckpoint({
  store,
  runId,
  config,
  status,
  snapshot,
  createdAt
} = {}) {
  if (!store || !isSafeId(runId)) {
    return refused('SCHEDULER_APPEND_INPUT', 'Store and safe run ID are required.');
  }
  const lock = acquireSchedulerLock(store, runId);
  if (lock.status !== 'OK') return lock;
  try {
    const loaded = loadCampaignSchedulerCheckpoint({ store, runId, config });
    if (loaded.status !== 'OK') return loaded;
    const checked = validateCampaignSchedulerSnapshot(snapshot);
    if (checked.status !== 'OK') return checked;
    if (loaded.checkpoint
        && loaded.checkpoint.status === status
        && loaded.checkpoint.snapshotSha256 === checked.snapshotSha256) {
      return ok({
        checkpoint: loaded.checkpoint,
        configSha256: loaded.configSha256,
        idempotent: true,
        checkpointCount: loaded.checkpoints.length
      });
    }
    const built = createCampaignSchedulerCheckpoint({
      runId,
      configSha256: loaded.configSha256,
      previousCheckpoint: loaded.checkpoint,
      status,
      snapshot: checked.snapshot,
      createdAt
    });
    if (built.status !== 'OK') return built;
    const checkpoints = [...loaded.checkpoints, built.checkpoint];
    store.writeRunFile(
      runId,
      CAMPAIGN_SCHEDULER_LEDGER,
      `${checkpoints.map((item) => canonicalCampaignSchedulerJson(item)).join('\n')}\n`
    );
    const reopened = loadCampaignSchedulerCheckpoint({ store, runId, config });
    if (reopened.status !== 'OK'
        || reopened.checkpoint?.checkpointSha256 !== built.checkpoint.checkpointSha256) {
      return refused('SCHEDULER_LEDGER_REOPEN_FAILED', 'Persisted scheduler checkpoint did not reverify from disk.');
    }
    return ok({
      checkpoint: reopened.checkpoint,
      configSha256: reopened.configSha256,
      idempotent: false,
      checkpointCount: reopened.checkpoints.length
    });
  } finally {
    releaseSchedulerLock(lock);
  }
}
