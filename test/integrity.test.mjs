// Integrity Gate v0 proof. The thesis: reward the SOLUTION, not the answer. A candidate
// cannot promote by emitting the expected markers/schema/receipt; it must prove a method
// that survives a solution-pressure check. The negative control is the cop; the
// solution-not-answer guard is the law. Every anti-gaming rejection seals its SPECIFIC
// reason to the supervisor ledger and returns only a COARSE worker-visible message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshEngine, SPECIFIC_TASK, BASELINE_BODY, promoteWithApproval } from './helpers.mjs';
import { sha256 } from '../src/util.mjs';
import { DEFAULT_QUALITY_ORACLE, QUALITY_PROBES, buildMeasuredContent } from '../src/measure.mjs';
import { MANDATED_LOOPS } from '../src/constants.mjs';
import {
  SEALED, WORKER_MSG, ARTIFACT_CLASS, DETERMINISTIC_CLASSES, normalizeOutputClass,
  answerKeyEchoGuard, markerCharShare, negativeControlVerdict, standardNegativeControl,
  routeShaCollapse, evidenceBindingCheck, solutionPressureCheck, classifyArtifact, classifyObjectiveWork
} from '../src/integrity.mjs';

const H = (model, title) => ({ title: title || 'h', bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });
const ROUTES = ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'];

// Record a run-log artifact; tokenCost + (deterministic) quality are DERIVED from the bytes
// against the frozen benchmark oracle — exactly the production path.
function recordOut(engine, runId, name, content) {
  return engine.artifact_record({ runId, role: 'runlog', name, content, measure: true }).artifactId;
}
// Substantial prose carrying probe markers — low marker char-share, real independent text.
function richOutput(prose, probes) {
  return `${prose} ${prose} ${prose}\n${probes.join(' ')}\nverified against artifacts and re-run from clean context.`;
}
function lastSeal(store, runId) {
  const s = store.load(runId);
  return (s.integritySeals || [])[(s.integritySeals || []).length - 1];
}
// A worker-visible block must be COARSE: no sealed reason, scores, markers, or hashes.
function assertCoarse(r, sealed) {
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'INTEGRITY_GATE', 'worker sees one coarse code, never the sealed reason');
  assert.equal(r.message, WORKER_MSG[sealed], 'worker sees the coarse spec message');
  for (const leak of ['sealedReason', 'score', 'markerShare', 'ncSha256', 'unbound', 'detail']) {
    assert.ok(!(leak in r), `coarse return must not leak "${leak}"`);
  }
}

// Drive init → baseline lock → freeze benchmark → measured bar. Returns helpers.
function setupBench(engine, runId, { oracle, benchmark = {}, baselineContent, baselineBarContent }) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
  engine.artifact_record({ runId, role: 'baseline', content: baselineContent || BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId, benchmarks: [{
    name: 'bm', taskValueDimensions: ['task-value'], resourceDimensions: ['token-cost'], cases: [{ id: 'c1', input: 'fixture-A' }],
    oracle, ...benchmark
  }] });
  const sel = engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  return { prop, sel };
}
// A supervisor-visible TEST-FIXTURE override for a single guard. It lets a plumbing test
// exercise a specific gate mechanic (deterministic exception, Stone-eligibility, canonical-
// change flag) using synthetic buildMeasuredContent bytes WITHOUT fabricating a fake solution
// proof. The resulting promotion is stamped fixtureOnly / stoneEligible:false — it is NOT real
// promotion evidence and cannot bank a Stone. The LAW (answer_without_solution) is only ever
// bypassed this way, so a real benchmark can never weaken it into a Stone.
const fixtureOverride = (guard, reason) => ({ guard, scope: 'test_fixture_only', reason, approvedBy: 'supervisor_policy' });
function setBar(engine, runId, content) {
  const ref = recordOut(engine, runId, 'baseline-bar', content);
  return engine.benchmark_run({ runId, arm: 'baseline', measurementRef: ref });
}
// Register one hypothesis, run a 3-route full test with the given contents, reverify.
function runChallenger(engine, runId, contents) {
  const reg = engine.register_hypotheses({ runId, hypotheses: ROUTES.map((m, i) => H(m, 'h' + i)) });
  const hyp = reg.hypothesisIds[0];
  const agentRuns = ROUTES.map((m, i) => ({ model: m, measurementRef: recordOut(engine, runId, `${hyp}-r${i}`, contents[i]) }));
  const ft = engine.test_hypothesis({ runId, hypothesisId: hyp, fullTest: { agentRuns } });
  const rv = ft.testId ? engine.reverify_run({ runId, testId: ft.testId }) : null;
  return { hyp, ft, rv };
}

// ======================= unit tests for the pure guards =======================

