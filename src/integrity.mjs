// Integrity Gate v0 — pure guards. The supervisor's promotion/benchmark path calls
// these at exactly two chokepoints (benchmark creation/selection + promotion request)
// so marker-only reward hacking cannot promote. This module has NO I/O and NO state:
// it returns verdicts; the engine logs the SEALED reason to the ledger and returns only
// the COARSE worker-visible message.
//
// The hole this closes: measure.mjs scoreOracle() scores probe/mustInclude oracles by
// pure substring presence, so a candidate that just emits the marker tokens scores 1.0.
// These guards detect that without rewriting the scorer (which the whole measurement
// model depends on).
import { sha256, round } from './util.mjs';
import { isDeterministicOracle, scoreOracle } from './measure.mjs';

// Sealed reasons — written ONLY to the supervisor ledger (logEvent), NEVER returned to a
// worker. Worker-visible feedback for an anti-gaming hit is deliberately coarse.
export const SEALED = {
  NEGATIVE_CONTROL_PASSED: 'NEGATIVE_CONTROL_PASSED',
  ANSWER_KEY_ECHO_GUARD: 'ANSWER_KEY_ECHO_GUARD',
  ROUTE_SHA_COLLAPSE: 'ROUTE_SHA_COLLAPSE',
  EVIDENCE_BINDING_MISSING: 'EVIDENCE_BINDING_MISSING',
  // The LAW: reward the transferable solution, not answer-key recognition. The negative
  // control is its executable cop; this is the broader standard a promotion must clear.
  ANSWER_WITHOUT_SOLUTION: 'ANSWER_WITHOUT_SOLUTION',
  STONE_INELIGIBLE: 'STONE_INELIGIBLE',
  TARGET_SATURATED: 'TARGET_SATURATED_NEEDS_NEW_TARGET'
};

// Coarse worker-visible messages (no sealed detail: no scores, markers, or hashes).
export const WORKER_MSG = {
  NEGATIVE_CONTROL_PASSED: 'Rejected: benchmark does not discriminate bad evidence. Return to benchmark-hardening lane.',
  ANSWER_KEY_ECHO_GUARD: 'Rejected: output does not independently prove task improvement. Return to evidence-binding lane with artifact paths, hashes, commands, baseline/challenger comparison, and negative-control result.',
  ROUTE_SHA_COLLAPSE: 'Rejected: route independence not established. Return to route-replay lane with independently generated route outputs and evidence-bound comparisons.',
  EVIDENCE_BINDING_MISSING: 'Rejected: evidence binding incomplete. Return to evidence-binding lane.',
  ANSWER_WITHOUT_SOLUTION: 'Rejected: output does not demonstrate a transferable solution. Return to task-evidence lane with held-out case, negative control, and artifact-bound replay proof.',
  STONE_INELIGIBLE: 'Rejected: this artifact is receipt-maintenance, not a task-value improvement, and cannot be promoted as a Stone. Route to the next real target.'
};

// The lane a coarse rejection should send the worker back to (worker-visible — a lane
// name is not a sealed detail).
export const LANE = {
  NEGATIVE_CONTROL_PASSED: 'benchmark-hardening',
  ANSWER_KEY_ECHO_GUARD: 'evidence-binding',
  ROUTE_SHA_COLLAPSE: 'route-replay',
  EVIDENCE_BINDING_MISSING: 'evidence-binding',
  ANSWER_WITHOUT_SOLUTION: 'task-evidence',
  STONE_INELIGIBLE: 'next-real-target'
};

export const ARTIFACT_CLASS = {
  TASK_IMPROVEMENT: 'task_improvement',
  BENCHMARK_HARDENING: 'benchmark_hardening',
  RECEIPT_MAINTENANCE: 'receipt_maintenance',
  STATE_SYNC: 'state_sync',
  DASHBOARD_SYNC: 'dashboard_sync',
  QUARANTINE_EVIDENCE: 'quarantine_evidence',
  // A promotion that relied on a test_fixture waiver is plumbing, never a real artifact.
  TEST_FIXTURE: 'test_fixture',
  MEASUREMENT_PLUMBING: 'measurement_plumbing'
};

