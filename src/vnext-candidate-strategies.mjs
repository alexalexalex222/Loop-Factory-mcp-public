import { isAbsoluteOnAnyPlatform, isSafeId, sha256 } from './util.mjs';
import { isAbsolute } from 'node:path';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_CANDIDATE_STRATEGY_PLAN_SCHEMA =
  'vnext-candidate-strategy-plan-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_PATH = /\.(?:c|cc|css|go|h|html|java|js|json|jsx|md|mjs|py|rs|ts|tsx|yaml|yml)$/;
const STRATEGIES = new Set([
  'native',
  'reflective-pareto',
  'bounded-skill',
  'bank-recombination',
  'code-level-experimental'
]);

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function boundedText(value, maximum = 4000) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\0\r]/.test(value);
}

function safeIds(values, maximum = 128) {
  return Array.isArray(values)
    && values.length <= maximum
    && values.every(isSafeId)
    && new Set(values).size === values.length;
}

function safeTarget(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 500
    && value === value.trim()
    && !isAbsoluteOnAnyPlatform(value)
    && !/(?:^|\/)\.\.(?:\/|$)/.test(value)
    && !/[\\\0-\x1f\x7f]/.test(value);
}

function atOrBefore(value, decisionTime) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && Date.parse(value) <= Date.parse(decisionTime);
}

function selectedEvidenceSet(base) {
  return new Set(base.selectedEvidence.map(({ id }) => id));
}

function allowedTargetSet(base) {
  return new Set(base.allowedTargets.map(({ target }) => target));
}

function trajectoryRows(state, base) {
  if (!exactKeys(state, ['trajectories'])
      || !Array.isArray(state.trajectories)
      || state.trajectories.length < 2
      || state.trajectories.length > 64) return null;
  const evidence = selectedEvidenceSet(base);
  const rows = state.trajectories.map((row) => {
    if (!exactKeys(row, [
      'availableAt', 'evidenceIds', 'outcome', 'quality', 'regressions',
      'summary', 'tokenCost', 'trajectoryId'
    ])
        || !isSafeId(row.trajectoryId)
        || !['success', 'failure', 'tradeoff'].includes(row.outcome)
        || !Number.isFinite(row.quality)
        || !Number.isFinite(row.tokenCost) || row.tokenCost < 0
        || !Number.isInteger(row.regressions) || row.regressions < 0
        || !boundedText(row.summary, 3000)
        || !safeIds(row.evidenceIds, 32)
        || row.evidenceIds.length < 1
        || row.evidenceIds.some((id) => !evidence.has(id))
        || !atOrBefore(row.availableAt, base.decisionTime)) return null;
    return {
      trajectoryId: row.trajectoryId,
      outcome: row.outcome,
      quality: row.quality,
      tokenCost: row.tokenCost,
      regressions: row.regressions,
      summary: row.summary.trim(),
      evidenceIds: [...row.evidenceIds].sort(),
      availableAt: new Date(row.availableAt).toISOString()
    };
  });
  if (rows.some((row) => row == null)
      || new Set(rows.map(({ trajectoryId }) => trajectoryId)).size !== rows.length
      || !rows.some(({ outcome }) => outcome === 'success')
      || !rows.some(({ outcome }) => outcome !== 'success')) return null;
  return rows.sort((left, right) => left.trajectoryId.localeCompare(right.trajectoryId));
}

function dominates(left, right) {
  const noWorse = left.quality >= right.quality
    && left.tokenCost <= right.tokenCost
    && left.regressions <= right.regressions;
  const strictlyBetter = left.quality > right.quality
    || left.tokenCost < right.tokenCost
    || left.regressions < right.regressions;
  return noWorse && strictlyBetter;
}

function reflectiveParetoPlan(state, base) {
  const trajectories = trajectoryRows(state, base);
  if (!trajectories) return null;
  const frontier = trajectories.filter((row) => (
    !trajectories.some((other) => other !== row && dominates(other, row))
  )).sort((left, right) => (
    right.quality - left.quality
      || left.regressions - right.regressions
      || left.tokenCost - right.tokenCost
      || left.trajectoryId.localeCompare(right.trajectoryId)
  ));
  const failures = trajectories.filter(({ outcome }) => outcome !== 'success')
    .sort((left, right) => (
      right.regressions - left.regressions
        || left.quality - right.quality
        || right.tokenCost - left.tokenCost
        || left.trajectoryId.localeCompare(right.trajectoryId)
    ));
  return {
    plannerId: 'reflective-pareto-v1',
    context: {
      trajectories,
      paretoFrontierIds: frontier.map(({ trajectoryId }) => trajectoryId),
      failureTrajectoryIds: failures.map(({ trajectoryId }) => trajectoryId),
      archiveSha256: sha256(canonicalVNextJson(trajectories))
    },
    policy: {
      preserveParetoFrontier: true,
      requireFrontierEvidence: true,
      requireFailureEvidence: true,
      maximumPrimaryChanges: 1
    }
  };
}

