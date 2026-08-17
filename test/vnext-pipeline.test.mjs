import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../src/util.mjs';
import { buildHarnessHandbook } from '../src/harness-handbook.mjs';
import {
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority
} from '../src/vnext-evidence-bank.mjs';
import { runVNextModelWorker } from '../src/vnext-model-worker.mjs';
import { createExternalResearchPolicy } from '../src/vnext-external-research.mjs';
import {
  prepareVNextCandidate,
  validateVNextPreparationResult
} from '../src/vnext-pipeline.mjs';
import { createStore } from '../src/store.mjs';
import {
  persistVNextPreparationResult,
  verifyVNextPreparationRun
} from '../src/vnext-preparation-store.mjs';
import { createVNextAblationProfile } from '../src/vnext-ablation-profile.mjs';

const NOW = '2026-08-05T03:00:00.000Z';
const FIXTURE_AUTHORITY = createVNextFixtureEvidenceAuthority('vnext-pipeline-tests').authority;

function ablationProfile(strategy = 'native') {
  const armId = {
    native: 'B4',
    'reflective-pareto': 'B5a',
    'bounded-skill': 'B5b',
    'bank-recombination': 'B5c',
    'code-level-experimental': 'B7'
  }[strategy];
  return createVNextAblationProfile({ armId }).profile;
}

function behaviorMap() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-pipeline-repo-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'router.mjs'), 'export const negativeSelectionRule = true;\n');
  writeFileSync(join(root, 'test', 'router.test.mjs'), 'test("negative selection", () => {});\n');
  return buildHarnessHandbook({
    repositoryRoot: root,
    behaviors: [{
      id: 'retrieval', description: 'Selects positive and negative precedents.', generatedSummary: null,
      locators: [{ path: 'src/router.mjs', symbol: 'negativeSelectionRule', startLine: 1, endLine: 1 }],
      tests: [{ path: 'test/router.test.mjs', symbol: 'negative selection', startLine: 1, endLine: 1 }],
      dependencies: [], permissions: ['read evidence']
    }]
  }).behaviorMap;
}

function evidence() {
  return createVNextEvidenceRecord({
    recordId: 'evidence-1', kind: 'regression', availableAt: NOW, createdAt: NOW,
    sourceIds: ['source-1'], verifierEvidenceHashes: ['b'.repeat(64)],
    authority: FIXTURE_AUTHORITY,
    compatibility: { domains: [], tags: ['negative'], component: 'retrieval', schemaVersions: [], models: [], harnessSha256s: [], toolEnvironmentSha256s: [], permissions: [], securityRequirements: [], versionConstraints: [] },
    lifecycle: { state: 'replicated', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: -0.2, costUsd: 0, latencyMs: 1, tokenCost: 1, uncertainty: 0.1 },
    content: { statement: 'Omitting negative precedents caused a control regression.' }, callerClaims: {}
  }, { allowFixtureRecords: true }).record;
}

