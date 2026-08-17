import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalVNextJson, createVNextStageArtifact, VNEXT_STAGE } from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';
import {
  buildVNextHypothesisArtifact,
  buildVNextHypothesisContract
} from '../src/vnext-hypothesis.mjs';
import {
  collectTaskAgentFeedback,
  createTaskAgentFeedbackContract
} from '../src/task-agent-feedback.mjs';

const NOW = '2026-08-05T02:00:00.000Z';

function stage(name, payload, createdAt = NOW) {
  return createVNextStageArtifact({
    stage: name, status: 'OK', createdAt,
    authority: { actorId: `actor-${name}`, kind: 'test', model: null, promptSha256: null, toolPolicy: 'none' },
    inputRefs: [], permittedInformation: ['test'], forbiddenInformation: ['sealed tasks'], provenance: [],
    replay: { module: 'test', exportName: 'fixture', version: 'v1' }, failure: null, payload
  }).artifact;
}

function fixtures() {
  const dossier = stage(VNEXT_STAGE.DOSSIER, {
    schemaVersion: 'vnext-research-dossier-v1', items: [{ id: 'fact-1' }],
    sourceIndex: [{ id: 'source-1' }], budget: { payloadBytes: 0, maximumBytes: 999999, itemCount: 1, maximumItems: 64 }
  });
  dossier.payload.budget.payloadBytes = Buffer.byteLength(JSON.stringify(dossier.payload));
  // Rebuild after setting the self-reported byte count until stable.
  let rebuilt = dossier;
  for (let index = 0; index < 4; index++) {
    rebuilt = stage(VNEXT_STAGE.DOSSIER, rebuilt.payload);
    rebuilt.payload.budget.payloadBytes = Buffer.byteLength(JSON.stringify(rebuilt.payload));
  }
  rebuilt = stage(VNEXT_STAGE.DOSSIER, rebuilt.payload);
  const retrieval = stage(VNEXT_STAGE.RETRIEVAL, {
    schemaVersion: 'vnext-hybrid-retrieval-v1', evidenceAuthorityMode: 'verifier-owned-only',
    candidatePool: [{ recordId: 'evidence-1' }],
    selection: [{ recordId: 'evidence-1' }]
  });
  const research = stage(VNEXT_STAGE.INTERNAL_RESEARCH, {
    research: { facts: [{ id: 'fact-1' }] }
  });
  const behaviorMapCore = {
    schemaVersion: 'vnext-harness-handbook-v1', repositoryRootSha256: 'a'.repeat(64),
    authority: 'descriptive-source-map-only', canAuthorizeEdits: false,
    behaviors: [{ id: 'retrieval', description: 'retrieval', locators: [], tests: [], dependencies: [], permissions: [], summary: null }]
  };
  const behaviorMap = {
    ...behaviorMapCore,
    behaviorMapSha256: sha256(canonicalVNextJson(behaviorMapCore))
  };
  return { dossier: rebuilt, retrieval, research, behaviorMap };
}

function output(overrides = {}) {
  return {
    schemaVersion: 'vnext-hypothesis-output-v1', component: 'retrieval',
    statement: 'Reserve one compatible negative precedent.', mechanism: 'Diversity selection exposes contradictions.',
    targetBehavior: 'retrieval', prediction: 'negative recall rises', falsifier: 'negative recall is unchanged',
    taskAgnostic: true, controls: ['irrelevant-memory sham'], evidenceIds: ['fact-1'], ...overrides
  };
}

test('hypothesis contract binds research, behavior, evidence, and parent state', () => {
  const f = fixtures();
  const built = buildVNextHypothesisContract({
    createdAt: NOW, dossierArtifact: f.dossier, retrievalArtifact: f.retrieval,
    researchArtifact: f.research, behaviorMap: f.behaviorMap, targetBehaviorIds: ['retrieval'],
    feedbackArtifacts: [], parentArtifactSha256: 'c'.repeat(64), revisionNumber: 0
  });
  assert.equal(built.status, 'OK');
  const artifact = buildVNextHypothesisArtifact({ contract: built.contract, output: output() });
  assert.equal(artifact.status, 'OK');
  assert.equal(artifact.artifact.payload.activationAuthority, false);
});

