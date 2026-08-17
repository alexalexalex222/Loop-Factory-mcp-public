import { randomUUID } from 'node:crypto';
import {
  requestCampaignSeriesStop,
  runCampaignSeriesTickAsync,
  validateCampaignSeriesState,
  verifyCampaignSeriesWaveBudgets
} from './campaign-series.mjs';
import {
  appendCampaignSeriesCheckpoint,
  loadCampaignSeriesStore,
  loadCampaignSeriesWaveInputs
} from './campaign-series-store.mjs';
import {
  acquireRunLease,
  releaseRunLease,
  renewRunLease,
  verifyRunLeaseHistory
} from './run-lease.mjs';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  verifyVNextAblationProtocolFromDisk,
  vnextAblationProtocolPhase
} from './vnext-ablation-protocol.mjs';
import {
  runVNextCampaignWave,
  verifyVNextCampaignWave
} from './vnext-wave-runner.mjs';
import {
  cancelVNextCampaignLaunchAuthorization,
  consumeVNextCampaignLaunchAuthorization
} from './vnext-campaign-launch-authorization.mjs';
import { startRunLeaseHeartbeat } from './run-lease-heartbeat.mjs';

export const VNEXT_CAMPAIGN_VERIFIER_SCHEMA =
  'loop-factory-vnext-campaign-verifier-v1';
export const VNEXT_CAMPAIGN_STOP_REQUEST_SCHEMA =
  'loop-factory-vnext-campaign-stop-request-v1';

const SERIES_LEASE_TTL_MS = 11 * 60 * 1000;
const STOP_FILE = 'campaign-series/STOP';

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function stopRequested(store, seriesRunId) {
  return store.runFileExists(seriesRunId, STOP_FILE);
}

export function validateVNextCampaignStopReceipt(receipt) {
  if (!exactKeys(receipt, [
    'schemaVersion', 'runId', 'waveId', 'requestedAt', 'signal',
    'authority', 'receiptSha256'
  ]) || receipt.schemaVersion !== VNEXT_CAMPAIGN_STOP_REQUEST_SCHEMA
      || !isSafeId(receipt.runId)
      || !(receipt.waveId == null || isSafeId(receipt.waveId))
      || !Number.isFinite(Date.parse(receipt.requestedAt))
      || receipt.signal !== 'SIGTERM'
      || receipt.authority !== 'local-operator-cli') {
    return refused(
      'VNEXT_CAMPAIGN_STOP_RECEIPT_INVALID',
      'The operator stop receipt failed its closed contract.'
    );
  }
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  return receipt.receiptSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', receipt }
    : refused(
        'VNEXT_CAMPAIGN_STOP_RECEIPT_TAMPERED',
        'The operator stop receipt hash failed replay.'
      );
}

export function createVNextCampaignStopReceipt({
  seriesRunId,
  state = null,
  requestedAt = new Date().toISOString()
} = {}) {
  if (!isSafeId(seriesRunId) || !Number.isFinite(Date.parse(requestedAt))
      || (state != null && validateCampaignSeriesState(state).status !== 'OK')) {
    return refused(
      'VNEXT_CAMPAIGN_STOP_REQUEST_INVALID',
      'A safe run, valid time, and optional replayed campaign state are required.'
    );
  }
  const core = {
    schemaVersion: VNEXT_CAMPAIGN_STOP_REQUEST_SCHEMA,
    runId: seriesRunId,
    waveId: state?.currentWave?.descriptor?.waveId
      ?? state?.queue?.[0]?.waveId
      ?? null,
    requestedAt,
    signal: 'SIGTERM',
    authority: 'local-operator-cli'
  };
  const receipt = {
    ...core,
    receiptSha256: sha256(canonicalVNextJson(core))
  };
  return validateVNextCampaignStopReceipt(receipt).status === 'OK'
    ? { status: 'OK', receipt }
    : refused(
        'VNEXT_CAMPAIGN_STOP_REQUEST_INVALID',
        'The operator stop receipt could not be sealed.'
      );
}