function fixtureFor(role, {
  candidateTarget = 'src/router.mjs',
  candidateBeforeSha256 = 'd'.repeat(64),
  candidateStrategy = 'native',
  evidenceId = 'fact-1'
} = {}) {
  if (role === 'external-researcher') return {
    schemaVersion: 'vnext-external-research-discovery-output-v1',
    abstain: false,
    abstainReason: null,
    searchSummary: 'A primary source was located.',
    queries: ['site:example.com official retrieval evidence'],
    sources: [{
      sourceId: 'external-source-1',
      url: 'https://example.com/research',
      title: 'Official Retrieval Evidence',
      reason: 'Primary-source fixture for the research pipeline.',
      authorityClass: 'primary'
    }],
    uncertainties: ['Transfer remains unmeasured.']
  };
  if (role === 'reranker') return {
    schemaVersion: 'vnext-reranker-output-v1', abstain: false, abstainReason: null,
    rankings: [{ recordId: 'evidence-1', applicability: 0.9, structuralSimilarity: 0.9, expectedBenefit: 0.8, transferUncertainty: 0.1, contradictionRisk: 0.1, reason: 'same omission pattern', confidence: 0.9 }]
  };
  if (role === 'researcher') return {
    schemaVersion: 'vnext-research-output-v1',
    facts: [{ id: 'fact-1', statement: 'A verified negative precedent exists.', confidence: 'high', sourceIds: ['evidence-1'] }],
    counterexamples: ['Incompatible environments should not transfer mechanisms.'],
    uncertainties: ['Transfer to a new domain is unmeasured.'],
    unansweredQuestions: ['Does negative recall improve downstream quality?']
  };
  if (role === 'hypothesizer') return {
    schemaVersion: 'vnext-hypothesis-output-v1', component: 'retrieval',
    statement: 'Reserve one compatible negative precedent.', mechanism: 'A negative slot exposes known transfer failures.',
    targetBehavior: 'retrieval', prediction: 'negative recall increases without a positive recall regression',
    falsifier: 'negative recall is unchanged or controls regress', taskAgnostic: true,
    controls: ['irrelevant-memory sham'], evidenceIds: [evidenceId]
  };
  if (role === 'falsifier-initial') return {
    schemaVersion: 'vnext-falsification-output-v1', verdict: 'TEST',
    summary: 'The hypothesis is bounded and falsifiable.', smallerEdit: 'Reserve exactly one slot.', distinct: true,
    falsifiers: ['no negative recall gain'], confounds: ['extra context'], requiredControls: ['irrelevant-memory sham'],
    contradictions: [], evidenceIds: [evidenceId]
  };
  if (role === 'candidate-generator') return {
    schemaVersion: 'vnext-candidate-output-v1', strategy: candidateStrategy, targetBehavior: 'retrieval', component: 'retrieval',
    taskAgnostic: true, prediction: 'negative recall increases', falsifier: 'negative recall is unchanged',
    operations: [{
      op: candidateStrategy === 'bank-recombination' ? 'recombine' : 'replace',
      target: candidateTarget,
      beforeSha256: candidateBeforeSha256,
      value: candidateStrategy === 'bank-recombination'
        ? 'Combine donor-alpha with donor-beta.'
        : 'reserve one compatible negative precedent'
    }],
    evidenceIds: [evidenceId], rollback: 'restore the exact parent hash', protectedSurfaceTouches: []
  };
  throw new Error(`unexpected role ${role}`);
}

function pipelineStrategyState(strategy, target) {
  if (strategy === 'reflective-pareto') return {
    trajectories: [{
      trajectoryId: 'success-run', outcome: 'success', quality: 0.8,
      tokenCost: 100, regressions: 0, summary: 'Negative retrieval helped.',
      evidenceIds: ['fact-1'], availableAt: '2026-08-05T02:00:00.000Z'
    }, {
      trajectoryId: 'failure-run', outcome: 'failure', quality: 0.2,
      tokenCost: 140, regressions: 1, summary: 'Positive-only retrieval regressed.',
      evidenceIds: ['fact-1'], availableAt: '2026-08-05T02:01:00.000Z'
    }]
  };
  if (strategy === 'bounded-skill') {
    const value = 'Reserve one compatible negative precedent.';
    return {
      skill: { skillId: 'retrieval-skill', version: 'v1', items: [{ target, value, sha256: sha256(value) }] },
      successReflections: [{ reflectionId: 'success-reflection', evidenceId: 'fact-1', statement: 'Negative evidence helped.', availableAt: '2026-08-05T02:00:00.000Z' }],
      failureReflections: [{ reflectionId: 'failure-reflection', evidenceId: 'fact-1', statement: 'Unbounded context hurt.', availableAt: '2026-08-05T02:01:00.000Z' }],
      limits: { maximumChangedItems: 1, maximumChangedBytes: 256 }
    };
  }
  if (strategy === 'bank-recombination') {
    const donor = (mechanismId, familyId, content) => ({
      mechanismId, familyId, component: 'retrieval', operationKind: 'select', content,
      compatibilityTags: ['negative', 'retrieval'], incompatibleWith: [], evidenceIds: ['fact-1'],
      lifecycle: 'replicated', qualityDelta: 0.2, regressions: 0, sha256: sha256(content)
    });
    return {
      targetTags: ['negative', 'retrieval'],
      mechanisms: [
        donor('donor-alpha', 'family-alpha', 'Reserve negative evidence.'),
        donor('donor-beta', 'family-beta', 'Diversify selected evidence.')
      ]
    };
  }
  return {
    disposableWorktree: true, maximumFiles: 1, maximumPatchBytes: 1024,
    requiredTests: [{
      testId: 'router-test', executable: '/opt/homebrew/bin/node',
      executableSha256: 'c'.repeat(64), args: ['--test', 'test/router.test.mjs'],
      timeoutMs: 120000
    }]
  };
}

