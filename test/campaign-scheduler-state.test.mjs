import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_SCHEDULER_LEDGER,
  CAMPAIGN_SCHEDULER_LOCK,
  appendCampaignSchedulerCheckpoint,
  loadCampaignSchedulerCheckpoint,
  validateCampaignSchedulerSnapshot
} from '../src/campaign-scheduler-state.mjs';
import { createStore } from '../src/store.mjs';

function snapshot(overrides = {}) {
  return {
    queue: [{ kind: 'mine', routes: ['gpt-5.6-sol'] }],
    activeTarget: null,
    stones: [],
    pendingPromotions: [],
    bankedPromotionKeys: [],
    batchesTotal: 0,
    improveIndex: 0,
    findingsAccepted: 0,
    findingsRejected: 0,
    invalidAttempts: 0,
    benchmarkLocked: false,
    baselineSamples: 0,
    latestSubRunId: null,
    seenFindings: [],
    seenMinedCandidates: [],
    coverage: [],
    miningExhausted: false,
    idle: false,
    idleReason: null,
    idleCycles: 0,
    lastMiningFingerprint: null,
    allRunIds: ['scheduler-run'],
    ...overrides
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'scheduler-ledger-'));
  const store = createStore(home);
  store.save({ runId: 'scheduler-run', status: 'RUNNING' });
  return { store, config: { runId: 'scheduler-run', task: 'improve', targets: [] } };
}

test('scheduler checkpoints append as a deterministic hash chain and reopen from disk', () => {
  const { store, config } = fixture();
  const first = appendCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config,
    status: 'INITIALIZED',
    snapshot: snapshot(),
    createdAt: '2026-08-01T00:00:00.000Z'
  });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(first.checkpoint.sequence, 0);

  const second = appendCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config,
    status: 'TARGET_STARTED',
    snapshot: snapshot({
      queue: [],
      activeTarget: {
        target: { kind: 'improve', loop: 'loop-de-loop' },
        childRunId: 'scheduler-run-t1',
        batchesAtStart: 0,
        invalidAttemptsAtStart: 0
      },
      improveIndex: 1,
      latestSubRunId: 'scheduler-run-t1',
      allRunIds: ['scheduler-run', 'scheduler-run-t1']
    }),
    createdAt: '2026-08-01T00:00:01.000Z'
  });
  assert.equal(second.status, 'OK', second.message);
  assert.equal(second.checkpoint.sequence, 1);
  assert.equal(
    second.checkpoint.previousCheckpointSha256,
    first.checkpoint.checkpointSha256
  );

  const reopened = loadCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config
  });
  assert.equal(reopened.status, 'OK', reopened.message);
  assert.equal(reopened.checkpoints.length, 2);
  assert.equal(reopened.checkpoint.checkpointSha256, second.checkpoint.checkpointSha256);

  const repeated = appendCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config,
    status: second.checkpoint.status,
    snapshot: second.checkpoint.snapshot,
    createdAt: '2026-08-01T00:00:02.000Z'
  });
  assert.equal(repeated.status, 'OK');
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.checkpointCount, 2);
});

test('scheduler loading refuses config drift and any rehashed-payload mismatch', () => {
  const { store, config } = fixture();
  const written = appendCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config,
    status: 'INITIALIZED',
    snapshot: snapshot(),
    createdAt: '2026-08-01T00:00:00.000Z'
  });
  assert.equal(written.status, 'OK');

  const drifted = loadCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config: { ...config, task: 'different objective' }
  });
  assert.equal(drifted.status, 'REFUSED');

  const raw = store.readRunFile('scheduler-run', CAMPAIGN_SCHEDULER_LEDGER);
  store.writeRunFile(
    'scheduler-run',
    CAMPAIGN_SCHEDULER_LEDGER,
    raw.replace('"batchesTotal":0', '"batchesTotal":1')
  );
  const tampered = loadCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config
  });
  assert.equal(tampered.status, 'REFUSED');
  assert.equal(tampered.code, 'SCHEDULER_LEDGER_HASH_MISMATCH');
});

test('scheduler snapshots reject malformed in-flight work and duplicate set state', () => {
  assert.equal(validateCampaignSchedulerSnapshot(snapshot()).status, 'OK');
  assert.equal(validateCampaignSchedulerSnapshot(snapshot({
    activeTarget: {
      target: { kind: 'improve', loop: 'loop-de-loop' },
      childRunId: '../unsafe',
      batchesAtStart: 0,
      invalidAttemptsAtStart: 0
    }
  })).status, 'REFUSED');
  assert.equal(validateCampaignSchedulerSnapshot(snapshot({
    seenFindings: ['same', 'same']
  })).status, 'REFUSED');
});

test('scheduler checkpointing refuses a concurrent writer and recovers a stale lock', () => {
  const { store, config } = fixture();
  const lockPath = store.writeRunFile('scheduler-run', CAMPAIGN_SCHEDULER_LOCK, 'active-writer');
  const locked = appendCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config,
    status: 'INITIALIZED',
    snapshot: snapshot(),
    createdAt: '2026-08-01T00:00:00.000Z'
  });
  assert.equal(locked.status, 'REFUSED');
  assert.equal(locked.code, 'SCHEDULER_LEDGER_LOCKED');

  const stale = new Date(Date.now() - (10 * 60 * 1000));
  utimesSync(lockPath, stale, stale);
  const recovered = appendCampaignSchedulerCheckpoint({
    store,
    runId: 'scheduler-run',
    config,
    status: 'INITIALIZED',
    snapshot: snapshot(),
    createdAt: '2026-08-01T00:00:01.000Z'
  });
  assert.equal(recovered.status, 'OK', recovered.message);
});
