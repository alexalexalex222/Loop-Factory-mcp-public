import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { isSafeId, nowIso, round, sha256 } from './util.mjs';

export const IMPROVEMENT_MECHANISM_SCHEMA_VERSION = 'improvement-mechanism-v1';

const PARTITIONS = new Set(['harvest', 'reference', 'gate']);
const VERDICTS = new Set([
  'improvement',
  'no_improvement',
  'tradeoff',
  'invalid',
  'regression'
]);
const TRANSFER_KINDS = new Set([
  'negativeControl',
  'heldOut',
  'metamorphic',
  'perturbation',
  'evidenceBinding',
  'freshReplay'
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const RECEIPT_ID_RE = /^receipt-[a-f0-9]{24}$/;
const MECHANISM_ID_RE = /^mech-[a-f0-9]{24}$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ARTIFACT_REF_KEYS = [
  'measurementRef',
  'rawArtifactRef',
  'resultArtifactRef',
  'evaluationArtifactRef',
  'proposalRawArtifactRef',
  'proposalResultArtifactRef'
];

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function safeIdOrNull(value) {
  return isSafeId(value) ? String(value) : null;
}

function shaOrNull(value) {
  const digest = String(value || '').toLowerCase();
  return SHA256_RE.test(digest) ? digest : null;
}

function text(value, max) {
  const string = String(value == null ? '' : value).trim();
  if (!string || string.includes('\0')) return null;
  return string.slice(0, max);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalValue(value[key]);
      return result;
    }, {});
}

export function canonicalMechanismJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function receiptPayload(receipt) {
  const { receiptId: _receiptId, receiptSha256: _receiptSha256, ...payload } = receipt;
  return payload;
}

function normalizedHome(homeDir) {
  if (typeof homeDir !== 'string' || !homeDir || homeDir.includes('\0') || !isAbsolute(homeDir)) {
    return null;
  }
  const normalized = normalize(homeDir);
  return normalized === homeDir ? resolve(homeDir) : null;
}

function ensureWithin(base, target) {
  return target === base || target.startsWith(`${base}${sep}`);
}

function iso(value, fallback) {
  const string = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T/.test(string) && Number.isFinite(Date.parse(string))
    ? string
    : fallback;
}

function firstIso(...values) {
  for (const value of values) {
    const timestamp = iso(value, null);
    if (timestamp) return timestamp;
  }
  return null;
}

function nullableNumber(value) {
  return value == null || Number.isFinite(value);
}

function nullableInteger(value) {
  return value == null || Number.isInteger(value);
}

function nullableSafeId(value) {
  return value == null || isSafeId(value);
}

