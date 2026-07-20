import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReviewDecisionBinding, reviewDecisionBinding } from '../src/review-decisions.mjs';

function promotionState() {
  return {
    runId: 'binding-run',
    config: {
      comparisonRule: 'pareto',
      promotion: { minQualityGain: 0.05, maxCostRegressionPct: 0.1 }
    },
    baseline: { sha256: 'a'.repeat(64), epoch: 1 },
    benchmark: {
      frozen: true,
      epoch: 1,
      frozenAt: '2026-07-20T00:00:00.000Z',
      def: { id: 'bench-1', cases: [{ id: 'case-1' }] },
      baselineScore: { quality: 0.7, tokenCost: 1000 },
      negativeControl: { passed: false, sha256: 'b'.repeat(64) }
    },
    hypotheses: [{ id: 'hyp-001', operation: 'tighten evidence gate' }],
    tests: [{
      id: 'test-001',
      hypothesisId: 'hyp-001',
      source: 'tool',
      reverified: true,
      agg: { quality: 0.82, tokenCost: 1000 }
    }],
    humanReviews: []
  };
}

test('review decision binding is deterministic and ignores unrelated state', () => {
  const state = promotionState();
  const review = {
    id: 'rev-001',
    ts: '2026-07-20T00:01:00.000Z',
    status: 'PENDING',
    title: 'promote hyp-001',
    kind: 'promotion',
    summary: 'measured frontier movement',
    hypothesisId: 'hyp-001',
    evidenceRef: 'test-001'
  };
  const first = reviewDecisionBinding(state, review);
  state.activity = [{ event: 'unrelated dashboard refresh' }];
  state.updatedAt = '2026-07-20T00:02:00.000Z';
  const second = reviewDecisionBinding(state, review);
  assert.equal(first, second);
  assert.equal(isReviewDecisionBinding(first), true);
});

test('review decision binding changes when promotion evidence or proposed loop bytes change', () => {
  const state = promotionState();
  const promotionReview = {
    id: 'rev-001',
    ts: '2026-07-20T00:01:00.000Z',
    status: 'PENDING',
    kind: 'promotion',
    hypothesisId: 'hyp-001',
    evidenceRef: 'test-001'
  };
  const promotionBefore = reviewDecisionBinding(state, promotionReview);
  state.tests[0].reverified = false;
  assert.notEqual(reviewDecisionBinding(state, promotionReview), promotionBefore);

  const loopReview = {
    id: 'rev-002',
    ts: '2026-07-20T00:01:00.000Z',
    status: 'PENDING',
    kind: 'loop-adoption',
    loopId: 'candidate-loop',
    loopContent: 'VERSION A'
  };
  const loopBefore = reviewDecisionBinding(state, loopReview);
  loopReview.loopContent = 'VERSION B';
  assert.notEqual(reviewDecisionBinding(state, loopReview), loopBefore);
});
