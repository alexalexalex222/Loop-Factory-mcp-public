// Loop Factory SUPERVISOR proof — the active harness, proven entirely with MOCK workers
// (no command execution). This is the enforcement boundary: dispatch → validate →
// accept-or-re-enter, plus the continuous campaign (mine → improve → bank Stone →
// advance/retire → re-mine) that never self-completes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISSING_FULL_PRIVATE_LOOPS, requireFullLoops, compilePhaseContract,
  validateWorkerPacket, dispatchWorker, runFullTestBatch, runSupervisedCampaign,
  parseCandidates, parseJudgeVerdict, parseWorkerPacket
} from '../src/supervisor.mjs';
import { loadLoop } from '../src/loops.mjs';
import { DEFAULT_QUALITY_ORACLE, buildMeasuredContent } from '../src/measure.mjs';
import { freshEngine, BASELINE_BODY, BASELINE_BODY_V2 } from './helpers.mjs';

const okPacket = (route, out) => ({ route, artifacts: [{ role: 'runlog', content: out }], finalOutput: out });
const benchmark = { name: 'b', taskValueDimensions: ['quality'], resourceDimensions: ['token-cost'], cases: [{ id: 'c1' }], oracle: DEFAULT_QUALITY_ORACLE };

// A configurable mock worker: baseline runs score 0.70; challengers score per `mode`.
function mockWorker(mode = 'win') {
  return (contract) => {
    if (contract.kind === 'mine') return { route: contract.route, artifacts: [{ role: 'runlog', content: 'mined' }], finalOutput: 'mined', candidates: mode === 'saturate' ? [] : [{ loop: 'loop-de-loop', title: 'cand' }] };
    if (contract.kind === 'baseline') return okPacket(contract.route, buildMeasuredContent(1000, 0.70));
    // challenger
    if (mode === 'win') return okPacket(contract.route, buildMeasuredContent(900, 0.86));
    return okPacket(contract.route, buildMeasuredContent(1000, 0.70)); // no improvement
  };
}

// ---- full-loop gate -----------------------------------------------------
test('requireFullLoops: present → ok; missing/drift → exact MISSING_FULL_PRIVATE_LOOPS', () => {
  const real = requireFullLoops();
  assert.equal(real.ok, true);
  assert.equal(real.manifest.length, 2);
  assert.equal(requireFullLoops(() => { throw new Error('gone'); }).sentinel, MISSING_FULL_PRIVATE_LOOPS);
  assert.equal(requireFullLoops(() => []).sentinel, MISSING_FULL_PRIVATE_LOOPS);
  assert.equal(MISSING_FULL_PRIVATE_LOOPS, 'MISSING_FULL_PRIVATE_LOOPS');
});

test('a campaign with missing loops returns the exact sentinel and stops', () => {
  // monkeypatch is overkill; prove the wiring: requireFullLoops is what the campaign gates on
  const { engine } = freshEngine();
  // present → does NOT return the sentinel (returns a normal result object)
  const r = runSupervisedCampaign(engine, { runId: 'm0', targets: [], task: 'x' }, { worker: mockWorker(), maxBatches: 0 });
  assert.notEqual(r, MISSING_FULL_PRIVATE_LOOPS);
});

test('phase contract carries only the SLICE + loop hash, never the whole loop', () => {
  const loop = loadLoop('strip-miner');
  const c = compilePhaseContract('strip-miner', 0, { task: 't' });
  assert.equal(c.loopSha, loop.sha256);
  assert.ok(c.slice.length > 0 && c.slice.length < loop.text.length, 'slice must be a fraction of the full loop');
  assert.equal(c.totalPhases, loop.sections.length);
});

