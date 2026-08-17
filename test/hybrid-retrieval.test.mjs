import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority
} from '../src/vnext-evidence-bank.mjs';
import {
  buildHybridRetrieval as buildHybridRetrievalBase,
  validateHybridRetrievalReceipt
} from '../src/hybrid-retrieval.mjs';

const NOW = '2026-08-05T00:00:00.000Z';
const FIXTURE_AUTHORITY = createVNextFixtureEvidenceAuthority('hybrid-retrieval-tests').authority;

function buildHybridRetrieval(input) {
  return buildHybridRetrievalBase({ ...input, allowFixtureRecords: true });
}

function record(id, kind, statement, overrides = {}) {
  const built = createVNextEvidenceRecord({
    recordId: id,
    kind,
    availableAt: overrides.availableAt ?? '2026-08-04T00:00:00.000Z',
    createdAt: overrides.createdAt ?? NOW,
    sourceIds: [`source-${id}`],
    verifierEvidenceHashes: ['a'.repeat(64)],
    authority: FIXTURE_AUTHORITY,
    compatibility: {
      domains: ['routing'],
      tags: overrides.tags ?? ['retrieval', 'negative-recall'],
      component: 'retrieval',
      schemaVersions: ['failure-v1'],
      models: overrides.models ?? [],
      harnessSha256s: overrides.harnessSha256s ?? [],
      toolEnvironmentSha256s: overrides.toolEnvironmentSha256s ?? [],
      permissions: overrides.permissions ?? [],
      securityRequirements: overrides.securityRequirements ?? [],
      versionConstraints: overrides.versionConstraints ?? []
    },
    lifecycle: {
      state: overrides.state ?? 'replicated',
      quarantined: overrides.quarantined ?? false,
      quarantineReason: overrides.quarantined ? 'operator hold' : null
    },
    metrics: {
      qualityDelta: kind === 'positive' ? 0.2 : -0.1,
      costUsd: 0,
      latencyMs: 5,
      tokenCost: 10,
      uncertainty: overrides.uncertainty ?? 0.2
    },
    content: { statement },
    callerClaims: {}
  }, { allowFixtureRecords: true });
  assert.equal(built.status, 'OK');
  return built.record;
}

function rerankRow(recordId) {
  return {
    recordId,
    applicability: 0.9,
    structuralSimilarity: 0.9,
    expectedBenefit: 0.8,
    transferUncertainty: 0.1,
    contradictionRisk: 0.1,
    reason: 'same failure structure',
    confidence: 0.8
  };
}

const query = { summary: 'retrieval omitted negative precedent', uncertainty: 0.2 };

test('retrieval filters chronology, quarantine, and tampered hashes before ranking', async () => {
  const good = record('positive-1', 'positive', 'negative precedent retrieval improved');
  const future = record('future-1', 'positive', 'future result', { availableAt: '2026-08-06T00:00:00.000Z', createdAt: '2026-08-06T00:00:00.000Z' });
  const quarantined = record('held-1', 'positive', 'held result', { quarantined: true });
  const tampered = structuredClone(record('tampered-1', 'positive', 'original'));
  tampered.content.statement = 'tampered';
  const result = await buildHybridRetrieval({ records: [future, quarantined, tampered, good], query, queryAt: NOW });
  assert.equal(result.status, 'OK');
  assert.equal(result.artifact.payload.filterCounts.future, 1);
  assert.equal(result.artifact.payload.filterCounts.quarantined, 1);
  assert.equal(result.artifact.payload.filterCounts.tampered, 1);
  assert.deepEqual(result.artifact.payload.ranking.candidateIds, ['positive-1']);
});

test('negative and contradiction evidence are first-class selections', async () => {
  const records = [
    record('positive-1', 'positive', 'negative precedent retrieval improved'),
    record('regression-1', 'regression', 'negative precedent retrieval regressed controls'),
    record('contradiction-1', 'contradiction', 'claimed improvement contradicted by replay')
  ];
  const result = await buildHybridRetrieval({ records, query, queryAt: NOW });
  assert.equal(result.status, 'OK');
  const roles = result.artifact.payload.selection.map((row) => [row.role, row.kind]);
  assert.deepEqual(roles.slice(0, 2), [
    ['strongest-positive', 'positive'],
    ['strongest-negative', 'regression']
  ]);
  assert.equal(validateHybridRetrievalReceipt(result.artifact).status, 'OK');
});

