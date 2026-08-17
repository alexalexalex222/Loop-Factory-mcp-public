import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import {
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_SCHEMA,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import {
  ADAPTIVE_RECURSIVE_REASONING_EFFORTS,
  ADAPTIVE_RECURSIVE_SUPPORTED_MODELS
} from './adaptive-recursive-canary.mjs';
import {
  prepareAdaptiveRecursiveCanaryV2Config
} from './adaptive-recursive-canary-v2.mjs';
import {
  adaptiveRecursiveCanaryWorker,
  evidenceArtifact,
  parseArtifactJson,
  readArtifact
} from './adaptive-recursive-runner.mjs';
import {
  runAdaptiveRecursiveCanaryV2,
  verifyAdaptiveRecursiveCanaryV2Run
} from './adaptive-recursive-runner-v2.mjs';
import {
  createContextSaturationObservation,
  createInitialAdaptiveContextPolicy,
  deriveAdaptiveContextPolicy,
  validateAdaptiveContextPolicy,
  validateContextSaturationObservation
} from './adaptive-context-policy.mjs';
import {
  buildLosslessContextProjection,
  validateLosslessContextProjection
} from './adaptive-context-compaction.mjs';
import {
  buildMechanismMutationPrompt,
  buildMechanismMutationContract,
  executeMechanismMutationHypothesis,
  mutationInvocationMatches,
  parseMechanismMutationOutput
} from './mechanism-hypothesizer.mjs';
import {
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution
} from './mechanism-evolution.mjs';
import {
  validateMechanismEvolutionRecord
} from './mechanism-evolution-records.mjs';
import {
  createMechanismMutationPlan,
  mechanismProgramSemanticSha256,
  validateMechanismMutationPlan
} from './mechanism-mutation.mjs';
import {
  captureCodexOAuthAuthority,
  validateCodexOAuthAuthorityRecord
} from './codex-oauth-authority.mjs';
import {
  captureExecutableEvaluatorAuthority,
  validateExecutableEvaluatorAuthority
} from './adaptive-executable-canary.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from './executor.mjs';
import {
  listAdaptiveRecords,
  persistAdaptiveRecord,
  persistAdaptiveRecursiveCanaryV2DevelopmentResult,
  persistAdaptiveRecursiveCanaryV2Result
} from './mechanism-catalog.mjs';
import { createBaselinePolicyEpoch } from './adaptive-policy.mjs';
import { buildMechanismRoutingDecision } from './mechanism-router.mjs';
import {
  MECHANISM_EVOLUTION_ADMISSION_V2
} from './mechanism-evolution-admission-v2.mjs';
import {
  RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
} from './adaptive-recursive-statistics.mjs';
import { canonicalJson } from './real-test.mjs';
import { isSafeId, nowIso, sha256 } from './util.mjs';

export const ADAPTIVE_RECURSIVE_CAMPAIGN_SCHEMA =
  'adaptive-recursive-campaign-v1';
export const ADAPTIVE_RECURSIVE_CAMPAIGN_RUN_KIND =
  'adaptive-recursive-campaign';
export const ADAPTIVE_RECURSIVE_CAMPAIGN_IMPLEMENTATION_PATHS = Object.freeze([
  'package.json',
  'scripts/plan-adaptive-recursive-campaign.mjs',
  'scripts/run-adaptive-recursive-campaign.mjs',
  'scripts/verify-adaptive-recursive-campaign.mjs',
  'src/adaptive-context-compaction.mjs',
  'src/adaptive-context-policy.mjs',
  'src/adaptive-executable-canary.mjs',
  'src/adaptive-measurement-v2.mjs',
  'src/adaptive-recursive-campaign.mjs',
  'src/adaptive-recursive-canary-v2.mjs',
  'src/adaptive-recursive-runner-v2.mjs',
  'src/adaptive-recursive-statistics.mjs',
  'src/canary-runner.mjs',
  'src/codex-oauth-authority.mjs',
  'src/executor.mjs',
  'src/mechanism-catalog.mjs',
  'src/mechanism-compiler.mjs',
  'src/mechanism-evolution-admission-v2.mjs',
  'src/mechanism-evolution-records.mjs',
  'src/mechanism-evolution.mjs',
  'src/mechanism-hypothesizer.mjs',
  'src/mechanism-mutation.mjs',
  'src/mechanism-router.mjs',
  'src/schemas/adaptive-context-policy-v1.schema.json',
  'src/schemas/adaptive-recursive-campaign-v1.schema.json',
  'src/schemas/adaptive-recursive-canary-v2.schema.json',
  'src/schemas/lossless-context-index-v1.schema.json',
  'src/schemas/mechanism-mutation-output.schema.json'
].sort());

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 512 * 1024;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function within(base, target) {
  const rel = relative(base, target);
  return rel === '' || (
    rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

function validArtifactBinding(value) {
  return plainObject(value)
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= 500
    && !isAbsolute(value.path)
    && !value.path.split('/').includes('..')
    && SHA256_RE.test(String(value.sha256 || ''));
}

function validTask(task) {
  return plainObject(task)
    && isSafeId(task.id)
    && validArtifactBinding(task.source)
    && validArtifactBinding(task.incident)
    && validArtifactBinding(task.interface)
    && validArtifactBinding(task.oracle)
    && plainObject(task.interfaceContract);
}

function validObjective(objective) {
  return plainObject(objective)
    && /^measurement-[a-f0-9]{24}$/.test(String(objective.measurementId || ''))
    && ['measurementSha256', 'failureCaseSetSha256', 'successCaseSetSha256']
      .every((field) => SHA256_RE.test(String(objective[field] || '')))
    && objective.failureCaseSetSha256 !== objective.successCaseSetSha256
    && ['exact-case-rate', 'target-exact-rate', 'control-exact-rate',
      'decision-rate', 'code-rate', 'full-repair-rate', 'token-cost']
      .includes(objective.targetMetric)
    && objective.direction === (objective.targetMetric === 'token-cost'
      ? 'decrease'
      : 'increase');
}

function taskGenerations(config) {
  return [...(config.taskGenerations || [])].sort((left, right) => (
    left.generation - right.generation
  ));
}

function rawConfigCore(config) {
  return {
    schemaVersion: config.schemaVersion,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    authMode: config.authMode,
    retries: config.retries,
    promotionEnabled: config.promotionEnabled,
    maximumGenerations: config.maximumGenerations,
    maximumMutationOperations: config.maximumMutationOperations,
    historicalTokenEstimatePerGeneration:
      config.historicalTokenEstimatePerGeneration,
    seedParentFamily: config.seedParentFamily,
    seedObjective: config.seedObjective,
    context: config.context,
    taskGenerations: taskGenerations(config)
  };
}

function allTaskBindings(generations) {
  return generations.flatMap((generation) => [
    ...generation.calibrationTasks,
    ...generation.confirmationTasks
  ]);
}

function preparedBindings(config) {
  const present = [
    config.runtimeAuthority,
    config.evaluatorAuthority,
    config.implementationManifest,
    config.implementationCapsule,
    config.artifactRoot
  ].filter((value) => value != null).length;
  if (present === 0) return null;
  if (present !== 5
      || validateCodexOAuthAuthorityRecord(config.runtimeAuthority).status !== 'OK'
      || validateExecutableEvaluatorAuthority(config.evaluatorAuthority).status !== 'OK'
      || !Array.isArray(config.implementationManifest)
      || !Array.isArray(config.implementationCapsule)
      || typeof config.artifactRoot !== 'string'
      || !isAbsolute(config.artifactRoot)) return false;
  return {
    runtimeAuthoritySha256: config.runtimeAuthority.authoritySha256,
    runtimeExecutableSha256: config.runtimeAuthority.binary.sha256,
    evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
    implementationManifestSha256:
      sha256(canonicalJson(config.implementationManifest)),
    artifactRootSha256: sha256(config.artifactRoot)
  };
}

function portableExecution(model, reasoningEffort, kind) {
  const schemaPath = schemaPathForContract({ kind });
  return {
    argv: buildArgs('codex', null, model, {
      strictIsolation: true,
      schemaPath,
      workspaceRoot: '<fresh-model-capsule>',
      reasoningEffort
    }).map((value) => value === schemaPath ? `<${kind}-output-schema>` : value),
    outputSchemaSha256: sha256(readFileSync(schemaPath)),
    disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES]
  };
}

export function buildAdaptiveRecursiveCampaignPlan(config = {}) {
  try {
    const generations = taskGenerations(config);
    if (config.schemaVersion !== ADAPTIVE_RECURSIVE_CAMPAIGN_SCHEMA
        || !ADAPTIVE_RECURSIVE_SUPPORTED_MODELS.includes(config.model)
        || !ADAPTIVE_RECURSIVE_REASONING_EFFORTS.includes(config.reasoningEffort)
        || config.authMode !== 'chatgpt-oauth'
        || config.retries !== 0
        || config.promotionEnabled !== false
        || !Number.isInteger(config.maximumGenerations)
        || config.maximumGenerations < 1
        || config.maximumGenerations > 50
        || !Number.isInteger(config.maximumMutationOperations)
        || config.maximumMutationOperations < 1
        || config.maximumMutationOperations > 3
        || !Number.isInteger(config.historicalTokenEstimatePerGeneration)
        || config.historicalTokenEstimatePerGeneration < 1
        || validateAdaptiveRecord(config.seedParentFamily).status !== 'OK'
        || !config.seedParentFamily.causalFingerprint?.program
        || !validObjective(config.seedObjective)
        || !plainObject(config.context)
        || !Number.isInteger(config.context.minInputTokens)
        || !Number.isInteger(config.context.initialInputTokens)
        || !Number.isInteger(config.context.maxInputTokens)
        || config.context.minInputTokens < 1
        || config.context.minInputTokens > config.context.initialInputTokens
        || config.context.initialInputTokens > config.context.maxInputTokens
        || !Number.isFinite(config.context.permanentControlFraction)
        || config.context.permanentControlFraction <= 0
        || config.context.permanentControlFraction >= 1
        || generations.length !== config.maximumGenerations
        || generations.some((generation, index) => (
          generation.generation !== index
          || !Array.isArray(generation.calibrationTasks)
          || generation.calibrationTasks.length !== 5
          || !Array.isArray(generation.confirmationTasks)
          || generation.confirmationTasks.length !== 5
          || [...generation.calibrationTasks, ...generation.confirmationTasks]
            .some((task) => !validTask(task))
        ))) {
      return refused(
        'RECURSIVE_CAMPAIGN_CONFIG_INVALID',
        'Recursive campaigns require a bounded seed, explicit context limits, and five-plus-five sealed tasks per generation.'
      );
    }
    const tasks = allTaskBindings(generations);
    const identities = tasks.flatMap((task) => [
      `id:${task.id}`,
      `source-path:${task.source.path}`,
      `source-sha:${task.source.sha256}`,
      `oracle-path:${task.oracle.path}`,
      `oracle-sha:${task.oracle.sha256}`
    ]);
    if (new Set(identities).size !== identities.length) {
      return refused(
        'RECURSIVE_CAMPAIGN_TASKS_NOT_DISJOINT',
        'Every campaign task, source, and oracle identity must be globally disjoint.'
      );
    }
    const bindings = preparedBindings(config);
    if (bindings === false) {
      return refused(
        'RECURSIVE_CAMPAIGN_PREPARED_BINDINGS_INVALID',
        'Prepared campaign authority and implementation bindings are incomplete.'
      );
    }
    const configSha256 = sha256(canonicalJson(rawConfigCore(config)));
    const payload = {
      schemaVersion: ADAPTIVE_RECURSIVE_CAMPAIGN_SCHEMA,
      configSha256,
      modelPolicy: {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        authMode: 'chatgpt-oauth',
        retries: 0,
        fallbackModels: [],
        strictIsolation: true,
        promotionEnabled: false
      },
      bounds: {
        maximumGenerations: config.maximumGenerations,
        mutationCallsPerGeneration: 1,
        childCallsPerGeneration: 120,
        maximumCallsPerGeneration: 121,
        maximumCalls: config.maximumGenerations * 121,
        maximumMutationOperations: config.maximumMutationOperations,
        historicalTokenEstimatePerGeneration:
          config.historicalTokenEstimatePerGeneration,
        historicalMaximumTokenEstimate:
          config.maximumGenerations * config.historicalTokenEstimatePerGeneration,
        hardTokenCeiling: null,
        hardUsdCeiling: null
      },
      autonomy: {
        childPlanApproval: 'deterministic-under-approved-parent-plan',
        invalidMutationRetries: 0,
        childRetries: 0,
        zeroInferenceIdle: true,
        operatorStopRequiredForExternalTermination: true,
        promotionEnabled: false
      },
      statisticalAuthority: {
        familywiseAlpha: 0.05,
        method: 'bonferroni-over-maximum-generations',
        maximumHypotheses: config.maximumGenerations,
        perGenerationAlpha: 0.05 / config.maximumGenerations,
        minimumAttainableTaskSignP: 0.03125,
        familywiseAdmissionReachable:
          (0.05 / config.maximumGenerations) >= 0.03125,
        routingAdmissionEnabled:
          (0.05 / config.maximumGenerations) >= 0.03125,
        admissionMetric: 'adjusted-block-sign-test-p-one-sided',
        childTaskGateRetained: true
      },
      execution: {
        mutation: portableExecution(
          config.model,
          config.reasoningEffort,
          'mechanism-mutation'
        ),
        childProposal: portableExecution(
          config.model,
          config.reasoningEffort,
          'proposal'
        )
      },
      context: structuredClone(config.context),
      seed: {
        familyId: config.seedParentFamily.familyId,
        familySha256: config.seedParentFamily.familySha256,
        measurementId: config.seedObjective.measurementId,
        measurementSha256: config.seedObjective.measurementSha256
      },
      generations: generations.map((generation) => ({
        generation: generation.generation,
        calibrationTaskIds: generation.calibrationTasks.map((task) => task.id).sort(),
        confirmationTaskIds: generation.confirmationTasks.map((task) => task.id).sort(),
        taskSetSha256: sha256(canonicalJson([
          ...generation.calibrationTasks,
          ...generation.confirmationTasks
        ].map((task) => ({
          id: task.id,
          source: task.source,
          incident: task.incident,
          interface: task.interface,
          oracle: task.oracle
        })).sort((left, right) => left.id.localeCompare(right.id))))
      })),
      preparedBindings: bindings
    };
    return ok({
      plan: {
        ...payload,
        sha256: sha256(canonicalJson(payload))
      }
    });
  } catch (error) {
    return refused('RECURSIVE_CAMPAIGN_PLAN_FAILED', error.message);
  }
}

export function adaptiveRecursiveCampaignLaunchDisclosure(config = {}, {
  configPath = '',
  home = '',
  runId = ''
} = {}) {
  const built = buildAdaptiveRecursiveCampaignPlan(config);
  if (built.status !== 'OK') return built;
  return ok({
    planSha256: built.plan.sha256,
    configSha256: built.plan.configSha256,
    maximumGenerations: built.plan.bounds.maximumGenerations,
    maximumCalls: built.plan.bounds.maximumCalls,
    maximumMutationCalls: built.plan.bounds.maximumGenerations,
    maximumChildCalls:
      built.plan.bounds.maximumGenerations
        * built.plan.bounds.childCallsPerGeneration,
    historicalMaximumTokenEstimate:
      built.plan.bounds.historicalMaximumTokenEstimate,
    hardTokenCeiling: null,
    hardUsdCeiling: null,
    familywiseAdmissionReachable:
      built.plan.statisticalAuthority.familywiseAdmissionReachable,
    routingAdmissionEnabled:
      built.plan.statisticalAuthority.routingAdmissionEnabled,
    minimumAttainableTaskSignP:
      built.plan.statisticalAuthority.minimumAttainableTaskSignP,
    mutationArgv: built.plan.execution.mutation.argv,
    childProposalArgv: built.plan.execution.childProposal.argv,
    launchCommand: [
      'SUPER_LOOP_ALLOW_EXEC=1 npm run recursive-campaign --',
      `--config ${configPath}`,
      `--approved-plan ${built.plan.sha256}`,
      `--run-id ${runId}`,
      `--home ${home}`
    ].join(' '),
    stopFile: `${home}/runs/${runId}/OPERATOR_STOP`
  });
}

export function resolveAdaptiveRecursiveCampaignImplementation({
  packageRoot = PACKAGE_ROOT
} = {}) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const capsule = ADAPTIVE_RECURSIVE_CAMPAIGN_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full)
          || !existsSync(full)
          || lstatSync(full).isSymbolicLink()) {
        throw new Error(`recursive campaign dependency is missing or unsafe: ${path}`);
      }
      const content = readFileSync(full, 'utf8');
      if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
        throw new Error(`recursive campaign dependency is too large: ${path}`);
      }
      return {
        path,
        bytes: Buffer.byteLength(content),
        sha256: sha256(content),
        content
      };
    });
    return ok({
      manifest: capsule.map(({ path, bytes, sha256: digest }) => ({
        path,
        bytes,
        sha256: digest
      })),
      capsule
    });
  } catch (error) {
    return refused('RECURSIVE_CAMPAIGN_IMPLEMENTATION_UNRESOLVED', error.message);
  }
}

