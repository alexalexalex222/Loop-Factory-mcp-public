import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/util.mjs';
import { canonicalJson } from '../src/meta-policy.mjs';
import {
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority
} from '../src/vnext-evidence-bank.mjs';
import {
  runChronologicalRetrievalBenchmark,
  validateChronologicalRetrievalBenchmark
} from '../src/retrieval-benchmark.mjs';

const NOW = '2026-08-05T03:00:00.000Z';
const FIXTURE_AUTHORITY = createVNextFixtureEvidenceAuthority('retrieval-benchmark-tests').authority;

function mechanism(key, verdict = 'improvement') {
  const hex = sha256(key).slice(0, 24);
  const payload = {
    schemaVersion: 'improvement-mechanism-v1', mechanismId: `mech-${hex}`, generatedAt: NOW,
    partition: 'harvest', eligibleForRouting: true,
    source: { runId: `run-${hex.slice(0, 8)}`, findingId: null, hypothesisId: `hyp-${hex.slice(0, 8)}`, testId: `test-${hex.slice(0, 8)}`, benchmarkId: 'bench-1', benchmarkSha256: sha256('bench'), policyId: null, policySha256: null },
    target: { taskSha256: sha256('task'), taskMode: 'improve', loopId: 'loop-de-loop', taskValueDimensions: ['quality'], resourceDimensions: ['token-cost'], signatureTokens: key.split('-') },
    mechanism: { title: key, bottleneck: key, operation: key, expectedMovement: 'quality', falsifier: 'no gain' },
    measurement: { baseline: { quality: 0.5, tokenCost: 100, artifactOutputTokenEstimate: 100, cliReceiptTokenCost: 100, samples: 3 }, challenger: { quality: verdict === 'improvement' ? 0.7 : 0.4, tokenCost: 100, artifactOutputTokenEstimate: 100, cliReceiptTokenCost: 100, samples: 3 }, delta: { quality: verdict === 'improvement' ? 0.2 : -0.1, tokenCost: 0, tokenCostPct: 0 }, qualityAuthority: 'tool-computed', reverified: true, shamMovement: 0, controlRegressions: 0, transferChecks: [] },
    outcome: { verdict, code: verdict === 'improvement' ? 'MOVED_FRONTIER' : 'NO_IMPROVEMENT', valid: true, observedAt: NOW, reverifiedAt: NOW },
    provenance: { evidenceRefs: [], artifacts: [] }, lifecycle: { state: verdict === 'improvement' ? 'replicated' : 'contradicted', reason: 'test' }
  };
  const digest = sha256(canonicalJson(payload));
  return { ...payload, receiptId: `receipt-${digest.slice(0, 24)}`, receiptSha256: digest };
}

function record(id, kind, statement, tags, availableAt = NOW) {
  return createVNextEvidenceRecord({
    recordId: id, kind, availableAt, createdAt: availableAt,
    sourceIds: ['source-1'], verifierEvidenceHashes: ['a'.repeat(64)],
    authority: FIXTURE_AUTHORITY,
    compatibility: { domains: [], tags, component: 'retrieval', schemaVersions: [], models: [], harnessSha256s: [], toolEnvironmentSha256s: [], permissions: [], securityRequirements: [], versionConstraints: [] },
    lifecycle: { state: kind === 'contradiction' ? 'contradicted' : 'replicated', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: kind === 'positive' ? 0.2 : -0.1, costUsd: 0, latencyMs: 1, tokenCost: 1, uncertainty: 0.1 },
    content: { statement }, callerClaims: {}
  }, { allowFixtureRecords: true }).record;
}

function rank(recordId, expectedBenefit) {
  return { recordId, applicability: 0.9, structuralSimilarity: 0.9, expectedBenefit, transferUncertainty: 0.1, contradictionRisk: 0.1, reason: 'frozen ranking', confidence: 0.9 };
}

test('chronological replay compares all six strategies without future leakage', async () => {
  const positive = mechanism('negative-recall-improvement');
  const failed = mechanism('negative-recall-failure', 'no_improvement');
  const records = [
    record(positive.mechanismId, 'positive', 'negative recall improvement', ['negative', 'retrieval']),
    record(failed.mechanismId, 'contradiction', 'negative recall failure', ['negative', 'retrieval']),
    record('future-record', 'positive', 'future evidence', ['negative'], '2026-08-06T00:00:00.000Z')
  ];
  const reranker = {
    schemaVersion: 'vnext-reranker-output-v1', abstain: false, abstainReason: null,
    rankings: [rank(positive.mechanismId, 0.9), rank(failed.mechanismId, 0.1)]
  };
  const result = await runChronologicalRetrievalBenchmark({
    k: 2,
    allowFixtureRecords: true,
    cases: [{
      caseId: 'case-1', queryAt: NOW, query: { summary: 'negative retrieval recall' }, records,
      queryEmbedding: [1, 0], embeddings: { [positive.mechanismId]: [1, 0], [failed.mechanismId]: [0.5, 0.5] },
      hybridRerankerOutput: reranker, unfilteredRerankerOutput: reranker,
      deterministicRouter: {
        receipts: [positive, failed],
        availableAtByMechanism: { [positive.mechanismId]: NOW, [failed.mechanismId]: NOW },
        target: { signatureTokens: ['negative', 'recall', 'retrieval'], taskValueDimensions: ['quality'], resourceDimensions: ['token-cost'], taskMode: 'improve', loopId: 'loop-de-loop' }, seed: 'case-1'
      },
      labels: {
        beneficialIds: [positive.mechanismId], harmfulIds: [failed.mechanismId],
        negativePrecedentIds: [failed.mechanismId],
        utilityById: { [positive.mechanismId]: 1, [failed.mechanismId]: -0.25 }
      },
      costs: {}
    }]
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.report.caseResults[0].futureRecordCount, 1);
  assert.equal(result.report.summary['hybrid-diversity-negative'].negativeRecallAtK, 1);
  assert.equal(validateChronologicalRetrievalBenchmark(result.report).status, 'OK');
});
