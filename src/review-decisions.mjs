import { sha256 } from './util.mjs';

export const REVIEW_DECISION_BINDING_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function reviewRecord(review) {
  return {
    id: review?.id || null,
    ts: review?.ts || null,
    title: review?.title || null,
    kind: review?.kind || null,
    summary: review?.summary || null,
    hypothesisId: review?.hypothesisId || null,
    evidenceRef: review?.evidenceRef || null,
    loopId: review?.loopId || null,
    loopContent: typeof review?.loopContent === 'string' ? review.loopContent : null
  };
}

function promotionContext(state, review) {
  if (review?.kind !== 'promotion' || !review.hypothesisId) return null;
  const hypothesis = (state?.hypotheses || []).find((item) => item.id === review.hypothesisId) || null;
  const tests = (state?.tests || [])
    .filter((item) => item.hypothesisId === review.hypothesisId)
    .slice()
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  return {
    baseline: {
      sha256: state?.baseline?.sha256 || null,
      epoch: state?.baseline?.epoch || null
    },
    benchmark: {
      frozen: state?.benchmark?.frozen === true,
      epoch: state?.benchmark?.epoch || null,
      frozenAt: state?.benchmark?.frozenAt || null,
      def: state?.benchmark?.def || null,
      baselineScore: state?.benchmark?.baselineScore || null,
      negativeControl: state?.benchmark?.negativeControl || null
    },
    promotionPolicy: {
      comparisonRule: state?.config?.comparisonRule || null,
      promotion: state?.config?.promotion || null
    },
    hypothesis,
    tests
  };
}

export function reviewDecisionBinding(state, review) {
  const payload = canonicalize({
    schemaVersion: REVIEW_DECISION_BINDING_VERSION,
    runId: state?.runId || null,
    review: reviewRecord(review),
    promotionContext: promotionContext(state, review)
  });
  return sha256(JSON.stringify(payload));
}

export function isReviewDecisionBinding(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}
