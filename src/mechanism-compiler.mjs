import { sha256 } from './util.mjs';

export const MECHANISM_PROGRAM_SCHEMA_VERSION = 'mechanism-program-v1';
export const MECHANISM_COMPILER_VERSION = 'mechanism-compiler-v1';
export const COMPILED_MECHANISM_SCHEMA_VERSION = 'compiled-mechanism-v1';
export const COMPILED_MECHANISM_CAPSULE_SCHEMA_VERSION =
  'compiled-mechanism-capsule-v1';
export const EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2 =
  'executable-interface-contract-v2';

const ROLE_RE = /^[a-z][a-z0-9-]{0,79}(?:\.[a-z][a-z0-9-]{0,79})*$/;
const ID_RE = /^[a-z][a-z0-9-]{0,79}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,119}$/;
const REASON_RE = /^[A-Z][A-Z0-9_]{1,119}$/;
const PATH_RE =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?)*$/;
const DECISIONS = new Set(['ACCEPT', 'REJECT']);
const RULE_KINDS = new Set(['guard', 'decision', 'exception']);
const METRIC_OPERATORS = new Set([
  'subtract',
  'relative-decrease',
  'relative-increase'
]);
const COMPARE_OPERATORS = new Set([
  'equal',
  'not-equal',
  'less-than',
  'less-or-equal',
  'greater-than',
  'greater-or-equal'
]);
const LOGIC_OPERATORS = new Set(['all', 'any', 'not']);
const OPERAND_KINDS = new Set(['role', 'metric', 'binding', 'literal']);
const MAX_CONDITION_DEPTH = 6;
const MAX_CONDITION_NODES = 128;

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

export function canonicalMechanismProgramJson(value) {
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

function validLiteral(value) {
  return value === null
    || typeof value === 'boolean'
    || Number.isFinite(value)
    || (typeof value === 'string' && value.length <= 120);
}

function normalizeOperand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !OPERAND_KINDS.has(value.kind)) return null;
  if (value.kind === 'literal') {
    return exactKeys(value, ['kind', 'value']) && validLiteral(value.value)
      ? { kind: 'literal', value: value.value }
      : null;
  }
  const idPattern = value.kind === 'role' ? ROLE_RE : ID_RE;
  return exactKeys(value, ['kind', 'id']) && idPattern.test(String(value.id || ''))
    ? { kind: value.kind, id: String(value.id) }
    : null;
}

function normalizeCondition(value, state, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || depth > MAX_CONDITION_DEPTH
      || ++state.nodes > MAX_CONDITION_NODES) return null;
  const operator = String(value.operator || '');
  if (COMPARE_OPERATORS.has(operator)) {
    if (!exactKeys(value, ['operator', 'left', 'right'])) return null;
    const left = normalizeOperand(value.left);
    const right = normalizeOperand(value.right);
    return left && right ? { operator, left, right } : null;
  }
  if (operator === 'not') {
    if (!exactKeys(value, ['operator', 'condition'])) return null;
    const condition = normalizeCondition(value.condition, state, depth + 1);
    return condition ? { operator, condition } : null;
  }
  if (operator === 'all' || operator === 'any') {
    if (!exactKeys(value, ['operator', 'conditions'])
        || !Array.isArray(value.conditions)
        || value.conditions.length < 1
        || value.conditions.length > 20) return null;
    const conditions = value.conditions
      .map((item) => normalizeCondition(item, state, depth + 1));
    if (conditions.some((item) => !item)) return null;
    conditions.sort((left, right) => (
      canonicalMechanismProgramJson(left)
        .localeCompare(canonicalMechanismProgramJson(right))
    ));
    return { operator, conditions };
  }
  return null;
}

function conditionReferences(condition, refs) {
  if (COMPARE_OPERATORS.has(condition.operator)) {
    for (const operand of [condition.left, condition.right]) {
      if (operand.kind !== 'literal') refs[operand.kind].add(operand.id);
    }
    return;
  }
  if (condition.operator === 'not') {
    conditionReferences(condition.condition, refs);
    return;
  }
  for (const item of condition.conditions) conditionReferences(item, refs);
}

