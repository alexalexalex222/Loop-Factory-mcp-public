import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalMechanismProgramJson, normalizeMechanismProgram } from '../src/mechanism-compiler.mjs';
import {
  applyMechanismMutationPlan,
  compareCompiledMechanismTreatments,
  compareMechanismProgramSemantics,
  createMechanismMutationPlan,
  validateMechanismMutationPlan
} from '../src/mechanism-mutation.mjs';
import { sha256 } from '../src/util.mjs';

const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [{
    metricId: 'quality-delta',
    operator: 'subtract',
    leftRole: 'candidate.quality',
    rightRole: 'baseline.quality'
  }],
  rules: [{
    ruleId: 'accept-quality',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

const INTERFACE = {
  schemaVersion: 'executable-interface-contract-v2',
  exportName: 'decide',
  inputPaths: ['baseline.quality', 'candidate.quality'],
  decisions: ['ACCEPT', 'REJECT'],
  codes: [{ value: 'QUALITY_GAIN', meaning: 'Quality increased.' }, {
    value: 'NO_GAIN', meaning: 'Quality did not increase.'
  }, {
    value: 'MANUAL_REVIEW', meaning: 'The unresolved case needs review.'
  }],
  roleBindings: [{ role: 'baseline.quality', path: 'baseline.quality' }, {
    role: 'candidate.quality', path: 'candidate.quality'
  }]
};

function itemSha(value) {
  return sha256(canonicalMechanismProgramJson(value));
}

function mutation(operations) {
  const normalized = normalizeMechanismProgram(PROGRAM);
  assert.equal(normalized.status, 'OK');
  return createMechanismMutationPlan({
    parent: {
      familyId: `family-${sha256('parent-family').slice(0, 24)}`,
      familySha256: sha256('parent-family-record'),
      programSha256: normalized.programSha256
    },
    objective: {
      measurementId: `measurement-${sha256('measurement').slice(0, 24)}`,
      measurementSha256: sha256('measurement-record'),
      failureCaseSetSha256: sha256('failure-cases'),
      successCaseSetSha256: sha256('success-cases'),
      targetMetric: 'exact-case-rate',
      direction: 'increase'
    },
    operations,
    reasonCodes: ['FAILED_FALLBACK_DISPOSITION'],
    expectedEffectCode: 'MORE_EXACT_CASES'
  });
}

test('mutation plan schema is closed and parseable', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/mechanism-mutation-plan-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'mechanism-mutation-plan-v1');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('mutationPlanSha256'));
});

test('bounded mutation changes one exact item and proves model-visible treatment delta', () => {
  const built = mutation([{
    action: 'replace',
    collection: 'fallback',
    expectedItemSha256: itemSha(PROGRAM.fallback),
    insertBeforeRuleId: null,
    value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
  }]);
  assert.equal(built.status, 'OK', built.message);
  assert.equal(validateMechanismMutationPlan(built.plan).status, 'OK');

  const applied = applyMechanismMutationPlan({
    plan: built.plan,
    parentProgram: PROGRAM
  });
  assert.equal(applied.status, 'OK', applied.message);
  assert.equal(applied.candidateProgram.fallback.code, 'MANUAL_REVIEW');
  assert.notEqual(applied.parentProgramSha256, applied.candidateProgramSha256);
  assert.notEqual(applied.parentSemanticSha256, applied.candidateSemanticSha256);
  assert.deepEqual(applied.changedComponents, ['fallback']);
  assert.equal(applied.operationReceipts[0].beforeSha256, itemSha(PROGRAM.fallback));

  const treatment = compareCompiledMechanismTreatments({
    parentProgram: PROGRAM,
    candidateProgram: applied.candidateProgram,
    interfaceContracts: [INTERFACE]
  });
  assert.equal(treatment.status, 'OK', treatment.message);
  assert.equal(treatment.treatmentDelta.sourceSemanticDelta, true);
  assert.equal(treatment.treatmentDelta.interfaceCount, 1);
  assert.equal(treatment.treatmentDelta.changedInterfaceCount, 1);
  assert.equal(treatment.treatmentDelta.identifiable, true);
});