function implementationMatches(config) {
  const current = resolveAdaptiveRecursiveCampaignImplementation();
  return current.status === 'OK'
    && canonicalJson(current.manifest) === canonicalJson(config.implementationManifest)
    && canonicalJson(current.capsule) === canonicalJson(config.implementationCapsule);
}

export function prepareAdaptiveRecursiveCampaignConfig(raw = {}, {
  packageRoot = PACKAGE_ROOT,
  artifactRoot = packageRoot,
  codexBinaryPath,
  runtimeAuthorityRecord = null,
  evaluatorAuthorityRecord = null,
  approvedPlanSha256 = null
} = {}) {
  const built = buildAdaptiveRecursiveCampaignPlan(raw);
  if (built.status !== 'OK') return built;
  const runtime = runtimeAuthorityRecord
    ? validateCodexOAuthAuthorityRecord(runtimeAuthorityRecord)
    : captureCodexOAuthAuthority({
        binaryPath: codexBinaryPath,
        requestedModel: raw.model,
        reasoningEffort: raw.reasoningEffort
      });
  if (runtime.status !== 'OK') return runtime;
  const evaluator = evaluatorAuthorityRecord
    ? validateExecutableEvaluatorAuthority(evaluatorAuthorityRecord)
    : captureExecutableEvaluatorAuthority();
  if (evaluator.status !== 'OK') return evaluator;
  const implementation = resolveAdaptiveRecursiveCampaignImplementation({ packageRoot });
  if (implementation.status !== 'OK') return implementation;
  const config = {
    ...raw,
    approvedPlanSha256,
    runtimeAuthority: runtime.record,
    evaluatorAuthority: evaluator.record,
    implementationManifest: implementation.manifest,
    implementationCapsule: implementation.capsule,
    artifactRoot: realpathSync(resolve(artifactRoot))
  };
  const validation = validateAdaptiveRecursiveCampaignConfig(config, {
    requireApproval: approvedPlanSha256 != null
  });
  return validation.ok
    ? ok({ config, plan: validation.plan })
    : refused('RECURSIVE_CAMPAIGN_PREPARED_CONFIG_INVALID', validation.errors.join('; '), {
        errors: validation.errors,
        plan: validation.plan
      });
}

