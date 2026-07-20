// Step 2 — promotion requires operator approval on the dashboard. A challenger that
// wins the pareto math AND clears the integrity gate is NECESSARY but NOT SUFFICIENT:
// it queues a PENDING promotion review and cannot ship until the operator Approves out
// of band. The model can queue/list reviews but never resolve them (DASHBOARD_ONLY);
// resolution flows only through engine.operator.applyDashboardDecisions (the dashboard
// server's inbox), which is not on the model-callable tool surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, initThroughBaselineBar, recordMeasurement } from './helpers.mjs';

const ROUTES = ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'];
const H = (model) => ({ title: 'h', bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });

// Drive a run to a measured + reverified deterministic frontier win, ready to promote.
function readyToPromote(engine, runId) {
  initThroughBaselineBar(engine, runId, { baseQuality: 0.7, baseCost: 1000 });
  const reg = engine.register_hypotheses({ runId, hypotheses: ROUTES.map((m) => H(m)) });
  const hyp = reg.hypothesisIds[0];
  const agentRuns = [[1010, 0.80], [1000, 0.82], [1005, 0.81]].map(([c, q], i) => ({ model: ROUTES[i], measurementRef: recordMeasurement(engine, runId, `r${i}`, c, q) }));
  const ft = engine.test_hypothesis({ runId, hypothesisId: hyp, fullTest: { agentRuns } });
  engine.reverify_run({ runId, testId: ft.testId });
  return hyp;
}

test('a pareto+integrity win cannot ship without approval — it queues a PENDING promotion review', () => {
  const { engine, store } = freshEngine();
  const hyp = readyToPromote(engine, 'pa1');
  const r = engine.promotion_request({ runId: 'pa1', hypothesisId: hyp });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'PROMOTION_NEEDS_APPROVAL');
  assert.ok(r.queuedReviewId, 'a queued review id is returned');
  const rev = store.load('pa1').humanReviews.find((x) => x.id === r.queuedReviewId);
  assert.ok(rev && rev.status === 'PENDING' && rev.kind === 'promotion' && rev.hypothesisId === hyp, 'review enqueued, PENDING, kind:promotion, points at the hypothesis');
  assert.equal(store.load('pa1').promotions.length, 0, 'nothing shipped');
});

test('calling promotion_request again before approval does not double-queue', () => {
  const { engine, store } = freshEngine();
  const hyp = readyToPromote(engine, 'pa1b');
  const first = engine.promotion_request({ runId: 'pa1b', hypothesisId: hyp });
  const second = engine.promotion_request({ runId: 'pa1b', hypothesisId: hyp });
  assert.equal(second.code, 'PROMOTION_NEEDS_APPROVAL');
  assert.equal(first.queuedReviewId, second.queuedReviewId, 'same pending review, not a new one');
  assert.equal(store.load('pa1b').humanReviews.filter((x) => x.kind === 'promotion').length, 1);
});

test('operator Approve on the dashboard lets the next promotion_request record the champion', () => {
  const { engine, store } = freshEngine();
  const hyp = readyToPromote(engine, 'pa2');
  const queued = engine.promotion_request({ runId: 'pa2', hypothesisId: hyp });
  assert.equal(queued.code, 'PROMOTION_NEEDS_APPROVAL');
  // out-of-band dashboard approval — NOT a model-callable tool
  const ap = engine.operator.applyDashboardDecisions({ runId: 'pa2', decisions: { [queued.queuedReviewId]: { decision: 'approve' } } });
  assert.equal(ap.ok, true);
  const promo = engine.promotion_request({ runId: 'pa2', hypothesisId: hyp });
  assert.equal(promo.status, 'OK');
  assert.equal(promo.decision.promote, true);
  assert.equal(store.load('pa2').promotions.length, 1, 'exactly one champion recorded after approval');
});

test('promotion_request rechecks the unchanged gate after approval and refuses stale evidence', () => {
  const { engine, store } = freshEngine();
  const hyp = readyToPromote(engine, 'pa2-stale');
  const queued = engine.promotion_request({ runId: 'pa2-stale', hypothesisId: hyp });
  engine.operator.applyDashboardDecisions({
    runId: 'pa2-stale',
    decisions: { [queued.queuedReviewId]: { decision: 'approve' } }
  });
  const state = store.load('pa2-stale');
  state.tests.find((testRun) => testRun.hypothesisId === hyp).reverified = false;
  store.save(state);

  const promotion = engine.promotion_request({ runId: 'pa2-stale', hypothesisId: hyp });
  assert.equal(promotion.status, 'BLOCKED');
  assert.equal(promotion.code, 'NOT_REVERIFIED');
  assert.equal(store.load('pa2-stale').promotions.length, 0);
});

test('operator Sludge on the dashboard rejects the champion (PROMOTION_REJECTED)', () => {
  const { engine, store } = freshEngine();
  const hyp = readyToPromote(engine, 'pa3');
  const queued = engine.promotion_request({ runId: 'pa3', hypothesisId: hyp });
  engine.operator.applyDashboardDecisions({ runId: 'pa3', decisions: { [queued.queuedReviewId]: { decision: 'sludge', notes: 'not good enough' } } });
  const promo = engine.promotion_request({ runId: 'pa3', hypothesisId: hyp });
  assert.equal(promo.status, 'BLOCKED');
  assert.equal(promo.code, 'PROMOTION_REJECTED');
  assert.equal(store.load('pa3').promotions.length, 0, 'a sludged champion never ships');
});

test('the model cannot resolve a promotion review — resolution is dashboard-only', () => {
  const { engine } = freshEngine();
  const hyp = readyToPromote(engine, 'pa4');
  const queued = engine.promotion_request({ runId: 'pa4', hypothesisId: hyp });
  // the model-callable tool cannot approve its own promotion
  const spoof = engine.human_review_request({ runId: 'pa4', action: 'resolve', reviewId: queued.queuedReviewId, decision: 'approve' });
  assert.equal(spoof.status, 'BLOCKED');
  assert.equal(spoof.code, 'DASHBOARD_ONLY');
  // still pending, still unshipped
  const after = engine.promotion_request({ runId: 'pa4', hypothesisId: hyp });
  assert.equal(after.code, 'PROMOTION_NEEDS_APPROVAL');
});

test('approve → record is idempotent: a re-call after recording does not double-bank', () => {
  const { engine, store } = freshEngine();
  const hyp = readyToPromote(engine, 'pa5');
  const queued = engine.promotion_request({ runId: 'pa5', hypothesisId: hyp });
  engine.operator.applyDashboardDecisions({ runId: 'pa5', decisions: { [queued.queuedReviewId]: { decision: 'approve' } } });
  const p1 = engine.promotion_request({ runId: 'pa5', hypothesisId: hyp });
  const p2 = engine.promotion_request({ runId: 'pa5', hypothesisId: hyp });
  assert.equal(p1.status, 'OK');
  assert.equal(p2.status, 'OK');
  assert.equal(store.load('pa5').promotions.length, 1, 'only one promotion recorded across repeated calls');
});
