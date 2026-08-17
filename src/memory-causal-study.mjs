import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  appendPaceTaskCluster,
  createPaceAcceptor,
  validatePaceState
} from './pace-acceptor.mjs';

export const MEMORY_CAUSAL_STUDY_SCHEMA = 'vnext-memory-causal-study-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const ARM_IDS = Object.freeze(['relevant-memory', 'no-memory', 'irrelevant-memory']);

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function idSet(values) {
  if (!Array.isArray(values) || values.some((id) => !isSafeId(id))) return null;
  return new Set(values);
}

function contractCore(contract) {
  if (!plainObject(contract)
      || typeof contract.model !== 'string' || !contract.model
      || typeof contract.reasoningEffort !== 'string' || !contract.reasoningEffort
      || !SHA256.test(String(contract.modelIdentitySha256 || ''))
      || !SHA256.test(String(contract.promptTemplateSha256 || ''))
      || !SHA256.test(String(contract.outputSchemaSha256 || ''))
      || !SHA256.test(String(contract.taskPackSha256 || ''))
      || !plainObject(contract.budget)) return null;
  const budgetCanonical = canonicalVNextJson(contract.budget);
  return {
    model: contract.model,
    reasoningEffort: contract.reasoningEffort,
    modelIdentitySha256: contract.modelIdentitySha256,
    promptTemplateSha256: contract.promptTemplateSha256,
    outputSchemaSha256: contract.outputSchemaSha256,
    taskPackSha256: contract.taskPackSha256,
    budgetSha256: sha256(budgetCanonical)
  };
}

function normalizedArm(arm) {
  const contract = contractCore(arm?.contract);
  const selectedRecordIds = idSet(arm?.selectedRecordIds);
  if (!plainObject(arm) || !ARM_IDS.includes(arm.armId) || !contract || !selectedRecordIds
      || !SHA256.test(String(arm.contextPackageSha256 || ''))
      || !Array.isArray(arm.taskClusters) || arm.taskClusters.length < 1) return null;
  const taskClusters = arm.taskClusters.map((cluster) => {
    if (!plainObject(cluster) || !isSafeId(cluster.taskId)
        || !isSafeId(cluster.sourceIdentity)
        || !Array.isArray(cluster.replicates) || cluster.replicates.length < 1) return null;
    const replicates = cluster.replicates.map((row) => (
      plainObject(row) && Number.isInteger(row.replicate) && row.replicate >= 0
      && Number.isFinite(row.quality)
      && Number.isInteger(row.tokenCost) && row.tokenCost >= 0
      && Number.isInteger(row.controlRegressions) && row.controlRegressions >= 0
      && SHA256.test(String(row.objectiveEvidenceSha256 || ''))
        ? {
            replicate: row.replicate,
            quality: row.quality,
            tokenCost: row.tokenCost,
            controlRegressions: row.controlRegressions,
            objectiveEvidenceSha256: row.objectiveEvidenceSha256
          }
        : null
    ));
    if (replicates.some((row) => row == null)
        || new Set(replicates.map(({ replicate }) => replicate)).size !== replicates.length) return null;
    replicates.sort((left, right) => left.replicate - right.replicate);
    return { taskId: cluster.taskId, sourceIdentity: cluster.sourceIdentity, replicates };
  });
  if (taskClusters.some((row) => row == null)
      || new Set(taskClusters.map(({ taskId }) => taskId)).size !== taskClusters.length) return null;
  taskClusters.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    armId: arm.armId,
    contract,
    contextPackageSha256: arm.contextPackageSha256,
    selectedRecordIds: [...selectedRecordIds].sort(),
    taskClusters
  };
}

function matchArms(arms) {
  const reference = arms[0];
  const sharedContract = {
    ...reference.contract,
    taskPackSha256: undefined
  };
  delete sharedContract.taskPackSha256;
  for (const arm of arms.slice(1)) {
    const compare = { ...arm.contract };
    delete compare.taskPackSha256;
    if (canonicalVNextJson(compare) !== canonicalVNextJson(sharedContract)) return false;
  }
  const shape = reference.taskClusters.map((cluster) => ({
    taskId: cluster.taskId,
    sourceIdentity: cluster.sourceIdentity,
    replicates: cluster.replicates.map(({ replicate }) => replicate)
  }));
  return arms.slice(1).every((arm) => canonicalVNextJson(arm.taskClusters.map((cluster) => ({
    taskId: cluster.taskId,
    sourceIdentity: cluster.sourceIdentity,
    replicates: cluster.replicates.map(({ replicate }) => replicate)
  }))) === canonicalVNextJson(shape));
}

