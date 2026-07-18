// Loop Factory Supervisor — the ACTIVE harness around worker models.
//
// The correction this module exists for: MCP tools are passive; a model voluntarily
// calling a tool is not enforcement. The supervisor OWNS the transaction:
//
//   compile phase contract → dispatch worker → validate worker output →
//   supervisor-run evals/tools → accepted transition  OR  re-enter/retry/replace
//
// Worker models produce artifacts / transition packets. They do NOT commit progress,
// promote, decide they are done, or own the stop condition. Only a supervisor-accepted
// transition is progress. The operator is the only campaign stop condition.
//
// Workers are INJECTED (`worker(contract) -> packet`), so the whole enforcement
// boundary is provable with mock workers — no command execution required. The real
// executor (src/executor.mjs) is just one worker backend.
import { verifyAllLoops, loadLoop } from './loops.mjs';
import { sha256 } from './util.mjs';
import { DEFAULTS } from './constants.mjs';
import { isBuilderGatingRoute, defaultModelPolicy, normalizeModelPolicy } from './models.mjs';

export const MISSING_FULL_PRIVATE_LOOPS = 'MISSING_FULL_PRIVATE_LOOPS';

// Floor-passing scaffold when a target omits baselineContent. The thin
// `BASELINE ${loopId}` stub (~29 tokens) fails BASELINE_TOO_SHALLOW and makes
// copy-paste campaigns dead on arrival — never use it as a fallback.
export function floorBaselineScaffold(label = 'loop') {
  const id = String(label || 'loop');
  return [
    '## Purpose',
    `Operator/scaffold baseline for "${id}". This is the reference a challenger must beat. It describes a real multi-phase improvement procedure with durable reader waves, evidence gates, and tool-measured scorecards so the baseline integrity floor accepts the bytes as a bar rather than a placeholder stub.`,
    '',
    '## Procedure',
    'Stream each phase with recorded evidence. Reproduce the bottleneck on the smallest input. Freeze a scorecard before challengers. Measure cost and quality from sealed bytes. Never promote on a summary or confidence claim alone. Reverify from sealed artifacts before any promotion request.',
    '',
    '## Acceptance',
    'A candidate qualifies only when measured quality holds at equal or lower token cost and the result reverifies. The operator is the only stop condition. Prefer replacing this scaffold with the real loop text when available.'
  ].join('\n');
}

function resolveBaselineContent(target, loopId) {
  if (typeof target.baselineContent === 'string' && target.baselineContent.trim().length > 0) {
    return target.baselineContent;
  }
  return floorBaselineScaffold(loopId);
}

// Loads + hashes the full private loops. Returns the manifest, or the exact
// MISSING_FULL_PRIVATE_LOOPS sentinel if a file is absent / drifted. Never invents a
// replacement.
export function requireFullLoops(verify = verifyAllLoops) {
  try {
    const manifest = verify();
    if (!Array.isArray(manifest) || manifest.length < 2) return { ok: false, sentinel: MISSING_FULL_PRIVATE_LOOPS };
    return { ok: true, manifest };
  } catch {
    return { ok: false, sentinel: MISSING_FULL_PRIVATE_LOOPS };
  }
}

// Parse loop candidates a real Strip Miner worker emitted. Workers return candidates
// as a JSON array inside <CANDIDATES>…</CANDIDATES> (or a ```json fence). Public
// references are reference_only and are dropped — never turned into a candidate.
export function parseCandidates(text) {
  const s = String(text || '');
  const m = s.match(/<CANDIDATES>([\s\S]*?)<\/CANDIDATES>/i) || s.match(/```json\s*([\s\S]*?)```/i);
  const blob = (m ? m[1] : s).trim();
  try {
    const arr = JSON.parse(blob);
    if (Array.isArray(arr)) {
      return arr
        .filter((c) => c && (c.loop || c.title) && c.referenceOnly !== true && c.copiedFromPublic !== true)
        .map((c) => ({ loop: c.loop || 'loop-de-loop', title: c.title || c.loop, baselineContent: c.baselineContent || null, evidenceRef: c.evidenceRef || null }));
    }
  } catch { /* no parseable candidate block → no candidates (do not invent one) */ }
  return [];
}

