import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_CONTEXT_OBSERVATION_SCHEMA = 'vnext-context-observation-v1';
export const VNEXT_CONTEXT_POLICY_SCHEMA = 'vnext-context-policy-v1';
export const VNEXT_CONTEXT_MIN_ADAPTIVE_OBSERVATIONS = 5;
export const VNEXT_CONTEXT_MIN_CONTROL_OBSERVATIONS = 2;

const SHA256 = /^[a-f0-9]{64}$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compatibility(value) {
  if (!plainObject(value)
      || !['domain', 'harnessSha256', 'model', 'toolEnvironmentSha256']
        .every((key) => Object.hasOwn(value, key))
      || Object.keys(value).length !== 4
      || typeof value.model !== 'string'
      || value.model.length < 1
      || value.model.length > 120
      || typeof value.domain !== 'string'
      || value.domain.length < 1
      || value.domain.length > 120
      || !SHA256.test(String(value.harnessSha256 || ''))
      || !SHA256.test(String(value.toolEnvironmentSha256 || ''))) return null;
  return structuredClone(value);
}

function observationPayload(record) {
  return {
    schemaVersion: record.schemaVersion,
    observationId: record.observationId,
    observedAt: record.observedAt,
    runId: record.runId,
    taskClusterId: record.taskClusterId,
    arm: record.arm,
    compatibility: record.compatibility,
    allocatedInputTokens: record.allocatedInputTokens,
    usedInputTokens: record.usedInputTokens,
    outputTokens: record.outputTokens,
    relevantRecords: record.relevantRecords,
    selectedRecords: record.selectedRecords,
    hydratedRecords: record.hydratedRecords,
    missedRelevantRecords: record.missedRelevantRecords,
    qualityEffect: record.qualityEffect,
    contextPackageSha256: record.contextPackageSha256,
    verifierEvidenceSha256: record.verifierEvidenceSha256
  };
}

export function createVNextContextObservation(input = {}) {
  const base = {
    schemaVersion: VNEXT_CONTEXT_OBSERVATION_SCHEMA,
    observationId: input.observationId,
    observedAt: input.observedAt,
    runId: input.runId,
    taskClusterId: input.taskClusterId,
    arm: input.arm,
    compatibility: compatibility(input.compatibility),
    allocatedInputTokens: input.allocatedInputTokens,
    usedInputTokens: input.usedInputTokens,
    outputTokens: input.outputTokens,
    relevantRecords: input.relevantRecords,
    selectedRecords: input.selectedRecords,
    hydratedRecords: input.hydratedRecords,
    missedRelevantRecords: input.missedRelevantRecords,
    qualityEffect: input.qualityEffect,
    contextPackageSha256: input.contextPackageSha256,
    verifierEvidenceSha256: input.verifierEvidenceSha256
  };
  if (!isSafeId(base.observationId)
      || !isSafeId(base.runId)
      || !isSafeId(base.taskClusterId)
      || !['adaptive', 'permanent-control'].includes(base.arm)
      || base.compatibility == null
      || !Number.isFinite(Date.parse(base.observedAt))
      || !Number.isInteger(base.allocatedInputTokens)
      || base.allocatedInputTokens < 1
      || !Number.isInteger(base.usedInputTokens)
      || base.usedInputTokens < 0
      || base.usedInputTokens > base.allocatedInputTokens
      || !Number.isInteger(base.outputTokens)
      || base.outputTokens < 0
      || ![base.relevantRecords, base.selectedRecords, base.hydratedRecords, base.missedRelevantRecords]
        .every((value) => Number.isInteger(value) && value >= 0)
      || base.hydratedRecords > base.selectedRecords
      || base.missedRelevantRecords > base.relevantRecords
      || !Number.isFinite(base.qualityEffect)
      || base.qualityEffect < -1
      || base.qualityEffect > 1
      || !SHA256.test(String(base.contextPackageSha256 || ''))
      || !SHA256.test(String(base.verifierEvidenceSha256 || ''))) {
    return { status: 'REFUSED', code: 'VNEXT_CONTEXT_OBSERVATION_INVALID' };
  }
  return {
    status: 'OK',
    observation: {
      ...base,
      observationSha256: sha256(canonicalVNextJson(base))
    }
  };
}

