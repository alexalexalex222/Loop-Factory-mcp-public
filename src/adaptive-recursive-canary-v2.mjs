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
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import {
  captureExecutableEvaluatorAuthority,
  validateExecutableEvaluatorAuthority,
  validateExecutableInterfaceCoverage
} from './adaptive-executable-canary.mjs';
import {
  ADAPTIVE_RECURSIVE_IMPLEMENTATION_PATHS,
  resolveTaskMaterial
} from './adaptive-recursive-runner.mjs';
import {
  ADAPTIVE_RECURSIVE_REASONING_EFFORTS,
  ADAPTIVE_RECURSIVE_SUPPORTED_MODELS,
  compileAdaptiveRecursiveTaskTreatments
} from './adaptive-recursive-canary.mjs';
import {
  RECURSIVE_CONFIRMATION_RULE,
  RECURSIVE_PLACEBO_CALIBRATION_RULE
} from './adaptive-recursive-statistics.mjs';
import {
  captureCodexOAuthAuthority,
  validateCodexOAuthAuthorityRecord
} from './codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from './executor.mjs';
import { validateMechanismEvolutionRecord } from './mechanism-evolution-records.mjs';
import { stableJson } from './canary-runner.mjs';
import { canonicalJson } from './real-test.mjs';
import { isSafeId, sha256 } from './util.mjs';
import {
  createResourceBudgetPolicy
} from './resource-budget.mjs';
import {
  validateVNextMechanismExecutionBinding
} from './vnext-mechanism-execution.mjs';
import { createPaceAcceptor } from './pace-acceptor.mjs';

export const ADAPTIVE_RECURSIVE_CANARY_V2_SCHEMA_VERSION =
  'adaptive-recursive-canary-v2';
export const ADAPTIVE_RECURSIVE_CANARY_V2 = Object.freeze({
  arms: Object.freeze(['candidate', 'cold', 'parent', 'sham']),
  stages: Object.freeze(['calibration', 'confirmation']),
  tasksPerStage: 5,
  replicatesPerArm: 3,
  calibrationCalls: 60,
  confirmationCalls: 60,
  maximumCalls: 120,
  retries: 0,
  perCallTimeoutMs: 10 * 60 * 1000,
  sequentialTimeoutCeilingMinutes: 1200,
  promotionEnabled: false
});