function verifyNextWaveProtocol({
  store,
  seriesRunId,
  state,
  protocol,
  packageRoot
}) {
  const descriptor = state.currentWave?.descriptor ?? state.queue[0] ?? null;
  if (!descriptor) return { status: 'OK', protocolRequired: false };
  const inputs = loadCampaignSeriesWaveInputs({
    store,
    runId: seriesRunId,
    waveId: descriptor.waveId
  });
  if (inputs.status !== 'OK') return inputs;
  const facts = inputs.config.preparation?.architectureFacts;
  const protocolSha256 = facts?.protocolSha256 ?? null;
  const phaseId = facts?.studyPhaseId ?? null;
  if (protocolSha256 == null && phaseId == null) {
    return refused(
      'VNEXT_CAMPAIGN_PROTOCOL_BINDING_REQUIRED',
      'Paid VNext waves must be created under a replayable ablation protocol.'
    );
  }
  const replay = protocol
    ? verifyVNextAblationProtocolFromDisk({ protocol, packageRoot })
    : refused(
        'VNEXT_CAMPAIGN_PROTOCOL_REQUIRED',
        'A protocol-bound study wave must replay its evaluator proof before dispatch.'
      );
  const phase = replay.status === 'OK'
    ? vnextAblationProtocolPhase(
        protocol,
        phaseId,
        inputs.config.ablationProfile.armId,
        inputs.taskPack.packSha256
      )
    : null;
  return replay.status === 'OK'
      && protocol.protocolSha256 === protocolSha256
      && phase
    ? { status: 'OK', protocolRequired: true, protocolSha256 }
    : replay.status === 'OK'
      ? refused(
          'VNEXT_CAMPAIGN_PROTOCOL_BINDING_MISMATCH',
          'The next study wave is not authorized by the replayed protocol.'
        )
      : replay;
}

export async function recoverVNextCampaignWave({
  store,
  seriesRunId,
  descriptor,
  shouldStop = () => false,
  progressObserver = () => {},
  resumeWave = runVNextCampaignWave
} = {}) {
  if (!store || !isSafeId(seriesRunId) || !isSafeId(descriptor?.waveId)
      || typeof shouldStop !== 'function'
      || typeof progressObserver !== 'function'
      || typeof resumeWave !== 'function') {
    return refused(
      'VNEXT_CAMPAIGN_WAVE_RECOVERY_INVALID',
      'Campaign recovery requires one bound inner wave runner.'
    );
  }
  return resumeWave({
    store,
    seriesRunId,
    waveId: descriptor.waveId,
    shouldStop,
    progressObserver
  });
}

export function validateVNextCampaignVerifierEvidence(evidence) {
  if (!exactKeys(evidence, [
    'schemaVersion', 'seriesRunId', 'planSha256', 'stateSha256',
    'checkpointSha256', 'rootBudgetLedgerSha256', 'leaseHistorySha256',
    'waves', 'status', 'operatorStop', 'seriesValid', 'promotionAuthorized'
  ])
      || evidence.schemaVersion !== VNEXT_CAMPAIGN_VERIFIER_SCHEMA
      || !isSafeId(evidence.seriesRunId)
      || ![evidence.planSha256, evidence.stateSha256,
        evidence.checkpointSha256, evidence.rootBudgetLedgerSha256]
        .every((value) => /^[a-f0-9]{64}$/.test(String(value || '')))
      || !(evidence.leaseHistorySha256 == null
        || /^[a-f0-9]{64}$/.test(String(evidence.leaseHistorySha256)))
      || !Array.isArray(evidence.waves)
      || evidence.waves.some((wave) => !exactKeys(wave, [
        'waveId', 'disposition', 'valid', 'evidenceSha256'
      ])
        || !isSafeId(wave.waveId)
        || !['VERIFIED', 'INVALID', 'AMBIGUOUS_DISPATCH', 'QUEUED']
          .includes(wave.disposition)
        || typeof wave.valid !== 'boolean'
        || !(wave.evidenceSha256 == null
          || /^[a-f0-9]{64}$/.test(String(wave.evidenceSha256))))
      || typeof evidence.status !== 'string'
      || typeof evidence.operatorStop !== 'boolean'
      || typeof evidence.seriesValid !== 'boolean'
      || evidence.promotionAuthorized !== false) {
    return refused(
      'VNEXT_CAMPAIGN_VERIFIER_EVIDENCE_INVALID',
      'Campaign verifier evidence failed its closed authority contract.'
    );
  }
  return { status: 'OK', evidence };
}

