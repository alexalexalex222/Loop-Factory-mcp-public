// Causal proof for adaptive routing.
//
// Three isolated proposal arms differ only by their assigned mechanism capsule:
// no capsule, one evidence-routed capsule, or one schema-identical irrelevant
// capsule. V2 first qualifies the no-memory arm on five disjoint hidden shards,
// then spends the remaining calls only when that arm leaves measurable headroom.
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBaselineIntegrity,
  checkHypothesisIntegrity
} from './baseline-integrity.mjs';
import {
  CASE_RESULTS_ORACLE_KIND_V2,
  TOOL_AUTHORITY,
  canonicalCaseResultsContent,
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
  parseReportedModel,
  parseTokenUsage,
  schemaPathForContract
} from './executor.mjs';
import {
  REAL_TEST_MODEL,
  canonicalJson
} from './real-test.mjs';
import {
  compilePhaseContract,
  dispatchWorker
} from './supervisor.mjs';
import {
  verifyPersistedAgentRun,
  verifyPersistedProposalRun
} from './run-verifier.mjs';
import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';
import { buildMechanismRoutingDecision } from './mechanism-router.mjs';
import {
  persistCanaryEvaluation,
  persistCanaryProposal,
  persistRejectedDispatch,
  stableJson,
  writeCanaryArtifact
} from './canary-runner.mjs';
import { isSafeId, nowIso, round, sha256 } from './util.mjs';

export const ADAPTIVE_META_CANARY_SCHEMA_VERSION = 'adaptive-meta-canary-v2';
export const ADAPTIVE_META_CANARY_PRIVATE_EVIDENCE_POLICY = 'source-qualified-v2';
export const ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION =
  'development-identifiers-v1';
export const ADAPTIVE_META_CANARY_EXECUTION_MODES = Object.freeze([
  'full',
  'qualification-only'
]);

const LEGACY_ADAPTIVE_META_CANARY = Object.freeze({
  profile: 'adaptive-meta-canary-v1',
  arms: Object.freeze(['baseline', 'routed', 'sham']),
  proposalCalls: 3,
  evaluationsPerArm: 5,
  evaluationCalls: 15,
  totalCalls: 18,
  retriesPerDispatch: 0,
  perCallTimeoutMs: 10 * 60 * 1000,
  sequentialTimeoutCeilingMs: 180 * 60 * 1000,
  hardTokenLimit: null,
  hardUsdLimit: null,
  promotionEnabled: false
});

export const ADAPTIVE_META_CANARY = Object.freeze({
  ...LEGACY_ADAPTIVE_META_CANARY,
  profile: ADAPTIVE_META_CANARY_SCHEMA_VERSION,
  qualificationCalls: 6,
  conditionalCalls: 12,
  qualificationBaselineFailures: 4
});

// Retained byte-for-byte for verification of persisted v1 experiments.
export const ADAPTIVE_META_CANARY_EVALUATION_SCHEDULE = Object.freeze([
  Object.freeze(['baseline', 'routed', 'sham']),
  Object.freeze(['routed', 'sham', 'baseline']),
  Object.freeze(['sham', 'baseline', 'routed']),
  Object.freeze(['baseline', 'sham', 'routed']),
  Object.freeze(['routed', 'baseline', 'sham'])
]);

export const ADAPTIVE_META_CANARY_V2_COMPARISON_SCHEDULE = Object.freeze([
  Object.freeze(['routed', 'sham']),
  Object.freeze(['sham', 'routed']),
  Object.freeze(['routed', 'sham']),
  Object.freeze(['sham', 'routed']),
  Object.freeze(['routed', 'sham'])
]);

export const IRRELEVANT_SHAM_INSTRUCTION =
  'Irrelevant placebo control. Produce a byte-distinct, presentation-only revision by normalizing headings or spacing. Preserve every decision rule, code, and behavior. Do not introduce, remove, or alter any target-handling mechanism.';

export const ADAPTIVE_META_CANARY_IMPLEMENTATION_PATHS = Object.freeze([
  'package.json',
  'loops/loop-de-loop.md',
  'scripts/plan-adaptive-meta-canary.mjs',
  'scripts/run-adaptive-meta-canary.mjs',
  'scripts/verify-adaptive-meta-canary.mjs',
  'src/adaptive-meta-canary.mjs',
  'src/adaptive-policy.mjs',
  'src/adaptive-records.mjs',
  'src/baseline-integrity.mjs',
  'src/canary-runner.mjs',
  'src/codex-oauth-authority.mjs',
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
  'src/schemas/evaluation-output.schema.json',
  'src/schemas/proposal-output.schema.json',
  'src/skill-schema.mjs',
  'src/store.mjs',
  'src/supervisor.mjs',
  'src/util.mjs'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_ARM_ORDER = Object.freeze(['baseline', 'routed', 'sham']);
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mean(values) {
  return values.length
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function safeArtifact(store, runId, artifactId) {
  try {
    return artifactId ? store.readArtifact(runId, artifactId) : null;
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
  const text = String(content || '');
  const needle = String(locator || '').trim();
  if (!needle) return false;
  if (text.includes(needle)) return true;
  const match = needle.match(/(?:^|(?:line|lines|l)\s*|:)(\d+)(?:\s*(?:-|to|:)\s*(\d+))?$/i);
  if (!match) return false;
  const lines = text.split(/\r?\n/);
  const start = Number(match[1]);
  const end = Number(match[2] || start);
  return Number.isInteger(start)
    && Number.isInteger(end)
    && start >= 1
    && end >= start
    && end <= lines.length;
}

function capsulePayload(capsule) {
  const payload = { ...object(capsule) };
  delete payload.mechanismCapsuleSha256;
  return payload;
}

function capsuleHash(capsule) {
  return sha256(canonicalAdaptiveJson(capsulePayload(capsule)));
}

function capsuleIntegrity(capsule) {
  return object(capsule).schemaVersion === 'mechanism-capsule-v1'
    && SHA256_RE.test(String(capsule.mechanismCapsuleSha256 || ''))
    && capsuleHash(capsule) === capsule.mechanismCapsuleSha256;
}

function shape(value) {
  if (Array.isArray(value)) return { type: 'array', items: value.map(shape) };
  if (value === null) return { type: 'null' };
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      fields: Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, shape(value[key])])
      )
    };
  }
  return { type: typeof value };
}

export function capsuleSchemaSha256(capsule) {
  return sha256(stableJson(shape(capsule)));
}

function irrelevantProgram(source = {}) {
  const roles = new Map((source.roles || []).map((role, index) => (
    [role, `document.role-${index + 1}`]
  )));
  const selectors = new Map((source.selectors || []).map((item, index) => (
    [item.selectorId, `document-selector-${index + 1}`]
  )));
  const bindings = new Map((source.bindings || []).map((item, index) => (
    [item.bindingId, `document-binding-${index + 1}`]
  )));
  const metrics = new Map((source.metrics || []).map((item, index) => (
    [item.metricId, `document-metric-${index + 1}`]
  )));
  const rules = new Map((source.rules || []).map((item, index) => (
    [item.ruleId, `document-rule-${index + 1}`]
  )));
  const declaredCodes = [
    ...(source.rules || []).map((item) => item.emit?.code),
    source.fallback?.code
  ].filter(Boolean);
  const codes = new Map([...new Set(declaredCodes)].map((code, index) => (
    [code, `DOCUMENT_CODE_${index + 1}`]
  )));
  const maps = { roles, bindings, metrics };
  const literalState = { index: 0 };
  const operand = (value) => {
    if (value.kind === 'role') {
      return { kind: 'role', id: maps.roles.get(value.id) };
    }
    if (value.kind === 'metric') {
      return { kind: 'metric', id: maps.metrics.get(value.id) };
    }
    if (value.kind === 'binding') {
      return { kind: 'binding', id: maps.bindings.get(value.id) };
    }
    literalState.index += 1;
    const literal = value.value;
    return {
      kind: 'literal',
      value: typeof literal === 'string'
        ? `document-value-${literalState.index}`
        : (typeof literal === 'number'
            ? (literal === 0 ? 1 : -literal)
            : (typeof literal === 'boolean' ? !literal : null))
    };
  };
  const condition = (value) => {
    if (value.operator === 'not') {
      return { operator: 'not', condition: condition(value.condition) };
    }
    if (value.operator === 'all' || value.operator === 'any') {
      return {
        operator: value.operator,
        conditions: value.conditions.map(condition)
      };
    }
    return {
      operator: value.operator,
      left: operand(value.left),
      right: operand(value.right)
    };
  };
  return {
    schemaVersion: source.schemaVersion,
    bindingPolicy: source.bindingPolicy,
    roles: (source.roles || []).map((role) => roles.get(role)),
    selectors: (source.selectors || []).map((item) => ({
      selectorId: selectors.get(item.selectorId),
      collectionRole: roles.get(item.collectionRole),
      match: condition(item.match)
    })),
    bindings: (source.bindings || []).map((item) => ({
      bindingId: bindings.get(item.bindingId),
      operator: item.operator,
      leftRole: roles.get(item.leftRole),
      rightRole: roles.get(item.rightRole)
    })),
    forbiddenBindings: (source.forbiddenBindings || []).map((item, index) => ({
      leftRole: roles.get(item.leftRole),
      rightRole: roles.get(item.rightRole),
      reasonCode: `DOCUMENT_BINDING_${index + 1}`
    })),
    metrics: (source.metrics || []).map((item) => ({
      metricId: metrics.get(item.metricId),
      operator: item.operator,
      leftRole: roles.get(item.leftRole),
      rightRole: roles.get(item.rightRole)
    })),
    rules: (source.rules || []).map((item) => ({
      ruleId: rules.get(item.ruleId),
      kind: item.kind,
      exceptionOf: item.exceptionOf == null ? null : rules.get(item.exceptionOf),
      when: condition(item.when),
      emit: {
        decision: item.emit.decision,
        code: codes.get(item.emit.code)
      }
    })),
    fallback: {
      decision: source.fallback.decision,
      code: codes.get(source.fallback.code)
    }
  };
}

function shamFingerprint(source = {}) {
  const applicability = object(source.applicability);
  const replace = (values, prefix) => (Array.isArray(values) ? values : [])
    .map((ignored, index) => `${prefix}-${index + 1}`);
  return {
    bottleneckKind: 'presentation-only-variation',
    interventionKind: 'irrelevant-formatting-control',
    operationKind: 'nonbehavioral-formatting',
    expectedEffectKind: 'no-behavior-change',
    preconditions: replace(source.preconditions, 'irrelevant-precondition'),
    ...(Object.hasOwn(source, 'procedureSteps')
      ? {
          procedureSteps: replace(
            source.procedureSteps,
            'normalize-document-section'
          )
        }
      : {}),
    ...(Object.hasOwn(source, 'program')
      ? { program: irrelevantProgram(source.program) }
      : {}),
    applicability: {
      taskModes: replace(applicability.taskModes, 'irrelevant-task'),
      loopRoles: replace(applicability.loopRoles, 'irrelevant-role'),
      taskValueDimensions: replace(applicability.taskValueDimensions, 'irrelevant-value'),
      resourceDimensions: replace(applicability.resourceDimensions, 'irrelevant-resource')
    }
  };
}

export function createIrrelevantShamCapsule(routedCapsule) {
  if (!capsuleIntegrity(routedCapsule)
      || !Array.isArray(routedCapsule.items)
      || routedCapsule.items.length === 0) {
    return null;
  }
  const items = routedCapsule.items.map((item, index) => ({
    position: item.position,
    allocation: item.allocation,
    familyId: `family-${sha256(`adaptive-meta-canary-sham-family:${index}`).slice(0, 24)}`,
    familySha256: sha256(`adaptive-meta-canary-sham-family-record:${index}`),
    causalFingerprint: shamFingerprint(item.causalFingerprint),
    evidence: {
      applicationReceiptId: `app-receipt-${sha256(`adaptive-meta-canary-sham-application:${index}`).slice(0, 24)}`,
      applicationSha256: sha256(`adaptive-meta-canary-sham-application-record:${index}`),
      verdict: String(item.evidence?.verdict || 'improvement'),
      reverified: false,
      confidence: 0,
      utility: 0
    },
    semantics: 'irrelevant-control',
    instruction: IRRELEVANT_SHAM_INSTRUCTION
  }));
  const payload = {
    schemaVersion: routedCapsule.schemaVersion,
    targetSha256: routedCapsule.targetSha256,
    policyEpochId: routedCapsule.policyEpochId,
    policyEpochSha256: routedCapsule.policyEpochSha256,
    candidatePoolSha256: routedCapsule.candidatePoolSha256,
    items
  };
  return {
    ...payload,
    mechanismCapsuleSha256: sha256(canonicalAdaptiveJson(payload))
  };
}