export const ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS = Object.freeze([
  ...new Set([
    ...ADAPTIVE_RECURSIVE_IMPLEMENTATION_PATHS,
    'src/adaptive-canary-import.mjs',
    'src/adaptive-policy.mjs',
    'src/baseline-integrity.mjs',
    'src/constants.mjs',
    'src/host.mjs',
    'src/hybrid-retrieval.mjs',
    'src/hypothesis-falsifier.mjs',
    'src/isolated-evaluator.mjs',
    'src/loops.mjs',
    'src/mechanism-router.mjs',
    'src/meta-policy.mjs',
    'src/models.mjs',
    'src/real-test.mjs',
    'src/research-dossier.mjs',
    'src/skill-schema.mjs',
    'src/supervisor.mjs',
    'src/task-agent-feedback.mjs',
    'src/vnext-failure.mjs',
    'src/vnext-hypothesis.mjs',
    'src/vnext-research.mjs',
    'scripts/plan-adaptive-recursive-canary-v2.mjs',
    'scripts/run-adaptive-recursive-canary-v2.mjs',
    'scripts/verify-adaptive-recursive-canary-v2.mjs',
    'src/adaptive-recursive-canary-v2.mjs',
    'src/adaptive-recursive-runner-v2.mjs',
    'src/adaptive-recursive-vnext-run.mjs',
    'src/adaptive-recursive-statistics.mjs',
    'src/mechanism-evolution-admission-v2.mjs',
    'src/pace-acceptor.mjs',
    'src/process-launch.mjs',
    'src/process-tree-runner.mjs',
    'src/process-tree-supervisor.mjs',
    'src/resource-budget.mjs',
    'src/resource-budget-store.mjs',
    'src/run-lease.mjs',
    'src/run-lease-heartbeat.mjs',
    'src/ephemeral-auth-capsule.mjs',
    'src/vnext-candidate-generators.mjs',
    'src/vnext-candidate-strategies.mjs',
    'src/vnext-ablation-profile.mjs',
    'src/vnext-code-worktree.mjs',
    'src/vnext-contracts.mjs',
    'src/vnext-evidence-bank.mjs',
    'src/vnext-evidence-authority.mjs',
    'src/vnext-external-research.mjs',
    'src/vnext-external-research-worker.mjs',
    'src/vnext-mechanism-execution.mjs',
    'src/vnext-model-contracts.mjs',
    'src/vnext-model-identity.mjs',
    'src/vnext-model-worker.mjs',
    'src/vnext-operator-control-contract.mjs',
    'src/vnext-pipeline.mjs',
    'src/vnext-preparation-store.mjs',
    'src/vnext-recursive-import.mjs',
    'src/vnext-recursive-import-transaction.mjs',
    'src/mechanism-catalog.mjs',
    'scripts/vnext-model-worker.mjs',
    'scripts/vnext-guarded-exec.mjs',
    'scripts/run-lease-heartbeat.mjs',
    'scripts/run-vnext-code-candidate.mjs',
    'scripts/verify-vnext-code-candidate.mjs',
    'scripts/run-vnext-external-research.mjs',
    'scripts/verify-vnext-external-research.mjs',
    'src/schemas/adaptive-recursive-canary-v2.schema.json',
    'src/schemas/mechanism-evolution-admission-v2.schema.json',
    'src/schemas/vnext-candidate-output-v1.schema.json',
    'src/schemas/vnext-candidate-strategy-plan-v1.schema.json',
    'src/schemas/vnext-code-worktree-run-v1.schema.json',
    'src/schemas/vnext-falsification-output-v1.schema.json',
    'src/schemas/vnext-external-research-discovery-output-v1.schema.json',
    'src/schemas/vnext-external-research-plan-v1.schema.json',
    'src/schemas/vnext-external-research-fetch-v1.schema.json',
    'src/schemas/vnext-external-research-policy-v1.schema.json',
    'src/schemas/vnext-hypothesis-output-v1.schema.json',
    'src/schemas/vnext-model-identity-policy-v1.schema.json',
    'src/schemas/vnext-normalized-failure-v1.schema.json',
    'src/schemas/vnext-reranker-output-v1.schema.json',
    'src/schemas/vnext-research-output-v1.schema.json',
    'src/schemas/vnext-resource-budget-v1.schema.json',
    'src/schemas/vnext-resource-budget-ledger-v1.schema.json',
    'src/schemas/vnext-stage-envelope-v1.schema.json'
  ])
]);

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA256_RE = /^[a-f0-9]{64}$/;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, stableValue(value[key])]));
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function artifactRecord(path, content) {
  return {
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    content
  };
}

function validArtifact(value) {
  return plainObject(value)
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= 500
    && !isAbsolute(value.path)
    && !value.path.split('/').includes('..')
    && SHA256_RE.test(String(value.sha256 || ''));
}

function taskSets(config) {
  return ADAPTIVE_RECURSIVE_CANARY_V2.stages.flatMap((stage) => (
    (Array.isArray(config?.[`${stage}Tasks`])
      ? config[`${stage}Tasks`]
      : []).map((task) => ({ stage, task }))
  ));
}

function normalizedTask(task, stage, parentFamily, candidateFamily) {
  if (!plainObject(task)
      || !isSafeId(task.id)
      || !validArtifact(task.source)
      || !validArtifact(task.incident)
      || !validArtifact(task.interface)
      || !validArtifact(task.oracle)) {
    return refused('RECURSIVE_V2_TASK_INVALID', `${stage} task is malformed.`);
  }
  const compiled = compileAdaptiveRecursiveTaskTreatments({
    task,
    parentFamily,
    candidateFamily
  });
  if (compiled.status !== 'OK') return compiled;
  return ok({
    task: {
      stage,
      id: task.id,
      source: task.source,
      incident: task.incident,
      interface: task.interface,
      oracle: task.oracle,
      treatmentDeltaSha256: compiled.treatmentDeltaSha256,
      treatments: Object.fromEntries(Object.entries(compiled.packets).map(([arm, packet]) => (
        [arm, packet?.packetSha256 || null]
      )))
    }
  });
}

