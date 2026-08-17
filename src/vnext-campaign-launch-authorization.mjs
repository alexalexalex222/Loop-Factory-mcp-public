import { isSafeId, sha256 } from './util.mjs';
import { validateCampaignSeriesState } from './campaign-series.mjs';
import { loadCampaignSeriesStore } from './campaign-series-store.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { STORE_DURABILITY } from './store.mjs';
import { verifyVNextStudyPlanFromDisk } from './vnext-study-plan.mjs';

export const VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_SCHEMA =
  'loop-factory-vnext-campaign-launch-authorization-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const ROOT = 'campaign-series/launch-authorizations';

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function paths(waveId) {
  return {
    pending: `${ROOT}/${waveId}.pending.json`,
    consumed: `${ROOT}/${waveId}.consumed.json`,
    cancelled: `${ROOT}/${waveId}.cancelled.json`
  };
}

function frozenReadyWave(state, waveId) {
  return validateCampaignSeriesState(state).status === 'OK'
    && state.status === 'READY'
    && state.currentWave === null
    && state.operatorStop === false
    && state.queue[0]?.waveId === waveId;
}

export function validateVNextCampaignLaunchAuthorization(authorization) {
  if (!exactKeys(authorization, [
    'schemaVersion', 'seriesRunId', 'waveId', 'campaignPlanSha256',
    'authorizedStateSha256', 'approvedPlanSha256', 'protocolSha256',
    'createdAt', 'maximumDispatches', 'retriesAuthorized', 'authority',
    'authorizationSha256'
  ])
      || authorization.schemaVersion
        !== VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_SCHEMA
      || !isSafeId(authorization.seriesRunId)
      || !isSafeId(authorization.waveId)
      || ![
        authorization.campaignPlanSha256,
        authorization.authorizedStateSha256,
        authorization.approvedPlanSha256,
        authorization.protocolSha256,
        authorization.authorizationSha256
      ].every((value) => SHA256.test(String(value || '')))
      || !Number.isFinite(Date.parse(authorization.createdAt))
      || authorization.maximumDispatches !== 1
      || authorization.retriesAuthorized !== false
      || authorization.authority !== 'operator-reviewed-study-disclosure-v1') {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_INVALID',
      'Campaign launch authorization is malformed or exceeds one dispatch.'
    );
  }
  const core = structuredClone(authorization);
  delete core.authorizationSha256;
  return authorization.authorizationSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', authorization }
    : refused(
        'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_TAMPERED',
        'Campaign launch authorization hash failed replay.'
      );
}

export function persistVNextCampaignLaunchAuthorization({
  store,
  seriesRunId,
  waveId,
  approvedPlanSha256,
  protocolSha256,
  createdAt = new Date().toISOString()
} = {}) {
  if (store?.durability !== STORE_DURABILITY.POWER_LOSS) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_DURABILITY_REQUIRED',
      'Paid launch authorization requires a power-loss-durable store.'
    );
  }
  if (!isSafeId(seriesRunId) || !isSafeId(waveId)
      || !SHA256.test(String(approvedPlanSha256 || ''))
      || !SHA256.test(String(protocolSha256 || ''))
      || !Number.isFinite(Date.parse(createdAt))) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_INPUT_INVALID',
      'A safe run, wave, approved disclosure, protocol, and timestamp are required.'
    );
  }
  const location = paths(waveId);
  if (store.runFileExists(seriesRunId, location.consumed)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_ALREADY_CONSUMED',
      'This wave launch authorization was already consumed and cannot be recreated.'
    );
  }
  if (store.runFileExists(seriesRunId, location.cancelled)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_CANCELLED',
      'This wave launch authorization was cancelled and cannot be recreated.'
    );
  }
  const loaded = loadCampaignSeriesStore({ store, runId: seriesRunId });
  if (loaded.status !== 'OK' || !frozenReadyWave(loaded.state, waveId)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_STATE_INVALID',
      'Launch authorization requires the exact next wave at a durable READY checkpoint.'
    );
  }
  const existingText = store.readRunFile(seriesRunId, location.pending);
  if (existingText != null) {
    try {
      const existing = JSON.parse(existingText);
      const valid = validateVNextCampaignLaunchAuthorization(existing);
      return valid.status === 'OK'
          && existing.seriesRunId === seriesRunId
          && existing.waveId === waveId
          && existing.campaignPlanSha256 === loaded.plan.planSha256
          && existing.authorizedStateSha256 === loaded.state.stateSha256
          && existing.approvedPlanSha256 === approvedPlanSha256
          && existing.protocolSha256 === protocolSha256
        ? { status: 'OK', authorization: existing, idempotent: true }
        : refused(
            'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_CONFLICT',
            'A different immutable launch authorization already exists.'
          );
    } catch {
      return refused(
        'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_CONFLICT',
        'The existing launch authorization is not valid JSON.'
      );
    }
  }
  const core = {
    schemaVersion: VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_SCHEMA,
    seriesRunId,
    waveId,
    campaignPlanSha256: loaded.plan.planSha256,
    authorizedStateSha256: loaded.state.stateSha256,
    approvedPlanSha256,
    protocolSha256,
    createdAt,
    maximumDispatches: 1,
    retriesAuthorized: false,
    authority: 'operator-reviewed-study-disclosure-v1'
  };
  const authorization = {
    ...core,
    authorizationSha256: sha256(canonicalVNextJson(core))
  };
  store.writeRunFile(
    seriesRunId,
    location.pending,
    `${canonicalVNextJson(authorization)}\n`
  );
  const reopened = JSON.parse(
    store.readRunFile(seriesRunId, location.pending) || 'null'
  );
  return validateVNextCampaignLaunchAuthorization(reopened).status === 'OK'
      && reopened.authorizationSha256 === authorization.authorizationSha256
    ? { status: 'OK', authorization: reopened, idempotent: false }
    : refused(
        'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_WRITE_FAILED',
        'Launch authorization did not replay after persistence.'
      );
}