function normalizedRolePair(leftRole, rightRole) {
  if (!ROLE_RE.test(String(leftRole || ''))
      || !ROLE_RE.test(String(rightRole || ''))
      || leftRole === rightRole) return null;
  return [String(leftRole), String(rightRole)].sort();
}

function normalizeEmit(value) {
  if (!exactKeys(value, ['decision', 'code'])
      || !DECISIONS.has(value.decision)
      || !CODE_RE.test(String(value.code || ''))) return null;
  return { decision: value.decision, code: String(value.code) };
}

function duplicate(values) {
  return new Set(values).size !== values.length;
}

export function normalizeMechanismProgram(input = {}) {
  try {
    if (!exactKeys(input, [
      'schemaVersion',
      'bindingPolicy',
      'roles',
      'selectors',
      'bindings',
      'forbiddenBindings',
      'metrics',
      'rules',
      'fallback'
    ])
        || input.schemaVersion !== MECHANISM_PROGRAM_SCHEMA_VERSION
        || input.bindingPolicy !== 'closed-world') {
      return refused(
        'INVALID_MECHANISM_PROGRAM',
        'Mechanism program shape, version, or binding policy is invalid.'
      );
    }

    if (!Array.isArray(input.roles)
        || input.roles.length < 1
        || input.roles.length > 80
        || input.roles.some((role) => !ROLE_RE.test(String(role || '')))
        || duplicate(input.roles)) {
      return refused('INVALID_PROGRAM_ROLES', 'Program roles must be unique normalized role IDs.');
    }
    const roles = [...input.roles].map(String).sort();
    const roleSet = new Set(roles);

    if (!Array.isArray(input.selectors) || input.selectors.length > 12) {
      return refused('INVALID_PROGRAM_SELECTORS', 'Program selectors must be a bounded array.');
    }
    const selectors = input.selectors.map((selector) => {
      if (!exactKeys(selector, ['selectorId', 'collectionRole', 'match'])
          || !ID_RE.test(String(selector.selectorId || ''))
          || !ROLE_RE.test(String(selector.collectionRole || ''))) return null;
      const state = { nodes: 0 };
      const match = normalizeCondition(selector.match, state);
      return match ? {
        selectorId: String(selector.selectorId),
        collectionRole: String(selector.collectionRole),
        match
      } : null;
    });
    if (selectors.some((item) => !item)
        || duplicate(selectors.map((item) => item.selectorId))) {
      return refused('INVALID_PROGRAM_SELECTORS', 'Program selectors are malformed or duplicated.');
    }
    selectors.sort((left, right) => left.selectorId.localeCompare(right.selectorId));

    if (!Array.isArray(input.bindings) || input.bindings.length > 40) {
      return refused('INVALID_PROGRAM_BINDINGS', 'Program bindings must be a bounded array.');
    }
    const bindings = input.bindings.map((binding) => {
      if (!exactKeys(binding, ['bindingId', 'operator', 'leftRole', 'rightRole'])
          || !ID_RE.test(String(binding.bindingId || ''))
          || binding.operator !== 'equal') return null;
      const pair = normalizedRolePair(binding.leftRole, binding.rightRole);
      return pair ? {
        bindingId: String(binding.bindingId),
        operator: 'equal',
        leftRole: pair[0],
        rightRole: pair[1]
      } : null;
    });
    if (bindings.some((item) => !item)
        || duplicate(bindings.map((item) => item.bindingId))
        || duplicate(bindings.map((item) => `${item.leftRole}:${item.rightRole}`))) {
      return refused('INVALID_PROGRAM_BINDINGS', 'Program bindings are malformed or duplicated.');
    }
    bindings.sort((left, right) => left.bindingId.localeCompare(right.bindingId));

    if (!Array.isArray(input.forbiddenBindings)
        || input.forbiddenBindings.length > 40) {
      return refused(
        'INVALID_FORBIDDEN_BINDINGS',
        'Forbidden bindings must be a bounded array.'
      );
    }
    const forbiddenBindings = input.forbiddenBindings.map((binding) => {
      if (!exactKeys(binding, ['leftRole', 'rightRole', 'reasonCode'])
          || !REASON_RE.test(String(binding.reasonCode || ''))) return null;
      const pair = normalizedRolePair(binding.leftRole, binding.rightRole);
      return pair ? {
        leftRole: pair[0],
        rightRole: pair[1],
        reasonCode: String(binding.reasonCode)
      } : null;
    });
    if (forbiddenBindings.some((item) => !item)
        || duplicate(forbiddenBindings.map((item) => `${item.leftRole}:${item.rightRole}`))) {
      return refused(
        'INVALID_FORBIDDEN_BINDINGS',
        'Forbidden bindings are malformed or duplicated.'
      );
    }
    forbiddenBindings.sort((left, right) => (
      left.leftRole.localeCompare(right.leftRole)
      || left.rightRole.localeCompare(right.rightRole)
    ));

    const forbiddenPairs = new Set(
      forbiddenBindings.map((item) => `${item.leftRole}:${item.rightRole}`)
    );
    if (bindings.some((item) => forbiddenPairs.has(`${item.leftRole}:${item.rightRole}`))) {
      return refused(
        'FORBIDDEN_BINDING_DECLARED',
        'An allowed equality is also declared forbidden.'
      );
    }

    if (!Array.isArray(input.metrics) || input.metrics.length > 30) {
      return refused('INVALID_PROGRAM_METRICS', 'Program metrics must be a bounded array.');
    }
    const metrics = input.metrics.map((metric) => {
      if (!exactKeys(metric, ['metricId', 'operator', 'leftRole', 'rightRole'])
          || !ID_RE.test(String(metric.metricId || ''))
          || !METRIC_OPERATORS.has(metric.operator)
          || !ROLE_RE.test(String(metric.leftRole || ''))
          || !ROLE_RE.test(String(metric.rightRole || ''))) return null;
      return {
        metricId: String(metric.metricId),
        operator: metric.operator,
        leftRole: String(metric.leftRole),
        rightRole: String(metric.rightRole)
      };
    });
    if (metrics.some((item) => !item)
        || duplicate(metrics.map((item) => item.metricId))) {
      return refused('INVALID_PROGRAM_METRICS', 'Program metrics are malformed or duplicated.');
    }
    metrics.sort((left, right) => left.metricId.localeCompare(right.metricId));

    if (!Array.isArray(input.rules)
        || input.rules.length < 1
        || input.rules.length > 40) {
      return refused('INVALID_PROGRAM_RULES', 'Program rules must contain 1-40 ordered rules.');
    }
    const rules = input.rules.map((rule) => {
      if (!exactKeys(rule, ['ruleId', 'kind', 'exceptionOf', 'when', 'emit'])
          || !ID_RE.test(String(rule.ruleId || ''))
          || !RULE_KINDS.has(rule.kind)
          || (rule.kind === 'exception') !== (rule.exceptionOf != null)
          || (rule.exceptionOf != null && !ID_RE.test(String(rule.exceptionOf)))) return null;
      const state = { nodes: 0 };
      const when = normalizeCondition(rule.when, state);
      const emit = normalizeEmit(rule.emit);
      return when && emit ? {
        ruleId: String(rule.ruleId),
        kind: rule.kind,
        exceptionOf: rule.exceptionOf == null ? null : String(rule.exceptionOf),
        when,
        emit
      } : null;
    });
    if (rules.some((item) => !item)
        || duplicate(rules.map((item) => item.ruleId))) {
      return refused('INVALID_PROGRAM_RULES', 'Program rules are malformed or duplicated.');
    }
    const ruleIds = new Set(rules.map((item) => item.ruleId));
    if (rules.some((item) => (
      item.exceptionOf != null
      && (item.exceptionOf === item.ruleId || !ruleIds.has(item.exceptionOf))
    ))) {
      return refused('INVALID_PROGRAM_EXCEPTION', 'Every exception must name another declared rule.');
    }
    const ruleById = new Map(rules.map((item, index) => [item.ruleId, {
      index,
      kind: item.kind
    }]));
    if (rules.some((item, index) => item.kind === 'exception' && (
      ruleById.get(item.exceptionOf)?.kind === 'exception'
      || ruleById.get(item.exceptionOf)?.index <= index
    ))) {
      return refused(
        'INVALID_PROGRAM_EXCEPTION_ORDER',
        'An exception must precede the non-exception rule it overrides.'
      );
    }
    const fallback = normalizeEmit(input.fallback);
    if (!fallback) return refused('INVALID_PROGRAM_FALLBACK', 'Program fallback is invalid.');

    const refs = {
      role: new Set(),
      metric: new Set(),
      binding: new Set()
    };
    for (const selector of selectors) {
      refs.role.add(selector.collectionRole);
      conditionReferences(selector.match, refs);
    }
    for (const binding of bindings) {
      refs.role.add(binding.leftRole);
      refs.role.add(binding.rightRole);
    }
    for (const binding of forbiddenBindings) {
      refs.role.add(binding.leftRole);
      refs.role.add(binding.rightRole);
    }
    for (const metric of metrics) {
      refs.role.add(metric.leftRole);
      refs.role.add(metric.rightRole);
    }
    for (const rule of rules) conditionReferences(rule.when, refs);
    const metricIds = new Set(metrics.map((item) => item.metricId));
    const bindingIds = new Set(bindings.map((item) => item.bindingId));
    if ([...refs.role].some((role) => !roleSet.has(role))) {
      return refused('UNDECLARED_PROGRAM_ROLE', 'A program expression uses an undeclared role.');
    }
    if ([...refs.metric].some((id) => !metricIds.has(id))) {
      return refused('UNDECLARED_PROGRAM_METRIC', 'A program expression uses an undeclared metric.');
    }
    if ([...refs.binding].some((id) => !bindingIds.has(id))) {
      return refused('UNDECLARED_PROGRAM_BINDING', 'A program expression uses an undeclared binding.');
    }

    const program = {
      schemaVersion: MECHANISM_PROGRAM_SCHEMA_VERSION,
      bindingPolicy: 'closed-world',
      roles,
      selectors,
      bindings,
      forbiddenBindings,
      metrics,
      rules,
      fallback
    };
    return ok({
      program,
      programSha256: sha256(canonicalMechanismProgramJson(program))
    });
  } catch (error) {
    return refused('MECHANISM_PROGRAM_NORMALIZATION_FAILED', error.message);
  }
}