test('full preparation pipeline creates a replayable candidate with independent contexts', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-pipeline-workers-'));
  const map = behaviorMap();
  const targetLocator = map.behaviors[0].locators[0];
  const result = await prepareVNextCandidate({
    pipelineId: 'pipeline-1', createdAt: NOW,
    failure: {
      failureId: 'failure-1', summary: 'Negative precedent omitted.', behavior: 'retrieval', component: 'retrieval',
      symptoms: ['known contradiction absent'], environment: { model: 'gpt-5.6-sol' },
      sourceEvidence: [{ id: 'source-1', schemaVersion: 'measurement-v1', sha256: 'a'.repeat(64), availableAt: NOW, locator: 'proof/run.json#failure' }]
    },
    evidenceRecords: [evidence()],
    allowFixtureRecords: true,
    behaviorMap: map, targetBehaviorIds: ['retrieval'], feedbackArtifacts: [],
    architectureFacts: { router: 'deterministic eligibility then optional reranking' },
    architectureConstraints: ['Do not activate a mechanism from model output.'],
    publicMeasurementContract: { arms: ['incumbent', 'candidate', 'sham'], inferenceUnit: 'task-cluster' },
    parentArtifactSha256: 'c'.repeat(64), parentArtifact: { id: 'parent-1' },
    parentItemHashes: [{
      target: targetLocator.path,
      component: 'retrieval',
      sha256: targetLocator.locatorSha256
    }],
    protectedSurfaces: ['evaluator', 'statistics', 'promotion'], maxOperations: 1,
    candidateStrategy: 'native', candidateFeatureFlags: {},
    ablationProfile: ablationProfile(), enableModelReranker: true,
    externalResearchEnabled: false, sealedMode: false,
    modelPolicy: Object.fromEntries(['reranker', 'researcher', 'hypothesizer', 'falsifier-initial', 'candidate-generator']
      .map((role) => [role, { model: 'gpt-5.6-sol', reasoningEffort: 'high' }])),
    requireProductionWorkerEvidence: false,
    invokeModel: ({ role, ...workerInput }) => runVNextModelWorker({
      ...workerInput,
      binaryIdentity: { basename: 'codex', sha256: 'e'.repeat(64) },
      stateRoot
    }, {
      allowTestFixture: true,
      testFixtureOutput: fixtureFor(role, {
        candidateTarget: targetLocator.path,
        candidateBeforeSha256: targetLocator.locatorSha256
      }),
      timeoutMs: 10_000
    })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.disposition, 'CANDIDATE_READY_FOR_EXPERIMENT');
  assert.equal(result.receipt.contextIsolationPassed, true);
  assert.equal(result.receipt.activationAuthority, false);
  assert.equal(result.workers.length, 5);
  assert.equal(validateVNextPreparationResult(result).status, 'OK');
  const store = createStore(mkdtempSync(join(tmpdir(), 'vnext-preparation-proof-')));
  const persisted = persistVNextPreparationResult(store, result, {
    runId: 'pipeline-1-proof',
    requireProduction: false
  });
  assert.equal(persisted.status, 'OK', persisted.message);
  assert.equal(persisted.result.workers.length, 5);
  assert.equal(
    verifyVNextPreparationRun(store, 'pipeline-1-proof').evidenceSha256,
    persisted.evidenceSha256
  );
  const state = store.load('pipeline-1-proof');
  const outputRef = state.workers[0].refs.output;
  const outputArtifact = store.readArtifact('pipeline-1-proof', outputRef.id);
  outputArtifact.content = `${outputArtifact.content} `;
  outputArtifact.sha256 = '0'.repeat(64);
  store.writeArtifact('pipeline-1-proof', outputRef.id, outputArtifact);
  assert.equal(
    verifyVNextPreparationRun(store, 'pipeline-1-proof').status,
    'REFUSED'
  );
});