function nullableSha(value) {
  return value == null || SHA256_RE.test(String(value));
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validMeasurementArm(arm) {
  return exactKeys(arm, [
    'quality',
    'tokenCost',
    'artifactOutputTokenEstimate',
    'cliReceiptTokenCost',
    'samples'
  ])
    && nullableNumber(arm.quality)
    && nullableNumber(arm.tokenCost)
    && nullableNumber(arm.artifactOutputTokenEstimate)
    && nullableNumber(arm.cliReceiptTokenCost)
    && nullableInteger(arm.samples);
}

function signatureTokens(values) {
  const seen = new Set();
  const tokens = [];
  for (const value of values) {
    for (const token of String(value || '').toLowerCase().split(/[^a-z0-9._-]+/)) {
      if (!TOKEN_RE.test(token) || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= 80) return tokens;
    }
  }
  return tokens;
}

function measurementArm(value = {}) {
  const arm = object(value);
  const agentRuns = Array.isArray(arm.agentRuns) ? arm.agentRuns : [];
  const samples = integer(arm.n) ?? (agentRuns.length || (finite(arm.quality) != null ? 1 : null));
  return {
    quality: finite(arm.quality),
    tokenCost: finite(arm.tokenCost),
    artifactOutputTokenEstimate: finite(
      arm.artifactOutputTokenEstimate ?? arm.tokenCost
    ),
    cliReceiptTokenCost: finite(arm.cliReceiptTokenCost),
    samples
  };
}

function delta(baseline, challenger) {
  const quality = baseline.quality != null && challenger.quality != null
    ? round(challenger.quality - baseline.quality)
    : null;
  const tokenCost = baseline.tokenCost != null && challenger.tokenCost != null
    ? round(challenger.tokenCost - baseline.tokenCost)
    : null;
  const tokenCostPct = tokenCost != null && baseline.tokenCost != null && baseline.tokenCost !== 0
    ? round(tokenCost / baseline.tokenCost)
    : null;
  return { quality, tokenCost, tokenCostPct };
}

function normalizeEvidenceRefs(values) {
  return (Array.isArray(values) ? values : [])
    .slice(0, 50)
    .map((value) => {
      const ref = object(value);
      const path = text(ref.path, 1000);
      const locator = text(ref.locator, 1000);
      if (!path || !locator) return null;
      return { path, locator, sha256: shaOrNull(ref.sha256) };
    })
    .filter(Boolean);
}

function collectArtifacts(state, test, readArtifact) {
  if (typeof readArtifact !== 'function') return { artifacts: [], complete: false };
  const ids = new Set();
  const baselineId = safeIdOrNull(state?.baseline?.artifactId);
  if (baselineId) ids.add(baselineId);
  const agentRuns = Array.isArray(test?.agentRuns) ? test.agentRuns : [];
  const measurementRefsComplete = agentRuns.length > 0
    && agentRuns.every((run) => safeIdOrNull(run && run.measurementRef));
  for (const run of agentRuns) {
    for (const key of ARTIFACT_REF_KEYS) {
      const artifactId = safeIdOrNull(run && run[key]);
      if (artifactId) ids.add(artifactId);
    }
  }
  const artifacts = [];
  const artifactIds = [...ids].sort();
  for (const artifactId of artifactIds.slice(0, 100)) {
    try {
      const record = readArtifact(state.runId, artifactId);
      const digest = shaOrNull(record && record.sha256);
      if (!digest) continue;
      artifacts.push({
        artifactId,
        role: text(record.role, 80),
        sha256: digest
      });
    } catch {
      // A missing or unreadable artifact makes the receipt weaker, never invented.
    }
  }
  return {
    artifacts: artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    complete: measurementRefsComplete
      && artifactIds.length <= 100
      && artifacts.length === artifactIds.length
  };
}

function transferChecks(state, overlay) {
  const checks = new Map();
  const negativeControl = state?.benchmark?.negativeControl;
  if (negativeControl && typeof negativeControl === 'object') {
    checks.set('negativeControl', {
      kind: 'negativeControl',
      attempted: true,
      passed: negativeControl.passed === false,
      evidenceSha256: shaOrNull(negativeControl.sha256)
    });
  }
  for (const value of Array.isArray(overlay?.transferChecks) ? overlay.transferChecks : []) {
    const check = object(value);
    if (!TRANSFER_KINDS.has(check.kind)) continue;
    checks.set(check.kind, {
      kind: check.kind,
      attempted: check.attempted === true,
      passed: typeof check.passed === 'boolean' ? check.passed : null,
      evidenceSha256: shaOrNull(check.evidenceSha256)
    });
  }
  return [...checks.values()];
}

function classifyOutcome({
  test,
  baseline,
  challenger,
  checks,
  overlay,
  artifactEvidenceComplete
}) {
  const explicit = VERDICTS.has(overlay?.verdict) ? overlay.verdict : null;
  const valid = Boolean(
    test
    && test.source === 'tool'
    && test.agg
    && artifactEvidenceComplete
  )
    && overlay?.valid !== false;
  const qualityDelta = baseline.quality != null && challenger.quality != null
    ? challenger.quality - baseline.quality
    : null;
  const transferFailed = checks.some((check) => check.attempted && check.passed === false);
  const controlsRegressed = integer(overlay?.controlRegressions) > 0;
  const regression = qualityDelta != null && qualityDelta < -1e-9;

  let verdict;
  if (!valid || !test) verdict = 'invalid';
  else if (regression || controlsRegressed || transferFailed || test.movement?.code === 'BELOW_FLOOR') {
    verdict = 'regression';
  } else if (test.verdict === 'MOVED_FRONTIER') verdict = 'improvement';
  else if (test.verdict === 'STAGED_TRADEOFF' || test.movement?.code === 'STAGED_TRADEOFF') {
    verdict = 'tradeoff';
  } else verdict = 'no_improvement';

  if (verdict !== 'invalid' && verdict !== 'regression') {
    if (explicit === 'invalid') verdict = 'invalid';
    else if (explicit === 'regression') verdict = 'regression';
    else if (explicit === 'no_improvement' && verdict !== 'no_improvement') {
      verdict = 'no_improvement';
    } else if (explicit === 'tradeoff' && verdict === 'improvement') {
      verdict = 'tradeoff';
    }
  }

  const code = text(
    overlay?.code
      ?? test?.movement?.code
      ?? test?.verdict
      ?? (test ? null : 'NO_PERSISTED_TEST'),
    120
  );
  return { verdict, code, valid: valid && verdict !== 'invalid' };
}

function classifyLifecycle(outcome, test, checks) {
  const transferFailed = checks.some((check) => check.attempted && check.passed === false);
  if (outcome.verdict === 'regression' || transferFailed) {
    return {
      state: 'contradicted',
      reason: transferFailed
        ? 'A recorded transfer check failed.'
        : 'Measured evidence regressed against the frozen baseline.'
    };
  }
  if (outcome.verdict === 'improvement' && test?.reverified === true
      && (integer(test?.agg?.n) ?? test?.agentRuns?.length ?? 0) >= 2) {
    return {
      state: 'replicated',
      reason: 'A multi-sample improvement was independently reverified.'
    };
  }
  return {
    state: 'observed',
    reason: outcome.valid
      ? 'The measured outcome is recorded without a replicated transferable claim.'
      : 'The attempted mechanism lacks a valid measured test.'
  };
}

export function buildImprovementMechanismReceipt({
  state,
  hypothesisId,
  testId = null,
  clock = nowIso,
  readArtifact = null,
  evidenceRefs = [],
  outcomeOverlay = {}
} = {}) {
  try {
    if (!state || typeof state !== 'object' || !isSafeId(state.runId)) {
      return refused('INVALID_RUN_STATE', 'A persisted state with a safe runId is required.');
    }
    if (!isSafeId(hypothesisId)) {
      return refused('INVALID_HYPOTHESIS_ID', 'hypothesisId must be a safe persisted ID.');
    }
    if (testId != null && !isSafeId(testId)) {
      return refused('INVALID_TEST_ID', 'testId must be null or a safe persisted ID.');
    }
    const hypothesis = (Array.isArray(state.hypotheses) ? state.hypotheses : [])
      .find((item) => item && item.id === hypothesisId);
    if (!hypothesis) {
      return refused('UNKNOWN_HYPOTHESIS', `No persisted hypothesis "${hypothesisId}".`);
    }
    const mechanism = {
      title: text(hypothesis.title, 500),
      bottleneck: text(hypothesis.bottleneck, 4000),
      operation: text(hypothesis.operation, 4000),
      expectedMovement: text(hypothesis.expectedMovement, 4000),
      falsifier: text(hypothesis.falsifier, 4000)
    };
    if (Object.values(mechanism).some((value) => !value)) {
      return refused(
        'INCOMPLETE_HYPOTHESIS',
        'The persisted hypothesis lacks a complete predeclared mechanism description.'
      );
    }

    const tests = Array.isArray(state.tests) ? state.tests : [];
    const test = testId
      ? tests.find((item) => item && item.id === testId) || null
      : tests.filter((item) => item && item.hypothesisId === hypothesisId).at(-1) || null;
    if (test && test.hypothesisId !== hypothesisId) {
      return refused('TEST_HYPOTHESIS_MISMATCH', 'The persisted test belongs to another hypothesis.');
    }
    let generatedAt = firstIso(
      outcomeOverlay?.observedAt,
      test?.reverifiedAt,
      test?.ts,
      state.updatedAt,
      state.createdAt
    );
    if (!generatedAt) {
      generatedAt = firstIso(typeof clock === 'function' ? clock() : null);
      if (!generatedAt) return refused('INVALID_CLOCK', 'clock must return an ISO timestamp.');
    }

    const benchmark = object(state.benchmark);
    const benchmarkDef = object(benchmark.def);
    const partition = PARTITIONS.has(benchmarkDef.benchPartition)
      ? benchmarkDef.benchPartition
      : 'reference';
    const baseline = measurementArm(benchmark.baselineScore);
    const challenger = measurementArm(test?.agg);
    const checks = transferChecks(state, outcomeOverlay);
    const artifactEvidence = collectArtifacts(state, test, readArtifact);
    const outcomeClass = classifyOutcome({
      test,
      baseline,
      challenger,
      checks,
      overlay: outcomeOverlay,
      artifactEvidenceComplete: artifactEvidence.complete
    });
    const observedAt = firstIso(test?.ts, outcomeOverlay?.observedAt, generatedAt);
    const reverifiedAt = test?.reverified === true
      ? firstIso(test.reverifiedAt, test.ts, generatedAt)
      : null;
    const findingId = safeIdOrNull(
      hypothesis.findingId ?? state.config?.realTest?.findingId
    );
    const policyId = safeIdOrNull(state.config?.metaLearning?.policyId);
    const policySha256 = shaOrNull(state.config?.metaLearning?.policySha256);
    const taskValueDimensions = (Array.isArray(benchmarkDef.taskValueDimensions)
      ? benchmarkDef.taskValueDimensions
      : []).map((value) => text(value, 120)).filter(Boolean).slice(0, 20);
    const resourceDimensions = (Array.isArray(benchmarkDef.resourceDimensions)
      ? benchmarkDef.resourceDimensions
      : []).map((value) => text(value, 120)).filter(Boolean).slice(0, 20);
    const target = {
      taskSha256: shaOrNull(state.task?.sha256),
      taskMode: text(state.task?.mode, 80),
      loopId: safeIdOrNull(state.activeLoop),
      taskValueDimensions,
      resourceDimensions,
      signatureTokens: signatureTokens([
        ...taskValueDimensions,
        ...resourceDimensions,
        mechanism.title,
        mechanism.bottleneck,
        mechanism.operation
      ])
    };
    const source = {
      runId: state.runId,
      findingId,
      hypothesisId,
      testId: safeIdOrNull(test?.id ?? testId),
      benchmarkId: safeIdOrNull(benchmarkDef.id),
      benchmarkSha256: Object.keys(benchmarkDef).length
        ? sha256(canonicalMechanismJson(benchmarkDef))
        : null,
      policyId,
      policySha256
    };
    const identity = {
      runId: source.runId,
      findingId: source.findingId,
      hypothesisId: source.hypothesisId,
      title: mechanism.title,
      bottleneck: mechanism.bottleneck,
      operation: mechanism.operation
    };
    const mechanismId = `mech-${sha256(canonicalMechanismJson(identity)).slice(0, 24)}`;
    const receipt = {
      schemaVersion: IMPROVEMENT_MECHANISM_SCHEMA_VERSION,
      mechanismId,
      generatedAt,
      partition,
      eligibleForRouting: partition === 'harvest' && outcomeClass.valid,
      source,
      target,
      mechanism,
      measurement: {
        baseline,
        challenger,
        delta: delta(baseline, challenger),
        qualityAuthority: text(test?.qualityAuthority, 80),
        reverified: test?.reverified === true,
        shamMovement: finite(outcomeOverlay?.shamMovement),
        controlRegressions: integer(outcomeOverlay?.controlRegressions),
        transferChecks: checks
      },
      outcome: {
        verdict: outcomeClass.verdict,
        code: outcomeClass.code,
        valid: outcomeClass.valid,
        observedAt,
        reverifiedAt
      },
      provenance: {
        evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
        artifacts: artifactEvidence.artifacts
      },
      lifecycle: classifyLifecycle(outcomeClass, test, checks)
    };
    const receiptSha256 = sha256(canonicalMechanismJson(receipt));
    const receiptId = `receipt-${receiptSha256.slice(0, 24)}`;
    return ok({
      receipt: {
        schemaVersion: receipt.schemaVersion,
        mechanismId: receipt.mechanismId,
        receiptId,
        receiptSha256,
        generatedAt: receipt.generatedAt,
        partition: receipt.partition,
        eligibleForRouting: receipt.eligibleForRouting,
        source: receipt.source,
        target: receipt.target,
        mechanism: receipt.mechanism,
        measurement: receipt.measurement,
        outcome: receipt.outcome,
        provenance: receipt.provenance,
        lifecycle: receipt.lifecycle
      }
    });
  } catch (error) {
    return refused('RECEIPT_BUILD_FAILED', error.message);
  }
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return refused('INVALID_RECEIPT', 'receipt must be an object.');
  }
  if (receipt.schemaVersion !== IMPROVEMENT_MECHANISM_SCHEMA_VERSION
      || !MECHANISM_ID_RE.test(String(receipt.mechanismId || ''))
      || !RECEIPT_ID_RE.test(String(receipt.receiptId || ''))
      || !SHA256_RE.test(String(receipt.receiptSha256 || ''))) {
    return refused('INVALID_RECEIPT', 'receipt identity does not match improvement-mechanism-v1.');
  }
  if (!PARTITIONS.has(receipt.partition) || !VERDICTS.has(receipt.outcome?.verdict)) {
    return refused('INVALID_RECEIPT', 'receipt partition or verdict is invalid.');
  }
  const source = object(receipt.source);
  const target = object(receipt.target);
  const mechanism = object(receipt.mechanism);
  const measurement = object(receipt.measurement);
  const outcome = object(receipt.outcome);
  const provenance = object(receipt.provenance);
  const lifecycle = object(receipt.lifecycle);
  const deltas = object(measurement.delta);
  const shapeValid = exactKeys(receipt, [
    'schemaVersion',
    'mechanismId',
    'receiptId',
    'receiptSha256',
    'generatedAt',
    'partition',
    'eligibleForRouting',
    'source',
    'target',
    'mechanism',
    'measurement',
    'outcome',
    'provenance',
    'lifecycle'
  ])
    && exactKeys(source, [
      'runId',
      'findingId',
      'hypothesisId',
      'testId',
      'benchmarkId',
      'benchmarkSha256',
      'policyId',
      'policySha256'
    ])
    && exactKeys(target, [
      'taskSha256',
      'taskMode',
      'loopId',
      'taskValueDimensions',
      'resourceDimensions',
      'signatureTokens'
    ])
    && exactKeys(mechanism, [
      'title',
      'bottleneck',
      'operation',
      'expectedMovement',
      'falsifier'
    ])
    && exactKeys(measurement, [
      'baseline',
      'challenger',
      'delta',
      'qualityAuthority',
      'reverified',
      'shamMovement',
      'controlRegressions',
      'transferChecks'
    ])
    && exactKeys(deltas, ['quality', 'tokenCost', 'tokenCostPct'])
    && exactKeys(outcome, ['verdict', 'code', 'valid', 'observedAt', 'reverifiedAt'])
    && exactKeys(provenance, ['evidenceRefs', 'artifacts'])
    && exactKeys(lifecycle, ['state', 'reason'])
    && iso(receipt.generatedAt, null) === receipt.generatedAt
    && typeof receipt.eligibleForRouting === 'boolean'
    && isSafeId(source.runId)
    && nullableSafeId(source.findingId)
    && isSafeId(source.hypothesisId)
    && nullableSafeId(source.testId)
    && nullableSafeId(source.benchmarkId)
    && nullableSha(source.benchmarkSha256)
    && nullableSafeId(source.policyId)
    && nullableSha(source.policySha256)
    && nullableSha(target.taskSha256)
    && (target.taskMode == null || (typeof target.taskMode === 'string' && target.taskMode.length <= 80))
    && nullableSafeId(target.loopId)
    && Array.isArray(target.taskValueDimensions)
    && target.taskValueDimensions.length <= 20
    && target.taskValueDimensions.every((value) => (
      typeof value === 'string' && value.length > 0 && value.length <= 120
    ))
    && Array.isArray(target.resourceDimensions)
    && target.resourceDimensions.length <= 20
    && target.resourceDimensions.every((value) => (
      typeof value === 'string' && value.length > 0 && value.length <= 120
    ))
    && Array.isArray(target.signatureTokens)
    && target.signatureTokens.length <= 80
    && target.signatureTokens.every((token) => TOKEN_RE.test(token))
    && ['title', 'bottleneck', 'operation', 'expectedMovement', 'falsifier']
      .every((key) => typeof mechanism[key] === 'string' && mechanism[key].length > 0)
    && mechanism.title.length <= 500
    && mechanism.bottleneck.length <= 4000
    && mechanism.operation.length <= 4000
    && mechanism.expectedMovement.length <= 4000
    && mechanism.falsifier.length <= 4000
    && validMeasurementArm(measurement.baseline)
    && validMeasurementArm(measurement.challenger)
    && nullableNumber(deltas.quality)
    && nullableNumber(deltas.tokenCost)
    && nullableNumber(deltas.tokenCostPct)
    && (measurement.qualityAuthority == null || (
      typeof measurement.qualityAuthority === 'string'
      && measurement.qualityAuthority.length <= 80
    ))
    && typeof measurement.reverified === 'boolean'
    && nullableNumber(measurement.shamMovement)
    && nullableInteger(measurement.controlRegressions)
    && Array.isArray(measurement.transferChecks)
    && measurement.transferChecks.length <= 20
    && measurement.transferChecks.every((check) => (
      exactKeys(check, ['kind', 'attempted', 'passed', 'evidenceSha256'])
      && TRANSFER_KINDS.has(check.kind)
      && typeof check.attempted === 'boolean'
      && (check.passed == null || typeof check.passed === 'boolean')
      && nullableSha(check.evidenceSha256)
    ))
    && typeof outcome.valid === 'boolean'
    && iso(outcome.observedAt, null) === outcome.observedAt
    && (outcome.reverifiedAt == null || iso(outcome.reverifiedAt, null) === outcome.reverifiedAt)
    && (outcome.code == null || (typeof outcome.code === 'string' && outcome.code.length <= 120))
    && Array.isArray(provenance.evidenceRefs)
    && provenance.evidenceRefs.length <= 50
    && provenance.evidenceRefs.every((ref) => (
      exactKeys(ref, ['path', 'locator', 'sha256'])
      && typeof ref.path === 'string' && ref.path.length > 0 && ref.path.length <= 1000
      && typeof ref.locator === 'string' && ref.locator.length > 0 && ref.locator.length <= 1000
      && nullableSha(ref.sha256)
    ))
    && Array.isArray(provenance.artifacts)
    && provenance.artifacts.length <= 100
    && provenance.artifacts.every((artifact) => (
      exactKeys(artifact, ['artifactId', 'role', 'sha256'])
      && isSafeId(artifact.artifactId)
      && (artifact.role == null || (
        typeof artifact.role === 'string' && artifact.role.length <= 80
      ))
      && SHA256_RE.test(String(artifact.sha256 || ''))
    ))
    && ['observed', 'replicated', 'contradicted'].includes(lifecycle.state)
    && typeof lifecycle.reason === 'string'
    && lifecycle.reason.length > 0
    && lifecycle.reason.length <= 1000;
  if (!shapeValid) {
    return refused('INVALID_RECEIPT', 'receipt does not satisfy the frozen required shape.');
  }
  if ((receipt.partition !== 'harvest' || receipt.outcome?.valid !== true)
      && receipt.eligibleForRouting === true) {
    return refused(
      'INVALID_RECEIPT',
      'only valid harvest receipts may be routing eligible.'
    );
  }
  const recomputed = sha256(canonicalMechanismJson(receiptPayload(receipt)));
  if (recomputed !== receipt.receiptSha256
      || `receipt-${recomputed.slice(0, 24)}` !== receipt.receiptId) {
    return refused('RECEIPT_HASH_MISMATCH', 'receipt bytes do not match the declared receipt hash.');
  }
  return ok();
}