export async function runVNextCampaignSeriesTick({
  store,
  seriesRunId,
  protocol = null,
  launchAuthorizationSha256 = null,
  packageRoot = undefined
} = {}) {
  if (!store || !isSafeId(seriesRunId)) {
    return refused('VNEXT_CAMPAIGN_TICK_INPUT_INVALID', 'A store and safe series run ID are required.');
  }
  const ownerId = `campaign-supervisor-${process.pid}`;
  const nonce = `nonce-${randomUUID()}`;
  const acquired = acquireRunLease({
    homeDir: store.homeDir,
    runId: seriesRunId,
    ownerId,
    nonce,
    ttlMs: SERIES_LEASE_TTL_MS
  });
  if (acquired.status !== 'OK') {
    return refused(
      acquired.code || 'VNEXT_CAMPAIGN_LEASE_FAILED',
      'Another campaign supervisor owns this series or its lease is invalid.'
    );
  }
  let currentLease = acquired.lease;
  const heartbeat = startRunLeaseHeartbeat({
    homeDir: store.homeDir,
    lease: currentLease
  });
  if (heartbeat.status !== 'OK') {
    releaseRunLease({
      homeDir: store.homeDir,
      runId: seriesRunId,
      ownerId,
      nonce,
      expectedLeaseSha256: currentLease.leaseSha256
    });
    return refused(
      heartbeat.code || 'VNEXT_CAMPAIGN_HEARTBEAT_FAILED',
      'Campaign supervision could not establish an independent lease heartbeat.'
    );
  }
  const renew = () => {
    const renewed = renewRunLease({
      homeDir: store.homeDir,
      runId: seriesRunId,
      ownerId,
      nonce,
      expectedLeaseSha256: currentLease.leaseSha256,
      ttlMs: SERIES_LEASE_TTL_MS
    });
    if (renewed.status !== 'OK') {
      const error = new Error('Campaign supervision lease was lost.');
      error.code = renewed.code || 'VNEXT_CAMPAIGN_LEASE_LOST';
      throw error;
    }
    currentLease = renewed.lease;
  };
  let result;
  try {
    const loaded = loadCampaignSeriesStore({ store, runId: seriesRunId });
    if (loaded.status !== 'OK') {
      result = loaded;
    } else {
      let state = loaded.state;
      if (stopRequested(store, seriesRunId) && !state.operatorStop) {
        const stoppingWaveId = state.currentWave?.descriptor?.waveId
          ?? state.queue[0]?.waveId
          ?? null;
        const cancelled = stoppingWaveId
          ? cancelVNextCampaignLaunchAuthorization({
              store,
              seriesRunId,
              waveId: stoppingWaveId
            })
          : { status: 'OK', disposition: 'NO_WAVE' };
        if (cancelled.status !== 'OK') {
          result = cancelled;
        } else {
          const stopped = requestCampaignSeriesStop(state, {
            expectedStateSha256: state.stateSha256,
            requestedAt: new Date().toISOString()
          });
          if (stopped.status !== 'OK') {
            result = stopped;
          } else {
            const checkpoint = appendCampaignSeriesCheckpoint({
              store,
              runId: seriesRunId,
              plan: loaded.plan,
              state: stopped.state
            });
            result = checkpoint.status === 'OK'
              ? {
                  status: 'OK',
                  state: stopped.state,
                  disposition: 'OPERATOR_STOP',
                  inferenceCalls: 0,
                  launchAuthorization: cancelled.disposition
                }
              : checkpoint;
          }
        }
      } else {
        const protocolReplay = verifyNextWaveProtocol({
          store,
          seriesRunId,
          state,
          protocol,
          packageRoot
        });
        if (protocolReplay.status !== 'OK') {
          result = protocolReplay;
        } else {
          result = await runCampaignSeriesTickAsync({
          state,
          plan: loaded.plan,
          budgetLedger: loaded.rootBudgetLedger,
          authorizeDispatch: async (descriptor, authorizationState) => (
            consumeVNextCampaignLaunchAuthorization({
              store,
              seriesRunId,
              descriptor,
              state: authorizationState,
              authorizationSha256: launchAuthorizationSha256,
              protocolSha256: protocolReplay.protocolSha256
            })
          ),
          persistState: async (next) => {
            const persisted = appendCampaignSeriesCheckpoint({
              store,
              runId: seriesRunId,
              plan: loaded.plan,
              state: next
            });
            if (persisted.status !== 'OK') {
              const error = new Error(persisted.message || 'Campaign checkpoint failed.');
              error.code = persisted.code || 'VNEXT_CAMPAIGN_CHECKPOINT_FAILED';
              throw error;
            }
          },
          runWave: async (descriptor) => runVNextCampaignWave({
            store,
            seriesRunId,
            waveId: descriptor.waveId,
            shouldStop: () => stopRequested(store, seriesRunId),
            progressObserver: renew
          }),
          recoverWave: async (descriptor) => recoverVNextCampaignWave({
            store,
            seriesRunId,
            descriptor,
            shouldStop: () => stopRequested(store, seriesRunId),
            progressObserver: renew
          }),
          verifyWave: async (descriptor) => verifyVNextCampaignWave({
            store,
            seriesRunId,
            waveId: descriptor.waveId
          }),
          now: new Date().toISOString()
          });
        }
      }
    }
  } catch (error) {
    result = refused(
      error.code || 'VNEXT_CAMPAIGN_TICK_FAILED',
      error.message || 'Campaign tick failed.'
    );
  }
  const heartbeatStopped = heartbeat.stop();
  const released = releaseRunLease({
    homeDir: store.homeDir,
    runId: seriesRunId,
    ownerId,
    nonce,
    expectedLeaseSha256: currentLease.leaseSha256
  });
  if (heartbeatStopped.status !== 'OK') {
    return refused(
      heartbeatStopped.code || 'VNEXT_CAMPAIGN_HEARTBEAT_STOP_FAILED',
      'Campaign state was preserved, but heartbeat cleanup failed.',
      { result }
    );
  }
  return released.status === 'OK'
    ? result
    : refused(
        released.code || 'VNEXT_CAMPAIGN_LEASE_RELEASE_FAILED',
        'Campaign state was preserved, but exclusive supervision release failed.',
        { result }
      );
}