function portableArgv(model, reasoningEffort) {
  const schemaPath = schemaPathForContract({ kind: 'proposal' });
  const argv = buildArgs('codex', null, model, {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: '<fresh-model-capsule>',
    reasoningEffort
  });
  return {
    argv: argv.map((value) => (
      value === schemaPath ? '<proposal-output-schema>' : value
    )),
    outputSchemaSha256: sha256(readFileSync(schemaPath)),
    disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES]
  };
}

function rawConfigCore(config) {
  return {
    schemaVersion: config.schemaVersion,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    authMode: config.authMode,
    retries: config.retries,
    promotionEnabled: config.promotionEnabled,
    historicalTokenEstimate: config.historicalTokenEstimate,
    replicatesPerArm: config.replicatesPerArm,
    calibrationRule: config.calibrationRule,
    confirmationRule: config.confirmationRule,
    parentFamily: config.parentFamily,
    candidateFamily: config.candidateFamily,
    evolutionRecord: config.evolutionRecord,
    ...(config.resourceBudgetPolicy ? {
      resourceBudgetPolicy: config.resourceBudgetPolicy,
      perCallBudget: config.perCallBudget
    } : {}),
    ...(config.vnextBinding ? { vnextBinding: config.vnextBinding } : {}),
    ...(config.vnextBehaviorMap ? { vnextBehaviorMap: config.vnextBehaviorMap } : {}),
    ...(config.pacePolicy ? { pacePolicy: config.pacePolicy } : {}),
    calibrationTasks: [...config.calibrationTasks].sort((left, right) => (
      String(left.id).localeCompare(String(right.id))
    )),
    confirmationTasks: [...config.confirmationTasks].sort((left, right) => (
      String(left.id).localeCompare(String(right.id))
    ))
  };
}

function validResourceBudget(config) {
  if (config.resourceBudgetPolicy == null && config.perCallBudget == null) return true;
  const policy = createResourceBudgetPolicy(config.resourceBudgetPolicy);
  const callCount = ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls;
  const aggregateInput = Number(config.perCallBudget?.maxInputTokens) * callCount;
  const aggregateOutput = Number(config.perCallBudget?.maxOutputTokens) * callCount;
  const aggregateTotal = aggregateInput + aggregateOutput;
  const aggregateUsdMicros = policy.status === 'OK'
    ? Math.ceil((aggregateInput * policy.policy.inputUsdMicrosPerMillionTokens
      + aggregateOutput * policy.policy.outputUsdMicrosPerMillionTokens) / 1_000_000)
    : Number.NaN;
  return policy.status === 'OK'
    && policy.policy.policySha256 === config.resourceBudgetPolicy.policySha256
    && policy.policy.maxCalls >= ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls
    && plainObject(config.perCallBudget)
    && canonical(Object.keys(config.perCallBudget).sort())
      === canonical(['maxInputTokens', 'maxOutputTokens'].sort())
    && Number.isInteger(config.perCallBudget.maxInputTokens)
    && config.perCallBudget.maxInputTokens > 0
    && Number.isInteger(config.perCallBudget.maxOutputTokens)
    && config.perCallBudget.maxOutputTokens > 0
    && Number.isSafeInteger(aggregateInput)
    && Number.isSafeInteger(aggregateOutput)
    && Number.isSafeInteger(aggregateTotal)
    && aggregateInput <= policy.policy.maxInputTokens
    && aggregateOutput <= policy.policy.maxOutputTokens
    && aggregateTotal <= policy.policy.maxTotalTokens
    && aggregateUsdMicros <= policy.policy.maxUsdMicros;
}

