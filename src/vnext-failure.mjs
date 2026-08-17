import { posix } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact,
  validateVNextStageArtifact
} from './vnext-contracts.mjs';

export const VNEXT_NORMALIZED_FAILURE_SCHEMA = 'vnext-normalized-failure-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set([
  'answerKey',
  'finalTasks',
  'futureResults',
  'hiddenEvaluatorMaterial',
  'sealedTasks'
]);

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.trim() && value.length <= maximum
    && !value.includes('\0') ? value.trim() : null;
}

function strings(values, maximumItems = 64, maximumLength = 1000) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximumItems) return null;
  const normalized = values.map((value) => boundedText(value, maximumLength));
  return normalized.some((value) => value == null)
    ? null
    : [...new Set(normalized)].sort();
}

function containsForbidden(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsForbidden(item, seen));
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_KEYS.has(key) || containsForbidden(child, seen)
  ));
}

function locator(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 500
      || value.includes('\0') || value.startsWith('/') || value.includes('\\')) return null;
  const [path, symbol, extra] = value.split('#');
  if (extra != null || !path || path.includes('//')) return null;
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === '.' || normalized.startsWith('../')) return null;
  if (symbol != null && !boundedText(symbol, 240)) return null;
  return symbol == null ? normalized : `${normalized}#${symbol}`;
}

function normalizeSources(values, observedAt) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) return null;
  const rows = values.map((value) => {
    const sourceLocator = locator(value?.locator);
    if (!plainObject(value) || !isSafeId(value.id)
        || !boundedText(value.schemaVersion, 120)
        || !SHA256.test(String(value.sha256 || ''))
        || !sourceLocator
        || typeof value.availableAt !== 'string'
        || !Number.isFinite(Date.parse(value.availableAt))
        || Date.parse(value.availableAt) > Date.parse(observedAt)) return null;
    return {
      id: value.id,
      schemaVersion: value.schemaVersion,
      sha256: value.sha256,
      availableAt: value.availableAt,
      locator: sourceLocator
    };
  });
  if (rows.some((row) => row == null)) return null;
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return new Set(rows.map(({ id }) => id)).size === rows.length ? rows : null;
}

export function normalizeVNextFailure(input = {}) {
  const observedAt = input.observedAt;
  const symptoms = strings(input.symptoms);
  const sourceEvidence = normalizeSources(input.sourceEvidence, observedAt);
  const environment = plainObject(input.environment)
    && !containsForbidden(input.environment)
    ? structuredClone(input.environment)
    : null;
  let environmentBytes;
  try {
    environmentBytes = Buffer.byteLength(canonicalVNextJson(environment));
  } catch {
    environmentBytes = Infinity;
  }
  if (!isSafeId(input.failureId)
      || typeof observedAt !== 'string'
      || !Number.isFinite(Date.parse(observedAt))
      || !boundedText(input.summary, 4000)
      || !boundedText(input.behavior, 240)
      || !boundedText(input.component, 120)
      || !symptoms
      || !sourceEvidence
      || !environment
      || environmentBytes > 16 * 1024
      || containsForbidden(input)) {
    return refused('VNEXT_FAILURE_INVALID', 'Failure normalization requires bounded, source-bound, non-sealed evidence.');
  }
  const payload = {
    schemaVersion: VNEXT_NORMALIZED_FAILURE_SCHEMA,
    failureId: input.failureId,
    summary: input.summary.trim(),
    behavior: input.behavior.trim(),
    component: input.component.trim(),
    symptoms,
    environment,
    sourceEvidence,
    sealedDataIncluded: false,
    activationAuthority: false
  };
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.FAILURE,
    status: 'OK',
    createdAt: observedAt,
    authority: input.authority ?? {
      actorId: 'vnext-failure-normalizer',
      kind: 'deterministic-normalizer',
      model: null,
      promptSha256: null,
      toolPolicy: 'no-network'
    },
    inputRefs: sourceEvidence.map(({ id, schemaVersion, sha256 }) => ({
      id, schemaVersion, sha256
    })),
    permittedInformation: ['observed failure', 'source-bound task-local evidence'],
    forbiddenInformation: ['answer keys', 'final sealed tasks', 'future outcomes', 'hidden evaluator material'],
    provenance: sourceEvidence.map((source) => ({
      id: source.id,
      kind: 'failure-evidence',
      observedAt: source.availableAt,
      sha256: source.sha256,
      uri: `repo:${source.locator}`
    })),
    replay: { module: 'src/vnext-failure.mjs', exportName: 'normalizeVNextFailure', version: 'v1' },
    failure: null,
    payload
  });
  return artifact.status === 'OK' ? { status: 'OK', artifact: artifact.artifact } : artifact;
}

export function validateVNextFailureArtifact(artifact) {
  const valid = validateVNextStageArtifact(artifact);
  return valid.status === 'OK'
    && artifact.stage === VNEXT_STAGE.FAILURE
    && artifact.payload?.schemaVersion === VNEXT_NORMALIZED_FAILURE_SCHEMA
    && artifact.payload.sealedDataIncluded === false
    && artifact.payload.activationAuthority === false
    ? { status: 'OK', artifact }
    : refused('VNEXT_FAILURE_ARTIFACT_INVALID', 'Normalized failure artifact failed replay validation.');
}

export const normalizeFailureEvidence = normalizeVNextFailure;
