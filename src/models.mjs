// Frontier-route policy. The spec is blunt: under the default banlist, full tests
// run on frontier models (e.g. claude-opus-4-8, gpt-5.5, glm-5.2). Cheap/old routes
// are rejected so a campaign can never quietly downgrade itself to look "done".
// Operator-chosen modelPolicy (persisted at init) is the single source of truth;
// module-level DEFAULT_* constants feed banlist mode "default" for backward compat.
import {
  DEFAULT_PRIMARY_MODEL, KNOWN_FRONTIER_EXAMPLES, BUILDER_GATING_ROUTES
} from './constants.mjs';

// Builds and in-loop gating route ONLY to trusted builder/gating workers under the
// default policy (Opus 4.8 / GLM 5.2). Codex/GPT stays a supported HOST surface but
// is NOT a trusted in-loop builder/gating worker. This is intentionally separate
// from the frontier banlist: gpt-5.5 is a valid frontier TEST worker by default,
// but not a builder/gating worker here.
export const DEFAULT_BUILDER_ROUTE_PATTERNS = [
  /claude[-_ ]?opus[-_ ]?4/i, /\bopus[-_ ]?4/i, /glm[-_ ]?5\.[2-9]/i, /glm[-_ ]?[6-9]/i
];
// Alias kept for any external readers of the pre-redesign name.
const BUILDER_ROUTE_PATTERNS = DEFAULT_BUILDER_ROUTE_PATTERNS;

// Hard banlist defaults — if any pattern matches the route string under mode
// "default" or "strict", it is rejected outright. These catch the small/cheap/
// distilled/prior-gen tiers. Note `gpt-5.5-mini` matches via the `mini` rule even
// though `5.5` looks current.
export const DEFAULT_BANNED_ROUTE_PATTERNS = [
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
/** @deprecated Prefer DEFAULT_BANNED_ROUTE_PATTERNS — same array, kept for import stability. */
export const BANNED_ROUTE_PATTERNS = DEFAULT_BANNED_ROUTE_PATTERNS;

// Advisory allowlist — routes that look like current frontier. Not matching this
// does NOT reject under mode "default" (SOTA moves; the agent is told to web-search).
// Under mode "strict", frontierConfidence:unknown is rejected.
export const DEFAULT_FRONTIER_HINT_PATTERNS = [
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
/** @deprecated Prefer DEFAULT_FRONTIER_HINT_PATTERNS. */
export const FRONTIER_HINT_PATTERNS = DEFAULT_FRONTIER_HINT_PATTERNS;

const BANLIST_MODES = new Set(['default', 'strict', 'off']);
export const MODEL_POLICY_PRESETS = Object.freeze({
  GPT56_SOL: 'gpt-5.6-sol',
  GPT56: 'gpt-5.6-sol'
});

function normalizePolicySource(source) {
  const s = String(source || '').trim();
  if (s === 'operator-init' || s === 'defaults' || /^preset:[a-z0-9._+-]+$/i.test(s)) return s;
  return 'defaults';
}

/**
 * Default model policy — exactly today's historical behavior when the operator
 * presses enter / says "defaults" / uses the "just go" fast-path.
 */
export function defaultModelPolicy(source = 'defaults') {
  return {
    version: 1,
    source: normalizePolicySource(source),
    primary: DEFAULT_PRIMARY_MODEL,
    testRoutes: [DEFAULT_PRIMARY_MODEL, 'gpt-5.5', 'glm-5.2'],
    builderRoutes: [...BUILDER_GATING_ROUTES],
    judgeRoute: DEFAULT_PRIMARY_MODEL,
    banlist: { mode: 'default', extraDeny: [], extraAllow: [] },
    allowUnknownFrontier: true
  };
}

function normalizeStringList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
}

function normalizeBanlist(banlist) {
  const b = banlist && typeof banlist === 'object' ? banlist : {};
  const mode = BANLIST_MODES.has(b.mode) ? b.mode : 'default';
  return {
    mode,
    extraDeny: normalizeStringList(b.extraDeny),
    extraAllow: normalizeStringList(b.extraAllow)
  };
}

/**
 * Normalize / merge a partial or full modelPolicy with defaults.
 * Invalid fields fall back to defaults (never throw — init must stay friendly).
 * @param {object|null|undefined} input
 * @param {{ source?: string }} [opts]
 */
export function normalizeModelPolicy(input, opts = {}) {
  const base = defaultModelPolicy(opts.source || (input && input.source) || 'defaults');
  if (!input || typeof input !== 'object') return base;
  const primary = typeof input.primary === 'string' && input.primary.trim()
    ? input.primary.trim()
    : base.primary;
  const testRoutes = normalizeStringList(input.testRoutes);
  const builderRoutes = normalizeStringList(input.builderRoutes);
  const judgeRoute = typeof input.judgeRoute === 'string' && input.judgeRoute.trim()
    ? input.judgeRoute.trim()
    : (builderRoutes[0] || primary || base.judgeRoute);
  const banlist = normalizeBanlist(input.banlist);
  const source = normalizePolicySource(opts.source || input.source || base.source);
  return {
    version: 1,
    source,
    primary,
    testRoutes: testRoutes.length ? testRoutes : base.testRoutes,
    builderRoutes: builderRoutes.length ? builderRoutes : base.builderRoutes,
    judgeRoute,
    banlist,
    allowUnknownFrontier: input.allowUnknownFrontier === false ? false : true
  };
}

/**
 * Named policy presets are explicit operator conveniences. They never widen the
 * builder/judge trust boundary unless the preset says so.
 */
export function modelPolicyPreset(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!['gpt-5.6-sol', 'gpt56-sol', 'gpt-5.6', 'gpt56', 'build-week-gpt-5.6', 'build-week'].includes(key)) return null;
  return normalizeModelPolicy({
    source: 'preset:gpt-5.6-sol',
    primary: 'gpt-5.6-sol',
    testRoutes: ['gpt-5.6-sol', DEFAULT_PRIMARY_MODEL, 'glm-5.2'],
    builderRoutes: [...BUILDER_GATING_ROUTES],
    judgeRoute: DEFAULT_PRIMARY_MODEL,
    banlist: { mode: 'default', extraDeny: [], extraAllow: [] },
    allowUnknownFrontier: true
  }, { source: 'preset:gpt-5.6-sol' });
}

