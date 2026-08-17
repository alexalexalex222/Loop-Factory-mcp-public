// Confirmatory cross-task causal proof for adaptive mechanism routing.
//
// Five prospectively frozen tasks each receive baseline, routed, and
// schema-identical sham proposal arms. Every proposal is evaluated once against
// its task's evaluator-only partition. Calls run in deterministic waves of at
// most two; state mutation remains serialized in the parent process.
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASE_RESULTS_ORACLE_KIND_V2,
  evaluateCaseResultsGameability,
  isCaseResultsOracle,
  parseCaseResults,
  scoreCaseResults
} from './measure.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  STRICT_CODEX_REASONING_EFFORT,
  buildArgs,
  buildExecutorPrompt,
  schemaPathForContract
} from './executor.mjs';
import {
  REAL_TEST_MODEL,
  canonicalJson
} from './real-test.mjs';
import {
  PRESENTATION_ONLY_SHAM_VALIDATION,
  compilePhaseContract,
  validateWorkerPacket
} from './supervisor.mjs';
import {
  verifyPersistedAgentRun,
  verifyPersistedProposalRun
} from './run-verifier.mjs';
import {
  canonicalAdaptiveJson,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';
import { buildMechanismRoutingDecision } from './mechanism-router.mjs';
import {
  capsuleSchemaSha256,
  createIrrelevantShamCapsule
} from './adaptive-meta-canary.mjs';
import {
  persistCanaryEvaluation,
  persistCanaryProposal,
  persistRejectedDispatch,
  stableJson,
  writeCanaryArtifact
} from './canary-runner.mjs';
import {
  isAbsoluteOnAnyPlatform,
  isSafeId,
  nowIso,
  round,
  sha256
} from './util.mjs';

export const ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION =
  'adaptive-transfer-cohort-v1';
export const ADAPTIVE_TRANSFER_COHORT_PRIVATE_EVIDENCE_POLICY =
  'source-qualified-v2';
export const ADAPTIVE_TRANSFER_COHORT_SHAM_INSTRUCTION =
  'Deterministic placebo control. Return the baseline with exactly one additional blank line immediately after every level-2 Markdown heading (`## ...`). Do not change, add, remove, reorder, or reformat any non-whitespace character. Do not number or rename headings, create lists, add Markdown delimiters, or change punctuation. Preserve every decision rule, code, and behavior.';
export const ADAPTIVE_TRANSFER_COHORT_PROPOSAL_INSTRUCTION =
  'Revise the locked baseline only according to the assigned treatment: the hypothesis plus any assigned mechanism. If the assigned mechanism explicitly requires a nonbehavioral control, follow that control without implementing the behavioral hypothesis; the hypothesis ID remains required only for binding. Do not evaluate cases in this proposal phase.';
export const ADAPTIVE_TRANSFER_COHORT_EVALUATION_NORMALIZATION =
  'development-identifiers-v1';
export const ADAPTIVE_TRANSFER_COHORT = Object.freeze({
  profile: ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION,
  taskCount: 5,
  arms: Object.freeze(['baseline', 'routed', 'sham']),
  proposalsPerTask: 3,
  evaluationsPerTask: 3,
  proposalCalls: 15,
  evaluationCalls: 15,
  totalCalls: 30,
  maxConcurrency: 2,
  retriesPerDispatch: 0,
  perCallTimeoutMs: 10 * 60 * 1000,
  waveCount: 16,
  timeoutCeilingMs: 160 * 60 * 1000,
  hardTokenLimit: null,
  hardUsdLimit: null,
  promotionEnabled: false,
  requiredRoutedWins: 5,
  allowedShamWins: 0,
  allowedControlRegressions: 0,
  exactSignTestP: 0.03125
});

export const ADAPTIVE_TRANSFER_COHORT_IMPLEMENTATION_PATHS = Object.freeze([
  'package.json',
  'loops/loop-de-loop.md',
  'scripts/plan-adaptive-transfer-cohort.mjs',
  'scripts/run-adaptive-transfer-cohort.mjs',
  'scripts/run-cohort-worker.mjs',
  'scripts/verify-adaptive-transfer-cohort.mjs',
  'src/adaptive-meta-canary.mjs',
  'src/adaptive-policy.mjs',
  'src/adaptive-records.mjs',
  'src/adaptive-transfer-cohort.mjs',
  'src/baseline-integrity.mjs',
  'src/canary-runner.mjs',
  'src/codex-oauth-authority.mjs',
  'src/cohort-executor.mjs',
  'src/constants.mjs',
  'src/executor.mjs',
  'src/host.mjs',
  'src/loops.mjs',
  'src/measure.mjs',
  'src/mechanism-router.mjs',
  'src/meta-policy.mjs',
  'src/models.mjs',
  'src/real-test.mjs',
  'src/run-verifier.mjs',
  'src/schemas/adaptive-transfer-cohort-v1.schema.json',
  'src/schemas/evaluation-output.schema.json',
  'src/schemas/proposal-output.schema.json',
  'src/skill-schema.mjs',
  'src/store.mjs',
  'src/supervisor.mjs',
  'src/util.mjs'
]);

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA256_RE = /^[a-f0-9]{64}$/;
const FINDING_ID_RE = /^finding-[0-9]{3}$/;
const PROPOSAL_TASK =
  'Diagnose only this task\'s proposal-visible development evidence and produce one complete procedure revision. Held-out evaluation evidence is unavailable. Use an assigned mechanism only when present. Do not evaluate or score the procedure.';
const EVALUATION_TASK =
  'Apply the active procedure exactly as written to every evaluator-only case for this task. Return observations only; do not infer hidden groups, compare arms, revise the procedure, or report a score.';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeArtifact(store, runId, artifactId) {
  if (!artifactId) return null;
  try {
    return store.readArtifact(runId, artifactId);
  } catch {
    return null;
  }
}

function artifactHashMatches(artifact) {
  return !!(artifact
    && typeof artifact.content === 'string'
    && SHA256_RE.test(String(artifact.sha256 || ''))
    && sha256(artifact.content) === artifact.sha256);
}

function resolveLocator(content, locator) {
  const source = String(content || '');
  const needle = String(locator || '');
  if (!needle) return false;
  return source.includes(needle);
}

function normalizedManifest(config, field) {
  return (Array.isArray(config[field]) ? config[field] : []).map((item) => ({
    path: item.path,
    bytes: item.bytes,
    sha256: item.sha256
  }));
}

function validateEvidence(config, errors, {
  sourcesField,
  manifestField,
  capsuleField,
  label
}) {
  const sources = Array.isArray(config[sourcesField]) ? config[sourcesField] : [];
  const manifest = Array.isArray(config[manifestField]) ? config[manifestField] : [];
  const capsule = Array.isArray(config[capsuleField]) ? config[capsuleField] : [];
  const map = new Map();
  if (!sources.length || new Set(sources).size !== sources.length) {
    errors.push(`${label} sources must contain unique repository-relative paths`);
  }
  if (manifest.length !== sources.length || capsule.length !== sources.length) {
    errors.push(`${label} manifest and capsule must cover every source exactly once`);
  }
  for (const path of sources) {
    const value = String(path || '');
    if (!value || isAbsoluteOnAnyPlatform(value) || value.includes('\0')
        || value.split(/[\\/]/).includes('..')) {
      errors.push(`${label} path must stay repository-relative: ${value || '<missing>'}`);
    }
  }
  for (const item of capsule) {
    const path = String(item?.path || '');
    const content = typeof item?.content === 'string' ? item.content : null;
    const digest = content == null ? null : sha256(Buffer.from(content));
    const bytes = content == null ? null : Buffer.byteLength(content);
    const matchingManifest = manifest.find((candidate) => candidate?.path === path);
    if (!sources.includes(path) || map.has(path) || content == null
        || digest !== item?.sha256 || bytes !== item?.bytes
        || !matchingManifest
        || matchingManifest.sha256 !== digest
        || matchingManifest.bytes !== bytes) {
      errors.push(`${label} capsule entry failed path, byte, or hash verification: ${path || '<missing>'}`);
      continue;
    }
    map.set(path, item);
  }
  if (map.size !== sources.length) {
    errors.push(`${label} capsule does not resolve every declared source`);
  }
  return map;
}

function validateRef(ref, capsuleByPath, allowedPaths = null) {
  const path = String(ref?.path || '');
  const locator = String(ref?.locator || '');
  const item = capsuleByPath.get(path);
  return !!(item
    && (!allowedPaths || allowedPaths.has(path))
    && locator
    && resolveLocator(item.content, locator));
}

function capsuleForPaths(capsule, paths) {
  const allowed = new Set(paths);
  return (Array.isArray(capsule) ? capsule : [])
    .filter((item) => allowed.has(item.path));
}

function workerVisibleCase(item = {}) {
  return {
    id: item.id || null,
    prompt: item.prompt || null,
    evidenceRef: item.evidenceRef
      ? {
          path: item.evidenceRef.path || null,
          locator: item.evidenceRef.locator || null
        }
      : null
  };
}

function uniqueCaseEvidenceRefs(cases = []) {
  const seen = new Set();
  const refs = [];
  for (const item of cases) {
    const ref = item?.evidenceRef;
    const key = `${ref?.path || ''}:${ref?.locator || ''}`;
    if (!ref?.path || !ref?.locator || seen.has(key)) continue;
    seen.add(key);
    refs.push({ path: ref.path, locator: ref.locator });
  }
  return refs;
}

export function normalizeAdaptiveTransferCohortEvaluationProcedure(
  task,
  procedureContent
) {
  const replacements = [
    ...(task?.developmentEvidencePaths || []).map((value) => ({
      value: String(value || ''),
      replacement: 'ASSIGNED_EVIDENCE_PATH'
    })),
    ...(task?.developmentCases || []).flatMap((item) => [
      {
        value: String(item?.evidenceRef?.locator || ''),
        replacement: 'ASSIGNED_EVIDENCE_LOCATOR'
      },
      {
        value: String(item?.id || ''),
        replacement: 'DEVELOPMENT_CASE_ID'
      }
    ])
  ]
    .filter((item) => item.value.length >= 8)
    .sort((left, right) => right.value.length - left.value.length);
  let normalized = String(procedureContent || '');
  for (const item of replacements) {
    normalized = normalized.replaceAll(item.value, item.replacement);
  }
  return normalized;
}

function taskRouting(task = {}) {
  return object(task.routing);
}

export function createDeterministicCohortShamCapsule(shamCapsule) {
  if (!shamCapsule || !Array.isArray(shamCapsule.items)
      || shamCapsule.items.length !== 1
      || shamCapsule.items[0]?.semantics !== 'irrelevant-control') {
    return null;
  }
  const payload = {
    schemaVersion: shamCapsule.schemaVersion,
    targetSha256: shamCapsule.targetSha256,
    policyEpochId: shamCapsule.policyEpochId,
    policyEpochSha256: shamCapsule.policyEpochSha256,
    candidatePoolSha256: shamCapsule.candidatePoolSha256,
    items: shamCapsule.items.map((item) => ({
      ...structuredClone(item),
      instruction: ADAPTIVE_TRANSFER_COHORT_SHAM_INSTRUCTION
    }))
  };
  return {
    ...payload,
    mechanismCapsuleSha256: sha256(canonicalAdaptiveJson(payload))
  };
}

function proposalMechanism(task, armRole) {
  if (armRole === 'routed') return taskRouting(task).routedCapsule;
  if (armRole === 'sham') {
    return createDeterministicCohortShamCapsule(taskRouting(task).shamCapsule);
  }
  return null;
}

function blindLabel(seed, taskId, armRole) {
  return `arm-${sha256(`${seed}:${taskId}:${armRole}`).slice(0, 16)}`;
}

function rotateArms(offset) {
  const arms = [...ADAPTIVE_TRANSFER_COHORT.arms];
  return arms.map((_, index) => arms[(index + offset) % arms.length]);
}

function chunkSlots(stage, slots) {
  const waves = [];
  for (let index = 0; index < slots.length; index += ADAPTIVE_TRANSFER_COHORT.maxConcurrency) {
    const waveIndex = waves.length;
    const members = slots.slice(index, index + ADAPTIVE_TRANSFER_COHORT.maxConcurrency)
      .map((slot, wavePosition) => ({
        ...slot,
        waveId: `${stage}-wave-${String(waveIndex + 1).padStart(2, '0')}`,
        waveIndex,
        wavePosition
      }));
    waves.push({
      id: members[0].waveId,
      stage,
      index: waveIndex,
      slots: members
    });
  }
  return waves;
}

export function buildAdaptiveTransferCohortSchedule(config = {}) {
  const tasks = Array.isArray(config.tasks) ? config.tasks : [];
  const seed = String(config.seed || '');
  const makeStage = (stage, evaluationOffset) => {
    const slots = [];
    for (let roundIndex = 0; roundIndex < ADAPTIVE_TRANSFER_COHORT.arms.length; roundIndex++) {
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        const task = tasks[taskIndex];
        const rotation = rotateArms((taskIndex + evaluationOffset) % 3);
        const armRole = rotation[roundIndex];
        slots.push({
          slotId: `${stage}-${task.id}-${armRole}`,
          stage,
          taskId: task.id,
          taskIndex,
          armRole,
          blindArm: blindLabel(seed, task.id, armRole),
          roundIndex,
          route: REAL_TEST_MODEL,
          plannedIndex: slots.length
        });
      }
    }
    return chunkSlots(stage, slots);
  };
  const proposalWaves = makeStage('proposal', 0);
  const evaluationWaves = makeStage('evaluation', 1);
  return {
    proposalWaves,
    evaluationWaves,
    waves: [
      ...proposalWaves.map((wave, index) => ({ ...wave, globalIndex: index })),
      ...evaluationWaves.map((wave, index) => ({
        ...wave,
        globalIndex: proposalWaves.length + index
      }))
    ]
  };
}

