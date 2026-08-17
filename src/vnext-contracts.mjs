import { isSafeId, sha256 } from './util.mjs';

export const VNEXT_STAGE_ENVELOPE_SCHEMA = 'loop-factory-vnext-stage-envelope-v1';

export const VNEXT_STAGE = Object.freeze({
  FAILURE: 'failure-normalization',
  INTERNAL_RESEARCH: 'internal-research',
  EXTERNAL_RESEARCH: 'external-research',
  DOSSIER: 'research-dossier',
  HYPOTHESIS: 'hypothesis',
  FALSIFICATION: 'falsification',
  RETRIEVAL: 'retrieval',
  CANDIDATE: 'candidate-generation',
  EXECUTION: 'candidate-execution',
  OBJECTIVE_VERIFICATION: 'objective-verification',
  SEMANTIC_EVALUATION: 'semantic-evaluation',
  ADMISSION: 'statistical-admission',
  MEMORY: 'evidence-bank-update',
  ROUTING: 'routing-only-deployment',
  MONITORING: 'monitoring',
  OPERATOR: 'operator-action'
});

export const VNEXT_STATUS = Object.freeze([
  'OK',
  'ABSTAINED',
  'REFUSED',
  'BLOCKED',
  'INVALID'
]);

const SHA256 = /^[a-f0-9]{64}$/;
const STAGES = new Set(Object.values(VNEXT_STAGE));
const STATUSES = new Set(VNEXT_STATUS);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (plainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalVNextJson(value) {
  return JSON.stringify(stableValue(value));
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function uniqueStrings(values, maximum = 128) {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const normalized = values.map((value) => String(value || '').trim())
    .filter((value) => value.length > 0 && value.length <= 240);
  if (normalized.length !== values.length) return null;
  return [...new Set(normalized)].sort();
}

function normalizeInputRefs(values) {
  if (!Array.isArray(values) || values.length > 256) return null;
  const normalized = values.map((value) => {
    if (!exactKeys(value, ['id', 'schemaVersion', 'sha256'])
        || !isSafeId(value.id)
        || typeof value.schemaVersion !== 'string'
        || value.schemaVersion.length < 1
        || value.schemaVersion.length > 120
        || !SHA256.test(String(value.sha256 || ''))) return null;
    return {
      id: value.id,
      schemaVersion: value.schemaVersion,
      sha256: value.sha256
    };
  });
  if (normalized.some((value) => value == null)) return null;
  normalized.sort((left, right) => (
    `${left.id}:${left.sha256}`.localeCompare(`${right.id}:${right.sha256}`)
  ));
  if (new Set(normalized.map((value) => `${value.id}:${value.sha256}`)).size
      !== normalized.length) return null;
  return normalized;
}

function normalizeProvenance(values) {
  if (!Array.isArray(values) || values.length > 256) return null;
  const normalized = values.map((value) => {
    if (!exactKeys(value, ['id', 'kind', 'observedAt', 'sha256', 'uri'])
        || !isSafeId(value.id)
        || typeof value.kind !== 'string'
        || value.kind.length < 1
        || value.kind.length > 80
        || (value.sha256 != null && !SHA256.test(String(value.sha256)))
        || (value.uri != null && (typeof value.uri !== 'string' || value.uri.length > 2048))
        || (value.observedAt != null
          && (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))))) {
      return null;
    }
    return {
      id: value.id,
      kind: value.kind,
      observedAt: value.observedAt ?? null,
      sha256: value.sha256 ?? null,
      uri: value.uri ?? null
    };
  });
  if (normalized.some((value) => value == null)) return null;
  normalized.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map((value) => value.id)).size !== normalized.length) return null;
  return normalized;
}

function validAuthority(value) {
  return exactKeys(value, [
    'actorId',
    'kind',
    'model',
    'promptSha256',
    'toolPolicy'
  ])
    && isSafeId(value.actorId)
    && typeof value.kind === 'string'
    && value.kind.length > 0
    && value.kind.length <= 80
    && (value.model == null || (typeof value.model === 'string' && value.model.length <= 120))
    && (value.promptSha256 == null || SHA256.test(String(value.promptSha256)))
    && typeof value.toolPolicy === 'string'
    && value.toolPolicy.length > 0
    && value.toolPolicy.length <= 120;
}

