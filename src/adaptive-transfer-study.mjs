// Headroom-qualified, cross-task causal study for adaptive routing.
//
// Candidate tasks are screened with qualification-only meta-canaries. The
// first five valid headroom tasks then restart from fresh proposals against
// disjoint confirmatory evidence. The parent stores only child references and
// independently re-verifies every child from disk.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_META_CANARY,
  ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION,
  ADAPTIVE_META_CANARY_IMPLEMENTATION_PATHS,
  buildAdaptiveMetaCanaryPlan,
  resolveAdaptiveMetaCanaryImplementation,
  runAdaptiveMetaCanary,
  validateAdaptiveMetaCanaryConfig,
  verifyAdaptiveMetaCanaryRun
} from './adaptive-meta-canary.mjs';
import {
  stableJson,
  writeCanaryArtifact
} from './canary-runner.mjs';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';
import {
  STRICT_CODEX_REASONING_EFFORT,
  buildArgs,
  schemaPathForContract
} from './executor.mjs';
import {
  REAL_TEST_MODEL,
  resolveEvidenceCapsule
} from './real-test.mjs';
import { isSafeId, nowIso, round, sha256 } from './util.mjs';

export const ADAPTIVE_TRANSFER_STUDY_SCHEMA_VERSION =
  'adaptive-transfer-study-v1';
export const ADAPTIVE_TRANSFER_STUDY_SELECTION_RULE =
  'seeded-first-five-qualified-v1';
export const ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE =
  'first-five-or-impossible-v1';
export const ADAPTIVE_TRANSFER_STUDY = Object.freeze({
  minimumCandidates: 5,
  maximumCandidates: 12,
  requiredQualifiedTasks: 5,
  qualificationCallsPerCandidate: ADAPTIVE_META_CANARY.qualificationCalls,
  confirmationCallsPerTask: ADAPTIVE_META_CANARY.totalCalls,
  requiredTaskWins: 5,
  exactSignTestP: 0.03125,
  maxMeanTokenOverheadPct: 25,
  retriesPerDispatch: 0,
  perCallTimeoutMs: ADAPTIVE_META_CANARY.perCallTimeoutMs,
  hardTokenLimit: null,
  hardUsdLimit: null,
  promotionEnabled: false
});

