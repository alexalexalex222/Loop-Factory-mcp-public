import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import {
  createVerifierOwnedVNextEvidenceAuthority,
  createVNextEvidenceRecord
} from '../src/vnext-evidence-bank.mjs';
import {
  createVNextEvidenceAuthorityVerifier,
  replayVNextEvidenceRecordAuthority
} from '../src/vnext-evidence-authority.mjs';

const NOW = '2026-08-05T00:00:00.000Z';

function verifierOwnedRecord() {
  const authority = createVerifierOwnedVNextEvidenceAuthority({
    sourceRunId: 'authority-source-run',
    sourceCompletedAt: NOW,
    primaryEvidenceSha256: '1'.repeat(64),
    leaseEvidenceSha256: '2'.repeat(64),
    preparationEvidenceSha256: '3'.repeat(64)
  }).authority;
  return createVNextEvidenceRecord({
    recordId: 'authority-record',
    kind: 'positive',
    availableAt: NOW,
    createdAt: NOW,
    sourceIds: ['authority-source-run'],
    authority,
    verifierEvidenceHashes: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
    compatibility: {
      domains: [], tags: ['authority'], component: 'mechanism-program',
      schemaVersions: ['vnext-recursive-import-v1'], models: ['gpt-5.6-sol'],
      harnessSha256s: ['4'.repeat(64)], toolEnvironmentSha256s: ['5'.repeat(64)],
      permissions: ['routing-only'], securityRequirements: ['verifier-owned-admission'],
      versionConstraints: ['test-v1']
    },
    lifecycle: { state: 'active', quarantined: false, quarantineReason: null },
    metrics: {
      qualityDelta: 0.1, costUsd: 0, latencyMs: null,
      tokenCost: 1, uncertainty: null
    },
    content: {
      schemaVersion: 'vnext-recursive-import-v1',
      sourceRunId: 'authority-source-run',
      partition: 'validation',
      taskPackSha256: '6'.repeat(64)
    },
    callerClaims: {}
  }).record;
}

test('evidence authority verifier is locked to one real local store', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-authority-home-'));
  const other = mkdtempSync(join(tmpdir(), 'vnext-authority-other-'));
  const aliasParent = mkdtempSync(join(tmpdir(), 'vnext-authority-alias-'));
  const alias = join(aliasParent, 'same-store');
  try {
    const store = createStore(home);
    assert.equal(createVNextEvidenceAuthorityVerifier({
      sourceStore: store,
      homeDir: other
    }).code, 'EVIDENCE_AUTHORITY_STORE_MISMATCH');

    symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const same = createVNextEvidenceAuthorityVerifier({
      sourceStore: store,
      homeDir: alias
    });
    assert.equal(same.status, 'OK');
    assert.equal(
      same.verifier(verifierOwnedRecord()).code,
      'EVIDENCE_AUTHORITY_REPLAY_FAILED'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(aliasParent, { recursive: true, force: true });
  }
});

test('authority replay rejects unverified, tampered, and nonexistent proof', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-authority-replay-'));
  try {
    const store = createStore(home);
    const unverified = createVNextEvidenceRecord({
      ...verifierOwnedRecord(),
      recordId: 'unverified-authority-record',
      authority: undefined
    }).record;
    assert.equal(replayVNextEvidenceRecordAuthority({
      sourceStore: store,
      record: unverified
    }).code, 'EVIDENCE_AUTHORITY_RECORD_INVALID');

    const forged = verifierOwnedRecord();
    assert.equal(replayVNextEvidenceRecordAuthority({
      sourceStore: store,
      record: forged
    }).code, 'EVIDENCE_AUTHORITY_REPLAY_FAILED');

    const tampered = structuredClone(forged);
    tampered.authority.primaryEvidenceSha256 = '9'.repeat(64);
    assert.equal(replayVNextEvidenceRecordAuthority({
      sourceStore: store,
      record: tampered
    }).code, 'EVIDENCE_AUTHORITY_RECORD_INVALID');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
