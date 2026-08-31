import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  createAutomaticPromotionDecisionRecord,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord,
  createMetaPolicyEpochRecord,
  createRoutingDecisionRecord,
  isCausallyAdmittedApplication,
  normalizeCausalFingerprint,
  selectLatestApplicationRevisions,
  validateAdaptiveRecord
} from '../src/adaptive-records.mjs';
import { sha256 } from '../src/util.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const CLOCK = '2026-07-22T21:55:00.000Z';

const BASE_POLICY = {
  allocations: {
    control: 0.2,
    related: 0.35,
    adjacent: 0.15,
    failureDerived: 0.15,
    wildcard: 0.15
  },
  scoring: {
    relevanceWeight: 0.6,
    confidenceWeight: 0.25,
    positiveEffectWeight: 0.15,
    contradictionPenaltyWeight: 1
  },
  penalties: {
    cooldown: 0.1,
    failedTransfer: 0.2
  }
};

function family() {
  const built = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'missing-evidence-binding',
      interventionKind: 'bind-artifacts-before-scoring',
      operationKind: 'hash-bound-verification',
      expectedEffectKind: 'fewer-false-promotions',
      preconditions: ['deterministic-oracle', 'persisted-artifacts'],
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['loop-de-loop'],
        taskValueDimensions: ['evidence-quality'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function initialEpoch() {
  const built = createMetaPolicyEpochRecord({
    epochNumber: 0,
    trigger: 'initial',
    previousEpoch: null,
    baselinePolicy: BASE_POLICY,
    policy: BASE_POLICY,
    validApplicationCount: 0,
    evidenceWindowSha256: SHA_A
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function application(overrides = {}) {
  const familyRecord = family();
  const base = {
    familyId: familyRecord.familyId,
    appliedAt: CLOCK,
    partition: 'harvest',
    source: {
      runId: 'run-001',
      hypothesisId: 'hyp-001',
      testId: 'test-001'
    },
    context: {
      targetSha256: SHA_A,
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['evidence-quality'],
      resourceDimensions: ['token-cost']
    },
    routing: {
      routingDecisionId: null,
      routingPacketSha256: null,
      policyEpochId: null,
      policyEpochSha256: null
    },
    outcome: {
      verdict: 'improvement',
      valid: true,
      qualityDelta: 0.2,
      tokenCostDeltaPct: -0.1,
      shamMovement: null,
      controlRegressions: 0,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: SHA_B
      }],
      contradictionCodes: []
    },
    credit: {
      confidence: 0.9,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: 'receipt-000000000000000000000001',
      legacyReceiptSha256: SHA_C,
      benchmarkSha256: SHA_D,
      artifactSetSha256: SHA_A,
      evidenceSetSha256: SHA_B
    }
  };
  const built = createMechanismApplicationRecord({
    ...base,
    ...overrides,
    source: { ...base.source, ...overrides.source },
    context: { ...base.context, ...overrides.context },
    routing: { ...base.routing, ...overrides.routing },
    outcome: { ...base.outcome, ...overrides.outcome },
    credit: { ...base.credit, ...overrides.credit },
    provenance: { ...base.provenance, ...overrides.provenance }
  });
  return built;
}

test('all immutable schema files parse with closed top-level shapes', () => {
  const files = [
    ['mechanism-family-v1.schema.json', ADAPTIVE_SCHEMA.FAMILY],
    ['mechanism-application-v1.schema.json', ADAPTIVE_SCHEMA.APPLICATION],
    ['adaptive-canary-import-v1.schema.json', ADAPTIVE_SCHEMA.CANARY_IMPORT],
    ['adaptive-measurement-v2.schema.json', ADAPTIVE_SCHEMA.MEASUREMENT],
    ['mechanism-evolution-v1.schema.json', ADAPTIVE_SCHEMA.EVOLUTION],
    ['routing-decision-v1.schema.json', ADAPTIVE_SCHEMA.ROUTING_DECISION],
    ['meta-policy-epoch-v1.schema.json', ADAPTIVE_SCHEMA.POLICY_EPOCH],
    ['automatic-promotion-decision-v1.schema.json', ADAPTIVE_SCHEMA.AUTO_PROMOTION]
  ];
  for (const [filename, schemaVersion] of files) {
    const schema = JSON.parse(readFileSync(
      new URL(`../src/schemas/${filename}`, import.meta.url),
      'utf8'
    ));
    assert.equal(schema.$id, schemaVersion);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes('schemaVersion'));
  }
});

test('family identity is canonical, order-independent, and excludes attempt identity', () => {
  const first = family();
  const normalized = normalizeCausalFingerprint({
    runId: 'ignored-run',
    hypothesisId: 'ignored-hypothesis',
    causalFingerprint: {
      expectedEffectKind: 'fewer-false-promotions',
      operationKind: 'hash-bound-verification',
      interventionKind: 'bind-artifacts-before-scoring',
      bottleneckKind: 'missing-evidence-binding',
      preconditions: ['persisted-artifacts', 'deterministic-oracle'],
      applicability: {
        resourceDimensions: ['token-cost'],
        taskValueDimensions: ['evidence-quality'],
        loopRoles: ['loop-de-loop'],
        taskModes: ['improve']
      }
    }
  });
  assert.equal(normalized.status, 'OK');
  const second = createMechanismFamilyRecord({
    causalFingerprint: normalized.fingerprint
  });
  assert.equal(second.status, 'OK');
  assert.deepEqual(second.record, first);
  assert.equal(validateAdaptiveRecord(first).status, 'OK');

  const tampered = structuredClone(first);
  tampered.causalFingerprint.operationKind = 'trust-worker-summary';
  assert.equal(validateAdaptiveRecord(tampered).status, 'REFUSED');
});

test('ordered procedure steps are identity-bound while legacy families remain valid', () => {
  const legacy = family();
  assert.equal(Object.hasOwn(legacy.causalFingerprint, 'procedureSteps'), false);
  assert.equal(validateAdaptiveRecord(legacy).status, 'OK');

  const build = (procedureSteps) => createMechanismFamilyRecord({
    causalFingerprint: {
      ...legacy.causalFingerprint,
      procedureSteps
    }
  });
  const ordered = build([
    'reject-untrusted-measurement',
    'bind-current-artifact',
    'require-reverification'
  ]);
  const reordered = build([
    'bind-current-artifact',
    'reject-untrusted-measurement',
    'require-reverification'
  ]);
  assert.equal(ordered.status, 'OK', ordered.message);
  assert.equal(reordered.status, 'OK', reordered.message);
  assert.deepEqual(ordered.record.causalFingerprint.procedureSteps, [
    'reject-untrusted-measurement',
    'bind-current-artifact',
    'require-reverification'
  ]);
  assert.notEqual(ordered.record.familyId, reordered.record.familyId);
  assert.equal(validateAdaptiveRecord(ordered.record).status, 'OK');

  const duplicate = build([
    'bind-current-artifact',
    'bind-current-artifact'
  ]);
  assert.equal(duplicate.status, 'REFUSED');
  assert.equal(duplicate.code, 'INVALID_CAUSAL_FINGERPRINT');
});

test('executable programs are identity-bound while programless families remain valid', () => {
  const legacy = family();
  const program = {
    schemaVersion: 'mechanism-program-v1',
    bindingPolicy: 'closed-world',
    roles: ['candidate.id'],
    selectors: [],
    bindings: [],
    forbiddenBindings: [],
    metrics: [],
    rules: [{
      ruleId: 'reject-unbound-candidate',
      kind: 'guard',
      exceptionOf: null,
      when: {
        operator: 'equal',
        left: { kind: 'role', id: 'candidate.id' },
        right: { kind: 'literal', value: '' }
      },
      emit: { decision: 'REJECT', code: 'CANDIDATE_ID_MISSING' }
    }],
    fallback: { decision: 'REJECT', code: 'NO_MEASURED_GAIN' }
  };
  const executable = createMechanismFamilyRecord({
    causalFingerprint: {
      ...legacy.causalFingerprint,
      program
    }
  });

  assert.equal(executable.status, 'OK', executable.message);
  assert.deepEqual(executable.record.causalFingerprint.program, program);
  assert.notEqual(executable.record.familyId, legacy.familyId);
  assert.equal(validateAdaptiveRecord(executable.record).status, 'OK');
  assert.equal(validateAdaptiveRecord(legacy).status, 'OK');

  const malformed = createMechanismFamilyRecord({
    causalFingerprint: {
      ...legacy.causalFingerprint,
      program: { ...program, bindingPolicy: 'guess-missing-roles' }
    }
  });
  assert.equal(malformed.status, 'REFUSED');
  assert.equal(malformed.code, 'INVALID_CAUSAL_FINGERPRINT');
});

test('application revisions share attempt identity while preserving null evidence', () => {
  const observed = application({
    appliedAt: '2026-07-22T21:54:00.000Z',
    outcome: {
      reverified: false,
      shamMovement: '',
      transferChecks: []
    }
  });
  const reverified = application({
    appliedAt: '2026-07-22T21:55:00.000Z'
  });
  assert.equal(observed.status, 'OK', observed.message);
  assert.equal(reverified.status, 'OK', reverified.message);
  assert.equal(observed.record.applicationId, reverified.record.applicationId);
  assert.notEqual(observed.record.applicationReceiptId, reverified.record.applicationReceiptId);
  assert.equal(observed.record.outcome.shamMovement, null);
  assert.equal(validateAdaptiveRecord(observed.record).status, 'OK');
  assert.equal(validateAdaptiveRecord(reverified.record).status, 'OK');
});

test('semantic revision selection never lets receipt hash order hide later controls', () => {
  const initial = application({
    appliedAt: '2026-07-22T21:54:00.000Z',
    outcome: {
      shamMovement: null,
      controlRegressions: null,
      transferChecks: []
    }
  });
  const controlled = application({
    appliedAt: '2026-07-22T21:55:00.000Z',
    outcome: {
      shamMovement: 0,
      controlRegressions: 0
    }
  });
  assert.equal(initial.status, 'OK');
  assert.equal(controlled.status, 'OK');
  const selected = selectLatestApplicationRevisions([
    controlled.record,
    initial.record
  ]);
  assert.equal(selected.status, 'OK', selected.message);
  assert.equal(selected.applications.length, 1);
  assert.equal(
    selected.applications[0].applicationReceiptId,
    controlled.record.applicationReceiptId
  );
  assert.equal(isCausallyAdmittedApplication(initial.record), false);
  assert.equal(isCausallyAdmittedApplication(controlled.record), true);
});

test('equally authoritative conflicting application revisions fail closed', () => {
  const left = application({ outcome: { qualityDelta: 0.2 } });
  const right = application({ outcome: { qualityDelta: 0.3 } });
  assert.equal(left.status, 'OK');
  assert.equal(right.status, 'OK');
  const selected = selectLatestApplicationRevisions([left.record, right.record]);
  assert.equal(selected.status, 'REFUSED');
  assert.equal(selected.code, 'APPLICATION_REVISION_CONFLICT');
});

test('positive and failure-derived credit cannot invert measured evidence', () => {
  const regressed = application({
    outcome: {
      verdict: 'improvement',
      controlRegressions: 1,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: false,
        evidenceSha256: SHA_B
      }]
    }
  });
  assert.equal(regressed.status, 'OK', regressed.message);
  assert.equal(regressed.record.credit.positiveEvidence, false);
  assert.equal(regressed.record.credit.failureDerived, true);

  const shamConfounded = application({
    outcome: {
      verdict: 'improvement',
      shamMovement: 0.1,
      contradictionCodes: ['POSITIVE_SHAM_MOVEMENT']
    }
  });
  assert.equal(shamConfounded.status, 'OK', shamConfounded.message);
  assert.equal(shamConfounded.record.credit.positiveEvidence, false);
  assert.equal(shamConfounded.record.credit.failureDerived, true);

  const invalid = application({
    outcome: {
      verdict: 'invalid',
      valid: false
    }
  });
  assert.equal(invalid.status, 'OK', invalid.message);
  assert.equal(invalid.record.credit.positiveEvidence, false);
  assert.equal(invalid.record.credit.failureDerived, false);
});

