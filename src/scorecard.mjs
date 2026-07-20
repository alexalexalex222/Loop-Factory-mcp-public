// Promotion math. The frontier rule is deliberately strict and tradeoff-aware:
// a winner either raises verified quality without an unacceptable cost regression,
// or lowers cost without losing quality — and may never drop below the benchmark
// quality floor. A pure quality/cost tradeoff with no pre-declared comparison rule
// is STAGED, not auto-promoted (we never manufacture a scalar winner).
import { BLOCK } from './constants.mjs';
import { TOOL_AUTHORITY } from './measure.mjs';
import { round } from './util.mjs';

/**
 * @param {{tokenCost:number, quality:number}} baseline  the frozen, tool-measured bar
 * @param {{tokenCost:number, quality:number, source:string, reverified:boolean}} challenger
 * @param {{minQualityGain:number, costRegressionTolerance:number, minCostSaving:number}} thr
 * @param {string|null} comparisonRule  e.g. 'pareto' (default) or 'quality-first' / 'cost-first'
 * @returns {{promote:boolean, kind:string, code:string, message:string, deltas:object}}
 */
export function evaluatePromotion(baseline, challenger, thr, comparisonRule = 'pareto') {
  const qualityGain = round(challenger.quality - baseline.quality);
  const costDelta = round(challenger.tokenCost - baseline.tokenCost);
  const costRegressionPct = baseline.tokenCost > 0 ? round(costDelta / baseline.tokenCost) : (costDelta > 0 ? Infinity : 0);
  const costSavingPct = baseline.tokenCost > 0 ? round(-costDelta / baseline.tokenCost) : 0;
  const deltas = { qualityGain, costDelta, costRegressionPct, costSavingPct };

  // Hard gates first — these are also enforced upstream, repeated here for safety.
  if (challenger.source !== 'tool') {
    return { promote: false, kind: 'rejected', code: BLOCK.MODEL_REPORTED,
      message: 'metrics are not tool-measured; model self-report never promotes', deltas };
  }
  if (!challenger.reverified) {
    return { promote: false, kind: 'rejected', code: BLOCK.NOT_REVERIFIED,
      message: 'winning evidence has not been deep-reverified', deltas };
  }
  // Quality floor: never promote something that scores below the benchmark baseline.
  if (challenger.quality < baseline.quality - 1e-9) {
    return { promote: false, kind: 'rejected', code: BLOCK.BELOW_FLOOR,
      message: `quality ${round(challenger.quality)} is below the benchmark baseline ${round(baseline.quality)}`, deltas };
  }

  const qualityImproves = qualityGain >= thr.minQualityGain;
  const costImproves = costSavingPct >= thr.minCostSaving;
  const qualityHeld = qualityGain >= -1e-9; // no regression
  const costAcceptable = costRegressionPct <= thr.costRegressionTolerance;

  // Pareto wins (the common case): one axis improves, the other does not regress past tolerance.
  if (qualityImproves && costAcceptable) {
    return { promote: true, kind: 'QUALITY_FRONTIER', code: 'PROMOTE',
      message: `quality +${qualityGain} with cost change ${costRegressionPct >= 0 ? '+' : ''}${costRegressionPct} (within tolerance)`, deltas };
  }
  if (costImproves && qualityHeld) {
    return { promote: true, kind: 'COST_FRONTIER', code: 'PROMOTE',
      message: `cost -${costSavingPct} with quality held (Δq ${qualityGain})`, deltas };
  }

  // Genuine tradeoff (quality up + cost up beyond tolerance, or cost down + quality down):
  // do not manufacture a scalar winner unless a comparison rule was pre-declared.
  const tradeoff = (qualityGain > 0 && !costAcceptable) || (costSavingPct > 0 && qualityGain < 0);
  if (tradeoff) {
    if (comparisonRule === 'quality-first' && qualityImproves) {
      return { promote: true, kind: 'QUALITY_FRONTIER(rule)', code: 'PROMOTE',
        message: `quality-first rule: quality +${qualityGain} accepted at cost +${costRegressionPct}`, deltas };
    }
    if (comparisonRule === 'cost-first' && costImproves) {
      return { promote: true, kind: 'COST_FRONTIER(rule)', code: 'PROMOTE',
        message: `cost-first rule: cost -${costSavingPct} accepted at quality ${qualityGain}`, deltas };
    }
    return { promote: false, kind: 'staged', code: BLOCK.STAGED_TRADEOFF,
      message: 'quality/cost trade off with no pre-declared rule — stage for operator judgment, do not auto-promote', deltas };
  }

  return { promote: false, kind: 'rejected', code: BLOCK.BELOW_THRESHOLD,
    message: `no frontier movement: Δquality ${qualityGain} (need ≥ ${thr.minQualityGain}) / cost saving ${costSavingPct} (need ≥ ${thr.minCostSaving})`, deltas };
}