// ---- output classes (PATCH B exception + PATCH A/C triggers) -------------
// Output classes for which byte-identical route output is EXPECTANTED and so
// route-SHA collapse is exempt: a deterministic command/tool produces the same
// bytes across independent models. The exception is opt-in and explicit: an
// undeclared class never gets it for free.
export const OUTPUT_CLASS = {
  DETERMINISTIC_COMMAND: 'deterministic_command',
  DETERMINISTIC_TOOL_OUTPUT: 'deterministic_tool_output',
  PROSE: 'prose',
  RECEIPT: 'receipt',
  SUMMARY: 'summary',
  REVIEW: 'review',
  BENCHMARK_REPORT: 'benchmark_report',
  DASHBOARD_REPORT: 'dashboard_report',
  STATE_SYNC: 'state_sync',
  PROOF_MAINTENANCE: 'proof_maintenance'
};
// Identical route output is NOT independent evidence for these output classes.
// Route-SHA collapse defaults ON for them (PATCH B). Stored normalized.
export const RECEIPT_PROSE_CLASSES = new Set([
  OUTPUT_CLASS.PROSE, OUTPUT_CLASS.RECEIPT, OUTPUT_CLASS.SUMMARY, OUTPUT_CLASS.REVIEW,
  OUTPUT_CLASS.BENCHMARK_REPORT, OUTPUT_CLASS.DASHBOARD_REPORT, OUTPUT_CLASS.STATE_SYNC,
  OUTPUT_CLASS.PROOF_MAINTENANCE
]);
// Classes where byte-identical route output may be legitimate (explicit only).
export const DETERMINISTIC_CLASSES = new Set([OUTPUT_CLASS.DETERMINISTIC_COMMAND, OUTPUT_CLASS.DETERMINISTIC_TOOL_OUTPUT]);

// Back-compat alias: the v0 shipped a dash form ('deterministic-command'); honor it.
export function normalizeOutputClass(outputClass) {
  const v = String(outputClass == null ? '' : outputClass).trim().toLowerCase().replace(/[-\s]+/g, '_');
  return v || null;
}

// ---- PATCH A/C triggers --------------------------------------------------
// A benchmark oracle that scores by marker/probe/expected-token presence is an
// ANSWER-KEY-EXPOSED oracle: the worker can see the exact tokens that satisfy
// it. These are the oracles that can be gamed by emitting the markers, and so
// evidence-binding (PATCH A) and solution-pressure (PATCH C) default ON for them.
export function isMarkerOracle(oracle) {
  if (!oracle || typeof oracle !== 'object') return false;
  if (oracle.kind === 'probe' && Array.isArray(oracle.probes) && oracle.probes.length > 0) return true;
  if (Array.isArray(oracle.mustInclude) && oracle.mustInclude.length > 0) return true;
  if (Array.isArray(oracle.expectedMarkers) && oracle.expectedMarkers.length > 0) return true;
  // expected answer tokens / receipt-template labels visible to the worker
  if (Array.isArray(oracle.expectedTokens) && oracle.expectedTokens.length > 0) return true;
  return false;
}
// Answer visibility = the marker oracle is exposed (PATCH C trigger). Aliased
// for readability at the engine call site.
export const isAnswerVisible = isMarkerOracle;

// ---- PATCH B trigger -----------------------------------------------------
// Should route-SHA collapse default ON? Yes for receipt/prose/summary/review/
// report/sync outputs; YES by the safer default when a marker oracle carries no
// outputClass (the spec: treat as prose/receipt and enforce collapse). Only a
// declared deterministic class, a non-receipt task class, or a valid override
// turns the default off.
export function isReceiptProseOutput({ outputClass, name, role } = {}) {
  const norm = normalizeOutputClass(outputClass);
  if (norm) return RECEIPT_PROSE_CLASSES.has(norm); // explicit class wins
  // No class given: infer from the artifact role/name, then fall to the safer
  // default (true) so a marker/receipt benchmark cannot dodge collapse by silence.
  const hay = `${role || ''} ${name || ''}`;
  if (/receipt|summary|review|report|dashboard|parity|manifest|sync|ledger/i.test(hay)) return true;
  if (DETERMINISTIC_CLASSES.has(norm)) return false;
  return true; // safer default
}

