import { sha256 } from './util.mjs';
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
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';

export const VNEXT_HYBRID_RETRIEVAL_SCHEMA = 'vnext-hybrid-retrieval-v1';

const POSITIVE_KINDS = new Set(['positive']);
const NEGATIVE_KINDS = new Set(['no-improvement', 'regression', 'contradiction', 'sham', 'failure']);
const ELIGIBLE_LIFECYCLES = new Set(['observed', 'replicated', 'active', 'contradicted']);
const FORBIDDEN_QUERY_KEYS = new Set([
  'finalTasks', 'sealedTasks', 'futureResults', 'armLabels',
  'proposerConversation', 'hiddenEvaluatorMaterial', 'activationAuthority'
]);
const TARGET_COMPATIBILITY_KEYS = new Set([
  'component',
  'domains',
  'schemaVersions',
  'model',
  'models',
  'harnessSha256',
  'harnessSha256s',
  'toolEnvironmentSha256',
  'toolEnvironmentSha256s',
  'permissions',
  'securityRequirements',
  'versionConstraints'
]);

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function containsForbiddenKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, seen));
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_QUERY_KEYS.has(key) || containsForbiddenKey(child, seen)
  ));
}

function canonicalOrNull(value) {
  try {
    return canonicalVNextJson(value);
  } catch {
    return null;
  }
}

function tokenize(value) {
  return [...new Set(String(value ?? '').toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((token) => token.length > 1 && token.length <= 64))].sort();
}

function overlap(queryTokens, rowTokens) {
  if (!queryTokens.length || !rowTokens.length) return 0;
  const row = new Set(rowTokens);
  return queryTokens.filter((token) => row.has(token)).length / queryTokens.length;
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length
      || left.some((value) => !Number.isFinite(value)) || right.some((value) => !Number.isFinite(value))) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return (dot / Math.sqrt(leftNorm * rightNorm) + 1) / 2;
}

function targetValues(target, singular, plural) {
  const values = [target?.[singular], ...(Array.isArray(target?.[plural]) ? target[plural] : [])]
    .filter((value) => value != null)
    .map((value) => String(value));
  return [...new Set(values)];
}

function intersects(required, available) {
  return required.length === 0 || required.some((value) => available.includes(value));
}

function subset(required, available) {
  return required.length === 0 || required.every((value) => available.includes(value));
}

function compatibilityTargetValid(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).some((key) => !TARGET_COMPATIBILITY_KEYS.has(key))) return false;
  const arrays = [
    'domains', 'schemaVersions', 'models', 'harnessSha256s',
    'toolEnvironmentSha256s', 'permissions', 'securityRequirements',
    'versionConstraints'
  ];
  return arrays.every((key) => target[key] == null || (
    Array.isArray(target[key])
    && target[key].every((value) => typeof value === 'string' && value.length > 0)
  ));
}

function compatible(record, target = {}) {
  const compatibility = record.compatibility;
  if (target.component && compatibility.component && target.component !== compatibility.component) return false;
  if (Array.isArray(target.domains) && target.domains.length > 0
      && compatibility.domains.length > 0
      && !target.domains.some((domain) => compatibility.domains.includes(domain))) return false;
  if (Array.isArray(target.schemaVersions) && target.schemaVersions.length > 0
      && compatibility.schemaVersions.length > 0
      && !target.schemaVersions.some((schema) => compatibility.schemaVersions.includes(schema))) return false;
  const models = targetValues(target, 'model', 'models');
  const harnesses = targetValues(target, 'harnessSha256', 'harnessSha256s');
  const tools = targetValues(target, 'toolEnvironmentSha256', 'toolEnvironmentSha256s');
  return intersects(compatibility.models, models)
    && intersects(compatibility.harnessSha256s, harnesses)
    && intersects(compatibility.toolEnvironmentSha256s, tools)
    && subset(compatibility.permissions, target.permissions ?? [])
    && subset(compatibility.securityRequirements, target.securityRequirements ?? [])
    && subset(compatibility.versionConstraints, target.versionConstraints ?? []);
}