// Parse an INDEPENDENT judge's structured verdict (for benchmarks that score real
// final outputs, not a deterministic oracle). The judge — not the challenger —
// reports the score, and the supervisor parses it; the challenger never scores itself.
export function parseJudgeVerdict(text) {
  const s = String(text || '');
  const m = s.match(/<VERDICT>([\s\S]*?)<\/VERDICT>/i) || s.match(/```json\s*([\s\S]*?)```/i);
  const blob = (m ? m[1] : s).trim();
  try {
    const v = JSON.parse(blob);
    if (v && typeof v === 'object') {
      const score = Number(v.score);
      const winner = String(v.winner || '').toLowerCase();
      if (score >= 0 && score <= 1) return { score, winner: winner || 'unknown', notes: v.notes || null };
    }
  } catch { /* fall through to loose parse */ }
  const sc = s.match(/score\s*[:=]\s*(0?\.\d+|1(?:\.0)?)/i);
  if (sc) return { score: Number(sc[1]), winner: /winner\s*[:=]\s*challenger/i.test(s) ? 'challenger' : (/winner\s*[:=]\s*baseline/i.test(s) ? 'baseline' : 'unknown'), notes: null };
  return null;
}

// Parse a model-produced worker packet without trusting its evidence claims. The raw
// captured CLI envelope remains the only runlog artifact; model-supplied `artifacts`
// are ignored so the worker cannot manufacture tool ownership.
export function parseWorkerPacket(text, { route = null, invocation = null } = {}) {
  const raw = String(text || '');
  const match = raw.match(/<WORKER_PACKET>([\s\S]*?)<\/WORKER_PACKET>/i)
    || raw.match(/```json\s*([\s\S]*?)```/i);
  const blob = (match ? match[1] : raw).trim();
  let parsed = null;
  try { parsed = JSON.parse(blob); } catch { /* malformed packet stays summary-only */ }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      route,
      artifacts: raw.trim() ? [{ role: 'runlog', content: raw }] : [],
      finalOutput: '',
      summaryOnly: true,
      invocation
    };
  }
  return {
    route: route || (typeof parsed.route === 'string' ? parsed.route : null),
    phase: Number.isInteger(parsed.phase) ? parsed.phase : undefined,
    stoppedEarly: parsed.stoppedEarly === true,
    summaryOnly: parsed.summaryOnly === true,
    copiedFromPublic: parsed.copiedFromPublic === true,
    claim: parsed.claim && typeof parsed.claim === 'object' ? parsed.claim : {},
    artifacts: raw.trim() ? [{ role: 'runlog', content: raw }] : [],
    finalOutput: typeof parsed.finalOutput === 'string' ? parsed.finalOutput : raw,
    invocation
  };
}

// Dispatch an independent judge to compare baseline vs challenger FINAL OUTPUTS under
// a frozen rubric. The judge must be a trusted builder/gating route under the active
// modelPolicy (defaults: Opus/GLM). The judge prompt is the rubric + the two outputs
// (not a loop slice). policy is optional; omit → default policy.
function dispatchJudge(baselineOutput, challengerOutput, rubric, judgeRoute, worker, log, policy) {
  const pol = policy ? normalizeModelPolicy(policy) : defaultModelPolicy();
  if (!isBuilderGatingRoute(judgeRoute, pol)) {
    return { error: 'JUDGE_ROUTE', message: `judge must run on a trusted builder/gating route (${pol.builderRoutes.join(' or ')} under active modelPolicy; fallback primary ${pol.primary}), not ${judgeRoute}` };
  }
  const contract = {
    loopId: 'judge', loopSha: 'judge', phase: 0, kind: 'judge', route: judgeRoute,
    slice: `You are an INDEPENDENT judge. Compare the BASELINE and CHALLENGER final outputs strictly under the rubric. Reply with ONLY <VERDICT>{"winner":"challenger"|"baseline"|"tie","score":0..1,"notes":"..."}</VERDICT> where score is the challenger's quality.\nRUBRIC:\n${rubric}\n\nBASELINE OUTPUT:\n${baselineOutput}\n\nCHALLENGER OUTPUT:\n${challengerOutput}`,
    task: 'judge baseline vs challenger', requires: ['runlog'], evidenceRequired: false, mustProduceComparableOutput: true
  };
  const d = dispatchWorker(contract, worker, { log });
  if (!d.accepted) return { error: 'JUDGE_INVALID', reasons: d.reasons };
  const verdict = parseJudgeVerdict(d.packet.finalOutput);
  if (!verdict) return { error: 'JUDGE_UNPARSEABLE' };
  return { verdict };
}

