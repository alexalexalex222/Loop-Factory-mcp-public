import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADAPTIVE_RECURSIVE_CANARY,
  adaptiveRecursiveCanaryLaunchDisclosure,
  buildAdaptiveRecursiveCanaryPlan
} from '../src/adaptive-recursive-canary.mjs';
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

function interfaceContract(index, includeCandidateCode = true) {
  const root = `domain${index}`;
  return {
    schemaVersion: 'executable-interface-contract-v2',
    exportName: 'decide',
    inputPaths: [`${root}.baselineQuality`, `${root}.candidateQuality`],
    decisions: ['ACCEPT', 'REJECT'],
    codes: [{ value: 'QUALITY_GAIN', meaning: 'Quality increased.' }, {
      value: 'NO_GAIN', meaning: 'Quality did not increase.'
    }, ...(includeCandidateCode ? [{
      value: 'MANUAL_REVIEW', meaning: 'The unresolved case needs review.'
    }] : [{
      value: 'UNRELATED_CODE', meaning: 'An unrelated disposition remains available.'
    }])],
    roleBindings: [{
      role: 'baseline.quality', path: `${root}.baselineQuality`
    }, {
      role: 'candidate.quality', path: `${root}.candidateQuality`
    }]
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
  assert.equal(parentBuilt.status, 'OK', parentBuilt.message);
  const parentFamily = parentBuilt.record;
  const normalized = normalizeMechanismProgram(PROGRAM);
  const mutation = createMechanismMutationPlan({
    parent: {
      familyId: parentFamily.familyId,
      familySha256: parentFamily.familySha256,
      programSha256: normalized.programSha256
    },
    objective: {
      measurementId: `measurement-${sha256('source-measurement').slice(0, 24)}`,
      measurementSha256: sha256('source-measurement-record'),
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
  assert.equal(mutation.status, 'OK', mutation.message);
  const proposed = proposeMechanismEvolution({
    parentFamily,
    mutationPlan: mutation.plan,
    recordedAt: '2026-08-03T19:00:00.000Z'
  });
  assert.equal(proposed.status, 'OK', proposed.message);
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [interfaceContract(0)],
    recordedAt: '2026-08-03T19:01:00.000Z'
  });
  assert.equal(shadow.status, 'OK', shadow.message);
  return {
    parentFamily,
    candidateFamily: proposed.candidateFamily,
    evolutionRecord: shadow.record
  };
}

function task(index, includeCandidateCode = true) {
  const contract = interfaceContract(index + 1, includeCandidateCode);
  const compiled = compileMechanismProgram({ program: PROGRAM, interfaceContract: contract });
  assert.equal(compiled.status, 'OK', compiled.message);
  const id = `recursive-task-${index + 1}`;
  return {
    id,
    source: { path: `proof/recursive/${id}/candidate.mjs`, sha256: sha256(`${id}:source`) },
    incident: { path: `proof/recursive/${id}/incident.md`, sha256: sha256(`${id}:incident`) },
    interface: {
      path: `proof/recursive/${id}/interface.json`,
      sha256: compiled.compilation.interfaceSha256
    },
    oracle: { path: `proof/recursive/${id}/oracle.json`, sha256: sha256(`${id}:oracle`) },
    interfaceContract: contract
  };
}

function config() {
  return {
    schemaVersion: 'adaptive-recursive-canary-v1',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    historicalTokenEstimate: 500000,
    ...shadowFixture(),
    tasks: Array.from({ length: 5 }, (_, index) => task(index))
  };
}

test('recursive canary schema is closed', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/adaptive-recursive-canary-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'adaptive-recursive-canary-v1');
  assert.equal(schema.additionalProperties, false);
});

test('recursive canary plan freezes four balanced arms and twenty zero-retry calls', () => {
  const input = config();
  const first = buildAdaptiveRecursiveCanaryPlan(input);
  const second = buildAdaptiveRecursiveCanaryPlan({
    ...input,
    tasks: [...input.tasks].reverse()
  });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(second.status, 'OK', second.message);
  assert.deepEqual(first.plan, second.plan);
  assert.equal(first.plan.exposure.tasks, 5);
  assert.deepEqual(first.plan.exposure.arms, ADAPTIVE_RECURSIVE_CANARY.arms);
  assert.equal(first.plan.exposure.calls, 20);
  assert.equal(first.plan.modelPolicy.retries, 0);
  assert.equal(first.plan.modelPolicy.promotionEnabled, false);
  assert.equal(first.plan.exposure.hardTokenCeiling, null);
  assert.equal(first.plan.exposure.hardUsdCeiling, null);
  assert.equal(first.plan.calls.length, 20);
  for (const arm of ADAPTIVE_RECURSIVE_CANARY.arms) {
    assert.equal(first.plan.calls.filter((call) => call.arm === arm).length, 5);
  }
  assert.ok(first.plan.tasks.every((item) => (
    item.treatments.cold === null
    && item.treatments.parent !== item.treatments.candidate
    && item.treatments.sham !== item.treatments.candidate
  )));
  assert.ok(first.plan.execution.argv.includes('--ignore-user-config'));
  assert.ok(first.plan.execution.disabledFeatures.includes('multi_agent'));

  const disclosure = adaptiveRecursiveCanaryLaunchDisclosure(input);
  assert.equal(disclosure.status, 'OK');
  assert.equal(disclosure.workerLaunched, false);
  assert.equal(disclosure.launchAvailable, true);
  assert.equal(disclosure.planSha256, first.plan.sha256);
});

test('recursive plan blocks a task that cannot compile complete candidate treatment', () => {
  const input = config();
  input.tasks[0] = task(0, false);
  const built = buildAdaptiveRecursiveCanaryPlan(input);
  assert.equal(built.status, 'REFUSED');
  assert.equal(built.code, 'RECURSIVE_CANARY_TASK_COMPILATION_INVALID');
});
