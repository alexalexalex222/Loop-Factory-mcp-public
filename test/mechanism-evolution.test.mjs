import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptiveMeasurementRecord } from '../src/adaptive-measurement-v2.mjs';
import {
  ADAPTIVE_SCHEMA,
  createMechanismFamilyRecord,
  validateAdaptiveRecord
} from '../src/adaptive-records.mjs';
import {
  activateMechanismEvolution,
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution,
  rejectMechanismEvolution,
  verifyMechanismEvolution
} from '../src/mechanism-evolution.mjs';
import {
  selectLatestMechanismEvolutionRecords,
  validateMechanismEvolutionRecord
} from '../src/mechanism-evolution-records.mjs';
import { canonicalMechanismProgramJson, normalizeMechanismProgram } from '../src/mechanism-compiler.mjs';
import { createMechanismMutationPlan } from '../src/mechanism-mutation.mjs';
import {
  listAdaptiveRecords,
  persistAdaptiveRecord
} from '../src/mechanism-catalog.mjs';
import { sha256 } from '../src/util.mjs';

const CLOCKS = [
  '2026-08-03T18:00:00.000Z',
  '2026-08-03T18:01:00.000Z',
  '2026-08-03T18:02:00.000Z',
  '2026-08-03T18:03:00.000Z'
];

