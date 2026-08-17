import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isSafeId, sha256 } from './util.mjs';
import {
  resolveWorkerBinary,
  STRICT_CODEX_DISABLED_FEATURES
} from './executor.mjs';
import { verifyVNextModelInvocation } from './vnext-model-identity.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact,
  validateVNextStageArtifact
} from './vnext-contracts.mjs';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from './vnext-model-contracts.mjs';
import {
  prepareEphemeralCodexAuthCapsule,
  sweepEphemeralAuthCapsules
} from './ephemeral-auth-capsule.mjs';
import { superviseProcessTree } from './process-tree-supervisor.mjs';

export const ISOLATED_EVALUATOR_REQUEST_SCHEMA_V1 =
  'vnext-isolated-evaluator-request-v1';
export const ISOLATED_EVALUATOR_REQUEST_SCHEMA =
  'vnext-isolated-evaluator-request-v2';
export const ISOLATED_EVALUATOR_INVOCATION_SCHEMA =
  'vnext-isolated-evaluator-invocation-v2';
export const ISOLATED_EVALUATOR_RECEIPT_SCHEMA =
  'vnext-isolated-evaluator-receipt-v2';
export const EVALUATOR_WORKER_FAILURE_SCHEMA_V1 =
  'vnext-evaluator-worker-failure-v1';
export const EVALUATOR_WORKER_FAILURE_SCHEMA =
  'vnext-evaluator-worker-failure-v2';
export const EVALUATOR_PROCESS_DIAGNOSTIC_SCHEMA =
  'vnext-evaluator-process-diagnostic-v1';
export const EVALUATOR_COUNTERBALANCE_SEED_SCHEMA =
  'vnext-evaluator-counterbalance-seed-commitment-v1';
export const EVALUATOR_SECURITY_QUALIFICATION_SCHEMA =
  'vnext-semantic-judge-security-qualification-v1';
export const EVALUATOR_SECURITY_ANSWER_KEY_SCHEMA =
  'vnext-semantic-judge-answer-key-v1';
export const READ_ONLY_EVALUATOR_TOOLS = Object.freeze([
  'read-task-local-evidence'
]);

const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = Object.freeze([
  'anonymousCandidateArtifact',
  'objectiveVerifierFacts',
  'pairwise',
  'publicRubric',
  'taskLocalEvidence',
  'taskSpecification'
]);
const FORBIDDEN_KEY = /(?:^|[-_])(arm|lineage|hypothesis|research|proposer|model|prior[-_]?score|previous[-_]?score|promotion|promote|admission|admit|deploy(?:ment)?)(?:$|[-_])/i;
const FORBIDDEN_VALUE = /\b(?:baseline|parent|candidate|treatment|sham)\b|\b(?:gpt(?:-[\w.]+)?|claude(?:-[\w.]+)?|gemini(?:-[\w.]+)?)\b|\b(?:prior|previous)\s+score\b|\b(?:promote|promotion|admit|admission|deploy|deployment)\b/i;
const UNSAFE_PATH_KEY = /(?:^|[-_])(path|filepath|filename|directory|cwd|uri|url)(?:$|[-_])/i;
const UNSAFE_PATH_VALUE = /(?:^|\s)(?:file:\/\/|~\/|(?:\.\.\/)+|(?:\.\.\\)+|\/(?:Users|home|private|tmp|var|etc|root)\/|[A-Za-z]:\\)/;
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OFFICIAL_WORKER_PATH = fileURLToPath(
  new URL('../scripts/vnext-evaluator-worker.mjs', import.meta.url)
);
const MAX_WRAPPER_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESS_DIAGNOSTIC_BYTES = 8 * 1024;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function redactProcessDiagnostic(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk|gh[opusr])[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(
      /(^|[\s,{])(["']?[A-Za-z0-9_.-]*(?:token|key|secret|password|authorization|cookie|session(?:[_-]?id)?|sid)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gim,
      '$1$2[REDACTED]'
    )
    .replace(/\bhttps?:\/\/[^\s?#]+\?[^\s]+/gi, (url) => (
      `${url.slice(0, url.indexOf('?'))}?[REDACTED_QUERY]`
    ))
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, '[REDACTED_LONG_TOKEN]')
    .replace(/\0/g, '\uFFFD');
}

export function buildEvaluatorProcessDiagnostic(value, {
  maximumBytes = MAX_PROCESS_DIAGNOSTIC_BYTES
} = {}) {
  const raw = String(value || '');
  const redacted = redactProcessDiagnostic(raw);
  const bytes = Buffer.from(redacted, 'utf8');
  const truncated = bytes.length > maximumBytes;
  const marker = Buffer.from('\n[TRUNCATED]\n', 'utf8');
  let text = redacted;
  if (truncated) {
    const available = Math.max(0, maximumBytes - marker.length);
    let prefix = '';
    let prefixBytes = 0;
    for (const character of redacted) {
      const characterBytes = Buffer.byteLength(character, 'utf8');
      if (prefixBytes + characterBytes > available) break;
      prefix += character;
      prefixBytes += characterBytes;
    }
    text = `${prefix}${marker.toString('utf8')}`;
  }
  return {
    schemaVersion: EVALUATOR_PROCESS_DIAGNOSTIC_SCHEMA,
    rawSha256: sha256(raw),
    rawBytes: Buffer.byteLength(raw, 'utf8'),
    storedSha256: sha256(text),
    storedBytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    redacted: text !== raw,
    text
  };
}

function validEvaluatorProcessDiagnostic(diagnostic) {
  return exactKeys(diagnostic, [
    'schemaVersion', 'rawSha256', 'rawBytes', 'storedSha256',
    'storedBytes', 'truncated', 'redacted', 'text'
  ])
    && diagnostic.schemaVersion === EVALUATOR_PROCESS_DIAGNOSTIC_SCHEMA
    && SHA256.test(String(diagnostic.rawSha256 || ''))
    && SHA256.test(String(diagnostic.storedSha256 || ''))
    && Number.isSafeInteger(diagnostic.rawBytes) && diagnostic.rawBytes >= 0
    && Number.isSafeInteger(diagnostic.storedBytes)
    && diagnostic.storedBytes >= 0
    && diagnostic.storedBytes <= MAX_PROCESS_DIAGNOSTIC_BYTES
    && typeof diagnostic.truncated === 'boolean'
    && typeof diagnostic.redacted === 'boolean'
    && typeof diagnostic.text === 'string'
    && diagnostic.storedBytes === Buffer.byteLength(diagnostic.text, 'utf8')
    && diagnostic.storedSha256 === sha256(diagnostic.text)
    && redactProcessDiagnostic(diagnostic.text) === diagnostic.text
    && (!diagnostic.truncated || diagnostic.text.endsWith('\n[TRUNCATED]\n'));
}

export function validateEvaluatorProcessDiagnostic(diagnostic) {
  return validEvaluatorProcessDiagnostic(diagnostic)
    ? { status: 'OK', diagnostic }
    : refused(
        'EVALUATOR_PROCESS_DIAGNOSTIC_INVALID',
        'Process diagnostic is malformed, unsafe, or not a redaction fixed point.'
      );
}

export function validateEvaluatorWorkerFailure(failure, {
  invocationSha256 = null
} = {}) {
  const legacy = failure?.schemaVersion === EVALUATOR_WORKER_FAILURE_SCHEMA_V1;
  if (legacy) {
    if (!exactKeys(failure, [
      'schemaVersion', 'invocationSha256', 'reason', 'stdoutSha256',
      'stderrSha256', 'executorInvocation'
    ])
        || !SHA256.test(String(failure.invocationSha256 || ''))
        || (invocationSha256 != null
          && failure.invocationSha256 !== invocationSha256)
        || typeof failure.reason !== 'string' || failure.reason.length > 120
        || !SHA256.test(String(failure.stdoutSha256 || ''))
        || !SHA256.test(String(failure.stderrSha256 || ''))
        || !plainObject(failure.executorInvocation)
        || failure.stdoutSha256 !== failure.executorInvocation.stdoutSha256
        || failure.stderrSha256 !== failure.executorInvocation.stderrSha256
        || failure.executorInvocation.exitCode === 0) {
      return refused(
        'EVALUATOR_WORKER_FAILURE_INVALID',
        'Legacy evaluator worker failure evidence is malformed.'
      );
    }
    return { status: 'OK', failure };
  }
  if (!exactKeys(failure, [
    'schemaVersion', 'invocationSha256', 'reason', 'stdout', 'stderr',
    'executorInvocation', 'failureSha256'
  ])
      || failure.schemaVersion !== EVALUATOR_WORKER_FAILURE_SCHEMA
      || !SHA256.test(String(failure.invocationSha256 || ''))
      || (invocationSha256 != null && failure.invocationSha256 !== invocationSha256)
      || typeof failure.reason !== 'string' || failure.reason.length > 120
      || !validEvaluatorProcessDiagnostic(failure.stdout)
      || !validEvaluatorProcessDiagnostic(failure.stderr)
      || !(failure.executorInvocation == null || plainObject(failure.executorInvocation))
      || !SHA256.test(String(failure.failureSha256 || ''))) {
    return refused(
      'EVALUATOR_WORKER_FAILURE_INVALID',
      'Evaluator worker failure evidence is malformed.'
    );
  }
  const core = structuredClone(failure);
  delete core.failureSha256;
  if (failure.failureSha256 !== sha256(canonicalVNextJson(core))
      || (failure.executorInvocation && (
        failure.stdout.rawSha256 !== failure.executorInvocation.stdoutSha256
        || failure.stderr.rawSha256 !== failure.executorInvocation.stderrSha256
      ))) {
    return refused(
      'EVALUATOR_WORKER_FAILURE_TAMPERED',
      'Evaluator worker failure evidence failed replay.'
    );
  }
  return { status: 'OK', failure };
}

function boundaryViolation(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const violation = boundaryViolation(value[index], `${path}[${index}]`);
      if (violation) return violation;
    }
    return null;
  }
  if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
      if (FORBIDDEN_KEY.test(normalizedKey)
          || /(?:^|[-_])other[-_]?arms?(?:$|[-_])/i.test(normalizedKey)
          || /(?:^|[-_])(?:proposer|model)[-_]?identity(?:$|[-_])/i.test(normalizedKey)) {
        return `${path}.${key}:forbidden-key`;
      }
      if (UNSAFE_PATH_KEY.test(normalizedKey)) return `${path}.${key}:unsafe-path-key`;
      const violation = boundaryViolation(child, `${path}.${key}`);
      if (violation) return violation;
    }
    return null;
  }
  if (typeof value === 'string') {
    if (value.includes('\0')) return `${path}:nul-byte`;
    if (FORBIDDEN_VALUE.test(value)) return `${path}:forbidden-value`;
    if (UNSAFE_PATH_VALUE.test(value)) return `${path}:unsafe-path-value`;
  }
  return null;
}

