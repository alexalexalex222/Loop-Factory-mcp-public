#!/usr/bin/env node
// End-to-end proof: spawn the real MCP server and drive it over stdio JSON-RPC
// through a full campaign — ask-once, phase-gated streaming of the actual Strip
// miner, BLOCKED states, frozen benchmark, 3–5 frontier hypotheses, a tool-
// measured + reverified promotion, and the dashboard stop-condition notice.
// Writes a transcript + PROOF.md under proof/.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { buildMeasuredContent, DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import { createStore } from '../src/store.mjs';
import { reviewDecisionBinding } from '../src/review-decisions.mjs';
import { BUILDER_GATING_ROUTES, DEFAULT_PRIMARY_MODEL } from '../src/constants.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_HOME = join(ROOT, 'proof', '.super-loop-demo');
rmSync(DEMO_HOME, { recursive: true, force: true });
mkdirSync(join(ROOT, 'proof'), { recursive: true });

const transcript = [];
function log(...a) { const line = a.join(' '); transcript.push(line); console.log(line); }

const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
  cwd: ROOT, env: { ...process.env, SUPER_LOOP_HOME: DEMO_HOME }, stdio: ['pipe', 'pipe', 'pipe']
});

let outBuf = '';
const pending = new Map();
let nextId = 1;
let ready = false;
const readyWaiters = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  outBuf += chunk;
  let nl;
  while ((nl = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, nl).trim();
    outBuf = outBuf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  if (/ready/.test(d)) { ready = true; readyWaiters.splice(0).forEach((r) => r()); }
  process.stderr.write(`[server] ${d}`);
});

function waitReady() { return ready ? Promise.resolve() : new Promise((r) => readyWaiters.push(r)); }
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (msg) => resolve(msg));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args) {
  const res = await request('tools/call', { name, arguments: args });
  return JSON.parse(res.result.content[0].text);
}

const checks = [];
function expect(label, cond) {
  checks.push({ label, ok: !!cond });
  log(`  ${cond ? 'PASS' : 'FAIL'} · ${label}`);
}

