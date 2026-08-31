import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createContextSaturationObservation,
  createInitialAdaptiveContextPolicy,
  deriveAdaptiveContextPolicy
} from '../src/adaptive-context-policy.mjs';
import {
  buildLosslessContextProjection,
  hydrateLosslessContextProjection,
  validateLosslessContextProjection
} from '../src/adaptive-context-compaction.mjs';
import { sha256 } from '../src/util.mjs';

function policy({ indexed = false } = {}) {
  const initial = createInitialAdaptiveContextPolicy({
    scopeId: 'projection-test',
    minInputTokens: 50,
    initialInputTokens: 100,
    maxInputTokens: 200,
    permanentControlFraction: 0.2,
    recordedAt: '2026-08-05T01:00:00.000Z'
  });
  assert.equal(initial.status, 'OK');
  if (!indexed) return initial.record;
  const observations = Array.from({ length: 5 }, (_, index) => {
    const built = createContextSaturationObservation({
      scopeId: 'projection-test',
      runId: 'projection-run',
      generation: index,
      callId: `projection-call-${index}`,
      allocatedInputTokens: 100,
      requestedContextTokens: 95,
      inputTokens: 95,
      outputTokens: 20,
      promptArtifactRef: `projection-prompt-${index}`,
      promptArtifactSha256: sha256(`projection-prompt-${index}`),
      receiptArtifactRef: `projection-receipt-${index}`,
      receiptArtifactSha256: sha256(`projection-receipt-${index}`),
      valid: true,
      measuredLift: 0,
      recordedAt: `2026-08-05T01:0${index}:00.000Z`
    });
    assert.equal(built.status, 'OK');
    return built.record;
  });
  const derived = deriveAdaptiveContextPolicy({
    previousPolicy: initial.record,
    observations,
    recordedAt: '2026-08-05T01:10:00.000Z'
  });
  assert.equal(derived.status, 'OK');
  return derived.record;
}

function records(length = 3, bytes = 80) {
  return Array.from({ length }, (_, index) => {
    const content = `${index}:${'x'.repeat(bytes)}`;
    return {
      recordId: `mechanism-${index}`,
      artifactRef: `mechanism-artifact-${index}`,
      artifactSha256: sha256(content),
      semanticSha256: sha256(`semantic-${index}`),
      content,
      priority: length - index,
      lifecycle: index === 0 ? 'active' : 'observed'
    };
  });
}

test('lossless context keeps every full record inline when it fits', () => {
  const built = buildLosslessContextProjection({
    policy: policy(),
    records: records(2, 20)
  });
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.record.mode, 'FULL_RECORDS');
  assert.equal(built.record.referenceCount, 0);
  assert.equal(built.record.inlineCount, 2);
  assert.equal(built.record.contentDeletionAuthorized, false);
  assert.equal(validateLosslessContextProjection(built.record).status, 'OK');
});

test('oversized context refuses indexing without measured saturation authority', () => {
  const built = buildLosslessContextProjection({
    policy: policy(),
    records: records(6, 100)
  });
  assert.equal(built.code, 'CONTEXT_PROJECTION_NOT_AUTHORIZED');
});

test('authorized projection is lossless and hash-verifies hydrated references', () => {
  const source = records(6, 100);
  const artifacts = new Map(source.map((record) => [record.artifactRef, {
    content: record.content
  }]));
  const built = buildLosslessContextProjection({
    policy: policy({ indexed: true }),
    records: source
  });
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.record.mode, 'LOSSLESS_INDEX');
  assert.ok(built.record.referenceCount > 0);
  assert.equal(built.record.contentDeletionAuthorized, false);
  const referenced = built.record.entries
    .filter((entry) => entry.projection === 'REFERENCE')
    .map((entry) => entry.recordId);
  const hydrated = hydrateLosslessContextProjection({
    projection: built.record,
    recordIds: referenced,
    readArtifact: (artifactRef) => artifacts.get(artifactRef)
  });
  assert.equal(hydrated.status, 'OK', hydrated.message);
  assert.equal(hydrated.records.length, referenced.length);
  const firstRef = built.record.entries.find((entry) => (
    entry.projection === 'REFERENCE'
  ));
  artifacts.set(firstRef.artifactRef, { content: 'tampered' });
  const tampered = hydrateLosslessContextProjection({
    projection: built.record,
    recordIds: [firstRef.recordId],
    readArtifact: (artifactRef) => artifacts.get(artifactRef)
  });
  assert.equal(tampered.code, 'CONTEXT_HYDRATION_HASH_MISMATCH');
});

test('lossless context index schema is closed at the root', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/lossless-context-index-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'lossless-context-index-v1');
  assert.equal(schema.additionalProperties, false);
});