function substantive(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return plainObject(value) && Object.keys(value).length > 0;
}

function evaluatorSemanticContract(publicRubric, taskLocalEvidence) {
  if (!plainObject(publicRubric)
      || !Array.isArray(publicRubric.dimensions)
      || publicRubric.dimensions.length < 1
      || publicRubric.dimensions.length > 64
      || !plainObject(publicRubric.scale)
      || !Number.isFinite(publicRubric.scale.minimum)
      || !Number.isFinite(publicRubric.scale.maximum)
      || publicRubric.scale.minimum >= publicRubric.scale.maximum
      || !Array.isArray(taskLocalEvidence)
      || taskLocalEvidence.length < 1) return null;
  const dimensionIds = publicRubric.dimensions.map((dimension) => (
    plainObject(dimension) ? dimension.id : null
  ));
  const evidenceIds = taskLocalEvidence.map((evidence) => (
    plainObject(evidence) ? evidence.id : null
  ));
  if (dimensionIds.some((id) => !isSafeId(id))
      || evidenceIds.some((id) => !isSafeId(id))
      || new Set(dimensionIds).size !== dimensionIds.length
      || new Set(evidenceIds).size !== evidenceIds.length) return null;
  return {
    dimensionIds,
    evidenceIds,
    minimum: publicRubric.scale.minimum,
    maximum: publicRubric.scale.maximum
  };
}

export function buildIsolatedEvaluatorPrompt(request, instruction) {
  const validated = validateIsolatedEvaluatorRequest(request);
  if (validated.status !== 'OK'
      || typeof instruction !== 'string'
      || !instruction.trim()
      || instruction.length > 32_000
      || boundaryViolation(instruction)) return null;
  return [
    instruction.trim(),
    '',
    `FROZEN_EVALUATION_INPUT_SHA256=${request.requestSha256}`,
    canonicalVNextJson(request)
  ].join('\n');
}

function orderedPair(first, second, seed) {
  if (typeof seed !== 'string' || seed.trim().length < 8 || seed.length > 500) {
    return refused('EVALUATOR_PAIRWISE_SEED_INVALID', 'Pairwise ordering requires a bounded non-public seed.');
  }
  const canonicalInputs = [first, second].map((artifact) => ({
    artifact,
    sha256: sha256(canonicalVNextJson(artifact))
  })).sort((left, right) => left.sha256.localeCompare(right.sha256));
  const inputSha256 = canonicalInputs.map(({ sha256: digest }) => digest);
  if (new Set(inputSha256).size !== inputSha256.length) {
    return refused(
      'EVALUATOR_PAIRWISE_ARTIFACTS_IDENTICAL',
      'Pairwise evaluation requires two distinct canonical artifacts.'
    );
  }
  const seedSha256 = sha256(seed);
  const randomizationSha256 = sha256(canonicalVNextJson({
    seedSha256,
    inputSha256
  }));
  const order = Number.parseInt(randomizationSha256.slice(0, 2), 16) % 2 === 0
    ? [0, 1]
    : [1, 0];
  const artifacts = order.map((index, slot) => ({
    slot: `item-${slot + 1}`,
    artifact: structuredClone(canonicalInputs[index].artifact)
  }));
  const receiptCore = {
    schemaVersion: 'vnext-evaluator-pairwise-order-v2',
    seedSha256,
    randomizationSha256,
    inputSha256,
    orderedArtifactSha256: order.map((index) => inputSha256[index])
  };
  return {
    status: 'OK',
    artifacts,
    receipt: {
      ...receiptCore,
      receiptSha256: sha256(canonicalVNextJson(receiptCore))
    }
  };
}

export function buildIsolatedEvaluatorRequest(input = {}) {
  if (!exactKeys(input, REQUEST_KEYS)) {
    return refused(
      'EVALUATOR_REQUEST_FIELDS_INVALID',
      'Evaluator requests accept only the frozen task, rubric, anonymous artifact, objective facts, task-local evidence, and pairwise setting.'
    );
  }
  const {
    taskSpecification,
    publicRubric,
    anonymousCandidateArtifact,
    objectiveVerifierFacts,
    taskLocalEvidence,
    pairwise
  } = input;
  if (![taskSpecification, publicRubric, anonymousCandidateArtifact, objectiveVerifierFacts]
    .every(substantive)
      || !evaluatorSemanticContract(publicRubric, taskLocalEvidence)) {
    return refused('EVALUATOR_REQUEST_CONTENT_REQUIRED', 'Evaluator request content must be inline and non-empty.');
  }
  const visibleInput = {
    taskSpecification,
    publicRubric,
    anonymousCandidateArtifact,
    objectiveVerifierFacts,
    taskLocalEvidence
  };
  const violation = boundaryViolation(visibleInput);
  if (violation) {
    return refused('EVALUATOR_INFORMATION_BOUNDARY', `Evaluator request refused at ${violation}.`);
  }

  let artifacts;
  let pairwiseReceipt = null;
  if (pairwise == null) {
    artifacts = [{
      slot: 'item-1',
      artifact: structuredClone(anonymousCandidateArtifact)
    }];
  } else {
    if (!exactKeys(pairwise, ['secondAnonymousArtifact', 'seed'])
        || !substantive(pairwise.secondAnonymousArtifact)) {
      return refused('EVALUATOR_PAIRWISE_INVALID', 'Pairwise evaluation requires exactly one second anonymous artifact and a seed.');
    }
    const pairViolation = boundaryViolation(pairwise.secondAnonymousArtifact);
    if (pairViolation) {
      return refused('EVALUATOR_INFORMATION_BOUNDARY', `Evaluator request refused at ${pairViolation}.`);
    }
    const paired = orderedPair(
      anonymousCandidateArtifact,
      pairwise.secondAnonymousArtifact,
      pairwise.seed
    );
    if (paired.status !== 'OK') return paired;
    artifacts = paired.artifacts;
    pairwiseReceipt = paired.receipt;
  }

  const core = {
    schemaVersion: ISOLATED_EVALUATOR_REQUEST_SCHEMA,
    taskSpecification: structuredClone(taskSpecification),
    publicRubric: structuredClone(publicRubric),
    rubricSha256: sha256(canonicalVNextJson(publicRubric)),
    anonymousArtifacts: artifacts,
    objectiveVerifierFacts: structuredClone(objectiveVerifierFacts),
    taskLocalEvidence: structuredClone(taskLocalEvidence),
    pairwiseOrderReceiptSha256: pairwiseReceipt?.receiptSha256 ?? null
  };
  const request = {
    ...core,
    requestSha256: sha256(canonicalVNextJson(core))
  };
  return deepFreeze({
    status: 'OK',
    request,
    pairwiseReceipt
  });
}

