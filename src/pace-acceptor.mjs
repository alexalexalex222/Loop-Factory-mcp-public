import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const PACE_ACCEPTOR_SCHEMA = 'vnext-pace-task-cluster-eprocess-v1';
export const PACE_STEP_SCHEMA = 'vnext-pace-task-cluster-step-v1';
export const PACE_V2_GATE_SCHEMA = 'vnext-pace-v2-companion-gates-v1';
export const PACE_OFFLINE_COMPARISON_SCHEMA =
  'vnext-pace-offline-comparison-v1';

const SHA256 = /^[a-f0-9]{64}$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function round(value, places = 12) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function floorConservative(value, places = 12) {
  const scale = 10 ** places;
  return Math.floor(value * scale) / scale;
}

function ceilConservative(value, places = 12) {
  const scale = 10 ** places;
  return Math.ceil(value * scale) / scale;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function alphaAllocationValid(value) {
  return exactKeys(value, [
    'allocationId',
    'alpha',
    'familyAlpha',
    'policySha256'
  ])
    && isSafeId(value.allocationId)
    && Number.isFinite(value.alpha)
    && value.alpha > 0
    && value.alpha < 1
    && Number.isFinite(value.familyAlpha)
    && value.familyAlpha > 0
    && value.familyAlpha < 1
    && value.alpha <= value.familyAlpha
    && SHA256.test(String(value.policySha256 || ''));
}

function lambdaPolicyValid(value) {
  if (!plainObject(value)) return false;
  if (value.kind === 'fixed') {
    return exactKeys(value, ['kind', 'value'])
      && Number.isFinite(value.value)
      && value.value >= 0
      && value.value <= 1;
  }
  return value.kind === 'predictable-empirical'
    && exactKeys(value, ['kind', 'maximum', 'priorLosses', 'priorWins'])
    && Number.isFinite(value.maximum)
    && value.maximum >= 0
    && value.maximum <= 1
    && Number.isFinite(value.priorWins)
    && value.priorWins > 0
    && Number.isFinite(value.priorLosses)
    && value.priorLosses > 0;
}

function initialCore(input) {
  if (!exactKeys(input, ['candidateId', 'lambdaPolicy', 'outerAlphaAllocation'])
      || !isSafeId(input.candidateId)
      || !alphaAllocationValid(input.outerAlphaAllocation)
      || !lambdaPolicyValid(input.lambdaPolicy)) return null;
  return {
    candidateId: input.candidateId,
    outerAlphaAllocation: structuredClone(input.outerAlphaAllocation),
    lambdaPolicy: structuredClone(input.lambdaPolicy),
    inferenceUnit: 'task-cluster',
    fixedCandidateOnly: true,
    v2GateOnly: true,
    fullAdaptiveRunControl: false,
    activationAuthority: false
  };
}

function stateCore(state) {
  const core = structuredClone(state);
  delete core.stateSha256;
  return core;
}

export function createPaceAcceptor(input = {}) {
  const initial = initialCore(input);
  if (!initial) {
    return refused(
      'PACE_CONFIG_INVALID',
      'PACE requires one fixed candidate, an outer alpha allocation, and a bound deterministic lambda policy.'
    );
  }
  const initialStateSha256 = sha256(canonicalVNextJson(initial));
  const core = {
    schemaVersion: PACE_ACCEPTOR_SCHEMA,
    ...initial,
    initialStateSha256,
    alpha: input.outerAlphaAllocation.alpha,
    stoppingThreshold: ceilConservative(1 / input.outerAlphaAllocation.alpha),
    wealth: 1,
    taskCount: 0,
    discordantCount: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    stopped: false,
    crossedAtTask: null,
    paceGatePassed: false,
    steps: []
  };
  return deepFreeze({
    status: 'OK',
    state: {
      ...core,
      stateSha256: sha256(canonicalVNextJson(core))
    }
  });
}

function normalizeReplicates(replicates) {
  if (!Array.isArray(replicates) || replicates.length < 1 || replicates.length > 1000) {
    return null;
  }
  const normalized = replicates.map((value) => {
    if (!exactKeys(value, ['candidate', 'incumbent', 'replicate'])
        || !Number.isInteger(value.replicate)
        || value.replicate < 0
        || !Number.isFinite(value.candidate)
        || !Number.isFinite(value.incumbent)) return null;
    return {
      replicate: value.replicate,
      candidate: value.candidate,
      incumbent: value.incumbent
    };
  });
  if (normalized.some((value) => value == null)) return null;
  normalized.sort((left, right) => left.replicate - right.replicate);
  if (new Set(normalized.map((value) => value.replicate)).size !== normalized.length) {
    return null;
  }
  return normalized;
}

function normalizeTaskCluster(cluster) {
  if (!exactKeys(cluster, ['objectiveVerified', 'replicates', 'taskId'])
      || !isSafeId(cluster.taskId)
      || cluster.objectiveVerified !== true) return null;
  const replicates = normalizeReplicates(cluster.replicates);
  if (!replicates) return null;
  const candidateMean = round(mean(replicates.map((item) => item.candidate)));
  const incumbentMean = round(mean(replicates.map((item) => item.incumbent)));
  const delta = round(candidateMean - incumbentMean);
  const exactDelta = mean(replicates.map((item) => item.candidate))
    - mean(replicates.map((item) => item.incumbent));
  return {
    taskId: cluster.taskId,
    objectiveVerified: true,
    replicates,
    candidateMean,
    incumbentMean,
    delta,
    outcome: exactDelta > 0 ? 'win' : exactDelta < 0 ? 'loss' : 'tie'
  };
}

function predictableLambda(policy, history) {
  if (policy.kind === 'fixed') return policy.value;
  const wins = history.wins + policy.priorWins;
  const losses = history.losses + policy.priorLosses;
  const edge = (wins - losses) / (wins + losses);
  return round(Math.max(0, Math.min(policy.maximum, edge)));
}

function makeStep(state, task) {
  const discordant = task.outcome !== 'tie';
  const lambda = discordant
    ? predictableLambda(state.lambdaPolicy, state)
    : 0;
  const signedOutcome = task.outcome === 'win' ? 1 : task.outcome === 'loss' ? -1 : 0;
  const factor = discordant ? round(1 + (lambda * signedOutcome)) : 1;
  const wealthAfter = floorConservative(state.wealth * factor);
  const thresholdCrossed = wealthAfter >= state.stoppingThreshold;
  const previousStepSha256 = state.steps.at(-1)?.stepSha256
    || state.initialStateSha256;
  const core = {
    schemaVersion: PACE_STEP_SCHEMA,
    sequence: state.taskCount + 1,
    taskId: task.taskId,
    objectiveVerified: true,
    replicates: task.replicates,
    replicateCount: task.replicates.length,
    candidateMean: task.candidateMean,
    incumbentMean: task.incumbentMean,
    delta: task.delta,
    outcome: task.outcome,
    discordant,
    lambda,
    factor,
    wealthBefore: state.wealth,
    wealthAfter,
    stoppingThreshold: state.stoppingThreshold,
    thresholdCrossed,
    previousStepSha256
  };
  return {
    ...core,
    stepSha256: sha256(canonicalVNextJson(core))
  };
}

function replaySteps(state) {
  let wealth = 1;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let previousStepSha256 = state.initialStateSha256;
  let crossedAtTask = null;
  const taskIds = new Set();
  for (let index = 0; index < state.steps.length; index += 1) {
    const step = state.steps[index];
    if (!exactKeys(step, [
      'candidateMean',
      'delta',
      'discordant',
      'factor',
      'incumbentMean',
      'lambda',
      'objectiveVerified',
      'outcome',
      'previousStepSha256',
      'replicateCount',
      'replicates',
      'schemaVersion',
      'sequence',
      'stepSha256',
      'stoppingThreshold',
      'taskId',
      'thresholdCrossed',
      'wealthAfter',
      'wealthBefore'
    ]) || crossedAtTask != null || taskIds.has(step.taskId)) return null;
    taskIds.add(step.taskId);
    const task = normalizeTaskCluster({
      taskId: step.taskId,
      objectiveVerified: step.objectiveVerified,
      replicates: step.replicates
    });
    if (!task || step.schemaVersion !== PACE_STEP_SCHEMA
        || step.sequence !== index + 1
        || step.previousStepSha256 !== previousStepSha256
        || step.replicateCount !== task.replicates.length
        || step.candidateMean !== task.candidateMean
        || step.incumbentMean !== task.incumbentMean
        || step.delta !== task.delta
        || step.outcome !== task.outcome
        || step.wealthBefore !== wealth) return null;
    const history = { wins, losses };
    const expectedLambda = task.outcome === 'tie'
      ? 0
      : predictableLambda(state.lambdaPolicy, history);
    const signed = task.outcome === 'win' ? 1 : task.outcome === 'loss' ? -1 : 0;
    const expectedFactor = task.outcome === 'tie'
      ? 1
      : round(1 + (expectedLambda * signed));
    const expectedWealth = floorConservative(wealth * expectedFactor);
    if (step.discordant !== (task.outcome !== 'tie')
        || step.lambda !== expectedLambda
        || step.factor !== expectedFactor
        || step.wealthAfter !== expectedWealth
        || step.stoppingThreshold !== state.stoppingThreshold
        || step.thresholdCrossed !== (expectedWealth >= state.stoppingThreshold)) {
      return null;
    }
    const core = structuredClone(step);
    delete core.stepSha256;
    if (step.stepSha256 !== sha256(canonicalVNextJson(core))) return null;
    previousStepSha256 = step.stepSha256;
    wealth = expectedWealth;
    if (task.outcome === 'win') wins += 1;
    else if (task.outcome === 'loss') losses += 1;
    else ties += 1;
    if (crossedAtTask == null && step.thresholdCrossed) crossedAtTask = step.taskId;
  }
  return {
    wealth,
    wins,
    losses,
    ties,
    discordantCount: wins + losses,
    crossedAtTask
  };
}

export function validatePaceState(state) {
  if (!exactKeys(state, [
    'activationAuthority',
    'alpha',
    'candidateId',
    'crossedAtTask',
    'discordantCount',
    'fixedCandidateOnly',
    'fullAdaptiveRunControl',
    'inferenceUnit',
    'initialStateSha256',
    'lambdaPolicy',
    'losses',
    'outerAlphaAllocation',
    'paceGatePassed',
    'schemaVersion',
    'stateSha256',
    'steps',
    'stopped',
    'stoppingThreshold',
    'taskCount',
    'ties',
    'v2GateOnly',
    'wealth',
    'wins'
  ])
      || state.schemaVersion !== PACE_ACCEPTOR_SCHEMA
      || state.inferenceUnit !== 'task-cluster'
      || state.fixedCandidateOnly !== true
      || state.v2GateOnly !== true
      || state.fullAdaptiveRunControl !== false
      || state.activationAuthority !== false
      || !isSafeId(state.candidateId)
      || !alphaAllocationValid(state.outerAlphaAllocation)
      || !lambdaPolicyValid(state.lambdaPolicy)
      || !Array.isArray(state.steps)
      || !SHA256.test(String(state.stateSha256 || ''))) {
    return refused('PACE_STATE_INVALID', 'PACE state shape or authority is invalid.');
  }
  const expectedInitial = initialCore({
    candidateId: state.candidateId,
    outerAlphaAllocation: state.outerAlphaAllocation,
    lambdaPolicy: state.lambdaPolicy
  });
  if (!expectedInitial
      || state.initialStateSha256 !== sha256(canonicalVNextJson(expectedInitial))
      || state.alpha !== state.outerAlphaAllocation.alpha
      || state.stoppingThreshold !== ceilConservative(1 / state.alpha)
      || state.stateSha256 !== sha256(canonicalVNextJson(stateCore(state)))) {
    return refused('PACE_STATE_TAMPERED', 'PACE state hash or frozen allocation drifted.');
  }
  const replay = replaySteps(state);
  if (!replay
      || state.taskCount !== state.steps.length
      || state.wealth !== replay.wealth
      || state.wins !== replay.wins
      || state.losses !== replay.losses
      || state.ties !== replay.ties
      || state.discordantCount !== replay.discordantCount
      || state.crossedAtTask !== replay.crossedAtTask
      || state.stopped !== (replay.crossedAtTask != null)
      || state.paceGatePassed !== state.stopped) {
    return refused('PACE_STATE_REPLAY_MISMATCH', 'PACE task-cluster replay does not match persisted state.');
  }
  return { status: 'OK', state: structuredClone(state) };
}

export function appendPaceTaskCluster(state, cluster, {
  persistStep
} = {}) {
  const stateValidation = validatePaceState(state);
  if (stateValidation.status !== 'OK') return stateValidation;
  if (state.stopped) {
    return refused('PACE_ALREADY_STOPPED', 'PACE crossed its predeclared threshold and cannot consume another task.');
  }
  if (typeof persistStep !== 'function') {
    return refused('PACE_STEP_PERSISTENCE_REQUIRED', 'Every PACE task-cluster step must be persisted before the state is returned.');
  }
  const task = normalizeTaskCluster(cluster);
  if (!task) {
    return refused('PACE_TASK_CLUSTER_INVALID', 'PACE requires one objectively verified cluster with finite paired replicates.');
  }
  if (state.steps.some((step) => step.taskId === task.taskId)) {
    return refused('PACE_TASK_CLUSTER_DUPLICATED', 'A task cluster may contribute at most one PACE outcome.');
  }
  const step = makeStep(state, task);
  const core = {
    ...stateCore(state),
    wealth: step.wealthAfter,
    taskCount: state.taskCount + 1,
    discordantCount: state.discordantCount + (step.discordant ? 1 : 0),
    wins: state.wins + (step.outcome === 'win' ? 1 : 0),
    losses: state.losses + (step.outcome === 'loss' ? 1 : 0),
    ties: state.ties + (step.outcome === 'tie' ? 1 : 0),
    stopped: step.thresholdCrossed,
    crossedAtTask: step.thresholdCrossed ? step.taskId : null,
    paceGatePassed: step.thresholdCrossed,
    steps: [...state.steps, step]
  };
  const nextState = {
    ...core,
    stateSha256: sha256(canonicalVNextJson(core))
  };
  try {
    persistStep(deepFreeze({
      schemaVersion: 'vnext-pace-step-persistence-v1',
      step: structuredClone(step),
      state: structuredClone(nextState),
      stateSha256: nextState.stateSha256
    }));
  } catch (error) {
    return refused('PACE_STEP_PERSIST_FAILED', String(error?.message || error));
  }
  return deepFreeze({ status: 'OK', state: nextState, step });
}

function gateInputValid(input) {
  return exactKeys(input, [
    'objectiveVerification',
    'regressions',
    'shamMovement',
    'state',
    'tokenCost',
    'untouchedConfirmation'
  ])
    && exactKeys(input.shamMovement, ['absoluteMovement', 'maximumAllowed'])
    && Number.isFinite(input.shamMovement.absoluteMovement)
    && input.shamMovement.absoluteMovement >= 0
    && Number.isFinite(input.shamMovement.maximumAllowed)
    && input.shamMovement.maximumAllowed >= 0
    && exactKeys(input.regressions, ['control', 'target'])
    && Number.isInteger(input.regressions.control)
    && input.regressions.control >= 0
    && Number.isInteger(input.regressions.target)
    && input.regressions.target >= 0
    && exactKeys(input.tokenCost, [
      'candidateTokens',
      'incumbentTokens',
      'maximumRelativeIncrease'
    ])
    && Number.isInteger(input.tokenCost.candidateTokens)
    && input.tokenCost.candidateTokens >= 0
    && Number.isInteger(input.tokenCost.incumbentTokens)
    && input.tokenCost.incumbentTokens > 0
    && Number.isFinite(input.tokenCost.maximumRelativeIncrease)
    && input.tokenCost.maximumRelativeIncrease >= 0
    && exactKeys(input.objectiveVerification, ['evidenceSha256', 'verified'])
    && typeof input.objectiveVerification.verified === 'boolean'
    && SHA256.test(String(input.objectiveVerification.evidenceSha256 || ''))
    && exactKeys(input.untouchedConfirmation, [
      'evidenceSha256',
      'passed',
      'untouched'
    ])
    && typeof input.untouchedConfirmation.passed === 'boolean'
    && typeof input.untouchedConfirmation.untouched === 'boolean'
    && SHA256.test(String(input.untouchedConfirmation.evidenceSha256 || ''));
}

export function evaluatePaceV2Gates(input = {}) {
  const stateValidation = validatePaceState(input.state);
  if (stateValidation.status !== 'OK' || !gateInputValid(input)) {
    return refused('PACE_V2_GATE_INPUT_INVALID', 'PACE companion gates require verified sham, regression, cost, objective, and untouched-confirmation evidence.');
  }
  const exactRelativeTokenIncrease = (
    input.tokenCost.candidateTokens - input.tokenCost.incumbentTokens
  ) / input.tokenCost.incumbentTokens;
  const relativeTokenIncrease = round(exactRelativeTokenIncrease);
  const gates = {
    outerAlphaAllocationBound: true,
    paceThresholdCrossed: input.state.paceGatePassed === true,
    shamMovementBounded:
      input.shamMovement.absoluteMovement <= input.shamMovement.maximumAllowed,
    noTargetRegressions: input.regressions.target === 0,
    noControlRegressions: input.regressions.control === 0,
    tokenCostBounded:
      exactRelativeTokenIncrease <= input.tokenCost.maximumRelativeIncrease,
    objectiveVerificationPassed: input.objectiveVerification.verified === true,
    untouchedConfirmationPassed:
      input.untouchedConfirmation.passed === true
      && input.untouchedConfirmation.untouched === true
  };
  const allV2GatesPassed = Object.values(gates).every(Boolean);
  const core = {
    schemaVersion: PACE_V2_GATE_SCHEMA,
    paceStateSha256: input.state.stateSha256,
    outerAlphaAllocation: structuredClone(input.state.outerAlphaAllocation),
    gates,
    relativeTokenIncrease,
    shamMovement: structuredClone(input.shamMovement),
    regressions: structuredClone(input.regressions),
    objectiveVerification: structuredClone(input.objectiveVerification),
    untouchedConfirmation: structuredClone(input.untouchedConfirmation),
    allV2GatesPassed,
    disposition: allV2GatesPassed ? 'V2_GATES_PASSED' : 'REJECTED',
    v2GateOnly: true,
    fullAdaptiveRunControl: false,
    activationAuthority: false
  };
  return deepFreeze({
    status: 'OK',
    record: {
      ...core,
      recordSha256: sha256(canonicalVNextJson(core))
    }
  });
}

export function validatePaceV2GateRecord(record) {
  if (!exactKeys(record, [
    'activationAuthority',
    'allV2GatesPassed',
    'disposition',
    'fullAdaptiveRunControl',
    'gates',
    'objectiveVerification',
    'outerAlphaAllocation',
    'paceStateSha256',
    'recordSha256',
    'regressions',
    'relativeTokenIncrease',
    'schemaVersion',
    'shamMovement',
    'untouchedConfirmation',
    'v2GateOnly'
  ])
      || record.schemaVersion !== PACE_V2_GATE_SCHEMA
      || record.v2GateOnly !== true
      || record.fullAdaptiveRunControl !== false
      || record.activationAuthority !== false
      || !plainObject(record.gates)
      || record.allV2GatesPassed !== Object.values(record.gates).every(Boolean)
      || record.disposition !== (record.allV2GatesPassed
        ? 'V2_GATES_PASSED'
        : 'REJECTED')
      || !SHA256.test(String(record.recordSha256 || ''))) {
    return refused('PACE_V2_GATE_RECORD_INVALID', 'PACE V2 gate record is invalid.');
  }
  const core = structuredClone(record);
  delete core.recordSha256;
  return record.recordSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', record: structuredClone(record) }
    : refused('PACE_V2_GATE_RECORD_TAMPERED', 'PACE V2 gate record hash does not match its content.');
}

export function compareOfflineAcceptors({
  candidateId,
  stream,
  outerAlphaAllocation,
  lambdaPolicy,
  fixedDelta = 0
} = {}) {
  if (!Array.isArray(stream)
      || stream.length < 1
      || !Number.isFinite(fixedDelta)) {
    return refused('PACE_OFFLINE_STREAM_INVALID', 'Offline comparison requires one non-empty predeclared task stream and a fixed delta.');
  }
  const normalized = stream.map(normalizeTaskCluster);
  if (normalized.some((task) => task == null)
      || new Set(normalized.map((task) => task.taskId)).size !== normalized.length) {
    return refused('PACE_OFFLINE_STREAM_INVALID', 'Offline stream task clusters are invalid or duplicated.');
  }
  const streamSha256 = sha256(canonicalVNextJson(stream));
  const created = createPaceAcceptor({
    candidateId,
    outerAlphaAllocation,
    lambdaPolicy
  });
  if (created.status !== 'OK') return created;
  let state = created.state;
  let greedyAcceptedAtTask = null;
  let cumulativeDelta = 0;
  const persistedSteps = [];
  for (let index = 0; index < stream.length; index += 1) {
    const task = normalized[index];
    cumulativeDelta = round(cumulativeDelta + task.delta);
    if (greedyAcceptedAtTask == null && cumulativeDelta / (index + 1) > 0) {
      greedyAcceptedAtTask = task.taskId;
    }
    if (!state.stopped) {
      const updated = appendPaceTaskCluster(state, stream[index], {
        persistStep: (receipt) => persistedSteps.push(receipt)
      });
      if (updated.status !== 'OK') return updated;
      state = updated.state;
    }
  }
  const finalMeanDelta = round(cumulativeDelta / stream.length);
  const core = {
    schemaVersion: PACE_OFFLINE_COMPARISON_SCHEMA,
    predeclaredStreamSha256: streamSha256,
    taskCount: stream.length,
    noModelCalls: true,
    greedy: {
      accepted: greedyAcceptedAtTask != null,
      acceptedAtTask: greedyAcceptedAtTask,
      rule: 'first-positive-running-task-mean'
    },
    fixedDelta: {
      accepted: finalMeanDelta >= fixedDelta,
      evaluatedAtTaskCount: stream.length,
      threshold: fixedDelta,
      finalMeanDelta,
      rule: 'predeclared-stream-final-mean'
    },
    pace: {
      accepted: state.paceGatePassed,
      acceptedAtTask: state.crossedAtTask,
      consumedTaskCount: state.taskCount,
      finalWealth: state.wealth,
      stoppingThreshold: state.stoppingThreshold,
      stateSha256: state.stateSha256,
      rule: 'task-cluster-paired-anytime-valid-e-process'
    },
    persistedStepCount: persistedSteps.length,
    samePredeclaredStream: true,
    v2GateOnly: true,
    fullAdaptiveRunControl: false
  };
  return deepFreeze({
    status: 'OK',
    comparison: {
      ...core,
      comparisonSha256: sha256(canonicalVNextJson(core))
    }
  });
}

export const compareOfflineAcceptancePolicies = compareOfflineAcceptors;
