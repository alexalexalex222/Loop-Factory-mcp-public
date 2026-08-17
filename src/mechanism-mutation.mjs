import {
  canonicalMechanismProgramJson,
  compileMechanismProgram,
  normalizeMechanismProgram
} from './mechanism-compiler.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const MECHANISM_MUTATION_PLAN_SCHEMA_VERSION = 'mechanism-mutation-plan-v1';
export const MECHANISM_SEMANTIC_COMPARISON_SCHEMA_VERSION =
  'mechanism-semantic-comparison-v1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const REASON_RE = /^[A-Z0-9][A-Z0-9_]{0,119}$/;
const COLLECTIONS = new Set([
  'bindings',
  'fallback',
  'forbiddenBindings',
  'metrics',
  'rules',
  'selectors'
]);
const ACTIONS = new Set(['add', 'remove', 'replace']);
const TARGET_METRICS = new Set([
  'code-rate',
  'control-exact-rate',
  'decision-rate',
  'exact-case-rate',
  'full-repair-rate',
  'target-exact-rate',
  'token-cost'
]);
const DIRECTIONS = new Set(['decrease', 'increase']);

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

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function validSha(value) {
  return SHA256_RE.test(String(value || ''));
}

function itemSha256(value) {
  return sha256(canonical(value));
}

function normalizeReasonCodes(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 12) return null;
  const normalized = values.map((value) => String(value || '').trim().toUpperCase());
  if (normalized.some((value) => !REASON_RE.test(value))
      || new Set(normalized).size !== normalized.length) return null;
  return normalized.sort();
}

function normalizeObjective(value) {
  if (!exactKeys(value, [
    'direction',
    'failureCaseSetSha256',
    'measurementId',
    'measurementSha256',
    'successCaseSetSha256',
    'targetMetric'
  ])
      || !/^measurement-[a-f0-9]{24}$/.test(String(value.measurementId || ''))
      || !validSha(value.measurementSha256)
      || !validSha(value.failureCaseSetSha256)
      || !validSha(value.successCaseSetSha256)
      || value.failureCaseSetSha256 === value.successCaseSetSha256
      || !TARGET_METRICS.has(value.targetMetric)
      || !DIRECTIONS.has(value.direction)
      || (value.targetMetric === 'token-cost' && value.direction !== 'decrease')
      || (value.targetMetric !== 'token-cost' && value.direction !== 'increase')) return null;
  return {
    measurementId: String(value.measurementId),
    measurementSha256: String(value.measurementSha256),
    failureCaseSetSha256: String(value.failureCaseSetSha256),
    successCaseSetSha256: String(value.successCaseSetSha256),
    targetMetric: value.targetMetric,
    direction: value.direction
  };
}

function normalizeOperation(value) {
  if (!exactKeys(value, [
    'action',
    'collection',
    'expectedItemSha256',
    'insertBeforeRuleId',
    'value'
  ])
      || !ACTIONS.has(value.action)
      || !COLLECTIONS.has(value.collection)) return null;
  const expectedItemSha256 = value.expectedItemSha256 == null
    ? null
    : (validSha(value.expectedItemSha256) ? String(value.expectedItemSha256) : null);
  const insertBeforeRuleId = value.insertBeforeRuleId == null
    ? null
    : (isSafeId(value.insertBeforeRuleId) ? String(value.insertBeforeRuleId) : null);
  const hasObjectValue = value.value
    && typeof value.value === 'object'
    && !Array.isArray(value.value)
    && Buffer.byteLength(canonical(value.value)) <= 16 * 1024;
  if (value.action === 'add' && expectedItemSha256 != null
      || value.action !== 'add' && expectedItemSha256 == null
      || value.action === 'remove' && value.value != null
      || value.action !== 'remove' && !hasObjectValue
      || value.collection === 'fallback' && value.action !== 'replace'
      || (value.collection !== 'rules' || value.action !== 'add')
        && insertBeforeRuleId != null) return null;
  return {
    action: value.action,
    collection: value.collection,
    expectedItemSha256,
    insertBeforeRuleId,
    value: value.action === 'remove' ? null : stableValue(value.value)
  };
}

function planPayload(plan) {
  const payload = { ...plan };
  delete payload.mutationPlanId;
  delete payload.mutationPlanSha256;
  return payload;
}

