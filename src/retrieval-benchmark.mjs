import { buildShadowMechanismPacket } from './mechanism-router.mjs';
import {
  buildHybridRetrieval,
  buildHybridRetrievalCandidatePool
} from './hybrid-retrieval.mjs';
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';
import { validateVNextModelOutput, VNEXT_MODEL_SCHEMA } from './vnext-model-contracts.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const VNEXT_RETRIEVAL_BENCHMARK_SCHEMA = 'vnext-retrieval-benchmark-v1';

const STRATEGIES = Object.freeze([
  'current-deterministic-router',
  'lexical-only',
  'semantic-only',
  'llm-only-unfiltered',
  'hybrid-ranked',
  'hybrid-diversity-negative'
]);

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function idSet(values) {
  if (!Array.isArray(values) || values.some((value) => !isSafeId(value))) return null;
  return new Set(values);
}

function labels(value) {
  if (!plainObject(value)) return null;
  const beneficial = idSet(value.beneficialIds);
  const harmful = idSet(value.harmfulIds);
  const negative = idSet(value.negativePrecedentIds);
  if (!beneficial || !harmful || !negative || beneficial.size === 0
      || !plainObject(value.utilityById)
      || Object.entries(value.utilityById).some(([id, utility]) => (
        !isSafeId(id) || !Number.isFinite(utility)
      ))) return null;
  return { beneficial, harmful, negative, utilityById: value.utilityById };
}

function rankMetrics(ids, truth, k) {
  const selected = ids.slice(0, k);
  const beneficialHits = selected.filter((id) => truth.beneficial.has(id));
  const negativeHits = selected.filter((id) => truth.negative.has(id));
  const harmfulHits = selected.filter((id) => truth.harmful.has(id));
  const firstBeneficial = selected.findIndex((id) => truth.beneficial.has(id));
  const gains = selected.map((id) => Math.max(0, Number(truth.utilityById[id] ?? 0)));
  const ideal = Object.values(truth.utilityById).map((value) => Math.max(0, Number(value)))
    .sort((a, b) => b - a).slice(0, k);
  const dcg = gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
  const idealDcg = ideal.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
  return {
    selectedIds: selected,
    beneficialRecallAtK: beneficialHits.length / truth.beneficial.size,
    negativeRecallAtK: truth.negative.size ? negativeHits.length / truth.negative.size : 1,
    harmfulRetrievalRate: selected.length ? harmfulHits.length / selected.length : 0,
    reciprocalRank: firstBeneficial < 0 ? 0 : 1 / (firstBeneficial + 1),
    ndcgAtK: idealDcg === 0 ? 0 : dcg / idealDcg,
    downstreamUtility: selected.reduce((sum, id) => sum + Number(truth.utilityById[id] ?? 0), 0),
    downstreamSuccess: beneficialHits.length > 0,
    selectedCount: selected.length
  };
}

function chronologicalRows(records, queryAt, { allowFixtureRecords = false } = {}) {
  return records.filter((record) => (
    validateVNextEvidenceRecord(record, { allowFixtureRecords }).status === 'OK'
    && Date.parse(record.availableAt) <= Date.parse(queryAt)
  ));
}

function llmOnlyOrder(records, output) {
  const valid = validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.RERANKER);
  if (valid.status !== 'OK' || valid.output.abstain) return [];
  const available = new Set(records.map(({ recordId }) => recordId));
  return valid.output.rankings
    .map(({ recordId }) => recordId)
    .filter((id) => available.has(id));
}

function aggregate(rows) {
  const keys = [
    'beneficialRecallAtK', 'negativeRecallAtK', 'harmfulRetrievalRate',
    'reciprocalRank', 'ndcgAtK', 'downstreamUtility'
  ];
  const result = Object.fromEntries(keys.map((key) => [
    key,
    rows.reduce((sum, row) => sum + row[key], 0) / rows.length
  ]));
  result.downstreamSuccessRate = rows.filter(({ downstreamSuccess }) => downstreamSuccess).length / rows.length;
  result.caseCount = rows.length;
  return result;
}

