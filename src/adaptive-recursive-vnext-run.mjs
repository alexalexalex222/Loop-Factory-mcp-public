import { randomUUID } from 'node:crypto';
import {
  ADAPTIVE_RECURSIVE_CANARY_V2
} from './adaptive-recursive-canary-v2.mjs';
import {
  runAdaptiveRecursiveCanaryV2,
  verifyAdaptiveRecursiveCanaryV2Run
} from './adaptive-recursive-runner-v2.mjs';
import {
  acquireRunLease,
  releaseRunLease,
  renewRunLease,
  verifyRunLeaseHistory
} from './run-lease.mjs';
import {
  startRunLeaseHeartbeat,
  verifyRunLeaseHeartbeat
} from './run-lease-heartbeat.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { isSafeId, nowIso, sha256 } from './util.mjs';

export const ADAPTIVE_RECURSIVE_VNEXT_LEASE_RECEIPT =
  'adaptive-recursive-vnext-lease-receipt-v2';

const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_FILE = 'adaptive-recursive-vnext-lease-receipt.json';
const LEASE_SAFETY_MARGIN_MS = 60_000;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function receiptPayload(receipt) {
  const { receiptSha256, ...payload } = receipt;
  return payload;
}

function closedReceipt(receipt) {
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && canonicalVNextJson(Object.keys(receipt).sort()) === canonicalVNextJson([
      'schemaVersion',
      'runId',
      'leaseOwnerId',
      'supervisionSessionCount',
      'leaseAuthoritySha256s',
      'leaseTtlMs',
      'minimumLeaseTtlMs',
      'renewAfterEveryPersistedCall',
      'heartbeatDuringCall',
      'heartbeatIntervalMs',
      'heartbeatTimeoutMs',
      'heartbeatSha256',
      'heartbeatAuthoritySha256',
      'callsAtReceipt',
      'runnerDisposition',
      'runnerEvidenceSha256',
      'leaseHistorySha256',
      'latestLeaseSha256',
      'recordedAt',
      'receiptSha256'
    ].sort());
}

export function verifyAdaptiveRecursiveVNextLeaseReceipt(store, runId) {
  try {
    const raw = store.readRunFile(runId, RECEIPT_FILE);
    const receipt = raw ? JSON.parse(raw) : null;
    const state = store.load(runId);
    const history = verifyRunLeaseHistory({ homeDir: store.homeDir, runId });
    const runner = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
    const heartbeat = history.status === 'OK'
      ? verifyRunLeaseHeartbeat({
          homeDir: store.homeDir,
          runId,
          lease: history.latestLease,
          requireFresh: false
        })
      : { status: 'REFUSED' };
    const leaseAuthoritySha256s = history.status === 'OK'
      ? history.history.reduce((rows, row) => (
          rows.at(-1) === row.ownerBindingSha256
            ? rows
            : [...rows, row.ownerBindingSha256]
        ), [])
      : [];
    const minimumLeaseTtlMs = ADAPTIVE_RECURSIVE_CANARY_V2.perCallTimeoutMs
      + LEASE_SAFETY_MARGIN_MS;
    const valid = closedReceipt(receipt)
      && receipt.schemaVersion === ADAPTIVE_RECURSIVE_VNEXT_LEASE_RECEIPT
      && receipt.runId === runId
      && isSafeId(receipt.leaseOwnerId)
      && receipt.leaseOwnerId === history.latestLease?.ownerId
      && Number.isSafeInteger(receipt.supervisionSessionCount)
      && receipt.supervisionSessionCount === leaseAuthoritySha256s.length
      && canonicalVNextJson(receipt.leaseAuthoritySha256s)
        === canonicalVNextJson(leaseAuthoritySha256s)
      && Number.isSafeInteger(receipt.leaseTtlMs)
      && receipt.leaseTtlMs >= minimumLeaseTtlMs
      && receipt.minimumLeaseTtlMs === minimumLeaseTtlMs
      && receipt.renewAfterEveryPersistedCall === true
      && receipt.heartbeatDuringCall === true
      && Number.isSafeInteger(receipt.heartbeatIntervalMs)
      && receipt.heartbeatIntervalMs >= 100
      && Number.isSafeInteger(receipt.heartbeatTimeoutMs)
      && receipt.heartbeatTimeoutMs >= receipt.heartbeatIntervalMs * 2
      && heartbeat.status === 'OK'
      && receipt.heartbeatSha256 === heartbeat.heartbeatSha256
      && receipt.heartbeatAuthoritySha256 === leaseAuthoritySha256s.at(-1)
      && heartbeat.heartbeat.authoritySha256 === receipt.heartbeatAuthoritySha256
      && Number.isSafeInteger(receipt.callsAtReceipt)
      && receipt.callsAtReceipt === (state?.calls?.length || 0)
      && history.status === 'OK'
      && history.latestKind === 'released'
      && history.history.length
        === receipt.callsAtReceipt + receipt.supervisionSessionCount
      && receipt.leaseHistorySha256 === history.historySha256
      && receipt.latestLeaseSha256 === history.latestLease.leaseSha256
      && receipt.runnerDisposition === state?.status
      && SHA256.test(String(receipt.runnerEvidenceSha256 || ''))
      && receipt.runnerEvidenceSha256 === runner.evidenceSha256
      && Number.isFinite(Date.parse(receipt.recordedAt))
      && receipt.receiptSha256 === sha256(canonicalVNextJson(receiptPayload(receipt)));
    return valid
      ? {
          status: 'OK',
          receipt,
          history,
          runner,
          evidenceSha256: sha256(canonicalVNextJson({
            receiptSha256: receipt.receiptSha256,
            leaseHistorySha256: history.historySha256,
            runnerEvidenceSha256: runner.evidenceSha256
          }))
        }
      : refused(
          'RECURSIVE_VNEXT_LEASE_RECEIPT_INVALID',
          'The run lease receipt does not replay against persisted runner and lease history.'
        );
  } catch (error) {
    return refused('RECURSIVE_VNEXT_LEASE_RECEIPT_FAILED', error.message);
  }
}