export function validateVNextContextObservation(record) {
  if (!record
      || record.schemaVersion !== VNEXT_CONTEXT_OBSERVATION_SCHEMA
      || record.observationSha256 !== sha256(canonicalVNextJson(observationPayload(record)))) {
    return { status: 'REFUSED', code: 'VNEXT_CONTEXT_OBSERVATION_TAMPERED' };
  }
  return createVNextContextObservation(record).status === 'OK'
    ? { status: 'OK', observation: record }
    : { status: 'REFUSED', code: 'VNEXT_CONTEXT_OBSERVATION_INVALID' };
}

function policyPayload(policy) {
  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    scopeId: policy.scopeId,
    compatibility: policy.compatibility,
    epoch: policy.epoch,
    minInputTokens: policy.minInputTokens,
    maxInputTokens: policy.maxInputTokens,
    allocatedInputTokens: policy.allocatedInputTokens,
    permanentControlFraction: policy.permanentControlFraction,
    maximumStepFraction: policy.maximumStepFraction,
    action: policy.action,
    evidence: policy.evidence,
    compaction: policy.compaction,
    previousPolicySha256: policy.previousPolicySha256,
    createdAt: policy.createdAt
  };
}

export function createInitialVNextContextPolicy(input = {}) {
  const base = {
    schemaVersion: VNEXT_CONTEXT_POLICY_SCHEMA,
    policyId: input.policyId,
    scopeId: input.scopeId,
    compatibility: compatibility(input.compatibility),
    epoch: 1,
    minInputTokens: input.minInputTokens,
    maxInputTokens: input.maxInputTokens,
    allocatedInputTokens: input.allocatedInputTokens,
    permanentControlFraction: input.permanentControlFraction,
    maximumStepFraction: input.maximumStepFraction ?? 0.1,
    action: 'INITIAL',
    evidence: {
      adaptiveObservations: 0,
      controlObservations: 0,
      pairedClusters: 0,
      medianSaturation: null,
      medianQualityEffect: null,
      medianControlEffect: null,
      missedRelevantRecords: 0,
      observationSha256s: []
    },
    compaction: {
      mode: 'lossless-reference-and-hydration',
      contentDeletionAuthorized: false
    },
    previousPolicySha256: null,
    createdAt: input.createdAt
  };
  if (!isSafeId(base.policyId)
      || !isSafeId(base.scopeId)
      || base.compatibility == null
      || !Number.isInteger(base.minInputTokens)
      || !Number.isInteger(base.maxInputTokens)
      || !Number.isInteger(base.allocatedInputTokens)
      || base.minInputTokens < 1
      || base.minInputTokens > base.allocatedInputTokens
      || base.allocatedInputTokens > base.maxInputTokens
      || !Number.isFinite(base.permanentControlFraction)
      || base.permanentControlFraction <= 0
      || base.permanentControlFraction >= 1
      || !Number.isFinite(base.maximumStepFraction)
      || base.maximumStepFraction <= 0
      || base.maximumStepFraction > 0.1
      || !Number.isFinite(Date.parse(base.createdAt))) {
    return { status: 'REFUSED', code: 'VNEXT_CONTEXT_POLICY_INVALID' };
  }
  return {
    status: 'OK',
    policy: { ...base, policySha256: sha256(canonicalVNextJson(base)) }
  };
}

export function validateVNextContextPolicy(policy) {
  if (!policy
      || policy.schemaVersion !== VNEXT_CONTEXT_POLICY_SCHEMA
      || policy.policySha256 !== sha256(canonicalVNextJson(policyPayload(policy)))
      || policy.compaction?.contentDeletionAuthorized !== false
      || policy.compaction?.mode !== 'lossless-reference-and-hydration') {
    return { status: 'REFUSED', code: 'VNEXT_CONTEXT_POLICY_TAMPERED' };
  }
  return { status: 'OK', policy };
}