export function createMechanismMutationPlan({
  parent = {},
  objective,
  operations,
  reasonCodes,
  expectedEffectCode
} = {}) {
  try {
    const normalizedObjective = normalizeObjective(objective);
    const normalizedReasons = normalizeReasonCodes(reasonCodes);
    const normalizedOperations = Array.isArray(operations)
      ? operations.map(normalizeOperation)
      : [];
    if (!/^family-[a-f0-9]{24}$/.test(String(parent.familyId || ''))
        || !validSha(parent.familySha256)
        || !validSha(parent.programSha256)
        || !normalizedObjective
        || !normalizedReasons
        || !REASON_RE.test(String(expectedEffectCode || ''))
        || normalizedOperations.length < 1
        || normalizedOperations.length > 8
        || normalizedOperations.some((operation) => !operation)) {
      return refused(
        'INVALID_MECHANISM_MUTATION_PLAN',
        'A mutation plan requires an exact parent, bounded operations, verifier evidence, and normalized effect codes.'
      );
    }
    const expectedHashes = normalizedOperations
      .map((operation) => operation.expectedItemSha256)
      .filter(Boolean);
    const addedValues = normalizedOperations
      .filter((operation) => operation.action === 'add')
      .map((operation) => `${operation.collection}:${itemSha256(operation.value)}`);
    if (new Set(expectedHashes).size !== expectedHashes.length
        || new Set(addedValues).size !== addedValues.length) {
      return refused(
        'DUPLICATE_MECHANISM_MUTATION',
        'A mutation plan cannot target or add the same program item more than once.'
      );
    }
    const payload = {
      schemaVersion: MECHANISM_MUTATION_PLAN_SCHEMA_VERSION,
      parent: {
        familyId: String(parent.familyId),
        familySha256: String(parent.familySha256),
        programSha256: String(parent.programSha256)
      },
      objective: normalizedObjective,
      operations: normalizedOperations,
      reasonCodes: normalizedReasons,
      expectedEffectCode: String(expectedEffectCode)
    };
    const digest = sha256(canonical(payload));
    return ok({
      plan: {
        ...payload,
        mutationPlanId: `mutation-${digest.slice(0, 24)}`,
        mutationPlanSha256: digest
      }
    });
  } catch (error) {
    return refused('MECHANISM_MUTATION_PLAN_BUILD_FAILED', error.message);
  }
}

export function validateMechanismMutationPlan(plan) {
  try {
    if (!exactKeys(plan, [
      'expectedEffectCode',
      'mutationPlanId',
      'mutationPlanSha256',
      'objective',
      'operations',
      'parent',
      'reasonCodes',
      'schemaVersion'
    ])
        || plan.schemaVersion !== MECHANISM_MUTATION_PLAN_SCHEMA_VERSION
        || !/^mutation-[a-f0-9]{24}$/.test(String(plan.mutationPlanId || ''))
        || !validSha(plan.mutationPlanSha256)) {
      return refused('INVALID_MECHANISM_MUTATION_PLAN', 'Mutation plan shape is invalid.');
    }
    const rebuilt = createMechanismMutationPlan(plan);
    return rebuilt.status === 'OK'
      && canonical(rebuilt.plan) === canonical(plan)
      && plan.mutationPlanSha256 === sha256(canonical(planPayload(plan)))
      ? ok({ plan })
      : refused('INVALID_MECHANISM_MUTATION_PLAN', 'Mutation plan content or hash is invalid.');
  } catch (error) {
    return refused('INVALID_MECHANISM_MUTATION_PLAN', error.message);
  }
}

function mapCondition(condition, maps) {
  if (['equal', 'not-equal', 'less-than', 'less-or-equal', 'greater-than', 'greater-or-equal']
    .includes(condition.operator)) {
    const operand = (value) => value.kind === 'binding'
      ? { kind: 'binding', id: maps.binding.get(value.id) }
      : value.kind === 'metric'
        ? { kind: 'metric', id: maps.metric.get(value.id) }
        : stableValue(value);
    return {
      operator: condition.operator,
      left: operand(condition.left),
      right: operand(condition.right)
    };
  }
  if (condition.operator === 'not') {
    return { operator: 'not', condition: mapCondition(condition.condition, maps) };
  }
  const conditions = condition.conditions.map((item) => mapCondition(item, maps));
  conditions.sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return {
    operator: condition.operator,
    conditions
  };
}