test('markerCharShare: marker-only ≈ all chars; padded fixture is a small fraction', () => {
  const markerOnly = QUALITY_PROBES.join(' ');
  assert.ok(markerCharShare(markerOnly, QUALITY_PROBES).share >= 0.8);
  // buildMeasuredContent pads with dots → low CHAR share even though it is probe-seeded
  assert.ok(markerCharShare(buildMeasuredContent(1000, 0.8), QUALITY_PROBES).share < 0.2);
});

test('answerKeyEchoGuard: flags marker-dominant output, clears a padded run-log and real prose', () => {
  assert.equal(answerKeyEchoGuard(QUALITY_PROBES.join(' '), DEFAULT_QUALITY_ORACLE).echo, true);
  assert.equal(answerKeyEchoGuard(buildMeasuredContent(1000, 0.8), DEFAULT_QUALITY_ORACLE).echo, false);
  assert.equal(answerKeyEchoGuard(richOutput('a real adapter that reconciles records idempotently', QUALITY_PROBES.slice(0, 8)), DEFAULT_QUALITY_ORACLE).echo, false);
});

test('negativeControlVerdict: a marker-echo fake PASSES a substring oracle (bad); lorem fails (good)', () => {
  assert.equal(negativeControlVerdict(QUALITY_PROBES.join(' '), DEFAULT_QUALITY_ORACLE).passed, true);
  assert.equal(negativeControlVerdict(standardNegativeControl(), DEFAULT_QUALITY_ORACLE).passed, false);
});

test('routeShaCollapse: identical SHAs collapse; deterministic-command is exempt; distinct passes', () => {
  const same = [{ content: 'X' }, { content: 'X' }, { content: 'X' }];
  assert.equal(routeShaCollapse(same, { requiredRoutes: 3 }).collapsed, true);
  assert.equal(routeShaCollapse(same, { requiredRoutes: 3, deterministicCommand: true }).collapsed, false);
  assert.equal(DETERMINISTIC_CLASSES.has(normalizeOutputClass('structured-case-results')), true);
  assert.equal(routeShaCollapse(same, {
    requiredRoutes: 3,
    deterministicCommand: DETERMINISTIC_CLASSES.has(normalizeOutputClass('structured-case-results'))
  }).collapsed, false);
  assert.equal(routeShaCollapse([{ content: 'A' }, { content: 'B' }, { content: 'C' }], { requiredRoutes: 3 }).collapsed, false);
});

test('evidenceBindingCheck: a bare marker list is unbound; markers with artifacts bind', () => {
  assert.equal(evidenceBindingCheck(['M1', 'M2'], []).ok, false);
  assert.equal(evidenceBindingCheck(['M1'], [{ marker: 'M1', sha256: 'abc', command: 'pytest' }]).ok, true);
  assert.deepEqual(evidenceBindingCheck(['M1', 'M2'], [{ marker: 'M1', artifactPath: 'p' }]).unbound, ['M2']);
});

test('solutionPressureCheck: answer-visible + strict + only auto NC fails; a held-out pass satisfies it', () => {
  const autoNc = { passed: false, source: 'auto' };
  assert.equal(solutionPressureCheck({ answerVisible: true, strict: true, negativeControl: autoNc }).ok, false);
  assert.equal(solutionPressureCheck({ answerVisible: true, strict: false, negativeControl: autoNc }).ok, true);
  assert.equal(solutionPressureCheck({ answerVisible: true, strict: true, negativeControl: autoNc, heldOut: { score: 0.9, floor: 0.6, echo: false } }).ok, true);
  // a held-out output that is itself marker-echo does NOT count
  assert.equal(solutionPressureCheck({ answerVisible: true, strict: true, negativeControl: autoNc, heldOut: { score: 1.0, floor: 0.6, echo: true } }).ok, false);
  assert.equal(solutionPressureCheck({ answerVisible: false }).ok, true);
});

test('classifyArtifact: receipts are not Stone-eligible unless they prove a behavior change', () => {
  assert.equal(classifyArtifact({ role: 'runlog', name: 'w-opus', content: 'RUN-LOG…' }).artifactClass, ARTIFACT_CLASS.TASK_IMPROVEMENT);
  const receipt = classifyArtifact({ role: 'runlog', name: 'dashboard-parity-receipt' });
  assert.equal(receipt.artifactClass, ARTIFACT_CLASS.RECEIPT_MAINTENANCE);
  assert.equal(receipt.stoneEligible, false);
  assert.equal(classifyArtifact({ name: 'dashboard-parity-receipt', provesBehaviorChange: true }).stoneEligible, true);
});

test('classifyObjectiveWork: saturated + receipt-only → route to a new real target', () => {
  const r = classifyObjectiveWork({ artifactClass: ARTIFACT_CLASS.RECEIPT_MAINTENANCE, targetSaturated: true, hasRealTarget: false });
  assert.equal(r.promotable, false);
  assert.equal(r.code, SEALED.TARGET_SATURATED);
  assert.equal(classifyObjectiveWork({ artifactClass: ARTIFACT_CLASS.TASK_IMPROVEMENT }).promotable, true);
});

