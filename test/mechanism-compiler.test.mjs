import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileMechanismCapsule,
  compileMechanismProgram,
  canonicalMechanismProgramJson,
  normalizeMechanismProgram
} from '../src/mechanism-compiler.mjs';
import { sha256 } from '../src/util.mjs';

const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: [
    'candidate.id',
    'measurement.candidate-id',
    'measurement.sha256',
    'candidate.quality',
    'baseline.quality',
    'candidate.cost',
    'baseline.cost',
    'candidate.results'
  ],
  selectors: [{
    selectorId: 'failed-results',
    collectionRole: 'candidate.results',
    match: {
      operator: 'all',
      conditions: [{
        operator: 'equal',
        left: { kind: 'role', id: 'candidate.id' },
        right: { kind: 'role', id: 'measurement.candidate-id' }
      }, {
        operator: 'greater-than',
        left: { kind: 'role', id: 'candidate.cost' },
        right: { kind: 'literal', value: 0 }
      }]
    }
  }],
  bindings: [{
    bindingId: 'candidate-measurement',
    operator: 'equal',
    leftRole: 'candidate.id',
    rightRole: 'measurement.candidate-id'
  }],
  forbiddenBindings: [{
    leftRole: 'candidate.id',
    rightRole: 'measurement.sha256',
    reasonCode: 'HASH_IS_NOT_CANDIDATE_ID'
  }],
  metrics: [{
    metricId: 'quality-delta',
    operator: 'subtract',
    leftRole: 'candidate.quality',
    rightRole: 'baseline.quality'
  }, {
    metricId: 'cost-increase',
    operator: 'relative-increase',
    leftRole: 'candidate.cost',
    rightRole: 'baseline.cost'
  }],
  rules: [{
    ruleId: 'reject-unbound',
    kind: 'guard',
    exceptionOf: null,
    when: {
      operator: 'equal',
      left: { kind: 'binding', id: 'candidate-measurement' },
      right: { kind: 'literal', value: false }
    },
    emit: { decision: 'REJECT', code: 'CANDIDATE_MEASUREMENT_MISMATCH' }
  }, {
    ruleId: 'quality-first-exception',
    kind: 'exception',
    exceptionOf: 'reject-cost-regression',
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_FIRST_EXCEPTION' }
  }, {
    ruleId: 'reject-cost-regression',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'cost-increase' },
      right: { kind: 'literal', value: 0.05 }
    },
    emit: { decision: 'REJECT', code: 'COST_REGRESSION' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_MEASURED_GAIN' }
};

const INTERFACE = {
  schemaVersion: 'executable-interface-contract-v2',
  exportName: 'selectCandidate',
  inputPaths: [
    'candidate.id',
    'measurement.candidateId',
    'measurement.measurementSha256',
    'candidate.quality',
    'baseline.quality',
    'candidate.tokenCost',
    'baseline.tokenCost',
    'candidate.results[]'
  ],
  decisions: ['ACCEPT', 'REJECT'],
  codes: [
    { value: 'CANDIDATE_MEASUREMENT_MISMATCH', meaning: 'Candidate identity does not match its measurement.' },
    { value: 'QUALITY_FIRST_EXCEPTION', meaning: 'Measured quality gain takes precedence over cost.' },
    { value: 'COST_REGRESSION', meaning: 'Candidate cost exceeds the accepted threshold.' },
    { value: 'NO_MEASURED_GAIN', meaning: 'No declared measured improvement was found.' }
  ],
  roleBindings: [
    { role: 'candidate.id', path: 'candidate.id' },
    { role: 'measurement.candidate-id', path: 'measurement.candidateId' },
    { role: 'measurement.sha256', path: 'measurement.measurementSha256' },
    { role: 'candidate.quality', path: 'candidate.quality' },
    { role: 'baseline.quality', path: 'baseline.quality' },
    { role: 'candidate.cost', path: 'candidate.tokenCost' },
    { role: 'baseline.cost', path: 'baseline.tokenCost' },
    { role: 'candidate.results', path: 'candidate.results[]' }
  ]
};

