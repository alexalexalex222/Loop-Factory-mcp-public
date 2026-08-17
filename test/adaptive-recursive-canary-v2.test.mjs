import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADAPTIVE_RECURSIVE_CANARY_V2,
  adaptiveRecursiveCanaryV2LaunchDisclosure,
  buildAdaptiveRecursiveCanaryV2Plan
} from '../src/adaptive-recursive-canary-v2.mjs';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import {
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution
} from '../src/mechanism-evolution.mjs';
import {
  canonicalMechanismProgramJson,
  compileMechanismProgram,
  normalizeMechanismProgram
} from '../src/mechanism-compiler.mjs';
import { createMechanismMutationPlan } from '../src/mechanism-mutation.mjs';
import { createResourceBudgetPolicy } from '../src/resource-budget.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';

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

function interfaceContract(index) {
  const root = `replicatedDomain${index}`;
  return {
    schemaVersion: 'executable-interface-contract-v2',
    exportName: 'decide',
    inputPaths: [`${root}.baselineQuality`, `${root}.candidateQuality`],
    decisions: ['ACCEPT', 'REJECT'],
    codes: [
      { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
      { value: 'NO_GAIN', meaning: 'Quality did not increase.' },
      { value: 'MANUAL_REVIEW', meaning: 'The unresolved case needs review.' }
    ],
    roleBindings: [
      { role: 'baseline.quality', path: `${root}.baselineQuality` },
      { role: 'candidate.quality', path: `${root}.candidateQuality` }
    ]
  };
}

function shadowFixture() {
  const parentBuilt = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback',
      interventionKind: 'evidence-bound-fallback',
      operationKind: 'bounded-program-mutation',
      expectedEffectKind: 'more-exact-dispositions',
      preconditions: ['paired-measurement'],
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
  assert.equal(parentBuilt.status, 'OK');
  const parentFamily = parentBuilt.record;
  const normalized = normalizeMechanismProgram(PROGRAM);
  const mutation = createMechanismMutationPlan({
    parent: {
      familyId: parentFamily.familyId,
      familySha256: parentFamily.familySha256,
      programSha256: normalized.programSha256
    },
    objective: {
      measurementId: `measurement-${sha256('v2-source').slice(0, 24)}`,
      measurementSha256: sha256('v2-source-record'),
      failureCaseSetSha256: sha256('v2-failures'),
      successCaseSetSha256: sha256('v2-successes'),
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
  assert.equal(mutation.status, 'OK');
  const proposed = proposeMechanismEvolution({
    parentFamily,
    mutationPlan: mutation.plan,
    recordedAt: '2026-08-04T20:00:00.000Z'
  });
  assert.equal(proposed.status, 'OK');
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [interfaceContract(0)],
    recordedAt: '2026-08-04T20:01:00.000Z'
  });
  assert.equal(shadow.status, 'OK');
  return {
    parentFamily,
    candidateFamily: proposed.candidateFamily,
    evolutionRecord: shadow.record
  };
}

function task(index, stage) {
  const contract = interfaceContract(index + 1);
  const compiled = compileMechanismProgram({ program: PROGRAM, interfaceContract: contract });
  assert.equal(compiled.status, 'OK');
  const id = `${stage}-recursive-task-${index + 1}`;
  return {
    id,
    source: { path: `proof/recursive-v2/${id}/candidate.mjs`, sha256: sha256(`${id}:source`) },
    incident: { path: `proof/recursive-v2/${id}/incident.md`, sha256: sha256(`${id}:incident`) },
    interface: {
      path: `proof/recursive-v2/${id}/interface.json`,
      sha256: compiled.compilation.interfaceSha256
    },
    oracle: { path: `proof/recursive-v2/${id}/oracle.json`, sha256: sha256(`${id}:oracle`) },
    interfaceContract: contract
  };
}

function config() {
  return {
    schemaVersion: 'adaptive-recursive-canary-v2',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    historicalTokenEstimate: 4000000,
    replicatesPerArm: 3,
    calibrationRule: 'paired-placebo-upper-bound-v1',
    confirmationRule: 'five-task-adjusted-sign-test-v1',
    ...shadowFixture(),
    calibrationTasks: Array.from({ length: 5 }, (_, index) => task(index, 'calibration')),
    confirmationTasks: Array.from({ length: 5 }, (_, index) => task(index + 5, 'confirmation'))
  };
}

function withBudget(input, {
  maxInputTokens = 1000,
  maxOutputTokens = 300,
  maxCalls = ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls
} = {}) {
  const policy = createResourceBudgetPolicy({
    policyId: 'recursive-v2-vnext-test',
    maxCalls,
    maxInputTokens: maxInputTokens * maxCalls,
    maxOutputTokens: maxOutputTokens * maxCalls,
    maxTotalTokens: (maxInputTokens + maxOutputTokens) * maxCalls,
    maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd',
    currency: 'USD'
  });
  assert.equal(policy.status, 'OK');
  return {
    ...input,
    resourceBudgetPolicy: policy.policy,
    perCallBudget: { maxInputTokens, maxOutputTokens }
  };
}

function vnextBehaviorMap() {
  const core = {
    schemaVersion: 'vnext-harness-handbook-v1',
    repositoryRootSha256: sha256('recursive-v2-mechanism-map'),
    authority: 'descriptive-source-map-only', canAuthorizeEdits: false,
    behaviors: [{
      id: 'mechanism-program', description: 'Bounded mechanism state.',
      locators: [{
        path: 'mechanism-program/fallback', symbol: 'fallback',
        symbolSha256: sha256('fallback'), startLine: 1, endLine: 1,
        sourceSha256: sha256('parent-fallback'),
        locatorSha256: sha256('parent-fallback')
      }],
      tests: [], dependencies: [], permissions: [], summary: null
    }]
  };
  return { ...core, behaviorMapSha256: sha256(canonicalVNextJson(core)) };
}

function vnextBinding(input) {
  const behaviorMap = vnextBehaviorMap();
  const core = {
    schemaVersion: 'vnext-mechanism-execution-binding-v1',
    adapterId: 'mechanism-program-v1',
    preparationRunId: 'preparation-proof',
    taskPartition: 'validation',
    taskPackSha256: sha256('task-pack'),
    preparationVerifierEvidenceSha256: sha256('preparation-evidence'),
    pipelineReceiptSha256: sha256('pipeline-receipt'),
    candidateArtifactSha256: sha256('candidate-artifact'),
    candidateVerificationSha256: sha256('candidate-verification'),
    candidateContractSha256: sha256('candidate-contract'),
    behaviorMapSha256: behaviorMap.behaviorMapSha256,
    allowedTargetsSha256: sha256(canonicalVNextJson([{
      target: 'mechanism-program/fallback', component: 'mechanism-program',
      locatorSha256: sha256('parent-fallback'),
      parentItemSha256: sha256('parent-fallback')
    }])),
    parentFamilySha256: input.parentFamily.familySha256,
    mutationPlanSha256: input.evolutionRecord.mutationPlan.mutationPlanSha256,
    candidateFamilySha256: input.candidateFamily.familySha256,
    candidateProgramSha256: input.evolutionRecord.candidate.programSha256,
    evolutionSha256: input.evolutionRecord.evolutionSha256,
    treatmentDeltaSha256: input.evolutionRecord.evidence.treatmentDeltaSha256,
    proposalRecordedAt: '2026-08-04T20:00:00.000Z',
    shadowRecordedAt: '2026-08-04T20:01:00.000Z',
    productionEvidence: true,
    executionAuthority: 'bounded-experiment-only',
    activationAuthority: false
  };
  return { ...core, bindingSha256: sha256(canonicalVNextJson(core)) };
}

function pacePolicy() {
  const core = {
    schemaVersion: 'vnext-pace-canary-policy-v1',
    outerAlphaAllocation: {
      allocationId: 'vnext-generation-1',
      alpha: 0.05,
      familyAlpha: 0.05,
      policySha256: sha256('outer-alpha-policy')
    },
    lambdaPolicy: { kind: 'fixed', value: 1 },
    maximumShamMovement: 0.05,
    maximumRelativeTokenIncrease: 0.25,
    ordering: 'policy-hash-task-id-v1'
  };
  return { ...core, policySha256: sha256(canonicalVNextJson(core)) };
}

test('recursive V2 schema is closed and freezes replicated conditional exposure', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/adaptive-recursive-canary-v2.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'adaptive-recursive-canary-v2');
  assert.equal(schema.additionalProperties, false);

  const input = config();
  const first = buildAdaptiveRecursiveCanaryV2Plan(input);
  const second = buildAdaptiveRecursiveCanaryV2Plan({
    ...input,
    calibrationTasks: [...input.calibrationTasks].reverse(),
    confirmationTasks: [...input.confirmationTasks].reverse()
  });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(second.status, 'OK', second.message);
  assert.deepEqual(first.plan, second.plan);
  assert.equal(first.plan.exposure.calibrationCalls, 60);
  assert.equal(first.plan.exposure.conditionalConfirmationCalls, 60);
  assert.equal(first.plan.exposure.maximumCalls, 120);
  assert.equal(first.plan.calibrationCalls.length, 60);
  assert.equal(first.plan.confirmationCalls.length, 60);
  assert.equal(first.plan.causalDesign.finalGenerationUntouchedAtLaunch, true);
  for (const stage of ADAPTIVE_RECURSIVE_CANARY_V2.stages) {
    const calls = first.plan[`${stage}Calls`];
    for (const arm of ADAPTIVE_RECURSIVE_CANARY_V2.arms) {
      assert.equal(calls.filter((call) => call.arm === arm).length, 15);
    }
  }
  const disclosure = adaptiveRecursiveCanaryV2LaunchDisclosure(input, {
    configPath: 'config.json',
    home: 'proof-home',
    runId: 'run-v2'
  });
  assert.equal(disclosure.status, 'OK');
  assert.equal(disclosure.maximumCalls, 120);
  assert.match(disclosure.launchCommand, new RegExp(first.plan.sha256));
});