function validateInterfaceContract(input = {}) {
  if (!exactKeys(input, [
    'schemaVersion',
    'exportName',
    'inputPaths',
    'decisions',
    'codes',
    'roleBindings'
  ])
      || input.schemaVersion !== EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2
      || !/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(String(input.exportName || ''))
      || !Array.isArray(input.inputPaths)
      || input.inputPaths.length < 1
      || input.inputPaths.length > 160
      || input.inputPaths.some((path) => !PATH_RE.test(String(path || '')))
      || duplicate(input.inputPaths)
      || !Array.isArray(input.decisions)
      || input.decisions.length !== 2
      || duplicate(input.decisions)
      || !input.decisions.every((decision) => DECISIONS.has(decision))
      || !Array.isArray(input.codes)
      || input.codes.length < 2
      || input.codes.length > 60
      || input.codes.some((item) => (
        !exactKeys(item, ['value', 'meaning'])
        || !CODE_RE.test(String(item.value || ''))
        || typeof item.meaning !== 'string'
        || item.meaning.trim().length < 8
        || item.meaning.length > 500
      ))
      || duplicate(input.codes.map((item) => item.value))
      || !Array.isArray(input.roleBindings)
      || input.roleBindings.length < 1
      || input.roleBindings.length > 100) {
    return refused('INTERFACE_CONTRACT_INVALID', 'Executable interface v2 shape is invalid.');
  }
  const declaredPaths = new Set(input.inputPaths);
  const roleBindings = input.roleBindings.map((binding) => {
    if (!exactKeys(binding, ['role', 'path'])
        || !ROLE_RE.test(String(binding.role || ''))
        || !PATH_RE.test(String(binding.path || ''))
        || !declaredPaths.has(binding.path)) return null;
    return { role: String(binding.role), path: String(binding.path) };
  });
  if (roleBindings.some((item) => !item)
      || duplicate(roleBindings.map((item) => item.role))
      || duplicate(roleBindings.map((item) => item.path))) {
    return refused(
      'INTERFACE_ROLE_BINDINGS_INVALID',
      'Role bindings must be total candidates with unique roles and injective declared paths.'
    );
  }
  roleBindings.sort((left, right) => left.role.localeCompare(right.role));
  const contract = {
    schemaVersion: EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2,
    exportName: input.exportName,
    inputPaths: [...input.inputPaths].sort(),
    decisions: [...input.decisions].sort(),
    codes: [...input.codes]
      .map((item) => ({ value: item.value, meaning: item.meaning.trim() }))
      .sort((left, right) => left.value.localeCompare(right.value)),
    roleBindings
  };
  return ok({
    contract,
    interfaceSha256: sha256(canonicalMechanismProgramJson(contract))
  });
}

