import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { validateVNextTaskPack } from './vnext-task-pack.mjs';
import {
  createResourceBudgetPolicy,
  verifyResourceBudgetLedger
} from './resource-budget.mjs';

export const CAMPAIGN_SERIES_PLAN_SCHEMA = 'loop-factory-campaign-series-plan-v1';
export const CAMPAIGN_SERIES_STATE_SCHEMA = 'loop-factory-campaign-series-state-v1';

const SHA256 = /^[a-f0-9]{64}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function planPayload(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    seriesId: plan.seriesId,
    createdAt: plan.createdAt,
    maximumWaves: plan.maximumWaves,
    familywiseAlpha: plan.familywiseAlpha,
    perWaveAlpha: plan.perWaveAlpha,
    maximumCalls: plan.maximumCalls,
    modelPolicySha256: plan.modelPolicySha256,
    evaluatorPolicySha256: plan.evaluatorPolicySha256,
    implementationSha256: plan.implementationSha256,
    budgetPolicy: plan.budgetPolicy,
    promotionEnabled: plan.promotionEnabled
  };
}

function statePayload(state) {
  return {
    schemaVersion: state.schemaVersion,
    kind: state.kind,
    seriesId: state.seriesId,
    runId: state.runId,
    planSha256: state.planSha256,
    status: state.status,
    revision: state.revision,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    queue: state.queue,
    currentWave: state.currentWave,
    completedWaves: state.completedWaves,
    taskIdentities: state.taskIdentities,
    totalAuthorizedCalls: state.totalAuthorizedCalls,
    totalAuthorizedInputTokens: state.totalAuthorizedInputTokens,
    totalAuthorizedOutputTokens: state.totalAuthorizedOutputTokens,
    totalAuthorizedTokens: state.totalAuthorizedTokens,
    totalAuthorizedUsdMicros: state.totalAuthorizedUsdMicros,
    operatorStop: state.operatorStop,
    events: state.events
  };
}

function sealState(state) {
  const payload = statePayload(state);
  return { ...payload, stateSha256: sha256(canonicalVNextJson(payload)) };
}

export function createCampaignSeriesPlan(input = {}) {
  const budget = createResourceBudgetPolicy(input.budgetPolicy);
  const base = {
    schemaVersion: CAMPAIGN_SERIES_PLAN_SCHEMA,
    seriesId: input.seriesId,
    createdAt: input.createdAt,
    maximumWaves: input.maximumWaves,
    familywiseAlpha: input.familywiseAlpha,
    perWaveAlpha: Number.isInteger(input.maximumWaves) && input.maximumWaves > 0
      ? input.familywiseAlpha / input.maximumWaves
      : null,
    maximumCalls: input.maximumCalls,
    modelPolicySha256: input.modelPolicySha256,
    evaluatorPolicySha256: input.evaluatorPolicySha256,
    implementationSha256: input.implementationSha256,
    budgetPolicy: budget.status === 'OK' ? budget.policy : input.budgetPolicy,
    promotionEnabled: false
  };
  if (!isSafeId(base.seriesId)
      || !Number.isFinite(Date.parse(base.createdAt))
      || !Number.isInteger(base.maximumWaves)
      || base.maximumWaves < 1
      || base.maximumWaves > 1000
      || !Number.isFinite(base.familywiseAlpha)
      || base.familywiseAlpha <= 0
      || base.familywiseAlpha >= 1
      || !Number.isInteger(base.maximumCalls)
      || base.maximumCalls < 1
      || budget.status !== 'OK'
      || base.maximumCalls > budget.policy.maxCalls
      || ![
        base.modelPolicySha256,
        base.evaluatorPolicySha256,
        base.implementationSha256
      ].every((value) => SHA256.test(String(value || '')))) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_PLAN_INVALID' };
  }
  return {
    status: 'OK',
    plan: { ...base, planSha256: sha256(canonicalVNextJson(base)) }
  };
}

export function validateCampaignSeriesPlan(plan) {
  if (!exactKeys(plan, [
    'schemaVersion', 'seriesId', 'createdAt', 'maximumWaves',
    'familywiseAlpha', 'perWaveAlpha', 'maximumCalls', 'modelPolicySha256',
    'evaluatorPolicySha256', 'implementationSha256', 'budgetPolicy',
    'promotionEnabled', 'planSha256'
  ])
      || plan.schemaVersion !== CAMPAIGN_SERIES_PLAN_SCHEMA
      || plan.planSha256 !== sha256(canonicalVNextJson(planPayload(plan)))) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_PLAN_TAMPERED' };
  }
  return createCampaignSeriesPlan(plan).status === 'OK'
    ? { status: 'OK', plan }
    : { status: 'REFUSED', code: 'CAMPAIGN_SERIES_PLAN_INVALID' };
}