async function main() {
  await waitReady();
  const RUN = 'demo-run';

  log('\n=== 1. MCP handshake ===');
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  notify('notifications/initialized');
  log('server:', init.result.serverInfo.name, init.result.serverInfo.version, '· protocol', init.result.protocolVersion);
  const tools = await request('tools/list');
  const toolNames = tools.result.tools.map((t) => t.name);
  log('tools:', toolNames.join(', '));
  expect('server lists all 29 tools incl. autonomous driver + supervisor lanes + live executor + loop library + skill fetch + host detect',
    tools.result.tools.length === 29 && ['run_campaign', 'report_saturation', 'campaign_status', 'execute_full_test', 'continue_run', 'loop_register', 'loop_library', 'skill_fetch', 'host_capability_preflight', 'host_runtime_detect'].every((n) => toolNames.includes(n)));

  log('\n=== 2. Ask-once (vague task → questions) ===');
  const vague = await call('initialize_loop_run', { runId: RUN, task: 'make my loop better', userMessages: ['make my loop better', 'use the FULL strip miner and loop-de-loop'] });
  log('questions:', JSON.stringify(vague.questions, null, 2));
  expect('explain-first brief + a few short questions returned once',
    vague.questions && vague.questions.length >= 5 && vague.questions.length <= 10
    && typeof vague.explanation === 'string' && vague.explanation.length > 80
    && /dashboard is always on/i.test(vague.briefing || '') && vague.dashboardAlwaysOn === true);
  expect('ask-once includes the operator model-choice question (defaults / any model)',
    /which models do you want to use/i.test(vague.questions.join('\n'))
    && /defaults|any model/i.test(vague.questions.join('\n')));
  expect('ask-once never poses promotion-mode / 3000-char policy choices to the operator',
    !/promotion mode/i.test(vague.questions.join('\n'))
    && !/char ?cap|3000\s*char/i.test(vague.questions.join('\n'))
    && /you choose the models/i.test(vague.explanation || ''));

  log('\n=== 3. Answer once → INITIALIZED (never asks again) ===');
  // answers: goal, path, start-from, scope/order, better, hard-limit, models, deeper
  const initd = await call('initialize_loop_run', { runId: RUN, answers: ['3+ qualified loops per corpus', 'my local loop sources', 'my local loop sources', 'whole history, best first', 'tokens down, replay pass-rate up, no proof loss', 'keep my authorship', 'defaults', 'keep moving after the brief'] });
  log('status:', initd.status, '· model:', initd.model.primary, '· policy:', initd.modelPolicy && initd.modelPolicy.banlist.mode);
  expect('initialized with no further questions', initd.status === 'OK' && !initd.questions);
  expect('init surfaces the stop-condition notice up front', initd.stopCondition === 'WARNING: You are the stop condition. This loop does not stop until you stop it.');
  expect('defaults model policy persisted on the run (primary + banlist default)',
    initd.modelPolicy && initd.modelPolicy.primary === DEFAULT_PRIMARY_MODEL && initd.modelPolicy.banlist.mode === 'default');
  const [routeA, routeB, routeC] = initd.modelPolicy.testRoutes;

  log('\n=== 3b. Deeper explanation honored only when asked (leak #2) ===');
  expect('no deeper explanation when the operator says keep moving', !initd.deeperExplanation);
  const deeper = await call('initialize_loop_run', { runId: RUN, answers: ['3+ loops', 'my loop sources', 'tokens + replay', 'no proof loss', 'yes, explain deeper before you start'] });
  expect('answering the last question yes returns a deeper explanation, no re-ask/no block', deeper.status === 'OK' && !deeper.questions && /How Loop Factory actually enforces this/.test(deeper.deeperExplanation || ''));

  log('\n=== 3c. Host capability preflight (PATH only, no exec) ===');
  const pre = await call('host_capability_preflight', { runId: RUN });
  log('installed frontier CLIs on PATH:', pre.installed.join(', ') || '(none)');
  expect('preflight reports known routes via PATH detection, no command executed',
    pre.status === 'OK' && Array.isArray(pre.routes) && pre.routes.some((r) => r.name === 'claude') && /no command executed/i.test(pre.method));

  log('\n=== 3d. Local loop library — register + list + stream a custom loop (leak #1) ===');
  const customText = [
    '# INTAKE', 'Read the operator goal and the frozen benchmark before touching anything.',
    '', '# MEASURE', 'Run the candidate and record the raw log so the MCP derives the cost.',
    '', '# DECIDE', 'Promote only on tool-computed, reverified frontier movement; else continue.'
  ].join('\n');
  const regLoop = await call('loop_register', { runId: RUN, id: 'demo-custom-loop', title: 'Demo Custom Loop', content: customText });
  log('registered:', regLoop.loop && regLoop.loop.id, '· sections', regLoop.loop && regLoop.loop.sections, '· sha256', regLoop.loop && regLoop.loop.sha256.slice(0, 12));
  expect('custom loop registered, hash-locked, phase-gated', regLoop.status === 'OK' && regLoop.loop.origin === 'custom' && regLoop.loop.sections >= 2);
  const collide = await call('loop_register', { runId: RUN, id: 'strip-miner', title: 'hijack', content: customText });
  expect('cannot overwrite a mandated hash-locked loop', collide.status === 'BLOCKED' && collide.code === 'LOOP_EXISTS');
  const lib = await call('loop_library', { runId: RUN });
  expect('library lists 2 mandated + the custom loop', lib.mandated.length === 2 && lib.custom.some((c) => c.id === 'demo-custom-loop'));
  const cs0 = await call('loop_start', { runId: RUN, loop: 'demo-custom-loop' });
  expect('custom loop streams section 0 through the same phase gate', cs0.status === 'OK' && cs0.phase === 0 && cs0.totalPhases >= 2);
  const cskip = await call('request_next_phase', { runId: RUN, loop: 'demo-custom-loop' });
  expect('custom loop also blocks PHASE_SKIP without evidence', cskip.status === 'BLOCKED' && cskip.code === 'PHASE_SKIP');
  await call('observation_record', { runId: RUN, loop: 'demo-custom-loop', phase: 0, summary: 'read operator goal + frozen benchmark' });
  const cs1 = await call('request_next_phase', { runId: RUN, loop: 'demo-custom-loop' });
  expect('evidence unlocks the custom loop next section', cs1.status === 'OK' && cs1.phase === 1);

  log('\n=== 4. Phase-gated streaming of the actual Strip Miner ===');
  const s0 = await call('loop_start', { runId: RUN, loop: 'strip-miner' });
  log(`phase ${s0.phase + 1}/${s0.totalPhases}: ${s0.title}`);
  log('section[0] head:', JSON.stringify(s0.section.slice(0, 120)));
  expect('section 0 carries the /loop loop-de-loop trigger', s0.section.includes('/loop loop-de-loop'));
  expect('only one section streamed (not the whole 345-line file)', s0.section.length < 3000 && s0.totalPhases > 5);

  const skip = await call('request_next_phase', { runId: RUN });
  log('skip attempt:', skip.status, skip.code);
  expect('request_next_phase BLOCKED without evidence (PHASE_SKIP)', skip.status === 'BLOCKED' && skip.code === 'PHASE_SKIP');

  await call('observation_record', { runId: RUN, loop: 'strip-miner', phase: 0, summary: 'discovered accessible agent-session sources across the machine' });
  const s1 = await call('request_next_phase', { runId: RUN });
  log(`advanced to phase ${s1.phase + 1}/${s1.totalPhases}: ${s1.title}`);
  expect('evidence unlocks the next section', s1.status === 'OK' && s1.phase === 1);

  log('\n=== 4b. Supervisor: Strip Miner saturation AUTO-TRANSITIONS to Loop-de-loop (never stops) ===');
  const sat = await call('report_saturation', { runId: RUN, evidence: 'final confirmation batch changed nothing material' });
  log('saturation →', sat.transition && `${sat.saturatedLane.kind} lane → ${sat.transition.toLoop}`);
  expect('saturation auto-transitions to loop-de-loop, not a stop',
    sat.status === 'OK' && sat.autoTransitioned === true && sat.transition.toLoop === 'loop-de-loop' && sat.continuation.required === true);
  const cs = await call('campaign_status', { runId: RUN });
  expect('campaign_status reports lanes; pending review never blocks; 30-batch retirement; active modelPolicy',
    cs.status === 'OK' && cs.runStatus === 'ACTIVE' && cs.pendingReviewBlocksCampaign === false
    && cs.branchRetirementThreshold === 30 && Array.isArray(cs.lanes) && cs.lanes.length >= 2
    && cs.modelPolicy && cs.modelPolicy.banlist && cs.modelPolicy.banlist.mode === 'default'
    && JSON.stringify(cs.builderGatingRoutes) === JSON.stringify(cs.modelPolicy.builderRoutes)
    && JSON.stringify(cs.modelPolicy.builderRoutes) === JSON.stringify(BUILDER_GATING_ROUTES));

  log('\n=== 5. Benchmark-first: hash-lock baseline, freeze scorecard, set the bar ===');
  const baselineFixture = [
    '## Demo Fixture — Baseline Strip Miner v1 (frozen copy)',
    '',
    'This artifact is demo fixture content recorded by `scripts/demo.mjs` to exercise the',
    'benchmark-first gate end-to-end. It stands in for "the loop as it existed before this',
    'cycle\'s improvement attempt" — a hash-locked baseline the challenger hypotheses must',
    'beat. It is not the real Strip Miner loop; the real loop is the private 345-line',
    'source hash-locked inside `loops/strip-miner.txt` and streamed separately through the',
    'phase gate.',
    '',
    '## Baseline procedure summary',
    '',
    '1. Discover every accessible agent-session source across the machine the operator',
    '   has authorized.',
    '2. Read each session\'s recorded tool trace and extract the workflow steps that',
    '   produced a real, verifiable result.',
    '3. Score each candidate workflow against replay pass-rate, evidence fidelity, and',
    '   token cost.',
    '4. Freeze the highest-scoring workflows as the baseline reference for this',
    '   improvement cycle.',
    '',
    '## What the baseline-integrity floor checks',
    '',
    'The engine\'s baseline-integrity floor rejects a baseline that is too thin or lacks',
    'real structure, so a worker cannot register a trivial stand-in and then promote weak',
    'challengers against it. A genuine baseline carries real prose, real steps, and enough',
    'length to be worth beating.',
    '',
    '## Scope of this fixture',
    '',
    'Nothing in this fixture is executed by the demo. Its only job is to give the',
    'baseline-integrity floor real content to evaluate: sufficient estimated token length',
    'and at least three markdown section headers, exactly like a genuine recorded',
    'baseline would have.'
  ].join('\n');
  const baselineRec = await call('artifact_record', { runId: RUN, role: 'baseline', name: 'baseline-miner.txt', content: baselineFixture });
  expect('baseline fixture recorded + hash-locked', baselineRec.status === 'OK');
  const prop = await call('benchmark_propose', { runId: RUN, benchmarks: [{
    name: 'miner-yield-vs-cost',
    taskValueDimensions: ['qualified-loops', 'evidence-fidelity', 'contradiction-coverage'],
    resourceDimensions: ['token-cost', 'reader-waves'],
    cases: [{ id: 'corpusA', input: 'claude+codex sessions', expect: '>=3 HIGH-confidence loops' }],
    oracle: DEFAULT_QUALITY_ORACLE // deterministic → quality is tool-computed from the recorded bytes
  }] });
  await call('benchmark_select', { runId: RUN, benchmarkId: prop.benchmarkIds[0] });
  // The MCP derives the bar from the recorded run-log bytes; we never hand it a bare number.
  const barRef = (await call('artifact_record', { runId: RUN, name: 'baseline-bar', role: 'runlog', content: buildMeasuredContent(1000, 0.70), measurement: { tokenCost: 1000, quality: 0.70 } })).artifactId;
  const bar = await call('benchmark_run', { runId: RUN, arm: 'baseline', measurementRef: barRef });
  log('baseline bar:', JSON.stringify(bar.baselineScore), '· qAuthority', bar.baselineScore.qualityAuthority);
  expect('benchmark frozen + tool-computed bar set', bar.status === 'OK' && bar.baselineScore.quality === 0.70 && bar.baselineScore.qualityAuthority === 'tool-computed');

  log('\n=== 5b. A caller-reported (typed) measurement is refused by the gate ===');
  const crRef = (await call('artifact_record', { runId: RUN, name: 'typed-number', role: 'runlog', content: 'I promise it cost 1 and scored 0.99', measurement: { tokenCost: 1, quality: 0.99 }, callerReported: true })).artifactId;
  const crBar = await call('benchmark_run', { runId: RUN, arm: 'baseline', measurementRef: crRef });
  expect('caller-reported measurement rejected (MEASUREMENT_AUTHORITY)', crBar.status === 'BLOCKED' && crBar.code === 'MEASUREMENT_AUTHORITY');

  log('\n=== 6. Hypotheses: reject non-frontier under default banlist, accept 3–5 frontier ===');
  const mini = await call('register_hypotheses', { runId: RUN, hypotheses: [
    { title: 'cheap', route: { model: 'claude-haiku-4-5' } }, { title: 'b', route: { model: 'gpt-5.5' } }, { title: 'c', route: { model: 'glm-5.2' } }
  ] });
  log('mini attempt:', mini.status, mini.code);
  expect('haiku route rejected under default banlist (BANNED_ROUTE)', mini.status === 'BLOCKED' && mini.code === 'BANNED_ROUTE');

  const codexBuild = await call('register_hypotheses', { runId: RUN, hypotheses: [
    { title: 'a', route: { model: 'claude-opus-4-8' }, builderRoute: 'codex' }, { title: 'b', route: { model: 'gpt-5.5' } }, { title: 'c', route: { model: 'glm-5.2' } }
  ] });
  expect('Codex as in-loop BUILDER is refused under default modelPolicy builders', codexBuild.status === 'BLOCKED' && codexBuild.code === 'BUILDER_ROUTE');

  // Separate run: banlist-off accepts a previously-banned route; banned primary holds for confirmation.
  log('\n=== 6b. Model policy: any-model run + banned-choice confirmation ===');
  const anyRun = await call('initialize_loop_run', {
    runId: 'demo-any-model',
    task: 'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.',
    modelPolicy: { banlist: { mode: 'off' }, primary: 'claude-opus-4-8' }
  });
  expect('"any model" / banlist-off policy initializes', anyRun.status === 'OK' && anyRun.modelPolicy && anyRun.modelPolicy.banlist.mode === 'off');
  // Floor-passing baseline + bar for the any-model run so register can proceed.
  const anyBaseline = [
    '## Purpose',
    'Demo baseline for banlist-off policy check. '.repeat(40),
    '## Procedure',
    'Record phases, measure, reverify. '.repeat(40),
    '## Acceptance',
    'Quality holds at equal or lower cost. '.repeat(40)
  ].join('\n');
  await call('artifact_record', { runId: 'demo-any-model', role: 'baseline', name: 'b.md', content: anyBaseline });
  const anyProp = await call('benchmark_propose', { runId: 'demo-any-model', benchmarks: [{
    name: 'any-pol', taskValueDimensions: ['q'], resourceDimensions: ['c'],
    cases: [{ id: 'c1', input: 'i', expect: 'e' }], oracle: DEFAULT_QUALITY_ORACLE
  }] });
  await call('benchmark_select', { runId: 'demo-any-model', benchmarkId: anyProp.benchmarkIds[0] });
  const anyBarRef = (await call('artifact_record', {
    runId: 'demo-any-model', name: 'bar', role: 'runlog',
    content: buildMeasuredContent(1000, 0.70), measurement: { tokenCost: 1000, quality: 0.70 }
  })).artifactId;
  await call('benchmark_run', { runId: 'demo-any-model', arm: 'baseline', measurementRef: anyBarRef });
  const anyReg = await call('register_hypotheses', { runId: 'demo-any-model', hypotheses: [
    { title: 'cheap-ok', route: { model: 'claude-haiku-4-5' } },
    { title: 'b', route: { model: 'gpt-5.5' } },
    { title: 'c', route: { model: 'glm-5.2' } }
  ] });
  expect('"any model" run accepts a previously-banned haiku route', anyReg.status === 'OK' && anyReg.hypothesisIds && anyReg.hypothesisIds.length === 3);

  const confHold = await call('initialize_loop_run', {
    runId: 'demo-ban-confirm',
    task: 'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.',
    model: 'claude-haiku-4-5'
  });
  expect('banned primary holds at AWAITING_ANSWERS with needsConfirmation (never silent accept)',
    confHold.status === 'OK'
    && confHold.needsConfirmation === true
    && confHold.runStatus === 'AWAITING_ANSWERS'
    && confHold.confirmation && confHold.confirmation.requested === 'claude-haiku-4-5'
    && Array.isArray(confHold.questions) && confHold.questions.length === 1);
  const confResolve = await call('initialize_loop_run', {
    runId: 'demo-ban-confirm',
    answers: ['use it anyway']
  });
  expect('confirmation "use it anyway" initializes with banlist off + requested primary (no re-ask)',
    confResolve.status === 'OK'
    && confResolve.runStatus === 'INITIALIZED'
    && confResolve.needsConfirmation === false
    && confResolve.modelPolicy && confResolve.modelPolicy.banlist.mode === 'off'
    && confResolve.model && confResolve.model.primary === 'claude-haiku-4-5');

  const reg = await call('register_hypotheses', { runId: RUN, hypotheses: [
    { title: 'restructure reader routing', bottleneck: 'precision', operation: 'restructure', route: { model: routeA } },
    { title: 'add contradiction sweep gate', bottleneck: 'false positives', operation: 'verify', route: { model: routeB } },
    { title: 'compress evidence schema', bottleneck: 'cost', operation: 'remove', route: { model: routeC } }
  ] });
  log('registered:', reg.hypothesisIds.join(', '));
  expect('3 frontier hypotheses accepted', reg.status === 'OK' && reg.hypothesisIds.length === 3);
  const winner = reg.hypothesisIds[0];

  log('\n=== 7. Full test (3 frontier agents, tool-measured) ===');
  const refs = [];
  for (const [m, c, q] of [[routeA, 1010, 0.80], [routeB, 1000, 0.83], [routeC, 1015, 0.82]]) {
    refs.push({ model: m, measurementRef: (await call('artifact_record', { runId: RUN, name: `run-${m}`, role: 'runlog', content: buildMeasuredContent(c, q), measurement: { tokenCost: c, quality: q } })).artifactId });
  }
  const ft = await call('test_hypothesis', { runId: RUN, hypothesisId: winner, fullTest: { agentRuns: refs } });
  log('full test verdict:', ft.verdict, '· quality', ft.aggregate.quality, 'vs bar 0.70 · qAuthority', ft.qualityAuthority, '·', ft.movement.message);
  expect('measured full test moved the frontier (tool-computed quality)', ft.verdict === 'MOVED_FRONTIER' && ft.qualityAuthority === 'tool-computed');

  log('\n=== 8. Promotion needs reverify; model-report path stays blocked ===');
  const early = await call('promotion_request', { runId: RUN, hypothesisId: winner });
  expect('promotion blocked before reverify', early.status === 'BLOCKED' && early.code === 'NOT_REVERIFIED');
  const rv = await call('reverify_run', { runId: RUN, testId: ft.testId });
  expect('deep reverify passes on sealed artifacts', rv.status === 'OK' && rv.reverified === true);
  const queued = await call('promotion_request', { runId: RUN, hypothesisId: winner });
  log('promotion (pre-approval):', queued.status, '·', queued.message);
  expect('supervisor refuses to self-ship — promotion queued for operator review',
    queued.status === 'BLOCKED' && queued.code === 'PROMOTION_NEEDS_APPROVAL' && !!queued.queuedReviewId);

  log('\n=== 8b. Operator step: Approve the queued review out-of-band via apply-decisions.mjs ===');
  const decisionsPath = join(ROOT, 'proof', 'demo-decisions.json');
  const demoStore = createStore(DEMO_HOME);
  const demoState = demoStore.load(RUN);
  const demoReview = demoState.humanReviews.find((review) => review.id === queued.queuedReviewId);
  writeFileSync(decisionsPath, JSON.stringify({
    runId: RUN,
    decisions: {
      [queued.queuedReviewId]: {
        decision: 'approve',
        notes: 'demo operator approval',
        reviewSha256: reviewDecisionBinding(demoState, demoReview)
      }
    }
  }, null, 2));
  const applyOut = execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'apply-decisions.mjs'), '--file', decisionsPath, '--run', RUN, '--home', DEMO_HOME
  ], { encoding: 'utf8' });
  log('apply-decisions:', applyOut.trim());
  const applyRes = JSON.parse(applyOut);
  expect('operator Approve applied out-of-band (apply-decisions.mjs, not the model)',
    applyRes.ok === true && applyRes.applied.some((a) => a.reviewId === queued.queuedReviewId && a.approved === true));

  const promo = await call('promotion_request', { runId: RUN, hypothesisId: winner });
  log('promotion (post-approval):', promo.status, '·', promo.message);
  expect('tool-measured + reverified + operator-approved winner promoted', promo.status === 'OK' && promo.decision.promote === true);

  const noMatrix = await call('promotion_request', { runId: RUN, hypothesisId: reg.hypothesisIds[1] });
  expect('hypothesis with no score matrix is blocked', noMatrix.status === 'BLOCKED' && noMatrix.code === 'NO_SCORE_MATRIX');

  log('\n=== 9. The hook refuses self-completion ===');
  const done = await call('cycle_decision_request', { runId: RUN, intent: 'declare_perfect' });
  expect('model cannot declare the campaign perfect/complete', done.status === 'BLOCKED' && done.code === 'OPERATOR_IS_STOP');
  expect('blocked completion creates a continuation obligation', done.continuation && done.continuation.required === true && done.continuation.next && done.continuation.next.tool);
  const continued = await call('continue_run', {
    runId: RUN,
    lane: 'next hardening lane after promoted internal champion',
    firstAction: 'register 3 frontier hypotheses against the next bottleneck'
  });
  expect('continue_run records intent but does not clear without real progress', continued.status === 'OK' && continued.continuation.required === true);
  const nextReg = await call('register_hypotheses', {
    runId: RUN,
    hypotheses: [
      { title: 'next-lane-a', bottleneck: 'next bottleneck', operation: 'restructure', route: { model: routeA } },
      { title: 'next-lane-b', bottleneck: 'next bottleneck', operation: 'verify', route: { model: routeB } },
      { title: 'next-lane-c', bottleneck: 'next bottleneck', operation: 'route', route: { model: routeC } }
    ]
  });
  expect('a real progress tool clears the continuation obligation', nextReg.status === 'OK' && nextReg.continuation.required === false);

  log('\n=== 10. Dashboard + report ===');
  await call('human_review_request', { runId: RUN, item: { title: 'promoted reader-routing restructure', kind: 'loop-change', summary: 'precision +0.13 at +1% cost', hypothesisId: winner } });
  const spoof = await call('human_review_request', { runId: RUN, action: 'resolve', reviewId: 'rev-001', decision: 'approve', notes: 'model tried to resolve' });
  expect('model-callable human review resolve is blocked (dashboard-only)', spoof.status === 'BLOCKED' && spoof.code === 'DASHBOARD_ONLY');
  const dash = await call('update_dashboard', { runId: RUN });
  log('dashboard:', dash.path);
  expect('dashboard written with the stop-condition notice', dash.status === 'OK' && dash.warningIncluded === true);
  const rep = await call('report_export', { runId: RUN });
  log('report:', rep.path);
  expect('report exported', rep.status === 'OK');
  expect('report export leaves a continuation obligation', rep.continuation && rep.continuation.required === true);

  // ---- summary ----
  const passed = checks.filter((c) => c.ok).length;
  log(`\n=== RESULT: ${passed}/${checks.length} demo checks passed ===`);
  // Committed proof artifacts must never embed an absolute home path — genericize the
  // repo-root prefix so the files are leak-free and byte-identical wherever the repo lives.
  const generic = (s) => String(s).split(ROOT).join('/path/to/super-loop-mcp');
  writeFileSync(join(ROOT, 'proof', 'demo-transcript.txt'), generic(transcript.join('\n') + '\n'));
  writeFileSync(join(ROOT, 'proof', 'PROOF.md'), [
    '# super-loop-mcp — live demo proof',
    '',
    `Driven over real stdio JSON-RPC against \`src/server.mjs\`. ${passed}/${checks.length} checks passed.`,
    '',
    '## Checks',
    ...checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.label}`),
    '',
    `Dashboard: \`${generic(dash.path)}\``,
    `Report: \`${generic(rep.path)}\``,
    `Transcript: \`proof/demo-transcript.txt\``,
    '',
    '_The campaign ended promoted, but not complete. The operator is the only stop condition._'
  ].join('\n') + '\n');

  child.stdin.end();
  child.kill();
  if (passed !== checks.length) { console.error('DEMO FAILED'); process.exit(1); }
  console.log('DEMO OK');
  process.exit(0);
}

main().catch((e) => { console.error('demo error:', e); child.kill(); process.exit(1); });
