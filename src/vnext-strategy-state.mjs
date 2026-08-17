import { validateAdaptiveRecord } from './adaptive-records.mjs';
import { deriveVNextRecursiveEvidence } from './vnext-recursive-import.mjs';
import {
  createVNextEvidenceAuthorityVerifier
} from './vnext-evidence-authority.mjs';
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';
import {
  createCandidateStrategyPlan
} from './vnext-candidate-strategies.mjs';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson, VNEXT_STAGE } from './vnext-contracts.mjs';

export const VNEXT_STRATEGY_STATE_BUNDLE_SCHEMA =
  'vnext-strategy-state-bundle-v1';

const STRATEGIES = Object.freeze([
  'reflective-pareto',
  'bounded-skill',
  'bank-recombination'
]);
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

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function bounded(value, maximum) {
  return typeof value === 'string' && value.trim() && value.length <= maximum
    ? value.trim() : null;
}

function safeIds(values, maximum = 64) {
  return Array.isArray(values) && values.length <= maximum
    && values.every(isSafeId) && new Set(values).size === values.length;
}

function snapshotValid(row, decisionAt) {
  return exactKeys(row, [
    'availableAt', 'candidateFamilyId', 'component', 'hypothesis', 'kind',
    'lifecycle', 'operations', 'proofEvidenceSha256', 'qualityDelta',
    'recordId', 'recordSha256', 'regressions', 'strategy', 'tags', 'tokenCost'
  ])
    && isSafeId(row.recordId) && isSafeId(row.candidateFamilyId)
    && SHA256.test(String(row.recordSha256 || ''))
    && SHA256.test(String(row.proofEvidenceSha256 || ''))
    && Number.isFinite(Date.parse(row.availableAt))
    && Date.parse(row.availableAt) <= Date.parse(decisionAt)
    && ['positive', 'no-improvement', 'regression'].includes(row.kind)
    && ['replicated', 'active', 'contradicted'].includes(row.lifecycle)
    && bounded(row.component, 120)
    && bounded(row.hypothesis, 3000)
    && bounded(row.strategy, 120)
    && Number.isFinite(row.qualityDelta)
    && Number.isFinite(row.tokenCost) && row.tokenCost >= 0
    && Number.isInteger(row.regressions) && row.regressions >= 0
    && safeIds(row.tags, 32)
    && Array.isArray(row.operations) && row.operations.length >= 1
    && row.operations.length <= 3
    && row.operations.every((operation) => (
      exactKeys(operation, ['beforeSha256', 'op', 'target', 'value'])
      && ['add', 'delete', 'replace', 'recombine', 'emit'].includes(operation.op)
      && bounded(operation.target, 500)
      && (operation.beforeSha256 == null || SHA256.test(operation.beforeSha256))
      && (operation.value == null || bounded(operation.value, 8000))
    ));
}

function strategyBase(snapshots, decisionAt) {
  const targets = [...new Map(snapshots.flatMap((row) => row.operations)
    .map((operation) => [operation.target, {
      target: operation.target,
      locatorSha256: operation.beforeSha256 ?? sha256(operation.target),
      sourceSha256: operation.beforeSha256 ?? sha256(operation.target)
    }])).values()].sort((left, right) => left.target.localeCompare(right.target));
  return {
    decisionTime: decisionAt,
    selectedEvidence: snapshots.map((row) => ({
      id: row.recordId,
      sha256: row.recordSha256
    })),
    allowedTargets: targets,
    allowedComponent: 'mechanism-program',
    maximumOperations: 1
  };
}