export function consumeVNextCampaignLaunchAuthorization({
  store,
  seriesRunId,
  descriptor,
  state,
  authorizationSha256,
  protocolSha256
} = {}) {
  const waveId = descriptor?.waveId;
  if (store?.durability !== STORE_DURABILITY.POWER_LOSS) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_DURABILITY_REQUIRED',
      'Paid dispatch requires a power-loss-durable store.'
    );
  }
  if (!isSafeId(seriesRunId) || !isSafeId(waveId)
      || !SHA256.test(String(authorizationSha256 || ''))
      || !SHA256.test(String(protocolSha256 || ''))
      || !frozenReadyWave(state, waveId)
      || canonicalVNextJson(state.queue[0]) !== canonicalVNextJson(descriptor)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_REQUIRED',
      'A matching unconsumed authorization is required before dispatch.'
    );
  }
  const location = paths(waveId);
  if (store.runFileExists(seriesRunId, location.consumed)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_ALREADY_CONSUMED',
      'This wave launch authorization has already been consumed.'
    );
  }
  if (store.runFileExists(seriesRunId, location.cancelled)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_CANCELLED',
      'This wave launch authorization was cancelled before dispatch.'
    );
  }
  const loaded = loadCampaignSeriesStore({ store, runId: seriesRunId });
  if (loaded.status !== 'OK'
      || loaded.state.stateSha256 !== state.stateSha256
      || loaded.plan.planSha256 !== state.planSha256) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_STATE_DRIFT',
      'Campaign state changed after launch authorization was checked.'
    );
  }
  let authorization;
  try {
    authorization = JSON.parse(
      store.readRunFile(seriesRunId, location.pending) || ''
    );
  } catch {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_REQUIRED',
      'No valid pending launch authorization exists for this wave.'
    );
  }
  if (validateVNextCampaignLaunchAuthorization(authorization).status !== 'OK'
      || authorization.authorizationSha256 !== authorizationSha256
      || authorization.seriesRunId !== seriesRunId
      || authorization.waveId !== waveId
      || authorization.campaignPlanSha256 !== state.planSha256
      || authorization.authorizedStateSha256 !== state.stateSha256
      || authorization.protocolSha256 !== protocolSha256) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_MISMATCH',
      'Pending launch authorization does not bind this exact dispatch.'
    );
  }
  const approvalReplay = verifyVNextStudyPlanFromDisk({
    store,
    seriesRunId,
    waveId,
    approvedPlanSha256: authorization.approvedPlanSha256,
    requireApproval: true
  });
  if (approvalReplay.status !== 'OK'
      || approvalReplay.disclosure.studyBinding.protocolSha256 !== protocolSha256) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_APPROVAL_REPLAY_FAILED',
      'The final dispatch boundary could not replay the exact approved study disclosure.'
    );
  }
  if (!store.moveRunFile(seriesRunId, location.pending, location.consumed)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_CONSUME_FAILED',
      'Launch authorization could not be atomically consumed.'
    );
  }
  const consumedText = store.readRunFile(seriesRunId, location.consumed);
  return !store.runFileExists(seriesRunId, location.pending)
      && consumedText === `${canonicalVNextJson(authorization)}\n`
    ? { status: 'OK', authorization, consumed: true }
    : refused(
        'VNEXT_CAMPAIGN_LAUNCH_CONSUME_FAILED',
        'Consumed launch authorization failed durable replay.'
      );
}

export function cancelVNextCampaignLaunchAuthorization({
  store,
  seriesRunId,
  waveId
} = {}) {
  if (store?.durability !== STORE_DURABILITY.POWER_LOSS) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_DURABILITY_REQUIRED',
      'Launch cancellation requires a power-loss-durable store.'
    );
  }
  if (!isSafeId(seriesRunId) || !isSafeId(waveId)) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_CANCEL_INPUT_INVALID',
      'A store and safe run/wave IDs are required to cancel launch authority.'
    );
  }
  const location = paths(waveId);
  if (store.runFileExists(seriesRunId, location.consumed)) {
    return {
      status: 'OK',
      disposition: 'ALREADY_CONSUMED',
      cancelled: false,
      idempotent: true
    };
  }
  if (store.runFileExists(seriesRunId, location.cancelled)) {
    return {
      status: 'OK',
      disposition: 'CANCELLED',
      cancelled: true,
      idempotent: true
    };
  }
  const text = store.readRunFile(seriesRunId, location.pending);
  if (text == null) {
    return {
      status: 'OK',
      disposition: 'NO_PENDING_AUTHORIZATION',
      cancelled: false,
      idempotent: true
    };
  }
  let authorization;
  try { authorization = JSON.parse(text); } catch { authorization = null; }
  if (validateVNextCampaignLaunchAuthorization(authorization).status !== 'OK'
      || authorization.seriesRunId !== seriesRunId
      || authorization.waveId !== waveId) {
    return refused(
      'VNEXT_CAMPAIGN_LAUNCH_CANCEL_AUTHORIZATION_INVALID',
      'Pending launch authority failed replay and was not moved.'
    );
  }
  return store.moveRunFile(seriesRunId, location.pending, location.cancelled)
    ? {
        status: 'OK',
        disposition: 'CANCELLED',
        cancelled: true,
        idempotent: false,
        authorizationSha256: authorization.authorizationSha256
      }
    : refused(
        'VNEXT_CAMPAIGN_LAUNCH_CANCEL_FAILED',
        'Pending launch authority could not be atomically cancelled.'
      );
}
