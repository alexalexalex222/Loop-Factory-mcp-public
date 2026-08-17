import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAdaptiveJson,
  createRoutingDecisionRecord
} from '../src/adaptive-records.mjs';
import { prepareActiveMechanismTreatment } from '../src/active-mechanism-treatment.mjs';
import { sha256 } from '../src/util.mjs';

const TARGET = sha256('target');
const POOL = sha256('candidate-pool');
const EPOCH = sha256('policy-epoch');
const EPOCH_ID = `epoch-${sha256('epoch-id').slice(0, 24)}`;
const FAMILY = `family-${sha256('family').slice(0, 24)}`;
const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['candidate.score'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [],
  rules: [{
    ruleId: 'accept-score',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'role', id: 'candidate.score' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'SCORE_PRESENT' }
  }],
  fallback: { decision: 'REJECT', code: 'SCORE_MISSING' }
};
const INTERFACE = {
  schemaVersion: 'executable-interface-contract-v2',
  exportName: 'evaluateCandidate',
  inputPaths: ['candidate.score'],
  decisions: ['ACCEPT', 'REJECT'],
  codes: [
    { value: 'SCORE_PRESENT', meaning: 'Candidate score is positive.' },
    { value: 'SCORE_MISSING', meaning: 'Candidate score is absent.' }
  ],
  roleBindings: [{ role: 'candidate.score', path: 'candidate.score' }]
};

function fixture({ executable = true } = {}) {
  const item = {
    position: 1,
    allocation: 'related',
    familyId: FAMILY,
    semantics: 'positive-transfer',
    causalFingerprint: executable
      ? { program: PROGRAM }
      : { operationKind: 'preserve-existing-behavior' },
    instruction: 'Free-form source instruction.'
  };
  const capsulePayload = {
    schemaVersion: 'mechanism-capsule-v1',
    targetSha256: TARGET,
    policyEpochId: EPOCH_ID,
    policyEpochSha256: EPOCH,
    candidatePoolSha256: POOL,
    items: [item]
  };
  const mechanismCapsule = {
    ...capsulePayload,
    mechanismCapsuleSha256: sha256(canonicalAdaptiveJson(capsulePayload))
  };
  const decision = createRoutingDecisionRecord({
    mode: 'active-canary',
    status: 'COMPLETE',
    targetSha256: TARGET,
    candidatePoolSha256: POOL,
    candidatePoolCount: 1,
    policyEpochId: EPOCH_ID,
    policyEpochSha256: EPOCH,
    mechanismCapsuleSha256: mechanismCapsule.mechanismCapsuleSha256,
    seed: 'adapter-test',
    abstentionCode: null,
    allocationSchedule: [{
      allocation: 'control',
      familyId: null,
      applicationReceiptId: null,
      probability: 0.2,
      evidenceStrength: null,
      reasonCodes: ['NO_MEMORY_CONTROL']
    }, {
      allocation: 'related',
      familyId: FAMILY,
      applicationReceiptId: null,
      probability: 0.8,
      evidenceStrength: 0.8,
      reasonCodes: ['EVIDENCE_SELECTED']
    }]
  });
  assert.equal(decision.status, 'OK', decision.message);
  return { routingDecision: decision.record, mechanismCapsule };
}

test('compiles executable treatment before exposure and leaves control untreated', () => {
  const result = prepareActiveMechanismTreatment({
    ...fixture(),
    interfaceContract: INTERFACE
  });

  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.treatmentMode, 'COMPILED');
  assert.deepEqual(result.positions[0], {
    position: 0,
    allocation: 'control',
    familyId: null,
    capsuleItem: null,
    compiledTreatment: null,
    legacyTreatment: null
  });
  assert.equal(result.positions[1].compiledTreatment.schemaVersion, 'compiled-mechanism-v1');
  assert.equal(result.positions[1].compiledTreatment.status, 'COMPILED');
  assert.match(result.positions[1].compiledTreatment.packetSha256, /^[a-f0-9]{64}$/);
  assert.match(result.positions[1].compiledTreatment.interfaceSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.positions[1].compiledTreatment.roleBindings[0].path, 'candidate.score');
  assert.equal(result.positions[1].legacyTreatment, null);
});

test('missing or unmapped interfaces fail closed before treatment registration', () => {
  const missing = prepareActiveMechanismTreatment(fixture());
  assert.equal(missing.status, 'REFUSED');
  assert.equal(missing.code, 'INTERFACE_CONTRACT_INVALID');

  const unmapped = prepareActiveMechanismTreatment({
    ...fixture(),
    interfaceContract: {
      ...INTERFACE,
      inputPaths: ['candidate.other'],
      roleBindings: [{ role: 'candidate.other', path: 'candidate.other' }]
    }
  });
  assert.equal(unmapped.status, 'REFUSED');
  assert.equal(unmapped.code, 'EXECUTABLE_COMPILATION_ABSTAINED');
  assert.equal(unmapped.compilerReasonCode, 'ROLE_UNMAPPED');
});

test('capsule mutation is refused even when the route itself remains valid', () => {
  const input = fixture();
  input.mechanismCapsule.items[0].instruction = 'Mutated after sealing.';
  const result = prepareActiveMechanismTreatment({
    ...input,
    interfaceContract: INTERFACE
  });

  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'MECHANISM_CAPSULE_HASH_MISMATCH');
});

test('programless families remain explicit legacy treatments', () => {
  const result = prepareActiveMechanismTreatment(fixture({ executable: false }));

  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.treatmentMode, 'LEGACY');
  assert.equal(result.compiledCapsule, null);
  assert.equal(result.positions[1].compiledTreatment, null);
  assert.equal(result.positions[1].legacyTreatment.instruction, 'Free-form source instruction.');
});