function descriptorPayload(descriptor) {
  return {
    waveId: descriptor.waveId,
    position: descriptor.position,
    taskPackId: descriptor.taskPackId,
    taskPackSha256: descriptor.taskPackSha256,
    taskIdentitySetSha256: descriptor.taskIdentitySetSha256,
    configId: descriptor.configId,
    configSha256: descriptor.configSha256,
    maximumCalls: descriptor.maximumCalls,
    budgetPolicies: descriptor.budgetPolicies,
    budgetPolicySetSha256: descriptor.budgetPolicySetSha256,
    alpha: descriptor.alpha,
    sealedAt: descriptor.sealedAt,
    sealAuthority: descriptor.sealAuthority
  };
}

const DESCRIPTOR_KEYS = Object.freeze([
  'waveId', 'position', 'taskPackId', 'taskPackSha256',
  'taskIdentitySetSha256', 'configId', 'configSha256', 'maximumCalls',
  'budgetPolicies', 'budgetPolicySetSha256', 'alpha', 'sealedAt',
  'sealAuthority', 'waveSha256'
]);

function descriptorValid(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return false;
  const allowedExtras = [
    'status', 'evidenceSha256', 'budgetUsageSha256', 'budgetUsage', 'outcome'
  ];
  if (Object.keys(descriptor).some((key) => (
    !DESCRIPTOR_KEYS.includes(key) && !allowedExtras.includes(key)
  ))
      || DESCRIPTOR_KEYS.some((key) => !Object.hasOwn(descriptor, key))
      || !isSafeId(descriptor.waveId)
      || !Number.isSafeInteger(descriptor.position)
      || descriptor.position < 0
      || !isSafeId(descriptor.taskPackId)
      || !isSafeId(descriptor.configId)
      || !isSafeId(descriptor.sealAuthority)
      || ![descriptor.taskPackSha256, descriptor.taskIdentitySetSha256,
        descriptor.configSha256, descriptor.budgetPolicySetSha256,
        descriptor.waveSha256].every((value) => SHA256.test(String(value || '')))
      || !Number.isSafeInteger(descriptor.maximumCalls)
      || descriptor.maximumCalls < 1
      || !Number.isFinite(descriptor.alpha)
      || descriptor.alpha <= 0
      || descriptor.alpha >= 1
      || !Number.isFinite(Date.parse(descriptor.sealedAt))
      || !Array.isArray(descriptor.budgetPolicies)
      || descriptor.budgetPolicies.length < 1
      || descriptor.budgetPolicies.length > 8) return false;
  const policies = descriptor.budgetPolicies.map((policy) => createResourceBudgetPolicy(policy));
  if (policies.some((result) => result.status !== 'OK')
      || canonicalVNextJson(policies.map((result) => result.policy))
        !== canonicalVNextJson(descriptor.budgetPolicies)
      || descriptor.budgetPolicySetSha256
        !== sha256(canonicalVNextJson(descriptor.budgetPolicies))
      || descriptor.maximumCalls !== descriptor.budgetPolicies.reduce((sum, policy) => (
        sum + policy.maxCalls
      ), 0)
      || descriptor.waveSha256 !== sha256(canonicalVNextJson(descriptorPayload(descriptor)))) {
    return false;
  }
  if (descriptor.status == null) {
    return Object.keys(descriptor).length === DESCRIPTOR_KEYS.length;
  }
  if (!['VERIFIED', 'INVALID', 'AMBIGUOUS_DISPATCH'].includes(descriptor.status)
      || !(descriptor.evidenceSha256 == null
        || SHA256.test(String(descriptor.evidenceSha256)))) return false;
  if (descriptor.budgetUsage != null) {
    if (!Array.isArray(descriptor.budgetUsage)
        || descriptor.budgetUsage.some((row) => !exactKeys(row, [
          'policyId', 'policySha256', 'ledgerSha256', 'calls', 'inputTokens',
          'outputTokens', 'usdMicros'
        ])
          || !isSafeId(row.policyId)
          || ![row.policySha256, row.ledgerSha256].every((value) => (
            SHA256.test(String(value || ''))
          ))
          || ![row.calls, row.inputTokens, row.outputTokens, row.usdMicros]
            .every((value) => Number.isSafeInteger(value) && value >= 0))
        || descriptor.budgetUsageSha256
          !== sha256(canonicalVNextJson(descriptor.budgetUsage))) return false;
  } else if (descriptor.budgetUsageSha256 != null
      && !SHA256.test(String(descriptor.budgetUsageSha256))) return false;
  if (descriptor.outcome != null && (!exactKeys(descriptor.outcome, [
    'disposition', 'causalPass', 'activationEligible', 'promotionAuthorized'
  ])
      || !(descriptor.outcome.disposition == null
        || typeof descriptor.outcome.disposition === 'string')
      || typeof descriptor.outcome.causalPass !== 'boolean'
      || typeof descriptor.outcome.activationEligible !== 'boolean'
      || descriptor.outcome.promotionAuthorized !== false
      || (descriptor.outcome.activationEligible && !descriptor.outcome.causalPass))) {
    return false;
  }
  const extras = Object.keys(descriptor)
    .filter((key) => !DESCRIPTOR_KEYS.includes(key))
    .sort();
  const legacyCompleted = ['evidenceSha256', 'status'];
  const verifiedCompleted = [
    'budgetUsage', 'budgetUsageSha256', 'evidenceSha256', 'outcome', 'status'
  ];
  const failedCompleted = ['budgetUsageSha256', 'evidenceSha256', 'status'];
  return canonicalVNextJson(extras) === canonicalVNextJson(legacyCompleted)
    || descriptor.status === 'VERIFIED'
      && canonicalVNextJson(extras) === canonicalVNextJson(verifiedCompleted)
    || ['INVALID', 'AMBIGUOUS_DISPATCH'].includes(descriptor.status)
      && canonicalVNextJson(extras) === canonicalVNextJson(failedCompleted);
}