function ledgerEntry(receipt) {
  return {
    receiptId: receipt.receiptId,
    receiptSha256: receipt.receiptSha256,
    mechanismId: receipt.mechanismId,
    generatedAt: receipt.generatedAt,
    partition: receipt.partition,
    eligibleForRouting: receipt.eligibleForRouting,
    verdict: receipt.outcome.verdict,
    lifecycle: receipt.lifecycle.state,
    path: `receipts/${receipt.receiptId}.json`
  };
}

function ledgerStatus(ledgerPath, receipt) {
  if (!existsSync(ledgerPath)) return { found: false, conflict: false };
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.receiptId !== receipt.receiptId) continue;
      return {
        found: true,
        conflict: entry.receiptSha256 !== receipt.receiptSha256
      };
    } catch {
      return { found: false, conflict: true };
    }
  }
  return { found: false, conflict: false };
}

export function persistImprovementMechanismReceipt({ homeDir, receipt } = {}) {
  try {
    const validation = validateReceipt(receipt);
    if (validation.status !== 'OK') return validation;
    const home = normalizedHome(homeDir);
    if (!home) {
      return refused(
        'UNSAFE_HOME',
        'homeDir must be a normalized absolute path without traversal or NUL bytes.'
      );
    }
    const mechanismsRoot = resolve(home, 'mechanisms');
    const receiptsRoot = resolve(mechanismsRoot, 'receipts');
    const receiptPath = resolve(receiptsRoot, `${receipt.receiptId}.json`);
    const ledgerPath = resolve(mechanismsRoot, 'ledger.jsonl');
    if (!ensureWithin(home, mechanismsRoot)
        || !ensureWithin(mechanismsRoot, receiptsRoot)
        || !ensureWithin(receiptsRoot, receiptPath)
        || !ensureWithin(mechanismsRoot, ledgerPath)) {
      return refused('PATH_ESCAPE', 'mechanism persistence escaped the configured home.');
    }
    for (const path of [home, mechanismsRoot, receiptsRoot, receiptPath, ledgerPath]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        return refused('SYMLINK_REFUSED', 'mechanism persistence refuses symbolic-link paths.');
      }
    }
    const indexed = ledgerStatus(ledgerPath, receipt);
    if (indexed.conflict) {
      return refused(
        'LEDGER_CONFLICT',
        `Ledger entry for ${receipt.receiptId} conflicts with the receipt hash.`,
        { receiptPath, ledgerPath }
      );
    }
    mkdirSync(receiptsRoot, { recursive: true });
    const bytes = `${canonicalMechanismJson(receipt)}\n`;
    let idempotent = false;
    try {
      writeFileSync(receiptPath, bytes, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readFileSync(receiptPath, 'utf8');
      if (existing !== bytes) {
        return refused(
          'RECEIPT_CONFLICT',
          `Immutable receipt ${receipt.receiptId} already exists with different bytes.`,
          { receiptPath }
        );
      }
      idempotent = true;
    }
    if (!indexed.found) {
      appendFileSync(ledgerPath, `${canonicalMechanismJson(ledgerEntry(receipt))}\n`, 'utf8');
    }
    return ok({
      receiptId: receipt.receiptId,
      receiptSha256: receipt.receiptSha256,
      receiptPath,
      ledgerPath,
      idempotent,
      indexed: true
    });
  } catch (error) {
    return refused('RECEIPT_PERSIST_FAILED', error.message);
  }
}

