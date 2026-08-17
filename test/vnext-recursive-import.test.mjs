import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import {
  deriveVNextRecursiveEvidence,
  persistVNextRecursiveEvidence
} from '../src/vnext-recursive-import.mjs';
import {
  appendVNextEvidenceRecord,
  createVerifierOwnedVNextEvidenceAuthority,
  createVNextEvidenceRecord
} from '../src/vnext-evidence-bank.mjs';
import {
  commitVNextRecursiveImportTransaction,
  persistVNextRecursiveImportPending,
  requireVNextRecursiveImportGate
} from '../src/vnext-recursive-import-transaction.mjs';
import {
  listAdaptiveRecords,
  loadMechanismCatalog,
  reconcileMechanismCatalog,
  verifyVNextRecursiveCatalogImportCommit
} from '../src/mechanism-catalog.mjs';

test('VNext recursive import refuses missing and non-VNext proof before persistence', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-recursive-import-'));
  const store = createStore(home);
  const derived = deriveVNextRecursiveEvidence({
    sourceStore: store,
    runId: 'missing-run'
  });
  assert.equal(derived.status, 'REFUSED');
  assert.equal(derived.code, 'VNEXT_RECURSIVE_IMPORT_NOT_ELIGIBLE');
  const persisted = persistVNextRecursiveEvidence({
    sourceStore: store,
    homeDir: home,
    runId: 'missing-run'
  });
  assert.equal(persisted.status, 'REFUSED');
});

test('VNext catalog stays blocked between evidence pending and commit', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-recursive-transaction-'));
  const sourceCompletedAt = '2026-08-05T00:00:00.000Z';
  const primaryEvidenceSha256 = '1'.repeat(64);
  const authority = createVerifierOwnedVNextEvidenceAuthority({
    sourceRunId: 'vnext-import-run',
    sourceCompletedAt,
    primaryEvidenceSha256,
    leaseEvidenceSha256: '2'.repeat(64),
    preparationEvidenceSha256: '3'.repeat(64)
  }).authority;
  const built = createVNextEvidenceRecord({
    kind: 'positive',
    availableAt: sourceCompletedAt,
    createdAt: sourceCompletedAt,
    sourceIds: ['vnext-import-run'],
    authority,
    verifierEvidenceHashes: [
      primaryEvidenceSha256,
      '2'.repeat(64),
      '3'.repeat(64)
    ],
    compatibility: {
      domains: [],
      tags: ['transaction-test'],
      component: 'mechanism-program',
      schemaVersions: ['vnext-recursive-import-v1'],
      models: ['gpt-5.6-sol'],
      harnessSha256s: ['4'.repeat(64)],
      toolEnvironmentSha256s: ['5'.repeat(64)],
      permissions: ['routing-only'],
      securityRequirements: ['verifier-owned-admission'],
      versionConstraints: ['test-v1']
    },
    lifecycle: {
      state: 'active',
      quarantined: false,
      quarantineReason: null
    },
    metrics: {
      qualityDelta: 0.1,
      costUsd: 0,
      latencyMs: null,
      tokenCost: 1,
      uncertainty: null
    },
    content: {
      schemaVersion: 'vnext-recursive-import-v1',
      sourceRunId: 'vnext-import-run',
      partition: 'validation'
    },
    callerClaims: {}
  });
  assert.equal(built.status, 'OK');
  const unverified = createVNextEvidenceRecord({
    ...structuredClone(built.record),
    recordId: 'unverified-import-record',
    authority: undefined
  });
  assert.equal(unverified.status, 'OK');
  assert.equal(persistVNextRecursiveImportPending({
    homeDir: home,
    runId: 'vnext-import-run',
    partition: 'validation',
    record: unverified.record,
    verifierEvidenceSha256: primaryEvidenceSha256,
    createdAt: sourceCompletedAt
  }).code, 'VNEXT_RECURSIVE_IMPORT_PENDING_INPUT_INVALID');
  const pending = persistVNextRecursiveImportPending({
    homeDir: home,
    runId: 'vnext-import-run',
    partition: 'validation',
    record: built.record,
    verifierEvidenceSha256: primaryEvidenceSha256,
    createdAt: sourceCompletedAt
  });
  assert.equal(pending.status, 'OK', pending.message);
  assert.equal(requireVNextRecursiveImportGate(home).code,
    'VNEXT_RECURSIVE_IMPORT_INCOMPLETE');
  assert.equal(listAdaptiveRecords({ homeDir: home }).code,
    'VNEXT_RECURSIVE_IMPORT_INCOMPLETE');
  assert.equal(verifyVNextRecursiveCatalogImportCommit({
    homeDir: home,
    runId: 'vnext-import-run',
    partition: 'validation',
    verifierEvidenceSha256: primaryEvidenceSha256,
    vnextImportCommit: null
  }).code, 'VNEXT_RECURSIVE_IMPORT_COMMIT_REQUIRED');

  const appended = appendVNextEvidenceRecord(home, built.record, {
    authorityVerifier: (record) => ({
      status: 'OK',
      verifierEligible: true,
      authoritySha256: record.authority.authoritySha256,
      sourceCompletedAt: record.authority.sourceCompletedAt,
      verificationEvidenceSha256: record.authority.primaryEvidenceSha256
    })
  });
  assert.equal(appended.status, 'OK', appended.message);
  assert.equal(requireVNextRecursiveImportGate(home).code,
    'VNEXT_RECURSIVE_IMPORT_INCOMPLETE');
  const committed = commitVNextRecursiveImportTransaction({
    homeDir: home,
    transactionId: pending.pending.transactionId,
    evidenceLedgerSha256: appended.ledgerSha256,
    committedAt: sourceCompletedAt
  });
  assert.equal(committed.status, 'OK', committed.message);
  const vnextImportCommit = {
    transactionId: committed.commit.transactionId,
    commitSha256: committed.commit.commitSha256
  };
  assert.equal(verifyVNextRecursiveCatalogImportCommit({
    homeDir: home,
    runId: 'vnext-import-run',
    partition: 'validation',
    verifierEvidenceSha256: primaryEvidenceSha256,
    vnextImportCommit
  }).status, 'OK');
  assert.equal(requireVNextRecursiveImportGate(home).status, 'OK');
  assert.equal(listAdaptiveRecords({ homeDir: home }).status, 'OK');
  assert.equal(reconcileMechanismCatalog({ homeDir: home }).status, 'OK');
  assert.equal(loadMechanismCatalog({ homeDir: home }).status, 'OK');
});
