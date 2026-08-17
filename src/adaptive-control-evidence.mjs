import { canonicalAdaptiveJson } from './adaptive-records.mjs';
import { isSafeId, round, sha256 } from './util.mjs';

export const ADAPTIVE_CONTROL_SOURCE_SCHEMA = 'adaptive-control-evidence-source-v1';
export const ADAPTIVE_CONTROL_ARM_SCHEMA = 'adaptive-control-arm-evidence-v1';
export const ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA = 'adaptive-control-case-measurement-v1';
export const ADAPTIVE_CONTROL_CASE_SET_SCHEMA = 'adaptive-control-case-set-v1';
export const ADAPTIVE_CONTROL_ARTIFACT_SOURCE_SCHEMA =
  'adaptive-control-artifact-source-v1';

const ROLES = Object.freeze(['baseline', 'routed', 'sham']);
const ARM_KEYS = ['schemaVersion', 'armRole', 'provenance', 'measurements'];
const MEASUREMENT_KEYS = ['caseId', 'targetQuality', 'controlQuality'];
const PROVENANCE_KEYS = [
  'runId', 'testId', 'benchmarkSha256', 'caseSetSha256', 'caseIdsSha256',
  'oracleSha256', 'evaluatorSha256', 'measurementSchemaVersion',
  'measurementAuthority'
];
const EXPECTED_KEYS = [
  'runId', 'testId', 'benchmarkSha256', 'caseSetSha256', 'caseIdsSha256',
  'oracleSha256', 'evaluatorSha256', 'sourceEvidenceSha256',
  'armEvidenceSha256'
];
const SHA256_RE = /^[a-f0-9]{64}$/;

function refused(code, message, details = {}) {
  return { status: 'REFUSED', code, message, ...details };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  const keys = record(value) && Object.keys(value).sort();
  const wanted = [...expected].sort();
  return !!keys && keys.length === wanted.length
    && keys.every((key, index) => key === wanted[index]);
}

function safeStringId(value) {
  return typeof value === 'string' && isSafeId(value);
}

