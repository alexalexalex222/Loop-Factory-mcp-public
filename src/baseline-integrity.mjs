// Pure baseline-integrity check shared by the engine and the strict real-test
// supervisor. A candidate does not count as a finding if its proposed baseline
// could not become the hash-locked bar for an improvement run.
import { BLOCK } from './constants.mjs';
import { estimateTokens } from './measure.mjs';

const BASELINE_PLACEHOLDER_RE = /\b(PLACEHOLDER|TODO|scaffold to be|not yet authored)\b/i;
const HYPOTHESIS_PLACEHOLDER_RE = /^(?:h\d*|b|o|x|tbd|todo|placeholder|test|fix|improve|change)$/i;
const HYPOTHESIS_FIELDS = Object.freeze({
  title: 8,
  bottleneck: 12,
  operation: 12,
  expectedMovement: 8,
  falsifier: 8
});

function normalizedHypothesis(hypothesis = {}) {
  return Object.keys(HYPOTHESIS_FIELDS)
    .map((field) => String(hypothesis[field] || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

export function checkHypothesisIntegrity(hypothesis, siblings = []) {
  const h = hypothesis && typeof hypothesis === 'object' ? hypothesis : {};
  for (const [field, minChars] of Object.entries(HYPOTHESIS_FIELDS)) {
    const value = String(h[field] || '').trim();
    if (!value || HYPOTHESIS_PLACEHOLDER_RE.test(value) || value.length < minChars) {
      return {
        ok: false,
        code: BLOCK.HYPOTHESIS_TOO_SHALLOW,
        reason: `Strict hypothesis ${field} must be specific and non-placeholder-shaped (minimum ${minChars} characters; received "${value || '<missing>'}").`,
        evidence: { field, value, minChars }
      };
    }
  }
  const normalized = normalizedHypothesis(h);
  if ((siblings || []).some((other) => other !== hypothesis && normalizedHypothesis(other) === normalized)) {
    return {
      ok: false,
      code: BLOCK.HYPOTHESIS_TOO_SHALLOW,
      reason: 'The two strict hypotheses are identical after normalization; each finding needs two distinct attempted operations.',
      evidence: { duplicate: true }
    };
  }
  return { ok: true, evidence: { normalized } };
}

export function checkBaselineIntegrity(content) {
  const text = String(content == null ? '' : content);
  const marker = text.match(BASELINE_PLACEHOLDER_RE);
  if (marker) {
    return {
      ok: false,
      code: BLOCK.BASELINE_PLACEHOLDER,
      reason: `Baseline content reads as a placeholder ("${marker[0]}"). The baseline is the reference a challenger must beat - record the real loop/artifact bytes, not a stub.`,
      evidence: { marker: marker[0] }
    };
  }
  const tokenEstimate = estimateTokens(text);
  if (tokenEstimate < 200) {
    return {
      ok: false,
      code: BLOCK.BASELINE_TOO_SHALLOW,
      reason: `Baseline is too thin to be a real bar (~${tokenEstimate} tokens; a real baseline carries real content).`,
      evidence: { tokenEstimate, minTokens: 200 }
    };
  }
  const headers = (text.match(/^#{2,3}\s+\S/gm) || []).length;
  const codeBlocks = (text.match(/```[\s\S]*?```/g) || []).filter((block) => block.replace(/`/g, '').trim().length > 0).length;
  if (headers < 3 && codeBlocks < 3) {
    return {
      ok: false,
      code: BLOCK.BASELINE_TOO_SHALLOW,
      reason: `Baseline lacks the structure of a real reference (found ${headers} markdown header(s) and ${codeBlocks} non-empty code block(s); need at least 3 of either).`,
      evidence: { headers, codeBlocks }
    };
  }
  return { ok: true, evidence: { tokenEstimate, headers, codeBlocks } };
}
