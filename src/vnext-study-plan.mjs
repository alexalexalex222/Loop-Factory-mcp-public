import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import {
  captureExecutableEvaluatorAuthority,
  validateExecutableEvaluatorAuthority
} from './adaptive-executable-canary.mjs';
import {
  createCampaignSeriesPlan,
  createCampaignSeriesState,
  enqueueCampaignSeriesWave
} from './campaign-series.mjs';
import {
  appendCampaignSeriesCheckpoint,
  initializeCampaignSeriesStore,
  persistCampaignSeriesWaveInputs
} from './campaign-series-store.mjs';
import {
  validateCodexOAuthAuthorityRecord
} from './codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  STRICT_CODEX_RESEARCH_DISABLED_FEATURES,
  STRICT_CODEX_RESEARCH_ENABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from './executor.mjs';
import { canonicalMechanismProgramJson } from './mechanism-compiler.mjs';
import {
  createResourceBudgetLedger,
  createResourceBudgetPolicy
} from './resource-budget.mjs';
import { isSafeId, sha256 } from './util.mjs';
import {
  createVNextAblationProfile,
  validateVNextAblationProfile,
  vnextAblationPreparationRoleCalls
} from './vnext-ablation-profile.mjs';
import {
  MANDATORY_PROTECTED_SURFACES,
  VNEXT_CANDIDATE_GENERATOR_FLAGS
} from './vnext-candidate-generators.mjs';
import {
  candidateStrategyRequiredEvidenceIds,
  createCandidateStrategyPlan
} from './vnext-candidate-strategies.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  createVNextEvidenceRecord,
  validateVNextEvidenceRecord
} from './vnext-evidence-bank.mjs';
import { createVNextModelIdentityPolicy } from './vnext-model-identity.mjs';
import {
  validateVNextTaskMaterialBundle,
  validateVNextTaskPack
} from './vnext-task-pack.mjs';
import {
  createVNextWaveConfig,
  deriveVNextWaveEvaluatorPolicySha256,
  deriveVNextWaveModelPolicySha256
} from './vnext-wave-config.mjs';
import {
  planVNextCampaignWave,
  resolveVNextWaveImplementation
} from './vnext-wave-runner.mjs';

export const VNEXT_STUDY_DISCLOSURE_SCHEMA =
  'loop-factory-vnext-study-disclosure-v1';

export const DEFAULT_VNEXT_STUDY_CALL_BUDGETS = Object.freeze({
  'candidate-generator': Object.freeze({ maxInputTokens: 64_000, maxOutputTokens: 12_000 }),
  falsifier: Object.freeze({ maxInputTokens: 64_000, maxOutputTokens: 8_000 }),
  hypothesizer: Object.freeze({ maxInputTokens: 64_000, maxOutputTokens: 8_000 }),
  reranker: Object.freeze({ maxInputTokens: 48_000, maxOutputTokens: 8_000 }),
  researcher: Object.freeze({ maxInputTokens: 48_000, maxOutputTokens: 8_000 }),
  'external-researcher': Object.freeze({ maxInputTokens: 32_000, maxOutputTokens: 8_000 })
});

export const DEFAULT_VNEXT_STUDY_EXPERIMENT_CALL_BUDGET = Object.freeze({
  maxInputTokens: 32_000,
  maxOutputTokens: 8_000
});