function sha(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function quality(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function adaptiveControlCaseIdsSha256(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length === 0
      || caseIds.some((id) => !safeStringId(id))
      || new Set(caseIds).size !== caseIds.length) return null;
  return sha256(canonicalAdaptiveJson({
    schemaVersion: ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA,
    caseIds: [...caseIds].sort()
  }));
}

export function adaptiveControlBenchmarkBindings(benchmark = {}) {
  try {
    const cases = Array.isArray(benchmark?.cases) ? benchmark.cases : [];
    const caseIds = cases.map((item) => item?.id);
    const caseIdsSha256 = adaptiveControlCaseIdsSha256(caseIds);
    if (!record(benchmark) || !record(benchmark.oracle) || !caseIdsSha256) {
      return refused(
        'BENCHMARK_BINDING_INVALID',
        'The frozen benchmark needs a deterministic oracle and unique safe case IDs.'
      );
    }
    return {
      status: 'OK',
      bindings: {
        benchmarkSha256: sha256(canonicalAdaptiveJson(benchmark)),
        caseSetSha256: sha256(canonicalAdaptiveJson({
          schemaVersion: ADAPTIVE_CONTROL_CASE_SET_SCHEMA,
          cases
        })),
        caseIdsSha256,
        oracleSha256: sha256(canonicalAdaptiveJson(benchmark.oracle)),
        evaluatorSha256: sha256(canonicalAdaptiveJson({
          schemaVersion: ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA,
          authority: 'tool-computed',
          oracle: benchmark.oracle
        }))
      }
    };
  } catch {
    return refused(
      'BENCHMARK_BINDING_INVALID',
      'The frozen benchmark must be finite plain JSON data.'
    );
  }
}

function validateArm(arm, expectedRole, sealed) {
  if (!exactKeys(arm, [...ARM_KEYS, ...(sealed ? ['armEvidenceSha256'] : [])])) {
    return refused(
      'ARM_SCHEMA_MISMATCH',
      'Arm evidence is incomplete or contains unsupported aggregate claims.'
    );
  }
  if (arm.schemaVersion !== ADAPTIVE_CONTROL_ARM_SCHEMA) {
    return refused('ARM_SCHEMA_MISMATCH', 'Unsupported adaptive control arm schema.');
  }
  if (!ROLES.includes(arm.armRole) || arm.armRole !== expectedRole) {
    return refused(
      'ARM_ROLE_MISMATCH',
      `Expected ${expectedRole} evidence, received ${String(arm.armRole)}.`
    );
  }
  if (!Array.isArray(arm.measurements) || arm.measurements.length === 0) {
    return refused('MEASUREMENTS_REQUIRED', 'Each arm requires per-case measurements.');
  }
  const caseIds = [];
  for (const measurement of arm.measurements) {
    if (!exactKeys(measurement, MEASUREMENT_KEYS)) {
      return refused(
        'MEASUREMENT_SCHEMA_MISMATCH',
        'Measurements contain unsupported or missing fields.'
      );
    }
    if (!safeStringId(measurement.caseId)) {
      return refused('CASE_ID_INVALID', 'Every measurement requires a safe string caseId.');
    }
    if (!quality(measurement.targetQuality) || !quality(measurement.controlQuality)) {
      return refused(
        'MEASUREMENT_MISSING',
        'Target and control quality must be finite numbers between 0 and 1.'
      );
    }
    caseIds.push(measurement.caseId);
  }
  if (new Set(caseIds).size !== caseIds.length) {
    return refused('CASE_SET_MISMATCH', 'An arm cannot contain duplicate case IDs.');
  }
  const provenance = arm.provenance;
  if (!exactKeys(provenance, PROVENANCE_KEYS)) {
    return refused('PROVENANCE_SCHEMA_MISMATCH', 'Arm provenance is incomplete.');
  }
  if (!safeStringId(provenance.runId) || !safeStringId(provenance.testId)
      || ['benchmarkSha256', 'caseSetSha256', 'caseIdsSha256', 'oracleSha256',
        'evaluatorSha256'].some((field) => !sha(provenance[field]))) {
    return refused('PROVENANCE_MISMATCH', 'Arm provenance contains an invalid binding.');
  }
  if (provenance.measurementSchemaVersion !== ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA
      || provenance.measurementAuthority !== 'tool-computed') {
    return refused(
      'MEASUREMENT_SCHEMA_MISMATCH',
      'Only tool-computed adaptive-control-case-measurement-v1 evidence is accepted.'
    );
  }
  const sortedCaseIds = [...caseIds].sort();
  if (provenance.caseIdsSha256 !== adaptiveControlCaseIdsSha256(sortedCaseIds)) {
    return refused('CASE_SET_MISMATCH', 'Case IDs do not match their provenance binding.');
  }
  return { status: 'OK', caseIds: sortedCaseIds };
}

export function sealAdaptiveControlArmEvidence(input) {
  try {
    const role = record(input)?.armRole;
    const valid = validateArm(input, role, false);
    if (valid.status !== 'OK') return valid;
    return {
      status: 'OK',
      armEvidence: {
        ...input,
        armEvidenceSha256: sha256(canonicalAdaptiveJson(input))
      }
    };
  } catch {
    return refused('ARM_INVALID', 'Arm evidence must be finite plain JSON data.');
  }
}

function validateExpected(expected) {
  if (!exactKeys(expected, EXPECTED_KEYS)) {
    return refused(
      'EXPECTED_BINDING_REQUIRED',
      'Trusted supervisor bindings are required separately from the evidence payload.'
    );
  }
  if (!safeStringId(expected.runId) || !safeStringId(expected.testId)
      || ['benchmarkSha256', 'caseSetSha256', 'caseIdsSha256', 'oracleSha256',
        'evaluatorSha256', 'sourceEvidenceSha256']
        .some((field) => !sha(expected[field]))
      || !exactKeys(expected.armEvidenceSha256, ROLES)
      || ROLES.some((role) => !sha(expected.armEvidenceSha256[role]))) {
    return refused('EXPECTED_BINDING_INVALID', 'Trusted supervisor bindings are invalid.');
  }
  return { status: 'OK' };
}

function matchesExpected(provenance, expected) {
  return ['runId', 'testId', 'benchmarkSha256', 'caseSetSha256', 'caseIdsSha256',
    'oracleSha256', 'evaluatorSha256']
    .every((field) => provenance[field] === expected[field]);
}

function derive(source, expected) {
  const expectedResult = validateExpected(expected);
  if (expectedResult.status !== 'OK') return expectedResult;
  if (!exactKeys(source, ['schemaVersion', 'arms'])
      || source.schemaVersion !== ADAPTIVE_CONTROL_SOURCE_SCHEMA
      || !exactKeys(source.arms, ROLES)) {
    return refused(
      'SOURCE_SCHEMA_MISMATCH',
      'Source evidence requires exactly one baseline, routed, and sham arm.'
    );
  }
  const evidenceSha256 = sha256(canonicalAdaptiveJson(source));
  if (evidenceSha256 !== expected.sourceEvidenceSha256) {
    return refused('SOURCE_HASH_MISMATCH', 'Source evidence does not match its trusted hash.');
  }

  const caseIds = {};
  for (const role of ROLES) {
    const arm = source.arms[role];
    const valid = validateArm(arm, role, true);
    if (valid.status !== 'OK') return valid;
    const { armEvidenceSha256, ...payload } = arm;
    if (armEvidenceSha256 !== sha256(canonicalAdaptiveJson(payload))
        || armEvidenceSha256 !== expected.armEvidenceSha256[role]) {
      return refused('ARM_HASH_MISMATCH', `${role} evidence does not match its trusted hash.`);
    }
    if (!matchesExpected(arm.provenance, expected)) {
      return refused('PROVENANCE_MISMATCH', `${role} provenance does not match the test.`);
    }
    caseIds[role] = valid.caseIds;
  }
  const baselineIds = canonicalAdaptiveJson(caseIds.baseline);
  if (ROLES.some((role) => canonicalAdaptiveJson(caseIds[role]) !== baselineIds)) {
    return refused('CASE_SET_MISMATCH', 'All arms must cover the same paired cases.');
  }

  const maps = Object.fromEntries(ROLES.map((role) => [
    role,
    new Map(source.arms[role].measurements.map((row) => [row.caseId, row]))
  ]));
  const positiveSham = [];
  const controlRegressions = [];
  let shamTotal = 0;
  for (const caseId of caseIds.baseline) {
    const baseline = maps.baseline.get(caseId);
    const shamDelta = maps.sham.get(caseId).targetQuality - baseline.targetQuality;
    shamTotal += shamDelta;
    if (shamDelta > 0) positiveSham.push(caseId);
    if (maps.routed.get(caseId).controlQuality < baseline.controlQuality) {
      controlRegressions.push(caseId);
    }
  }
  const exactSham = shamTotal / caseIds.baseline.length;
  const shamMovement = Object.is(round(exactSham), -0) ? 0 : round(exactSham);
  if (exactSham !== 0 && shamMovement === 0) {
    return refused(
      'SHAM_MOVEMENT_PRECISION_LOSS',
      'Nonzero sham movement would round to engine-stable zero.'
    );
  }
  return {
    status: 'OK',
    controlEvidence: {
      runId: expected.runId,
      testId: expected.testId,
      controlRegressions: controlRegressions.length,
      shamMovement,
      evidenceSha256,
      automaticBankingEligible: positiveSham.length === 0
        && controlRegressions.length === 0
        && shamMovement === 0,
      reasonCodes: [
        ...(positiveSham.length ? ['POSITIVE_SHAM_MOVEMENT'] : []),
        ...(controlRegressions.length ? ['CONTROL_REGRESSION'] : []),
        ...(shamMovement < 0 ? ['NEGATIVE_SHAM_MOVEMENT'] : [])
      ]
    },
    sourceSummary: {
      schemaVersion: source.schemaVersion,
      measurementSchemaVersion: ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA,
      caseCount: caseIds.baseline.length,
      armEvidenceSha256: { ...expected.armEvidenceSha256 },
      positiveShamCaseIds: positiveSham,
      controlRegressionCaseIds: controlRegressions
    }
  };
}

export function deriveAdaptiveControlEvidence(source, expected) {
  try {
    return derive(source, expected);
  } catch {
    return refused('SOURCE_INVALID', 'Source evidence must be finite plain JSON data.');
  }
}