function eventValid(eventRow, index) {
  return exactKeys(eventRow, ['index', 'type', 'at', 'detailSha256'])
    && eventRow.index === index
    && ['SERIES_INITIALIZED', 'WAVE_ENQUEUED', 'WAVE_DISPATCHED',
      'WAVE_VERIFIED', 'WAVE_RECOVERED', 'WAVE_INVALID',
      'AMBIGUOUS_WAVE_DISPATCH', 'IDLE_NO_NEW_WORK', 'OPERATOR_STOP']
      .includes(eventRow.type)
    && Number.isFinite(Date.parse(eventRow.at))
    && SHA256.test(String(eventRow.detailSha256 || ''));
}

export function createCampaignSeriesState({ plan, runId, createdAt = plan?.createdAt } = {}) {
  if (validateCampaignSeriesPlan(plan).status !== 'OK'
      || !isSafeId(runId)
      || !Number.isFinite(Date.parse(createdAt))) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_STATE_INVALID' };
  }
  return {
    status: 'OK',
    state: sealState({
      schemaVersion: CAMPAIGN_SERIES_STATE_SCHEMA,
      kind: 'vnext-campaign-series',
      seriesId: plan.seriesId,
      runId,
      planSha256: plan.planSha256,
      status: 'IDLE_NO_NEW_WORK',
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      queue: [],
      currentWave: null,
      completedWaves: [],
      taskIdentities: [],
      totalAuthorizedCalls: 0,
      totalAuthorizedInputTokens: 0,
      totalAuthorizedOutputTokens: 0,
      totalAuthorizedTokens: 0,
      totalAuthorizedUsdMicros: 0,
      operatorStop: false,
      events: [{
        index: 0,
        type: 'SERIES_INITIALIZED',
        at: createdAt,
        detailSha256: sha256(plan.planSha256)
      }]
    })
  };
}

