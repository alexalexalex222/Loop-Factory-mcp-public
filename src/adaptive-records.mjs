import { isSafeId, round, sha256 } from './util.mjs';
import { normalizeMechanismProgram } from './mechanism-compiler.mjs';
import {
  ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2,
  validateAdaptiveMeasurementRecord
} from './adaptive-measurement-v2.mjs';
import {
  MECHANISM_EVOLUTION_SCHEMA_VERSION,
  validateMechanismEvolutionRecord
} from './mechanism-evolution-records.mjs';

export const ADAPTIVE_SCHEMA = Object.freeze({
  FAMILY: 'mechanism-family-v1',
  APPLICATION: 'mechanism-application-v1',
  CANARY_IMPORT: 'adaptive-canary-import-v1',
  MEASUREMENT: ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2,
  EVOLUTION: MECHANISM_EVOLUTION_SCHEMA_VERSION,
  ROUTING_DECISION: 'routing-decision-v1',
  POLICY_EPOCH: 'meta-policy-epoch-v1',
  AUTO_PROMOTION: 'automatic-promotion-decision-v1'
});

export const ADAPTIVE_POLICY_FIELDS = Object.freeze([
  'allocations.related',
  'allocations.adjacent',
  'allocations.failureDerived',
  'allocations.wildcard',
  'scoring.relevanceWeight',
  'scoring.confidenceWeight',
  'scoring.positiveEffectWeight',
  'scoring.contradictionPenaltyWeight',
  'penalties.cooldown',
  'penalties.failedTransfer'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REASON_RE = /^[A-Z0-9][A-Z0-9_]{0,119}$/;
const PARTITIONS = new Set(['harvest', 'reference', 'gate']);
const OUTCOMES = new Set(['improvement', 'no_improvement', 'tradeoff', 'invalid', 'regression']);
const ROUTING_MODES = new Set(['shadow', 'active-canary']);
const ROUTING_STATUS = new Set(['COMPLETE', 'PARTIAL', 'ABSTAINED', 'FALLBACK']);
const ALLOCATIONS = new Set(['control', 'related', 'adjacent', 'failure-derived', 'wildcard']);
const POLICY_TRIGGERS = new Set(['initial', 'valid-attempt-window', 'lane-boundary', 'rollback']);
const AUTO_DISPOSITIONS = new Set(['AUTO_BANK_INTERNAL', 'QUEUE_HUMAN_REVIEW']);
const TRANSFER_KINDS = new Set([
  'negativeControl',
  'heldOut',
  'metamorphic',
  'perturbation',
  'evidenceBinding',
  'freshReplay'
]);

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

export function canonicalAdaptiveJson(value) {
  return JSON.stringify(stableValue(value));
}

function ok(record) {
  return { status: 'OK', record };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function finite(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function nullableFinite(value) {
  return value == null || Number.isFinite(value);
}

function nullableInteger(value) {
  return value == null || Number.isInteger(value);
}

function normalizedKind(value) {
  const normalized = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return KIND_RE.test(normalized) ? normalized : null;
}

function normalizedKinds(values, max = 40) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizedKind)
    .filter(Boolean))]
    .sort()
    .slice(0, max);
}

function normalizedOrderedKinds(values, max = 24) {
  if (!Array.isArray(values) || values.length < 1 || values.length > max) {
    return null;
  }
  const normalized = values.map(normalizedKind);
  if (normalized.some((value) => !value)
      || new Set(normalized).size !== normalized.length) {
    return null;
  }
  return normalized;
}

function normalizedReasons(values, max = 50) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter((value) => REASON_RE.test(value)))]
    .sort()
    .slice(0, max);
}

function safeOrNull(value) {
  return value == null || value === '' ? null : (isSafeId(value) ? String(value) : null);
}

function shaOrNull(value) {
  const normalized = String(value || '').toLowerCase();
  return SHA256_RE.test(normalized) ? normalized : null;
}

function isoOrNull(value) {
  const normalized = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T/.test(normalized) && Number.isFinite(Date.parse(normalized))
    ? normalized
    : null;
}

function normalizedSeed(value) {
  return `seed-${sha256(String(value || 'adaptive-policy-default')).slice(0, 24)}`;
}

function sealRecord(payload, { idField, hashField, prefix }) {
  const digest = sha256(canonicalAdaptiveJson(payload));
  return {
    ...payload,
    [idField]: `${prefix}-${digest.slice(0, 24)}`,
    [hashField]: digest
  };
}

function recordPayload(record, idField, hashField) {
  const payload = { ...record };
  delete payload[idField];
  delete payload[hashField];
  return payload;
}

function verifySeal(record, { idField, hashField, prefix }) {
  const digest = sha256(canonicalAdaptiveJson(recordPayload(record, idField, hashField)));
  return record[hashField] === digest && record[idField] === `${prefix}-${digest.slice(0, 24)}`;
}

export function normalizeCausalFingerprint(input = {}) {
  const source = object(input.causalFingerprint || input);
  const applicability = object(source.applicability);
  const hasProcedureSteps = Object.hasOwn(source, 'procedureSteps');
  const hasProgram = Object.hasOwn(source, 'program');
  const procedureSteps = hasProcedureSteps
    ? normalizedOrderedKinds(source.procedureSteps)
    : null;
  const normalizedProgram = hasProgram
    ? normalizeMechanismProgram(source.program)
    : null;
  if (hasProgram && normalizedProgram.status !== 'OK') {
    return refused(
      'INVALID_CAUSAL_FINGERPRINT',
      `Executable mechanism program is invalid: ${normalizedProgram.code}.`
    );
  }
  const fingerprint = {
    bottleneckKind: normalizedKind(source.bottleneckKind),
    interventionKind: normalizedKind(source.interventionKind),
    operationKind: normalizedKind(source.operationKind),
    expectedEffectKind: normalizedKind(source.expectedEffectKind),
    preconditions: normalizedKinds(source.preconditions),
    ...(hasProcedureSteps ? { procedureSteps } : {}),
    ...(hasProgram && normalizedProgram.status === 'OK'
      ? { program: normalizedProgram.program }
      : {}),
    applicability: {
      taskModes: normalizedKinds(applicability.taskModes),
      loopRoles: normalizedKinds(applicability.loopRoles),
      taskValueDimensions: normalizedKinds(applicability.taskValueDimensions),
      resourceDimensions: normalizedKinds(applicability.resourceDimensions)
    }
  };
  if ([
    fingerprint.bottleneckKind,
    fingerprint.interventionKind,
    fingerprint.operationKind,
    fingerprint.expectedEffectKind,
    ...(hasProcedureSteps ? [procedureSteps] : [])
  ].some((value) => !value)) {
    return refused(
      'INVALID_CAUSAL_FINGERPRINT',
      'A family needs normalized bottleneck, intervention, operation, expected-effect, and optional ordered procedure kinds.'
    );
  }
  return { status: 'OK', fingerprint };
}

export function createMechanismFamilyRecord(input = {}) {
  const normalized = normalizeCausalFingerprint(input);
  if (normalized.status !== 'OK') return normalized;
  const fingerprintSha256 = sha256(canonicalAdaptiveJson(normalized.fingerprint));
  const familyId = `family-${fingerprintSha256.slice(0, 24)}`;
  const payload = {
    schemaVersion: ADAPTIVE_SCHEMA.FAMILY,
    familyId,
    fingerprintSha256,
    causalFingerprint: normalized.fingerprint
  };
  return ok({
    ...payload,
    familySha256: sha256(canonicalAdaptiveJson(payload))
  });
}