test('eligible harvest applications require complete supervisor evidence hashes', () => {
  const missing = application({
    provenance: {
      legacyReceiptId: null,
      legacyReceiptSha256: null,
      benchmarkSha256: null,
      artifactSetSha256: null,
      evidenceSetSha256: null
    }
  });
  assert.equal(missing.status, 'REFUSED');
  assert.equal(missing.code, 'INCOMPLETE_APPLICATION_PROVENANCE');

  const gate = application({ partition: 'gate' });
  assert.equal(gate.status, 'OK');
  assert.equal(gate.record.eligibleForRouting, false);
});

test('active routing requires a permanent no-memory control allocation', () => {
  const epoch = initialEpoch();
  const familyRecord = family();
  const withoutControl = createRoutingDecisionRecord({
    mode: 'active-canary',
    status: 'COMPLETE',
    targetSha256: SHA_A,
    candidatePoolSha256: SHA_B,
    candidatePoolCount: 1,
    policyEpochId: epoch.policyEpochId,
    policyEpochSha256: epoch.policyEpochSha256,
    seed: 'routing-seed',
    abstentionCode: null,
    allocationSchedule: [{
      allocation: 'related',
      familyId: familyRecord.familyId,
      applicationReceiptId: application().record.applicationReceiptId,
      probability: 1,
      evidenceStrength: 0.9,
      reasonCodes: ['RELATED_EVIDENCE']
    }]
  });
  assert.equal(withoutControl.status, 'REFUSED');
  assert.equal(withoutControl.code, 'CONTROL_ALLOCATION_REQUIRED');

  const withControl = createRoutingDecisionRecord({
    mode: 'active-canary',
    status: 'COMPLETE',
    targetSha256: SHA_A,
    candidatePoolSha256: SHA_B,
    candidatePoolCount: 1,
    policyEpochId: epoch.policyEpochId,
    policyEpochSha256: epoch.policyEpochSha256,
    seed: 'routing-seed',
    abstentionCode: null,
    allocationSchedule: [
      {
        allocation: 'control',
        familyId: null,
        applicationReceiptId: null,
        probability: 0.2,
        evidenceStrength: null,
        reasonCodes: ['NO_MEMORY_CONTROL']
      },
      {
        allocation: 'related',
        familyId: familyRecord.familyId,
        applicationReceiptId: application().record.applicationReceiptId,
        probability: 0.8,
        evidenceStrength: 0.9,
        reasonCodes: ['RELATED_EVIDENCE']
      }
    ]
  });
  assert.equal(withControl.status, 'OK', withControl.message);
  assert.equal(withControl.record.affectedExecution, true);
  assert.equal(validateAdaptiveRecord(withControl.record).status, 'OK');
});