export function runAdaptiveRecursiveCanaryV2WithLease(store, config, {
  runId,
  leaseOwnerId = `supervisor-${process.pid}`,
  leaseNonce = `nonce-${randomUUID()}`,
  leaseTtlMs = ADAPTIVE_RECURSIVE_CANARY_V2.perCallTimeoutMs
    + LEASE_SAFETY_MARGIN_MS,
  leaseClock = nowIso,
  onCallPersisted = null,
  ...runnerOptions
} = {}) {
  if (!config?.resourceBudgetPolicy) {
    return refused(
      'RECURSIVE_HARD_BUDGET_REQUIRED',
      'The leased runner requires a sealed hard resource budget.'
    );
  }
  const minimumLeaseTtlMs = ADAPTIVE_RECURSIVE_CANARY_V2.perCallTimeoutMs
    + LEASE_SAFETY_MARGIN_MS;
  if (!isSafeId(runId) || !isSafeId(leaseOwnerId) || !isSafeId(leaseNonce)
      || !Number.isSafeInteger(leaseTtlMs)
      || leaseTtlMs < minimumLeaseTtlMs
      || typeof leaseClock !== 'function') {
    return refused(
      'RECURSIVE_VNEXT_LEASE_CONFIG_INVALID',
      'The lease must outlive one maximum worker call plus the fixed safety margin.'
    );
  }
  const acquired = acquireRunLease({
    homeDir: store.homeDir,
    runId,
    ownerId: leaseOwnerId,
    nonce: leaseNonce,
    now: leaseClock(),
    ttlMs: leaseTtlMs
  });
  if (acquired.status !== 'OK') {
    return refused(
      acquired.code || 'RECURSIVE_VNEXT_LEASE_ACQUIRE_FAILED',
      'The VNext runner could not acquire exclusive supervision authority.',
      { lease: acquired }
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
      runId,
      ownerId: leaseOwnerId,
      nonce: leaseNonce,
      expectedLeaseSha256: currentLease.leaseSha256
    });
    return refused(
      heartbeat.code || 'RECURSIVE_VNEXT_HEARTBEAT_FAILED',
      'The leased runner could not establish an independent heartbeat.'
    );
  }
  let result;
  let executionError = null;
  try {
    result = runAdaptiveRecursiveCanaryV2(store, config, {
      ...runnerOptions,
      runId,
      onCallPersisted(call) {
        const renewed = renewRunLease({
          homeDir: store.homeDir,
          runId,
          ownerId: leaseOwnerId,
          nonce: leaseNonce,
          expectedLeaseSha256: currentLease.leaseSha256,
          now: leaseClock(),
          ttlMs: leaseTtlMs
        });
        if (renewed.status !== 'OK') {
          const error = new Error('exclusive VNext supervision lease was lost');
          error.code = renewed.code || 'RECURSIVE_VNEXT_LEASE_LOST';
          throw error;
        }
        currentLease = renewed.lease;
        if (typeof onCallPersisted === 'function') onCallPersisted(call);
      }
    });
  } catch (error) {
    executionError = error;
  }

  const heartbeatResult = heartbeat.stop();
  const released = releaseRunLease({
    homeDir: store.homeDir,
    runId,
    ownerId: leaseOwnerId,
    nonce: leaseNonce,
    expectedLeaseSha256: currentLease.leaseSha256
  });
  if (executionError && !String(executionError.code || '').startsWith('RUN_LEASE_')) {
    throw executionError;
  }
  if (released.status !== 'OK') {
    return refused(
      released.code || 'RECURSIVE_VNEXT_LEASE_RELEASE_FAILED',
      'The VNext runner could not prove clean release of exclusive supervision.',
      { result }
    );
  }
  if (executionError) {
    return refused(
      executionError.code || 'RECURSIVE_VNEXT_LEASE_LOST',
      executionError.message,
      { result }
    );
  }
  if (!store.exists(runId)) return result;

  const history = verifyRunLeaseHistory({ homeDir: store.homeDir, runId });
  const runner = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
  if (history.status !== 'OK' || history.latestKind !== 'released') {
    return refused(
      'RECURSIVE_VNEXT_LEASE_HISTORY_INVALID',
      'The released lease history failed independent replay.',
      { result }
    );
  }
  const state = store.load(runId);
  const leaseAuthoritySha256s = history.history.reduce((rows, row) => (
    rows.at(-1) === row.ownerBindingSha256
      ? rows
      : [...rows, row.ownerBindingSha256]
  ), []);
  const payload = {
    schemaVersion: ADAPTIVE_RECURSIVE_VNEXT_LEASE_RECEIPT,
    runId,
    leaseOwnerId: history.latestLease.ownerId,
    supervisionSessionCount: leaseAuthoritySha256s.length,
    leaseAuthoritySha256s,
    leaseTtlMs,
    minimumLeaseTtlMs,
    renewAfterEveryPersistedCall: true,
    heartbeatDuringCall: true,
    heartbeatIntervalMs: heartbeat.intervalMs,
    heartbeatTimeoutMs: heartbeat.timeoutMs,
    heartbeatSha256: heartbeatResult.heartbeatSha256,
    heartbeatAuthoritySha256: heartbeat.binding.authoritySha256,
    callsAtReceipt: state.calls.length,
    runnerDisposition: state.status,
    runnerEvidenceSha256: runner.evidenceSha256,
    leaseHistorySha256: history.historySha256,
    latestLeaseSha256: history.latestLease.leaseSha256,
    recordedAt: leaseClock()
  };
  const receipt = {
    ...payload,
    receiptSha256: sha256(canonicalVNextJson(payload))
  };
  const receiptPath = store.writeRunFile(
    runId,
    RECEIPT_FILE,
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  const checked = verifyAdaptiveRecursiveVNextLeaseReceipt(store, runId);
  if (checked.status !== 'OK') {
    return refused(
      checked.code,
      checked.message,
      { result, receiptPath }
    );
  }
  return {
    ...result,
    leaseReceiptPath: receiptPath,
    leaseReceiptSha256: receipt.receiptSha256,
    leaseEvidenceSha256: checked.evidenceSha256
  };
}