export function validateCampaignSeriesState(state) {
  if (!exactKeys(state, [
    'schemaVersion', 'kind', 'seriesId', 'runId', 'planSha256', 'status',
    'revision', 'createdAt', 'updatedAt', 'queue', 'currentWave',
    'completedWaves', 'taskIdentities', 'totalAuthorizedCalls',
    'totalAuthorizedInputTokens', 'totalAuthorizedOutputTokens',
    'totalAuthorizedTokens', 'totalAuthorizedUsdMicros', 'operatorStop',
    'events', 'stateSha256'
  ])
      || state.schemaVersion !== CAMPAIGN_SERIES_STATE_SCHEMA
      || state.kind !== 'vnext-campaign-series'
      || !isSafeId(state.seriesId)
      || !isSafeId(state.runId)
      || !SHA256.test(String(state.planSha256 || ''))
      || !['IDLE_NO_NEW_WORK', 'READY', 'RUNNING', 'WAVE_DRAINED',
        'OPERATOR_STOP', 'BLOCKED'].includes(state.status)
      || !Number.isFinite(Date.parse(state.createdAt))
      || !Number.isFinite(Date.parse(state.updatedAt))
      || state.stateSha256 !== sha256(canonicalVNextJson(statePayload(state)))
      || !Number.isInteger(state.revision)
      || state.revision < 1
      || !Array.isArray(state.queue)
      || state.queue.some((descriptor) => !descriptorValid(descriptor)
        || descriptor.status != null)
      || !Array.isArray(state.completedWaves)
      || state.completedWaves.some((descriptor) => !descriptorValid(descriptor)
        || descriptor.status == null)
      || !(state.currentWave === null || (
        exactKeys(state.currentWave, ['phase', 'descriptor', 'dispatchedAt'])
        && state.currentWave.phase === 'DISPATCHED'
        && descriptorValid(state.currentWave.descriptor)
        && state.currentWave.descriptor.status == null
        && Number.isFinite(Date.parse(state.currentWave.dispatchedAt))
      ))
      || ![
        state.totalAuthorizedCalls,
        state.totalAuthorizedInputTokens,
        state.totalAuthorizedOutputTokens,
        state.totalAuthorizedTokens,
        state.totalAuthorizedUsdMicros
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
      || typeof state.operatorStop !== 'boolean'
      || !Array.isArray(state.events)
      || state.events.length < 1
      || state.events.some((row, index) => !eventValid(row, index))
      || !Array.isArray(state.taskIdentities)
      || state.taskIdentities.some((identity) => (
        typeof identity !== 'string' || !identity || identity.length > 256
      ))
      || new Set(state.taskIdentities).size !== state.taskIdentities.length
      || new Set([
        ...state.queue,
        ...(state.currentWave ? [state.currentWave.descriptor] : []),
        ...state.completedWaves
      ]
        .map((wave) => wave.waveId)).size !== state.queue.length
          + state.completedWaves.length
          + (state.currentWave ? 1 : 0)) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_STATE_TAMPERED' };
  }
  return { status: 'OK', state };
}

function event(state, type, at, detail) {
  return {
    index: state.events.length,
    type,
    at,
    detailSha256: sha256(canonicalVNextJson(detail))
  };
}

function seriesBudgetValid(state, plan, budgetLedger) {
  const checked = verifyResourceBudgetLedger(budgetLedger);
  return checked.status === 'OK'
    && canonicalVNextJson(budgetLedger.policy) === canonicalVNextJson(plan.budgetPolicy)
    && state.totalAuthorizedCalls <= plan.budgetPolicy.maxCalls
    && state.totalAuthorizedInputTokens <= plan.budgetPolicy.maxInputTokens
    && state.totalAuthorizedOutputTokens <= plan.budgetPolicy.maxOutputTokens
    && state.totalAuthorizedTokens <= plan.budgetPolicy.maxTotalTokens
    && state.totalAuthorizedUsdMicros <= plan.budgetPolicy.maxUsdMicros;
}

export function verifyCampaignSeriesWaveBudgets(descriptor, result) {
  if (!descriptor || !Array.isArray(descriptor.budgetPolicies)
      || !Array.isArray(result?.budgetLedgers)
      || result.budgetLedgers.length !== descriptor.budgetPolicies.length
      || !Number.isSafeInteger(result.calls)
      || result.calls < 0) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_WAVE_BUDGET_MISSING' };
  }
  const ledgers = new Map(result.budgetLedgers.map((ledger) => [
    ledger?.policy?.policyId,
    ledger
  ]));
  if (ledgers.size !== result.budgetLedgers.length) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_WAVE_BUDGET_DUPLICATED' };
  }
  const usage = [];
  for (const policy of descriptor.budgetPolicies) {
    const ledger = ledgers.get(policy.policyId);
    const checked = verifyResourceBudgetLedger(ledger);
    if (checked.status !== 'OK'
        || canonicalVNextJson(ledger.policy) !== canonicalVNextJson(policy)
        || checked.totals.callsReserved !== checked.totals.callsSettled) {
      return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_WAVE_BUDGET_INVALID' };
    }
    usage.push({
      policyId: policy.policyId,
      policySha256: policy.policySha256,
      ledgerSha256: ledger.ledgerSha256,
      calls: checked.totals.callsSettled,
      inputTokens: checked.totals.inputUsed,
      outputTokens: checked.totals.outputUsed,
      usdMicros: checked.totals.usdUsed
    });
  }
  const calls = usage.reduce((sum, row) => sum + row.calls, 0);
  if (calls !== result.calls || calls > descriptor.maximumCalls) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_WAVE_CALL_MISMATCH' };
  }
  return {
    status: 'OK',
    calls,
    usage,
    usageSha256: sha256(canonicalVNextJson(usage))
  };
}