function validVNextBinding(config) {
  if (config.vnextBinding == null) return config.vnextBehaviorMap == null;
  const binding = config.vnextBinding;
  const behaviorMap = config.vnextBehaviorMap;
  const behaviorMapCore = behaviorMap && typeof behaviorMap === 'object'
    ? structuredClone(behaviorMap)
    : null;
  if (behaviorMapCore) delete behaviorMapCore.behaviorMapSha256;
  return config.resourceBudgetPolicy != null
    && validateVNextMechanismExecutionBinding(binding).status === 'OK'
    && behaviorMap?.schemaVersion === 'vnext-harness-handbook-v1'
    && behaviorMap?.authority === 'descriptive-source-map-only'
    && behaviorMap?.canAuthorizeEdits === false
    && behaviorMap?.behaviorMapSha256 === sha256(canonical(behaviorMapCore))
    && behaviorMap.behaviorMapSha256 === binding.behaviorMapSha256
    && behaviorMap.behaviors?.some((behavior) => (
      behavior.id === 'mechanism-program'
      && Array.isArray(behavior.locators)
      && behavior.locators.length > 0
    ))
    && binding.productionEvidence === true
    && binding.parentFamilySha256 === config.parentFamily?.familySha256
    && binding.candidateFamilySha256 === config.candidateFamily?.familySha256
    && binding.candidateProgramSha256 === config.evolutionRecord?.candidate?.programSha256
    && binding.mutationPlanSha256
      === config.evolutionRecord?.mutationPlan?.mutationPlanSha256
    && binding.evolutionSha256 === config.evolutionRecord?.evolutionSha256
    && binding.treatmentDeltaSha256
      === config.evolutionRecord?.evidence?.treatmentDeltaSha256;
}

function validPacePolicy(config) {
  if (config.pacePolicy == null) return config.vnextBinding == null;
  const policy = config.pacePolicy;
  if (!plainObject(policy)
      || canonical(Object.keys(policy).sort()) !== canonical([
        'lambdaPolicy',
        'maximumRelativeTokenIncrease',
        'maximumShamMovement',
        'ordering',
        'outerAlphaAllocation',
        'policySha256',
        'schemaVersion'
      ].sort())
      || policy.schemaVersion !== 'vnext-pace-canary-policy-v1'
      || policy.ordering !== 'policy-hash-task-id-v1'
      || !Number.isFinite(policy.maximumShamMovement)
      || policy.maximumShamMovement < 0
      || !Number.isFinite(policy.maximumRelativeTokenIncrease)
      || policy.maximumRelativeTokenIncrease < 0) return false;
  const core = structuredClone(policy);
  delete core.policySha256;
  if (policy.policySha256 !== sha256(canonical(core))) return false;
  return createPaceAcceptor({
    candidateId: config.candidateFamily?.familyId,
    outerAlphaAllocation: policy.outerAlphaAllocation,
    lambdaPolicy: policy.lambdaPolicy
  }).status === 'OK';
}

function preparedBindings(config) {
  const present = [
    config.runtimeAuthority,
    config.evaluatorAuthority,
    config.implementationManifest,
    config.taskMaterials
  ].filter((value) => value != null).length;
  if (present === 0) return null;
  if (present !== 4
      || !SHA256_RE.test(String(config.runtimeAuthority?.authoritySha256 || ''))
      || !SHA256_RE.test(String(config.runtimeAuthority?.binary?.sha256 || ''))
      || !SHA256_RE.test(String(config.evaluatorAuthority?.authoritySha256 || ''))
      || !Array.isArray(config.implementationManifest)
      || !Array.isArray(config.taskMaterials)) return false;
  const materials = config.taskMaterials.map((material) => ({
    stage: material.stage,
    id: material.id,
    sourceSha256: material.source?.sha256,
    incidentSha256: material.incident?.sha256,
    interfaceSha256: material.interface?.sha256,
    interfaceSemanticSha256: material.interface?.semanticSha256,
    oracleSha256: material.oracle?.sha256,
    caseSetSha256: material.caseSetSha256,
    interfaceCoverageSha256: material.interfaceCoverageSha256,
    treatmentDeltaSha256: material.treatmentDeltaSha256,
    treatmentPacketSha256s: Object.fromEntries(Object.entries(
      material.treatmentPackets || {}
    ).map(([arm, packet]) => [arm, packet?.packetSha256 || null]))
  })).sort((left, right) => (
    left.stage.localeCompare(right.stage) || left.id.localeCompare(right.id)
  ));
  return {
    runtimeAuthoritySha256: config.runtimeAuthority.authoritySha256,
    runtimeExecutableSha256: config.runtimeAuthority.binary.sha256,
    runtimeVersion: config.runtimeAuthority.binary.version,
    evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
    implementationManifestSha256: sha256(canonical(config.implementationManifest)),
    taskMaterialSetSha256: sha256(canonical(materials))
  };
}