function promotionDecisionForTest(test, baseline, thr, comparisonRule) {
  if (!baseline || !thr || !test?.agg) return { promote: false };
  return evaluatePromotion(
    baseline,
    {
      tokenCost: test.agg.tokenCost,
      quality: test.agg.quality,
      source: test.source,
      reverified: !!test.reverified
    },
    thr,
    comparisonRule
  );
}

function isPromotableTest(test, baseline, thr, comparisonRule) {
  const decision = promotionDecisionForTest(test, baseline, thr, comparisonRule);
  return decision.promote && !!test.reverified && test.qualityAuthority === TOOL_AUTHORITY;
}

export function selectBestMeasuredTest(tests, baseline, thr, comparisonRule = 'pareto') {
  return tests
    .filter((t) => t.agg && t.source === 'tool')
    .sort((a, b) => {
      const qualityDelta = Number(b.agg.quality) - Number(a.agg.quality);
      if (Math.abs(qualityDelta) > 1e-12) return qualityDelta;

      const aPromotable = isPromotableTest(a, baseline, thr, comparisonRule) ? 1 : 0;
      const bPromotable = isPromotableTest(b, baseline, thr, comparisonRule) ? 1 : 0;
      if (bPromotable !== aPromotable) return bPromotable - aPromotable;

      const aVerifiedTool = a.reverified && a.qualityAuthority === TOOL_AUTHORITY ? 1 : 0;
      const bVerifiedTool = b.reverified && b.qualityAuthority === TOOL_AUTHORITY ? 1 : 0;
      if (bVerifiedTool !== aVerifiedTool) return bVerifiedTool - aVerifiedTool;

      const costDelta = Number(a.agg.tokenCost) - Number(b.agg.tokenCost);
      if (Math.abs(costDelta) > 1e-12) return costDelta;

      return String(a.id || '').localeCompare(String(b.id || ''));
    })[0];
}

/**
 * Build the score matrix: one row per hypothesis with its best measured full test.
 * Unmeasured hypotheses are surfaced (measured:false) and are never promotable.
 */
export function buildScoreMatrix(state) {
  const baseline = state.benchmark && state.benchmark.baselineScore;
  return state.hypotheses.map((h) => {
    const tests = state.tests.filter((t) => t.hypothesisId === h.id);
    const best = selectBestMeasuredTest(tests, baseline, state.config?.promotion, state.config?.comparisonRule);
    if (!best) {
      return {
        hypothesisId: h.id, title: h.title, route: h.route, status: h.status,
        measured: false, tokenCost: null, artifactOutputTokenEstimate: null, cliReceiptTokenCost: null,
        quality: null, source: null, qualityAuthority: null, reverified: false,
        deltaQuality: null, deltaCostPct: null, verdict: 'NO_MEASUREMENT', promotable: false
      };
    }
    const deltaQuality = baseline ? round(best.agg.quality - baseline.quality) : null;
    const deltaCostPct = baseline && baseline.tokenCost > 0 ? round((best.agg.tokenCost - baseline.tokenCost) / baseline.tokenCost) : null;
    const qualityAuthority = best.qualityAuthority || 'caller-reported';
    const promotionDecision = promotionDecisionForTest(
      best,
      baseline,
      state.config?.promotion,
      state.config?.comparisonRule
    );
    return {
      hypothesisId: h.id, title: h.title, route: h.route, status: h.status,
      measured: true, tokenCost: round(best.agg.tokenCost), quality: round(best.agg.quality),
      artifactOutputTokenEstimate: round(best.agg.artifactOutputTokenEstimate ?? best.agg.tokenCost),
      cliReceiptTokenCost: Number.isFinite(best.agg.cliReceiptTokenCost)
        ? round(best.agg.cliReceiptTokenCost)
        : null,
      source: best.source, qualityAuthority, reverified: !!best.reverified,
      deltaQuality, deltaCostPct, verdict: best.verdict,
      // A win only auto-promotes when quality is tool-verifiable; subjective → dashboard.
      promotable: promotionDecision.promote === true && !!best.reverified && qualityAuthority === 'tool-computed'
    };
  });
}