test('policy epochs enforce the hash chain, five-attempt window, and immutable control share', () => {
  const epoch0 = initialEpoch();
  const tooSoon = createMetaPolicyEpochRecord({
    epochNumber: 1,
    trigger: 'valid-attempt-window',
    previousEpoch: epoch0,
    baselinePolicy: BASE_POLICY,
    policy: BASE_POLICY,
    validApplicationCount: 4,
    evidenceWindowSha256: SHA_B
  });
  assert.equal(tooSoon.code, 'POLICY_WINDOW_TOO_SMALL');

  const movedControl = structuredClone(BASE_POLICY);
  movedControl.allocations.control = 0.25;
  movedControl.allocations.related = 0.3;
  const hiddenControlChange = createMetaPolicyEpochRecord({
    epochNumber: 1,
    trigger: 'valid-attempt-window',
    previousEpoch: epoch0,
    baselinePolicy: BASE_POLICY,
    policy: movedControl,
    validApplicationCount: 5,
    evidenceWindowSha256: SHA_B
  });
  assert.equal(hiddenControlChange.status, 'REFUSED');
  assert.equal(hiddenControlChange.code, 'CONTROL_ALLOCATION_IMMUTABLE');

  const tamperedPrevious = {
    ...epoch0,
    policyEpochSha256: SHA_D
  };
  const brokenChain = createMetaPolicyEpochRecord({
    epochNumber: 1,
    trigger: 'lane-boundary',
    previousEpoch: tamperedPrevious,
    baselinePolicy: BASE_POLICY,
    policy: BASE_POLICY,
    validApplicationCount: 0,
    evidenceWindowSha256: SHA_C
  });
  assert.equal(brokenChain.status, 'REFUSED');
  assert.equal(brokenChain.code, 'INVALID_POLICY_CHAIN');
});