// =============================== Test A: H61/H63 ===============================

test('A1: a benchmark whose negative control PASSES the oracle is rejected at creation (sealed, coarse)', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'A1', task: SPECIFIC_TASK });
  engine.artifact_record({ runId: 'A1', role: 'baseline', content: BASELINE_BODY });
  // The H/Q receipt oracle: "must include these markers". Its frozen negative control is
  // the marker-only receipt fake — which the substring oracle scores 1.0 → non-discriminating.
  const prop = engine.benchmark_propose({ runId: 'A1', benchmarks: [{
    name: 'hq-receipts', taskValueDimensions: ['receipt'], resourceDimensions: ['cost'], cases: [{ id: 'c1' }],
    oracle: { mustInclude: ['H61', 'H63', 'HQ-RECEIPT-OK'] },
    negativeControl: { content: 'H61 H63 HQ-RECEIPT-OK' }
  }] });
  const sel = engine.benchmark_select({ runId: 'A1', benchmarkId: prop.benchmarkIds[0] });
  assertCoarse(sel, SEALED.NEGATIVE_CONTROL_PASSED);
  assert.equal(sel.lane, 'benchmark-hardening');
  // benchmark did NOT freeze
  assert.equal(store.load('A1').benchmark.frozen, false);
  // the SPECIFIC reason + forensic detail are sealed to the ledger only
  const seal = lastSeal(store, 'A1');
  assert.equal(seal.sealedReason, SEALED.NEGATIVE_CONTROL_PASSED);
  assert.equal(seal.detail.score, 1);
});

test('A2: a marker-only candidate that games a probe oracle is blocked at promotion + quarantined', () => {
  const { engine, store } = freshEngine();
  setupBench(engine, 'A2', { oracle: DEFAULT_QUALITY_ORACLE }); // auto negative control (lorem) → selects fine
  setBar(engine, 'A2', buildMeasuredContent(1000, 0.6));
  // The attack: emit every probe token, nothing else. The substring oracle scores it 1.0.
  const markerOnly = QUALITY_PROBES.join(' ');
  const { hyp, ft, rv } = runChallenger(engine, 'A2', [markerOnly, markerOnly, markerOnly]);
  assert.equal(ft.verdict, 'MOVED_FRONTIER', 'the naive oracle is fooled — it scores the fake a frontier win');
  assert.equal(rv.reverified, true, 'and the fake even reverifies (bytes back the bogus score)');
  const promo = engine.promotion_request({ runId: 'A2', hypothesisId: hyp });
  assertCoarse(promo, SEALED.ANSWER_KEY_ECHO_GUARD); // …but the gate refuses to promote it
  assert.equal(lastSeal(store, 'A2').sealedReason, SEALED.ANSWER_KEY_ECHO_GUARD);
  // the offending artifact is quarantine-eligible (evidence preserved, not deleted)
  const ref = store.load('A2').tests[0].agentRuns[0].measurementRef;
  assert.equal(store.readArtifact('A2', ref).quarantineEligible, true);
});

// ===================== Bench-005/006 data-ingest portability =====================

const INGEST = ['RECONCILE-INSERT', 'RECONCILE-UPDATE', 'RECONCILE-DELETE', 'RECONCILE-UPSERT', 'CANONICAL-BOUNDARY', 'PORTABLE-ADAPTER', 'IDEMPOTENT', 'SCHEMA-DRIFT'];
const BOUNDARY = ['HELDOUT-NONDESTRUCTIVE', 'HELDOUT-CANONICAL-PRESERVED', 'HELDOUT-NO-OVERWRITE'];
const ingestOracle = { kind: 'probe', probes: INGEST };
const ingestBenchmark = {
  requireSolutionPressure: true,                 // the law: answering is not enough
  routeIndependence: 'required', requiredRoutes: 3,
  solutionPressure: { heldOut: { oracle: { kind: 'probe', probes: BOUNDARY }, floor: 0.6 } }
};
// three INDEPENDENT route variants (distinct prose → distinct SHA) that all solve the task
const ingestWin = (tag) => richOutput(`portable ingest adapter ${tag}: reconciles inserts updates deletes upserts, preserves the canonical boundary, idempotent under schema drift`, INGEST);
// The baseline is the verbose/expensive prior loop (4/8 probes = 0.5). Challengers are leaner
// AND more correct → quality up, cost down (the real Bench-005/006 shape: "cost decreased").
const INGEST_BASELINE = richOutput('baseline ingest: partial reconcile only', INGEST.slice(0, 4)) + '\n' + 'x'.repeat(4000);
// REAL artifact-bound evidence for each ingest marker: an audit artifact the method commits
// (a reconciliation log + its SHA + the command that produced it). This is how a genuine
// data-ingest loop proves its markers are bound to source evidence — not a fixture override.
function ingestBindings(engine, runId) {
  const audit = engine.artifact_record({ runId, role: 'runlog', name: 'reconcile-audit', content: 'reconciliation audit: every category replayed against the canonical store; deltas recorded; idempotency verified by re-run.', measure: false });
  return INGEST.map((marker) => ({ marker, artifactPath: `${runId}/reconcile-audit`, sha256: audit.artifact && audit.artifact.sha256, command: 'ingest --reconcile --dry-run', result: 'ok: 0 destructive ops; canonical boundary preserved' }));
}

