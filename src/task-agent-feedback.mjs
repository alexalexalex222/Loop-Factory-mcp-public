import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from './vnext-model-contracts.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const TASK_AGENT_FEEDBACK_CONTRACT_SCHEMA = 'vnext-task-agent-feedback-contract-v1';
export const TASK_AGENT_FEEDBACK_ARTIFACT_SCHEMA = 'vnext-task-agent-feedback-artifact-v1';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTEXT_KINDS = new Set([
  'anonymous-treatment',
  'objective-task-facts',
  'task-input',
  'task-output',
  'task-trajectory'
]);
const CONTRACT_KEYS = new Set([
  'collectionId',
  'contextRefs',
  'issuedAt',
  'runId',
  'taskId',
  'ttlMs'
]);
const REQUIRED_CONTRACT_KEYS = new Set([
  'collectionId',
  'contextRefs',
  'issuedAt',
  'runId',
  'taskId'
]);
const REF_KEYS = new Set(['id', 'kind', 'schemaVersion', 'sha256']);

const INFORMATION_BY_KIND = Object.freeze({
  'anonymous-treatment': 'one anonymous treatment capsule',
  'objective-task-facts': 'objective task-local facts',
  'task-input': 'task-local input',
  'task-output': 'task-local output',
  'task-trajectory': 'task-local trajectory'
});

const FORBIDDEN_INFORMATION = Object.freeze([
  'admission decisions',
  'arm labels and other arms',
  'evaluator state and hidden oracle material',
  'final sealed tasks',
  'future outcomes',
  'promotion or deployment authority',
  'research pipeline and proposer lineage'
]);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function refuse(code, message) {
  return { status: 'REFUSED', code, message };
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeContextRefs(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 32) return null;
  const refs = values.map((value) => {
    if (!exactKeys(value, REF_KEYS)
        || !isSafeId(value.id)
        || !CONTEXT_KINDS.has(value.kind)
        || typeof value.schemaVersion !== 'string'
        || value.schemaVersion.length < 1
        || value.schemaVersion.length > 120
        || !SHA256.test(String(value.sha256 || ''))) return null;
    return {
      id: value.id,
      kind: value.kind,
      schemaVersion: value.schemaVersion,
      sha256: value.sha256
    };
  });
  if (refs.some((value) => value == null)
      || !refs.some(({ kind }) => kind === 'task-input')
      || !refs.some(({ kind }) => kind === 'task-output')) return null;
  refs.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  if (new Set(refs.map(({ id, kind }) => `${kind}:${id}`)).size !== refs.length) return null;
  return refs;
}

function contractCore(contract) {
  return {
    schemaVersion: contract.schemaVersion,
    collectionId: contract.collectionId,
    runId: contract.runId,
    taskId: contract.taskId,
    issuedAt: contract.issuedAt,
    expiresAt: contract.expiresAt,
    expectedOutputSchema: contract.expectedOutputSchema,
    contextRefs: contract.contextRefs,
    permittedInformation: contract.permittedInformation,
    forbiddenInformation: contract.forbiddenInformation,
    purpose: contract.purpose
  };
}

function validateContract(contract) {
  if (!plainObject(contract)
      || Object.keys(contract).sort().join(',') !== [
        'collectionId',
        'contextRefs',
        'contractId',
        'contractSha256',
        'expectedOutputSchema',
        'expiresAt',
        'forbiddenInformation',
        'issuedAt',
        'permittedInformation',
        'purpose',
        'runId',
        'schemaVersion',
        'taskId'
      ].sort().join(',')
      || contract.schemaVersion !== TASK_AGENT_FEEDBACK_CONTRACT_SCHEMA
      || contract.expectedOutputSchema !== VNEXT_MODEL_SCHEMA.FEEDBACK
      || contract.purpose !== 'future-hypothesis-evidence-only'
      || !isSafeId(contract.collectionId)
      || !isSafeId(contract.runId)
      || !isSafeId(contract.taskId)
      || !validTimestamp(contract.issuedAt)
      || !validTimestamp(contract.expiresAt)
      || Date.parse(contract.expiresAt) <= Date.parse(contract.issuedAt)) return false;
  const refs = normalizeContextRefs(contract.contextRefs);
  if (!refs || canonicalVNextJson(refs) !== canonicalVNextJson(contract.contextRefs)) return false;
  const permitted = [...new Set(refs.map(({ kind }) => INFORMATION_BY_KIND[kind]))].sort();
  if (canonicalVNextJson(permitted) !== canonicalVNextJson(contract.permittedInformation)
      || canonicalVNextJson([...FORBIDDEN_INFORMATION].sort())
        !== canonicalVNextJson(contract.forbiddenInformation)) return false;
  const digest = sha256(canonicalVNextJson(contractCore(contract)));
  return contract.contractSha256 === digest
    && contract.contractId === `task-feedback-${digest.slice(0, 24)}`;
}