function implementationManifest(config) {
  return normalizedManifest(config, 'implementationManifest');
}

export function resolveAdaptiveTransferCohortImplementation(packageRoot = PACKAGE_ROOT) {
  const root = resolve(packageRoot);
  const manifest = [];
  const capsule = [];
  for (const path of ADAPTIVE_TRANSFER_COHORT_IMPLEMENTATION_PATHS) {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`implementation path escaped package root: ${path}`);
    }
    const content = readFileSync(absolute, 'utf8');
    const record = {
      path,
      bytes: Buffer.byteLength(content),
      sha256: sha256(Buffer.from(content))
    };
    manifest.push(record);
    capsule.push({ ...record, content });
  }
  return { manifest, capsule };
}

function inspectImplementation(config, errors) {
  const manifest = Array.isArray(config.implementationManifest)
    ? config.implementationManifest
    : [];
  const capsule = Array.isArray(config.implementationCapsule)
    ? config.implementationCapsule
    : [];
  const expectedPaths = [...ADAPTIVE_TRANSFER_COHORT_IMPLEMENTATION_PATHS].sort();
  const actualPaths = manifest.map((item) => item?.path).sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)
      || capsule.length !== expectedPaths.length) {
    errors.push('implementation manifest must bind the exact cohort dependency set');
  }
  const map = new Map();
  for (const item of capsule) {
    const content = typeof item?.content === 'string' ? item.content : null;
    const digest = content == null ? null : sha256(Buffer.from(content));
    const bytes = content == null ? null : Buffer.byteLength(content);
    const manifestItem = manifest.find((candidate) => candidate?.path === item?.path);
    if (!expectedPaths.includes(item?.path) || map.has(item?.path)
        || digest !== item?.sha256 || bytes !== item?.bytes
        || !manifestItem
        || manifestItem.sha256 !== digest
        || manifestItem.bytes !== bytes) {
      errors.push(`implementation capsule failed verification: ${item?.path || '<missing>'}`);
      continue;
    }
    map.set(item.path, item);
  }
  return { ok: map.size === expectedPaths.length, manifest, capsule, map };
}

function taskPlanIdentity(task) {
  const routing = taskRouting(task);
  return {
    id: task.id,
    findingId: task.target?.findingId,
    baselineSha256: sha256(String(task.target?.baselineContent || '')),
    proposalBriefSha256: sha256(canonicalJson(task.target?.proposalBrief || {})),
    hypothesisSha256: sha256(canonicalJson(task.target?.hypothesis || {})),
    developmentEvidencePaths: [...(task.developmentEvidencePaths || [])],
    heldOutEvidencePaths: [...(task.heldOutEvidencePaths || [])],
    developmentCasesSha256: sha256(canonicalJson(task.developmentCases || [])),
    heldOutCasesSha256: sha256(canonicalJson(task.heldOutCases || [])),
    oracleSha256: sha256(canonicalJson(task.oracle || {})),
    routingDecisionSha256: routing.routingDecision?.routingDecisionSha256 || null,
    candidatePoolSha256: routing.candidatePool?.sha256
      || routing.routingDecision?.candidatePoolSha256
      || null,
    routedCapsuleSha256: routing.routedCapsule?.mechanismCapsuleSha256 || null,
    shamCapsuleSha256: routing.shamCapsule?.mechanismCapsuleSha256 || null,
    executionShamCapsuleSha256:
      proposalMechanism(task, 'sham')?.mechanismCapsuleSha256 || null,
    primaryFamilyId: routing.primaryFamilyId || null
  };
}

export function buildAdaptiveTransferCohortPlan(config = {}) {
  const schedule = buildAdaptiveTransferCohortSchedule(config);
  const tasks = (Array.isArray(config.tasks) ? config.tasks : []).map(taskPlanIdentity);
  const runtimeAuthority = object(config.runtimeAuthority);
  const basis = {
    profile: ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION,
    privateEvidencePolicy: config.privateEvidencePolicy,
    model: REAL_TEST_MODEL,
    fixtureOnly: config.fixtureOnly === true,
    seed: config.seed,
    maxConcurrency: ADAPTIVE_TRANSFER_COHORT.maxConcurrency,
    tasks,
    evidenceManifests: {
      development: normalizedManifest(config, 'developmentEvidenceManifest'),
      heldOut: normalizedManifest(config, 'heldOutEvidenceManifest'),
      privateMechanism: normalizedManifest(config, 'mechanismEvidenceManifest')
    },
    mechanismContext: {
      familyHashes: (config.mechanismContext?.families || [])
        .map((item) => item.familySha256),
      applicationHashes: (config.mechanismContext?.applications || [])
        .map((item) => item.applicationSha256),
      policyEpochSha256: config.mechanismContext?.policyEpoch?.policyEpochSha256 || null
    },
    implementationManifest: implementationManifest(config),
    runtimeAuthority: {
      authoritySha256: runtimeAuthority.authoritySha256 || null,
      requestedModel: runtimeAuthority.requestedModel || null,
      reasoningEffort: runtimeAuthority.reasoningEffort || null,
      authMode: runtimeAuthority.authMode || null,
      selectionAuthority: runtimeAuthority.selectionAuthority || null,
      executableSha256: runtimeAuthority.binary?.sha256 || null,
      catalogSha256: runtimeAuthority.catalog?.sha256 || null
    },
    contract: {
      taskCount: ADAPTIVE_TRANSFER_COHORT.taskCount,
      arms: [...ADAPTIVE_TRANSFER_COHORT.arms],
      proposalCalls: ADAPTIVE_TRANSFER_COHORT.proposalCalls,
      evaluationCalls: ADAPTIVE_TRANSFER_COHORT.evaluationCalls,
      totalCalls: ADAPTIVE_TRANSFER_COHORT.totalCalls,
      maxConcurrency: ADAPTIVE_TRANSFER_COHORT.maxConcurrency,
      retriesPerDispatch: ADAPTIVE_TRANSFER_COHORT.retriesPerDispatch,
      perCallTimeoutMs: ADAPTIVE_TRANSFER_COHORT.perCallTimeoutMs,
      waveCount: ADAPTIVE_TRANSFER_COHORT.waveCount,
      timeoutCeilingMs: ADAPTIVE_TRANSFER_COHORT.timeoutCeilingMs,
      promotionEnabled: false,
      requiredRoutedWins: ADAPTIVE_TRANSFER_COHORT.requiredRoutedWins,
      allowedShamWins: ADAPTIVE_TRANSFER_COHORT.allowedShamWins,
      allowedControlRegressions: ADAPTIVE_TRANSFER_COHORT.allowedControlRegressions,
      exactSignTestP: ADAPTIVE_TRANSFER_COHORT.exactSignTestP,
      proposalValidationMode: PRESENTATION_ONLY_SHAM_VALIDATION,
      proposalTreatmentInstructionSha256: sha256(
        ADAPTIVE_TRANSFER_COHORT_PROPOSAL_INSTRUCTION
      ),
      shamInstructionSha256: sha256(
        ADAPTIVE_TRANSFER_COHORT_SHAM_INSTRUCTION
      ),
      evaluationProcedureNormalization:
        ADAPTIVE_TRANSFER_COHORT_EVALUATION_NORMALIZATION,
      waves: schedule.waves
    }
  };
  return {
    ...basis,
    sha256: sha256(stableJson(basis))
  };
}

function validateMechanismContext(config, errors) {
  const context = object(config.mechanismContext);
  const families = Array.isArray(context.families) ? context.families : [];
  const applications = Array.isArray(context.applications) ? context.applications : [];
  const policyEpoch = context.policyEpoch;
  if (!families.length || !applications.length || !policyEpoch) {
    errors.push('mechanismContext requires families, applications, and one policy epoch');
    return;
  }
  for (const record of [...families, ...applications, policyEpoch]) {
    const validated = validateAdaptiveRecord(record);
    if (validated.status !== 'OK') {
      errors.push(`mechanismContext contains an invalid ${record?.schemaVersion || 'record'}`);
    }
  }
  const primaryFamilies = new Set();
  for (const task of config.tasks || []) {
    const routing = taskRouting(task);
    const rebuilt = buildMechanismRoutingDecision({
      families,
      applications,
      target: routing.target,
      policyEpoch,
      seed: routing.seed,
      hypothesisCount: routing.hypothesisCount,
      mode: 'active-canary'
    });
    if (rebuilt.status !== 'OK') {
      errors.push(`task ${task.id} routing decision does not rebuild`);
      continue;
    }
    if (canonicalAdaptiveJson(rebuilt.decision)
        !== canonicalAdaptiveJson(routing.routingDecision)
        || canonicalJson(rebuilt.candidatePool)
          !== canonicalJson(routing.candidatePool)
        || canonicalJson(rebuilt.capsule)
          !== canonicalJson(routing.routedCapsule)) {
      errors.push(`task ${task.id} routing records do not match deterministic replay`);
    }
    const expectedSham = createIrrelevantShamCapsule(rebuilt.capsule);
    if (canonicalJson(expectedSham) !== canonicalJson(routing.shamCapsule)
        || capsuleSchemaSha256(rebuilt.capsule)
          !== capsuleSchemaSha256(routing.shamCapsule)) {
      errors.push(`task ${task.id} sham is not a schema-identical irrelevant control`);
    }
    if (routing.routingDecision?.mode !== 'active-canary'
        || routing.routingDecision?.affectedExecution !== true
        || rebuilt.capsule?.items?.length !== 1
        || rebuilt.capsule.items[0]?.familyId !== routing.primaryFamilyId) {
      errors.push(`task ${task.id} must bind one active primary mechanism family`);
    }
    primaryFamilies.add(routing.primaryFamilyId);
  }
  if (primaryFamilies.size !== 1 || primaryFamilies.has(undefined)) {
    errors.push('all cohort tasks must test the same primary mechanism family');
  }
}

