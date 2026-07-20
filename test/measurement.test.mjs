// Leak #3: tool-computed measurement authority. The MCP DERIVES metrics from the
// recorded bytes (tokenCost always; quality via a frozen deterministic oracle).
// A number the model types is 'caller-reported' and is refused by the
// benchmark/test gates; a quality win the MCP cannot tool-verify is refused by the
// promotion gate (subjective → dashboard). The honest boundary is explicit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, recordMeasurement, recordCallerReported, BASELINE_BODY, promoteWithApproval } from './helpers.mjs';
import {
  DEFAULT_QUALITY_ORACLE, estimateTokens, buildMeasuredContent, scoreOracle,
  buildCaseResultsContent, parseCaseResults, evaluateCaseResultsGameability
} from '../src/measure.mjs';

const H = (model) => ({ title: 'h', bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });
const CASE_ORACLE = {
  kind: 'case-results-v1',
  passMark: 1,
  cases: [
    { caseId: 'phase', disposition: 'BLOCKED', code: 'PHASE_SKIP', requiredEvidencePaths: ['phase.jsonl', 'state.json'] },
    { caseId: 'metric', disposition: 'BLOCKED', code: 'MODEL_REPORTED_METRIC', requiredEvidencePaths: ['metric.jsonl', 'state.json'] }
  ]
};
const CASE_ORACLE_V2 = {
  kind: 'case-results-v2',
  passMark: 1,
  cases: [
    { caseId: 'phase', accepted: false, code: 'PHASE_SKIP', requiredEvidencePaths: ['phase.jsonl', 'state.json'] },
    { caseId: 'metric', accepted: false, code: 'MODEL_REPORTED_METRIC', requiredEvidencePaths: ['metric.jsonl', 'state.json'] }
  ]
};

test('case-results-v1 scores exact per-case semantics and rejects gameable controls', () => {
  const correct = buildCaseResultsContent(CASE_ORACLE);
  assert.equal(scoreOracle(correct, CASE_ORACLE), 1);
  assert.equal(scoreOracle('PHASE_SKIP MODEL_REPORTED_METRIC independent evidence', CASE_ORACLE), 0);
  const reversed = buildCaseResultsContent(CASE_ORACLE, (row) => ({ ...row, disposition: 'ACCEPTED' }));
  assert.equal(scoreOracle(reversed, CASE_ORACLE), 0);
  const wrong = buildCaseResultsContent(CASE_ORACLE, (row, index, all) => ({ ...row, code: all[(index + 1) % all.length].code }));
  assert.equal(scoreOracle(wrong, CASE_ORACLE), 0);
  assert.equal(evaluateCaseResultsGameability(CASE_ORACLE).ok, true);
});

test('case-results-v1 rejects duplicate, unknown, and cross-case evidence', () => {
  const duplicate = `<CASE_RESULTS>${JSON.stringify([
    { caseId: 'phase', disposition: 'BLOCKED', code: 'PHASE_SKIP', evidencePaths: ['phase.jsonl', 'state.json'] },
    { caseId: 'phase', disposition: 'BLOCKED', code: 'PHASE_SKIP', evidencePaths: ['phase.jsonl', 'state.json'] }
  ])}</CASE_RESULTS>`;
  assert.equal(scoreOracle(duplicate, CASE_ORACLE), 0);
  const crossEvidence = buildCaseResultsContent(CASE_ORACLE, (row, index, all) => ({
    ...row,
    evidence: all[(index + 1) % all.length].requiredEvidencePaths.map((path) => ({ path, locator: null }))
  }));
  assert.equal(scoreOracle(crossEvidence, CASE_ORACLE), 0);
  assert.equal(parseCaseResults('<CASE_RESULTS>[]</CASE_RESULTS>').ok, true);
});