test('B0, B2, and B3 execute only their frozen attributable model stages', async () => {
  for (const [armId, expectedRoles] of [
    ['B0', ['hypothesizer', 'candidate-generator']],
    ['B2', ['researcher', 'hypothesizer', 'candidate-generator']],
    ['B3', ['researcher', 'hypothesizer', 'falsifier-initial', 'candidate-generator']]
  ]) {
    const stateRoot = mkdtempSync(join(tmpdir(), `vnext-${armId}-workers-`));
    const map = behaviorMap();
    const target = map.behaviors[0].locators[0];
    const profile = createVNextAblationProfile({ armId }).profile;
    const roles = [];
    const evidenceId = armId === 'B0' ? 'evidence-1' : 'fact-1';
    const result = await prepareVNextCandidate({
      pipelineId: `pipeline-${armId.toLowerCase()}`,
      createdAt: NOW,
      ablationProfile: profile,
      failure: {
        failureId: `failure-${armId.toLowerCase()}`,
        summary: 'Negative precedent omitted.',
        behavior: 'retrieval',
        component: 'retrieval',
        symptoms: ['known contradiction absent'],
        environment: { model: 'gpt-5.6-sol' },
        sourceEvidence: [{
          id: 'source-1', schemaVersion: 'measurement-v1',
          sha256: 'a'.repeat(64), availableAt: NOW,
          locator: 'proof/run.json#failure'
        }]
      },
      evidenceRecords: [evidence()],
      allowFixtureRecords: true,
      behaviorMap: map,
      targetBehaviorIds: ['retrieval'],
      feedbackArtifacts: [],
      architectureFacts: {},
      architectureConstraints: [],
      publicMeasurementContract: { inferenceUnit: 'task-cluster' },
      compatibility: {},
      maximumCandidates: 64,
      maximumSelected: 4,
      exploreUncertainty: false,
      enableModelReranker: profile.modelRerankerEnabled,
      parentArtifactSha256: 'c'.repeat(64),
      parentArtifact: { id: 'parent-1' },
      parentItemHashes: [{
        target: target.path,
        component: 'retrieval',
        sha256: target.locatorSha256
      }],
      protectedSurfaces: ['evaluator', 'statistics', 'promotion'],
      maxOperations: 1,
      candidateStrategy: 'native',
      candidateFeatureFlags: {},
      candidateStrategyState: null,
      externalResearchEnabled: false,
      sealedMode: false,
      modelPolicy: Object.fromEntries([
        'reranker', 'researcher', 'hypothesizer', 'hypothesis-reviser',
        'falsifier-initial', 'falsifier-revision', 'candidate-generator'
      ].map((role) => [role, {
        model: 'gpt-5.6-sol', reasoningEffort: 'high'
      }])),
      requireProductionWorkerEvidence: false,
      invokeModel: ({ role, ...workerInput }) => {
        roles.push(role);
        return runVNextModelWorker({
          ...workerInput,
          binaryIdentity: { basename: 'codex', sha256: 'e'.repeat(64) },
          stateRoot
        }, {
          allowTestFixture: true,
          testFixtureOutput: fixtureFor(role, {
            candidateTarget: target.path,
            candidateBeforeSha256: target.locatorSha256,
            evidenceId
          }),
          timeoutMs: 10_000
        });
      }
    });
    assert.equal(result.status, 'OK', `${armId}: ${result.code || result.message}`);
    assert.equal(result.disposition, 'CANDIDATE_READY_FOR_EXPERIMENT');
    assert.deepEqual(roles, expectedRoles);
    assert.equal(result.receipt.ablationProfileSha256, profile.profileSha256);
    assert.equal(result.workers.length, expectedRoles.length);
    assert.equal(validateVNextPreparationResult(result).status, 'OK');
  }
});

