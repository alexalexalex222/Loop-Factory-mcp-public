import { canonicalVNextJson } from './vnext-contracts.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const CONCEPTUAL_SIGNATURE_SCHEMA = 'vnext-conceptual-signature-v1';
export const CONCEPTUAL_COMPARISON_SCHEMA = 'vnext-conceptual-comparison-v1';
export const CONCEPTUAL_REVIEW_SCHEMA = 'vnext-conceptual-review-output-v1';
export const CONCEPTUAL_REVIEW_PACKET_SCHEMA = 'vnext-conceptual-review-packet-v1';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_EMBEDDING_DIMENSIONS = 4096;
const STANCES = new Set(['supports', 'contradicts', 'neutral']);
const REVIEW_VERDICTS = new Set(['PROBABLE_CLONE', 'DISTINCT', 'UNCERTAIN']);
const REVIEW_KEYS = new Set([
  'evidenceCodes',
  'pairSha256',
  'schemaVersion',
  'uncertainty',
  'verdict'
]);

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'when',
  'with'
]);

const SYNONYMS = new Map(Object.entries({
  retain: 'preserve',
  retained: 'preserve',
  retaining: 'preserve',
  keep: 'preserve',
  kept: 'preserve',
  failures: 'failure',
  failed: 'failure',
  failing: 'failure',
  errors: 'failure',
  error: 'failure',
  negatives: 'failure',
  negative: 'failure',
  precedents: 'evidence',
  precedent: 'evidence',
  records: 'evidence',
  record: 'evidence',
  learnings: 'evidence',
  learning: 'evidence',
  retries: 'retry',
  reattempt: 'retry',
  reattempts: 'retry',
  workers: 'agent',
  worker: 'agent',
  jobs: 'task',
  job: 'task',
  modules: 'component',
  module: 'component',
  subsystems: 'component',
  subsystem: 'component',
  routing: 'route',
  routed: 'route',
  routes: 'route',
  choosing: 'select',
  chosen: 'select',
  choose: 'select',
  selects: 'select',
  omitted: 'missing',
  absent: 'missing',
  outdated: 'stale',
  duplicated: 'duplicate',
  repeated: 'duplicate',
  removes: 'remove',
  removed: 'remove',
  deleting: 'remove',
  deleted: 'remove',
  delete: 'remove'
}));

const OPPOSITES = Object.freeze([
  ['accept', 'reject'],
  ['allow', 'deny'],
  ['enable', 'disable'],
  ['include', 'exclude'],
  ['increase', 'decrease'],
  ['preserve', 'remove']
]);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function refuse(code, message) {
  return { status: 'REFUSED', code, message };
}

function normalizeText(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 12000) return null;
  return value.normalize('NFKC')
    .toLowerCase()
    .replace(/\btry\s+again\b/gu, 'retry')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function semanticToken(token) {
  if (SYNONYMS.has(token)) return SYNONYMS.get(token);
  let stem = token;
  if (stem.length > 5 && stem.endsWith('ies')) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 5 && stem.endsWith('ing')) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith('ed')) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith('s')) stem = stem.slice(0, -1);
  return SYNONYMS.get(stem) ?? stem;
}

function semanticTokens(normalized) {
  return [...new Set(normalized.split(' ')
    .filter((token) => token && !STOP_WORDS.has(token))
    .map(semanticToken))].sort();
}

function normalizeTags(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) return null;
  const tags = values.map((value) => normalizeText(value))
    .map((value) => value && semanticTokens(value).join('-'));
  if (tags.some((value) => !value || value.length > 160)) return null;
  return [...new Set(tags)].sort();
}

function normalizeEmbedding(value) {
  if (value == null) return null;
  if (!Array.isArray(value)
      || value.length === 0
      || value.length > MAX_EMBEDDING_DIMENSIONS
      || value.some((number) => !Number.isFinite(number))) return undefined;
  const magnitude = Math.sqrt(value.reduce((sum, number) => sum + (number ** 2), 0));
  if (magnitude === 0) return undefined;
  return value.map((number) => number / magnitude);
}