function reflectionRows(values, decisionTime, evidence, label) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) return null;
  const rows = values.map((row) => {
    if (!exactKeys(row, ['availableAt', 'evidenceId', 'reflectionId', 'statement'])
        || !isSafeId(row.reflectionId)
        || !isSafeId(row.evidenceId)
        || !evidence.has(row.evidenceId)
        || !boundedText(row.statement, 2000)
        || !atOrBefore(row.availableAt, decisionTime)) return null;
    return {
      reflectionId: row.reflectionId,
      evidenceId: row.evidenceId,
      statement: row.statement.trim(),
      availableAt: new Date(row.availableAt).toISOString(),
      kind: label
    };
  });
  if (rows.some((row) => row == null)
      || new Set(rows.map(({ reflectionId }) => reflectionId)).size !== rows.length) return null;
  return rows.sort((left, right) => left.reflectionId.localeCompare(right.reflectionId));
}

function boundedSkillPlan(state, base) {
  if (!exactKeys(state, [
    'failureReflections', 'limits', 'skill', 'successReflections'
  ])
      || !exactKeys(state.skill, ['items', 'skillId', 'version'])
      || !isSafeId(state.skill.skillId)
      || !isSafeId(state.skill.version)
      || !Array.isArray(state.skill.items)
      || state.skill.items.length < 1
      || state.skill.items.length > 128
      || !exactKeys(state.limits, ['maximumChangedBytes', 'maximumChangedItems'])
      || !Number.isInteger(state.limits.maximumChangedItems)
      || state.limits.maximumChangedItems < 1
      || state.limits.maximumChangedItems > 3
      || !Number.isInteger(state.limits.maximumChangedBytes)
      || state.limits.maximumChangedBytes < 1
      || state.limits.maximumChangedBytes > 24_000) return null;
  const allowed = allowedTargetSet(base);
  const items = state.skill.items.map((item) => {
    if (!exactKeys(item, ['sha256', 'target', 'value'])
        || !safeTarget(item.target)
        || !allowed.has(item.target)
        || !SHA256.test(String(item.sha256 || ''))
        || !boundedText(item.value, 8000)
        || sha256(item.value) !== item.sha256) return null;
    return { target: item.target, sha256: item.sha256, value: item.value };
  });
  if (items.some((item) => item == null)
      || new Set(items.map(({ target }) => target)).size !== items.length) return null;
  const evidence = selectedEvidenceSet(base);
  const successes = reflectionRows(
    state.successReflections, base.decisionTime, evidence, 'success'
  );
  const failures = reflectionRows(
    state.failureReflections, base.decisionTime, evidence, 'failure'
  );
  if (!successes || !failures) return null;
  return {
    plannerId: 'bounded-skill-v1',
    context: {
      skill: {
        skillId: state.skill.skillId,
        version: state.skill.version,
        items: items.sort((left, right) => left.target.localeCompare(right.target))
      },
      successReflections: successes,
      failureReflections: failures
    },
    policy: {
      maximumChangedItems: state.limits.maximumChangedItems,
      maximumChangedBytes: state.limits.maximumChangedBytes,
      reflectOnSuccessAndFailureSeparately: true,
      allowedOperations: ['add', 'delete', 'replace']
    }
  };
}