function normalizedManifest(config, field) {
  return (Array.isArray(config[field]) ? config[field] : [])
    .map((item) => ({
      path: item?.path || null,
      bytes: Number.isInteger(item?.bytes) ? item.bytes : null,
      sha256: item?.sha256 || null
    }))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function isBlindHeldOutV2(config = {}) {
  return config.schemaVersion === ADAPTIVE_META_CANARY_SCHEMA_VERSION;
}

function evidenceManifest(config) {
  return normalizedManifest(config, 'evidenceManifest');
}

function heldOutEvidenceManifest(config) {
  return normalizedManifest(config, 'heldOutEvidenceManifest');
}

function mechanismEvidenceManifest(config) {
  return normalizedManifest(config, 'mechanismEvidenceManifest');
}

function implementationManifest(config) {
  return (Array.isArray(config.implementationManifest) ? config.implementationManifest : [])
    .map((item) => ({
      path: item?.path || null,
      bytes: Number.isInteger(item?.bytes) ? item.bytes : null,
      sha256: item?.sha256 || null
    }))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

export function resolveAdaptiveMetaCanaryImplementation(packageRoot = PACKAGE_ROOT) {
  const root = resolve(packageRoot);
  const capsule = ADAPTIVE_META_CANARY_IMPLEMENTATION_PATHS.map((path) => {
    const fullPath = resolve(root, path);
    const rel = relative(root, fullPath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`meta-canary implementation path escapes package root: ${path}`);
    }
    const bytes = readFileSync(fullPath);
    return {
      path,
      content: bytes.toString('utf8')
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest: capsule.map((item) => ({
      path: item.path,
      bytes: Buffer.byteLength(item.content),
      sha256: sha256(Buffer.from(item.content))
    })),
    capsule
  };
}

function inspectImplementation(config, errors) {
  const manifest = implementationManifest(config);
  const capsule = Array.isArray(config.implementationCapsule)
    ? config.implementationCapsule
    : [];
  const expectedPaths = [...ADAPTIVE_META_CANARY_IMPLEMENTATION_PATHS].sort();
  const actualPaths = manifest.map((item) => item.path);
  const manifestByPath = new Map();
  for (const item of manifest) {
    if (!item.path
        || !Number.isInteger(item.bytes)
        || item.bytes < 0
        || !SHA256_RE.test(String(item.sha256 || ''))
        || manifestByPath.has(item.path)) {
      errors.push(`invalid implementation manifest entry: ${item.path || '<missing>'}`);
      continue;
    }
    manifestByPath.set(item.path, item);
  }
  if (stableJson(actualPaths) !== stableJson(expectedPaths)) {
    errors.push('implementation manifest must bind the exact meta-canary dependency set');
  }
  const capsuleByPath = new Map();
  for (const item of capsule) {
    const sealed = manifestByPath.get(String(item?.path || ''));
    if (!sealed
        || typeof item?.content !== 'string'
        || capsuleByPath.has(item.path)
        || Buffer.byteLength(item.content) !== sealed.bytes
        || sha256(Buffer.from(item.content)) !== sealed.sha256) {
      errors.push(`implementation capsule does not match its manifest: ${item?.path || '<missing>'}`);
      continue;
    }
    capsuleByPath.set(item.path, item);
  }
  if (capsuleByPath.size !== manifestByPath.size) {
    errors.push('implementation capsule must contain every sealed dependency');
  }
  return {
    ok: manifestByPath.size === expectedPaths.length
      && capsuleByPath.size === expectedPaths.length
      && stableJson(actualPaths) === stableJson(expectedPaths),
    manifest,
    capsule
  };
}

function planMechanismIdentity(context = {}) {
  return {
    familyIds: (context.families || []).map((item) => item.familyId).sort(),
    familyHashes: (context.families || []).map((item) => item.familySha256).sort(),
    applicationReceiptIds: (context.applications || [])
      .map((item) => item.applicationReceiptId)
      .sort(),
    applicationHashes: (context.applications || []).map((item) => item.applicationSha256).sort(),
    primaryFamilyId: context.primaryFamilyId || null,
    policyEpochId: context.policyEpoch?.policyEpochId || null,
    policyEpochSha256: context.policyEpoch?.policyEpochSha256 || null,
    routingDecisionId: context.routingDecision?.routingDecisionId || null,
    routingDecisionSha256: context.routingDecision?.routingDecisionSha256 || null,
    routingPacketSha256: context.routingDecision?.routingPacketSha256 || null,
    candidatePoolSha256: context.routingDecision?.candidatePoolSha256 || null,
    routedCapsuleSha256: context.routedCapsule?.mechanismCapsuleSha256 || null,
    shamCapsuleSha256: context.shamCapsule?.mechanismCapsuleSha256 || null,
    capsuleSchemaSha256: context.routedCapsule
      ? capsuleSchemaSha256(context.routedCapsule)
      : null,
    seed: context.seed || null,
    hypothesisCount: Number.isInteger(context.hypothesisCount)
      ? context.hypothesisCount
      : null,
    routingTargetSha256: context.routingDecision?.targetSha256 || null
  };
}

function v2EvaluationShards(config = {}) {
  return Array.isArray(config.benchmark?.evaluationShards)
    ? config.benchmark.evaluationShards
    : [];
}

function isQualificationOnly(config = {}) {
  return config.executionMode === 'qualification-only';
}

export function normalizeAdaptiveMetaCanaryEvaluationProcedure(
  config,
  procedureContent
) {
  if (config?.evaluationProcedureNormalization
      !== ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION) {
    return String(procedureContent || '');
  }
  const replacements = [
    ...(config.evidenceSources || []).map((value) => ({
      value: String(value || ''),
      replacement: 'ASSIGNED_EVIDENCE_PATH'
    })),
    ...(config.benchmark?.developmentCases || []).flatMap((item) => [
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

function v2ExecutionSchedule(config, blindLabels) {
  const shards = v2EvaluationShards(config);
  return [
    {
      kind: 'proposal',
      armRole: 'baseline',
      blindArm: blindLabels.baseline,
      position: 0
    },
    ...shards.map((shard, replicate) => ({
      kind: 'evaluation',
      armRole: 'baseline',
      blindArm: blindLabels.baseline,
      shardId: shard.id,
      replicate,
      position: 0,
      stage: 'qualification'
    })),
    {
      kind: 'proposal',
      armRole: 'routed',
      blindArm: blindLabels.routed,
      position: 1
    },
    {
      kind: 'proposal',
      armRole: 'sham',
      blindArm: blindLabels.sham,
      position: 2
    },
    ...shards.flatMap((shard, replicate) => (
      ADAPTIVE_META_CANARY_V2_COMPARISON_SCHEDULE[replicate].map((armRole, position) => ({
        kind: 'evaluation',
        armRole,
        blindArm: blindLabels[armRole],
        shardId: shard.id,
        replicate,
        position,
        stage: 'comparison'
      }))
    ))
  ];
}

export function buildAdaptiveMetaCanaryPlan(config = {}) {
  const target = object(config.target);
  const benchmark = object(config.benchmark);
  const context = object(config.mechanismContext);
  const v2 = isBlindHeldOutV2(config);
  const qualificationOnly = v2 && isQualificationOnly(config);
  const profile = v2 ? ADAPTIVE_META_CANARY : LEGACY_ADAPTIVE_META_CANARY;
  const legacyTargetIdentity = {
    findingId: target.findingId || null,
    baselineSha256: typeof target.baselineContent === 'string'
      ? sha256(target.baselineContent)
      : null,
    hypothesisSha256: sha256(canonicalJson(object(target.hypothesis))),
    benchmarkSha256: Object.keys(benchmark).length
      ? sha256(canonicalJson(benchmark))
      : null,
    evidenceRefs: (Array.isArray(target.evidenceRefs) ? target.evidenceRefs : [])
      .map((item) => ({
        path: item?.path || null,
        locator: item?.locator || null
      }))
      .sort((left, right) => (
        `${left.path}:${left.locator}`.localeCompare(`${right.path}:${right.locator}`)
      ))
  };
  const targetIdentity = v2
    ? {
        ...legacyTargetIdentity,
        proposalBriefSha256: sha256(canonicalJson(object(target.proposalBrief))),
        developmentCasesSha256: sha256(canonicalJson(
          Array.isArray(benchmark.developmentCases) ? benchmark.developmentCases : []
        )),
        evaluationShardsSha256: sha256(canonicalJson(v2EvaluationShards(config)))
      }
    : legacyTargetIdentity;
  const mechanism = planMechanismIdentity(context);
  const blindSeed = sha256(canonicalJson({ targetIdentity, mechanism }));
  const blindLabels = Object.fromEntries(profile.arms.map((arm) => [
    arm,
    `arm-${sha256(`${blindSeed}:${arm}`).slice(0, 12)}`
  ]));
  const fullExecutionSchedule = v2
    ? v2ExecutionSchedule(config, blindLabels)
    : null;
  const v2Contract = v2
    ? {
        ...profile,
        ...(qualificationOnly
          ? {
              executionMode: 'qualification-only',
              proposalCalls: 1,
              evaluationCalls: ADAPTIVE_META_CANARY.evaluationsPerArm,
              totalCalls: ADAPTIVE_META_CANARY.qualificationCalls,
              conditionalCalls: 0
            }
          : {}),
        arms: [...profile.arms],
        proposalSchedule: qualificationOnly
          ? ['baseline']
          : [...PROPOSAL_ARM_ORDER],
        evaluationShardIds: v2EvaluationShards(config).map((item) => item.id),
        comparisonSchedule: ADAPTIVE_META_CANARY_V2_COMPARISON_SCHEDULE
          .map((row) => [...row]),
        executionSchedule: qualificationOnly
          ? fullExecutionSchedule.slice(0, ADAPTIVE_META_CANARY.qualificationCalls)
          : fullExecutionSchedule,
        blindLabels
      }
    : null;
  const basis = {
    schemaVersion: v2 ? 2 : 1,
    profile: profile.profile,
    ...(config.privateEvidencePolicy != null
      ? { privateEvidencePolicy: config.privateEvidencePolicy }
      : {}),
    model: REAL_TEST_MODEL,
    fixtureOnly: config.fixtureOnly === true,
    ...(config.executionMode != null
      ? { executionMode: config.executionMode }
      : {}),
    ...(config.evaluationProcedureNormalization != null
      ? {
          evaluationProcedureNormalization:
            config.evaluationProcedureNormalization
        }
      : {}),
    target: targetIdentity,
    evidenceManifest: evidenceManifest(config),
    ...(v2 ? { heldOutEvidenceManifest: heldOutEvidenceManifest(config) } : {}),
    mechanismEvidenceManifest: mechanismEvidenceManifest(config),
    mechanismEvidenceRefs: (Array.isArray(config.mechanismEvidenceRefs)
      ? config.mechanismEvidenceRefs
      : []).map((item) => ({
      path: item?.path || null,
      locator: item?.locator || null
    })).sort((left, right) => (
      `${left.path}:${left.locator}`.localeCompare(`${right.path}:${right.locator}`)
    )),
    implementationManifest: implementationManifest(config),
    runtimeAuthority: object(config.runtimeAuthority),
    proposalRoutes: Array.isArray(config.proposalRoutes) ? [...config.proposalRoutes] : [],
    evaluationRoutes: Array.isArray(config.evaluationRoutes) ? [...config.evaluationRoutes] : [],
    mechanism,
    contract: v2Contract || {
      ...profile,
      arms: [...profile.arms],
      proposalSchedule: [...PROPOSAL_ARM_ORDER],
      evaluationSchedule: ADAPTIVE_META_CANARY_EVALUATION_SCHEDULE.map((row) => [...row]),
      blindLabels
    }
  };
  return {
    ...basis,
    sha256: sha256(canonicalJson(basis))
  };
}

function inspectMechanismContext(config = {}) {
  const context = object(config.mechanismContext);
  const families = Array.isArray(context.families) ? context.families : [];
  const applications = Array.isArray(context.applications) ? context.applications : [];
  const policyEpoch = context.policyEpoch;
  const routingDecision = context.routingDecision;
  const routedCapsule = context.routedCapsule;
  const shamCapsule = context.shamCapsule;
  const errors = [];

  const validFamilies = families.every((record) => (
    record?.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
    && validateAdaptiveRecord(record).status === 'OK'
  ));
  const validApplications = applications.every((record) => (
    record?.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
    && validateAdaptiveRecord(record).status === 'OK'
  ));
  const policyValid = policyEpoch?.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH
    && validateAdaptiveRecord(policyEpoch).status === 'OK';
  const decisionValid = routingDecision?.schemaVersion === ADAPTIVE_SCHEMA.ROUTING_DECISION
    && validateAdaptiveRecord(routingDecision).status === 'OK';
  if (!families.length || !validFamilies) errors.push('mechanism families are missing or invalid');
  if (!applications.length || !validApplications) errors.push('mechanism applications are missing or invalid');
  if (!policyValid) errors.push('meta-canary policy epoch is invalid');
  if (!decisionValid) errors.push('meta-canary routing decision is invalid');

  const familyIds = new Set(families.map((item) => item.familyId));
  if (applications.some((item) => !familyIds.has(item.familyId))) {
    errors.push('mechanism application references an unknown family');
  }
  const recomputed = policyValid
    ? buildMechanismRoutingDecision({
        families,
        applications,
        target: object(context.routingTarget),
        policyEpoch,
        seed: context.seed,
        hypothesisCount: context.hypothesisCount,
        mode: 'active-canary'
      })
    : null;
  const routingReplay = recomputed?.status === 'OK'
    && canonicalAdaptiveJson(recomputed.decision) === canonicalAdaptiveJson(routingDecision)
    && canonicalAdaptiveJson(recomputed.capsule) === canonicalAdaptiveJson(routedCapsule)
    && canonicalAdaptiveJson(recomputed.candidatePool) === canonicalAdaptiveJson(context.candidatePool);
  if (!routingReplay) errors.push('routing decision, candidate pool, or routed capsule does not replay');

  const primaryFamilyId = String(context.primaryFamilyId || '');
  const capsuleItems = Array.isArray(routedCapsule?.items) ? routedCapsule.items : [];
  const routedItem = capsuleItems.length === 1 ? capsuleItems[0] : null;
  const selectedApplication = routedItem
    ? applications.find((item) => item.applicationReceiptId === routedItem.evidence?.applicationReceiptId)
    : null;
  const primaryBinding = /^family-[a-f0-9]{24}$/.test(primaryFamilyId)
    && routedItem?.familyId === primaryFamilyId
    && selectedApplication?.familyId === primaryFamilyId
    && selectedApplication?.partition === 'harvest'
    && selectedApplication?.eligibleForRouting === true
    && selectedApplication?.outcome?.valid === true
    && selectedApplication?.outcome?.reverified === true
    && selectedApplication?.credit?.positiveEvidence === true;
  if (!primaryBinding) {
    errors.push('routed capsule must bind one reverified positive harvest application');
  }

  const nonHarvestIds = new Set(applications
    .filter((item) => item.partition !== 'harvest')
    .map((item) => item.applicationReceiptId));
  const routedApplicationIds = new Set([
    ...capsuleItems.map((item) => item.evidence?.applicationReceiptId),
    ...(Array.isArray(context.candidatePool) ? context.candidatePool : [])
      .flatMap((item) => (item.applications || []).map((entry) => entry.applicationReceiptId))
  ].filter(Boolean));
  const partitionIsolation = [...nonHarvestIds].every((id) => !routedApplicationIds.has(id));
  if (!partitionIsolation) errors.push('gate or reference evidence crossed into the routed candidate pool');

  const routedCapsuleValid = capsuleIntegrity(routedCapsule)
    && routingDecision?.mechanismCapsuleSha256 === routedCapsule?.mechanismCapsuleSha256;
  if (!routedCapsuleValid) errors.push('routed capsule hash does not bind the routing decision');

  const shamItems = Array.isArray(shamCapsule?.items) ? shamCapsule.items : [];
  const shamValid = capsuleIntegrity(shamCapsule)
    && capsuleSchemaSha256(shamCapsule) === capsuleSchemaSha256(routedCapsule)
    && shamCapsule.mechanismCapsuleSha256 !== routedCapsule?.mechanismCapsuleSha256
    && shamItems.length === capsuleItems.length
    && shamItems.every((item) => (
      item.semantics === 'irrelevant-control'
      && item.instruction === IRRELEVANT_SHAM_INSTRUCTION
      && item.causalFingerprint?.operationKind === 'nonbehavioral-formatting'
      && item.causalFingerprint?.expectedEffectKind === 'no-behavior-change'
      && !familyIds.has(item.familyId)
    ));
  if (!shamValid) errors.push('sham capsule is not a distinct schema-identical irrelevant control');

  return {
    ok: errors.length === 0,
    errors,
    recordsValid: validFamilies && validApplications && policyValid && decisionValid,
    routingReplay,
    primaryBinding,
    partitionIsolation,
    routedCapsuleValid,
    shamValid,
    recomputed
  };
}

function validateEvidence(config, errors, {
  sourcesField = 'evidenceSources',
  manifestField = 'evidenceManifest',
  capsuleField = 'evidenceCapsule',
  label = 'evidence'
} = {}) {
  const sources = Array.isArray(config[sourcesField]) ? config[sourcesField] : [];
  const manifest = normalizedManifest(config, manifestField);
  const capsule = Array.isArray(config[capsuleField]) ? config[capsuleField] : [];
  if (!sources.length || new Set(sources).size !== sources.length) {
    errors.push(`${sourcesField} must contain unique repository-relative paths`);
  }
  const manifestByPath = new Map();
  for (const item of manifest) {
    if (!item.path
        || item.path.startsWith('/')
        || item.path.split(/[\\/]/).includes('..')
        || !Number.isInteger(item.bytes)
        || item.bytes < 0
        || !SHA256_RE.test(String(item.sha256 || ''))
        || manifestByPath.has(item.path)) {
      errors.push(`invalid ${label} manifest entry: ${item.path || '<missing>'}`);
      continue;
    }
    manifestByPath.set(item.path, item);
  }
  if (manifest.length !== sources.length
      || sources.some((path) => !manifestByPath.has(path))) {
    errors.push(`${label} manifest must seal each source exactly once`);
  }
  const capsuleByPath = new Map();
  for (const item of capsule) {
    const sealed = manifestByPath.get(String(item?.path || ''));
    if (!sealed
        || typeof item?.content !== 'string'
        || capsuleByPath.has(item.path)
        || Buffer.byteLength(item.content) !== sealed.bytes
        || sha256(Buffer.from(item.content)) !== sealed.sha256) {
      errors.push(`${label} capsule does not match its manifest: ${item?.path || '<missing>'}`);
      continue;
    }
    capsuleByPath.set(item.path, item);
  }
  if (capsuleByPath.size !== manifestByPath.size) {
    errors.push(`${label} capsule must contain every sealed source`);
  }
  return capsuleByPath;
}

function validateRef(ref, capsuleByPath) {
  const path = String(ref?.path || '');
  const locator = String(ref?.locator || '').trim();
  const source = capsuleByPath.get(path);
  return !!(source && locator && resolveLocator(source.content, locator));
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

function shardEvidenceCapsule(config, shard) {
  const paths = new Set(Array.isArray(shard?.evidencePaths) ? shard.evidencePaths : []);
  return (Array.isArray(config.heldOutEvidenceCapsule)
    ? config.heldOutEvidenceCapsule
    : []).filter((item) => paths.has(item.path));
}

function validateBlindHeldOutV2(config, errors, {
  developmentCapsuleByPath,
  heldOutCapsuleByPath,
  mechanismCapsuleByPath,
  enforcePrivateEvidencePolicy
}) {
  const initialErrorCount = errors.length;
  const target = object(config.target);
  const benchmark = object(config.benchmark);
  const brief = object(target.proposalBrief);
  const developmentCases = Array.isArray(benchmark.developmentCases)
    ? benchmark.developmentCases
    : [];
  const shards = v2EvaluationShards(config);
  const summary = {
    ok: false,
    developmentCaseCount: developmentCases.length,
    shardCount: shards.length,
    shardGameability: [],
    assignedHeldOutPaths: []
  };

  if (typeof brief.title !== 'string' || brief.title.trim().length < 8
      || typeof brief.problem !== 'string' || brief.problem.trim().length < 24) {
    errors.push('v2 target requires a non-prescriptive proposalBrief title and problem');
  }
  const invariants = Array.isArray(brief.invariants) ? brief.invariants : [];
  if (invariants.length < 2
      || invariants.length > 10
      || new Set(invariants).size !== invariants.length
      || invariants.some((item) => typeof item !== 'string' || item.trim().length < 8)) {
    errors.push('v2 proposalBrief requires 2-10 unique substantive invariants');
  }

  if (developmentCases.length < 2 || developmentCases.length > 10) {
    errors.push('v2 benchmark requires 2-10 proposal-visible development cases');
  }
  const developmentIds = developmentCases.map((item) => String(item?.id || ''));
  if (developmentIds.some((id) => !id)
      || new Set(developmentIds).size !== developmentIds.length
      || developmentCases.some((item) => (
        typeof item?.prompt !== 'string'
        || item.prompt.trim().length < 8
        || !validateRef(item.evidenceRef, developmentCapsuleByPath)
      ))) {
    errors.push('v2 development cases require unique IDs, prompts, and resolvable development evidence');
  }

  if (shards.length !== ADAPTIVE_META_CANARY.evaluationsPerArm) {
    errors.push('v2 benchmark requires exactly five evaluator-only held-out shards');
  }
  const shardIds = shards.map((item) => String(item?.id || ''));
  if (shardIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id))
      || new Set(shardIds).size !== shardIds.length) {
    errors.push('v2 held-out shard IDs must be unique safe identifiers');
  }

  const assignedPaths = [];
  const hiddenCaseIds = [];
  const hiddenCaseShapes = [];
  const hiddenNeedles = [];
  const targetChallengeSignatures = [];
  for (const shard of shards) {
    const shardId = String(shard?.id || '<missing>');
    const paths = Array.isArray(shard?.evidencePaths) ? shard.evidencePaths.map(String) : [];
    if (!paths.length
        || new Set(paths).size !== paths.length
        || paths.some((path) => !heldOutCapsuleByPath.has(path))) {
      errors.push(`held-out shard ${shardId} must bind unique sealed evidence paths`);
    }
    assignedPaths.push(...paths);
    const pathSet = new Set(paths);
    const cases = Array.isArray(shard?.cases) ? shard.cases : [];
    const oracle = object(shard?.oracle);
    const oracleCases = Array.isArray(oracle.cases) ? oracle.cases : [];
    if (cases.length < 3 || cases.length > 10) {
      errors.push(`held-out shard ${shardId} must contain 3-10 cases`);
    }
    const caseIds = cases.map((item) => String(item?.id || ''));
    const oracleIds = oracleCases.map((item) => String(item?.caseId || ''));
    if (caseIds.some((id) => !id)
        || new Set(caseIds).size !== caseIds.length
        || stableJson(caseIds) !== stableJson(oracleIds)) {
      errors.push(`held-out shard ${shardId} case and oracle IDs must be unique and identically ordered`);
    }
    if (cases.some((item) => (
      typeof item?.prompt !== 'string'
      || item.prompt.trim().length < 8
      || !validateRef(item.evidenceRef, heldOutCapsuleByPath)
      || !pathSet.has(item.evidenceRef?.path)
    ))) {
      errors.push(`held-out shard ${shardId} cases must resolve only inside that shard`);
    }
    if (oracle.kind !== CASE_RESULTS_ORACLE_KIND_V2 || !isCaseResultsOracle(oracle)) {
      errors.push(`held-out shard ${shardId} oracle must use ${CASE_RESULTS_ORACLE_KIND_V2}`);
    }
    const groups = new Set(oracleCases.map((item) => item.group));
    if (!groups.has('target') || !groups.has('control')) {
      errors.push(`held-out shard ${shardId} requires target and control groups`);
    }
    for (const oracleCase of oracleCases) {
      const visible = cases.find((item) => item.id === oracleCase.caseId);
      if (oracleCase.group === 'target'
          && (!validateRef(visible?.baselineFailureRef, heldOutCapsuleByPath)
            || !pathSet.has(visible?.baselineFailureRef?.path))) {
        errors.push(`target case ${oracleCase.caseId} lacks a shard-local baseline failure`);
      }
      if (oracleCase.group === 'target' && visible) {
        targetChallengeSignatures.push(stableJson({
          evidenceLocator: visible.evidenceRef?.locator || null,
          baselineFailureLocator: visible.baselineFailureRef?.locator || null,
          accepted: oracleCase.accepted,
          code: oracleCase.code || null
        }));
      }
      if (oracleCase.group === 'target'
          && typeof oracleCase.code === 'string'
          && oracleCase.code.length >= 4
          && !String(target.baselineContent || '').includes(oracleCase.code)) {
        hiddenNeedles.push(oracleCase.code);
      }
      const required = [
        ...(Array.isArray(oracleCase.requiredEvidence) ? oracleCase.requiredEvidence : [])
          .map((item) => item?.path),
        ...(Array.isArray(oracleCase.requiredEvidencePaths)
          ? oracleCase.requiredEvidencePaths
          : [])
      ];
      if (!required.length || required.some((path) => !pathSet.has(path))) {
        errors.push(`oracle case ${oracleCase.caseId || '<missing>'} leaves held-out shard ${shardId}`);
      }
    }
    const gameability = evaluateCaseResultsGameability(oracle);
    summary.shardGameability.push({ shardId, ...gameability });
    if (!gameability.ok) {
      errors.push(`held-out shard ${shardId} gameability failed: ${gameability.reason || 'unknown reason'}`);
    }
    for (const item of cases) {
      hiddenCaseIds.push(String(item?.id || ''));
      hiddenCaseShapes.push(stableJson(workerVisibleCase(item)));
      hiddenNeedles.push(
        String(item?.id || ''),
        String(item?.prompt || ''),
        String(item?.evidenceRef?.path || ''),
        String(item?.evidenceRef?.locator || ''),
        String(item?.baselineFailureRef?.locator || '')
      );
    }
  }
  summary.assignedHeldOutPaths = [...assignedPaths];

  const heldOutPaths = [...heldOutCapsuleByPath.keys()].sort();
  if (new Set(assignedPaths).size !== assignedPaths.length
      || stableJson([...assignedPaths].sort()) !== stableJson(heldOutPaths)) {
    errors.push('every held-out evidence source must belong to exactly one shard');
  }
  if (new Set(hiddenCaseIds).size !== hiddenCaseIds.length
      || hiddenCaseIds.some((id) => developmentIds.includes(id))
      || new Set(hiddenCaseShapes).size !== hiddenCaseShapes.length) {
    errors.push('development and held-out cases must be globally distinct');
  }
  if (new Set(targetChallengeSignatures).size !== targetChallengeSignatures.length) {
    errors.push('held-out target challenges must have distinct evidence and failure signatures');
  }
  for (const shard of shards) {
    const shardVisible = [
      String(shard?.id || ''),
      ...(Array.isArray(shard?.evidencePaths) ? shard.evidencePaths.map(String) : []),
      ...(Array.isArray(shard?.cases) ? shard.cases : []).flatMap((item) => [
        String(item?.id || ''),
        String(item?.prompt || ''),
        String(item?.evidenceRef?.path || ''),
        String(item?.evidenceRef?.locator || ''),
        String(item?.baselineFailureRef?.path || ''),
        String(item?.baselineFailureRef?.locator || '')
      ])
    ].join('\n');
    const otherShardNeedles = shards
      .filter((candidate) => candidate !== shard)
      .flatMap((candidate) => [
        String(candidate?.id || ''),
        ...(Array.isArray(candidate?.evidencePaths)
          ? candidate.evidencePaths.map(String)
          : []),
        ...(Array.isArray(candidate?.cases) ? candidate.cases : []).flatMap((item) => [
          String(item?.id || ''),
          String(item?.prompt || ''),
          String(item?.evidenceRef?.locator || '')
        ])
      ])
      .filter((needle) => needle.length >= 8);
    if (otherShardNeedles.some((needle) => shardVisible.includes(needle))) {
      errors.push(
        `held-out shard ${shard?.id || '<missing>'} contains another shard's identity, prompt, locator, or path`
      );
    }
  }

  const developmentPaths = new Set(developmentCapsuleByPath.keys());
  const privatePaths = new Set(mechanismCapsuleByPath.keys());
  if (heldOutPaths.some((path) => developmentPaths.has(path) || privatePaths.has(path))) {
    errors.push('development, held-out, and private mechanism evidence must be path-disjoint');
  }
  const developmentHashes = new Set([...developmentCapsuleByPath.values()]
    .map((item) => sha256(Buffer.from(item.content))));
  const privateHashes = new Set([...mechanismCapsuleByPath.values()]
    .map((item) => sha256(Buffer.from(item.content))));
  const heldOutHashes = [...heldOutCapsuleByPath.values()]
    .map((item) => sha256(Buffer.from(item.content)));
  if (new Set(heldOutHashes).size !== heldOutHashes.length) {
    errors.push('held-out evidence sources must be byte-distinct');
  }
  if (heldOutHashes.some((digest) => {
    return developmentHashes.has(digest) || privateHashes.has(digest);
  })) {
    errors.push('development, held-out, and private mechanism evidence must be content-disjoint');
  }

  const proposalVisible = canonicalJson({
    baselineContent: target.baselineContent,
    proposalBrief: brief,
    developmentCases: developmentCases.map(workerVisibleCase),
    evidenceRefs: target.evidenceRefs,
    evidenceCapsule: config.evidenceCapsule
  });
  if (hiddenNeedles.filter((needle) => needle.length >= 8)
    .some((needle) => proposalVisible.includes(needle))) {
    errors.push('held-out case identity, prompt, locator, or path leaked into proposal-visible inputs');
  }
  if (enforcePrivateEvidencePolicy) {
    const workerVisiblePartitions = [
      String(target.baselineContent || ''),
      String(brief.title || ''),
      String(brief.problem || ''),
      ...invariants.map(String),
      ...developmentCases.flatMap((item) => [
        String(item?.id || ''),
        String(item?.prompt || ''),
        String(item?.evidenceRef?.path || ''),
        String(item?.evidenceRef?.locator || '')
      ]),
      ...[...developmentCapsuleByPath.values(), ...heldOutCapsuleByPath.values()]
        .flatMap((item) => [
          String(item?.path || ''),
          String(item?.content || '')
        ]),
      ...shards.flatMap((shard) => [
        String(shard?.id || ''),
        ...(Array.isArray(shard?.evidencePaths) ? shard.evidencePaths.map(String) : []),
        ...(Array.isArray(shard?.cases) ? shard.cases : []).flatMap((item) => [
          String(item?.id || ''),
          String(item?.prompt || ''),
          String(item?.evidenceRef?.path || ''),
          String(item?.evidenceRef?.locator || ''),
          String(item?.baselineFailureRef?.path || ''),
          String(item?.baselineFailureRef?.locator || '')
        ])
      ])
    ].join('\n');
    const privateMechanismNeedles = [
      ...mechanismCapsuleByPath.values()
    ].flatMap((item) => [
      String(item?.path || ''),
      String(item?.content || '')
    ]).concat(
      (Array.isArray(config.mechanismEvidenceRefs) ? config.mechanismEvidenceRefs : [])
        .map((item) => String(item?.locator || ''))
    ).filter((needle) => needle.length >= 8);
    if (privateMechanismNeedles.some((needle) => workerVisiblePartitions.includes(needle))) {
      errors.push('private mechanism evidence leaked into worker-visible partitions');
    }
  }
  for (const field of ['operation', 'expectedMovement']) {
    const treatment = String(target.hypothesis?.[field] || '').trim();
    if (treatment.length >= 12 && proposalVisible.includes(treatment)) {
      errors.push(`supervisor-only hypothesis ${field} leaked into proposal-visible inputs`);
    }
  }

  summary.ok = errors.length === initialErrorCount;
  return summary;
}

export function validateAdaptiveMetaCanaryConfig(config = {}, {
  requireApproval = true,
  allowLegacy = false,
  allowHistoricalPrivateEvidencePolicy = false,
  allowHistoricalEvaluationNormalization = false
} = {}) {
  const errors = [];
  const v2 = isBlindHeldOutV2(config);
  const target = object(config.target);
  const hypothesis = object(target.hypothesis);
  const benchmark = object(config.benchmark);
  const visibleCases = Array.isArray(benchmark.cases) ? benchmark.cases : [];
  const oracle = object(benchmark.oracle);
  const oracleCases = Array.isArray(oracle.cases) ? oracle.cases : [];
  const proposalRoutes = Array.isArray(config.proposalRoutes) ? config.proposalRoutes : [];
  const evaluationRoutes = Array.isArray(config.evaluationRoutes) ? config.evaluationRoutes : [];
  const plan = buildAdaptiveMetaCanaryPlan(config);

  if (!v2 && !allowLegacy) {
    errors.push(`schemaVersion must be ${ADAPTIVE_META_CANARY_SCHEMA_VERSION}; v1 is verification-only`);
  }
  const historicalPrivateEvidencePolicy = v2
    && allowHistoricalPrivateEvidencePolicy
    && config.privateEvidencePolicy == null;
  if (v2
      && !historicalPrivateEvidencePolicy
      && config.privateEvidencePolicy !== ADAPTIVE_META_CANARY_PRIVATE_EVIDENCE_POLICY) {
    errors.push(
      `privateEvidencePolicy must be ${ADAPTIVE_META_CANARY_PRIVATE_EVIDENCE_POLICY}`
    );
  }
  const historicalEvaluationNormalization = v2
    && allowHistoricalEvaluationNormalization
    && config.evaluationProcedureNormalization == null;
  if (v2
      && !historicalEvaluationNormalization
      && config.evaluationProcedureNormalization
        !== ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION) {
    errors.push(
      `evaluationProcedureNormalization must be ${ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION}`
    );
  }
  if (config.executionMode != null
      && !ADAPTIVE_META_CANARY_EXECUTION_MODES.includes(config.executionMode)) {
    errors.push('executionMode must be full or qualification-only');
  }
  if (config.model !== REAL_TEST_MODEL) errors.push(`model must be ${REAL_TEST_MODEL}`);
  const requiredProposalRoutes = isQualificationOnly(config)
    ? 1
    : ADAPTIVE_META_CANARY.proposalCalls;
  if (proposalRoutes.length !== requiredProposalRoutes
      || proposalRoutes.some((route) => route !== REAL_TEST_MODEL)) {
    errors.push(`proposalRoutes must contain exactly ${requiredProposalRoutes} ${REAL_TEST_MODEL} entries`);
  }
  if (evaluationRoutes.length !== ADAPTIVE_META_CANARY.evaluationsPerArm
      || evaluationRoutes.some((route) => route !== REAL_TEST_MODEL)) {
    errors.push(`evaluationRoutes must contain exactly ${ADAPTIVE_META_CANARY.evaluationsPerArm} ${REAL_TEST_MODEL} entries`);
  }
  if (!/^finding-\d{3}$/.test(String(target.findingId || ''))) {
    errors.push('target requires one immutable findingId');
  }
  if (!checkBaselineIntegrity(target.baselineContent).ok) {
    errors.push('target requires a complete immutable baselineContent procedure');
  }
  if (!checkHypothesisIntegrity(hypothesis, [hypothesis]).ok) {
    errors.push('target requires one substantive hypothesis');
  }
  if (typeof config.fixtureOnly !== 'boolean') {
    errors.push('fixtureOnly must explicitly state whether activation evidence is real');
  }
  if (config.historicalTokenEstimate != null
      && (!Number.isInteger(config.historicalTokenEstimate)
        || config.historicalTokenEstimate <= 0)) {
    errors.push('historicalTokenEstimate must be a positive non-binding integer when supplied');
  }

  const capsuleByPath = validateEvidence(config, errors);
  const heldOutCapsuleByPath = v2
    ? validateEvidence(config, errors, {
        sourcesField: 'heldOutEvidenceSources',
        manifestField: 'heldOutEvidenceManifest',
        capsuleField: 'heldOutEvidenceCapsule',
        label: 'held-out evidence'
      })
    : new Map();
  const mechanismCapsuleByPath = validateEvidence(config, errors, {
    sourcesField: 'mechanismEvidenceSources',
    manifestField: 'mechanismEvidenceManifest',
    capsuleField: 'mechanismEvidenceCapsule',
    label: 'mechanism evidence'
  });
  const commonPaths = new Set(capsuleByPath.keys());
  if ([...mechanismCapsuleByPath.keys()].some((path) => commonPaths.has(path))) {
    errors.push('common target evidence and private mechanism evidence must be path-disjoint');
  }
  const commonContentHashes = new Set(
    [...capsuleByPath.values()].map((item) => sha256(Buffer.from(item.content)))
  );
  if ([...mechanismCapsuleByPath.values()]
    .some((item) => commonContentHashes.has(sha256(Buffer.from(item.content))))) {
    errors.push('common target evidence and private mechanism evidence must be content-disjoint');
  }
  const blindHeldOut = v2
    ? validateBlindHeldOutV2(config, errors, {
      developmentCapsuleByPath: capsuleByPath,
      heldOutCapsuleByPath,
      mechanismCapsuleByPath,
      enforcePrivateEvidencePolicy: !historicalPrivateEvidencePolicy
    })
    : null;
  const implementation = inspectImplementation(config, errors);
  const runtimeAuthority = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtimeAuthority.status !== 'OK'
      || runtimeAuthority.record.requestedModel !== REAL_TEST_MODEL
      || runtimeAuthority.record.reasoningEffort !== STRICT_CODEX_REASONING_EFFORT) {
    errors.push('runtimeAuthority must bind ChatGPT OAuth, exact gpt-5.6-sol, and high reasoning');
  }
  const evidenceRefs = Array.isArray(target.evidenceRefs) ? target.evidenceRefs : [];
  if (!evidenceRefs.length || evidenceRefs.some((ref) => !validateRef(ref, capsuleByPath))) {
    errors.push('every target evidenceRef must resolve inside the sealed evidence capsule');
  }
  const mechanismEvidenceRefs = Array.isArray(config.mechanismEvidenceRefs)
    ? config.mechanismEvidenceRefs
    : [];
  if (!mechanismEvidenceRefs.length
      || mechanismEvidenceRefs.some((ref) => !validateRef(ref, mechanismCapsuleByPath))) {
    errors.push('every mechanismEvidenceRef must resolve inside private sealed mechanism evidence');
  }

  let gameability = blindHeldOut
    ? {
        ok: blindHeldOut.shardGameability.every((item) => item.ok),
        shards: blindHeldOut.shardGameability
      }
    : null;
  if (!v2) {
    if (oracle.kind !== CASE_RESULTS_ORACLE_KIND_V2 || !isCaseResultsOracle(oracle)) {
      errors.push(`benchmark oracle must use ${CASE_RESULTS_ORACLE_KIND_V2}`);
    }
    if (visibleCases.length < 6 || visibleCases.length > 10) {
      errors.push('benchmark must contain 6-10 visible cases');
    }
    if (oracleCases.length !== visibleCases.length) {
      errors.push('visible and oracle case counts must match');
    }
    const visibleIds = visibleCases.map((item) => String(item?.id || ''));
    const oracleIds = oracleCases.map((item) => String(item?.caseId || ''));
    if (visibleIds.some((id) => !id)
        || new Set(visibleIds).size !== visibleIds.length
        || stableJson(visibleIds) !== stableJson(oracleIds)) {
      errors.push('visible and oracle case IDs must be unique and identically ordered');
    }
    const groups = new Set(oracleCases.map((item) => item.group));
    if (!groups.has('target') || !groups.has('control')) {
      errors.push('oracle requires target and control groups');
    }
    for (const oracleCase of oracleCases.filter((item) => item.group === 'target')) {
      const visible = visibleCases.find((item) => item.id === oracleCase.caseId);
      if (!validateRef(visible?.baselineFailureRef, capsuleByPath)) {
        errors.push(`target case ${oracleCase.caseId} lacks a resolvable pre-existing baseline failure`);
      }
    }
    gameability = evaluateCaseResultsGameability(oracle);
    if (!gameability.ok) {
      errors.push(`benchmark gameability failed: ${gameability.reason || 'unknown reason'}`);
    }
    const manifestPaths = new Set(evidenceManifest(config).map((item) => item.path));
    for (const oracleCase of oracleCases) {
      const required = [
        ...(Array.isArray(oracleCase.requiredEvidence) ? oracleCase.requiredEvidence : [])
          .map((item) => item?.path),
        ...(Array.isArray(oracleCase.requiredEvidencePaths)
          ? oracleCase.requiredEvidencePaths
          : [])
      ];
      if (!required.length || required.some((path) => !manifestPaths.has(path))) {
        errors.push(`oracle case ${oracleCase.caseId || '<missing>'} leaves the sealed evidence partition`);
      }
    }
  }

  const mechanism = inspectMechanismContext(config);
  errors.push(...mechanism.errors);
  if (/\[(?:OPERATOR|REPLACE|REAL_|CASE_|ORACLE_|SUBSTANTIAL|EXPECTED)|PLACEHOLDER|TODO/i.test(
    canonicalJson({ target, benchmark })
  )) {
    errors.push('target and benchmark contain unresolved placeholders');
  }
  if (requireApproval && config.approvedPlanSha256 !== plan.sha256) {
    errors.push('meta-canary plan is not operator-approved');
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    plan,
    mechanism,
    implementation,
    runtimeAuthority,
    gameability,
    blindHeldOut
  };
}

export function expectedAdaptiveMetaCanarySchedule(plan) {
  if (plan?.profile === ADAPTIVE_META_CANARY.profile) {
    return (plan.contract?.executionSchedule || [])
      .filter((item) => item.kind === 'evaluation')
      .map((item) => ({ ...item }));
  }
  return (plan?.contract?.evaluationSchedule || []).flatMap((row, replicate) => (
    row.map((armRole, position) => ({
      armRole,
      blindArm: plan.contract.blindLabels[armRole],
      replicate,
      position
    }))
  ));
}

function oracleForGroup(oracle, group) {
  return {
    ...oracle,
    cases: (oracle?.cases || []).filter((item) => item.group === group)
  };
}

function groupQuality(content, oracle, group) {
  const grouped = oracleForGroup(oracle, group);
  const expected = new Set(grouped.cases.map((item) => String(item.caseId)));
  const parsed = parseCaseResults(content, { allowProposalWrappers: false });
  if (!parsed.ok || grouped.cases.length === 0) return null;
  const rows = parsed.results.filter((item) => expected.has(String(item?.caseId || '')));
  return scoreCaseResults(`<CASE_RESULTS>${JSON.stringify(rows)}</CASE_RESULTS>`, grouped);
}

function persistCallInputs(store, runId, prefix, contract) {
  // Preserve insertion order because JSON.stringify order is part of the exact
  // prompt bytes produced by buildExecutorPrompt.
  const contractContent = JSON.stringify(contract);
  const contractArtifact = writeCanaryArtifact(store, runId, `${prefix}-contract`, {
    role: 'worker-contract',
    content: contractContent
  });
  const promptContent = buildExecutorPrompt({ ...contract, outputSchemaMode: true });
  const promptArtifact = writeCanaryArtifact(store, runId, `${prefix}-prompt`, {
    role: 'worker-prompt',
    content: promptContent
  });
  return {
    contractArtifactRef: contractArtifact.id,
    contractSha256: contractArtifact.sha256,
    promptArtifactRef: promptArtifact.id,
    promptArtifactSha256: promptArtifact.sha256
  };
}

function evidenceArtifact(store, runId, id, role, value) {
  const artifact = writeCanaryArtifact(store, runId, id, {
    role,
    content: stableJson(value)
  });
  return { id: artifact.id, sha256: artifact.sha256 };
}

function renderAdaptiveMetaCanaryReport(state) {
  const verification = state.verification || {};
  const outcome = verification.outcome || {};
  const measured = (value, suffix = '') => value == null ? 'unmeasured' : `${value}${suffix}`;
  const lines = [
    '# Loop Factory Adaptive Meta-Canary',
    '',
    `- **run**: \`${state.runId}\``,
    `- **status**: ${state.status}`,
    `- **design**: ${state.plan?.profile || state.designVersion || 'unknown'}`,
    `- **experiment valid**: ${verification.experimentValid === true}`,
    `- **activation eligible**: ${verification.activationEligible === true}`,
    `- **causal outcome**: ${outcome.status || 'UNKNOWN'}`,
    `- **model**: ${state.model}`,
    `- **plan sha256**: \`${state.plan.sha256}\``,
    `- **verification sha256**: \`${verification.evidenceSha256 || 'missing'}\``,
    ...(state.blocker ? [`- **blocker**: \`${state.blocker.code}\` - ${state.blocker.message}`] : []),
    ...(state.qualification ? [
      `- **headroom qualification**: ${state.qualification.status}`,
      `- **qualification failures**: ${measured(state.qualification.observedBaselineFailures, '/5')}`
    ] : []),
    '- **promotion**: disabled',
    '',
    '## Gates',
    '',
    '| gate | result |',
    '|---|---|',
    ...Object.entries(verification.gates || {})
      .map(([name, passed]) => `| ${name} | ${passed ? 'PASS' : 'FAIL'} |`),
    '',
    '## Causal Result',
    '',
    `- no-memory control target failures: ${measured(outcome.baselineTargetFailures, '/5')}`,
    `- routed paired target wins: ${measured(outcome.routedPairedTargetWins, '/5')}`,
    `- sham target wins: ${measured(outcome.shamTargetWins)}`,
    `- routed control regressions: ${measured(outcome.controlRegressions)}`,
    `- observed calls: ${verification.tokenUsage?.observedCalls ?? 0}`,
    `- proposal tokens: ${verification.tokenUsage?.proposalTotal ?? 'unmeasured'}`,
    `- evaluation tokens: ${verification.tokenUsage?.evaluationTotal ?? 'unmeasured'}`,
    `- rejected-dispatch tokens: ${verification.tokenUsage?.failedDispatchTotal ?? 'unmeasured'}`,
    '',
    'This report proves only the persisted experiment. It does not promote a loop or alter the controller.'
  ];
  return `${lines.join('\n')}\n`;
}

function proposalMechanism(config, armRole) {
  if (armRole === 'routed') return config.mechanismContext.routedCapsule;
  if (armRole === 'sham') return config.mechanismContext.shamCapsule;
  return null;
}

const LEGACY_PROPOSAL_TASK =
  'Produce one complete procedure for the frozen finding. Use only the frozen target, hypothesis, evidence, and assigned mechanism if present. Do not evaluate or score it.';
const BLIND_PROPOSAL_TASK =
  'Diagnose the proposal-visible development evidence and produce one complete procedure revision. Hidden evaluation shards and expected outputs are unavailable. Use an assigned mechanism only when present. Do not evaluate or score the procedure.';
const BLIND_EVALUATION_TASK =
  'Apply the active procedure exactly as written to every evaluator-only case. Return observations only; do not infer hidden groups, compare arms, revise the procedure, or report a score.';
const LEGACY_EVALUATION_TASK =
  'Apply the active procedure to every frozen case. Return observations only; do not compare arms or report a score.';

function buildMetaCanaryProposalContract(config, target, hypothesis, armRole, route) {
  const v2 = isBlindHeldOutV2(config);
  const brief = object(config.target?.proposalBrief);
  return compilePhaseContract('loop-de-loop', 1, {
    kind: 'proposal',
    route,
    task: v2 ? BLIND_PROPOSAL_TASK : LEGACY_PROPOSAL_TASK,
    requirements: v2 ? [...(brief.invariants || [])] : [],
    target: v2
      ? {
          ...target,
          title: brief.title,
          evidenceRefs: config.target.evidenceRefs
        }
      : target,
    hypothesis: v2
      ? {
          id: hypothesis.id,
          title: brief.title,
          bottleneck: brief.problem
        }
      : hypothesis,
    frozenCases: v2
      ? (config.benchmark.developmentCases || []).map(workerVisibleCase)
      : config.benchmark.cases,
    evidenceCapsule: config.evidenceCapsule,
    mechanismCapsule: proposalMechanism(config, armRole),
    toolPolicy: 'none'
  });
}

function evaluationShard(config, item) {
  return isBlindHeldOutV2(config)
    ? v2EvaluationShards(config).find((shard) => shard.id === item.shardId)
    : null;
}

function evaluationOracle(config, item) {
  return isBlindHeldOutV2(config)
    ? evaluationShard(config, item)?.oracle
    : config.benchmark.oracle;
}

function buildMetaCanaryEvaluationContract(
  config,
  target,
  hypothesis,
  item,
  route,
  procedureContent
) {
  const v2 = isBlindHeldOutV2(config);
  const shard = evaluationShard(config, item);
  const normalizedProcedure = normalizeAdaptiveMetaCanaryEvaluationProcedure(
    config,
    procedureContent
  );
  const procedureSha256 = sha256(normalizedProcedure);
  return compilePhaseContract('loop-de-loop', 1, {
    kind: 'evaluation',
    evaluationArm: item.blindArm,
    route,
    task: v2 ? BLIND_EVALUATION_TASK : LEGACY_EVALUATION_TASK,
    target: {
      findingId: target.findingId,
      title: v2 ? null : target.title,
      baselineArtifactId: target.baselineArtifactId,
      baselineSha256: target.baselineSha256,
      evidenceRefs: v2
        ? uniqueCaseEvidenceRefs(shard?.cases)
        : target.evidenceRefs
    },
    hypothesis: { id: hypothesis.id },
    frozenCases: v2
      ? (shard?.cases || []).map(workerVisibleCase)
      : config.benchmark.cases,
    evidenceCapsule: v2
      ? shardEvidenceCapsule(config, shard)
      : config.evidenceCapsule,
    mechanismCapsule: null,
    procedureContent: normalizedProcedure,
    procedureSha256,
    toolPolicy: 'none'
  });
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

export function runAdaptiveMetaCanary(store, config, {
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
      message: `run "${runId}" already exists; meta-canary runs are append-only`
    };
  }
  if (typeof worker !== 'function') {
    return { status: 'BLOCKED', code: 'NO_WORKER', message: 'meta-canary requires a worker backend' };
  }
  const validation = validateAdaptiveMetaCanaryConfig(config);
  if (!validation.ok) {
    return {
      status: 'BLOCKED',
      code: 'META_CANARY_CONFIG',
      errors: validation.errors,
      plan: validation.plan
    };
  }
  const plan = validation.plan;
  const createdAt = clock();
  const target = {
    findingId: config.target.findingId,
    title: config.target.title || config.target.findingId,
    baselineArtifactId: 'baseline-procedure',
    baselineSha256: plan.target.baselineSha256,
    baselineContent: config.target.baselineContent,
    evidenceRefs: config.target.evidenceRefs.map((item) => ({ ...item }))
  };
  const hypothesis = {
    id: `${target.findingId}-meta-h1`,
    ...config.target.hypothesis
  };
  const state = {
    schemaVersion: 1,
    kind: 'adaptive-meta-canary',
    designVersion: plan.profile,
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
    verdictEvents: [],
    failureEvidence: [],
    qualification: isBlindHeldOutV2(config)
      ? {
          status: 'PENDING',
          executionMode: config.executionMode || 'full',
          requiredBaselineFailures: ADAPTIVE_META_CANARY.qualificationBaselineFailures,
          observedBaselineFailures: null,
          observedBaselineControlFailures: null,
          callsBeforeDecision: ADAPTIVE_META_CANARY.qualificationCalls
        }
      : null,
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
    config: evidenceArtifact(store, runId, 'sealed-meta-canary-config', 'config', config),
    benchmark: evidenceArtifact(store, runId, 'frozen-benchmark', 'benchmark', config.benchmark),
    evidenceCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-evidence-capsule',
      'evidence-capsule',
      config.evidenceCapsule
    ),
    ...(isBlindHeldOutV2(config)
      ? {
          heldOutEvidenceCapsule: evidenceArtifact(
            store,
            runId,
            'sealed-held-out-evidence-capsule',
            'held-out-evidence-capsule',
            config.heldOutEvidenceCapsule
          )
        }
      : {}),
    mechanismEvidenceCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-private-mechanism-evidence',
      'mechanism-evidence-capsule',
      config.mechanismEvidenceCapsule
    ),
    runtimeAuthority: evidenceArtifact(
      store,
      runId,
      'sealed-codex-oauth-authority',
      'runtime-authority',
      config.runtimeAuthority
    ),
    implementationCapsule: evidenceArtifact(
      store,
      runId,
      'sealed-meta-canary-implementation',
      'implementation-capsule',
      config.implementationCapsule
    ),
    families: config.mechanismContext.families.map((record, index) => (
      evidenceArtifact(store, runId, `mechanism-family-${index + 1}`, 'adaptive-record', record)
    )),
    applications: config.mechanismContext.applications.map((record, index) => (
      evidenceArtifact(store, runId, `mechanism-application-${index + 1}`, 'adaptive-record', record)
    )),
    policyEpoch: evidenceArtifact(
      store,
      runId,
      'meta-policy-epoch',
      'adaptive-record',
      config.mechanismContext.policyEpoch
    ),
    routingDecision: evidenceArtifact(
      store,
      runId,
      'routing-decision',
      'adaptive-record',
      config.mechanismContext.routingDecision
    ),
    candidatePool: evidenceArtifact(
      store,
      runId,
      'candidate-pool',
      'routing-candidate-pool',
      config.mechanismContext.candidatePool
    ),
    routedCapsule: evidenceArtifact(
      store,
      runId,
      'routed-mechanism-capsule',
      'mechanism-capsule',
      config.mechanismContext.routedCapsule
    ),
    shamCapsule: evidenceArtifact(
      store,
      runId,
      'sham-mechanism-capsule',
      'mechanism-capsule',
      config.mechanismContext.shamCapsule
    )
  };
  const proposalSchemaArtifact = writeCanaryArtifact(store, runId, 'proposal-output-schema', {
    role: 'output-schema',
    content: proposalSchema
  });
  const evaluationSchemaArtifact = writeCanaryArtifact(store, runId, 'evaluation-output-schema', {
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

  const block = (code, message) => {
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.updatedAt = clock();
    store.save(state);
    state.verification = verifyAdaptiveMetaCanaryRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-meta-canary-report.md',
      renderAdaptiveMetaCanaryReport(state)
    );
    store.save(state);
    return {
      status: 'BLOCKED',
      code,
      message,
      runId,
      reportPath: state.reportPath,
      verification: state.verification
    };
  };

  const finish = (status) => {
    state.status = status;
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
    state.verification = verifyAdaptiveMetaCanaryRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-meta-canary-report.md',
      renderAdaptiveMetaCanaryReport(state)
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

  const procedures = {};
  const executeProposal = (armRole) => {
    const position = PROPOSAL_ARM_ORDER.indexOf(armRole);
    const blindArm = plan.contract.blindLabels[armRole];
    const route = config.proposalRoutes[position];
    const mechanismCapsule = proposalMechanism(config, armRole);
    const contract = buildMetaCanaryProposalContract(
      config,
      target,
      hypothesis,
      armRole,
      route
    );
    const prefix = `proposal-p${position + 1}`;
    const inputs = persistCallInputs(store, runId, prefix, contract);
    const dispatch = dispatchWorker(contract, worker, {
      maxRetries: ADAPTIVE_META_CANARY.retriesPerDispatch,
      onVerdict: (event) => state.verdictEvents.push({
        kind: 'proposal',
        armRole,
        blindArm,
        position,
        accepted: event.accepted,
        reasons: event.reasons,
        attempt: event.attempt,
        invocation: event.invocation || null
      })
    });
    store.save(state);
    if (!dispatch.accepted) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `${prefix}-failed`,
          kind: 'proposal',
          reasons: dispatch.reasons,
          attempt: dispatch.attempt,
          context: { armRole, blindArm, position, ...inputs }
        }
      ));
      store.save(state);
      return { blocked: block('PROPOSAL_INVALID', `${armRole}: ${dispatch.reasons.join(',')}`) };
    }
    if (!invocationMatchesRuntimeAuthority(config, dispatch.packet?.invocation)) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `${prefix}-authority-failed`,
          kind: 'proposal',
          reasons: ['MODEL_AUTHORITY_UNPROVEN'],
          attempt: dispatch.attempt,
          context: { armRole, blindArm, position, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'MODEL_AUTHORITY_UNPROVEN',
          `${armRole}: OAuth catalog, executable, explicit route, or backend identity mismatch`
        )
      };
    }
    const persisted = persistCanaryProposal(store, runId, dispatch.packet, route, {
      artifactPrefix: prefix
    });
    if (!persisted.ok) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `${prefix}-receipt-failed`,
          kind: 'proposal',
          reasons: [persisted.reason],
          attempt: dispatch.attempt,
          context: { armRole, blindArm, position, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block('PROPOSAL_RECEIPT_INVALID', `${armRole}: ${persisted.reason}`)
      };
    }
    state.proposals.push({
      ...persisted.record,
      armRole,
      blindArm,
      position,
      mechanismCapsuleSha256: mechanismCapsule?.mechanismCapsuleSha256 || null,
      primaryFamilyId: armRole === 'routed'
        ? config.mechanismContext.primaryFamilyId
        : null,
      routingDecisionId: armRole === 'routed'
        ? config.mechanismContext.routingDecision.routingDecisionId
        : null,
      policyEpochId: armRole === 'routed'
        ? config.mechanismContext.policyEpoch.policyEpochId
        : null,
      ...inputs
    });
    procedures[armRole] = persisted.revisedContent;
    state.updatedAt = clock();
    store.save(state);
    return { blocked: null };
  };

  const executeEvaluation = (item) => {
    const route = config.evaluationRoutes[item.replicate];
    const procedureContent = procedures[item.armRole];
    const contract = buildMetaCanaryEvaluationContract(
      config,
      target,
      hypothesis,
      item,
      route,
      procedureContent
    );
    const procedureSha256 = contract.procedureSha256;
    const prefix = isBlindHeldOutV2(config)
      ? `evaluation-s${item.replicate + 1}-${item.armRole}`
      : `evaluation-r${item.replicate + 1}-p${item.position + 1}`;
    const inputs = persistCallInputs(store, runId, prefix, contract);
    const dispatch = dispatchWorker(contract, worker, {
      maxRetries: ADAPTIVE_META_CANARY.retriesPerDispatch,
      onVerdict: (event) => state.verdictEvents.push({
        kind: 'evaluation',
        ...item,
        accepted: event.accepted,
        reasons: event.reasons,
        attempt: event.attempt,
        invocation: event.invocation || null
      })
    });
    store.save(state);
    if (!dispatch.accepted) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `${prefix}-failed`,
          kind: 'evaluation',
          reasons: dispatch.reasons,
          attempt: dispatch.attempt,
          context: { ...item, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'EVALUATION_INVALID',
          `${item.armRole} replicate ${item.replicate + 1}: ${dispatch.reasons.join(',')}`
        )
      };
    }
    if (!invocationMatchesRuntimeAuthority(config, dispatch.packet?.invocation)) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `${prefix}-authority-failed`,
          kind: 'evaluation',
          reasons: ['MODEL_AUTHORITY_UNPROVEN'],
          attempt: dispatch.attempt,
          context: { ...item, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'MODEL_AUTHORITY_UNPROVEN',
          `${item.armRole} replicate ${item.replicate + 1}: OAuth model authority mismatch`
        )
      };
    }
    const shard = evaluationShard(config, item);
    const persisted = persistCanaryEvaluation(store, runId, dispatch.packet, route, {
      artifactPrefix: prefix,
      oracle: evaluationOracle(config, item),
      ...item,
      procedureSha256
    });
    if (!persisted.ok) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `${prefix}-receipt-failed`,
          kind: 'evaluation',
          reasons: [persisted.reason],
          attempt: dispatch.attempt,
          context: { ...item, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'EVALUATION_RECEIPT_INVALID',
          `${item.armRole} replicate ${item.replicate + 1}: ${persisted.reason}`
        )
      };
    }
    state.evaluations.push({
      ...persisted.record,
      ...inputs,
      ...(shard
        ? {
            shardId: shard.id,
            shardSha256: sha256(canonicalJson(shard)),
            stage: item.stage
          }
        : {})
    });
    state.updatedAt = clock();
    store.save(state);
    return { blocked: null };
  };

  if (!isBlindHeldOutV2(config)) {
    for (const armRole of PROPOSAL_ARM_ORDER) {
      const proposal = executeProposal(armRole);
      if (proposal.blocked) return proposal.blocked;
    }
    for (const item of expectedAdaptiveMetaCanarySchedule(plan)) {
      const evaluation = executeEvaluation(item);
      if (evaluation.blocked) return evaluation.blocked;
    }
    return finish('QUEUE_DRAINED');
  }

  const schedule = expectedAdaptiveMetaCanarySchedule(plan);
  const baselineProposal = executeProposal('baseline');
  if (baselineProposal.blocked) return baselineProposal.blocked;
  for (const item of schedule.filter((entry) => entry.armRole === 'baseline')) {
    const evaluation = executeEvaluation(item);
    if (evaluation.blocked) return evaluation.blocked;
  }
  const observedBaselineFailures = state.evaluations
    .filter((item) => item.armRole === 'baseline' && item.targetQuality < 1)
    .length;
  const observedBaselineControlFailures = state.evaluations
    .filter((item) => item.armRole === 'baseline' && item.controlQuality < 1)
    .length;
  state.qualification.observedBaselineFailures = observedBaselineFailures;
  state.qualification.observedBaselineControlFailures =
    observedBaselineControlFailures;
  if (observedBaselineControlFailures > 0) {
    state.qualification.status = 'UNSTABLE_CONTROL';
    state.updatedAt = clock();
    store.save(state);
    return finish('UNSTABLE_CONTROL');
  }
  if (observedBaselineFailures < ADAPTIVE_META_CANARY.qualificationBaselineFailures) {
    state.qualification.status = 'NO_HEADROOM';
    state.updatedAt = clock();
    store.save(state);
    return finish('NO_HEADROOM');
  }
  state.qualification.status = 'QUALIFIED';
  state.updatedAt = clock();
  store.save(state);
  if (isQualificationOnly(config)) {
    return finish('QUALIFIED');
  }

  for (const armRole of ['routed', 'sham']) {
    const proposal = executeProposal(armRole);
    if (proposal.blocked) return proposal.blocked;
  }
  for (const item of schedule.filter((entry) => entry.armRole !== 'baseline')) {
    const evaluation = executeEvaluation(item);
    if (evaluation.blocked) return evaluation.blocked;
  }
  return finish('QUEUE_DRAINED');
}

