import {
  validateAdaptiveMeasurementRecord
} from './adaptive-measurement-v2.mjs';
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import { validateMechanismEvolutionRecord } from './mechanism-evolution-records.mjs';
import {
  validateRecursiveReplicatedAnalysis
} from './adaptive-recursive-statistics.mjs';
import { round, sha256 } from './util.mjs';

export const MECHANISM_EVOLUTION_ADMISSION_V2 =
  'mechanism-evolution-admission-v2';
export const MECHANISM_EVOLUTION_ADMISSION_STATES = Object.freeze([
  'VERIFIED',
  'ACTIVE',
  'REJECTED'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const REASON_RE = /^[A-Z0-9][A-Z0-9_]{0,119}$/;

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

export function canonicalMechanismEvolutionAdmissionV2Json(value) {
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

function familyRef(value) {
  return exactKeys(value, [
    'familyId',
    'familySha256',
    'programSha256',
    'semanticSha256'
  ])
    && /^family-[a-f0-9]{24}$/.test(String(value.familyId || ''))
    && ['familySha256', 'programSha256', 'semanticSha256']
      .every((field) => validSha(value[field]))
    ? structuredClone(value)
    : null;
}

function sourceEvolutionRef(value) {
  return exactKeys(value, [
    'evolutionId',
    'evolutionReceiptId',
    'evolutionSha256',
    'state'
  ])
    && /^evolution-[a-f0-9]{24}$/.test(String(value.evolutionId || ''))
    && /^evolution-receipt-[a-f0-9]{24}$/.test(String(value.evolutionReceiptId || ''))
    && validSha(value.evolutionSha256)
    && value.state === 'SHADOW'
    ? structuredClone(value)
    : null;
}

function previousRef(value) {
  if (value == null) return null;
  return exactKeys(value, ['admissionReceiptId', 'admissionSha256', 'state'])
    && /^admission-receipt-[a-f0-9]{24}$/.test(String(value.admissionReceiptId || ''))
    && validSha(value.admissionSha256)
    && MECHANISM_EVOLUTION_ADMISSION_STATES.includes(value.state)
    ? structuredClone(value)
    : undefined;
}

function normalizeEvidence(value) {
  if (!exactKeys(value, [
    'activationEvidenceSha256',
    'calibrationAnalysisSha256',
    'calibrationMeasurementId',
    'calibrationMeasurementSha256',
    'confirmationAnalysisSha256',
    'confirmationMeasurementId',
    'confirmationMeasurementSha256',
    'rejectionEvidenceSha256',
    'verifierEvidenceSha256'
  ])) return null;
  const ids = ['calibrationMeasurementId', 'confirmationMeasurementId'];
  const hashes = [
    'calibrationAnalysisSha256',
    'calibrationMeasurementSha256',
    'confirmationAnalysisSha256',
    'confirmationMeasurementSha256',
    'verifierEvidenceSha256'
  ];
  if (!ids.every((field) => /^measurement-[a-f0-9]{24}$/.test(String(value[field] || '')))
      || !hashes.every((field) => validSha(value[field]))
      || ![value.activationEvidenceSha256, value.rejectionEvidenceSha256]
        .every((item) => item == null || validSha(item))) return null;
  return structuredClone(value);
}

function normalizeOutcome(value) {
  const fields = [
    'exactVsBaselineDelta',
    'exactVsParentDelta',
    'decisionVsParentDelta',
    'shamExactVsBaselineDelta',
    'candidateVsParentLower95',
    'placeboUpper95',
    'adjustedExactDelta',
    'adjustedTaskP',
    'targetRegressions',
    'controlRegressions',
    'candidateTokenDelta'
  ];
  if (!exactKeys(value, fields)
      || fields.slice(0, 8).some((field) => !Number.isFinite(value[field]))
      || !Number.isInteger(value.targetRegressions)
      || value.targetRegressions < 0
      || !Number.isInteger(value.controlRegressions)
      || value.controlRegressions < 0
      || !Number.isFinite(value.candidateTokenDelta)
      || value.adjustedTaskP < 0 || value.adjustedTaskP > 1) return null;
  return Object.fromEntries(fields.map((field) => [field, round(value[field], 8)]));
}

function admissionPasses(outcome) {
  return outcome.exactVsBaselineDelta > 0
    && outcome.exactVsParentDelta > 0
    && outcome.decisionVsParentDelta >= 0
    && outcome.candidateVsParentLower95 > outcome.placeboUpper95
    && outcome.placeboUpper95 >= 0
    && outcome.adjustedExactDelta > 0
    && outcome.adjustedTaskP <= 0.05
    && outcome.targetRegressions === 0
    && outcome.controlRegressions === 0
    && outcome.candidateTokenDelta <= 0.25;
}

function payload(record) {
  const copy = { ...record };
  delete copy.admissionReceiptId;
  delete copy.admissionSha256;
  return copy;
}

export function createMechanismEvolutionAdmissionV2(input = {}) {
  try {
    const state = MECHANISM_EVOLUTION_ADMISSION_STATES.includes(input.state)
      ? input.state
      : null;
    const previous = previousRef(input.previous);
    const sourceEvolution = sourceEvolutionRef(input.sourceEvolution);
    const parent = familyRef(input.parent);
    const candidate = familyRef(input.candidate);
    const evidence = normalizeEvidence(input.evidence);
    const outcome = normalizeOutcome(input.outcome);
    const recordedAt = typeof input.recordedAt === 'string'
      && Number.isFinite(Date.parse(input.recordedAt))
      ? input.recordedAt
      : null;
    const authority = exactKeys(input.authority, [
      'activation', 'promotionAuthorized', 'verification'
    ])
      && input.authority.verification === 'independent-replicated-verifier'
      && ['none', 'routing-only'].includes(input.authority.activation)
      && input.authority.promotionAuthorized === false
      ? structuredClone(input.authority)
      : null;
    const reasonCodes = Array.isArray(input.reasonCodes)
      ? [...new Set(input.reasonCodes.map((value) => String(value || '').trim().toUpperCase()))].sort()
      : [];
    if (!state || previous === undefined || !sourceEvolution || !parent || !candidate
        || !evidence || !outcome || !recordedAt || !authority
        || parent.familyId === candidate.familyId
        || parent.programSha256 === candidate.programSha256
        || reasonCodes.length > 20
        || reasonCodes.some((reason) => !REASON_RE.test(reason))) {
      return refused('INVALID_EVOLUTION_ADMISSION_V2', 'Replicated admission identity or evidence is invalid.');
    }
    const passed = admissionPasses(outcome);
    const stateValid = state === 'VERIFIED'
      ? previous == null
        && passed
        && evidence.activationEvidenceSha256 == null
        && evidence.rejectionEvidenceSha256 == null
        && authority.activation === 'none'
        && reasonCodes.length === 0
      : (state === 'ACTIVE'
          ? previous?.state === 'VERIFIED'
            && passed
            && evidence.activationEvidenceSha256 != null
            && evidence.rejectionEvidenceSha256 == null
            && authority.activation === 'routing-only'
            && reasonCodes.length === 0
          : previous == null
            && evidence.activationEvidenceSha256 == null
            && evidence.rejectionEvidenceSha256 != null
            && authority.activation === 'none'
            && reasonCodes.length > 0);
    if (!stateValid) {
      return refused('INVALID_EVOLUTION_ADMISSION_V2_STATE', 'Replicated admission state does not satisfy its fixed gates.');
    }
    const identity = {
      sourceEvolutionSha256: sourceEvolution.evolutionSha256,
      parentFamilyId: parent.familyId,
      candidateFamilyId: candidate.familyId,
      calibrationAnalysisSha256: evidence.calibrationAnalysisSha256,
      confirmationAnalysisSha256: evidence.confirmationAnalysisSha256
    };
    const admissionId = `admission-${sha256(
      canonicalMechanismEvolutionAdmissionV2Json(identity)
    ).slice(0, 24)}`;
    const base = {
      schemaVersion: MECHANISM_EVOLUTION_ADMISSION_V2,
      admissionId,
      state,
      recordedAt,
      previous,
      sourceEvolution,
      parent,
      candidate,
      evidence,
      outcome,
      authority,
      reasonCodes
    };
    const digest = sha256(canonicalMechanismEvolutionAdmissionV2Json(base));
    return ok({
      record: {
        ...base,
        admissionReceiptId: `admission-receipt-${digest.slice(0, 24)}`,
        admissionSha256: digest
      }
    });
  } catch (error) {
    return refused('EVOLUTION_ADMISSION_V2_BUILD_FAILED', error.message);
  }
}

export function validateMechanismEvolutionAdmissionV2(record) {
  try {
    if (!exactKeys(record, [
      'admissionId',
      'admissionReceiptId',
      'admissionSha256',
      'authority',
      'candidate',
      'evidence',
      'outcome',
      'parent',
      'previous',
      'reasonCodes',
      'recordedAt',
      'schemaVersion',
      'sourceEvolution',
      'state'
    ])
        || record.schemaVersion !== MECHANISM_EVOLUTION_ADMISSION_V2
        || !/^admission-[a-f0-9]{24}$/.test(String(record.admissionId || ''))
        || !/^admission-receipt-[a-f0-9]{24}$/.test(String(record.admissionReceiptId || ''))
        || !validSha(record.admissionSha256)) {
      return refused('INVALID_EVOLUTION_ADMISSION_V2', 'Replicated admission shape is invalid.');
    }
    const rebuilt = createMechanismEvolutionAdmissionV2(record);
    return rebuilt.status === 'OK'
      && canonicalMechanismEvolutionAdmissionV2Json(rebuilt.record)
        === canonicalMechanismEvolutionAdmissionV2Json(record)
      && record.admissionSha256 === sha256(
        canonicalMechanismEvolutionAdmissionV2Json(payload(record))
      )
      ? ok({ record: structuredClone(record) })
      : refused('INVALID_EVOLUTION_ADMISSION_V2', 'Replicated admission content or seal is invalid.');
  } catch (error) {
    return refused('INVALID_EVOLUTION_ADMISSION_V2', error.message);
  }
}

function familyReference(family, sourceRef) {
  return {
    familyId: family.familyId,
    familySha256: family.familySha256,
    programSha256: sourceRef.programSha256,
    semanticSha256: sourceRef.semanticSha256
  };
}

function outcomeFrom(confirmationMeasurement, calibrationAnalysis, confirmationAnalysis) {
  return {
    exactVsBaselineDelta:
      confirmationMeasurement.contrasts.treatmentVsBaseline.metrics.exact.delta,
    exactVsParentDelta:
      confirmationMeasurement.contrasts.treatmentVsParent.metrics.exact.delta,
    decisionVsParentDelta:
      confirmationMeasurement.contrasts.treatmentVsParent.metrics.decision.delta,
    shamExactVsBaselineDelta:
      confirmationMeasurement.contrasts.shamVsBaseline.metrics.exact.delta,
    candidateVsParentLower95:
      confirmationAnalysis.summary.candidateVsParent.lower95,
    placeboUpper95: calibrationAnalysis.placeboUpper95,
    adjustedExactDelta: confirmationAnalysis.summary.adjusted.mean,
    adjustedTaskP:
      confirmationAnalysis.summary.adjustedTaskSignTest.pOneSided,
    targetRegressions: confirmationAnalysis.summary.targetRegressions,
    controlRegressions: confirmationAnalysis.summary.controlRegressions,
    candidateTokenDelta:
      confirmationAnalysis.summary.tokenCost.candidateVsParentRelative
  };
}

export function verifyReplicatedMechanismEvolution({
  currentRecord,
  parentFamily,
  candidateFamily,
  calibrationMeasurement,
  confirmationMeasurement,
  calibrationAnalysis,
  confirmationAnalysis,
  verifierEvidenceSha256,
  recordedAt,
  companionGatePassed = true,
  companionFailureReason = 'COMPANION_GATE_FAILED'
} = {}) {
  try {
    if (validateMechanismEvolutionRecord(currentRecord).status !== 'OK'
        || currentRecord.state !== 'SHADOW'
        || validateAdaptiveRecord(parentFamily).status !== 'OK'
        || validateAdaptiveRecord(candidateFamily).status !== 'OK'
        || currentRecord.parent.familyId !== parentFamily.familyId
        || currentRecord.candidate.familyId !== candidateFamily.familyId
        || validateAdaptiveMeasurementRecord(calibrationMeasurement).status !== 'OK'
        || validateAdaptiveMeasurementRecord(confirmationMeasurement).status !== 'OK'
        || validateRecursiveReplicatedAnalysis(calibrationAnalysis).status !== 'OK'
        || validateRecursiveReplicatedAnalysis(confirmationAnalysis).status !== 'OK'
        || calibrationAnalysis.stage !== 'calibration'
        || calibrationAnalysis.qualified !== true
        || confirmationAnalysis.stage !== 'confirmation'
        || confirmationAnalysis.calibrationAnalysisSha256 !== calibrationAnalysis.analysisSha256
        || calibrationMeasurement.source.verifierEvidenceSha256 !== verifierEvidenceSha256
        || confirmationMeasurement.source.verifierEvidenceSha256 !== verifierEvidenceSha256
        || calibrationMeasurement.mechanismBindings.parent !== currentRecord.parent.programSha256
        || calibrationMeasurement.mechanismBindings.treatment !== currentRecord.candidate.programSha256
        || confirmationMeasurement.mechanismBindings.parent !== currentRecord.parent.programSha256
        || confirmationMeasurement.mechanismBindings.treatment !== currentRecord.candidate.programSha256
        || !validSha(verifierEvidenceSha256)
        || typeof companionGatePassed !== 'boolean'
        || !REASON_RE.test(String(companionFailureReason || ''))) {
      return refused(
        'REPLICATED_EVOLUTION_EVIDENCE_INVALID',
        'V2 verification must bind both measurements, both analyses, the shadow evolution, and verifier evidence.'
      );
    }
    const outcome = outcomeFrom(
      confirmationMeasurement,
      calibrationAnalysis,
      confirmationAnalysis
    );
    const replicatedPassed = confirmationAnalysis.causalPass === true
      && admissionPasses(outcome);
    const passed = replicatedPassed && companionGatePassed;
    return createMechanismEvolutionAdmissionV2({
      state: passed ? 'VERIFIED' : 'REJECTED',
      recordedAt,
      previous: null,
      sourceEvolution: {
        evolutionId: currentRecord.evolutionId,
        evolutionReceiptId: currentRecord.evolutionReceiptId,
        evolutionSha256: currentRecord.evolutionSha256,
        state: currentRecord.state
      },
      parent: familyReference(parentFamily, currentRecord.parent),
      candidate: familyReference(candidateFamily, currentRecord.candidate),
      evidence: {
        calibrationMeasurementId: calibrationMeasurement.measurementId,
        calibrationMeasurementSha256: calibrationMeasurement.measurementSha256,
        confirmationMeasurementId: confirmationMeasurement.measurementId,
        confirmationMeasurementSha256: confirmationMeasurement.measurementSha256,
        calibrationAnalysisSha256: calibrationAnalysis.analysisSha256,
        confirmationAnalysisSha256: confirmationAnalysis.analysisSha256,
        verifierEvidenceSha256,
        activationEvidenceSha256: null,
        rejectionEvidenceSha256: passed ? null : verifierEvidenceSha256
      },
      outcome,
      authority: {
        verification: 'independent-replicated-verifier',
        activation: 'none',
        promotionAuthorized: false
      },
      reasonCodes: passed
        ? []
        : [replicatedPassed
            ? companionFailureReason
            : 'REPLICATED_CAUSAL_GATES_FAILED']
    });
  } catch (error) {
    return refused('REPLICATED_EVOLUTION_VERIFICATION_FAILED', error.message);
  }
}

export function activateReplicatedMechanismEvolution({
  currentAdmission,
  activationEvidenceSha256,
  recordedAt
} = {}) {
  const checked = validateMechanismEvolutionAdmissionV2(currentAdmission);
  if (checked.status !== 'OK'
      || currentAdmission.state !== 'VERIFIED'
      || !validSha(activationEvidenceSha256)) {
    return refused(
      'REPLICATED_EVOLUTION_ACTIVATION_INVALID',
      'Only a valid V2 VERIFIED admission may become routing-active.'
    );
  }
  return createMechanismEvolutionAdmissionV2({
    ...currentAdmission,
    state: 'ACTIVE',
    recordedAt,
    previous: {
      admissionReceiptId: currentAdmission.admissionReceiptId,
      admissionSha256: currentAdmission.admissionSha256,
      state: currentAdmission.state
    },
    evidence: {
      ...currentAdmission.evidence,
      activationEvidenceSha256
    },
    authority: {
      ...currentAdmission.authority,
      activation: 'routing-only'
    }
  });
}
