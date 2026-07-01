// Fix-2 — the supervisor closes the autonomous loop: a measured win is QUEUED for operator
// approval (never auto-banked), and once the operator Approves it on the dashboard (→ run inbox),
// the supervisor re-attempts promotion_request so the approved win actually banks — with no manual
// re-call and no double-bank. A Sludge leaves it unbanked. The engine's promotion gate is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSupervisedCampaign } from '../src/supervisor.mjs';
import { DEFAULT_QUALITY_ORACLE, buildMeasuredContent } from '../src/measure.mjs';
import { freshEngine, BASELINE_BODY } from './helpers.mjs';

const okPacket = (route, out) => ({ route, artifacts: [{ role: 'runlog', content: out }], finalOutput: out });
const benchmark = { name: 'b', taskValueDimensions: ['quality'], resourceDimensions: ['token-cost'], cases: [{ id: 'c1' }], oracle: DEFAULT_QUALITY_ORACLE };
const ROUTES = ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'];

// Challenger always wins the pareto math (0.86 quality at 900 cost vs baseline 0.70 at 1000).
const winWorker = (contract) => {
  if (contract.kind === 'mine') return { route: contract.route, artifacts: [{ role: 'runlog', content: 'mined' }], finalOutput: 'mined', candidates: [] };
  if (contract.kind === 'baseline') return okPacket(contract.route, buildMeasuredContent(1000, 0.70));
  return okPacket(contract.route, buildMeasuredContent(900, 0.86));
};

const improveTarget = (content = BASELINE_BODY) => ({ kind: 'improve', loop: 'loop-de-loop', baselineContent: content, benchmark, routes: ROUTES });

// Operator dashboard decision, delivered exactly how the live path does it: dropped into the
// sub-run inbox the moment a promotion review is PENDING. Fires once, for the first pending lane.
function injectDecision(store, runId, decision) {
  let dropped = false;
  return () => {
    if (!dropped) {
      for (let i = 1; i <= 8 && !dropped; i++) {
        const sub = `${runId}-t${i}`;
        if (!store.exists(sub)) continue;
        const rev = (store.load(sub).humanReviews || []).find((r) => r.kind === 'promotion' && r.status === 'PENDING');
        if (rev) {
          store.writeRunFile(sub, 'inbox-decisions.json', JSON.stringify({ runId: sub, decisions: { [rev.id]: { decision } } }));
          dropped = true;
        }
      }
    }
    return false; // never stop via the injector; queue-drain / maxBatches stops the run
  };
}

test('autonomous run: a queued measured win is NOT banked until the operator Approves — then it banks', () => {
  const { engine, store } = freshEngine();
  // Three improve lanes so the approved lane (t1) is drained on more than one tick (idempotency).
  const r = runSupervisedCampaign(engine, {
    runId: 'ab', task: 'improve the loop',
    targets: [improveTarget(), improveTarget(), improveTarget()]
  }, { worker: winWorker, maxBatches: 30, stopCheck: injectDecision(store, 'ab', 'approve') });

  assert.equal(r.status, 'OK');
  const steps = r.transcript.map((t) => t.step);
  assert.ok(steps.includes('promotion_queued'), 'the measured win was queued for approval first');

  // Exactly one stone banked — the approved lane (t1) — and it banked AFTER approval.
  assert.equal(r.stones.length, 1, 'only the operator-approved lane banks');
  const banks = r.transcript.filter((t) => t.step === 'stone_banked' && t.afterApproval);
  assert.equal(banks.length, 1, 'banked exactly once despite t1 being drained on several ticks (no double-bank)');
  assert.equal(banks[0].runId, 'ab-t1');
  assert.equal(r.stones[0].hypothesisId, banks[0].hypothesisId);

  // The other queued lanes (t2, t3) were never approved, so they stayed queued — not banked.
  assert.ok(steps.filter((s) => s === 'promotion_queued').length >= 2, 'unapproved lanes remained queued');

  // Direct path is unchanged + idempotent: a manual re-call for the banked lane records nothing new.
  const again = engine.promotion_request({ runId: 'ab-t1', hypothesisId: r.stones[0].hypothesisId });
  assert.equal(again.status, 'OK');
  assert.equal(again.alreadyRecorded, true, 'an already-banked promotion is idempotent — never re-banked');
});

test('autonomous run: operator Sludge leaves the queued win unbanked (no re-attempt bank)', () => {
  const { engine, store } = freshEngine();
  const r = runSupervisedCampaign(engine, {
    runId: 'sl', task: 'improve the loop',
    targets: [improveTarget(), improveTarget()]
  }, { worker: winWorker, maxBatches: 20, stopCheck: injectDecision(store, 'sl', 'sludge') });

  assert.equal(r.status, 'OK');
  assert.equal(r.stones.length, 0, 'a sludged win is never banked');
  const steps = r.transcript.map((t) => t.step);
  assert.ok(steps.includes('promotion_queued'), 'the win was queued');
  assert.ok(steps.includes('promotion_rejected_after_review'), 'the sludge was recorded — not banked');
  assert.ok(!r.transcript.some((t) => t.step === 'stone_banked'), 'no stone banked on a sludge');
});

test('no inbox approval at all → the measured win stays queued, never auto-banked (Step 2 posture holds)', () => {
  const { engine } = freshEngine();
  const r = runSupervisedCampaign(engine, {
    runId: 'nq', task: 'improve the loop',
    targets: [improveTarget()]
  }, { worker: winWorker, maxBatches: 10 });
  assert.equal(r.stones.length, 0, 'without operator approval nothing banks — auto-promotion stays closed');
  assert.ok(r.transcript.some((t) => t.step === 'promotion_queued'));
  assert.ok(!r.transcript.some((t) => t.step === 'stone_banked'));
});
