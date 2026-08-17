import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import {
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord
} from '../src/adaptive-records.mjs';
import {
  ADAPTIVE_LEDGER_ENTRY_SCHEMA_VERSION,
  listAdaptiveRecords,
  loadMechanismCatalog,
  persistAdaptiveRecord,
  reconcileMechanismCatalog
} from '../src/mechanism-catalog.mjs';

function home(prefix = 'adaptive-catalog-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function family(operationKind = 'bind-and-rehash') {
  const result = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'unbound-evidence',
      interventionKind: 'precondition-gate',
      operationKind,
      expectedEffectKind: 'fewer-false-positives',
      preconditions: ['frozen-benchmark'],
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['evidence-fidelity'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(result.status, 'OK');
  return result.record;
}

function application(mechanismFamily, {
  runId = 'run-001',
  reverified = true,
  partition = 'harvest',
  verdict = 'improvement',
  qualityDelta = 0.2,
  controlRegressions = 0,
  transferPassed = true
} = {}) {
  const result = createMechanismApplicationRecord({
    familyId: mechanismFamily.familyId,
    appliedAt: '2026-07-22T20:00:00.000Z',
    partition,
    source: {
      runId,
      hypothesisId: 'hyp-001',
      testId: 'test-001'
    },
    context: {
      targetSha256: '1'.repeat(64),
      taskMode: 'improve',
      loopRole: 'supervisor',
      taskValueDimensions: ['evidence-fidelity'],
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
        evidenceSha256: '2'.repeat(64)
      }],
      contradictionCodes: transferPassed ? [] : ['FAILED_TRANSFER']
    },
    credit: {
      confidence: 0.8,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: 'receipt-111111111111111111111111',
      legacyReceiptSha256: '6'.repeat(64),
      benchmarkSha256: '3'.repeat(64),
      artifactSetSha256: '4'.repeat(64),
      evidenceSetSha256: '5'.repeat(64)
    }
  });
  assert.equal(result.status, 'OK');
  return result.record;
}

test('persistence is immutable, idempotent, and ledger-backed', () => {
  const root = home();
  const record = family();
  const first = persistAdaptiveRecord({ homeDir: root, record });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(first.idempotent, false);
  assert.equal(first.appendedEntries, 1);
  assert.equal(existsSync(first.recordPath), true);
  assert.equal(readFileSync(first.recordPath, 'utf8'), `${canonicalAdaptiveJson(record)}\n`);

  const second = persistAdaptiveRecord({ homeDir: root, record });
  assert.equal(second.status, 'OK');
  assert.equal(second.idempotent, true);
  assert.equal(second.appendedEntries, 0);
  const lines = readFileSync(second.ledgerPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.schemaVersion, ADAPTIVE_LEDGER_ENTRY_SCHEMA_VERSION);
  assert.equal(entry.recordSchemaVersion, record.schemaVersion);
  assert.equal(entry.recordId, record.familyId);
});

test('catalog aggregates cross-run applications under one stable family', () => {
  const root = home();
  const mechanismFamily = family();
  const first = application(mechanismFamily, { runId: 'run-001' });
  const second = application(mechanismFamily, { runId: 'run-002' });
  for (const record of [mechanismFamily, first, second]) {
    assert.equal(persistAdaptiveRecord({ homeDir: root, record }).status, 'OK');
  }
  const loaded = loadMechanismCatalog({ homeDir: root });
  assert.equal(loaded.status, 'OK');
  assert.equal(loaded.catalog.families.length, 1);
  const summary = loaded.catalog.families[0];
  assert.equal(summary.familyId, mechanismFamily.familyId);
  assert.equal(summary.applicationCount, 2);
  assert.equal(summary.validApplicationCount, 2);
  assert.equal(summary.routingEligibleApplicationCount, 2);
  assert.equal(summary.positiveEvidenceCount, 2);
  assert.equal(summary.reverifiedPositiveRunCount, 2);
  assert.equal(summary.lifecycle, 'replicated');
  assert.equal(summary.creditConfidence, 0.8);
});

test('application revisions are counted once and the strongest revision wins', () => {
  const root = home();
  const mechanismFamily = family();
  const observed = application(mechanismFamily, { reverified: false });
  const reverified = application(mechanismFamily, { reverified: true, qualityDelta: 0.25 });
  assert.equal(observed.applicationId, reverified.applicationId);
  for (const record of [mechanismFamily, observed, reverified]) {
    assert.equal(persistAdaptiveRecord({ homeDir: root, record }).status, 'OK');
  }
  const summary = loadMechanismCatalog({ homeDir: root }).catalog.families[0];
  assert.equal(summary.applicationCount, 1);
  assert.equal(summary.validApplicationCount, 1);
  assert.equal(summary.positiveEvidenceCount, 1);
});

test('gate applications remain auditable but cannot become routing evidence', () => {
  const root = home();
  const mechanismFamily = family();
  for (const record of [
    mechanismFamily,
    application(mechanismFamily, { partition: 'gate' })
  ]) {
    assert.equal(persistAdaptiveRecord({ homeDir: root, record }).status, 'OK');
  }
  const summary = loadMechanismCatalog({ homeDir: root }).catalog.families[0];
  assert.equal(summary.applicationCount, 1);
  assert.equal(summary.routingEligibleApplicationCount, 0);
});

test('contradictions fail closed into the family lifecycle', () => {
  const root = home();
  const mechanismFamily = family();
  for (const record of [
    mechanismFamily,
    application(mechanismFamily, {
      verdict: 'regression',
      qualityDelta: -0.2,
      controlRegressions: 1,
      transferPassed: false
    })
  ]) {
    assert.equal(persistAdaptiveRecord({ homeDir: root, record }).status, 'OK');
  }
  const summary = loadMechanismCatalog({ homeDir: root }).catalog.families[0];
  assert.equal(summary.lifecycle, 'contradicted');
  assert.equal(summary.failureDerivedCount, 1);
  assert.equal(summary.contradictionEvidenceCount, 1);
  assert.equal(summary.transferEvidence.failed, 1);
});