function reflectiveState(snapshots) {
  const successes = snapshots.filter((row) => row.kind === 'positive')
    .sort((left, right) => right.qualityDelta - left.qualityDelta
      || left.tokenCost - right.tokenCost
      || left.recordId.localeCompare(right.recordId));
  const failures = snapshots.filter((row) => row.kind !== 'positive')
    .sort((left, right) => right.regressions - left.regressions
      || left.qualityDelta - right.qualityDelta
      || left.recordId.localeCompare(right.recordId));
  if (!successes.length || !failures.length) return null;
  const selected = [...successes.slice(0, 4), ...failures.slice(0, 4)]
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  return {
    trajectories: selected.map((row) => ({
      trajectoryId: `trajectory-${sha256(row.recordId).slice(0, 24)}`,
      outcome: row.kind === 'positive'
        ? 'success'
        : (row.kind === 'regression' ? 'failure' : 'tradeoff'),
      quality: row.qualityDelta,
      tokenCost: row.tokenCost,
      regressions: row.regressions,
      summary: `${row.hypothesis} Observed outcome: ${row.kind}.`,
      evidenceIds: [row.recordId],
      availableAt: row.availableAt
    }))
  };
}

function boundedSkillState(snapshots) {
  const successes = snapshots.filter((row) => (
    row.kind === 'positive'
    && row.operations.some((operation) => operation.value != null)
  )).sort((left, right) => right.qualityDelta - left.qualityDelta
    || left.tokenCost - right.tokenCost
    || left.recordId.localeCompare(right.recordId));
  const failures = snapshots.filter((row) => row.kind !== 'positive')
    .sort((left, right) => right.regressions - left.regressions
      || left.qualityDelta - right.qualityDelta
      || left.recordId.localeCompare(right.recordId));
  if (!successes.length || !failures.length) return null;
  const source = successes[0];
  const items = [...new Map(source.operations
    .filter((operation) => operation.value != null)
    .map((operation) => [operation.target, {
      target: operation.target,
      value: operation.value,
      sha256: sha256(operation.value)
    }])).values()].slice(0, 3);
  if (!items.length) return null;
  return {
    skill: {
      skillId: `skill-${sha256(source.candidateFamilyId).slice(0, 24)}`,
      version: `version-${source.recordSha256.slice(0, 24)}`,
      items
    },
    successReflections: successes.slice(0, 2).map((row) => ({
      reflectionId: `success-${sha256(row.recordId).slice(0, 24)}`,
      evidenceId: row.recordId,
      statement: `This bounded operation produced verifier-owned positive movement: ${row.hypothesis}`,
      availableAt: row.availableAt
    })),
    failureReflections: failures.slice(0, 2).map((row) => ({
      reflectionId: `failure-${sha256(row.recordId).slice(0, 24)}`,
      evidenceId: row.recordId,
      statement: `This trajectory did not establish a safe gain and must constrain revision: ${row.hypothesis}`,
      availableAt: row.availableAt
    })),
    limits: {
      maximumChangedItems: 1,
      maximumChangedBytes: 8000
    }
  };
}

function commonTags(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([tag]) => tag)
    .sort()
    .slice(0, 32);
}

function bankState(snapshots) {
  const successes = snapshots.filter((row) => (
    row.kind === 'positive' && row.regressions === 0 && row.qualityDelta > 0
  )).sort((left, right) => right.qualityDelta - left.qualityDelta
    || left.tokenCost - right.tokenCost
    || left.recordId.localeCompare(right.recordId));
  const distinct = [];
  for (const row of successes) {
    if (!distinct.some((current) => current.candidateFamilyId === row.candidateFamilyId)) {
      distinct.push(row);
    }
  }
  if (distinct.length < 2) return null;
  const rows = distinct.slice(0, 8);
  const targetTags = commonTags(rows);
  if (!targetTags.length) return null;
  const mechanisms = rows.map((row) => {
    const content = canonicalVNextJson({
      familyId: row.candidateFamilyId,
      operations: row.operations
    });
    return {
      mechanismId: `mechanism-${sha256(row.recordId).slice(0, 24)}`,
      familyId: row.candidateFamilyId,
      component: row.component,
      operationKind: [...new Set(row.operations.map(({ op }) => op))].sort().join('-'),
      content,
      compatibilityTags: row.tags,
      incompatibleWith: [],
      evidenceIds: [row.recordId],
      lifecycle: row.lifecycle === 'active' ? 'validated' : 'replicated',
      qualityDelta: row.qualityDelta,
      regressions: row.regressions,
      sha256: sha256(content)
    };
  }).filter((row) => row.content.length <= 4000);
  return mechanisms.length >= 2 ? { targetTags, mechanisms } : null;
}