test('B: an R3/R5-style data-ingest candidate (solves + transfers, evidence-bound) still promotes', () => {
  const { engine, store } = freshEngine();
  setupBench(engine, 'B', { oracle: ingestOracle, benchmark: ingestBenchmark });
  setBar(engine, 'B', INGEST_BASELINE); // 4/8 = 0.5 bar, expensive
  const { hyp, ft, rv } = runChallenger(engine, 'B', [ingestWin('alpha'), ingestWin('beta'), ingestWin('gamma')]);
  assert.equal(ft.aggregate.quality, 1, 'all task-value probes present → quality 1.0');
  assert.equal(rv.reverified, true);
  // held-out boundary case the method must also satisfy (transfer proof) + REAL artifact-bound
  // evidence for every present marker (PATCH A is default-on; a real loop binds its markers).
  const heldOutRef = recordOut(engine, 'B', 'heldout', richOutput('on the held-out fixture it stays non-destructive and preserves canon', BOUNDARY));
  const promo = promoteWithApproval(engine, 'B', hyp, { solutionProof: { heldOutRef }, evidence: { bindings: ingestBindings(engine, 'B') } });
  assert.equal(promo.status, 'OK');
  assert.equal(promo.decision.promote, true);
  assert.equal(promo.integrity.artifactClass, ARTIFACT_CLASS.TASK_IMPROVEMENT);
  assert.equal(promo.integrity.stoneEligible, true, 'a real evidence-bound transfer solution banks a Stone');
  assert.equal(promo.integrity.fixtureOnly, false, 'no test-fixture override was used');
  // PATCH E wording: the Bench-006 cost-frontier win is EQUAL quality preserved at 1.0 while
  // cost dropped — not a quality gain over the 1.0 baseline. (Here the baseline is the weaker
  // 0.5 bar, so qualityGain is positive; the canonical Bench-006 claim is preservation@1.0.)
  assert.ok(promo.decision.deltas.qualityGain >= 0.4, 'quality moved vs the 0.5 baseline; cost within tolerance');
});

test('C: R2 (missing reconciliation) and R4 (boundary not transferable) still FAIL', () => {
  // R2 — missing the reconciliation categories → scores below the bar (main-oracle failure)
  {
    const { engine } = freshEngine();
    setupBench(engine, 'C2', { oracle: ingestOracle, benchmark: ingestBenchmark });
    setBar(engine, 'C2', INGEST_BASELINE); // 0.5 bar
    const r2 = richOutput('R2 adapter without reconciliation', ['PORTABLE-ADAPTER', 'IDEMPOTENT']); // 2/8 = 0.25
    const { hyp, ft } = runChallenger(engine, 'C2', [r2, r2 + ' x', r2 + ' y']);
    assert.equal(ft.verdict, 'NO_IMPROVEMENT', 'a failed route is not successful evidence');
    const promo = engine.promotion_request({ runId: 'C2', hypothesisId: hyp });
    assert.equal(promo.status, 'BLOCKED');
    assert.ok(['BELOW_FLOOR', 'BELOW_THRESHOLD'].includes(promo.code), `R2 fails the bar (${promo.code})`);
  }
  // R4 — answers the main oracle (1.0) AND binds its markers (so it clears PATCH A) BUT its
  // method does not hold on the held-out boundary → the LAW catches it: ANSWER_WITHOUT_SOLUTION.
  {
    const { engine, store } = freshEngine();
    setupBench(engine, 'C4', { oracle: ingestOracle, benchmark: ingestBenchmark });
    setBar(engine, 'C4', INGEST_BASELINE);
    const { hyp, ft, rv } = runChallenger(engine, 'C4', [ingestWin('a'), ingestWin('b'), ingestWin('c')]);
    assert.equal(ft.aggregate.quality, 1, 'R4 "answers" the visible benchmark perfectly');
    assert.equal(rv.reverified, true);
    // held-out boundary fixture: R4 overwrites canon → boundary probes ABSENT → transfer fails
    const heldOutRef = recordOut(engine, 'C4', 'heldout-bad', richOutput('R4 silently overwrites the canonical store', ['UNRELATED-NOTE']));
    // R4 binds its markers (so it isn't trivially blocked by evidence-binding) — but the held-out
    // boundary transfer still fails, which is the real defect the LAW exists to catch.
    const promo = engine.promotion_request({ runId: 'C4', hypothesisId: hyp, solutionProof: { heldOutRef }, evidence: { bindings: ingestBindings(engine, 'C4') } });
    assertCoarse(promo, SEALED.ANSWER_WITHOUT_SOLUTION);
    assert.equal(lastSeal(store, 'C4').sealedReason, SEALED.ANSWER_WITHOUT_SOLUTION);
  }
});