function alphaMap(values, structuralValue, prefix) {
  const groups = new Map();
  for (const value of values) {
    const key = canonical(structuralValue(value));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  const map = new Map();
  [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([, group], index) => {
      for (const item of group) map.set(item.id, `${prefix}-${index + 1}`);
    });
  return map;
}

function semanticProgram(program) {
  const normalized = normalizeMechanismProgram(program);
  if (normalized.status !== 'OK') return normalized;
  const source = normalized.program;
  const bindingValues = source.bindings.map((item) => ({
    id: item.bindingId,
    item
  }));
  const metricValues = source.metrics.map((item) => ({
    id: item.metricId,
    item
  }));
  const maps = {
    binding: alphaMap(bindingValues, ({ item }) => ({
      operator: item.operator,
      leftRole: item.leftRole,
      rightRole: item.rightRole
    }), 'binding'),
    metric: alphaMap(metricValues, ({ item }) => ({
      operator: item.operator,
      leftRole: item.leftRole,
      rightRole: item.rightRole
    }), 'metric'),
    rule: new Map(source.rules.map((item, index) => [item.ruleId, `rule-${index + 1}`]))
  };
  const semantic = {
    schemaVersion: source.schemaVersion,
    bindingPolicy: source.bindingPolicy,
    roles: source.roles,
    selectors: source.selectors.map((item) => ({
      collectionRole: item.collectionRole,
      match: mapCondition(item.match, maps)
    })).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    bindings: source.bindings.map((item) => ({
      operator: item.operator,
      leftRole: item.leftRole,
      rightRole: item.rightRole
    })).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    forbiddenBindings: source.forbiddenBindings,
    metrics: source.metrics.map((item) => ({
      operator: item.operator,
      leftRole: item.leftRole,
      rightRole: item.rightRole
    })).sort((left, right) => canonical(left).localeCompare(canonical(right))),
    rules: source.rules.map((item) => ({
      kind: item.kind,
      exceptionOf: item.exceptionOf == null ? null : maps.rule.get(item.exceptionOf),
      when: mapCondition(item.when, maps),
      emit: item.emit
    })),
    fallback: source.fallback
  };
  return ok({
    program: source,
    programSha256: normalized.programSha256,
    semantic,
    semanticSha256: sha256(canonical(semantic))
  });
}

export function mechanismProgramSemanticSha256(program) {
  const semantic = semanticProgram(program);
  return semantic.status === 'OK'
    ? ok({
        programSha256: semantic.programSha256,
        semanticSha256: semantic.semanticSha256
      })
    : semantic;
}

export function compareMechanismProgramSemantics(leftProgram, rightProgram) {
  const left = semanticProgram(leftProgram);
  if (left.status !== 'OK') return left;
  const right = semanticProgram(rightProgram);
  if (right.status !== 'OK') return right;
  return ok({
    comparison: {
      schemaVersion: MECHANISM_SEMANTIC_COMPARISON_SCHEMA_VERSION,
      leftProgramSha256: left.programSha256,
      rightProgramSha256: right.programSha256,
      leftSemanticSha256: left.semanticSha256,
      rightSemanticSha256: right.semanticSha256,
      byteIdentical: left.programSha256 === right.programSha256,
      semanticallyIdentical: left.semanticSha256 === right.semanticSha256,
      semanticDelta: left.semanticSha256 !== right.semanticSha256
    }
  });
}

function findCurrentItem(program, collection, expectedItemSha256) {
  if (collection === 'fallback') {
    return itemSha256(program.fallback) === expectedItemSha256
      ? { index: null, item: program.fallback }
      : null;
  }
  const matches = program[collection]
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => itemSha256(item) === expectedItemSha256);
  return matches.length === 1 ? matches[0] : null;
}