function bankRecombinationPlan(state, base) {
  if (!exactKeys(state, ['mechanisms', 'targetTags'])
      || !safeIds(state.targetTags, 32)
      || state.targetTags.length < 1
      || !Array.isArray(state.mechanisms)
      || state.mechanisms.length < 2
      || state.mechanisms.length > 128) return null;
  const evidence = selectedEvidenceSet(base);
  const rows = state.mechanisms.map((row) => {
    if (!exactKeys(row, [
      'compatibilityTags', 'component', 'content', 'evidenceIds', 'familyId',
      'incompatibleWith', 'lifecycle', 'mechanismId', 'operationKind',
      'qualityDelta', 'regressions', 'sha256'
    ])
        || !isSafeId(row.mechanismId)
        || !isSafeId(row.familyId)
        || !boundedText(row.component, 120)
        || !boundedText(row.operationKind, 120)
        || !boundedText(row.content, 4000)
        || !safeIds(row.compatibilityTags, 32)
        || !safeIds(row.incompatibleWith, 64)
        || !safeIds(row.evidenceIds, 32)
        || row.evidenceIds.length < 1
        || row.evidenceIds.some((id) => !evidence.has(id))
        || !['replicated', 'validated', 'contradicted', 'quarantined'].includes(row.lifecycle)
        || !Number.isFinite(row.qualityDelta)
        || !Number.isInteger(row.regressions) || row.regressions < 0
        || !SHA256.test(String(row.sha256 || ''))
        || sha256(row.content) !== row.sha256) return null;
    return {
      mechanismId: row.mechanismId,
      familyId: row.familyId,
      component: row.component,
      operationKind: row.operationKind,
      content: row.content,
      compatibilityTags: [...row.compatibilityTags].sort(),
      incompatibleWith: [...row.incompatibleWith].sort(),
      evidenceIds: [...row.evidenceIds].sort(),
      lifecycle: row.lifecycle,
      qualityDelta: row.qualityDelta,
      regressions: row.regressions,
      sha256: row.sha256
    };
  });
  if (rows.some((row) => row == null)
      || new Set(rows.map(({ mechanismId }) => mechanismId)).size !== rows.length) return null;
  const targetTags = new Set(state.targetTags);
  const eligible = rows.filter((row) => (
    ['replicated', 'validated'].includes(row.lifecycle)
      && row.component === base.allowedComponent
      && row.qualityDelta > 0
      && row.regressions === 0
      && row.compatibilityTags.some((tag) => targetTags.has(tag))
  ));
  const pairs = [];
  for (let left = 0; left < eligible.length; left += 1) {
    for (let right = left + 1; right < eligible.length; right += 1) {
      const a = eligible[left];
      const b = eligible[right];
      if (a.familyId === b.familyId
          || a.incompatibleWith.includes(b.mechanismId)
          || b.incompatibleWith.includes(a.mechanismId)) continue;
      const tagOverlap = new Set([
        ...a.compatibilityTags.filter((tag) => b.compatibilityTags.includes(tag)),
        ...a.compatibilityTags.filter((tag) => targetTags.has(tag)),
        ...b.compatibilityTags.filter((tag) => targetTags.has(tag))
      ]).size;
      pairs.push({
        donors: [a, b].sort((x, y) => x.mechanismId.localeCompare(y.mechanismId)),
        score: a.qualityDelta + b.qualityDelta + tagOverlap
      });
    }
  }
  pairs.sort((left, right) => (
    right.score - left.score
      || left.donors.map(({ mechanismId }) => mechanismId).join(':')
        .localeCompare(right.donors.map(({ mechanismId }) => mechanismId).join(':'))
  ));
  if (!pairs.length) return null;
  const donors = pairs[0].donors;
  return {
    plannerId: 'bank-recombination-v1',
    context: {
      targetTags: [...state.targetTags].sort(),
      donors,
      donorSelectionSha256: sha256(canonicalVNextJson(donors)),
      rejectedMechanismIds: rows
        .filter((row) => !donors.some(({ mechanismId }) => mechanismId === row.mechanismId))
        .map(({ mechanismId }) => mechanismId)
        .sort()
    },
    policy: {
      requireRecombineOperation: true,
      requireEveryDonorEvidence: true,
      requireDistinctFamilies: true,
      maximumPrimaryChanges: 1
    }
  };
}