function costRow(value = {}) {
  return {
    tokens: Number.isFinite(value.tokens) && value.tokens >= 0 ? value.tokens : 0,
    latencyMs: Number.isFinite(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : 0,
    costUsd: Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : 0
  };
}

export async function runChronologicalRetrievalBenchmark({
  cases,
  k = 4,
  allowFixtureRecords = false
} = {}) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 10_000
      || !Number.isInteger(k) || k < 1 || k > 64) {
    return refused('RETRIEVAL_BENCHMARK_INPUT_INVALID', 'Retrieval benchmark requires bounded chronological cases and K.');
  }
  const caseResults = [];
  for (const item of cases) {
    const truth = labels(item?.labels);
    if (!plainObject(item) || !isSafeId(item.caseId) || !truth
        || typeof item.queryAt !== 'string' || !Number.isFinite(Date.parse(item.queryAt))
        || !Array.isArray(item.records) || !plainObject(item.deterministicRouter)
        || !Array.isArray(item.deterministicRouter.receipts)
        || !plainObject(item.deterministicRouter.availableAtByMechanism)
        || item.deterministicRouter.receipts.some((receipt) => (
          !Number.isFinite(Date.parse(item.deterministicRouter.availableAtByMechanism[receipt.mechanismId]))
          || Date.parse(item.deterministicRouter.availableAtByMechanism[receipt.mechanismId]) > Date.parse(item.queryAt)
        ))) {
      return refused('RETRIEVAL_BENCHMARK_CASE_INVALID', 'Each case requires labels, a decision time, evidence records, and time-bound current-router receipts.');
    }
    const currentPacket = buildShadowMechanismPacket({
      receipts: item.deterministicRouter.receipts,
      target: item.deterministicRouter.target,
      seed: item.deterministicRouter.seed ?? item.caseId
    });
    const currentIds = currentPacket.selected.map(({ mechanismId }) => mechanismId);
    const lexicalPool = buildHybridRetrievalCandidatePool({
      records: item.records, query: item.query, queryAt: item.queryAt,
      compatibility: item.compatibility ?? {}, maximumCandidates: 512,
      allowFixtureRecords
    });
    const semanticPool = buildHybridRetrievalCandidatePool({
      records: item.records, query: item.query, queryAt: item.queryAt,
      compatibility: item.compatibility ?? {}, queryEmbedding: item.queryEmbedding,
      embeddings: item.embeddings ?? {}, maximumCandidates: 512,
      allowFixtureRecords
    });
    if (lexicalPool.status !== 'OK' || semanticPool.status !== 'OK') return lexicalPool.status !== 'OK' ? lexicalPool : semanticPool;
    const lexicalIds = [...lexicalPool.rows]
      .sort((left, right) => right.lexicalScore - left.lexicalScore || left.record.recordId.localeCompare(right.record.recordId))
      .map(({ record }) => record.recordId);
    const semanticIds = [...semanticPool.rows]
      .sort((left, right) => right.semanticScore - left.semanticScore || left.record.recordId.localeCompare(right.record.recordId))
      .map(({ record }) => record.recordId);
    const chronological = chronologicalRows(item.records, item.queryAt, {
      allowFixtureRecords
    });
    const llmIds = llmOnlyOrder(chronological, item.unfilteredRerankerOutput);
    const hybrid = await buildHybridRetrieval({
      records: item.records, query: item.query, queryAt: item.queryAt,
      compatibility: item.compatibility ?? {}, queryEmbedding: item.queryEmbedding,
      embeddings: item.embeddings ?? {}, rerankerOutput: item.hybridRerankerOutput,
      maximumCandidates: 512, maximumSelected: k,
      exploreUncertainty: item.exploreUncertainty === true,
      allowFixtureRecords
    });
    if (!hybrid.artifact) return hybrid;
    const hybridRanked = hybrid.artifact.payload.ranking.candidateIds;
    const hybridSelected = hybrid.artifact.payload.selection.map(({ recordId }) => recordId);
    const rankings = {
      'current-deterministic-router': currentIds,
      'lexical-only': lexicalIds,
      'semantic-only': semanticIds,
      'llm-only-unfiltered': llmIds,
      'hybrid-ranked': hybridRanked,
      'hybrid-diversity-negative': hybridSelected
    };
    const strategyResults = Object.fromEntries(STRATEGIES.map((strategy) => [
      strategy,
      {
        ...rankMetrics(rankings[strategy], truth, k),
        cost: costRow(item.costs?.[strategy])
      }
    ]));
    caseResults.push({
      caseId: item.caseId,
      queryAt: item.queryAt,
      caseSha256: sha256(canonicalVNextJson(item)),
      futureRecordCount: item.records.filter((record) => Date.parse(record.availableAt) > Date.parse(item.queryAt)).length,
      strategies: strategyResults
    });
  }
  const summary = Object.fromEntries(STRATEGIES.map((strategy) => {
    const rows = caseResults.map(({ strategies }) => strategies[strategy]);
    const costs = rows.map(({ cost }) => cost);
    return [strategy, {
      ...aggregate(rows),
      tokens: costs.reduce((sum, row) => sum + row.tokens, 0),
      latencyMs: costs.reduce((sum, row) => sum + row.latencyMs, 0),
      costUsd: costs.reduce((sum, row) => sum + row.costUsd, 0)
    }];
  }));
  const core = {
    schemaVersion: VNEXT_RETRIEVAL_BENCHMARK_SCHEMA,
    chronological: true,
    leakageResistant: true,
    fixtureOnly: allowFixtureRecords,
    k,
    strategyIds: [...STRATEGIES],
    caseCount: caseResults.length,
    caseResults,
    summary,
    activationAuthority: false,
    noModelCallsDuringReplay: true
  };
  return {
    status: 'OK',
    report: { ...core, reportSha256: sha256(canonicalVNextJson(core)) }
  };
}

export function validateChronologicalRetrievalBenchmark(report) {
  if (!plainObject(report) || report.schemaVersion !== VNEXT_RETRIEVAL_BENCHMARK_SCHEMA
      || report.chronological !== true || report.leakageResistant !== true
      || typeof report.fixtureOnly !== 'boolean'
      || report.activationAuthority !== false || report.noModelCallsDuringReplay !== true
      || !Array.isArray(report.caseResults)
      || report.caseResults.some((row) => row.futureRecordCount < 0)) {
    return refused('RETRIEVAL_BENCHMARK_REPORT_INVALID', 'Retrieval benchmark report shape is invalid.');
  }
  const core = structuredClone(report);
  delete core.reportSha256;
  return report.reportSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', report }
    : refused('RETRIEVAL_BENCHMARK_REPORT_TAMPERED', 'Retrieval benchmark report hash drifted.');
}