function stateReceipt(strategy, state, snapshots, decisionAt) {
  if (state == null) return {
    ready: false,
    state: null,
    stateSha256: null,
    reason: strategy === 'bank-recombination'
      ? 'NEEDS_TWO_DISTINCT_VERIFIER_OWNED_SUCCESSES'
      : 'NEEDS_VERIFIER_OWNED_SUCCESS_AND_NON_SUCCESS'
  };
  const base = strategyBase(snapshots, decisionAt);
  const plan = createCandidateStrategyPlan(strategy, state, base);
  return plan.status === 'OK'
    ? {
        ready: true,
        state,
        stateSha256: sha256(canonicalVNextJson(state)),
        reason: null
      }
    : {
        ready: false,
        state: null,
        stateSha256: null,
        reason: plan.code ?? 'STRATEGY_STATE_REPLAY_FAILED'
      };
}

export function buildVNextStrategyStateBundle({ snapshots, decisionAt } = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 64
      || !Number.isFinite(Date.parse(decisionAt))
      || snapshots.some((row) => !snapshotValid(row, decisionAt))
      || new Set(snapshots.map((row) => row.recordId)).size !== snapshots.length) {
    return refused(
      'VNEXT_STRATEGY_STATE_SNAPSHOTS_INVALID',
      'Strategy state requires unique, chronological verifier-derived snapshots.'
    );
  }
  const ordered = [...snapshots].sort((left, right) => (
    left.availableAt.localeCompare(right.availableAt)
      || left.recordId.localeCompare(right.recordId)
  ));
  const states = {
    'reflective-pareto': stateReceipt(
      'reflective-pareto', reflectiveState(ordered), ordered, decisionAt
    ),
    'bounded-skill': stateReceipt(
      'bounded-skill', boundedSkillState(ordered), ordered, decisionAt
    ),
    'bank-recombination': stateReceipt(
      'bank-recombination', bankState(ordered), ordered, decisionAt
    )
  };
  const core = {
    schemaVersion: VNEXT_STRATEGY_STATE_BUNDLE_SCHEMA,
    decisionAt: new Date(decisionAt).toISOString(),
    sourceRecords: ordered.map((row) => ({
      recordId: row.recordId,
      recordSha256: row.recordSha256,
      availableAt: row.availableAt,
      proofEvidenceSha256: row.proofEvidenceSha256
    })),
    states,
    activationAuthority: false
  };
  return {
    status: 'OK',
    bundle: { ...core, bundleSha256: sha256(canonicalVNextJson(core)) }
  };
}

function stage(result, name) {
  return [...(result?.stages ?? [])].reverse().find((artifact) => (
    artifact.stage === name
  )) ?? null;
}