test('the preparation pipeline carries each distinct strategy plan into its worker prompt and receipt', async () => {
  for (const strategy of [
    'reflective-pareto',
    'bounded-skill',
    'bank-recombination',
    'code-level-experimental'
  ]) {
    const stateRoot = mkdtempSync(join(tmpdir(), `vnext-${strategy}-`));
    const map = behaviorMap();
    const target = map.behaviors[0].locators[0];
    const flag = {
      'reflective-pareto': 'vnextCandidateReflectiveParetoEnabled',
      'bounded-skill': 'vnextCandidateBoundedSkillEnabled',
      'bank-recombination': 'vnextCandidateBankRecombinationEnabled',
      'code-level-experimental': 'vnextCandidateCodeLevelExperimentalEnabled'
    }[strategy];
    const result = await prepareVNextCandidate({
      pipelineId: `pipeline-${strategy}`, createdAt: NOW,
      failure: {
        failureId: `failure-${strategy}`, summary: 'Negative precedent omitted.',
        behavior: 'retrieval', component: 'retrieval', symptoms: ['known contradiction absent'],
        environment: { model: 'gpt-5.6-sol' },
        sourceEvidence: [{ id: 'source-1', schemaVersion: 'measurement-v1', sha256: 'a'.repeat(64), availableAt: NOW, locator: 'proof/run.json#failure' }]
      },
      evidenceRecords: [evidence()], allowFixtureRecords: true,
      behaviorMap: map, targetBehaviorIds: ['retrieval'], feedbackArtifacts: [],
      architectureFacts: {}, architectureConstraints: [],
      publicMeasurementContract: { inferenceUnit: 'task-cluster' },
      parentArtifactSha256: 'c'.repeat(64), parentArtifact: { id: 'parent-1' },
      parentItemHashes: [{ target: target.path, component: 'retrieval', sha256: target.locatorSha256 }],
      protectedSurfaces: ['evaluator', 'statistics', 'promotion'], maxOperations: 1,
      candidateStrategy: strategy, candidateFeatureFlags: { [flag]: true },
      ablationProfile: ablationProfile(strategy), enableModelReranker: true,
      candidateStrategyState: pipelineStrategyState(strategy, target.path),
      externalResearchEnabled: false, sealedMode: false,
      modelPolicy: Object.fromEntries(['reranker', 'researcher', 'hypothesizer', 'falsifier-initial', 'candidate-generator']
        .map((role) => [role, { model: 'gpt-5.6-sol', reasoningEffort: 'high' }])),
      requireProductionWorkerEvidence: false,
      invokeModel: ({ role, ...workerInput }) => runVNextModelWorker({
        ...workerInput,
        binaryIdentity: { basename: 'codex', sha256: 'e'.repeat(64) },
        stateRoot
      }, {
        allowTestFixture: true,
        testFixtureOutput: fixtureFor(role, {
          candidateTarget: target.path,
          candidateBeforeSha256: strategy === 'code-level-experimental'
            ? target.sourceSha256
            : target.locatorSha256,
          candidateStrategy: strategy
        }),
        timeoutMs: 10_000
      })
    });
    assert.equal(result.status, 'OK', `${strategy}: ${result.code || result.message}`);
    assert.equal(result.disposition, 'CANDIDATE_READY_FOR_EXPERIMENT');
    assert.equal(result.candidateContract.strategyPlan.strategy, strategy);
    assert.equal(
      result.candidate.artifactSha256 != null,
      true
    );
  }
});