export function validateAdaptiveRecursiveCampaignConfig(config = {}, {
  requireApproval = true
} = {}) {
  const errors = [];
  const built = buildAdaptiveRecursiveCampaignPlan(config);
  if (built.status !== 'OK') errors.push(`${built.code}: ${built.message}`);
  const runtime = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtime.status !== 'OK'
      || runtime.record?.requestedModel !== config.model
      || runtime.record?.reasoningEffort !== config.reasoningEffort) {
    errors.push('Codex OAuth authority does not bind the campaign model and reasoning effort');
  }
  if (validateExecutableEvaluatorAuthority(config.evaluatorAuthority).status !== 'OK') {
    errors.push('executable evaluator authority is invalid');
  }
  if (!implementationMatches(config)) {
    errors.push('recursive campaign implementation capsule does not match current bytes');
  }
  if (typeof config.artifactRoot !== 'string'
      || !isAbsolute(config.artifactRoot)
      || !existsSync(config.artifactRoot)
      || realpathSync(config.artifactRoot) !== config.artifactRoot) {
    errors.push('campaign artifact root is not a stable absolute directory');
  }
  if (requireApproval && config.approvedPlanSha256 !== built.plan?.sha256) {
    errors.push('approved plan SHA-256 does not match the prepared recursive campaign plan');
  }
  return { ok: errors.length === 0, errors, plan: built.plan || null };
}

function eventPayload(state, type, detail, createdAt) {
  return {
    schemaVersion: 'adaptive-recursive-campaign-event-v1',
    runId: state.runId,
    sequence: state.events.length,
    previousEventSha256: state.events.at(-1)?.eventSha256 || null,
    type,
    createdAt,
    detail
  };
}

function appendEvent(state, type, detail, createdAt) {
  const payload = eventPayload(state, type, detail, createdAt);
  state.events.push({
    ...payload,
    eventSha256: sha256(canonicalJson(payload))
  });
}

function eventsValid(state) {
  let previous = null;
  return (state.events || []).every((event, sequence) => {
    const payload = {
      schemaVersion: event.schemaVersion,
      runId: event.runId,
      sequence: event.sequence,
      previousEventSha256: event.previousEventSha256,
      type: event.type,
      createdAt: event.createdAt,
      detail: event.detail
    };
    const valid = event.schemaVersion === 'adaptive-recursive-campaign-event-v1'
      && event.runId === state.runId
      && event.sequence === sequence
      && event.previousEventSha256 === previous
      && event.eventSha256 === sha256(canonicalJson(payload));
    previous = event.eventSha256;
    return valid;
  });
}

function initialMemoryRecord(store, runId, family) {
  const content = canonicalJson({
    schemaVersion: 'mechanism-learning-receipt-v1',
    kind: 'seed-parent',
    familyId: family.familyId,
    familySha256: family.familySha256,
    causalFingerprint: family.causalFingerprint,
    authority: 'operator-sealed-seed'
  });
  const artifact = evidenceArtifact(
    store,
    runId,
    'memory-seed-parent',
    'mechanism-learning-receipt',
    content
  );
  return {
    recordId: 'memory-seed-parent',
    artifactRef: artifact.id,
    artifactSha256: artifact.sha256,
    content,
    priority: 1,
    lifecycle: 'verified',
    semanticSha256:
      mechanismProgramSemanticSha256(family.causalFingerprint.program).semanticSha256
  };
}

function routedContextRecords(store, state, generation) {
  const catalog = listAdaptiveRecords({ homeDir: store.homeDir });
  if (catalog.status !== 'OK') return catalog;
  const records = catalog.records;
  const family = state.currentParentFamily;
  const applicability = family.causalFingerprint.applicability;
  const routed = buildMechanismRoutingDecision({
    families: records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
    )),
    applications: records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
      || record.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
    )),
    evolutions: records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION
    )),
    measurements: records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT
    )),
    admissions: records.filter((record) => (
      record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2
    )),
    analyses: records.filter((record) => (
      record.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
    )),
    target: {
      taskMode: applicability.taskModes[0] || 'improve',
      loopRole: applicability.loopRoles[0] || 'supervisor',
      taskValueDimensions: applicability.taskValueDimensions,
      resourceDimensions: applicability.resourceDimensions
    },
    policyEpoch: state.routingPolicyEpoch,
    seed: `${state.runId}:${generation}:mechanism-routing`,
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  if (routed.status !== 'OK') return routed;
  const persisted = persistAdaptiveRecord({
    homeDir: store.homeDir,
    record: routed.decision
  });
  if (persisted.status !== 'OK') return persisted;
  const routingArtifact = evidenceArtifact(
    store,
    state.runId,
    `routing-packet-g${generation}`,
    'mechanism-routing-packet',
    {
      decision: routed.decision,
      capsule: routed.capsule,
      candidatePool: routed.candidatePool,
      filtered: routed.filtered
    }
  );
  const contextRecords = routed.capsule.items.map((item, index) => {
    const content = canonicalJson({
      schemaVersion: 'routed-mechanism-memory-v1',
      generation,
      position: item.position,
      allocation: item.allocation,
      familyId: item.familyId,
      familySha256: item.familySha256,
      causalFingerprint: item.causalFingerprint,
      evidence: item.evidence,
      semantics: item.semantics,
      instruction: item.instruction,
      routingDecisionSha256: routed.decision.routingDecisionSha256
    });
    const artifact = evidenceArtifact(
      store,
      state.runId,
      `routed-memory-g${generation}-p${index}`,
      'routed-mechanism-memory',
      content
    );
    const semantic = mechanismProgramSemanticSha256(
      item.causalFingerprint.program
    );
    return {
      recordId: `routed-memory-g${generation}-p${index}`,
      artifactRef: artifact.id,
      artifactSha256: artifact.sha256,
      content,
      priority: item.allocation === 'related'
        ? 1.5
        : item.allocation === 'failure-derived'
          ? 1.25
          : 1,
      lifecycle: item.evidence?.verdict === 'improvement' ? 'verified' : 'failed',
      semanticSha256: semantic.status === 'OK'
        ? semantic.semanticSha256
        : sha256(canonicalJson(item.causalFingerprint))
    };
  });
  return ok({
    decision: routed.decision,
    capsule: routed.capsule,
    routingArtifact: {
      id: routingArtifact.id,
      sha256: routingArtifact.sha256
    },
    contextRecords
  });
}

