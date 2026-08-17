import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendVNextEvidenceRecord,
  createVerifierOwnedVNextEvidenceAuthority,
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority,
  readVNextEvidenceBank,
  validateVNextEvidenceRecord,
  vnextEvidenceBankPaths
} from '../src/vnext-evidence-bank.mjs';

const NOW = '2026-08-05T00:00:00.000Z';

function recordInput(overrides = {}) {
  return {
    recordId: 'evidence-1',
    kind: 'positive',
    availableAt: NOW,
    createdAt: NOW,
    sourceIds: ['measurement-1'],
    verifierEvidenceHashes: ['a'.repeat(64)],
    compatibility: {
      domains: ['routing'],
      tags: ['negative-recall'],
      component: 'retrieval',
      schemaVersions: ['failure-v1'],
      models: ['gpt-5.6-sol'],
      harnessSha256s: ['b'.repeat(64)],
      toolEnvironmentSha256s: ['c'.repeat(64)],
      permissions: ['read-repository'],
      securityRequirements: ['sealed-evaluation'],
      versionConstraints: ['node-26']
    },
    lifecycle: { state: 'replicated', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: 0.2, costUsd: 0.01, latencyMs: 10, tokenCost: 50, uncertainty: 0.1 },
    content: { statement: 'reserve one negative precedent' },
    callerClaims: { eligible: true, aggregateQuality: 1 },
    ...overrides
  };
}

test('caller aggregate claims cannot create verifier eligibility', () => {
  const result = createVNextEvidenceRecord(recordInput({ verifierEvidenceHashes: [] }));
  assert.equal(result.status, 'OK');
  assert.equal(result.record.verifierEligible, false);
  assert.equal(validateVNextEvidenceRecord(result.record).status, 'OK');
});

test('fixture evidence requires an explicit non-production switch', () => {
  const authority = createVNextFixtureEvidenceAuthority('evidence-bank-test').authority;
  assert.equal(createVNextEvidenceRecord(recordInput({ authority })).status, 'REFUSED');
  const built = createVNextEvidenceRecord(
    recordInput({ authority }),
    { allowFixtureRecords: true }
  );
  assert.equal(built.status, 'OK');
  assert.equal(built.record.verifierEligible, true);
  assert.equal(validateVNextEvidenceRecord(built.record).status, 'REFUSED');
  assert.equal(validateVNextEvidenceRecord(
    built.record,
    { allowFixtureRecords: true }
  ).status, 'OK');
  const home = mkdtempSync(join(tmpdir(), 'vnext-fixture-bank-'));
  assert.equal(appendVNextEvidenceRecord(home, built.record).status, 'REFUSED');
  assert.equal(appendVNextEvidenceRecord(
    home,
    built.record,
    { allowFixtureRecords: true }
  ).status, 'OK');
});

test('hash-shaped verifier claims cannot enter the production bank without source replay', () => {
  const authority = createVerifierOwnedVNextEvidenceAuthority({
    sourceRunId: 'forged-run',
    sourceCompletedAt: NOW,
    primaryEvidenceSha256: '1'.repeat(64),
    leaseEvidenceSha256: '2'.repeat(64),
    preparationEvidenceSha256: '3'.repeat(64)
  }).authority;
  const built = createVNextEvidenceRecord(recordInput({
    authority,
    sourceIds: ['forged-run'],
    verifierEvidenceHashes: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
    content: {
      sourceRunId: 'forged-run',
      partition: 'validation',
      taskPackSha256: '4'.repeat(64)
    }
  }));
  assert.equal(built.status, 'OK');
  assert.equal(built.record.verifierEligible, true);
  const home = mkdtempSync(join(tmpdir(), 'vnext-forged-bank-'));
  assert.equal(
    appendVNextEvidenceRecord(home, built.record).code,
    'EVIDENCE_AUTHORITY_REPLAY_REQUIRED'
  );
});

test('record integrity rejects hash tampering', () => {
  const built = createVNextEvidenceRecord(recordInput());
  const tampered = structuredClone(built.record);
  tampered.content.statement = 'changed after persistence';
  assert.equal(validateVNextEvidenceRecord(tampered).code, 'EVIDENCE_RECORD_TAMPERED');
});

test('bank is append-only, idempotent, and rejects immutable id conflicts', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-bank-'));
  const first = createVNextEvidenceRecord(recordInput()).record;
  assert.equal(appendVNextEvidenceRecord(home, first).appended, true);
  assert.equal(appendVNextEvidenceRecord(home, first).appended, false);

  const conflict = createVNextEvidenceRecord(recordInput({ content: { statement: 'different bytes' } })).record;
  assert.equal(appendVNextEvidenceRecord(home, conflict).code, 'EVIDENCE_RECORD_CONFLICT');
  const read = readVNextEvidenceBank(home);
  assert.equal(read.status, 'OK');
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].recordSha256, first.recordSha256);
});

test('exclusive lock refuses a concurrent writer', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-lock-'));
  const paths = vnextEvidenceBankPaths(home);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.lock, 'held');
  const result = appendVNextEvidenceRecord(home, createVNextEvidenceRecord(recordInput()).record);
  assert.equal(result.code, 'EVIDENCE_BANK_LOCKED');
});

test('stale dead-writer locks are archived before the append', () => {
  const home = mkdtempSync(join(tmpdir(), 'vnext-stale-lock-'));
  const paths = vnextEvidenceBankPaths(home);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.lock, JSON.stringify({
    schemaVersion: 'vnext-evidence-bank-lock-v1',
    pid: 999_999_999,
    createdAtMs: 1,
    nonce: 'stale'
  }));
  const result = appendVNextEvidenceRecord(
    home,
    createVNextEvidenceRecord(recordInput()).record,
    { clock: () => 1_000_000, staleLockMs: 100 }
  );
  assert.equal(result.status, 'OK');
  assert.equal(
    readdirSync(paths.directory).some((name) => name.startsWith('.write.lock.stale.')),
    true
  );
});

test('records reject unbounded, cyclic, non-finite, and secret-bearing content', () => {
  assert.equal(createVNextEvidenceRecord(recordInput({
    content: { text: 'x'.repeat(70 * 1024) }
  })).code, 'EVIDENCE_RECORD_INVALID');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(createVNextEvidenceRecord(recordInput({ content: cyclic })).code, 'EVIDENCE_RECORD_INVALID');
  assert.equal(createVNextEvidenceRecord(recordInput({
    content: { score: Number.NaN }
  })).code, 'EVIDENCE_RECORD_INVALID');
  assert.equal(createVNextEvidenceRecord(recordInput({
    content: { apiKey: 'must-not-enter-model-visible-memory' }
  })).code, 'EVIDENCE_RECORD_INVALID');
});

test('bank rejects relative, normalized traversal, and symlink homes', () => {
  assert.equal(vnextEvidenceBankPaths('../escape').code, 'EVIDENCE_BANK_HOME_INVALID');
  const root = mkdtempSync(join(tmpdir(), 'vnext-path-'));
  assert.equal(vnextEvidenceBankPaths(`${root}/child/../escape`).code, 'EVIDENCE_BANK_HOME_INVALID');
  const target = mkdtempSync(join(tmpdir(), 'vnext-real-home-'));
  const link = join(root, 'linked-home');
  symlinkSync(target, link, 'dir');
  assert.equal(vnextEvidenceBankPaths(link).code, 'EVIDENCE_BANK_HOME_INVALID');
});
