import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, STORE_DURABILITY } from '../src/store.mjs';
import {
  createResourceBudgetLedger,
  createResourceBudgetPolicy,
  reserveResourceBudget,
  settleResourceBudget
} from '../src/resource-budget.mjs';
import {
  persistResourceBudgetBreachEvidence,
  persistResourceBudgetCheckpoint,
  verifyResourceBudgetBreachEvidenceFromDisk,
  verifyResourceBudgetCheckpointHistory
} from '../src/resource-budget-store.mjs';

function createPowerLossStore(home) {
  if (process.platform !== 'win32') {
    return createStore(home, { durability: STORE_DURABILITY.POWER_LOSS });
  }
  assert.throws(
    () => createStore(home, { durability: STORE_DURABILITY.POWER_LOSS }),
    { code: 'DURABLE_PLATFORM_UNSUPPORTED' }
  );
  return null;
}

function fixture() {
  const store = createStore(mkdtempSync(join(tmpdir(), 'resource-budget-store-')));
  const policy = createResourceBudgetPolicy({
    policyId: 'checkpoint-budget',
    maxCalls: 2,
    maxInputTokens: 200,
    maxOutputTokens: 100,
    maxTotalTokens: 300,
    maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd',
    currency: 'USD'
  }).policy;
  const ledger = createResourceBudgetLedger({
    policy,
    runId: 'budget-run',
    createdAt: '2026-08-16T00:00:00.000Z'
  }).ledger;
  return { store, ledger, root: 'budget-checkpoints/preparation' };
}

test('reservation checkpoint survives without settlement as one unresolved call', () => {
  const { store, ledger, root } = fixture();
  const reserved = reserveResourceBudget(ledger, {
    callId: 'call-1',
    maxInputTokens: 100,
    maxOutputTokens: 50,
    createdAt: '2026-08-16T00:00:01.000Z'
  });
  const checkpoint = persistResourceBudgetCheckpoint({
    store,
    runId: 'budget-run',
    checkpointRoot: root,
    kind: 'reservation',
    callId: 'call-1',
    ledger: reserved.ledger,
    recordedAt: '2026-08-16T00:00:01.000Z'
  });
  assert.equal(checkpoint.status, 'OK');
  const replay = verifyResourceBudgetCheckpointHistory({
    store,
    runId: 'budget-run',
    checkpointRoot: root
  });
  assert.equal(replay.status, 'OK');
  assert.deepEqual(
    replay.unresolvedReservations.map((row) => row.callId),
    ['call-1']
  );
});

test('checkpoint roots reject absolute path forms from every supported OS', () => {
  const { store, ledger } = fixture();
  const reserved = reserveResourceBudget(ledger, {
    callId: 'call-1',
    maxInputTokens: 100,
    maxOutputTokens: 50,
    createdAt: '2026-08-16T00:00:01.000Z'
  });
  for (const checkpointRoot of [
    '/escaped/checkpoints',
    'C:\\escaped\\checkpoints',
    '\\\\server\\share\\checkpoints'
  ]) {
    assert.equal(persistResourceBudgetCheckpoint({
      store,
      runId: 'budget-run',
      checkpointRoot,
      kind: 'reservation',
      callId: 'call-1',
      ledger: reserved.ledger,
      recordedAt: '2026-08-16T00:00:01.000Z'
    }).status, 'REFUSED');
  }
});