export async function runVNextCampaignSeriesContinuous({
  store,
  seriesRunId,
  pollIntervalMs = 5000,
  maximumTicks = Infinity,
  signal = null,
  protocol = null,
  launchAuthorizationSha256 = null,
  packageRoot = undefined
} = {}) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60000
      || !(maximumTicks === Infinity
        || (Number.isSafeInteger(maximumTicks) && maximumTicks > 0))) {
    return refused('VNEXT_CAMPAIGN_LOOP_CONFIG_INVALID', 'Polling interval or tick bound is invalid.');
  }
  let ticks = 0;
  let inferenceCalls = 0;
  while (ticks < maximumTicks) {
    if (signal?.aborted) {
      return { status: 'OK', disposition: 'LOCAL_ABORT', ticks, inferenceCalls };
    }
    const tick = await runVNextCampaignSeriesTick({
      store,
      seriesRunId,
      protocol,
      launchAuthorizationSha256,
      packageRoot
    });
    ticks += 1;
    inferenceCalls += Number.isSafeInteger(tick.inferenceCalls) ? tick.inferenceCalls : 0;
    if (tick.status !== 'OK'
        || ['OPERATOR_STOP', 'BLOCKED'].includes(tick.disposition)) {
      return { ...tick, ticks, inferenceCalls };
    }
    if (ticks >= maximumTicks) return { ...tick, ticks, inferenceCalls };
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs));
  }
  return { status: 'OK', disposition: 'TICK_BOUND_REACHED', ticks, inferenceCalls };
}