export const buildEvaluatorRequest = buildIsolatedEvaluatorRequest;

export function createEvaluatorCounterbalanceSeedCommitment({
  qualificationId,
  seeds,
  committedAt
} = {}) {
  if (!isSafeId(qualificationId)
      || !Array.isArray(seeds)
      || seeds.length !== 2
      || new Set(seeds).size !== seeds.length
      || seeds.some((seed) => (
        typeof seed !== 'string' || seed.trim().length < 8 || seed.length > 500
      ))
      || !Number.isFinite(Date.parse(committedAt))) {
    return refused(
      'EVALUATOR_COUNTERBALANCE_SEED_INVALID',
      'Counterbalancing requires two distinct bounded seeds committed before artifact selection.'
    );
  }
  const core = {
    schemaVersion: EVALUATOR_COUNTERBALANCE_SEED_SCHEMA,
    qualificationId,
    committedAt,
    formCount: 2,
    seedSha256s: seeds.map((seed) => sha256(seed))
  };
  return {
    status: 'OK',
    commitment: deepFreeze({
      ...core,
      commitmentSha256: sha256(canonicalVNextJson(core))
    })
  };
}

export function validateEvaluatorCounterbalanceSeedCommitment(commitment) {
  if (!exactKeys(commitment, [
    'schemaVersion', 'qualificationId', 'committedAt', 'formCount',
    'seedSha256s', 'commitmentSha256'
  ])
      || commitment.schemaVersion !== EVALUATOR_COUNTERBALANCE_SEED_SCHEMA
      || !isSafeId(commitment.qualificationId)
      || !Number.isFinite(Date.parse(commitment.committedAt))
      || commitment.formCount !== 2
      || !Array.isArray(commitment.seedSha256s)
      || commitment.seedSha256s.length !== 2
      || new Set(commitment.seedSha256s).size !== 2
      || commitment.seedSha256s.some((digest) => !SHA256.test(String(digest || '')))
      || !SHA256.test(String(commitment.commitmentSha256 || ''))) {
    return refused(
      'EVALUATOR_COUNTERBALANCE_COMMITMENT_INVALID',
      'Counterbalance seed commitment is malformed.'
    );
  }
  const core = structuredClone(commitment);
  delete core.commitmentSha256;
  return commitment.commitmentSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', commitment }
    : refused(
        'EVALUATOR_COUNTERBALANCE_COMMITMENT_TAMPERED',
        'Counterbalance seed commitment hash failed replay.'
      );
}

export function buildEvaluatorSecurityQualification({
  seedCommitment,
  seeds,
  supportedArtifact,
  contradictedArtifact,
  objectiveVerifierFacts,
  taskLocalEvidence,
  criteria,
  scale
} = {}) {
  const seedValid = validateEvaluatorCounterbalanceSeedCommitment(seedCommitment);
  if (seedValid.status !== 'OK'
      || !Array.isArray(seeds)
      || seeds.length !== 2
      || seeds.some((seed, index) => (
        sha256(String(seed || '')) !== seedCommitment.seedSha256s[index]
      ))
      || !substantive(supportedArtifact)
      || !substantive(contradictedArtifact)
      || canonicalVNextJson(supportedArtifact) === canonicalVNextJson(contradictedArtifact)
      || !Array.isArray(criteria)
      || criteria.length < 1 || criteria.length > 10
      || criteria.some((criterion) => (
        typeof criterion !== 'string'
        || !criterion.trim()
        || criterion.length > 500
        || boundaryViolation(criterion)
      ))
      || !exactKeys(scale, ['minimum', 'maximum'])
      || !Number.isFinite(scale.minimum)
      || !Number.isFinite(scale.maximum)
      || scale.minimum >= scale.maximum) {
    return refused(
      'EVALUATOR_SECURITY_QUALIFICATION_INPUT_INVALID',
      'Semantic-judge qualification requires committed counterbalanced seeds, distinct artifacts, and neutral criteria.'
    );
  }
  const dimensions = [];
  for (let itemIndex = 0; itemIndex < 2; itemIndex += 1) {
    for (const criterion of criteria) {
      dimensions.push({
        id: `criterion-${String(dimensions.length + 1).padStart(2, '0')}`,
        criterion: `Visible item ${itemIndex + 1}: ${criterion.trim()}`
      });
    }
  }
  const publicRubric = { dimensions, scale: structuredClone(scale) };
  const taskSpecification = {
    instruction: 'Measure both visible items using only the supplied evidence and every public criterion.',
    outputConvention: 'Return one measurement for every opaque criterion ID.'
  };
  const supportedSha256 = sha256(canonicalVNextJson(supportedArtifact));
  const contradictedSha256 = sha256(canonicalVNextJson(contradictedArtifact));
  const forms = [];
  const mappings = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const built = buildIsolatedEvaluatorRequest({
      taskSpecification,
      publicRubric,
      anonymousCandidateArtifact: supportedArtifact,
      objectiveVerifierFacts,
      taskLocalEvidence,
      pairwise: {
        secondAnonymousArtifact: contradictedArtifact,
        seed: seeds[index]
      }
    });
    if (built.status !== 'OK') return built;
    const formId = `form-${index + 1}`;
    const visible = built.request.anonymousArtifacts.map(({ artifact }) => (
      sha256(canonicalVNextJson(artifact))
    ));
    const supportedIndex = visible.indexOf(supportedSha256);
    const contradictedIndex = visible.indexOf(contradictedSha256);
    if (supportedIndex < 0 || contradictedIndex < 0) {
      return refused(
        'EVALUATOR_SECURITY_QUALIFICATION_MAPPING_INVALID',
        'Counterbalanced form no longer contains the two committed artifacts.'
      );
    }
    forms.push({
      formId,
      request: built.request,
      pairwiseReceipt: built.pairwiseReceipt
    });
    mappings.push({
      formId,
      supportedItem: `item-${supportedIndex + 1}`,
      contradictedItem: `item-${contradictedIndex + 1}`,
      supportedArtifactSha256: supportedSha256,
      contradictedArtifactSha256: contradictedSha256
    });
  }
  if (new Set(mappings.map((mapping) => mapping.supportedItem)).size !== 2) {
    return refused(
      'EVALUATOR_SECURITY_QUALIFICATION_NOT_COUNTERBALANCED',
      'The two committed forms must place the supported artifact in opposite positions.'
    );
  }
  const answerKeyCore = {
    schemaVersion: EVALUATOR_SECURITY_ANSWER_KEY_SCHEMA,
    qualificationId: seedCommitment.qualificationId,
    seedCommitmentSha256: seedCommitment.commitmentSha256,
    mappings
  };
  const answerKey = {
    ...answerKeyCore,
    answerKeySha256: sha256(canonicalVNextJson(answerKeyCore))
  };
  const bundleCore = {
    schemaVersion: EVALUATOR_SECURITY_QUALIFICATION_SCHEMA,
    qualificationId: seedCommitment.qualificationId,
    seedCommitment: structuredClone(seedCommitment),
    forms,
    answerKeySha256: answerKey.answerKeySha256,
    exposure: {
      maximumCalls: 2,
      retriesPerCall: 0,
      promotionAuthorized: false,
      causalScoringAuthority: false
    }
  };
  return deepFreeze({
    status: 'OK',
    qualification: {
      ...bundleCore,
      qualificationSha256: sha256(canonicalVNextJson(bundleCore))
    },
    answerKey
  });
}

