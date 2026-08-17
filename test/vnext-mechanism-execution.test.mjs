import test from 'node:test';
import assert from 'node:assert/strict';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import {
  canonicalMechanismProgramJson,
  compileMechanismProgram
} from '../src/mechanism-compiler.mjs';
import {
  buildCandidateStageArtifact,
  createCandidateGeneratorRegistry,
  getCandidateGenerator
} from '../src/vnext-candidate-generators.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact
} from '../src/vnext-contracts.mjs';
import {
  createVNextMechanismExecutionBinding,
  validateVNextMechanismExecutionBinding,
  verifyVNextMechanismExecutionBinding
} from '../src/vnext-mechanism-execution.mjs';
import { sha256 } from '../src/util.mjs';
import { createVNextAblationProfile } from '../src/vnext-ablation-profile.mjs';

const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [{ metricId: 'quality-delta', operator: 'subtract', leftRole: 'candidate.quality', rightRole: 'baseline.quality' }],
  rules: [{
    ruleId: 'accept-quality', kind: 'decision', exceptionOf: null,
    when: { operator: 'greater-than', left: { kind: 'metric', id: 'quality-delta' }, right: { kind: 'literal', value: 0 } },
    emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

function stage(name, marker) {
  return createVNextStageArtifact({
    stage: name, status: 'OK', createdAt: '2026-08-05T03:00:00.000Z',
    authority: { actorId: `actor-${marker}`, kind: 'test-builder', model: null, promptSha256: null, toolPolicy: 'none' },
    inputRefs: [], permittedInformation: ['development evidence'], forbiddenInformation: ['sealed tasks'],
    provenance: [], replay: { module: 'test', exportName: 'fixture', version: 'v1' }, failure: null,
    payload: { marker }
  }).artifact;
}

function interfaceContract() {
  return {
    schemaVersion: 'executable-interface-contract-v2', exportName: 'decide',
    inputPaths: ['quality.baseline', 'quality.candidate'], decisions: ['ACCEPT', 'REJECT'],
    codes: [
      { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
      { value: 'NO_GAIN', meaning: 'Quality did not increase.' },
      { value: 'MANUAL_REVIEW', meaning: 'Equal values need review.' }
    ],
    roleBindings: [
      { role: 'baseline.quality', path: 'quality.baseline' },
      { role: 'candidate.quality', path: 'quality.candidate' }
    ]
  };
}

function fixture() {
  const parent = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback', interventionKind: 'evidence-bound-fallback',
      operationKind: 'bounded-program-mutation', expectedEffectKind: 'more-exact-dispositions',
      preconditions: ['paired-measurement'], procedureSteps: ['measure', 'mutate', 'verify'],
      program: PROGRAM,
      applicability: { taskModes: ['improve'], loopRoles: ['supervisor'], taskValueDimensions: ['exactness'], resourceDimensions: ['token-cost'] }
    }
  });
  assert.equal(parent.status, 'OK');
  const hypothesis = stage(VNEXT_STAGE.HYPOTHESIS, 'h');
  const falsification = stage(VNEXT_STAGE.FALSIFICATION, 'f');
  const retrieval = stage(VNEXT_STAGE.RETRIEVAL, 'r');
  const fallbackSha256 = sha256(canonicalMechanismProgramJson(PROGRAM.fallback));
  const behaviorMapCore = {
    schemaVersion: 'vnext-harness-handbook-v1',
    repositoryRootSha256: sha256('mechanism-program-root'),
    authority: 'descriptive-source-map-only',
    canAuthorizeEdits: false,
    behaviors: [{
      id: 'mechanism-program', description: 'Bounded mechanism state.',
      locators: [{
        path: 'mechanism-program/fallback', symbol: 'fallback',
        symbolSha256: sha256('fallback'), startLine: 1, endLine: 1,
        sourceSha256: fallbackSha256, locatorSha256: fallbackSha256
      }],
      tests: [], dependencies: [], permissions: [], summary: null
    }]
  };
  const behaviorMap = {
    ...behaviorMapCore,
    behaviorMapSha256: sha256(canonicalVNextJson(behaviorMapCore))
  };
  const plugin = getCandidateGenerator(createCandidateGeneratorRegistry(), 'native').plugin;
  const contract = plugin.createContract({
    hypothesisArtifact: hypothesis, falsificationArtifact: falsification,
    retrievalArtifact: retrieval,
    selectedEvidence: [{ id: 'evidence-1', sha256: sha256('evidence-1') }],
    behaviorMap, allowedComponent: 'mechanism-program',
    parentArtifact: PROGRAM,
    parentItemHashes: [{
      target: 'mechanism-program/fallback', component: 'mechanism-program',
      sha256: fallbackSha256
    }],
    maxOperations: 1, protectedSurfaces: ['evaluator', 'statistics', 'promotion'], taskAgnostic: true
  });
  assert.equal(contract.status, 'OK');
  const candidateOutput = {
    schemaVersion: 'vnext-candidate-output-v1', strategy: 'native',
    targetBehavior: 'classify equal quality explicitly', component: 'mechanism-program', taskAgnostic: true,
    prediction: 'equal-value cases become exact without control regressions',
    falsifier: 'equal-value exactness is unchanged or controls regress',
    operations: [{
      op: 'replace', target: 'mechanism-program/fallback',
      beforeSha256: sha256(canonicalMechanismProgramJson(PROGRAM.fallback)),
      value: JSON.stringify({ decision: 'REJECT', code: 'MANUAL_REVIEW' })
    }],
    evidenceIds: ['evidence-1'], rollback: 'restore the exact parent fallback', protectedSurfaceTouches: []
  };
  const verified = plugin.verifyCandidate(candidateOutput, contract.contract);
  assert.equal(verified.status, 'OK');
  const candidate = buildCandidateStageArtifact({
    candidate: verified.candidate, verification: verified.verification,
    contract: contract.contract, createdAt: '2026-08-05T03:00:00.000Z'
  }).artifact;
  const stages = [hypothesis, falsification, retrieval, candidate];
  const ablationProfile = createVNextAblationProfile({ armId: 'B0' }).profile;
  const receiptCore = {
    schemaVersion: 'vnext-preparation-pipeline-v1', pipelineId: 'pipeline-mechanism',
    createdAt: '2026-08-05T03:00:00.000Z', disposition: 'CANDIDATE_READY_FOR_EXPERIMENT',
    revisionCount: 0,
    ablationProfileSha256: ablationProfile.profileSha256,
    stages: stages.map((item) => ({ id: item.artifactId, stage: item.stage, status: item.status, sha256: item.artifactSha256 })),
    workers: [], contextIsolationPassed: true, resourceBudgetLedgerSha256: null,
    executionAuthority: false, activationAuthority: false
  };
  const receipt = { ...receiptCore, receiptSha256: sha256(canonicalVNextJson(receiptCore)) };
  const result = {
    status: 'OK', disposition: receipt.disposition, stages, workers: [],
    ablationProfile, externalResearchEvidence: null,
    resourceBudgetLedger: null, receipt, candidate, candidateContract: contract.contract
  };
  const evidence = { productionEvidence: false };
  return {
    parentFamily: parent.record,
    behaviorMap,
    preparationVerification: {
      status: 'OK', result, evidence,
      evidenceSha256: sha256(canonicalVNextJson({ receipt: receipt.receiptSha256, production: false }))
    }
  };
}

