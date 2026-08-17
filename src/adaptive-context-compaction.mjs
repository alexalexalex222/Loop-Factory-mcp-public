import { canonicalAdaptiveJson } from './adaptive-records.mjs';
import { validateAdaptiveContextPolicy } from './adaptive-context-policy.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const LOSSLESS_CONTEXT_INDEX_SCHEMA = 'lossless-context-index-v1';

const SHA256_RE = /^[a-f0-9]{64}$/;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function validSha(value) {
  return SHA256_RE.test(String(value || ''));
}

function normalizeRecord(input) {
  if (!input
      || !isSafeId(input.recordId)
      || !isSafeId(input.artifactRef)
      || !validSha(input.artifactSha256)
      || typeof input.content !== 'string'
      || sha256(input.content) !== input.artifactSha256
      || !Number.isFinite(input.priority)
      || !['active', 'verified', 'observed', 'failed'].includes(input.lifecycle)) {
    return null;
  }
  return {
    recordId: input.recordId,
    artifactRef: input.artifactRef,
    artifactSha256: input.artifactSha256,
    content: input.content,
    bytes: Buffer.byteLength(input.content),
    priority: input.priority,
    lifecycle: input.lifecycle,
    semanticSha256: validSha(input.semanticSha256)
      ? input.semanticSha256
      : sha256(input.content)
  };
}

function lifecycleRank(lifecycle) {
  return { active: 4, verified: 3, observed: 2, failed: 1 }[lifecycle] || 0;
}

function indexPayload(record) {
  const copy = structuredClone(record);
  delete copy.indexSha256;
  return copy;
}