test('case-results-v1 supports explicit disposition aliases and structured evidence locators', () => {
  const oracle = {
    kind: 'case-results-v1',
    passMark: 1,
    cases: [{
      caseId: 'phase',
      disposition: 'BLOCKED',
      acceptedDispositions: ['BLOCKED', 'REJECTED'],
      code: 'PHASE_SKIP',
      requiredEvidence: [{ path: 'proof/phase.jsonl', locator: 'lines 12-14' }]
    }]
  };
  const output = `<EVALUATION>${JSON.stringify({
    arm: 'baseline',
    findingId: 'finding-001',
    hypothesisId: '',
    baselineSha256: 'a'.repeat(64),
    procedureSha256: 'a'.repeat(64),
    caseResults: [{
      caseId: 'phase',
      disposition: 'REJECTED',
      code: 'PHASE_SKIP',
      evidence: [{ path: 'proof/phase.jsonl', locator: 'lines 12-14' }]
    }]
  })}</EVALUATION>`;
  assert.equal(scoreOracle(output, oracle), 1);
  const wrongLocator = output.replace('lines 12-14', 'lines 15-16');
  assert.equal(scoreOracle(wrongLocator, oracle), 0);
});

test('case-results-v2 scores supervisor decisions rather than disposition vocabulary', () => {
  const canonical = buildCaseResultsContent(CASE_ORACLE_V2);
  const synonyms = buildCaseResultsContent(CASE_ORACLE_V2, (row) => ({
    ...row,
    disposition: 'REJECTED'
  }));
  const explanatorySynonyms = buildCaseResultsContent(CASE_ORACLE_V2, (row, index) => ({
    ...row,
    disposition: index === 0 ? 'STAGED' : 'REJECTED: evidence gate failed'
  }));
  const wrongDecision = buildCaseResultsContent(CASE_ORACLE_V2, (row) => ({
    ...row,
    disposition: 'ACCEPTED'
  }));
  const unknownDecision = buildCaseResultsContent(CASE_ORACLE_V2, (row) => ({
    ...row,
    disposition: 'UNRESOLVED'
  }));
  assert.equal(scoreOracle(canonical, CASE_ORACLE_V2), 1);
  assert.equal(scoreOracle(synonyms, CASE_ORACLE_V2), 1);
  assert.equal(scoreOracle(explanatorySynonyms, CASE_ORACLE_V2), 1);
  assert.equal(scoreOracle(wrongDecision, CASE_ORACLE_V2), 0);
  assert.equal(scoreOracle(unknownDecision, CASE_ORACLE_V2), 0);
  const gameability = evaluateCaseResultsGameability(CASE_ORACLE_V2);
  assert.equal(gameability.ok, true);
  assert.equal(gameability.scores.semanticEquivalent, 1);
  assert.equal(gameability.scores.unknownDecision, 0);
});

/** init → baseline → freeze a benchmark (oracle optional) → measured bar. */
function initBench(engine, runId, { oracle, baseQuality = 0.7, baseCost = 1000 } = {}) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
  engine.artifact_record({ runId, role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId, benchmarks: [{
    name: 'bm', taskValueDimensions: ['q'], resourceDimensions: ['cost'], cases: [{ id: 'c1' }], oracle
  }] });
  engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  const ref = recordMeasurement(engine, runId, 'bar', baseCost, baseQuality);
  engine.benchmark_run({ runId, arm: 'baseline', measurementRef: ref });
}

test('tokenCost is derived from the recorded bytes, not the caller number', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'M1', task: SPECIFIC_TASK });
  // claim a tiny cost while committing a large run log → the MCP ignores the claim
  const content = 'x'.repeat(4000);
  const r = engine.artifact_record({ runId: 'M1', role: 'runlog', content, measurement: { tokenCost: 1, quality: 0.99 } });
  assert.equal(r.measurement.tokenCostAuthority, 'tool-computed');
  assert.equal(r.measurement.tokenCost, estimateTokens(content)); // ~1000, not 1
  const art = store.readArtifact('M1', r.artifactId);
  assert.equal(art.measurement.claimed.tokenCost, 1, 'the bogus claim is retained only as `claimed`');
});

test('quality is tool-computed against a deterministic oracle, caller-reported without one', () => {
  const { engine } = freshEngine();
  // with oracle frozen
  initBench(engine, 'M2a', { oracle: DEFAULT_QUALITY_ORACLE });
  const withOracle = engine.artifact_record({ runId: 'M2a', role: 'runlog', content: buildMeasuredContent(1000, 0.8), measurement: { tokenCost: 1000, quality: 0.8 } });
  assert.equal(withOracle.measurement.qualityAuthority, 'tool-computed');
  assert.equal(withOracle.measurement.quality, 0.8);
  // without oracle
  initBench(engine, 'M2b', { oracle: 'human judgement' });
  const noOracle = engine.artifact_record({ runId: 'M2b', role: 'runlog', content: buildMeasuredContent(1000, 0.8), measurement: { tokenCost: 1000, quality: 0.8 } });
  assert.equal(noOracle.measurement.qualityAuthority, 'caller-reported');
});