// Compile a phase contract: the worker receives ONLY the needed phase SLICE plus the
// loop hash (proof the full loop was loaded) — never the whole crown-jewel loop.
export function compilePhaseContract(loopId, phaseIndex, opts = {}) {
  const loop = loadLoop(loopId); // throws if hash/line drift — full-loop integrity
  const section = loop.sections[phaseIndex] || loop.sections[0];
  return {
    loopId,
    loopSha: loop.sha256,
    phase: phaseIndex,
    phaseTitle: section.title,
    slice: section.body, // ONLY this section, not the full loop
    sliceSha: sha256(section.body),
    totalPhases: loop.sections.length,
    kind: opts.kind || 'challenger',
    route: opts.route || null,
    task: opts.task || '',
    requirements: Array.isArray(opts.requirements) ? opts.requirements : [], // exact hard reqs from the ledger
    requires: Array.isArray(opts.requires) ? opts.requires : ['runlog'],
    mustProduceComparableOutput: opts.mustProduceComparableOutput !== false,
    evidenceRequired: opts.evidenceRequired !== false
  };
}

// THE ENFORCEMENT BOUNDARY. Validates a worker packet against its contract. The
// supervisor never trusts a worker's claims; this is what makes a transition count.
// Returns { accepted, reasons }. Reason codes map 1:1 to the worker-invalidation spec.
export function validateWorkerPacket(contract, packet) {
  const reasons = [];
  if (!packet || typeof packet !== 'object') return { accepted: false, reasons: ['NO_PACKET'] };
  const artifacts = Array.isArray(packet.artifacts) ? packet.artifacts : [];
  const finalOutput = packet.finalOutput != null ? String(packet.finalOutput) : '';
  const claim = packet.claim && typeof packet.claim === 'object' ? packet.claim : {};

  // structural / honesty checks
  if (packet.stoppedEarly === true) reasons.push('EARLY_STOP');
  if (packet.summaryOnly === true || (artifacts.length === 0 && !finalOutput.trim())) reasons.push('SUMMARY_ONLY');
  const roles = new Set(artifacts.map((a) => a && a.role));
  for (const need of contract.requires || []) if (!roles.has(need)) { reasons.push('MISSING_ARTIFACTS'); break; }
  if (contract.evidenceRequired && !artifacts.some((a) => a && a.content != null && String(a.content).trim().length > 0)) reasons.push('MISSING_EVIDENCE');
  if (contract.mustProduceComparableOutput && !finalOutput.trim()) reasons.push('NO_COMPARABLE_OUTPUT');
  if (packet.phase != null && contract.phase != null && packet.phase !== contract.phase) reasons.push('PHASE_SKIP');
  if (packet.copiedFromPublic === true || artifacts.some((a) => a && a.copiedFromPublic === true)) reasons.push('COPIED_PUBLIC');

  // self-report / self-authority checks — a worker can never report metrics-as-proof,
  // promote itself, declare done, or stop the campaign.
  if (claim.metricsSelfReported === true || claim.metrics != null) reasons.push('MODEL_REPORTED_METRIC');
  if (claim.promoted === true || claim.done === true || claim.complete === true) reasons.push('SELF_PROMOTION');
  if (claim.stopCampaign === true) reasons.push('SELF_STOP');

  return { accepted: reasons.length === 0, reasons: [...new Set(reasons)] };
}

// The dispatch transaction with re-entry. On invalid output the supervisor
// retries/replaces the worker up to maxRetries; it never accepts the bad packet.
export function dispatchWorker(contract, worker, { maxRetries = 2, log = () => {}, onVerdict = () => {} } = {}) {
  let last = { accepted: false, reasons: ['NO_PACKET'] };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let packet = null;
    // Pass attempt inside the contract (a single positional arg) so a worker's own
    // 2nd parameter (e.g. executorWorker's env) is never clobbered.
    try { packet = worker({ ...contract, attempt }); } catch (e) { packet = { __error: e && e.message }; }
    const v = validateWorkerPacket(contract, packet);
    last = { ...v, packet, attempt };
    try {
      onVerdict({
        accepted: v.accepted,
        reasons: [...v.reasons],
        attempt,
        contract: {
          loopId: contract.loopId,
          phase: contract.phase,
          kind: contract.kind,
          route: contract.route
        },
        invocation: packet && packet.invocation ? packet.invocation : null
      });
    } catch { /* evidence journaling cannot change the worker verdict */ }
    if (v.accepted) { log(`  worker ${contract.route || ''} phase ${contract.phase} accepted (attempt ${attempt + 1})`); return last; }
    log(`  worker ${contract.route || ''} REJECTED (${v.reasons.join(',')}) → re-enter (attempt ${attempt + 1}/${maxRetries + 1})`);
  }
  return last; // exhausted retries; caller treats as an invalid worker (does not count)
}

