import { isSafeId, round, sha256 } from './util.mjs';

export const CONTEXT_OBSERVATION_SCHEMA = 'context-saturation-observation-v1';
export const ADAPTIVE_CONTEXT_POLICY_SCHEMA = 'adaptive-context-policy-v1';
export const CONTEXT_POLICY_MIN_OBSERVATIONS = 5;

const SHA256_RE = /^[a-f0-9]{64}$/;
const ACTIONS = Object.freeze(['KEEP', 'EXPAND', 'NARROW']);

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => (
    [key, stableValue(value[key])]
  )));
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validSha(value) {
  return SHA256_RE.test(String(value || ''));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index];
}

function observationPayload(record) {
  const copy = structuredClone(record);
  delete copy.observationId;
  delete copy.observationSha256;
  return copy;
}

export function createContextSaturationObservation({
  scopeId,
  runId,
  generation,
  callId,
  allocatedInputTokens,
  requestedContextTokens,
  inputTokens,
  outputTokens,
  promptArtifactRef,
  promptArtifactSha256,
  receiptArtifactRef,
  receiptArtifactSha256,
  valid,
  measuredLift = null,
  recordedAt
} = {}) {
  try {
    if (!isSafeId(scopeId)
        || !isSafeId(runId)
        || !isSafeId(callId)
        || !Number.isInteger(generation)
        || generation < 0
        || !Number.isInteger(allocatedInputTokens)
        || allocatedInputTokens < 1
        || !Number.isInteger(requestedContextTokens)
        || requestedContextTokens < 0
        || !Number.isInteger(inputTokens)
        || inputTokens < 0
        || !Number.isInteger(outputTokens)
        || outputTokens < 0
        || !isSafeId(promptArtifactRef)
        || !validSha(promptArtifactSha256)
        || !isSafeId(receiptArtifactRef)
        || !validSha(receiptArtifactSha256)
        || typeof valid !== 'boolean'
        || (measuredLift != null && !Number.isFinite(measuredLift))
        || typeof recordedAt !== 'string'
        || !Number.isFinite(Date.parse(recordedAt))) {
      return refused(
        'CONTEXT_OBSERVATION_INVALID',
        'Context telemetry must bind one persisted prompt, one receipt, and explicit token allocation.'
      );
    }
    const payload = {
      schemaVersion: CONTEXT_OBSERVATION_SCHEMA,
      scopeId,
      runId,
      generation,
      callId,
      allocatedInputTokens,
      requestedContextTokens,
      inputTokens,
      outputTokens,
      saturationRatio: round(inputTokens / allocatedInputTokens, 8),
      contextPressureRatio: round(requestedContextTokens / allocatedInputTokens, 8),
      promptArtifactRef,
      promptArtifactSha256,
      receiptArtifactRef,
      receiptArtifactSha256,
      valid,
      measuredLift: measuredLift == null ? null : round(measuredLift, 8),
      recordedAt
    };
    const observationId = `context-observation-${sha256(canonical(payload)).slice(0, 24)}`;
    const record = {
      ...payload,
      observationId,
      observationSha256: sha256(canonical({ ...payload, observationId }))
    };
    return ok({ record });
  } catch (error) {
    return refused('CONTEXT_OBSERVATION_FAILED', error.message);
  }
}

export function validateContextSaturationObservation(record) {
  if (!exactKeys(record, [
    'allocatedInputTokens',
    'callId',
    'contextPressureRatio',
    'generation',
    'inputTokens',
    'measuredLift',
    'observationId',
    'observationSha256',
    'outputTokens',
    'promptArtifactRef',
    'promptArtifactSha256',
    'receiptArtifactRef',
    'receiptArtifactSha256',
    'recordedAt',
    'requestedContextTokens',
    'runId',
    'saturationRatio',
    'schemaVersion',
    'scopeId',
    'valid'
  ])
      || record.schemaVersion !== CONTEXT_OBSERVATION_SCHEMA
      || !/^context-observation-[a-f0-9]{24}$/.test(String(record.observationId || ''))
      || !validSha(record.observationSha256)) {
    return refused('CONTEXT_OBSERVATION_INVALID', 'Context observation shape is invalid.');
  }
  const rebuilt = createContextSaturationObservation(record);
  return rebuilt.status === 'OK'
    && rebuilt.record.observationId === record.observationId
    && rebuilt.record.observationSha256 === record.observationSha256
    ? ok({ record: structuredClone(record) })
    : refused('CONTEXT_OBSERVATION_HASH_MISMATCH', 'Context observation does not replay.');
}

function policyPayload(record) {
  const copy = structuredClone(record);
  delete copy.policyId;
  delete copy.policySha256;
  return copy;
}

