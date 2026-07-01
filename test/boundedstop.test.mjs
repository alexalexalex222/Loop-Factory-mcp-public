// Bounded-mode stop: when (and ONLY when) the operator set a limit, reaching it is a
// legitimate "you may stop your /loop" point — tool-determined (full-test count or the
// exhaustion advisory), never a model claim. Infinite mode never self-stops. The run
// stays resumable; nothing auto-promotes. This is what keeps a bounded run from idling
// for hours (the run-1d313906 case) without weakening "the operator is the only stop".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, recordMeasurement, BASELINE_BODY } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';

const ROUTES = ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'];

// init → baseline → frozen deterministic benchmark → measured bar → 3 hypotheses →
// ONE full test (counters.test += 1). Returns the (heartbeat-wrapped) test result.
function driveOneFullTest(engine, runId, config) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK, userMessages: ['go'], config });
  engine.artifact_record({ runId, role: 'baseline', name: 'baseline.md', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId, benchmarks: [{
    name: 'b', taskValueDimensions: ['q'], resourceDimensions: ['tokenCost'],
    cases: [{ id: 'c1', input: 'x' }], oracle: DEFAULT_QUALITY_ORACLE
  }] });
  engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  engine.benchmark_run({ runId, arm: 'baseline', measurementRef: recordMeasurement(engine, runId, 'bar', 1000, 0.5) });
  const reg = engine.register_hypotheses({ runId, hypotheses: ROUTES.map((m, i) => ({ title: `h${i}`, bottleneck: 'b', operation: 'o', route: { model: m } })) });
  const agentRuns = ROUTES.map((m, i) => ({ model: m, measurementRef: recordMeasurement(engine, runId, `r${i}`, 800, 0.9) }));
  return engine.test_hypothesis({ runId, hypothesisId: reg.hypothesisIds[0], fullTest: { agentRuns } });
}

test('infinite mode (default): a full test never sets boundedComplete; heartbeat stays open', () => {
  const { engine, store } = freshEngine();
  const r = driveOneFullTest(engine, 'inf1'); // no config → infinite
  assert.equal(store.load('inf1').config.runMode, 'infinite');
  assert.equal(store.load('inf1').config.maxCycles, null);
  assert.equal(r.campaignContinues, true, 'infinite run keeps going');
  assert.equal(r.boundedComplete, undefined, 'no bounded-complete signal in infinite mode');
});

test('bounded mode: the operator limit is parsed once at init', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'b0', task: SPECIFIC_TASK, config: { maxCycles: 3 } });
  const s = store.load('b0');
  assert.equal(s.config.runMode, 'bounded');
  assert.equal(s.config.maxCycles, 3);
  // a worker cannot change it mid-run: re-init is idempotent and does not re-parse config
  engine.initialize_loop_run({ runId: 'b0', task: SPECIFIC_TASK, config: { maxCycles: 99 } });
  assert.equal(store.load('b0').config.maxCycles, 3, 'limit is locked at first-init');
});

test('bounded mode: reaching the full-test limit flips the heartbeat to "you may stop"', () => {
  const { engine } = freshEngine();
  const r = driveOneFullTest(engine, 'b1', { maxCycles: 1 }); // 1 full test == the limit
  assert.ok(['INITIALIZED', 'ACTIVE', 'NEEDS_RESUME'].includes(r.runStatus), 'run stays open/resumable, not a terminal status');
  assert.equal(r.campaignContinues, false, 'host may stop its /loop at the bounded limit');
  assert.equal(r.boundedComplete, true);
  assert.match(r.mayStopLoop, /may stop your \/loop|NOT a self-completion/i);
  assert.match(r.next, /stop the loop|resume/i);
});

test('bounded mode: campaign_status reports runMode / cyclesDone / boundedComplete', () => {
  const { engine } = freshEngine();
  driveOneFullTest(engine, 'b2', { maxCycles: 1 });
  const st = engine.campaign_status({ runId: 'b2' });
  assert.equal(st.runMode, 'bounded');
  assert.equal(st.maxCycles, 1);
  assert.equal(st.cyclesDone, 1);
  assert.equal(st.boundedComplete, true);
});

test('bounded mode below the limit still continues (does not stop early)', () => {
  const { engine } = freshEngine();
  const r = driveOneFullTest(engine, 'b3', { maxCycles: 5 }); // 1 of 5 → keep going
  assert.equal(r.campaignContinues, true, 'under the limit, the run keeps going');
  assert.equal(r.boundedComplete, undefined);
});