export function validateEvaluatorSecurityAnswerKey(answerKey) {
  if (!exactKeys(answerKey, [
    'schemaVersion', 'qualificationId', 'seedCommitmentSha256', 'mappings',
    'answerKeySha256'
  ])
      || answerKey.schemaVersion !== EVALUATOR_SECURITY_ANSWER_KEY_SCHEMA
      || !isSafeId(answerKey.qualificationId)
      || !SHA256.test(String(answerKey.seedCommitmentSha256 || ''))
      || !SHA256.test(String(answerKey.answerKeySha256 || ''))
      || !Array.isArray(answerKey.mappings)
      || answerKey.mappings.length !== 2
      || answerKey.mappings.some((mapping, index) => (
        !exactKeys(mapping, [
          'formId', 'supportedItem', 'contradictedItem',
          'supportedArtifactSha256', 'contradictedArtifactSha256'
        ])
        || mapping.formId !== `form-${index + 1}`
        || !['item-1', 'item-2'].includes(mapping.supportedItem)
        || !['item-1', 'item-2'].includes(mapping.contradictedItem)
        || mapping.supportedItem === mapping.contradictedItem
        || !SHA256.test(String(mapping.supportedArtifactSha256 || ''))
        || !SHA256.test(String(mapping.contradictedArtifactSha256 || ''))
      ))
      || new Set(answerKey.mappings.map(({ supportedItem }) => supportedItem)).size !== 2
      || new Set(answerKey.mappings.map(({ supportedArtifactSha256 }) => (
        supportedArtifactSha256
      ))).size !== 1
      || new Set(answerKey.mappings.map(({ contradictedArtifactSha256 }) => (
        contradictedArtifactSha256
      ))).size !== 1) {
    return refused(
      'EVALUATOR_SECURITY_ANSWER_KEY_INVALID',
      'Semantic-judge answer key is malformed or not counterbalanced.'
    );
  }
  const core = structuredClone(answerKey);
  delete core.answerKeySha256;
  return answerKey.answerKeySha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', answerKey }
    : refused(
        'EVALUATOR_SECURITY_ANSWER_KEY_TAMPERED',
        'Semantic-judge answer key hash failed replay.'
      );
}

export function validateEvaluatorSecurityQualification(qualification) {
  const seed = validateEvaluatorCounterbalanceSeedCommitment(
    qualification?.seedCommitment
  );
  if (!exactKeys(qualification, [
    'schemaVersion', 'qualificationId', 'seedCommitment', 'forms',
    'answerKeySha256', 'exposure', 'qualificationSha256'
  ])
      || qualification.schemaVersion !== EVALUATOR_SECURITY_QUALIFICATION_SCHEMA
      || !isSafeId(qualification.qualificationId)
      || seed.status !== 'OK'
      || seed.commitment.qualificationId !== qualification.qualificationId
      || !SHA256.test(String(qualification.answerKeySha256 || ''))
      || !SHA256.test(String(qualification.qualificationSha256 || ''))
      || !Array.isArray(qualification.forms)
      || qualification.forms.length !== 2
      || qualification.forms.some((form, index) => (
        !exactKeys(form, ['formId', 'request', 'pairwiseReceipt'])
        || form.formId !== `form-${index + 1}`
        || validateIsolatedEvaluatorRequest(form.request).status !== 'OK'
        || validatePairwiseOrderReceipt(form.pairwiseReceipt, form.request).status !== 'OK'
        || form.request.anonymousArtifacts.length !== 2
        || form.pairwiseReceipt.seedSha256
          !== qualification.seedCommitment.seedSha256s[index]
      ))
      || !exactKeys(qualification.exposure, [
        'maximumCalls', 'retriesPerCall', 'promotionAuthorized',
        'causalScoringAuthority'
      ])
      || qualification.exposure.maximumCalls !== 2
      || qualification.exposure.retriesPerCall !== 0
      || qualification.exposure.promotionAuthorized !== false
      || qualification.exposure.causalScoringAuthority !== false) {
    return refused(
      'EVALUATOR_SECURITY_QUALIFICATION_INVALID',
      'Semantic-judge security qualification is malformed or not replayable.'
    );
  }
  const firstVisible = qualification.forms[0].request.anonymousArtifacts
    .map(({ artifact }) => sha256(canonicalVNextJson(artifact)));
  const secondVisible = qualification.forms[1].request.anonymousArtifacts
    .map(({ artifact }) => sha256(canonicalVNextJson(artifact)));
  const core = structuredClone(qualification);
  delete core.qualificationSha256;
  if (canonicalVNextJson(firstVisible) !== canonicalVNextJson([...secondVisible].reverse())
      || qualification.qualificationSha256 !== sha256(canonicalVNextJson(core))) {
    return refused(
      'EVALUATOR_SECURITY_QUALIFICATION_TAMPERED',
      'Qualification forms are not exact position swaps or its hash failed replay.'
    );
  }
  return { status: 'OK', qualification };
}

export function validateIsolatedEvaluatorRequest(request) {
  const legacy = request?.schemaVersion === ISOLATED_EVALUATOR_REQUEST_SCHEMA_V1;
  const current = request?.schemaVersion === ISOLATED_EVALUATOR_REQUEST_SCHEMA;
  const expectedSlot = (index) => legacy
    ? (index === 0 ? 'A' : 'B')
    : `item-${index + 1}`;
  if (!exactKeys(request, [
    'anonymousArtifacts',
    'objectiveVerifierFacts',
    'pairwiseOrderReceiptSha256',
    'publicRubric',
    'requestSha256',
    'rubricSha256',
    'schemaVersion',
    'taskLocalEvidence',
    'taskSpecification'
  ]) || (!legacy && !current)
      || !SHA256.test(String(request.requestSha256 || ''))
      || !SHA256.test(String(request.rubricSha256 || ''))
      || !Array.isArray(request.anonymousArtifacts)
      || ![1, 2].includes(request.anonymousArtifacts.length)
      || request.anonymousArtifacts.some((item, index) => (
        !exactKeys(item, ['artifact', 'slot'])
        || item.slot !== expectedSlot(index)
        || !substantive(item.artifact)
      ))
      || (request.anonymousArtifacts.length === 1
        ? request.pairwiseOrderReceiptSha256 !== null
        : !SHA256.test(String(request.pairwiseOrderReceiptSha256 || '')))
      || boundaryViolation({
        taskSpecification: request.taskSpecification,
        publicRubric: request.publicRubric,
        anonymousArtifacts: request.anonymousArtifacts,
        objectiveVerifierFacts: request.objectiveVerifierFacts,
        taskLocalEvidence: request.taskLocalEvidence
      })
      || !evaluatorSemanticContract(
        request.publicRubric,
        request.taskLocalEvidence
      )) {
    return refused('EVALUATOR_REQUEST_INVALID', 'Evaluator request shape or information boundary is invalid.');
  }
  if (request.rubricSha256 !== sha256(canonicalVNextJson(request.publicRubric))) {
    return refused('EVALUATOR_RUBRIC_HASH_MISMATCH', 'The public rubric bytes drifted.');
  }
  const core = structuredClone(request);
  delete core.requestSha256;
  if (request.requestSha256 !== sha256(canonicalVNextJson(core))) {
    return refused('EVALUATOR_REQUEST_HASH_MISMATCH', 'The evaluator request bytes drifted.');
  }
  return { status: 'OK', request: structuredClone(request) };
}

export function validateEvaluatorOutputAgainstRequest(output, request) {
  const requestValidation = validateIsolatedEvaluatorRequest(request);
  const outputValidation = validateVNextModelOutput(
    output,
    VNEXT_MODEL_SCHEMA.EVALUATOR
  );
  const contract = requestValidation.status === 'OK'
    ? evaluatorSemanticContract(request.publicRubric, request.taskLocalEvidence)
    : null;
  if (requestValidation.status !== 'OK'
      || outputValidation.status !== 'OK'
      || !contract
      || outputValidation.output.rubricSha256 !== request.rubricSha256) {
    return refused(
      'EVALUATOR_OUTPUT_SEMANTICS_INVALID',
      'Evaluator output does not replay against the frozen rubric and evidence request.'
    );
  }
  const measurements = outputValidation.output.measurements;
  const dimensions = measurements.map((measurement) => measurement.dimension);
  const expectedDimensions = new Set(contract.dimensionIds);
  const evidenceIds = new Set(contract.evidenceIds);
  const semanticsValid = measurements.length === contract.dimensionIds.length
    && new Set(dimensions).size === dimensions.length
    && dimensions.every((dimension) => expectedDimensions.has(dimension))
    && contract.dimensionIds.every((dimension) => dimensions.includes(dimension))
    && measurements.every((measurement) => (
      measurement.score >= contract.minimum
      && measurement.score <= contract.maximum
      && measurement.evidenceRefs.length > 0
      && new Set(measurement.evidenceRefs).size === measurement.evidenceRefs.length
      && measurement.evidenceRefs.every((id) => evidenceIds.has(id))
    ));
  return semanticsValid
    ? { status: 'OK', output: structuredClone(outputValidation.output) }
    : refused(
        'EVALUATOR_OUTPUT_SEMANTICS_INVALID',
        'Evaluator measurements must exactly cover the frozen rubric with bounded scores and task-local evidence references.'
      );
}