function sealCompilation(payload) {
  return {
    ...payload,
    packetSha256: sha256(canonicalMechanismProgramJson(payload))
  };
}

function abstainedCompilation(reasonCode, {
  programSha256 = null,
  interfaceSha256 = null
} = {}) {
  return sealCompilation({
    schemaVersion: COMPILED_MECHANISM_SCHEMA_VERSION,
    compilerVersion: MECHANISM_COMPILER_VERSION,
    status: 'ABSTAINED',
    reasonCode,
    programSha256,
    interfaceSha256,
    bindingPolicy: 'closed-world',
    roleBindings: [],
    selectors: [],
    bindings: [],
    forbiddenBindings: [],
    metrics: [],
    rules: [],
    fallback: null,
    acceptancePredicate: null
  });
}

function compileOperand(operand, roleMap) {
  return operand.kind === 'role'
    ? { kind: 'path', role: operand.id, path: roleMap.get(operand.id) }
    : { ...operand };
}

function compileCondition(condition, roleMap) {
  if (COMPARE_OPERATORS.has(condition.operator)) {
    return {
      operator: condition.operator,
      left: compileOperand(condition.left, roleMap),
      right: compileOperand(condition.right, roleMap)
    };
  }
  if (condition.operator === 'not') {
    return {
      operator: 'not',
      condition: compileCondition(condition.condition, roleMap)
    };
  }
  return {
    operator: condition.operator,
    conditions: condition.conditions.map((item) => compileCondition(item, roleMap))
  };
}

