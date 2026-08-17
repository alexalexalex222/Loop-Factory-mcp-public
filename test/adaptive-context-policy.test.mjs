import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createContextSaturationObservation,
  createInitialAdaptiveContextPolicy,
  deriveAdaptiveContextPolicy,
  validateAdaptiveContextPolicy,
  validateContextSaturationObservation
} from '../src/adaptive-context-policy.mjs';
import { sha256 } from '../src/util.mjs';

function initial(tokens = 1000) {
  const built = createInitialAdaptiveContextPolicy({
    scopeId: 'recursive-context-test',
    minInputTokens: 500,
    initialInputTokens: tokens,
    maxInputTokens: 2000,
    permanentControlFraction: 0.2,
    recordedAt: '2026-08-04T23:00:00.000Z'
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function observations({ saturation, lift, count = 5 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const built = createContextSaturationObservation({
      scopeId: 'recursive-context-test',
      runId: 'context-run',
      generation: index,
      callId: `context-call-${index}`,
      allocatedInputTokens: 1000,
      requestedContextTokens: Math.floor(1000 * saturation),
      inputTokens: Math.floor(1000 * saturation),
      outputTokens: 100,
      promptArtifactRef: `prompt-${index}`,
      promptArtifactSha256: sha256(`prompt-${index}`),
      receiptArtifactRef: `receipt-${index}`,
      receiptArtifactSha256: sha256(`receipt-${index}`),
      valid: true,
      measuredLift: lift,
      recordedAt: `2026-08-04T23:0${index}:00.000Z`
    });
    assert.equal(built.status, 'OK', built.message);
    return built.record;
  });
}

test('context observations are receipt-bound and tamper evident', () => {
  const [record] = observations({ saturation: 0.8, lift: 0.1, count: 1 });
  assert.equal(validateContextSaturationObservation(record).status, 'OK');
  assert.equal(validateContextSaturationObservation({
    ...record,
    inputTokens: record.inputTokens + 1
  }).status, 'REFUSED');
});

test('context policy narrows one bounded step only after measured saturation', () => {
  const previous = initial();
  const derived = deriveAdaptiveContextPolicy({
    previousPolicy: previous,
    observations: observations({ saturation: 0.9, lift: 0 }),
    recordedAt: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(derived.status, 'OK', derived.message);
  assert.equal(derived.record.action, 'NARROW');
  assert.equal(derived.record.allocatedInputTokens, 900);
  assert.equal(derived.record.compaction.projectionEligible, true);
  assert.equal(derived.record.compaction.contentDeletionAuthorized, false);
  assert.equal(
    derived.record.permanentControlFraction,
    previous.permanentControlFraction
  );
  assert.equal(validateAdaptiveContextPolicy(derived.record).status, 'OK');
});

test('context policy expands only with headroom and replicated positive lift', () => {
  const derived = deriveAdaptiveContextPolicy({
    previousPolicy: initial(),
    observations: observations({ saturation: 0.4, lift: 0.2 }),
    recordedAt: '2026-08-05T00:10:00.000Z'
  });
  assert.equal(derived.status, 'OK');
  assert.equal(derived.record.action, 'EXPAND');
  assert.equal(derived.record.allocatedInputTokens, 1100);
  assert.equal(derived.record.compaction.projectionEligible, false);
});

test('positive lift retains high-use context and fewer than five observations abstain', () => {
  const retained = deriveAdaptiveContextPolicy({
    previousPolicy: initial(),
    observations: observations({ saturation: 0.9, lift: 0.2 }),
    recordedAt: '2026-08-05T00:20:00.000Z'
  });
  assert.equal(retained.status, 'OK');
  assert.equal(retained.record.action, 'KEEP');
  assert.equal(retained.record.compaction.projectionEligible, false);
  const insufficient = deriveAdaptiveContextPolicy({
    previousPolicy: initial(),
    observations: observations({ saturation: 0.9, lift: 0, count: 4 }),
    recordedAt: '2026-08-05T00:30:00.000Z'
  });
  assert.equal(insufficient.code, 'CONTEXT_POLICY_INSUFFICIENT_EVIDENCE');
});

test('adaptive context policy schema is closed at the root', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/adaptive-context-policy-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'adaptive-context-policy-v1');
  assert.equal(schema.additionalProperties, false);
});