// ---- the enforcement boundary (worker invalidation) ---------------------
test('worker invalidation: every bad-worker shape is rejected by the supervisor', () => {
  const c = compilePhaseContract('loop-de-loop', 1, { requires: ['runlog'] });
  const cases = [
    ['early-stop', { ...okPacket('m', 'x'), stoppedEarly: true }, 'EARLY_STOP'],
    ['summary-only', { route: 'm', artifacts: [], finalOutput: '' }, 'SUMMARY_ONLY'],
    ['missing artifacts', { route: 'm', artifacts: [{ role: 'notes', content: 'x' }], finalOutput: 'x' }, 'MISSING_ARTIFACTS'],
    ['no comparable output', { route: 'm', artifacts: [{ role: 'runlog', content: 'x' }], finalOutput: '' }, 'NO_COMPARABLE_OUTPUT'],
    ['phase skip', { ...okPacket('m', 'x'), phase: 99 }, 'PHASE_SKIP'],
    ['copied public', { ...okPacket('m', 'x'), copiedFromPublic: true }, 'COPIED_PUBLIC'],
    ['model-reported metric', { ...okPacket('m', 'x'), claim: { metricsSelfReported: true } }, 'MODEL_REPORTED_METRIC'],
    ['self-promotion', { ...okPacket('m', 'x'), claim: { promoted: true } }, 'SELF_PROMOTION'],
    ['self-stop', { ...okPacket('m', 'x'), claim: { stopCampaign: true } }, 'SELF_STOP']
  ];
  for (const [label, packet, code] of cases) {
    const v = validateWorkerPacket(c, packet);
    assert.equal(v.accepted, false, `${label} must be rejected`);
    assert.ok(v.reasons.includes(code), `${label} → expected ${code}, got ${v.reasons.join(',')}`);
  }
  // a clean packet is accepted
  assert.equal(validateWorkerPacket(c, okPacket('m', 'real output')).accepted, true);
});

test('structured worker packets keep tool-owned raw evidence and expose prohibited claims to the validator', () => {
  const contract = compilePhaseContract('loop-de-loop', 0, { requires: ['runlog'] });
  const packet = parseWorkerPacket(
    '<WORKER_PACKET>{"phase":1,"claim":{"metrics":{"quality":1},"promoted":true},"finalOutput":"done"}</WORKER_PACKET>',
    { route: 'gpt-5.6-sol', invocation: { requestedModel: 'gpt-5.6-sol' } }
  );
  assert.equal(packet.route, 'gpt-5.6-sol');
  assert.equal(packet.artifacts.length, 1);
  assert.match(packet.artifacts[0].content, /WORKER_PACKET/);
  assert.equal(packet.phase, 1);
  assert.equal(packet.claim.promoted, true);
  const verdict = validateWorkerPacket(contract, packet);
  assert.equal(verdict.accepted, false);
  assert.deepEqual(verdict.reasons.sort(), ['MODEL_REPORTED_METRIC', 'PHASE_SKIP', 'SELF_PROMOTION']);
});

test('malformed worker packet is summary-only and cannot pass the enforcement boundary', () => {
  const contract = compilePhaseContract('loop-de-loop', 0);
  const packet = parseWorkerPacket('not-json', { route: 'gpt-5.6-sol' });
  const verdict = validateWorkerPacket(contract, packet);
  assert.equal(packet.summaryOnly, true);
  assert.equal(verdict.accepted, false);
  assert.ok(verdict.reasons.includes('SUMMARY_ONLY'));
});

test('dispatch transaction re-enters on a bad worker and never accepts it', () => {
  const c = compilePhaseContract('loop-de-loop', 1);
  let calls = 0;
  const flaky = () => { calls++; return calls < 2 ? { route: 'm', summaryOnly: true } : okPacket('m', 'real output'); };
  const d = dispatchWorker(c, flaky, { maxRetries: 2 });
  assert.equal(d.accepted, true);
  assert.equal(calls, 2, 'it re-entered until the worker produced valid output');

  const alwaysBad = () => ({ route: 'm', stoppedEarly: true, finalOutput: 'x', artifacts: [{ role: 'runlog', content: 'x' }] });
  const d2 = dispatchWorker(c, alwaysBad, { maxRetries: 2 });
  assert.equal(d2.accepted, false, 'a persistently bad worker is never accepted');
});