function validateTask(task, config, errors, {
  developmentCapsuleByPath,
  heldOutCapsuleByPath
}) {
  const label = `task ${task?.id || '<missing>'}`;
  const target = object(task?.target);
  const brief = object(target.proposalBrief);
  const hypothesis = object(target.hypothesis);
  const developmentPaths = new Set(task?.developmentEvidencePaths || []);
  const heldOutPaths = new Set(task?.heldOutEvidencePaths || []);
  const developmentCases = Array.isArray(task?.developmentCases)
    ? task.developmentCases
    : [];
  const heldOutCases = Array.isArray(task?.heldOutCases) ? task.heldOutCases : [];
  const oracle = task?.oracle;

  if (!isSafeId(task?.id) || String(task.id).length < 8) {
    errors.push(`${label} requires a safe substantive id`);
  }
  if (!FINDING_ID_RE.test(String(target.findingId || ''))
      || typeof target.baselineContent !== 'string'
      || target.baselineContent.trim().length < 120) {
    errors.push(`${label} requires a finding-NNN id and substantive baselineContent`);
  }
  if (typeof brief.title !== 'string' || brief.title.trim().length < 8
      || typeof brief.problem !== 'string' || brief.problem.trim().length < 24
      || !Array.isArray(brief.invariants)
      || brief.invariants.length < 2
      || brief.invariants.length > 10
      || brief.invariants.some((item) => (
        typeof item !== 'string' || item.trim().length < 8
      ))) {
    errors.push(`${label} requires a non-prescriptive proposal brief and 2-10 invariants`);
  }
  for (const field of ['title', 'bottleneck', 'operation', 'expectedMovement', 'falsifier']) {
    if (typeof hypothesis[field] !== 'string' || hypothesis[field].trim().length < 12) {
      errors.push(`${label} hypothesis.${field} must be substantive`);
    }
  }
  if (!developmentPaths.size || !heldOutPaths.size) {
    errors.push(`${label} requires development and held-out evidence paths`);
  }
  if ([...developmentPaths].some((path) => (
    heldOutPaths.has(path) || !developmentCapsuleByPath.has(path)
  )) || [...heldOutPaths].some((path) => !heldOutCapsuleByPath.has(path))) {
    errors.push(`${label} evidence path assignments are missing or overlap`);
  }
  if (developmentCases.length < 2 || developmentCases.length > 10
      || heldOutCases.length < 3 || heldOutCases.length > 10) {
    errors.push(`${label} requires 2-10 development cases and 3-10 held-out cases`);
  }
  const devIds = developmentCases.map((item) => String(item?.id || ''));
  const hiddenIds = heldOutCases.map((item) => String(item?.id || ''));
  if (new Set(devIds).size !== devIds.length
      || new Set(hiddenIds).size !== hiddenIds.length
      || devIds.some((id) => hiddenIds.includes(id))) {
    errors.push(`${label} development and held-out case identities must be distinct`);
  }
  if (developmentCases.some((item) => (
    typeof item?.prompt !== 'string'
    || item.prompt.trim().length < 16
    || !validateRef(item.evidenceRef, developmentCapsuleByPath, developmentPaths)
  ))) {
    errors.push(`${label} development cases must resolve inside assigned development evidence`);
  }
  if (heldOutCases.some((item) => (
    typeof item?.prompt !== 'string'
    || item.prompt.trim().length < 16
    || !validateRef(item.evidenceRef, heldOutCapsuleByPath, heldOutPaths)
  ))) {
    errors.push(`${label} held-out cases must resolve inside assigned held-out evidence`);
  }
  const targetOracleIds = new Set((oracle?.cases || [])
    .filter((item) => item.group === 'target')
    .map((item) => String(item.caseId)));
  const targetCases = heldOutCases.filter((item) => targetOracleIds.has(String(item?.id || '')));
  if (!targetCases.length || targetCases.some((item) => (
    !validateRef(item.baselineFailureRef, heldOutCapsuleByPath, heldOutPaths)
  ))) {
    errors.push(`${label} target cases require mechanically grounded baseline failures`);
  }
  if (oracle?.kind !== CASE_RESULTS_ORACLE_KIND_V2 || !isCaseResultsOracle(oracle)) {
    errors.push(`${label} oracle must be a valid ${CASE_RESULTS_ORACLE_KIND_V2} oracle`);
  } else {
    const gameability = evaluateCaseResultsGameability(oracle);
    const oracleIds = oracle.cases.map((item) => String(item.caseId)).sort();
    if (!gameability.ok
        || canonicalJson(oracleIds) !== canonicalJson([...hiddenIds].sort())
        || !oracle.cases.some((item) => item.group === 'target')
        || !oracle.cases.some((item) => item.group === 'control')) {
      errors.push(`${label} oracle must be non-gameable and cover every target/control case`);
    }
  }
  const targetRefs = Array.isArray(target.evidenceRefs) ? target.evidenceRefs : [];
  if (!targetRefs.length || targetRefs.some((ref) => (
    !validateRef(ref, developmentCapsuleByPath, developmentPaths)
  ))) {
    errors.push(`${label} target evidenceRefs must resolve inside assigned development evidence`);
  }

  const hiddenNeedles = [
    ...heldOutPaths,
    ...heldOutCases.flatMap((item) => [
      String(item?.id || ''),
      String(item?.prompt || ''),
      String(item?.evidenceRef?.locator || ''),
      String(item?.baselineFailureRef?.locator || '')
    ])
  ].filter((needle) => needle.length >= 8);
  const proposalVisible = canonicalJson({
    baselineContent: target.baselineContent,
    proposalBrief: brief,
    developmentCases: developmentCases.map(workerVisibleCase),
    evidenceRefs: targetRefs,
    evidenceCapsule: capsuleForPaths(config.developmentEvidenceCapsule, [...developmentPaths])
  });
  if (hiddenNeedles.some((needle) => proposalVisible.includes(needle))) {
    errors.push(`${label} held-out identity or evidence leaked into proposal-visible inputs`);
  }
}

function validateGlobalPartitions(config, errors, {
  developmentCapsuleByPath,
  heldOutCapsuleByPath,
  mechanismCapsuleByPath
}) {
  const taskPaths = {
    development: [],
    heldOut: []
  };
  for (const task of config.tasks || []) {
    taskPaths.development.push(...(task.developmentEvidencePaths || []));
    taskPaths.heldOut.push(...(task.heldOutEvidencePaths || []));
  }
  if (new Set(taskPaths.development).size !== taskPaths.development.length
      || new Set(taskPaths.heldOut).size !== taskPaths.heldOut.length
      || taskPaths.development.length !== developmentCapsuleByPath.size
      || taskPaths.heldOut.length !== heldOutCapsuleByPath.size) {
    errors.push('every development and held-out source must belong to exactly one task');
  }
  const allPaths = [
    ...developmentCapsuleByPath.keys(),
    ...heldOutCapsuleByPath.keys(),
    ...mechanismCapsuleByPath.keys()
  ];
  if (new Set(allPaths).size !== allPaths.length) {
    errors.push('development, held-out, and private mechanism paths must be disjoint');
  }
  const contentHashes = allPaths.map((path) => {
    const item = developmentCapsuleByPath.get(path)
      || heldOutCapsuleByPath.get(path)
      || mechanismCapsuleByPath.get(path);
    return sha256(Buffer.from(item.content));
  });
  if (new Set(contentHashes).size !== contentHashes.length) {
    errors.push('development, held-out, and private mechanism source bytes must be distinct');
  }

  const tasks = config.tasks || [];
  for (const task of tasks) {
    const visible = [
      String(task?.id || ''),
      stableJson(task?.target || {}),
      ...(task?.developmentEvidencePaths || []).map(String),
      ...(task?.heldOutEvidencePaths || []).map(String),
      stableJson(task?.developmentCases || []),
      stableJson(task?.heldOutCases || []),
      ...capsuleForPaths(
        config.developmentEvidenceCapsule,
        task?.developmentEvidencePaths || []
      ).flatMap((item) => [
        String(item?.path || ''),
        String(item?.content || '')
      ]),
      ...capsuleForPaths(
        config.heldOutEvidenceCapsule,
        task?.heldOutEvidencePaths || []
      ).flatMap((item) => [
        String(item?.path || ''),
        String(item?.content || '')
      ])
    ].join('\n');
    const foreignNeedles = tasks
      .filter((candidate) => candidate !== task)
      .flatMap((candidate) => [
        String(candidate?.id || ''),
        ...(candidate?.developmentEvidencePaths || []).map(String),
        ...(candidate?.heldOutEvidencePaths || []).map(String),
        ...(candidate?.developmentCases || []).flatMap((item) => [
          String(item?.id || ''),
          String(item?.prompt || ''),
          String(item?.evidenceRef?.locator || '')
        ]),
        ...(candidate?.heldOutCases || []).flatMap((item) => [
          String(item?.id || ''),
          String(item?.prompt || ''),
          String(item?.evidenceRef?.locator || ''),
          String(item?.baselineFailureRef?.locator || '')
        ])
      ])
      .filter((needle) => needle.length >= 8);
    if (foreignNeedles.some((needle) => visible.includes(needle))) {
      errors.push(`task ${task.id} contains another task's hidden or visible identity`);
    }
  }

  const workerVisible = [
    ...(config.tasks || []).flatMap((task) => [
      String(task?.id || ''),
      String(task?.target?.baselineContent || ''),
      String(task?.target?.proposalBrief?.title || ''),
      String(task?.target?.proposalBrief?.problem || ''),
      ...(task?.target?.proposalBrief?.invariants || []).map(String),
      ...(task?.target?.evidenceRefs || []).flatMap((ref) => [
        String(ref?.path || ''),
        String(ref?.locator || '')
      ]),
      ...(task?.developmentEvidencePaths || []).map(String),
      ...(task?.heldOutEvidencePaths || []).map(String),
      ...(task?.developmentCases || []).flatMap((item) => [
        String(item?.id || ''),
        String(item?.prompt || ''),
        String(item?.evidenceRef?.path || ''),
        String(item?.evidenceRef?.locator || '')
      ]),
      ...(task?.heldOutCases || []).flatMap((item) => [
        String(item?.id || ''),
        String(item?.prompt || ''),
        String(item?.evidenceRef?.path || ''),
        String(item?.evidenceRef?.locator || ''),
        String(item?.baselineFailureRef?.path || ''),
        String(item?.baselineFailureRef?.locator || '')
      ])
    ]),
    ...(config.developmentEvidenceCapsule || []).flatMap((item) => [
      String(item?.path || ''),
      String(item?.content || '')
    ]),
    ...(config.heldOutEvidenceCapsule || []).flatMap((item) => [
      String(item?.path || ''),
      String(item?.content || '')
    ])
  ].join('\n');
  const privateNeedles = [
    ...mechanismCapsuleByPath.values()
  ].flatMap((item) => [
    String(item.path || ''),
    String(item.content || '')
  ]).concat(
    (config.mechanismEvidenceRefs || []).map((item) => String(item?.locator || ''))
  ).filter((needle) => needle.length >= 8);
  if (privateNeedles.some((needle) => workerVisible.includes(needle))) {
    errors.push('private mechanism evidence leaked into worker-visible partitions');
  }
}