function sameCompatibility(left, right) {
  return canonicalVNextJson(left) === canonicalVNextJson(right);
}

export function deriveVNextContextPolicy({
  previousPolicy,
  observations,
  createdAt
} = {}) {
  if (validateVNextContextPolicy(previousPolicy).status !== 'OK'
      || !Array.isArray(observations)
      || !Number.isFinite(Date.parse(createdAt))) {
    return { status: 'REFUSED', code: 'VNEXT_CONTEXT_POLICY_DERIVATION_INVALID' };
  }
  const valid = observations.filter((record) => (
    validateVNextContextObservation(record).status === 'OK'
    && sameCompatibility(record.compatibility, previousPolicy.compatibility)
  ));
  if (new Set(valid.map((record) => record.observationSha256)).size !== valid.length) {
    return { status: 'REFUSED', code: 'VNEXT_CONTEXT_OBSERVATION_DUPLICATE' };
  }
  const adaptive = valid.filter((record) => record.arm === 'adaptive');
  const control = valid.filter((record) => record.arm === 'permanent-control');
  const pairedClusters = new Set(adaptive.map((record) => record.taskClusterId)
    .filter((id) => control.some((record) => record.taskClusterId === id))).size;
  const saturation = adaptive.map((record) => (
    record.usedInputTokens / record.allocatedInputTokens
  ));
  const medianSaturation = median(saturation);
  const medianQualityEffect = median(adaptive.map((record) => record.qualityEffect));
  const medianControlEffect = median(control.map((record) => record.qualityEffect));
  const missedRelevantRecords = adaptive.reduce(
    (sum, record) => sum + record.missedRelevantRecords,
    0
  );
  let action = 'RETAIN_INSUFFICIENT_EVIDENCE';
  let nextAllocation = previousPolicy.allocatedInputTokens;
  if (adaptive.length >= VNEXT_CONTEXT_MIN_ADAPTIVE_OBSERVATIONS
      && control.length >= VNEXT_CONTEXT_MIN_CONTROL_OBSERVATIONS
      && pairedClusters >= VNEXT_CONTEXT_MIN_CONTROL_OBSERVATIONS) {
    const step = Math.max(1, Math.floor(
      previousPolicy.allocatedInputTokens * previousPolicy.maximumStepFraction
    ));
    if (medianSaturation >= 0.85
        && (missedRelevantRecords > 0 || medianQualityEffect > medianControlEffect)) {
      action = 'EXPAND_MEASURED_SATURATION';
      nextAllocation = Math.min(previousPolicy.maxInputTokens,
        previousPolicy.allocatedInputTokens + step);
    } else if (medianSaturation <= 0.5
        && missedRelevantRecords === 0
        && medianQualityEffect >= medianControlEffect) {
      action = 'NARROW_MEASURED_HEADROOM';
      nextAllocation = Math.max(previousPolicy.minInputTokens,
        previousPolicy.allocatedInputTokens - step);
    } else {
      action = 'RETAIN_MEASURED';
    }
  }
  const evidence = {
    adaptiveObservations: adaptive.length,
    controlObservations: control.length,
    pairedClusters,
    medianSaturation,
    medianQualityEffect,
    medianControlEffect,
    missedRelevantRecords,
    observationSha256s: valid.map((record) => record.observationSha256).sort()
  };
  const base = {
    ...policyPayload(previousPolicy),
    policyId: `${previousPolicy.scopeId}-e${previousPolicy.epoch + 1}`,
    epoch: previousPolicy.epoch + 1,
    allocatedInputTokens: nextAllocation,
    action,
    evidence,
    previousPolicySha256: previousPolicy.policySha256,
    createdAt
  };
  return {
    status: 'OK',
    policy: { ...base, policySha256: sha256(canonicalVNextJson(base)) }
  };
}