// One FullTestBatch = ONE hypothesis tested by 3-5 frontier workers that each
// actually produce comparable output. The supervisor validates EVERY worker before
// any measurement; if any worker is invalid the batch is invalid and is NOT counted.
// Valid batches are measured + delta-computed by the engine (the supervisor's evals).
export function runFullTestBatch(engine, runId, { hypothesisId, loopId, phase, task, routes, requirements, worker, recordMeasurement, log = () => {} }) {
  if (!Array.isArray(routes) || routes.length < DEFAULTS.fullTestAgentsMin || routes.length > DEFAULTS.fullTestAgentsMax) {
    return { valid: false, reason: 'FULLTEST_AGENTS', counted: false };
  }
  const agentRuns = [];
  for (const route of routes) {
    const contract = compilePhaseContract(loopId, phase, { kind: 'challenger', route, task, requirements });
    const d = dispatchWorker(contract, worker, { log });
    if (!d.accepted) return { valid: false, reason: d.reasons.join(','), counted: false }; // invalid batch never counts
    const ref = recordMeasurement(d.packet, route);
    if (!ref) return { valid: false, reason: 'MEASUREMENT_FAILED', counted: false };
    agentRuns.push({ model: route, measurementRef: ref });
  }
  const res = engine.test_hypothesis({ runId, hypothesisId, fullTest: { agentRuns, notes: 'supervised batch' } });
  if (res.status !== 'OK') return { valid: false, reason: res.code || 'TEST_REJECTED', counted: false, detail: res.message };
  return { valid: true, counted: true, verdict: res.verdict, testId: res.testId, aggregate: res.aggregate, result: res };
}