test('reconciliation repairs an interrupted record-before-ledger write', () => {
  const root = home();
  const record = family();
  const dir = join(root, 'adaptive-memory-v1', 'families');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.familyId}.json`), `${canonicalAdaptiveJson(record)}\n`);
  const reconciled = reconcileMechanismCatalog({ homeDir: root });
  assert.equal(reconciled.status, 'OK', reconciled.message);
  assert.equal(reconciled.recordCount, 1);
  assert.equal(reconciled.appendedEntries, 1);
  assert.equal(reconciled.catalog.families.length, 1);
  assert.equal(readFileSync(reconciled.ledgerPath, 'utf8').trim().split('\n').length, 1);
});

test('reconciliation appends repairs without rewriting malformed ledger evidence', () => {
  const root = home();
  const record = family();
  const adaptiveRoot = join(root, 'adaptive-memory-v1');
  const dir = join(adaptiveRoot, 'families');
  const ledgerPath = join(adaptiveRoot, 'ledger.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.familyId}.json`), `${canonicalAdaptiveJson(record)}\n`);
  writeFileSync(ledgerPath, '{"broken":\n');

  const before = readFileSync(ledgerPath, 'utf8');
  const reconciled = reconcileMechanismCatalog({ homeDir: root });

  assert.equal(reconciled.status, 'OK', reconciled.message);
  assert.equal(reconciled.appendedEntries, 1);
  assert.equal(reconciled.rejectedLedgerEntries.length, 1);
  const after = readFileSync(ledgerPath, 'utf8');
  assert.equal(after.startsWith(before), true, 'malformed history remains byte-preserved');
  assert.equal(after.trim().split('\n').length, 2);
  assert.equal(reconciled.catalog.rejectedLedgerEntryCount, 1);
});

test('stale locks are preserved as evidence and recovered', () => {
  const root = home();
  const adaptiveRoot = join(root, 'adaptive-memory-v1');
  mkdirSync(adaptiveRoot, { recursive: true });
  const lock = join(adaptiveRoot, '.lock');
  writeFileSync(lock, '{"stale":true}\n');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const reconciled = reconcileMechanismCatalog({ homeDir: root });
  assert.equal(reconciled.status, 'OK', reconciled.message);
  assert.ok(reconciled.staleLockPath);
  assert.equal(existsSync(reconciled.staleLockPath), true);
  assert.equal(existsSync(lock), false);
});

test('a live lock refuses concurrent mutation without touching records', () => {
  const root = home();
  const adaptiveRoot = join(root, 'adaptive-memory-v1');
  mkdirSync(adaptiveRoot, { recursive: true });
  writeFileSync(join(adaptiveRoot, '.lock'), '{"live":true}\n');
  const record = family();
  const result = persistAdaptiveRecord({ homeDir: root, record });
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'CATALOG_LOCKED');
  assert.equal(
    existsSync(join(adaptiveRoot, 'families', `${record.familyId}.json`)),
    false
  );
});

test('invalid record files are rejected visibly and never enter the catalog', () => {
  const root = home();
  const valid = family();
  assert.equal(persistAdaptiveRecord({ homeDir: root, record: valid }).status, 'OK');
  const dir = join(root, 'adaptive-memory-v1', 'families');
  writeFileSync(join(dir, 'family-000000000000000000000000.json'), '{"tampered":true}\n');
  const reconciled = reconcileMechanismCatalog({ homeDir: root });
  assert.equal(reconciled.status, 'OK');
  assert.equal(reconciled.catalog.recordCount, 1);
  assert.equal(reconciled.catalog.rejectedRecordCount, 1);
  assert.equal(reconciled.rejectedRecords[0].code, 'INVALID_ADAPTIVE_RECORD');
});

test('existing conflicting bytes are never overwritten', () => {
  const root = home();
  const record = family();
  const dir = join(root, 'adaptive-memory-v1', 'families');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.familyId}.json`);
  writeFileSync(path, '{}\n');
  const result = persistAdaptiveRecord({ homeDir: root, record });
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'IMMUTABLE_RECORD_CONFLICT');
  assert.equal(readFileSync(path, 'utf8'), '{}\n');
});

test('catalog hash tampering is refused instead of trusted', () => {
  const root = home();
  assert.equal(persistAdaptiveRecord({ homeDir: root, record: family() }).status, 'OK');
  const loaded = loadMechanismCatalog({ homeDir: root });
  assert.equal(loaded.status, 'OK');
  const tampered = { ...loaded.catalog, recordCount: 999 };
  writeFileSync(loaded.catalogPath, `${canonicalAdaptiveJson(tampered)}\n`);
  const rejected = loadMechanismCatalog({ homeDir: root });
  assert.equal(rejected.status, 'REFUSED');
  assert.equal(rejected.code, 'CATALOG_HASH_MISMATCH');
});

test('unsafe and symbolic-link homes fail closed', () => {
  const relative = listAdaptiveRecords({ homeDir: '../outside' });
  assert.equal(relative.status, 'REFUSED');
  assert.equal(relative.code, 'UNSAFE_HOME');

  const outside = home('adaptive-outside-');
  const parent = home('adaptive-link-parent-');
  const linkedHome = join(parent, 'linked-home');
  symlinkSync(outside, linkedHome, 'dir');
  const linked = reconcileMechanismCatalog({ homeDir: linkedHome });
  assert.equal(linked.status, 'REFUSED');
  assert.equal(linked.code, 'SYMLINK_REFUSED');
});