test('settlement checkpoint closes the exact persisted reservation', () => {
  const { store, ledger, root } = fixture();
  const reserved = reserveResourceBudget(ledger, {
    callId: 'call-1',
    maxInputTokens: 100,
    maxOutputTokens: 50,
    createdAt: '2026-08-16T00:00:01.000Z'
  });
  assert.equal(persistResourceBudgetCheckpoint({
    store,
    runId: 'budget-run',
    checkpointRoot: root,
    kind: 'reservation',
    callId: 'call-1',
    ledger: reserved.ledger,
    recordedAt: '2026-08-16T00:00:01.000Z'
  }).status, 'OK');
  const settled = settleResourceBudget(reserved.ledger, {
    reservationId: reserved.reservation.reservationId,
    inputTokens: 80,
    outputTokens: 30,
    settledAt: '2026-08-16T00:00:02.000Z',
    usageAuthority: 'cli-receipt'
  });
  assert.equal(persistResourceBudgetCheckpoint({
    store,
    runId: 'budget-run',
    checkpointRoot: root,
    kind: 'settlement',
    callId: 'call-1',
    ledger: settled.ledger,
    recordedAt: '2026-08-16T00:00:02.000Z'
  }).status, 'OK');
  const replay = verifyResourceBudgetCheckpointHistory({
    store,
    runId: 'budget-run',
    checkpointRoot: root
  });
  assert.equal(replay.status, 'OK');
  assert.deepEqual(replay.unresolvedReservations, []);
  assert.equal(replay.ledger.ledgerSha256, settled.ledger.ledgerSha256);

  const first = join(
    store.runDir('budget-run'),
    root,
    `0001-${replay.checkpoints[0].checkpointSha256}.json`
  );
  const tampered = JSON.parse(readFileSync(first, 'utf8'));
  tampered.callId = 'call-2';
  writeFileSync(first, JSON.stringify(tampered));
  assert.equal(verifyResourceBudgetCheckpointHistory({
    store,
    runId: 'budget-run',
    checkpointRoot: root
  }).status, 'REFUSED');
});

test('an over-reservation provider receipt is preserved outside the invalid bounded ledger', () => {
  const policy = createResourceBudgetPolicy({
    policyId: 'breach-budget',
    maxCalls: 1,
    maxInputTokens: 100,
    maxOutputTokens: 50,
    maxTotalTokens: 150,
    maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd',
    currency: 'USD'
  }).policy;
  const initial = createResourceBudgetLedger({
    policy,
    runId: 'breach-ledger',
    createdAt: '2026-08-16T00:00:00.000Z'
  }).ledger;
  const store = createPowerLossStore(
    mkdtempSync(join(tmpdir(), 'resource-budget-breach-'))
  );
  if (!store) return;
  const root = 'budget-checkpoints/preparation';
  const reserved = reserveResourceBudget(initial, {
    callId: 'call-1',
    maxInputTokens: 100,
    maxOutputTokens: 50,
    createdAt: '2026-08-16T00:00:01.000Z'
  });
  assert.equal(persistResourceBudgetCheckpoint({
    store,
    runId: 'budget-run',
    checkpointRoot: root,
    kind: 'reservation',
    callId: 'call-1',
    ledger: reserved.ledger,
    recordedAt: '2026-08-16T00:00:01.000Z'
  }).status, 'OK');
  const settled = settleResourceBudget(reserved.ledger, {
    reservationId: reserved.reservation.reservationId,
    inputTokens: 120,
    outputTokens: 40,
    settledAt: '2026-08-16T00:00:02.000Z',
    usageAuthority: 'provider-receipt'
  });
  assert.equal(settled.status, 'BLOCKED');
  const persisted = persistResourceBudgetBreachEvidence({
    store,
    runId: 'budget-run',
    checkpointRoot: root,
    callId: 'call-1',
    ledger: settled.ledger,
    settlement: settled.settlement,
    recordedAt: '2026-08-16T00:00:02.000Z'
  });
  assert.equal(persisted.status, 'OK', persisted.code);
  const replay = verifyResourceBudgetBreachEvidenceFromDisk({
    store,
    runId: 'budget-run',
    checkpointRoot: root,
    reservationId: reserved.reservation.reservationId
  });
  assert.equal(replay.status, 'OK', replay.code);
  assert.equal(replay.evidence.settlement.inputTokens, 120);
  assert.equal(replay.evidence.settlement.withinReservation, false);
  assert.deepEqual(
    replay.history.unresolvedReservations.map((row) => row.callId),
    ['call-1']
  );
});
