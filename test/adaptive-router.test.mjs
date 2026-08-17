import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord,
  createMetaPolicyEpochRecord,
  validateAdaptiveRecord
} from '../src/adaptive-records.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import { DEFAULT_ADAPTIVE_POLICY } from '../src/adaptive-policy.mjs';
import { sha256 } from '../src/util.mjs';
import {
  sealVNextOperatorControlProjection,
  VNEXT_OPERATOR_CONTROL_SCHEMA
} from '../src/vnext-operator-control-contract.mjs';

const TARGET = {
  taskMode: 'improve',
  loopRole: 'supervisor',
  taskValueDimensions: ['quality'],
  resourceDimensions: ['token-cost']
};

function epoch(policy = DEFAULT_ADAPTIVE_POLICY, quarantinedFamilyIds = []) {
  const built = createMetaPolicyEpochRecord({
    epochNumber: 0,
    trigger: 'initial',
    previousEpoch: null,
    validApplicationCount: 0,
    evidenceWindowSha256: sha256(canonicalAdaptiveJson({ policy, quarantinedFamilyIds })),
    baselinePolicy: policy,
    policy,
    quarantinedFamilyIds
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function evidence(key, {
  kind = 'related',
  verdict = 'improvement',
  partition = 'harvest',
  transferPassed = true,
  procedureSteps = null,
  program = null
} = {}) {
  const familyResult = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: `${key}-bottleneck`,
      interventionKind: `${key}-intervention`,
      operationKind: `${key}-operation`,
      expectedEffectKind: `${key}-effect`,
      preconditions: ['frozen-benchmark'],
      ...(procedureSteps ? { procedureSteps } : {}),
      ...(program ? { program } : {}),
      applicability: {
        taskModes: kind === 'related' || kind === 'failure' ? ['improve'] : ['audit'],
        loopRoles: kind === 'related' || kind === 'failure' ? ['supervisor'] : ['other'],
        taskValueDimensions: kind === 'adjacent' ? ['quality'] : (kind === 'wildcard' ? ['latency'] : ['quality']),
        resourceDimensions: kind === 'wildcard' || kind === 'adjacent' ? ['wall-time'] : ['token-cost']
      }
    }
  });
  assert.equal(familyResult.status, 'OK');
  const family = familyResult.record;
  const valid = partition === 'harvest';
  const applicationResult = createMechanismApplicationRecord({
    familyId: family.familyId,
    appliedAt: '2026-07-22T22:15:00.000Z',
    partition,
    source: {
      runId: `run-${key}`,
      hypothesisId: `hyp-${key}`,
      testId: `test-${key}`
    },
    context: {
      targetSha256: sha256(`historical-target-${key}`),
      taskMode: kind === 'related' || kind === 'failure' ? 'improve' : 'audit',
      loopRole: kind === 'related' || kind === 'failure' ? 'supervisor' : 'other',
      taskValueDimensions: kind === 'adjacent' ? ['quality'] : (kind === 'wildcard' ? ['latency'] : ['quality']),
      resourceDimensions: kind === 'wildcard' || kind === 'adjacent' ? ['wall-time'] : ['token-cost']
    },
    routing: {
      routingDecisionId: null,
      routingDecisionSha256: null,
      routingPacketSha256: null,
      policyEpochId: null,
      policyEpochSha256: null,
      allocation: null,
      schedulePosition: null
    },
    outcome: {
      verdict,
      valid,
      qualityDelta: verdict === 'improvement' ? 0.2 : 0,
      tokenCostDeltaPct: -0.05,
      shamMovement: 0,
      controlRegressions: transferPassed ? 0 : 1,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: transferPassed,
        evidenceSha256: sha256(`transfer-${key}`)
      }],
      contradictionCodes: transferPassed ? [] : ['FAILED_TRANSFER']
    },
    credit: {
      confidence: 0.8,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256(key).slice(0, 24)}`,
      legacyReceiptSha256: sha256(`legacy-${key}`),
      benchmarkSha256: sha256('benchmark'),
      artifactSetSha256: sha256(`artifacts-${key}`),
      evidenceSetSha256: sha256(`evidence-${key}`)
    }
  });
  assert.equal(applicationResult.status, 'OK', applicationResult.message);
  return { family, application: applicationResult.record };
}

const ROUTER_PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [{
    metricId: 'quality-delta',
    operator: 'subtract',
    leftRole: 'candidate.quality',
    rightRole: 'baseline.quality'
  }],
  rules: [{
    ruleId: 'accept-quality',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

function completeCorpus() {
  const rows = [];
  for (const kind of ['related', 'adjacent', 'wildcard', 'failure']) {
    for (let index = 0; index < 5; index++) {
      rows.push(evidence(`${kind}-${index}`, {
        kind,
        verdict: kind === 'failure' ? 'no_improvement' : 'improvement'
      }));
    }
  }
  return {
    families: rows.map((row) => row.family),
    applications: rows.map((row) => row.application)
  };
}

function operatorControl({ quarantinedFamilyIds = [], shadowOnlyFamilyIds = [] } = {}) {
  return sealVNextOperatorControlProjection({
    schemaVersion: VNEXT_OPERATOR_CONTROL_SCHEMA,
    revision: 1,
    previousProjectionSha256: 'a'.repeat(64),
    actionId: 'operator-control-action',
    actionSha256: 'b'.repeat(64),
    appliedAt: '2026-08-05T00:00:00.000Z',
    disposition: shadowOnlyFamilyIds.length ? 'RELEASED_TO_SHADOW' : 'QUARANTINED',
    quarantinedFamilyIds,
    shadowOnlyFamilyIds,
    policyOverride: null,
    activationAuthorized: false,
    promotionAuthorized: false
  });
}

test('active routing is deterministic, precomputes control, and binds its capsule', () => {
  const corpus = completeCorpus();
  const policyEpoch = epoch();
  const input = {
    ...corpus,
    target: TARGET,
    policyEpoch,
    seed: 'PRIVATE_ROUTING_SEED',
    hypothesisCount: 5,
    mode: 'active-canary'
  };
  const first = buildMechanismRoutingDecision(input);
  const second = buildMechanismRoutingDecision({
    ...input,
    families: [...corpus.families].reverse(),
    applications: [...corpus.applications].reverse()
  });
  assert.equal(first.status, 'OK', first.message);
  assert.deepEqual(first, second);
  assert.equal(first.decision.status, 'COMPLETE');
  assert.equal(first.decision.affectedExecution, true);
  assert.equal(first.decision.allocationSchedule.length, 5);
  assert.ok(first.decision.allocationSchedule.some((item) => item.allocation === 'control'));
  assert.ok(first.decision.allocationSchedule.some((item) => item.allocation !== 'control'));
  assert.equal(
    first.decision.mechanismCapsuleSha256,
    first.capsule.mechanismCapsuleSha256
  );
  assert.equal(validateAdaptiveRecord(first.decision).status, 'OK');
  assert.ok(!canonicalAdaptiveJson(first).includes('PRIVATE_ROUTING_SEED'));
});

test('semantic clones compete once even when descriptive family names differ', () => {
  const first = evidence('semantic-clone-a', { program: ROUTER_PROGRAM });
  const second = evidence('semantic-clone-b', { program: ROUTER_PROGRAM });
  assert.notEqual(first.family.familyId, second.family.familyId);
  const routed = buildMechanismRoutingDecision({
    families: [first.family, second.family],
    applications: [first.application, second.application],
    target: TARGET,
    policyEpoch: epoch(),
    seed: 'semantic-clone-routing',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  assert.equal(routed.candidatePool.length, 1);
  assert.equal(routed.filtered.semanticCloneFamilies, 1);
  assert.match(routed.candidatePool[0].semanticSha256, /^[a-f0-9]{64}$/);
  assert.equal(new Set(routed.capsule.items.map((item) => item.familyId)).size,
    routed.capsule.items.length);
});

test('routed capsules turn ordered procedure evidence into actionable instructions', () => {
  const procedureSteps = [
    'reject-non-tool-measurement',
    'require-reverification',
    'bind-current-artifact',
    'enforce-quality-floor'
  ];
  const row = evidence('ordered-procedure', { procedureSteps });
  const policy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  policy.allocations.related = 0.8;
  policy.allocations.adjacent = 0;
  policy.allocations.failureDerived = 0;
  policy.allocations.wildcard = 0;
  const routed = buildMechanismRoutingDecision({
    families: [row.family],
    applications: [row.application],
    target: TARGET,
    policyEpoch: epoch(policy),
    seed: 'ordered-procedure-seed',
    hypothesisCount: 2,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  const item = routed.capsule.items[0];
  assert.deepEqual(item.causalFingerprint.procedureSteps, procedureSteps);
  assert.match(item.instruction, /Apply this evidence-backed procedure in order/);
  assert.ok(
    item.instruction.indexOf('reject non tool measurement')
      < item.instruction.indexOf('require reverification')
  );
  assert.match(item.instruction, /Map each step to the supplied interface/);
  assert.ok(!canonicalAdaptiveJson(routed.candidatePool).includes('procedureSteps'));
});

test('failure-derived routing is explicitly an inversion, never positive evidence', () => {
  const failurePolicy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  failurePolicy.allocations.related = 0;
  failurePolicy.allocations.adjacent = 0;
  failurePolicy.allocations.failureDerived = 0.8;
  failurePolicy.allocations.wildcard = 0;
  const failures = Array.from({ length: 5 }, (_, index) => evidence(`failure-only-${index}`, {
    kind: 'failure',
    verdict: 'no_improvement'
  }));
  const routed = buildMechanismRoutingDecision({
    families: failures.map((row) => row.family),
    applications: failures.map((row) => row.application),
    target: TARGET,
    policyEpoch: epoch(failurePolicy),
    seed: 'failure-seed',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  const failureItems = routed.capsule.items.filter((item) => item.allocation === 'failure-derived');
  assert.ok(failureItems.length > 0);
  assert.ok(failureItems.every((item) => (
    item.semantics === 'failure-inversion'
    && item.instruction.includes('not positive evidence')
    && item.evidence.verdict === 'no_improvement'
  )));
  assert.ok(routed.decision.allocationSchedule
    .filter((item) => item.allocation === 'failure-derived')
    .every((item) => item.reasonCodes.includes('FAILURE_DERIVED_INVERSION')));
});

test('no evidence produces a control-only abstention without claiming execution influence', () => {
  const routed = buildMechanismRoutingDecision({
    families: [],
    applications: [],
    target: TARGET,
    policyEpoch: epoch(),
    seed: 'empty',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  assert.equal(routed.decision.status, 'ABSTAINED');
  assert.equal(routed.decision.affectedExecution, false);
  assert.equal(routed.capsule.items.length, 0);
  assert.ok(routed.decision.allocationSchedule.every((item) => item.allocation === 'control'));
});

test('gate/reference evidence and quarantined families never enter the candidate pool', () => {
  const harvest = evidence('harvest', { kind: 'related' });
  const gate = evidence('gate', { kind: 'related', partition: 'gate' });
  const quarantined = evidence('quarantined', { kind: 'related' });
  const routed = buildMechanismRoutingDecision({
    families: [harvest.family, gate.family, quarantined.family],
    applications: [harvest.application, gate.application, quarantined.application],
    target: TARGET,
    policyEpoch: epoch(DEFAULT_ADAPTIVE_POLICY, [quarantined.family.familyId]),
    seed: 'partition-firewall',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  assert.deepEqual(
    routed.candidatePool.map((item) => item.familyId),
    [harvest.family.familyId]
  );
  assert.equal(routed.filtered.quarantinedFamilies, 1);
  const json = canonicalAdaptiveJson(routed);
  assert.ok(!json.includes(gate.application.applicationReceiptId));
  assert.ok(!json.includes(quarantined.application.applicationReceiptId));
});

test('operator release permits shadow observation but never active routing', () => {
  const row = evidence('operator-shadow-only', { kind: 'related' });
  const control = operatorControl({
    shadowOnlyFamilyIds: [row.family.familyId]
  });
  const base = {
    families: [row.family],
    applications: [row.application],
    target: TARGET,
    policyEpoch: epoch(),
    operatorControl: control,
    seed: 'operator-control-routing',
    hypothesisCount: 5
  };
  const active = buildMechanismRoutingDecision({ ...base, mode: 'active-canary' });
  const shadow = buildMechanismRoutingDecision({ ...base, mode: 'shadow' });
  assert.equal(active.status, 'OK');
  assert.deepEqual(active.candidatePool, []);
  assert.equal(active.filtered.shadowOnlyFamilies, 1);
  assert.equal(active.capsule.operatorControlSha256, control.projectionSha256);
  assert.equal(shadow.status, 'OK');
  assert.deepEqual(shadow.candidatePool.map((candidate) => candidate.familyId), [
    row.family.familyId
  ]);
  assert.equal(shadow.capsule.operatorControlSha256, control.projectionSha256);
  assert.notEqual(active.decision.routingDecisionId, shadow.decision.routingDecisionId);
});

test('shadow decisions select the same evidence but remain observational', () => {
  const corpus = completeCorpus();
  const policyEpoch = epoch();
  const active = buildMechanismRoutingDecision({
    ...corpus,
    target: TARGET,
    policyEpoch,
    seed: 'same-route',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  const shadow = buildMechanismRoutingDecision({
    ...corpus,
    target: TARGET,
    policyEpoch,
    seed: 'same-route',
    hypothesisCount: 5,
    mode: 'shadow'
  });
  assert.equal(shadow.status, 'OK');
  assert.equal(shadow.decision.affectedExecution, false);
  assert.deepEqual(
    shadow.decision.allocationSchedule,
    active.decision.allocationSchedule
  );
  assert.notEqual(shadow.decision.routingDecisionId, active.decision.routingDecisionId);
});

test('wildcard selection is seeded, replayable, and records probability', () => {
  const wildcardPolicy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  wildcardPolicy.allocations.related = 0;
  wildcardPolicy.allocations.adjacent = 0;
  wildcardPolicy.allocations.failureDerived = 0;
  wildcardPolicy.allocations.wildcard = 0.8;
  const rows = Array.from({ length: 8 }, (_, index) => evidence(`wildcard-only-${index}`, {
    kind: 'wildcard'
  }));
  const base = {
    families: rows.map((row) => row.family),
    applications: rows.map((row) => row.application),
    target: TARGET,
    policyEpoch: epoch(wildcardPolicy),
    hypothesisCount: 2,
    mode: 'active-canary'
  };
  const first = buildMechanismRoutingDecision({ ...base, seed: 'wild-seed-a' });
  const replay = buildMechanismRoutingDecision({ ...base, seed: 'wild-seed-a' });
  assert.deepEqual(first, replay);
  const selected = first.decision.allocationSchedule.find((item) => item.allocation === 'wildcard');
  assert.ok(selected);
  assert.ok(selected.probability > 0 && selected.probability <= 0.8);

  const ids = new Set();
  for (let index = 0; index < 20; index++) {
    const result = buildMechanismRoutingDecision({ ...base, seed: `wild-seed-${index}` });
    const item = result.decision.allocationSchedule.find((row) => row.allocation === 'wildcard');
    if (item) ids.add(item.familyId);
  }
  assert.ok(ids.size > 1);
});

test('target changes alter the decision and candidate-pool tampering is filtered', () => {
  const corpus = completeCorpus();
  const tampered = structuredClone(corpus.applications[0]);
  tampered.outcome.qualityDelta = 999;
  const policyEpoch = epoch();
  const first = buildMechanismRoutingDecision({
    families: corpus.families,
    applications: [...corpus.applications, tampered],
    target: TARGET,
    policyEpoch,
    seed: 'target',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  const changed = buildMechanismRoutingDecision({
    families: corpus.families,
    applications: corpus.applications,
    target: { ...TARGET, taskMode: 'audit' },
    policyEpoch,
    seed: 'target',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(first.status, 'OK');
  assert.equal(first.filtered.validHarvestApplications, corpus.applications.length);
  assert.notEqual(first.decision.targetSha256, changed.decision.targetSha256);
  assert.notEqual(first.decision.routingDecisionId, changed.decision.routingDecisionId);
});