function extractRecord(record) {
  if (!plainObject(record)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return null;
  }
  if (!serialized || Buffer.byteLength(serialized) > MAX_RECORD_BYTES) return null;
  const original = JSON.parse(serialized);
  const recordId = original.id ?? original.recordId;
  const text = original.text ?? original.statement;
  const structuralTags = original.structuralTags ?? original.tags;
  const mechanism = original.mechanismComponent ?? original.component ?? original.mechanism;
  const pathology = original.pathology ?? {
    where: original.where,
    why: original.why
  };
  const stance = original.stance ?? 'neutral';
  const canonicalText = normalizeText(text);
  const tags = normalizeTags(structuralTags);
  const canonicalMechanism = normalizeText(mechanism);
  const canonicalWhere = normalizeText(pathology?.where);
  const canonicalWhy = normalizeText(pathology?.why);
  const embedding = normalizeEmbedding(original.embedding ?? null);
  if (!isSafeId(recordId)
      || !canonicalText
      || !tags
      || !canonicalMechanism
      || !canonicalWhere
      || !canonicalWhy
      || !STANCES.has(stance)
      || embedding === undefined) return null;
  return {
    recordId,
    original,
    features: {
      canonicalText,
      semanticTokens: semanticTokens(canonicalText),
      structuralTags: tags,
      mechanismComponent: semanticTokens(canonicalMechanism).join(' '),
      pathology: {
        where: semanticTokens(canonicalWhere).join(' '),
        why: semanticTokens(canonicalWhy).join(' ')
      },
      stance,
      embedding
    }
  };
}

function signatureCore(signature) {
  return {
    schemaVersion: signature.schemaVersion,
    recordId: signature.recordId,
    original: signature.original,
    features: signature.features
  };
}

function validSignature(signature) {
  if (!plainObject(signature)
      || Object.keys(signature).sort().join(',')
        !== ['features', 'original', 'recordId', 'schemaVersion', 'signatureSha256'].sort().join(',')
      || signature.schemaVersion !== CONCEPTUAL_SIGNATURE_SCHEMA
      || !isSafeId(signature.recordId)) return false;
  const extracted = extractRecord(signature.original);
  return !!extracted
    && extracted.recordId === signature.recordId
    && canonicalVNextJson(extracted.features) === canonicalVNextJson(signature.features)
    && signature.signatureSha256 === sha256(canonicalVNextJson(signatureCore(signature)));
}

export function createConceptualSignature(record = {}) {
  const extracted = extractRecord(record);
  if (!extracted) {
    return refuse(
      'CONCEPTUAL_RECORD_INVALID',
      'Learning records require a safe id, text, structural tags, mechanism component, where/why pathology, valid stance, and optional finite embedding.'
    );
  }
  const core = {
    schemaVersion: CONCEPTUAL_SIGNATURE_SCHEMA,
    ...extracted
  };
  return {
    status: 'OK',
    signature: {
      ...core,
      signatureSha256: sha256(canonicalVNextJson(core))
    }
  };
}