function disjointTaskSets(tasks) {
  const ids = tasks.map((item) => item.id);
  const treatmentHashes = tasks.flatMap((item) => (
    Object.values(item.treatments).filter(Boolean)
  ));
  const protectedBindings = tasks.flatMap((item) => [
    item.source.path,
    item.incident.path,
    item.oracle.path,
    item.source.sha256,
    item.oracle.sha256
  ]);
  return new Set(ids).size === ids.length
    && new Set(treatmentHashes).size === treatmentHashes.length
    && new Set(protectedBindings).size === protectedBindings.length;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function disjointDiagnostics(tasks) {
  return {
    duplicateTaskIds: duplicateValues(tasks.map((item) => item.id)),
    duplicateTreatmentHashes: duplicateValues(tasks.flatMap((item) => (
      Object.values(item.treatments).filter(Boolean)
    ))),
    duplicateProtectedBindings: duplicateValues(tasks.flatMap((item) => [
      item.source.path,
      item.incident.path,
      item.oracle.path,
      item.source.sha256,
      item.oracle.sha256
    ]))
  };
}

function stageCalls(tasks, stage, configSha256, offset) {
  return tasks.flatMap((task) => (
    Array.from({ length: ADAPTIVE_RECURSIVE_CANARY_V2.replicatesPerArm }, (_, replicate) => (
      ADAPTIVE_RECURSIVE_CANARY_V2.arms.map((arm) => ({
        stage,
        taskId: task.id,
        replicate,
        arm,
        treatmentPacketSha256: task.treatments[arm],
        outputSchemaKind: 'proposal'
      }))
    )).flat()
  )).sort((left, right) => (
    sha256(`${configSha256}:${stage}:${left.taskId}:${left.replicate}:${left.arm}`)
      .localeCompare(sha256(`${configSha256}:${stage}:${right.taskId}:${right.replicate}:${right.arm}`))
  )).map((call, index) => ({ callIndex: offset + index, ...call }));
}

export function buildAdaptiveRecursiveCanaryV2Plan(config = {}) {
  try {
    if (config.schemaVersion !== ADAPTIVE_RECURSIVE_CANARY_V2_SCHEMA_VERSION
        || !ADAPTIVE_RECURSIVE_SUPPORTED_MODELS.includes(config.model)
        || !ADAPTIVE_RECURSIVE_REASONING_EFFORTS.includes(config.reasoningEffort)
        || config.authMode !== 'chatgpt-oauth'
        || config.retries !== 0
        || config.promotionEnabled !== false
        || !Number.isInteger(config.historicalTokenEstimate)
        || config.historicalTokenEstimate <= 0
        || config.replicatesPerArm !== ADAPTIVE_RECURSIVE_CANARY_V2.replicatesPerArm
        || config.calibrationRule !== RECURSIVE_PLACEBO_CALIBRATION_RULE
        || config.confirmationRule !== RECURSIVE_CONFIRMATION_RULE
        || !validResourceBudget(config)
        || !validVNextBinding(config)
        || !validPacePolicy(config)
        || validateAdaptiveRecord(config.parentFamily).status !== 'OK'
        || validateAdaptiveRecord(config.candidateFamily).status !== 'OK'
        || !config.parentFamily.causalFingerprint?.program
        || !config.candidateFamily.causalFingerprint?.program
        || validateMechanismEvolutionRecord(config.evolutionRecord).status !== 'OK'
        || config.evolutionRecord.state !== 'SHADOW'
        || config.evolutionRecord.parent.familyId !== config.parentFamily.familyId
        || config.evolutionRecord.parent.familySha256 !== config.parentFamily.familySha256
        || config.evolutionRecord.candidate.familyId !== config.candidateFamily.familyId
        || config.evolutionRecord.candidate.familySha256 !== config.candidateFamily.familySha256
        || !Array.isArray(config.calibrationTasks)
        || config.calibrationTasks.length !== ADAPTIVE_RECURSIVE_CANARY_V2.tasksPerStage
        || !Array.isArray(config.confirmationTasks)
        || config.confirmationTasks.length !== ADAPTIVE_RECURSIVE_CANARY_V2.tasksPerStage) {
      return refused(
        'RECURSIVE_V2_CONFIG_INVALID',
        'V2 requires one shadow descendant, two five-task generations, three replicates per arm, exact OAuth routing, zero retries, and no promotion.'
      );
    }
    const tasks = [];
    for (const { stage, task } of taskSets(config)) {
      const normalized = normalizedTask(
        task,
        stage,
        config.parentFamily,
        config.candidateFamily
      );
      if (normalized.status !== 'OK') return normalized;
      tasks.push(normalized.task);
    }
    tasks.sort((left, right) => (
      left.stage.localeCompare(right.stage) || left.id.localeCompare(right.id)
    ));
    if (!disjointTaskSets(tasks)) {
      return refused(
        'RECURSIVE_V2_GENERATIONS_NOT_DISJOINT',
        'Calibration and confirmation must have unique task, source, oracle, and treatment identities.',
        { diagnostics: disjointDiagnostics(tasks) }
      );
    }
    const bindings = preparedBindings(config);
    if (bindings === false) {
      return refused(
        'RECURSIVE_V2_PREPARED_BINDINGS_INVALID',
        'Prepared runtime, evaluator, implementation, and task bindings must be complete.'
      );
    }
    const configSha256 = sha256(canonical(rawConfigCore(config)));
    const calibrationTasks = tasks.filter((task) => task.stage === 'calibration');
    const confirmationTasks = tasks.filter((task) => task.stage === 'confirmation');
    const calibrationCalls = stageCalls(calibrationTasks, 'calibration', configSha256, 0);
    const confirmationCalls = stageCalls(
      confirmationTasks,
      'confirmation',
      configSha256,
      calibrationCalls.length
    );
    const payload = {
      schemaVersion: ADAPTIVE_RECURSIVE_CANARY_V2_SCHEMA_VERSION,
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
      causalDesign: {
        replicatesPerArm: ADAPTIVE_RECURSIVE_CANARY_V2.replicatesPerArm,
        calibrationRule: RECURSIVE_PLACEBO_CALIBRATION_RULE,
        confirmationRule: RECURSIVE_CONFIRMATION_RULE,
        calibrationTasks: calibrationTasks.length,
        confirmationTasks: confirmationTasks.length,
        confirmationConditionalOnCalibration: true,
        finalGenerationUntouchedAtLaunch: true
      },
      exposure: {
        calibrationCalls: calibrationCalls.length,
        conditionalConfirmationCalls: confirmationCalls.length,
        maximumCalls: calibrationCalls.length + confirmationCalls.length,
        perCallTimeoutMs: ADAPTIVE_RECURSIVE_CANARY_V2.perCallTimeoutMs,
        sequentialTimeoutCeilingMinutes:
          ADAPTIVE_RECURSIVE_CANARY_V2.sequentialTimeoutCeilingMinutes,
        historicalTokenEstimate: config.historicalTokenEstimate,
        hardTokenCeiling: config.resourceBudgetPolicy
          ? config.resourceBudgetPolicy.maxTotalTokens
          : null,
        tokenCeilingEnforcement: config.resourceBudgetPolicy
          ? 'local reservation before dispatch and receipt settlement after each call; no provider-side output preemption'
          : 'none',
        providerEnforcedOutputTokenLimit: null,
        hardUsdCeiling: config.resourceBudgetPolicy
          ? config.resourceBudgetPolicy.maxUsdMicros / 1_000_000
          : null
      },
      ...(config.vnextBinding ? {
        vnext: {
          ...config.vnextBinding,
          resourceBudgetPolicySha256: config.resourceBudgetPolicy.policySha256,
          perCallBudget: config.perCallBudget,
          pacePolicySha256: config.pacePolicy.policySha256
        }
      } : {}),
      evolution: {
        evolutionId: config.evolutionRecord.evolutionId,
        evolutionReceiptId: config.evolutionRecord.evolutionReceiptId,
        evolutionSha256: config.evolutionRecord.evolutionSha256,
        parentFamilyId: config.parentFamily.familyId,
        parentProgramSha256: config.evolutionRecord.parent.programSha256,
        candidateFamilyId: config.candidateFamily.familyId,
        candidateProgramSha256: config.evolutionRecord.candidate.programSha256,
        sourceMeasurementId: config.evolutionRecord.evidence.sourceMeasurementId,
        sourceMeasurementSha256: config.evolutionRecord.evidence.sourceMeasurementSha256,
        treatmentDeltaSha256: config.evolutionRecord.evidence.treatmentDeltaSha256
      },
      execution: portableArgv(config.model, config.reasoningEffort),
      preparedBindings: bindings,
      tasks,
      calibrationCalls,
      confirmationCalls
    };
    return ok({ plan: { ...payload, sha256: sha256(canonical(payload)) } });
  } catch (error) {
    return refused('RECURSIVE_V2_PLAN_FAILED', error.message);
  }
}

export function resolveAdaptiveRecursiveV2Implementation({
  packageRoot = PACKAGE_ROOT
} = {}) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const capsule = ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full)
          || !existsSync(full)
          || lstatSync(full).isSymbolicLink()) {
        throw new Error(`recursive V2 dependency is missing or unsafe: ${path}`);
      }
      return artifactRecord(path, readFileSync(full, 'utf8'));
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
    return refused('RECURSIVE_V2_IMPLEMENTATION_UNRESOLVED', error.message);
  }
}