export function validatePairwiseOrderReceipt(receipt, request) {
  const requestValidation = validateIsolatedEvaluatorRequest(request);
  const legacy = request?.schemaVersion === ISOLATED_EVALUATOR_REQUEST_SCHEMA_V1;
  const receiptSchema = legacy
    ? 'vnext-evaluator-pairwise-order-v1'
    : 'vnext-evaluator-pairwise-order-v2';
  if (requestValidation.status !== 'OK'
      || request.anonymousArtifacts.length !== 2
      || !exactKeys(receipt, [
        'inputSha256',
        'orderedArtifactSha256',
        'randomizationSha256',
        'receiptSha256',
        'schemaVersion',
        'seedSha256'
      ])
      || receipt.schemaVersion !== receiptSchema
      || !SHA256.test(String(receipt.seedSha256 || ''))
      || !Array.isArray(receipt.inputSha256)
      || receipt.inputSha256.length !== 2
      || receipt.inputSha256.some((value) => !SHA256.test(String(value || '')))
      || new Set(receipt.inputSha256).size !== 2
      || !Array.isArray(receipt.orderedArtifactSha256)
      || receipt.orderedArtifactSha256.length !== 2) {
    return refused('EVALUATOR_PAIRWISE_RECEIPT_INVALID', 'Pairwise order receipt is invalid.');
  }
  const expectedRandomization = sha256(canonicalVNextJson({
    seedSha256: receipt.seedSha256,
    inputSha256: receipt.inputSha256
  }));
  const order = Number.parseInt(expectedRandomization.slice(0, 2), 16) % 2 === 0
    ? [0, 1]
    : [1, 0];
  const visibleHashes = request.anonymousArtifacts.map((item) => (
    sha256(canonicalVNextJson(item.artifact))
  ));
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  if (receipt.randomizationSha256 !== expectedRandomization
      || canonicalVNextJson(receipt.orderedArtifactSha256)
        !== canonicalVNextJson(order.map((index) => receipt.inputSha256[index]))
      || canonicalVNextJson(receipt.orderedArtifactSha256)
        !== canonicalVNextJson(visibleHashes)
      || receipt.receiptSha256 !== request.pairwiseOrderReceiptSha256
      || receipt.receiptSha256 !== sha256(canonicalVNextJson(core))) {
    return refused('EVALUATOR_PAIRWISE_RECEIPT_TAMPERED', 'Pairwise order receipt does not replay to the visible order.');
  }
  return { status: 'OK', receipt: structuredClone(receipt) };
}

export function validateObservedEvaluatorIsolation(executorInvocation, toolPolicy) {
  const isolation = executorInvocation?.isolation;
  const validShape = exactKeys(isolation, [
    'status', 'toolCalls', 'disallowedToolCalls', 'contextDiagnostics',
    'malformedLines', 'reasons'
  ])
    && Array.isArray(isolation.toolCalls)
    && Array.isArray(isolation.disallowedToolCalls)
    && Array.isArray(isolation.contextDiagnostics)
    && Array.isArray(isolation.reasons)
    && Number.isSafeInteger(isolation.malformedLines)
    && isolation.malformedLines >= 0;
  const valid = validShape
    && isolation.status === 'PASS'
    && isolation.disallowedToolCalls.length === 0
    && isolation.contextDiagnostics.length === 0
    && isolation.malformedLines === 0
    && isolation.reasons.length === 0
    && (toolPolicy !== 'none' || isolation.toolCalls.length === 0);
  return valid
    ? { status: 'OK', isolation: structuredClone(isolation) }
    : refused(
        'EVALUATOR_OBSERVED_ISOLATION_INVALID',
        'Observed evaluator isolation must pass with no forbidden context or tool use.'
      );
}

function toolsValid(tools, toolPolicy) {
  return Array.isArray(tools)
    && new Set(tools).size === tools.length
    && tools.every((tool) => READ_ONLY_EVALUATOR_TOOLS.includes(tool))
    && (toolPolicy === 'none' ? tools.length === 0 : toolPolicy === 'read-only-task-local');
}

function invocationCore(
  input,
  stateDirectory,
  taskIdentitySha256,
  evaluatorSlotId
) {
  const requestValidation = validateIsolatedEvaluatorRequest(input.request);
  const prompt = buildIsolatedEvaluatorPrompt(input.request, input.prompt);
  if (requestValidation.status !== 'OK'
      || !isSafeId(input.taskId)
      || !isSafeId(input.anonymousArmId)
      || !SHA256.test(taskIdentitySha256)
      || !/^slot-[a-f0-9]{24}$/.test(evaluatorSlotId)
      || !['codex-strict-v1', 'test-fixture-v1'].includes(input.isolationPolicy)
      || typeof input.model !== 'string'
      || !input.model.trim()
      || typeof input.reasoningEffort !== 'string'
      || !input.reasoningEffort.trim()
      || !toolsValid(input.tools, input.toolPolicy)
      || !plainObject(input.outputSchema)
      || prompt == null
      || !exactKeys(input.binaryIdentity, ['basename', 'sha256'])
      || typeof input.binaryIdentity.basename !== 'string'
      || !input.binaryIdentity.basename.trim()
      || !SHA256.test(String(input.binaryIdentity.sha256 || ''))
      || !exactKeys(input.wrapperIdentity, ['basename', 'sha256'])
      || input.wrapperIdentity.basename !== basename(OFFICIAL_WORKER_PATH)
      || !SHA256.test(String(input.wrapperIdentity.sha256 || ''))) return null;
  return {
    schemaVersion: ISOLATED_EVALUATOR_INVOCATION_SCHEMA,
    taskIdentitySha256,
    evaluatorSlotId,
    separateProcess: true,
    freshConversation: true,
    conversationId: null,
    isolationPolicy: input.isolationPolicy,
    environmentIsolation: input.isolationPolicy === 'codex-strict-v1'
      ? 'ephemeral-external-auth-capsule-v2'
      : 'isolated-home-no-auth-v1',
    stateDirectory,
    stateDirectoryIdentitySha256: sha256(stateDirectory),
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    toolPolicy: input.toolPolicy,
    tools: [...input.tools],
    toolsSha256: sha256(canonicalVNextJson(input.tools)),
    outputSchemaSha256: sha256(canonicalVNextJson(input.outputSchema)),
    executorOutputSchemaSha256: input.executorOutputSchemaSha256
      ?? sha256(canonicalVNextJson(input.outputSchema)),
    promptSha256: sha256(prompt),
    inputSha256: input.request.requestSha256,
    rubricSha256: input.request.rubricSha256,
    binaryIdentity: structuredClone(input.binaryIdentity),
    wrapperIdentity: structuredClone(input.wrapperIdentity)
  };
}

function realStateRoot(path) {
  const resolved = resolve(path);
  try {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    if (!lstatSync(resolved).isDirectory()) return null;
    const real = realpathSync(resolved);
    const macosVarAlias = resolved.startsWith('/var/') && real === `/private${resolved}`;
    return real === resolved || macosVarAlias ? real : null;
  } catch {
    return null;
  }
}

export function createEvaluatorInvocationContract(input = {}) {
  const root = realStateRoot(
    input.stateRoot || join(tmpdir(), 'loop-factory-vnext-evaluator')
  );
  if (!root) {
    return refused('EVALUATOR_STATE_ROOT_INVALID', 'Evaluator state root must be a real, non-symlink directory.');
  }
  if (!isSafeId(input.taskId) || !isSafeId(input.anonymousArmId)) {
    return refused('EVALUATOR_INVOCATION_IDENTITY_INVALID', 'Safe task and anonymous arm identities are required.');
  }
  const taskIdentitySha256 = sha256(input.taskId);
  const evaluatorSlotId = `slot-${sha256(canonicalVNextJson({
    taskIdentitySha256,
    anonymousArmIdentitySha256: sha256(input.anonymousArmId),
    requestSha256: input.request?.requestSha256 ?? null
  })).slice(0, 24)}`;
  const stateDirectory = mkdtempSync(join(root, `${evaluatorSlotId}-`));
  const core = invocationCore(
    input,
    stateDirectory,
    taskIdentitySha256,
    evaluatorSlotId
  );
  if (!core) {
    return refused('EVALUATOR_INVOCATION_INVALID', 'Evaluator invocation must bind a fresh process, minimal tools, schema, prompt, inputs, and model.');
  }
  const contract = {
    ...core,
    invocationSha256: sha256(canonicalVNextJson(core))
  };
  return deepFreeze({ status: 'OK', contract });
}

