// Security gates: the MCP must not let model-supplied ids become filesystem
// paths, and it must not read arbitrary local files into artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, BASELINE_BODY } from './helpers.mjs';

test('initialize_loop_run rejects path-like runId values before persistence', () => {
  const { engine, store } = freshEngine();
  const r = engine.initialize_loop_run({ runId: '../escape', task: SPECIFIC_TASK });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BAD_INPUT');
  assert.match(r.message, /Invalid runId/);
  assert.deepEqual(store.listRuns(), []);
});

test('other tools reject path-like runId values as BAD_INPUT, not UNKNOWN_RUN', () => {
  const { engine } = freshEngine();
  const r = engine.loop_start({ runId: '../../outside', loop: 'strip-miner' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BAD_INPUT');
  assert.match(r.message, /Invalid runId/);
});

test('artifact_record refuses sourcePath reads', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'sec-sourcepath', task: SPECIFIC_TASK });
  const r = engine.artifact_record({ runId: 'sec-sourcepath', role: 'baseline', sourcePath: '/etc/hosts' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BAD_INPUT');
  assert.match(r.message, /sourcePath reads are disabled/);
  assert.equal(Object.hasOwn(r, 'artifactId'), false);
});

test('benchmark_run rejects path-like measurementRef before artifact lookup', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'sec-measurement', task: SPECIFIC_TASK });
  engine.artifact_record({ runId: 'sec-measurement', role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({
    runId: 'sec-measurement',
    benchmarks: [{
      name: 'safe-ref-benchmark',
      taskValueDimensions: ['quality'],
      resourceDimensions: ['token-cost'],
      cases: [{ id: 'case-1', input: 'prior session', expect: 'measured output' }]
    }]
  });
  engine.benchmark_select({ runId: 'sec-measurement', benchmarkId: prop.benchmarkIds[0] });
  const r = engine.benchmark_run({ runId: 'sec-measurement', arm: 'baseline', measurementRef: '../../secret' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'MODEL_REPORTED');
  assert.match(r.message, /invalid measurementRef/);
});