export function validateAdaptiveTransferCohortConfig(config = {}, {
  requireApproval = true
} = {}) {
  const errors = [];
  const tasks = Array.isArray(config.tasks) ? config.tasks : [];
  if (config.schemaVersion !== ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION}`);
  }
  if (config.privateEvidencePolicy
      !== ADAPTIVE_TRANSFER_COHORT_PRIVATE_EVIDENCE_POLICY) {
    errors.push(
      `privateEvidencePolicy must be ${ADAPTIVE_TRANSFER_COHORT_PRIVATE_EVIDENCE_POLICY}`
    );
  }
  if (config.model !== REAL_TEST_MODEL) {
    errors.push(`model must be ${REAL_TEST_MODEL}`);
  }
  if (config.maxConcurrency !== ADAPTIVE_TRANSFER_COHORT.maxConcurrency) {
    errors.push(`maxConcurrency must be ${ADAPTIVE_TRANSFER_COHORT.maxConcurrency}`);
  }
  if (typeof config.fixtureOnly !== 'boolean') {
    errors.push('fixtureOnly must explicitly state whether evidence is real');
  }
  if (typeof config.seed !== 'string' || config.seed.trim().length < 8) {
    errors.push('seed must be a substantive frozen string');
  }
  if (config.historicalTokenEstimate != null
      && (!Number.isInteger(config.historicalTokenEstimate)
        || config.historicalTokenEstimate <= 0)) {
    errors.push('historicalTokenEstimate must be a positive non-binding integer');
  }
  if (tasks.length !== ADAPTIVE_TRANSFER_COHORT.taskCount
      || new Set(tasks.map((task) => task?.id)).size !== tasks.length
      || new Set(tasks.map((task) => task?.target?.findingId)).size !== tasks.length) {
    errors.push('cohort requires exactly five unique tasks and finding IDs');
  }

  const developmentCapsuleByPath = validateEvidence(config, errors, {
    sourcesField: 'developmentEvidenceSources',
    manifestField: 'developmentEvidenceManifest',
    capsuleField: 'developmentEvidenceCapsule',
    label: 'development evidence'
  });
  const heldOutCapsuleByPath = validateEvidence(config, errors, {
    sourcesField: 'heldOutEvidenceSources',
    manifestField: 'heldOutEvidenceManifest',
    capsuleField: 'heldOutEvidenceCapsule',
    label: 'held-out evidence'
  });
  const mechanismCapsuleByPath = validateEvidence(config, errors, {
    sourcesField: 'mechanismEvidenceSources',
    manifestField: 'mechanismEvidenceManifest',
    capsuleField: 'mechanismEvidenceCapsule',
    label: 'private mechanism evidence'
  });
  const mechanismRefs = Array.isArray(config.mechanismEvidenceRefs)
    ? config.mechanismEvidenceRefs
    : [];
  if (!mechanismRefs.length || mechanismRefs.some((ref) => (
    !validateRef(ref, mechanismCapsuleByPath)
  ))) {
    errors.push('every mechanismEvidenceRef must resolve inside private mechanism evidence');
  }
  validateGlobalPartitions(config, errors, {
    developmentCapsuleByPath,
    heldOutCapsuleByPath,
    mechanismCapsuleByPath
  });
  for (const task of tasks) {
    validateTask(task, config, errors, {
      developmentCapsuleByPath,
      heldOutCapsuleByPath
    });
  }
  validateMechanismContext(config, errors);
  const implementation = inspectImplementation(config, errors);
  const runtimeAuthority = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtimeAuthority.status !== 'OK'
      || runtimeAuthority.record.requestedModel !== REAL_TEST_MODEL
      || runtimeAuthority.record.reasoningEffort !== STRICT_CODEX_REASONING_EFFORT) {
    errors.push('runtimeAuthority must bind ChatGPT OAuth, exact gpt-5.6-sol, and high reasoning');
  }

  const plan = buildAdaptiveTransferCohortPlan(config);
  const schedule = plan.contract.waves || [];
  const slots = schedule.flatMap((wave) => wave.slots || []);
  if (schedule.length !== ADAPTIVE_TRANSFER_COHORT.waveCount
      || slots.length !== ADAPTIVE_TRANSFER_COHORT.totalCalls
      || schedule.some((wave) => (
        !wave.slots?.length
        || wave.slots.length > ADAPTIVE_TRANSFER_COHORT.maxConcurrency
      ))
      || new Set(slots.map((slot) => slot.slotId)).size !== slots.length) {
    errors.push('deterministic cohort wave schedule is malformed');
  }
  if (requireApproval
      && config.approvedPlanSha256 !== plan.sha256) {
    errors.push('transfer cohort plan is not operator-approved');
  }
  return {
    ok: errors.length === 0,
    errors,
    plan,
    implementation,
    runtimeAuthority: runtimeAuthority.status === 'OK'
      ? runtimeAuthority.record
      : null
  };
}

function taskTarget(task, planTask) {
  return {
    findingId: task.target.findingId,
    title: task.target.title || task.target.findingId,
    baselineArtifactId: `baseline-${task.id}`,
    baselineSha256: planTask.baselineSha256,
    baselineContent: task.target.baselineContent,
    evidenceRefs: task.target.evidenceRefs.map((item) => ({ ...item }))
  };
}

function taskHypothesis(task) {
  return {
    id: `${task.target.findingId}-cohort-h1`,
    ...task.target.hypothesis
  };
}

export function buildAdaptiveTransferCohortProposalContract(
  config,
  task,
  planTask,
  slot
) {
  const target = taskTarget(task, planTask);
  const brief = task.target.proposalBrief;
  return compilePhaseContract('loop-de-loop', 1, {
    kind: 'proposal',
    route: slot.route,
    task: PROPOSAL_TASK,
    requirements: [...brief.invariants],
    target: {
      ...target,
      title: brief.title,
      evidenceRefs: task.target.evidenceRefs
    },
    hypothesis: {
      id: taskHypothesis(task).id,
      title: brief.title,
      bottleneck: brief.problem
    },
    frozenCases: task.developmentCases.map(workerVisibleCase),
    evidenceCapsule: capsuleForPaths(
      config.developmentEvidenceCapsule,
      task.developmentEvidencePaths
    ),
    mechanismCapsule: proposalMechanism(task, slot.armRole),
    proposalValidationMode: PRESENTATION_ONLY_SHAM_VALIDATION,
    proposalTreatmentInstruction:
      ADAPTIVE_TRANSFER_COHORT_PROPOSAL_INSTRUCTION,
    toolPolicy: 'none'
  });
}

function buildEvaluationContract(config, task, planTask, slot, procedureContent) {
  const target = taskTarget(task, planTask);
  const normalizedProcedure =
    normalizeAdaptiveTransferCohortEvaluationProcedure(task, procedureContent);
  return compilePhaseContract('loop-de-loop', 1, {
    kind: 'evaluation',
    evaluationArm: slot.blindArm,
    route: slot.route,
    task: EVALUATION_TASK,
    target: {
      findingId: target.findingId,
      title: null,
      baselineArtifactId: target.baselineArtifactId,
      baselineSha256: target.baselineSha256,
      evidenceRefs: uniqueCaseEvidenceRefs(task.heldOutCases)
    },
    hypothesis: { id: taskHypothesis(task).id },
    frozenCases: task.heldOutCases.map(workerVisibleCase),
    evidenceCapsule: capsuleForPaths(
      config.heldOutEvidenceCapsule,
      task.heldOutEvidencePaths
    ),
    mechanismCapsule: null,
    procedureContent: normalizedProcedure,
    procedureSha256: sha256(normalizedProcedure),
    toolPolicy: 'none'
  });
}

function persistCallInputs(store, runId, slot, contract) {
  const contractContent = JSON.stringify(contract);
  const contractArtifact = writeCanaryArtifact(store, runId, `${slot.slotId}-contract`, {
    role: 'worker-contract',
    content: contractContent
  });
  const promptContent = buildExecutorPrompt({ ...contract, outputSchemaMode: true });
  const promptArtifact = writeCanaryArtifact(store, runId, `${slot.slotId}-prompt`, {
    role: 'worker-prompt',
    content: promptContent
  });
  const contractPath = `call-inputs/${slot.slotId}.contract.json`;
  store.writeRunFile(runId, contractPath, contractContent);
  return {
    contractArtifactRef: contractArtifact.id,
    contractSha256: contractArtifact.sha256,
    promptArtifactRef: promptArtifact.id,
    promptArtifactSha256: promptArtifact.sha256,
    contractPath,
    contractPathSha256: sha256(contractContent)
  };
}

function evidenceArtifact(store, runId, id, role, value) {
  const artifact = writeCanaryArtifact(store, runId, id, {
    role,
    content: stableJson(value)
  });
  return { id: artifact.id, sha256: artifact.sha256 };
}

function invocationMatchesRuntimeAuthority(config, invocation) {
  const validated = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (validated.status !== 'OK' || !invocation || typeof invocation !== 'object') {
    return false;
  }
  const authority = validated.record;
  const argv = Array.isArray(invocation.argv) ? invocation.argv.map(String) : [];
  const modelIndex = argv.indexOf('-m');
  const reported = invocation.reportedModel == null
    ? null
    : String(invocation.reportedModel).toLowerCase();
  return invocation.requestedModel === authority.requestedModel
    && invocation.binaryFamily === 'codex'
    && invocation.modelSelectionAuthority === 'explicit-model-flag'
    && invocation.executableBasename === authority.binary.basename
    && invocation.executableSha256 === authority.binary.sha256
    && invocation.executableBytes === authority.binary.bytes
    && invocation.authMode === 'chatgpt-oauth'
    && invocation.oauthAuthoritySha256 === authority.authoritySha256
    && modelIndex >= 0
    && argv[modelIndex + 1] === authority.requestedModel
    && Number(invocation.exitCode) === 0
    && (reported == null || reported === authority.requestedModel.toLowerCase())
    && invocation.reportedModelMatchesRequest !== false;
}

function packetEnvelope(store, runId, slot, contractSha256, packet, persistedAt) {
  const packetPath = `call-packets/${slot.slotId}.json`;
  const existing = store.readRunFile(runId, packetPath);
  if (existing != null) {
    try {
      const parsed = JSON.parse(existing);
      const valid = parsed?.schemaVersion === 'cohort-call-packet-v1'
        && parsed.slotId === slot.slotId
        && parsed.contractSha256 === contractSha256
        && stableJson(parsed.packet) === stableJson(packet);
      return valid
        ? {
            ok: true,
            packetPath,
            packetSha256: sha256(existing),
            envelope: parsed
          }
        : { ok: false, reason: 'persisted child packet envelope does not match returned packet' };
    } catch {
      return { ok: false, reason: 'persisted child packet envelope is malformed' };
    }
  }
  const envelope = {
    schemaVersion: 'cohort-call-packet-v1',
    slotId: slot.slotId,
    contractSha256,
    persistedAt,
    packet
  };
  const content = stableJson(envelope);
  store.writeRunFile(runId, packetPath, content);
  return {
    ok: true,
    packetPath,
    packetSha256: sha256(content),
    envelope
  };
}

function proposalContent(store, runId, record) {
  const artifact = safeArtifact(store, runId, record?.resultArtifactRef);
  const parsed = artifact ? parseCaseResults(artifact.content) : null;
  return parsed?.ok && parsed.wrapper === 'IMPROVEMENT'
    ? String(parsed.payload?.revisedContent || '')
    : '';
}

function renderCohortReport(state) {
  const verification = state.verification || {};
  const outcome = verification.outcome || {};
  const lines = [
    '# Loop Factory Adaptive Transfer Cohort',
    '',
    `- **run**: \`${state.runId}\``,
    `- **status**: ${state.status}`,
    `- **experiment valid**: ${verification.experimentValid === true}`,
    `- **activation eligible**: ${verification.activationEligible === true}`,
    `- **causal outcome**: ${outcome.status || 'UNKNOWN'}`,
    `- **model**: ${state.model}`,
    `- **plan sha256**: \`${state.plan?.sha256 || 'missing'}\``,
    `- **verification sha256**: \`${verification.evidenceSha256 || 'missing'}\``,
    `- **maximum concurrency**: ${state.plan?.contract?.maxConcurrency ?? 'unknown'}`,
    '- **promotion**: disabled',
    ...(state.blocker ? [`- **blocker**: \`${state.blocker.code}\` - ${state.blocker.message}`] : []),
    '',
    '## Gates',
    '',
    '| gate | result |',
    '|---|---|',
    ...Object.entries(verification.gates || {})
      .map(([name, passed]) => `| ${name} | ${passed ? 'PASS' : 'FAIL'} |`),
    '',
    '## Task Results',
    '',
    '| task | baseline target | routed target | sham target | routed win | sham win | control regression |',
    '|---|---:|---:|---:|---|---|---|',
    ...(outcome.tasks || []).map((item) => [
      `| ${item.taskId}`,
      item.baselineTargetQuality,
      item.routedTargetQuality,
      item.shamTargetQuality,
      item.routedWin ? 'yes' : 'no',
      item.shamWin ? 'yes' : 'no',
      item.controlRegression ? 'yes' : 'no',
      '|'
    ].join(' | ')),
    '',
    `- routed wins: ${outcome.routedWins ?? 'unmeasured'}/5`,
    `- sham wins: ${outcome.shamWins ?? 'unmeasured'}`,
    `- control regressions: ${outcome.controlRegressions ?? 'unmeasured'}`,
    `- exact one-sided sign-test p: ${outcome.exactSignTestP ?? 'unmeasured'}`,
    `- measured tokens: ${verification.tokenUsage?.total ?? 'unmeasured'}`,
    '',
    'This report proves only the frozen cohort. It does not promote a loop, alter the controller, or establish general recursive self-improvement.'
  ];
  return `${lines.join('\n')}\n`;
}

