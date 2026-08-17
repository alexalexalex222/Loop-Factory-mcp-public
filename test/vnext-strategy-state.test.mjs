import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/util.mjs';
import {
  buildVNextStrategyStateBundle,
  validateVNextStrategyStateBundle
} from '../src/vnext-strategy-state.mjs';

const NOW = '2026-08-05T04:00:00.000Z';

function snapshot({
  id,
  family,
  kind,
  quality,
  tokens,
  regressions = 0,
  value
}) {
  return {
    recordId: id,
    recordSha256: sha256(`${id}:record`),
    availableAt: '2026-08-05T03:00:00.000Z',
    kind,
    lifecycle: kind === 'regression' ? 'contradicted' : 'replicated',
    qualityDelta: quality,
    tokenCost: tokens,
    regressions,
    candidateFamilyId: family,
    component: 'mechanism-program',
    strategy: 'native',
    hypothesis: `Hypothesis grounded by ${id}.`,
    operations: [{
      op: 'replace',
      target: 'mechanism-program/fallback',
      beforeSha256: 'a'.repeat(64),
      value
    }],
    tags: ['admission', 'mechanism-program', 'quality'],
    proofEvidenceSha256: sha256(`${id}:proof`)
  };
}

const SUCCESS_A = snapshot({
  id: 'evidence-success-a',
  family: 'family-success-a',
  kind: 'positive',
  quality: 0.3,
  tokens: 1000,
  value: '{"decision":"ACCEPT","code":"EXACT_A"}'
});
const SUCCESS_B = snapshot({
  id: 'evidence-success-b',
  family: 'family-success-b',
  kind: 'positive',
  quality: 0.2,
  tokens: 900,
  value: '{"decision":"ACCEPT","code":"EXACT_B"}'
});
const FAILURE = snapshot({
  id: 'evidence-failure',
  family: 'family-failure',
  kind: 'no-improvement',
  quality: 0,
  tokens: 800,
  value: '{"decision":"REJECT","code":"NO_GAIN"}'
});

test('actual positive and negative snapshots compile all three strategy states', () => {
  const built = buildVNextStrategyStateBundle({
    snapshots: [SUCCESS_A, SUCCESS_B, FAILURE],
    decisionAt: NOW
  });
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.bundle.states['reflective-pareto'].ready, true);
  assert.equal(built.bundle.states['bounded-skill'].ready, true);
  assert.equal(built.bundle.states['bank-recombination'].ready, true);
  assert.equal(
    built.bundle.states['reflective-pareto'].state.trajectories.length,
    3
  );
  assert.equal(
    built.bundle.states['bank-recombination'].state.mechanisms.length,
    2
  );
  assert.equal(validateVNextStrategyStateBundle(built.bundle).status, 'OK');
});

test('missing evidence classes cause explicit abstention instead of synthetic history', () => {
  const successesOnly = buildVNextStrategyStateBundle({
    snapshots: [SUCCESS_A, SUCCESS_B],
    decisionAt: NOW
  }).bundle;
  assert.equal(successesOnly.states['reflective-pareto'].ready, false);
  assert.equal(successesOnly.states['bounded-skill'].ready, false);
  assert.equal(successesOnly.states['bank-recombination'].ready, true);

  const oneSuccess = buildVNextStrategyStateBundle({
    snapshots: [SUCCESS_A, FAILURE],
    decisionAt: NOW
  }).bundle;
  assert.equal(oneSuccess.states['reflective-pareto'].ready, true);
  assert.equal(oneSuccess.states['bounded-skill'].ready, true);
  assert.equal(oneSuccess.states['bank-recombination'].ready, false);
});

test('future snapshots and hash-resealed state drift fail closed', () => {
  assert.equal(buildVNextStrategyStateBundle({
    snapshots: [{ ...SUCCESS_A, availableAt: '2026-08-06T00:00:00.000Z' }],
    decisionAt: NOW
  }).status, 'REFUSED');
  const built = buildVNextStrategyStateBundle({
    snapshots: [SUCCESS_A, SUCCESS_B, FAILURE],
    decisionAt: NOW
  });
  const changed = structuredClone(built.bundle);
  changed.states['bounded-skill'].state.limits.maximumChangedItems = 2;
  assert.equal(validateVNextStrategyStateBundle(changed).status, 'REFUSED');
});