export function compileMechanismProgram({ program, interfaceContract } = {}) {
  const normalized = normalizeMechanismProgram(program);
  if (normalized.status !== 'OK') return normalized;
  const parsedInterface = validateInterfaceContract(interfaceContract);
  if (parsedInterface.status !== 'OK') return parsedInterface;
  const roleMap = new Map(
    parsedInterface.contract.roleBindings.map((item) => [item.role, item.path])
  );
  const missingRoles = normalized.program.roles.filter((role) => !roleMap.has(role));
  if (missingRoles.length) {
    return ok({
      compilation: abstainedCompilation('ROLE_UNMAPPED', {
        programSha256: normalized.programSha256,
        interfaceSha256: parsedInterface.interfaceSha256
      }),
      missingRoles
    });
  }
  const declaredDecisions = new Set(parsedInterface.contract.decisions);
  const declaredCodes = new Set(
    parsedInterface.contract.codes.map((item) => item.value)
  );
  const emits = [
    ...normalized.program.rules.map((rule) => rule.emit),
    normalized.program.fallback
  ];
  if (emits.some((emit) => !declaredDecisions.has(emit.decision))) {
    return ok({
      compilation: abstainedCompilation('OUTPUT_DECISION_UNDECLARED', {
        programSha256: normalized.programSha256,
        interfaceSha256: parsedInterface.interfaceSha256
      })
    });
  }
  if (emits.some((emit) => !declaredCodes.has(emit.code))) {
    return ok({
      compilation: abstainedCompilation('OUTPUT_CODE_UNDECLARED', {
        programSha256: normalized.programSha256,
        interfaceSha256: parsedInterface.interfaceSha256
      })
    });
  }

  const bindings = normalized.program.bindings.map((binding) => ({
    ...binding,
    leftPath: roleMap.get(binding.leftRole),
    rightPath: roleMap.get(binding.rightRole)
  }));
  const forbiddenBindings = normalized.program.forbiddenBindings.map((binding) => ({
    ...binding,
    leftPath: roleMap.get(binding.leftRole),
    rightPath: roleMap.get(binding.rightRole)
  }));
  const rules = normalized.program.rules.map((rule) => ({
    ...rule,
    when: compileCondition(rule.when, roleMap)
  }));
  const payload = {
    schemaVersion: COMPILED_MECHANISM_SCHEMA_VERSION,
    compilerVersion: MECHANISM_COMPILER_VERSION,
    status: 'COMPILED',
    reasonCode: null,
    programSha256: normalized.programSha256,
    interfaceSha256: parsedInterface.interfaceSha256,
    bindingPolicy: 'closed-world',
    roleBindings: normalized.program.roles.map((role) => ({
      role,
      path: roleMap.get(role)
    })),
    selectors: normalized.program.selectors.map((selector) => ({
      selectorId: selector.selectorId,
      collectionRole: selector.collectionRole,
      collectionPath: roleMap.get(selector.collectionRole),
      match: compileCondition(selector.match, roleMap)
    })),
    bindings,
    forbiddenBindings,
    metrics: normalized.program.metrics.map((metric) => ({
      ...metric,
      leftPath: roleMap.get(metric.leftRole),
      rightPath: roleMap.get(metric.rightRole)
    })),
    rules,
    fallback: normalized.program.fallback,
    acceptancePredicate: {
      bindingPolicy: 'closed-world',
      allowedBindingIds: bindings.map((item) => item.bindingId),
      allowedPathPairs: bindings.map((item) => ({
        bindingId: item.bindingId,
        leftPath: item.leftPath,
        rightPath: item.rightPath
      })),
      forbiddenPathPairs: forbiddenBindings.map((item) => ({
        leftPath: item.leftPath,
        rightPath: item.rightPath,
        reasonCode: item.reasonCode
      })),
      requiredRuleIds: rules.map((item) => item.ruleId),
      requiredExceptionIds: rules
        .filter((item) => item.kind === 'exception')
        .map((item) => item.ruleId),
      decisions: [...declaredDecisions].sort(),
      codes: [...declaredCodes].sort()
    }
  };
  return ok({ compilation: sealCompilation(payload) });
}