const PROGRAM = {
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

const INTERFACE = {
  schemaVersion: 'executable-interface-contract-v2',
  exportName: 'decide',
  inputPaths: ['baseline.quality', 'candidate.quality'],
  decisions: ['ACCEPT', 'REJECT'],
  codes: [{ value: 'QUALITY_GAIN', meaning: 'Quality increased.' }, {
    value: 'NO_GAIN', meaning: 'Quality did not increase.'
  }, {
    value: 'MANUAL_REVIEW', meaning: 'The unresolved case needs review.'
  }],
  roleBindings: [{ role: 'baseline.quality', path: 'baseline.quality' }, {
    role: 'candidate.quality', path: 'candidate.quality'
  }]
};

function parentFamily() {
  const built = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback',
      interventionKind: 'evidence-bound-fallback',
      operationKind: 'bounded-program-mutation',
      expectedEffectKind: 'more-exact-dispositions',
      preconditions: ['paired-measurement', 'sealed-cases'],
      procedureSteps: ['measure-failure', 'mutate-one-rule', 'verify-disjoint'],
      program: PROGRAM,
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['exactness'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function evaluation(taskId, armId, passes, tokenCost = 100) {
  const cases = [
    ['target-a', 'target'],
    ['target-b', 'target'],
    ['target-c', 'target'],
    ['control-a', 'control']
  ];
  return {
    evaluationArtifactRef: `${taskId}-${armId}-evaluation`,
    evaluationArtifactSha256: sha256(`${taskId}:${armId}:evaluation`),
    tokenCost,
    results: cases.map(([id, group], index) => ({
      id: `${taskId}-${id}`,
      group,
      pass: passes[index],
      decisionPass: passes[index],
      codePass: passes[index]
    }))
  };
}

function measurement({
  runId,
  profile,
  armRoles,
  mechanismBindings,
  patterns
}) {
  const tasks = ['task-a', 'task-b'].map((taskId, taskIndex) => ({
    taskId,
    arms: Object.fromEntries(Object.entries(patterns).map(([armId, passes], armIndex) => [
      armId,
      evaluation(taskId, armId, passes, 100 + taskIndex + (armIndex * 10))
    ]))
  }));
  const built = createAdaptiveMeasurementRecord({
    source: {
      kind: profile === 'recursive-causal-v1'
        ? 'recursive-executable-canary-v1'
        : 'adaptive-executable-canary-v4',
      runId,
      verifierEvidenceSha256: sha256(`${runId}:verifier`),
      evaluatorAuthoritySha256: sha256(`${runId}:evaluator`),
      caseSetSha256: sha256(`${runId}:cases`)
    },
    profile,
    armRoles,
    mechanismBindings,
    tasks
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function fixture() {
  const parent = parentFamily();
  const normalized = normalizeMechanismProgram(PROGRAM);
  const sourceMeasurement = measurement({
    runId: 'source-measurement-run',
    profile: 'retrieval-causal-v1',
    armRoles: {
      baseline: 'baseline',
      parent: null,
      sham: 'sham',
      treatment: 'routed'
    },
    mechanismBindings: {
      baseline: null,
      parent: null,
      sham: null,
      treatment: normalized.programSha256
    },
    patterns: {
      baseline: [false, true, false, true],
      routed: [true, true, true, true],
      sham: [false, true, false, true]
    }
  });
  const plan = createMechanismMutationPlan({
    parent: {
      familyId: parent.familyId,
      familySha256: parent.familySha256,
      programSha256: normalized.programSha256
    },
    objective: {
      measurementId: sourceMeasurement.measurementId,
      measurementSha256: sourceMeasurement.measurementSha256,
      failureCaseSetSha256: sha256('source-failures'),
      successCaseSetSha256: sha256('source-successes'),
      targetMetric: 'exact-case-rate',
      direction: 'increase'
    },
    operations: [{
      action: 'replace',
      collection: 'fallback',
      expectedItemSha256: sha256(canonicalMechanismProgramJson(PROGRAM.fallback)),
      insertBeforeRuleId: null,
      value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
    }],
    reasonCodes: ['FAILED_FALLBACK_DISPOSITION'],
    expectedEffectCode: 'MORE_EXACT_CASES'
  });
  assert.equal(plan.status, 'OK', plan.message);
  const proposed = proposeMechanismEvolution({
    parentFamily: parent,
    mutationPlan: plan.plan,
    recordedAt: CLOCKS[0]
  });
  assert.equal(proposed.status, 'OK', proposed.message);
  return { parent, sourceMeasurement, plan: plan.plan, proposed };
}

test('bounded descendants advance through proposed, shadow, verified, and routing-only active states', () => {
  const { parent, proposed } = fixture();
  assert.equal(validateMechanismEvolutionRecord(proposed.record).status, 'OK');
  assert.equal(validateAdaptiveRecord(proposed.record).status, 'OK');
  assert.equal(proposed.record.state, 'PROPOSED');
  assert.notEqual(proposed.candidateFamily.familyId, parent.familyId);
  assert.equal(proposed.record.authority.promotionAuthorized, false);

  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [INTERFACE],
    recordedAt: CLOCKS[1]
  });
  assert.equal(shadow.status, 'OK', shadow.message);
  assert.equal(shadow.record.state, 'SHADOW');
  assert.equal(shadow.treatmentDelta.identifiable, true);

  const verificationMeasurement = measurement({
    runId: 'recursive-verification-run',
    profile: 'recursive-causal-v1',
    armRoles: {
      baseline: 'cold',
      parent: 'parent',
      sham: 'sham',
      treatment: 'candidate'
    },
    mechanismBindings: {
      baseline: null,
      parent: shadow.record.parent.programSha256,
      sham: null,
      treatment: shadow.record.candidate.programSha256
    },
    patterns: {
      candidate: [true, true, true, true],
      cold: [false, true, false, true],
      parent: [true, true, false, true],
      sham: [false, true, false, true]
    }
  });
  const verified = verifyMechanismEvolution({
    currentRecord: shadow.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    measurementRecord: verificationMeasurement,
    verifierEvidenceSha256: verificationMeasurement.source.verifierEvidenceSha256,
    recordedAt: CLOCKS[2]
  });
  assert.equal(verified.status, 'OK', verified.message);
  assert.equal(verified.record.state, 'VERIFIED');
  assert.equal(verified.record.outcome.exactVsBaselineDelta, 0.5);
  assert.equal(verified.record.outcome.exactVsParentDelta, 0.25);
  assert.equal(verified.record.outcome.controlRegressions, 0);

  const active = activateMechanismEvolution({
    currentRecord: verified.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    activationEvidenceSha256: sha256('active-canary-allocation'),
    recordedAt: CLOCKS[3]
  });
  assert.equal(active.status, 'OK', active.message);
  assert.equal(active.record.state, 'ACTIVE');
  assert.equal(active.record.authority.activation, 'routing-only');
  assert.equal(active.record.authority.promotionAuthorized, false);

  const latest = selectLatestMechanismEvolutionRecords([
    verified.record,
    proposed.record,
    active.record,
    shadow.record
  ]);
  assert.equal(latest.status, 'OK', latest.message);
  assert.equal(latest.records.length, 1);
  assert.equal(latest.records[0].state, 'ACTIVE');
});

test('verification refuses a valid scorecard bound to the wrong candidate program', () => {
  const { parent, proposed } = fixture();
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [INTERFACE],
    recordedAt: CLOCKS[1]
  });
  const wrongMeasurement = measurement({
    runId: 'wrong-candidate-run',
    profile: 'recursive-causal-v1',
    armRoles: {
      baseline: 'cold',
      parent: 'parent',
      sham: 'sham',
      treatment: 'candidate'
    },
    mechanismBindings: {
      baseline: null,
      parent: shadow.record.parent.programSha256,
      sham: null,
      treatment: sha256('different-candidate-program')
    },
    patterns: {
      candidate: [true, true, true, true],
      cold: [false, true, false, true],
      parent: [true, true, false, true],
      sham: [false, true, false, true]
    }
  });
  const refused = verifyMechanismEvolution({
    currentRecord: shadow.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    measurementRecord: wrongMeasurement,
    verifierEvidenceSha256: wrongMeasurement.source.verifierEvidenceSha256,
    recordedAt: CLOCKS[2]
  });
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.code, 'EVOLUTION_MEASUREMENT_BINDING_INVALID');
});

test('rejection is terminal and chain reduction refuses forks', () => {
  const { parent, proposed } = fixture();
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [INTERFACE],
    recordedAt: CLOCKS[1]
  });
  const rejected = rejectMechanismEvolution({
    currentRecord: shadow.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    rejectionEvidenceSha256: sha256('failed-shadow-evidence'),
    reasonCodes: ['NO_RECURSIVE_LIFT'],
    recordedAt: CLOCKS[2]
  });
  assert.equal(rejected.status, 'OK', rejected.message);
  assert.equal(rejected.record.state, 'REJECTED');
  assert.equal(activateMechanismEvolution({
    currentRecord: rejected.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    activationEvidenceSha256: sha256('invalid-activation'),
    recordedAt: CLOCKS[3]
  }).status, 'REFUSED');

  const secondRejection = rejectMechanismEvolution({
    currentRecord: shadow.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    rejectionEvidenceSha256: sha256('different-failed-shadow-evidence'),
    reasonCodes: ['CONTROL_REGRESSION'],
    recordedAt: CLOCKS[3]
  });
  const forked = selectLatestMechanismEvolutionRecords([
    proposed.record,
    shadow.record,
    rejected.record,
    secondRejection.record
  ]);
  assert.equal(forked.status, 'REFUSED');
  assert.equal(forked.code, 'INVALID_MECHANISM_EVOLUTION_CHAIN');
});

test('catalog accepts observational states but blocks caller-minted verified state', () => {
  const { parent, proposed } = fixture();
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [INTERFACE],
    recordedAt: CLOCKS[1]
  });
  const homeDir = mkdtempSync(join(tmpdir(), 'mechanism-evolution-catalog-'));
  assert.equal(persistAdaptiveRecord({ homeDir, record: parent }).status, 'OK');
  assert.equal(persistAdaptiveRecord({
    homeDir,
    record: proposed.candidateFamily
  }).status, 'OK');
  assert.equal(persistAdaptiveRecord({ homeDir, record: proposed.record }).status, 'OK');
  assert.equal(persistAdaptiveRecord({ homeDir, record: shadow.record }).status, 'OK');

  const fakeVerified = structuredClone(shadow.record);
  fakeVerified.state = 'VERIFIED';
  const refused = persistAdaptiveRecord({ homeDir, record: fakeVerified });
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.code, 'MECHANISM_EVOLUTION_VERIFIER_REQUIRED');

  const listed = listAdaptiveRecords({
    homeDir,
    schemaVersion: ADAPTIVE_SCHEMA.EVOLUTION
  });
  assert.equal(listed.status, 'OK');
  assert.equal(listed.records.length, 2);
});