test('dispatch emits one immutable verdict event per attempt without changing acceptance', () => {
  const contract = compilePhaseContract('loop-de-loop', 1);
  const events = [];
  let calls = 0;
  const d = dispatchWorker(contract, () => {
    calls++;
    return calls === 1
      ? { ...okPacket('gpt-5.6-sol', 'bad'), claim: { promoted: true } }
      : { ...okPacket('gpt-5.6-sol', 'good'), invocation: { requestedModel: 'gpt-5.6-sol' } };
  }, { onVerdict: (event) => events.push(event) });
  assert.equal(d.accepted, true);
  assert.equal(events.length, 2);
  assert.equal(events[0].accepted, false);
  assert.deepEqual(events[0].reasons, ['SELF_PROMOTION']);
  assert.equal(events[1].accepted, true);
  assert.equal(events[1].invocation.requestedModel, 'gpt-5.6-sol');
});

test('dispatch passes ONE contract arg (attempt inside it) — a worker 2nd param is not clobbered', () => {
  // regression: executorWorker(contract, env=process.env) broke when dispatch passed
  // `attempt` as the 2nd positional, reading attempt(0) as env → exec seen disabled.
  const c = compilePhaseContract('loop-de-loop', 1);
  let secondArg = 'untouched';
  const w = (contract, env = 'DEFAULT') => { secondArg = env; return okPacket('m', 'out'); };
  dispatchWorker(c, w, {});
  assert.equal(secondArg, 'DEFAULT', 'worker 2nd positional must keep its default; attempt rides inside the contract');
});