export function listImprovementMechanismReceipts({
  homeDir,
  partitions = ['harvest'],
  includeIneligible = false
} = {}) {
  try {
    const home = normalizedHome(homeDir);
    if (!home) {
      return refused(
        'UNSAFE_HOME',
        'homeDir must be a normalized absolute path without traversal or NUL bytes.'
      );
    }
    const requested = Array.isArray(partitions) ? [...new Set(partitions)] : [];
    if (!requested.length || requested.some((partition) => !PARTITIONS.has(partition))) {
      return refused('INVALID_PARTITION_FILTER', 'partitions must contain harvest, reference, or gate.');
    }
    const mechanismsRoot = resolve(home, 'mechanisms');
    const receiptsRoot = resolve(mechanismsRoot, 'receipts');
    if (!ensureWithin(home, mechanismsRoot)
        || !ensureWithin(mechanismsRoot, receiptsRoot)) {
      return refused('PATH_ESCAPE', 'mechanism listing escaped the configured home.');
    }
    for (const path of [home, mechanismsRoot, receiptsRoot]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
        return refused('SYMLINK_REFUSED', 'mechanism listing refuses symbolic-link paths.');
      }
    }
    if (!existsSync(receiptsRoot)) return ok({ receipts: [], rejected: [] });
    const receipts = [];
    const rejected = [];
    for (const filename of readdirSync(receiptsRoot).sort()) {
      if (!/^receipt-[a-f0-9]{24}\.json$/.test(filename)) continue;
      const receiptPath = resolve(receiptsRoot, filename);
      if (!ensureWithin(receiptsRoot, receiptPath)) {
        rejected.push({ filename, code: 'PATH_ESCAPE' });
        continue;
      }
      if (lstatSync(receiptPath).isSymbolicLink()) {
        rejected.push({ filename, code: 'SYMLINK_REFUSED' });
        continue;
      }
      try {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        const validation = validateReceipt(receipt);
        if (validation.status !== 'OK') {
          rejected.push({ filename, code: validation.code });
          continue;
        }
        if (!requested.includes(receipt.partition)) continue;
        if (!includeIneligible && receipt.eligibleForRouting !== true) continue;
        receipts.push(receipt);
      } catch {
        rejected.push({ filename, code: 'RECEIPT_PARSE_FAILED' });
      }
    }
    receipts.sort((a, b) => (
      String(a.generatedAt).localeCompare(String(b.generatedAt))
      || a.receiptId.localeCompare(b.receiptId)
    ));
    return ok({ receipts, rejected });
  } catch (error) {
    return refused('RECEIPT_LIST_FAILED', error.message);
  }
}

