// Frontier-route policy. The spec is blunt: full tests run on the most frontier
// models (e.g. claude-opus-4-8, gpt-5.5, glm-5.2). Cheap/old routes are rejected
// so a campaign can never quietly downgrade itself to look "done".
import { KNOWN_FRONTIER_EXAMPLES, BUILDER_GATING_ROUTES } from './constants.mjs';

// Builds and in-loop gating route ONLY to trusted builder/gating workers
// (Opus 4.8 / GLM 5.2). Codex/GPT stays a supported HOST surface but is NOT a
// trusted in-loop builder/gating worker. This is intentionally separate from the
// frontier banlist: gpt-5.5 is a valid frontier TEST worker, but not a
// builder/gating worker here.
const BUILDER_ROUTE_PATTERNS = [/claude[-_ ]?opus[-_ ]?4/i, /\bopus[-_ ]?4/i, /glm[-_ ]?5\.[2-9]/i, /glm[-_ ]?[6-9]/i];

/** Is this route allowed to perform a build or in-loop gating step? */
export function isBuilderGatingRoute(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!classifyRoute(m).ok) return false;
  return BUILDER_ROUTE_PATTERNS.some((re) => re.test(m));
}

/** Offenders among routes asked to build / gate in-loop (empty == all allowed). */
export function rejectedBuilderRoutes(models) {
  return (models || [])
    .filter((m) => !isBuilderGatingRoute(m))
    .map((m) => ({ model: m, reason: `not a trusted builder/gating route — builds and in-loop gating route to ${BUILDER_GATING_ROUTES.join(' or ')} (Codex/GPT stays a host surface, not an in-loop builder)` }));
}

// Hard banlist — if any pattern matches the route string, it is rejected outright.
// These catch the small/cheap/distilled/prior-gen tiers. Note `gpt-5.5-mini`
// matches via the `mini` rule even though `5.5` looks current.
export const BANNED_ROUTE_PATTERNS = [
  /haiku/i,
  /(?:^|[-_ \/])mini\b/i,
  /\bmini\b/i,
  /nano/i,
  /\blite\b/i,
  /flash[-_ ]?lite/i,
  /\btiny\b/i,
  /\bsmall\b/i,
  /\bdistil/i,
  /\bembed/i,
  /gemma/i,
  /\bphi[-_ ]?\d/i,
  /\b(?:o1|o3|o4)[-_ ]?mini\b/i,
  /gpt[-_ ]?5\.[0-4]\b/i, // prior-gen GPT-5.x (5.0–5.4); 5.5+ is allowed
  /gpt[-_ ]?4/i, // any GPT-4.x is prior-gen for this campaign
  /gpt[-_ ]?3/i,
  /claude[-_ ]?3/i,
  /claude[-_ ]?2/i,
  /gemini[-_ ]?1/i,
  /-(?:0\.5|1|1\.5|2|3|4|7|8|9|13|14)b\b/i // explicit small parameter counts
];

// Advisory allowlist — routes that look like current frontier. Not matching this
// does NOT reject (SOTA moves; the agent is told to web-search). It only sets a
// confidence flag the dashboard/report can show.
export const FRONTIER_HINT_PATTERNS = [
  /claude[-_ ]?opus[-_ ]?4/i,
  /opus[-_ ]?4/i,
  /claude[-_ ]?sonnet[-_ ]?4/i,
  /sonnet[-_ ]?4/i,
  /claude[-_ ]?fable/i,
  /gpt[-_ ]?5\.[5-9]\b/i,
  /gpt[-_ ]?[6-9]/i,
  /glm[-_ ]?5\.[2-9]/i,
  /glm[-_ ]?[6-9]/i,
  /gemini[-_ ]?[23][-_ .]?(?:pro|ultra)?/i,
  /grok[-_ ]?[4-9]/i
];

/**
 * Classify a single route string.
 * @returns {{ ok: boolean, model: string, reason?: string, frontierConfidence: 'known'|'unknown' }}
 */
export function classifyRoute(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) {
    return { ok: false, model: m, reason: 'empty route — name the frontier model', frontierConfidence: 'unknown' };
  }
  const banned = BANNED_ROUTE_PATTERNS.find((re) => re.test(m));
  if (banned) {
    return {
      ok: false,
      model: m,
      reason: `non-frontier route rejected (matched ${banned}); use a frontier model such as ${KNOWN_FRONTIER_EXAMPLES.join(', ')}`,
      frontierConfidence: 'unknown'
    };
  }
  const known = FRONTIER_HINT_PATTERNS.some((re) => re.test(m));
  return { ok: true, model: m, frontierConfidence: known ? 'known' : 'unknown' };
}

/** Convenience boolean used by the engine's hard gates. */
export function isFrontierRoute(model) {
  return classifyRoute(model).ok;
}

/**
 * Validate every route in a list; returns the offenders (empty array == all clean).
 * @param {string[]} models
 */
export function rejectedRoutes(models) {
  return models
    .map((m) => classifyRoute(m))
    .filter((c) => !c.ok)
    .map((c) => ({ model: c.model, reason: c.reason }));
}