// ===================== Test D: deterministic-command exception =====================

test('D: identical route SHAs do NOT fail route-diversity for deterministic command output', () => {
  const cmdOut = richOutput('exit 0 — checksum 9f1a deterministic verification passed', INGEST);
  // exempt case: outputClass deterministic-command → identical SHA ×3 is valid. This is a
  // PLUMBING test of the route-SHA exception, so it carries a test_fixture override for the
  // marker-oracle guards (evidence_binding + the LAW); it promotes as fixtureOnly/non-Stone.
  {
    const { engine } = freshEngine();
    setupBench(engine, 'D1', { oracle: ingestOracle, benchmark: {
      routeIndependence: 'required', requiredRoutes: 3, outputClass: 'deterministic-command',
      integrityOverride: [fixtureOverride('evidence_binding', 'plumbing: route-SHA deterministic exception'), fixtureOverride('answer_without_solution', 'plumbing: route-SHA deterministic exception')]
    } });
    setBar(engine, 'D1', INGEST_BASELINE);
    const { hyp } = runChallenger(engine, 'D1', [cmdOut, cmdOut, cmdOut]); // identical → same SHA
    const promo = promoteWithApproval(engine, 'D1', hyp);
    assert.equal(promo.status, 'OK', 'deterministic identical output is allowed to promote');
    assert.equal(promo.integrity.fixtureOnly, true, 'a fixture override makes this non-Stone plumbing, not real evidence');
    assert.equal(promo.integrity.stoneEligible, false);
  }
  // control: same identical outputs but NOT declared deterministic → collapse blocks it
  {
    const { engine, store } = freshEngine();
    setupBench(engine, 'D2', { oracle: ingestOracle, benchmark: { routeIndependence: 'required', requiredRoutes: 3 } });
    setBar(engine, 'D2', INGEST_BASELINE);
    const { hyp } = runChallenger(engine, 'D2', [cmdOut, cmdOut, cmdOut]);
    const promo = engine.promotion_request({ runId: 'D2', hypothesisId: hyp });
    assertCoarse(promo, SEALED.ROUTE_SHA_COLLAPSE);
    assert.equal(lastSeal(store, 'D2').sealedReason, SEALED.ROUTE_SHA_COLLAPSE);
  }
});

// ===================== Test E: receipt-maintenance ≠ Stone =====================

test('E: a receipt-maintenance artifact cannot become a Stone (unless it proves a behavior change)', () => {
  const { engine, store } = freshEngine();
  // PLUMBING test of the Stone-eligibility path: carry a fixture override so the synthetic
  // probe-seeded receipt reaches the eligibility check and is blocked for the RIGHT reason
  // (receipt maintenance ≠ Stone), not incidentally by a marker guard.
  setupBench(engine, 'E', { oracle: DEFAULT_QUALITY_ORACLE, benchmark: { integrityOverride: [fixtureOverride('answer_key_echo', 'plumbing: synthetic measured content is padded marker echo'), fixtureOverride('evidence_binding', 'plumbing: Stone-eligibility receipt path'), fixtureOverride('answer_without_solution', 'plumbing: Stone-eligibility receipt path')] } });
  setBar(engine, 'E', buildMeasuredContent(1000, 0.6));
  // a compact dashboard/report/manifest receipt — probe-seeded so it would "win", but it is
  // receipt maintenance, not a task-value improvement.
  const reg = engine.register_hypotheses({ runId: 'E', hypotheses: ROUTES.map((m, i) => H(m, 'h' + i)) });
  const hyp = reg.hypothesisIds[0];
  const receipts = ROUTES.map((m, i) => {
    const rec = engine.artifact_record({ runId: 'E', role: 'runlog', name: `dashboard-parity-receipt-${i}`, content: buildMeasuredContent(900 + i, 0.86), measure: true });
    assert.equal(rec.artifactClass, ARTIFACT_CLASS.RECEIPT_MAINTENANCE);
    assert.equal(rec.stoneEligible, false); // proven at record time
    return { model: m, measurementRef: rec.artifactId };
  });
  const ft = engine.test_hypothesis({ runId: 'E', hypothesisId: hyp, fullTest: { agentRuns: receipts } });
  engine.reverify_run({ runId: 'E', testId: ft.testId });
  const promo = engine.promotion_request({ runId: 'E', hypothesisId: hyp });
  assertCoarse(promo, SEALED.STONE_INELIGIBLE);
  assert.equal(lastSeal(store, 'E').sealedReason, SEALED.STONE_INELIGIBLE);
});