export const buildEvaluatorInvocationContract = createEvaluatorInvocationContract;

export function validateEvaluatorInvocationContract(contract) {
  if (!plainObject(contract)
      || contract.schemaVersion !== ISOLATED_EVALUATOR_INVOCATION_SCHEMA
      || contract.separateProcess !== true
      || contract.freshConversation !== true
      || contract.conversationId !== null
      || !SHA256.test(String(contract.taskIdentitySha256 || ''))
      || !/^slot-[a-f0-9]{24}$/.test(String(contract.evaluatorSlotId || ''))
      || !['codex-strict-v1', 'test-fixture-v1'].includes(contract.isolationPolicy)
      || contract.environmentIsolation !== (contract.isolationPolicy === 'codex-strict-v1'
        ? 'ephemeral-external-auth-capsule-v2'
        : 'isolated-home-no-auth-v1')
      || !SHA256.test(String(contract.invocationSha256 || ''))
      || !SHA256.test(String(contract.stateDirectoryIdentitySha256 || ''))
      || contract.stateDirectoryIdentitySha256 !== sha256(contract.stateDirectory)
      || contract.toolsSha256 !== sha256(canonicalVNextJson(contract.tools))
      || !SHA256.test(String(contract.executorOutputSchemaSha256 || ''))
      || !exactKeys(contract.wrapperIdentity, ['basename', 'sha256'])
      || contract.wrapperIdentity.basename !== basename(OFFICIAL_WORKER_PATH)
      || !SHA256.test(String(contract.wrapperIdentity.sha256 || ''))) {
    return refused('EVALUATOR_INVOCATION_CONTRACT_INVALID', 'Evaluator invocation contract is invalid.');
  }
  const core = structuredClone(contract);
  delete core.invocationSha256;
  if (contract.invocationSha256 !== sha256(canonicalVNextJson(core))) {
    return refused('EVALUATOR_INVOCATION_DRIFT', 'Evaluator invocation contract drifted.');
  }
  return { status: 'OK', contract: structuredClone(contract) };
}

function receiptCore(contract, output, packet, createdAt) {
  const stdoutSha256 = validEvaluatorProcessDiagnostic(packet.stdoutDiagnostic)
    ? packet.stdoutDiagnostic.rawSha256
    : sha256(canonicalVNextJson(output));
  return {
    schemaVersion: ISOLATED_EVALUATOR_RECEIPT_SCHEMA,
    createdAt,
    invocationSha256: contract.invocationSha256,
    processIdentity: String(packet.processIdentity || ''),
    stateDirectoryIdentitySha256: contract.stateDirectoryIdentitySha256,
    model: contract.model,
    reasoningEffort: contract.reasoningEffort,
    toolsSha256: contract.toolsSha256,
    outputSchemaSha256: contract.outputSchemaSha256,
    executorOutputSchemaSha256: contract.executorOutputSchemaSha256,
    promptSha256: contract.promptSha256,
    inputSha256: contract.inputSha256,
    rubricSha256: contract.rubricSha256,
    binaryIdentity: structuredClone(contract.binaryIdentity),
    wrapperIdentity: structuredClone(contract.wrapperIdentity),
    isolationPolicy: contract.isolationPolicy,
    environmentIsolation: contract.environmentIsolation,
    workerPid: Number.isInteger(packet.workerPid) ? packet.workerPid : null,
    parentPid: Number.isInteger(packet.parentPid) ? packet.parentPid : null,
    executionMode: packet.executionMode,
    productionEvidence: packet.executionMode === 'spawned-model-worker',
    executorInvocationSha256: plainObject(packet.executorInvocation)
      ? sha256(canonicalVNextJson(packet.executorInvocation))
      : null,
    workerPacketSha256: packet.workerPacketSha256 ?? null,
    stdoutSha256,
    resultSha256: sha256(canonicalVNextJson(output)),
    separateProcess: true,
    freshConversation: true,
    activationAuthority: false
  };
}

export function validateEvaluatorReceipt(receipt, expectedContract) {
  const contractValidation = validateEvaluatorInvocationContract(expectedContract);
  if (contractValidation.status !== 'OK'
      || !plainObject(receipt)
      || receipt.schemaVersion !== ISOLATED_EVALUATOR_RECEIPT_SCHEMA
      || !receipt.processIdentity
      || receipt.activationAuthority !== false
      || receipt.separateProcess !== true
      || receipt.freshConversation !== true
      || !['spawned-model-worker', 'test-only-in-process', 'test-fixture-process']
        .includes(receipt.executionMode)
      || receipt.productionEvidence !== (receipt.executionMode === 'spawned-model-worker')
      || (receipt.productionEvidence
        && (!Number.isInteger(receipt.workerPid)
          || receipt.workerPid < 1
          || !Number.isInteger(receipt.parentPid)
          || receipt.parentPid < 1
          || !SHA256.test(String(receipt.executorInvocationSha256 || ''))
          || !SHA256.test(String(receipt.workerPacketSha256 || ''))))
      || !SHA256.test(String(receipt.receiptSha256 || ''))) {
    return refused('EVALUATOR_RECEIPT_INVALID', 'Evaluator receipt is incomplete or authority-bearing.');
  }
  const expected = expectedContract;
  for (const key of [
    'invocationSha256',
    'stateDirectoryIdentitySha256',
    'model',
    'reasoningEffort',
    'toolsSha256',
    'outputSchemaSha256',
    'executorOutputSchemaSha256',
    'promptSha256',
    'inputSha256',
    'rubricSha256',
    'isolationPolicy',
    'environmentIsolation'
  ]) {
    if (receipt[key] !== expected[key]) {
      return refused('EVALUATOR_RECEIPT_BINDING_MISMATCH', `Evaluator receipt drifted at ${key}.`);
    }
  }
  if (canonicalVNextJson(receipt.binaryIdentity)
      !== canonicalVNextJson(expected.binaryIdentity)
      || canonicalVNextJson(receipt.wrapperIdentity)
        !== canonicalVNextJson(expected.wrapperIdentity)) {
    return refused('EVALUATOR_RECEIPT_BINDING_MISMATCH', 'Evaluator binary identity drifted.');
  }
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  return receipt.receiptSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', receipt: structuredClone(receipt) }
    : refused('EVALUATOR_RECEIPT_TAMPERED', 'Evaluator receipt hash does not match its content.');
}

function executorPacketValid(packet, contract) {
  if (packet.executionMode !== 'spawned-model-worker') return true;
  const invocation = packet.executorInvocation;
  return plainObject(invocation)
    && invocation.requestedModel === contract.model
    && invocation.reasoningEffort === contract.reasoningEffort
    && invocation.binaryFamily === 'codex'
    && invocation.authMode === 'chatgpt-oauth'
    && invocation.strictIsolation === true
    && canonicalVNextJson(invocation.disabledFeatures)
      === canonicalVNextJson(STRICT_CODEX_DISABLED_FEATURES)
    && invocation.exitCode === 0
    && invocation.promptSha256 === contract.promptSha256
    && invocation.outputSchemaSha256 === contract.executorOutputSchemaSha256
    && invocation.executableBasename === contract.binaryIdentity.basename
    && invocation.executableSha256 === contract.binaryIdentity.sha256
    && invocation.reportedModelMatchesRequest !== false
    && validateObservedEvaluatorIsolation(invocation, contract.toolPolicy).status === 'OK'
    && validEvaluatorProcessDiagnostic(packet.stdoutDiagnostic)
    && invocation.stdoutSha256 === packet.stdoutDiagnostic.rawSha256;
}