// ---- override validation (the only opt-out; never silent) ----------------
// A guard may be skipped ONLY by an explicit, supervisor-visible override. It
// must name the guard, state a reason, and be approved by supervisor_policy. A
// scope of 'test_fixture_only' additionally marks the promotion non-Stone (it
// is plumbing, not real evidence). Malformed/missing overrides have NO effect.
export const OVERRIDE_SCOPE = { TEST_FIXTURE_ONLY: 'test_fixture_only' };
const APPROVED_BY = 'supervisor_policy';
export function validateIntegrityOverride(override, guard) {
  if (!override || typeof override !== 'object') return { valid: false };
  if (!guard || override.guard !== guard) return { valid: false };
  if (typeof override.reason !== 'string' || override.reason.trim().length < 1) return { valid: false };
  if (override.approvedBy !== APPROVED_BY) return { valid: false };
  // The ONLY valid integrity waiver is test_fixture_only plumbing, which forces the promotion
  // NON-Stone. A real (Stone-eligible) benchmark can NEVER waive an integrity guard — not echo,
  // not route-independence, not evidence-binding, not the LAW. Real edge cases use real
  // declarations instead: deterministic output → outputClass:'deterministic_command' /
  // 'deterministic_tool_output'; a marker/probe oracle → bind markers to evidence; prose/receipt
  // routes → genuinely independent route outputs. A non-fixture scope is INVALID → ignored, so
  // the guard still fires. This closes the real-Stone waiver backdoor.
  if (override.scope !== OVERRIDE_SCOPE.TEST_FIXTURE_ONLY) {
    return { valid: false, fixture: false, scope: override.scope || null, ignored: true, reason: 'non_fixture_scope_rejected' };
  }
  return { valid: true, fixture: true, scope: OVERRIDE_SCOPE.TEST_FIXTURE_ONLY };
}
// Find a valid override for `guard` in a benchmark def's integrityOverride list
// (accepts a single object or an array). Returns the validation result or {valid:false}.
export function findOverride(def, guard) {
  if (!def || !guard) return { valid: false };
  const raw = def.integrityOverride;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  for (const ov of list) {
    const v = validateIntegrityOverride(ov, guard);
    if (v.valid) return v;
  }
  return { valid: false };
}

// v0 tuning constants.
export const DEFAULT_PASS_MARK = 0.5;     // negative control scoring >= this "passes" → benchmark non-discriminating
export const MARKER_DOMINANCE = 0.6;      // >= this share of CHARS are oracle markers → answer-key echo
export const MIN_INDEPENDENT_CHARS = 40;  // with markers present, fewer than this many non-marker chars → echo

// ---- helpers -------------------------------------------------------------

/** The marker strings a deterministic oracle scores by (probe tokens or mustInclude). */
export function oracleMarkers(oracle) {
  if (!oracle || typeof oracle !== 'object') return [];
  if (oracle.kind === 'probe' && Array.isArray(oracle.probes)) return oracle.probes.map(String);
  if (Array.isArray(oracle.mustInclude)) return oracle.mustInclude.map(String);
  return [];
}

/**
 * Char-share of `content` occupied by oracle markers. CHAR-based on purpose: a
 * marker-only output is ~100% markers by char, while a real run-log (markers + prose
 * or padding) is a small fraction — token-share would false-positive on padded fixtures.
 */
export function markerCharShare(content, markers) {
  const text = String(content == null ? '' : content);
  const total = text.length;
  if (!total || !markers.length) return { share: 0, markerChars: 0, totalChars: total, independentChars: total, distinctPresent: 0 };
  let markerChars = 0; let distinctPresent = 0;
  for (const m of markers) {
    if (!m) continue;
    let idx = text.indexOf(m); let count = 0;
    while (idx !== -1) { count++; idx = text.indexOf(m, idx + m.length); }
    if (count > 0) { distinctPresent++; markerChars += count * m.length; }
  }
  markerChars = Math.min(markerChars, total);
  return { share: round(markerChars / total), markerChars, totalChars: total, independentChars: Math.max(0, total - markerChars), distinctPresent };
}

// ---- req 2: answer-key echo guard ---------------------------------------

/** Marker-dominant output, or output with no independent evidence text beyond the marker list. */
export function answerKeyEchoGuard(content, oracle) {
  const markers = oracleMarkers(oracle);
  const m = markerCharShare(content, markers);
  const present = m.distinctPresent > 0;
  const dominant = m.share >= MARKER_DOMINANCE;
  const noIndependent = present && m.independentChars < MIN_INDEPENDENT_CHARS;
  const echo = present && (dominant || noIndependent);
  return { echo, ...m, reason: echo ? (dominant ? 'marker-dominant' : 'no-independent-evidence') : null };
}