function codeLevelPlan(state, base) {
  if (!exactKeys(state, [
    'disposableWorktree', 'maximumFiles', 'maximumPatchBytes', 'requiredTests'
  ])
      || state.disposableWorktree !== true
      || !Number.isInteger(state.maximumFiles)
      || state.maximumFiles < 1
      || state.maximumFiles > 3
      || !Number.isInteger(state.maximumPatchBytes)
      || state.maximumPatchBytes < 1
      || state.maximumPatchBytes > 64 * 1024
      || !Array.isArray(state.requiredTests)
      || state.requiredTests.length < 1
      || state.requiredTests.length > 32
      || !state.requiredTests.every((test) => (
        exactKeys(test, ['args', 'executable', 'executableSha256', 'testId', 'timeoutMs'])
          && isSafeId(test.testId)
          && typeof test.executable === 'string'
          && isAbsolute(test.executable)
          && test.executable.length <= 500
          && !/[\0\r\n]/.test(test.executable)
          && SHA256.test(String(test.executableSha256 || ''))
          && Array.isArray(test.args)
          && test.args.length <= 64
          && test.args.every((arg) => typeof arg === 'string' && arg.length <= 1000 && !/[\0\r\n]/.test(arg))
          && Number.isInteger(test.timeoutMs)
          && test.timeoutMs >= 100
          && test.timeoutMs <= 30 * 60 * 1000
      ))) return null;
  const sourceTargets = base.allowedTargets
    .filter(({ target }) => SOURCE_PATH.test(target))
    .map(({ sourceSha256, target }) => ({ sourceSha256, target }));
  if (!sourceTargets.length) return null;
  return {
    plannerId: 'guarded-code-level-v1',
    context: {
      sourceTargets,
      requiredTests: structuredClone(state.requiredTests)
        .sort((left, right) => left.testId.localeCompare(right.testId))
    },
    policy: {
      disposableWorktree: true,
      maximumFiles: state.maximumFiles,
      maximumPatchBytes: state.maximumPatchBytes,
      allowedOperations: ['replace'],
      networkDuringExecution: false,
      activationAuthority: false
    }
  };
}

function planBody(strategy, state, base) {
  if (strategy === 'native') {
    if (state != null && canonicalVNextJson(state) !== '{}') return null;
    return {
      plannerId: 'native-evidence-edit-v1',
      context: {
        selectedEvidenceIds: base.selectedEvidence.map(({ id }) => id),
        allowedTargets: base.allowedTargets.map(({ target }) => target)
      },
      policy: {
        directEvidenceEdit: true,
        maximumPrimaryChanges: base.maximumOperations
      }
    };
  }
  if (!plainObject(state)) return null;
  if (strategy === 'reflective-pareto') return reflectiveParetoPlan(state, base);
  if (strategy === 'bounded-skill') return boundedSkillPlan(state, base);
  if (strategy === 'bank-recombination') return bankRecombinationPlan(state, base);
  if (strategy === 'code-level-experimental') return codeLevelPlan(state, base);
  return null;
}

export function candidateStrategyRequiredEvidenceIds(strategy, state) {
  if (!STRATEGIES.has(strategy)) return null;
  if (strategy === 'native' || strategy === 'code-level-experimental') return [];
  if (!plainObject(state)) return null;
  let values;
  if (strategy === 'reflective-pareto') {
    values = Array.isArray(state.trajectories)
      ? state.trajectories.flatMap((row) => row?.evidenceIds ?? [])
      : null;
  } else if (strategy === 'bounded-skill') {
    values = [
      ...(state.successReflections ?? []),
      ...(state.failureReflections ?? [])
    ].map((row) => row?.evidenceId);
  } else {
    values = Array.isArray(state.mechanisms)
      ? state.mechanisms.flatMap((row) => row?.evidenceIds ?? [])
      : null;
  }
  if (!Array.isArray(values) || values.length < 1
      || values.some((id) => !isSafeId(id))) return null;
  return [...new Set(values)].sort();
}

export function createCandidateStrategyPlan(strategy, state, base = {}) {
  if (!STRATEGIES.has(strategy)
      || typeof base.decisionTime !== 'string'
      || !Number.isFinite(Date.parse(base.decisionTime))
      || !Array.isArray(base.selectedEvidence)
      || !Array.isArray(base.allowedTargets)
      || !boundedText(base.allowedComponent, 120)
      || !Number.isInteger(base.maximumOperations)) {
    return refused('VNEXT_CANDIDATE_STRATEGY_INPUT_INVALID', 'Strategy planning requires frozen evidence, targets, component, operation budget, and decision time.');
  }
  const body = planBody(strategy, state ?? null, base);
  if (!body) {
    return refused('VNEXT_CANDIDATE_STRATEGY_STATE_INVALID', `Strategy state is invalid or insufficient for ${strategy}.`);
  }
  const core = {
    schemaVersion: VNEXT_CANDIDATE_STRATEGY_PLAN_SCHEMA,
    strategy,
    plannerId: body.plannerId,
    plannerVersion: 'v1',
    decisionTime: new Date(base.decisionTime).toISOString(),
    inputSha256: sha256(canonicalVNextJson({
      state: state ?? null,
      selectedEvidence: base.selectedEvidence,
      allowedTargets: base.allowedTargets,
      allowedComponent: base.allowedComponent,
      maximumOperations: base.maximumOperations
    })),
    context: body.context,
    policy: body.policy,
    activationAuthority: false
  };
  return {
    status: 'OK',
    plan: Object.freeze({
      ...core,
      planSha256: sha256(canonicalVNextJson(core))
    })
  };
}