function validReplay(value) {
  return exactKeys(value, ['exportName', 'module', 'version'])
    && typeof value.module === 'string'
    && value.module.length > 0
    && value.module.length <= 240
    && typeof value.exportName === 'string'
    && value.exportName.length > 0
    && value.exportName.length <= 120
    && typeof value.version === 'string'
    && value.version.length > 0
    && value.version.length <= 80;
}

function validFailure(value, status) {
  if (status === 'OK') return value === null;
  return exactKeys(value, ['code', 'message'])
    && isSafeId(value.code)
    && typeof value.message === 'string'
    && value.message.length > 0
    && value.message.length <= 1000;
}

function coreFrom(input) {
  const stage = String(input.stage || '');
  const status = String(input.status || '');
  const inputRefs = normalizeInputRefs(input.inputRefs);
  const provenance = normalizeProvenance(input.provenance);
  const permittedInformation = uniqueStrings(input.permittedInformation);
  const forbiddenInformation = uniqueStrings(input.forbiddenInformation);
  if (!STAGES.has(stage)
      || !STATUSES.has(status)
      || !validAuthority(input.authority)
      || !validReplay(input.replay)
      || inputRefs == null
      || provenance == null
      || permittedInformation == null
      || forbiddenInformation == null
      || !plainObject(input.payload)
      || typeof input.createdAt !== 'string'
      || !Number.isFinite(Date.parse(input.createdAt))
      || !validFailure(input.failure ?? null, status)) return null;
  return {
    schemaVersion: VNEXT_STAGE_ENVELOPE_SCHEMA,
    stage,
    status,
    createdAt: input.createdAt,
    authority: structuredClone(input.authority),
    inputRefs,
    permittedInformation,
    forbiddenInformation,
    provenance,
    replay: structuredClone(input.replay),
    failure: input.failure ?? null,
    payload: structuredClone(input.payload)
  };
}

export function createVNextStageArtifact(input = {}) {
  const core = coreFrom(input);
  if (!core) {
    return {
      status: 'REFUSED',
      code: 'VNEXT_STAGE_ARTIFACT_INVALID',
      message: 'VNext stage artifacts require closed authority, provenance, replay, information-boundary, and failure contracts.'
    };
  }
  const artifactSha256 = sha256(canonicalVNextJson(core));
  const artifactId = `vnext-${core.stage}-${artifactSha256.slice(0, 20)}`;
  return {
    status: 'OK',
    artifact: {
      ...core,
      artifactId,
      artifactSha256
    }
  };
}

export function validateVNextStageArtifact(artifact) {
  if (!exactKeys(artifact, [
    'artifactId',
    'artifactSha256',
    'authority',
    'createdAt',
    'failure',
    'forbiddenInformation',
    'inputRefs',
    'payload',
    'permittedInformation',
    'provenance',
    'replay',
    'schemaVersion',
    'stage',
    'status'
  ]) || artifact.schemaVersion !== VNEXT_STAGE_ENVELOPE_SCHEMA) {
    return { status: 'REFUSED', code: 'VNEXT_STAGE_ARTIFACT_SHAPE' };
  }
  const core = coreFrom(artifact);
  if (!core) return { status: 'REFUSED', code: 'VNEXT_STAGE_ARTIFACT_INVALID' };
  const expectedSha256 = sha256(canonicalVNextJson(core));
  const expectedId = `vnext-${core.stage}-${expectedSha256.slice(0, 20)}`;
  if (artifact.artifactSha256 !== expectedSha256 || artifact.artifactId !== expectedId) {
    return { status: 'REFUSED', code: 'VNEXT_STAGE_ARTIFACT_TAMPERED' };
  }
  return { status: 'OK', artifact };
}