function childRunId(runId, generation) {
  const suffix = `-g${String(generation).padStart(2, '0')}-v2`;
  return `${runId.slice(0, 120 - suffix.length)}${suffix}`;
}

function generationByIndex(config, generation) {
  return config.taskGenerations.find((item) => item.generation === generation) || null;
}

function mutationArtifacts(store, runId, generation, mutation) {
  const prefix = `mutation-g${String(generation).padStart(2, '0')}`;
  return {
    contract: evidenceArtifact(store, runId, `${prefix}-contract`, 'mutation-contract', mutation.contract),
    projection: evidenceArtifact(store, runId, `${prefix}-projection`, 'context-projection', mutation.projection),
    prompt: evidenceArtifact(store, runId, `${prefix}-prompt`, 'mutation-prompt', mutation.prompt),
    raw: evidenceArtifact(store, runId, `${prefix}-raw`, 'mutation-raw-stdout', mutation.result.stdout || ''),
    result: evidenceArtifact(store, runId, `${prefix}-result`, 'mutation-result', mutation.result.resultText),
    invocation: evidenceArtifact(store, runId, `${prefix}-invocation`, 'mutation-invocation', mutation.result.invocation),
    output: evidenceArtifact(store, runId, `${prefix}-output`, 'mutation-output', mutation.output),
    plan: evidenceArtifact(store, runId, `${prefix}-plan`, 'mutation-plan', mutation.plan)
  };
}

function rejectedMutationArtifact(store, runId, generation, {
  contract,
  projection,
  mutation
}) {
  return evidenceArtifact(
    store,
    runId,
    `mutation-g${String(generation).padStart(2, '0')}-rejection`,
    'mutation-rejection-evidence',
    {
      contract,
      projection,
      prompt: buildMechanismMutationPrompt(contract),
      code: mutation.code,
      message: mutation.message,
      result: mutation.result ? {
        ok: mutation.result.ok,
        stdout: mutation.result.stdout || '',
        stderr: mutation.result.stderr || '',
        resultText: mutation.result.resultText || '',
        invocation: mutation.result.invocation || null
      } : null
    }
  );
}

function deriveCasePartitions(store, childRun, stage) {
  const child = store.load(childRun);
  const calls = (child?.calls || []).filter((call) => (
    call.stage === stage && call.arm === 'candidate'
  ));
  const failed = [];
  const passed = [];
  for (const call of calls) {
    const evaluation = parseArtifactJson(readArtifact(
      store,
      childRun,
      call.evaluationArtifactRef
    ));
    if (!evaluation) return null;
    for (const result of evaluation.results) {
      const row = {
        taskId: call.taskId,
        replicate: call.replicate,
        caseId: result.id,
        group: result.group,
        pass: result.pass,
        decisionPass: result.decisionPass,
        codePass: result.codePass
      };
      (result.pass ? passed : failed).push(row);
    }
  }
  failed.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  passed.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return { failed, passed };
}

function nextObjective(store, childRun, verification) {
  const stage = verification.confirmationMeasurement ? 'confirmation' : 'calibration';
  const measurement = verification.confirmationMeasurement
    || verification.calibrationMeasurement;
  const partitions = deriveCasePartitions(store, childRun, stage);
  if (!measurement || !partitions?.failed.length || !partitions?.passed.length) return null;
  return {
    measurementId: measurement.measurementId,
    measurementSha256: measurement.measurementSha256,
    failureCaseSetSha256: sha256(canonicalJson(partitions.failed)),
    successCaseSetSha256: sha256(canonicalJson(partitions.passed)),
    targetMetric: 'exact-case-rate',
    direction: 'increase'
  };
}

function learningMemoryRecord(store, state, generationRecord, verification) {
  const outcome = verification.confirmationAnalysis?.summary
    || verification.calibrationAnalysis?.summary
    || null;
  const content = canonicalJson({
    schemaVersion: 'mechanism-learning-receipt-v1',
    kind: generationRecord.causalPass
      ? 'familywise-admitted-improvement'
      : generationRecord.childCausalPass
        ? 'development-signal'
        : 'measured-failure',
    generation: generationRecord.generation,
    parentFamilyId: generationRecord.parentFamily.familyId,
    candidateFamilyId: generationRecord.candidateFamily.familyId,
    mutationPlanId: generationRecord.mutationPlan.mutationPlanId,
    mutationPlanSha256: generationRecord.mutationPlan.mutationPlanSha256,
    memoryRecordIds: generationRecord.mutationOutput.memoryRecordIds,
    explanation: generationRecord.mutationOutput.explanation,
    calibrationAnalysisSha256: verification.calibrationAnalysis?.analysisSha256 || null,
    confirmationAnalysisSha256: verification.confirmationAnalysis?.analysisSha256 || null,
    childCausalPass: verification.causalPass,
    familywisePass: generationRecord.causalPass,
    perGenerationAlpha: generationRecord.perGenerationAlpha,
    adjustedTaskP: generationRecord.adjustedTaskP,
    adjustedEffect: outcome?.adjusted?.mean ?? null,
    placeboMovement: outcome?.shamVsCold?.mean ?? null,
    targetRegressions: outcome?.targetRegressions ?? null,
    controlRegressions: outcome?.controlRegressions ?? null,
    authority: 'independent-recursive-v2-verifier'
  });
  const id = `memory-generation-${generationRecord.generation}`;
  const artifact = evidenceArtifact(
    store,
    state.runId,
    id,
    'mechanism-learning-receipt',
    content
  );
  return {
    recordId: id,
    artifactRef: artifact.id,
    artifactSha256: artifact.sha256,
    content,
    priority: generationRecord.causalPass
      ? 2
      : generationRecord.childCausalPass ? 1 : 0.5,
    lifecycle: generationRecord.causalPass
      ? 'active'
      : generationRecord.childCausalPass ? 'observed' : 'failed',
    semanticSha256: generationRecord.evolutionRecord.candidate.semanticSha256
  };
}

function persistObservationAndPolicy(store, state, generationRecord, verification, clock) {
  const details = generationRecord.mutationInvocation.tokenUsageDetails;
  const inputTokens = details?.inputTokens ?? details?.input_tokens;
  const outputTokens = details?.outputTokens ?? details?.output_tokens;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) {
    return refused(
      'MUTATION_TOKEN_USAGE_UNAVAILABLE',
      'Adaptive context requires CLI-reported input and output token counts.'
    );
  }
  const lift = verification.confirmationAnalysis?.summary?.adjusted?.mean
    ?? verification.calibrationAnalysis?.summary?.adjusted?.mean
    ?? null;
  const observation = createContextSaturationObservation({
    scopeId: state.contextPolicy.scopeId,
    runId: state.runId,
    generation: generationRecord.generation,
    callId: `${state.runId.slice(0, 90)}-g${generationRecord.generation}-mutation`,
    allocatedInputTokens: state.contextPolicy.allocatedInputTokens,
    requestedContextTokens: Math.ceil(generationRecord.contextProjection.totalBytes / 4),
    inputTokens,
    outputTokens,
    promptArtifactRef: generationRecord.mutationArtifacts.prompt.id,
    promptArtifactSha256: generationRecord.mutationArtifacts.prompt.sha256,
    receiptArtifactRef: generationRecord.mutationArtifacts.invocation.id,
    receiptArtifactSha256: generationRecord.mutationArtifacts.invocation.sha256,
    valid: true,
    measuredLift: lift,
    recordedAt: clock()
  });
  if (observation.status !== 'OK') return observation;
  const artifact = evidenceArtifact(
    store,
    state.runId,
    `context-observation-g${generationRecord.generation}`,
    'context-observation',
    observation.record
  );
  state.contextObservations.push({
    ...observation.record,
    artifactRef: artifact.id,
    artifactSha256: artifact.sha256
  });
  if (state.contextObservations.length >= 5
      && state.contextObservations.length % 5 === 0) {
    const derived = deriveAdaptiveContextPolicy({
      previousPolicy: state.contextPolicy,
      observations: state.contextObservations.map(({ artifactRef, artifactSha256, ...row }) => row),
      recordedAt: clock()
    });
    if (derived.status !== 'OK') return derived;
    state.contextPolicy = derived.record;
    const policyArtifact = evidenceArtifact(
      store,
      state.runId,
      `context-policy-epoch-${derived.record.epoch}`,
      'context-policy',
      derived.record
    );
    state.contextPolicyArtifacts.push({
      id: policyArtifact.id,
      sha256: policyArtifact.sha256,
      policyId: derived.record.policyId,
      policySha256: derived.record.policySha256
    });
  }
  return ok();
}