test('automatic internal promotion fails closed on malformed or failed gates', () => {
  const base = {
    source: {
      runId: 'run-001',
      hypothesisId: 'hyp-001',
      testId: 'test-001'
    },
    evidence: {
      benchmarkSha256: SHA_A,
      baselineSha256: SHA_B,
      challengerSha256: SHA_C,
      qualityAuthority: 'tool-computed',
      deterministicOracle: true,
      reverified: true,
      qualityDelta: 0.2,
      tokenCostDeltaPct: -0.1,
      controlRegressions: 0,
      fixtureOnly: false
    },
    routing: {
      routingDecisionId: null,
      routingDecisionSha256: null,
      policyEpochId: null,
      policyEpochSha256: null
    }
  };
  const eligible = createAutomaticPromotionDecisionRecord({
    ...base,
    gates: [
      { code: 'INTEGRITY', passed: true, evidenceSha256: SHA_D },
      { code: 'COST', passed: true, evidenceSha256: SHA_A }
    ]
  });
  assert.equal(eligible.status, 'OK', eligible.message);
  assert.equal(eligible.record.disposition, 'AUTO_BANK_INTERNAL');
  assert.equal(eligible.record.canonicalChange, false);
  assert.equal(validateAdaptiveRecord(eligible.record).status, 'OK');

  const malformed = createAutomaticPromotionDecisionRecord({
    ...base,
    gates: [
      { code: 'INTEGRITY', passed: true, evidenceSha256: SHA_D },
      { code: 'not valid!', passed: true, evidenceSha256: SHA_A }
    ]
  });
  assert.equal(malformed.status, 'REFUSED');
  assert.equal(malformed.code, 'INVALID_PROMOTION_GATE');

  const failed = createAutomaticPromotionDecisionRecord({
    ...base,
    gates: [{ code: 'INTEGRITY', passed: false, evidenceSha256: SHA_D }]
  });
  assert.equal(failed.status, 'OK');
  assert.equal(failed.record.disposition, 'QUEUE_HUMAN_REVIEW');
  assert.equal(failed.record.promotionAuthorized, false);
});