export function enqueueCampaignSeriesWave({
  state,
  plan,
  expectedStateSha256,
  waveId,
  taskPack,
  configId,
  configSha256,
  budgetPolicies,
  sealedAt,
  sealAuthority
} = {}) {
  if (validateCampaignSeriesState(state).status !== 'OK'
      || validateCampaignSeriesPlan(plan).status !== 'OK'
      || state.planSha256 !== plan.planSha256
      || state.stateSha256 !== expectedStateSha256
      || validateVNextTaskPack(taskPack).status !== 'OK'
      || taskPack.partition === 'final'
      || !isSafeId(waveId)
      || !isSafeId(configId)
      || !isSafeId(sealAuthority)
      || !SHA256.test(String(configSha256 || ''))
      || !Number.isFinite(Date.parse(sealedAt))) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_WAVE_INVALID' };
  }
  if (state.operatorStop) return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_STOPPED' };
  const childPolicies = Array.isArray(budgetPolicies)
    ? budgetPolicies.map((policy) => createResourceBudgetPolicy(policy))
    : [];
  if (childPolicies.length < 1 || childPolicies.length > 8
      || childPolicies.some((result) => result.status !== 'OK')) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_BUDGET_SET_INVALID' };
  }
  const normalizedPolicies = childPolicies.map((result) => result.policy)
    .sort((left, right) => left.policyId.localeCompare(right.policyId));
  if (new Set(normalizedPolicies.map((policy) => policy.policyId)).size
      !== normalizedPolicies.length) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_BUDGET_SET_INVALID' };
  }
  const allocation = normalizedPolicies.reduce((sum, policy) => ({
    calls: sum.calls + policy.maxCalls,
    inputTokens: sum.inputTokens + policy.maxInputTokens,
    outputTokens: sum.outputTokens + policy.maxOutputTokens,
    totalTokens: sum.totalTokens + policy.maxTotalTokens,
    usdMicros: sum.usdMicros + policy.maxUsdMicros
  }), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, usdMicros: 0 });
  if (!Object.values(allocation).every(Number.isSafeInteger)) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_BUDGET_SET_INVALID' };
  }
  const waveCount = state.queue.length + state.completedWaves.length + (state.currentWave ? 1 : 0);
  if (waveCount >= plan.maximumWaves
      || state.totalAuthorizedCalls + allocation.calls > plan.maximumCalls
      || state.totalAuthorizedCalls + allocation.calls > plan.budgetPolicy.maxCalls
      || state.totalAuthorizedInputTokens + allocation.inputTokens
        > plan.budgetPolicy.maxInputTokens
      || state.totalAuthorizedOutputTokens + allocation.outputTokens
        > plan.budgetPolicy.maxOutputTokens
      || state.totalAuthorizedTokens + allocation.totalTokens
        > plan.budgetPolicy.maxTotalTokens
      || state.totalAuthorizedUsdMicros + allocation.usdMicros
        > plan.budgetPolicy.maxUsdMicros) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_BOUND_EXCEEDED' };
  }
  const identities = taskPack.tasks.flatMap((task) => [
    `task:${task.taskId}`,
    `cluster:${task.clusterId}`,
    `source:${task.source.sha256}`,
    `oracle:${task.oracle.sha256}`
  ]);
  if (identities.some((identity) => state.taskIdentities.includes(identity))) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_TASK_REUSED' };
  }
  const descriptorBase = {
    waveId,
    position: waveCount,
    taskPackId: taskPack.packId,
    taskPackSha256: taskPack.packSha256,
    taskIdentitySetSha256: taskPack.taskIdentitySetSha256,
    configId,
    configSha256,
    maximumCalls: allocation.calls,
    budgetPolicies: normalizedPolicies,
    budgetPolicySetSha256: sha256(canonicalVNextJson(normalizedPolicies)),
    alpha: plan.perWaveAlpha,
    sealedAt,
    sealAuthority
  };
  const descriptor = {
    ...descriptorBase,
    waveSha256: sha256(canonicalVNextJson(descriptorBase))
  };
  const updated = {
    ...state,
    status: 'READY',
    revision: state.revision + 1,
    updatedAt: sealedAt,
    queue: [...state.queue, descriptor],
    taskIdentities: [...state.taskIdentities, ...identities].sort(),
    totalAuthorizedCalls: state.totalAuthorizedCalls + allocation.calls,
    totalAuthorizedInputTokens:
      state.totalAuthorizedInputTokens + allocation.inputTokens,
    totalAuthorizedOutputTokens:
      state.totalAuthorizedOutputTokens + allocation.outputTokens,
    totalAuthorizedTokens: state.totalAuthorizedTokens + allocation.totalTokens,
    totalAuthorizedUsdMicros:
      state.totalAuthorizedUsdMicros + allocation.usdMicros,
    events: [...state.events, event(state, 'WAVE_ENQUEUED', sealedAt, descriptor)]
  };
  return { status: 'OK', state: sealState(updated), wave: descriptor };
}