function materialFor(config, stage, taskId) {
  return config.taskMaterials?.find((material) => (
    material.stage === stage && material.id === taskId
  )) || null;
}

function validateTaskMaterials(config) {
  const all = taskSets(config);
  if (!Array.isArray(config.taskMaterials)
      || config.taskMaterials.length !== all.length) return false;
  for (const { stage, task } of all) {
    const material = materialFor(config, stage, task.id);
    if (!material) return false;
    for (const field of ['source', 'incident', 'interface', 'oracle']) {
      const item = material[field];
      if (!item
          || item.path !== task[field].path
          || item.bytes !== Buffer.byteLength(item.content)
          || item.sha256 !== sha256(item.content)) return false;
    }
    if (material.source.sha256 !== task.source.sha256
        || material.incident.sha256 !== task.incident.sha256
        || material.oracle.sha256 !== task.oracle.sha256
        || material.interface.semanticSha256 !== task.interface.sha256
        || material.caseSetSha256 !== sha256(canonicalJson(material.caseSet))) return false;
    const coverage = validateExecutableInterfaceCoverage(
      material.caseSet,
      task.interfaceContract
    );
    if (!coverage.ok || coverage.sha256 !== material.interfaceCoverageSha256) return false;
    const compiled = compileAdaptiveRecursiveTaskTreatments({
      task,
      parentFamily: config.parentFamily,
      candidateFamily: config.candidateFamily
    });
    if (compiled.status !== 'OK'
        || compiled.treatmentDeltaSha256 !== material.treatmentDeltaSha256
        || stableJson(compiled.packets) !== stableJson(material.treatmentPackets)) return false;
  }
  return true;
}