test('mechanism adapter binds a generic candidate to one executable shadow descendant', () => {
  const input = fixture();
  const contract = interfaceContract();
  assert.equal(compileMechanismProgram({ program: PROGRAM, interfaceContract: contract }).status, 'OK');
  const built = createVNextMechanismExecutionBinding({
    preparationRunId: 'pipeline-mechanism-proof', ...input,
    taskPartition: 'validation', taskPackSha256: sha256('task-pack'),
    mutationObjective: {
      measurementId: `measurement-${sha256('mechanism-source').slice(0, 24)}`,
      measurementSha256: sha256('mechanism-source-record'),
      failureCaseSetSha256: sha256('mechanism-failures'),
      successCaseSetSha256: sha256('mechanism-successes'),
      targetMetric: 'exact-case-rate', direction: 'increase'
    },
    reasonCodes: ['FAILED_FALLBACK_DISPOSITION'], expectedEffectCode: 'MORE_EXACT_CASES',
    interfaceContracts: [contract],
    proposalRecordedAt: '2026-08-05T03:00:01.000Z', shadowRecordedAt: '2026-08-05T03:00:02.000Z'
  }, { requireProduction: false });
  assert.equal(built.status, 'OK', JSON.stringify(built));
  assert.equal(validateVNextMechanismExecutionBinding(built.binding).status, 'OK');
  const replay = verifyVNextMechanismExecutionBinding({
    binding: built.binding, preparationVerification: input.preparationVerification,
    parentFamily: built.parentFamily, candidateFamily: built.candidateFamily,
    evolutionRecord: built.evolutionRecord, interfaceContracts: [contract],
    behaviorMap: input.behaviorMap, requireProduction: false
  });
  assert.equal(replay.status, 'OK', replay.message);
  assert.equal(built.binding.executionAuthority, 'bounded-experiment-only');
  assert.equal(built.binding.activationAuthority, false);
  assert.equal(built.binding.taskPartition, 'validation');

  const tampered = structuredClone(built.binding);
  tampered.candidateProgramSha256 = sha256('different-program');
  assert.equal(validateVNextMechanismExecutionBinding(tampered).status, 'REFUSED');
  assert.equal(verifyVNextMechanismExecutionBinding({
    binding: built.binding, preparationVerification: input.preparationVerification,
    parentFamily: built.parentFamily,
    candidateFamily: { ...built.candidateFamily, familySha256: sha256('wrong-family') },
    evolutionRecord: built.evolutionRecord, interfaceContracts: [contract],
    behaviorMap: input.behaviorMap, requireProduction: false
  }).status, 'REFUSED');
});

test('mechanism adapter refuses unsupported generic recombination operations', () => {
  const input = fixture();
  const candidate = input.preparationVerification.result.candidate;
  candidate.payload.candidate.operations[0].op = 'recombine';
  candidate.payload.candidate.operations[0].value = JSON.stringify({ decision: 'REJECT', code: 'MANUAL_REVIEW' });
  assert.equal(createVNextMechanismExecutionBinding({
    preparationRunId: 'pipeline-mechanism-proof', ...input,
    taskPartition: 'validation', taskPackSha256: sha256('task-pack'),
    mutationObjective: {}, reasonCodes: ['FAILED_FALLBACK_DISPOSITION'], expectedEffectCode: 'MORE_EXACT_CASES',
    interfaceContracts: [interfaceContract()], proposalRecordedAt: '2026-08-05T03:00:01.000Z',
    shadowRecordedAt: '2026-08-05T03:00:02.000Z'
  }, { requireProduction: false }).status, 'REFUSED');
});
