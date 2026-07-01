// Req 7/8/9: full tests, score matrix, reverify, promotion threshold, failure
// patience. Model-reported metrics never count; one no-improvement run is never
// "perfect"; the campaign never self-completes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, initThroughBaselineBar, recordMeasurement, recordCallerReported, promoteWithApproval } from './helpers.mjs';
import { sha256 } from '../src/util.mjs';

const H = (model, title) => ({ title: title || 'h', bottleneck: 'precision', operation: 'restructure', expectedMovement: '+quality', route: { model } });

function setup(runId) {
  const { engine, store } = freshEngine();
  initThroughBaselineBar(engine, runId, { baseQuality: 0.7, baseCost: 1000 });
  const reg = engine.register_hypotheses({ runId, hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  return { engine, store, hyps: reg.hypothesisIds };
}

function fullTest(engine, runId, hypId, triples) {
  const agentRuns = triples.map(([model, cost, q], i) => ({ model, measurementRef: recordMeasurement(engine, runId, `${hypId}-r${i}`, cost, q) }));
  return engine.test_hypothesis({ runId, hypothesisId: hypId, fullTest: { agentRuns } });
}

test('a full test needs 3–5 agents (not "think hard and count it")', () => {
  const { engine, hyps } = setup('m1');
  const r = fullTest(engine, 'm1', hyps[0], [['claude-opus-4-8', 1000, 0.8], ['gpt-5.5', 1000, 0.8]]);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'FULLTEST_AGENTS');
});

test('model-reported (no measurementRef) full test is rejected', () => {
  const { engine, hyps } = setup('m2');
  const r = engine.test_hypothesis({ runId: 'm2', hypothesisId: hyps[0], fullTest: { agentRuns: [
    { model: 'claude-opus-4-8', metrics: { tokenCost: 900, quality: 0.95, source: 'model' } },
    { model: 'gpt-5.5', metrics: { tokenCost: 900, quality: 0.95, source: 'model' } },
    { model: 'glm-5.2', metrics: { tokenCost: 900, quality: 0.95, source: 'model' } }
  ] } });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'MODEL_REPORTED');
});

test('promotion with no score matrix is blocked ("old 21/21 green" is not enough)', () => {
  const { engine, hyps } = setup('m3');
  const r = engine.promotion_request({ runId: 'm3', hypothesisId: hyps[0] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'NO_SCORE_MATRIX');
});

test('a tool-measured, reverified frontier win is PROMOTED', () => {
  const { engine, hyps } = setup('m4');
  const ft = fullTest(engine, 'm4', hyps[0], [['claude-opus-4-8', 1010, 0.80], ['gpt-5.5', 1000, 0.82], ['glm-5.2', 1020, 0.81]]);
  assert.equal(ft.status, 'OK');
  assert.equal(ft.verdict, 'MOVED_FRONTIER');
  // must reverify before promotion
  const early = engine.promotion_request({ runId: 'm4', hypothesisId: hyps[0] });
  assert.equal(early.code, 'NOT_REVERIFIED');
  const rv = engine.reverify_run({ runId: 'm4', testId: ft.testId });
  assert.equal(rv.status, 'OK');
  assert.equal(rv.reverified, true);
  // Step 2: a measured+reverified win still needs operator Approve on the dashboard.
  const queued = engine.promotion_request({ runId: 'm4', hypothesisId: hyps[0] });
  assert.equal(queued.code, 'PROMOTION_NEEDS_APPROVAL');
  const promo = promoteWithApproval(engine, 'm4', hyps[0]);
  assert.equal(promo.status, 'OK');
  assert.match(promo.message, /PROMOTE/);
  assert.equal(promo.decision.promote, true);
});

test('a below-threshold result (no frontier movement) is blocked', () => {
  const { engine, hyps } = setup('m5');
  const ft = fullTest(engine, 'm5', hyps[0], [['claude-opus-4-8', 1000, 0.70], ['gpt-5.5', 1000, 0.69], ['glm-5.2', 1000, 0.71]]);
  assert.equal(ft.verdict, 'NO_IMPROVEMENT');
  engine.reverify_run({ runId: 'm5', testId: ft.testId });
  const promo = engine.promotion_request({ runId: 'm5', hypothesisId: hyps[0] });
  assert.equal(promo.status, 'BLOCKED');
  assert.equal(promo.code, 'BELOW_THRESHOLD');
});

test('reverify re-derives metrics from bytes, so a content tamper cannot survive', () => {
  const { engine, store, hyps } = setup('m6');
  const ft = fullTest(engine, 'm6', hyps[0], [['claude-opus-4-8', 1010, 0.80], ['gpt-5.5', 1000, 0.82], ['glm-5.2', 1020, 0.81]]);
  // Sophisticated tamper: rewrite the raw bytes AND fix the content hash so the
  // hash check passes — but the MCP re-derives tokenCost + oracle quality from the
  // (now smaller, fewer-probe) bytes, which no longer back the recorded metrics.
  const state = store.load('m6');
  const ref = state.tests[0].agentRuns[0].measurementRef;
  const art = store.readArtifact('m6', ref);
  art.content = art.content.replace(/QP0\d\d/g, '').slice(0, 200); // strip probes + shrink → cost & quality drop
  art.sha256 = sha256(art.content); // forge a matching content hash
  store.writeArtifact('m6', ref, art);
  const rv = engine.reverify_run({ runId: 'm6', testId: ft.testId });
  assert.equal(rv.status, 'BLOCKED');
  assert.equal(rv.code, 'NOT_REVERIFIED');
  assert.ok(rv.problems.some((p) => /do not back the (cost|quality)/.test(p)), 're-derivation must catch the byte tamper');
});

test('a caller-reported (non-tool-computed) measurement is refused by the test gate', () => {
  const { engine, hyps } = setup('m8');
  const agentRuns = [['claude-opus-4-8', 1000, 0.99], ['gpt-5.5', 1000, 0.99], ['glm-5.2', 1000, 0.99]]
    .map(([m, c, q], i) => ({ model: m, measurementRef: recordCallerReported(engine, 'm8', `cr${i}`, c, q) }));
  const r = engine.test_hypothesis({ runId: 'm8', hypothesisId: hyps[0], fullTest: { agentRuns } });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'MEASUREMENT_AUTHORITY');
});

test('failure patience flags economic exhaustion without completing the campaign', () => {
  const { engine, store } = freshEngine();
  initThroughBaselineBar(engine, 'm7', { baseQuality: 0.7, baseCost: 1000 }); // default patience = 12
  const reg = engine.register_hypotheses({ runId: 'm7', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const hyp = reg.hypothesisIds[0];
  let last;
  for (let i = 0; i < 13; i++) {
    last = fullTest(engine, 'm7', hyp, [['claude-opus-4-8', 1000, 0.69], ['gpt-5.5', 1000, 0.70], ['glm-5.2', 1000, 0.69]]);
  }
  assert.equal(last.failureCounter.exhaustionFlagged, true);
  assert.ok(last.advisory);
  assert.match(last.advisory, /does not stop the run|reports risk/i);
  // 13 < 30, so this is the RISK ADVISORY band, not branch retirement yet
  assert.equal(last.branchRetirement.retired, false);
  // campaign is not "done": the engine still accepts more work
  assert.equal(last.status, 'OK');
  // there is no completion flag anywhere in state
  const state = store.load('m7');
  assert.equal(state.status === 'COMPLETE', false);
});
