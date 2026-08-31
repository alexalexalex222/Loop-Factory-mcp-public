import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activateReplicatedMechanismEvolution,
  createMechanismEvolutionAdmissionV2,
  validateMechanismEvolutionAdmissionV2
} from '../src/mechanism-evolution-admission-v2.mjs';
import { sha256 } from '../src/util.mjs';

function digest(label) {
  return sha256(label);
}

function input(overrides = {}) {
  return {
    state: 'VERIFIED',
    recordedAt: '2026-08-04T21:00:00.000Z',
    previous: null,
    sourceEvolution: {
      evolutionId: `evolution-${digest('evolution-id').slice(0, 24)}`,
      evolutionReceiptId: `evolution-receipt-${digest('evolution-receipt').slice(0, 24)}`,
      evolutionSha256: digest('evolution'),
      state: 'SHADOW'
    },
    parent: {
      familyId: `family-${digest('parent-id').slice(0, 24)}`,
      familySha256: digest('parent-family'),
      programSha256: digest('parent-program'),
      semanticSha256: digest('parent-semantic')
    },
    candidate: {
      familyId: `family-${digest('candidate-id').slice(0, 24)}`,
      familySha256: digest('candidate-family'),
      programSha256: digest('candidate-program'),
      semanticSha256: digest('candidate-semantic')
    },
    evidence: {
      calibrationMeasurementId: `measurement-${digest('calibration-id').slice(0, 24)}`,
      calibrationMeasurementSha256: digest('calibration-measurement'),
      confirmationMeasurementId: `measurement-${digest('confirmation-id').slice(0, 24)}`,
      confirmationMeasurementSha256: digest('confirmation-measurement'),
      calibrationAnalysisSha256: digest('calibration-analysis'),
      confirmationAnalysisSha256: digest('confirmation-analysis'),
      verifierEvidenceSha256: digest('verifier'),
      activationEvidenceSha256: null,
      rejectionEvidenceSha256: null
    },
    outcome: {
      exactVsBaselineDelta: 0.3,
      exactVsParentDelta: 0.2,
      decisionVsParentDelta: 0.1,
      shamExactVsBaselineDelta: 0.05,
      candidateVsParentLower95: 0.12,
      placeboUpper95: 0.08,
      adjustedExactDelta: 0.15,
      adjustedBlockP: 0.01,
      adjustedTaskP: 0.03125,
      targetRegressions: 0,
      controlRegressions: 0,
      candidateTokenDelta: -0.1
    },
    authority: {
      verification: 'independent-replicated-verifier',
      activation: 'none',
      promotionAuthorized: false
    },
    reasonCodes: [],
    ...overrides
  };
}

test('replicated admission schema is closed', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/mechanism-evolution-admission-v2.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'mechanism-evolution-admission-v2');
  assert.equal(schema.additionalProperties, false);
});

test('V2 admission permits measured sham movement only behind a stronger adjusted gate', () => {
  const built = createMechanismEvolutionAdmissionV2(input());
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.record.state, 'VERIFIED');
  assert.equal(built.record.outcome.shamExactVsBaselineDelta, 0.05);
  assert.equal(validateMechanismEvolutionAdmissionV2(built.record).status, 'OK');

  const active = activateReplicatedMechanismEvolution({
    currentAdmission: built.record,
    activationEvidenceSha256: digest('activation'),
    recordedAt: '2026-08-04T21:01:00.000Z'
  });
  assert.equal(active.status, 'OK', active.message);
  assert.equal(active.record.state, 'ACTIVE');
  assert.equal(active.record.authority.activation, 'routing-only');
});

test('a candidate confidence bound below placebo cannot mint VERIFIED', () => {
  const weak = input({
    outcome: {
      ...input().outcome,
      candidateVsParentLower95: 0.04,
      placeboUpper95: 0.08
    }
  });
  assert.equal(createMechanismEvolutionAdmissionV2(weak).status, 'REFUSED');

  const rejected = createMechanismEvolutionAdmissionV2({
    ...weak,
    state: 'REJECTED',
    evidence: {
      ...weak.evidence,
      rejectionEvidenceSha256: digest('rejection')
    },
    reasonCodes: ['REPLICATED_CAUSAL_GATES_FAILED']
  });
  assert.equal(rejected.status, 'OK', rejected.message);
  assert.equal(rejected.record.state, 'REJECTED');
});

test('replicated admission receipts are tamper-evident', () => {
  const built = createMechanismEvolutionAdmissionV2(input());
  const tampered = structuredClone(built.record);
  tampered.outcome.adjustedExactDelta = 0.9;
  assert.equal(validateMechanismEvolutionAdmissionV2(tampered).status, 'REFUSED');
});