function remapCompiledOperand(operand, maps, literalState) {
  if (operand.kind === 'path') {
    return {
      kind: 'path',
      role: maps.role.get(operand.role),
      path: maps.path.get(operand.path)
    };
  }
  if (operand.kind === 'metric') {
    return { kind: 'metric', id: maps.metric.get(operand.id) };
  }
  if (operand.kind === 'binding') {
    return { kind: 'binding', id: maps.binding.get(operand.id) };
  }
  literalState.index += 1;
  const value = operand.value;
  return {
    kind: 'literal',
    value: typeof value === 'string'
      ? `document-value-${literalState.index}`
      : (typeof value === 'number'
          ? (value === 0 ? 1 : -value)
          : (typeof value === 'boolean' ? !value : null))
  };
}

function remapCompiledCondition(condition, maps, literalState) {
  if (COMPARE_OPERATORS.has(condition.operator)) {
    return {
      operator: condition.operator,
      left: remapCompiledOperand(condition.left, maps, literalState),
      right: remapCompiledOperand(condition.right, maps, literalState)
    };
  }
  if (condition.operator === 'not') {
    return {
      operator: 'not',
      condition: remapCompiledCondition(condition.condition, maps, literalState)
    };
  }
  return {
    operator: condition.operator,
    conditions: condition.conditions.map((item) => (
      remapCompiledCondition(item, maps, literalState)
    ))
  };
}

