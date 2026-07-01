// Step 1 — baseline integrity floor. A baseline is the reference a challenger must
// beat, so a worker cannot register a trivial/placeholder bar (the Opus pattern:
// register a PLACEHOLDER scaffold, then auto-promote stubs against it). The floor
// rejects placeholder/shallow worker baselines at record time; a maker/operator
// baseline waives the floor ONLY with the out-of-band operator authority; and a
// worker that authored both the baseline and a challenger (same bytes) cannot set
// its own bar at benchmark_run arm=baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, recordMeasurement, BASELINE_BODY } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';

const DET_BENCH = {
  name: 'bm', taskValueDimensions: ['q'], resourceDimensions: ['cost'],
  cases: [{ id: 'c1' }], oracle: DEFAULT_QUALITY_ORACLE
};

test('a PLACEHOLDER baseline is rejected (even when otherwise substantial)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi1', task: SPECIFIC_TASK });
  // substantial enough to clear size/structure, but it names itself a placeholder
  const r = engine.artifact_record({ runId: 'bi1', role: 'baseline', content: `${BASELINE_BODY}\n\nThis last section is a PLACEHOLDER pending the real text.` });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_PLACEHOLDER');
});

test('a baseline under the token floor is rejected (BASELINE_TOO_SHALLOW)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi2', task: SPECIFIC_TASK });
  const r = engine.artifact_record({ runId: 'bi2', role: 'baseline', content: 'A short baseline note with no real content.' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_TOO_SHALLOW');
  assert.ok(r.evidence.tokenEstimate < 200);
});

test('a long but unstructured baseline (no headers, no code blocks) is rejected (BASELINE_TOO_SHALLOW)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi3', task: SPECIFIC_TASK });
  const longProse = 'word '.repeat(250); // ~312 tokens, 0 headers, 0 code blocks
  const r = engine.artifact_record({ runId: 'bi3', role: 'baseline', content: longProse });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_TOO_SHALLOW');
  assert.equal(r.evidence.headers, 0);
  assert.equal(r.evidence.codeBlocks, 0);
});

test('a real (structured, >=200 token) worker baseline is accepted', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi4', task: SPECIFIC_TASK });
  const r = engine.artifact_record({ runId: 'bi4', role: 'baseline', content: BASELINE_BODY });
  assert.equal(r.status, 'OK');
  assert.equal(r.baseline.recorded, true);
  assert.equal(r.baseline.baselineSource, 'worker');
});

test('a maker/operator baseline WITHOUT the operator authority is refused (BASELINE_AUTHOR_FORBIDDEN)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi5', task: SPECIFIC_TASK });
  // no authority at all
  const noAuth = engine.artifact_record({ runId: 'bi5', role: 'baseline', baselineSource: 'maker', content: 'BASE' });
  assert.equal(noAuth.status, 'BLOCKED');
  assert.equal(noAuth.code, 'BASELINE_AUTHOR_FORBIDDEN');
  // a wrong/guessed authority does not match the out-of-band secret either
  const wrongAuth = engine.artifact_record({ runId: 'bi5', role: 'baseline', baselineSource: 'operator', baselineAuthority: 'not-the-secret', content: 'BASE' });
  assert.equal(wrongAuth.status, 'BLOCKED');
  assert.equal(wrongAuth.code, 'BASELINE_AUTHOR_FORBIDDEN');
});

test('a maker baseline WITH the operator authority waives the floor and is accepted', () => {
  const { engine } = freshEngine(); // freshEngine configures operatorAuthority:"operator"
  engine.initialize_loop_run({ runId: 'bi6', task: SPECIFIC_TASK });
  // tiny content that WOULD fail the worker floor — accepted because it is operator-authored out of band
  const r = engine.artifact_record({ runId: 'bi6', role: 'baseline', baselineSource: 'maker', baselineAuthority: 'operator', content: 'BASE' });
  assert.equal(r.status, 'OK');
  assert.equal(r.baseline.baselineSource, 'maker');
});

test('fail-closed: with no operator authority configured, a maker baseline is always refused', () => {
  const { engine } = freshEngine({ operatorAuthority: null }); // env unset / not configured
  engine.initialize_loop_run({ runId: 'bi7', task: SPECIFIC_TASK });
  const r = engine.artifact_record({ runId: 'bi7', role: 'baseline', baselineSource: 'maker', baselineAuthority: 'operator', content: BASELINE_BODY });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_AUTHOR_FORBIDDEN');
});

test('a worker that authored both the baseline and a same-bytes challenger cannot set its own bar', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi8', task: SPECIFIC_TASK });
  // worker locks a (floor-passing) baseline...
  engine.artifact_record({ runId: 'bi8', role: 'baseline', content: BASELINE_BODY });
  // ...then records a challenger artifact with the EXACT same bytes (authored both)
  engine.artifact_record({ runId: 'bi8', role: 'runlog', name: 'challenger', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId: 'bi8', benchmarks: [DET_BENCH] });
  engine.benchmark_select({ runId: 'bi8', benchmarkId: prop.benchmarkIds[0] });
  const ref = recordMeasurement(engine, 'bi8', 'bar', 1000, 0.7);
  const r = engine.benchmark_run({ runId: 'bi8', arm: 'baseline', measurementRef: ref });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_AUTHOR_FORBIDDEN');
});

test('a normal worker baseline (no self-bar) still sets the bar — the guard does not false-positive', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'bi9', task: SPECIFIC_TASK });
  engine.artifact_record({ runId: 'bi9', role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId: 'bi9', benchmarks: [DET_BENCH] });
  engine.benchmark_select({ runId: 'bi9', benchmarkId: prop.benchmarkIds[0] });
  const ref = recordMeasurement(engine, 'bi9', 'bar', 1000, 0.7);
  const r = engine.benchmark_run({ runId: 'bi9', arm: 'baseline', measurementRef: ref });
  assert.equal(r.status, 'OK');
  assert.equal(r.baselineScore.quality, 0.7);
});