test('hypothesis output cannot escape evidence, component, controls, or task-agnostic scope', () => {
  const f = fixtures();
  const built = buildVNextHypothesisContract({
    createdAt: NOW, dossierArtifact: f.dossier, retrievalArtifact: f.retrieval,
    researchArtifact: f.research, behaviorMap: f.behaviorMap, targetBehaviorIds: ['retrieval'],
    feedbackArtifacts: [], parentArtifactSha256: 'c'.repeat(64), revisionNumber: 0
  });
  for (const invalid of [
    output({ evidenceIds: ['invented'] }), output({ component: 'evaluator' }),
    output({ controls: [] }), output({ taskAgnostic: false })
  ]) assert.equal(buildVNextHypothesisArtifact({ contract: built.contract, output: invalid }).status, 'REFUSED');
});

test('a candidate strategy cannot proceed when the hypothesis omits required evidence', () => {
  const f = fixtures();
  const built = buildVNextHypothesisContract({
    createdAt: NOW, dossierArtifact: f.dossier, retrievalArtifact: f.retrieval,
    researchArtifact: f.research, behaviorMap: f.behaviorMap,
    targetBehaviorIds: ['retrieval'], feedbackArtifacts: [],
    parentArtifactSha256: 'c'.repeat(64), revisionNumber: 0,
    requiredEvidenceIds: ['evidence-1']
  });
  assert.equal(built.status, 'OK');
  assert.equal(buildVNextHypothesisArtifact({
    contract: built.contract,
    output: output({ evidenceIds: ['fact-1'] })
  }).status, 'REFUSED');
  assert.equal(buildVNextHypothesisArtifact({
    contract: built.contract,
    output: output({ evidenceIds: ['evidence-1', 'fact-1'] })
  }).status, 'OK');
});

test('hypothesis contracts reject future lineage and future task-agent feedback', () => {
  const f = fixtures();
  const future = '2026-08-05T02:00:01.000Z';
  const futureResearch = stage(
    VNEXT_STAGE.INTERNAL_RESEARCH,
    f.research.payload,
    future
  );
  assert.equal(buildVNextHypothesisContract({
    createdAt: NOW, dossierArtifact: f.dossier, retrievalArtifact: f.retrieval,
    researchArtifact: futureResearch, behaviorMap: f.behaviorMap,
    targetBehaviorIds: ['retrieval'], feedbackArtifacts: [],
    parentArtifactSha256: 'c'.repeat(64), revisionNumber: 0
  }).status, 'REFUSED');

  const feedbackContract = createTaskAgentFeedbackContract({
    collectionId: 'future-feedback', runId: 'run-1', taskId: 'task-1',
    issuedAt: '2026-08-05T01:59:59.000Z', ttlMs: 120_000,
    contextRefs: [{
      id: 'task-input', kind: 'task-input', schemaVersion: 'task-input-v1',
      sha256: 'd'.repeat(64)
    }, {
      id: 'task-output', kind: 'task-output', schemaVersion: 'task-output-v1',
      sha256: 'e'.repeat(64)
    }]
  });
  const futureFeedback = collectTaskAgentFeedback({
    contract: feedbackContract.contract,
    collectedAt: future,
    output: {
      schemaVersion: 'vnext-task-feedback-output-v1',
      helped: [], obstructed: [], timing: [], missing: [], irrelevant: [],
      rediscovered: [], uncertainty: 0.5
    }
  });
  assert.equal(futureFeedback.status, 'OK');
  assert.equal(buildVNextHypothesisContract({
    createdAt: NOW, dossierArtifact: f.dossier, retrievalArtifact: f.retrieval,
    researchArtifact: f.research, behaviorMap: f.behaviorMap,
    targetBehaviorIds: ['retrieval'], feedbackArtifacts: [futureFeedback.artifact],
    parentArtifactSha256: 'c'.repeat(64), revisionNumber: 0
  }).status, 'REFUSED');
});