export function buildLosslessContextProjection({
  policy,
  records,
  bytesPerToken = 4
} = {}) {
  const checked = validateAdaptiveContextPolicy(policy);
  if (checked.status !== 'OK') return checked;
  if (!Array.isArray(records)
      || !records.length
      || !Number.isFinite(bytesPerToken)
      || bytesPerToken < 1
      || bytesPerToken > 8) {
    return refused('CONTEXT_RECORDS_INVALID', 'A bounded nonempty context record set is required.');
  }
  const normalized = records.map(normalizeRecord);
  if (normalized.some((record) => record == null)) {
    return refused('CONTEXT_RECORD_INVALID', 'Every context record must bind immutable full bytes.');
  }
  if (new Set(normalized.map((record) => record.recordId)).size !== normalized.length
      || new Set(normalized.map((record) => record.artifactRef)).size !== normalized.length) {
    return refused('CONTEXT_RECORD_DUPLICATED', 'Context records and artifact refs must be unique.');
  }
  const maxInlineBytes = Math.floor(policy.allocatedInputTokens * bytesPerToken);
  const totalBytes = normalized.reduce((sum, record) => sum + record.bytes, 0);
  const indexed = totalBytes > maxInlineBytes;
  if (indexed && policy.compaction.projectionEligible !== true) {
    return refused(
      'CONTEXT_PROJECTION_NOT_AUTHORIZED',
      'Oversized context may not be indexed until measured saturation authorizes a lossless projection.',
      { totalBytes, maxInlineBytes }
    );
  }
  const ranked = [...normalized].sort((left, right) => (
    lifecycleRank(right.lifecycle) - lifecycleRank(left.lifecycle)
    || right.priority - left.priority
    || left.recordId.localeCompare(right.recordId)
  ));
  const inlineIds = new Set();
  let inlineBytes = 0;
  for (const record of ranked) {
    if (!indexed || inlineBytes + record.bytes <= maxInlineBytes) {
      inlineIds.add(record.recordId);
      inlineBytes += record.bytes;
    }
  }
  const entries = normalized
    .map((record) => ({
      recordId: record.recordId,
      artifactRef: record.artifactRef,
      artifactSha256: record.artifactSha256,
      semanticSha256: record.semanticSha256,
      bytes: record.bytes,
      priority: record.priority,
      lifecycle: record.lifecycle,
      projection: inlineIds.has(record.recordId) ? 'INLINE' : 'REFERENCE'
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  const inlineRecords = ranked
    .filter((record) => inlineIds.has(record.recordId))
    .map((record) => ({
      recordId: record.recordId,
      artifactRef: record.artifactRef,
      artifactSha256: record.artifactSha256,
      content: record.content
    }));
  const payload = {
    schemaVersion: LOSSLESS_CONTEXT_INDEX_SCHEMA,
    policyId: policy.policyId,
    policySha256: policy.policySha256,
    mode: indexed ? 'LOSSLESS_INDEX' : 'FULL_RECORDS',
    contentDeletionAuthorized: false,
    maxInlineBytes,
    totalBytes,
    inlineBytes,
    recordCount: entries.length,
    inlineCount: inlineRecords.length,
    referenceCount: entries.length - inlineRecords.length,
    entries,
    inlineRecords,
    fullRecordSetSha256: sha256(canonicalAdaptiveJson(entries.map((entry) => ({
      recordId: entry.recordId,
      artifactRef: entry.artifactRef,
      artifactSha256: entry.artifactSha256,
      semanticSha256: entry.semanticSha256,
      bytes: entry.bytes
    }))))
  };
  return ok({
    record: {
      ...payload,
      indexSha256: sha256(canonicalAdaptiveJson(payload))
    }
  });
}

export function validateLosslessContextProjection(record) {
  if (!record
      || record.schemaVersion !== LOSSLESS_CONTEXT_INDEX_SCHEMA
      || !/^context-policy-[a-f0-9]{24}$/.test(String(record.policyId || ''))
      || !validSha(record.policySha256)
      || !['FULL_RECORDS', 'LOSSLESS_INDEX'].includes(record.mode)
      || record.contentDeletionAuthorized !== false
      || !Number.isInteger(record.maxInlineBytes)
      || record.maxInlineBytes < 1
      || !Number.isInteger(record.totalBytes)
      || record.totalBytes < 0
      || !Number.isInteger(record.inlineBytes)
      || record.inlineBytes < 0
      || !Number.isInteger(record.recordCount)
      || !Number.isInteger(record.inlineCount)
      || !Number.isInteger(record.referenceCount)
      || !Array.isArray(record.entries)
      || !Array.isArray(record.inlineRecords)
      || record.entries.length !== record.recordCount
      || record.inlineRecords.length !== record.inlineCount
      || record.inlineCount + record.referenceCount !== record.recordCount
      || !validSha(record.fullRecordSetSha256)
      || !validSha(record.indexSha256)) {
    return refused('LOSSLESS_CONTEXT_INDEX_INVALID', 'Lossless context index shape is invalid.');
  }
  const payload = indexPayload(record);
  if (sha256(canonicalAdaptiveJson(payload)) !== record.indexSha256) {
    return refused('LOSSLESS_CONTEXT_INDEX_HASH_MISMATCH', 'Lossless context index hash is invalid.');
  }
  const inlineById = new Map(record.inlineRecords.map((item) => [item.recordId, item]));
  for (const entry of record.entries) {
    if (!isSafeId(entry.recordId)
        || !isSafeId(entry.artifactRef)
        || !validSha(entry.artifactSha256)
        || !validSha(entry.semanticSha256)
        || !Number.isInteger(entry.bytes)
        || entry.bytes < 0
        || !Number.isFinite(entry.priority)
        || !['active', 'verified', 'observed', 'failed'].includes(entry.lifecycle)
        || !['INLINE', 'REFERENCE'].includes(entry.projection)) {
      return refused('LOSSLESS_CONTEXT_ENTRY_INVALID', 'Lossless context entry is invalid.');
    }
    const inline = inlineById.get(entry.recordId);
    if (entry.projection === 'INLINE') {
      if (!inline
          || inline.artifactRef !== entry.artifactRef
          || inline.artifactSha256 !== entry.artifactSha256
          || typeof inline.content !== 'string'
          || sha256(inline.content) !== entry.artifactSha256
          || Buffer.byteLength(inline.content) !== entry.bytes) {
        return refused('LOSSLESS_CONTEXT_INLINE_INVALID', 'Inline context bytes do not match the index.');
      }
    } else if (inline) {
      return refused('LOSSLESS_CONTEXT_REFERENCE_LEAK', 'Referenced context unexpectedly contains inline bytes.');
    }
  }
  return ok({ record: structuredClone(record) });
}

export function hydrateLosslessContextProjection({
  projection,
  recordIds,
  readArtifact
} = {}) {
  const checked = validateLosslessContextProjection(projection);
  if (checked.status !== 'OK') return checked;
  if (!Array.isArray(recordIds)
      || new Set(recordIds).size !== recordIds.length
      || recordIds.some((recordId) => !isSafeId(recordId))
      || typeof readArtifact !== 'function') {
    return refused('CONTEXT_HYDRATION_REQUEST_INVALID', 'Hydration IDs and resolver are invalid.');
  }
  const entries = new Map(projection.entries.map((entry) => [entry.recordId, entry]));
  const inline = new Map(projection.inlineRecords.map((record) => [record.recordId, record]));
  const hydrated = [];
  for (const recordId of recordIds) {
    const entry = entries.get(recordId);
    if (!entry) return refused('CONTEXT_RECORD_NOT_INDEXED', `${recordId} is not indexed.`);
    const content = inline.get(recordId)?.content
      ?? readArtifact(entry.artifactRef)?.content;
    if (typeof content !== 'string'
        || sha256(content) !== entry.artifactSha256
        || Buffer.byteLength(content) !== entry.bytes) {
      return refused(
        'CONTEXT_HYDRATION_HASH_MISMATCH',
        `Hydrated bytes for ${recordId} do not match the immutable index.`
      );
    }
    hydrated.push({
      recordId,
      artifactRef: entry.artifactRef,
      artifactSha256: entry.artifactSha256,
      content
    });
  }
  return ok({
    records: hydrated,
    hydrationSha256: sha256(canonicalAdaptiveJson(hydrated.map((record) => ({
      recordId: record.recordId,
      artifactRef: record.artifactRef,
      artifactSha256: record.artifactSha256
    }))))
  });
}