test('E2: the SAME receipt promotes once it proves a real source-level behavior change', () => {
  const { engine } = freshEngine();
  // PLUMBING: same fixture override so the provesBehaviorChange path is reached and promotes
  // (as fixtureOnly/non-Stone — this proves the eligibility mechanic, not a real transfer).
  setupBench(engine, 'E2', { oracle: DEFAULT_QUALITY_ORACLE, benchmark: { integrityOverride: [fixtureOverride('answer_key_echo', 'plumbing: synthetic measured content is padded marker echo'), fixtureOverride('evidence_binding', 'plumbing: Stone-eligibility behavior-change path'), fixtureOverride('answer_without_solution', 'plumbing: Stone-eligibility behavior-change path')] } });
  setBar(engine, 'E2', buildMeasuredContent(1000, 0.6));
  const reg = engine.register_hypotheses({ runId: 'E2', hypotheses: ROUTES.map((m, i) => H(m, 'h' + i)) });
  const hyp = reg.hypothesisIds[0];
  const runs = ROUTES.map((m, i) => ({ model: m, measurementRef: engine.artifact_record({ runId: 'E2', role: 'runlog', name: `dashboard-parity-receipt-${i}`, content: buildMeasuredContent(900 + i, 0.86), measure: true, provesBehaviorChange: true }).artifactId }));
  const ft = engine.test_hypothesis({ runId: 'E2', hypothesisId: hyp, fullTest: { agentRuns: runs } });
  engine.reverify_run({ runId: 'E2', testId: ft.testId });
  const promo = promoteWithApproval(engine, 'E2', hyp);
  assert.equal(promo.status, 'OK');
});

// ===================== Test F: no canonical mutation =====================

test('F: the mandated canonical loop files are byte-identical after the full gate exercises', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const loopsDir = join(here, '..', 'loops');
  for (const id of Object.keys(MANDATED_LOOPS)) {
    const def = MANDATED_LOOPS[id];
    const bytes = readFileSync(join(loopsDir, def.file));
    assert.equal(sha256(bytes), def.sha256, `${def.file} must be unchanged (operator authority only)`);
  }
});

test('F2: no promotion ever sets canonicalChange — disposition is internal-champion only', () => {
  const { engine, store } = freshEngine();
  // PLUMBING: the canonical-change flag is what this test exercises; carry a fixture override
  // so synthetic buildMeasuredContent bytes promote (as fixtureOnly/non-Stone) for the check.
  setupBench(engine, 'F2', { oracle: DEFAULT_QUALITY_ORACLE, benchmark: { integrityOverride: [fixtureOverride('answer_key_echo', 'plumbing: synthetic measured content is padded marker echo'), fixtureOverride('evidence_binding', 'plumbing: canonical-change flag'), fixtureOverride('answer_without_solution', 'plumbing: canonical-change flag')] } });
  setBar(engine, 'F2', buildMeasuredContent(1000, 0.6));
  const { hyp } = runChallenger(engine, 'F2', [buildMeasuredContent(950, 0.82), buildMeasuredContent(960, 0.83), buildMeasuredContent(940, 0.81)]);
  const promo = promoteWithApproval(engine, 'F2', hyp);
  assert.equal(promo.status, 'OK');
  assert.equal(store.load('F2').promotions.every((p) => p.canonicalChange === false), true);
});

// ============== v0 opt-in guards (Option A merge defaults) ==============

const SMALL_PROBES = ['PRX1', 'PRX2', 'PRX3'];
const smallOracle = { kind: 'probe', probes: SMALL_PROBES };
const bigBaseline = 'baseline reference text ' + 'x'.repeat(4000); // expensive, 0 probes → quality 0 bar
const FIXTURE_BUNDLE = ['answer_key_echo', 'route_sha_collapse', 'evidence_binding', 'answer_without_solution'].map((g) => fixtureOverride(g, 'plumbing: synthetic fixture'));
// real evidence bindings for the small-oracle markers (artifact path + sha + command/result)
const smallBindings = () => ({ bindings: SMALL_PROBES.map((m) => ({ marker: m, sha256: 'd00dfeed', command: 'verify', result: 'ok', artifactPath: `/ev/${m}` })) });
const heldOutOracle = { kind: 'probe', probes: ['HO1', 'HO2'] };