test('alpha-equivalent identifier renames are semantic clones and cannot become descendants', () => {
  const renamedRule = structuredClone(PROGRAM.rules[0]);
  renamedRule.ruleId = 'same-rule-new-name';
  const comparison = compareMechanismProgramSemantics(PROGRAM, {
    ...PROGRAM,
    rules: [renamedRule]
  });
  assert.equal(comparison.status, 'OK');
  assert.equal(comparison.comparison.byteIdentical, false);
  assert.equal(comparison.comparison.semanticallyIdentical, true);

  const built = mutation([{
    action: 'replace',
    collection: 'rules',
    expectedItemSha256: itemSha(PROGRAM.rules[0]),
    insertBeforeRuleId: null,
    value: renamedRule
  }]);
  assert.equal(built.status, 'OK', built.message);
  const applied = applyMechanismMutationPlan({
    plan: built.plan,
    parentProgram: PROGRAM
  });
  assert.equal(applied.status, 'REFUSED');
  assert.equal(applied.code, 'NO_SEMANTIC_DELTA');

  const multiMetric = structuredClone(PROGRAM);
  multiMetric.roles.push('baseline.cost', 'candidate.cost');
  multiMetric.metrics.push({
    metricId: 'cost-delta',
    operator: 'subtract',
    leftRole: 'candidate.cost',
    rightRole: 'baseline.cost'
  });
  multiMetric.rules[0].when = {
    operator: 'all',
    conditions: [{
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    }, {
      operator: 'less-than',
      left: { kind: 'metric', id: 'cost-delta' },
      right: { kind: 'literal', value: 0 }
    }]
  };
  const renamedMetrics = structuredClone(multiMetric);
  renamedMetrics.metrics.find((item) => item.metricId === 'quality-delta').metricId = 'z-quality';
  renamedMetrics.metrics.find((item) => item.metricId === 'cost-delta').metricId = 'a-cost';
  for (const condition of renamedMetrics.rules[0].when.conditions) {
    if (condition.left.id === 'quality-delta') condition.left.id = 'z-quality';
    if (condition.left.id === 'cost-delta') condition.left.id = 'a-cost';
  }
  const reordered = compareMechanismProgramSemantics(multiMetric, renamedMetrics);
  assert.equal(reordered.status, 'OK', reordered.message);
  assert.equal(reordered.comparison.semanticallyIdentical, true);
});

test('mutation plans fail closed on stale items, duplicate targets, and harness-level fields', () => {
  const stale = mutation([{
    action: 'replace',
    collection: 'fallback',
    expectedItemSha256: sha256('not-the-fallback'),
    insertBeforeRuleId: null,
    value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
  }]);
  assert.equal(stale.status, 'OK');
  const staleApplied = applyMechanismMutationPlan({
    plan: stale.plan,
    parentProgram: PROGRAM
  });
  assert.equal(staleApplied.status, 'REFUSED');
  assert.equal(staleApplied.code, 'STALE_MECHANISM_ITEM');

  const duplicate = mutation([{
    action: 'replace',
    collection: 'fallback',
    expectedItemSha256: itemSha(PROGRAM.fallback),
    insertBeforeRuleId: null,
    value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
  }, {
    action: 'remove',
    collection: 'rules',
    expectedItemSha256: itemSha(PROGRAM.fallback),
    insertBeforeRuleId: null,
    value: null
  }]);
  assert.equal(duplicate.status, 'REFUSED');
  assert.equal(duplicate.code, 'DUPLICATE_MECHANISM_MUTATION');

  const harnessMutation = mutation([{
    action: 'replace',
    collection: 'policy',
    expectedItemSha256: sha256('policy'),
    insertBeforeRuleId: null,
    value: { controlShare: 0 }
  }]);
  assert.equal(harnessMutation.status, 'REFUSED');
  assert.equal(harnessMutation.code, 'INVALID_MECHANISM_MUTATION_PLAN');
});

test('valid source mutations still abstain when no frozen interface sees a treatment delta', () => {
  const built = mutation([{
    action: 'replace',
    collection: 'fallback',
    expectedItemSha256: itemSha(PROGRAM.fallback),
    insertBeforeRuleId: null,
    value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
  }]);
  const applied = applyMechanismMutationPlan({ plan: built.plan, parentProgram: PROGRAM });
  assert.equal(applied.status, 'OK');
  const unmapped = structuredClone(INTERFACE);
  unmapped.codes = [{ value: 'QUALITY_GAIN', meaning: 'Quality increased.' }, {
    value: 'UNRELATED_CODE', meaning: 'An unrelated disposition remains available.'
  }];
  const compared = compareCompiledMechanismTreatments({
    parentProgram: PROGRAM,
    candidateProgram: applied.candidateProgram,
    interfaceContracts: [unmapped]
  });
  assert.equal(compared.status, 'OK', compared.message);
  assert.equal(compared.treatmentDelta.sourceSemanticDelta, true);
  assert.equal(compared.treatmentDelta.changedInterfaceCount, 0);
  assert.equal(compared.treatmentDelta.identifiable, false);
});