test('external research is discovered, fetched, replayed, and persisted before the dossier', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-external-pipeline-workers-'));
  const researchStateRoot = mkdtempSync(join(tmpdir(), 'vnext-external-pipeline-fetch-'));
  const map = behaviorMap();
  const target = map.behaviors[0].locators[0];
  const policy = createExternalResearchPolicy({
    policyId: 'pipeline-external-policy',
    createdAt: NOW,
    allowlist: ['example.com'],
    maximumQueries: 2,
    maximumSources: 1,
    maximumPerSourceBytes: 64 * 1024,
    maximumTotalBytes: 64 * 1024,
    timeoutMs: 5000,
    networkEnabled: true,
    sealedMode: false
  }).policy;
  let tick = 0;
  const result = await prepareVNextCandidate({
    pipelineId: 'pipeline-external', createdAt: NOW,
    failure: {
      failureId: 'failure-external', summary: 'Negative precedent omitted.',
      behavior: 'retrieval', component: 'retrieval', symptoms: ['known contradiction absent'],
      environment: { model: 'gpt-5.6-sol' },
      sourceEvidence: [{ id: 'source-1', schemaVersion: 'measurement-v1', sha256: 'a'.repeat(64), availableAt: NOW, locator: 'proof/run.json#failure' }]
    },
    evidenceRecords: [evidence()], allowFixtureRecords: true,
    behaviorMap: map, targetBehaviorIds: ['retrieval'], feedbackArtifacts: [],
    architectureFacts: {}, architectureConstraints: [],
    publicMeasurementContract: { inferenceUnit: 'task-cluster' },
    parentArtifactSha256: 'c'.repeat(64), parentArtifact: { id: 'parent-1' },
    parentItemHashes: [{ target: target.path, component: 'retrieval', sha256: target.locatorSha256 }],
    protectedSurfaces: ['evaluator', 'statistics', 'promotion'], maxOperations: 1,
    candidateStrategy: 'native', candidateFeatureFlags: {},
    ablationProfile: ablationProfile(), enableModelReranker: true,
    externalResearchEnabled: true, sealedMode: false,
    externalResearchPolicy: policy,
    externalResearchStateRoot: researchStateRoot,
    externalResearchDecisionAt: NOW,
    externalResearchNow: () => new Date(Date.parse(NOW) + (++tick * 1000)),
    externalResearchTransport: async (source) => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`Primary evidence bytes for ${source.sourceId}.`),
      finalUrl: source.url,
      remoteAddresses: ['93.184.216.34'],
      peerAddressVerified: true,
      tlsAuthorized: true,
      tlsProtocol: 'TLSv1.3'
    }),
    modelPolicy: Object.fromEntries([
      'reranker', 'external-researcher', 'researcher', 'hypothesizer',
      'falsifier-initial', 'candidate-generator'
    ].map((role) => [role, { model: 'gpt-5.6-sol', reasoningEffort: 'high' }])),
    requireProductionWorkerEvidence: false,
    invokeModel: ({ role, ...workerInput }) => runVNextModelWorker({
      ...workerInput,
      binaryIdentity: { basename: 'codex', sha256: 'e'.repeat(64) },
      stateRoot
    }, {
      allowTestFixture: true,
      testFixtureOutput: fixtureFor(role, {
        candidateTarget: target.path,
        candidateBeforeSha256: target.locatorSha256
      }),
      timeoutMs: 10_000
    })
  });
  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.workers.length, 6);
  assert.equal(result.externalResearch.payload.networkFetchPerformedByStage, true);
  assert.equal(
    result.externalResearch.payload.fetchEvidenceSha256,
    result.externalResearchEvidence.evidenceSha256
  );
  assert.ok(Date.parse(result.dossier.createdAt) >= Date.parse(
    result.externalResearch.createdAt
  ));
  const store = createStore(mkdtempSync(join(tmpdir(), 'vnext-external-proof-')));
  const persisted = persistVNextPreparationResult(store, result, {
    runId: 'pipeline-external-proof',
    requireProduction: false
  });
  assert.equal(persisted.status, 'OK', persisted.message);
  assert.equal(
    verifyVNextPreparationRun(store, 'pipeline-external-proof').status,
    'OK'
  );
  const state = store.load('pipeline-external-proof');
  const ref = state.externalResearchEvidence;
  const artifact = store.readArtifact('pipeline-external-proof', ref.id);
  artifact.content = `${artifact.content} `;
  store.writeArtifact('pipeline-external-proof', ref.id, artifact);
  assert.equal(
    verifyVNextPreparationRun(store, 'pipeline-external-proof').status,
    'REFUSED'
  );
});