function validateImplementation(config) {
  const current = resolveAdaptiveRecursiveV2Implementation();
  return current.status === 'OK'
    && stableJson(current.manifest) === stableJson(config.implementationManifest)
    && stableJson(current.capsule) === stableJson(config.implementationCapsule);
}

export function prepareAdaptiveRecursiveCanaryV2Config(raw = {}, {
  packageRoot = PACKAGE_ROOT,
  artifactRoot = packageRoot,
  codexBinaryPath,
  runtimeAuthorityRecord = null,
  evaluatorAuthorityRecord = null,
  approvedPlanSha256 = null
} = {}) {
  const built = buildAdaptiveRecursiveCanaryV2Plan(raw);
  if (built.status !== 'OK') return built;
  const runtimeAuthority = runtimeAuthorityRecord
    ? validateCodexOAuthAuthorityRecord(runtimeAuthorityRecord)
    : captureCodexOAuthAuthority({
        binaryPath: codexBinaryPath,
        requestedModel: raw.model,
        reasoningEffort: raw.reasoningEffort
      });
  if (runtimeAuthority.status !== 'OK') return runtimeAuthority;
  const evaluatorAuthority = evaluatorAuthorityRecord
    ? validateExecutableEvaluatorAuthority(evaluatorAuthorityRecord)
    : captureExecutableEvaluatorAuthority();
  if (evaluatorAuthority.status !== 'OK') return evaluatorAuthority;
  const implementation = resolveAdaptiveRecursiveV2Implementation({ packageRoot });
  if (implementation.status !== 'OK') return implementation;
  const taskMaterials = [];
  for (const { stage, task } of taskSets(raw)) {
    const resolved = resolveTaskMaterial(
      artifactRoot,
      task,
      raw.parentFamily,
      raw.candidateFamily
    );
    if (resolved.status !== 'OK') return resolved;
    taskMaterials.push({ ...resolved.material, stage });
  }
  taskMaterials.sort((left, right) => (
    left.stage.localeCompare(right.stage) || left.id.localeCompare(right.id)
  ));
  const config = {
    ...raw,
    approvedPlanSha256,
    runtimeAuthority: runtimeAuthority.record,
    evaluatorAuthority: evaluatorAuthority.record,
    implementationManifest: implementation.manifest,
    implementationCapsule: implementation.capsule,
    taskMaterials
  };
  const validation = validateAdaptiveRecursiveCanaryV2Config(config, {
    requireApproval: approvedPlanSha256 != null
  });
  return validation.ok
    ? ok({ config, plan: validation.plan })
    : refused('RECURSIVE_V2_PREPARED_CONFIG_INVALID', validation.errors.join('; '), {
        errors: validation.errors,
        plan: validation.plan
      });
}