function flattenEvidenceArtifactRefs(value) {
  if (Array.isArray(value)) return value.flatMap(flattenEvidenceArtifactRefs);
  if (value && typeof value === 'object' && typeof value.id === 'string') return [value.id];
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(flattenEvidenceArtifactRefs);
  }
  return [];
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
  return {
    ok: artifactHashMatches(contractArtifact)
      && artifactHashMatches(promptArtifact)
      && contractArtifact.sha256 === record.contractSha256
      && promptArtifact.sha256 === record.promptArtifactSha256
      && record.promptSha256 === record.promptArtifactSha256
      && stableJson(parsedContract) === stableJson(expectedContract)
      && promptArtifact.content === expectedPrompt,
    contract: parsedContract,
    promptArtifact
  };
}

function verifyRecordedCallInputs(store, runId, record) {
  const contractArtifact = safeArtifact(store, runId, record.contractArtifactRef);
  const promptArtifact = safeArtifact(store, runId, record.promptArtifactRef);
  let contract = null;
  try {
    contract = contractArtifact ? JSON.parse(contractArtifact.content) : null;
  } catch {
    contract = null;
  }
  const expectedPrompt = contract
    ? buildExecutorPrompt({ ...contract, outputSchemaMode: true })
    : null;
  return {
    ok: artifactHashMatches(contractArtifact)
      && artifactHashMatches(promptArtifact)
      && contractArtifact.sha256 === record.contractSha256
      && promptArtifact.sha256 === record.promptArtifactSha256
      && record.invocation?.promptSha256 === record.promptArtifactSha256
      && promptArtifact.content === expectedPrompt,
    contract,
    promptArtifact
  };
}

