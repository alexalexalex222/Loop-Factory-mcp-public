import { validateMechanismMutationPlan } from './mechanism-mutation.mjs';
import { isSafeId, round, sha256 } from './util.mjs';

export const MECHANISM_EVOLUTION_SCHEMA_VERSION = 'mechanism-evolution-v1';
export const MECHANISM_EVOLUTION_STATES = Object.freeze([
  'PROPOSED',
  'SHADOW',
  'VERIFIED',
  'ACTIVE',
  'REJECTED'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const REASON_RE = /^[A-Z0-9][A-Z0-9_]{0,119}$/;
const TRANSITIONS = Object.freeze({
  PROPOSED: new Set(['SHADOW', 'REJECTED']),
  SHADOW: new Set(['VERIFIED', 'REJECTED']),
  VERIFIED: new Set(['ACTIVE', 'REJECTED']),
  ACTIVE: new Set(),
  REJECTED: new Set()
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])])
  );
}

export function canonicalMechanismEvolutionJson(value) {
  return JSON.stringify(stableValue(value));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function validSha(value) {
  return SHA256_RE.test(String(value || ''));
}

function nullableSha(value) {
  return value == null ? null : (validSha(value) ? String(value) : undefined);
}

function nullableFinite(value) {
  return value == null ? null : (Number.isFinite(value) ? round(value) : undefined);
}

function nullableInteger(value) {
  return value == null ? null : (Number.isInteger(value) && value >= 0 ? value : undefined);
}

function familyRef(value) {
  if (!exactKeys(value, [
    'familyId',
    'familySha256',
    'programSha256',
    'semanticSha256'
  ])
      || !/^family-[a-f0-9]{24}$/.test(String(value.familyId || ''))
      || !validSha(value.familySha256)
      || !validSha(value.programSha256)
      || !validSha(value.semanticSha256)) return null;
  return {
    familyId: String(value.familyId),
    familySha256: String(value.familySha256),
    programSha256: String(value.programSha256),
    semanticSha256: String(value.semanticSha256)
  };
}

function previousRef(value) {
  if (value == null) return null;
  if (!exactKeys(value, ['evolutionReceiptId', 'evolutionSha256', 'state'])
      || !/^evolution-receipt-[a-f0-9]{24}$/.test(String(value.evolutionReceiptId || ''))
      || !validSha(value.evolutionSha256)
      || !MECHANISM_EVOLUTION_STATES.includes(value.state)) return undefined;
  return {
    evolutionReceiptId: String(value.evolutionReceiptId),
    evolutionSha256: String(value.evolutionSha256),
    state: value.state
  };
}

function evidence(value) {
  if (!exactKeys(value, [
    'activationEvidenceSha256',
    'rejectionEvidenceSha256',
    'sourceMeasurementId',
    'sourceMeasurementSha256',
    'treatmentDeltaSha256',
    'verificationMeasurementId',
    'verificationMeasurementSha256',
    'verifierEvidenceSha256'
  ])) return null;
  const sourceMeasurementId = /^measurement-[a-f0-9]{24}$/.test(
    String(value.sourceMeasurementId || '')
  ) ? String(value.sourceMeasurementId) : null;
  const verificationMeasurementId = value.verificationMeasurementId == null
    ? null
    : (/^measurement-[a-f0-9]{24}$/.test(String(value.verificationMeasurementId))
        ? String(value.verificationMeasurementId)
        : undefined);
  const normalized = {
    sourceMeasurementId,
    sourceMeasurementSha256: nullableSha(value.sourceMeasurementSha256),
    treatmentDeltaSha256: nullableSha(value.treatmentDeltaSha256),
    verificationMeasurementId,
    verificationMeasurementSha256: nullableSha(value.verificationMeasurementSha256),
    verifierEvidenceSha256: nullableSha(value.verifierEvidenceSha256),
    activationEvidenceSha256: nullableSha(value.activationEvidenceSha256),
    rejectionEvidenceSha256: nullableSha(value.rejectionEvidenceSha256)
  };
  return sourceMeasurementId
    && normalized.sourceMeasurementSha256
    && !Object.values(normalized).includes(undefined)
    ? normalized
    : null;
}

function outcome(value) {
  if (!exactKeys(value, [
    'controlRegressions',
    'decisionVsParentDelta',
    'exactVsBaselineDelta',
    'exactVsParentDelta',
    'shamExactVsBaselineDelta',
    'targetRegressions'
  ])) return null;
  const normalized = {
    exactVsBaselineDelta: nullableFinite(value.exactVsBaselineDelta),
    exactVsParentDelta: nullableFinite(value.exactVsParentDelta),
    decisionVsParentDelta: nullableFinite(value.decisionVsParentDelta),
    shamExactVsBaselineDelta: nullableFinite(value.shamExactVsBaselineDelta),
    targetRegressions: nullableInteger(value.targetRegressions),
    controlRegressions: nullableInteger(value.controlRegressions)
  };
  return Object.values(normalized).includes(undefined) ? null : normalized;
}

function authority(value) {
  if (!exactKeys(value, [
    'activation',
    'mutation',
    'promotionAuthorized',
    'verification'
  ])
      || value.mutation !== 'bounded-tool'
      || ![null, 'independent-verifier'].includes(value.verification)
      || !['none', 'routing-only'].includes(value.activation)
      || value.promotionAuthorized !== false) return null;
  return {
    mutation: 'bounded-tool',
    verification: value.verification,
    activation: value.activation,
    promotionAuthorized: false
  };
}

function semanticDelta(value, mutationPlan) {
  if (!exactKeys(value, [
    'candidateSemanticSha256',
    'changedComponents',
    'operationCount',
    'parentSemanticSha256',
    'sourceSemanticDelta'
  ])
      || value.sourceSemanticDelta !== true
      || !validSha(value.parentSemanticSha256)
      || !validSha(value.candidateSemanticSha256)
      || value.parentSemanticSha256 === value.candidateSemanticSha256
      || !Number.isInteger(value.operationCount)
      || value.operationCount !== mutationPlan.operations.length
      || !Array.isArray(value.changedComponents)
      || value.changedComponents.length < 1) return null;
  const expected = [...new Set(mutationPlan.operations.map((item) => item.collection))].sort();
  const changedComponents = [...value.changedComponents].map(String).sort();
  return canonicalMechanismEvolutionJson(expected) === canonicalMechanismEvolutionJson(changedComponents)
    ? {
        sourceSemanticDelta: true,
        parentSemanticSha256: String(value.parentSemanticSha256),
        candidateSemanticSha256: String(value.candidateSemanticSha256),
        operationCount: value.operationCount,
        changedComponents
      }
    : null;
}

function stateContractValid({ state, previous, evidence: proof, outcome: result, authority: owner, reasonCodes }) {
  const allOutcomeNull = Object.values(result).every((value) => value == null);
  if (state === 'PROPOSED') {
    return previous == null
      && proof.treatmentDeltaSha256 == null
      && proof.verificationMeasurementId == null
      && proof.verificationMeasurementSha256 == null
      && proof.verifierEvidenceSha256 == null
      && proof.activationEvidenceSha256 == null
      && proof.rejectionEvidenceSha256 == null
      && allOutcomeNull
      && owner.verification == null
      && owner.activation === 'none'
      && reasonCodes.length === 0;
  }
  if (!previous || !TRANSITIONS[previous.state]?.has(state)) return false;
  if (state === 'SHADOW') {
    return proof.treatmentDeltaSha256 != null
      && proof.verificationMeasurementId == null
      && proof.verificationMeasurementSha256 == null
      && proof.verifierEvidenceSha256 == null
      && proof.activationEvidenceSha256 == null
      && proof.rejectionEvidenceSha256 == null
      && allOutcomeNull
      && owner.verification == null
      && owner.activation === 'none'
      && reasonCodes.length === 0;
  }
  if (state === 'VERIFIED' || state === 'ACTIVE') {
    const verified = proof.treatmentDeltaSha256 != null
      && proof.verificationMeasurementId != null
      && proof.verificationMeasurementSha256 != null
      && proof.verifierEvidenceSha256 != null
      && proof.rejectionEvidenceSha256 == null
      && result.exactVsBaselineDelta > 0
      && result.exactVsParentDelta > 0
      && result.decisionVsParentDelta >= 0
      && result.shamExactVsBaselineDelta === 0
      && result.targetRegressions === 0
      && result.controlRegressions === 0
      && owner.verification === 'independent-verifier'
      && reasonCodes.length === 0;
    return verified && (state === 'VERIFIED'
      ? proof.activationEvidenceSha256 == null && owner.activation === 'none'
      : proof.activationEvidenceSha256 != null && owner.activation === 'routing-only');
  }
  return state === 'REJECTED'
    && proof.rejectionEvidenceSha256 != null
    && proof.activationEvidenceSha256 == null
    && owner.activation === 'none'
    && reasonCodes.length > 0;
}

function recordPayload(record) {
  const payload = { ...record };
  delete payload.evolutionReceiptId;
  delete payload.evolutionSha256;
  return payload;
}

export function createMechanismEvolutionRecord(input = {}) {
  try {
    const parent = familyRef(input.parent);
    const candidate = familyRef(input.candidate);
    const mutation = validateMechanismMutationPlan(input.mutationPlan);
    const previous = previousRef(input.previous);
    const proof = evidence(input.evidence);
    const result = outcome(input.outcome);
    const owner = authority(input.authority);
    const recordedAt = typeof input.recordedAt === 'string'
      && Number.isFinite(Date.parse(input.recordedAt))
      ? input.recordedAt
      : null;
    const reasonCodes = Array.isArray(input.reasonCodes)
      ? [...new Set(input.reasonCodes.map((value) => String(value || '').trim().toUpperCase()))].sort()
      : [];
    const state = MECHANISM_EVOLUTION_STATES.includes(input.state) ? input.state : null;
    if (!parent || !candidate || mutation.status !== 'OK'
        || previous === undefined || !proof || !result || !owner || !recordedAt || !state
        || reasonCodes.some((value) => !REASON_RE.test(value))
        || reasonCodes.length > 20
        || parent.familyId !== mutation.plan.parent.familyId
        || parent.familySha256 !== mutation.plan.parent.familySha256
        || parent.programSha256 !== mutation.plan.parent.programSha256
        || parent.familyId === candidate.familyId
        || parent.programSha256 === candidate.programSha256) {
      return refused('INVALID_MECHANISM_EVOLUTION', 'Evolution identity or immutable lineage is invalid.');
    }
    const delta = semanticDelta(input.semanticDelta, mutation.plan);
    if (!delta
        || delta.parentSemanticSha256 !== parent.semanticSha256
        || delta.candidateSemanticSha256 !== candidate.semanticSha256
        || proof.sourceMeasurementId !== mutation.plan.objective.measurementId
        || proof.sourceMeasurementSha256 !== mutation.plan.objective.measurementSha256
        || !stateContractValid({
          state,
          previous,
          evidence: proof,
          outcome: result,
          authority: owner,
          reasonCodes
        })) {
      return refused('INVALID_MECHANISM_EVOLUTION_STATE', 'Evolution state lacks its required evidence or gate outcome.');
    }
    const identity = {
      parentFamilyId: parent.familyId,
      candidateFamilyId: candidate.familyId,
      mutationPlanSha256: mutation.plan.mutationPlanSha256
    };
    const evolutionId = `evolution-${sha256(
      canonicalMechanismEvolutionJson(identity)
    ).slice(0, 24)}`;
    const payload = {
      schemaVersion: MECHANISM_EVOLUTION_SCHEMA_VERSION,
      evolutionId,
      state,
      recordedAt,
      previous,
      parent,
      candidate,
      mutationPlan: mutation.plan,
      semanticDelta: delta,
      evidence: proof,
      outcome: result,
      authority: owner,
      reasonCodes
    };
    const digest = sha256(canonicalMechanismEvolutionJson(payload));
    return ok({
      record: {
        ...payload,
        evolutionReceiptId: `evolution-receipt-${digest.slice(0, 24)}`,
        evolutionSha256: digest
      }
    });
  } catch (error) {
    return refused('MECHANISM_EVOLUTION_BUILD_FAILED', error.message);
  }
}

export function validateMechanismEvolutionRecord(record) {
  try {
    if (!exactKeys(record, [
      'authority',
      'candidate',
      'evidence',
      'evolutionId',
      'evolutionReceiptId',
      'evolutionSha256',
      'mutationPlan',
      'outcome',
      'parent',
      'previous',
      'reasonCodes',
      'recordedAt',
      'schemaVersion',
      'semanticDelta',
      'state'
    ])
        || record.schemaVersion !== MECHANISM_EVOLUTION_SCHEMA_VERSION
        || !/^evolution-[a-f0-9]{24}$/.test(String(record.evolutionId || ''))
        || !/^evolution-receipt-[a-f0-9]{24}$/.test(String(record.evolutionReceiptId || ''))
        || !validSha(record.evolutionSha256)) {
      return refused('INVALID_MECHANISM_EVOLUTION', 'Evolution record shape is invalid.');
    }
    const rebuilt = createMechanismEvolutionRecord(record);
    return rebuilt.status === 'OK'
      && canonicalMechanismEvolutionJson(rebuilt.record)
        === canonicalMechanismEvolutionJson(record)
      && record.evolutionSha256 === sha256(canonicalMechanismEvolutionJson(
        recordPayload(record)
      ))
      ? ok({ schemaVersion: record.schemaVersion })
      : refused('INVALID_MECHANISM_EVOLUTION', 'Evolution record content or seal is invalid.');
  } catch (error) {
    return refused('INVALID_MECHANISM_EVOLUTION', error.message);
  }
}

export function selectLatestMechanismEvolutionRecords(records = []) {
  try {
    const unique = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (validateMechanismEvolutionRecord(record).status !== 'OK') {
        return refused('INVALID_MECHANISM_EVOLUTION_CHAIN', 'Evolution chain contains an invalid record.');
      }
      const existing = unique.get(record.evolutionReceiptId);
      if (existing && existing.evolutionSha256 !== record.evolutionSha256) {
        return refused('CONFLICTING_MECHANISM_EVOLUTION_RECEIPT', 'Evolution receipt ID has conflicting bytes.');
      }
      unique.set(record.evolutionReceiptId, record);
    }
    const groups = new Map();
    for (const record of unique.values()) {
      if (!groups.has(record.evolutionId)) groups.set(record.evolutionId, []);
      groups.get(record.evolutionId).push(record);
    }
    const latest = [];
    for (const [evolutionId, group] of groups) {
      const roots = group.filter((record) => record.previous == null);
      if (roots.length !== 1 || roots[0].state !== 'PROPOSED') {
        return refused('INVALID_MECHANISM_EVOLUTION_CHAIN', `Evolution ${evolutionId} needs one proposal root.`);
      }
      const byReceipt = new Map(group.map((record) => [record.evolutionReceiptId, record]));
      const childByParent = new Map();
      for (const record of group.filter((item) => item.previous != null)) {
        const parent = byReceipt.get(record.previous.evolutionReceiptId);
        if (!parent
            || parent.evolutionSha256 !== record.previous.evolutionSha256
            || parent.state !== record.previous.state
            || !TRANSITIONS[parent.state]?.has(record.state)
            || childByParent.has(parent.evolutionReceiptId)) {
          return refused('INVALID_MECHANISM_EVOLUTION_CHAIN', `Evolution ${evolutionId} is stale, forked, or out of order.`);
        }
        childByParent.set(parent.evolutionReceiptId, record.evolutionReceiptId);
      }
      const leaves = group.filter((record) => !childByParent.has(record.evolutionReceiptId));
      if (leaves.length !== 1) {
        return refused('INVALID_MECHANISM_EVOLUTION_CHAIN', `Evolution ${evolutionId} does not have one latest state.`);
      }
      latest.push(leaves[0]);
    }
    latest.sort((left, right) => left.evolutionId.localeCompare(right.evolutionId));
    return ok({ records: latest });
  } catch (error) {
    return refused('INVALID_MECHANISM_EVOLUTION_CHAIN', error.message);
  }
}