function irrelevantCompilation(source) {
  const role = new Map(source.roleBindings.map((item, index) => (
    [item.role, `document.role-${index + 1}`]
  )));
  const path = new Map(source.roleBindings.map((item, index) => (
    [item.path, `document.field${index + 1}`]
  )));
  const binding = new Map(source.bindings.map((item, index) => (
    [item.bindingId, `document-binding-${index + 1}`]
  )));
  const metric = new Map(source.metrics.map((item, index) => (
    [item.metricId, `document-metric-${index + 1}`]
  )));
  const rule = new Map(source.rules.map((item, index) => (
    [item.ruleId, `document-rule-${index + 1}`]
  )));
  const code = new Map(source.acceptancePredicate.codes.map((item, index) => (
    [item, `DOCUMENT_CODE_${index + 1}`]
  )));
  const maps = { role, path, binding, metric };
  const literalState = { index: 0 };
  const payload = {
    schemaVersion: source.schemaVersion,
    compilerVersion: source.compilerVersion,
    status: source.status,
    reasonCode: source.reasonCode,
    programSha256: sha256(`irrelevant-program:${source.programSha256}`),
    interfaceSha256: source.interfaceSha256,
    bindingPolicy: source.bindingPolicy,
    roleBindings: source.roleBindings.map((item) => ({
      role: role.get(item.role),
      path: path.get(item.path)
    })),
    selectors: source.selectors.map((item, index) => ({
      selectorId: `document-selector-${index + 1}`,
      collectionRole: role.get(item.collectionRole),
      collectionPath: path.get(item.collectionPath),
      match: remapCompiledCondition(item.match, maps, literalState)
    })),
    bindings: source.bindings.map((item) => ({
      bindingId: binding.get(item.bindingId),
      operator: item.operator,
      leftRole: role.get(item.leftRole),
      rightRole: role.get(item.rightRole),
      leftPath: path.get(item.leftPath),
      rightPath: path.get(item.rightPath)
    })),
    forbiddenBindings: source.forbiddenBindings.map((item, index) => ({
      leftRole: role.get(item.leftRole),
      rightRole: role.get(item.rightRole),
      reasonCode: `DOCUMENT_BINDING_${index + 1}`,
      leftPath: path.get(item.leftPath),
      rightPath: path.get(item.rightPath)
    })),
    metrics: source.metrics.map((item) => ({
      metricId: metric.get(item.metricId),
      operator: item.operator,
      leftRole: role.get(item.leftRole),
      rightRole: role.get(item.rightRole),
      leftPath: path.get(item.leftPath),
      rightPath: path.get(item.rightPath)
    })),
    rules: source.rules.map((item) => ({
      ruleId: rule.get(item.ruleId),
      kind: item.kind,
      exceptionOf: item.exceptionOf == null ? null : rule.get(item.exceptionOf),
      when: remapCompiledCondition(item.when, maps, literalState),
      emit: {
        decision: item.emit.decision,
        code: code.get(item.emit.code)
      }
    })),
    fallback: {
      decision: source.fallback.decision,
      code: code.get(source.fallback.code)
    },
    acceptancePredicate: {
      bindingPolicy: source.acceptancePredicate.bindingPolicy,
      allowedBindingIds: source.acceptancePredicate.allowedBindingIds
        .map((item) => binding.get(item)),
      allowedPathPairs: source.acceptancePredicate.allowedPathPairs.map((item) => ({
        bindingId: binding.get(item.bindingId),
        leftPath: path.get(item.leftPath),
        rightPath: path.get(item.rightPath)
      })),
      forbiddenPathPairs: source.acceptancePredicate.forbiddenPathPairs
        .map((item, index) => ({
          leftPath: path.get(item.leftPath),
          rightPath: path.get(item.rightPath),
          reasonCode: `DOCUMENT_BINDING_${index + 1}`
        })),
      requiredRuleIds: source.acceptancePredicate.requiredRuleIds
        .map((item) => rule.get(item)),
      requiredExceptionIds: source.acceptancePredicate.requiredExceptionIds
        .map((item) => rule.get(item)),
      decisions: [...source.acceptancePredicate.decisions],
      codes: source.acceptancePredicate.codes.map((item) => code.get(item))
    }
  };
  return sealCompilation(payload);
}

