// Supervisor/harness behavior: Loop Factory owns transitions, the target queue, builder
// routing, and review authority. A worker only PROPOSES; only a supervisor-accepted
// transition counts as progress. Dashboard review never blocks the campaign and the
// model can never resolve its own review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, initThroughBaselineBar, recordMeasurement, BASELINE_BODY, promoteWithApproval } from './helpers.mjs';

const H = (model, title, extra = {}) => ({ title, bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model }, ...extra });

test('builds / in-loop gating route to Opus 4.8 or GLM 5.2 — Codex/GPT builder is refused', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'b1');
  // gpt-5.5 is a fine frontier TEST worker, but naming it as the BUILDER is refused
  const bad = engine.register_hypotheses({ runId: 'b1', hypotheses: [
    H('claude-opus-4-8', 'a', { builderRoute: 'gpt-5.5' }),
    H('gpt-5.5', 'b'),
    H('glm-5.2', 'c')
  ] });
  assert.equal(bad.status, 'BLOCKED');
  assert.equal(bad.code, 'BUILDER_ROUTE');

  const codex = engine.register_hypotheses({ runId: 'b1', hypotheses: [
    H('claude-opus-4-8', 'a', { builderRoute: 'codex' }), H('gpt-5.5', 'b'), H('glm-5.2', 'c')
  ] });
  assert.equal(codex.code, 'BUILDER_ROUTE', 'codex is a host surface, not an in-loop builder');

  // trusted builder routes pass
  const good = engine.register_hypotheses({ runId: 'b1', hypotheses: [
    H('claude-opus-4-8', 'a', { builderRoute: 'claude-opus-4-8' }),
    H('gpt-5.5', 'b', { builderRoute: 'glm-5.2' }),
    H('glm-5.2', 'c')
  ] });
  assert.equal(good.status, 'OK');
});

test('only a supervisor-accepted transition counts as progress (a worker "done" does not)', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 's1', task: 'Improve precision by at least 10% under benchmark cost.' });
  // worker proposes completion → refused, continuation obligation opens
  const done = engine.cycle_decision_request({ runId: 's1', intent: 'mark_complete' });
  assert.equal(done.status, 'BLOCKED');
  assert.equal(done.continuation.required, true);
  // worker records a next-lane commitment (a proposal) → still not cleared
  const commit = engine.continue_run({ runId: 's1', lane: 'baseline lane', firstAction: 'artifact_record role=baseline' });
  assert.equal(commit.continuation.required, true, 'a worker proposal is not progress');
  // a real supervisor-accepted progress tool clears it
  const progress = engine.artifact_record({ runId: 's1', role: 'baseline', content: BASELINE_BODY });
  assert.equal(progress.continuation.required, false);
});

test('pending dashboard review does NOT stop the campaign; the model cannot resolve it', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 's2', task: 'Improve precision by at least 10% under benchmark cost.' });
  const queued = engine.human_review_request({ runId: 's2', action: 'add', item: { title: 'subjective win', kind: 'promotion', summary: 'looks better' } });
  assert.equal(queued.status, 'OK');
  assert.equal(queued.reviewAuthority, 'dashboard-only');
  // the model cannot resolve its own review gate
  const spoof = engine.human_review_request({ runId: 's2', action: 'resolve', reviewId: queued.reviewId, decision: 'approve' });
  assert.equal(spoof.status, 'BLOCKED');
  assert.equal(spoof.code, 'DASHBOARD_ONLY');
  // pending review does not block: the supervisor reports it and keeps running
  const status = engine.campaign_status({ runId: 's2' });
  assert.equal(status.pendingDashboardReview, 1);
  assert.equal(status.pendingReviewBlocksCampaign, false);
  // a real progress tool still runs with a review pending
  const progress = engine.artifact_record({ runId: 's2', role: 'baseline', content: BASELINE_BODY });
  assert.equal(progress.status, 'OK');
});

test('campaign_status exposes the lane queue, retirement threshold, advisory band, and builder routes', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 's3', task: 'Improve precision by at least 10% under benchmark cost.' });
  engine.loop_start({ runId: 's3', loop: 'strip-miner' });
  const s = engine.campaign_status({ runId: 's3' });
  assert.equal(s.status, 'OK'); // envelope status, not the run status (regression guard)
  assert.equal(s.runStatus, 'ACTIVE');
  assert.equal(s.activeLane.kind, 'mine');
  assert.equal(s.branchRetirementThreshold, 30);
  assert.ok(s.advisoryBand >= 10 && s.advisoryBand <= 15);
  // Active policy (defaults) — not a hard-coded constant the campaign cannot change.
  assert.ok(s.modelPolicy, 'campaign_status exposes the ACTIVE modelPolicy');
  assert.equal(s.modelPolicy.banlist.mode, 'default');
  assert.deepEqual(s.builderGatingRoutes, s.modelPolicy.builderRoutes);
  assert.deepEqual(s.modelPolicy.builderRoutes, ['claude-opus-4-8', 'glm-5.2']);
  assert.match(s.stopCondition, /you are the stop condition/i);
});

test('a measured + reverified win still promotes through the supervisor delta', () => {
  // Guards that the benchmark path (baseline measured, challenger measured on the
  // same yardstick, supervisor delta, reverify) still works end-to-end after refactor.
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 's4', { baseQuality: 0.7, baseCost: 1000 });
  const reg = engine.register_hypotheses({ runId: 's4', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const hyp = reg.hypothesisIds[0];
  const agentRuns = [['claude-opus-4-8', 980, 0.82], ['gpt-5.5', 990, 0.83], ['glm-5.2', 985, 0.84]]
    .map(([m, c, q], i) => ({ model: m, measurementRef: recordMeasurement(engine, 's4', `r${i}`, c, q) }));
  const ft = engine.test_hypothesis({ runId: 's4', hypothesisId: hyp, fullTest: { agentRuns } });
  assert.equal(ft.verdict, 'MOVED_FRONTIER');
  // promotion blocked until reverify
  assert.equal(engine.promotion_request({ runId: 's4', hypothesisId: hyp }).code, 'NOT_REVERIFIED');
  engine.reverify_run({ runId: 's4', testId: ft.testId });
  const promo = promoteWithApproval(engine, 's4', hyp);
  assert.equal(promo.status, 'OK');
  assert.equal(promo.continuation.required, true, 'promotion is a checkpoint, the campaign keeps running');
});
