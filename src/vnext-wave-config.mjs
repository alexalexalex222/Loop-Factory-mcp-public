import { validateAdaptiveRecord } from './adaptive-records.mjs';
import { validateExecutableEvaluatorAuthority } from './adaptive-executable-canary.mjs';
import {
  ADAPTIVE_RECURSIVE_REASONING_EFFORTS,
  ADAPTIVE_RECURSIVE_SUPPORTED_MODELS
} from './adaptive-recursive-canary.mjs';
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';
import { validateVNextModelIdentityPolicy } from './vnext-model-identity.mjs';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { normalizeVNextFailure } from './vnext-failure.mjs';
import { validateTaskAgentFeedbackArtifact } from './task-agent-feedback.mjs';
import {
  MANDATORY_PROTECTED_SURFACES,
  VNEXT_CANDIDATE_GENERATOR_FLAGS
} from './vnext-candidate-generators.mjs';
import {
  validateExternalResearchPolicy
} from './vnext-external-research.mjs';
import {
  validateVNextAblationPreparation,
  validateVNextAblationProfile,
  vnextAblationPreparationMaximumCalls
} from './vnext-ablation-profile.mjs';

export const VNEXT_WAVE_CONFIG_SCHEMA = 'loop-factory-vnext-wave-config-v1';

export const VNEXT_PREPARATION_ROLES = Object.freeze([
  'candidate-generator',
  'falsifier-initial',
  'falsifier-revision',
  'hypothesis-reviser',
  'hypothesizer',
  'reranker',
  'researcher'
]);
export const VNEXT_EXTERNAL_RESEARCH_ROLE = 'external-researcher';

export const VNEXT_PREPARATION_BUDGET_ROLES = Object.freeze([
  'candidate-generator',
  'falsifier',
  'hypothesizer',
  'reranker',
  'researcher'
]);

