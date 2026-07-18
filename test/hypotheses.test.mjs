// Req 7: hypothesis engine. 3–5 hypotheses, routes must clear the active
// modelPolicy banlist, and the benchmark-first ordering is enforced before any
// hypothesis is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, initThroughBaselineBar, BASELINE_BODY, recordMeasurement } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import { ROUTES, POLICY_OFF, withPolicy } from './fixtures/model-policy.mjs';

const H = (model, title) => ({ title: title || 'h', bottleneck: 'precision', operation: 'restructure', expectedMovement: '+quality', route: { model } });

/** Drive baseline bar on an already-initialized run (does not re-init / clobber policy). */
function barOnRun(engine, runId, { baseQuality = 0.7, baseCost = 1000 } = {}) {
  engine.artifact_record({ runId, role: 'baseline', name: 'baseline.md', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({
    runId,
    benchmarks: [{
      name: 'miner-precision',
      taskValueDimensions: ['candidate-precision', 'evidence-fidelity'],
      resourceDimensions: ['token-cost'],
      cases: [{ id: 'c1', input: 'session-corpus-A', expect: '3 qualified loops' }],
      oracle: DEFAULT_QUALITY_ORACLE
    }]
  });
  engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  const ref = recordMeasurement(engine, runId, 'baseline-bar', baseCost, baseQuality);
  engine.benchmark_run({ runId, arm: 'baseline', measurementRef: ref });
}

test('hypotheses cannot be registered before the benchmark bar exists', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'h0', task: 'Improve precision by at least 10% under benchmark cost.' });
  const r = engine.register_hypotheses({ runId: 'h0', hypotheses: [H(ROUTES.primary), H(ROUTES.frontier[1]), H(ROUTES.frontier[2])] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_FIRST');
});

test('fewer than 3 hypotheses is rejected', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h1');
  const r = engine.register_hypotheses({ runId: 'h1', hypotheses: [H(ROUTES.primary), H(ROUTES.frontier[1])] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'HYPOTHESIS_COUNT');
});

test('more than 5 hypotheses is rejected', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h2');
  const six = Array.from({ length: 6 }, (_, i) => H(ROUTES.primary, `h${i}`));
  const r = engine.register_hypotheses({ runId: 'h2', hypotheses: six });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'HYPOTHESIS_COUNT');
});

test('exactly 3–5 frontier hypotheses are accepted', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h3');
  const r = engine.register_hypotheses({ runId: 'h3', hypotheses: [H(ROUTES.primary), H(ROUTES.frontier[1]), H(ROUTES.frontier[2]), H('gemini-3-pro')] });
  assert.equal(r.status, 'OK');
  assert.equal(r.hypothesisIds.length, 4);
});

test('under banlist mode "default", a haiku/mini route is rejected', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h4');
  const r = engine.register_hypotheses({ runId: 'h4', hypotheses: [H(ROUTES.primary), H(ROUTES.banned), H(ROUTES.builders[1])] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BANNED_ROUTE');
  assert.ok(r.rejected.some((x) => /haiku/.test(x.model)));
});

test('under banlist mode "default", gpt-5.5-mini is rejected even though 5.5 looks current', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h5');
  const r = engine.register_hypotheses({ runId: 'h5', hypotheses: [H(ROUTES.bannedMini), H(ROUTES.primary), H(ROUTES.builders[1])] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BANNED_ROUTE');
});

test('under banlist mode "off", a previously-banned haiku route is ACCEPTED', () => {
  const { engine } = freshEngine();
  withPolicy(engine, 'h4off', POLICY_OFF);
  barOnRun(engine, 'h4off');
  const r = engine.register_hypotheses({
    runId: 'h4off',
    hypotheses: [H(ROUTES.primary), H(ROUTES.banned), H(ROUTES.builders[1])]
  });
  assert.equal(r.status, 'OK', `expected haiku accepted under banlist off, got ${r.code}: ${r.message}`);
  assert.equal(r.hypothesisIds.length, 3);
});