function normalizedTrajectoryValid(row, decisionTime) {
  return exactKeys(row, [
    'availableAt', 'evidenceIds', 'outcome', 'quality', 'regressions',
    'summary', 'tokenCost', 'trajectoryId'
  ])
    && isSafeId(row.trajectoryId)
    && ['success', 'failure', 'tradeoff'].includes(row.outcome)
    && Number.isFinite(row.quality)
    && Number.isFinite(row.tokenCost) && row.tokenCost >= 0
    && Number.isInteger(row.regressions) && row.regressions >= 0
    && boundedText(row.summary, 3000)
    && safeIds(row.evidenceIds, 32) && row.evidenceIds.length > 0
    && atOrBefore(row.availableAt, decisionTime);
}

function normalizedReflectionValid(row, decisionTime, kind) {
  return exactKeys(row, [
    'availableAt', 'evidenceId', 'kind', 'reflectionId', 'statement'
  ])
    && isSafeId(row.reflectionId)
    && isSafeId(row.evidenceId)
    && row.kind === kind
    && boundedText(row.statement, 2000)
    && atOrBefore(row.availableAt, decisionTime);
}

function normalizedDonorValid(row) {
  return exactKeys(row, [
    'compatibilityTags', 'component', 'content', 'evidenceIds', 'familyId',
    'incompatibleWith', 'lifecycle', 'mechanismId', 'operationKind',
    'qualityDelta', 'regressions', 'sha256'
  ])
    && isSafeId(row.mechanismId)
    && isSafeId(row.familyId)
    && boundedText(row.component, 120)
    && boundedText(row.operationKind, 120)
    && boundedText(row.content, 4000)
    && safeIds(row.compatibilityTags, 32)
    && safeIds(row.incompatibleWith, 64)
    && safeIds(row.evidenceIds, 32) && row.evidenceIds.length > 0
    && ['replicated', 'validated'].includes(row.lifecycle)
    && Number.isFinite(row.qualityDelta) && row.qualityDelta > 0
    && row.regressions === 0
    && SHA256.test(String(row.sha256 || ''))
    && sha256(row.content) === row.sha256;
}