function rowTokens(record) {
  return tokenize(canonicalVNextJson({
    content: record.content,
    kind: record.kind,
    component: record.compatibility.component,
    domains: record.compatibility.domains,
    tags: record.compatibility.tags
  }));
}

function compareRows(left, right) {
  return right.baseScore - left.baseScore
    || right.lexicalScore - left.lexicalScore
    || right.semanticScore - left.semanticScore
    || left.record.recordId.localeCompare(right.record.recordId);
}

function structuralDistance(left, right) {
  const a = new Set(left.record.compatibility.tags);
  const b = new Set(right.record.compatibility.tags);
  if (!a.size && !b.size) {
    return left.record.compatibility.component === right.record.compatibility.component ? 0 : 1;
  }
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  const union = new Set([...a, ...b]).size;
  return 1 - intersection / union;
}

function publicCandidate(row) {
  return {
    recordId: row.record.recordId,
    recordSha256: row.record.recordSha256,
    kind: row.record.kind,
    availableAt: row.record.availableAt,
    lifecycle: row.record.lifecycle.state,
    compatibility: row.record.compatibility,
    metrics: row.record.metrics,
    content: row.record.content,
    lexicalScore: row.lexicalScore,
    semanticScore: row.semanticScore,
    baseScore: row.baseScore
  };
}

export function buildHybridRetrievalCandidatePool({
  records = [],
  query,
  queryAt,
  compatibility = {},
  embeddings = {},
  queryEmbedding = null,
  maximumCandidates = 64,
  allowFixtureRecords = false
} = {}) {
  if (!Array.isArray(records) || !validIso(queryAt) || typeof allowFixtureRecords !== 'boolean'
      || !Number.isInteger(maximumCandidates)
      || maximumCandidates < 1 || maximumCandidates > 512 || containsForbiddenKey(query)) {
    return refused('RETRIEVAL_INPUT_INVALID', 'Retrieval requires records, a decision time, and a bounded candidate limit.');
  }
  if (!compatibilityTargetValid(compatibility)) {
    return refused('RETRIEVAL_COMPATIBILITY_INVALID', 'Retrieval compatibility must use the closed environment contract.');
  }
  const queryCanonical = canonicalOrNull(query ?? {});
  if (queryCanonical == null) return refused('RETRIEVAL_INPUT_INVALID', 'Retrieval query must be finite canonical JSON.');
  const counts = {
    input: records.length,
    malformed: 0,
    tampered: 0,
    unverified: 0,
    quarantined: 0,
    lifecycle: 0,
    future: 0,
    incompatible: 0,
    duplicate: 0,
    eligible: 0
  };
  const queryTokens = tokenize(queryCanonical);
  const byId = new Map();
  const validHashes = new Map();
  for (const record of records) {
    if (validateVNextEvidenceRecord(record, { allowFixtureRecords }).status !== 'OK') continue;
    const hashes = validHashes.get(record.recordId) ?? new Set();
    hashes.add(record.recordSha256);
    validHashes.set(record.recordId, hashes);
  }
  const conflictingIds = new Set([...validHashes]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([recordId]) => recordId));
  const orderedRecords = [...records].sort((left, right) => (
    `${left?.recordId ?? ''}:${left?.recordSha256 ?? ''}`
      .localeCompare(`${right?.recordId ?? ''}:${right?.recordSha256 ?? ''}`)
  ));
  for (const record of orderedRecords) {
    const valid = validateVNextEvidenceRecord(record, { allowFixtureRecords });
    if (valid.status !== 'OK') {
      if (valid.code === 'EVIDENCE_RECORD_TAMPERED') counts.tampered++;
      else counts.malformed++;
      continue;
    }
    if (!record.verifierEligible) { counts.unverified++; continue; }
    if (conflictingIds.has(record.recordId)) { counts.duplicate++; continue; }
    if (record.lifecycle.quarantined) { counts.quarantined++; continue; }
    if (!ELIGIBLE_LIFECYCLES.has(record.lifecycle.state)) { counts.lifecycle++; continue; }
    if (Date.parse(record.availableAt) > Date.parse(queryAt)) { counts.future++; continue; }
    if (!compatible(record, compatibility)) { counts.incompatible++; continue; }
    if (byId.has(record.recordId)) { counts.duplicate++; continue; }
    const lexicalScore = overlap(queryTokens, rowTokens(record));
    const semantic = cosine(queryEmbedding, embeddings?.[record.recordId]);
    const semanticScore = semantic ?? 0;
    const baseScore = Number((lexicalScore * 0.7 + semanticScore * 0.3).toFixed(8));
    byId.set(record.recordId, { record, lexicalScore, semanticScore, baseScore });
  }
  const rows = [...byId.values()].sort(compareRows).slice(0, maximumCandidates);
  counts.eligible = rows.length;
  return { status: 'OK', rows, counts, queryTokens, queryCanonical };
}