test('automatic promotion refuses a passed gate without a persisted evidence hash', () => {
  const built = createAutomaticPromotionDecisionRecord({
    source: {
      runId: 'run-001',
      hypothesisId: 'hyp-001',
      testId: 'test-001'
    },
    evidence: {
      benchmarkSha256: SHA_A,
      baselineSha256: SHA_B,
      challengerSha256: SHA_C,
      qualityAuthority: 'tool-computed',
      deterministicOracle: true,
      reverified: true,
      qualityDelta: 0.2,
      tokenCostDeltaPct: -0.1,
      controlRegressions: 0,
      fixtureOnly: false
    },
    routing: {
      routingDecisionId: null,
      routingDecisionSha256: null,
      policyEpochId: null,
      policyEpochSha256: null
    },
    gates: [{ code: 'INTEGRITY', passed: true, evidenceSha256: null }]
  });
  assert.equal(built.status, 'OK');
  assert.equal(built.record.eligible, false);
  assert.equal(built.record.disposition, 'QUEUE_HUMAN_REVIEW');
  assert.ok(built.record.reasonCodes.some((code) => code.endsWith('_UNBOUND')));
});

test('canonical encoding keeps null distinct from zero', () => {
  assert.notEqual(
    sha256(canonicalAdaptiveJson({ value: null })),
    sha256(canonicalAdaptiveJson({ value: 0 }))
  );
});