// The continuous campaign. Drives the target queue (mine → improve), banks Stones on
// promotion, advances/retires branches, re-mines on an empty queue if configured, and
// NEVER self-completes. The operator stop signal (stopCheck) is the only stop.
export function runSupervisedCampaign(engine, config = {}, hooks = {}) {
  const log = typeof hooks.log === 'function' ? hooks.log : () => {};
  const worker = hooks.worker;
  const stopCheck = typeof hooks.stopCheck === 'function' ? hooks.stopCheck : () => false;
  const maxBatches = Number.isFinite(hooks.maxBatches) ? hooks.maxBatches : Infinity;
  if (typeof worker !== 'function') return { status: 'BLOCKED', code: 'NO_WORKER', message: 'runSupervisedCampaign needs a worker(contract) function (mock or executor-backed).' };

  const loops = requireFullLoops();
  if (!loops.ok) return loops.sentinel; // exact MISSING_FULL_PRIVATE_LOOPS string

  const runId = config.runId;
  const noImprovePolicy = Number.isFinite(config.noImprovePolicy) ? config.noImprovePolicy : DEFAULTS.branchRetirementBatches;
  const transcript = [];
  const tx = (step, extra) => { transcript.push({ step, ...extra }); log(`${step}${extra && extra.verdict ? ' ' + extra.verdict : ''}${extra && extra.reason ? ' ' + extra.reason : ''}`); };

  // intake (ask-once happens here; supervisor records the ledger via engine)
  engine.initialize_loop_run({
    runId, task: config.task || 'supervised campaign',
    answers: config.answers || ['a measurably better loop', config.startMode || 'mine then improve', 'measured quality up at equal-or-lower cost', 'keep authorship', 'keep moving'],
    userMessages: config.userMessages, model: config.model, config: config.engineConfig
  });

  const queue = (config.targets || []).map((t) => ({ ...t }));
  const stones = [];
  // Fix-2: a measured win is QUEUED for operator approval, never auto-banked. Track the pending
  // lanes so that once the operator Approves (dashboard → run inbox → applyInboxDecisions), the
  // supervisor re-attempts promotion_request and the approved win actually banks — closing the
  // autonomous loop with no manual re-call. bankedPromotions prevents ever banking a win twice.
  const pendingPromotions = [];          // { runId, hypothesisId, reviewId, loop } awaiting approval
  const bankedPromotions = new Set();    // `${runId}::${hypothesisId}` already banked
  let batchesTotal = 0;
  let improveIdx = 0;

  const stopped = () => stopCheck() || batchesTotal >= maxBatches;

  // Each tick, auto-apply any operator decisions dropped into a run inbox (dashboard
  // Approve/Sludge → exported decisions.json saved to runs/<runId>/inbox-decisions.json).
  // Covers the top-level run and every per-improve sub-run. Operator-driven, model-
  // independent, NON-BLOCKING: a failure here is logged and never stops the campaign.
  const allRunIds = new Set([runId]);

  // Fix-2: once the operator Approves a queued measured win, re-attempt promotion_request so it
  // banks. The engine gate is unchanged — it records the champion only because the review is now
  // APPROVED (a winning challenger passes the integrity gate again with no double-seal, then hits
  // the APPROVED→record path; an already-recorded promotion returns idempotent OK). Never grinds
  // or fabricates a bank: a non-OK re-attempt is left for a later approval signal.
  const bankApprovedPromotion = (rid, hypothesisId) => {
    const key = `${rid}::${hypothesisId}`;
    if (bankedPromotions.has(key)) return; // already banked → idempotent, never double-bank
    const promo = engine.promotion_request({ runId: rid, hypothesisId });
    if (promo.status === 'OK') {
      bankedPromotions.add(key);
      const i = pendingPromotions.findIndex((p) => p.runId === rid && p.hypothesisId === hypothesisId);
      const loop = i >= 0 ? pendingPromotions[i].loop : null;
      if (i >= 0) pendingPromotions.splice(i, 1);
      const stone = { id: promo.promotionId, loop, hypothesisId, kind: promo.decision && promo.decision.kind, fixtureOnly: !!(promo.integrity && promo.integrity.fixtureOnly) };
      stones.push(stone);
      tx('stone_banked', { stone: stone.id, runId: rid, hypothesisId, afterApproval: true, note: 'operator-approved measured win banked after dashboard approval — autonomous loop closed' });
      try { engine.update_dashboard({ runId: rid }); engine.report_export({ runId: rid }); } catch { /* dashboard refresh is best-effort; a write failure must not unbank a stone */ }
    } else {
      tx('promotion_reattempt_deferred', { runId: rid, hypothesisId, code: promo.code || promo.status, note: 'approved win not yet bankable on re-attempt — left for a later signal, not retried in a grind' });
    }
  };
  const dropRejectedPromotion = (rid, reviewId) => {
    const i = pendingPromotions.findIndex((p) => p.runId === rid && p.reviewId === reviewId);
    if (i < 0) return;
    const { hypothesisId } = pendingPromotions[i];
    pendingPromotions.splice(i, 1);
    tx('promotion_rejected_after_review', { runId: rid, hypothesisId, reviewId, note: 'operator sludged the dashboard review — not banked' });
  };

  const drainInbox = () => {
    const op = engine.operator;
    if (!op || typeof op.applyInboxDecisions !== 'function') return;
    for (const rid of allRunIds) {
      try {
        const r = op.applyInboxDecisions(rid);
        if (r && r.inbox && r.applied && r.applied.length) {
          tx('operator_decisions_applied', { runId: rid, count: r.applied.length, note: 'dashboard approvals auto-applied between ticks; campaign never paused' });
          // Fix-2: act on resolved promotions — bank approvals, drop sludges. (Loop adoptions and
          // other review kinds are already enforced inside applyDashboardDecisions itself.)
          for (const a of r.applied) {
            if (!a) continue;
            if (a.kind === 'promotion' && a.approved && a.hypothesisId != null) bankApprovedPromotion(rid, a.hypothesisId);
            else if (a.sludged && a.reviewId != null) dropRejectedPromotion(rid, a.reviewId);
          }
        } else if (r && r.inbox && r.reason) tx('operator_decisions_error', { runId: rid, reason: r.reason });
      } catch (e) { tx('inbox_drain_error', { runId: rid, reason: e.message }); }
    }
  };
  drainInbox();

  while (queue.length && !stopped()) {
    drainInbox();
    const target = queue.shift();

    if (target.kind === 'mine') {
      const mineReqs = [...(config.requirements || []), 'Emit discovered loop candidates as a JSON array inside <CANDIDATES>…</CANDIDATES>; each {loop, title, baselineContent}. Public references are reference_only — set referenceOnly:true and never copy them. If no real candidate exists, emit [].'];
      const contract = compilePhaseContract('strip-miner', target.phase || 0, { kind: 'mine', route: (target.routes || [])[0], task: config.task, requirements: mineReqs, mustProduceComparableOutput: false });
      const d = dispatchWorker(contract, worker, { log });
      if (!d.accepted) { tx('mine_worker_rejected', { reason: d.reasons.join(',') }); continue; }
      // candidates come structured from a mock, or parsed from a real miner's output
      const candidates = Array.isArray(d.packet.candidates) ? d.packet.candidates : parseCandidates(d.packet.finalOutput);
      if (candidates.length === 0) {
        tx('mine_saturation', { note: 'no candidate — saturation is a PHASE EDGE, not completion; auto-transition to improve/next' });
        // auto-transition: if no improve work queued, fall through (queue may be empty → re-mine policy below)
      } else {
        for (const c of candidates) queue.push({ kind: 'improve', loop: c.loop || 'loop-de-loop', baselineContent: c.baselineContent || floorBaselineScaffold(c.title || c.loop), benchmark: target.benchmark || config.benchmark, routes: target.routes || config.routes, challengerFamily: c.challengerFamily });
        tx('mine_candidates', { count: candidates.length });
      }
    } else if (target.kind === 'improve') {
      improveIdx++;
      const subRunId = `${runId}-t${improveIdx}`; // each branch is its own measured run
      allRunIds.add(subRunId); // its inbox is drained too, so the operator can adopt a per-branch win
      const r = runImproveTarget(engine, subRunId, target, { worker, log, stopped, noImprovePolicy, task: config.task, answers: config.answers, requirements: config.requirements, onBatch: () => { batchesTotal++; } });
      transcript.push(...r.transcript);
      if (r.stone) { stones.push(r.stone); bankedPromotions.add(`${subRunId}::${r.stone.hypothesisId}`); tx('stone_banked', { stone: r.stone.id }); }
      else if (r.promotionQueued) {
        pendingPromotions.push({ runId: subRunId, hypothesisId: r.hypothesisId, reviewId: r.reviewId, loop: r.loop });
        tx('promotion_queued', { reviewId: r.reviewId, hypothesisId: r.hypothesisId, note: 'measured win queued to dashboard (operator Approve/Sludge) — supervisor continues, never auto-promotes' });
      }
      else if (r.queued) tx('subjective_win_queued', { reviewId: r.reviewId, note: 'judged win queued to dashboard (human Approve/Sludge) — supervisor continues, never auto-promotes' });
      else if (r.retired) tx('branch_retired', { note: 'pivot to next target — NOT campaign stop' });
      else if (r.blocked) tx('improve_blocked', { reason: r.code });
    }

    if (queue.length === 0 && config.remineOnEmpty && !stopped()) {
      queue.push({ kind: 'mine', routes: config.routes, benchmark: config.benchmark });
      tx('queue_empty_remine', { note: 'empty target queue → re-mine (configured)' });
    }
  }

  // Final pass: bank any win the operator approved on the last tick before reporting (loop closure).
  drainInbox();

  return {
    status: 'OK',
    stoppedBy: stopCheck() ? 'operator-stop' : (batchesTotal >= maxBatches ? 'maxBatches-safety-cap (NOT completion)' : 'queue-drained (NOT completion)'),
    stones, batchesTotal, transcript,
    note: 'The supervisor never marks the campaign complete. Only the operator stop signal stops it.'
  };
}

