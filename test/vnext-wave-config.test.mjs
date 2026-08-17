import test from 'node:test';
import assert from 'node:assert/strict';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import { createVNextEvidenceRecord } from '../src/vnext-evidence-bank.mjs';
import { createVNextModelIdentityPolicy } from '../src/vnext-model-identity.mjs';
import { captureExecutableEvaluatorAuthority } from '../src/adaptive-executable-canary.mjs';
import {
  createVNextWaveConfig,
  validateVNextWaveConfig,
  vnextPreparationMaximumCalls
} from '../src/vnext-wave-config.mjs';
import { MANDATORY_PROTECTED_SURFACES } from '../src/vnext-candidate-generators.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';
import { canonicalMechanismProgramJson } from '../src/mechanism-compiler.mjs';
import { createExternalResearchPolicy } from '../src/vnext-external-research.mjs';
import { createVNextAblationProfile } from '../src/vnext-ablation-profile.mjs';

const executableEvaluatorTest = process.platform === 'darwin' ? test : test.skip;

const PROGRAM = {
  schemaVersion: 'mechanism-program-v1', bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'], selectors: [], bindings: [],
  forbiddenBindings: [],
  metrics: [{ metricId: 'quality-delta', operator: 'subtract', leftRole: 'candidate.quality', rightRole: 'baseline.quality' }],
  rules: [{ ruleId: 'accept-quality', kind: 'decision', exceptionOf: null, when: { operator: 'greater-than', left: { kind: 'metric', id: 'quality-delta' }, right: { kind: 'literal', value: 0 } }, emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' } }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

function configInput() {
  const authority = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real', binaryBytes: Buffer.from('wave-config-codex'),
    versionOutput: 'codex-cli 1.0.0', loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high', service_tiers: []
    }] }),
    requestedModel: 'gpt-5.6-sol', reasoningEffort: 'high'
  }).record;
  const policy = createVNextModelIdentityPolicy({
    policyId: 'wave-model-identity', oauthAuthority: authority,
    requireBackendReportedModel: true
  }).policy;
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK', evaluator.errors?.join('; '));
  const family = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback', interventionKind: 'exact-fallback',
      operationKind: 'bounded-program-mutation', expectedEffectKind: 'exactness',
      preconditions: ['paired-measurement'],
      procedureSteps: ['observe', 'mutate', 'verify'], program: PROGRAM,
      applicability: { taskModes: ['improve'], loopRoles: ['supervisor'], taskValueDimensions: ['exactness'], resourceDimensions: ['token-cost'] }
    }
  }).record;
  const evidence = createVNextEvidenceRecord({
    kind: 'failure', availableAt: '2026-08-05T00:00:00.000Z',
    createdAt: '2026-08-05T00:00:00.000Z', sourceIds: ['source-1'],
    verifierEvidenceHashes: ['a'.repeat(64)],
    compatibility: { domains: [], tags: ['fallback'], component: 'mechanism-program', schemaVersions: [], models: ['gpt-5.6-sol'], harnessSha256s: [], toolEnvironmentSha256s: [], permissions: [], securityRequirements: [], versionConstraints: [] },
    lifecycle: { state: 'observed', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: null, costUsd: null, latencyMs: null, tokenCost: null, uncertainty: 0.5 },
    content: { statement: 'Fallback mishandles equal values.' }, callerClaims: {}
  }).record;
  const roles = [
    'candidate-generator', 'falsifier-initial', 'falsifier-revision',
    'hypothesis-reviser', 'hypothesizer', 'reranker', 'researcher'
  ];
  const mechanismLocators = [{
    target: 'mechanism-program/fallback', symbol: 'fallback', value: PROGRAM.fallback
  }, ...PROGRAM.metrics.map((value) => ({
    target: `mechanism-program/metrics/${value.metricId}`,
    symbol: value.metricId,
    value
  })), ...PROGRAM.rules.map((value) => ({
    target: `mechanism-program/rules/${value.ruleId}`,
    symbol: value.ruleId,
    value
  }))].map(({ target, symbol, value }) => {
    const digest = sha256(canonicalMechanismProgramJson(value));
    return {
      path: target, symbol, symbolSha256: sha256(symbol),
      startLine: 1, endLine: 1, sourceSha256: digest,
      locatorSha256: digest
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const behaviorMapCore = {
    schemaVersion: 'vnext-harness-handbook-v1',
    repositoryRootSha256: 'f'.repeat(64),
    authority: 'descriptive-source-map-only',
    canAuthorizeEdits: false,
    behaviors: [{
      id: 'mechanism-program',
      description: 'Bounded executable mechanism behavior.',
      locators: mechanismLocators,
      tests: [],
      dependencies: [],
      permissions: [],
      summary: null
    }]
  };
  const behaviorMap = {
    ...behaviorMapCore,
    behaviorMapSha256: sha256(canonicalVNextJson(behaviorMapCore))
  };
  return {
    waveId: 'wave-1', preparationRunId: 'wave-1-prep',
    experimentRunId: 'wave-1-experiment',
    createdAt: '2026-08-05T00:00:00.000Z',
    proposalRecordedAt: '2026-08-05T00:00:01.000Z',
    shadowRecordedAt: '2026-08-05T00:00:02.000Z',
    preparationBudgetPolicyId: 'wave-1-preparation-budget',
    experimentBudgetPolicyId: 'wave-1-experiment-budget',
    runtimeAuthority: authority,
    evaluatorAuthority: evaluator.record,
    ablationProfile: createVNextAblationProfile({ armId: 'B4' }).profile,
    preparation: {
      failure: {
        failureId: 'failure-1',
        summary: 'The parent fallback rejects equal candidate quality.',
        behavior: 'mechanism-program',
        component: 'mechanism-program',
        symptoms: ['Equal values follow the coarse fallback.'],
        environment: { runtime: 'node' },
        sourceEvidence: [{
          id: 'failure-source-1',
          schemaVersion: 'vnext-task-pack-v1',
          sha256: '1'.repeat(64),
          availableAt: '2026-08-05T00:00:00.000Z',
          locator: 'test/vnext-wave-config.test.mjs#configInput'
        }]
      },
      evidenceRecords: [evidence],
      behaviorMap, targetBehaviorIds: ['mechanism-program'],
      feedbackArtifacts: [], architectureFacts: {}, architectureConstraints: ['no activation'],
      publicMeasurementContract: { inferenceUnit: 'task-cluster' }, compatibility: {}, embeddings: {},
      queryEmbedding: null, maximumCandidates: 64, maximumSelected: 4,
      exploreUncertainty: false, enableModelReranker: true,
      internalResearchEnabled: true, hypothesisFalsificationEnabled: true,
      externalResearchEnabled: false, sealedMode: false, externalSources: [],
      externalSourceAllowlist: [], dossierMaximumItems: 64, dossierMaximumBytes: 65536,
      candidateStrategy: 'native', candidateFeatureFlags: {}, candidateStrategyState: null,
      protectedSurfaces: [...MANDATORY_PROTECTED_SURFACES].sort(), maxOperations: 1,
      modelPolicy: Object.fromEntries(roles.map((role) => [role, {
        model: 'gpt-5.6-sol', reasoningEffort: 'high', identityPolicy: policy
      }])),
      callBudgets: Object.fromEntries([
        'candidate-generator', 'falsifier', 'hypothesizer', 'reranker', 'researcher'
      ].map((role) => [role, { maxInputTokens: 100, maxOutputTokens: 50 }]))
    },
    mechanism: {
      parentFamily: family,
      mutationObjective: {
        measurementId: `measurement-${'b'.repeat(24)}`,
        measurementSha256: 'c'.repeat(64), failureCaseSetSha256: 'd'.repeat(64),
        successCaseSetSha256: 'e'.repeat(64), targetMetric: 'exact-case-rate',
        direction: 'increase'
      },
      reasonCodes: ['FAILED_FALLBACK'], expectedEffectCode: 'MORE_EXACT_CASES'
    },
    taskSplit: {
      calibrationTaskIds: Array.from({ length: 5 }, (_, index) => `task-${index + 1}`),
      confirmationTaskIds: Array.from({ length: 5 }, (_, index) => `task-${index + 6}`)
    },
    recursiveCanary: {
      model: 'gpt-5.6-sol', reasoningEffort: 'high', authMode: 'chatgpt-oauth',
      retries: 0, promotionEnabled: false, historicalTokenEstimate: 4000000,
      replicatesPerArm: 3, calibrationRule: 'paired-placebo-upper-bound-v1',
      confirmationRule: 'five-task-adjusted-sign-test-v1',
      perCallBudget: { maxInputTokens: 100, maxOutputTokens: 50 }
    },
    pace: {
      lambdaPolicy: { kind: 'fixed', value: 1 }, maximumShamMovement: 0.05,
      maximumRelativeTokenIncrease: 0.25
    }
  };
}

executableEvaluatorTest('wave config closes every model role, split, authority, and resource input', () => {
  const built = createVNextWaveConfig(configInput());
  assert.equal(built.status, 'OK');
  assert.equal(validateVNextWaveConfig(built.config).status, 'OK');
  assert.equal(vnextPreparationMaximumCalls(built.config), 7);
  const tampered = structuredClone(built.config);
  tampered.recursiveCanary.promotionEnabled = true;
  assert.equal(validateVNextWaveConfig(tampered).status, 'REFUSED');
});

executableEvaluatorTest('wave preflight rejects preparation inputs that could only fail after launch', () => {
  const sparseFailure = configInput();
  sparseFailure.preparation.failure = { failureId: 'failure-1' };
  assert.equal(createVNextWaveConfig(sparseFailure).status, 'REFUSED');

  const staleMap = configInput();
  staleMap.preparation.behaviorMap.behaviors[0].description = 'changed after hashing';
  assert.equal(createVNextWaveConfig(staleMap).status, 'REFUSED');

  const unprotected = configInput();
  unprotected.preparation.protectedSurfaces = ['evaluator'];
  assert.equal(createVNextWaveConfig(unprotected).status, 'REFUSED');

  const invalidPace = configInput();
  invalidPace.pace.lambdaPolicy = { kind: 'model-chosen', value: 1 };
  assert.equal(createVNextWaveConfig(invalidPace).status, 'REFUSED');
});

executableEvaluatorTest('external research adds exactly one frozen preparation call and no caller content', () => {
  const input = configInput();
  input.preparation.externalResearchEnabled = true;
  input.preparation.externalSources = [];
  input.preparation.externalSourceAllowlist = ['arxiv.org'];
  input.preparation.externalResearchPolicy = createExternalResearchPolicy({
    policyId: 'wave-external-research-policy',
    createdAt: input.createdAt,
    allowlist: ['arxiv.org'],
    maximumQueries: 4,
    maximumSources: 2,
    maximumPerSourceBytes: 64 * 1024,
    maximumTotalBytes: 128 * 1024,
    timeoutMs: 5000,
    networkEnabled: true,
    sealedMode: false
  }).policy;
  input.preparation.modelPolicy['external-researcher'] = structuredClone(
    input.preparation.modelPolicy.researcher
  );
  input.preparation.callBudgets['external-researcher'] = {
    maxInputTokens: 100,
    maxOutputTokens: 50
  };
  const built = createVNextWaveConfig(input);
  assert.equal(built.status, 'OK');
  assert.equal(vnextPreparationMaximumCalls(built.config), 8);

  const callerContent = configInput();
  callerContent.preparation.externalResearchEnabled = true;
  callerContent.preparation.externalSources = [{
    id: 'caller-source',
    url: 'https://arxiv.org/abs/2501.00001',
    title: 'Caller source',
    authorityClass: 'primary',
    retrievedAt: callerContent.createdAt,
    content: 'Unverified caller content.',
    contentSha256: sha256('Unverified caller content.')
  }];
  callerContent.preparation.externalSourceAllowlist = ['arxiv.org'];
  callerContent.preparation.externalResearchPolicy = input.preparation.externalResearchPolicy;
  callerContent.preparation.modelPolicy['external-researcher'] = structuredClone(
    callerContent.preparation.modelPolicy.researcher
  );
  callerContent.preparation.callBudgets['external-researcher'] = {
    maxInputTokens: 100,
    maxOutputTokens: 50
  };
  assert.equal(createVNextWaveConfig(callerContent).status, 'REFUSED');
});

export { configInput };