function setSimilarity(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((value) => rightSet.has(value)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 1 : intersection / union;
}

function cosine(left, right) {
  if (left == null || right == null) return null;
  if (left.length !== right.length) return 'dimension-mismatch';
  return left.reduce((sum, value, index) => sum + (value * right[index]), 0);
}

function opposingClaims(left, right) {
  if ((left.stance === 'supports' && right.stance === 'contradicts')
      || (left.stance === 'contradicts' && right.stance === 'supports')) return true;
  const leftTokens = new Set(left.semanticTokens);
  const rightTokens = new Set(right.semanticTokens);
  for (const [positive, negative] of OPPOSITES) {
    if ((leftTokens.has(positive) && rightTokens.has(negative))
        || (leftTokens.has(negative) && rightTokens.has(positive))) return true;
  }
  const negations = new Set(['no', 'not', 'never', 'without']);
  const leftNegated = [...negations].some((token) => leftTokens.has(token));
  const rightNegated = [...negations].some((token) => rightTokens.has(token));
  if (leftNegated === rightNegated) return false;
  const leftBase = [...leftTokens].filter((token) => !negations.has(token));
  const rightBase = [...rightTokens].filter((token) => !negations.has(token));
  return setSimilarity(leftBase, rightBase) >= 0.7;
}

function evidenceRow(code, value) {
  return { code, value };
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function recommendationFor(classification, contradiction, originals, reason) {
  const ids = originals.map(({ recordId }) => recordId);
  if (contradiction) {
    return {
      mode: 'append-only',
      action: 'record-contradiction',
      preserveOriginalIds: ids,
      canonicalRecordId: null,
      aliasRecordId: null,
      reason
    };
  }
  if (classification === 'exact-clone' || classification === 'probable-clone') {
    return {
      mode: 'append-only',
      action: 'alias',
      preserveOriginalIds: ids,
      canonicalRecordId: ids[0],
      aliasRecordId: ids[1],
      reason
    };
  }
  return {
    mode: 'append-only',
    action: classification === 'uncertain' ? 'manual-review' : 'none',
    preserveOriginalIds: ids,
    canonicalRecordId: null,
    aliasRecordId: null,
    reason
  };
}

function comparisonCore(comparison) {
  const { comparisonSha256: ignored, ...core } = comparison;
  return core;
}

export function compareConceptualSignatures(leftSignature, rightSignature) {
  if (!validSignature(leftSignature) || !validSignature(rightSignature)) {
    return refuse('CONCEPTUAL_SIGNATURE_INVALID', 'Both conceptual signatures must pass integrity validation.');
  }
  if (leftSignature.signatureSha256 === rightSignature.signatureSha256) {
    return refuse('CONCEPTUAL_PAIR_INVALID', 'A conceptual pair must contain two preserved records.');
  }
  const [left, right] = [leftSignature, rightSignature].sort((a, b) => (
    `${a.recordId}:${a.signatureSha256}`.localeCompare(`${b.recordId}:${b.signatureSha256}`)
  ));
  const a = left.features;
  const b = right.features;
  const textSimilarity = setSimilarity(a.semanticTokens, b.semanticTokens);
  const tagSimilarity = setSimilarity(a.structuralTags, b.structuralTags);
  const mechanismMatch = a.mechanismComponent === b.mechanismComponent;
  const whereMatch = a.pathology.where === b.pathology.where;
  const whyMatch = a.pathology.why === b.pathology.why;
  const embeddingSimilarity = cosine(a.embedding, b.embedding);
  const contradiction = opposingClaims(a, b)
    && mechanismMatch
    && (whereMatch || whyMatch)
    && textSimilarity >= 0.25;
  const embeddingMismatch = embeddingSimilarity === 'dimension-mismatch';
  const embeddingConflict = typeof embeddingSimilarity === 'number' && embeddingSimilarity < 0.35;
  const exactStructure = tagSimilarity === 1 && mechanismMatch && whereMatch && whyMatch;
  const exactText = a.canonicalText === b.canonicalText;
  const structureSupport = mechanismMatch && whereMatch && whyMatch && tagSimilarity >= 0.5;

  let classification;
  let reason;
  if (contradiction) {
    classification = 'distinct';
    reason = 'The records share pathology coordinates but make opposing claims.';
  } else if (embeddingMismatch) {
    classification = 'uncertain';
    reason = 'Caller-supplied embeddings have incompatible dimensions.';
  } else if (exactText && exactStructure && !embeddingConflict && a.stance === b.stance) {
    classification = 'exact-clone';
    reason = 'Canonical text and all structural coordinates are identical.';
  } else if (structureSupport
      && ((textSimilarity >= 0.45 && !embeddingConflict)
        || (typeof embeddingSimilarity === 'number'
          && embeddingSimilarity >= 0.9
          && textSimilarity >= 0.15))) {
    classification = 'probable-clone';
    reason = 'Textual meaning and the mechanism/pathology coordinates converge.';
  } else if ((embeddingConflict && textSimilarity < 0.45)
      || (!mechanismMatch && !whereMatch && !whyMatch)
      || (textSimilarity < 0.15 && tagSimilarity < 0.34)) {
    classification = 'distinct';
    reason = 'The available semantic and structural evidence separates the records.';
  } else {
    classification = 'uncertain';
    reason = 'Evidence is mixed or insufficient for a conservative alias recommendation.';
  }

  const prefiltered = !contradiction
    && mechanismMatch
    && (whereMatch || whyMatch || tagSimilarity >= 0.5)
    && (textSimilarity >= 0.15
      || (typeof embeddingSimilarity === 'number' && embeddingSimilarity >= 0.65));
  const evidence = [
    evidenceRow('CANONICAL_TEXT_MATCH', exactText),
    evidenceRow('TEXT_TOKEN_SIMILARITY', round(textSimilarity)),
    evidenceRow('STRUCTURAL_TAG_SIMILARITY', round(tagSimilarity)),
    evidenceRow('MECHANISM_MATCH', mechanismMatch),
    evidenceRow('PATHOLOGY_WHERE_MATCH', whereMatch),
    evidenceRow('PATHOLOGY_WHY_MATCH', whyMatch),
    evidenceRow('EXPLICIT_CONTRADICTION', contradiction),
    evidenceRow(
      'EMBEDDING_SIMILARITY',
      typeof embeddingSimilarity === 'number' ? round(embeddingSimilarity) : embeddingSimilarity
    )
  ];
  const originals = [
    { recordId: left.recordId, record: structuredClone(left.original) },
    { recordId: right.recordId, record: structuredClone(right.original) }
  ];
  const pairSha256 = sha256(canonicalVNextJson([
    left.signatureSha256,
    right.signatureSha256
  ].sort()));
  const core = {
    schemaVersion: CONCEPTUAL_COMPARISON_SCHEMA,
    pairSha256,
    classification,
    prefiltered,
    evidence,
    originals,
    recommendation: recommendationFor(classification, contradiction, originals, reason)
  };
  const comparison = {
    ...core,
    comparisonSha256: sha256(canonicalVNextJson(core))
  };
  return { status: 'OK', comparison };
}

function validComparison(comparison) {
  if (!plainObject(comparison)
      || Object.keys(comparison).sort().join(',') !== [
        'classification',
        'comparisonSha256',
        'evidence',
        'originals',
        'pairSha256',
        'prefiltered',
        'recommendation',
        'schemaVersion'
      ].sort().join(',')
      || comparison.schemaVersion !== CONCEPTUAL_COMPARISON_SCHEMA
      || comparison.comparisonSha256 !== sha256(canonicalVNextJson(comparisonCore(comparison)))
      || !Array.isArray(comparison.originals)
      || comparison.originals.length !== 2) return false;
  const rebuiltSignatures = comparison.originals.map(({ recordId, record } = {}) => {
    const built = createConceptualSignature(record);
    return built.status === 'OK' && built.signature.recordId === recordId
      ? built.signature
      : null;
  });
  if (rebuiltSignatures.some((signature) => signature == null)) return false;
  const rebuilt = compareConceptualSignatures(...rebuiltSignatures);
  return rebuilt.status === 'OK'
    && canonicalVNextJson(rebuilt.comparison) === canonicalVNextJson(comparison);
}

function evidenceSupportsVerdict(evidence, verdict) {
  const rows = new Map(evidence.map(({ code, value }) => [code, value]));
  if (verdict === 'UNCERTAIN') return true;
  if (verdict === 'PROBABLE_CLONE') {
    return [...rows].some(([code, value]) => (
      (['CANONICAL_TEXT_MATCH', 'MECHANISM_MATCH', 'PATHOLOGY_WHERE_MATCH', 'PATHOLOGY_WHY_MATCH'].includes(code)
        && value === true)
      || (code === 'TEXT_TOKEN_SIMILARITY' && value >= 0.45)
      || (code === 'STRUCTURAL_TAG_SIMILARITY' && value >= 0.5)
      || (code === 'EMBEDDING_SIMILARITY' && typeof value === 'number' && value >= 0.65)
    ));
  }
  return [...rows].some(([code, value]) => (
    (code === 'EXPLICIT_CONTRADICTION' && value === true)
    || (['MECHANISM_MATCH', 'PATHOLOGY_WHERE_MATCH', 'PATHOLOGY_WHY_MATCH'].includes(code)
      && value === false)
    || (code === 'TEXT_TOKEN_SIMILARITY' && value < 0.15)
    || (code === 'EMBEDDING_SIMILARITY' && typeof value === 'number' && value < 0.35)
  ));
}

function sanitizedReviewRecord({ recordId, record }) {
  const text = record.text ?? record.statement;
  const structuralTags = record.structuralTags ?? record.tags;
  const mechanismComponent = record.mechanismComponent
    ?? record.component
    ?? record.mechanism;
  const pathology = record.pathology ?? { where: record.where, why: record.why };
  const verifierEvidenceHashes = Array.isArray(record.verifierEvidenceHashes)
    ? [...new Set(record.verifierEvidenceHashes
      .filter((value) => /^[a-f0-9]{64}$/.test(String(value))))].sort().slice(0, 64)
    : [];
  return {
    recordId,
    text,
    structuralTags: structuredClone(structuralTags),
    mechanismComponent,
    pathology: structuredClone(pathology),
    stance: record.stance ?? 'neutral',
    verifierEvidenceHashes
  };
}

export function buildConceptualReviewPacket(comparison) {
  if (!validComparison(comparison)) {
    return refuse('CONCEPTUAL_COMPARISON_INVALID', 'Conceptual comparison integrity failed.');
  }
  if (!comparison.prefiltered
      || !['probable-clone', 'uncertain'].includes(comparison.classification)) {
    return refuse('CONCEPTUAL_REVIEW_NOT_ALLOWED', 'Only deterministic prefiltered pairs may enter model review.');
  }
  const core = {
    schemaVersion: CONCEPTUAL_REVIEW_PACKET_SCHEMA,
    pairSha256: comparison.pairSha256,
    comparisonSha256: comparison.comparisonSha256,
    deterministicClassification: comparison.classification,
    records: comparison.originals.map(sanitizedReviewRecord),
    evidence: structuredClone(comparison.evidence),
    allowedEvidenceCodes: comparison.evidence.map(({ code }) => code).sort(),
    outputSchemaVersion: CONCEPTUAL_REVIEW_SCHEMA,
    activationAuthority: false
  };
  return {
    status: 'OK',
    packet: {
      ...core,
      packetSha256: sha256(canonicalVNextJson(core))
    }
  };
}

export function applyModelAssistedConceptualReview({ comparison, output } = {}) {
  if (!validComparison(comparison)) {
    return refuse('CONCEPTUAL_COMPARISON_INVALID', 'Conceptual comparison integrity failed.');
  }
  if (!comparison.prefiltered
      || !['probable-clone', 'uncertain'].includes(comparison.classification)) {
    return refuse('CONCEPTUAL_REVIEW_NOT_ALLOWED', 'A model may review only deterministic prefiltered clone candidates.');
  }
  if (!plainObject(output)
      || Object.keys(output).length !== REVIEW_KEYS.size
      || Object.keys(output).some((key) => !REVIEW_KEYS.has(key))
      || output.schemaVersion !== CONCEPTUAL_REVIEW_SCHEMA
      || output.pairSha256 !== comparison.pairSha256
      || !REVIEW_VERDICTS.has(output.verdict)
      || !Number.isFinite(output.uncertainty)
      || output.uncertainty < 0
      || output.uncertainty > 1
      || !Array.isArray(output.evidenceCodes)
      || output.evidenceCodes.length > 8
      || new Set(output.evidenceCodes).size !== output.evidenceCodes.length) {
    return refuse('CONCEPTUAL_REVIEW_OUTPUT_INVALID', 'Model review output must use the closed pair-bound contract.');
  }
  const availableCodes = new Set(comparison.evidence.map(({ code }) => code));
  if (output.evidenceCodes.some((code) => !availableCodes.has(code))) {
    return refuse('CONCEPTUAL_REVIEW_HALLUCINATED_EVIDENCE', 'Model review cited evidence outside the prefiltered pair.');
  }
  const citedEvidence = comparison.evidence.filter(({ code }) => output.evidenceCodes.includes(code));
  if (!evidenceSupportsVerdict(citedEvidence, output.verdict)) {
    return refuse('CONCEPTUAL_REVIEW_UNSUPPORTED_VERDICT', 'Model review verdict is unsupported by its cited pair evidence.');
  }

  let classification = comparison.classification;
  let recommendation = structuredClone(comparison.recommendation);
  if (comparison.classification === 'probable-clone' && output.verdict !== 'PROBABLE_CLONE') {
    classification = 'uncertain';
    recommendation = recommendationFor(
      'uncertain',
      false,
      comparison.originals,
      'The closed model review did not affirm the deterministic probable-clone candidate.'
    );
  }
  if (comparison.classification === 'uncertain') {
    classification = 'uncertain';
    recommendation = recommendationFor(
      'uncertain',
      false,
      comparison.originals,
      'Model review cannot upgrade a deterministically uncertain pair.'
    );
  }
  const core = {
    ...comparisonCore(comparison),
    classification,
    recommendation,
    modelReview: structuredClone(output)
  };
  return {
    status: 'OK',
    comparison: {
      ...core,
      comparisonSha256: sha256(canonicalVNextJson(core))
    }
  };
}

export const buildConceptualSignature = createConceptualSignature;
export const classifyConceptualPair = compareConceptualSignatures;
export const applyConceptualReview = applyModelAssistedConceptualReview;