const PREPARATION_ROLE_KIND = Object.freeze({
  'candidate-generator': 'candidate',
  falsifier: 'falsification',
  hypothesizer: 'hypothesis',
  reranker: 'reranker',
  researcher: 'research',
  'external-researcher': 'external-research-discovery'
});
const PREPARATION_ROLES = Object.freeze([
  'candidate-generator',
  'falsifier-initial',
  'falsifier-revision',
  'hypothesis-reviser',
  'hypothesizer',
  'reranker',
  'researcher'
]);
const DISCLOSURE_FILE = 'campaign-series/study-disclosure.json';
const SHA256 = /^[a-f0-9]{64}$/;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isoOffset(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function safeStrings(values, maximum = 128) {
  if (!Array.isArray(values) || values.length > maximum
      || values.some((value) => typeof value !== 'string' || !value.trim())) return null;
  return [...new Set(values.map((value) => value.trim()))].sort();
}

function programItemId(collection, value) {
  if (collection === 'selectors') return value.selectorId;
  if (collection === 'bindings') return value.bindingId;
  if (collection === 'metrics') return value.metricId;
  if (collection === 'rules') return value.ruleId;
  return sha256(canonicalMechanismProgramJson(value)).slice(0, 24);
}

function mechanismLocators(program) {
  const values = [{
    target: 'mechanism-program/fallback',
    symbol: 'fallback',
    value: program.fallback
  }];
  for (const collection of [
    'bindings', 'forbiddenBindings', 'metrics', 'rules', 'selectors'
  ]) {
    for (const value of program[collection] ?? []) {
      values.push({
        target: `mechanism-program/${collection.toLowerCase()}/${programItemId(collection, value)}`,
        symbol: programItemId(collection, value),
        value
      });
    }
  }
  return values.map(({ target, symbol, value }) => {
    const digest = sha256(canonicalMechanismProgramJson(value));
    return {
      path: target,
      symbol,
      symbolSha256: sha256(symbol),
      startLine: 1,
      endLine: 1,
      sourceSha256: digest,
      locatorSha256: digest
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function buildBehaviorMap(parentFamily) {
  const program = parentFamily.causalFingerprint.program;
  const core = {
    schemaVersion: 'vnext-harness-handbook-v1',
    repositoryRootSha256: sha256(canonicalMechanismProgramJson(program)),
    authority: 'descriptive-source-map-only',
    canAuthorizeEdits: false,
    behaviors: [{
      id: 'mechanism-program',
      description: 'The bounded executable mechanism program under causal evaluation.',
      locators: mechanismLocators(program),
      tests: [],
      dependencies: [],
      permissions: [],
      summary: null
    }]
  };
  return { ...core, behaviorMapSha256: sha256(canonicalVNextJson(core)) };
}

function buildFailure(taskPack, createdAt) {
  const sourceEvidence = taskPack.tasks.map((task) => ({
    id: `baseline-${task.taskId}`,
    schemaVersion: 'vnext-task-baseline-failure-v1',
    sha256: task.baselineFailure.verifierEvidenceSha256,
    availableAt: taskPack.createdAt,
    locator: `${task.source.path}#${task.baselineFailure.targetFailureIds[0]}`
  }));
  const domains = [...new Set(taskPack.tasks.map((task) => task.domain))].sort();
  return {
    failureId: `failure-${taskPack.packSha256.slice(0, 24)}`,
    summary: `The frozen parent mechanism fails verified target cases across ${taskPack.tasks.length} disjoint task clusters.`,
    behavior: 'Bounded mechanism-program admission behavior',
    component: 'mechanism-program',
    symptoms: taskPack.tasks.map((task) => (
      `${task.taskId} has ${task.baselineFailure.targetFailureIds.length} verifier-observed target failures while every declared control passes.`
    )),
    environment: {
      taskPackId: taskPack.packId,
      taskPackSha256: taskPack.packSha256,
      taskPartition: taskPack.partition,
      taskClusterCount: taskPack.tasks.length,
      domains,
      evaluatorAuthoritySha256: taskPack.evaluatorAuthority.authoritySha256,
      observedAt: createdAt
    },
    sourceEvidence
  };
}

function buildBaselineEvidenceRecord(taskPack, model, createdAt) {
  const domains = [...new Set(taskPack.tasks.map((task) => task.domain))].sort();
  return createVNextEvidenceRecord({
    kind: 'failure',
    availableAt: taskPack.createdAt,
    createdAt,
    sourceIds: taskPack.tasks.map((task) => task.taskId),
    verifierEvidenceHashes: taskPack.tasks.map((task) => (
      task.baselineFailure.verifierEvidenceSha256
    )),
    compatibility: {
      component: 'mechanism-program',
      domains,
      tags: ['baseline-failure', 'mechanism-program', taskPack.partition],
      schemaVersions: [taskPack.schemaVersion],
      models: [model],
      harnessSha256s: [],
      toolEnvironmentSha256s: [taskPack.evaluatorAuthority.authoritySha256],
      permissions: [],
      securityRequirements: [],
      versionConstraints: []
    },
    lifecycle: {
      state: 'observed',
      quarantined: false,
      quarantineReason: null
    },
    metrics: {
      qualityDelta: null,
      costUsd: null,
      latencyMs: null,
      tokenCost: null,
      uncertainty: 1
    },
    content: {
      statement: 'The task-pack baseline fails target cases and preserves controls; no proposed repair is included in this record.',
      taskPackId: taskPack.packId,
      taskPackSha256: taskPack.packSha256,
      partition: taskPack.partition,
      targetFailureCount: taskPack.tasks.reduce((sum, task) => (
        sum + task.baselineFailure.targetFailureIds.length
      ), 0),
      controlPassCount: taskPack.tasks.reduce((sum, task) => (
        sum + task.baselineFailure.controlPassIds.length
      ), 0)
    },
    callerClaims: {}
  });
}

function taskSplit(taskPack) {
  const calibrationTaskIds = taskPack.tasks
    .filter((task) => task.tags.includes('qualification'))
    .map((task) => task.taskId).sort();
  const confirmationTaskIds = taskPack.tasks
    .filter((task) => task.tags.includes('confirmation'))
    .map((task) => task.taskId).sort();
  return calibrationTaskIds.length === 5 && confirmationTaskIds.length === 5
    ? { calibrationTaskIds, confirmationTaskIds }
    : null;
}

function normalizedEvidenceRecords(taskPack, model, createdAt, values) {
  const baseline = buildBaselineEvidenceRecord(taskPack, model, createdAt);
  if (baseline.status !== 'OK' || !Array.isArray(values)) return null;
  const byId = new Map([[baseline.record.recordId, baseline.record]]);
  for (const record of values) {
    if (validateVNextEvidenceRecord(record).status !== 'OK') return null;
    const current = byId.get(record.recordId);
    if (current && current.recordSha256 !== record.recordSha256) return null;
    byId.set(record.recordId, record);
  }
  return [...byId.values()].sort((left, right) => (
    left.recordId.localeCompare(right.recordId)
  ));
}

function roleRoutes(runtimeAuthority, identityPolicy, externalResearchEnabled) {
  const roles = externalResearchEnabled
    ? [...PREPARATION_ROLES, 'external-researcher']
    : [...PREPARATION_ROLES];
  return Object.fromEntries(roles.map((role) => [role, {
    model: runtimeAuthority.requestedModel,
    reasoningEffort: runtimeAuthority.reasoningEffort,
    identityPolicy
  }]));
}

function normalizedCallBudgets(overrides, externalResearchEnabled) {
  const roles = externalResearchEnabled
    ? Object.keys(DEFAULT_VNEXT_STUDY_CALL_BUDGETS)
    : Object.keys(DEFAULT_VNEXT_STUDY_CALL_BUDGETS)
      .filter((role) => role !== 'external-researcher');
  const values = {};
  for (const role of roles) {
    const value = overrides?.[role] ?? DEFAULT_VNEXT_STUDY_CALL_BUDGETS[role];
    if (!exactKeys(value, ['maxInputTokens', 'maxOutputTokens'])
        || !Number.isSafeInteger(value.maxInputTokens) || value.maxInputTokens < 1
        || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1) {
      return null;
    }
    values[role] = { ...value };
  }
  return values;
}

function policy(input) {
  const built = createResourceBudgetPolicy({
    ...input,
    maxTotalTokens: input.maxInputTokens + input.maxOutputTokens,
    maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd',
    currency: 'USD'
  });
  return built.status === 'OK' ? built.policy : null;
}

function preparationPolicy(config, roleCalls) {
  const exposure = Object.entries(roleCalls).reduce((sum, [role, calls]) => {
    if (calls === 0) return sum;
    return {
      calls: sum.calls + calls,
      input: sum.input + calls * config.preparation.callBudgets[role].maxInputTokens,
      output: sum.output + calls * config.preparation.callBudgets[role].maxOutputTokens
    };
  }, { calls: 0, input: 0, output: 0 });
  return policy({
    policyId: config.preparationBudgetPolicyId,
    maxCalls: exposure.calls,
    maxInputTokens: exposure.input,
    maxOutputTokens: exposure.output
  });
}

function experimentPolicy(config) {
  const calls = 120;
  return policy({
    policyId: config.experimentBudgetPolicyId,
    maxCalls: calls,
    maxInputTokens: calls * config.recursiveCanary.perCallBudget.maxInputTokens,
    maxOutputTokens: calls * config.recursiveCanary.perCallBudget.maxOutputTokens
  });
}

function rootPolicy(seriesRunId, preparation, experiment) {
  return policy({
    policyId: `${seriesRunId}-root-budget`,
    maxCalls: preparation.maxCalls + experiment.maxCalls,
    maxInputTokens: preparation.maxInputTokens + experiment.maxInputTokens,
    maxOutputTokens: preparation.maxOutputTokens + experiment.maxOutputTokens
  });
}

function portableInvocation(kind, model, reasoningEffort, toolPolicy) {
  const executorKind = kind === 'proposal'
    ? 'proposal'
    : kind === 'external-research-discovery'
      ? 'vnext-external-research-discovery'
      : `vnext-${kind}`;
  const schemaPath = schemaPathForContract({ kind: executorKind });
  if (!schemaPath) return null;
  const argv = buildArgs('codex', null, model, {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: '<fresh-model-capsule>',
    toolPolicy,
    reasoningEffort
  }).map((value) => value === schemaPath ? `<output-schema:${basename(schemaPath)}>` : value);
  const research = toolPolicy === 'research-web-read-only';
  return {
    kind,
    toolPolicy,
    argv,
    outputSchemaPath: `src/schemas/${basename(schemaPath)}`,
    outputSchemaSha256: sha256(readFileSync(schemaPath)),
    disabledFeatures: research
      ? [...STRICT_CODEX_RESEARCH_DISABLED_FEATURES]
      : [...STRICT_CODEX_DISABLED_FEATURES],
    enabledFeatures: research ? [...STRICT_CODEX_RESEARCH_ENABLED_FEATURES] : [],
    promptTransport: 'stdin',
    filesystem: 'fresh-read-only-capsule',
    conversation: 'fresh-ephemeral-process'
  };
}

function executionDisclosure(config, roleCalls) {
  const preparation = Object.entries(roleCalls)
    .filter(([, calls]) => calls > 0)
    .map(([role, calls]) => {
      const kind = PREPARATION_ROLE_KIND[role];
      const invocation = portableInvocation(
        kind,
        config.recursiveCanary.model,
        config.recursiveCanary.reasoningEffort,
        role === 'external-researcher' ? 'research-web-read-only' : 'none'
      );
      return invocation ? { role, maximumCalls: calls, ...invocation } : null;
    });
  const experiment = portableInvocation(
    'proposal',
    config.recursiveCanary.model,
    config.recursiveCanary.reasoningEffort,
    'none'
  );
  return preparation.some((row) => row == null) || experiment == null
    ? null
    : { preparation, experiment };
}

function disclosureCore({ store, build, planned }) {
  const exposure = planned.exposure;
  const execution = executionDisclosure(build.config, build.roleCalls);
  if (!execution) return null;
  return {
    schemaVersion: VNEXT_STUDY_DISCLOSURE_SCHEMA,
    seriesRunId: build.seriesRunId,
    waveId: build.waveId,
    armId: build.ablationProfile.armId,
    studyBinding: build.studyBinding,
    createdAt: build.createdAt,
    proofHome: realpathSync(store.homeDir),
    taskPack: {
      packId: build.taskPack.packId,
      partition: build.taskPack.partition,
      packSha256: build.taskPack.packSha256,
      taskIdentitySetSha256: build.taskPack.taskIdentitySetSha256,
      taskClusters: build.taskPack.tasks.length
    },
    parentMechanism: {
      familyId: build.parentFamily.familyId,
      familySha256: build.parentFamily.familySha256,
      mutationObjectiveSha256: sha256(canonicalVNextJson(build.mutationObjective))
    },
    model: {
      requestedModel: build.runtimeAuthority.requestedModel,
      reasoningEffort: build.runtimeAuthority.reasoningEffort,
      authMode: 'chatgpt-oauth',
      oauthAuthoritySha256: build.runtimeAuthority.authoritySha256,
      executableSha256: build.runtimeAuthority.binary.sha256,
      fallbackModels: []
    },
    evaluatorAuthoritySha256: build.evaluatorAuthority.authoritySha256,
    ablationProfileSha256: build.ablationProfile.profileSha256,
    implementationSha256: planned.implementation.implementationSha256,
    configSha256: build.config.configSha256,
    campaignPlanSha256: build.seriesPlan.planSha256,
    wavePlanSha256: planned.planSha256,
    budgetPolicySha256s: [
      build.preparationBudget.policySha256,
      build.experimentBudget.policySha256,
      build.rootBudget.policySha256
    ].sort(),
    exposure: {
      preparationCalls: exposure.preparationCalls,
      calibrationCalls: 60,
      conditionalConfirmationCalls: 60,
      maximumCalls: exposure.maximumCalls,
      maximumInputTokens: exposure.maximumInputTokens,
      maximumOutputTokens: exposure.maximumOutputTokens,
      maximumTotalTokens: exposure.maximumTotalTokens,
      maximumUsdMicros: exposure.maximumUsdMicros,
      billingMode: 'subscription-no-metered-usd',
      tokenCeilingEnforcement: 'receipt-ledger-fail-closed-after-each-call; no provider-side preemption inside one call',
      historicalTokenEstimate: build.historicalTokenEstimate,
      sequentialTimeoutCeilingMinutes: 1200
    },
    execution,
    controls: {
      retries: 0,
      promotionEnabled: false,
      confirmationConditional: true,
      shamArm: true,
      parentArm: true,
      coldArm: true,
      candidateArm: true,
      evaluatorIsolationRequired: true
    },
    approval: {
      requiredBeforeLaunch: true,
      authority: 'operator-exact-study-disclosure-sha256',
      workerLaunchedAtPlanning: false,
      paidModelCallsAtPlanning: 0
    }
  };
}

export function createVNextStudyWave(input = {}) {
  const createdAt = input.createdAt;
  const taskPack = input.taskPack;
  const taskMaterialBundle = input.taskMaterialBundle;
  const parentFamily = input.parentFamily;
  const runtimeAuthority = input.runtimeAuthority;
  const evaluatorAuthority = input.evaluatorAuthority
    ?? captureExecutableEvaluatorAuthority().record;
  const profile = createVNextAblationProfile({
    armId: input.armId,
    selectedGeneratorArm: input.selectedGeneratorArm ?? null
  });
  const externalResearchEnabled = input.externalResearchEnabled === true;
  const split = validateVNextTaskPack(taskPack).status === 'OK'
    ? taskSplit(taskPack) : null;
  const callBudgets = normalizedCallBudgets(
    input.preparationCallBudgets,
    externalResearchEnabled
  );
  const experimentCallBudget = input.experimentCallBudget
    ?? DEFAULT_VNEXT_STUDY_EXPERIMENT_CALL_BUDGET;
  if (!isSafeId(input.seriesRunId) || !isSafeId(input.waveId)
      || !Number.isFinite(Date.parse(createdAt))
      || !taskPack || taskPack.partition === 'final'
      || validateVNextTaskPack(taskPack).status !== 'OK'
      || validateVNextTaskMaterialBundle({ bundle: taskMaterialBundle, pack: taskPack }).status !== 'OK'
      || Date.parse(createdAt) <= Date.parse(taskPack.createdAt)
      || validateAdaptiveRecord(parentFamily).status !== 'OK'
      || parentFamily.schemaVersion !== 'mechanism-family-v1'
      || !plainObject(parentFamily.causalFingerprint?.program)
      || !plainObject(input.mutationObjective)
      || validateCodexOAuthAuthorityRecord(runtimeAuthority).status !== 'OK'
      || validateExecutableEvaluatorAuthority(evaluatorAuthority).status !== 'OK'
      || canonicalVNextJson(evaluatorAuthority) !== canonicalVNextJson(taskPack.evaluatorAuthority)
      || profile.status !== 'OK' || !split || !callBudgets
      || !exactKeys(experimentCallBudget, ['maxInputTokens', 'maxOutputTokens'])
      || !Number.isSafeInteger(experimentCallBudget.maxInputTokens)
      || experimentCallBudget.maxInputTokens < 1
      || !Number.isSafeInteger(experimentCallBudget.maxOutputTokens)
      || experimentCallBudget.maxOutputTokens < 1
      || !Number.isSafeInteger(input.historicalTokenEstimate ?? 4_000_000)
      || (input.historicalTokenEstimate ?? 4_000_000) < 1
      || !exactKeys(input.studyBinding, [
        'protocolSha256', 'phaseId', 'memoryLedgerSha256'
      ])
      || !SHA256.test(String(input.studyBinding.protocolSha256 || ''))
      || !isSafeId(input.studyBinding.phaseId)
      || !(input.studyBinding.memoryLedgerSha256 == null
        || SHA256.test(String(input.studyBinding.memoryLedgerSha256)))) {
    return refused(
      'VNEXT_STUDY_INPUT_INVALID',
      'A study wave requires one development/validation task pack, exact material/evaluator/runtime authority, one parent mechanism, and closed budgets.'
    );
  }
  const strategy = profile.profile.candidateStrategy;
  const strategyState = strategy === 'native'
    ? null
    : structuredClone(input.candidateStrategyState ?? null);
  const evidenceDerivedStrategy = [
    'reflective-pareto', 'bounded-skill', 'bank-recombination'
  ].includes(strategy);
  if (evidenceDerivedStrategy
      && !SHA256.test(String(input.strategyStateBundleSha256 || ''))) {
    return refused(
      'VNEXT_STUDY_STRATEGY_PROVENANCE_REQUIRED',
      'Evidence-derived candidate strategies require the exact strategy-state bundle hash.'
    );
  }
  const requiredEvidenceIds = candidateStrategyRequiredEvidenceIds(
    strategy,
    strategyState
  );
  const evidenceRecords = normalizedEvidenceRecords(
    taskPack,
    runtimeAuthority.requestedModel,
    createdAt,
    input.evidenceRecords ?? []
  );
  if (!evidenceRecords || requiredEvidenceIds == null
      || requiredEvidenceIds.length > 16
      || requiredEvidenceIds.some((id) => !evidenceRecords.some((record) => (
        record.recordId === id && record.verifierEligible === true
      )))
      || (profile.profile.modelRerankerEnabled
        && !evidenceRecords.some((record) => record.verifierEligible === true))) {
    return refused(
      'VNEXT_STUDY_EVIDENCE_INSUFFICIENT',
      'This arm requires its exact strategy evidence and any model-reranked memory to be verifier-eligible before planning.'
    );
  }
  const behaviorMap = buildBehaviorMap(parentFamily);
  const strategyPreflight = createCandidateStrategyPlan(
    strategy,
    strategyState,
    {
      decisionTime: createdAt,
      selectedEvidence: evidenceRecords.map((record) => ({
        id: record.recordId,
        sha256: record.recordSha256
      })),
      allowedTargets: behaviorMap.behaviors[0].locators.map((locator) => ({
        target: locator.path,
        locatorSha256: locator.locatorSha256,
        sourceSha256: locator.sourceSha256
      })),
      allowedComponent: 'mechanism-program',
      maximumOperations: 1
    }
  );
  if (strategyPreflight.status !== 'OK') {
    return refused(
      'VNEXT_STUDY_STRATEGY_STATE_INVALID',
      'Candidate strategy state does not replay against the current parent targets and frozen evidence.',
      { strategyCode: strategyPreflight.code }
    );
  }
  const identity = createVNextModelIdentityPolicy({
    policyId: `${input.waveId}-model-identity`,
    oauthAuthority: runtimeAuthority,
    requireBackendReportedModel: true
  });
  const roleCalls = vnextAblationPreparationRoleCalls(profile.profile, {
    externalResearchEnabled
  });
  if (identity.status !== 'OK' || roleCalls == null) {
    return refused('VNEXT_STUDY_AUTHORITY_INVALID', 'Model identity or ablation call accounting failed.');
  }
  const candidateFeatureFlags = strategy === 'native'
    ? {}
    : { [VNEXT_CANDIDATE_GENERATOR_FLAGS[strategy]]: true };
  const maximumSelected = requiredEvidenceIds.length
    ? Math.min(16, Math.max(4, requiredEvidenceIds.length))
    : 4;
  const preparation = {
    failure: buildFailure(taskPack, createdAt),
    evidenceRecords,
    behaviorMap,
    targetBehaviorIds: ['mechanism-program'],
    feedbackArtifacts: [],
    architectureFacts: {
      parentFamilyId: parentFamily.familyId,
      parentFamilySha256: parentFamily.familySha256,
      taskPackId: taskPack.packId,
      taskPackSha256: taskPack.packSha256,
      taskPartition: taskPack.partition,
      taskClusterCount: taskPack.tasks.length,
      protocolSha256: input.studyBinding.protocolSha256,
      studyPhaseId: input.studyBinding.phaseId,
      memoryLedgerSha256: input.studyBinding.memoryLedgerSha256,
      strategyStateBundleSha256: input.strategyStateBundleSha256 ?? null,
      strategyStateSourceRecordSha256s: evidenceDerivedStrategy
        ? requiredEvidenceIds.map((id) => (
            evidenceRecords.find((record) => record.recordId === id).recordSha256
          )).sort()
        : []
    },
    architectureConstraints: [
      'candidate cannot edit protected authority surfaces',
      'candidate changes one bounded mechanism program',
      'no activation or promotion authority',
      'no final sealed task access'
    ].sort(),
    publicMeasurementContract: {
      inferenceUnit: 'task-cluster',
      arms: ['candidate', 'cold', 'parent', 'sham'],
      calibrationTasks: 5,
      confirmationTasks: 5,
      replicatesPerArm: 3,
      confirmationConditional: true,
      promotionEnabled: false
    },
    compatibility: {
      component: 'mechanism-program',
      domains: [...new Set(taskPack.tasks.map((task) => task.domain))].sort(),
      model: runtimeAuthority.requestedModel
    },
    embeddings: {},
    queryEmbedding: null,
    maximumCandidates: Math.max(64, evidenceRecords.length),
    maximumSelected,
    exploreUncertainty: false,
    enableModelReranker: profile.profile.modelRerankerEnabled,
    internalResearchEnabled: profile.profile.internalResearchEnabled,
    hypothesisFalsificationEnabled: profile.profile.hypothesisFalsificationEnabled,
    externalResearchEnabled,
    sealedMode: false,
    externalSources: [],
    externalSourceAllowlist: externalResearchEnabled
      ? [...(input.externalResearchPolicy?.allowlist ?? [])]
      : [],
    ...(externalResearchEnabled
      ? { externalResearchPolicy: structuredClone(input.externalResearchPolicy) }
      : {}),
    dossierMaximumItems: 64,
    dossierMaximumBytes: 128 * 1024,
    candidateStrategy: strategy,
    candidateFeatureFlags,
    candidateStrategyState: strategyState,
    protectedSurfaces: [...MANDATORY_PROTECTED_SURFACES].sort(),
    maxOperations: 1,
    modelPolicy: roleRoutes(runtimeAuthority, identity.policy, externalResearchEnabled),
    callBudgets
  };
  const configResult = createVNextWaveConfig({
    waveId: input.waveId,
    preparationRunId: `${input.waveId}-preparation`,
    experimentRunId: `${input.waveId}-experiment`,
    createdAt,
    proposalRecordedAt: isoOffset(createdAt, 1),
    shadowRecordedAt: isoOffset(createdAt, 2),
    preparationBudgetPolicyId: `${input.waveId}-preparation-budget`,
    experimentBudgetPolicyId: `${input.waveId}-experiment-budget`,
    runtimeAuthority,
    evaluatorAuthority,
    ablationProfile: profile.profile,
    preparation,
    mechanism: {
      parentFamily,
      mutationObjective: structuredClone(input.mutationObjective),
      reasonCodes: safeStrings(input.reasonCodes ?? ['VERIFIED_BASELINE_TARGET_FAILURES']),
      expectedEffectCode: input.expectedEffectCode ?? 'MORE_EXACT_DISJOINT_REPAIRS'
    },
    taskSplit: split,
    recursiveCanary: {
      model: runtimeAuthority.requestedModel,
      reasoningEffort: runtimeAuthority.reasoningEffort,
      authMode: 'chatgpt-oauth',
      retries: 0,
      promotionEnabled: false,
      historicalTokenEstimate: input.historicalTokenEstimate ?? 4_000_000,
      replicatesPerArm: 3,
      calibrationRule: 'paired-placebo-upper-bound-v1',
      confirmationRule: 'five-task-adjusted-sign-test-v1',
      perCallBudget: { ...experimentCallBudget }
    },
    pace: {
      lambdaPolicy: { kind: 'fixed', value: 1 },
      maximumShamMovement: 0.05,
      maximumRelativeTokenIncrease: 0.25
    }
  });
  if (configResult.status !== 'OK') {
    return refused('VNEXT_STUDY_CONFIG_INVALID', 'The frozen study config failed its closed wave contract.');
  }
  const preparationBudget = preparationPolicy(configResult.config, roleCalls);
  const experimentBudget = experimentPolicy(configResult.config);
  const rootBudget = preparationBudget && experimentBudget
    ? rootPolicy(input.seriesRunId, preparationBudget, experimentBudget)
    : null;
  const implementation = resolveVNextWaveImplementation({
    packageRoot: input.packageRoot
  });
  if (!preparationBudget || !experimentBudget || !rootBudget
      || implementation.status !== 'OK') {
    return refused('VNEXT_STUDY_BUDGET_OR_IMPLEMENTATION_INVALID', 'Exact budgets or the implementation capsule could not be frozen.');
  }
  const seriesPlan = createCampaignSeriesPlan({
    seriesId: `${input.seriesRunId}-series`,
    createdAt,
    maximumWaves: 1,
    familywiseAlpha: 0.05,
    maximumCalls: rootBudget.maxCalls,
    modelPolicySha256: deriveVNextWaveModelPolicySha256(configResult.config),
    evaluatorPolicySha256: deriveVNextWaveEvaluatorPolicySha256(configResult.config),
    implementationSha256: implementation.implementationSha256,
    budgetPolicy: rootBudget
  });
  if (seriesPlan.status !== 'OK') {
    return refused('VNEXT_STUDY_SERIES_INVALID', 'The one-wave campaign series could not be frozen.');
  }
  const seriesState = createCampaignSeriesState({
    plan: seriesPlan.plan,
    runId: input.seriesRunId,
    createdAt
  });
  const rootBudgetLedger = createResourceBudgetLedger({
    policy: rootBudget,
    runId: input.seriesRunId,
    createdAt
  });
  if (seriesState.status !== 'OK' || rootBudgetLedger.status !== 'OK') {
    return refused('VNEXT_STUDY_STATE_INVALID', 'The initial series state or root budget ledger could not be sealed.');
  }
  return {
    status: 'OK',
    build: {
      seriesRunId: input.seriesRunId,
      waveId: input.waveId,
      createdAt,
      studyBinding: structuredClone(input.studyBinding),
      taskPack,
      taskMaterialBundle,
      parentFamily,
      mutationObjective: structuredClone(input.mutationObjective),
      runtimeAuthority,
      evaluatorAuthority,
      ablationProfile: profile.profile,
      roleCalls,
      historicalTokenEstimate: input.historicalTokenEstimate ?? 4_000_000,
      config: configResult.config,
      preparationBudget,
      experimentBudget,
      rootBudget,
      rootBudgetLedger: rootBudgetLedger.ledger,
      seriesPlan: seriesPlan.plan,
      seriesState: seriesState.state,
      implementation
    }
  };
}

export function persistVNextStudyWave({ store, build } = {}) {
  if (!store || !plainObject(build)) {
    return refused('VNEXT_STUDY_PERSIST_INPUT_INVALID', 'A store and completed study build are required.');
  }
  const initialized = initializeCampaignSeriesStore({
    store,
    runId: build.seriesRunId,
    plan: build.seriesPlan,
    state: build.seriesState,
    rootBudgetLedger: build.rootBudgetLedger
  });
  if (initialized.status !== 'OK') return initialized;
  const inputs = persistCampaignSeriesWaveInputs({
    store,
    runId: build.seriesRunId,
    waveId: build.waveId,
    taskPack: build.taskPack,
    taskMaterialBundle: build.taskMaterialBundle,
    config: build.config,
    budgetPolicies: [build.preparationBudget, build.experimentBudget]
  });
  if (inputs.status !== 'OK') return inputs;
  const queued = enqueueCampaignSeriesWave({
    state: build.seriesState,
    plan: build.seriesPlan,
    expectedStateSha256: build.seriesState.stateSha256,
    waveId: build.waveId,
    taskPack: build.taskPack,
    configId: inputs.manifest.configId,
    configSha256: inputs.manifest.configSha256,
    budgetPolicies: inputs.budgetPolicies,
    sealedAt: isoOffset(build.createdAt, 3),
    sealAuthority: 'vnext-study-plan-builder'
  });
  if (queued.status !== 'OK') return queued;
  const checkpoint = appendCampaignSeriesCheckpoint({
    store,
    runId: build.seriesRunId,
    plan: build.seriesPlan,
    state: queued.state
  });
  if (checkpoint.status !== 'OK') return checkpoint;
  const planned = planVNextCampaignWave({
    store,
    seriesRunId: build.seriesRunId,
    waveId: build.waveId
  });
  if (planned.status !== 'OK') return planned;
  const core = disclosureCore({ store, build, planned });
  if (!core) return refused('VNEXT_STUDY_DISCLOSURE_INVALID', 'Execution disclosure could not be derived.');
  const disclosure = {
    ...core,
    disclosureSha256: sha256(canonicalVNextJson(core))
  };
  const current = store.readRunFile(build.seriesRunId, DISCLOSURE_FILE);
  const bytes = `${canonicalVNextJson(disclosure)}\n`;
  if (current != null && current !== bytes) {
    return refused('VNEXT_STUDY_DISCLOSURE_CONFLICT', 'The immutable study disclosure already differs on disk.');
  }
  if (current == null) store.writeRunFile(build.seriesRunId, DISCLOSURE_FILE, bytes);
  const verified = verifyVNextStudyPlanFromDisk({
    store,
    seriesRunId: build.seriesRunId,
    waveId: build.waveId
  });
  return verified.status === 'OK'
    ? { ...verified, build, state: queued.state }
    : verified;
}

export function validateVNextStudyDisclosure(disclosure) {
  const keys = [
    'schemaVersion', 'seriesRunId', 'waveId', 'armId', 'createdAt',
    'studyBinding', 'proofHome', 'taskPack', 'parentMechanism', 'model',
    'evaluatorAuthoritySha256', 'ablationProfileSha256',
    'implementationSha256', 'configSha256', 'campaignPlanSha256',
    'wavePlanSha256', 'budgetPolicySha256s', 'exposure', 'execution',
    'controls', 'approval', 'disclosureSha256'
  ];
  if (!exactKeys(disclosure, keys)
      || disclosure.schemaVersion !== VNEXT_STUDY_DISCLOSURE_SCHEMA
      || !isSafeId(disclosure.seriesRunId) || !isSafeId(disclosure.waveId)
      || !exactKeys(disclosure.studyBinding, [
        'protocolSha256', 'phaseId', 'memoryLedgerSha256'
      ])
      || !SHA256.test(String(disclosure.studyBinding.protocolSha256 || ''))
      || !isSafeId(disclosure.studyBinding.phaseId)
      || !(disclosure.studyBinding.memoryLedgerSha256 == null
        || SHA256.test(String(disclosure.studyBinding.memoryLedgerSha256)))
      || !isAbsolute(String(disclosure.proofHome || ''))
      || !Number.isFinite(Date.parse(disclosure.createdAt))
      || ![disclosure.evaluatorAuthoritySha256,
        disclosure.ablationProfileSha256, disclosure.implementationSha256,
        disclosure.configSha256, disclosure.campaignPlanSha256,
        disclosure.wavePlanSha256, disclosure.disclosureSha256]
        .every((value) => SHA256.test(String(value || '')))
      || !Array.isArray(disclosure.budgetPolicySha256s)
      || disclosure.budgetPolicySha256s.length !== 3
      || disclosure.budgetPolicySha256s.some((value) => !SHA256.test(value))
      || disclosure.controls?.retries !== 0
      || disclosure.controls?.promotionEnabled !== false
      || disclosure.approval?.requiredBeforeLaunch !== true
      || disclosure.approval?.workerLaunchedAtPlanning !== false
      || disclosure.approval?.paidModelCallsAtPlanning !== 0) {
    return refused('VNEXT_STUDY_DISCLOSURE_INVALID', 'Study disclosure shape or closed safety fields are invalid.');
  }
  const core = structuredClone(disclosure);
  delete core.disclosureSha256;
  return disclosure.disclosureSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', disclosure }
    : refused('VNEXT_STUDY_DISCLOSURE_TAMPERED', 'Study disclosure hash failed replay.');
}

export function verifyVNextStudyPlanFromDisk({
  store,
  seriesRunId,
  waveId,
  approvedPlanSha256 = null,
  requireApproval = false
} = {}) {
  if (!store || !isSafeId(seriesRunId) || !isSafeId(waveId)) {
    return refused('VNEXT_STUDY_VERIFY_INPUT_INVALID', 'A store and safe study identifiers are required.');
  }
  let disclosure;
  try {
    disclosure = JSON.parse(store.readRunFile(seriesRunId, DISCLOSURE_FILE) || '');
  } catch {
    return refused('VNEXT_STUDY_DISCLOSURE_MISSING', 'The persisted study disclosure is missing or malformed.');
  }
  const valid = validateVNextStudyDisclosure(disclosure);
  const planned = planVNextCampaignWave({ store, seriesRunId, waveId });
  if (valid.status !== 'OK' || planned.status !== 'OK'
      || disclosure.seriesRunId !== seriesRunId
      || disclosure.waveId !== waveId
      || realpathSync(store.homeDir) !== disclosure.proofHome
      || planned.planSha256 !== disclosure.wavePlanSha256
      || planned.implementation.implementationSha256 !== disclosure.implementationSha256
      || planned.inputs.config.configSha256 !== disclosure.configSha256
      || planned.series.plan.planSha256 !== disclosure.campaignPlanSha256
      || (requireApproval && approvedPlanSha256 !== disclosure.disclosureSha256)) {
    return refused(
      requireApproval && approvedPlanSha256 !== disclosure?.disclosureSha256
        ? 'VNEXT_STUDY_APPROVAL_MISMATCH'
        : 'VNEXT_STUDY_REPLAY_FAILED',
      'The study disclosure, exact approval hash, or replayed wave plan does not match.'
    );
  }
  return {
    status: 'OK',
    disclosure,
    planned,
    approvalRequired: true,
    approved: requireApproval,
    evidenceSha256: sha256(canonicalVNextJson({
      disclosureSha256: disclosure.disclosureSha256,
      wavePlanSha256: planned.planSha256,
      implementationSha256: planned.implementation.implementationSha256,
      waveInputEvidenceSha256: planned.inputs.evidenceSha256
    }))
  };
}

export function vnextStudyDisclosurePath() {
  return DISCLOSURE_FILE;
}