export function requestCampaignSeriesStop(state, {
  expectedStateSha256,
  requestedAt
} = {}) {
  if (validateCampaignSeriesState(state).status !== 'OK'
      || state.stateSha256 !== expectedStateSha256
      || !Number.isFinite(Date.parse(requestedAt))) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_STOP_INVALID' };
  }
  if (state.operatorStop) return { status: 'OK', state, idempotent: true };
  const updated = {
    ...state,
    status: 'OPERATOR_STOP',
    revision: state.revision + 1,
    updatedAt: requestedAt,
    operatorStop: true,
    events: [...state.events, event(state, 'OPERATOR_STOP', requestedAt, {
      currentWave: state.currentWave?.descriptor?.waveId || null
    })]
  };
  return { status: 'OK', state: sealState(updated), idempotent: false };
}

export function runCampaignSeriesTick({
  state,
  plan,
  budgetLedger,
  runWave,
  verifyWave,
  persistState = () => {},
  now = new Date().toISOString()
} = {}) {
  if (validateCampaignSeriesState(state).status !== 'OK'
      || validateCampaignSeriesPlan(plan).status !== 'OK'
      || !seriesBudgetValid(state, plan, budgetLedger)
      || typeof runWave !== 'function'
      || typeof verifyWave !== 'function'
      || state.planSha256 !== plan.planSha256) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_TICK_INVALID' };
  }
  if (state.operatorStop) return { status: 'OK', state, disposition: 'OPERATOR_STOP', inferenceCalls: 0 };
  if (state.currentWave?.phase === 'DISPATCHED') {
    const ambiguous = {
      ...state.currentWave.descriptor,
      status: 'AMBIGUOUS_DISPATCH',
      evidenceSha256: null
    };
    const updated = sealState({
      ...state,
      status: state.queue.length ? 'READY' : 'IDLE_NO_NEW_WORK',
      revision: state.revision + 1,
      updatedAt: now,
      currentWave: null,
      completedWaves: [...state.completedWaves, ambiguous],
      events: [...state.events, event(state, 'AMBIGUOUS_WAVE_DISPATCH', now, ambiguous)]
    });
    persistState(updated);
    return { status: 'OK', state: updated, disposition: 'AMBIGUOUS_DISPATCH', inferenceCalls: 0 };
  }
  if (state.queue.length === 0) {
    if (state.status === 'IDLE_NO_NEW_WORK') {
      return {
        status: 'OK', state, disposition: 'IDLE_NO_NEW_WORK',
        inferenceCalls: 0, idempotent: true
      };
    }
    const idle = sealState({
      ...state,
      status: 'IDLE_NO_NEW_WORK',
      revision: state.revision + 1,
      updatedAt: now,
      events: [...state.events, event(state, 'IDLE_NO_NEW_WORK', now, { inferenceCalls: 0 })]
    });
    persistState(idle);
    return { status: 'OK', state: idle, disposition: 'IDLE_NO_NEW_WORK', inferenceCalls: 0 };
  }
  const [descriptor, ...rest] = state.queue;
  const dispatched = sealState({
    ...state,
    status: 'RUNNING',
    revision: state.revision + 1,
    updatedAt: now,
    queue: rest,
    currentWave: { phase: 'DISPATCHED', descriptor, dispatchedAt: now },
    events: [...state.events, event(state, 'WAVE_DISPATCHED', now, descriptor)]
  });
  persistState(dispatched);
  const result = runWave(descriptor);
  const verified = verifyWave(descriptor, result);
  if (!verified || verified.status !== 'OK' || !SHA256.test(String(verified.evidenceSha256 || ''))) {
    const blocked = sealState({
      ...dispatched,
      status: 'BLOCKED',
      revision: dispatched.revision + 1,
      updatedAt: now,
      currentWave: null,
      completedWaves: [...dispatched.completedWaves, {
        ...descriptor,
        status: 'INVALID',
        evidenceSha256: verified?.evidenceSha256 || null
      }],
      events: [...dispatched.events, event(dispatched, 'WAVE_INVALID', now, {
        waveId: descriptor.waveId,
        code: verified?.code || 'WAVE_VERIFICATION_FAILED'
      })]
    });
    persistState(blocked);
    return { status: 'BLOCKED', code: verified?.code || 'WAVE_VERIFICATION_FAILED', state: blocked, inferenceCalls: result?.calls || 0 };
  }
  const completed = {
    ...descriptor,
    status: 'VERIFIED',
    evidenceSha256: verified.evidenceSha256
  };
  const final = sealState({
    ...dispatched,
    status: rest.length ? 'READY' : 'WAVE_DRAINED',
    revision: dispatched.revision + 1,
    updatedAt: now,
    currentWave: null,
    completedWaves: [...dispatched.completedWaves, completed],
    events: [...dispatched.events, event(dispatched, 'WAVE_VERIFIED', now, completed)]
  });
  persistState(final);
  return { status: 'OK', state: final, disposition: final.status, inferenceCalls: result?.calls || 0 };
}