function semanticPlanValid(plan) {
  if (plan.strategy === 'native') {
    return plan.plannerId === 'native-evidence-edit-v1'
      && exactKeys(plan.context, ['allowedTargets', 'selectedEvidenceIds'])
      && safeIds(plan.context.selectedEvidenceIds)
      && Array.isArray(plan.context.allowedTargets)
      && plan.context.allowedTargets.length > 0
      && plan.context.allowedTargets.every(safeTarget)
      && exactKeys(plan.policy, ['directEvidenceEdit', 'maximumPrimaryChanges'])
      && plan.policy.directEvidenceEdit === true
      && Number.isInteger(plan.policy.maximumPrimaryChanges)
      && plan.policy.maximumPrimaryChanges >= 1
      && plan.policy.maximumPrimaryChanges <= 3;
  }
  if (plan.strategy === 'reflective-pareto') {
    if (plan.plannerId !== 'reflective-pareto-v1'
        || !exactKeys(plan.context, [
          'archiveSha256', 'failureTrajectoryIds', 'paretoFrontierIds', 'trajectories'
        ])
        || !Array.isArray(plan.context.trajectories)
        || plan.context.trajectories.length < 2
        || !plan.context.trajectories.every((row) => normalizedTrajectoryValid(row, plan.decisionTime))
        || !safeIds(plan.context.paretoFrontierIds)
        || !safeIds(plan.context.failureTrajectoryIds)
        || plan.context.paretoFrontierIds.length < 1
        || plan.context.failureTrajectoryIds.length < 1
        || plan.context.archiveSha256 !== sha256(canonicalVNextJson(plan.context.trajectories))
        || !exactKeys(plan.policy, [
          'maximumPrimaryChanges', 'preserveParetoFrontier',
          'requireFailureEvidence', 'requireFrontierEvidence'
        ])
        || plan.policy.preserveParetoFrontier !== true
        || plan.policy.requireFailureEvidence !== true
        || plan.policy.requireFrontierEvidence !== true
        || plan.policy.maximumPrimaryChanges !== 1) return false;
    const byId = new Map(plan.context.trajectories.map((row) => [row.trajectoryId, row]));
    return plan.context.paretoFrontierIds.every((id) => byId.has(id))
      && plan.context.failureTrajectoryIds.every((id) => byId.get(id)?.outcome !== 'success');
  }
  if (plan.strategy === 'bounded-skill') {
    if (plan.plannerId !== 'bounded-skill-v1'
        || !exactKeys(plan.context, ['failureReflections', 'skill', 'successReflections'])
        || !exactKeys(plan.context.skill, ['items', 'skillId', 'version'])
        || !isSafeId(plan.context.skill.skillId)
        || !isSafeId(plan.context.skill.version)
        || !Array.isArray(plan.context.skill.items)
        || plan.context.skill.items.length < 1
        || !plan.context.skill.items.every((item) => (
          exactKeys(item, ['sha256', 'target', 'value'])
            && safeTarget(item.target)
            && boundedText(item.value, 8000)
            && item.sha256 === sha256(item.value)
        ))
        || !Array.isArray(plan.context.successReflections)
        || !Array.isArray(plan.context.failureReflections)
        || plan.context.successReflections.length < 1
        || plan.context.failureReflections.length < 1
        || !plan.context.successReflections.every((row) => normalizedReflectionValid(row, plan.decisionTime, 'success'))
        || !plan.context.failureReflections.every((row) => normalizedReflectionValid(row, plan.decisionTime, 'failure'))
        || !exactKeys(plan.policy, [
          'allowedOperations', 'maximumChangedBytes', 'maximumChangedItems',
          'reflectOnSuccessAndFailureSeparately'
        ])
        || canonicalVNextJson(plan.policy.allowedOperations) !== canonicalVNextJson(['add', 'delete', 'replace'])
        || !Number.isInteger(plan.policy.maximumChangedItems)
        || plan.policy.maximumChangedItems < 1 || plan.policy.maximumChangedItems > 3
        || !Number.isInteger(plan.policy.maximumChangedBytes)
        || plan.policy.maximumChangedBytes < 1 || plan.policy.maximumChangedBytes > 24_000
        || plan.policy.reflectOnSuccessAndFailureSeparately !== true) return false;
    return true;
  }
  if (plan.strategy === 'bank-recombination') {
    if (plan.plannerId !== 'bank-recombination-v1'
        || !exactKeys(plan.context, [
          'donorSelectionSha256', 'donors', 'rejectedMechanismIds', 'targetTags'
        ])
        || !safeIds(plan.context.targetTags, 32)
        || plan.context.targetTags.length < 1
        || !Array.isArray(plan.context.donors)
        || plan.context.donors.length !== 2
        || !plan.context.donors.every(normalizedDonorValid)
        || plan.context.donors[0].familyId === plan.context.donors[1].familyId
        || plan.context.donors[0].incompatibleWith.includes(plan.context.donors[1].mechanismId)
        || plan.context.donors[1].incompatibleWith.includes(plan.context.donors[0].mechanismId)
        || plan.context.donorSelectionSha256 !== sha256(canonicalVNextJson(plan.context.donors))
        || !safeIds(plan.context.rejectedMechanismIds)
        || !exactKeys(plan.policy, [
          'maximumPrimaryChanges', 'requireDistinctFamilies',
          'requireEveryDonorEvidence', 'requireRecombineOperation'
        ])
        || plan.policy.maximumPrimaryChanges !== 1
        || plan.policy.requireDistinctFamilies !== true
        || plan.policy.requireEveryDonorEvidence !== true
        || plan.policy.requireRecombineOperation !== true) return false;
    return true;
  }
  return plan.strategy === 'code-level-experimental'
    && plan.plannerId === 'guarded-code-level-v1'
    && exactKeys(plan.context, ['requiredTests', 'sourceTargets'])
    && Array.isArray(plan.context.sourceTargets)
    && plan.context.sourceTargets.length > 0
    && plan.context.sourceTargets.every((row) => (
      exactKeys(row, ['sourceSha256', 'target'])
        && safeTarget(row.target)
        && SOURCE_PATH.test(row.target)
        && SHA256.test(String(row.sourceSha256 || ''))
    ))
    && Array.isArray(plan.context.requiredTests)
    && plan.context.requiredTests.length > 0
    && plan.context.requiredTests.every((test) => (
      exactKeys(test, ['args', 'executable', 'executableSha256', 'testId', 'timeoutMs'])
        && isSafeId(test.testId)
        && typeof test.executable === 'string' && isAbsolute(test.executable)
        && test.executable.length <= 500 && !/[\0\r\n]/.test(test.executable)
        && SHA256.test(String(test.executableSha256 || ''))
        && Array.isArray(test.args) && test.args.length <= 64
        && test.args.every((arg) => typeof arg === 'string' && arg.length <= 1000 && !/[\0\r\n]/.test(arg))
        && Number.isInteger(test.timeoutMs)
        && test.timeoutMs >= 100 && test.timeoutMs <= 30 * 60 * 1000
    ))
    && exactKeys(plan.policy, [
      'activationAuthority', 'allowedOperations', 'disposableWorktree',
      'maximumFiles', 'maximumPatchBytes', 'networkDuringExecution'
    ])
    && plan.policy.disposableWorktree === true
    && plan.policy.activationAuthority === false
    && plan.policy.networkDuringExecution === false
    && canonicalVNextJson(plan.policy.allowedOperations) === canonicalVNextJson(['replace'])
    && Number.isInteger(plan.policy.maximumFiles)
    && plan.policy.maximumFiles >= 1 && plan.policy.maximumFiles <= 3
    && Number.isInteger(plan.policy.maximumPatchBytes)
    && plan.policy.maximumPatchBytes >= 1 && plan.policy.maximumPatchBytes <= 64 * 1024;
}