function runImproveTarget(engine, runId, target, ctx) {
  // Judge mode: the benchmark evaluates REAL final outputs via an independent judge,
  // not a deterministic oracle. Subjective by nature → wins queue to the dashboard.
  if (target.benchmark && target.benchmark.mode === 'judge') return runJudgeImproveTarget(engine, runId, target, ctx);
  const { worker, log, stopped, noImprovePolicy, task, requirements } = ctx;
  const transcript = [];
  const t = (step, extra) => transcript.push({ step, ...extra });
  const loopId = target.loop || 'loop-de-loop';
  // Each improve target is its own measured run (own baseline + frozen benchmark),
  // so two targets never collide on the write-once baseline hash-lock.
  engine.initialize_loop_run({ runId, task: task || `improve ${loopId}`, answers: ctx.answers || ['a measurably better loop', `improve ${loopId}`, 'measured quality up at equal-or-lower cost', 'keep authorship', 'keep moving'] });
  const recordMeasurement = (packet, route) => {
    const art = engine.artifact_record({ runId, role: 'runlog', name: `w-${route}`, content: String(packet.finalOutput || ''), measure: true });
    return art && art.status === 'OK' ? art.artifactId : null;
  };

  engine.loop_start({ runId, loop: loopId });
  const bl = engine.artifact_record({ runId, role: 'baseline', name: 'baseline', content: resolveBaselineContent(target, loopId) });
  if (bl.status !== 'OK') return { blocked: true, code: bl.code, transcript };
  const prop = engine.benchmark_propose({ runId, benchmarks: [target.benchmark] });
  if (prop.status !== 'OK') return { blocked: true, code: prop.code, transcript };
  engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });

  // measure the baseline on a worker FIRST (baseline before challenger)
  const baseContract = compilePhaseContract(loopId, 0, { kind: 'baseline', route: (target.routes || [])[0], task, requirements });
  const baseD = dispatchWorker(baseContract, worker, { log });
  if (!baseD.accepted) return { blocked: true, code: 'BASELINE_WORKER_INVALID', transcript };
  const baseRef = recordMeasurement(baseD.packet, (target.routes || [])[0]);
  const bar = engine.benchmark_run({ runId, arm: 'baseline', measurementRef: baseRef });
  if (bar.status !== 'OK') return { blocked: true, code: bar.code, transcript };
  t('baseline_measured', { });

  let noImprove = 0;
  let invalidStreak = 0;
  while (noImprove < noImprovePolicy && !stopped()) {
    // a branch = a registered family of 3-5 frontier hypotheses
    const reg = engine.register_hypotheses({ runId, hypotheses: (target.routes || []).map((r, i) => ({ title: `h${i}`, bottleneck: 'b', operation: 'o', route: { model: r } })) });
    if (reg.status !== 'OK') return { blocked: true, code: reg.code, transcript };
    for (const hypothesisId of reg.hypothesisIds) {
      if (stopped()) break;
      const batch = runFullTestBatch(engine, runId, { hypothesisId, loopId, phase: 1, task, routes: target.routes, requirements, worker, recordMeasurement, log });
      if (!batch.valid) { t('batch_invalid', { reason: batch.reason, note: 'invalid worker(s) → batch does NOT count toward retirement' }); invalidStreak++; if (invalidStreak >= 3) return { retired: false, blocked: true, code: 'WORKERS_UNUSABLE', transcript }; continue; }
      invalidStreak = 0;
      ctx.onBatch(); // count a VALID FullTestBatch
      t('full_test_batch', { verdict: batch.verdict });
      if (batch.verdict === 'MOVED_FRONTIER' && batch.testId) {
        const rv = engine.reverify_run({ runId, testId: batch.testId });
        if (rv.status === 'OK') {
          const promo = engine.promotion_request({ runId, hypothesisId });
          if (promo.status === 'OK') {
            engine.update_dashboard({ runId }); engine.report_export({ runId });
            return { stone: { id: promo.promotionId, loop: loopId, hypothesisId, kind: promo.decision && promo.decision.kind, fixtureOnly: !!(promo.integrity && promo.integrity.fixtureOnly) }, transcript };
          }
          // Step 2 — a measured+reverified win is NOT auto-banked. It is queued to the
          // dashboard for operator Approve (same posture as a subjective/judge win); the
          // supervisor keeps running and never self-promotes.
          if (promo.code === 'PROMOTION_NEEDS_APPROVAL') {
            engine.update_dashboard({ runId }); engine.report_export({ runId });
            t('promotion_queued', { hypothesisId, reviewId: promo.queuedReviewId });
            return { promotionQueued: true, reviewId: promo.queuedReviewId, hypothesisId, loop: loopId, transcript };
          }
        }
      } else {
        noImprove++;
      }
    }
  }
  engine.update_dashboard({ runId }); engine.report_export({ runId });
  return { retired: noImprove >= noImprovePolicy, transcript };
}