test('opt-in A: evidence-binding fires when benchmark declares evidenceBinding:"required"', () => {
  const { engine, store } = freshEngine();
  setupBench(engine, 'DA', { oracle: smallOracle, benchmark: { evidenceBinding: 'required' } });
  setBar(engine, 'DA', bigBaseline);
  const { hyp } = runChallenger(engine, 'DA', [richOutput('alpha solves it', SMALL_PROBES), richOutput('beta solves it', SMALL_PROBES), richOutput('gamma solves it', SMALL_PROBES)]);
  const promo = engine.promotion_request({ runId: 'DA', hypothesisId: hyp });
  assertCoarse(promo, SEALED.EVIDENCE_BINDING_MISSING);
  assert.equal(lastSeal(store, 'DA').detail.optIn, true);
});

test('opt-in B: route-SHA collapse fires when benchmark declares routeIndependence:"required"', () => {
  const { engine, store } = freshEngine();
  setupBench(engine, 'DB', { oracle: smallOracle, benchmark: { routeIndependence: 'required', requiredRoutes: 3, outputClass: 'prose' } });
  setBar(engine, 'DB', bigBaseline);
  const same = richOutput('one shared prose answer', SMALL_PROBES);
  const { hyp } = runChallenger(engine, 'DB', [same, same, same]);
  const promo = engine.promotion_request({ runId: 'DB', hypothesisId: hyp });
  assertCoarse(promo, SEALED.ROUTE_SHA_COLLAPSE);
  assert.equal(lastSeal(store, 'DB').detail.optIn, true);
});

test('opt-in C: solution-pressure fires when benchmark declares requireSolutionPressure:true', () => {
  const { engine, store } = freshEngine();
  const dcBench = { requireSolutionPressure: true, evidenceBinding: 'required', solutionPressure: { heldOut: { oracle: heldOutOracle, floor: 0.6 } } };
  setupBench(engine, 'DC', { oracle: smallOracle, benchmark: dcBench });
  setBar(engine, 'DC', bigBaseline);
  const { hyp } = runChallenger(engine, 'DC', [richOutput('a', SMALL_PROBES), richOutput('b', SMALL_PROBES), richOutput('c', SMALL_PROBES)]);
  const heldOutRef = recordOut(engine, 'DC', 'ho-fail', richOutput('does not transfer to the hidden case', ['NOPE']));
  const promo = engine.promotion_request({ runId: 'DC', hypothesisId: hyp, solutionProof: { heldOutRef }, evidence: smallBindings() });
  assertCoarse(promo, SEALED.ANSWER_WITHOUT_SOLUTION);
  assert.equal(lastSeal(store, 'DC').detail.optIn, true);
});

test('padded marker fake (markers + filler diluting char-share) is rejected at promotion', () => {
  const { engine, store } = freshEngine();
  setupBench(engine, 'PAD', { oracle: DEFAULT_QUALITY_ORACLE });
  setBar(engine, 'PAD', bigBaseline);
  // all probes (so the naive oracle scores 1.0) + a filler wall to push char-share under 0.6
  const padded = QUALITY_PROBES.join(' ') + ' ' + 'x'.repeat(2000);
  const { hyp } = runChallenger(engine, 'PAD', [padded, padded + ' ', padded + '  ']);
  const promo = engine.promotion_request({ runId: 'PAD', hypothesisId: hyp });
  assertCoarse(promo, SEALED.ANSWER_KEY_ECHO_GUARD);
  assert.equal(lastSeal(store, 'PAD').detail.padded, true, 'caught by the secondary padded-marker detector, not raw char-share');
});

test('override honored: a test_fixture_only override is accepted and the promotion is recorded NON-Stone', () => {
  const { engine } = freshEngine();
  setupBench(engine, 'OVH', { oracle: DEFAULT_QUALITY_ORACLE, benchmark: { integrityOverride: FIXTURE_BUNDLE } });
  setBar(engine, 'OVH', buildMeasuredContent(1000, 0.6));
  const { hyp } = runChallenger(engine, 'OVH', [buildMeasuredContent(950, 0.82), buildMeasuredContent(960, 0.83), buildMeasuredContent(940, 0.81)]);
  const promo = promoteWithApproval(engine, 'OVH', hyp);
  assert.equal(promo.status, 'OK');
  assert.equal(promo.integrity.fixtureOnly, true);
  assert.equal(promo.integrity.stoneEligible, false, 'a fixture override can never bank a real Stone');
  assert.equal(promo.integrity.artifactClass, ARTIFACT_CLASS.TEST_FIXTURE, 'a fixture waiver forces artifactClass=test_fixture (plumbing)');
});