export async function runCampaignSeriesTickAsync({
  state,
  plan,
  budgetLedger,
  runWave,
  verifyWave,
  recoverWave = null,
  authorizeDispatch = null,
  persistState = async () => {},
  now = new Date().toISOString()
} = {}) {
  if (validateCampaignSeriesState(state).status !== 'OK'
      || validateCampaignSeriesPlan(plan).status !== 'OK'
      || !seriesBudgetValid(state, plan, budgetLedger)
      || typeof runWave !== 'function'
      || typeof verifyWave !== 'function'
      || (recoverWave != null && typeof recoverWave !== 'function')
      || (authorizeDispatch != null && typeof authorizeDispatch !== 'function')
      || typeof persistState !== 'function'
      || state.planSha256 !== plan.planSha256) {
    return { status: 'REFUSED', code: 'CAMPAIGN_SERIES_TICK_INVALID' };
  }
  if (state.operatorStop) {
    return { status: 'OK', state, disposition: 'OPERATOR_STOP', inferenceCalls: 0 };
  }
  if (state.currentWave?.phase === 'DISPATCHED') {
    if (recoverWave) {
      const descriptor = state.currentWave.descriptor;
      const recovered = await recoverWave(descriptor);
      const verified = recovered ? await verifyWave(descriptor, recovered) : null;
      const budget = recovered
        ? verifyCampaignSeriesWaveBudgets(descriptor, recovered)
        : { status: 'REFUSED' };
      if (verified?.status === 'OK'
          && SHA256.test(String(verified.evidenceSha256 || ''))
          && budget.status === 'OK') {
        const completed = {
          ...descriptor,
          status: 'VERIFIED',
          evidenceSha256: verified.evidenceSha256,
          budgetUsageSha256: budget.usageSha256,
          budgetUsage: budget.usage,
          outcome: {
            disposition: verified.disposition ?? null,
            causalPass: verified.causalPass === true,
            activationEligible: verified.activationEligible === true,
            promotionAuthorized: false
          }
        };
        const final = sealState({
          ...state,
          status: state.queue.length ? 'READY' : 'WAVE_DRAINED',
          revision: state.revision + 1,
          updatedAt: now,
          currentWave: null,
          completedWaves: [...state.completedWaves, completed],
          events: [...state.events, event(state, 'WAVE_RECOVERED', now, completed)]
        });
        await persistState(final);
        return {
          status: 'OK',
          state: final,
          disposition: final.status,
          inferenceCalls: 0,
          recoveredCalls: budget.calls,
          budgetUsageSha256: budget.usageSha256
        };
      }
    }
    const ambiguous = {
      ...state.currentWave.descriptor,
      status: 'AMBIGUOUS_DISPATCH',
      evidenceSha256: null,
      budgetUsageSha256: null
    };
    const updated = sealState({
      ...state,
      status: state.queue.length ? 'READY' : 'IDLE_NO_NEW_WORK',
      revision: state.revision + 1,
      updatedAt: now,
      currentWave: null,
      completedWaves: [...state.completedWaves, ambiguous],
      events: [...state.events, event(state, 'AMBIGUOUS_WAVE_DISPATCH', now, ambiguous)]
    });
    await persistState(updated);
    return { status: 'OK', state: updated, disposition: 'AMBIGUOUS_DISPATCH', inferenceCalls: 0 };
  }
  if (state.queue.length === 0) {
    if (state.status === 'IDLE_NO_NEW_WORK') {
      return {
        status: 'OK', state, disposition: 'IDLE_NO_NEW_WORK',
        inferenceCalls: 0, idempotent: true
      };
    }
    const idle = sealState({
      ...state,
      status: 'IDLE_NO_NEW_WORK',
      revision: state.revision + 1,
      updatedAt: now,
      events: [...state.events, event(state, 'IDLE_NO_NEW_WORK', now, { inferenceCalls: 0 })]
    });
    await persistState(idle);
    return { status: 'OK', state: idle, disposition: 'IDLE_NO_NEW_WORK', inferenceCalls: 0 };
  }
  const [descriptor, ...rest] = state.queue;
  if (authorizeDispatch) {
    const authorization = await authorizeDispatch(descriptor, state);
    if (authorization?.status !== 'OK') {
      return {
        status: 'REFUSED',
        code: authorization?.code || 'CAMPAIGN_SERIES_LAUNCH_UNAUTHORIZED',
        message: authorization?.message || 'Wave launch authorization failed.',
        state,
        inferenceCalls: 0
      };
    }
  }
  const dispatched = sealState({
    ...state,
    status: 'RUNNING',
    revision: state.revision + 1,
    updatedAt: now,
    queue: rest,
    currentWave: { phase: 'DISPATCHED', descriptor, dispatchedAt: now },
    events: [...state.events, event(state, 'WAVE_DISPATCHED', now, descriptor)]
  });
  await persistState(dispatched);
  const result = await runWave(descriptor);
  const verified = await verifyWave(descriptor, result);
  const budget = verifyCampaignSeriesWaveBudgets(descriptor, result);
  if (!verified || verified.status !== 'OK'
      || !SHA256.test(String(verified.evidenceSha256 || ''))
      || budget.status !== 'OK') {
    const code = budget.status !== 'OK'
      ? budget.code
      : (verified?.code || 'WAVE_VERIFICATION_FAILED');
    const blocked = sealState({
      ...dispatched,
      status: 'BLOCKED',
      revision: dispatched.revision + 1,
      updatedAt: now,
      currentWave: null,
      completedWaves: [...dispatched.completedWaves, {
        ...descriptor,
        status: 'INVALID',
        evidenceSha256: verified?.evidenceSha256 || null,
        budgetUsageSha256: budget.usageSha256 || null
      }],
      events: [...dispatched.events, event(dispatched, 'WAVE_INVALID', now, {
        waveId: descriptor.waveId,
        code
      })]
    });
    await persistState(blocked);
    return {
      status: 'BLOCKED',
      code,
      state: blocked,
      inferenceCalls: Number.isSafeInteger(result?.calls) ? result.calls : 0
    };
  }
  const completed = {
    ...descriptor,
    status: 'VERIFIED',
    evidenceSha256: verified.evidenceSha256,
    budgetUsageSha256: budget.usageSha256,
    budgetUsage: budget.usage,
    outcome: {
      disposition: verified.disposition ?? null,
      causalPass: verified.causalPass === true,
      activationEligible: verified.activationEligible === true,
      promotionAuthorized: false
    }
  };
  const final = sealState({
    ...dispatched,
    status: rest.length ? 'READY' : 'WAVE_DRAINED',
    revision: dispatched.revision + 1,
    updatedAt: now,
    currentWave: null,
    completedWaves: [...dispatched.completedWaves, completed],
    events: [...dispatched.events, event(dispatched, 'WAVE_VERIFIED', now, completed)]
  });
  await persistState(final);
  return {
    status: 'OK',
    state: final,
    disposition: final.status,
    inferenceCalls: budget.calls,
    budgetUsageSha256: budget.usageSha256
  };
}