function finalizeEvaluatorPacket(input, contract, packet, options = {}) {
  if (!plainObject(packet) || !packet.processIdentity) {
    return refused('EVALUATOR_PROCESS_IDENTITY_REQUIRED', 'The worker must attest a separate process identity.');
  }
  if (!executorPacketValid(packet, contract)) {
    return refused('EVALUATOR_EXECUTOR_RECEIPT_INVALID', 'Spawned evaluator evidence is not bound to the frozen executor contract.');
  }
  let output = packet.output;
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      return refused('EVALUATOR_OUTPUT_JSON_INVALID', 'Evaluator output is not strict JSON.');
    }
  }
  const validated = validateEvaluatorOutputAgainstRequest(output, input.request);
  if (validated.status !== 'OK') return validated;
  const createdAt = (options.clock || (() => new Date().toISOString()))();
  const core = receiptCore(contract, validated.output, packet, createdAt);
  const receipt = {
    ...core,
    receiptSha256: sha256(canonicalVNextJson(core))
  };
  const artifactResult = createVNextStageArtifact({
    stage: VNEXT_STAGE.SEMANTIC_EVALUATION,
    status: 'OK',
    createdAt,
    authority: {
      actorId: `evaluator-${contract.evaluatorSlotId}`,
      kind: 'isolated-semantic-evaluator',
      model: contract.model,
      promptSha256: contract.promptSha256,
      toolPolicy: contract.toolPolicy
    },
    inputRefs: [{
      id: `request-${input.request.requestSha256.slice(0, 20)}`,
      schemaVersion: input.request.schemaVersion,
      sha256: input.request.requestSha256
    }],
    permittedInformation: [
      'anonymous artifact',
      'fixed public rubric',
      'objective verifier facts',
      'task-local evidence',
      'task specification'
    ],
    forbiddenInformation: [
      'activation authority',
      'arm identity',
      'lineage and proposer context',
      'prior scores and other outputs',
      'promotion and admission authority',
      'research and hypothesis context'
    ],
    provenance: [{
      id: `binary-${contract.binaryIdentity.sha256.slice(0, 20)}`,
      kind: 'evaluator-binary',
      observedAt: createdAt,
      sha256: contract.binaryIdentity.sha256,
      uri: null
    }],
    replay: {
      module: 'src/isolated-evaluator.mjs',
      exportName: packet.executionMode === 'spawned-model-worker'
        ? 'runIsolatedEvaluatorProcess'
        : 'runIsolatedEvaluator',
      version: 'v1'
    },
    failure: null,
    payload: {
      evaluation: validated.output,
      evaluatorReceipt: receipt,
      semanticMeasurementOnly: true,
      productionEvidence: receipt.productionEvidence,
      activationAuthority: false
    }
  });
  if (artifactResult.status !== 'OK') return artifactResult;
  return deepFreeze({
    status: 'OK',
    artifact: artifactResult.artifact,
    receipt,
    invocation: contract
  });
}

export function runIsolatedEvaluator(input = {}, options = {}) {
  if (options.allowTestWorker !== true || typeof options.worker !== 'function') {
    return refused(
      'EVALUATOR_PROCESS_REQUIRED',
      'Production evaluation requires runIsolatedEvaluatorProcess; the in-process seam is test-only.'
    );
  }
  const built = createEvaluatorInvocationContract(input);
  if (built.status !== 'OK') return built;
  let packet;
  try {
    packet = options.worker(deepFreeze({
      request: structuredClone(input.request),
      invocation: structuredClone(built.contract)
    }));
  } catch (error) {
    return refused('EVALUATOR_WORKER_FAILED', String(error?.message || error));
  }
  return finalizeEvaluatorPacket(input, built.contract, {
    ...packet,
    executionMode: 'test-only-in-process',
    workerPid: null,
    executorInvocation: null,
    workerPacketSha256: null
  }, options);
}

export function buildIsolatedEvaluatorEnvironment(
  env,
  fixtureMode,
  stateDirectory,
  authCapsule = null
) {
  const allowed = [
    'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PATH', 'SHELL', 'SSL_CERT_FILE',
    'SUPER_LOOP_ALLOW_EXEC', 'SUPER_LOOP_CODEX_BIN',
    'SUPER_LOOP_CODEX_EXECUTABLE_SHA256',
    'SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256', 'SUPER_LOOP_REQUIRE_CHATGPT_OAUTH'
  ];
  const child = Object.fromEntries(allowed
    .filter((key) => typeof env[key] === 'string')
    .map((key) => [key, env[key]]));
  const isolatedHome = join(stateDirectory, 'home');
  const isolatedTmp = join(stateDirectory, 'tmp');
  mkdirSync(isolatedHome, { mode: 0o700 });
  mkdirSync(isolatedTmp, { mode: 0o700 });
  child.HOME = isolatedHome;
  child.TMPDIR = isolatedTmp;
  if (authCapsule) child.CODEX_HOME = authCapsule;
  if (child.SUPER_LOOP_ALLOW_EXEC !== '1') delete child.SUPER_LOOP_ALLOW_EXEC;
  if (fixtureMode) child.LOOP_FACTORY_EVALUATOR_TEST_FIXTURE = '1';
  return child;
}

function executableRoute(model, env) {
  const resolved = resolveWorkerBinary(model, env);
  if (!resolved.binPath) return null;
  try {
    return {
      binaryFamily: resolved.bin,
      identity: {
        basename: basename(resolved.binPath),
        sha256: sha256(readFileSync(resolved.binPath))
      }
    };
  } catch {
    return null;
  }
}