function buildPolicy(input) {
  const payload = {
    schemaVersion: ADAPTIVE_CONTEXT_POLICY_SCHEMA,
    scopeId: input.scopeId,
    epoch: input.epoch,
    previousPolicySha256: input.previousPolicySha256,
    bounds: input.bounds,
    allocatedInputTokens: input.allocatedInputTokens,
    action: input.action,
    reasonCodes: input.reasonCodes,
    evidence: input.evidence,
    compaction: input.compaction,
    permanentControlFraction: input.permanentControlFraction,
    recordedAt: input.recordedAt
  };
  const policyId = `context-policy-${sha256(canonical(payload)).slice(0, 24)}`;
  return {
    ...payload,
    policyId,
    policySha256: sha256(canonical({ ...payload, policyId }))
  };
}

export function createInitialAdaptiveContextPolicy({
  scopeId,
  minInputTokens,
  initialInputTokens,
  maxInputTokens,
  permanentControlFraction,
  recordedAt
} = {}) {
  if (!isSafeId(scopeId)
      || !Number.isInteger(minInputTokens)
      || !Number.isInteger(initialInputTokens)
      || !Number.isInteger(maxInputTokens)
      || minInputTokens < 1
      || minInputTokens > initialInputTokens
      || initialInputTokens > maxInputTokens
      || !Number.isFinite(permanentControlFraction)
      || permanentControlFraction <= 0
      || permanentControlFraction >= 1
      || typeof recordedAt !== 'string'
      || !Number.isFinite(Date.parse(recordedAt))) {
    return refused('CONTEXT_POLICY_INITIAL_INVALID', 'Initial context bounds are invalid.');
  }
  return ok({
    record: buildPolicy({
      scopeId,
      epoch: 1,
      previousPolicySha256: null,
      bounds: {
        minInputTokens,
        maxInputTokens,
        maximumStepFraction: 0.1
      },
      allocatedInputTokens: initialInputTokens,
      action: 'KEEP',
      reasonCodes: ['INITIAL_EXPLICIT_ALLOCATION'],
      evidence: {
        observationCount: 0,
        observationSetSha256: sha256(canonical([])),
        medianSaturation: null,
        p75Saturation: null,
        medianLift: null,
        regressions: 0
      },
      compaction: {
        projectionEligible: false,
        mode: 'FULL_RECORDS',
        contentDeletionAuthorized: false
      },
      permanentControlFraction: round(permanentControlFraction, 8),
      recordedAt
    })
  });
}

export function validateAdaptiveContextPolicy(record) {
  if (!exactKeys(record, [
    'action',
    'allocatedInputTokens',
    'bounds',
    'compaction',
    'epoch',
    'evidence',
    'permanentControlFraction',
    'policyId',
    'policySha256',
    'previousPolicySha256',
    'reasonCodes',
    'recordedAt',
    'schemaVersion',
    'scopeId'
  ])
      || record.schemaVersion !== ADAPTIVE_CONTEXT_POLICY_SCHEMA
      || !isSafeId(record.scopeId)
      || !/^context-policy-[a-f0-9]{24}$/.test(String(record.policyId || ''))
      || !validSha(record.policySha256)
      || !Number.isInteger(record.epoch)
      || record.epoch < 1
      || (record.previousPolicySha256 != null && !validSha(record.previousPolicySha256))
      || !exactKeys(record.bounds, [
        'maximumStepFraction', 'maxInputTokens', 'minInputTokens'
      ])
      || !Number.isInteger(record.bounds.minInputTokens)
      || !Number.isInteger(record.bounds.maxInputTokens)
      || record.bounds.minInputTokens < 1
      || record.bounds.minInputTokens > record.bounds.maxInputTokens
      || record.bounds.maximumStepFraction !== 0.1
      || !Number.isInteger(record.allocatedInputTokens)
      || record.allocatedInputTokens < record.bounds.minInputTokens
      || record.allocatedInputTokens > record.bounds.maxInputTokens
      || !ACTIONS.includes(record.action)
      || !Array.isArray(record.reasonCodes)
      || !record.reasonCodes.length
      || !exactKeys(record.evidence, [
        'medianLift',
        'medianSaturation',
        'observationCount',
        'observationSetSha256',
        'p75Saturation',
        'regressions'
      ])
      || !Number.isInteger(record.evidence.observationCount)
      || record.evidence.observationCount < 0
      || !validSha(record.evidence.observationSetSha256)
      || !exactKeys(record.compaction, [
        'contentDeletionAuthorized', 'mode', 'projectionEligible'
      ])
      || record.compaction.contentDeletionAuthorized !== false
      || !['FULL_RECORDS', 'LOSSLESS_INDEX'].includes(record.compaction.mode)
      || typeof record.compaction.projectionEligible !== 'boolean'
      || !Number.isFinite(record.permanentControlFraction)
      || record.permanentControlFraction <= 0
      || record.permanentControlFraction >= 1
      || typeof record.recordedAt !== 'string'
      || !Number.isFinite(Date.parse(record.recordedAt))) {
    return refused('CONTEXT_POLICY_INVALID', 'Adaptive context policy shape is invalid.');
  }
  const rebuilt = buildPolicy(policyPayload(record));
  return rebuilt.policyId === record.policyId
    && rebuilt.policySha256 === record.policySha256
    ? ok({ record: structuredClone(record) })
    : refused('CONTEXT_POLICY_HASH_MISMATCH', 'Adaptive context policy does not replay.');
}