export function validateCandidateStrategyPlan(plan) {
  if (!exactKeys(plan, [
    'activationAuthority', 'context', 'decisionTime', 'inputSha256', 'planSha256',
    'plannerId', 'plannerVersion', 'policy', 'schemaVersion', 'strategy'
  ])
      || plan.schemaVersion !== VNEXT_CANDIDATE_STRATEGY_PLAN_SCHEMA
      || !STRATEGIES.has(plan.strategy)
      || !isSafeId(plan.plannerId)
      || plan.plannerVersion !== 'v1'
      || !Number.isFinite(Date.parse(plan.decisionTime))
      || !SHA256.test(String(plan.inputSha256 || ''))
      || !SHA256.test(String(plan.planSha256 || ''))
      || !plainObject(plan.context)
      || !plainObject(plan.policy)
      || plan.activationAuthority !== false
      || !semanticPlanValid(plan)) {
    return refused('VNEXT_CANDIDATE_STRATEGY_PLAN_INVALID', 'Strategy plan shape is invalid.');
  }
  const core = structuredClone(plan);
  delete core.planSha256;
  if (sha256(canonicalVNextJson(core)) !== plan.planSha256) {
    return refused('VNEXT_CANDIDATE_STRATEGY_PLAN_TAMPERED', 'Strategy plan hash does not match its content.');
  }
  return { status: 'OK', plan: structuredClone(plan) };
}

function evidenceFromTrajectories(rows) {
  return new Set(rows.flatMap(({ evidenceIds }) => evidenceIds));
}