function failureArtifactMatches(store, runId, evidence, receiptSha256) {
  if (!evidence) return receiptSha256 == null || receiptSha256 === sha256('');
  const artifact = safeArtifact(store, runId, evidence.artifactRef);
  return artifactHashMatches(artifact)
    && artifact.sha256 === evidence.sha256
    && evidence.receiptSha256 === receiptSha256
    && evidence.matchesReceipt === true
    && artifact.sha256 === receiptSha256
    && evidence.bytes === Buffer.byteLength(artifact.content);
}

function callSlotKey(event = {}) {
  return event.kind === 'evaluation'
    ? `evaluation:${event.armRole}:${event.blindArm}:${event.replicate}:${event.position}`
    : `proposal:${event.armRole}:${event.blindArm}:${event.position}`;
}

function aggregateSeries(evaluations) {
  return Object.fromEntries(ADAPTIVE_META_CANARY.arms.map((arm) => [
    arm,
    evaluations
      .filter((item) => item.armRole === arm)
      .sort((left, right) => left.replicate - right.replicate)
      .map((item) => ({
        targetQuality: item.targetQuality,
        controlQuality: item.controlQuality,
        tokenCost: item.tokenCost,
        artifactRef: item.evaluationArtifactRef
      }))
  ]));
}

function evaluateAdaptiveOutcome(series, {
  qualificationOnly = false,
  requiredBaselineFailures = ADAPTIVE_META_CANARY.qualificationBaselineFailures,
  legacyWording = false,
  strictQualificationControls = false
} = {}) {
  const baseline = series.baseline || [];
  const routed = series.routed || [];
  const sham = series.sham || [];
  if (qualificationOnly) {
    const qualificationValid = baseline.length === ADAPTIVE_META_CANARY.evaluationsPerArm
      && routed.length === 0
      && sham.length === 0
      && baseline.every((row) => (
        Number.isFinite(row.targetQuality)
        && Number.isFinite(row.controlQuality)
        && Number.isFinite(row.tokenCost)
      ));
    const baselineTargetFailures = qualificationValid
      ? baseline.filter((row) => row.targetQuality < 1).length
      : null;
    const baselineControlFailures = qualificationValid
      ? baseline.filter((row) => row.controlQuality < 1).length
      : null;
    const noHeadroom = qualificationValid
      && baselineTargetFailures < requiredBaselineFailures
      && (!strictQualificationControls || baselineControlFailures === 0);
    const unstableControl = qualificationValid
      && strictQualificationControls
      && baselineControlFailures > 0;
    const qualified = qualificationValid
      && baselineTargetFailures >= requiredBaselineFailures
      && (!strictQualificationControls || baselineControlFailures === 0);
    return {
      status: unstableControl
        ? 'UNSTABLE_CONTROL'
        : (qualified ? 'QUALIFIED' : (noHeadroom ? 'NO_HEADROOM' : 'INCOMPLETE')),
      seriesValid: qualificationValid,
      qualificationValid,
      baselineTargetFailures,
      ...(strictQualificationControls ? { baselineControlFailures } : {}),
      routedPairedTargetWins: null,
      shamTargetWins: null,
      controlRegressions: null,
      promotionEnabled: false,
      reasons: unstableControl
        ? ['The no-memory control failed one or more protected control shards.']
        : (qualified
            ? []
            : (noHeadroom
                ? ['The no-memory control solved too many held-out shards to measure routed lift.']
                : ['Qualification did not establish a valid terminal state.']))
    };
  }
  const seriesValid = [baseline, routed, sham].every((rows) => (
    rows.length === ADAPTIVE_META_CANARY.evaluationsPerArm
    && rows.every((row) => (
      Number.isFinite(row.targetQuality)
      && Number.isFinite(row.controlQuality)
      && Number.isFinite(row.tokenCost)
    ))
  ));
  if (!seriesValid) {
    return {
      status: 'INCOMPLETE',
      seriesValid: false,
      baselineTargetFailures: null,
      routedPairedTargetWins: null,
      shamTargetWins: null,
      controlRegressions: null,
      promotionEnabled: false,
      reasons: ['Each arm must have five complete target/control evaluations.']
    };
  }
  const baselineTargetFailures = baseline.filter((row) => row.targetQuality < 1).length;
  const baselineControlFailures = baseline
    .filter((row) => row.controlQuality < 1).length;
  const routedPairedTargetWins = routed
    .filter((row, index) => row.targetQuality > baseline[index].targetQuality).length;
  const shamTargetWins = sham
    .filter((row, index) => row.targetQuality > baseline[index].targetQuality).length;
  const controlRegressions = routed
    .filter((row, index) => row.controlQuality < baseline[index].controlQuality).length;
  const passed = seriesValid
    && baselineTargetFailures >= 4
    && (!strictQualificationControls || baselineControlFailures === 0)
    && routedPairedTargetWins >= 4
    && shamTargetWins === 0
    && controlRegressions === 0;
  return {
    status: passed ? 'PASS' : 'FAIL',
    seriesValid,
    baselineTargetFailures,
    ...(strictQualificationControls ? { baselineControlFailures } : {}),
    routedPairedTargetWins,
    shamTargetWins,
    controlRegressions,
    promotionEnabled: false,
    reasons: [
      ...(baselineTargetFailures < 4
        ? [legacyWording
            ? 'Baseline did not fail target cases in at least four paired evaluations.'
            : 'The no-memory control did not fail target cases in at least four paired evaluations.']
        : []),
      ...(strictQualificationControls && baselineControlFailures > 0
        ? ['The no-memory control failed one or more protected control evaluations.']
        : []),
      ...(routedPairedTargetWins < 4 ? ['Routed proposal did not beat baseline in at least four paired evaluations.'] : []),
      ...(shamTargetWins > 0 ? ['The irrelevant sham moved target quality.'] : []),
      ...(controlRegressions > 0 ? ['The routed proposal regressed a control evaluation.'] : [])
    ]
  };
}

