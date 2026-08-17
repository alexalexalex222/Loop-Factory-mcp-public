import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTER_SCALE_TARGET as TARGET,
  buildScaleCorpus,
  buildScaleEpoch as epoch,
  buildScaleEvidence as evidence
} from '../scripts/lib/mechanism-router-scale-fixture.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import { DEFAULT_ADAPTIVE_POLICY } from '../src/adaptive-policy.mjs';

function route(rows, overrides = {}) {
  return buildMechanismRoutingDecision({
    families: rows.map((row) => row.family),
    applications: rows.map((row) => row.application),
    target: TARGET,
    policyEpoch: epoch(overrides.policy || DEFAULT_ADAPTIVE_POLICY),
    seed: overrides.seed || 'router-scale-seed',
    hypothesisCount: overrides.hypothesisCount || 20,
    mode: 'active-canary',
    ...overrides
  });
}

test('duplicate family records cannot change the candidate pool or routing decision', () => {
  const rows = Array.from({ length: 24 }, (_, index) => evidence(`dedupe-${index}`));
  const clean = route(rows, { hypothesisCount: 10 });
  const duplicated = buildMechanismRoutingDecision({
    families: rows.flatMap((row) => [row.family, row.family, row.family]),
    applications: rows.map((row) => row.application),
    target: TARGET,
    policyEpoch: epoch(),
    seed: 'router-scale-seed',
    hypothesisCount: 10,
    mode: 'active-canary'
  });
  assert.equal(clean.status, 'OK', clean.message);
  assert.equal(duplicated.status, 'OK', duplicated.message);
  assert.deepEqual(duplicated.candidatePool, clean.candidatePool);
  assert.deepEqual(duplicated.capsule, clean.capsule);
  assert.deepEqual(duplicated.decision, clean.decision);
  assert.equal(duplicated.filtered.duplicateFamilies, 48);
});

test('ranked allocations prefer structurally diverse mechanisms before near-clone fallback', () => {
  const rows = [
    evidence('clone-1', { operationKind: 'bind-evidence', interventionKind: 'ordered-gates', qualityDelta: 0.9 }),
    evidence('clone-2', { operationKind: 'bind-evidence', interventionKind: 'ordered-gates', qualityDelta: 0.8 }),
    evidence('clone-3', { operationKind: 'bind-evidence', interventionKind: 'ordered-gates', qualityDelta: 0.7 }),
    evidence('diverse-1', { operationKind: 'replay-receipts', interventionKind: 'receipt-replay', qualityDelta: 0.4 }),
    evidence('diverse-2', { operationKind: 'freeze-frontier', interventionKind: 'frontier-floor', qualityDelta: 0.3 }),
    evidence('diverse-3', { operationKind: 'invert-failure', interventionKind: 'failure-inversion', qualityDelta: 0.2 })
  ];
  const policy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  policy.allocations.related = 0.8;
  policy.allocations.adjacent = 0;
  policy.allocations.failureDerived = 0;
  policy.allocations.wildcard = 0;
  const routed = route(rows, { policy, hypothesisCount: 5, seed: 'diversity-scale-seed' });
  assert.equal(routed.status, 'OK', routed.message);
  const selected = routed.capsule.items.map((item) => item.causalFingerprint);
  assert.equal(selected.length, 4);
  assert.equal(
    new Set(selected.map((fingerprint) => `${fingerprint.interventionKind}|${fingerprint.operationKind}`)).size,
    selected.length
  );
  assert.ok(routed.decision.allocationSchedule
    .filter((item) => item.allocation !== 'control')
    .every((item) => item.reasonCodes.includes('DIVERSITY_PREFERRED')));
});

test('512-family routing is order invariant and preserves selected mechanisms in full', () => {
  const rows = buildScaleCorpus(512);
  const policyEpoch = epoch();
  const input = {
    families: rows.map((row) => row.family),
    applications: rows.map((row) => row.application),
    target: TARGET,
    policyEpoch,
    seed: 'five-hundred-twelve-families',
    hypothesisCount: 20,
    mode: 'active-canary'
  };
  const forward = buildMechanismRoutingDecision(input);
  const reverse = buildMechanismRoutingDecision({
    ...input,
    families: [...input.families].reverse(),
    applications: [...input.applications].reverse()
  });
  assert.equal(forward.status, 'OK', forward.message);
  assert.deepEqual(reverse, forward);
  assert.equal(forward.candidatePool.length, 512);
  assert.equal(new Set(forward.candidatePool.map((item) => item.familyId)).size, 512);

  const authoritative = new Map(rows.map((row) => [row.family.familyId, row.family]));
  for (const selected of forward.capsule.items) {
    const family = authoritative.get(selected.familyId);
    assert.ok(family);
    assert.equal(selected.familySha256, family.familySha256);
    assert.deepEqual(selected.causalFingerprint, family.causalFingerprint);
  }
});