function normalizedTransferChecks(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      const check = object(value);
      if (!TRANSFER_KINDS.has(check.kind)) return null;
      return {
        kind: check.kind,
        attempted: check.attempted === true,
        passed: typeof check.passed === 'boolean' ? check.passed : null,
        evidenceSha256: shaOrNull(check.evidenceSha256)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

export function createMechanismApplicationRecord(input = {}) {
  try {
    const source = object(input.source);
    const context = object(input.context);
    const routing = object(input.routing);
    const outcome = object(input.outcome);
    const credit = object(input.credit);
    const provenance = object(input.provenance);
    const familyId = /^family-[a-f0-9]{24}$/.test(String(input.familyId || ''))
      ? String(input.familyId)
      : null;
    const runId = isSafeId(source.runId) ? String(source.runId) : null;
    const hypothesisId = isSafeId(source.hypothesisId) ? String(source.hypothesisId) : null;
    const testId = safeOrNull(source.testId);
    const targetSha256 = shaOrNull(context.targetSha256);
    const partition = PARTITIONS.has(input.partition) ? input.partition : null;
    const verdict = OUTCOMES.has(outcome.verdict) ? outcome.verdict : null;
    const appliedAt = isoOrNull(input.appliedAt);
    if (!familyId || !runId || !hypothesisId || source.testId != null && testId == null
        || !targetSha256 || !partition || !verdict || !appliedAt) {
      return refused('INVALID_APPLICATION', 'Application identity, partition, outcome, or timestamp is invalid.');
    }
    const routingDecisionId = routing.routingDecisionId == null
      ? null
      : (/^route-[a-f0-9]{24}$/.test(String(routing.routingDecisionId))
          ? String(routing.routingDecisionId)
          : null);
    const policyEpochId = routing.policyEpochId == null
      ? null
      : (/^epoch-[a-f0-9]{24}$/.test(String(routing.policyEpochId))
          ? String(routing.policyEpochId)
          : null);
    const allocation = routing.allocation == null
      ? null
      : (ALLOCATIONS.has(routing.allocation) ? routing.allocation : null);
    const schedulePosition = routing.schedulePosition == null
      ? null
      : (Number.isInteger(routing.schedulePosition) && routing.schedulePosition >= 0
          ? routing.schedulePosition
          : null);
    if (routing.routingDecisionId != null && !routingDecisionId
        || routing.policyEpochId != null && !policyEpochId
        || routing.allocation != null && !allocation
        || routing.schedulePosition != null && schedulePosition == null) {
      return refused('INVALID_APPLICATION_BINDING', 'Application routing IDs are malformed.');
    }
    const routingBound = routingDecisionId != null;
    if (routingBound && (
      !shaOrNull(routing.routingDecisionSha256)
      || !shaOrNull(routing.routingPacketSha256)
      || !policyEpochId
      || !shaOrNull(routing.policyEpochSha256)
      || !allocation
      || schedulePosition == null
    )) {
      return refused(
        'INCOMPLETE_APPLICATION_BINDING',
        'A routed application must bind the packet, policy epoch, allocation, and schedule position.'
      );
    }
    if (!routingBound && (
      routing.routingDecisionSha256 != null
      || routing.routingPacketSha256 != null
      || policyEpochId != null
      || routing.policyEpochSha256 != null
      || allocation != null
      || schedulePosition != null
    )) {
      return refused(
        'ORPHAN_APPLICATION_BINDING',
        'Application routing fields require a routingDecisionId.'
      );
    }
    const identity = {
      familyId,
      source: { runId, hypothesisId, testId },
      targetSha256,
      routingDecisionId,
      routingDecisionSha256: shaOrNull(routing.routingDecisionSha256),
      routingPacketSha256: shaOrNull(routing.routingPacketSha256),
      allocation,
      schedulePosition
    };
    const applicationId = `application-${sha256(canonicalAdaptiveJson(identity)).slice(0, 24)}`;
    const normalizedOutcome = {
      verdict,
      valid: outcome.valid === true,
      qualityDelta: finite(outcome.qualityDelta),
      tokenCostDeltaPct: finite(outcome.tokenCostDeltaPct),
      shamMovement: finite(outcome.shamMovement),
      controlRegressions: Number.isInteger(outcome.controlRegressions)
        ? outcome.controlRegressions
        : null,
      reverified: outcome.reverified === true,
      transferChecks: normalizedTransferChecks(outcome.transferChecks),
      contradictionCodes: normalizedReasons(outcome.contradictionCodes)
    };
    const failedTransfer = normalizedOutcome.transferChecks.some((check) => (
      check.attempted && check.passed === false
    ));
    const controlRegression = normalizedOutcome.controlRegressions != null
      && normalizedOutcome.controlRegressions > 0;
    const positiveEvidence = normalizedOutcome.valid
      && verdict === 'improvement'
      && !failedTransfer
      && !controlRegression
      && normalizedOutcome.contradictionCodes.length === 0;
    const failureDerived = normalizedOutcome.valid
      && ['no_improvement', 'tradeoff', 'regression'].includes(verdict)
      || normalizedOutcome.valid
        && verdict === 'improvement'
        && (failedTransfer || controlRegression || normalizedOutcome.contradictionCodes.length > 0);
    const normalizedProvenance = {
      legacyReceiptId: /^receipt-[a-f0-9]{24}$/.test(String(provenance.legacyReceiptId || ''))
        ? String(provenance.legacyReceiptId)
        : null,
      legacyReceiptSha256: shaOrNull(provenance.legacyReceiptSha256),
      benchmarkSha256: shaOrNull(provenance.benchmarkSha256),
      artifactSetSha256: shaOrNull(provenance.artifactSetSha256),
      evidenceSetSha256: shaOrNull(provenance.evidenceSetSha256)
    };
    const routable = partition === 'harvest' && normalizedOutcome.valid;
    if (routable && (!testId
        || Object.values(normalizedProvenance).some((value) => value == null))) {
      return refused(
        'INCOMPLETE_APPLICATION_PROVENANCE',
        'A routable harvest application requires a persisted test and complete legacy, benchmark, artifact, and evidence hashes.'
      );
    }
    const payload = {
      schemaVersion: ADAPTIVE_SCHEMA.APPLICATION,
      applicationId,
      familyId,
      appliedAt,
      partition,
      eligibleForRouting: routable,
      source: { runId, hypothesisId, testId },
      context: {
        targetSha256,
        taskMode: normalizedKind(context.taskMode),
        loopRole: normalizedKind(context.loopRole),
        taskValueDimensions: normalizedKinds(context.taskValueDimensions),
        resourceDimensions: normalizedKinds(context.resourceDimensions)
      },
      routing: {
        routingDecisionId,
        routingDecisionSha256: shaOrNull(routing.routingDecisionSha256),
        routingPacketSha256: shaOrNull(routing.routingPacketSha256),
        policyEpochId,
        policyEpochSha256: shaOrNull(routing.policyEpochSha256),
        allocation,
        schedulePosition
      },
      outcome: normalizedOutcome,
      credit: {
        confidence: finite(credit.confidence) == null
          ? null
          : round(Math.max(0, Math.min(1, finite(credit.confidence)))),
        authority: normalizedKind(credit.authority),
        positiveEvidence,
        failureDerived
      },
      provenance: normalizedProvenance
    };
    return ok(sealRecord(payload, {
      idField: 'applicationReceiptId',
      hashField: 'applicationSha256',
      prefix: 'app-receipt'
    }));
  } catch (error) {
    return refused('APPLICATION_BUILD_FAILED', error.message);
  }
}

export function createAdaptiveCanaryImportRecord(input = {}) {
  try {
    const source = object(input.source);
    const context = object(input.context);
    const routing = object(input.routing);
    const outcome = object(input.outcome);
    const authority = object(input.authority);
    const evidence = object(input.evidence);
    const familyId = /^family-[a-f0-9]{24}$/.test(String(input.familyId || ''))
      ? String(input.familyId)
      : null;
    const runId = isSafeId(source.runId) ? String(source.runId) : null;
    const targetSha256 = shaOrNull(context.targetSha256);
    const routingDecisionId = /^route-[a-f0-9]{24}$/.test(String(routing.routingDecisionId || ''))
      ? String(routing.routingDecisionId)
      : null;
    const policyEpochId = /^epoch-[a-f0-9]{24}$/.test(String(routing.policyEpochId || ''))
      ? String(routing.policyEpochId)
      : null;
    const allocation = ALLOCATIONS.has(routing.allocation) && routing.allocation !== 'control'
      ? routing.allocation
      : null;
    const schedulePosition = Number.isInteger(routing.schedulePosition)
      && routing.schedulePosition >= 0
      ? routing.schedulePosition
      : null;
    if (!familyId || !runId || !targetSha256 || !routingDecisionId || !policyEpochId
        || !allocation || schedulePosition == null) {
      return refused(
        'INVALID_CANARY_IMPORT_IDENTITY',
        'A canary import requires a family, source run, target, and non-control routing binding.'
      );
    }
    const routingDecisionSha256 = shaOrNull(routing.routingDecisionSha256);
    const routingPacketSha256 = shaOrNull(routing.routingPacketSha256);
    const policyEpochSha256 = shaOrNull(routing.policyEpochSha256);
    if (!routingDecisionSha256 || !routingPacketSha256 || !policyEpochSha256) {
      return refused(
        'INVALID_CANARY_IMPORT_ROUTING',
        'A canary import must bind the source routing decision, packet, and policy epoch.'
      );
    }
    const qualityDelta = finite(outcome.qualityDelta);
    const tokenCostDeltaPct = finite(outcome.tokenCostDeltaPct);
    const shamMovement = finite(outcome.shamMovement);
    const controlRegressions = Number.isInteger(outcome.controlRegressions)
      ? outcome.controlRegressions
      : null;
    const targetRegressions = Number.isInteger(outcome.targetRegressions)
      ? outcome.targetRegressions
      : null;
    const shamWins = Number.isInteger(outcome.shamWins) ? outcome.shamWins : null;
    const transferChecks = normalizedTransferChecks(outcome.transferChecks);
    const transferKinds = new Set(transferChecks.map((check) => check.kind));
    if (!(qualityDelta > 0) || tokenCostDeltaPct == null || shamMovement !== 0
        || controlRegressions !== 0 || targetRegressions !== 0 || shamWins !== 0
        || transferChecks.length !== transferKinds.size
        || !['heldOut', 'negativeControl', 'freshReplay'].every((kind) => (
          transferKinds.has(kind)
        ))
        || transferChecks.some((check) => (
          check.attempted !== true || check.passed !== true || !check.evidenceSha256
        ))) {
      return refused(
        'INVALID_CANARY_IMPORT_OUTCOME',
        'A routable canary import requires positive paired quality, complete controls, and passing transfer evidence.'
      );
    }
    const evidenceHashFields = [
      'configSha256',
      'planSha256',
      'verifierEvidenceSha256',
      'familySha256',
      'programSha256',
      'evaluatorAuthoritySha256',
      'interfaceSetSha256',
      'caseSetSha256',
      'compilationSetSha256',
      'evaluationArtifactSetSha256',
      'tokenReceiptSetSha256',
      'measurementSha256',
      'mechanismCapsuleSha256'
    ];
    const evidenceHashes = Object.fromEntries(
      evidenceHashFields.map((field) => [field, shaOrNull(evidence[field])])
    );
    const rawEvaluationHashes = Array.isArray(evidence.evaluationArtifactSha256s)
      ? evidence.evaluationArtifactSha256s
      : [];
    const evaluationArtifactSha256s = rawEvaluationHashes.map(shaOrNull).sort();
    const confirmationCaseCount = Number.isInteger(evidence.confirmationCaseCount)
      && evidence.confirmationCaseCount > 0
      ? evidence.confirmationCaseCount
      : null;
    const evaluationArtifactCount = Number.isInteger(evidence.evaluationArtifactCount)
      && evidence.evaluationArtifactCount > 0
      ? evidence.evaluationArtifactCount
      : null;
    const rawTokenReceiptHashes = Array.isArray(evidence.tokenReceiptArtifactSha256s)
      ? evidence.tokenReceiptArtifactSha256s
      : [];
    const tokenReceiptArtifactSha256s = rawTokenReceiptHashes.map(shaOrNull).sort();
    const tokenReceiptArtifactCount = Number.isInteger(evidence.tokenReceiptArtifactCount)
      && evidence.tokenReceiptArtifactCount > 0
      ? evidence.tokenReceiptArtifactCount
      : null;
    if (Object.values(evidenceHashes).some((value) => value == null)
        || evaluationArtifactSha256s.some((value) => value == null)
        || tokenReceiptArtifactSha256s.some((value) => value == null)
        || confirmationCaseCount == null || evaluationArtifactCount == null
        || tokenReceiptArtifactCount == null
        || evaluationArtifactSha256s.length !== evaluationArtifactCount
        || tokenReceiptArtifactSha256s.length !== tokenReceiptArtifactCount) {
      return refused(
        'INVALID_CANARY_IMPORT_EVIDENCE',
        'A canary import must bind every verifier, mechanism, evaluator, case, compilation, evaluation, and token receipt hash.'
      );
    }
    if (source.kind !== 'adaptive-executable-canary-v4'
        || authority.profile !== 'adaptive-executable-canary-v4'
        || authority.model !== 'gpt-5.6-sol'
        || authority.authMode !== 'chatgpt-oauth'
        || authority.fixtureOnly !== false
        || authority.verificationStatus !== 'PASS'
        || authority.experimentValid !== true
        || authority.causalPass !== true
        || authority.allVerifierGatesPassed !== true
        || authority.retries !== 0
        || authority.promotionRecorded !== false
        || authority.activation !== 'routing-only') {
      return refused(
        'INVALID_CANARY_IMPORT_AUTHORITY',
        'A canary import requires exact V4, GPT-5.6 Sol OAuth, non-fixture, zero-retry, no-promotion verifier authority.'
      );
    }
    const normalizedContext = {
      targetSha256,
      taskMode: normalizedKind(context.taskMode),
      loopRole: normalizedKind(context.loopRole),
      taskValueDimensions: normalizedKinds(context.taskValueDimensions),
      resourceDimensions: normalizedKinds(context.resourceDimensions)
    };
    if (!normalizedContext.taskMode || !normalizedContext.loopRole) {
      return refused(
        'INVALID_CANARY_IMPORT_CONTEXT',
        'A canary import needs normalized task-mode and loop-role applicability.'
      );
    }
    const identity = {
      schemaVersion: ADAPTIVE_SCHEMA.CANARY_IMPORT,
      familyId,
      runId,
      verifierEvidenceSha256: evidenceHashes.verifierEvidenceSha256
    };
    const payload = {
      schemaVersion: ADAPTIVE_SCHEMA.CANARY_IMPORT,
      applicationId: `application-${sha256(canonicalAdaptiveJson(identity)).slice(0, 24)}`,
      familyId,
      partition: 'harvest',
      eligibleForRouting: true,
      source: {
        kind: 'adaptive-executable-canary-v4',
        runId
      },
      context: normalizedContext,
      routing: {
        routingDecisionId,
        routingDecisionSha256,
        routingPacketSha256,
        policyEpochId,
        policyEpochSha256,
        allocation,
        schedulePosition
      },
      outcome: {
        verdict: 'improvement',
        valid: true,
        qualityDelta: round(qualityDelta),
        tokenCostDeltaPct: round(tokenCostDeltaPct),
        shamMovement: 0,
        controlRegressions: 0,
        targetRegressions: 0,
        shamWins: 0,
        reverified: true,
        transferChecks,
        contradictionCodes: []
      },
      credit: {
        confidence: 1,
        authority: 'tool-computed',
        positiveEvidence: true,
        failureDerived: false
      },
      authority: {
        profile: 'adaptive-executable-canary-v4',
        model: 'gpt-5.6-sol',
        authMode: 'chatgpt-oauth',
        fixtureOnly: false,
        verificationStatus: 'PASS',
        experimentValid: true,
        causalPass: true,
        allVerifierGatesPassed: true,
        retries: 0,
        promotionRecorded: false,
        activation: 'routing-only'
      },
      evidence: {
        ...evidenceHashes,
        confirmationCaseCount,
        evaluationArtifactCount,
        evaluationArtifactSha256s,
        tokenReceiptArtifactCount,
        tokenReceiptArtifactSha256s
      }
    };
    return ok(sealRecord(payload, {
      idField: 'applicationReceiptId',
      hashField: 'applicationSha256',
      prefix: 'app-receipt'
    }));
  } catch (error) {
    return refused('CANARY_IMPORT_BUILD_FAILED', error.message);
  }
}

function applicationInvariant(record) {
  return canonicalAdaptiveJson({
    familyId: record.familyId,
    partition: record.partition,
    source: record.source,
    context: record.context,
    routing: record.routing
  });
}

function applicationHasContradiction(record) {
  return record.outcome.verdict === 'regression'
    || record.outcome.controlRegressions > 0
    || record.outcome.contradictionCodes.length > 0
    || record.outcome.transferChecks.some((check) => (
      check.attempted === true && check.passed === false
    ));
}

export function isCausallyAdmittedApplication(record) {
  if (validateAdaptiveRecord(record).status !== 'OK'
      || record.schemaVersion !== ADAPTIVE_SCHEMA.APPLICATION) return false;
  const attemptedTransfers = record.outcome.transferChecks.filter((check) => (
    check.attempted === true
  ));
  return record.partition === 'harvest'
    && record.eligibleForRouting === true
    && record.outcome.valid === true
    && record.outcome.reverified === true
    && Number.isFinite(record.outcome.shamMovement)
    && Number.isInteger(record.outcome.controlRegressions)
    && record.outcome.controlRegressions >= 0
    && attemptedTransfers.length > 0
    && attemptedTransfers.every((check) => (
      typeof check.passed === 'boolean' && shaOrNull(check.evidenceSha256)
    ))
    && record.credit.authority === 'tool-computed'
    && Object.values(record.provenance).every((value) => value != null);
}

export function isCausallyAdmittedCanaryImport(record) {
  return validateAdaptiveRecord(record).status === 'OK'
    && record.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
    && record.partition === 'harvest'
    && record.eligibleForRouting === true
    && record.outcome.valid === true
    && record.outcome.verdict === 'improvement'
    && record.outcome.reverified === true
    && record.outcome.qualityDelta > 0
    && record.outcome.shamMovement === 0
    && record.outcome.controlRegressions === 0
    && record.outcome.targetRegressions === 0
    && record.outcome.shamWins === 0
    && record.credit.authority === 'tool-computed'
    && record.credit.positiveEvidence === true
    && record.authority.activation === 'routing-only';
}

function applicationRevisionRank(record) {
  const attemptedTransfers = record.outcome.transferChecks.filter((check) => (
    check.attempted === true
  )).length;
  const measuredFields = [
    record.outcome.qualityDelta,
    record.outcome.tokenCostDeltaPct,
    record.outcome.shamMovement,
    record.outcome.controlRegressions
  ].filter((value) => value != null).length;
  return [
    record.outcome.reverified === true ? 1 : 0,
    applicationHasContradiction(record) ? 1 : 0,
    isCausallyAdmittedApplication(record) ? 1 : 0,
    attemptedTransfers,
    measuredFields,
    Object.values(record.provenance).filter((value) => value != null).length,
    String(record.appliedAt)
  ];
}

function compareRevisionRank(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function selectLatestApplicationRevisions(applications = []) {
  const latest = new Map();
  for (const record of Array.isArray(applications) ? applications : []) {
    if (validateAdaptiveRecord(record).status !== 'OK'
        || record.schemaVersion !== ADAPTIVE_SCHEMA.APPLICATION) {
      return refused(
        'INVALID_APPLICATION_REVISION',
        'Application revision selection received an invalid record.'
      );
    }
    const current = latest.get(record.applicationId);
    if (!current) {
      latest.set(record.applicationId, record);
      continue;
    }
    if (applicationInvariant(current) !== applicationInvariant(record)) {
      return refused(
        'APPLICATION_REVISION_IDENTITY_CONFLICT',
        `Application ${record.applicationId} has conflicting immutable identity fields.`
      );
    }
    const comparison = compareRevisionRank(
      applicationRevisionRank(record),
      applicationRevisionRank(current)
    );
    if (comparison > 0) {
      latest.set(record.applicationId, record);
      continue;
    }
    if (comparison === 0
        && record.applicationReceiptId !== current.applicationReceiptId) {
      return refused(
        'APPLICATION_REVISION_CONFLICT',
        `Application ${record.applicationId} has equally authoritative conflicting revisions.`
      );
    }
  }
  return {
    status: 'OK',
    applications: [...latest.values()].sort((left, right) => (
      left.applicationId.localeCompare(right.applicationId)
    ))
  };
}

function normalizeSchedule(values) {
  const schedule = [];
  for (const [index, value] of (Array.isArray(values) ? values : []).entries()) {
    const item = object(value);
    if (!ALLOCATIONS.has(item.allocation)) return null;
    const familyId = item.familyId == null
      ? null
      : (/^family-[a-f0-9]{24}$/.test(String(item.familyId)) ? String(item.familyId) : null);
    if (item.familyId != null && !familyId) return null;
    if (item.allocation === 'control' && familyId != null) return null;
    if (item.allocation !== 'control' && familyId == null) return null;
    const probability = finite(item.probability);
    if (probability == null || probability < 0 || probability > 1) return null;
    const applicationReceiptId = item.applicationReceiptId == null
      ? null
      : (/^app-receipt-[a-f0-9]{24}$/.test(String(item.applicationReceiptId))
          ? String(item.applicationReceiptId)
          : null);
    if (item.applicationReceiptId != null && !applicationReceiptId) return null;
    schedule.push({
      position: index,
      allocation: item.allocation,
      familyId,
      applicationReceiptId,
      probability: round(probability),
      evidenceStrength: finite(item.evidenceStrength) == null
        ? null
        : round(Math.max(0, Math.min(1, finite(item.evidenceStrength)))),
      reasonCodes: normalizedReasons(item.reasonCodes)
    });
  }
  return schedule;
}

export function createRoutingDecisionRecord(input = {}) {
  const mode = ROUTING_MODES.has(input.mode) ? input.mode : null;
  const status = ROUTING_STATUS.has(input.status) ? input.status : null;
  const targetSha256 = shaOrNull(input.targetSha256);
  const candidatePoolSha256 = shaOrNull(input.candidatePoolSha256);
  const policyEpochId = /^epoch-[a-f0-9]{24}$/.test(String(input.policyEpochId || ''))
    ? String(input.policyEpochId)
    : null;
  const policyEpochSha256 = shaOrNull(input.policyEpochSha256);
  const schedule = normalizeSchedule(input.allocationSchedule);
  if (!mode || !status || !targetSha256 || !candidatePoolSha256 || !policyEpochId
      || !policyEpochSha256 || !schedule) {
    return refused('INVALID_ROUTING_DECISION', 'Routing hashes, policy binding, status, or schedule is invalid.');
  }
  if (mode === 'active-canary'
      && !schedule.some((item) => item.allocation === 'control')) {
    return refused(
      'CONTROL_ALLOCATION_REQUIRED',
      'Active routing must preserve a no-memory control allocation.'
    );
  }
  const affectedExecution = mode === 'active-canary'
    && schedule.some((item) => item.allocation !== 'control');
  const mechanismCapsuleSha256 = shaOrNull(input.mechanismCapsuleSha256)
    || sha256(canonicalAdaptiveJson(schedule.map((item) => ({
      position: item.position,
      allocation: item.allocation,
      familyId: item.familyId,
      applicationReceiptId: item.applicationReceiptId,
      reasonCodes: item.reasonCodes
    }))));
  const packetPayload = {
    mode,
    affectedExecution,
    targetSha256,
    candidatePoolSha256,
    candidatePoolCount: Number.isInteger(input.candidatePoolCount)
      ? Math.max(0, input.candidatePoolCount)
      : 0,
    policyEpochId,
    policyEpochSha256,
    mechanismCapsuleSha256,
    seed: normalizedSeed(input.seed),
    status,
    abstentionCode: input.abstentionCode == null
      ? null
      : (REASON_RE.test(String(input.abstentionCode)) ? String(input.abstentionCode) : null),
    allocationSchedule: schedule
  };
  const payload = {
    schemaVersion: ADAPTIVE_SCHEMA.ROUTING_DECISION,
    ...packetPayload,
    routingPacketSha256: sha256(canonicalAdaptiveJson(packetPayload))
  };
  return ok(sealRecord(payload, {
    idField: 'routingDecisionId',
    hashField: 'routingDecisionSha256',
    prefix: 'route'
  }));
}

function normalizePolicy(input = {}) {
  if (!exactKeys(input, ['allocations', 'scoring', 'penalties'])) return null;
  const allocations = object(input.allocations);
  const scoring = object(input.scoring);
  const penalties = object(input.penalties);
  if (!exactKeys(allocations, ['control', 'related', 'adjacent', 'failureDerived', 'wildcard'])
      || !exactKeys(scoring, [
        'relevanceWeight',
        'confidenceWeight',
        'positiveEffectWeight',
        'contradictionPenaltyWeight'
      ])
      || !exactKeys(penalties, ['cooldown', 'failedTransfer'])) {
    return null;
  }
  const policy = {
    allocations: {
      control: finite(allocations.control),
      related: finite(allocations.related),
      adjacent: finite(allocations.adjacent),
      failureDerived: finite(allocations.failureDerived),
      wildcard: finite(allocations.wildcard)
    },
    scoring: {
      relevanceWeight: finite(scoring.relevanceWeight),
      confidenceWeight: finite(scoring.confidenceWeight),
      positiveEffectWeight: finite(scoring.positiveEffectWeight),
      contradictionPenaltyWeight: finite(scoring.contradictionPenaltyWeight)
    },
    penalties: {
      cooldown: finite(penalties.cooldown),
      failedTransfer: finite(penalties.failedTransfer)
    }
  };
  const numbers = [
    ...Object.values(policy.allocations),
    ...Object.values(policy.scoring),
    ...Object.values(policy.penalties)
  ];
  const allocationSum = Object.values(policy.allocations).reduce((sum, value) => sum + value, 0);
  if (numbers.some((value) => value == null || value < 0 || value > 1)
      || policy.allocations.control < 0.2
      || Math.abs(allocationSum - 1) > 1e-9) {
    return null;
  }
  return policy;
}

function policyValues(policy) {
  return {
    'allocations.related': policy.allocations.related,
    'allocations.adjacent': policy.allocations.adjacent,
    'allocations.failureDerived': policy.allocations.failureDerived,
    'allocations.wildcard': policy.allocations.wildcard,
    'scoring.relevanceWeight': policy.scoring.relevanceWeight,
    'scoring.confidenceWeight': policy.scoring.confidenceWeight,
    'scoring.positiveEffectWeight': policy.scoring.positiveEffectWeight,
    'scoring.contradictionPenaltyWeight': policy.scoring.contradictionPenaltyWeight,
    'penalties.cooldown': policy.penalties.cooldown,
    'penalties.failedTransfer': policy.penalties.failedTransfer
  };
}

function diffPolicies(previous, next) {
  const before = policyValues(previous);
  const after = policyValues(next);
  return ADAPTIVE_POLICY_FIELDS
    .map((field) => ({
      field,
      before: round(before[field]),
      after: round(after[field]),
      delta: round(after[field] - before[field])
    }))
    .filter((change) => Math.abs(change.delta) > 1e-12);
}

function driftFromBaseline(baseline, current) {
  const left = policyValues(baseline);
  const right = policyValues(current);
  return round(ADAPTIVE_POLICY_FIELDS.reduce(
    (sum, field) => sum + Math.abs(right[field] - left[field]),
    0
  ));
}

export function policyDriftTier(drift) {
  if (!Number.isFinite(drift) || drift < 0) return null;
  if (drift === 0) return 0;
  if (drift <= 0.1) return 1;
  if (drift <= 0.25) return 2;
  return 3;
}

export function createMetaPolicyEpochRecord(input = {}) {
  const epochNumber = Number.isInteger(input.epochNumber) && input.epochNumber >= 0
    ? input.epochNumber
    : null;
  const trigger = POLICY_TRIGGERS.has(input.trigger) ? input.trigger : null;
  const baselinePolicy = normalizePolicy(input.baselinePolicy);
  const policy = normalizePolicy(input.policy);
  const previousEpoch = input.previousEpoch == null ? null : object(input.previousEpoch);
  const policyScopeIdValue = input.policyScopeId ?? previousEpoch?.policyScopeId ?? 'global';
  const policyScopeId = isSafeId(policyScopeIdValue) ? String(policyScopeIdValue) : null;
  const validApplicationCount = Number.isInteger(input.validApplicationCount)
    ? Math.max(0, input.validApplicationCount)
    : 0;
  const evidenceWindowSha256 = shaOrNull(input.evidenceWindowSha256);
  if (epochNumber == null || !policyScopeId || !trigger || !baselinePolicy || !policy || !evidenceWindowSha256) {
    return refused('INVALID_POLICY_EPOCH', 'Policy epoch identity, trigger, policy, or evidence window is invalid.');
  }
  if (epochNumber === 0 && (trigger !== 'initial' || previousEpoch !== null)) {
    return refused('INVALID_POLICY_CHAIN', 'Epoch zero must be initial and have no previous epoch.');
  }
  if (epochNumber > 0) {
    if (!/^epoch-[a-f0-9]{24}$/.test(String(previousEpoch.policyEpochId || ''))
        || !SHA256_RE.test(String(previousEpoch.policyEpochSha256 || ''))
        || previousEpoch.schemaVersion !== ADAPTIVE_SCHEMA.POLICY_EPOCH
        || previousEpoch.policyScopeId !== policyScopeId
        || previousEpoch.epochNumber !== epochNumber - 1
        || !validateEpoch(previousEpoch)) {
      return refused('INVALID_POLICY_CHAIN', 'Policy epoch must bind the immediately previous valid epoch.');
    }
    if (trigger === 'valid-attempt-window' && validApplicationCount < 5) {
      return refused('POLICY_WINDOW_TOO_SMALL', 'A valid-attempt update requires at least five applications.');
    }
  }
  const previousPolicy = epochNumber === 0
    ? baselinePolicy
    : normalizePolicy(previousEpoch.policy);
  if (!previousPolicy) return refused('INVALID_POLICY_CHAIN', 'Previous epoch policy is invalid.');
  if (Math.abs(policy.allocations.control - previousPolicy.allocations.control) > 1e-12
      || Math.abs(policy.allocations.control - baselinePolicy.allocations.control) > 1e-12) {
    return refused(
      'CONTROL_ALLOCATION_IMMUTABLE',
      'The permanent no-memory control allocation cannot change between policy epochs.'
    );
  }
  const changes = diffPolicies(previousPolicy, policy);
  if (changes.some((change) => Math.abs(change.delta) > 0.05 + 1e-9)) {
    return refused('POLICY_STEP_TOO_LARGE', 'No allowlisted policy field may move by more than 0.05 per epoch.');
  }
  const drift = driftFromBaseline(baselinePolicy, policy);
  const driftTier = policyDriftTier(drift);
  const metaCanaryReceiptSha256 = shaOrNull(input.metaCanaryReceiptSha256);
  if (driftTier === 3 && !metaCanaryReceiptSha256) {
    return refused('TIER3_REQUIRES_META_CANARY', 'Tier-3 policy drift requires a held-out meta-canary receipt.');
  }
  const payload = {
    schemaVersion: ADAPTIVE_SCHEMA.POLICY_EPOCH,
    policyScopeId,
    epochNumber,
    previousEpochId: previousEpoch?.policyEpochId || null,
    previousEpochSha256: previousEpoch?.policyEpochSha256 || null,
    trigger,
    evidenceWindow: {
      validApplicationCount,
      sha256: evidenceWindowSha256
    },
    baselinePolicySha256: sha256(canonicalAdaptiveJson(baselinePolicy)),
    baselinePolicy,
    policySha256: sha256(canonicalAdaptiveJson(policy)),
    policy,
    changes,
    drift,
    driftTier,
    quarantinedFamilyIds: [...new Set((Array.isArray(input.quarantinedFamilyIds)
      ? input.quarantinedFamilyIds
      : []).filter((value) => /^family-[a-f0-9]{24}$/.test(String(value))))]
      .sort(),
    rollbackTargetEpochId: input.rollbackTargetEpochId == null
      ? null
      : (/^epoch-[a-f0-9]{24}$/.test(String(input.rollbackTargetEpochId))
          ? String(input.rollbackTargetEpochId)
          : null),
    metaCanaryReceiptSha256
  };
  if (input.rollbackTargetEpochId != null && !payload.rollbackTargetEpochId) {
    return refused('INVALID_ROLLBACK_TARGET', 'Rollback target epoch ID is malformed.');
  }
  return ok(sealRecord(payload, {
    idField: 'policyEpochId',
    hashField: 'policyEpochSha256',
    prefix: 'epoch'
  }));
}

function normalizedGates(values) {
  const gates = (Array.isArray(values) ? values : [])
    .map((value) => {
      const gate = object(value);
      const code = String(gate.code || '').trim().toUpperCase();
      if (!REASON_RE.test(code)) return null;
      return {
        code,
        passed: gate.passed === true,
        evidenceSha256: shaOrNull(gate.evidenceSha256)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.code.localeCompare(b.code));
  return gates;
}

export function createAutomaticPromotionDecisionRecord(input = {}) {
  const source = object(input.source);
  const evidence = object(input.evidence);
  const routing = object(input.routing);
  const gates = normalizedGates(input.gates);
  const rawGates = Array.isArray(input.gates) ? input.gates : [];
  if (gates.length !== rawGates.length
      || new Set(gates.map((gate) => gate.code)).size !== gates.length) {
    return refused(
      'INVALID_PROMOTION_GATE',
      'Promotion gates must be complete, uniquely coded, and structurally valid.'
    );
  }
  const runId = isSafeId(source.runId) ? String(source.runId) : null;
  const hypothesisId = isSafeId(source.hypothesisId) ? String(source.hypothesisId) : null;
  const testId = isSafeId(source.testId) ? String(source.testId) : null;
  const benchmarkSha256 = shaOrNull(evidence.benchmarkSha256);
  const baselineSha256 = shaOrNull(evidence.baselineSha256);
  const challengerSha256 = shaOrNull(evidence.challengerSha256);
  const qualityAuthority = normalizedKind(evidence.qualityAuthority);
  const policyEpochId = routing.policyEpochId == null
    ? null
    : (/^epoch-[a-f0-9]{24}$/.test(String(routing.policyEpochId))
        ? String(routing.policyEpochId)
        : null);
  const routingDecisionId = routing.routingDecisionId == null
    ? null
    : (/^route-[a-f0-9]{24}$/.test(String(routing.routingDecisionId))
        ? String(routing.routingDecisionId)
        : null);
  if (!runId || !hypothesisId || !testId || !benchmarkSha256 || !baselineSha256
      || !challengerSha256 || !qualityAuthority || !gates.length) {
    return refused('INVALID_AUTO_PROMOTION_DECISION', 'Promotion source, evidence hashes, authority, or gates are invalid.');
  }
  if (routing.routingDecisionId != null && !routingDecisionId
      || routing.policyEpochId != null && !policyEpochId) {
    return refused('INVALID_AUTO_PROMOTION_BINDING', 'Promotion routing IDs are malformed.');
  }
  const deterministicOracle = evidence.deterministicOracle === true;
  const reverified = evidence.reverified === true;
  const controlRegressions = Number.isInteger(evidence.controlRegressions)
    ? evidence.controlRegressions
    : null;
  const fixtureOnly = evidence.fixtureOnly === true;
  const allGatesPassed = gates.every((gate) => (
    gate.passed && SHA256_RE.test(String(gate.evidenceSha256 || ''))
  ));
  const eligible = allGatesPassed
    && deterministicOracle
    && reverified
    && qualityAuthority === 'tool-computed'
    && controlRegressions === 0
    && !fixtureOnly;
  const reasonCodes = normalizedReasons([
    ...gates.filter((gate) => !gate.passed).map((gate) => `GATE_${gate.code}`),
    ...gates.filter((gate) => gate.passed && !gate.evidenceSha256)
      .map((gate) => `GATE_${gate.code}_UNBOUND`),
    ...(!deterministicOracle ? ['ORACLE_NOT_DETERMINISTIC'] : []),
    ...(!reverified ? ['NOT_REVERIFIED'] : []),
    ...(qualityAuthority !== 'tool-computed' ? ['QUALITY_NOT_TOOL_COMPUTED'] : []),
    ...(controlRegressions !== 0 ? ['CONTROL_REGRESSION'] : []),
    ...(fixtureOnly ? ['FIXTURE_ONLY'] : []),
    ...(eligible ? ['ALL_AUTOMATIC_GATES_PASSED'] : [])
  ]);
  const payload = {
    schemaVersion: ADAPTIVE_SCHEMA.AUTO_PROMOTION,
    source: { runId, hypothesisId, testId },
    evidence: {
      benchmarkSha256,
      baselineSha256,
      challengerSha256,
      qualityAuthority,
      deterministicOracle,
      reverified,
      qualityDelta: finite(evidence.qualityDelta),
      tokenCostDeltaPct: finite(evidence.tokenCostDeltaPct),
      controlRegressions,
      fixtureOnly
    },
    routing: {
      routingDecisionId,
      routingDecisionSha256: shaOrNull(routing.routingDecisionSha256),
      policyEpochId,
      policyEpochSha256: shaOrNull(routing.policyEpochSha256)
    },
    gates,
    eligible,
    disposition: eligible ? 'AUTO_BANK_INTERNAL' : 'QUEUE_HUMAN_REVIEW',
    reasonCodes,
    promotionAuthorized: eligible,
    canonicalChange: false
  };
  return ok(sealRecord(payload, {
    idField: 'automaticPromotionDecisionId',
    hashField: 'automaticPromotionDecisionSha256',
    prefix: 'auto-promo'
  }));
}

function validateFamily(record) {
  const normalized = normalizeCausalFingerprint(record.causalFingerprint);
  if (normalized.status !== 'OK'
      || !exactKeys(record, [
        'schemaVersion',
        'familyId',
        'fingerprintSha256',
        'causalFingerprint',
        'familySha256'
      ])) return false;
  const fingerprintSha256 = sha256(canonicalAdaptiveJson(normalized.fingerprint));
  const payload = { ...record };
  delete payload.familySha256;
  return record.familyId === `family-${fingerprintSha256.slice(0, 24)}`
    && record.fingerprintSha256 === fingerprintSha256
    && record.familySha256 === sha256(canonicalAdaptiveJson(payload))
    && canonicalAdaptiveJson(record.causalFingerprint) === canonicalAdaptiveJson(normalized.fingerprint);
}

function validateApplication(record) {
  const failedTransfer = Array.isArray(record.outcome?.transferChecks)
    && record.outcome.transferChecks.some((check) => check.attempted && check.passed === false);
  const controlRegression = Number.isInteger(record.outcome?.controlRegressions)
    && record.outcome.controlRegressions > 0;
  const expectedPositive = record.outcome?.valid === true
    && record.outcome?.verdict === 'improvement'
    && !failedTransfer
    && !controlRegression
    && Array.isArray(record.outcome?.contradictionCodes)
    && record.outcome.contradictionCodes.length === 0;
  const expectedFailureDerived = record.outcome?.valid === true
    && ['no_improvement', 'tradeoff', 'regression'].includes(record.outcome?.verdict)
    || record.outcome?.valid === true
      && record.outcome?.verdict === 'improvement'
      && (failedTransfer
        || controlRegression
        || (record.outcome?.contradictionCodes || []).length > 0);
  const completeProvenance = /^receipt-[a-f0-9]{24}$/.test(
    String(record.provenance?.legacyReceiptId || '')
  )
    && [
      record.provenance?.legacyReceiptSha256,
      record.provenance?.benchmarkSha256,
      record.provenance?.artifactSetSha256,
      record.provenance?.evidenceSetSha256
    ].every((value) => SHA256_RE.test(String(value || '')));
  const routing = object(record.routing);
  const routingBound = /^route-[a-f0-9]{24}$/.test(String(routing.routingDecisionId || ''));
  const validRouting = exactKeys(routing, [
    'routingDecisionId',
    'routingDecisionSha256',
    'routingPacketSha256',
    'policyEpochId',
    'policyEpochSha256',
    'allocation',
    'schedulePosition'
  ])
    && (routingBound
      ? SHA256_RE.test(String(routing.routingDecisionSha256 || ''))
        && SHA256_RE.test(String(routing.routingPacketSha256 || ''))
        && /^epoch-[a-f0-9]{24}$/.test(String(routing.policyEpochId || ''))
        && SHA256_RE.test(String(routing.policyEpochSha256 || ''))
        && ALLOCATIONS.has(routing.allocation)
        && Number.isInteger(routing.schedulePosition)
        && routing.schedulePosition >= 0
      : routing.routingDecisionId == null
        && routing.routingDecisionSha256 == null
        && routing.routingPacketSha256 == null
        && routing.policyEpochId == null
        && routing.policyEpochSha256 == null
        && routing.allocation == null
        && routing.schedulePosition == null);
  const rebuilt = createMechanismApplicationRecord(record);
  return exactKeys(record, [
    'schemaVersion',
    'applicationId',
    'applicationReceiptId',
    'applicationSha256',
    'familyId',
    'appliedAt',
    'partition',
    'eligibleForRouting',
    'source',
    'context',
    'routing',
    'outcome',
    'credit',
    'provenance'
  ])
    && /^application-[a-f0-9]{24}$/.test(String(record.applicationId || ''))
    && /^family-[a-f0-9]{24}$/.test(String(record.familyId || ''))
    && PARTITIONS.has(record.partition)
    && isoOrNull(record.appliedAt) === record.appliedAt
    && record.eligibleForRouting === (record.partition === 'harvest' && record.outcome?.valid === true)
    && OUTCOMES.has(record.outcome?.verdict)
    && nullableFinite(record.outcome?.qualityDelta)
    && nullableFinite(record.outcome?.tokenCostDeltaPct)
    && nullableFinite(record.outcome?.shamMovement)
    && nullableInteger(record.outcome?.controlRegressions)
    && validRouting
    && record.credit?.positiveEvidence === expectedPositive
    && record.credit?.failureDerived === expectedFailureDerived
    && (!record.eligibleForRouting || completeProvenance)
    && rebuilt.status === 'OK'
    && canonicalAdaptiveJson(rebuilt.record) === canonicalAdaptiveJson(record)
    && verifySeal(record, {
      idField: 'applicationReceiptId',
      hashField: 'applicationSha256',
      prefix: 'app-receipt'
    });
}

function validateCanaryImport(record) {
  const rebuilt = createAdaptiveCanaryImportRecord(record);
  return exactKeys(record, [
    'schemaVersion',
    'applicationId',
    'applicationReceiptId',
    'applicationSha256',
    'familyId',
    'partition',
    'eligibleForRouting',
    'source',
    'context',
    'routing',
    'outcome',
    'credit',
    'authority',
    'evidence'
  ])
    && rebuilt.status === 'OK'
    && canonicalAdaptiveJson(rebuilt.record) === canonicalAdaptiveJson(record)
    && verifySeal(record, {
      idField: 'applicationReceiptId',
      hashField: 'applicationSha256',
      prefix: 'app-receipt'
    });
}

function validateRouting(record) {
  const schedule = normalizeSchedule(record.allocationSchedule);
  const packetPayload = {
    mode: record.mode,
    affectedExecution: record.affectedExecution,
    targetSha256: record.targetSha256,
    candidatePoolSha256: record.candidatePoolSha256,
    candidatePoolCount: record.candidatePoolCount,
    policyEpochId: record.policyEpochId,
    policyEpochSha256: record.policyEpochSha256,
    mechanismCapsuleSha256: record.mechanismCapsuleSha256,
    seed: record.seed,
    status: record.status,
    abstentionCode: record.abstentionCode,
    allocationSchedule: record.allocationSchedule
  };
  return exactKeys(record, [
    'schemaVersion',
    'routingDecisionId',
    'routingDecisionSha256',
    'routingPacketSha256',
    'mode',
    'affectedExecution',
    'targetSha256',
    'candidatePoolSha256',
    'candidatePoolCount',
    'policyEpochId',
    'policyEpochSha256',
    'mechanismCapsuleSha256',
    'seed',
    'status',
    'abstentionCode',
    'allocationSchedule'
  ])
    && schedule
    && canonicalAdaptiveJson(schedule) === canonicalAdaptiveJson(record.allocationSchedule)
    && SHA256_RE.test(String(record.targetSha256 || ''))
    && SHA256_RE.test(String(record.candidatePoolSha256 || ''))
    && SHA256_RE.test(String(record.policyEpochSha256 || ''))
    && SHA256_RE.test(String(record.mechanismCapsuleSha256 || ''))
    && /^epoch-[a-f0-9]{24}$/.test(String(record.policyEpochId || ''))
    && /^seed-[a-f0-9]{24}$/.test(String(record.seed || ''))
    && Number.isInteger(record.candidatePoolCount)
    && record.candidatePoolCount >= 0
    && (record.abstentionCode == null || REASON_RE.test(String(record.abstentionCode)))
    && record.affectedExecution === (
      record.mode === 'active-canary'
      && schedule.some((item) => item.allocation !== 'control')
    )
    && (record.mode !== 'active-canary'
      || schedule.some((item) => item.allocation === 'control'))
    && ROUTING_MODES.has(record.mode)
    && ROUTING_STATUS.has(record.status)
    && record.routingPacketSha256 === sha256(canonicalAdaptiveJson(packetPayload))
    && verifySeal(record, {
      idField: 'routingDecisionId',
      hashField: 'routingDecisionSha256',
      prefix: 'route'
    });
}

function validateEpoch(record) {
  const policy = normalizePolicy(record.policy);
  const baseline = normalizePolicy(record.baselinePolicy);
  const expectedKeys = [
    'schemaVersion',
    'policyEpochId',
    'policyEpochSha256',
    'policyScopeId',
    'epochNumber',
    'previousEpochId',
    'previousEpochSha256',
    'trigger',
    'evidenceWindow',
    'baselinePolicySha256',
    'baselinePolicy',
    'policySha256',
    'policy',
    'changes',
    'drift',
    'driftTier',
    'quarantinedFamilyIds',
    'rollbackTargetEpochId',
    'metaCanaryReceiptSha256'
  ];
  const changesValid = Array.isArray(record.changes)
    && new Set(record.changes.map((change) => change.field)).size === record.changes.length
    && record.changes.every((change) => (
      exactKeys(change, ['field', 'before', 'after', 'delta'])
      && ADAPTIVE_POLICY_FIELDS.includes(change.field)
      && Number.isFinite(change.before)
      && Number.isFinite(change.after)
      && Number.isFinite(change.delta)
      && round(change.after - change.before) === change.delta
      && Math.abs(change.delta) <= 0.05 + 1e-9
    ));
  const quarantinesValid = Array.isArray(record.quarantinedFamilyIds)
    && record.quarantinedFamilyIds.every((value) => /^family-[a-f0-9]{24}$/.test(String(value)))
    && canonicalAdaptiveJson(record.quarantinedFamilyIds)
      === canonicalAdaptiveJson([...new Set(record.quarantinedFamilyIds)].sort());
  const chainShapeValid = record.epochNumber === 0
    ? record.trigger === 'initial'
      && record.previousEpochId === null
      && record.previousEpochSha256 === null
      && record.changes.length === 0
    : /^epoch-[a-f0-9]{24}$/.test(String(record.previousEpochId || ''))
      && SHA256_RE.test(String(record.previousEpochSha256 || ''))
      && record.trigger !== 'initial';
  return exactKeys(record, expectedKeys)
    && policy
    && baseline
    && isSafeId(record.policyScopeId)
    && Number.isInteger(record.epochNumber)
    && record.epochNumber >= 0
    && POLICY_TRIGGERS.has(record.trigger)
    && exactKeys(record.evidenceWindow, ['validApplicationCount', 'sha256'])
    && Number.isInteger(record.evidenceWindow.validApplicationCount)
    && record.evidenceWindow.validApplicationCount >= 0
    && SHA256_RE.test(String(record.evidenceWindow.sha256 || ''))
    && (record.trigger !== 'valid-attempt-window'
      || record.evidenceWindow.validApplicationCount >= 5)
    && chainShapeValid
    && record.drift === driftFromBaseline(baseline, policy)
    && record.driftTier === policyDriftTier(record.drift)
    && record.baselinePolicySha256 === sha256(canonicalAdaptiveJson(baseline))
    && record.policySha256 === sha256(canonicalAdaptiveJson(policy))
    && policy.allocations.control === baseline.allocations.control
    && changesValid
    && quarantinesValid
    && (record.rollbackTargetEpochId == null
      || /^epoch-[a-f0-9]{24}$/.test(String(record.rollbackTargetEpochId)))
    && (record.trigger !== 'rollback' || record.rollbackTargetEpochId != null)
    && (record.metaCanaryReceiptSha256 == null
      || SHA256_RE.test(String(record.metaCanaryReceiptSha256)))
    && (record.driftTier !== 3 || record.metaCanaryReceiptSha256 != null)
    && verifySeal(record, {
      idField: 'policyEpochId',
      hashField: 'policyEpochSha256',
      prefix: 'epoch'
    });
}

function validateAutoPromotion(record) {
  const rebuilt = createAutomaticPromotionDecisionRecord(record);
  return rebuilt.status === 'OK'
    && canonicalAdaptiveJson(rebuilt.record) === canonicalAdaptiveJson(record)
    && AUTO_DISPOSITIONS.has(record.disposition)
    && record.canonicalChange === false
    && record.promotionAuthorized === record.eligible
    && (record.eligible
      ? record.disposition === 'AUTO_BANK_INTERNAL'
      : record.disposition === 'QUEUE_HUMAN_REVIEW')
    && Array.isArray(record.gates)
    && record.gates.length > 0
    && new Set(record.gates.map((gate) => gate.code)).size === record.gates.length
    && verifySeal(record, {
      idField: 'automaticPromotionDecisionId',
      hashField: 'automaticPromotionDecisionSha256',
      prefix: 'auto-promo'
    });
}

export function validateAdaptiveRecord(record) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return refused('INVALID_ADAPTIVE_RECORD', 'Adaptive record must be an object.');
    }
    const valid = record.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
      ? validateFamily(record)
      : record.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
        ? validateApplication(record)
        : record.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
          ? validateCanaryImport(record)
          : record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT
            ? validateAdaptiveMeasurementRecord(record).status === 'OK'
            : record.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION
              ? validateMechanismEvolutionRecord(record).status === 'OK'
              : record.schemaVersion === ADAPTIVE_SCHEMA.ROUTING_DECISION
                ? validateRouting(record)
                : record.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH
                  ? validateEpoch(record)
                  : record.schemaVersion === ADAPTIVE_SCHEMA.AUTO_PROMOTION
                    ? validateAutoPromotion(record)
                    : false;
    return valid
      ? { status: 'OK', schemaVersion: record.schemaVersion }
      : refused('INVALID_ADAPTIVE_RECORD', 'Adaptive record shape or hash is invalid.');
  } catch (error) {
    return refused('INVALID_ADAPTIVE_RECORD', error.message);
  }
}