export function deriveVNextStrategyStateBundle({
  sourceStore,
  homeDir,
  records,
  decisionAt,
  parentFamily
} = {}) {
  if (!sourceStore || !Array.isArray(records)
      || validateAdaptiveRecord(parentFamily).status !== 'OK'
      || parentFamily.schemaVersion !== 'mechanism-family-v1') {
    return refused('VNEXT_STRATEGY_STATE_INPUT_INVALID', 'Strategy state derivation requires a source store, evidence records, and parent family.');
  }
  const authority = createVNextEvidenceAuthorityVerifier({ sourceStore, homeDir });
  if (authority.status !== 'OK') return authority;
  const snapshots = [];
  for (const record of [...records].sort((left, right) => (
    left.availableAt.localeCompare(right.availableAt)
      || left.recordId.localeCompare(right.recordId)
  ))) {
    if (validateVNextEvidenceRecord(record).status !== 'OK'
        || record.verifierEligible !== true
        || Date.parse(record.availableAt) > Date.parse(decisionAt)) continue;
    const replay = authority.verifier(record);
    if (replay.status !== 'OK') return replay;
    const derived = deriveVNextRecursiveEvidence({
      sourceStore,
      runId: record.authority.sourceRunId
    });
    if (derived.status !== 'OK'
        || derived.record.recordSha256 !== record.recordSha256) {
      return refused(
        'VNEXT_STRATEGY_STATE_RECORD_DRIFT',
        'A verifier-owned evidence row no longer derives from the same source run.'
      );
    }
    const candidate = stage(derived.preparation.result, VNEXT_STAGE.CANDIDATE)
      ?.payload?.candidate;
    const hypothesis = stage(derived.preparation.result, VNEXT_STAGE.HYPOTHESIS)
      ?.payload?.hypothesis;
    const summary = derived.verification.confirmationAnalysis?.summary
      ?? derived.verification.calibrationAnalysis?.summary;
    const regressions = Number(summary?.targetRegressions ?? 0)
      + Number(summary?.controlRegressions ?? 0);
    const tags = record.compatibility.tags.filter(isSafeId).slice(0, 32);
    if (!candidate || !hypothesis || !Array.isArray(candidate.operations)
        || !isSafeId(record.content.candidateFamilyId)
        || !Number.isInteger(regressions) || regressions < 0
        || !tags.length) {
      return refused(
        'VNEXT_STRATEGY_STATE_SOURCE_INCOMPLETE',
        'A verifier-owned source lacks the candidate, hypothesis, family, tags, or regression evidence required for strategy state.'
      );
    }
    snapshots.push({
      recordId: record.recordId,
      recordSha256: record.recordSha256,
      availableAt: record.availableAt,
      kind: record.kind,
      lifecycle: record.lifecycle.state,
      qualityDelta: finite(record.metrics.qualityDelta),
      tokenCost: finite(record.metrics.tokenCost),
      regressions,
      candidateFamilyId: record.content.candidateFamilyId,
      component: candidate.component,
      strategy: candidate.strategy,
      hypothesis: hypothesis.statement,
      operations: structuredClone(candidate.operations),
      tags,
      proofEvidenceSha256: derived.verification.evidenceSha256
    });
  }
  return snapshots.length
    ? buildVNextStrategyStateBundle({ snapshots, decisionAt })
    : refused(
        'VNEXT_STRATEGY_STATE_NO_ELIGIBLE_HISTORY',
        'No chronological verifier-owned recursive history was eligible.'
      );
}

export function validateVNextStrategyStateBundle(bundle) {
  if (!exactKeys(bundle, [
    'schemaVersion', 'decisionAt', 'sourceRecords', 'states',
    'activationAuthority', 'bundleSha256'
  ]) || bundle.schemaVersion !== VNEXT_STRATEGY_STATE_BUNDLE_SCHEMA
      || !Number.isFinite(Date.parse(bundle.decisionAt))
      || !Array.isArray(bundle.sourceRecords)
      || !exactKeys(bundle.states, STRATEGIES)
      || bundle.activationAuthority !== false
      || !SHA256.test(String(bundle.bundleSha256 || ''))) {
    return refused('VNEXT_STRATEGY_STATE_BUNDLE_INVALID', 'Strategy state bundle shape is invalid.');
  }
  const core = structuredClone(bundle);
  delete core.bundleSha256;
  return bundle.bundleSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', bundle }
    : refused('VNEXT_STRATEGY_STATE_BUNDLE_TAMPERED', 'Strategy state bundle hash failed replay.');
}
