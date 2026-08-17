import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_SCHEMA,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord
} from '../src/adaptive-records.mjs';
import {
  listAdaptiveRecords,
  loadMechanismCatalog,
  persistAdaptiveRecord,
  reconcileMechanismCatalog
} from '../src/mechanism-catalog.mjs';
import { sha256 } from '../src/util.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function family() {
  const result = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'unbound-evidence',
      interventionKind: 'bind-before-score',
      operationKind: 'artifact-rehash',
      expectedEffectKind: 'fewer-false-wins',
      preconditions: ['persisted-artifacts'],
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['loop-de-loop'],
        taskValueDimensions: ['evidence-quality'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(result.status, 'OK', result.message);
  return result.record;
}

function application({
  familyId,
  runId,
  hypothesisId = 'hyp-001',
  testId = 'test-001',
  appliedAt,
  verdict = 'improvement',
  qualityDelta = 0.2,
  controlRegressions = 0,
  reverified = true,
  transferPassed = true
}) {
  const result = createMechanismApplicationRecord({
    familyId,
    appliedAt,
    partition: 'harvest',
    source: { runId, hypothesisId, testId },
    context: {
      targetSha256: SHA_A,
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['evidence-quality'],
      resourceDimensions: ['token-cost']
    },
    routing: {
      routingDecisionId: null,
      routingPacketSha256: null,
      policyEpochId: null,
      policyEpochSha256: null
    },
    outcome: {
      verdict,
      valid: true,
      qualityDelta,
      tokenCostDeltaPct: -0.1,
      shamMovement: 0,
      controlRegressions,
      reverified,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: transferPassed,
        evidenceSha256: SHA_B
      }],
      contradictionCodes: verdict === 'regression' ? ['MEASURED_REGRESSION'] : []
    },
    credit: {
      confidence: 0.9,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256(runId).slice(0, 24)}`,
      legacyReceiptSha256: SHA_C,
      benchmarkSha256: SHA_D,
      artifactSetSha256: SHA_A,
      evidenceSetSha256: SHA_B
    }
  });
  assert.equal(result.status, 'OK', result.message);
  return result.record;
}

test('catalog persistence is append-only, idempotent, and hash-rebuildable', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-catalog-'));
  const familyRecord = family();
  const first = persistAdaptiveRecord({ homeDir: home, record: familyRecord });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(first.idempotent, false);
  assert.equal(existsSync(first.recordPath), true);

  const second = persistAdaptiveRecord({ homeDir: home, record: familyRecord });
  assert.equal(second.status, 'OK', second.message);
  assert.equal(second.idempotent, true);
  assert.equal(first.recordPath, second.recordPath);

  const loaded = loadMechanismCatalog({ homeDir: home });
  assert.equal(loaded.status, 'OK', loaded.message);
  assert.equal(loaded.catalog.recordCount, 1);
  assert.equal(loaded.catalog.counts[ADAPTIVE_SCHEMA.FAMILY], 1);
  assert.equal(loaded.catalog.families[0].familyId, familyRecord.familyId);
  assert.match(loaded.catalog.catalogSha256, /^[a-f0-9]{64}$/);

  const ledger = readFileSync(second.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].recordId, familyRecord.familyId);
});

test('catalog aggregates cross-run applications under one stable family', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-aggregate-'));
  const familyRecord = family();
  assert.equal(persistAdaptiveRecord({ homeDir: home, record: familyRecord }).status, 'OK');
  const first = application({
    familyId: familyRecord.familyId,
    runId: 'run-001',
    appliedAt: '2026-07-22T20:00:00.000Z'
  });
  const second = application({
    familyId: familyRecord.familyId,
    runId: 'run-002',
    hypothesisId: 'hyp-002',
    testId: 'test-002',
    appliedAt: '2026-07-22T21:00:00.000Z'
  });
  assert.equal(persistAdaptiveRecord({ homeDir: home, record: first }).status, 'OK');
  assert.equal(persistAdaptiveRecord({ homeDir: home, record: second }).status, 'OK');

  const loaded = loadMechanismCatalog({ homeDir: home });
  assert.equal(loaded.status, 'OK');
  const row = loaded.catalog.families[0];
  assert.equal(row.applicationCount, 2);
  assert.equal(row.receiptCount, 2);
  assert.equal(row.uniqueRunCount, 2);
  assert.equal(row.positiveEvidenceCount, 2);
  assert.equal(row.lifecycle, 'replicated');
  assert.equal(row.routingEligible, true);
});

test('a reverified contradiction quarantines a family without deleting evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-quarantine-'));
  const familyRecord = family();
  const positive = application({
    familyId: familyRecord.familyId,
    runId: 'run-001',
    appliedAt: '2026-07-22T20:00:00.000Z'
  });
  const regression = application({
    familyId: familyRecord.familyId,
    runId: 'run-003',
    hypothesisId: 'hyp-003',
    testId: 'test-003',
    appliedAt: '2026-07-22T22:00:00.000Z',
    verdict: 'regression',
    qualityDelta: -0.2,
    controlRegressions: 1,
    transferPassed: false
  });
  for (const record of [familyRecord, positive, regression]) {
    assert.equal(persistAdaptiveRecord({ homeDir: home, record }).status, 'OK');
  }
  const loaded = loadMechanismCatalog({ homeDir: home });
  const row = loaded.catalog.families[0];
  assert.equal(row.lifecycle, 'contradicted');
  assert.equal(row.quarantineStatus, 'QUARANTINED');
  assert.equal(row.quarantined, true);
  assert.equal(row.routingEligible, false);
  assert.equal(row.contradictionEvidenceCount, 1);
  assert.equal(row.failedTransferCount, 1);

  const listed = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.APPLICATION
  });
  assert.equal(listed.status, 'OK');
  assert.equal(listed.records.length, 2, 'quarantine preserves both positive and contradictory receipts');
});

test('an interrupted index write is repaired from immutable record files', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-interruption-'));
  const familyRecord = family();
  const interrupted = persistAdaptiveRecord({
    homeDir: home,
    record: familyRecord,
    hooks: {
      afterRecordWrite() {
        throw new Error('simulated interruption after immutable record write');
      }
    }
  });
  assert.equal(interrupted.status, 'REFUSED');
  assert.equal(interrupted.code, 'ADAPTIVE_RECORD_PERSIST_FAILED');
  assert.equal(
    existsSync(join(home, 'adaptive-memory-v1', 'families', `${familyRecord.familyId}.json`)),
    true
  );
  assert.equal(existsSync(join(home, 'adaptive-memory-v1', 'catalog.json')), false);

  const repaired = reconcileMechanismCatalog({ homeDir: home });
  assert.equal(repaired.status, 'OK', repaired.message);
  assert.equal(repaired.recordCount, 1);
  assert.equal(repaired.catalog.families[0].familyId, familyRecord.familyId);
});

test('fresh locks fail closed and stale locks are archived before reconciliation', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-lock-'));
  const root = join(home, 'adaptive-memory-v1');
  const lock = join(root, '.lock');
  mkdirSync(root, { recursive: true });
  writeFileSync(lock, '{"owner":"other"}\n');

  const locked = reconcileMechanismCatalog({
    homeDir: home,
    now: () => 1_000_000,
    staleAfterMs: 10_000
  });
  assert.equal(locked.status, 'REFUSED');
  assert.equal(locked.code, 'CATALOG_LOCKED');

  utimesSync(lock, new Date(0), new Date(0));
  const recovered = reconcileMechanismCatalog({
    homeDir: home,
    now: () => 1_000_000,
    staleAfterMs: 10_000
  });
  assert.equal(recovered.status, 'OK', recovered.message);
  const staleDir = join(root, 'stale-locks');
  assert.equal(existsSync(staleDir), true);
  assert.ok(readFileSync(recovered.catalogPath, 'utf8').includes('mechanism-catalog-v1'));
});

test('tampered record bytes are rejected and never silently overwritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-conflict-'));
  const familyRecord = family();
  const first = persistAdaptiveRecord({ homeDir: home, record: familyRecord });
  assert.equal(first.status, 'OK');
  writeFileSync(first.recordPath, '{}\n');

  const conflict = persistAdaptiveRecord({ homeDir: home, record: familyRecord });
  assert.equal(conflict.status, 'REFUSED');
  assert.equal(conflict.code, 'IMMUTABLE_RECORD_CONFLICT');
  assert.equal(readFileSync(first.recordPath, 'utf8'), '{}\n');

  const repaired = reconcileMechanismCatalog({ homeDir: home });
  assert.equal(repaired.status, 'OK');
  assert.equal(repaired.recordCount, 0);
  assert.equal(repaired.rejected.length, 1);
});

test('catalog refuses symlink roots instead of following them', () => {
  const home = mkdtempSync(join(tmpdir(), 'adaptive-symlink-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'adaptive-symlink-outside-'));
  symlinkSync(outside, join(home, 'adaptive-memory-v1'), 'dir');
  const result = persistAdaptiveRecord({ homeDir: home, record: family() });
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'SYMLINK_REFUSED');
});