// ---- req 1 extra: padded marker fake (PATCH D) ---------------------------
// The char-share echo guard (above) flags marker-dominant output. A worker can
// try to dilute char-share below MARKER_DOMINANCE by padding with generic
// filler (repeated dots, lorem ipsum, 'x' runs) — markers present but a small
// char fraction. This secondary detector catches that: marker tokens are
// present AND the non-marker text is low-information (dominated by filler /
// very low character entropy). It AUGMENTS the main defense; evidence-binding
// (req 4) + solution-pressure (the law) are what actually carry the proof.
//
// Filler heuristic: strip markers, then measure the share of the remaining
// text that is repeated filler (single-char runs, whitespace, 'lorem/ipsum',
// 'x'/'.'/'-' walls). Above PADDED_FILLER_SHARE with markers present → padded
// echo. We also floor on independent text length so a real run-log (markers +
// genuine prose) is never flagged.
export const PADDED_FILLER_SHARE = 0.6;   // >= this of non-marker chars is filler → low-information
export const PADDED_MIN_INDEPENDENT = 40; // need at least this many non-marker chars before trusting a filler verdict

export function paddedMarkerEchoGuard(content, oracle) {
  const markers = oracleMarkers(oracle);
  const m = markerCharShare(content, markers);
  if (!m.distinctPresent || m.distinctPresent < 1) return { padded: false, reason: null, ...m };
  // Measurement fixtures pad with dots → very low marker char-share. The dilution-attack
  // band is share below MARKER_DOMINANCE but not trivially low; skip padded detection there.
  if (m.share < MARKER_DOMINANCE * 0.25) return { padded: false, reason: null, ...m };
  const text = String(content == null ? '' : content);
  // erase markers to inspect only the independent text
  let indep = text;
  for (const mk of markers) { if (!mk) continue; indep = indep.split(mk).join(''); }
  if (indep.length < PADDED_MIN_INDEPENDENT) {
    // very little independent text at all → already caught by the no-independent
    // branch of answerKeyEchoGuard; not additionally padded.
    return { padded: false, reason: null, ...m };
  }
  // filler = runs of a single repeated char (length>=4), generic lorem walls,
  // or whitespace-only spans. Count filler chars.
  let filler = 0;
  const fillerMatches = indep.match(/(.)\1{3,}|lorem|ipsum|[\s_.\-x]{4,}/gi) || [];
  for (const f of fillerMatches) filler += f.length;
  const fillerShare = indep.length > 0 ? filler / indep.length : 0;
  const padded = fillerShare >= PADDED_FILLER_SHARE;
  return { padded, fillerShare, fillerChars: filler, independentChars: m.independentChars, reason: padded ? 'markers-present-over-low-information-filler' : null };
}

// ---- req 1: benchmark negative-control precondition ----------------------

/** Build the STANDARD failing fake used when a deterministic benchmark supplies none. */
export function standardNegativeControl() {
  return 'NEGATIVE-CONTROL: irrelevant placeholder with no task evidence and no oracle markers. lorem ipsum dolor sit amet consectetur.';
}

/**
 * Score a frozen negative control with the SAME benchmark oracle. It "passes" — which
 * is BAD, the benchmark cannot fail a fake — when its oracle score reaches passMark.
 */
export function negativeControlVerdict(content, oracle, passMark = DEFAULT_PASS_MARK) {
  const text = String(content == null ? '' : content);
  const score = isDeterministicOracle(oracle) ? scoreOracle(text, oracle) : null;
  const passed = score != null && score >= passMark;
  return { score, passMark, passed, sha256: sha256(text), chars: text.length };
}

// ---- req 3: route-SHA collapse guard ------------------------------------

/**
 * Route independence for multi-route tests. Identical route outputs collapse to one
 * independent route; if independent routes fall below the required count, fail.
 * Deterministic command output (exact identical output expected) is exempt.
 * @param {Array<{route?:string, sha256?:string, content?:string}>} routeOutputs
 */
export function routeShaCollapse(routeOutputs, { requiredRoutes, deterministicCommand = false } = {}) {
  const outs = Array.isArray(routeOutputs) ? routeOutputs : [];
  const shas = outs.map((r) => r.sha256 || sha256(String(r && r.content == null ? '' : r.content)));
  const independentRoutes = new Set(shas).size;
  const required = Number.isFinite(requiredRoutes) ? requiredRoutes : outs.length;
  if (deterministicCommand) return { collapsed: false, independentRoutes, requiredRoutes: required, exempt: true };
  return { collapsed: independentRoutes < required, independentRoutes, requiredRoutes: required, exempt: false };
}