function taskClusterPairs(candidate, incumbent) {
  const incumbentByTask = new Map(incumbent.taskClusters.map((row) => [row.taskId, row]));
  return candidate.taskClusters.map((cluster) => {
    const parent = incumbentByTask.get(cluster.taskId);
    const parentByReplicate = new Map(parent.replicates.map((row) => [row.replicate, row]));
    return {
      taskId: cluster.taskId,
      objectiveVerified: true,
      replicates: cluster.replicates.map((row) => ({
        replicate: row.replicate,
        candidate: row.quality,
        incumbent: parentByReplicate.get(row.replicate).quality
      }))
    };
  });
}

function runPace(candidate, incumbent, candidateId, alpha, familyAlpha, policySha256) {
  let state = createPaceAcceptor({
    candidateId,
    outerAlphaAllocation: {
      allocationId: `${candidateId}-allocation`,
      alpha,
      familyAlpha,
      policySha256
    },
    lambdaPolicy: { kind: 'fixed', value: 0.5 }
  }).state;
  const stepReceipts = [];
  for (const cluster of taskClusterPairs(candidate, incumbent)) {
    if (state.stopped) break;
    const next = appendPaceTaskCluster(state, cluster, {
      persistStep: (receipt) => stepReceipts.push(receipt)
    });
    if (next.status !== 'OK') return next;
    state = next.state;
  }
  return validatePaceState(state).status === 'OK'
    ? { status: 'OK', state, stepReceipts }
    : refused('MEMORY_STUDY_PACE_INVALID', 'PACE replay failed for a memory contrast.');
}

function armSummary(arm) {
  const rows = arm.taskClusters.flatMap(({ replicates }) => replicates);
  return {
    taskCount: arm.taskClusters.length,
    replicateCount: rows.length,
    meanQuality: rows.reduce((sum, row) => sum + row.quality, 0) / rows.length,
    totalTokens: rows.reduce((sum, row) => sum + row.tokenCost, 0),
    controlRegressions: rows.reduce((sum, row) => sum + row.controlRegressions, 0),
    objectiveEvidenceSha256: sha256(canonicalVNextJson(rows.map(({ objectiveEvidenceSha256 }) => objectiveEvidenceSha256)))
  };
}