function verificationFailure(runId, reason) {
  const base = {
    schemaVersion: 1,
    runId,
    status: 'FAIL',
    experimentValid: false,
    activationEligible: false,
    gates: {},
    outcome: evaluateAdaptiveOutcome({ baseline: [], routed: [], sham: [] }),
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function verifyAdaptiveMetaCanaryRun(store, runId) {
  let state;
  try {
    state = store.load(runId);
  } catch {
    state = null;
  }
  if (!state || state.kind !== 'adaptive-meta-canary') {
    return verificationFailure(runId, 'adaptive meta-canary state is missing or has the wrong kind');
  }
  const configArtifact = safeArtifact(store, runId, state.evidenceArtifacts?.config?.id);
  let config = null;
  try {
    config = configArtifact ? JSON.parse(configArtifact.content) : null;
  } catch {
    config = null;
  }
  const v2 = state.plan?.profile === ADAPTIVE_META_CANARY.profile;
  const configCheck = config
    ? validateAdaptiveMetaCanaryConfig(config, {
        allowLegacy: !v2,
        allowHistoricalPrivateEvidencePolicy: true,
        allowHistoricalEvaluationNormalization: true
      })
    : {
        ok: false,
        errors: ['sealed config is missing'],
        mechanism: {},
        implementation: {}
      };
  const plan = config ? buildAdaptiveMetaCanaryPlan(config) : null;
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

  const plannedQualificationOnly = v2 && isQualificationOnly(config || {});
  const qualificationTerminal = v2 && [
    'NO_HEADROOM',
    'QUALIFIED',
    'UNSTABLE_CONTROL'
  ].includes(state.status);
  const qualificationOnly = plannedQualificationOnly || (
    qualificationTerminal && state.status !== 'QUALIFIED'
  );
  const expectedProposalSchedule = qualificationOnly
    ? ['baseline']
    : (plan?.contract?.proposalSchedule || []);
  const actualProposalSchedule = proposals.map((item) => item.armRole);
  const fullExpectedEvaluationSchedule = plan
    ? expectedAdaptiveMetaCanarySchedule(plan)
    : [];
  const expectedEvaluationSchedule = qualificationOnly
    ? fullExpectedEvaluationSchedule.filter((item) => item.armRole === 'baseline')
    : fullExpectedEvaluationSchedule;
  const actualEvaluationSchedule = evaluations.map((item) => ({
    ...(v2 ? { kind: 'evaluation' } : {}),
    armRole: item.armRole,
    blindArm: item.blindArm,
    ...(v2 ? { shardId: item.shardId } : {}),
    replicate: item.replicate,
    position: item.position,
    ...(v2 ? { stage: item.stage } : {})
  }));
  const proposalByArm = new Map(proposals.map((item) => [item.armRole, item]));
  const expectedTarget = config ? {
    findingId: config.target.findingId,
    title: config.target.title || config.target.findingId,
    baselineArtifactId: 'baseline-procedure',
    baselineSha256: plan.target.baselineSha256,
    baselineContent: config.target.baselineContent,
    evidenceRefs: config.target.evidenceRefs
  } : null;
  const expectedHypothesis = config ? {
    id: `${config.target.findingId}-meta-h1`,
    ...config.target.hypothesis
  } : null;

  const promptChecks = [];
  for (const proposal of proposals) {
    const expectedCapsule = proposal.armRole === 'routed'
      ? config?.mechanismContext?.routedCapsule
      : (proposal.armRole === 'sham' ? config?.mechanismContext?.shamCapsule : null);
    const expectedContract = config
      ? buildMetaCanaryProposalContract(
          config,
          expectedTarget,
          expectedHypothesis,
          proposal.armRole,
          proposal.model
        )
      : null;
    promptChecks.push({
      kind: 'proposal',
      record: proposal,
      expectedCapsule,
      ...verifyCallInputs(store, runId, proposal, expectedContract)
    });
  }
  for (const evaluation of evaluations) {
    const proposal = proposalByArm.get(evaluation.armRole);
    const proposalArtifact = proposal
      ? safeArtifact(store, runId, proposal.resultArtifactRef)
      : null;
    const parsedProposal = proposalArtifact ? parseCaseResults(proposalArtifact.content) : null;
    const procedureContent = String(parsedProposal?.payload?.revisedContent || '');
    const expectedContract = config
      ? buildMetaCanaryEvaluationContract(
          config,
          expectedTarget,
          expectedHypothesis,
          {
            armRole: evaluation.armRole,
            blindArm: evaluation.blindArm,
            shardId: evaluation.shardId,
            replicate: evaluation.replicate,
            position: evaluation.position,
            stage: evaluation.stage
          },
          evaluation.model,
          procedureContent
        )
      : null;
    promptChecks.push({
      kind: 'evaluation',
      record: evaluation,
      expectedCapsule: null,
      ...verifyCallInputs(store, runId, evaluation, expectedContract)
    });
  }

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
  const proposalSchemaHashes = new Set(proposals.map((item) => item.outputSchemaSha256));
  const evaluationSchemaHashes = new Set(evaluations.map((item) => item.outputSchemaSha256));
  const expectedProposalCount = qualificationOnly ? 1 : ADAPTIVE_META_CANARY.proposalCalls;
  const expectedEvaluationCount = qualificationOnly
    ? ADAPTIVE_META_CANARY.evaluationsPerArm
    : ADAPTIVE_META_CANARY.evaluationCalls;
  const expectedCallCount = expectedProposalCount + expectedEvaluationCount;
  const proposalSchemaIdentity = proposals.length === expectedProposalCount
    && proposalSchemaHashes.size === 1
    && proposalSchemaHashes.has(proposalSchemaArtifact?.sha256);
  const evaluationSchemaIdentity = evaluations.length === expectedEvaluationCount
    && evaluationSchemaHashes.size === 1
    && evaluationSchemaHashes.has(evaluationSchemaArtifact?.sha256);

  let measurementDerivation = evaluations.length === ADAPTIVE_META_CANARY.evaluationCalls;
  if (qualificationOnly) {
    measurementDerivation = evaluations.length === ADAPTIVE_META_CANARY.evaluationsPerArm;
  }
  for (const record of evaluations) {
    const item = {
      shardId: record.shardId,
      replicate: record.replicate,
      armRole: record.armRole
    };
    const oracle = config ? evaluationOracle(config, item) : null;
    const shard = config ? evaluationShard(config, item) : null;
    const expectedCaseIds = (oracle?.cases || []).map((entry) => String(entry.caseId));
    const artifact = safeArtifact(store, runId, record.evaluationArtifactRef);
    const raw = safeArtifact(store, runId, record.rawArtifactRef);
    const parsed = artifact
      ? parseCaseResults(artifact.content, { allowProposalWrappers: false })
      : null;
    const actualIds = parsed?.ok ? parsed.results.map((item) => String(item?.caseId || '')) : [];
    const recomputed = artifact ? {
      tokenCost: raw ? parseTokenUsage(raw.content) : null,
      quality: scoreCaseResults(artifact.content, oracle),
      targetQuality: groupQuality(artifact.content, oracle, 'target'),
      controlQuality: groupQuality(artifact.content, oracle, 'control')
    } : null;
    if (!recomputed
        || stableJson(actualIds) !== stableJson(expectedCaseIds)
        || (v2 && (
          !shard
          || record.shardId !== shard.id
          || record.shardSha256 !== sha256(canonicalJson(shard))
        ))
        || recomputed.tokenCost !== record.tokenCost
        || recomputed.quality !== record.quality
        || recomputed.targetQuality !== record.targetQuality
        || recomputed.controlQuality !== record.controlQuality) {
      measurementDerivation = false;
    }
  }

  const allCalls = [...proposals, ...evaluations];
  const failureEvidence = Array.isArray(state.failureEvidence) ? state.failureEvidence : [];
  const verdictEvents = Array.isArray(state.verdictEvents) ? state.verdictEvents : [];
  const observedEvents = verdictEvents
    .filter((event) => event?.invocation && typeof event.invocation === 'object');
  const acceptedBackendConsistency = allCalls.every((item) => {
      const raw = safeArtifact(store, runId, item.rawArtifactRef);
      const reportedFromRaw = raw ? parseReportedModel('codex', raw.content) : null;
      return (item.reportedModel == null && reportedFromRaw == null)
        || String(item.reportedModel || '').toLowerCase()
          === String(reportedFromRaw || '').toLowerCase();
    });
  const failedBackendConsistency = failureEvidence.every((item) => {
    const raw = safeArtifact(store, runId, item.stdout?.artifactRef);
    const reportedFromRaw = raw ? parseReportedModel('codex', raw.content) : null;
    return (item.invocation?.reportedModel == null && reportedFromRaw == null)
      || String(item.invocation?.reportedModel || '').toLowerCase()
        === String(reportedFromRaw || '').toLowerCase();
  });
  const modelAuthority = configCheck.runtimeAuthority?.status === 'OK'
    && observedEvents.length > 0
    && observedEvents.every((event) => (
      invocationMatchesRuntimeAuthority(config, event.invocation)
    ))
    && acceptedBackendConsistency
    && failedBackendConsistency;
  const reportedModels = observedEvents
    .map((event) => event.invocation.reportedModel)
    .filter((value) => value != null)
    .map((value) => String(value).toLowerCase());
  const backendModelIdentity = reportedModels.some((value) => value !== REAL_TEST_MODEL)
    ? 'MISMATCH'
    : (reportedModels.length === observedEvents.length && observedEvents.length > 0
      ? 'REPORTED_MATCH'
      : (reportedModels.length > 0 ? 'PARTIAL_MATCH' : 'UNAVAILABLE'));
  const strictIsolation = observedEvents.length > 0
    && observedEvents.every((event) => (
      event.invocation.strictIsolation === true
      && event.invocation.isolation?.status === 'PASS'
      && (event.invocation.isolation?.toolCalls || []).length === 0
    ))
    && proposalChecks.every((item) => (
    item.verification.checks?.strictLaunch === true
    && item.verification.checks?.isolation === true
  )) && evaluationChecks.every((item) => (
    item.verification.checks?.strictLaunch === true
    && item.verification.checks?.isolation === true
  ));
  const promptBinding = promptChecks.length === expectedCallCount
    && promptChecks.every((item) => (
      item.ok
      && SHA256_RE.test(String(item.record.promptSha256 || ''))
      && item.record.promptArtifactSha256 === item.promptArtifact?.sha256
      && item.record.promptSha256 === item.record.promptArtifactSha256
    ));
  const proposalTreatment = promptChecks
    .filter((item) => item.kind === 'proposal')
    .every((item) => {
      const contractCapsule = item.contract?.mechanismCapsule || null;
      if (item.record.armRole === 'baseline') return contractCapsule === null;
      return canonicalAdaptiveJson(contractCapsule)
        === canonicalAdaptiveJson(item.expectedCapsule);
    });
  const proposalContractsWithoutTreatment = promptChecks
    .filter((item) => item.kind === 'proposal')
    .map((item) => {
      const contract = structuredClone(item.contract || {});
      contract.mechanismCapsule = null;
      return stableJson(contract);
    });
  const proposalInputParity = proposalContractsWithoutTreatment.length === 1
    ? qualificationOnly
    : (
        proposalContractsWithoutTreatment.length === ADAPTIVE_META_CANARY.proposalCalls
        && new Set(proposalContractsWithoutTreatment).size === 1
      );
  const heldOutProposalNeedles = v2 ? [
    ...(config?.heldOutEvidenceCapsule || []).flatMap((item) => [
      String(item?.path || ''),
      String(item?.content || '')
    ]),
    ...v2EvaluationShards(config).flatMap((shard) => [
      String(shard.id || ''),
      ...(shard.cases || []).flatMap((item) => [
        String(item?.id || ''),
        String(item?.prompt || ''),
        String(item?.evidenceRef?.locator || ''),
        String(item?.baselineFailureRef?.locator || '')
      ])
    ]),
    String(config?.target?.hypothesis?.operation || ''),
    String(config?.target?.hypothesis?.expectedMovement || '')
  ].filter((needle) => needle.length >= 8) : [];
  const proposalBlindness = !v2 || promptChecks
    .filter((item) => item.kind === 'proposal')
    .every((item) => (
      item.contract?.hypothesis?.operation === null
      && item.contract?.hypothesis?.expectedMovement === null
      && item.contract?.hypothesis?.falsifier === null
      && stableJson(item.contract?.evidenceCapsule) === stableJson(config?.evidenceCapsule)
      && stableJson(item.contract?.frozenCases)
        === stableJson((config?.benchmark?.developmentCases || []).map(workerVisibleCase))
      && heldOutProposalNeedles.every((needle) => (
        !item.promptArtifact?.content?.includes(needle)
      ))
    ));
  const concealment = promptChecks
    .filter((item) => item.kind === 'evaluation')
    .every((item) => (
      item.contract?.mechanismCapsule === null
      && item.contract?.target?.baselineContent === null
      && (!v2 || item.contract?.target?.title === null)
      && item.contract?.hypothesis?.title === null
      && item.contract?.hypothesis?.bottleneck === null
      && item.contract?.hypothesis?.operation === null
      && item.contract?.hypothesis?.expectedMovement === null
      && item.contract?.hypothesis?.falsifier === null
      && /^arm-[a-f0-9]{12}$/.test(String(item.contract?.evaluationArm || ''))
      && !ADAPTIVE_META_CANARY.arms.includes(item.contract?.evaluationArm)
    ));
  const evaluationPartitionIsolation = !v2 || promptChecks
    .filter((item) => item.kind === 'evaluation')
    .every((item) => {
      const shard = evaluationShard(config, item.record);
      if (!shard) return false;
      const otherNeedles = v2EvaluationShards(config)
        .filter((candidate) => candidate.id !== shard.id)
        .flatMap((candidate) => [
          String(candidate.id || ''),
          ...(candidate.evidencePaths || []).map(String),
          ...(candidate.cases || []).flatMap((entry) => [
            String(entry?.id || ''),
            String(entry?.prompt || ''),
            String(entry?.evidenceRef?.locator || '')
          ])
        ])
        .filter((needle) => needle.length >= 8);
      const developmentNeedles = config?.evaluationProcedureNormalization
          === ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION
        ? [
            ...(config?.evidenceSources || []),
            ...(config?.benchmark?.developmentCases || []).flatMap((entry) => [
              String(entry?.id || ''),
              String(entry?.evidenceRef?.locator || '')
            ])
          ].filter((needle) => String(needle).length >= 8)
        : [];
      return stableJson(item.contract?.evidenceCapsule)
          === stableJson(shardEvidenceCapsule(config, shard))
        && stableJson(item.contract?.frozenCases)
          === stableJson((shard.cases || []).map(workerVisibleCase))
        && stableJson(item.contract?.target?.evidenceRefs)
          === stableJson(uniqueCaseEvidenceRefs(shard.cases))
        && [...otherNeedles, ...developmentNeedles].every((needle) => (
          !item.promptArtifact?.content?.includes(needle)
        ));
    });
  const evaluatedArms = qualificationOnly ? ['baseline'] : [...ADAPTIVE_META_CANARY.arms];
  const distinctEvaluationShards = !v2 || evaluatedArms.every((armRole) => {
    const rows = evaluations.filter((item) => item.armRole === armRole);
    return rows.length === ADAPTIVE_META_CANARY.evaluationsPerArm
      && new Set(rows.map((item) => item.shardId)).size
        === ADAPTIVE_META_CANARY.evaluationsPerArm
      && new Set(rows.map((item) => item.promptArtifactSha256)).size
        === ADAPTIVE_META_CANARY.evaluationsPerArm
      && new Set(rows.map((item) => item.rawResultSha256)).size
        === ADAPTIVE_META_CANARY.evaluationsPerArm;
  });
  const privateMechanismSources = Array.isArray(config?.mechanismEvidenceCapsule)
    ? config.mechanismEvidenceCapsule
    : [];
  const privateSourceNeedles = privateMechanismSources.flatMap((item) => [
    String(item?.path || ''),
    String(item?.content || '')
  ]).filter(Boolean);
  const privateLocatorNeedles = (
    Array.isArray(config?.mechanismEvidenceRefs) ? config.mechanismEvidenceRefs : []
  ).map((item) => String(item?.locator || '')).filter(Boolean);
  const legacyPrivateNeedles = [
    ...privateMechanismSources.map((item) => String(item?.content || '')),
    ...privateLocatorNeedles
  ].filter(Boolean);
  const strictPrivateEvidencePolicy =
    config?.privateEvidencePolicy === ADAPTIVE_META_CANARY_PRIVATE_EVIDENCE_POLICY;
  const failedPromptChecks = failureEvidence.map((item) => (
    verifyRecordedCallInputs(store, runId, item)
  ));
  const privateEvidenceWithheld = [
    ...promptChecks,
    ...failedPromptChecks
  ].every((item) => {
    const contract = object(item.contract);
    const prompt = String(item.promptArtifact?.content || '');
    if (!strictPrivateEvidencePolicy) {
      return !Object.hasOwn(contract, 'mechanismEvidenceCapsule')
        && legacyPrivateNeedles.every((needle) => !prompt.includes(needle));
    }
    const strictNeedles = item.kind === 'proposal'
      ? [...privateSourceNeedles, ...privateLocatorNeedles]
      : privateSourceNeedles;
    return !Object.hasOwn(contract, 'mechanismEvidenceCapsule')
      && !Object.hasOwn(contract, 'mechanismEvidenceRefs')
      && strictNeedles.every((needle) => !prompt.includes(needle));
  });

  const evidenceRefs = flattenEvidenceArtifactRefs(state.evidenceArtifacts);
  const callRefs = allCalls.flatMap((item) => [
    item.rawArtifactRef,
    item.resultArtifactRef,
    item.evaluationArtifactRef,
    item.contractArtifactRef,
    item.promptArtifactRef
  ]).filter(Boolean);
  const failureRefs = failureEvidence.flatMap((item) => [
    item.stdout?.artifactRef,
    item.stderr?.artifactRef,
    item.result?.artifactRef,
    item.contractArtifactRef,
    item.promptArtifactRef
  ]).filter(Boolean);
  const artifactRefs = [...new Set([...evidenceRefs, ...callRefs, ...failureRefs])];
  const artifactHashes = artifactRefs.length > 0
    && artifactRefs.every((artifactId) => artifactHashMatches(safeArtifact(store, runId, artifactId)));
  const expectedFailureEvidenceCount = state.status === 'BLOCKED' ? 1 : 0;
  const failureEvidenceIntegrity = failureEvidence.length === expectedFailureEvidenceCount
    && failureEvidence.every((failure) => {
      const event = observedEvents.find((candidate) => (
        callSlotKey(candidate) === callSlotKey(failure)
        && candidate.invocation?.stdoutSha256 === failure.invocation?.stdoutSha256
      ));
      const input = verifyRecordedCallInputs(store, runId, failure);
      const tokens = failure.stdout
        ? parseTokenUsage(safeArtifact(store, runId, failure.stdout.artifactRef)?.content)
        : null;
      return !!event
        && input.ok
        && failure.attempt === 0
        && failureArtifactMatches(
          store,
          runId,
          failure.stdout,
          failure.invocation?.stdoutSha256
        )
        && failureArtifactMatches(
          store,
          runId,
          failure.stderr,
          failure.invocation?.stderrSha256
        )
        && failureArtifactMatches(
          store,
          runId,
          failure.result,
          failure.invocation?.resultSha256
        )
        && (failure.invocation?.cliReportedTotalTokens == null
          || tokens === failure.invocation.cliReportedTotalTokens);
    });
  const sealedEvidenceIntegrity = [
    [state.evidenceArtifacts?.evidenceCapsule, config?.evidenceCapsule],
    ...(v2
      ? [[
          state.evidenceArtifacts?.heldOutEvidenceCapsule,
          config?.heldOutEvidenceCapsule
        ]]
      : []),
    [state.evidenceArtifacts?.mechanismEvidenceCapsule, config?.mechanismEvidenceCapsule],
    [state.evidenceArtifacts?.runtimeAuthority, config?.runtimeAuthority]
  ].every(([reference, expected]) => {
    const artifact = safeArtifact(store, runId, reference?.id);
    return artifactHashMatches(artifact)
      && artifact.sha256 === reference?.sha256
      && artifact.content === stableJson(expected);
  });
  const implementationArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.implementationCapsule?.id
  );
  const implementationIntegrity = configCheck.implementation?.ok === true
    && artifactHashMatches(implementationArtifact)
    && implementationArtifact.content === stableJson(config?.implementationCapsule);

  const receipts = proposalChecks.length === expectedProposalCount
    && evaluationChecks.length === expectedEvaluationCount
    && proposalChecks.every((item) => item.verification.ok)
    && evaluationChecks.every((item) => item.verification.ok);
  const armSchedule = stableJson(actualProposalSchedule) === stableJson(expectedProposalSchedule)
    && stableJson(actualEvaluationSchedule) === stableJson(expectedEvaluationSchedule);
  const expectedExecutionSchedule = v2
    ? (qualificationOnly
        ? (plan?.contract?.executionSchedule || []).slice(
            0,
            ADAPTIVE_META_CANARY.qualificationCalls
          )
        : (plan?.contract?.executionSchedule || []))
    : null;
  const actualExecutionSchedule = v2 ? verdictEvents.map((event) => ({
    kind: event.kind,
    armRole: event.armRole,
    blindArm: event.blindArm,
    ...(event.kind === 'evaluation' ? {
      shardId: event.shardId,
      replicate: event.replicate,
      position: event.position,
      stage: event.stage
    } : {
      position: event.position
    })
  })) : null;
  const callOrder = !v2
    || stableJson(actualExecutionSchedule) === stableJson(expectedExecutionSchedule);
  const observedSlots = verdictEvents.map(callSlotKey);
  const completeStatus = state.status === 'QUEUE_DRAINED'
    || qualificationTerminal;
  const noRetries = (completeStatus
      ? verdictEvents.length === expectedCallCount
      : verdictEvents.length <= ADAPTIVE_META_CANARY.totalCalls)
    && verdictEvents.every((event) => event.attempt === 0)
    && new Set(observedSlots).size === observedSlots.length;
  const qualificationConsistency = !v2 || (
    Number.isInteger(state.qualification?.observedBaselineFailures)
    && state.qualification.observedBaselineFailures
      === evaluations.filter((item) => (
        item.armRole === 'baseline' && item.targetQuality < 1
      )).length
    && (
      config?.evaluationProcedureNormalization
        !== ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION
      || (
        Number.isInteger(state.qualification?.observedBaselineControlFailures)
        && state.qualification.observedBaselineControlFailures
          === evaluations.filter((item) => (
            item.armRole === 'baseline' && item.controlQuality < 1
          )).length
      )
    )
    && (
      state.qualification.status === 'NO_HEADROOM'
        ? (
            state.qualification.observedBaselineFailures
              < ADAPTIVE_META_CANARY.qualificationBaselineFailures
            && (state.qualification.observedBaselineControlFailures ?? 0) === 0
          )
        : (state.qualification.status === 'UNSTABLE_CONTROL'
            ? state.qualification.observedBaselineControlFailures > 0
            : (
                state.qualification.status === 'QUALIFIED'
                && state.qualification.observedBaselineFailures
                  >= ADAPTIVE_META_CANARY.qualificationBaselineFailures
                && (state.qualification.observedBaselineControlFailures ?? 0) === 0
              ))
    )
  );
  const stateConsistency = completeStatus
    && state.plan?.sha256 === state.approvedPlanSha256
    && state.plan?.sha256 === plan?.sha256
    && state.failureEvidence?.length === 0
    && state.promotion?.enabled === false
    && state.promotion?.recorded === false
    && qualificationConsistency;
  const noPromotion = state.promotion?.enabled === false
    && state.promotion?.recorded === false;

  const gates = {
    configIntegrity: configCheck.ok === true && artifactHashMatches(configArtifact),
    implementationIntegrity,
    adaptiveRecords: configCheck.mechanism?.recordsValid === true
      && configCheck.mechanism?.routingReplay === true
      && configCheck.mechanism?.primaryBinding === true,
    partitionIsolation: configCheck.mechanism?.partitionIsolation === true,
    privateEvidenceWithheld,
    sealedEvidenceIntegrity,
    receipts,
    modelAuthority,
    strictIsolation,
    promptBinding,
    proposalTreatment,
    ...(v2 ? {
      proposalInputParity,
      proposalBlindness
    } : {}),
    proposalSchemaIdentity,
    evaluationSchemaIdentity,
    armSchedule,
    ...(v2 ? { callOrder } : {}),
    concealment,
    ...(v2 ? {
      evaluationPartitionIsolation,
      distinctEvaluationShards
    } : {}),
    measurementDerivation,
    artifactHashes,
    failureEvidenceIntegrity,
    noRetries,
    noPromotion,
    stateConsistency
  };
  const experimentValid = Object.values(gates).every(Boolean);
  const series = aggregateSeries(evaluations);
  const outcome = evaluateAdaptiveOutcome(series, {
    qualificationOnly,
    requiredBaselineFailures: ADAPTIVE_META_CANARY.qualificationBaselineFailures,
    legacyWording: !v2,
    strictQualificationControls:
      config?.evaluationProcedureNormalization
        === ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION
  });
  const realEvidence = config?.fixtureOnly === false;
  const activationEligible = experimentValid
    && realEvidence
    && !qualificationOnly
    && outcome.status === 'PASS';
  const eventUsage = observedEvents.map((event) => ({
    ...event,
    tokens: Number.isFinite(event.invocation?.tokenUsage)
      ? event.invocation.tokenUsage
      : null
  }));
  const usageTotal = (items) => items.some((item) => !Number.isFinite(item.tokens))
    ? null
    : items.reduce((sum, item) => sum + item.tokens, 0);
  const proposalUsage = eventUsage.filter((item) => item.kind === 'proposal');
  const evaluationUsage = eventUsage.filter((item) => item.kind === 'evaluation');
  const failedDispatchUsage = eventUsage.filter((item) => item.accepted !== true);
  const tokenUsage = {
    observedCalls: observedEvents.length,
    measuredCalls: eventUsage.filter((item) => Number.isFinite(item.tokens)).length,
    unmeasuredCalls: eventUsage.filter((item) => !Number.isFinite(item.tokens)).length,
    proposalTotal: usageTotal(proposalUsage),
    evaluationTotal: usageTotal(evaluationUsage),
    total: usageTotal(eventUsage),
    failedDispatchTotal: usageTotal(failedDispatchUsage),
    byArm: Object.fromEntries(ADAPTIVE_META_CANARY.arms.map((arm) => {
      const armProposalUsage = eventUsage
        .filter((item) => item.kind === 'proposal' && item.armRole === arm);
      const armEvaluationUsage = eventUsage
        .filter((item) => item.kind === 'evaluation' && item.armRole === arm);
      const armEvaluationTokens = armEvaluationUsage
        .map((item) => item.tokens)
        .filter(Number.isFinite);
      const armFailedUsage = eventUsage
        .filter((item) => item.armRole === arm && item.accepted !== true);
      return [arm, {
        proposal: armProposalUsage.length
          ? usageTotal(armProposalUsage)
          : null,
        evaluationMean: armEvaluationUsage.some((item) => !Number.isFinite(item.tokens))
          ? null
          : mean(armEvaluationTokens),
        evaluationTotal: usageTotal(armEvaluationUsage),
        failedDispatchTotal: usageTotal(armFailedUsage)
      }];
    }))
  };
  const reasons = [
    ...Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => `Required experiment gate failed: ${name}.`),
    ...configCheck.errors.map((error) => `Config: ${error}`),
    ...outcome.reasons,
    ...(!realEvidence ? ['Fixture-only evidence cannot activate adaptive routing.'] : [])
  ];
  const base = {
    schemaVersion: 1,
    runId,
    status: experimentValid ? 'PASS' : 'FAIL',
    experimentValid,
    activationEligible,
    realEvidence,
    modelAuthority: {
      launchAuthority: modelAuthority,
      requestedModel: config?.runtimeAuthority?.requestedModel || null,
      authMode: config?.runtimeAuthority?.authMode || null,
      selectionAuthority: config?.runtimeAuthority?.selectionAuthority || null,
      backendModelIdentity,
      backendReportedCalls: reportedModels.length,
      observedCalls: observedEvents.length
    },
    gates,
    armCounts: Object.fromEntries(ADAPTIVE_META_CANARY.arms.map((arm) => [
      arm,
      {
        proposals: proposals.filter((item) => item.armRole === arm).length,
        evaluations: evaluations.filter((item) => item.armRole === arm).length
      }
    ])),
    series,
    outcome,
    tokenUsage,
    failedReceipts: [
      ...proposalChecks
        .filter((item) => !item.verification.ok)
        .map((item) => ({
          kind: 'proposal',
          armRole: item.record.armRole,
          reasons: item.verification.reasons
        })),
      ...evaluationChecks
        .filter((item) => !item.verification.ok)
        .map((item) => ({
          kind: 'evaluation',
          armRole: item.record.armRole,
          replicate: item.record.replicate,
          reasons: item.verification.reasons
        }))
    ],
    reasons: [...new Set(reasons)]
  };
  return {
    ...base,
    evidenceSha256: sha256(stableJson(base))
  };
}