function renderCampaignReport(state, verification) {
  const rows = state.generations.map((generation) => (
    `| ${generation.generation} | ${generation.status} | ${generation.childRunId || '-'} | ${generation.causalPass ?? '-'} | ${generation.mutationPlan?.mutationPlanId || '-'} |`
  ));
  return [
    '# Adaptive Recursive Campaign',
    '',
    `- run: \`${state.runId}\``,
    `- status: **${state.status}**`,
    `- verifier valid: **${verification.experimentValid}**`,
    `- generations attempted: ${state.generations.length}/${state.plan.bounds.maximumGenerations}`,
    `- verified improvements: ${state.generations.filter((item) => item.causalPass).length}`,
    `- model calls observed: ${verification.modelCalls}/${state.plan.bounds.maximumCalls}`,
    `- current context policy: \`${state.contextPolicy.action}\` at ${state.contextPolicy.allocatedInputTokens} input tokens`,
    '',
    '| generation | status | child run | causal pass | mutation |',
    '|---:|---|---|---|---|',
    ...rows,
    '',
    'Promotion remained disabled. WAVE_DRAINED and IDLE_NO_NEW_WORK are not global completion.',
    ''
  ].join('\n');
}

export function verifyAdaptiveRecursiveCampaignRun(store, runId) {
  const state = store.load(runId);
  if (!state || state.kind !== ADAPTIVE_RECURSIVE_CAMPAIGN_RUN_KIND) {
    return refused('RECURSIVE_CAMPAIGN_STATE_MISSING', 'Campaign state is missing.');
  }
  const config = parseArtifactJson(readArtifact(
    store,
    runId,
    state.evidenceArtifacts?.config?.id
  ));
  if (!config) return refused('RECURSIVE_CAMPAIGN_CONFIG_MISSING', 'Sealed campaign config is invalid.');
  const validation = validateAdaptiveRecursiveCampaignConfig(config, {
    requireApproval: false
  });
  const sealedExpected = {
    config,
    plan: validation.plan,
    runtimeAuthority: config.runtimeAuthority,
    evaluatorAuthority: config.evaluatorAuthority,
    implementation: config.implementationCapsule
  };
  const sealedInputs = Object.entries(sealedExpected).every(([key, expected]) => {
    const ref = state.evidenceArtifacts?.[key];
    const artifact = ref?.id ? readArtifact(store, runId, ref.id) : null;
    return artifact?.sha256 === ref?.sha256
      && artifact?.sha256 === sha256(artifact.content)
      && artifact.content === canonicalJson(expected);
  });
  const gates = {
    configIntegrity: validation.ok,
    sealedInputs,
    planBinding: state.plan?.sha256 === validation.plan?.sha256
      && state.approvedPlanSha256 === validation.plan?.sha256,
    eventChain: eventsValid(state),
    contextPolicy: validateAdaptiveContextPolicy(state.contextPolicy).status === 'OK',
    routingPolicy: validateAdaptiveRecord(state.routingPolicyEpoch).status === 'OK'
      && state.routingPolicyEpoch.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH,
    promotionDisabled: state.promotion?.enabled === false
      && state.promotion?.recorded === false,
    generationCount: state.generations.length <= config.maximumGenerations
  };
  let modelCalls = 0;
  let childCalls = 0;
  const generationResults = [];
  for (const generation of state.generations) {
    if (generation.status === 'MUTATION_REJECTED'
        || generation.status === 'AMBIGUOUS_MUTATION_DISPATCH') {
      modelCalls += 1;
      if (generation.status === 'AMBIGUOUS_MUTATION_DISPATCH') {
        generationResults.push({ generation: generation.generation, valid: true });
        continue;
      }
      let valid = false;
      if (generation.mutationArtifacts) {
        const contract = parseArtifactJson(readArtifact(
          store,
          runId,
          generation.mutationArtifacts.contract.id
        ));
        const outputArtifact = readArtifact(
          store,
          runId,
          generation.mutationArtifacts.output.id
        );
        const invocation = parseArtifactJson(readArtifact(
          store,
          runId,
          generation.mutationArtifacts.invocation.id
        ));
        const output = parseMechanismMutationOutput(outputArtifact?.content, contract);
        const replayedPlan = output.status === 'OK'
          ? createMechanismMutationPlan({
              parent: contract.parent,
              objective: contract.objective,
              operations: output.output.operations,
              reasonCodes: output.output.reasonCodes,
              expectedEffectCode: output.output.expectedEffectCode
            })
          : output;
        valid = output.status === 'OK'
          && replayedPlan.status === 'OK'
          && canonicalJson(replayedPlan.plan) === canonicalJson(generation.mutationPlan)
          && validateMechanismMutationPlan(generation.mutationPlan).status === 'OK'
          && mutationInvocationMatches({
            runtimeAuthority: config.runtimeAuthority,
            contract,
            invocation
          });
      } else if (generation.rejectionEvidence) {
        const evidence = parseArtifactJson(readArtifact(
          store,
          runId,
          generation.rejectionEvidence.id
        ));
        valid = evidence?.result?.ok === true
          && mutationInvocationMatches({
            runtimeAuthority: config.runtimeAuthority,
            contract: evidence.contract,
            invocation: evidence.result.invocation
          })
          && parseMechanismMutationOutput(
            evidence.result.resultText,
            evidence.contract
          ).status !== 'OK';
      }
      generationResults.push({ generation: generation.generation, valid });
      continue;
    }
    const contract = parseArtifactJson(readArtifact(
      store,
      runId,
      generation.mutationArtifacts?.contract?.id
    ));
    const outputArtifact = readArtifact(
      store,
      runId,
      generation.mutationArtifacts?.output?.id
    );
    const invocation = parseArtifactJson(readArtifact(
      store,
      runId,
      generation.mutationArtifacts?.invocation?.id
    ));
    const output = outputArtifact
      ? parseMechanismMutationOutput(outputArtifact.content, contract)
      : refused('OUTPUT_MISSING', 'output missing');
    const projection = parseArtifactJson(readArtifact(
      store,
      runId,
      generation.mutationArtifacts?.projection?.id
    ));
    const rebuiltContract = projection
      ? buildMechanismMutationContract({
          generation: generation.generation,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          parentFamily: generation.parentFamily,
          objective: generation.mutationPlan?.objective,
          contextProjection: projection,
          allocatedInputTokens: contract?.allocatedInputTokens,
          maximumOperations: config.maximumMutationOperations
        })
      : refused('PROJECTION_MISSING', 'projection missing');
    const replayedPlan = output.status === 'OK'
      ? createMechanismMutationPlan({
          parent: contract.parent,
          objective: contract.objective,
          operations: output.output.operations,
          reasonCodes: output.output.reasonCodes,
          expectedEffectCode: output.output.expectedEffectCode
        })
      : output;
    const mutationPlanValid = validateMechanismMutationPlan(generation.mutationPlan).status === 'OK'
      && replayedPlan.status === 'OK'
      && canonicalJson(replayedPlan.plan) === canonicalJson(generation.mutationPlan);
    const evolutionValid = validateMechanismEvolutionRecord(generation.evolutionRecord).status === 'OK';
    const mutationValid = output.status === 'OK'
      && validateLosslessContextProjection(projection).status === 'OK'
      && rebuiltContract.status === 'OK'
      && canonicalJson(rebuiltContract.contract) === canonicalJson(contract)
      && mutationPlanValid
      && evolutionValid
      && generation.evolutionRecord.parent.familyId === generation.parentFamily.familyId
      && generation.evolutionRecord.candidate.familyId === generation.candidateFamily.familyId
      && validateAdaptiveRecord(generation.routingDecision).status === 'OK'
      && generation.routingDecision.schemaVersion === ADAPTIVE_SCHEMA.ROUTING_DECISION
      && mutationInvocationMatches({
        runtimeAuthority: config.runtimeAuthority,
        contract,
        invocation
      });
    const child = verifyAdaptiveRecursiveCanaryV2Run(store, generation.childRunId);
    const childTaskP = child.confirmationAnalysis
      ?.summary?.adjustedTaskSignTest?.pOneSided;
    const familywisePass = state.plan.statisticalAuthority.routingAdmissionEnabled === true
      && child.causalPass === true
      && Number.isFinite(childTaskP)
      && childTaskP <= state.plan.statisticalAuthority.perGenerationAlpha;
    modelCalls += 1;
    childCalls += child.tokenUsage?.observedCalls || 0;
    const valid = mutationValid
      && child.experimentValid === true
      && generation.childCausalPass === child.causalPass
      && generation.familywisePass === familywisePass
      && generation.causalPass === familywisePass
      && generation.perGenerationAlpha
        === state.plan.statisticalAuthority.perGenerationAlpha
      && generation.adjustedTaskP
        === (Number.isFinite(childTaskP) ? childTaskP : null)
      && generation.catalogPersistence?.mode
        === (familywisePass ? 'routing-admission' : 'development-only');
    generationResults.push({
      generation: generation.generation,
      valid,
      childExperimentValid: child.experimentValid === true,
      childEvidenceSha256: child.evidenceSha256 || null
    });
  }
  if (state.currentGeneration) {
    const current = state.currentGeneration;
    const child = current.childRunId
      ? verifyAdaptiveRecursiveCanaryV2Run(store, current.childRunId)
      : null;
    modelCalls += current.mutationInvocation ? 1 : 0;
    childCalls += child?.tokenUsage?.observedCalls || 0;
    gates.currentGeneration = state.status === 'OPERATOR_STOP'
      && current.phase === 'CHILD_READY'
      && child?.resumeValid === true;
  } else {
    gates.currentGeneration = true;
  }
  gates.generationsReplay = generationResults.every((result) => result.valid);
  gates.callCap = modelCalls + childCalls <= state.plan.bounds.maximumCalls;
  gates.contextObservations = state.contextObservations.every((observation) => {
    const { artifactRef, artifactSha256, ...record } = observation;
    const artifact = readArtifact(store, runId, artifactRef);
    return validateContextSaturationObservation(record).status === 'OK'
      && artifact?.sha256 === artifactSha256
      && artifact.content === canonicalJson(record);
  });
  gates.contextPolicyArtifacts = state.contextPolicyArtifacts.every((ref) => {
    const artifact = readArtifact(store, runId, ref.id);
    const policy = parseArtifactJson(artifact);
    return artifact?.sha256 === ref.sha256
      && policy?.policyId === ref.policyId
      && policy?.policySha256 === ref.policySha256
      && validateAdaptiveContextPolicy(policy).status === 'OK';
  });
  gates.memoryLedger = state.memoryRecords.every((record) => {
    const artifact = readArtifact(store, runId, record.artifactRef);
    return artifact?.sha256 === record.artifactSha256
      && artifact?.content === record.content
      && sha256(record.content) === record.artifactSha256
      && SHA256_RE.test(String(record.semanticSha256 || ''));
  });
  const terminal = [
    'WAVE_DRAINED',
    'IDLE_NO_NEW_WORK',
    'OPERATOR_STOP',
    'BLOCKED'
  ].includes(state.status);
  const experimentValid = terminal
    && state.status !== 'BLOCKED'
    && Object.values(gates).every(Boolean);
  const base = {
    status: experimentValid ? 'PASS' : 'FAIL',
    runId,
    runDisposition: state.status,
    experimentValid,
    gates,
    modelCalls: modelCalls + childCalls,
    mutationCalls: modelCalls,
    childCalls,
    generationResults,
    verifiedImprovements: state.generations.filter((item) => item.causalPass).length,
    promotionEnabled: false,
    reasons: Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([gate]) => `${gate} gate failed`)
  };
  return { ...base, evidenceSha256: sha256(canonicalJson(base)) };
}