const CANDIDATE_STRATEGIES = new Set([
  'native',
  'reflective-pareto',
  'bounded-skill',
  'bank-recombination',
  'code-level-experimental'
]);
const SHA256 = /^[a-f0-9]{64}$/;
const REASON = /^[A-Z0-9][A-Z0-9_]{0,119}$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function sortedUniqueStrings(values, { minimum = 0, maximum = 128 } = {}) {
  return Array.isArray(values)
    && values.length >= minimum
    && values.length <= maximum
    && values.every((value) => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length
    && canonicalVNextJson(values) === canonicalVNextJson([...values].sort());
}

function routeValid(route) {
  return exactKeys(route, ['model', 'reasoningEffort', 'identityPolicy'])
    && typeof route.model === 'string'
    && route.model.length > 0
    && route.model.length <= 120
    && ADAPTIVE_RECURSIVE_REASONING_EFFORTS.includes(route.reasoningEffort)
    && validateVNextModelIdentityPolicy(route.identityPolicy).status === 'OK'
    && route.identityPolicy.requestedModel === route.model
    && route.identityPolicy.reasoningEffort === route.reasoningEffort;
}

function requiredPreparationRoles(externalResearchEnabled) {
  return externalResearchEnabled
    ? [...VNEXT_PREPARATION_ROLES, VNEXT_EXTERNAL_RESEARCH_ROLE]
    : [...VNEXT_PREPARATION_ROLES];
}

function requiredBudgetRoles(externalResearchEnabled) {
  return externalResearchEnabled
    ? [...VNEXT_PREPARATION_BUDGET_ROLES, VNEXT_EXTERNAL_RESEARCH_ROLE]
    : [...VNEXT_PREPARATION_BUDGET_ROLES];
}

function modelPolicyValid(policy, externalResearchEnabled) {
  const roles = requiredPreparationRoles(externalResearchEnabled);
  return exactKeys(policy, roles)
    && roles.every((role) => routeValid(policy[role]));
}

function boundedCanonicalObject(value, maximumBytes) {
  if (!plainObject(value)) return false;
  try {
    return Buffer.byteLength(canonicalVNextJson(value)) <= maximumBytes;
  } catch {
    return false;
  }
}

function behaviorMapValid(map, targetBehaviorIds) {
  if (!exactKeys(map, [
    'schemaVersion', 'repositoryRootSha256', 'authority', 'canAuthorizeEdits',
    'behaviors', 'behaviorMapSha256'
  ])
      || map.schemaVersion !== 'vnext-harness-handbook-v1'
      || !SHA256.test(String(map.repositoryRootSha256 || ''))
      || map.authority !== 'descriptive-source-map-only'
      || map.canAuthorizeEdits !== false
      || !Array.isArray(map.behaviors)
      || map.behaviors.length < 1
      || map.behaviors.length > 128
      || !Array.isArray(targetBehaviorIds)) return false;
  const core = structuredClone(map);
  delete core.behaviorMapSha256;
  if (map.behaviorMapSha256 !== sha256(canonicalVNextJson(core))) return false;
  const ids = new Set();
  for (const behavior of map.behaviors) {
    if (!exactKeys(behavior, [
      'id', 'description', 'locators', 'tests', 'dependencies', 'permissions',
      'summary'
    ])
        || !isSafeId(behavior.id)
        || ids.has(behavior.id)
        || typeof behavior.description !== 'string'
        || !behavior.description.trim()
        || !Array.isArray(behavior.locators)
        || !Array.isArray(behavior.tests)
        || !Array.isArray(behavior.dependencies)
        || !Array.isArray(behavior.permissions)
        || !(behavior.summary === null || plainObject(behavior.summary))) return false;
    ids.add(behavior.id);
  }
  return targetBehaviorIds.every((id) => ids.has(id));
}

function compatibilityValid(value) {
  const allowed = [
    'component', 'domains', 'schemaVersions', 'model', 'models',
    'harnessSha256', 'harnessSha256s', 'toolEnvironmentSha256',
    'toolEnvironmentSha256s', 'permissions', 'securityRequirements',
    'versionConstraints'
  ];
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    return false;
  }
  return Object.entries(value).every(([key, item]) => (
    ['domains', 'schemaVersions', 'models', 'harnessSha256s',
      'toolEnvironmentSha256s', 'permissions', 'securityRequirements',
      'versionConstraints'].includes(key)
      ? Array.isArray(item) && item.every((entry) => typeof entry === 'string' && entry.length > 0)
      : typeof item === 'string' && item.length > 0
  ));
}

function embeddingsValid(embeddings, queryEmbedding) {
  if (!plainObject(embeddings)
      || !Object.entries(embeddings).every(([key, vector]) => (
        isSafeId(key)
        && Array.isArray(vector)
        && vector.length > 0
        && vector.length <= 4096
        && vector.every(Number.isFinite)
      ))) return false;
  return queryEmbedding == null || (
    Array.isArray(queryEmbedding)
    && queryEmbedding.length > 0
    && queryEmbedding.length <= 4096
    && queryEmbedding.every(Number.isFinite)
  );
}

