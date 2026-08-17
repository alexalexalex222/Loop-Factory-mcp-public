import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialVNextContextPolicy,
  createVNextContextObservation,
  deriveVNextContextPolicy,
  validateVNextContextPolicy
} from '../src/vnext-context-allocator.mjs';

const compatibility = {
  model: 'gpt-5.6-sol',
  domain: 'code',
  harnessSha256: 'a'.repeat(64),
  toolEnvironmentSha256: 'b'.repeat(64)
};

function policy() {
  return createInitialVNextContextPolicy({
    policyId: 'context-1', scopeId: 'context-scope', compatibility,
    minInputTokens: 1000, maxInputTokens: 4000, allocatedInputTokens: 2000,
    permanentControlFraction: 0.2, maximumStepFraction: 0.1,
    createdAt: '2026-08-05T00:00:00.000Z'
  }).policy;
}

function observation(index, arm, overrides = {}) {
  return createVNextContextObservation({
    observationId: `observation-${arm}-${index}`, runId: `run-${index}`,
    taskClusterId: `cluster-${index % 2}`, arm, compatibility,
    allocatedInputTokens: 2000, usedInputTokens: 1900, outputTokens: 100,
    relevantRecords: 10, selectedRecords: 8, hydratedRecords: 4,
    missedRelevantRecords: 1, qualityEffect: arm === 'adaptive' ? 0.2 : 0.05,
    contextPackageSha256: 'c'.repeat(64), verifierEvidenceSha256: 'd'.repeat(64),
    observedAt: `2026-08-05T00:00:${String(index).padStart(2, '0')}.000Z`,
    ...overrides
  }).observation;
}

test('cross-run allocation expands one bounded step with saturation and control evidence', () => {
  const observations = [
    ...Array.from({ length: 5 }, (_, index) => observation(index, 'adaptive')),
    observation(6, 'permanent-control'), observation(7, 'permanent-control')
  ];
  const derived = deriveVNextContextPolicy({
    previousPolicy: policy(), observations, createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(derived.status, 'OK');
  assert.equal(derived.policy.action, 'EXPAND_MEASURED_SATURATION');
  assert.equal(derived.policy.allocatedInputTokens, 2200);
  assert.equal(derived.policy.compaction.contentDeletionAuthorized, false);
  assert.equal(validateVNextContextPolicy(derived.policy).status, 'OK');
});

test('insufficient or unpaired evidence retains allocation', () => {
  const derived = deriveVNextContextPolicy({
    previousPolicy: policy(),
    observations: [observation(0, 'adaptive')],
    createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(derived.policy.action, 'RETAIN_INSUFFICIENT_EVIDENCE');
  assert.equal(derived.policy.allocatedInputTokens, 2000);
});

test('measured headroom narrows without deleting memory', () => {
  const observations = [
    ...Array.from({ length: 5 }, (_, index) => observation(index, 'adaptive', {
      usedInputTokens: 500, missedRelevantRecords: 0, qualityEffect: 0.1,
      taskClusterId: `cluster-${index % 2}`
    })),
    observation(6, 'permanent-control', { qualityEffect: 0.05 }),
    observation(7, 'permanent-control', { qualityEffect: 0.05 })
  ];
  const derived = deriveVNextContextPolicy({
    previousPolicy: policy(), observations, createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(derived.policy.action, 'NARROW_MEASURED_HEADROOM');
  assert.equal(derived.policy.allocatedInputTokens, 1800);
  assert.equal(derived.policy.compaction.mode, 'lossless-reference-and-hydration');
});

test('duplicate observations and compatibility drift fail closed or are excluded', () => {
  const same = observation(0, 'adaptive');
  assert.equal(deriveVNextContextPolicy({
    previousPolicy: policy(), observations: [same, same],
    createdAt: '2026-08-05T00:01:00.000Z'
  }).code, 'VNEXT_CONTEXT_OBSERVATION_DUPLICATE');
  const other = observation(1, 'adaptive', {
    compatibility: { ...compatibility, domain: 'design' }
  });
  const derived = deriveVNextContextPolicy({
    previousPolicy: policy(), observations: [other],
    createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(derived.policy.evidence.adaptiveObservations, 0);
});