// ---- req 4: evidence-binding guard --------------------------------------

/**
 * Each present marker must bind to >=1 independent evidence object (artifact path, SHA,
 * command/result, baseline/challenger comparison, or source locator). Marker presence
 * alone is never evidence.
 * @param {string[]} presentMarkers
 * @param {Array<{marker:string, artifactPath?:string, sha256?:string, command?:string, result?:string, comparison?:string, source?:string}>} bindings
 */
export function evidenceBindingCheck(presentMarkers, bindings) {
  const bound = new Set();
  for (const b of (bindings || [])) {
    if (!b || !b.marker) continue;
    const hasEvidence = !!(b.artifactPath || b.sha256 || b.command || b.result || b.comparison || b.source);
    if (hasEvidence) bound.add(String(b.marker));
  }
  const unbound = (presentMarkers || []).map(String).filter((m) => !bound.has(m));
  return { ok: unbound.length === 0, unbound, boundCount: bound.size, requiredCount: (presentMarkers || []).length };
}

// ---- solution-not-answer guard (the LAW) --------------------------------

// Recognized solution-pressure checks. A candidate proves a transferable METHOD, not
// answer-key recognition, when at least one of these holds. Route-independence is NOT here
// on purpose: identical-vs-distinct route outputs is a reproducibility property (its own
// guard, req 3), not proof the method transfers to a changed/hidden case.
export const SOLUTION_PRESSURE = ['negativeControl', 'heldOut', 'metamorphic', 'perturbation', 'evidenceBinding', 'freshReplay'];

/**
 * Reward the solution, not the answer. When the oracle exposes its answer key
 * (deterministic marker/probe rubric the worker can see), a promotion must clear at
 * least one solution-pressure check — otherwise a candidate could win by emitting the
 * expected markers/schema without solving the underlying task.
 *
 * The verified failing negative control is the minimum cop. `strict` (the benchmark's
 * requireSolutionPressure flag) escalates: an auto/empty negative control no longer
 * counts, so a STRONGER check is required (held-out transfer case, metamorphic,
 * perturbation, evidence-binding, route-independence, or fresh-context replay).
 *
 * @returns {{ ok:boolean, satisfiedBy:string[]|string, reason:string|null }}
 */
export function solutionPressureCheck(ctx = {}) {
  if (!ctx.answerVisible) return { ok: true, satisfiedBy: 'oracle-not-answer-visible', reason: null };
  // A transfer/solution check that was ATTEMPTED and FAILED is disqualifying negative evidence:
  // the method demonstrably does not transfer. It cannot be rescued by another check passing.
  // (R4 is exactly this case: answers + binds its markers, but its held-out boundary transfer
  // fails → ANSWER_WITHOUT_SOLUTION, no matter that evidence-binding passed.)
  const ho = ctx.heldOut;
  const heldOutAttempted = !!(ho && ho.score != null && Number.isFinite(ho.floor));
  const heldOutFailed = heldOutAttempted && (ho.score < ho.floor || ho.echo);
  if (heldOutFailed) {
    return { ok: false, satisfiedBy: [], reason: ho.echo
      ? 'held-out transfer case was answered with the marker echo, not a transferable solution'
      : 'held-out transfer case failed: the method does not transfer to a changed/hidden case' };
  }
  const mm = ctx.metamorphic, pr = ctx.perturbation, fr = ctx.freshReplay;
  const transferFailed = (mm && mm.attempted && !mm.holds) || (pr && pr.attempted && !pr.stable) || (fr && fr.attempted && !fr.reproduced);
  if (transferFailed) {
    return { ok: false, satisfiedBy: [], reason: 'a solution-pressure check was attempted and failed: the method does not demonstrate a transferable solution' };
  }
  const satisfied = [];
  const nc = ctx.negativeControl;
  if (nc && nc.passed === false && (!ctx.strict || nc.source === 'author')) satisfied.push('negativeControl');
  if (ctx.evidenceBindingPassed) satisfied.push('evidenceBinding');
  if (heldOutAttempted && ho.score >= (Number.isFinite(ho.floor) ? ho.floor : DEFAULT_PASS_MARK) && !ho.echo) satisfied.push('heldOut');
  if (mm && mm.holds) satisfied.push('metamorphic');
  if (pr && pr.stable) satisfied.push('perturbation');
  if (fr && fr.reproduced) satisfied.push('freshReplay');
  return {
    ok: satisfied.length > 0,
    satisfiedBy: satisfied,
    reason: satisfied.length ? null : (ctx.strict
      ? 'answer-visible benchmark requires a non-trivial solution-pressure check (held-out / metamorphic / perturbation / evidence-binding / route-independence / replay)'
      : 'answer-visible benchmark carries no solution-pressure check')
  };
}

