// Req 3 (the hook) + "operator is the stop condition": cycle_decision_request
// routes upgrade/complete decisions through the evidence gate. Reasoning alone is not
// evidence; the model can never mark the campaign complete or "perfect".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, initThroughBaselineBar, recordMeasurement, BASELINE_BODY } from './helpers.mjs';

const H = (model, title) => ({ title, bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });

test('completion and checkpoint endings are always refused (operator is the stop condition)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'k1', task: 'Improve precision by at least 10% under benchmark cost.' });
  for (const intent of ['mark_complete', 'declare_perfect', 'stop_campaign', 'finish', 'checkpoint_complete']) {
    const r = engine.cycle_decision_request({ runId: 'k1', intent });
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.code, 'OPERATOR_IS_STOP');
    assert.equal(r.continuation.required, true);
    assert.match(r.message, /next runnable bottleneck or lane/i);
  }
});

test('continuation commitment does not clear until a real progress tool runs', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'k1b', task: 'Improve precision by at least 10% under benchmark cost.' });
  const blocked = engine.cycle_decision_request({ runId: 'k1b', intent: 'checkpoint_complete' });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.continuation.required, true);
  assert.equal(blocked.continuation.next.tool, 'artifact_record');

  const weak = engine.continue_run({ runId: 'k1b', lane: 'next benchmark lane' });
  assert.equal(weak.status, 'BLOCKED');
  assert.equal(weak.code, 'BAD_INPUT');
  assert.equal(weak.continuation.required, true);

  const continued = engine.continue_run({
    runId: 'k1b',
    lane: 'next benchmark lane',
    firstAction: 'hash-lock the baseline with artifact_record role=baseline'
  });
  assert.equal(continued.status, 'OK');
  assert.equal(continued.continuation.required, true);
  assert.match(continued.next, /artifact_record/);

  const progressed = engine.artifact_record({ runId: 'k1b', role: 'baseline', content: BASELINE_BODY });
  assert.equal(progressed.status, 'OK');
  assert.equal(progressed.continuation.required, false);
});

test('promote via the hook still demands measured + reverified evidence', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'k2');
  const reg = engine.register_hypotheses({ runId: 'k2', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const hyp = reg.hypothesisIds[0];
  // try to promote with nothing measured → blocked through the hook
  const blocked = engine.cycle_decision_request({ runId: 'k2', intent: 'promote', hypothesisId: hyp });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.code, 'NO_SCORE_MATRIX');
  assert.ok(blocked.decisionId, 'the decision is audited even when blocked');

  // now measure + reverify, then promote through the hook → Step 2: queued for operator
  // Approve on the dashboard, then OK once approved
  const agentRuns = [['claude-opus-4-8', 1010, 0.81], ['gpt-5.5', 1000, 0.82], ['glm-5.2', 1005, 0.83]]
    .map(([m, c, q], i) => ({ model: m, measurementRef: recordMeasurement(engine, 'k2', `r${i}`, c, q) }));
  const ft = engine.test_hypothesis({ runId: 'k2', hypothesisId: hyp, fullTest: { agentRuns } });
  engine.reverify_run({ runId: 'k2', testId: ft.testId });
  const queued = engine.cycle_decision_request({ runId: 'k2', intent: 'promote', hypothesisId: hyp });
  assert.equal(queued.code, 'PROMOTION_NEEDS_APPROVAL');
  engine.operator.applyDashboardDecisions({ runId: 'k2', decisions: { [queued.queuedReviewId]: { decision: 'approve' } } });
  const promoted = engine.cycle_decision_request({ runId: 'k2', intent: 'promote', hypothesisId: hyp });
  assert.equal(promoted.status, 'OK');
  assert.match(promoted.hookNote, /Reasoning alone is not evidence/);
  assert.equal(promoted.continuation.required, true, 'promotion is a checkpoint that still requires continuation');
});

test('changing a locked baseline / frozen benchmark via the hook needs a new epoch', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'k3');
  const b = engine.cycle_decision_request({ runId: 'k3', intent: 'change_baseline' });
  assert.equal(b.status, 'BLOCKED');
  assert.equal(b.code, 'BASELINE_LOCKED');
  const okB = engine.cycle_decision_request({ runId: 'k3', intent: 'change_baseline', newEpoch: true, rationale: 'corpus changed' });
  assert.equal(okB.status, 'OK');
});
