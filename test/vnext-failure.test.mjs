import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVNextFailure,
  validateVNextFailureArtifact
} from '../src/vnext-failure.mjs';

const NOW = '2026-08-05T02:00:00.000Z';

function input(overrides = {}) {
  return {
    failureId: 'failure-routing-1',
    observedAt: NOW,
    summary: 'Relevant negative evidence was omitted from retrieval.',
    behavior: 'failure-aware retrieval',
    component: 'retrieval',
    symptoms: ['contradicted mechanism was not shown'],
    environment: { model: 'gpt-5.6-sol', harnessSha256: 'b'.repeat(64) },
    sourceEvidence: [{
      id: 'receipt-1',
      schemaVersion: 'measurement-v1',
      sha256: 'a'.repeat(64),
      availableAt: NOW,
      locator: 'proof/run/state.json#failure-1'
    }],
    ...overrides
  };
}

test('failure normalization is immutable, source-bound, and authority-free', () => {
  const first = normalizeVNextFailure(input());
  const second = normalizeVNextFailure(input());
  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(validateVNextFailureArtifact(first.artifact).status, 'OK');
  assert.equal(first.artifact.payload.activationAuthority, false);
  assert.equal(first.artifact.inputRefs[0].sha256, 'a'.repeat(64));
});

test('failure normalization rejects sealed data, future evidence, and path escape', () => {
  assert.equal(normalizeVNextFailure(input({ sealedTasks: ['hidden'] })).status, 'REFUSED');
  assert.equal(normalizeVNextFailure(input({
    sourceEvidence: [{ ...input().sourceEvidence[0], availableAt: '2026-08-06T00:00:00.000Z' }]
  })).status, 'REFUSED');
  assert.equal(normalizeVNextFailure(input({
    sourceEvidence: [{ ...input().sourceEvidence[0], locator: '../hidden.json' }]
  })).status, 'REFUSED');
});