export function createTaskAgentFeedbackContract(input = {}) {
  if (!plainObject(input)
      || Object.keys(input).some((key) => !CONTRACT_KEYS.has(key))
      || [...REQUIRED_CONTRACT_KEYS].some((key) => !(key in input))
      || !isSafeId(input.collectionId)
      || !isSafeId(input.runId)
      || !isSafeId(input.taskId)
      || !validTimestamp(input.issuedAt)) {
    return refuse(
      'TASK_FEEDBACK_CONTRACT_INVALID',
      'Feedback contracts require exact collection, run, task, issue-time, TTL, and context fields.'
    );
  }
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    return refuse('TASK_FEEDBACK_TTL_INVALID', 'Feedback contract TTL is outside the one-hour cap.');
  }
  const contextRefs = normalizeContextRefs(input.contextRefs);
  if (!contextRefs) {
    return refuse(
      'TASK_FEEDBACK_CONTEXT_INVALID',
      'Feedback context must contain only bounded task-local references, including task input and output.'
    );
  }
  const issuedAtMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAtMs + ttlMs)
      || Math.abs(issuedAtMs + ttlMs) > 8.64e15) {
    return refuse('TASK_FEEDBACK_COLLECTION_TIME_INVALID', 'Feedback contract time is outside the supported range.');
  }
  const core = {
    schemaVersion: TASK_AGENT_FEEDBACK_CONTRACT_SCHEMA,
    collectionId: input.collectionId,
    runId: input.runId,
    taskId: input.taskId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
    expectedOutputSchema: VNEXT_MODEL_SCHEMA.FEEDBACK,
    contextRefs,
    permittedInformation: [...new Set(contextRefs.map(({ kind }) => INFORMATION_BY_KIND[kind]))].sort(),
    forbiddenInformation: [...FORBIDDEN_INFORMATION].sort(),
    purpose: 'future-hypothesis-evidence-only'
  };
  const contractSha256 = sha256(canonicalVNextJson(core));
  return {
    status: 'OK',
    contract: {
      ...core,
      contractId: `task-feedback-${contractSha256.slice(0, 24)}`,
      contractSha256
    }
  };
}

export function collectTaskAgentFeedback({ contract, output, collectedAt } = {}) {
  if (!validateContract(contract)) {
    return refuse('TASK_FEEDBACK_CONTRACT_TAMPERED', 'Feedback contract validation failed.');
  }
  if (!validTimestamp(collectedAt)) {
    return refuse('TASK_FEEDBACK_COLLECTION_TIME_INVALID', 'collectedAt must be an ISO timestamp.');
  }
  const collectedAtMs = Date.parse(collectedAt);
  if (collectedAtMs < Date.parse(contract.issuedAt)
      || collectedAtMs > Date.parse(contract.expiresAt)) {
    return refuse('TASK_FEEDBACK_CONTRACT_EXPIRED', 'Feedback was collected outside the fresh contract window.');
  }
  const validated = validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.FEEDBACK);
  if (validated.status !== 'OK') {
    return refuse('TASK_FEEDBACK_OUTPUT_INVALID', 'Feedback output must satisfy vnext-task-feedback-output-v1 exactly.');
  }
  const core = {
    schemaVersion: TASK_AGENT_FEEDBACK_ARTIFACT_SCHEMA,
    contractId: contract.contractId,
    contractSha256: contract.contractSha256,
    collectedAt: new Date(collectedAtMs).toISOString(),
    purpose: 'future-hypothesis-evidence-only',
    feedback: validated.output
  };
  const artifactSha256 = sha256(canonicalVNextJson(core));
  return {
    status: 'OK',
    artifact: {
      ...core,
      artifactId: `task-feedback-artifact-${artifactSha256.slice(0, 24)}`,
      artifactSha256
    }
  };
}

export function validateTaskAgentFeedbackArtifact(artifact) {
  if (!plainObject(artifact)
      || Object.keys(artifact).sort().join(',') !== [
        'artifactId',
        'artifactSha256',
        'collectedAt',
        'contractId',
        'contractSha256',
        'feedback',
        'purpose',
        'schemaVersion'
      ].sort().join(',')
      || artifact.schemaVersion !== TASK_AGENT_FEEDBACK_ARTIFACT_SCHEMA
      || artifact.purpose !== 'future-hypothesis-evidence-only'
      || !isSafeId(artifact.contractId)
      || !SHA256.test(String(artifact.contractSha256 || ''))
      || !validTimestamp(artifact.collectedAt)
      || validateVNextModelOutput(artifact.feedback, VNEXT_MODEL_SCHEMA.FEEDBACK).status !== 'OK') {
    return refuse('TASK_FEEDBACK_ARTIFACT_INVALID', 'Feedback artifact shape is invalid.');
  }
  const { artifactId, artifactSha256, ...core } = artifact;
  const expectedSha256 = sha256(canonicalVNextJson(core));
  if (artifactSha256 !== expectedSha256
      || artifactId !== `task-feedback-artifact-${expectedSha256.slice(0, 24)}`) {
    return refuse('TASK_FEEDBACK_ARTIFACT_TAMPERED', 'Feedback artifact integrity failed.');
  }
  return { status: 'OK', artifact: structuredClone(artifact) };
}

export const buildTaskAgentFeedbackContract = createTaskAgentFeedbackContract;
export const recordTaskAgentFeedback = collectTaskAgentFeedback;