export function deriveAdaptiveContextPolicy({
  previousPolicy,
  observations,
  recordedAt
} = {}) {
  const checked = validateAdaptiveContextPolicy(previousPolicy);
  if (checked.status !== 'OK') return checked;
  const rows = Array.isArray(observations)
    ? observations.map((observation) => validateContextSaturationObservation(observation))
    : [];
  if (rows.some((row) => row.status !== 'OK')) {
    return refused('CONTEXT_POLICY_EVIDENCE_INVALID', 'One or more context observations are invalid.');
  }
  const valid = rows.map((row) => row.record)
    .filter((observation) => (
      observation.valid === true
      && observation.scopeId === previousPolicy.scopeId
    ))
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (valid.length < CONTEXT_POLICY_MIN_OBSERVATIONS) {
    return refused(
      'CONTEXT_POLICY_INSUFFICIENT_EVIDENCE',
      `At least ${CONTEXT_POLICY_MIN_OBSERVATIONS} valid observations are required.`
    );
  }
  const saturations = valid.map((observation) => observation.saturationRatio);
  const lifts = valid
    .map((observation) => observation.measuredLift)
    .filter(Number.isFinite);
  const medianSaturation = median(saturations);
  const p75Saturation = percentile(saturations, 0.75);
  const medianLift = lifts.length ? median(lifts) : null;
  const regressions = lifts.filter((lift) => lift < 0).length;
  const positiveLift = lifts.length >= 3 && medianLift > 0 && regressions === 0;
  let action = 'KEEP';
  let reasonCodes = ['CONTEXT_ALLOCATION_STABLE'];
  let allocatedInputTokens = previousPolicy.allocatedInputTokens;
  let projectionEligible = false;
  if (p75Saturation >= 0.85 && !positiveLift) {
    action = 'NARROW';
    allocatedInputTokens = Math.max(
      previousPolicy.bounds.minInputTokens,
      Math.floor(previousPolicy.allocatedInputTokens * 0.9)
    );
    projectionEligible = true;
    reasonCodes = ['MEASURED_CONTEXT_SATURATION', 'NO_REPLICATED_LIFT'];
  } else if (medianSaturation <= 0.45 && positiveLift) {
    action = 'EXPAND';
    allocatedInputTokens = Math.min(
      previousPolicy.bounds.maxInputTokens,
      Math.ceil(previousPolicy.allocatedInputTokens * 1.1)
    );
    reasonCodes = ['MEASURED_CONTEXT_HEADROOM', 'REPLICATED_POSITIVE_LIFT'];
  } else if (p75Saturation >= 0.85 && positiveLift) {
    reasonCodes = ['HIGH_CONTEXT_USE_RETAINED_BY_POSITIVE_LIFT'];
  } else if (!lifts.length) {
    reasonCodes = ['LIFT_UNMEASURED_KEEP_ALLOCATION'];
  }
  const observationSetSha256 = sha256(canonical(valid.map((observation) => ({
    observationId: observation.observationId,
    observationSha256: observation.observationSha256
  }))));
  const record = buildPolicy({
    scopeId: previousPolicy.scopeId,
    epoch: previousPolicy.epoch + 1,
    previousPolicySha256: previousPolicy.policySha256,
    bounds: structuredClone(previousPolicy.bounds),
    allocatedInputTokens,
    action,
    reasonCodes,
    evidence: {
      observationCount: valid.length,
      observationSetSha256,
      medianSaturation: round(medianSaturation, 8),
      p75Saturation: round(p75Saturation, 8),
      medianLift: medianLift == null ? null : round(medianLift, 8),
      regressions
    },
    compaction: {
      projectionEligible,
      mode: projectionEligible ? 'LOSSLESS_INDEX' : 'FULL_RECORDS',
      contentDeletionAuthorized: false
    },
    permanentControlFraction: previousPolicy.permanentControlFraction,
    recordedAt
  });
  return validateAdaptiveContextPolicy(record).status === 'OK'
    ? ok({ record })
    : refused('CONTEXT_POLICY_BUILD_FAILED', 'Derived context policy did not validate.');
}