function externalSourcesValid(sources, allowlist, createdAt, enabled, sealedMode) {
  if (!Array.isArray(sources) || sources.length > 64
      || !Array.isArray(allowlist)
      || allowlist.some((host) => typeof host !== 'string' || !host || host.includes('/') || host.includes(':'))
      || (sealedMode && (enabled || sources.length > 0))
      || (!enabled && sources.length > 0)) return false;
  if (!enabled) return true;
  const allowed = new Set(allowlist.map((host) => host.toLowerCase()));
  return sources.every((source) => {
    if (!exactKeys(source, [
      'id', 'url', 'title', 'authorityClass', 'retrievedAt', 'content',
      'contentSha256'
    ]) || !isSafeId(source.id) || source.authorityClass !== 'primary'
        || typeof source.title !== 'string' || !source.title.trim()
        || typeof source.content !== 'string' || !source.content.trim()
        || source.contentSha256 !== sha256(source.content)
        || !Number.isFinite(Date.parse(source.retrievedAt))
        || Date.parse(source.retrievedAt) > Date.parse(createdAt)) return false;
    try {
      const url = new URL(source.url);
      return url.protocol === 'https:' && !url.username && !url.password
        && allowed.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}

function mutationObjectiveValid(value) {
  return exactKeys(value, [
    'measurementId', 'measurementSha256', 'failureCaseSetSha256',
    'successCaseSetSha256', 'targetMetric', 'direction'
  ])
    && /^measurement-[a-f0-9]{24}$/.test(String(value.measurementId || ''))
    && [value.measurementSha256, value.failureCaseSetSha256,
      value.successCaseSetSha256].every((item) => SHA256.test(String(item || '')))
    && value.failureCaseSetSha256 !== value.successCaseSetSha256
    && ['code-rate', 'control-exact-rate', 'decision-rate', 'exact-case-rate',
      'full-repair-rate', 'target-exact-rate', 'token-cost'].includes(value.targetMetric)
    && value.direction === (value.targetMetric === 'token-cost' ? 'decrease' : 'increase');
}

function callBudgetsValid(budgets, externalResearchEnabled) {
  const roles = requiredBudgetRoles(externalResearchEnabled);
  return exactKeys(budgets, roles)
    && roles.every((role) => (
      exactKeys(budgets[role], ['maxInputTokens', 'maxOutputTokens'])
      && Number.isSafeInteger(budgets[role].maxInputTokens)
      && budgets[role].maxInputTokens > 0
      && Number.isSafeInteger(budgets[role].maxOutputTokens)
      && budgets[role].maxOutputTokens > 0
    ));
}

function preparationValid(value, createdAt) {
  const baseKeys = [
    'failure', 'evidenceRecords', 'behaviorMap', 'targetBehaviorIds',
    'feedbackArtifacts', 'architectureFacts', 'architectureConstraints',
    'publicMeasurementContract', 'compatibility', 'embeddings',
    'queryEmbedding', 'maximumCandidates', 'maximumSelected',
    'exploreUncertainty', 'enableModelReranker', 'internalResearchEnabled',
    'hypothesisFalsificationEnabled', 'externalResearchEnabled',
    'sealedMode', 'externalSources', 'externalSourceAllowlist',
    'dossierMaximumItems', 'dossierMaximumBytes', 'candidateStrategy',
    'candidateFeatureFlags', 'candidateStrategyState', 'protectedSurfaces', 'maxOperations',
    'modelPolicy', 'callBudgets'
  ];
  const hasExternalPolicy = Object.hasOwn(value ?? {}, 'externalResearchPolicy');
  if (!exactKeys(value, hasExternalPolicy
    ? [...baseKeys, 'externalResearchPolicy']
    : baseKeys)
      || normalizeVNextFailure({ ...value.failure, observedAt: createdAt }).status !== 'OK'
      || !Array.isArray(value.evidenceRecords)
      || value.evidenceRecords.length < 1
      || value.evidenceRecords.some((record) => validateVNextEvidenceRecord(record).status !== 'OK')
      || !sortedUniqueStrings(value.targetBehaviorIds, { minimum: 1 })
      || !behaviorMapValid(value.behaviorMap, value.targetBehaviorIds)
      || !Array.isArray(value.feedbackArtifacts)
      || value.feedbackArtifacts.length > 64
      || value.feedbackArtifacts.some((artifact) => validateTaskAgentFeedbackArtifact(artifact).status !== 'OK')
      || !boundedCanonicalObject(value.architectureFacts, 128 * 1024)
      || !sortedUniqueStrings(value.architectureConstraints)
      || !boundedCanonicalObject(value.publicMeasurementContract, 64 * 1024)
      || !compatibilityValid(value.compatibility)
      || !embeddingsValid(value.embeddings, value.queryEmbedding)
      || !Number.isSafeInteger(value.maximumCandidates)
      || value.maximumCandidates < 1
      || value.maximumCandidates > 256
      || !Number.isSafeInteger(value.maximumSelected)
      || value.maximumSelected < 1
      || value.maximumSelected > value.maximumCandidates
      || typeof value.exploreUncertainty !== 'boolean'
      || typeof value.enableModelReranker !== 'boolean'
      || typeof value.internalResearchEnabled !== 'boolean'
      || typeof value.hypothesisFalsificationEnabled !== 'boolean'
      || typeof value.externalResearchEnabled !== 'boolean'
      || typeof value.sealedMode !== 'boolean'
      || (value.sealedMode && value.externalResearchEnabled)
      || !Array.isArray(value.externalSources)
      || !Array.isArray(value.externalSourceAllowlist)
      || !externalSourcesValid(
        value.externalSources,
        value.externalSourceAllowlist,
        createdAt,
        value.externalResearchEnabled,
        value.sealedMode
      )
      || (value.externalResearchEnabled
        ? !hasExternalPolicy
          || validateExternalResearchPolicy(value.externalResearchPolicy).status !== 'OK'
          || value.externalSources.length !== 0
          || canonicalVNextJson(value.externalSourceAllowlist)
            !== canonicalVNextJson(value.externalResearchPolicy.allowlist)
          || Date.parse(value.externalResearchPolicy.createdAt) > Date.parse(createdAt)
        : hasExternalPolicy && value.externalResearchPolicy !== null)
      || !Number.isSafeInteger(value.dossierMaximumItems)
      || value.dossierMaximumItems < 1
      || value.dossierMaximumItems > 256
      || !Number.isSafeInteger(value.dossierMaximumBytes)
      || value.dossierMaximumBytes < 1024
      || value.dossierMaximumBytes > 1024 * 1024
      || !CANDIDATE_STRATEGIES.has(value.candidateStrategy)
      || !plainObject(value.candidateFeatureFlags)
      || Object.keys(value.candidateFeatureFlags).some((key) => (
        !Object.values(VNEXT_CANDIDATE_GENERATOR_FLAGS).includes(key)
        || typeof value.candidateFeatureFlags[key] !== 'boolean'
      ))
      || (value.candidateStrategy !== 'native'
        && value.candidateFeatureFlags[
          VNEXT_CANDIDATE_GENERATOR_FLAGS[value.candidateStrategy]
        ] !== true)
      || (value.candidateStrategy === 'native'
        ? value.candidateStrategyState !== null
        : !boundedCanonicalObject(value.candidateStrategyState, 512 * 1024))
      || !sortedUniqueStrings(value.protectedSurfaces, { minimum: 1 })
      || MANDATORY_PROTECTED_SURFACES.some((surface) => (
        !value.protectedSurfaces.includes(surface)
      ))
      || !Number.isSafeInteger(value.maxOperations)
      || value.maxOperations < 1
      || value.maxOperations > 3
      || !modelPolicyValid(value.modelPolicy, value.externalResearchEnabled)
      || !callBudgetsValid(value.callBudgets, value.externalResearchEnabled)) return false;
  return value.enableModelReranker || value.modelPolicy.reranker != null;
}

function mechanismValid(value) {
  return exactKeys(value, [
    'parentFamily', 'mutationObjective', 'reasonCodes', 'expectedEffectCode'
  ])
    && validateAdaptiveRecord(value.parentFamily).status === 'OK'
    && plainObject(value.parentFamily.causalFingerprint?.program)
    && mutationObjectiveValid(value.mutationObjective)
    && sortedUniqueStrings(value.reasonCodes, { minimum: 1, maximum: 12 })
    && value.reasonCodes.every((reason) => REASON.test(reason))
    && REASON.test(String(value.expectedEffectCode || ''));
}

function recursiveCanaryValid(value) {
  return exactKeys(value, [
    'model', 'reasoningEffort', 'authMode', 'retries', 'promotionEnabled',
    'historicalTokenEstimate', 'replicatesPerArm', 'calibrationRule',
    'confirmationRule', 'perCallBudget'
  ])
    && ADAPTIVE_RECURSIVE_SUPPORTED_MODELS.includes(value.model)
    && ADAPTIVE_RECURSIVE_REASONING_EFFORTS.includes(value.reasoningEffort)
    && value.authMode === 'chatgpt-oauth'
    && value.retries === 0
    && value.promotionEnabled === false
    && Number.isSafeInteger(value.historicalTokenEstimate)
    && value.historicalTokenEstimate > 0
    && value.replicatesPerArm === 3
    && value.calibrationRule === 'paired-placebo-upper-bound-v1'
    && value.confirmationRule === 'five-task-adjusted-sign-test-v1'
    && exactKeys(value.perCallBudget, ['maxInputTokens', 'maxOutputTokens'])
    && Number.isSafeInteger(value.perCallBudget.maxInputTokens)
    && value.perCallBudget.maxInputTokens > 0
    && Number.isSafeInteger(value.perCallBudget.maxOutputTokens)
    && value.perCallBudget.maxOutputTokens > 0;
}

function paceValid(value) {
  return exactKeys(value, [
    'lambdaPolicy', 'maximumShamMovement', 'maximumRelativeTokenIncrease'
  ])
    && (exactKeys(value.lambdaPolicy, ['kind', 'value'])
      && value.lambdaPolicy.kind === 'fixed'
      && Number.isFinite(value.lambdaPolicy.value)
      && value.lambdaPolicy.value >= 0
      && value.lambdaPolicy.value <= 1
      || exactKeys(value.lambdaPolicy, ['kind', 'maximum', 'priorLosses', 'priorWins'])
      && value.lambdaPolicy.kind === 'predictable-empirical'
      && Number.isFinite(value.lambdaPolicy.maximum)
      && value.lambdaPolicy.maximum >= 0
      && value.lambdaPolicy.maximum <= 1
      && Number.isFinite(value.lambdaPolicy.priorLosses)
      && value.lambdaPolicy.priorLosses > 0
      && Number.isFinite(value.lambdaPolicy.priorWins)
      && value.lambdaPolicy.priorWins > 0)
    && Number.isFinite(value.maximumShamMovement)
    && value.maximumShamMovement >= 0
    && Number.isFinite(value.maximumRelativeTokenIncrease)
    && value.maximumRelativeTokenIncrease >= 0;
}

function configPayload(config) {
  const core = structuredClone(config);
  delete core.configSha256;
  return core;
}

export function deriveVNextWaveModelPolicySha256(config) {
  return sha256(canonicalVNextJson({
    runtimeAuthoritySha256: config.runtimeAuthority.authoritySha256,
    ablationProfileSha256: config.ablationProfile.profileSha256,
    preparationModelPolicy: config.preparation.modelPolicy,
    recursiveRoute: {
      model: config.recursiveCanary.model,
      reasoningEffort: config.recursiveCanary.reasoningEffort,
      authMode: config.recursiveCanary.authMode
    }
  }));
}

export function deriveVNextWaveEvaluatorPolicySha256(config) {
  return config.evaluatorAuthority.authoritySha256;
}

export function createVNextWaveConfig(input = {}) {
  const base = {
    schemaVersion: VNEXT_WAVE_CONFIG_SCHEMA,
    waveId: input.waveId,
    preparationRunId: input.preparationRunId,
    experimentRunId: input.experimentRunId,
    createdAt: input.createdAt,
    proposalRecordedAt: input.proposalRecordedAt,
    shadowRecordedAt: input.shadowRecordedAt,
    preparationBudgetPolicyId: input.preparationBudgetPolicyId,
    experimentBudgetPolicyId: input.experimentBudgetPolicyId,
    requireProductionEvidence: true,
    runtimeAuthority: structuredClone(input.runtimeAuthority),
    evaluatorAuthority: structuredClone(input.evaluatorAuthority),
    ablationProfile: structuredClone(input.ablationProfile),
    preparation: structuredClone(input.preparation),
    mechanism: structuredClone(input.mechanism),
    taskSplit: {
      calibrationTaskIds: [...(input.taskSplit?.calibrationTaskIds ?? [])].sort(),
      confirmationTaskIds: [...(input.taskSplit?.confirmationTaskIds ?? [])].sort()
    },
    recursiveCanary: structuredClone(input.recursiveCanary),
    pace: structuredClone(input.pace)
  };
  const config = {
    ...base,
    configSha256: sha256(canonicalVNextJson(base))
  };
  return validateVNextWaveConfig(config).status === 'OK'
    ? { status: 'OK', config }
    : { status: 'REFUSED', code: 'VNEXT_WAVE_CONFIG_INVALID' };
}

export function validateVNextWaveConfig(config) {
  if (!exactKeys(config, [
    'schemaVersion', 'waveId', 'preparationRunId', 'experimentRunId',
    'createdAt', 'proposalRecordedAt', 'shadowRecordedAt',
    'preparationBudgetPolicyId', 'experimentBudgetPolicyId',
    'requireProductionEvidence', 'runtimeAuthority', 'evaluatorAuthority',
    'ablationProfile', 'preparation', 'mechanism', 'taskSplit',
    'recursiveCanary', 'pace', 'configSha256'
  ])
      || config.schemaVersion !== VNEXT_WAVE_CONFIG_SCHEMA
      || !isSafeId(config.waveId)
      || !isSafeId(config.preparationRunId)
      || !isSafeId(config.experimentRunId)
      || config.preparationRunId === config.experimentRunId
      || !isSafeId(config.preparationBudgetPolicyId)
      || !isSafeId(config.experimentBudgetPolicyId)
      || config.preparationBudgetPolicyId === config.experimentBudgetPolicyId
      || config.requireProductionEvidence !== true
      || validateCodexOAuthAuthorityRecord(config.runtimeAuthority).status !== 'OK'
      || validateExecutableEvaluatorAuthority(config.evaluatorAuthority).status !== 'OK'
      || validateVNextAblationProfile(config.ablationProfile).status !== 'OK'
      || !Number.isFinite(Date.parse(config.createdAt))
      || !Number.isFinite(Date.parse(config.proposalRecordedAt))
      || !Number.isFinite(Date.parse(config.shadowRecordedAt))
      || Date.parse(config.proposalRecordedAt) <= Date.parse(config.createdAt)
      || Date.parse(config.shadowRecordedAt) <= Date.parse(config.proposalRecordedAt)
      || !preparationValid(config.preparation, config.createdAt)
      || validateVNextAblationPreparation(
        config.ablationProfile,
        config.preparation
      ).status !== 'OK'
      || !mechanismValid(config.mechanism)
      || !exactKeys(config.taskSplit, ['calibrationTaskIds', 'confirmationTaskIds'])
      || !sortedUniqueStrings(config.taskSplit.calibrationTaskIds, { minimum: 5, maximum: 5 })
      || !sortedUniqueStrings(config.taskSplit.confirmationTaskIds, { minimum: 5, maximum: 5 })
      || config.taskSplit.calibrationTaskIds.some((id) => (
        config.taskSplit.confirmationTaskIds.includes(id)
      ))
      || !recursiveCanaryValid(config.recursiveCanary)
      || config.runtimeAuthority.requestedModel !== config.recursiveCanary.model
      || config.runtimeAuthority.reasoningEffort !== config.recursiveCanary.reasoningEffort
      || Object.values(config.preparation.modelPolicy).some((route) => (
        route.model !== config.recursiveCanary.model
        || route.reasoningEffort !== config.recursiveCanary.reasoningEffort
        || route.identityPolicy.oauthAuthoritySha256
          !== config.runtimeAuthority.authoritySha256
        || route.identityPolicy.executableSha256
          !== config.runtimeAuthority.binary.sha256
      ))
      || !paceValid(config.pace)
      || !SHA256.test(String(config.configSha256 || ''))
      || config.configSha256 !== sha256(canonicalVNextJson(configPayload(config)))) {
    return { status: 'REFUSED', code: 'VNEXT_WAVE_CONFIG_INVALID' };
  }
  return { status: 'OK', config };
}

export function vnextPreparationMaximumCalls(config) {
  if (validateVNextWaveConfig(config).status !== 'OK') return null;
  return vnextAblationPreparationMaximumCalls(config.ablationProfile, {
    externalResearchEnabled: config.preparation.externalResearchEnabled
  });
}