export function summarizeImprovementMechanisms(receipts) {
  try {
    const list = Array.isArray(receipts) ? receipts : [];
    const valid = [];
    let invalidEntries = 0;
    for (const receipt of list) {
      if (validateReceipt(receipt).status === 'OK') valid.push(receipt);
      else invalidEntries++;
    }
    const byVerdict = Object.fromEntries([...VERDICTS].map((verdict) => [verdict, 0]));
    const byLifecycle = { observed: 0, replicated: 0, contradicted: 0 };
    const byPartition = { harvest: 0, reference: 0, gate: 0 };
    let eligible = 0;
    for (const receipt of valid) {
      byVerdict[receipt.outcome.verdict]++;
      byLifecycle[receipt.lifecycle.state]++;
      byPartition[receipt.partition]++;
      if (receipt.eligibleForRouting === true) eligible++;
    }
    return ok({
      summary: {
        total: valid.length,
        uniqueMechanisms: new Set(valid.map((receipt) => receipt.mechanismId)).size,
        eligibleForRouting: eligible,
        ineligibleForRouting: valid.length - eligible,
        byVerdict,
        byLifecycle,
        byPartition,
        invalidEntries
      }
    });
  } catch (error) {
    return refused('RECEIPT_SUMMARY_FAILED', error.message);
  }
}