test('production preparation refuses before inference without a hard budget ledger', async () => {
  let calls = 0;
  const result = await prepareVNextCandidate({
    pipelineId: 'pipeline-no-budget', createdAt: NOW,
    failure: {}, evidenceRecords: [], publicMeasurementContract: {}, modelPolicy: {},
    ablationProfile: createVNextAblationProfile({ armId: 'B0' }).profile,
    enableModelReranker: false, candidateStrategy: 'native',
    invokeModel: async () => { calls += 1; return null; }
  });
  assert.equal(result.code, 'VNEXT_PIPELINE_RESOURCE_BUDGET_REQUIRED');
  assert.equal(calls, 0);
});

test('an out-of-scope hypothesis is rejected before candidate generation', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-out-of-scope-'));
  const roles = [];
  const result = await prepareVNextCandidate({
    pipelineId: 'pipeline-out-of-scope', createdAt: NOW,
    failure: {
      failureId: 'failure-1', summary: 'Negative precedent omitted.',
      behavior: 'retrieval', component: 'retrieval', symptoms: ['omission'],
      environment: {}, sourceEvidence: [{ id: 'source-1', schemaVersion: 'measurement-v1', sha256: 'a'.repeat(64), availableAt: NOW, locator: 'proof/run.json#failure' }]
    },
    evidenceRecords: [evidence()], behaviorMap: behaviorMap(),
    allowFixtureRecords: true,
    targetBehaviorIds: ['retrieval'], feedbackArtifacts: [], architectureFacts: {},
    architectureConstraints: [], publicMeasurementContract: { inferenceUnit: 'task-cluster' },
    parentArtifactSha256: 'c'.repeat(64), parentArtifact: { id: 'parent-1' },
    parentItemHashes: [{ target: 'negative-selection-rule', component: 'retrieval', sha256: 'd'.repeat(64) }],
    protectedSurfaces: ['evaluator'], maxOperations: 1, candidateStrategy: 'native',
    ablationProfile: ablationProfile(), enableModelReranker: true,
    candidateFeatureFlags: {}, externalResearchEnabled: false, sealedMode: false,
    requiredComponent: 'mechanism-program',
    modelPolicy: Object.fromEntries(['reranker', 'researcher', 'hypothesizer', 'falsifier-initial']
      .map((role) => [role, { model: 'gpt-5.6-sol', reasoningEffort: 'high' }])),
    requireProductionWorkerEvidence: false,
    invokeModel: ({ role, ...workerInput }) => {
      roles.push(role);
      return runVNextModelWorker({
        ...workerInput, binaryIdentity: { basename: 'codex', sha256: 'e'.repeat(64) }, stateRoot
      }, { allowTestFixture: true, testFixtureOutput: fixtureFor(role), timeoutMs: 10_000 });
    }
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.disposition, 'HYPOTHESIS_OUT_OF_SCOPE');
  assert.equal(roles.includes('candidate-generator'), false);
});
