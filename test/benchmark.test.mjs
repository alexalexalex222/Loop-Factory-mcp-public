// Req 6: benchmark-first. Baseline hash-locked (write-once), scorecard frozen
// before challengers, weak benchmarks rejected, model-reported bars rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, recordMeasurement, BASELINE_BODY, BASELINE_BODY_V2 } from './helpers.mjs';

function init(engine, runId) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
}

test('baseline is hash-locked write-once; tampering is refused', () => {
  const { engine } = freshEngine();
  init(engine, 'b1');
  const a = engine.artifact_record({ runId: 'b1', role: 'baseline', content: BASELINE_BODY });
  assert.equal(a.role, 'baseline');
  assert.ok(a.baseline.recorded);
  // same bytes again → idempotent OK
  const same = engine.artifact_record({ runId: 'b1', role: 'baseline', content: BASELINE_BODY });
  assert.equal(same.status, 'OK');
  // different bytes → BLOCKED
  const tamper = engine.artifact_record({ runId: 'b1', role: 'baseline', content: BASELINE_BODY_V2 });
  assert.equal(tamper.status, 'BLOCKED');
  assert.equal(tamper.code, 'BASELINE_LOCKED');
  // explicit new epoch is allowed
  const epoch = engine.artifact_record({ runId: 'b1', role: 'baseline', content: BASELINE_BODY_V2, newEpoch: true, rationale: 'metric epoch 2' });
  assert.equal(epoch.status, 'OK');
});

test('a hand-waved benchmark (no dimensions/cases) is rejected', () => {
  const { engine } = freshEngine();
  init(engine, 'b2');
  const r = engine.benchmark_propose({ runId: 'b2', benchmarks: [{ name: 'empty', taskValueDimensions: [], resourceDimensions: [], cases: [] }] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'WEAK_BENCHMARK');
});

test('benchmark cannot be frozen before the baseline is locked', () => {
  const { engine } = freshEngine();
  init(engine, 'b3');
  const prop = engine.benchmark_propose({ runId: 'b3', benchmarks: [{ name: 'bm', taskValueDimensions: ['q'], resourceDimensions: ['cost'], cases: [{ id: 'c1' }] }] });
  const sel = engine.benchmark_select({ runId: 'b3', benchmarkId: prop.benchmarkIds[0] });
  assert.equal(sel.status, 'BLOCKED');
  assert.equal(sel.code, 'BASELINE_FIRST');
});

test('frozen benchmark is immutable mid-cycle', () => {
  const { engine } = freshEngine();
  init(engine, 'b4');
  engine.artifact_record({ runId: 'b4', role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId: 'b4', benchmarks: [
    { name: 'bm1', taskValueDimensions: ['q'], resourceDimensions: ['cost'], cases: [{ id: 'c1' }] },
    { name: 'bm2', taskValueDimensions: ['q'], resourceDimensions: ['cost'], cases: [{ id: 'c2' }] }
  ] });
  engine.benchmark_select({ runId: 'b4', benchmarkId: prop.benchmarkIds[0] });
  const swap = engine.benchmark_select({ runId: 'b4', benchmarkId: prop.benchmarkIds[1] });
  assert.equal(swap.status, 'BLOCKED');
  assert.equal(swap.code, 'BENCHMARK_FROZEN');
});

test('the baseline bar must be tool-measured, not model-reported', () => {
  const { engine } = freshEngine();
  init(engine, 'b5');
  engine.artifact_record({ runId: 'b5', role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId: 'b5', benchmarks: [{ name: 'bm', taskValueDimensions: ['q'], resourceDimensions: ['cost'], cases: [{ id: 'c1' }] }] });
  engine.benchmark_select({ runId: 'b5', benchmarkId: prop.benchmarkIds[0] });
  // no measurementRef → rejected
  const bad = engine.benchmark_run({ runId: 'b5', arm: 'baseline', measurementRef: 'does-not-exist' });
  assert.equal(bad.status, 'BLOCKED');
  assert.equal(bad.code, 'MODEL_REPORTED');
  // proper tool-measured artifact → bar set
  const ref = recordMeasurement(engine, 'b5', 'bar', 1000, 0.7);
  const okRun = engine.benchmark_run({ runId: 'b5', arm: 'baseline', measurementRef: ref });
  assert.equal(okRun.status, 'OK');
  assert.equal(okRun.baselineScore.quality, 0.7);
});
