// Supervisor anti-stop + no-cap guarantees. Loop Factory is the supervisor/harness and
// OWNS stop policy, so the loop text stays byte-identical to the full private
// source (we never scrub words out of it). Never-stop is proven on the SUPERVISOR:
//   - Strip Miner saturation AUTO-TRANSITIONS to the next lane (never stops)
//   - a branch retires only after 30 VALID no-improvement batches, then PIVOTS
//   - the 10-15 advisory reports risk but never stops
//   - invalid / fake-metric / summary-only batches do NOT count toward retirement
//   - pause / await_operator / no_remining_warranted are not valid campaign states
//   - no 3000-character cap exists
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLoop } from '../src/loops.mjs';
import { STATUS } from '../src/constants.mjs';
import { freshEngine, initThroughBaselineBar, recordMeasurement } from './helpers.mjs';

const H = (model, title) => ({ title, bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });
const noImproveRuns = (engine, runId, i) => [0, 1, 2].map((k) =>
  ({ model: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'][k], measurementRef: recordMeasurement(engine, runId, `t${i}-${k}`, 1000, 0.7) }));

test('the bundled loops are the FULL PRIVATE sources (un-reconstructed, full markers present)', () => {
  const miner = loadLoop('strip-miner');
  // full-only section markers prove this is the long private miner, not a lite/short one
  for (const m of ['DURABLE READER WAVES', 'CONTRADICTION SWEEP', 'CLEAN-CONTEXT REPLAY', 'INDEPENDENT ROOT-TASK PROOF', 'WEB LOOP SCOUTING AND EXTERNAL INSPIRATION', 'PUBLICATION AND SHARING BOUNDARY']) {
    assert.ok(miner.text.includes(m), `full miner missing section: ${m}`);
  }
  assert.equal(miner.lines, 345);
  assert.equal(loadLoop('loop-de-loop').lines, 75);
});

test('the loop-de-loop text forbids worker self-completion (supervisor owns completion)', () => {
  const text = loadLoop('loop-de-loop').text;
  assert.match(text, /never call the campaign complete yourself/i);
  assert.match(text, /may not[^.]*mark the campaign complete/i);
});

test('pause / await / no-remining are NOT valid campaign states', () => {
  // AWAITING_ANSWERS is the legitimate one-time startup ask-once gate, not a
  // mid-campaign stop state — exclude it explicitly; forbid the rest.
  const FORBIDDEN = ['pause', 'clean_pause', 'await_operator', 'await_operator_calls', 'no_remining_warranted'];
  for (const s of Object.values(STATUS)) {
    assert.ok(!FORBIDDEN.includes(s.toLowerCase()), `status "${s}" must not be a forbidden stop state`);
    assert.doesNotMatch(s, /clean.?pause|await.?operator|no.?remin|^pause$|\bhalt\b|saturat|complete|finished/i, `status "${s}" must not be a stop-flavored campaign state`);
  }
  // and the decision hook refuses every completion/stop-style transition intent
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'st', task: 'Improve precision by at least 10% under benchmark cost.' });
  for (const intent of ['pause', 'clean_pause', 'await_operator', 'await_operator_calls', 'no_remining_warranted', 'mark_complete', 'stop']) {
    const r = engine.cycle_decision_request({ runId: 'st', intent });
    assert.equal(r.status, 'BLOCKED', `intent ${intent} must be refused`);
    assert.equal(r.code, 'OPERATOR_IS_STOP');
    assert.equal(r.continuation.required, true);
  }
});

test('Strip Miner saturation AUTO-TRANSITIONS to the next lane (never stops)', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'sat', task: 'mine', answers: ['stronger loops', 'mine my sessions (Strip Miner)', 'more qualified loops', 'keep authorship', 'keep moving'] });
  engine.loop_start({ runId: 'sat', loop: 'strip-miner' });
  const r = engine.report_saturation({ runId: 'sat', evidence: 'final confirmation batch changed nothing material' });
  assert.equal(r.status, 'OK');
  assert.equal(r.autoTransitioned, true);
  assert.equal(r.transition.toLoop, 'loop-de-loop'); // mine → improve
  assert.equal(r.continuation.required, true); // pivot obligation, not a stop
  const state = store.load('sat');
  const mineLane = state.campaign.lanes.find((l) => l.kind === 'mine');
  assert.equal(mineLane.status, 'saturated');
  assert.ok(['ACTIVE', 'INITIALIZED'].includes(state.status), 'run never enters a terminal state on saturation');
  assert.equal(state.campaign.transitions.length, 1);
});

