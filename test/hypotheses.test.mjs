// Req 7: hypothesis engine. 3–5 hypotheses, frontier routes only, and the
// benchmark-first ordering is enforced before any hypothesis is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, initThroughBaselineBar } from './helpers.mjs';

const H = (model, title) => ({ title: title || 'h', bottleneck: 'precision', operation: 'restructure', expectedMovement: '+quality', route: { model } });

test('hypotheses cannot be registered before the benchmark bar exists', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'h0', task: 'Improve precision by at least 10% under benchmark cost.' });
  const r = engine.register_hypotheses({ runId: 'h0', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5'), H('glm-5.2')] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BASELINE_FIRST');
});

test('fewer than 3 hypotheses is rejected', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h1');
  const r = engine.register_hypotheses({ runId: 'h1', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5')] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'HYPOTHESIS_COUNT');
});

test('more than 5 hypotheses is rejected', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h2');
  const six = Array.from({ length: 6 }, (_, i) => H('claude-opus-4-8', `h${i}`));
  const r = engine.register_hypotheses({ runId: 'h2', hypotheses: six });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'HYPOTHESIS_COUNT');
});

test('exactly 3–5 frontier hypotheses are accepted', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h3');
  const r = engine.register_hypotheses({ runId: 'h3', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5'), H('glm-5.2'), H('gemini-3-pro')] });
  assert.equal(r.status, 'OK');
  assert.equal(r.hypothesisIds.length, 4);
});

test('a haiku/mini route in the set is rejected (mini model rejection)', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h4');
  const r = engine.register_hypotheses({ runId: 'h4', hypotheses: [H('claude-opus-4-8'), H('claude-haiku-4-5'), H('glm-5.2')] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BANNED_ROUTE');
  assert.ok(r.rejected.some((x) => /haiku/.test(x.model)));
});

test('gpt-5.5-mini is rejected even though 5.5 looks current', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'h5');
  const r = engine.register_hypotheses({ runId: 'h5', hypotheses: [H('gpt-5.5-mini'), H('claude-opus-4-8'), H('glm-5.2')] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BANNED_ROUTE');
});