function binomialCoefficient(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= Math.min(k, n - k); index++) {
    result = (result * (n - index + 1)) / index;
  }
  return result;
}

function exactOneSidedSignTest(wins, trials) {
  if (!Number.isInteger(wins) || !Number.isInteger(trials) || trials <= 0) return null;
  let numerator = 0;
  for (let index = wins; index <= trials; index++) {
    numerator += binomialCoefficient(trials, index);
  }
  return round(numerator / (2 ** trials), 8);
}

function scoreOracleGroup(content, oracle, group) {
  const grouped = {
    ...oracle,
    cases: (oracle?.cases || []).filter((item) => item.group === group)
  };
  const expected = new Set(grouped.cases.map((item) => String(item.caseId)));
  const parsed = parseCaseResults(content, { allowProposalWrappers: false });
  if (!parsed.ok || grouped.cases.length === 0) return null;
  const rows = parsed.results.filter((item) => expected.has(String(item?.caseId || '')));
  return scoreCaseResults(
    `<CASE_RESULTS>${JSON.stringify(rows)}</CASE_RESULTS>`,
    grouped
  );
}

function evaluateCohortOutcome(config, evaluations) {
  const tasks = [];
  for (const task of config.tasks || []) {
    const rows = Object.fromEntries(ADAPTIVE_TRANSFER_COHORT.arms.map((armRole) => [
      armRole,
      evaluations.find((item) => item.taskId === task.id && item.armRole === armRole)
    ]));
    if (ADAPTIVE_TRANSFER_COHORT.arms.some((armRole) => !rows[armRole])) {
      return {
        status: 'INCOMPLETE',
        tasks: [],
        routedWins: null,
        shamWins: null,
        controlRegressions: null,
        exactSignTestP: null,
        promotionEnabled: false,
        reasons: ['Every task requires baseline, routed, and sham measurements.']
      };
    }
    tasks.push({
      taskId: task.id,
      baselineTargetQuality: rows.baseline.targetQuality,
      routedTargetQuality: rows.routed.targetQuality,
      shamTargetQuality: rows.sham.targetQuality,
      baselineControlQuality: rows.baseline.controlQuality,
      routedControlQuality: rows.routed.controlQuality,
      shamControlQuality: rows.sham.controlQuality,
      routedWin: rows.routed.targetQuality > rows.baseline.targetQuality,
      shamWin: rows.sham.targetQuality > rows.baseline.targetQuality,
      controlRegression: rows.routed.controlQuality < rows.baseline.controlQuality,
      baselineTokens: rows.baseline.tokenCost,
      routedTokens: rows.routed.tokenCost,
      shamTokens: rows.sham.tokenCost
    });
  }
  const routedWins = tasks.filter((item) => item.routedWin).length;
  const shamWins = tasks.filter((item) => item.shamWin).length;
  const controlRegressions = tasks.filter((item) => item.controlRegression).length;
  const passed = routedWins === ADAPTIVE_TRANSFER_COHORT.requiredRoutedWins
    && shamWins === ADAPTIVE_TRANSFER_COHORT.allowedShamWins
    && controlRegressions === ADAPTIVE_TRANSFER_COHORT.allowedControlRegressions;
  return {
    status: passed ? 'PASS' : 'FAIL',
    tasks,
    routedWins,
    shamWins,
    controlRegressions,
    exactSignTestP: exactOneSidedSignTest(
      routedWins,
      ADAPTIVE_TRANSFER_COHORT.taskCount
    ),
    promotionEnabled: false,
    reasons: [
      ...(routedWins !== ADAPTIVE_TRANSFER_COHORT.requiredRoutedWins
        ? ['Routed memory did not beat baseline on all five frozen tasks.']
        : []),
      ...(shamWins !== ADAPTIVE_TRANSFER_COHORT.allowedShamWins
        ? ['The irrelevant sham beat baseline on one or more tasks.']
        : []),
      ...(controlRegressions !== ADAPTIVE_TRANSFER_COHORT.allowedControlRegressions
        ? ['Routed memory regressed one or more task controls.']
        : [])
    ]
  };
}