function applyReranker(rows, rerankerOutput) {
  if (rerankerOutput == null) return { rows, source: 'deterministic', fallbackReason: null };
  const valid = validateVNextModelOutput(rerankerOutput, VNEXT_MODEL_SCHEMA.RERANKER);
  if (valid.status !== 'OK') {
    return { rows, source: 'deterministic-fallback', fallbackReason: 'RERANKER_OUTPUT_INVALID' };
  }
  const eligibleIds = new Set(rows.map((row) => row.record.recordId));
  if (rerankerOutput.rankings.some((ranking) => !eligibleIds.has(ranking.recordId))) {
    return { rows, source: 'deterministic-fallback', fallbackReason: 'RERANKER_ID_INELIGIBLE' };
  }
  if (rerankerOutput.abstain) {
    return { rows, source: 'deterministic-fallback', fallbackReason: 'RERANKER_ABSTAINED' };
  }
  const rankings = new Map(rerankerOutput.rankings.map((ranking, index) => [ranking.recordId, { ranking, index }]));
  const reranked = rows.map((row) => {
    const entry = rankings.get(row.record.recordId);
    if (!entry) return { ...row, rerankerScore: null, rerankerRank: null };
    const rank = entry.ranking;
    const rerankerScore = (
      rank.applicability * 0.25
      + rank.structuralSimilarity * 0.2
      + rank.expectedBenefit * 0.2
      + (1 - rank.transferUncertainty) * 0.1
      + (1 - rank.contradictionRisk) * 0.1
      + rank.confidence * 0.15
    );
    return { ...row, rerankerScore, rerankerRank: entry.index };
  }).sort((left, right) => {
    const leftRanked = left.rerankerRank != null;
    const rightRanked = right.rerankerRank != null;
    if (leftRanked !== rightRanked) return leftRanked ? -1 : 1;
    if (leftRanked && left.rerankerRank !== right.rerankerRank) return left.rerankerRank - right.rerankerRank;
    return compareRows(left, right);
  });
  return { rows: reranked, source: 'fresh-worker-reranker', fallbackReason: null };
}

function selectRows(rows, { maximumSelected, exploreUncertainty, queryUncertainty }) {
  const selected = [];
  const add = (row, role) => {
    if (!row || selected.length >= maximumSelected || selected.some((item) => item.row.record.recordId === row.record.recordId)) return;
    selected.push({ row, role });
  };
  add(rows.find((row) => POSITIVE_KINDS.has(row.record.kind)), 'strongest-positive');
  add(rows.find((row) => NEGATIVE_KINDS.has(row.record.kind)), 'strongest-negative');
  const remaining = rows.filter((row) => !selected.some((item) => item.row.record.recordId === row.record.recordId));
  const diverse = remaining.map((row) => ({
    row,
    distance: selected.length
      ? Math.min(...selected.map((item) => structuralDistance(row, item.row)))
      : 1
  })).sort((left, right) => right.distance - left.distance || compareRows(left.row, right.row))[0]?.row;
  add(diverse, 'diverse-alternative');
  const uncertaintyJustified = exploreUncertainty === true
    && (Number(queryUncertainty) >= 0.6 || !selected.some((item) => item.role === 'strongest-positive'));
  if (uncertaintyJustified) {
    const exploratory = rows.filter((row) => !selected.some((item) => item.row.record.recordId === row.record.recordId))
      .sort((left, right) => (right.record.metrics.uncertainty ?? 0) - (left.record.metrics.uncertainty ?? 0)
        || compareRows(left, right))[0];
    add(exploratory, 'uncertainty-exploration');
  }
  for (const row of rows) add(row, 'ranked-fill');
  return { selected, uncertaintyJustified };
}