/**
 * Backfill a loaded run state that predates modelPolicy (resume safety).
 * Mutates state.config in place; returns the active policy.
 */
export function ensureModelPolicy(state) {
  if (!state || !state.config) return defaultModelPolicy();
  if (state.config.modelPolicy && state.config.modelPolicy.version === 1) {
    state.config.modelPolicy = normalizeModelPolicy(state.config.modelPolicy, {
      source: state.config.modelPolicy.source
    });
    return state.config.modelPolicy;
  }
  const primary = (state.config.model && state.config.model.primary) || DEFAULT_PRIMARY_MODEL;
  state.config.modelPolicy = normalizeModelPolicy({
    primary,
    source: (state.config.model && state.config.model.declared) ? 'operator-init' : 'defaults'
  });
  return state.config.modelPolicy;
}

function routeKey(s) {
  return String(s || '').trim().toLowerCase();
}

function listHasRoute(list, model) {
  const key = routeKey(model);
  return (list || []).some((x) => routeKey(x) === key);
}

function compileExtraPatterns(strings) {
  return (strings || []).map((s) => {
    const t = String(s).trim();
    if (!t) return null;
    // Literal substring match (case-insensitive), escaped.
    try {
      return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Classify a single route string under an optional modelPolicy.
 * When policy is omitted, uses defaultModelPolicy() (today's historical behavior).
 * @returns {{ ok: boolean, model: string, reason?: string, frontierConfidence: 'known'|'unknown', matchedPattern?: string }}
 */
export function classifyRoute(model, policy) {
  const pol = policy ? normalizeModelPolicy(policy) : defaultModelPolicy();
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) {
    return { ok: false, model: m, reason: 'empty route — name the frontier model', frontierConfidence: 'unknown' };
  }

  // extraAllow punches holes in the banlist (cost experiments, etc.).
  if (listHasRoute(pol.banlist.extraAllow, m)) {
    const knownAllow = DEFAULT_FRONTIER_HINT_PATTERNS.some((re) => re.test(m));
    return { ok: true, model: m, frontierConfidence: knownAllow ? 'known' : 'unknown' };
  }

  // extraDeny always applies (even under mode "off").
  const extraDenyHit = compileExtraPatterns(pol.banlist.extraDeny).find((re) => re.test(m));
  if (extraDenyHit) {
    return {
      ok: false,
      model: m,
      reason: `route rejected by operator extraDeny (matched ${extraDenyHit}); remove it from banlist.extraDeny or pick another route`,
      frontierConfidence: 'unknown',
      matchedPattern: String(extraDenyHit)
    };
  }

  const mode = pol.banlist.mode || 'default';
  if (mode === 'off') {
    // Banlist off: only empty routes (and extraDeny above) are rejected.
    const knownOff = DEFAULT_FRONTIER_HINT_PATTERNS.some((re) => re.test(m));
    return { ok: true, model: m, frontierConfidence: knownOff ? 'known' : 'unknown' };
  }

  const banned = DEFAULT_BANNED_ROUTE_PATTERNS.find((re) => re.test(m));
  if (banned) {
    return {
      ok: false,
      model: m,
      reason: `non-frontier route rejected (matched ${banned}); use a frontier model such as ${KNOWN_FRONTIER_EXAMPLES.join(', ')} (or set banlist mode "off" / extraAllow for this run)`,
      frontierConfidence: 'unknown',
      matchedPattern: String(banned)
    };
  }

  const known = DEFAULT_FRONTIER_HINT_PATTERNS.some((re) => re.test(m));
  const frontierConfidence = known ? 'known' : 'unknown';
  // mode "strict" = default banlist + reject frontierConfidence:unknown.
  // Under mode "default", allowUnknownFrontier:false also rejects unknown.
  if (frontierConfidence === 'unknown') {
    if (mode === 'strict') {
      return {
        ok: false,
        model: m,
        reason: `strict banlist rejects frontierConfidence:unknown ("${m}"); use a known frontier route such as ${KNOWN_FRONTIER_EXAMPLES.join(', ')} or switch banlist mode`,
        frontierConfidence: 'unknown'
      };
    }
    if (pol.allowUnknownFrontier === false) {
      return {
        ok: false,
        model: m,
        reason: `allowUnknownFrontier is false — "${m}" is not a known frontier route; use one of ${KNOWN_FRONTIER_EXAMPLES.join(', ')} or set allowUnknownFrontier:true`,
        frontierConfidence: 'unknown'
      };
    }
  }
  return { ok: true, model: m, frontierConfidence };
}

/** Convenience boolean used by the engine's hard gates. */
export function isFrontierRoute(model, policy) {
  return classifyRoute(model, policy).ok;
}

/**
 * Validate every route in a list under policy; returns offenders (empty == all clean).
 * @param {string[]} models
 * @param {object} [policy]
 */
export function rejectedRoutes(models, policy) {
  return (models || [])
    .map((m) => classifyRoute(m, policy))
    .filter((c) => !c.ok)
    .map((c) => ({ model: c.model, reason: c.reason, matchedPattern: c.matchedPattern }));
}

/**
 * Is this route allowed to perform a build or in-loop gating step under policy?
 * Family mapping / builder patterns are separate from the frontier banlist: a route
 * must clear classifyRoute (under policy) AND match a builder pattern or be listed
 * in policy.builderRoutes.
 */
export function isBuilderGatingRoute(model, policy) {
  const pol = policy ? normalizeModelPolicy(policy) : defaultModelPolicy();
  const m = typeof model === 'string' ? model.trim() : '';
  if (!classifyRoute(m, pol).ok) return false;
  if (DEFAULT_BUILDER_ROUTE_PATTERNS.some((re) => re.test(m))) return true;
  return listHasRoute(pol.builderRoutes, m);
}

/** Offenders among routes asked to build / gate in-loop (empty == all allowed). */
export function rejectedBuilderRoutes(models, policy) {
  const pol = policy ? normalizeModelPolicy(policy) : defaultModelPolicy();
  const allowed = (pol.builderRoutes && pol.builderRoutes.length)
    ? pol.builderRoutes.join(' or ')
    : BUILDER_GATING_ROUTES.join(' or ');
  return (models || [])
    .filter((m) => !isBuilderGatingRoute(m, pol))
    .map((m) => ({
      model: m,
      reason: `not a trusted builder/gating route — builds and in-loop gating route to ${allowed} (Codex/GPT stays a host surface, not an in-loop builder unless listed in modelPolicy.builderRoutes)`
    }));
}

/**
 * Factory that binds a policy into closed-over classifiers (handy for tests).
 * @param {object} modelPolicy
 */
export function makePolicy(modelPolicy) {
  const pol = normalizeModelPolicy(modelPolicy);
  return {
    policy: pol,
    classifyRoute: (model) => classifyRoute(model, pol),
    isFrontierRoute: (model) => isFrontierRoute(model, pol),
    rejectedRoutes: (models) => rejectedRoutes(models, pol),
    isBuilderGatingRoute: (model) => isBuilderGatingRoute(model, pol),
    rejectedBuilderRoutes: (models) => rejectedBuilderRoutes(models, pol)
  };
}

/**
 * Parse free-form operator model-choice text into a partial modelPolicy.
 * Friendly: "defaults" / empty → defaults; "any model" → banlist off;
 * otherwise try to pull a primary (+ optional lists).
 * @param {string} text
 * @returns {{ policy: object, source: string, notes: string[] }}
 */
export function parseModelChoiceText(text) {
  const raw = String(text == null ? '' : text).trim();
  const notes = [];
  if (!raw || /^(defaults?|default|enter|standard|same|yes|ok|sure|fine|just defaults?)$/i.test(raw)) {
    return { policy: defaultModelPolicy('defaults'), source: 'defaults', notes };
  }
  const lower = raw.toLowerCase();
  if (/\b(?:gpt[-_ ]?5\.6(?:[-_ ]?sol)?|gpt56[-_ ]?sol)\b.*\bpreset\b|\bpreset\b.*\b(?:gpt[-_ ]?5\.6(?:[-_ ]?sol)?|gpt56[-_ ]?sol)\b|\bbuild[-_ ]?week\b/i.test(lower)) {
    const policy = modelPolicyPreset('gpt-5.6-sol');
    notes.push('gpt-5.6-sol preset selected: GPT-5.6 Sol primary/test worker; trusted builder and judge defaults preserved');
    return { policy, source: policy.source, notes };
  }
  if (/\bany models?\b|\bno ban(?:list)?\b|\bbanlist\s*off\b|\bdisable (?:the )?banlist\b|\ball models?\b/.test(lower)) {
    const pol = defaultModelPolicy('operator-init');
    pol.banlist.mode = 'off';
    // Optional primary after "any model": "any model, primary haiku"
    const primaryMatch = raw.match(/\bprimary\s*[:=]?\s*([a-z0-9][a-z0-9._+\- ]{1,80})/i)
      || raw.match(/\buse\s+([a-z0-9][a-z0-9._+\-]{2,60})/i);
    if (primaryMatch) {
      pol.primary = primaryMatch[1].trim().replace(/[.,;]+$/, '');
      pol.judgeRoute = pol.primary;
    }
    notes.push('banlist mode set to "off" for this run (any model)');
    return { policy: pol, source: 'operator-init', notes };
  }

  const pol = defaultModelPolicy('operator-init');
  // primary: foo  OR  primary worker: foo  OR  first bare model-looking token
  const primaryExplicit = raw.match(/\bprimary(?:\s+worker)?\s*[:=]\s*([a-z0-9][a-z0-9._+\- ]{1,80})/i);
  if (primaryExplicit) {
    pol.primary = primaryExplicit[1].trim().split(/[,\s;]/)[0];
  } else {
    // Bare model id as the whole answer or first token that looks like a model
    const bare = raw.match(/^(?:use\s+)?([a-z][a-z0-9]*(?:[-_.][a-z0-9]+){1,6})\s*$/i)
      || raw.match(/\b((?:claude|gpt|glm|gemini|grok|opus|sonnet|haiku|codex|minimax|deepseek|mimo)[-_a-z0-9.]{2,60})\b/i);
    if (bare) pol.primary = bare[1].trim();
  }

  const testMatch = raw.match(/\btest(?:\s+routes?)?\s*[:=]\s*([^\n;]+)/i);
  if (testMatch) {
    pol.testRoutes = testMatch[1].split(/[,|/]+/).map((s) => s.trim()).filter(Boolean);
  }
  const builderMatch = raw.match(/\bbuilder(?:\s+routes?)?\s*[:=]\s*([^\n;]+)/i);
  if (builderMatch) {
    pol.builderRoutes = builderMatch[1].split(/[,|/]+/).map((s) => s.trim()).filter(Boolean);
  }
  const judgeMatch = raw.match(/\bjudge(?:\s+route)?\s*[:=]\s*([a-z0-9][a-z0-9._+\- ]{1,80})/i);
  if (judgeMatch) pol.judgeRoute = judgeMatch[1].trim().split(/[,\s;]/)[0];
  else pol.judgeRoute = pol.primary;

  if (/\bstrict\b/i.test(raw)) {
    pol.banlist.mode = 'strict';
    notes.push('banlist mode set to "strict"');
  }

  return { policy: normalizeModelPolicy(pol, { source: 'operator-init' }), source: 'operator-init', notes };
}