export async function runAdaptiveTransferCohort(store, config, {
  runId,
  worker,
  clock = nowIso
} = {}) {
  if (!isSafeId(runId)) {
    return { status: 'BLOCKED', code: 'BAD_RUN_ID', message: 'a safe --run-id is required' };
  }
  if (store.exists(runId)) {
    return {
      status: 'BLOCKED',
      code: 'RUN_EXISTS',
      message: `run "${runId}" already exists; cohort runs are append-only`
    };
  }
  if (typeof worker !== 'function') {
    return { status: 'BLOCKED', code: 'NO_WORKER', message: 'cohort requires an asynchronous worker backend' };
  }
  const validation = validateAdaptiveTransferCohortConfig(config);
  if (!validation.ok) {
    return {
      status: 'BLOCKED',
      code: 'TRANSFER_COHORT_CONFIG',
      errors: validation.errors,
      plan: validation.plan
    };
  }
  const plan = validation.plan;
  const createdAt = clock();
  const state = {
    schemaVersion: 1,
    kind: 'adaptive-transfer-cohort',
    designVersion: ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION,
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'RUNNING',
    model: config.model,
    approvedPlanSha256: config.approvedPlanSha256,
    plan,
    evidenceArtifacts: {},
    proposals: [],
    evaluations: [],
    callLedger: plan.contract.waves.flatMap((wave) => (
      wave.slots.map((slot) => ({
        ...slot,
        globalWaveIndex: wave.globalIndex,
        status: 'PLANNED',
        attempt: null,
        launchedAt: null,
        settledAt: null,
        contractArtifactRef: null,
        contractSha256: null,
        promptArtifactRef: null,
        promptArtifactSha256: null,
        contractPath: null,
        contractPathSha256: null,
        packetPath: null,
        packetSha256: null,
        accepted: null,
        reasons: []
      }))
    )),
    waveLedger: plan.contract.waves.map((wave) => ({
      id: wave.id,
      stage: wave.stage,
      globalIndex: wave.globalIndex,
      slotIds: wave.slots.map((slot) => slot.slotId),
      status: 'PLANNED',
      launchedAt: null,
      settledAt: null
    })),
    verdictEvents: [],
    failureEvidence: [],
    promotion: { enabled: false, recorded: false },
    verification: null,
    outcome: null,
    blocker: null,
    reportPath: null
  };
  store.save(state);

  const proposalSchema = readFileSync(schemaPathForContract({ kind: 'proposal' }), 'utf8');
  const evaluationSchema = readFileSync(schemaPathForContract({ kind: 'evaluation' }), 'utf8');
  state.evidenceArtifacts = {
    config: evidenceArtifact(store, runId, 'sealed-transfer-cohort-config', 'config', config),
    developmentEvidenceCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-development-evidence-capsule',
      'development-evidence-capsule',
      config.developmentEvidenceCapsule
    ),
    heldOutEvidenceCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-held-out-evidence-capsule',
      'held-out-evidence-capsule',
      config.heldOutEvidenceCapsule
    ),
    mechanismEvidenceCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-private-mechanism-evidence',
      'mechanism-evidence-capsule',
      config.mechanismEvidenceCapsule
    ),
    implementationCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-transfer-cohort-implementation',
      'implementation-capsule',
      config.implementationCapsule
    ),
    runtimeAuthority: evidenceArtifact(
      store,
      runId,
      'sealed-codex-oauth-authority',
      'runtime-authority',
      config.runtimeAuthority
    ),
    families: config.mechanismContext.families.map((record, index) => (
      evidenceArtifact(store, runId, `cohort-mechanism-family-${index + 1}`, 'adaptive-record', record)
    )),
    applications: config.mechanismContext.applications.map((record, index) => (
      evidenceArtifact(store, runId, `cohort-mechanism-application-${index + 1}`, 'adaptive-record', record)
    )),
    policyEpoch: evidenceArtifact(
      store,
      runId,
      'cohort-meta-policy-epoch',
      'adaptive-record',
      config.mechanismContext.policyEpoch
    ),
    taskRouting: Object.fromEntries(config.tasks.map((task) => {
      const routing = taskRouting(task);
      return [task.id, {
        routingDecision: evidenceArtifact(
          store,
          runId,
          `${task.id}-routing-decision`,
          'adaptive-record',
          routing.routingDecision
        ),
        candidatePool: evidenceArtifact(
          store,
          runId,
          `${task.id}-candidate-pool`,
          'routing-candidate-pool',
          routing.candidatePool
        ),
        routedCapsule: evidenceArtifact(
          store,
          runId,
          `${task.id}-routed-capsule`,
          'mechanism-capsule',
          routing.routedCapsule
        ),
        shamCapsule: evidenceArtifact(
          store,
          runId,
          `${task.id}-sham-capsule`,
          'mechanism-capsule',
          proposalMechanism(task, 'sham')
        )
      }];
    }))
  };
  const proposalSchemaArtifact = writeCanaryArtifact(store, runId, 'cohort-proposal-output-schema', {
    role: 'output-schema',
    content: proposalSchema
  });
  const evaluationSchemaArtifact = writeCanaryArtifact(store, runId, 'cohort-evaluation-output-schema', {
    role: 'output-schema',
    content: evaluationSchema
  });
  state.evidenceArtifacts.proposalSchema = {
    id: proposalSchemaArtifact.id,
    sha256: proposalSchemaArtifact.sha256
  };
  state.evidenceArtifacts.evaluationSchema = {
    id: evaluationSchemaArtifact.id,
    sha256: evaluationSchemaArtifact.sha256
  };
  store.save(state);

  const finish = (status) => {
    state.status = status;
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
    state.verification = verifyAdaptiveTransferCohortRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-transfer-cohort-report.md',
      renderCohortReport(state)
    );
    store.save(state);
    return {
      status: 'OK',
      runId,
      reportPath: state.reportPath,
      statePath: `${store.runDir(runId)}/state.json`,
      experimentValid: state.verification.experimentValid,
      activationEligible: state.verification.activationEligible,
      outcome: state.verification.outcome,
      verification: state.verification
    };
  };

  const block = (code, message) => {
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
    state.verification = verifyAdaptiveTransferCohortRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-transfer-cohort-report.md',
      renderCohortReport(state)
    );
    store.save(state);
    return {
      status: 'BLOCKED',
      code,
      message,
      runId,
      reportPath: state.reportPath,
      statePath: `${store.runDir(runId)}/state.json`,
      verification: state.verification
    };
  };

  const procedures = new Map();
  const taskById = new Map(config.tasks.map((task) => [task.id, task]));
  const planTaskById = new Map(plan.tasks.map((task) => [task.id, task]));

  for (const wave of plan.contract.waves) {
    const waveRecord = state.waveLedger.find((item) => item.id === wave.id);
    const prepared = [];
    for (const slot of wave.slots) {
      const task = taskById.get(slot.taskId);
      const planTask = planTaskById.get(slot.taskId);
      const procedure = procedures.get(`${slot.taskId}:${slot.armRole}`);
      if (slot.stage === 'evaluation' && !procedure) {
        return block(
          'PROPOSAL_MISSING',
          `${slot.slotId} cannot evaluate a missing proposal`
        );
      }
      const contract = slot.stage === 'proposal'
        ? buildAdaptiveTransferCohortProposalContract(
            config,
            task,
            planTask,
            slot
          )
        : buildEvaluationContract(config, task, planTask, slot, procedure);
      const inputs = persistCallInputs(store, runId, slot, contract);
      const ledger = state.callLedger.find((item) => item.slotId === slot.slotId);
      Object.assign(ledger, inputs, {
        status: 'LAUNCHED',
        attempt: 0,
        launchedAt: clock()
      });
      prepared.push({
        slot,
        task,
        planTask,
        contract,
        inputs,
        ledger
      });
    }
    waveRecord.status = 'LAUNCHED';
    waveRecord.launchedAt = clock();
    state.updatedAt = waveRecord.launchedAt;
    store.save(state);

    const settled = await Promise.all(prepared.map(async (item) => {
      try {
        const packet = await worker(
          { ...item.contract, attempt: 0 },
          {
            runId,
            slotId: item.slot.slotId,
            packetPath: `call-packets/${item.slot.slotId}.json`,
            contractPath: item.inputs.contractPath,
            contractSha256: item.inputs.contractSha256
          }
        );
        return { ...item, packet, settledAt: clock(), error: null };
      } catch (error) {
        return {
          ...item,
          packet: {
            route: item.contract.route,
            phase: item.contract.phase,
            __execReason: 'COHORT_WORKER_ERROR',
            __error: error?.message || String(error),
            artifacts: [],
            finalOutput: ''
          },
          settledAt: clock(),
          error
        };
      }
    }));

    let waveFailed = false;
    const waveReasons = [];
    for (const item of settled) {
      const envelope = packetEnvelope(
        store,
        runId,
        item.slot,
        item.inputs.contractSha256,
        item.packet,
        item.settledAt
      );
      const verdict = validateWorkerPacket(item.contract, item.packet);
      const accepted = envelope.ok && verdict.accepted
        && invocationMatchesRuntimeAuthority(config, item.packet?.invocation);
      const reasons = [
        ...(!envelope.ok ? ['PACKET_ENVELOPE_INVALID'] : []),
        ...verdict.reasons,
        ...(verdict.accepted
          && !invocationMatchesRuntimeAuthority(config, item.packet?.invocation)
          ? ['MODEL_AUTHORITY_UNPROVEN']
          : [])
      ];
      Object.assign(item.ledger, {
        status: accepted ? 'ACCEPTED' : 'REJECTED',
        settledAt: item.settledAt,
        packetPath: envelope.packetPath || `call-packets/${item.slot.slotId}.json`,
        packetSha256: envelope.packetSha256 || null,
        accepted,
        reasons
      });
      state.verdictEvents.push({
        slotId: item.slot.slotId,
        stage: item.slot.stage,
        taskId: item.slot.taskId,
        armRole: item.slot.armRole,
        blindArm: item.slot.blindArm,
        waveId: item.slot.waveId,
        wavePosition: item.slot.wavePosition,
        attempt: 0,
        accepted,
        reasons,
        invocation: item.packet?.invocation || null
      });
      if (!accepted) {
        waveFailed = true;
        waveReasons.push(`${item.slot.slotId}: ${reasons.join(',') || 'rejected'}`);
        state.failureEvidence.push(persistRejectedDispatch(
          store,
          runId,
          item.packet,
          item.slot.route,
          {
            artifactPrefix: `${item.slot.slotId}-failed`,
            kind: item.slot.stage,
            reasons,
            attempt: 0,
            context: {
              slotId: item.slot.slotId,
              taskId: item.slot.taskId,
              armRole: item.slot.armRole,
              blindArm: item.slot.blindArm,
              waveId: item.slot.waveId,
              ...item.inputs
            }
          }
        ));
        continue;
      }

      if (item.slot.stage === 'proposal') {
        const persisted = persistCanaryProposal(
          store,
          runId,
          item.packet,
          item.slot.route,
          { artifactPrefix: item.slot.slotId }
        );
        if (!persisted.ok) {
          waveFailed = true;
          item.ledger.status = 'REJECTED';
          item.ledger.accepted = false;
          item.ledger.reasons = [persisted.reason];
          waveReasons.push(`${item.slot.slotId}: ${persisted.reason}`);
          state.failureEvidence.push(persistRejectedDispatch(
            store,
            runId,
            item.packet,
            item.slot.route,
            {
              artifactPrefix: `${item.slot.slotId}-receipt-failed`,
              kind: 'proposal',
              reasons: [persisted.reason],
              attempt: 0,
              context: {
                slotId: item.slot.slotId,
                taskId: item.slot.taskId,
                armRole: item.slot.armRole,
                blindArm: item.slot.blindArm,
                waveId: item.slot.waveId,
                ...item.inputs
              }
            }
          ));
          continue;
        }
        const routing = taskRouting(item.task);
        const record = {
          ...persisted.record,
          slotId: item.slot.slotId,
          taskId: item.slot.taskId,
          armRole: item.slot.armRole,
          blindArm: item.slot.blindArm,
          roundIndex: item.slot.roundIndex,
          waveId: item.slot.waveId,
          wavePosition: item.slot.wavePosition,
          mechanismCapsuleSha256: proposalMechanism(item.task, item.slot.armRole)
            ?.mechanismCapsuleSha256 || null,
          primaryFamilyId: item.slot.armRole === 'routed'
            ? routing.primaryFamilyId
            : null,
          routingDecisionId: item.slot.armRole === 'routed'
            ? routing.routingDecision.routingDecisionId
            : null,
          policyEpochId: item.slot.armRole === 'routed'
            ? config.mechanismContext.policyEpoch.policyEpochId
            : null,
          ...item.inputs,
          packetPath: item.ledger.packetPath,
          packetSha256: item.ledger.packetSha256
        };
        state.proposals.push(record);
        procedures.set(
          `${item.slot.taskId}:${item.slot.armRole}`,
          persisted.revisedContent
        );
      } else {
        const persisted = persistCanaryEvaluation(
          store,
          runId,
          item.packet,
          item.slot.route,
          {
            artifactPrefix: item.slot.slotId,
            oracle: item.task.oracle,
            armRole: item.slot.armRole,
            blindArm: item.slot.blindArm,
            replicate: item.slot.taskIndex,
            position: item.slot.wavePosition,
            procedureSha256: item.contract.procedureSha256
          }
        );
        if (!persisted.ok) {
          waveFailed = true;
          item.ledger.status = 'REJECTED';
          item.ledger.accepted = false;
          item.ledger.reasons = [persisted.reason];
          waveReasons.push(`${item.slot.slotId}: ${persisted.reason}`);
          state.failureEvidence.push(persistRejectedDispatch(
            store,
            runId,
            item.packet,
            item.slot.route,
            {
              artifactPrefix: `${item.slot.slotId}-receipt-failed`,
              kind: 'evaluation',
              reasons: [persisted.reason],
              attempt: 0,
              context: {
                slotId: item.slot.slotId,
                taskId: item.slot.taskId,
                armRole: item.slot.armRole,
                blindArm: item.slot.blindArm,
                waveId: item.slot.waveId,
                ...item.inputs
              }
            }
          ));
          continue;
        }
        state.evaluations.push({
          ...persisted.record,
          slotId: item.slot.slotId,
          taskId: item.slot.taskId,
          roundIndex: item.slot.roundIndex,
          waveId: item.slot.waveId,
          wavePosition: item.slot.wavePosition,
          oracleSha256: item.planTask.oracleSha256,
          heldOutEvidencePaths: [...item.task.heldOutEvidencePaths],
          ...item.inputs,
          packetPath: item.ledger.packetPath,
          packetSha256: item.ledger.packetSha256
        });
      }
    }
    waveRecord.status = waveFailed ? 'FAILED' : 'SETTLED';
    waveRecord.settledAt = clock();
    state.updatedAt = waveRecord.settledAt;
    store.save(state);
    if (waveFailed) {
      return block('COHORT_WAVE_INVALID', waveReasons.join('; '));
    }
  }
  return finish('QUEUE_DRAINED');
}

function verifyCallInputs(store, runId, record, expectedContract) {
  const contractArtifact = safeArtifact(store, runId, record.contractArtifactRef);
  const promptArtifact = safeArtifact(store, runId, record.promptArtifactRef);
  let parsedContract = null;
  try {
    parsedContract = contractArtifact ? JSON.parse(contractArtifact.content) : null;
  } catch {
    parsedContract = null;
  }
  const expectedPrompt = parsedContract
    ? buildExecutorPrompt({ ...parsedContract, outputSchemaMode: true })
    : null;
  const contractFile = record.contractPath
    ? store.readRunFile(runId, record.contractPath)
    : null;
  return {
    ok: artifactHashMatches(contractArtifact)
      && artifactHashMatches(promptArtifact)
      && contractArtifact.sha256 === record.contractSha256
      && promptArtifact.sha256 === record.promptArtifactSha256
      && record.promptSha256 === record.promptArtifactSha256
      && stableJson(parsedContract) === stableJson(expectedContract)
      && promptArtifact.content === expectedPrompt
      && contractFile === contractArtifact.content
      && sha256(String(contractFile || '')) === record.contractPathSha256,
    contract: parsedContract,
    promptArtifact
  };
}