export function validateAdaptiveRecursiveCanaryV2Config(config = {}, {
  requireApproval = true
} = {}) {
  const errors = [];
  const built = buildAdaptiveRecursiveCanaryV2Plan(config);
  if (built.status !== 'OK') errors.push(`${built.code}: ${built.message}`);
  const runtime = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtime.status !== 'OK'
      || runtime.record?.requestedModel !== config.model
      || runtime.record?.reasoningEffort !== config.reasoningEffort) {
    errors.push('Codex OAuth authority does not bind the exact V2 model and reasoning effort');
  }
  const evaluator = validateExecutableEvaluatorAuthority(config.evaluatorAuthority);
  if (evaluator.status !== 'OK') {
    errors.push(...(evaluator.errors || ['evaluator authority is invalid']));
  }
  if (!validateImplementation(config)) {
    errors.push('recursive V2 implementation capsule does not match current bytes');
  }
  if (!validateTaskMaterials(config)) {
    errors.push('recursive V2 task materials do not match sealed artifacts and treatments');
  }
  if (requireApproval && config.approvedPlanSha256 !== built.plan?.sha256) {
    errors.push('approved plan SHA-256 does not match the prepared recursive V2 plan');
  }
  return {
    ok: errors.length === 0,
    errors,
    plan: built.plan || null,
    runtimeAuthority: runtime,
    evaluatorAuthority: evaluator
  };
}

export function adaptiveRecursiveCanaryV2LaunchDisclosure(config = {}, {
  configPath = '',
  home = '',
  runId = ''
} = {}) {
  const built = buildAdaptiveRecursiveCanaryV2Plan(config);
  if (built.status !== 'OK') return built;
  const plan = built.plan;
  return ok({
    planSha256: plan.sha256,
    configSha256: plan.configSha256,
    calibrationCalls: plan.exposure.calibrationCalls,
    conditionalConfirmationCalls: plan.exposure.conditionalConfirmationCalls,
    maximumCalls: plan.exposure.maximumCalls,
    hardTokenCeiling: plan.exposure.hardTokenCeiling,
    tokenCeilingEnforcement: plan.exposure.tokenCeilingEnforcement,
    providerEnforcedOutputTokenLimit:
      plan.exposure.providerEnforcedOutputTokenLimit,
    hardUsdCeiling: plan.exposure.hardUsdCeiling,
    exactArgv: plan.execution.argv,
    launchCommand: [
      'SUPER_LOOP_ALLOW_EXEC=1 npm run recursive-canary:v2 --',
      `--config ${configPath}`,
      `--approved-plan ${plan.sha256}`,
      `--run-id ${runId}`,
      `--home ${home}`
    ].join(' ')
  });
}
