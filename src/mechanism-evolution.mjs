import { validateAdaptiveMeasurementRecord } from './adaptive-measurement-v2.mjs';
import {
  createMechanismFamilyRecord,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import {
  createMechanismEvolutionRecord,
  validateMechanismEvolutionRecord
} from './mechanism-evolution-records.mjs';
import {
  applyMechanismMutationPlan,
  compareCompiledMechanismTreatments,
  compareMechanismProgramSemantics
} from './mechanism-mutation.mjs';

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function nullOutcome() {
  return {
    exactVsBaselineDelta: null,
    exactVsParentDelta: null,
    decisionVsParentDelta: null,
    shamExactVsBaselineDelta: null,
    targetRegressions: null,
    controlRegressions: null
  };
}

function previous(record) {
  return {
    evolutionReceiptId: record.evolutionReceiptId,
    evolutionSha256: record.evolutionSha256,
    state: record.state
  };
}

function familyRef(family, semanticSha256) {
  return {
    familyId: family.familyId,
    familySha256: family.familySha256,
    programSha256: family.causalFingerprint.program
      ? compareMechanismProgramSemantics(
          family.causalFingerprint.program,
          family.causalFingerprint.program
        ).comparison.leftProgramSha256
      : null,
    semanticSha256
  };
}

function validateFamilyPair(record, parentFamily, candidateFamily) {
  if (validateMechanismEvolutionRecord(record).status !== 'OK'
      || validateAdaptiveRecord(parentFamily).status !== 'OK'
      || validateAdaptiveRecord(candidateFamily).status !== 'OK'
      || !parentFamily.causalFingerprint?.program
      || !candidateFamily.causalFingerprint?.program
      || record.parent.familyId !== parentFamily.familyId
      || record.parent.familySha256 !== parentFamily.familySha256
      || record.candidate.familyId !== candidateFamily.familyId
      || record.candidate.familySha256 !== candidateFamily.familySha256) {
    return refused(
      'EVOLUTION_FAMILY_BINDING_INVALID',
      'Evolution state does not bind the supplied parent and candidate families.'
    );
  }
  const comparison = compareMechanismProgramSemantics(
    parentFamily.causalFingerprint.program,
    candidateFamily.causalFingerprint.program
  );
  if (comparison.status !== 'OK'
      || comparison.comparison.leftProgramSha256 !== record.parent.programSha256
      || comparison.comparison.rightProgramSha256 !== record.candidate.programSha256
      || comparison.comparison.leftSemanticSha256 !== record.parent.semanticSha256
      || comparison.comparison.rightSemanticSha256 !== record.candidate.semanticSha256
      || comparison.comparison.semanticDelta !== true) {
    return refused(
      'EVOLUTION_SEMANTIC_BINDING_INVALID',
      'Evolution state does not bind a real parent-to-candidate semantic delta.'
    );
  }
  return ok({ comparison: comparison.comparison });
}

export function proposeMechanismEvolution({
  parentFamily,
  mutationPlan,
  recordedAt
} = {}) {
  try {
    if (validateAdaptiveRecord(parentFamily).status !== 'OK'
        || !parentFamily.causalFingerprint?.program) {
      return refused(
        'EVOLUTION_PARENT_INVALID',
        'A bounded evolution proposal requires one valid executable parent family.'
      );
    }
    const applied = applyMechanismMutationPlan({
      plan: mutationPlan,
      parentProgram: parentFamily.causalFingerprint.program
    });
    if (applied.status !== 'OK') return applied;
    if (mutationPlan.parent.familyId !== parentFamily.familyId
        || mutationPlan.parent.familySha256 !== parentFamily.familySha256) {
      return refused(
        'EVOLUTION_PARENT_INVALID',
        'The mutation plan family binding does not match the supplied parent.'
      );
    }
    const candidateBuilt = createMechanismFamilyRecord({
      causalFingerprint: {
        ...parentFamily.causalFingerprint,
        program: applied.candidateProgram
      }
    });
    if (candidateBuilt.status !== 'OK') return candidateBuilt;
    const candidateFamily = candidateBuilt.record;
    const built = createMechanismEvolutionRecord({
      state: 'PROPOSED',
      recordedAt,
      previous: null,
      parent: familyRef(parentFamily, applied.parentSemanticSha256),
      candidate: familyRef(candidateFamily, applied.candidateSemanticSha256),
      mutationPlan,
      semanticDelta: {
        sourceSemanticDelta: true,
        parentSemanticSha256: applied.parentSemanticSha256,
        candidateSemanticSha256: applied.candidateSemanticSha256,
        operationCount: mutationPlan.operations.length,
        changedComponents: applied.changedComponents
      },
      evidence: {
        sourceMeasurementId: mutationPlan.objective.measurementId,
        sourceMeasurementSha256: mutationPlan.objective.measurementSha256,
        treatmentDeltaSha256: null,
        verificationMeasurementId: null,
        verificationMeasurementSha256: null,
        verifierEvidenceSha256: null,
        activationEvidenceSha256: null,
        rejectionEvidenceSha256: null
      },
      outcome: nullOutcome(),
      authority: {
        mutation: 'bounded-tool',
        verification: null,
        activation: 'none',
        promotionAuthorized: false
      },
      reasonCodes: []
    });
    return built.status === 'OK'
      ? ok({
          parentFamily,
          candidateFamily,
          mutationPlan,
          mutation: applied,
          record: built.record
        })
      : built;
  } catch (error) {
    return refused('EVOLUTION_PROPOSAL_FAILED', error.message);
  }
}

export function advanceMechanismEvolutionToShadow({
  currentRecord,
  parentFamily,
  candidateFamily,
  interfaceContracts,
  recordedAt
} = {}) {
  try {
    const pair = validateFamilyPair(currentRecord, parentFamily, candidateFamily);
    if (pair.status !== 'OK') return pair;
    if (currentRecord.state !== 'PROPOSED') {
      return refused('EVOLUTION_TRANSITION_INVALID', 'Only a proposal may enter shadow evaluation.');
    }
    const compared = compareCompiledMechanismTreatments({
      parentProgram: parentFamily.causalFingerprint.program,
      candidateProgram: candidateFamily.causalFingerprint.program,
      interfaceContracts
    });
    if (compared.status !== 'OK') return compared;
    if (compared.treatmentDelta.identifiable !== true) {
      return refused(
        'NO_MODEL_VISIBLE_TREATMENT_DELTA',
        'The candidate does not change any frozen model-visible treatment.',
        { treatmentDelta: compared.treatmentDelta }
      );
    }
    const built = createMechanismEvolutionRecord({
      ...currentRecord,
      state: 'SHADOW',
      recordedAt,
      previous: previous(currentRecord),
      evidence: {
        ...currentRecord.evidence,
        treatmentDeltaSha256: compared.treatmentDelta.treatmentDeltaSha256
      }
    });
    return built.status === 'OK'
      ? ok({ record: built.record, treatmentDelta: compared.treatmentDelta })
      : built;
  } catch (error) {
    return refused('EVOLUTION_SHADOW_TRANSITION_FAILED', error.message);
  }
}

export function verifyMechanismEvolution({
  currentRecord,
  parentFamily,
  candidateFamily,
  measurementRecord,
  verifierEvidenceSha256,
  recordedAt
} = {}) {
  try {
    const pair = validateFamilyPair(currentRecord, parentFamily, candidateFamily);
    if (pair.status !== 'OK') return pair;
    if (currentRecord.state !== 'SHADOW') {
      return refused('EVOLUTION_TRANSITION_INVALID', 'Only a shadow candidate may be verified.');
    }
    if (validateAdaptiveMeasurementRecord(measurementRecord).status !== 'OK'
        || measurementRecord.profile !== 'recursive-causal-v1'
        || measurementRecord.source.verifierEvidenceSha256 !== verifierEvidenceSha256
        || measurementRecord.mechanismBindings.parent !== currentRecord.parent.programSha256
        || measurementRecord.mechanismBindings.treatment
          !== currentRecord.candidate.programSha256) {
      return refused(
        'EVOLUTION_MEASUREMENT_BINDING_INVALID',
        'Recursive verification must bind the exact parent, candidate, and verifier evidence.'
      );
    }
    const baseline = measurementRecord.contrasts.treatmentVsBaseline;
    const parent = measurementRecord.contrasts.treatmentVsParent;
    const sham = measurementRecord.contrasts.shamVsBaseline;
    const result = {
      exactVsBaselineDelta: baseline.metrics.exact.delta,
      exactVsParentDelta: parent.metrics.exact.delta,
      decisionVsParentDelta: parent.metrics.decision.delta,
      shamExactVsBaselineDelta: sham.metrics.exact.delta,
      targetRegressions: baseline.targetRegressions + parent.targetRegressions,
      controlRegressions: baseline.controlRegressions + parent.controlRegressions
    };
    const built = createMechanismEvolutionRecord({
      ...currentRecord,
      state: 'VERIFIED',
      recordedAt,
      previous: previous(currentRecord),
      evidence: {
        ...currentRecord.evidence,
        verificationMeasurementId: measurementRecord.measurementId,
        verificationMeasurementSha256: measurementRecord.measurementSha256,
        verifierEvidenceSha256
      },
      outcome: result,
      authority: {
        mutation: 'bounded-tool',
        verification: 'independent-verifier',
        activation: 'none',
        promotionAuthorized: false
      }
    });
    return built.status === 'OK'
      ? ok({ record: built.record, measurement: measurementRecord, outcome: result })
      : built;
  } catch (error) {
    return refused('EVOLUTION_VERIFICATION_FAILED', error.message);
  }
}

export function activateMechanismEvolution({
  currentRecord,
  parentFamily,
  candidateFamily,
  activationEvidenceSha256,
  recordedAt
} = {}) {
  try {
    const pair = validateFamilyPair(currentRecord, parentFamily, candidateFamily);
    if (pair.status !== 'OK') return pair;
    if (currentRecord.state !== 'VERIFIED') {
      return refused('EVOLUTION_TRANSITION_INVALID', 'Only a verified candidate may enter active routing.');
    }
    const built = createMechanismEvolutionRecord({
      ...currentRecord,
      state: 'ACTIVE',
      recordedAt,
      previous: previous(currentRecord),
      evidence: {
        ...currentRecord.evidence,
        activationEvidenceSha256
      },
      authority: {
        mutation: 'bounded-tool',
        verification: 'independent-verifier',
        activation: 'routing-only',
        promotionAuthorized: false
      }
    });
    return built.status === 'OK' ? ok({ record: built.record }) : built;
  } catch (error) {
    return refused('EVOLUTION_ACTIVATION_FAILED', error.message);
  }
}

export function rejectMechanismEvolution({
  currentRecord,
  parentFamily,
  candidateFamily,
  rejectionEvidenceSha256,
  reasonCodes,
  recordedAt
} = {}) {
  try {
    const pair = validateFamilyPair(currentRecord, parentFamily, candidateFamily);
    if (pair.status !== 'OK') return pair;
    if (!['PROPOSED', 'SHADOW', 'VERIFIED'].includes(currentRecord.state)) {
      return refused('EVOLUTION_TRANSITION_INVALID', 'Only a nonterminal candidate may be rejected.');
    }
    const built = createMechanismEvolutionRecord({
      ...currentRecord,
      state: 'REJECTED',
      recordedAt,
      previous: previous(currentRecord),
      evidence: {
        ...currentRecord.evidence,
        activationEvidenceSha256: null,
        rejectionEvidenceSha256
      },
      authority: {
        ...currentRecord.authority,
        activation: 'none',
        promotionAuthorized: false
      },
      reasonCodes
    });
    return built.status === 'OK' ? ok({ record: built.record }) : built;
  } catch (error) {
    return refused('EVOLUTION_REJECTION_FAILED', error.message);
  }
}