function reverseDeclarations(program) {
  const changed = structuredClone(program);
  changed.roles.reverse();
  changed.selectors[0].match.conditions.reverse();
  changed.bindings.reverse();
  changed.forbiddenBindings.reverse();
  changed.metrics.reverse();
  return changed;
}

function valueShape(value) {
  if (Array.isArray(value)) return {
    type: 'array',
    length: value.length,
    items: value.map(valueShape)
  };
  if (value && typeof value === 'object') return {
    type: 'object',
    keys: Object.keys(value).sort(),
    values: Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, valueShape(value[key])])
    )
  };
  return { type: value === null ? 'null' : typeof value };
}

function sealedCapsule(items) {
  const payload = {
    schemaVersion: 'mechanism-capsule-v1',
    items
  };
  return {
    ...payload,
    mechanismCapsuleSha256: sha256(canonicalMechanismProgramJson(payload))
  };
}

test('mechanism program and executable interface v2 schemas are closed and parseable', () => {
  for (const [filename, schemaVersion] of [
    ['mechanism-program-v1.schema.json', 'mechanism-program-v1'],
    ['executable-interface-contract-v2.schema.json', 'executable-interface-contract-v2']
  ]) {
    const schema = JSON.parse(readFileSync(
      new URL(`../src/schemas/${filename}`, import.meta.url),
      'utf8'
    ));
    assert.equal(schema.$id, schemaVersion);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
  }
});

test('normalization accepts dotted roles and deterministically seals unordered declarations', () => {
  const first = normalizeMechanismProgram(PROGRAM);
  const second = normalizeMechanismProgram(reverseDeclarations(PROGRAM));

  assert.equal(first.status, 'OK', first.message);
  assert.equal(second.status, 'OK', second.message);
  assert.deepEqual(second.program, first.program);
  assert.equal(second.programSha256, first.programSha256);
});

test('compiler binds semantic roles exactly and emits an authoritative closed-world predicate', () => {
  const result = compileMechanismProgram({
    program: PROGRAM,
    interfaceContract: INTERFACE
  });

  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.compilation.status, 'COMPILED');
  assert.deepEqual(result.compilation.acceptancePredicate.allowedPathPairs, [{
    bindingId: 'candidate-measurement',
    leftPath: 'candidate.id',
    rightPath: 'measurement.candidateId'
  }]);
  assert.deepEqual(result.compilation.acceptancePredicate.forbiddenPathPairs, [{
    leftPath: 'candidate.id',
    rightPath: 'measurement.measurementSha256',
    reasonCode: 'HASH_IS_NOT_CANDIDATE_ID'
  }]);
  assert.equal(
    result.compilation.acceptancePredicate.allowedPathPairs.some((pair) => (
      pair.leftPath === 'candidate.id'
      && pair.rightPath === 'measurement.measurementSha256'
    )),
    false
  );
  assert.deepEqual(result.compilation.acceptancePredicate.requiredExceptionIds, [
    'quality-first-exception'
  ]);
  assert.equal(
    result.compilation.rules[1].exceptionOf,
    'reject-cost-regression'
  );
});

test('compiler abstains when any semantic role is unmapped', () => {
  const interfaceContract = structuredClone(INTERFACE);
  interfaceContract.roleBindings = interfaceContract.roleBindings.filter(
    (binding) => binding.role !== 'measurement.sha256'
  );
  const result = compileMechanismProgram({ program: PROGRAM, interfaceContract });

  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.compilation.status, 'ABSTAINED');
  assert.equal(result.compilation.reasonCode, 'ROLE_UNMAPPED');
  assert.deepEqual(result.missingRoles, ['measurement.sha256']);
});