test('override non-silent: overrides appear in the benchmark summary and on the promotion record (guard + reason)', () => {
  const { engine, store } = freshEngine();
  const { sel } = setupBench(engine, 'OVS', { oracle: DEFAULT_QUALITY_ORACLE, benchmark: { integrityOverride: FIXTURE_BUNDLE } });
  assert.ok(sel.frozen.integrityOverrides.some((o) => o.guard === 'answer_key_echo' && typeof o.reason === 'string' && o.reason.length), 'summary surfaces overrides with guard + reason');
  setBar(engine, 'OVS', buildMeasuredContent(1000, 0.6));
  const { hyp } = runChallenger(engine, 'OVS', [buildMeasuredContent(950, 0.82), buildMeasuredContent(960, 0.83), buildMeasuredContent(940, 0.81)]);
  promoteWithApproval(engine, 'OVS', hyp);
  const rec = store.load('OVS').promotions.slice(-1)[0];
  assert.ok(rec.integrity.overrides.length >= 1);
  assert.ok(rec.integrity.overrides.every((o) => o.guard && o.reason), 'every recorded override names its guard + reason (never silent)');
  assert.ok(rec.integrity.overrides.some((o) => o.fixture === true));
});

test('LAW unwaivable: a NON-fixture override of answer_without_solution is IGNORED — the LAW still blocks', () => {
  const { engine, store } = freshEngine();
  // A real benchmark cannot waive any integrity guard. This candidate binds its markers (evidence
  // passes) but its held-out transfer FAILS. A production-scope waiver of the LAW is invalid, so it
  // is ignored and the LAW still blocks. (Only a test_fixture_only waiver could bypass it — and that
  // would force the promotion non-Stone, never a real Stone.)
  const lawWaiveAttempt = { guard: 'answer_without_solution', scope: 'production', reason: 'attempt to waive the law in a real benchmark', approvedBy: 'supervisor_policy' };
  const lawBench = { requireSolutionPressure: true, evidenceBinding: 'required', solutionPressure: { heldOut: { oracle: heldOutOracle, floor: 0.6 } }, integrityOverride: [lawWaiveAttempt] };
  setupBench(engine, 'LAW', { oracle: smallOracle, benchmark: lawBench });
  setBar(engine, 'LAW', bigBaseline);
  const { hyp } = runChallenger(engine, 'LAW', [richOutput('a', SMALL_PROBES), richOutput('b', SMALL_PROBES), richOutput('c', SMALL_PROBES)]);
  const heldOutRef = recordOut(engine, 'LAW', 'ho-fail', richOutput('does not transfer', ['NOPE']));
  const promo = engine.promotion_request({ runId: 'LAW', hypothesisId: hyp, solutionProof: { heldOutRef }, evidence: smallBindings() });
  assertCoarse(promo, SEALED.ANSWER_WITHOUT_SOLUTION);
  assert.equal(lastSeal(store, 'LAW').sealedReason, SEALED.ANSWER_WITHOUT_SOLUTION);
});

test('#1a tightening: route_sha_collapse + evidence_binding waivers are FIXTURE-ONLY — a non-fixture (real-benchmark) waiver is ignored and the guard still fires', () => {
  // route-independence: a real prose benchmark cannot waive route-SHA collapse with a production scope
  {
    const { engine, store } = freshEngine();
    const nfRoute = { guard: 'route_sha_collapse', scope: 'production', reason: 'try to waive route independence in a real benchmark', approvedBy: 'supervisor_policy' };
    const { sel } = setupBench(engine, 'NF1', { oracle: smallOracle, benchmark: { routeIndependence: 'required', requiredRoutes: 3, outputClass: 'prose', integrityOverride: [nfRoute] } });
    assert.equal(sel.frozen.integrityOverrides.find((o) => o.guard === 'route_sha_collapse').honored, false, 'summary marks the non-fixture waiver honored:false (non-silent)');
    setBar(engine, 'NF1', bigBaseline);
    const same = richOutput('one shared prose answer', SMALL_PROBES);
    const { hyp } = runChallenger(engine, 'NF1', [same, same, same]); // identical → same SHA
    const promo = engine.promotion_request({ runId: 'NF1', hypothesisId: hyp });
    assertCoarse(promo, SEALED.ROUTE_SHA_COLLAPSE); // waiver ignored → collapse still fires
  }
  // evidence-binding: a real marker benchmark cannot waive evidence binding with a production scope
  {
    const { engine } = freshEngine();
    const nfEv = { guard: 'evidence_binding', scope: 'production', reason: 'try to waive evidence binding in a real benchmark', approvedBy: 'supervisor_policy' };
    setupBench(engine, 'NF2', { oracle: smallOracle, benchmark: { evidenceBinding: 'required', integrityOverride: [nfEv] } });
    setBar(engine, 'NF2', bigBaseline);
    const { hyp } = runChallenger(engine, 'NF2', [richOutput('a', SMALL_PROBES), richOutput('b', SMALL_PROBES), richOutput('c', SMALL_PROBES)]); // distinct → route ok
    const promo = engine.promotion_request({ runId: 'NF2', hypothesisId: hyp }); // no bindings supplied
    assertCoarse(promo, SEALED.EVIDENCE_BINDING_MISSING); // waiver ignored → binding still required
  }
});