test('benchmark_run refuses a caller-reported measurement (MEASUREMENT_AUTHORITY)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'M3', task: SPECIFIC_TASK });
  engine.artifact_record({ runId: 'M3', role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId: 'M3', benchmarks: [{ name: 'bm', taskValueDimensions: ['q'], resourceDimensions: ['cost'], cases: [{ id: 'c1' }], oracle: DEFAULT_QUALITY_ORACLE }] });
  engine.benchmark_select({ runId: 'M3', benchmarkId: prop.benchmarkIds[0] });
  const ref = recordCallerReported(engine, 'M3', 'typed', 1, 0.99);
  const r = engine.benchmark_run({ runId: 'M3', arm: 'baseline', measurementRef: ref });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'MEASUREMENT_AUTHORITY');
});

test('test_hypothesis refuses a caller-reported agent run', () => {
  const { engine } = freshEngine();
  initBench(engine, 'M4', { oracle: DEFAULT_QUALITY_ORACLE });
  const reg = engine.register_hypotheses({ runId: 'M4', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5'), H('glm-5.2')] });
  const agentRuns = [0, 1, 2].map((i) => ({ model: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'][i], measurementRef: recordCallerReported(engine, 'M4', `cr${i}`, 1000, 0.99) }));
  const r = engine.test_hypothesis({ runId: 'M4', hypothesisId: reg.hypothesisIds[0], fullTest: { agentRuns } });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'MEASUREMENT_AUTHORITY');
});

test('a subjective (caller-reported quality) win cannot auto-promote — it routes to the dashboard', () => {
  const { engine } = freshEngine();
  // benchmark WITHOUT a deterministic oracle → quality stays caller-reported
  initBench(engine, 'M5', { oracle: 'human taste', baseQuality: 0.7, baseCost: 1000 });
  const reg = engine.register_hypotheses({ runId: 'M5', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5'), H('glm-5.2')] });
  const hyp = reg.hypothesisIds[0];
  const agentRuns = [['claude-opus-4-8', 1000, 0.85], ['gpt-5.5', 1000, 0.86], ['glm-5.2', 1000, 0.84]]
    .map(([m, c, q], i) => ({ model: m, measurementRef: recordMeasurement(engine, 'M5', `r${i}`, c, q) }));
  const ft = engine.test_hypothesis({ runId: 'M5', hypothesisId: hyp, fullTest: { agentRuns } });
  assert.equal(ft.qualityAuthority, 'caller-reported');
  assert.equal(ft.verdict, 'MOVED_FRONTIER'); // the numbers move, but they are not tool-verifiable
  engine.reverify_run({ runId: 'M5', testId: ft.testId });
  const promo = engine.promotion_request({ runId: 'M5', hypothesisId: hyp });
  assert.equal(promo.status, 'BLOCKED');
  assert.equal(promo.code, 'QUALITY_UNVERIFIED');
  assert.equal(promo.reviewAuthority, 'dashboard-only');
  assert.equal(promo.continuation.required, true, 'still a checkpoint, not a stop');
});

test('a deterministic (oracle-scored) win promotes after operator approval', () => {
  const { engine } = freshEngine();
  initBench(engine, 'M6', { oracle: DEFAULT_QUALITY_ORACLE, baseQuality: 0.7, baseCost: 1000 });
  const reg = engine.register_hypotheses({ runId: 'M6', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5'), H('glm-5.2')] });
  const hyp = reg.hypothesisIds[0];
  const agentRuns = [['claude-opus-4-8', 1010, 0.80], ['gpt-5.5', 1000, 0.82], ['glm-5.2', 1005, 0.81]]
    .map(([m, c, q], i) => ({ model: m, measurementRef: recordMeasurement(engine, 'M6', `r${i}`, c, q) }));
  const ft = engine.test_hypothesis({ runId: 'M6', hypothesisId: hyp, fullTest: { agentRuns } });
  assert.equal(ft.qualityAuthority, 'tool-computed');
  engine.reverify_run({ runId: 'M6', testId: ft.testId });
  const promo = promoteWithApproval(engine, 'M6', hyp);
  assert.equal(promo.status, 'OK');
  assert.equal(promo.decision.promote, true);
});