test('recursive V2 rejects reused source or oracle identities across generations', () => {
  const input = config();
  input.confirmationTasks[0] = {
    ...input.confirmationTasks[0],
    source: input.calibrationTasks[0].source
  };
  const built = buildAdaptiveRecursiveCanaryV2Plan(input);
  assert.equal(built.status, 'REFUSED');
  assert.equal(built.code, 'RECURSIVE_V2_GENERATIONS_NOT_DISJOINT');
});

test('recursive V2 does not accept fewer replicates or a weaker rule name', () => {
  const wrongReplicates = config();
  wrongReplicates.replicatesPerArm = 2;
  assert.equal(buildAdaptiveRecursiveCanaryV2Plan(wrongReplicates).status, 'REFUSED');

  const wrongRule = config();
  wrongRule.calibrationRule = 'accept-any-movement';
  assert.equal(buildAdaptiveRecursiveCanaryV2Plan(wrongRule).status, 'REFUSED');
});

test('recursive V2 budgeted plans freeze enforceable token and cost ceilings', () => {
  const input = withBudget(config());
  const built = buildAdaptiveRecursiveCanaryV2Plan(input);
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.plan.exposure.hardTokenCeiling, 156000);
  assert.equal(built.plan.exposure.hardUsdCeiling, 0);
  const vnext = withBudget(config());
  vnext.vnextBinding = vnextBinding(vnext);
  vnext.vnextBehaviorMap = vnextBehaviorMap();
  vnext.pacePolicy = pacePolicy();
  const vnextPlan = buildAdaptiveRecursiveCanaryV2Plan(vnext);
  assert.equal(vnextPlan.status, 'OK', vnextPlan.message);
  assert.equal(vnextPlan.plan.vnext.bindingSha256, vnext.vnextBinding.bindingSha256);
  const underfunded = withBudget(config(), { maxCalls: 119 });
  assert.equal(buildAdaptiveRecursiveCanaryV2Plan(underfunded).status, 'REFUSED');

  const detached = config();
  detached.vnextBinding = {
    pipelineReceiptSha256: sha256('pipeline-receipt'),
    candidateArtifactSha256: sha256('candidate-artifact'),
    candidateVerificationSha256: sha256('candidate-verification'),
    candidateContractSha256: sha256('candidate-contract')
  };
  assert.equal(buildAdaptiveRecursiveCanaryV2Plan(detached).status, 'REFUSED');
});