test('duplicate and hallucinated reranker IDs trigger deterministic fallback', async () => {
  const records = [
    record('positive-1', 'positive', 'negative precedent retrieval improved'),
    record('failure-1', 'failure', 'negative precedent was omitted')
  ];
  const duplicate = {
    schemaVersion: 'vnext-reranker-output-v1',
    rankings: [rerankRow('positive-1'), rerankRow('positive-1')],
    abstain: false,
    abstainReason: null
  };
  const duplicateResult = await buildHybridRetrieval({ records, query, queryAt: NOW, rerankerOutput: duplicate });
  assert.equal(duplicateResult.artifact.payload.ranking.source, 'deterministic-fallback');
  assert.equal(duplicateResult.artifact.payload.ranking.fallbackReason, 'RERANKER_OUTPUT_INVALID');

  const hallucinated = {
    schemaVersion: 'vnext-reranker-output-v1',
    rankings: [rerankRow('not-eligible')],
    abstain: false,
    abstainReason: null
  };
  const hallucinatedResult = await buildHybridRetrieval({ records, query, queryAt: NOW, rerankerOutput: hallucinated });
  assert.equal(hallucinatedResult.artifact.payload.ranking.fallbackReason, 'RERANKER_ID_INELIGIBLE');
  assert.deepEqual(
    hallucinatedResult.artifact.payload.ranking.candidateIds,
    duplicateResult.artifact.payload.ranking.candidateIds
  );
});

test('selection reserves a structurally diverse alternative', async () => {
  const records = [
    record('positive-a', 'positive', 'negative precedent retrieval improved', { tags: ['retrieval', 'negative-recall'] }),
    record('negative-a', 'failure', 'negative precedent retrieval failed', { tags: ['retrieval', 'negative-recall'] }),
    record('similar-a', 'transfer', 'negative precedent retrieval transfer', { tags: ['retrieval', 'negative-recall'] }),
    record('diverse-a', 'transfer', 'negative precedent retrieval transfer', { tags: ['dispatch', 'tool-boundary'] })
  ];
  const result = await buildHybridRetrieval({ records, query, queryAt: NOW, maximumSelected: 3 });
  const diverse = result.artifact.payload.selection.find((row) => row.role === 'diverse-alternative');
  assert.equal(diverse.recordId, 'diverse-a');
});

test('optional embeddings are deterministic and empty eligible pools abstain', async () => {
  const records = [
    record('positive-a', 'positive', 'unrelated words'),
    record('positive-b', 'positive', 'unrelated words')
  ];
  const args = {
    records,
    query,
    queryAt: NOW,
    queryEmbedding: [1, 0],
    embeddings: { 'positive-a': [0, 1], 'positive-b': [1, 0] }
  };
  const first = await buildHybridRetrieval(args);
  const second = await buildHybridRetrieval({ ...args, records: [...records].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.artifact.payload.ranking.candidateIds[0], 'positive-b');

  const empty = await buildHybridRetrieval({ records: [record('held', 'positive', 'held', { quarantined: true })], query, queryAt: NOW });
  assert.equal(empty.status, 'ABSTAINED');
  assert.equal(empty.code, 'RETRIEVAL_NO_ELIGIBLE_EVIDENCE');
  assert.equal(validateHybridRetrievalReceipt(empty.artifact).status, 'OK');
  assert.equal(empty.artifact.payload.selection.length, 0);
});

test('hard filtering binds model, harness, tools, permissions, security, and versions', async () => {
  const constrained = record('constrained', 'positive', 'compatible only', {
    models: ['gpt-5.6-sol'],
    harnessSha256s: ['b'.repeat(64)],
    toolEnvironmentSha256s: ['c'.repeat(64)],
    permissions: ['read-repository'],
    securityRequirements: ['sealed-evaluation'],
    versionConstraints: ['node-26']
  });
  const wrong = await buildHybridRetrieval({
    records: [constrained],
    query,
    queryAt: NOW,
    compatibility: {
      model: 'gpt-5.6-luna',
      harnessSha256: 'b'.repeat(64),
      toolEnvironmentSha256: 'c'.repeat(64),
      permissions: ['read-repository'],
      securityRequirements: ['sealed-evaluation'],
      versionConstraints: ['node-26']
    }
  });
  assert.equal(wrong.code, 'RETRIEVAL_NO_ELIGIBLE_EVIDENCE');
  const exact = await buildHybridRetrieval({
    records: [constrained],
    query,
    queryAt: NOW,
    compatibility: {
      model: 'gpt-5.6-sol',
      harnessSha256: 'b'.repeat(64),
      toolEnvironmentSha256: 'c'.repeat(64),
      permissions: ['read-repository'],
      securityRequirements: ['sealed-evaluation'],
      versionConstraints: ['node-26']
    }
  });
  assert.equal(exact.status, 'OK');
  assert.deepEqual(exact.artifact.payload.ranking.candidateIds, ['constrained']);
});