export function applyMechanismMutationPlan({ plan, parentProgram } = {}) {
  try {
    const validatedPlan = validateMechanismMutationPlan(plan);
    if (validatedPlan.status !== 'OK') return validatedPlan;
    const normalizedParent = normalizeMechanismProgram(parentProgram);
    if (normalizedParent.status !== 'OK') return normalizedParent;
    if (normalizedParent.programSha256 !== plan.parent.programSha256) {
      return refused(
        'STALE_MECHANISM_PARENT',
        'The mutation plan does not bind the supplied parent program.'
      );
    }
    const candidate = structuredClone(normalizedParent.program);
    const operationReceipts = [];
    for (const [index, operation] of plan.operations.entries()) {
      if (operation.action === 'add') {
        if (operation.collection === 'rules') {
          const insertAt = operation.insertBeforeRuleId == null
            ? candidate.rules.length
            : candidate.rules.findIndex((rule) => rule.ruleId === operation.insertBeforeRuleId);
          if (insertAt < 0) {
            return refused(
              'MUTATION_INSERTION_POINT_MISSING',
              `Mutation operation ${index} names an absent rule insertion point.`
            );
          }
          candidate.rules.splice(insertAt, 0, structuredClone(operation.value));
        } else {
          candidate[operation.collection].push(structuredClone(operation.value));
        }
        operationReceipts.push({
          position: index,
          action: operation.action,
          collection: operation.collection,
          beforeSha256: null,
          afterSha256: itemSha256(operation.value)
        });
        continue;
      }
      const current = findCurrentItem(
        candidate,
        operation.collection,
        operation.expectedItemSha256
      );
      if (!current) {
        return refused(
          'STALE_MECHANISM_ITEM',
          `Mutation operation ${index} does not bind exactly one current program item.`
        );
      }
      if (operation.collection === 'fallback') {
        candidate.fallback = structuredClone(operation.value);
      } else if (operation.action === 'remove') {
        candidate[operation.collection].splice(current.index, 1);
      } else {
        candidate[operation.collection][current.index] = structuredClone(operation.value);
      }
      operationReceipts.push({
        position: index,
        action: operation.action,
        collection: operation.collection,
        beforeSha256: operation.expectedItemSha256,
        afterSha256: operation.action === 'remove' ? null : itemSha256(operation.value)
      });
    }
    const normalizedCandidate = normalizeMechanismProgram(candidate);
    if (normalizedCandidate.status !== 'OK') {
      return refused(
        'MUTATED_PROGRAM_INVALID',
        `The bounded mutation produced an invalid program: ${normalizedCandidate.code}.`
      );
    }
    const semantics = compareMechanismProgramSemantics(
      normalizedParent.program,
      normalizedCandidate.program
    );
    if (semantics.status !== 'OK') return semantics;
    if (!semantics.comparison.semanticDelta) {
      return refused(
        'NO_SEMANTIC_DELTA',
        'The mutation changes bytes or names but not executable mechanism semantics.',
        { comparison: semantics.comparison }
      );
    }
    return ok({
      parentProgram: normalizedParent.program,
      candidateProgram: normalizedCandidate.program,
      parentProgramSha256: normalizedParent.programSha256,
      candidateProgramSha256: normalizedCandidate.programSha256,
      parentSemanticSha256: semantics.comparison.leftSemanticSha256,
      candidateSemanticSha256: semantics.comparison.rightSemanticSha256,
      changedComponents: [...new Set(plan.operations.map((item) => item.collection))].sort(),
      operationReceipts
    });
  } catch (error) {
    return refused('MECHANISM_MUTATION_FAILED', error.message);
  }
}

function compiledPayload(compilation) {
  const payload = structuredClone(compilation);
  delete payload.packetSha256;
  delete payload.programSha256;
  return payload;
}

export function compareCompiledMechanismTreatments({
  parentProgram,
  candidateProgram,
  interfaceContracts
} = {}) {
  try {
    const semantics = compareMechanismProgramSemantics(parentProgram, candidateProgram);
    if (semantics.status !== 'OK') return semantics;
    if (!Array.isArray(interfaceContracts)
        || interfaceContracts.length < 1
        || interfaceContracts.length > 100) {
      return refused(
        'TREATMENT_INTERFACE_SET_INVALID',
        'Treatment comparison requires 1-100 frozen executable interfaces.'
      );
    }
    const interfaces = [];
    for (const interfaceContract of interfaceContracts) {
      const parent = compileMechanismProgram({ program: parentProgram, interfaceContract });
      if (parent.status !== 'OK') return parent;
      const candidate = compileMechanismProgram({ program: candidateProgram, interfaceContract });
      if (candidate.status !== 'OK') return candidate;
      const parentSha256 = sha256(canonical(compiledPayload(parent.compilation)));
      const candidateSha256 = sha256(canonical(compiledPayload(candidate.compilation)));
      interfaces.push({
        interfaceSha256: parent.compilation.interfaceSha256,
        parentStatus: parent.compilation.status,
        candidateStatus: candidate.compilation.status,
        parentTreatmentSha256: parentSha256,
        candidateTreatmentSha256: candidateSha256,
        changed: parentSha256 !== candidateSha256
      });
    }
    const changedInterfaceCount = interfaces.filter((item) => item.changed).length;
    const payload = {
      schemaVersion: 'mechanism-treatment-delta-v1',
      parentProgramSha256: semantics.comparison.leftProgramSha256,
      candidateProgramSha256: semantics.comparison.rightProgramSha256,
      parentSemanticSha256: semantics.comparison.leftSemanticSha256,
      candidateSemanticSha256: semantics.comparison.rightSemanticSha256,
      sourceSemanticDelta: semantics.comparison.semanticDelta,
      interfaceCount: interfaces.length,
      changedInterfaceCount,
      identifiable: semantics.comparison.semanticDelta && changedInterfaceCount > 0,
      interfaces
    };
    return ok({
      treatmentDelta: {
        ...payload,
        treatmentDeltaSha256: sha256(canonical(payload))
      }
    });
  } catch (error) {
    return refused('TREATMENT_COMPARISON_FAILED', error.message);
  }
}