export const ADAPTIVE_TRANSFER_STUDY_IMPLEMENTATION_PATHS = Object.freeze([
  ...new Set([
    ...ADAPTIVE_META_CANARY_IMPLEMENTATION_PATHS,
    'scripts/plan-adaptive-transfer-study.mjs',
    'scripts/run-adaptive-transfer-study.mjs',
    'scripts/verify-adaptive-transfer-study.mjs',
    'src/adaptive-transfer-study.mjs',
    'src/schemas/adaptive-transfer-study-v1.schema.json'
  ])
]);

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA256_RE = /^[a-f0-9]{64}$/;
const RESOLVED_META_CONFIG_FIELDS = Object.freeze([
  'evidenceManifest',
  'evidenceCapsule',
  'heldOutEvidenceManifest',
  'heldOutEvidenceCapsule',
  'mechanismEvidenceManifest',
  'mechanismEvidenceCapsule',
  'implementationManifest',
  'implementationCapsule',
  'runtimeAuthority',
  'approvedPlanSha256'
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function artifactHashMatches(artifact) {
  return !!(artifact
    && typeof artifact.content === 'string'
    && SHA256_RE.test(String(artifact.sha256 || ''))
    && sha256(artifact.content) === artifact.sha256);
}

function safeArtifact(store, runId, artifactId) {
  try {
    return artifactId ? store.readArtifact(runId, artifactId) : null;
  } catch {
    return null;
  }
}

function withinRoot(root, path, label) {
  const absolute = resolve(root, String(path || ''));
  const rel = relative(root, absolute);
  if (!path || isAbsolute(String(path))
      || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be repository-relative`);
  }
  return { absolute, relative: rel };
}

function normalizedManifest(config, field) {
  return (Array.isArray(config?.[field]) ? config[field] : []).map((item) => ({
    path: item.path,
    bytes: item.bytes,
    sha256: item.sha256
  }));
}

function rawMetaConfig(config) {
  const raw = structuredClone(config || {});
  for (const field of RESOLVED_META_CONFIG_FIELDS) delete raw[field];
  return raw;
}

function metaConfigIdentity(config) {
  const plan = buildAdaptiveMetaCanaryPlan(config);
  return {
    planSha256: plan.sha256,
    findingId: config.target?.findingId || null,
    targetSha256: sha256(stableJson(config.target || {})),
    developmentCasesSha256: sha256(stableJson(
      config.benchmark?.developmentCases || []
    )),
    developmentEvidenceManifest: normalizedManifest(config, 'evidenceManifest'),
    heldOutEvidenceManifest: normalizedManifest(
      config,
      'heldOutEvidenceManifest'
    ),
    primaryFamilyId: config.mechanismContext?.primaryFamilyId || null,
    policyEpochSha256:
      config.mechanismContext?.policyEpoch?.policyEpochSha256 || null,
    routingDecisionSha256:
      config.mechanismContext?.routingDecision?.routingDecisionSha256 || null,
    runtimeAuthoritySha256: config.runtimeAuthority?.authoritySha256 || null
  };
}

function candidatePlanIdentity(candidate) {
  return {
    id: candidate.id,
    source: {
      qualificationConfigPath:
        candidate.source?.qualificationConfigPath || null,
      qualificationConfigSha256:
        candidate.source?.qualificationConfigSha256 || null,
      confirmationConfigPath:
        candidate.source?.confirmationConfigPath || null,
      confirmationConfigSha256:
        candidate.source?.confirmationConfigSha256 || null
    },
    qualification: metaConfigIdentity(candidate.qualification || {}),
    confirmation: metaConfigIdentity(candidate.confirmation || {})
  };
}

export function adaptiveTransferStudyCandidateOrder(config = {}) {
  const seed = String(config.seed || '');
  return [...(Array.isArray(config.candidates) ? config.candidates : [])]
    .sort((left, right) => {
      const leftKey = sha256(`${seed}:${left?.id || ''}`);
      const rightKey = sha256(`${seed}:${right?.id || ''}`);
      return leftKey.localeCompare(rightKey)
        || String(left?.id || '').localeCompare(String(right?.id || ''));
    });
}

export function buildAdaptiveTransferStudyPlan(config = {}) {
  const candidates = adaptiveTransferStudyCandidateOrder(config)
    .map((candidate, selectionPosition) => ({
      selectionPosition,
      ...candidatePlanIdentity(candidate)
    }));
  const candidateCount = candidates.length;
  const maximumCalls = (
    candidateCount * ADAPTIVE_TRANSFER_STUDY.qualificationCallsPerCandidate
  ) + (
    ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks
      * ADAPTIVE_TRANSFER_STUDY.confirmationCallsPerTask
  );
  const basis = {
    profile: ADAPTIVE_TRANSFER_STUDY_SCHEMA_VERSION,
    model: REAL_TEST_MODEL,
    fixtureOnly: config.fixtureOnly === true,
    seed: config.seed || null,
    selectionRule: ADAPTIVE_TRANSFER_STUDY_SELECTION_RULE,
    ...(config.qualificationStopRule != null
      ? { qualificationStopRule: config.qualificationStopRule }
      : {}),
    candidates,
    implementationManifest: normalizedManifest(
      config,
      'implementationManifest'
    ),
    runtimeAuthority: {
      authoritySha256: config.runtimeAuthority?.authoritySha256 || null,
      requestedModel: config.runtimeAuthority?.requestedModel || null,
      reasoningEffort: config.runtimeAuthority?.reasoningEffort || null,
      authMode: config.runtimeAuthority?.authMode || null,
      selectionAuthority:
        config.runtimeAuthority?.selectionAuthority || null,
      executableSha256: config.runtimeAuthority?.binary?.sha256 || null,
      catalogSha256: config.runtimeAuthority?.catalog?.sha256 || null
    },
    contract: {
      candidateCount,
      minimumCandidates: ADAPTIVE_TRANSFER_STUDY.minimumCandidates,
      maximumCandidates: ADAPTIVE_TRANSFER_STUDY.maximumCandidates,
      requiredQualifiedTasks:
        ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks,
      ...(config.qualificationStopRule != null
        ? { qualificationStopRule: config.qualificationStopRule }
        : {}),
      qualificationCallsPerCandidate:
        ADAPTIVE_TRANSFER_STUDY.qualificationCallsPerCandidate,
      confirmationCallsPerTask:
        ADAPTIVE_TRANSFER_STUDY.confirmationCallsPerTask,
      maximumCalls,
      retriesPerDispatch: ADAPTIVE_TRANSFER_STUDY.retriesPerDispatch,
      perCallTimeoutMs: ADAPTIVE_TRANSFER_STUDY.perCallTimeoutMs,
      timeoutCeilingMs:
        maximumCalls * ADAPTIVE_TRANSFER_STUDY.perCallTimeoutMs,
      hardTokenLimit: ADAPTIVE_TRANSFER_STUDY.hardTokenLimit,
      hardUsdLimit: ADAPTIVE_TRANSFER_STUDY.hardUsdLimit,
      promotionEnabled: false,
      endpoint: {
        requiredTaskWins: ADAPTIVE_TRANSFER_STUDY.requiredTaskWins,
        exactSignTestP: ADAPTIVE_TRANSFER_STUDY.exactSignTestP,
        maxMeanTokenOverheadPct:
          ADAPTIVE_TRANSFER_STUDY.maxMeanTokenOverheadPct,
        allowedShamWins: 0,
        allowedControlRegressions: 0
      }
    }
  };
  return {
    ...basis,
    sha256: sha256(stableJson(basis))
  };
}

export function resolveAdaptiveTransferStudyImplementation(
  packageRoot = PACKAGE_ROOT
) {
  const root = resolve(packageRoot);
  const manifest = [];
  const capsule = [];
  for (const path of ADAPTIVE_TRANSFER_STUDY_IMPLEMENTATION_PATHS) {
    const { absolute, relative: rel } = withinRoot(
      root,
      path,
      'implementation path'
    );
    const content = readFileSync(absolute, 'utf8');
    const record = {
      path: rel,
      bytes: Buffer.byteLength(content),
      sha256: sha256(Buffer.from(content))
    };
    manifest.push(record);
    capsule.push({ ...record, content });
  }
  return { manifest, capsule };
}

function inspectImplementation(config, errors) {
  const expected = [...ADAPTIVE_TRANSFER_STUDY_IMPLEMENTATION_PATHS].sort();
  const manifest = Array.isArray(config.implementationManifest)
    ? config.implementationManifest
    : [];
  const capsule = Array.isArray(config.implementationCapsule)
    ? config.implementationCapsule
    : [];
  const actual = manifest.map((item) => item?.path).sort();
  if (stableJson(actual) !== stableJson(expected)
      || capsule.length !== expected.length) {
    errors.push('implementation manifest must bind the exact study dependency set');
  }
  const map = new Map();
  for (const item of capsule) {
    const content = typeof item?.content === 'string' ? item.content : null;
    const digest = content == null ? null : sha256(Buffer.from(content));
    const bytes = content == null ? null : Buffer.byteLength(content);
    const sealed = manifest.find((candidate) => candidate?.path === item?.path);
    if (!expected.includes(item?.path) || map.has(item.path)
        || digest !== item?.sha256 || bytes !== item?.bytes
        || sealed?.sha256 !== digest || sealed?.bytes !== bytes) {
      errors.push(`implementation capsule failed verification: ${item?.path || '<missing>'}`);
      continue;
    }
    map.set(item.path, item);
  }
  return { ok: map.size === expected.length, manifest, capsule };
}

function sameAuthority(left, right) {
  return left?.authoritySha256 === right?.authoritySha256
    && left?.requestedModel === right?.requestedModel
    && left?.reasoningEffort === right?.reasoningEffort
    && left?.authMode === right?.authMode
    && left?.binary?.sha256 === right?.binary?.sha256;
}

function heldOutIdentifiers(config) {
  return (config.benchmark?.evaluationShards || []).flatMap((shard) => [
    String(shard?.id || ''),
    ...(shard?.evidencePaths || []).map(String),
    ...(shard?.cases || []).flatMap((item) => [
      String(item?.id || ''),
      `${item?.evidenceRef?.path || ''}:${item?.evidenceRef?.locator || ''}`,
      ...(item?.baselineFailureRef
        ? [`${item.baselineFailureRef.path || ''}:${item.baselineFailureRef.locator || ''}`]
        : [])
    ])
  ]).filter(Boolean);
}

function developmentIdentifiers(config) {
  return [
    ...(config.evidenceManifest || []).map((item) => String(item?.path || '')),
    ...(config.benchmark?.developmentCases || []).flatMap((item) => [
      String(item?.id || ''),
      `${item?.evidenceRef?.path || ''}:${item?.evidenceRef?.locator || ''}`
    ])
  ].filter(Boolean);
}

function candidatePartitionIdentifiers(candidate) {
  return [
    String(candidate?.id || ''),
    String(candidate?.source?.qualificationConfigPath || ''),
    String(candidate?.source?.confirmationConfigPath || ''),
    ...developmentIdentifiers(candidate?.qualification || {}),
    ...heldOutIdentifiers(candidate?.qualification || {}),
    ...heldOutIdentifiers(candidate?.confirmation || {})
  ].filter((value) => value.length >= 8);
}

function candidatePartitionSurface(candidate) {
  const childSurface = (child) => ({
    target: child?.target || null,
    evidenceManifest: child?.evidenceManifest || [],
    evidenceCapsule: child?.evidenceCapsule || [],
    heldOutEvidenceManifest: child?.heldOutEvidenceManifest || [],
    heldOutEvidenceCapsule: child?.heldOutEvidenceCapsule || [],
    benchmark: child?.benchmark || null
  });
  return stableJson({
    id: candidate?.id || null,
    source: candidate?.source || null,
    qualification: childSurface(candidate?.qualification),
    confirmation: childSurface(candidate?.confirmation)
  });
}

function validateCandidate(candidate, config, errors) {
  const label = `candidate ${candidate?.id || '<missing>'}`;
  if (!isSafeId(candidate?.id) || String(candidate.id).length < 8) {
    errors.push(`${label} requires a safe substantive id`);
  }
  const source = object(candidate?.source);
  for (const field of [
    'qualificationConfigPath',
    'confirmationConfigPath'
  ]) {
    const value = String(source[field] || '');
    if (!value || value.startsWith('/') || value.includes('\0')
        || value === '..' || value.startsWith(`..${sep}`)) {
      errors.push(`${label} ${field} must be repository-relative`);
    }
  }
  for (const field of [
    'qualificationConfigSha256',
    'confirmationConfigSha256'
  ]) {
    if (!SHA256_RE.test(String(source[field] || ''))) {
      errors.push(`${label} ${field} must be a SHA-256`);
    }
  }
  for (const [contentField, hashField, childField] of [
    [
      'qualificationConfigContent',
      'qualificationConfigSha256',
      'qualification'
    ],
    [
      'confirmationConfigContent',
      'confirmationConfigSha256',
      'confirmation'
    ]
  ]) {
    const content = source[contentField];
    let parsed = null;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : null;
    } catch {
      parsed = null;
    }
    if (typeof content !== 'string'
        || sha256(Buffer.from(content)) !== source[hashField]
        || stableJson(parsed) !== stableJson(rawMetaConfig(candidate[childField]))) {
      errors.push(`${label} ${contentField} must rederive ${hashField}`);
    }
  }
  if (source.qualificationConfigPath === source.confirmationConfigPath
      || source.qualificationConfigSha256 === source.confirmationConfigSha256) {
    errors.push(`${label} qualification and confirmation config sources must differ`);
  }

  const qualification = object(candidate?.qualification);
  const confirmation = object(candidate?.confirmation);
  const qualificationCheck = validateAdaptiveMetaCanaryConfig(qualification, {
    requireApproval: false
  });
  const confirmationCheck = validateAdaptiveMetaCanaryConfig(confirmation, {
    requireApproval: false
  });
  for (const error of qualificationCheck.errors) {
    errors.push(`${label} qualification: ${error}`);
  }
  for (const error of confirmationCheck.errors) {
    errors.push(`${label} confirmation: ${error}`);
  }
  if (qualification.executionMode !== 'qualification-only'
      || confirmation.executionMode !== 'full') {
    errors.push(`${label} requires qualification-only then full execution modes`);
  }
  if (qualification.evaluationProcedureNormalization
      !== ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION
      || confirmation.evaluationProcedureNormalization
        !== ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION) {
    errors.push(`${label} must enable the evaluation provenance firewall`);
  }
  if (qualification.fixtureOnly !== config.fixtureOnly
      || confirmation.fixtureOnly !== config.fixtureOnly) {
    errors.push(`${label} fixtureOnly must match the parent study`);
  }
  if (!sameAuthority(config.runtimeAuthority, qualification.runtimeAuthority)
      || !sameAuthority(config.runtimeAuthority, confirmation.runtimeAuthority)) {
    errors.push(`${label} runtime authority must match the parent study`);
  }
  if (stableJson(qualification.target) !== stableJson(confirmation.target)
      || stableJson(qualification.benchmark?.developmentCases)
        !== stableJson(confirmation.benchmark?.developmentCases)
      || stableJson(qualification.evidenceManifest)
        !== stableJson(confirmation.evidenceManifest)
      || stableJson(qualification.evidenceCapsule)
        !== stableJson(confirmation.evidenceCapsule)
      || stableJson(qualification.mechanismContext)
        !== stableJson(confirmation.mechanismContext)
      || stableJson(qualification.mechanismEvidenceManifest)
        !== stableJson(confirmation.mechanismEvidenceManifest)
      || stableJson(qualification.mechanismEvidenceCapsule)
        !== stableJson(confirmation.mechanismEvidenceCapsule)) {
    errors.push(`${label} must hold target, development, and mechanism inputs fixed`);
  }
  const qualificationPaths = new Set(
    (qualification.heldOutEvidenceManifest || []).map((item) => item.path)
  );
  const qualificationHashes = new Set(
    (qualification.heldOutEvidenceManifest || []).map((item) => item.sha256)
  );
  if ((confirmation.heldOutEvidenceManifest || []).some((item) => (
    qualificationPaths.has(item.path) || qualificationHashes.has(item.sha256)
  ))) {
    errors.push(`${label} qualification and confirmation evidence must be disjoint`);
  }
  const qualificationIdentifiers = new Set(heldOutIdentifiers(qualification));
  if (heldOutIdentifiers(confirmation).some((value) => (
    qualificationIdentifiers.has(value)
  ))) {
    errors.push(`${label} qualification and confirmation identifiers must be disjoint`);
  }
  return { qualificationCheck, confirmationCheck };
}

export function validateAdaptiveTransferStudyConfig(config = {}, {
  requireApproval = true,
  allowHistoricalQualificationStopRule = false
} = {}) {
  const errors = [];
  const candidates = Array.isArray(config.candidates) ? config.candidates : [];
  if (config.schemaVersion !== ADAPTIVE_TRANSFER_STUDY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${ADAPTIVE_TRANSFER_STUDY_SCHEMA_VERSION}`);
  }
  if (config.model !== REAL_TEST_MODEL) {
    errors.push(`model must be ${REAL_TEST_MODEL}`);
  }
  if (typeof config.fixtureOnly !== 'boolean') {
    errors.push('fixtureOnly must explicitly state whether evidence is real');
  }
  if (typeof config.seed !== 'string' || config.seed.trim().length < 8) {
    errors.push('seed must be a substantive frozen string');
  }
  const historicalQualificationStopRule =
    allowHistoricalQualificationStopRule
    && config.qualificationStopRule == null;
  if (!historicalQualificationStopRule
      && config.qualificationStopRule
        !== ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE) {
    errors.push(
      `qualificationStopRule must be ${ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE}`
    );
  }
  if (config.historicalTokenEstimate != null
      && (!Number.isInteger(config.historicalTokenEstimate)
        || config.historicalTokenEstimate <= 0)) {
    errors.push('historicalTokenEstimate must be a positive non-binding integer');
  }
  if (candidates.length < ADAPTIVE_TRANSFER_STUDY.minimumCandidates
      || candidates.length > ADAPTIVE_TRANSFER_STUDY.maximumCandidates
      || new Set(candidates.map((item) => item?.id)).size !== candidates.length) {
    errors.push(
      `study requires ${ADAPTIVE_TRANSFER_STUDY.minimumCandidates}-${ADAPTIVE_TRANSFER_STUDY.maximumCandidates} unique candidates`
    );
  }
  const authority = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (authority.status !== 'OK'
      || authority.record.requestedModel !== REAL_TEST_MODEL
      || authority.record.reasoningEffort !== STRICT_CODEX_REASONING_EFFORT) {
    errors.push('runtimeAuthority must bind ChatGPT OAuth, exact gpt-5.6-sol, and high reasoning');
  }
  const implementation = inspectImplementation(config, errors);
  const findingIds = [];
  const primaryFamilyIds = new Set();
  const policyEpochHashes = new Set();
  const developmentPaths = [];
  const developmentHashes = [];
  const developmentIds = [];
  const heldOutPaths = [];
  const heldOutHashes = [];
  const heldOutIds = [];
  const sourceConfigPaths = [];
  for (const candidate of candidates) {
    validateCandidate(candidate, config, errors);
    findingIds.push(candidate.confirmation?.target?.findingId);
    primaryFamilyIds.add(
      candidate.confirmation?.mechanismContext?.primaryFamilyId
    );
    policyEpochHashes.add(
      candidate.confirmation?.mechanismContext?.policyEpoch?.policyEpochSha256
    );
    developmentPaths.push(
      ...(candidate.confirmation?.evidenceManifest || []).map((item) => item.path)
    );
    developmentHashes.push(
      ...(candidate.confirmation?.evidenceManifest || []).map((item) => item.sha256)
    );
    developmentIds.push(...developmentIdentifiers(candidate.confirmation || {}));
    sourceConfigPaths.push(
      candidate.source?.qualificationConfigPath,
      candidate.source?.confirmationConfigPath
    );
    for (const child of [candidate.qualification, candidate.confirmation]) {
      heldOutPaths.push(
        ...(child?.heldOutEvidenceManifest || []).map((item) => item.path)
      );
      heldOutHashes.push(
        ...(child?.heldOutEvidenceManifest || []).map((item) => item.sha256)
      );
      heldOutIds.push(...heldOutIdentifiers(child || {}));
    }
  }
  if (new Set(findingIds).size !== findingIds.length
      || findingIds.some((id) => !/^finding-\d{3}$/.test(String(id || '')))) {
    errors.push('candidate finding IDs must be unique and immutable');
  }
  if (primaryFamilyIds.size !== 1 || primaryFamilyIds.has(undefined)
      || policyEpochHashes.size !== 1 || policyEpochHashes.has(undefined)) {
    errors.push('all confirmation tasks must test one frozen family and policy epoch');
  }
  for (const [label, values] of [
    ['source config paths', sourceConfigPaths],
    ['development paths', developmentPaths],
    ['development hashes', developmentHashes],
    ['development identifiers', developmentIds],
    ['held-out paths', heldOutPaths],
    ['held-out hashes', heldOutHashes],
    ['held-out identifiers', heldOutIds]
  ]) {
    if (new Set(values).size !== values.length) {
      errors.push(`study ${label} must be globally disjoint`);
    }
  }
  const heldOutPathSet = new Set(heldOutPaths);
  const heldOutHashSet = new Set(heldOutHashes);
  const heldOutIdSet = new Set(heldOutIds);
  if (developmentPaths.some((value) => heldOutPathSet.has(value))
      || developmentHashes.some((value) => heldOutHashSet.has(value))
      || developmentIds.some((value) => heldOutIdSet.has(value))) {
    errors.push(
      'study development and held-out partitions must be globally disjoint'
    );
  }
  for (const candidate of candidates) {
    const surface = candidatePartitionSurface(candidate);
    const foreignIdentifiers = candidates
      .filter((item) => item !== candidate)
      .flatMap(candidatePartitionIdentifiers);
    if (foreignIdentifiers.some((value) => surface.includes(value))) {
      errors.push(
        `candidate ${candidate.id} contains another candidate's partition identity`
      );
    }
  }
  const plan = buildAdaptiveTransferStudyPlan(config);
  if (requireApproval && config.approvedPlanSha256 !== plan.sha256) {
    errors.push('adaptive transfer study plan is not operator-approved');
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    plan,
    implementation,
    runtimeAuthority: authority.status === 'OK' ? authority.record : null
  };
}

function resolveMetaConfig(raw, {
  packageRoot,
  runtimeAuthority
}) {
  const development = resolveEvidenceCapsule(
    packageRoot,
    raw.evidenceSources
  );
  const heldOut = resolveEvidenceCapsule(
    packageRoot,
    raw.heldOutEvidenceSources
  );
  const mechanism = resolveEvidenceCapsule(
    packageRoot,
    raw.mechanismEvidenceSources
  );
  const implementation = resolveAdaptiveMetaCanaryImplementation(packageRoot);
  const errors = [
    ...development.errors,
    ...heldOut.errors,
    ...mechanism.errors
  ];
  return {
    ok: errors.length === 0,
    errors,
    config: {
      ...raw,
      evidenceManifest: development.manifest,
      evidenceCapsule: development.capsule,
      heldOutEvidenceManifest: heldOut.manifest,
      heldOutEvidenceCapsule: heldOut.capsule,
      mechanismEvidenceManifest: mechanism.manifest,
      mechanismEvidenceCapsule: mechanism.capsule,
      implementationManifest: implementation.manifest,
      implementationCapsule: implementation.capsule,
      runtimeAuthority,
      approvedPlanSha256: null
    }
  };
}

export function resolveAdaptiveTransferStudyConfig(raw = {}, {
  packageRoot = PACKAGE_ROOT,
  runtimeAuthority
} = {}) {
  const root = resolve(packageRoot);
  const errors = [];
  const candidates = [];
  for (const item of Array.isArray(raw.candidates) ? raw.candidates : []) {
    try {
      const qualificationPath = withinRoot(
        root,
        item.qualificationConfigPath,
        `candidate ${item.id} qualification config`
      );
      const confirmationPath = withinRoot(
        root,
        item.confirmationConfigPath,
        `candidate ${item.id} confirmation config`
      );
      const qualificationBytes = readFileSync(
        qualificationPath.absolute,
        'utf8'
      );
      const confirmationBytes = readFileSync(
        confirmationPath.absolute,
        'utf8'
      );
      const qualification = resolveMetaConfig(
        JSON.parse(qualificationBytes),
        { packageRoot: root, runtimeAuthority }
      );
      const confirmation = resolveMetaConfig(
        JSON.parse(confirmationBytes),
        { packageRoot: root, runtimeAuthority }
      );
      errors.push(
        ...qualification.errors.map((error) => `${item.id} qualification: ${error}`),
        ...confirmation.errors.map((error) => `${item.id} confirmation: ${error}`)
      );
      candidates.push({
        id: item.id,
        source: {
          qualificationConfigPath: qualificationPath.relative,
          qualificationConfigSha256: sha256(Buffer.from(qualificationBytes)),
          qualificationConfigContent: qualificationBytes,
          confirmationConfigPath: confirmationPath.relative,
          confirmationConfigSha256: sha256(Buffer.from(confirmationBytes)),
          confirmationConfigContent: confirmationBytes
        },
        qualification: qualification.config,
        confirmation: confirmation.config
      });
    } catch (error) {
      errors.push(`${item?.id || '<missing>'}: ${error.message}`);
    }
  }
  const implementation = resolveAdaptiveTransferStudyImplementation(root);
  return {
    ok: errors.length === 0,
    errors,
    config: {
      ...raw,
      candidates,
      implementationManifest: implementation.manifest,
      implementationCapsule: implementation.capsule,
      runtimeAuthority,
      approvedPlanSha256: null
    }
  };
}

function childRunId(parentRunId, stage, candidateId) {
  return `${parentRunId}-${stage}-${candidateId}`;
}

function approvedChildConfig(config) {
  const plan = buildAdaptiveMetaCanaryPlan(config);
  return { ...config, approvedPlanSha256: plan.sha256 };
}

function qualificationEligible(verification) {
  return verification?.experimentValid === true
    && verification?.outcome?.status === 'QUALIFIED'
    && verification.outcome.baselineTargetFailures
      >= ADAPTIVE_META_CANARY.qualificationBaselineFailures
    && verification.outcome.baselineControlFailures === 0;
}

function expectedQualificationStop(config, records) {
  const candidates = adaptiveTransferStudyCandidateOrder(config);
  let qualified = 0;
  for (let index = 0; index < records.length; index++) {
    if (records[index]?.eligible) qualified++;
    const remaining = candidates.length - index - 1;
    if (qualified >= ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks) {
      return {
        count: index + 1,
        reason: 'required-qualified-reached',
        candidateId: records[index]?.candidateId || null,
        qualified,
        remaining
      };
    }
    if (config.qualificationStopRule
          === ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE
        && qualified + remaining
          < ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks) {
      return {
        count: index + 1,
        reason: 'qualification-impossible',
        candidateId: records[index]?.candidateId || null,
        qualified,
        remaining
      };
    }
  }
  if (records.length === candidates.length) {
    return {
      count: records.length,
      reason: 'pool-exhausted',
      candidateId: records.at(-1)?.candidateId || null,
      qualified,
      remaining: 0
    };
  }
  return null;
}

function exactOneSidedSignTest(wins, trials) {
  let coefficient = 1;
  let numerator = 0;
  for (let index = 0; index <= trials; index++) {
    if (index >= wins) numerator += coefficient;
    coefficient = index < trials
      ? coefficient * (trials - index) / (index + 1)
      : coefficient;
  }
  return round(numerator / (2 ** trials), 8);
}

function confirmationArmTokens(verification, arm) {
  const row = verification?.tokenUsage?.byArm?.[arm];
  if (!Number.isFinite(row?.proposal)
      || !Number.isFinite(row?.evaluationTotal)) {
    return null;
  }
  return row.proposal + row.evaluationTotal;
}

function evaluateStudyOutcome(state, childVerifications) {
  const selected = Array.isArray(state.selectedCandidateIds)
    ? state.selectedCandidateIds
    : [];
  if (selected.length < ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks) {
    return {
      status: 'NO_HEADROOM',
      qualifiedTasks: selected.length,
      confirmedTasks: 0,
      taskWins: null,
      shamWins: null,
      controlRegressions: null,
      exactSignTestP: null,
      meanTokenOverheadPct: null,
      promotionEnabled: false,
      reasons: ['Fewer than five frozen candidates established valid live headroom.']
    };
  }
  const confirmations = state.confirmations || [];
  if (confirmations.length !== selected.length) {
    return {
      status: 'INCOMPLETE',
      qualifiedTasks: selected.length,
      confirmedTasks: confirmations.length,
      taskWins: null,
      shamWins: null,
      controlRegressions: null,
      exactSignTestP: null,
      meanTokenOverheadPct: null,
      promotionEnabled: false,
      reasons: ['Every selected candidate requires one complete fresh confirmation.']
    };
  }
  const rows = confirmations.map((record) => {
    const verification = childVerifications.get(record.runId);
    return {
      candidateId: record.candidateId,
      passed: verification?.outcome?.status === 'PASS',
      shamWins: verification?.outcome?.shamTargetWins ?? null,
      controlRegressions: verification?.outcome?.controlRegressions ?? null,
      baselineTokens: confirmationArmTokens(verification, 'baseline'),
      routedTokens: confirmationArmTokens(verification, 'routed'),
      evidenceSha256: verification?.evidenceSha256 || null
    };
  });
  const taskWins = rows.filter((item) => item.passed).length;
  const shamWins = rows.some((item) => !Number.isInteger(item.shamWins))
    ? null
    : rows.reduce((sum, item) => sum + item.shamWins, 0);
  const controlRegressions = rows.some((item) => (
    !Number.isInteger(item.controlRegressions)
  ))
    ? null
    : rows.reduce((sum, item) => sum + item.controlRegressions, 0);
  const baselineTokens = rows.reduce(
    (sum, item) => sum + (item.baselineTokens || 0),
    0
  );
  const routedTokens = rows.reduce(
    (sum, item) => sum + (item.routedTokens || 0),
    0
  );
  const meanTokenOverheadPct = rows.every((item) => (
    Number.isFinite(item.baselineTokens) && Number.isFinite(item.routedTokens)
  )) && baselineTokens > 0
    ? round(((routedTokens - baselineTokens) / baselineTokens) * 100)
    : null;
  const exactSignTestP = exactOneSidedSignTest(
    taskWins,
    ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks
  );
  const passed = taskWins === ADAPTIVE_TRANSFER_STUDY.requiredTaskWins
    && shamWins === 0
    && controlRegressions === 0
    && Number.isFinite(meanTokenOverheadPct)
    && meanTokenOverheadPct
      <= ADAPTIVE_TRANSFER_STUDY.maxMeanTokenOverheadPct;
  return {
    status: passed ? 'PASS' : 'FAIL',
    qualifiedTasks: selected.length,
    confirmedTasks: confirmations.length,
    taskWins,
    shamWins,
    controlRegressions,
    exactSignTestP,
    meanTokenOverheadPct,
    taskResults: rows,
    promotionEnabled: false,
    reasons: [
      ...(taskWins !== ADAPTIVE_TRANSFER_STUDY.requiredTaskWins
        ? ['Routed memory did not pass all five fresh task confirmations.']
        : []),
      ...(shamWins !== 0 ? ['One or more sham arms moved target quality.'] : []),
      ...(controlRegressions !== 0
        ? ['One or more routed arms regressed protected controls.']
        : []),
      ...(!Number.isFinite(meanTokenOverheadPct)
          || meanTokenOverheadPct
            > ADAPTIVE_TRANSFER_STUDY.maxMeanTokenOverheadPct
        ? ['Routed memory exceeded the predeclared mean token overhead limit.']
        : [])
    ]
  };
}

function renderStudyReport(state) {
  const outcome = state.outcome || {};
  return [
    '# Adaptive Transfer Study',
    '',
    `- run: \`${state.runId}\``,
    `- status: **${state.status}**`,
    `- plan: \`${state.approvedPlanSha256}\``,
    `- model: \`${state.model}\``,
    `- qualified tasks: ${outcome.qualifiedTasks ?? 'unmeasured'}/5`,
    `- confirmed task wins: ${outcome.taskWins ?? 'unmeasured'}/5`,
    `- sham wins: ${outcome.shamWins ?? 'unmeasured'}`,
    `- control regressions: ${outcome.controlRegressions ?? 'unmeasured'}`,
    `- exact sign-test p: ${outcome.exactSignTestP ?? 'unmeasured'}`,
    `- mean token overhead: ${outcome.meanTokenOverheadPct ?? 'unmeasured'}%`,
    `- experiment valid: ${state.verification?.experimentValid === true}`,
    `- activation eligible: ${state.verification?.activationEligible === true}`,
    '- promotion enabled: false',
    '',
    ...(outcome.reasons || []).map((reason) => `- ${reason}`),
    ''
  ].join('\n');
}

export function runAdaptiveTransferStudy(store, config, {
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
      message: `run "${runId}" already exists; studies are append-only`
    };
  }
  if (typeof worker !== 'function') {
    return { status: 'BLOCKED', code: 'NO_WORKER', message: 'study requires a worker backend' };
  }
  const validation = validateAdaptiveTransferStudyConfig(config);
  if (!validation.ok) {
    return {
      status: 'BLOCKED',
      code: 'TRANSFER_STUDY_CONFIG',
      errors: validation.errors,
      plan: validation.plan
    };
  }
  const createdAt = clock();
  const state = {
    schemaVersion: 1,
    kind: 'adaptive-transfer-study',
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'RUNNING',
    model: config.model,
    approvedPlanSha256: config.approvedPlanSha256,
    plan: validation.plan,
    evidenceArtifacts: {},
    qualifications: [],
    qualificationStop: null,
    selectedCandidateIds: [],
    confirmations: [],
    promotion: { enabled: false, recorded: false },
    verification: null,
    outcome: null,
    blocker: null,
    reportPath: null
  };
  store.save(state);
  const configArtifact = writeCanaryArtifact(
    store,
    runId,
    'sealed-adaptive-transfer-study-config',
    { role: 'config', content: stableJson(config) }
  );
  const implementationArtifact = writeCanaryArtifact(
    store,
    runId,
    'sealed-adaptive-transfer-study-implementation',
    { role: 'implementation-capsule', content: stableJson(config.implementationCapsule) }
  );
  state.evidenceArtifacts = {
    config: { id: configArtifact.id, sha256: configArtifact.sha256 },
    implementationCapsule: {
      id: implementationArtifact.id,
      sha256: implementationArtifact.sha256
    }
  };
  store.save(state);

  const finish = (status) => {
    state.status = status;
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
    state.verification = verifyAdaptiveTransferStudyRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-transfer-study-report.md',
      renderStudyReport(state)
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
    state.verification = verifyAdaptiveTransferStudyRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    return {
      status: 'BLOCKED',
      code,
      message,
      runId,
      verification: state.verification
    };
  };

  const orderedCandidates = adaptiveTransferStudyCandidateOrder(config);
  for (const [index, candidate] of orderedCandidates.entries()) {
    const childId = childRunId(runId, 'q', candidate.id);
    const childConfig = approvedChildConfig(candidate.qualification);
    const result = runAdaptiveMetaCanary(store, childConfig, {
      runId: childId,
      worker,
      clock
    });
    const verification = verifyAdaptiveMetaCanaryRun(store, childId);
    const eligible = qualificationEligible(verification);
    state.qualifications.push({
      candidateId: candidate.id,
      runId: childId,
      planSha256: buildAdaptiveMetaCanaryPlan(childConfig).sha256,
      experimentValid: verification.experimentValid,
      outcome: verification.outcome?.status || null,
      eligible,
      evidenceSha256: verification.evidenceSha256,
      tokenUsage: verification.tokenUsage?.total ?? null
    });
    if (eligible) state.selectedCandidateIds.push(candidate.id);
    state.updatedAt = clock();
    store.save(state);
    if (result.status !== 'OK' || verification.experimentValid !== true) {
      return block(
        'QUALIFICATION_INVALID',
        `${candidate.id} qualification failed integrity verification`
      );
    }
    if (state.selectedCandidateIds.length
        === ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks) {
      state.qualificationStop = {
        rule: config.qualificationStopRule,
        reason: 'required-qualified-reached',
        afterCandidateId: candidate.id,
        qualificationRuns: state.qualifications.length,
        qualifiedTasks: state.selectedCandidateIds.length,
        remainingCandidates: orderedCandidates.length - index - 1
      };
      state.updatedAt = clock();
      store.save(state);
      break;
    }
    const remainingCandidates = orderedCandidates.length - index - 1;
    if (config.qualificationStopRule
          === ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE
        && state.selectedCandidateIds.length + remainingCandidates
          < ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks) {
      state.qualificationStop = {
        rule: config.qualificationStopRule,
        reason: 'qualification-impossible',
        afterCandidateId: candidate.id,
        qualificationRuns: state.qualifications.length,
        qualifiedTasks: state.selectedCandidateIds.length,
        remainingCandidates
      };
      state.updatedAt = clock();
      store.save(state);
      break;
    }
  }

  if (state.selectedCandidateIds.length
      < ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks) {
    return finish('NO_HEADROOM');
  }

  for (const candidateId of state.selectedCandidateIds) {
    const candidate = config.candidates.find((item) => item.id === candidateId);
    const childId = childRunId(runId, 'c', candidate.id);
    const childConfig = approvedChildConfig(candidate.confirmation);
    const result = runAdaptiveMetaCanary(store, childConfig, {
      runId: childId,
      worker,
      clock
    });
    const verification = verifyAdaptiveMetaCanaryRun(store, childId);
    state.confirmations.push({
      candidateId: candidate.id,
      runId: childId,
      planSha256: buildAdaptiveMetaCanaryPlan(childConfig).sha256,
      experimentValid: verification.experimentValid,
      outcome: verification.outcome?.status || null,
      activationEligible: verification.activationEligible,
      evidenceSha256: verification.evidenceSha256,
      tokenUsage: verification.tokenUsage?.total ?? null
    });
    state.updatedAt = clock();
    store.save(state);
    if (result.status !== 'OK' || verification.experimentValid !== true) {
      return block(
        'CONFIRMATION_INVALID',
        `${candidate.id} confirmation failed integrity verification`
      );
    }
  }
  return finish('QUEUE_DRAINED');
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
      qualifiedTasks: null,
      confirmedTasks: null,
      taskWins: null,
      reasons: [reason]
    },
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function verifyAdaptiveTransferStudyRun(store, runId) {
  let state;
  try {
    state = store.load(runId);
  } catch {
    state = null;
  }
  if (!state || state.kind !== 'adaptive-transfer-study') {
    return verificationFailure(
      runId,
      'adaptive transfer study state is missing or has the wrong kind'
    );
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
    ? validateAdaptiveTransferStudyConfig(config, {
        allowHistoricalQualificationStopRule: true
      })
    : {
        ok: false,
        errors: ['sealed study config is missing'],
        implementation: {}
      };
  const plan = config ? buildAdaptiveTransferStudyPlan(config) : null;
  const configIntegrity = configCheck.ok
    && artifactHashMatches(configArtifact)
    && configArtifact.sha256 === state.evidenceArtifacts?.config?.sha256;
  const implementationArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.implementationCapsule?.id
  );
  const implementationIntegrity = configCheck.implementation?.ok === true
    && artifactHashMatches(implementationArtifact)
    && implementationArtifact.content
      === stableJson(config?.implementationCapsule);

  const childVerifications = new Map();
  const childRows = [
    ...(state.qualifications || []),
    ...(state.confirmations || [])
  ];
  for (const record of childRows) {
    childVerifications.set(
      record.runId,
      verifyAdaptiveMetaCanaryRun(store, record.runId)
    );
  }
  const qualificationBindings = (state.qualifications || []).every(
    (record, index) => {
      const candidate = config
        ? adaptiveTransferStudyCandidateOrder(config)[index]
        : null;
      const verification = childVerifications.get(record.runId);
      const expectedRunId = candidate
        ? childRunId(runId, 'q', candidate.id)
        : null;
      return !!candidate
        && record.candidateId === candidate.id
        && record.runId === expectedRunId
        && record.planSha256
          === buildAdaptiveMetaCanaryPlan(candidate.qualification).sha256
        && record.experimentValid === verification?.experimentValid
        && record.outcome === verification?.outcome?.status
        && record.eligible === qualificationEligible(verification)
        && record.evidenceSha256 === verification?.evidenceSha256
        && record.tokenUsage === (verification?.tokenUsage?.total ?? null);
    }
  );
  const recomputedSelected = (state.qualifications || [])
    .filter((record) => record.eligible)
    .slice(0, ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks)
    .map((record) => record.candidateId);
  const expectedStop = config
    ? expectedQualificationStop(config, state.qualifications || [])
    : null;
  const expectedQualificationCount = expectedStop?.count ?? null;
  const selectionIntegrity = qualificationBindings
    && stableJson(recomputedSelected)
      === stableJson(state.selectedCandidateIds || [])
    && Number.isInteger(expectedQualificationCount)
    && (state.qualifications || []).length === expectedQualificationCount;
  const historicalQualificationStop = config?.qualificationStopRule == null;
  const qualificationStopIntegrity = historicalQualificationStop
    ? state.qualificationStop == null
    : !!expectedStop
      && stableJson(state.qualificationStop) === stableJson({
        rule: config.qualificationStopRule,
        reason: expectedStop.reason,
        afterCandidateId: expectedStop.candidateId,
        qualificationRuns: expectedStop.count,
        qualifiedTasks: expectedStop.qualified,
        remainingCandidates: expectedStop.remaining
      });
  const confirmationBindings = (state.confirmations || []).every(
    (record, index) => {
      const candidateId = state.selectedCandidateIds?.[index];
      const candidate = config?.candidates?.find((item) => (
        item.id === candidateId
      ));
      const verification = childVerifications.get(record.runId);
      return !!candidate
        && record.candidateId === candidateId
        && record.runId === childRunId(runId, 'c', candidateId)
        && record.planSha256
          === buildAdaptiveMetaCanaryPlan(candidate.confirmation).sha256
        && record.experimentValid === verification?.experimentValid
        && record.outcome === verification?.outcome?.status
        && record.activationEligible === verification?.activationEligible
        && record.evidenceSha256 === verification?.evidenceSha256
        && record.tokenUsage === (verification?.tokenUsage?.total ?? null);
    }
  );
  const childIntegrity = childRows.length > 0
    && childRows.every((record) => (
      childVerifications.get(record.runId)?.experimentValid === true
    ));
  const childModelAuthority = childRows.every((record) => (
    childVerifications.get(record.runId)?.gates?.modelAuthority === true
  ));
  const childIsolation = childRows.every((record) => (
    childVerifications.get(record.runId)?.gates?.strictIsolation === true
  ));
  const childPartitions = childRows.every((record) => {
    const gates = childVerifications.get(record.runId)?.gates || {};
    return gates.partitionIsolation === true
      && gates.evaluationPartitionIsolation === true
      && gates.privateEvidenceWithheld === true;
  });
  const noPromotion = state.promotion?.enabled === false
    && state.promotion?.recorded === false
    && childRows.every((record) => (
      childVerifications.get(record.runId)?.gates?.noPromotion === true
    ));
  const artifactHashes = artifactHashMatches(configArtifact)
    && artifactHashMatches(implementationArtifact);
  const terminal = ['QUEUE_DRAINED', 'NO_HEADROOM', 'BLOCKED']
    .includes(state.status);
  const expectedConfirmationCount = (state.selectedCandidateIds || []).length
      === ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks
    ? ADAPTIVE_TRANSFER_STUDY.requiredQualifiedTasks
    : 0;
  const stateConsistency = terminal
    && state.plan?.sha256 === state.approvedPlanSha256
    && state.plan?.sha256 === plan?.sha256
    && (state.confirmations || []).length === expectedConfirmationCount
    && (state.status !== 'NO_HEADROOM'
      || expectedConfirmationCount === 0);

  const gates = {
    configIntegrity,
    implementationIntegrity,
    qualificationBindings,
    selectionIntegrity,
    ...(!historicalQualificationStop ? { qualificationStopIntegrity } : {}),
    confirmationBindings,
    childIntegrity,
    childModelAuthority,
    childIsolation,
    childPartitions,
    artifactHashes,
    noPromotion,
    stateConsistency
  };
  const experimentValid = Object.values(gates).every(Boolean);
  const outcome = evaluateStudyOutcome(state, childVerifications);
  const realEvidence = config?.fixtureOnly === false;
  const activationEligible = experimentValid
    && realEvidence
    && outcome.status === 'PASS';
  const tokenRows = childRows.map((record) => (
    childVerifications.get(record.runId)?.tokenUsage?.total
  ));
  const tokenUsage = {
    observedChildRuns: childRows.length,
    measuredChildRuns: tokenRows.filter(Number.isFinite).length,
    total: tokenRows.length > 0 && tokenRows.every(Number.isFinite)
      ? tokenRows.reduce((sum, value) => sum + value, 0)
      : null,
    qualification: (state.qualifications || []).reduce((sum, record) => {
      const value = childVerifications.get(record.runId)?.tokenUsage?.total;
      return Number.isFinite(sum) && Number.isFinite(value) ? sum + value : null;
    }, 0),
    confirmation: (state.confirmations || []).reduce((sum, record) => {
      const value = childVerifications.get(record.runId)?.tokenUsage?.total;
      return Number.isFinite(sum) && Number.isFinite(value) ? sum + value : null;
    }, 0)
  };
  const reasons = [
    ...Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => `Required study gate failed: ${name}.`),
    ...(configCheck.errors || []).map((error) => `Config: ${error}`),
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
    gates,
    selection: {
      rule: ADAPTIVE_TRANSFER_STUDY_SELECTION_RULE,
      ...(!historicalQualificationStop
        ? {
            qualificationStopRule: config.qualificationStopRule,
            stop: state.qualificationStop || null
          }
        : {}),
      qualifiedCandidateIds: state.selectedCandidateIds || [],
      qualificationRuns: (state.qualifications || []).length,
      confirmationRuns: (state.confirmations || []).length
    },
    outcome,
    tokenUsage,
    childEvidence: childRows.map((record) => ({
      stage: (state.qualifications || []).includes(record)
        ? 'qualification'
        : 'confirmation',
      candidateId: record.candidateId,
      runId: record.runId,
      evidenceSha256:
        childVerifications.get(record.runId)?.evidenceSha256 || null
    })),
    reasons: [...new Set(reasons)]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function adaptiveTransferStudyLaunchDisclosure(config, {
  configPath,
  home,
  runId
} = {}) {
  const plan = buildAdaptiveTransferStudyPlan(config);
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
    'npm run transfer-study -- --config',
    quoted(configPath),
    '--approved-plan',
    plan.sha256,
    '--run-id',
    quoted(runId),
    '--home',
    quoted(home)
  ].join(' ');
  const verify = [
    'npm run verify:transfer-study -- --home',
    quoted(home),
    '--run',
    quoted(runId)
  ].join(' ');
  return {
    profile: plan.profile,
    planSha256: plan.sha256,
    resolvedConfigSha256: sha256(stableJson(config)),
    implementationManifest: plan.implementationManifest,
    runtimeAuthority: plan.runtimeAuthority,
    proofHome: home,
    runId,
    calls: {
      candidates: plan.contract.candidateCount,
      qualificationPerCandidate:
        plan.contract.qualificationCallsPerCandidate,
      confirmations: plan.contract.requiredQualifiedTasks,
      confirmationPerTask: plan.contract.confirmationCallsPerTask,
      totalMaximum: plan.contract.maximumCalls,
      retries: plan.contract.retriesPerDispatch
    },
    endpoint: plan.contract.endpoint,
    exposure: {
      perCallTimeoutMs: plan.contract.perCallTimeoutMs,
      timeoutCeilingMinutes: plan.contract.timeoutCeilingMs / 60_000,
      hardTokenLimit: plan.contract.hardTokenLimit,
      hardUsdLimit: plan.contract.hardUsdLimit,
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
      qualificationStopRule: config.qualificationStopRule || null,
      proposalSchemaPath,
      evaluationSchemaPath,
      proposalArgv,
      evaluationArgv
    },
    launchCommand: `${launch} && ${verify}`,
    verificationCommand: verify
  };
}