test('the 10-15 advisory reports risk but does NOT stop (and does not retire the branch)', () => {
  const { engine, store } = freshEngine();
  initThroughBaselineBar(engine, 'adv');
  const reg = engine.register_hypotheses({ runId: 'adv', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const hyp = reg.hypothesisIds[0];
  const band = store.load('adv').config.failurePatience;
  let last;
  for (let i = 0; i < band; i++) last = engine.test_hypothesis({ runId: 'adv', hypothesisId: hyp, fullTest: { agentRuns: noImproveRuns(engine, 'adv', i) } });
  assert.ok(last.advisory, 'advisory present at the band');
  assert.match(last.advisory, /does not stop the run|reports risk/i);
  assert.equal(last.branchRetirement.retired, false, 'advisory is well below the 30-batch retirement');
  assert.ok(['INITIALIZED', 'ACTIVE', 'NEEDS_RESUME'].includes(store.load('adv').status), 'advisory never moves the run to a terminal state');
});

test('a branch retires only after 30 VALID no-improvement batches, then PIVOTS (never stops)', () => {
  const { engine, store } = freshEngine();
  initThroughBaselineBar(engine, 'ret');
  const reg = engine.register_hypotheses({ runId: 'ret', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const hyp = reg.hypothesisIds[0];
  const threshold = store.load('ret').config.branchRetirementBatches;
  assert.equal(threshold, 30);
  let last;
  for (let i = 0; i < threshold - 1; i++) last = engine.test_hypothesis({ runId: 'ret', hypothesisId: hyp, fullTest: { agentRuns: noImproveRuns(engine, 'ret', i) } });
  assert.equal(last.branchRetirement.retired, false, `not retired before ${threshold}`);
  // the threshold-th valid no-improvement batch retires the branch and pivots
  last = engine.test_hypothesis({ runId: 'ret', hypothesisId: hyp, fullTest: { agentRuns: noImproveRuns(engine, 'ret', 999) } });
  assert.equal(last.branchRetirement.retired, true);
  assert.ok(last.retirement, 'retirement payload present');
  assert.equal(last.continuation.required, true, 'retirement leaves a pivot obligation, not a stop');
  const state = store.load('ret');
  assert.ok(['ACTIVE', 'INITIALIZED', 'NEEDS_RESUME'].includes(state.status), `retirement must not end the campaign (got ${state.status})`);
  assert.equal(state.campaign.transitions.some((t) => t.cause === 'branch_retirement'), true);
});

test('invalid / summary-only batches do NOT count toward retirement', () => {
  const { engine, store } = freshEngine();
  initThroughBaselineBar(engine, 'inv');
  const reg = engine.register_hypotheses({ runId: 'inv', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const hyp = reg.hypothesisIds[0];
  // two valid no-improvement batches
  for (let i = 0; i < 2; i++) engine.test_hypothesis({ runId: 'inv', hypothesisId: hyp, fullTest: { agentRuns: noImproveRuns(engine, 'inv', i) } });
  const before = store.load('inv').campaign.lanes.find((l) => l.status === 'active').noImproveBatches;
  assert.equal(before, 2);
  // a "summary-only" batch (too few agents) is BLOCKED and must not increment the counter
  const blockedFew = engine.test_hypothesis({ runId: 'inv', hypothesisId: hyp, fullTest: { agentRuns: [{ model: 'claude-opus-4-8', measurementRef: recordMeasurement(engine, 'inv', 'solo', 1000, 0.7) }] } });
  assert.equal(blockedFew.status, 'BLOCKED');
  assert.equal(blockedFew.code, 'FULLTEST_AGENTS');
  const after = store.load('inv').campaign.lanes.find((l) => l.status === 'active').noImproveBatches;
  assert.equal(after, before, 'an invalid/summary-only batch must not count toward retirement');
});

test('NO 3000-character cap: a long custom loop registers and streams intact', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'cap', task: 'Improve precision by at least 10% under benchmark cost.' });
  const longBody = 'This is a deliberately long loop section sentence. '.repeat(120); // ~6000 chars
  assert.ok(longBody.length > 3000);
  const content = `# PART ONE\nShort opening section.\n\n# PART TWO\n${longBody}`;
  const reg = engine.loop_register({ runId: 'cap', id: 'long-loop', title: 'Long Loop', content });
  assert.equal(reg.status, 'OK', 'a >3000-char loop must register — there is no length cap');
  engine.loop_start({ runId: 'cap', loop: 'long-loop' });
  engine.observation_record({ runId: 'cap', loop: 'long-loop', phase: 0, summary: 'read part one' });
  const s1 = engine.request_next_phase({ runId: 'cap', loop: 'long-loop' });
  assert.ok(s1.section.length > 3000, `the long section must stream uncapped (got ${s1.section.length} chars)`);
});

test('no engine tool returns a terminal "complete"/"done" status word', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'sw', task: 'Improve precision by at least 10% under benchmark cost.' });
  const results = [
    engine.loop_start({ runId: 'sw', loop: 'strip-miner' }),
    engine.report_saturation({ runId: 'sw' }),
    engine.campaign_status({ runId: 'sw' }),
    engine.update_dashboard({ runId: 'sw' }),
    engine.report_export({ runId: 'sw' }),
    engine.cycle_decision_request({ runId: 'sw', intent: 'mark_complete' })
  ];
  for (const r of results) {
    assert.ok(r.status === 'OK' || r.status === 'BLOCKED', `unexpected status ${r.status}`);
    assert.doesNotMatch(String(r.status), /complete|done|finished/i);
  }
});