export function adaptiveMetaCanaryLaunchDisclosure(config, {
  configPath,
  home,
  runId
} = {}) {
  const plan = buildAdaptiveMetaCanaryPlan(config);
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
  const runtimeAuthority = object(config.runtimeAuthority);
  const launch = [
    `SUPER_LOOP_CODEX_BIN=${quoted(runtimeAuthority.binary?.path || '')}`,
    'SUPER_LOOP_REQUIRE_CHATGPT_OAUTH=1',
    `SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256=${runtimeAuthority.authoritySha256 || ''}`,
    `SUPER_LOOP_CODEX_EXECUTABLE_SHA256=${runtimeAuthority.binary?.sha256 || ''}`,
    'SUPER_LOOP_ALLOW_EXEC=1',
    'npm run meta-canary -- --config',
    quoted(configPath),
    '--approved-plan',
    plan.sha256,
    '--run-id',
    quoted(runId),
    '--home',
    quoted(home)
  ].join(' ');
  const verify = [
    'npm run verify:meta-canary -- --home',
    quoted(home),
    '--run',
    quoted(runId)
  ].join(' ');
  const qualificationOnly = isQualificationOnly(config);
  const proposalCalls = qualificationOnly
    ? 1
    : ADAPTIVE_META_CANARY.proposalCalls;
  const evaluationCalls = qualificationOnly
    ? ADAPTIVE_META_CANARY.evaluationsPerArm
    : ADAPTIVE_META_CANARY.evaluationCalls;
  const totalMaximum = proposalCalls + evaluationCalls;
  return {
    profile: plan.profile,
    planSha256: plan.sha256,
    resolvedConfigSha256: sha256(stableJson(config)),
    implementationManifest: plan.implementationManifest,
    runtimeAuthority: plan.runtimeAuthority,
    proofHome: home,
    runId,
    calls: {
      proposals: proposalCalls,
      evaluations: evaluationCalls,
      totalMaximum,
      qualificationBeforeDecision: isBlindHeldOutV2(config)
        ? ADAPTIVE_META_CANARY.qualificationCalls
        : null,
      conditionalAfterQualification: isBlindHeldOutV2(config)
        ? (qualificationOnly ? 0 : ADAPTIVE_META_CANARY.conditionalCalls)
        : null,
      retries: ADAPTIVE_META_CANARY.retriesPerDispatch
    },
    partitions: isBlindHeldOutV2(config)
      ? {
          developmentSources: evidenceManifest(config).length,
          heldOutSources: heldOutEvidenceManifest(config).length,
          heldOutShards: v2EvaluationShards(config).length,
          privateMechanismSources: mechanismEvidenceManifest(config).length
        }
      : null,
    exposure: {
      perCallTimeoutMs: ADAPTIVE_META_CANARY.perCallTimeoutMs,
      sequentialTimeoutCeilingMinutes: (
        ADAPTIVE_META_CANARY.perCallTimeoutMs * totalMaximum / 60_000
      ),
      hardTokenLimit: ADAPTIVE_META_CANARY.hardTokenLimit,
      hardUsdLimit: ADAPTIVE_META_CANARY.hardUsdLimit,
      historicalTokenEstimate: config.historicalTokenEstimate ?? null,
      historicalEstimateBinding: 'non-binding'
    },
    execution: {
      model: REAL_TEST_MODEL,
      reasoningEffort: STRICT_CODEX_REASONING_EFFORT,
      authMode: runtimeAuthority.authMode || null,
      modelSelectionAuthority: runtimeAuthority.selectionAuthority || null,
      backendIdentitySurface: runtimeAuthority.backendIdentitySurface || null,
      executableSha256: runtimeAuthority.binary?.sha256 || null,
      catalogSha256: runtimeAuthority.catalog?.sha256 || null,
      promptTransport: 'stdin',
      sandbox: 'read-only',
      promotionEnabled: false,
      proposalSchemaPath,
      evaluationSchemaPath,
      proposalArgv,
      evaluationArgv,
      disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES]
    },
    launchCommand: `${launch} && ${verify}`
  };
}