export function runAdaptiveRecursiveCampaign(store, config, {
  runId,
  mutationWorker = null,
  childWorker = adaptiveRecursiveCanaryWorker,
  childRunner = runAdaptiveRecursiveCanaryV2,
  persistChild = persistAdaptiveRecursiveCanaryV2Result,
  persistDevelopmentChild =
    persistAdaptiveRecursiveCanaryV2DevelopmentResult,
  shouldStop = () => false,
  clock = nowIso,
  onMutationPersisted = null
} = {}) {
  if (!isSafeId(runId)) return refused('BAD_RUN_ID', 'A safe recursive campaign run ID is required.');
  const validation = validateAdaptiveRecursiveCampaignConfig(config);
  if (!validation.ok) {
    return refused('RECURSIVE_CAMPAIGN_CONFIG_INVALID', validation.errors.join('; '));
  }
  let state;
  if (store.exists(runId)) {
    state = store.load(runId);
    const sealed = parseArtifactJson(readArtifact(
      store,
      runId,
      state?.evidenceArtifacts?.config?.id
    ));
    if (state?.kind !== ADAPTIVE_RECURSIVE_CAMPAIGN_RUN_KIND
        || canonicalJson(sealed) !== canonicalJson(config)
        || state.plan?.sha256 !== validation.plan.sha256) {
      return refused(
        'RECURSIVE_CAMPAIGN_RESUME_MISMATCH',
        'Existing campaign state does not match the sealed config.'
      );
    }
    if (['WAVE_DRAINED', 'IDLE_NO_NEW_WORK', 'OPERATOR_STOP'].includes(state.status)) {
      const verification = verifyAdaptiveRecursiveCampaignRun(store, runId);
      return ok({ runId, idempotent: true, verification, state });
    }
    if (state.status === 'BLOCKED') {
      return refused('RECURSIVE_CAMPAIGN_BLOCKED', 'Blocked campaign evidence is immutable.');
    }
  } else {
    const initialPolicy = createInitialAdaptiveContextPolicy({
      scopeId: `${runId.slice(0, 100)}-context`,
      ...config.context,
      recordedAt: clock()
    });
    if (initialPolicy.status !== 'OK') return initialPolicy;
    const routingPolicy = createBaselinePolicyEpoch({
      policyScopeId: `${runId.slice(0, 100)}-routing`
    });
    if (routingPolicy.status !== 'OK') return routingPolicy;
    const familyPersisted = persistAdaptiveRecord({
      homeDir: store.homeDir,
      record: config.seedParentFamily
    });
    if (familyPersisted.status !== 'OK') return familyPersisted;
    const policyPersisted = persistAdaptiveRecord({
      homeDir: store.homeDir,
      record: routingPolicy.record
    });
    if (policyPersisted.status !== 'OK') return policyPersisted;
    state = {
      schemaVersion: 1,
      kind: ADAPTIVE_RECURSIVE_CAMPAIGN_RUN_KIND,
      runId,
      status: 'RUNNING',
      createdAt: clock(),
      updatedAt: clock(),
      completedAt: null,
      approvedPlanSha256: config.approvedPlanSha256,
      plan: validation.plan,
      evidenceArtifacts: {},
      events: [],
      generations: [],
      currentGeneration: null,
      nextGeneration: 0,
      currentParentFamily: config.seedParentFamily,
      currentObjective: config.seedObjective,
      attemptedSemanticSha256s: [
        mechanismProgramSemanticSha256(
          config.seedParentFamily.causalFingerprint.program
        ).semanticSha256
      ],
      contextPolicy: initialPolicy.record,
      routingPolicyEpoch: routingPolicy.record,
      contextPolicyArtifacts: [],
      contextObservations: [],
      memoryRecords: [],
      promotion: { enabled: false, recorded: false },
      verification: null,
      reportPath: null,
      blocker: null
    };
    appendEvent(state, 'CAMPAIGN_INITIALIZED', {
      planSha256: validation.plan.sha256
    }, clock());
    store.save(state);
    state.evidenceArtifacts = {
      config: evidenceArtifact(store, runId, 'sealed-recursive-campaign-config', 'config', config),
      plan: evidenceArtifact(store, runId, 'sealed-recursive-campaign-plan', 'plan', validation.plan),
      runtimeAuthority: evidenceArtifact(store, runId, 'sealed-recursive-campaign-oauth', 'runtime-authority', config.runtimeAuthority),
      evaluatorAuthority: evidenceArtifact(store, runId, 'sealed-recursive-campaign-evaluator', 'evaluator-authority', config.evaluatorAuthority),
      implementation: evidenceArtifact(store, runId, 'sealed-recursive-campaign-implementation', 'implementation', config.implementationCapsule)
    };
    const policyArtifact = evidenceArtifact(
      store,
      runId,
      'context-policy-epoch-1',
      'context-policy',
      initialPolicy.record
    );
    state.contextPolicyArtifacts.push({
      id: policyArtifact.id,
      sha256: policyArtifact.sha256,
      policyId: initialPolicy.record.policyId,
      policySha256: initialPolicy.record.policySha256
    });
    state.memoryRecords.push(initialMemoryRecord(
      store,
      runId,
      config.seedParentFamily
    ));
    store.save(state);
  }

  const block = (code, message) => {
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.updatedAt = clock();
    state.completedAt = state.updatedAt;
    appendEvent(state, 'CAMPAIGN_BLOCKED', { code, message }, state.updatedAt);
    store.save(state);
    const verification = verifyAdaptiveRecursiveCampaignRun(store, runId);
    state.verification = verification;
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-recursive-campaign-report.md',
      renderCampaignReport(state, verification)
    );
    store.save(state);
    return { status: 'BLOCKED', code, message, runId, verification };
  };

  while (state.nextGeneration < config.maximumGenerations) {
    if (shouldStop()) {
      state.status = 'OPERATOR_STOP';
      state.completedAt = clock();
      state.updatedAt = state.completedAt;
      appendEvent(state, 'OPERATOR_STOP', {
        nextGeneration: state.nextGeneration
      }, state.completedAt);
      store.save(state);
      break;
    }
    if (!state.currentObjective) {
      state.status = 'IDLE_NO_NEW_WORK';
      state.completedAt = clock();
      state.updatedAt = state.completedAt;
      appendEvent(state, 'IDLE_NO_NEW_WORK', {
        nextGeneration: state.nextGeneration,
        inferenceCalls: 0
      }, state.completedAt);
      store.save(state);
      break;
    }
    const generation = state.nextGeneration;
    const tasks = generationByIndex(config, generation);
    if (!tasks) return block('GENERATION_TASKS_MISSING', `Generation ${generation} has no sealed task pool.`);

    if (state.currentGeneration?.phase === 'MUTATION_DISPATCHED') {
      const rejected = {
        generation,
        status: 'AMBIGUOUS_MUTATION_DISPATCH',
        causalPass: false,
        dispatchIntent: state.currentGeneration.dispatchIntent
      };
      state.generations.push(rejected);
      state.currentGeneration = null;
      state.nextGeneration += 1;
      appendEvent(state, 'AMBIGUOUS_MUTATION_DISPATCH', {
        generation,
        retried: false
      }, clock());
      store.save(state);
      continue;
    }

    if (!state.currentGeneration) {
      const routedContext = routedContextRecords(store, state, generation);
      if (routedContext.status !== 'OK') {
        return block(routedContext.code, routedContext.message);
      }
      const projection = buildLosslessContextProjection({
        policy: state.contextPolicy,
        records: [...state.memoryRecords, ...routedContext.contextRecords]
      });
      if (projection.status !== 'OK') return block(projection.code, projection.message);
      const contractBuilt = buildMechanismMutationContract({
        generation,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        parentFamily: state.currentParentFamily,
        objective: state.currentObjective,
        contextProjection: projection.record,
        allocatedInputTokens: state.contextPolicy.allocatedInputTokens,
        maximumOperations: config.maximumMutationOperations
      });
      if (contractBuilt.status !== 'OK') return block(contractBuilt.code, contractBuilt.message);
      state.currentGeneration = {
        generation,
        phase: 'MUTATION_DISPATCHED',
        dispatchIntent: {
          generation,
          contractSha256: contractBuilt.contract.contractSha256,
          contextIndexSha256: projection.record.indexSha256,
          attempt: 0,
          createdAt: clock()
        },
        routingDecision: routedContext.decision,
        routingCapsule: routedContext.capsule,
        routingArtifact: routedContext.routingArtifact
      };
      appendEvent(state, 'MUTATION_DISPATCHED', state.currentGeneration.dispatchIntent, clock());
      store.save(state);
      const mutation = executeMechanismMutationHypothesis({
        contract: contractBuilt.contract,
        runtimeAuthority: config.runtimeAuthority,
        worker: mutationWorker
      });
      if (mutation.status !== 'OK') {
        const authorityValid = mutation.result?.ok === true
          && mutationInvocationMatches({
            runtimeAuthority: config.runtimeAuthority,
            contract: contractBuilt.contract,
            invocation: mutation.result.invocation
          });
        if (!authorityValid || mutation.code !== 'MUTATION_OUTPUT_INVALID') {
          return block(mutation.code, mutation.message);
        }
        const rejectionEvidence = rejectedMutationArtifact(
          store,
          runId,
          generation,
          {
            contract: contractBuilt.contract,
            projection: projection.record,
            mutation
          }
        );
        state.generations.push({
          generation,
          status: 'MUTATION_REJECTED',
          causalPass: false,
          code: mutation.code,
          dispatchIntent: state.currentGeneration.dispatchIntent,
          rejectionEvidence: {
            id: rejectionEvidence.id,
            sha256: rejectionEvidence.sha256
          }
        });
        appendEvent(state, 'MUTATION_REJECTED', {
          generation,
          code: mutation.code,
          retried: false
        }, clock());
        state.currentGeneration = null;
        state.nextGeneration += 1;
        store.save(state);
        continue;
      }
      const artifacts = mutationArtifacts(store, runId, generation, {
        ...mutation,
        contract: contractBuilt.contract,
        projection: projection.record
      });
      const proposed = proposeMechanismEvolution({
        parentFamily: state.currentParentFamily,
        mutationPlan: mutation.plan,
        recordedAt: clock()
      });
      if (proposed.status !== 'OK'
          || state.attemptedSemanticSha256s.includes(
            proposed.record?.candidate?.semanticSha256
          )) {
        state.generations.push({
          generation,
          status: 'MUTATION_REJECTED',
          causalPass: false,
          code: proposed.status === 'OK' ? 'SEMANTIC_CANDIDATE_REPEATED' : proposed.code,
          dispatchIntent: state.currentGeneration.dispatchIntent,
          mutationPlan: mutation.plan,
          mutationOutput: mutation.output,
          mutationInvocation: mutation.result.invocation,
          mutationArtifacts: artifacts
        });
        appendEvent(state, 'MUTATION_REJECTED', {
          generation,
          code: proposed.status === 'OK' ? 'SEMANTIC_CANDIDATE_REPEATED' : proposed.code,
          retried: false
        }, clock());
        state.currentGeneration = null;
        state.nextGeneration += 1;
        store.save(state);
        continue;
      }
      const shadow = advanceMechanismEvolutionToShadow({
        currentRecord: proposed.record,
        parentFamily: state.currentParentFamily,
        candidateFamily: proposed.candidateFamily,
        interfaceContracts: [
          ...tasks.calibrationTasks,
          ...tasks.confirmationTasks
        ].map((task) => task.interfaceContract),
        recordedAt: clock()
      });
      if (shadow.status !== 'OK') {
        state.generations.push({
          generation,
          status: 'MUTATION_REJECTED',
          causalPass: false,
          code: shadow.code,
          dispatchIntent: state.currentGeneration.dispatchIntent,
          mutationPlan: mutation.plan,
          mutationOutput: mutation.output,
          mutationInvocation: mutation.result.invocation,
          mutationArtifacts: artifacts
        });
        appendEvent(state, 'MUTATION_REJECTED', {
          generation,
          code: shadow.code,
          retried: false
        }, clock());
        state.currentGeneration = null;
        state.nextGeneration += 1;
        store.save(state);
        continue;
      }
      const rawChild = {
        schemaVersion: 'adaptive-recursive-canary-v2',
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        authMode: 'chatgpt-oauth',
        retries: 0,
        promotionEnabled: false,
        historicalTokenEstimate: config.historicalTokenEstimatePerGeneration,
        replicatesPerArm: 3,
        calibrationRule: 'paired-placebo-upper-bound-v1',
        confirmationRule: 'five-task-adjusted-sign-test-v1',
        parentFamily: state.currentParentFamily,
        candidateFamily: proposed.candidateFamily,
        evolutionRecord: shadow.record,
        calibrationTasks: tasks.calibrationTasks,
        confirmationTasks: tasks.confirmationTasks
      };
      const unapprovedChild = prepareAdaptiveRecursiveCanaryV2Config(rawChild, {
        artifactRoot: config.artifactRoot,
        runtimeAuthorityRecord: config.runtimeAuthority,
        evaluatorAuthorityRecord: config.evaluatorAuthority
      });
      if (unapprovedChild.status !== 'OK') {
        return block(unapprovedChild.code, unapprovedChild.message);
      }
      const child = prepareAdaptiveRecursiveCanaryV2Config(rawChild, {
        artifactRoot: config.artifactRoot,
        runtimeAuthorityRecord: config.runtimeAuthority,
        evaluatorAuthorityRecord: config.evaluatorAuthority,
        approvedPlanSha256: unapprovedChild.plan.sha256
      });
      if (child.status !== 'OK') return block(child.code, child.message);
      const childConfigArtifact = evidenceArtifact(
        store,
        runId,
        `child-config-g${generation}`,
        'recursive-v2-child-config',
        child.config
      );
      const authorization = evidenceArtifact(
        store,
        runId,
        `child-authorization-g${generation}`,
        'derived-child-plan-authorization',
        {
          authority: 'deterministic-under-approved-parent-plan',
          parentPlanSha256: state.plan.sha256,
          childPlanSha256: child.plan.sha256,
          generation,
          promotionEnabled: false
        }
      );
      state.currentGeneration = {
        generation,
        phase: 'CHILD_READY',
        dispatchIntent: state.currentGeneration.dispatchIntent,
        routingDecision: state.currentGeneration.routingDecision,
        routingCapsule: state.currentGeneration.routingCapsule,
        routingArtifact: state.currentGeneration.routingArtifact,
        parentFamily: state.currentParentFamily,
        candidateFamily: proposed.candidateFamily,
        evolutionRecord: shadow.record,
        mutationPlan: mutation.plan,
        mutationOutput: mutation.output,
        mutationInvocation: mutation.result.invocation,
        mutationArtifacts: artifacts,
        contextProjection: projection.record,
        childRunId: childRunId(runId, generation),
        childConfigArtifact: {
          id: childConfigArtifact.id,
          sha256: childConfigArtifact.sha256
        },
        childPlanSha256: child.plan.sha256,
        childAuthorization: {
          id: authorization.id,
          sha256: authorization.sha256
        }
      };
      state.attemptedSemanticSha256s.push(proposed.record.candidate.semanticSha256);
      appendEvent(state, 'MUTATION_ACCEPTED', {
        generation,
        mutationPlanSha256: mutation.plan.mutationPlanSha256,
        candidateFamilySha256: proposed.candidateFamily.familySha256,
        childPlanSha256: child.plan.sha256
      }, clock());
      store.save(state);
      if (typeof onMutationPersisted === 'function') onMutationPersisted(state.currentGeneration);
    }

    const current = state.currentGeneration;
    const childConfig = parseArtifactJson(readArtifact(
      store,
      runId,
      current.childConfigArtifact.id
    ));
    if (!childConfig) return block('CHILD_CONFIG_INVALID', 'Persisted child config could not be reopened.');
    const childResult = childRunner(store, childConfig, {
      runId: current.childRunId,
      worker: childWorker,
      clock,
      shouldStop
    });
    if (childResult.status === 'OPERATOR_STOP') {
      state.status = 'OPERATOR_STOP';
      state.completedAt = clock();
      state.updatedAt = state.completedAt;
      appendEvent(state, 'OPERATOR_STOP', {
        generation,
        childRunId: current.childRunId,
        childCalls: childResult.verification?.tokenUsage?.observedCalls || 0
      }, state.completedAt);
      store.save(state);
      break;
    }
    if (childResult.status === 'BLOCKED'
        || childResult.experimentValid !== true) {
      return block(
        childResult.code || 'CHILD_EXPERIMENT_INVALID',
        childResult.message || 'Recursive V2 child failed independent verification.'
      );
    }
    const verification = verifyAdaptiveRecursiveCanaryV2Run(store, current.childRunId);
    const childTaskP = verification.confirmationAnalysis
      ?.summary?.adjustedTaskSignTest?.pOneSided;
    const familywisePass = state.plan.statisticalAuthority.routingAdmissionEnabled === true
      && verification.causalPass === true
      && Number.isFinite(childTaskP)
      && childTaskP <= state.plan.statisticalAuthority.perGenerationAlpha;
    const persisted = (familywisePass ? persistChild : persistDevelopmentChild)({
      homeDir: store.homeDir,
      sourceStore: store,
      runId: current.childRunId
    });
    if (persisted.status !== 'OK') return block(persisted.code, persisted.message);
    const generationRecord = {
      ...current,
      status: familywisePass
        ? 'VERIFIED_IMPROVEMENT'
        : verification.causalPass
          ? 'DEVELOPMENT_ADVANCE'
          : 'MEASURED_REJECTION',
      causalPass: familywisePass,
      childCausalPass: verification.causalPass,
      familywisePass,
      familywiseAlpha: state.plan.statisticalAuthority.familywiseAlpha,
      perGenerationAlpha: state.plan.statisticalAuthority.perGenerationAlpha,
      adjustedTaskP: Number.isFinite(childTaskP) ? childTaskP : null,
      calibrationQualified: verification.calibrationQualified,
      childEvidenceSha256: verification.evidenceSha256,
      catalogPersistence: {
        verifierEvidenceSha256: persisted.verifierEvidenceSha256,
        mode: persisted.mode || (familywisePass ? 'routing-admission' : 'development-only'),
        persisted: persisted.persisted
      }
    };
    state.memoryRecords.push(learningMemoryRecord(
      store,
      state,
      generationRecord,
      verification
    ));
    const contextUpdated = persistObservationAndPolicy(
      store,
      state,
      generationRecord,
      verification,
      clock
    );
    if (contextUpdated.status !== 'OK') {
      return block(contextUpdated.code, contextUpdated.message);
    }
    state.generations.push(generationRecord);
    if (verification.causalPass) {
      state.currentParentFamily = current.candidateFamily;
    }
    state.currentObjective = nextObjective(store, current.childRunId, verification);
    state.currentGeneration = null;
    state.nextGeneration += 1;
    state.updatedAt = clock();
    appendEvent(state, 'GENERATION_MEASURED', {
      generation,
      childRunId: current.childRunId,
      childCausalPass: verification.causalPass,
      familywisePass,
      adjustedTaskP: Number.isFinite(childTaskP) ? childTaskP : null,
      perGenerationAlpha: state.plan.statisticalAuthority.perGenerationAlpha,
      childEvidenceSha256: verification.evidenceSha256,
      nextObjectiveAvailable: state.currentObjective != null
    }, state.updatedAt);
    store.save(state);
  }

  if (state.status === 'RUNNING') {
    state.status = state.currentObjective == null
      ? 'IDLE_NO_NEW_WORK'
      : 'WAVE_DRAINED';
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    appendEvent(state, state.status, {
      generations: state.generations.length,
      nextObjectiveAvailable: state.currentObjective != null
    }, state.completedAt);
    store.save(state);
  }
  const verification = verifyAdaptiveRecursiveCampaignRun(store, runId);
  state.verification = verification;
  state.reportPath = store.writeRunFile(
    runId,
    'adaptive-recursive-campaign-report.md',
    renderCampaignReport(state, verification)
  );
  store.save(state);
  return ok({
    runId,
    disposition: state.status,
    verification,
    reportPath: state.reportPath,
    statePath: `${store.runDir(runId)}/state.json`
  });
}