export async function buildHybridRetrieval(input = {}) {
  const maximumSelected = input.maximumSelected ?? 4;
  if (!Number.isInteger(maximumSelected) || maximumSelected < 1 || maximumSelected > 16) {
    return refused('RETRIEVAL_SELECTION_LIMIT_INVALID', 'Retrieval selection limit is invalid.');
  }
  const pool = buildHybridRetrievalCandidatePool(input);
  if (pool.status !== 'OK') return pool;
  if (pool.rows.length === 0) {
    const payload = {
      schemaVersion: VNEXT_HYBRID_RETRIEVAL_SCHEMA,
      evidenceAuthorityMode: input.allowFixtureRecords === true
        ? 'fixture-enabled'
        : 'verifier-owned-only',
      queryAt: input.queryAt,
      querySha256: sha256(pool.queryCanonical),
      embeddingsSha256: null,
      rerankerOutputSha256: null,
      filterCounts: pool.counts,
      ranking: {
        source: 'deterministic-abstention',
        fallbackReason: 'NO_ELIGIBLE_EVIDENCE',
        candidateIds: [],
        rows: []
      },
      candidatePool: [],
      selection: [],
      uncertaintyExplorationJustified: false
    };
    const artifact = createVNextStageArtifact({
      stage: VNEXT_STAGE.RETRIEVAL,
      status: 'ABSTAINED',
      createdAt: input.queryAt,
      authority: input.authority ?? {
        actorId: 'vnext-hybrid-retrieval',
        kind: 'deterministic-filter-and-selector',
        model: null,
        promptSha256: null,
        toolPolicy: 'none'
      },
      inputRefs: [],
      permittedInformation: ['normalized failure', 'deterministically eligible public evidence rows'],
      forbiddenInformation: ['quarantined raw content', 'final sealed tasks', 'future outcomes', 'activation authority'],
      provenance: [],
      replay: { module: 'src/hybrid-retrieval.mjs', exportName: 'buildHybridRetrieval', version: 'v1' },
      failure: {
        code: 'RETRIEVAL_NO_ELIGIBLE_EVIDENCE',
        message: 'No verifier-eligible, compatible, available evidence survived deterministic filtering.'
      },
      payload
    });
    return deepFreeze({
      status: 'ABSTAINED',
      code: 'RETRIEVAL_NO_ELIGIBLE_EVIDENCE',
      message: 'No verifier-eligible, compatible, available evidence survived deterministic filtering.',
      counts: pool.counts,
      artifact: artifact.artifact
    });
  }
  let rerankerOutput = input.rerankerOutput ?? null;
  if (typeof input.rerankerWorker === 'function') {
    try {
      rerankerOutput = await input.rerankerWorker(deepFreeze({
        schemaVersion: 'vnext-reranker-request-v1',
        query: structuredClone(input.query ?? {}),
        queryAt: input.queryAt,
        candidates: pool.rows.map(publicCandidate),
        forbiddenInformation: ['quarantined records', 'final sealed tasks', 'future outcomes', 'activation authority']
      }));
      if (typeof rerankerOutput === 'string') rerankerOutput = JSON.parse(rerankerOutput);
    } catch {
      rerankerOutput = { invalidWorkerOutput: true };
    }
  }
  const ranked = applyReranker(pool.rows, rerankerOutput);
  const selection = selectRows(ranked.rows, {
    maximumSelected,
    exploreUncertainty: input.exploreUncertainty,
    queryUncertainty: input.query?.uncertainty
  });
  const embeddingsCanonical = canonicalOrNull({
    queryEmbedding: input.queryEmbedding,
    embeddings: input.embeddings ?? {}
  });
  const rerankerCanonical = rerankerOutput == null ? null : canonicalOrNull(rerankerOutput);
  if (embeddingsCanonical == null || (rerankerOutput != null && rerankerCanonical == null)) {
    return refused('RETRIEVAL_INPUT_INVALID', 'Embedding and reranker receipts must be finite canonical JSON.');
  }
  const payload = {
    schemaVersion: VNEXT_HYBRID_RETRIEVAL_SCHEMA,
    evidenceAuthorityMode: input.allowFixtureRecords === true
      ? 'fixture-enabled'
      : 'verifier-owned-only',
    queryAt: input.queryAt,
    querySha256: sha256(pool.queryCanonical),
    embeddingsSha256: input.queryEmbedding == null && Object.keys(input.embeddings ?? {}).length === 0
      ? null
      : sha256(embeddingsCanonical),
    rerankerOutputSha256: rerankerCanonical == null ? null : sha256(rerankerCanonical),
    filterCounts: pool.counts,
    ranking: {
      source: ranked.source,
      fallbackReason: ranked.fallbackReason,
      candidateIds: ranked.rows.map((row) => row.record.recordId),
      rows: ranked.rows.map((row) => ({
        recordId: row.record.recordId,
        rerankerRank: row.rerankerRank ?? null,
        rerankerScore: row.rerankerScore == null ? null : Number(row.rerankerScore.toFixed(8))
      }))
    },
    candidatePool: pool.rows.map(publicCandidate),
    selection: selection.selected.map(({ row, role }) => ({
      role,
      ...publicCandidate(row)
    })),
    uncertaintyExplorationJustified: selection.uncertaintyJustified
  };
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.RETRIEVAL,
    status: 'OK',
    createdAt: input.queryAt,
    authority: input.authority ?? {
      actorId: 'vnext-hybrid-retrieval',
      kind: 'deterministic-filter-and-selector',
      model: null,
      promptSha256: null,
      toolPolicy: typeof input.rerankerWorker === 'function' ? 'caller-supplied-reranker' : 'none'
    },
    inputRefs: pool.rows.map((row) => ({
      id: row.record.recordId,
      schemaVersion: row.record.schemaVersion,
      sha256: row.record.recordSha256
    })),
    permittedInformation: ['normalized failure', 'deterministically eligible public evidence rows'],
    forbiddenInformation: ['quarantined raw content', 'final sealed tasks', 'future outcomes', 'activation authority'],
    provenance: pool.rows.map((row) => ({
      id: row.record.recordId,
      kind: 'verifier-evidence-record',
      observedAt: row.record.availableAt,
      sha256: row.record.recordSha256,
      uri: null
    })),
    replay: { module: 'src/hybrid-retrieval.mjs', exportName: 'buildHybridRetrieval', version: 'v1' },
    failure: null,
    payload
  });
  return artifact.status === 'OK' ? deepFreeze({ status: 'OK', artifact: artifact.artifact }) : artifact;
}

export function validateHybridRetrievalReceipt(artifact) {
  const valid = validateVNextStageArtifact(artifact);
  if (valid.status !== 'OK' || artifact.stage !== VNEXT_STAGE.RETRIEVAL
      || artifact.payload?.schemaVersion !== VNEXT_HYBRID_RETRIEVAL_SCHEMA
      || !['fixture-enabled', 'verifier-owned-only']
        .includes(artifact.payload?.evidenceAuthorityMode)) {
    return refused('RETRIEVAL_RECEIPT_INVALID', 'Hybrid retrieval receipt is invalid or has the wrong stage.');
  }
  const poolIds = new Set(artifact.payload.candidatePool.map((row) => row.recordId));
  if (poolIds.size !== artifact.payload.candidatePool.length
      || artifact.payload.selection.some((row) => !poolIds.has(row.recordId))
      || (artifact.status === 'ABSTAINED'
        && (artifact.payload.candidatePool.length !== 0
          || artifact.payload.selection.length !== 0))) {
    return refused('RETRIEVAL_RECEIPT_SCOPE_INVALID', 'Selection escaped its frozen candidate pool.');
  }
  return { status: 'OK', artifact };
}

export const retrieveHybridEvidence = buildHybridRetrieval;