export function compileMechanismCapsule({ capsule, interfaceContract } = {}) {
  const parsedInterface = validateInterfaceContract(interfaceContract);
  if (parsedInterface.status !== 'OK') return parsedInterface;
  if (capsule == null) {
    const payload = {
      schemaVersion: COMPILED_MECHANISM_CAPSULE_SCHEMA_VERSION,
      compilerVersion: MECHANISM_COMPILER_VERSION,
      sourceMechanismCapsuleSha256: null,
      interfaceSha256: parsedInterface.interfaceSha256,
      treatmentSemantics: 'none',
      status: 'NO_MECHANISM',
      reasonCode: 'NO_MECHANISM',
      coverage: { eligible: 0, compiled: 0, abstained: 0, ratio: null },
      items: []
    };
    return ok({ compiledCapsule: sealCompilation(payload) });
  }
  if (capsule.schemaVersion !== 'mechanism-capsule-v1'
      || !Array.isArray(capsule.items)
      || !/^[a-f0-9]{64}$/.test(String(capsule.mechanismCapsuleSha256 || ''))) {
    return refused('MECHANISM_CAPSULE_INVALID', 'Mechanism capsule shape is invalid.');
  }
  const capsulePayload = { ...capsule };
  delete capsulePayload.mechanismCapsuleSha256;
  if (sha256(canonicalMechanismProgramJson(capsulePayload))
      !== capsule.mechanismCapsuleSha256) {
    return refused(
      'MECHANISM_CAPSULE_HASH_MISMATCH',
      'Mechanism capsule hash does not bind the capsule payload.'
    );
  }
  const items = [];
  let eligible = 0;
  let compiled = 0;
  let abstained = 0;
  for (const item of capsule.items) {
    let compilation;
    if (!['positive-transfer', 'irrelevant-control'].includes(item?.semantics)) {
      compilation = abstainedCompilation('UNSUPPORTED_SEMANTICS', {
        interfaceSha256: parsedInterface.interfaceSha256
      });
      abstained += 1;
    } else {
      eligible += 1;
      const result = compileMechanismProgram({
        program: item?.causalFingerprint?.program,
        interfaceContract: parsedInterface.contract
      });
      compilation = result.status === 'OK'
        ? result.compilation
        : abstainedCompilation(result.code || 'PROGRAM_INVALID', {
            interfaceSha256: parsedInterface.interfaceSha256
          });
      if (compilation.status === 'COMPILED') {
        if (item.semantics === 'irrelevant-control') {
          compilation = irrelevantCompilation(compilation);
        }
        compiled += 1;
      }
      else abstained += 1;
    }
    items.push({
      position: Number.isInteger(item?.position) ? item.position : null,
      familyId: typeof item?.familyId === 'string' ? item.familyId : null,
      semantics: String(item?.semantics || ''),
      compilation
    });
  }
  const ratio = eligible ? Math.round(compiled / eligible * 1_000_000) / 1_000_000 : null;
  const status = items.length
    ? (abstained === 0 && compiled === eligible ? 'COMPILED' : 'ABSTAINED')
    : 'NO_MECHANISM';
  const semantics = [...new Set(items.map((item) => item.semantics))];
  const payload = {
    schemaVersion: COMPILED_MECHANISM_CAPSULE_SCHEMA_VERSION,
    compilerVersion: MECHANISM_COMPILER_VERSION,
    sourceMechanismCapsuleSha256: capsule.mechanismCapsuleSha256,
    interfaceSha256: parsedInterface.interfaceSha256,
    treatmentSemantics: semantics.length === 1 ? semantics[0] : 'mixed',
    status,
    reasonCode: status === 'ABSTAINED' ? 'COMPILE_COVERAGE_INCOMPLETE' : null,
    coverage: { eligible, compiled, abstained, ratio },
    items
  };
  return ok({ compiledCapsule: sealCompilation(payload) });
}
