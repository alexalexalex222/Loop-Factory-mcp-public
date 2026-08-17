import test from 'node:test';
import assert from 'node:assert/strict';
import { createVNextStageArtifact, VNEXT_STAGE, validateVNextStageArtifact } from '../src/vnext-contracts.mjs';
import { buildResearchDossier } from '../src/research-dossier.mjs';
import {
  buildHypothesisFalsificationArtifact,
  buildHypothesisFalsifierContract,
  parseHypothesisFalsifierOutput,
  runHypothesisFalsifier
} from '../src/hypothesis-falsifier.mjs';

const NOW = '2026-08-05T00:00:00.000Z';

function authority(actorId) {
  return { actorId, kind: 'deterministic-test', model: null, promptSha256: null, toolPolicy: 'none' };
}

function hypothesisArtifact() {
  return createVNextStageArtifact({
    stage: VNEXT_STAGE.HYPOTHESIS,
    status: 'OK',
    createdAt: NOW,
    authority: authority('hypothesis-worker'),
    inputRefs: [],
    permittedInformation: ['dossier'],
    forbiddenInformation: ['final sealed tasks'],
    provenance: [],
    replay: { module: 'test', exportName: 'hypothesisArtifact', version: 'v1' },
    failure: null,
    payload: {
      hypothesis: {
        schemaVersion: 'vnext-hypothesis-output-v1',
        statement: 'reserve one negative precedent',
        mechanism: 'selection explicitly represents failure evidence',
        targetBehavior: 'negative retrieval',
        component: 'retrieval',
        taskAgnostic: true,
        prediction: 'negative precedent recall increases',
        falsifier: 'negative precedent recall is unchanged',
        controls: ['positive recall does not regress'],
        evidenceIds: ['fact-1']
      }
    }
  }).artifact;
}

function dossierArtifact() {
  return buildResearchDossier({
    createdAt: NOW,
    decisionTime: NOW,
    failure: {
      id: 'failure-1',
      schemaVersion: 'normalized-failure-v1',
      availableAt: NOW,
      content: { summary: 'negative evidence omitted' }
    },
    failureSummary: 'negative evidence omitted',
    architectureConstraints: ['reranker cannot activate'],
    facts: [{ id: 'fact-1', statement: 'negative evidence exists', sourceIds: ['failure-1'], confidence: 'high' }],
    counterexamples: [],
    contradictions: [],
    uncertainties: [],
    unansweredQuestions: [],
    maximumBytes: 8000
  }).artifact;
}

function contractInput(overrides = {}) {
  return {
    createdAt: NOW,
    hypothesisArtifact: hypothesisArtifact(),
    dossierArtifact: dossierArtifact(),
    evidenceRecords: [],
    architectureFacts: { protectedSurfaces: ['admission'] },
    publicMeasurementContract: { unit: 'task-cluster', shamRequired: true },
    ...overrides
  };
}

function output(evidenceIds = ['fact-1']) {
  return {
    schemaVersion: 'vnext-falsification-output-v1',
    verdict: 'TEST',
    summary: 'The causal claim is testable but not established.',
    falsifiers: ['negative recall remains unchanged'],
    confounds: ['query mix changes'],
    requiredControls: ['positive recall'],
    contradictions: ['none established'],
    smallerEdit: 'reserve exactly one negative slot',
    distinct: true,
    evidenceIds
  };
}

test('fresh falsifier contract excludes forbidden proposer and sealed-task context', () => {
  const forbidden = buildHypothesisFalsifierContract(contractInput({ proposerConversation: ['hidden'] }));
  assert.equal(forbidden.code, 'FALSIFIER_CONTEXT_BOUNDARY');
  const allowed = buildHypothesisFalsifierContract(contractInput());
  assert.equal(allowed.status, 'OK');
  assert.equal(Object.hasOwn(allowed.contract, 'proposerConversation'), false);
  assert.equal(Object.hasOwn(allowed.contract, 'sealedTasks'), false);
  assert.equal(Object.isFrozen(allowed.contract), true);
});

test('falsifier rejects absent and hallucinated evidence IDs', () => {
  const contract = buildHypothesisFalsifierContract(contractInput()).contract;
  assert.equal(parseHypothesisFalsifierOutput(output([]), contract).code, 'FALSIFIER_EVIDENCE_ID_MISSING');
  assert.equal(parseHypothesisFalsifierOutput(output(['future-result']), contract).code, 'FALSIFIER_EVIDENCE_ID_MISSING');
});

test('valid REJECT/REVISE/TEST recommendation becomes an immutable stage artifact only', () => {
  const contract = buildHypothesisFalsifierContract(contractInput()).contract;
  const result = buildHypothesisFalsificationArtifact({ contract, output: output() });
  assert.equal(result.status, 'OK');
  assert.equal(result.artifact.payload.recommendationOnly, true);
  assert.equal(result.artifact.payload.mayEdit, false);
  assert.equal(result.artifact.payload.mayAdmit, false);
  assert.equal(validateVNextStageArtifact(result.artifact).status, 'OK');
});

test('caller-supplied worker receives frozen fresh context and cannot cite outside it', async () => {
  let frozen = false;
  const result = await runHypothesisFalsifier({
    ...contractInput(),
    worker: async ({ contract }) => {
      frozen = Object.isFrozen(contract) && Object.isFrozen(contract.hypothesis);
      return output();
    }
  });
  assert.equal(frozen, true);
  assert.equal(result.status, 'OK');
  assert.equal(result.artifact.stage, VNEXT_STAGE.FALSIFICATION);
});