export function analyzeMemoryCausalStudy(input = {}) {
  if (!isSafeId(input.studyId) || !SHA256.test(String(input.manifestSha256 || ''))
      || !plainObject(input.generationOne) || !plainObject(input.generationTwo)
      || !plainObject(input.policy)) {
    return refused('MEMORY_STUDY_INPUT_INVALID', 'Memory study requires a manifest, two generations, and a frozen policy.');
  }
  const learnedIds = idSet(input.generationOne.learnedRecordIds);
  const sourceIds = idSet(input.generationOne.sourceIdentities);
  const taskIds = idSet(input.generationTwo.taskIdentities);
  const irrelevantIds = idSet(input.generationTwo.irrelevantRecordIds);
  const arms = Array.isArray(input.arms) ? input.arms.map(normalizedArm) : [];
  if (!learnedIds || learnedIds.size < 1 || !sourceIds || !taskIds || !irrelevantIds
      || arms.length !== 3 || arms.some((arm) => arm == null)
      || new Set(arms.map(({ armId }) => armId)).size !== 3
      || [...sourceIds].some((id) => taskIds.has(id))
      || !matchArms(arms)
      || !Number.isFinite(input.policy.alpha) || input.policy.alpha <= 0 || input.policy.alpha >= 1
      || !Number.isFinite(input.policy.familyAlpha) || input.policy.familyAlpha < input.policy.alpha * 2
      || !Number.isFinite(input.policy.maximumRelativeTokenIncrease)
      || input.policy.maximumRelativeTokenIncrease < 0
      || !SHA256.test(String(input.policy.policySha256 || ''))) {
    return refused('MEMORY_STUDY_DESIGN_INVALID', 'Memory study design is not disjoint, arm-matched, or alpha-bound.');
  }
  const byId = new Map(arms.map((arm) => [arm.armId, arm]));
  const relevant = byId.get('relevant-memory');
  const none = byId.get('no-memory');
  const irrelevant = byId.get('irrelevant-memory');
  if (relevant.selectedRecordIds.length < 1
      || relevant.selectedRecordIds.some((id) => !learnedIds.has(id))
      || none.selectedRecordIds.length !== 0
      || irrelevant.selectedRecordIds.length < 1
      || irrelevant.selectedRecordIds.some((id) => !irrelevantIds.has(id) || learnedIds.has(id))) {
    return refused('MEMORY_STUDY_ARM_CONTAMINATION', 'Memory arm selections do not match their preregistered partitions.');
  }
  const relevantVsNone = runPace(
    relevant, none, `${input.studyId}-relevant-vs-none`,
    input.policy.alpha, input.policy.familyAlpha, input.policy.policySha256
  );
  const relevantVsIrrelevant = runPace(
    relevant, irrelevant, `${input.studyId}-relevant-vs-irrelevant`,
    input.policy.alpha, input.policy.familyAlpha, input.policy.policySha256
  );
  if (relevantVsNone.status !== 'OK' || relevantVsIrrelevant.status !== 'OK') {
    return relevantVsNone.status !== 'OK' ? relevantVsNone : relevantVsIrrelevant;
  }
  const summaries = Object.fromEntries(arms.map((arm) => [arm.armId, armSummary(arm)]));
  const baselineTokens = Math.max(1, summaries['no-memory'].totalTokens);
  const relativeTokenIncrease = (
    summaries['relevant-memory'].totalTokens - baselineTokens
  ) / baselineTokens;
  const confirmation = input.untouchedConfirmation;
  const confirmationValid = plainObject(confirmation)
    && confirmation.verifierOwned === true
    && confirmation.untouched === true
    && confirmation.passed === true
    && SHA256.test(String(confirmation.evidenceSha256 || ''))
    && Array.isArray(confirmation.taskIdentities)
    && confirmation.taskIdentities.length > 0
    && confirmation.taskIdentities.every((id) => isSafeId(id) && !taskIds.has(id) && !sourceIds.has(id));
  const gates = {
    generationsIdentityDisjoint: true,
    armContractsMatched: true,
    taskClustersMatched: true,
    relevantBeatsNoMemory: relevantVsNone.state.paceGatePassed,
    relevantBeatsIrrelevantMemory: relevantVsIrrelevant.state.paceGatePassed,
    noControlRegressions: summaries['relevant-memory'].controlRegressions === 0,
    tokenCostBounded: relativeTokenIncrease <= input.policy.maximumRelativeTokenIncrease,
    untouchedConfirmationPassed: confirmationValid
  };
  const supported = Object.values(gates).every(Boolean);
  const core = {
    schemaVersion: MEMORY_CAUSAL_STUDY_SCHEMA,
    studyId: input.studyId,
    manifestSha256: input.manifestSha256,
    generationOne: structuredClone(input.generationOne),
    generationTwo: structuredClone(input.generationTwo),
    armContractsSha256: sha256(canonicalVNextJson(arms.map(({ armId, contract }) => ({ armId, contract })))),
    summaries,
    contrasts: {
      relevantVsNoMemory: relevantVsNone.state,
      relevantVsIrrelevantMemory: relevantVsIrrelevant.state
    },
    relativeTokenIncrease,
    untouchedConfirmation: confirmationValid ? structuredClone(confirmation) : null,
    gates,
    memoryCausalEffectSupported: supported,
    disposition: supported ? 'MEMORY_EFFECT_SUPPORTED' : 'MEMORY_EFFECT_NOT_ESTABLISHED',
    activationAuthority: false
  };
  return {
    status: 'OK',
    report: { ...core, reportSha256: sha256(canonicalVNextJson(core)) }
  };
}

export function validateMemoryCausalStudyReport(report) {
  if (!plainObject(report) || report.schemaVersion !== MEMORY_CAUSAL_STUDY_SCHEMA
      || report.activationAuthority !== false || !plainObject(report.gates)
      || report.memoryCausalEffectSupported !== Object.values(report.gates).every(Boolean)
      || report.disposition !== (report.memoryCausalEffectSupported
        ? 'MEMORY_EFFECT_SUPPORTED' : 'MEMORY_EFFECT_NOT_ESTABLISHED')) {
    return refused('MEMORY_STUDY_REPORT_INVALID', 'Memory study report shape or verdict is invalid.');
  }
  const core = structuredClone(report);
  delete core.reportSha256;
  return report.reportSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', report }
    : refused('MEMORY_STUDY_REPORT_TAMPERED', 'Memory study report hash drifted.');
}