// Judge-mode improve target: benchmarks evaluate REAL final outputs. Measure the
// baseline output, then for each challenger: run it, have an INDEPENDENT judge score
// challenger-vs-baseline under the rubric, and queue judged wins to the dashboard
// (subjective → human Approve/Sludge, never auto-promote). The supervisor keeps
// running; a Stone is banked only on out-of-band human approval.
function runJudgeImproveTarget(engine, runId, target, ctx) {
  const { worker, log, stopped, noImprovePolicy, task } = ctx;
  const transcript = [];
  const t = (step, extra) => transcript.push({ step, ...extra });
  const loopId = target.loop || 'loop-de-loop';
  const rubric = target.benchmark.rubric || 'Higher-quality, clearer, more correct final output at equal-or-lower cost; no regressions.';
  // Judge route: explicit benchmark.judgeRoute → policy.judgeRoute → first
  // builder-gating route among target.routes → policy.primary. Never a hard-coded
  // Opus/DEFAULT_PRIMARY_MODEL terminal that reintroduces Opus into a non-Opus campaign.
  const targetPolicy = target.modelPolicy
    ? normalizeModelPolicy(target.modelPolicy)
    : defaultModelPolicy();
  const judgeRoute = target.benchmark.judgeRoute
    || targetPolicy.judgeRoute
    || (target.routes || []).find((r) => isBuilderGatingRoute(r, targetPolicy))
    || targetPolicy.primary;
  const threshold = Number.isFinite(target.benchmark.threshold) ? target.benchmark.threshold : 0.6;

  engine.initialize_loop_run({
    runId,
    task: task || `improve ${loopId} (judge mode)`,
    answers: ctx.answers || ['a measurably better loop', `improve ${loopId}`, 'judged better final output', 'keep authorship', 'defaults', 'keep moving'],
    modelPolicy: target.modelPolicy || undefined,
    model: target.modelPolicy && target.modelPolicy.primary ? target.modelPolicy.primary : undefined
  });
  // After init, prefer the run's live policy for judge gating.
  const statusSnap = engine.campaign_status({ runId });
  const runPolicy = (statusSnap && statusSnap.modelPolicy) || targetPolicy;
  engine.loop_start({ runId, loop: loopId });
  const bl = engine.artifact_record({ runId, role: 'baseline', name: 'baseline', content: resolveBaselineContent(target, loopId) });
  if (bl.status !== 'OK') return { blocked: true, code: bl.code, transcript };

  const baseContract = compilePhaseContract(loopId, 0, { kind: 'baseline', route: (target.routes || [])[0], task });
  const baseD = dispatchWorker(baseContract, worker, { log });
  if (!baseD.accepted) return { blocked: true, code: 'BASELINE_WORKER_INVALID', transcript };
  const baselineOutput = baseD.packet.finalOutput;
  t('baseline_output_captured', {});

  let noImprove = 0;
  while (noImprove < noImprovePolicy && !stopped()) {
    const route = (target.routes || [])[0];
    const chD = dispatchWorker(compilePhaseContract(loopId, 1, { kind: 'challenger', route, task }), worker, { log });
    if (!chD.accepted) { t('challenger_invalid', { reason: chD.reasons.join(',') }); noImprove++; continue; }
    ctx.onBatch();
    const j = dispatchJudge(baselineOutput, chD.packet.finalOutput, rubric, judgeRoute, worker, log, runPolicy);
    if (j.error) { t('judge_error', { reason: j.error }); noImprove++; continue; }
    t('judge_verdict', { winner: j.verdict.winner, score: j.verdict.score });
    if (j.verdict.winner === 'challenger' && j.verdict.score >= threshold) {
      const rev = engine.human_review_request({ runId, action: 'add', item: { title: `judged improvement on ${loopId}`, kind: 'subjective-promotion', summary: `independent judge (${judgeRoute}) scored ${j.verdict.score}${j.verdict.notes ? ' — ' + j.verdict.notes : ''}` } });
      engine.update_dashboard({ runId }); engine.report_export({ runId });
      t('subjective_win_queued', { reviewId: rev.reviewId });
      return { queued: true, reviewId: rev.reviewId, transcript };
    }
    noImprove++;
  }
  engine.update_dashboard({ runId }); engine.report_export({ runId });
  return { retired: noImprove >= noImprovePolicy, transcript };
}