// ---- FullTestBatch validity counting ------------------------------------
test('an invalid worker makes the whole batch invalid and it does NOT count', () => {
  const { engine } = freshEngine();
  // drive engine to a state where test_hypothesis could run
  engine.initialize_loop_run({ runId: 'b1', task: 'Improve precision by at least 10% under benchmark cost.' });
  engine.artifact_record({ runId: 'b1', role: 'baseline', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({ runId: 'b1', benchmarks: [benchmark] });
  engine.benchmark_select({ runId: 'b1', benchmarkId: prop.benchmarkIds[0] });
  const baseRef = engine.artifact_record({ runId: 'b1', role: 'runlog', content: buildMeasuredContent(1000, 0.7), measure: true }).artifactId;
  engine.benchmark_run({ runId: 'b1', arm: 'baseline', measurementRef: baseRef });
  const reg = engine.register_hypotheses({ runId: 'b1', hypotheses: [0, 1, 2].map((i) => ({ title: 'h' + i, route: { model: 'claude-opus-4-8' } })) });
  const recordMeasurement = (p, route) => engine.artifact_record({ runId: 'b1', role: 'runlog', name: route, content: String(p.finalOutput || ''), measure: true }).artifactId;

  // one worker in the batch is summary-only → batch invalid, not counted
  const badBatch = runFullTestBatch(engine, 'b1', { hypothesisId: reg.hypothesisIds[0], loopId: 'loop-de-loop', phase: 1, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'], worker: (c) => c.route === 'gpt-5.5' ? { route: 'gpt-5.5', summaryOnly: true } : okPacket(c.route, buildMeasuredContent(1000, 0.7)), recordMeasurement });
  assert.equal(badBatch.valid, false);
  assert.equal(badBatch.counted, false);

  // all-valid batch counts and produces a verdict
  const goodBatch = runFullTestBatch(engine, 'b1', { hypothesisId: reg.hypothesisIds[1], loopId: 'loop-de-loop', phase: 1, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'], worker: (c) => okPacket(c.route, buildMeasuredContent(900, 0.86)), recordMeasurement });
  assert.equal(goodBatch.valid, true);
  assert.equal(goodBatch.counted, true);
  assert.equal(goodBatch.verdict, 'MOVED_FRONTIER');
});

// ---- continuous campaign behaviors --------------------------------------
test('improve campaign measures baseline first, then QUEUES a measured win for operator approval (Step 2: no auto-promotion)', () => {
  const { engine } = freshEngine();
  const r = runSupervisedCampaign(engine, {
    runId: 'c-win', task: 'improve the loop',
    targets: [{ kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, benchmark, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'] }]
  }, { worker: mockWorker('win'), maxBatches: 10 });
  assert.equal(r.status, 'OK');
  // Step 2: a measured+reverified win is NOT auto-banked. It is queued to the dashboard
  // for operator Approve — the supervisor never self-promotes.
  assert.equal(r.stones.length, 0, 'no Stone is auto-banked; the win waits for operator approval');
  const steps = r.transcript.map((t) => t.step);
  assert.ok(steps.indexOf('baseline_measured') >= 0, 'baseline measured');
  assert.ok(steps.indexOf('baseline_measured') < steps.indexOf('full_test_batch'), 'baseline measured BEFORE any challenger batch');
  assert.ok(steps.includes('promotion_queued'), 'the measured win is queued to the dashboard for operator Approve');
  assert.ok(!steps.includes('stone_banked'), 'the supervisor does not bank a Stone without operator approval');
});

test('Strip Miner saturation auto-transitions (phase edge, NOT completion)', () => {
  const { engine } = freshEngine();
  const r = runSupervisedCampaign(engine, {
    runId: 'c-sat', task: 'mine',
    targets: [{ kind: 'mine', routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'], benchmark },
      { kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, benchmark, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'] }]
  }, { worker: mockWorker('saturate'), maxBatches: 10 });
  assert.equal(r.status, 'OK');
  assert.ok(r.transcript.some((t) => t.step === 'mine_saturation'));
  // saturation did NOT stop the campaign — it proceeded to the improve target
  assert.ok(r.transcript.some((t) => t.step === 'baseline_measured'));
  assert.doesNotMatch(r.stoppedBy, /saturat|complete/i);
});

test('branch retirement pivots to the next target instead of stopping the campaign', () => {
  const { engine } = freshEngine();
  const r = runSupervisedCampaign(engine, {
    runId: 'c-ret', task: 'improve', noImprovePolicy: 2,
    targets: [
      { kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, benchmark, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'] },
      { kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY_V2, benchmark, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'] }
    ]
  }, { worker: mockWorker('noimprove'), maxBatches: 20 });
  assert.equal(r.status, 'OK');
  assert.ok(r.transcript.filter((t) => t.step === 'branch_retired').length >= 1, 'a branch retired');
  // retirement pivoted to the second target (two baseline_measured = two targets attempted)
  assert.ok(r.transcript.filter((t) => t.step === 'baseline_measured').length >= 2, 'pivoted to the next target after retirement');
  assert.doesNotMatch(r.stoppedBy, /complete/i);
});

test('the supervisor never self-completes; stop is the operator / safety cap', () => {
  const { engine } = freshEngine();
  const r = runSupervisedCampaign(engine, {
    runId: 'c-stop', task: 'improve',
    targets: [{ kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, benchmark, routes: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'] }],
    remineOnEmpty: true, noImprovePolicy: 50
  }, { worker: mockWorker('noimprove'), maxBatches: 4 });
  assert.equal(r.status, 'OK');
  assert.match(r.stoppedBy, /maxBatches-safety-cap \(NOT completion\)/);
  assert.doesNotMatch(r.stoppedBy, /done|complete|finished/i);
});

// ---- gap #1: real Strip Miner candidate extraction ----------------------
test('parseCandidates extracts a real miner candidate block and drops reference_only/public', () => {
  const out = 'analysis...\n<CANDIDATES>[{"loop":"loop-de-loop","title":"refund-flow","baselineContent":"BASE"},{"title":"public-thing","referenceOnly":true},{"title":"copied","copiedFromPublic":true}]</CANDIDATES>\nmore';
  const cands = parseCandidates(out);
  assert.equal(cands.length, 1, 'only the real candidate survives; reference_only/copied are dropped');
  assert.equal(cands[0].title, 'refund-flow');
  assert.deepEqual(parseCandidates('no block here → invent nothing'), []);
});

// ---- gap #2: benchmark evaluates REAL output via an independent judge -----
test('parseJudgeVerdict reads a structured verdict (and a loose fallback)', () => {
  assert.deepEqual(parseJudgeVerdict('<VERDICT>{"winner":"challenger","score":0.9,"notes":"x"}</VERDICT>'), { score: 0.9, winner: 'challenger', notes: 'x' });
  assert.equal(parseJudgeVerdict('winner: challenger score: 0.8').winner, 'challenger');
  assert.equal(parseJudgeVerdict('no verdict'), null);
});

test('judge mode: an independent judge scores real outputs; a win QUEUES to the dashboard (never auto-promotes)', () => {
  const { engine } = freshEngine();
  const judgeWorker = (contract) => {
    if (contract.kind === 'judge') return okPacket(contract.route, '<VERDICT>{"winner":"challenger","score":0.9,"notes":"clearer"}</VERDICT>');
    if (contract.kind === 'baseline') return okPacket(contract.route, 'BASELINE final output');
    return okPacket(contract.route, 'CHALLENGER final output (better)');
  };
  const r = runSupervisedCampaign(engine, {
    runId: 'c-judge', task: 'improve copy',
    targets: [{ kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, routes: ['claude-opus-4-8', 'glm-5.2', 'claude-opus-4-8'],
      benchmark: { mode: 'judge', rubric: 'clearer, more correct', judgeRoute: 'claude-opus-4-8', threshold: 0.6 } }]
  }, { worker: judgeWorker, maxBatches: 10 });
  assert.equal(r.status, 'OK');
  assert.ok(r.transcript.some((t) => t.step === 'judge_verdict' && t.winner === 'challenger'));
  assert.ok(r.transcript.some((t) => t.step === 'subjective_win_queued'));
  assert.equal(r.stones.length, 0, 'judge wins are subjective → dashboard, NEVER auto-promoted to a Stone');
});

test('judge mode refuses a non-builder judge route (judge must match active modelPolicy builders)', () => {
  const { engine } = freshEngine();
  const judgeWorker = (contract) => contract.kind === 'judge'
    ? okPacket(contract.route, '<VERDICT>{"winner":"challenger","score":0.9}</VERDICT>')
    : okPacket(contract.route, 'output');
  const r = runSupervisedCampaign(engine, {
    runId: 'c-jbad', task: 'x',
    targets: [{ kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, routes: ['claude-opus-4-8', 'glm-5.2', 'claude-opus-4-8'],
      benchmark: { mode: 'judge', rubric: 'r', judgeRoute: 'gpt-5.5', threshold: 0.6 } }]
  }, { worker: judgeWorker, maxBatches: 3 });
  assert.ok(r.transcript.some((t) => t.step === 'judge_error' && t.reason === 'JUDGE_ROUTE'), 'gpt-5.5 is a test worker, not a trusted judge under default modelPolicy');
  assert.ok(!r.transcript.some((t) => t.step === 'subjective_win_queued'));
});

test('pending dashboard review does not stop the campaign; model cannot self-resolve', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'c-rev', task: 'Improve precision by at least 10% under benchmark cost.' });
  const q = engine.human_review_request({ runId: 'c-rev', action: 'add', item: { title: 'subjective', kind: 'promotion' } });
  assert.equal(q.status, 'OK');
  assert.equal(engine.human_review_request({ runId: 'c-rev', action: 'resolve', reviewId: q.reviewId, decision: 'approve' }).code, 'DASHBOARD_ONLY');
  assert.equal(engine.campaign_status({ runId: 'c-rev' }).pendingReviewBlocksCampaign, false);
});