// ---- req 5: stone eligibility -------------------------------------------

const RECEIPT_NAME_RE = /receipt|dashboard|report|manifest|parity|marker[-_ ]?ledger|ledger[-_ ]?sync|formal[-_ ]?sync|state[-_ ]?sync|sync[-_ ]?receipt/i;
const HARDENING_NAME_RE = /benchmark[-_ ]?hardening|negative[-_ ]?control|trap|answer[-_ ]?key|integrity[-_ ]?gate/i;
const RECEIPT_LIKE = new Set([ARTIFACT_CLASS.RECEIPT_MAINTENANCE, ARTIFACT_CLASS.STATE_SYNC, ARTIFACT_CLASS.DASHBOARD_SYNC]);

/**
 * Classify an artifact and decide Stone eligibility. Receipt/dashboard/report/manifest/
 * parity/sync artifacts are NOT Stone-eligible unless they prove a real source-level
 * behavior change (or real task-output improvement). Explicit caller class wins.
 */
export function classifyArtifact({ role, name, content, artifactClass, provesBehaviorChange } = {}) {
  let cls = (artifactClass && Object.values(ARTIFACT_CLASS).includes(artifactClass)) ? artifactClass : null;
  if (!cls) {
    const hay = `${role || ''} ${name || ''}`;
    if (RECEIPT_NAME_RE.test(hay)) cls = ARTIFACT_CLASS.RECEIPT_MAINTENANCE;
    else if (HARDENING_NAME_RE.test(hay)) cls = ARTIFACT_CLASS.BENCHMARK_HARDENING;
    else cls = ARTIFACT_CLASS.TASK_IMPROVEMENT;
  }
  let stoneEligible; let eligibilityReason;
  if (cls === ARTIFACT_CLASS.TASK_IMPROVEMENT || cls === ARTIFACT_CLASS.BENCHMARK_HARDENING) {
    stoneEligible = true;
    eligibilityReason = `${cls}: can move the frontier (still subject to measured + reverified promotion).`;
  } else if (RECEIPT_LIKE.has(cls)) {
    stoneEligible = !!provesBehaviorChange;
    eligibilityReason = provesBehaviorChange
      ? `${cls}: flagged as proving a real source-level behavior change → eligible.`
      : `${cls}: proves no source-level behavior change → not Stone-eligible.`;
  } else {
    stoneEligible = false;
    eligibilityReason = `${cls}: forensic evidence, never Stone-eligible.`;
  }
  return { artifactClass: cls, stoneEligible, eligibilityReason, provesBehaviorChange: !!provesBehaviorChange };
}

// ---- req 6: objective-saturation routing --------------------------------

/**
 * When the real target is exhausted, receipt-only next work is maintenance, not loop
 * improvement: it may update ledger/dashboard/state but cannot promote as a Stone.
 */
export function classifyObjectiveWork({ artifactClass, targetSaturated = false, hasRealTarget = false } = {}) {
  const cls = classifyArtifact({ artifactClass }).artifactClass;
  const receiptOnly = RECEIPT_LIKE.has(cls);
  if (!receiptOnly) return { route: 'real_target', promotable: true, code: null, note: 'task-value work — eligible for measured promotion' };
  if (targetSaturated && !hasRealTarget) {
    return { route: 'receipt_maintenance', promotable: false, code: SEALED.TARGET_SATURATED, note: 'target saturated and next work is receipt-only → route/mine to a NEW real target; receipt work cannot count as loop improvement' };
  }
  return { route: 'receipt_maintenance', promotable: false, code: SEALED.STONE_INELIGIBLE, note: 'receipt-only work updates ledger/dashboard/state but cannot promote as a Stone' };
}
