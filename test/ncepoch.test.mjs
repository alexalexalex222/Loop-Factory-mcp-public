// Regression: a deterministic oracle introduced via benchmark_select{newEpoch} must
// record its negative control, exactly like the first-freeze path. Before the fix the
// newEpoch branch returned before the NC precondition, so a deterministic oracle added
// in a later epoch never recorded an NC and promotion sealed NEGATIVE_CONTROL_PASSED on
// null — the gap that blocked the one genuine win in run-1d313906.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, BASELINE_BODY } from './helpers.mjs';

const dims = { taskValueDimensions: ['q'], resourceDimensions: ['tokenCost'], cases: [{ id: 'c1', prompt: 'x' }] };

test('NC precondition runs on the newEpoch freeze path, not only first-freeze', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'nce1', task: SPECIFIC_TASK });
  engine.artifact_record({ runId: 'nce1', role: 'baseline', content: BASELINE_BODY });
  // epoch 1: a NON-deterministic (string) oracle, like run-1d313906's bench-001 → no NC recorded
  const prop = engine.benchmark_propose({ runId: 'nce1', benchmarks: [
    { name: 'string-oracle', ...dims, oracle: 'free-text rubric, judged by a human' },
    { name: 'machine-oracle', ...dims, oracle: { mustInclude: ['VERIFIED'], mustExclude: ['I think'] } }
  ] });
  const [stringId, detId] = prop.benchmarkIds;
  const f1 = engine.benchmark_select({ runId: 'nce1', benchmarkId: stringId });
  assert.equal(f1.status, 'OK');
  assert.equal(store.load('nce1').benchmark.negativeControl, null, 'string oracle records no NC');
  // epoch 2 via newEpoch: a DETERMINISTIC oracle. The fix makes the NC precondition run here too.
  const f2 = engine.benchmark_select({ runId: 'nce1', benchmarkId: detId, newEpoch: true, rationale: 'switch to a machine oracle' });
  assert.equal(f2.status, 'OK', `newEpoch freeze should succeed: ${JSON.stringify(f2)}`);
  const nc = store.load('nce1').benchmark.negativeControl;
  assert.ok(nc && nc.passed === false, 'deterministic oracle via newEpoch now records a failing negative control');
  assert.equal(nc.source, 'auto', 'auto NC (no author NC supplied) — the standard fake fails the oracle');
});

test('a non-discriminating deterministic oracle via newEpoch is still sealed (guard intact)', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'nce2', task: SPECIFIC_TASK });
  engine.artifact_record({ runId: 'nce2', role: 'baseline', content: BASELINE_BODY });
  // A "machine" oracle whose mustInclude marker is also present in the standard negative
  // control would let a fake pass → must be sealed even when introduced via newEpoch.
  const prop = engine.benchmark_propose({ runId: 'nce2', benchmarks: [
    { name: 'string-oracle', ...dims, oracle: 'free-text rubric' },
    { name: 'gameable', ...dims, oracle: { mustInclude: ['lorem'] } } // present in standardNegativeControl
  ] });
  const [stringId, gameableId] = prop.benchmarkIds;
  engine.benchmark_select({ runId: 'nce2', benchmarkId: stringId });
  const bad = engine.benchmark_select({ runId: 'nce2', benchmarkId: gameableId, newEpoch: true, rationale: 'try a non-discriminating oracle' });
  assert.equal(bad.status, 'BLOCKED');
  assert.equal(bad.code, 'INTEGRITY_GATE', 'newEpoch path seals a benchmark that cannot fail a fake');
  // the old (string) benchmark stays frozen; the bad one did not replace it
  assert.equal(store.load('nce2').benchmark.def.id, stringId);
});