function spawnEvaluatorWorker({ args, cwd, env, timeoutMs, onSignalCleanup = null }) {
  return new Promise((resolveSpawn) => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let timer = null;
    let terminationCode = null;
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    });
    const supervision = superviseProcessTree(child, { onSignalCleanup });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      supervision.release();
      resolveSpawn({ childPid: child.pid, ...result });
    };
    const terminateTree = (code) => {
      if (terminationCode != null) return false;
      terminationCode = code;
      return supervision.terminate(code, 'SIGTERM');
    };
    const waitForTreeExit = async () => {
      let exited = await supervision.waitForExit(
        terminationCode == null ? 500 : 5_000
      );
      if (exited) return true;
      if (terminationCode == null) {
        terminateTree('EVALUATOR_WRAPPER_DESCENDANT_SURVIVED');
        exited = await supervision.waitForExit(5_000);
      }
      if (exited) return true;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already gone */ }
      return supervision.waitForExit(5_000);
    };
    const capture = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_WRAPPER_OUTPUT_BYTES) {
        terminateTree('EVALUATOR_WRAPPER_OUTPUT_LIMIT');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('error', async (error) => {
      terminateTree('EVALUATOR_WRAPPER_LAUNCH_FAILED');
      await waitForTreeExit();
      finish({ ok: false, code: 'EVALUATOR_WRAPPER_LAUNCH_FAILED', error });
    });
    child.once('close', async (code, signal) => {
      const treeReaped = await waitForTreeExit();
      finish({
        ok: terminationCode == null && code === 0 && signal == null,
        code: treeReaped
          ? (terminationCode
            ?? (code === 0 && signal == null ? null : 'EVALUATOR_WRAPPER_EXITED'))
          : 'EVALUATOR_WRAPPER_TREE_NOT_REAPED',
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    timer = setTimeout(() => {
      terminateTree('EVALUATOR_WRAPPER_TIMEOUT');
    }, timeoutMs);
  });
}

export async function runIsolatedEvaluatorProcess(input = {}, options = {}) {
  const fixtureMode = options.allowTestFixture === true
    && plainObject(options.testFixtureOutput);
  const env = options.env ?? process.env;
  let wrapperIdentity;
  try {
    wrapperIdentity = {
      basename: basename(OFFICIAL_WORKER_PATH),
      sha256: sha256(readFileSync(OFFICIAL_WORKER_PATH))
    };
  } catch {
    return refused('EVALUATOR_WRAPPER_MISSING', 'The official evaluator wrapper is unavailable.');
  }
  const route = fixtureMode ? null : executableRoute(input.model, env);
  if (!fixtureMode && (
    route?.binaryFamily !== 'codex'
    || !/^gpt-[a-z0-9.-]+$/i.test(String(input.model || ''))
  )) {
    return refused(
      'EVALUATOR_PROVIDER_ISOLATION_UNSUPPORTED',
      'Production evaluator isolation is currently proven only for GPT models through the strict Codex executor.'
    );
  }
  const binaryIdentity = fixtureMode
    ? input.binaryIdentity
    : route?.identity;
  if (!binaryIdentity) {
    return refused('EVALUATOR_BINARY_UNAVAILABLE', 'The requested evaluator binary is unavailable or unhashable.');
  }
  let outputSchema;
  let outputSchemaRawSha256;
  try {
    const schemaBytes = readFileSync(
      fileURLToPath(new URL('./schemas/vnext-evaluator-output-v1.schema.json', import.meta.url))
    );
    outputSchemaRawSha256 = sha256(schemaBytes);
    outputSchema = JSON.parse(schemaBytes.toString('utf8'));
  } catch {
    return refused('EVALUATOR_OUTPUT_SCHEMA_MISSING', 'The frozen evaluator output schema is unavailable.');
  }
  const effectiveInput = {
    ...input,
    isolationPolicy: fixtureMode ? 'test-fixture-v1' : 'codex-strict-v1',
    binaryIdentity,
    wrapperIdentity,
    outputSchema,
    executorOutputSchemaSha256: outputSchemaRawSha256
  };
  const built = createEvaluatorInvocationContract(effectiveInput);
  if (built.status !== 'OK') return built;
  const contract = built.contract;
  const prompt = buildIsolatedEvaluatorPrompt(effectiveInput.request, effectiveInput.prompt);
  const packetPath = join(contract.stateDirectory, 'worker-input.json');
  const outputPath = join(contract.stateDirectory, 'worker-result.json');
  const packet = {
    schemaVersion: 'vnext-evaluator-worker-input-v2',
    invocation: contract,
    request: effectiveInput.request,
    prompt,
    outputSchema,
    testFixtureOutput: fixtureMode ? options.testFixtureOutput : null
  };
  try {
    writeFileSync(packetPath, canonicalVNextJson(packet), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
  } catch (error) {
    return refused('EVALUATOR_PACKET_WRITE_FAILED', String(error?.message || error));
  }
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
    return refused('EVALUATOR_TIMEOUT_INVALID', 'Evaluator timeout must be between one second and one hour.');
  }
  const authRoot = options.authCapsuleRoot ?? null;
  if (!fixtureMode) {
    const swept = sweepEphemeralAuthCapsules({ root: authRoot });
    if (swept.status !== 'OK') return swept;
  }
  const auth = fixtureMode
    ? { status: 'OK', capsule: null, target: null, cleanup() {} }
    : prepareEphemeralCodexAuthCapsule({
        env,
        root: authRoot,
        forbiddenRoot: contract.stateDirectory
      });
  if (auth.status !== 'OK') return auth;
  let spawned;
  try {
    spawned = await spawnEvaluatorWorker({
      args: [
        OFFICIAL_WORKER_PATH,
        '--packet', packetPath,
        '--output', outputPath,
        '--invocation-sha256', contract.invocationSha256
      ],
      cwd: contract.stateDirectory,
      env: buildIsolatedEvaluatorEnvironment(
        env,
        fixtureMode,
        contract.stateDirectory,
        auth.capsule
      ),
      timeoutMs,
      onSignalCleanup: auth.cleanup
    });
  } finally {
    auth.cleanup();
  }
  if (!spawned.ok) {
    const failurePath = `${outputPath}.failure`;
    let failureEvidence = null;
    try {
      const failureText = readFileSync(failurePath, 'utf8');
      if (Buffer.byteLength(failureText, 'utf8') <= 64 * 1024) {
        const parsed = JSON.parse(failureText);
        const replay = validateEvaluatorWorkerFailure(parsed, {
          invocationSha256: contract.invocationSha256
        });
        if (replay.status === 'OK') {
          failureEvidence = {
            path: failurePath,
            fileSha256: sha256(failureText),
            record: replay.failure
          };
        }
      }
    } catch {
      failureEvidence = null;
    }
    return refused(spawned.code, 'The isolated evaluator wrapper did not complete successfully.', {
      exitCode: spawned.exitCode ?? null,
      signal: spawned.signal ?? null,
      stdoutSha256: sha256(String(spawned.stdout || '')),
      stderrSha256: sha256(String(spawned.stderr || '')),
      failureEvidence
    });
  }
  let resultText;
  let workerPacket;
  try {
    resultText = readFileSync(outputPath, 'utf8');
    if (Buffer.byteLength(resultText, 'utf8') > 64 * 1024 * 1024) {
      return refused('EVALUATOR_RESULT_TOO_LARGE', 'Evaluator result exceeded the evidence limit.');
    }
    workerPacket = JSON.parse(resultText);
  } catch {
    return refused('EVALUATOR_RESULT_INVALID', 'Evaluator wrapper did not persist valid JSON evidence.');
  }
  if (workerPacket.invocationSha256 !== contract.invocationSha256
      || workerPacket.workerPid !== spawned.childPid
      || workerPacket.parentPid !== process.pid
      || workerPacket.processIdentity !== sha256(canonicalVNextJson({
        invocationSha256: contract.invocationSha256,
        workerPid: spawned.childPid,
        parentPid: process.pid,
        wrapperSha256: wrapperIdentity.sha256
      }))) {
    return refused('EVALUATOR_PROCESS_RECEIPT_UNBOUND', 'Evaluator process identity did not bind to the spawned child.');
  }
  return finalizeEvaluatorPacket(effectiveInput, contract, {
    ...workerPacket,
    workerPacketSha256: sha256(resultText)
  }, options);
}

export function evaluatorStateDirectoryName(contract) {
  return basename(contract?.stateDirectory || '');
}

export function verifyIsolatedEvaluatorFromDisk({
  invocation,
  receipt,
  artifact,
  requireProduction = false,
  identityPolicy = null,
  verifiedAt = null
} = {}) {
  const receiptValid = validateEvaluatorReceipt(receipt, invocation);
  const artifactValid = validateVNextStageArtifact(artifact);
  if (receiptValid.status !== 'OK'
      || artifactValid.status !== 'OK'
      || artifact.stage !== VNEXT_STAGE.SEMANTIC_EVALUATION
      || artifact.payload?.evaluatorReceipt?.receiptSha256 !== receipt.receiptSha256
      || artifact.payload.activationAuthority !== false
      || (requireProduction && receipt.productionEvidence !== true)
      || !SHA256.test(String(receipt.workerPacketSha256 || ''))
      || !Number.isInteger(receipt.workerPid)
      || !Number.isInteger(receipt.parentPid)) {
    return refused('EVALUATOR_DISK_REPLAY_INVALID', 'Evaluator artifact or receipt is not replayable evidence.');
  }
  let text;
  let packet;
  let workerInput;
  try {
    text = readFileSync(join(invocation.stateDirectory, 'worker-result.json'), 'utf8');
    packet = JSON.parse(text);
    workerInput = JSON.parse(readFileSync(
      join(invocation.stateDirectory, 'worker-input.json'),
      'utf8'
    ));
  } catch {
    return refused('EVALUATOR_DISK_EVIDENCE_MISSING', 'Persisted evaluator worker evidence is missing.');
  }
  const evaluation = artifact.payload.evaluation;
  if (sha256(text) !== receipt.workerPacketSha256
      || workerInput.schemaVersion !== 'vnext-evaluator-worker-input-v2'
      || canonicalVNextJson(workerInput.invocation) !== canonicalVNextJson(invocation)
      || validateIsolatedEvaluatorRequest(workerInput.request).status !== 'OK'
      || workerInput.request.requestSha256 !== invocation.inputSha256
      || sha256(String(workerInput.prompt || '')) !== invocation.promptSha256
      || sha256(canonicalVNextJson(workerInput.outputSchema))
        !== invocation.outputSchemaSha256
      || packet.invocationSha256 !== invocation.invocationSha256
      || packet.workerPid !== receipt.workerPid
      || packet.parentPid !== receipt.parentPid
      || packet.processIdentity !== receipt.processIdentity
      || packet.executionMode !== receipt.executionMode
      || !validEvaluatorProcessDiagnostic(packet.stdoutDiagnostic)
      || packet.stdoutDiagnostic.rawSha256 !== receipt.stdoutSha256
      || sha256(canonicalVNextJson(packet.output)) !== receipt.resultSha256
      || canonicalVNextJson(packet.output) !== canonicalVNextJson(evaluation)
      || validateEvaluatorOutputAgainstRequest(
        evaluation,
        workerInput.request
      ).status !== 'OK'
      || (packet.executorInvocation
        ? sha256(canonicalVNextJson(packet.executorInvocation))
          !== receipt.executorInvocationSha256
        : receipt.executorInvocationSha256 !== null)
      || !executorPacketValid(packet, invocation)) {
    return refused('EVALUATOR_DISK_EVIDENCE_TAMPERED', 'Persisted evaluator evidence failed replay.');
  }
  let modelIdentityReceipt = null;
  if (requireProduction || identityPolicy != null) {
    if (!identityPolicy || !packet.executorInvocation || !Number.isFinite(Date.parse(verifiedAt))) {
      return refused('EVALUATOR_IDENTITY_POLICY_REQUIRED', 'Production evaluator replay requires a model-identity policy.');
    }
    const identity = verifyVNextModelInvocation({
      policy: identityPolicy,
      invocation: packet.executorInvocation,
      verifiedAt
    });
    if (identity.status !== 'OK') return identity;
    modelIdentityReceipt = identity.receipt;
  }
  return { status: 'OK', invocation, receipt, artifact, modelIdentityReceipt };
}