function flattenEvidenceArtifactRefs(value) {
  if (Array.isArray(value)) return value.flatMap(flattenEvidenceArtifactRefs);
  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return [value.id];
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(flattenEvidenceArtifactRefs);
  }
  return [];
}

function packetEnvelopeMatches(store, runId, record) {
  const content = record.packetPath
    ? store.readRunFile(runId, record.packetPath)
    : null;
  if (!content || sha256(content) !== record.packetSha256) return false;
  try {
    const parsed = JSON.parse(content);
    return parsed?.schemaVersion === 'cohort-call-packet-v1'
      && parsed.slotId === record.slotId
      && parsed.contractSha256 === record.contractSha256
      && parsed.packet?.invocation?.stdoutSha256 === record.stdoutSha256
      && parsed.packet?.invocation?.resultSha256 === record.resultSha256;
  } catch {
    return false;
  }
}

function verificationFailure(runId, reason) {
  const base = {
    schemaVersion: 1,
    runId,
    status: 'FAIL',
    experimentValid: false,
    activationEligible: false,
    gates: {},
    outcome: {
      status: 'INCOMPLETE',
      tasks: [],
      routedWins: null,
      shamWins: null,
      controlRegressions: null,
      exactSignTestP: null,
      promotionEnabled: false,
      reasons: [reason]
    },
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function verifyAdaptiveTransferCohortRun(store, runId) {
  const state = store.load(runId);
  if (!state || state.kind !== 'adaptive-transfer-cohort') {
    return verificationFailure(runId, 'cohort state is missing or has the wrong kind');
  }
  const configArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.config?.id
  );
  let config = null;
  try {
    config = configArtifact ? JSON.parse(configArtifact.content) : null;
  } catch {
    config = null;
  }
  const configCheck = config
    ? validateAdaptiveTransferCohortConfig(config)
    : { ok: false, errors: ['sealed config is missing'], plan: null };
  const plan = configCheck.plan;
  const configIntegrity = artifactHashMatches(configArtifact)
    && configArtifact.content === stableJson(config)
    && state.plan?.sha256 === state.approvedPlanSha256
    && state.plan?.sha256 === plan?.sha256;

  const implementationArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.implementationCapsule?.id
  );
  const implementationIntegrity = configCheck.implementation?.ok === true
    && artifactHashMatches(implementationArtifact)
    && implementationArtifact.content === stableJson(config?.implementationCapsule);

  const sealedEvidenceIntegrity = [
    ['developmentEvidenceCapsule', config?.developmentEvidenceCapsule],
    ['heldOutEvidenceCapsule', config?.heldOutEvidenceCapsule],
    ['mechanismEvidenceCapsule', config?.mechanismEvidenceCapsule],
    ['runtimeAuthority', config?.runtimeAuthority]
  ].every(([field, value]) => {
    const artifact = safeArtifact(store, runId, state.evidenceArtifacts?.[field]?.id);
    return artifactHashMatches(artifact)
      && artifact.content === stableJson(value);
  });

  const proposals = Array.isArray(state.proposals) ? state.proposals : [];
  const evaluations = Array.isArray(state.evaluations) ? state.evaluations : [];
  const proposalChecks = proposals.map((record) => ({
    record,
    verification: verifyPersistedProposalRun(store, runId, record)
  }));
  const evaluationChecks = evaluations.map((record) => ({
    record,
    verification: verifyPersistedAgentRun(store, runId, record)
  }));
  const receipts = proposalChecks.length === ADAPTIVE_TRANSFER_COHORT.proposalCalls
    && evaluationChecks.length === ADAPTIVE_TRANSFER_COHORT.evaluationCalls
    && proposalChecks.every((item) => item.verification.ok)
    && evaluationChecks.every((item) => item.verification.ok);
  const failedDispatches = Array.isArray(state.failureEvidence)
    ? state.failureEvidence
    : [];
  const observedAuthorityRows = [
    ...proposals.map((record) => ({
      slotId: record.slotId,
      invocation: record
    })),
    ...evaluations.map((record) => ({
      slotId: record.slotId,
      invocation: record
    })),
    ...failedDispatches.map((record) => ({
      slotId: record.slotId,
      invocation: record.invocation
    }))
  ];
  const observedVerdicts = Array.isArray(state.verdictEvents)
    ? state.verdictEvents
    : [];
  const modelAuthority = observedAuthorityRows.length === observedVerdicts.length
    && new Set(observedAuthorityRows.map((item) => item.slotId)).size
      === observedAuthorityRows.length
    && observedAuthorityRows.every((item) => (
      invocationMatchesRuntimeAuthority(config || {}, item.invocation)
    ));
  const failedDispatchIsolation = failedDispatches.every((item) => {
    const invocation = item?.invocation;
    return invocation?.strictIsolation === true
      && invocation?.isolation?.status === 'PASS'
      && Array.isArray(invocation?.disabledFeatures)
      && canonicalJson([...invocation.disabledFeatures].sort())
        === canonicalJson([...STRICT_CODEX_DISABLED_FEATURES].sort());
  });
  const strictIsolation = proposalChecks.every((item) => (
    item.verification.checks?.isolation === true
    && item.verification.checks?.strictLaunch === true
  )) && evaluationChecks.every((item) => (
    item.verification.checks?.isolation === true
    && item.verification.checks?.strictLaunch === true
  )) && failedDispatchIsolation;

  const expectedSlots = plan?.contract?.waves?.flatMap((wave) => wave.slots) || [];
  const actualLedger = Array.isArray(state.callLedger) ? state.callLedger : [];
  const schedule = actualLedger.length === expectedSlots.length
    && actualLedger.every((record, index) => {
      const expected = expectedSlots[index];
      return record.slotId === expected.slotId
        && record.stage === expected.stage
        && record.taskId === expected.taskId
        && record.armRole === expected.armRole
        && record.blindArm === expected.blindArm
        && record.waveId === expected.waveId
        && record.wavePosition === expected.wavePosition
        && record.globalWaveIndex === (
          plan.contract.waves.find((wave) => wave.id === expected.waveId)?.globalIndex
        )
        && record.status === 'ACCEPTED'
        && record.accepted === true
        && record.attempt === 0;
    });
  const acceptedRecords = [...proposals, ...evaluations];
  const ledgerBindings = acceptedRecords.length === ADAPTIVE_TRANSFER_COHORT.totalCalls
    && acceptedRecords.every((record) => {
      const ledger = actualLedger.find((item) => item.slotId === record.slotId);
      return !!ledger
        && ledger.contractArtifactRef === record.contractArtifactRef
        && ledger.contractSha256 === record.contractSha256
        && ledger.promptArtifactRef === record.promptArtifactRef
        && ledger.promptArtifactSha256 === record.promptArtifactSha256
        && ledger.contractPath === record.contractPath
        && ledger.contractPathSha256 === record.contractPathSha256
        && ledger.packetPath === record.packetPath
        && ledger.packetSha256 === record.packetSha256
        && ledger.accepted === true;
    });
  const concurrency = (plan?.contract?.waves || []).length
      === ADAPTIVE_TRANSFER_COHORT.waveCount
    && (plan?.contract?.waves || []).every((wave) => (
      wave.slots.length >= 1
      && wave.slots.length <= ADAPTIVE_TRANSFER_COHORT.maxConcurrency
    ))
    && (state.waveLedger || []).every((wave, index) => (
      wave.id === plan.contract.waves[index]?.id
      && wave.status === 'SETTLED'
      && Date.parse(wave.launchedAt) <= Date.parse(wave.settledAt)
      && (index === 0
        || Date.parse(state.waveLedger[index - 1].settledAt)
          <= Date.parse(wave.launchedAt))
    ));
  const noRetries = observedVerdicts.length <= ADAPTIVE_TRANSFER_COHORT.totalCalls
    && observedVerdicts.every((event) => event.attempt === 0)
    && new Set(observedVerdicts.map((event) => event.slotId)).size
      === observedVerdicts.length;

  const taskById = new Map((config?.tasks || []).map((task) => [task.id, task]));
  const planTaskById = new Map((plan?.tasks || []).map((task) => [task.id, task]));
  const proposalInputChecks = proposals.map((record) => {
    const task = taskById.get(record.taskId);
    const planTask = planTaskById.get(record.taskId);
    const slot = expectedSlots.find((item) => item.slotId === record.slotId);
    const contract = task && planTask && slot
      ? buildAdaptiveTransferCohortProposalContract(
          config,
          task,
          planTask,
          slot
        )
      : null;
    return contract
      ? verifyCallInputs(store, runId, record, contract)
      : { ok: false };
  });
  const evaluationInputChecks = evaluations.map((record) => {
    const task = taskById.get(record.taskId);
    const planTask = planTaskById.get(record.taskId);
    const slot = expectedSlots.find((item) => item.slotId === record.slotId);
    const proposal = proposals.find((item) => (
      item.taskId === record.taskId && item.armRole === record.armRole
    ));
    const procedure = proposalContent(store, runId, proposal);
    const contract = task && planTask && slot && procedure
      ? buildEvaluationContract(config, task, planTask, slot, procedure)
      : null;
    return contract
      ? verifyCallInputs(store, runId, record, contract)
      : { ok: false };
  });
  const promptBinding = [...proposalInputChecks, ...evaluationInputChecks]
    .every((item) => item.ok);

  const proposalSchemaHashes = new Set(
    proposals.map((item) => item.outputSchemaSha256).filter(Boolean)
  );
  const evaluationSchemaHashes = new Set(
    evaluations.map((item) => item.outputSchemaSha256).filter(Boolean)
  );
  const proposalSchemaArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.proposalSchema?.id
  );
  const evaluationSchemaArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.evaluationSchema?.id
  );
  const schemaIdentity = proposalSchemaHashes.size === 1
    && evaluationSchemaHashes.size === 1
    && proposalSchemaHashes.has(proposalSchemaArtifact?.sha256)
    && evaluationSchemaHashes.has(evaluationSchemaArtifact?.sha256)
    && artifactHashMatches(proposalSchemaArtifact)
    && artifactHashMatches(evaluationSchemaArtifact);

  const packetIntegrity = [...proposals, ...evaluations].length
      === ADAPTIVE_TRANSFER_COHORT.totalCalls
    && [...proposals, ...evaluations].every((record) => (
      packetEnvelopeMatches(store, runId, record)
    ));

  const privateSources = config?.mechanismEvidenceCapsule || [];
  const privateNeedles = privateSources.flatMap((item) => [
    String(item?.path || ''),
    String(item?.content || '')
  ]).concat(
    (config?.mechanismEvidenceRefs || []).map((item) => String(item?.locator || ''))
  ).filter((needle) => needle.length >= 8);
  const privateEvidenceWithheld = [...proposalInputChecks, ...evaluationInputChecks]
    .every((item) => {
      const prompt = String(item.promptArtifact?.content || '');
      return privateNeedles.every((needle) => !prompt.includes(needle))
        && !Object.hasOwn(item.contract || {}, 'mechanismEvidenceCapsule')
        && !Object.hasOwn(item.contract || {}, 'mechanismEvidenceRefs');
    });

  let partitionIsolation = true;
  for (const item of proposalInputChecks) {
    const taskId = proposals[proposalInputChecks.indexOf(item)]?.taskId;
    const task = taskById.get(taskId);
    const prompt = String(item.promptArtifact?.content || '');
    const hiddenNeedles = [
      ...(task?.heldOutEvidencePaths || []),
      ...(task?.heldOutCases || []).flatMap((row) => [
        String(row?.id || ''),
        String(row?.prompt || ''),
        String(row?.evidenceRef?.locator || ''),
        String(row?.baselineFailureRef?.locator || '')
      ])
    ].filter((needle) => needle.length >= 8);
    if (hiddenNeedles.some((needle) => prompt.includes(needle))) {
      partitionIsolation = false;
    }
  }
  for (const item of evaluationInputChecks) {
    const record = evaluations[evaluationInputChecks.indexOf(item)];
    const ownTask = taskById.get(record?.taskId);
    const prompt = String(item.promptArtifact?.content || '');
    const foreignIdentifiers = (config?.tasks || [])
      .filter((task) => task.id !== ownTask?.id)
      .flatMap((task) => [
        ...(task.developmentEvidencePaths || []),
        ...(task.heldOutEvidencePaths || []),
        ...(task.developmentCases || []).map((row) => String(row?.id || '')),
        ...(task.heldOutCases || []).map((row) => String(row?.id || ''))
      ]);
    const ownDevelopmentIdentifiers = [
      ...(ownTask?.developmentEvidencePaths || []),
      ...(ownTask?.developmentCases || []).flatMap((row) => [
        String(row?.id || ''),
        String(row?.evidenceRef?.locator || '')
      ])
    ];
    const forbidden = foreignIdentifiers
      .concat(ownDevelopmentIdentifiers)
      .filter((needle) => String(needle).length >= 8);
    if (forbidden.some((needle) => prompt.includes(String(needle)))
        || item.contract?.mechanismCapsule != null) {
      partitionIsolation = false;
    }
  }

  let measurementDerivation = evaluations.length
    === ADAPTIVE_TRANSFER_COHORT.evaluationCalls;
  for (const record of evaluations) {
    const task = taskById.get(record.taskId);
    const artifact = safeArtifact(store, runId, record.evaluationArtifactRef);
    const raw = safeArtifact(store, runId, record.rawArtifactRef);
    const quality = artifact ? scoreCaseResults(artifact.content, task?.oracle) : null;
    const targetQuality = artifact
      ? scoreOracleGroup(artifact.content, task?.oracle, 'target')
      : null;
    const controlQuality = artifact
      ? scoreOracleGroup(artifact.content, task?.oracle, 'control')
      : null;
    if (!artifactHashMatches(artifact)
        || !artifactHashMatches(raw)
        || quality !== record.quality
        || targetQuality !== record.targetQuality
        || controlQuality !== record.controlQuality) {
      measurementDerivation = false;
    }
  }

  const referencedArtifacts = new Set([
    ...flattenEvidenceArtifactRefs(state.evidenceArtifacts),
    ...proposals.flatMap((record) => [
      record.rawArtifactRef,
      record.resultArtifactRef,
      record.contractArtifactRef,
      record.promptArtifactRef
    ]),
    ...evaluations.flatMap((record) => [
      record.rawArtifactRef,
      record.resultArtifactRef,
      record.evaluationArtifactRef,
      record.contractArtifactRef,
      record.promptArtifactRef
    ]),
    ...(state.failureEvidence || []).flatMap((item) => [
      item.stdout?.artifactRef,
      item.stderr?.artifactRef,
      item.result?.artifactRef
    ])
  ].filter(Boolean));
  const artifactHashes = [...referencedArtifacts].every((artifactId) => (
    artifactHashMatches(safeArtifact(store, runId, artifactId))
  ));
  const noPromotion = state.promotion?.enabled === false
    && state.promotion?.recorded === false;
  const stateConsistency = state.status === 'QUEUE_DRAINED'
    && state.blocker == null
    && state.failureEvidence?.length === 0
    && proposals.length === ADAPTIVE_TRANSFER_COHORT.proposalCalls
    && evaluations.length === ADAPTIVE_TRANSFER_COHORT.evaluationCalls;

  const gates = {
    configIntegrity: configIntegrity && configCheck.ok,
    implementationIntegrity,
    sealedEvidenceIntegrity,
    receipts,
    modelAuthority,
    strictIsolation,
    schedule,
    ledgerBindings,
    concurrency,
    noRetries,
    promptBinding,
    schemaIdentity,
    packetIntegrity,
    privateEvidenceWithheld,
    partitionIsolation,
    measurementDerivation,
    artifactHashes,
    noPromotion,
    stateConsistency
  };
  const experimentValid = Object.values(gates).every(Boolean);
  const outcome = evaluateCohortOutcome(config || { tasks: [] }, evaluations);
  const activationEligible = experimentValid && outcome.status === 'PASS';
  const validTokenRows = [...proposals, ...evaluations]
    .map((item) => item.cliReportedTotalTokens)
    .filter(Number.isFinite);
  const failedTokenRows = (state.failureEvidence || [])
    .map((item) => item.invocation?.cliReportedTotalTokens)
    .filter(Number.isFinite);
  const observedCalls = state.verdictEvents?.length || 0;
  const measuredCalls = validTokenRows.length + failedTokenRows.length;
  const tokenUsage = {
    observedCalls,
    measuredCalls,
    unmeasuredCalls: Math.max(0, observedCalls - measuredCalls),
    total: observedCalls > 0 && observedCalls === measuredCalls
      ? [...validTokenRows, ...failedTokenRows]
        .reduce((sum, value) => sum + value, 0)
      : null,
    proposalTotal: proposals.length === ADAPTIVE_TRANSFER_COHORT.proposalCalls
      ? proposals.reduce((sum, item) => sum + item.cliReportedTotalTokens, 0)
      : null,
    evaluationTotal: evaluations.length === ADAPTIVE_TRANSFER_COHORT.evaluationCalls
      ? evaluations.reduce((sum, item) => sum + item.cliReportedTotalTokens, 0)
      : null,
    failedDispatchTotal: failedTokenRows.length
      ? failedTokenRows.reduce((sum, value) => sum + value, 0)
      : 0
  };
  const reasons = [
    ...Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => `Required experiment gate failed: ${name}.`),
    ...(configCheck.errors || []).map((error) => `Config: ${error}`),
    ...outcome.reasons
  ];
  const base = {
    schemaVersion: 1,
    runId,
    status: experimentValid ? 'PASS' : 'FAIL',
    experimentValid,
    activationEligible,
    realEvidence: config?.fixtureOnly === false,
    modelAuthority: {
      requestedModel: config?.model || null,
      authMode: config?.runtimeAuthority?.authMode || null,
      selectionAuthority: config?.runtimeAuthority?.selectionAuthority || null,
      observedCalls: tokenUsage.observedCalls
    },
    gates,
    callCounts: {
      proposals: proposals.length,
      evaluations: evaluations.length,
      total: proposals.length + evaluations.length
    },
    outcome,
    tokenUsage,
    reasons
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function adaptiveTransferCohortLaunchDisclosure(config, {
  configPath,
  home,
  runId
} = {}) {
  const plan = buildAdaptiveTransferCohortPlan(config);
  const proposalSchemaPath = schemaPathForContract({ kind: 'proposal' });
  const evaluationSchemaPath = schemaPathForContract({ kind: 'evaluation' });
  const proposalArgv = buildArgs('codex', null, REAL_TEST_MODEL, {
    strictIsolation: true,
    schemaPath: proposalSchemaPath,
    workspaceRoot: '<fresh-capsule-dir>'
  });
  const evaluationArgv = buildArgs('codex', null, REAL_TEST_MODEL, {
    strictIsolation: true,
    schemaPath: evaluationSchemaPath,
    workspaceRoot: '<fresh-capsule-dir>'
  });
  const quoted = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const authority = object(config.runtimeAuthority);
  const launch = [
    `SUPER_LOOP_CODEX_BIN=${quoted(authority.binary?.path || '')}`,
    'SUPER_LOOP_REQUIRE_CHATGPT_OAUTH=1',
    `SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256=${authority.authoritySha256 || ''}`,
    `SUPER_LOOP_CODEX_EXECUTABLE_SHA256=${authority.binary?.sha256 || ''}`,
    'SUPER_LOOP_ALLOW_EXEC=1',
    'npm run transfer-cohort -- --config',
    quoted(configPath),
    '--approved-plan',
    plan.sha256,
    '--run-id',
    quoted(runId),
    '--home',
    quoted(home)
  ].join(' ');
  const verify = [
    'npm run verify:transfer-cohort -- --home',
    quoted(home),
    '--run',
    quoted(runId)
  ].join(' ');
  return {
    profile: plan.profile,
    planSha256: plan.sha256,
    resolvedConfigSha256: sha256(stableJson(config)),
    proofHome: home,
    runId,
    implementationManifest: plan.implementationManifest,
    runtimeAuthority: plan.runtimeAuthority,
    calls: {
      proposals: ADAPTIVE_TRANSFER_COHORT.proposalCalls,
      evaluations: ADAPTIVE_TRANSFER_COHORT.evaluationCalls,
      total: ADAPTIVE_TRANSFER_COHORT.totalCalls,
      retries: ADAPTIVE_TRANSFER_COHORT.retriesPerDispatch,
      fallbackModels: 0
    },
    schedule: {
      maxConcurrency: ADAPTIVE_TRANSFER_COHORT.maxConcurrency,
      waves: ADAPTIVE_TRANSFER_COHORT.waveCount,
      proposalWaves: plan.contract.waves.filter((wave) => wave.stage === 'proposal').length,
      evaluationWaves: plan.contract.waves.filter((wave) => wave.stage === 'evaluation').length,
      conditionalContinuation: false,
      frozenWaves: plan.contract.waves
    },
    partitions: {
      developmentSources: normalizedManifest(config, 'developmentEvidenceManifest').length,
      heldOutSources: normalizedManifest(config, 'heldOutEvidenceManifest').length,
      privateMechanismSources: normalizedManifest(config, 'mechanismEvidenceManifest').length,
      tasks: config.tasks?.length || 0
    },
    exposure: {
      perCallTimeoutMs: ADAPTIVE_TRANSFER_COHORT.perCallTimeoutMs,
      timeoutCeilingMinutes: ADAPTIVE_TRANSFER_COHORT.timeoutCeilingMs / 60_000,
      hardTokenLimit: ADAPTIVE_TRANSFER_COHORT.hardTokenLimit,
      hardUsdLimit: ADAPTIVE_TRANSFER_COHORT.hardUsdLimit,
      historicalTokenEstimate: config.historicalTokenEstimate ?? null,
      historicalEstimateBinding: 'non-binding'
    },
    execution: {
      model: REAL_TEST_MODEL,
      reasoningEffort: STRICT_CODEX_REASONING_EFFORT,
      authMode: authority.authMode || null,
      modelSelectionAuthority: authority.selectionAuthority || null,
      executableSha256: authority.binary?.sha256 || null,
      catalogSha256: authority.catalog?.sha256 || null,
      promptTransport: 'stdin',
      sandbox: 'read-only',
      promotionEnabled: false,
      proposalSchemaPath,
      evaluationSchemaPath,
      proposalArgv,
      evaluationArgv,
      disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES]
    },
    endpoint: {
      requiredRoutedWins: ADAPTIVE_TRANSFER_COHORT.requiredRoutedWins,
      allowedShamWins: ADAPTIVE_TRANSFER_COHORT.allowedShamWins,
      allowedControlRegressions: ADAPTIVE_TRANSFER_COHORT.allowedControlRegressions,
      exactOneSidedSignTestP: ADAPTIVE_TRANSFER_COHORT.exactSignTestP
    },
    launchCommand: `${launch} && ${verify}`
  };
}