test('interface role bindings are injective and may not guess shared paths', () => {
  const interfaceContract = structuredClone(INTERFACE);
  interfaceContract.roleBindings.find(
    (binding) => binding.role === 'measurement.sha256'
  ).path = 'candidate.id';
  const result = compileMechanismProgram({ program: PROGRAM, interfaceContract });

  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'INTERFACE_ROLE_BINDINGS_INVALID');
});

test('compiler abstains when the target interface does not declare an emitted code', () => {
  const interfaceContract = structuredClone(INTERFACE);
  interfaceContract.codes = interfaceContract.codes.filter(
    (item) => item.value !== 'QUALITY_FIRST_EXCEPTION'
  );
  const result = compileMechanismProgram({ program: PROGRAM, interfaceContract });

  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.compilation.status, 'ABSTAINED');
  assert.equal(result.compilation.reasonCode, 'OUTPUT_CODE_UNDECLARED');
});

test('normalization refuses an exception placed after the rule it overrides', () => {
  const program = structuredClone(PROGRAM);
  [program.rules[1], program.rules[2]] = [program.rules[2], program.rules[1]];
  const result = normalizeMechanismProgram(program);

  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'INVALID_PROGRAM_EXCEPTION_ORDER');
});

test('capsule compilation reports complete coverage for routed and sham programs', () => {
  const capsule = sealedCapsule([{
      position: 1,
      familyId: 'family-000000000000000000000001',
      semantics: 'positive-transfer',
      causalFingerprint: { program: PROGRAM }
    }, {
      position: 2,
      familyId: 'family-000000000000000000000002',
      semantics: 'irrelevant-control',
      causalFingerprint: { program: PROGRAM },
      instruction: 'Preserve document heading order.'
    }]);
  const result = compileMechanismCapsule({ capsule, interfaceContract: INTERFACE });

  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.compiledCapsule.status, 'COMPILED');
  assert.deepEqual(result.compiledCapsule.coverage, {
    eligible: 2,
    compiled: 2,
    abstained: 0,
    ratio: 1
  });
  assert.equal(result.compiledCapsule.items[0].compilation.status, 'COMPILED');
  assert.equal(result.compiledCapsule.items[1].compilation.status, 'COMPILED');
});

test('routed and irrelevant treatments compile to schema-matched but distinct packets', () => {
  const baseItem = {
    position: 1,
    familyId: 'family-000000000000000000000001',
    causalFingerprint: { program: PROGRAM }
  };
  const routed = compileMechanismCapsule({
    capsule: sealedCapsule([{ ...baseItem, semantics: 'positive-transfer' }]),
    interfaceContract: INTERFACE
  });
  const sham = compileMechanismCapsule({
    capsule: sealedCapsule([{ ...baseItem, semantics: 'irrelevant-control' }]),
    interfaceContract: INTERFACE
  });

  assert.equal(routed.status, 'OK', routed.message);
  assert.equal(sham.status, 'OK', sham.message);
  assert.equal(routed.compiledCapsule.status, 'COMPILED');
  assert.equal(sham.compiledCapsule.status, 'COMPILED');
  assert.equal(sham.compiledCapsule.items[0].compilation.status, 'COMPILED');
  assert.deepEqual(valueShape(sham.compiledCapsule), valueShape(routed.compiledCapsule));
  assert.notEqual(sham.compiledCapsule.packetSha256, routed.compiledCapsule.packetSha256);
  assert.notDeepEqual(
    sham.compiledCapsule.items[0].compilation.roleBindings,
    routed.compiledCapsule.items[0].compilation.roleBindings
  );
});

test('capsule compilation refuses a hash that does not bind the capsule payload', () => {
  const capsule = sealedCapsule([{
    position: 1,
    familyId: 'family-000000000000000000000001',
    semantics: 'positive-transfer',
    causalFingerprint: { program: PROGRAM }
  }]);
  capsule.items[0].familyId = 'family-ffffffffffffffffffffffff';
  const result = compileMechanismCapsule({ capsule, interfaceContract: INTERFACE });

  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'MECHANISM_CAPSULE_HASH_MISMATCH');
});