export function validateCandidateForStrategy(candidate, plan) {
  const valid = validateCandidateStrategyPlan(plan);
  if (valid.status !== 'OK' || candidate?.strategy !== plan?.strategy) {
    return refused('VNEXT_CANDIDATE_STRATEGY_MISMATCH', 'Candidate does not match its strategy plan.');
  }
  const evidence = new Set(candidate.evidenceIds ?? []);
  if (plan.strategy === 'reflective-pareto') {
    const rows = plan.context.trajectories;
    const byId = new Map(rows.map((row) => [row.trajectoryId, row]));
    const frontierEvidence = evidenceFromTrajectories(
      plan.context.paretoFrontierIds.map((id) => byId.get(id))
    );
    const failureEvidence = evidenceFromTrajectories(
      plan.context.failureTrajectoryIds.map((id) => byId.get(id))
    );
    if (candidate.operations.length > plan.policy.maximumPrimaryChanges
        || ![...frontierEvidence].some((id) => evidence.has(id))
        || ![...failureEvidence].some((id) => evidence.has(id))) {
      return refused('VNEXT_REFLECTIVE_PARETO_CONTRACT_VIOLATION', 'Reflective candidates must cite frontier and failure trajectories and make one primary change.');
    }
  } else if (plan.strategy === 'bounded-skill') {
    const successEvidence = new Set(plan.context.successReflections.map(({ evidenceId }) => evidenceId));
    const failureEvidence = new Set(plan.context.failureReflections.map(({ evidenceId }) => evidenceId));
    const changedBytes = candidate.operations.reduce((sum, operation) => (
      sum + Buffer.byteLength(operation.value ?? '')
    ), 0);
    if (candidate.operations.length > plan.policy.maximumChangedItems
        || changedBytes > plan.policy.maximumChangedBytes
        || candidate.operations.some(({ op }) => !plan.policy.allowedOperations.includes(op))
        || ![...successEvidence].some((id) => evidence.has(id))
        || ![...failureEvidence].some((id) => evidence.has(id))) {
      return refused('VNEXT_BOUNDED_SKILL_CONTRACT_VIOLATION', 'Bounded skill candidates must stay inside edit limits and cite separate success and failure reflections.');
    }
  } else if (plan.strategy === 'bank-recombination') {
    const donorIds = plan.context.donors.map(({ mechanismId }) => mechanismId);
    const donorEvidence = plan.context.donors.map(({ evidenceIds }) => evidenceIds);
    const values = candidate.operations.map(({ value }) => value ?? '').join('\n');
    if (candidate.operations.length > plan.policy.maximumPrimaryChanges
        || candidate.operations.some(({ op }) => op !== 'recombine')
        || donorIds.some((id) => !values.includes(id))
        || donorEvidence.some((ids) => !ids.some((id) => evidence.has(id)))) {
      return refused('VNEXT_BANK_RECOMBINATION_CONTRACT_VIOLATION', 'Bank recombination must cite and explicitly recombine both compatible donors.');
    }
  } else if (plan.strategy === 'code-level-experimental') {
    const changedBytes = candidate.operations.reduce((sum, operation) => (
      sum + Buffer.byteLength(operation.value ?? '')
    ), 0);
    const sourceByTarget = new Map(
      plan.context.sourceTargets.map((row) => [row.target, row.sourceSha256])
    );
    if (candidate.operations.length > plan.policy.maximumFiles
        || changedBytes > plan.policy.maximumPatchBytes
        || candidate.operations.some(({ beforeSha256, op, target }) => (
          !plan.policy.allowedOperations.includes(op)
            || !sourceByTarget.has(target)
            || beforeSha256 !== sourceByTarget.get(target)
        ))) {
      return refused('VNEXT_CODE_LEVEL_CONTRACT_VIOLATION', 'Code-level candidates must remain inside the disposable worktree file and patch budget.');
    }
  }
  return { status: 'OK' };
}

export function buildCandidateStrategyPrompt(plan, contract) {
  if (validateCandidateStrategyPlan(plan).status !== 'OK') return null;
  const preamble = {
    native: 'Use the frozen evidence directly to propose the smallest attributable edit.',
    'reflective-pareto': 'Reflect over every permitted trajectory. Preserve the Pareto frontier, diagnose failures separately, and make one targeted change that could improve the frontier.',
    'bounded-skill': 'Treat the frozen skill artifact as bounded editable state. Reflect separately on successes and failures, then revise only within the item and byte limits.',
    'bank-recombination': 'Recombine the two deterministically selected compatible donor mechanisms. Preserve donor lineage and explicitly name both donor IDs in the recombination value.',
    'code-level-experimental': 'Propose one task-agnostic source edit for a disposable worktree. Touch only listed source targets and remain within file and patch-byte limits.'
  }[plan.strategy];
  return [
    preamble,
    'Return strict JSON matching vnext-candidate-output-v1.',
    'Cite only frozen evidence, declare a measurable prediction and falsifier, and provide an exact rollback.',
    'You have no execution, scoring, admission, activation, deployment, evaluator, or sealed-task authority.',
    '',
    canonicalVNextJson({ strategyPlan: plan, candidateContract: contract })
  ].join('\n');
}