export function verifyVNextCampaignSeries({ store, seriesRunId } = {}) {
  try {
    const loaded = loadCampaignSeriesStore({ store, runId: seriesRunId });
    if (loaded.status !== 'OK') return loaded;
    const stateValid = validateCampaignSeriesState(loaded.state).status === 'OK';
    const waves = [];
    let evidenceValid = true;
    for (const descriptor of loaded.state.completedWaves) {
      if (descriptor.status === 'VERIFIED') {
        const verified = verifyVNextCampaignWave({
          store,
          seriesRunId,
          waveId: descriptor.waveId
        });
        const budget = verified.status === 'OK'
          ? verifyCampaignSeriesWaveBudgets(descriptor, verified)
          : { status: 'REFUSED' };
        const valid = verified.status === 'OK'
          && budget.status === 'OK'
          && verified.evidenceSha256 === descriptor.evidenceSha256
          && budget.usageSha256 === descriptor.budgetUsageSha256;
        evidenceValid &&= valid;
        waves.push({
          waveId: descriptor.waveId,
          disposition: descriptor.status,
          valid,
          evidenceSha256: verified.evidenceSha256 ?? null
        });
      } else {
        const valid = ['AMBIGUOUS_DISPATCH', 'INVALID'].includes(descriptor.status);
        evidenceValid &&= valid;
        waves.push({
          waveId: descriptor.waveId,
          disposition: descriptor.status,
          valid,
          evidenceSha256: descriptor.evidenceSha256 ?? null
        });
      }
    }
    for (const descriptor of loaded.state.queue) {
      const input = loadCampaignSeriesWaveInputs({
        store,
        runId: seriesRunId,
        waveId: descriptor.waveId
      });
      const valid = input.status === 'OK'
        && input.taskPack.packSha256 === descriptor.taskPackSha256
        && input.manifest.configSha256 === descriptor.configSha256
        && input.manifest.budgetPolicySetSha256 === descriptor.budgetPolicySetSha256;
      evidenceValid &&= valid;
      waves.push({
        waveId: descriptor.waveId,
        disposition: 'QUEUED',
        valid,
        evidenceSha256: input.evidenceSha256 ?? null
      });
    }
    const leaseRequired = loaded.state.events.some((event) => (
      ['WAVE_DISPATCHED', 'WAVE_VERIFIED', 'WAVE_RECOVERED',
        'WAVE_INVALID', 'AMBIGUOUS_WAVE_DISPATCH'].includes(event.type)
    ));
    const lease = leaseRequired
      ? verifyRunLeaseHistory({ homeDir: store.homeDir, runId: seriesRunId })
      : { status: 'NOT_REQUIRED', historySha256: null };
    const seriesValid = stateValid
      && evidenceValid
      && (lease.status === 'OK' || lease.status === 'NOT_REQUIRED');
    const evidence = {
      schemaVersion: VNEXT_CAMPAIGN_VERIFIER_SCHEMA,
      seriesRunId,
      planSha256: loaded.plan.planSha256,
      stateSha256: loaded.state.stateSha256,
      checkpointSha256: loaded.checkpoints.at(-1).checkpointSha256,
      rootBudgetLedgerSha256: loaded.rootBudgetLedger.ledgerSha256,
      leaseHistorySha256: lease.historySha256 ?? null,
      waves,
      status: loaded.state.status,
      operatorStop: loaded.state.operatorStop,
      seriesValid,
      promotionAuthorized: false
    };
    const evidenceValidation = validateVNextCampaignVerifierEvidence(evidence);
    if (evidenceValidation.status !== 'OK') return evidenceValidation;
    return {
      status: seriesValid ? 'OK' : 'REFUSED',
      seriesValid,
      campaignContinues: seriesValid
        && !loaded.state.operatorStop
        && loaded.state.status !== 'BLOCKED',
      state: loaded.state,
      waves,
      evidence,
      evidenceSha256: sha256(canonicalVNextJson(evidence))
    };
  } catch (error) {
    return refused('VNEXT_CAMPAIGN_VERIFY_FAILED', error.message);
  }
}
