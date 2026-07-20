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
import { canonicalCaseResultsContent, parseCaseResults } from './measure.mjs';
import { checkBaselineIntegrity } from './baseline-integrity.mjs';
import {
  REAL_TEST_LIMITS,
  qualifyRealTestFinding,
  realTestBenchmarkRequirements,
  validateRealTestConfig
} from './real-test.mjs';

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

export function standardSupervisorHypotheses(target = {}, routes = [], task = '') {
  const loopId = target.loop || 'loop-de-loop';
  const objective = String(task || `improve ${loopId}`).trim();
  return routes.map((route, index) => ({
    title: `Test evidence-bound ${loopId} intervention ${index + 1}`,
    bottleneck: `The current ${loopId} baseline has not isolated which procedure step causes the measured gap for "${objective}", so an ungrounded rewrite could look different without moving the frozen benchmark.`,
    operation: `Use ${route} to change one evidence-supported bottleneck in the complete ${loopId} procedure, preserve its acceptance criteria, and return a comparable end-to-end output for the frozen cases.`,
    expectedMovement: 'Raise tool-measured benchmark quality at equal or lower cost, or produce a measured tradeoff that remains unpromoted and visible for operator review.',
    falsifier: 'Reject this hypothesis if the full route batch fails to improve the frozen scorecard, regresses cost or quality, or cannot reverify from sealed artifacts.',
    route: { model: route }
  }));
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
        .map((c) => ({
          loop: c.loop || 'loop-de-loop',
          title: c.title || c.loop,
          baselineContent: c.baselineContent || null,
          evidenceRef: c.evidenceRef || null,
          evidenceRefs: Array.isArray(c.evidenceRefs) ? c.evidenceRefs.map((ref) => ({
            path: ref && ref.path,
            locator: ref && ref.locator
          })) : [],
          hypotheses: Array.isArray(c.hypotheses) ? c.hypotheses.map((hypothesis) => ({
            title: hypothesis && hypothesis.title,
            bottleneck: hypothesis && hypothesis.bottleneck,
            operation: hypothesis && hypothesis.operation,
            expectedMovement: hypothesis && hypothesis.expectedMovement,
            falsifier: hypothesis && hypothesis.falsifier
          })) : []
        }));
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

function verdictRecorder(engine, runId) {
  return (entry) => {
    if (!engine?.operator || typeof engine.operator.recordSupervisorEvent !== 'function') return;
    const contract = entry.contract || {};
    engine.operator.recordSupervisorEvent({
      runId,
      event: {
        type: 'worker_verdict',
        accepted: entry.accepted === true,
        code: entry.accepted ? null : (entry.reasons && entry.reasons[0]) || 'WORKER_REJECTED',
        reasons: entry.reasons || [],
        route: contract.route,
        phase: contract.phase,
        workerKind: contract.kind,
        attempt: entry.attempt,
        scenario: `${contract.kind || 'worker'}-${contract.phase == null ? 'na' : contract.phase}`,
        invocation: entry.invocation
      }
    });
  };
}

function recordCampaignCheckpoint(engine, runId, code, details = {}) {
  if (!engine?.operator || typeof engine.operator.recordSupervisorEvent !== 'function') return;
  try {
    engine.operator.recordSupervisorEvent({
      runId,
      event: {
        type: 'proof_checkpoint',
        accepted: true,
        code,
        reasons: details.reasons || [],
        workerKind: 'scheduler',
        scenario: details.scenario || code.toLowerCase()
      }
    });
  } catch { /* scheduler evidence cannot change campaign control flow */ }
}

function fingerprintText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function fingerprintIdentityText(value) {
  return fingerprintText(value).replace(/\s+/g, ' ');
}

function minedCandidateFingerprint(candidate = {}) {
  const baselineContent = fingerprintIdentityText(candidate.baselineContent);
  const evidenceRef = fingerprintIdentityText(candidate.evidenceRef);
  const evidenceRefs = Array.isArray(candidate.evidenceRefs)
    ? candidate.evidenceRefs.map((ref) => ({
        path: fingerprintText(ref && ref.path),
        locator: fingerprintIdentityText(ref && ref.locator)
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : [];
  const hasEvidenceIdentity = !!evidenceRef || evidenceRefs.length > 0;
  return sha256(JSON.stringify({
    loop: fingerprintText(candidate.loop || 'loop-de-loop'),
    title: baselineContent || hasEvidenceIdentity
      ? ''
      : fingerprintIdentityText(candidate.title || candidate.loop),
    baselineContent,
    evidenceRef,
    evidenceRefs
  }));
}

function miningResultFingerprint(packet = {}) {
  const receiptHash = packet.invocation && packet.invocation.resultSha256;
  return /^[a-f0-9]{64}$/i.test(String(receiptHash || ''))
    ? String(receiptHash).toLowerCase()
    : sha256(fingerprintText(packet.finalOutput));
}

function wakeTargets(wake) {
  if (Array.isArray(wake)) return wake;
  return wake && Array.isArray(wake.targets) ? wake.targets : [];
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
    target: opts.target && typeof opts.target === 'object' ? {
      findingId: opts.target.findingId || null,
      title: opts.target.title || null,
      baselineArtifactId: opts.target.baselineArtifactId || null,
      baselineSha256: opts.target.baselineSha256 || null,
      baselineContent: opts.target.baselineContent || null,
      evidenceRefs: Array.isArray(opts.target.evidenceRefs) ? opts.target.evidenceRefs.map((ref) => ({ ...ref })) : []
    } : null,
    hypothesis: opts.hypothesis && typeof opts.hypothesis === 'object' ? {
      id: opts.hypothesis.id || null,
      title: opts.hypothesis.title || null,
      bottleneck: opts.hypothesis.bottleneck || null,
      operation: opts.hypothesis.operation || null,
      expectedMovement: opts.hypothesis.expectedMovement || null,
      falsifier: opts.hypothesis.falsifier || null
    } : null,
    frozenCases: Array.isArray(opts.frozenCases) ? opts.frozenCases.map((item) => ({ ...item })) : [],
    evidenceCapsule: Array.isArray(opts.evidenceCapsule) ? opts.evidenceCapsule.map((item) => ({ ...item })) : [],
    evaluationArm: typeof opts.evaluationArm === 'string' && opts.evaluationArm.trim()
      ? opts.evaluationArm.trim()
      : null,
    procedureContent: typeof opts.procedureContent === 'string' ? opts.procedureContent : null,
    procedureSha256: /^[a-f0-9]{64}$/i.test(String(opts.procedureSha256 || ''))
      ? String(opts.procedureSha256).toLowerCase()
      : null,
    toolPolicy: opts.toolPolicy === 'none' ? 'none' : 'default',
    phaseRequired: opts.phaseRequired === true || opts.toolPolicy === 'none',
    requires: Array.isArray(opts.requires) ? opts.requires : ['runlog'],
    mustProduceComparableOutput: opts.mustProduceComparableOutput !== false,
    evidenceRequired: opts.evidenceRequired !== false
  };
}

const HYPOTHESIS_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'before', 'being', 'between', 'every',
  'from', 'into', 'only', 'should', 'their', 'there', 'these', 'this', 'through',
  'under', 'while', 'with', 'without', 'would', 'change', 'specific', 'require',
  'requires', 'required', 'apply', 'applied', 'procedure', 'baseline', 'frozen'
]);

function hypothesisLinkage(contract, revisedContent, changeSummary) {
  const hypothesis = contract.hypothesis || {};
  const terms = `${hypothesis.title || ''} ${hypothesis.bottleneck || ''} ${hypothesis.operation || ''}`
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{3,}/g) || [];
  const meaningful = [...new Set(terms.filter((term) => !HYPOTHESIS_STOPWORDS.has(term)))];
  if (!meaningful.length) return false;
  const baselineLines = new Set(String(contract.target && contract.target.baselineContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean));
  const changedLines = String(revisedContent || '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !baselineLines.has(line));
  const haystack = `${changedLines.join('\n')}\n${changeSummary}`.toLowerCase();
  const matches = meaningful.filter((term) => haystack.includes(term));
  return matches.length >= Math.min(3, meaningful.length);
}

function validateBoundStructuredOutput(contract, finalOutput) {
  if (!contract.target || !['baseline', 'challenger', 'proposal', 'evaluation'].includes(contract.kind)) return [];
  const reasons = [];
  const text = String(finalOutput || '');
  if (/<CANDIDATES>[\s\S]*?<\/CANDIDATES>/i.test(text)) return ['WRONG_PHASE_OUTPUT'];
  const target = contract.target;
  if (contract.kind === 'proposal') {
    const parsed = parseCaseResults(text);
    if (!parsed.ok || parsed.wrapper !== 'IMPROVEMENT' || !parsed.payload) return ['WRONG_PHASE_OUTPUT'];
    const payload = parsed.payload;
    if (String(payload.findingId || '') !== String(target.findingId || '')
      || String(payload.hypothesisId || '') !== String(contract.hypothesis && contract.hypothesis.id || '')
      || String(payload.baselineSha256 || '') !== String(target.baselineSha256 || '')) {
      reasons.push('TARGET_UNBOUND');
    }
    const revisedContent = String(payload.revisedContent || '');
    const changeSummary = String(payload.changeSummary || '');
    if (!revisedContent.trim() || revisedContent === String(target.baselineContent || '')
      || !checkBaselineIntegrity(revisedContent).ok || !changeSummary.trim()) {
      reasons.push('TARGET_UNBOUND');
    } else if (!hypothesisLinkage(contract, revisedContent, changeSummary)) {
      reasons.push('HYPOTHESIS_UNLINKED');
    }
    return [...new Set(reasons)];
  }
  if (contract.kind === 'evaluation') {
    const parsed = parseCaseResults(text, { allowProposalWrappers: false });
    if (!parsed.ok || parsed.wrapper !== 'EVALUATION' || !parsed.payload) return ['WRONG_PHASE_OUTPUT'];
    const payload = parsed.payload;
    const allowedKeys = new Set([
      'arm', 'findingId', 'hypothesisId', 'baselineSha256', 'procedureSha256', 'caseResults'
    ]);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) reasons.push('WRONG_PHASE_OUTPUT');
    if (String(payload.arm || '') !== String(contract.evaluationArm || '')
      || String(payload.findingId || '') !== String(target.findingId || '')
      || String(payload.baselineSha256 || '') !== String(target.baselineSha256 || '')
      || String(payload.procedureSha256 || '') !== String(contract.procedureSha256 || '')
      || String(payload.hypothesisId || '') !== String(contract.hypothesis && contract.hypothesis.id || '')) {
      reasons.push('TARGET_UNBOUND');
    }
    if (!Array.isArray(payload.caseResults) || payload.caseResults.length === 0
      || payload.caseResults.some((row) => (
        !row || typeof row !== 'object' || !String(row.caseId || '').trim()
        || !String(row.disposition || '').trim() || !String(row.code || '').trim()
        || (!Array.isArray(row.evidence) && !Array.isArray(row.evidencePaths))
      ))) {
      reasons.push('WRONG_PHASE_OUTPUT');
    }
    return [...new Set(reasons)];
  }
  const parsed = parseCaseResults(text);
  const expectedWrapper = contract.kind === 'baseline' ? 'BASELINE_RESULT' : 'IMPROVEMENT';
  if (!parsed.ok || parsed.wrapper !== expectedWrapper || !parsed.payload) return ['WRONG_PHASE_OUTPUT'];
  const payload = parsed.payload;
  if (String(payload.findingId || '') !== String(target.findingId || '')
    || String(payload.baselineSha256 || '') !== String(target.baselineSha256 || '')) {
    reasons.push('TARGET_UNBOUND');
  }
  if (!Array.isArray(payload.caseResults) || payload.caseResults.length === 0
    || payload.caseResults.some((row) => (
      !row || typeof row !== 'object' || !String(row.caseId || '').trim()
      || !String(row.disposition || '').trim() || !String(row.code || '').trim()
      || !Array.isArray(row.evidencePaths)
    ))) {
    reasons.push('WRONG_PHASE_OUTPUT');
  }
  if (contract.kind === 'baseline') {
    if (/<IMPROVEMENT>[\s\S]*?<\/IMPROVEMENT>/i.test(text)) reasons.push('WRONG_PHASE_OUTPUT');
  } else {
    if (/<BASELINE_RESULT>[\s\S]*?<\/BASELINE_RESULT>/i.test(text)
      || String(payload.hypothesisId || '') !== String(contract.hypothesis && contract.hypothesis.id || '')) {
      reasons.push('TARGET_UNBOUND');
    }
    const revisedContent = String(payload.revisedContent || '');
    if (!revisedContent.trim() || revisedContent === String(target.baselineContent || '')
      || !checkBaselineIntegrity(revisedContent).ok
      || !String(payload.changeSummary || '').trim()) {
      reasons.push('TARGET_UNBOUND');
    }
  }
  return [...new Set(reasons)];
}

function claimValueAsserted(value) {
  if (value == null || value === false || value === 0 || value === '') return false;
  return true;
}

export function scanClaimAuthority(claim) {
  const codes = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [rawKey, nested] of Object.entries(value)) {
      const key = String(rawKey).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (claimValueAsserted(nested)) {
        if (/^(metric|metrics|score|scores|quality|cost|tokencost|tokens|winner|evaluation|evaluationresult|winrate)/.test(key)) {
          codes.add('MODEL_REPORTED_METRIC');
        }
        if (/^(promot|approv|champion|done|complete|completion|finish|success)/.test(key)) {
          codes.add('SELF_PROMOTION');
        }
        if (/^(stop|halt|terminat|terminal)/.test(key)) {
          codes.add('SELF_STOP');
        }
      }
      visit(nested);
    }
  };
  visit(claim);
  return [...codes];
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
  if (contract.phaseRequired === true && packet.phase == null) reasons.push('PHASE_SKIP');
  if (packet.phase != null && contract.phase != null && packet.phase !== contract.phase) reasons.push('PHASE_SKIP');
  if (packet.copiedFromPublic === true || artifacts.some((a) => a && a.copiedFromPublic === true)) reasons.push('COPIED_PUBLIC');
  if (contract.toolPolicy === 'none') {
    const isolation = packet.isolation && typeof packet.isolation === 'object' ? packet.isolation : null;
    if (!isolation || isolation.status !== 'PASS'
      || (Array.isArray(isolation.toolCalls) && isolation.toolCalls.length > 0)) {
      reasons.push('ISOLATION_VIOLATION');
    }
  }

  // self-report / self-authority checks — a worker can never report metrics-as-proof,
  // promote itself, declare done, or stop the campaign.
  const claimCodes = scanClaimAuthority(claim);
  reasons.push(...claimCodes);
  reasons.push(...validateBoundStructuredOutput(contract, finalOutput));

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
export function runFullTestBatch(engine, runId, {
  hypothesisId,
  loopId,
  phase,
  task,
  routes,
  requirements,
  target,
  hypothesis,
  procedureContent,
  procedureSha256,
  evidenceCapsule,
  frozenCases,
  worker,
  recordMeasurement,
  log = () => {},
  onVerdict = verdictRecorder(engine, runId)
}) {
  if (!Array.isArray(routes) || routes.length < DEFAULTS.fullTestAgentsMin || routes.length > DEFAULTS.fullTestAgentsMax) {
    return { valid: false, reason: 'FULLTEST_AGENTS', counted: false };
  }
  const strictEvaluation = !!(target && hypothesis && procedureContent && procedureSha256);
  const agentRuns = [];
  for (const route of routes) {
    const contract = compilePhaseContract(loopId, phase, {
      kind: strictEvaluation ? 'evaluation' : 'challenger',
      evaluationArm: strictEvaluation ? 'challenger' : null,
      route,
      task,
      requirements,
      target,
      hypothesis,
      frozenCases,
      evidenceCapsule,
      procedureContent,
      procedureSha256,
      toolPolicy: strictEvaluation ? 'none' : 'default'
    });
    const d = dispatchWorker(contract, worker, { log, onVerdict });
    if (!d.accepted) return { valid: false, reason: d.reasons.join(','), counted: false }; // invalid batch never counts
    const comparableContent = strictEvaluation
      ? canonicalCaseResultsContent(d.packet.finalOutput)
      : String(d.packet.finalOutput || '');
    if (!comparableContent) return { valid: false, reason: 'MEASUREMENT_FAILED', counted: false };
    const recorded = recordMeasurement(d.packet, route, comparableContent);
    if (!recorded) return { valid: false, reason: 'MEASUREMENT_FAILED', counted: false };
    agentRuns.push(typeof recorded === 'string'
      ? { model: route, measurementRef: recorded }
      : { model: route, ...recorded });
  }
  const res = engine.test_hypothesis({ runId, hypothesisId, fullTest: { agentRuns, notes: 'supervised batch' } });
  if (res.status !== 'OK') return { valid: false, reason: res.code || 'TEST_REJECTED', counted: false, detail: res.message };
  return { valid: true, counted: true, verdict: res.verdict, testId: res.testId, aggregate: res.aggregate, result: res };
}

function recordStrictExecutorPacket(engine, runId, packet, route, {
  comparableContent = null,
  label = 'worker'
} = {}) {
  const finalOutput = String(packet && packet.finalOutput || '');
  const invocation = packet && packet.invocation && typeof packet.invocation === 'object' ? packet.invocation : null;
  const rawStdout = packet && packet.executorOwned === true ? String(packet.rawStdout || '') : '';
  const isolation = packet && packet.isolation && typeof packet.isolation === 'object' ? packet.isolation : null;
  if (!invocation || !rawStdout || !finalOutput
    || !isolation || isolation.status !== 'PASS'
    || (Array.isArray(isolation.toolCalls) && isolation.toolCalls.length > 0)
    || sha256(rawStdout) !== invocation.stdoutSha256
    || sha256(finalOutput) !== invocation.resultSha256) {
    return null;
  }
  const raw = engine.artifact_record({
    runId,
    role: 'executor-raw',
    name: `${label}-raw-${route}`,
    content: rawStdout
  });
  if (!raw || raw.status !== 'OK') return null;
  const result = engine.artifact_record({
    runId,
    role: 'worker-final',
    name: `${label}-final-${route}`,
    content: finalOutput
  });
  if (!result || result.status !== 'OK') return null;
  let evaluation = null;
  if (typeof comparableContent === 'string') {
    evaluation = engine.artifact_record({
      runId,
      role: 'runlog',
      name: `${label}-evaluation-${route}`,
      content: comparableContent,
      measure: true
    });
    if (!evaluation || evaluation.status !== 'OK') return null;
  }
  return {
    ...(evaluation ? {
      measurementRef: evaluation.artifactId,
      evaluationArtifactRef: evaluation.artifactId
    } : {}),
    rawArtifactRef: raw.artifactId,
    resultArtifactRef: result.artifactId,
    requestedModel: invocation.requestedModel || route,
    reportedModel: invocation.reportedModel || null,
    binaryFamily: invocation.binaryFamily || null,
    argv: Array.isArray(invocation.argv) ? invocation.argv.map(String) : [],
    modelSelectionAuthority: invocation.modelSelectionAuthority || null,
    modelIdentityAuthority: invocation.modelIdentityAuthority || invocation.modelSelectionAuthority || null,
    reportedModelMatchesRequest: invocation.reportedModelMatchesRequest ?? null,
    strictIsolation: invocation.strictIsolation === true,
    disabledFeatures: Array.isArray(invocation.disabledFeatures) ? invocation.disabledFeatures.map(String) : [],
    workspaceRoot: invocation.workspaceRoot || null,
    outputSchemaSha256: invocation.outputSchemaSha256 || null,
    rawResultSha256: invocation.rawResultSha256 || null,
    resultNormalization: invocation.resultNormalization || null,
    cliReportedTotalTokens: Number.isFinite(invocation.tokenUsage) ? invocation.tokenUsage : null,
    cliReportedTokenUsage: invocation.tokenUsageDetails || null,
    durationMs: Number.isFinite(invocation.durationMs) ? invocation.durationMs : null,
    exitCode: Number.isFinite(invocation.exitCode) ? invocation.exitCode : null,
    stdoutSha256: invocation.stdoutSha256,
    resultSha256: invocation.resultSha256,
    isolation: {
      status: isolation.status,
      toolCalls: Array.isArray(isolation.toolCalls) ? isolation.toolCalls.map((item) => ({ ...item })) : []
    }
  };
}

// The continuous campaign. Drives the target queue (mine → improve), banks Stones on
// promotion, advances/retires branches, re-mines on an empty queue if configured, and
// NEVER self-completes. The operator stop signal (stopCheck) is the only stop.
export function runSupervisedCampaign(engine, config = {}, hooks = {}) {
  const log = typeof hooks.log === 'function' ? hooks.log : () => {};
  const worker = hooks.worker;
  const stopCheck = typeof hooks.stopCheck === 'function' ? hooks.stopCheck : () => false;
  const idleWait = typeof hooks.idleWait === 'function' ? hooks.idleWait : null;
  const realTestValidation = validateRealTestConfig(config);
  if (!realTestValidation.ok) {
    return {
      status: 'BLOCKED',
      code: 'REAL_TEST_CONFIG',
      errors: realTestValidation.errors,
      plan: realTestValidation.plan
    };
  }
  const realTestEnabled = realTestValidation.enabled === true;
  const requestedMaxBatches = Number.isFinite(hooks.maxBatches) ? hooks.maxBatches : Infinity;
  const maxBatches = realTestEnabled
    ? Math.min(requestedMaxBatches, REAL_TEST_LIMITS.maxImprovementAttempts)
    : requestedMaxBatches;
  if (typeof worker !== 'function') return { status: 'BLOCKED', code: 'NO_WORKER', message: 'runSupervisedCampaign needs a worker(contract) function (mock or executor-backed).' };

  const loops = requireFullLoops();
  if (!loops.ok) return loops.sentinel; // exact MISSING_FULL_PRIVATE_LOOPS string

  const runId = config.runId;
  const noImprovePolicy = Number.isFinite(config.noImprovePolicy) ? config.noImprovePolicy : DEFAULTS.branchRetirementBatches;
  const transcript = [];
  const tx = (step, extra) => { transcript.push({ step, ...extra }); log(`${step}${extra && extra.verdict ? ' ' + extra.verdict : ''}${extra && extra.reason ? ' ' + extra.reason : ''}`); };

  // intake (ask-once happens here; supervisor records the ledger via engine)
  const engineRealTestConfig = realTestEnabled
    ? {
        ...(config.engineConfig || {}),
        maxCycles: REAL_TEST_LIMITS.maxImprovementAttempts,
        realTest: {
          ...config.realTest,
          parentRunId: runId,
          evidenceManifest: config.evidenceManifest
        }
      }
    : config.engineConfig;
  engine.initialize_loop_run({
    runId, task: config.task || 'supervised campaign',
    answers: config.answers || ['a measurably better loop', config.startMode || 'mine then improve', 'measured quality up at equal-or-lower cost', 'keep authorship', 'keep moving'],
    answerSource: Array.isArray(config.answers) && config.answers.length ? 'config' : 'default',
    userMessages: config.userMessages,
    model: config.model,
    modelPolicy: config.modelPolicy,
    config: engineRealTestConfig
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
  let findingsAccepted = 0;
  let findingsRejected = 0;
  let invalidAttempts = 0;
  let benchmarkLocked = false;
  let baselineSamples = 0;
  let latestSubRunId = null;
  const seenFindings = new Set();
  const seenMinedCandidates = new Set(
    queue
      .filter((target) => target.kind === 'improve')
      .map((target) => minedCandidateFingerprint(target))
  );
  const coverage = [];
  let miningExhausted = false;
  let idle = false;
  let idleReason = null;
  let idleCycles = 0;
  let idleAnnounced = false;
  let lastMiningFingerprint = null;
  let schedulerError = null;

  const stopped = () => stopCheck() || batchesTotal >= maxBatches;
  const coverageSummary = () => ({
    findingsAccepted,
    findingsTested: coverage.filter((item) => item.valid > 0).length,
    findingsBlocked: coverage.filter((item) => item.status === 'BLOCKED').length,
    attemptsPlanned: coverage.reduce((sum, item) => sum + item.planned, 0),
    attemptsValid: coverage.reduce((sum, item) => sum + item.valid, 0),
    attemptsInvalid: coverage.reduce((sum, item) => sum + item.invalid, 0),
    coverage: coverage.map((item) => ({ ...item, hypothesisIds: [...item.hypothesisIds] }))
  });

  // Each tick, auto-apply any operator decisions dropped into a run inbox (dashboard
  // Approve/Sludge → exported decisions.json saved to runs/<runId>/inbox-decisions.json).
  // Covers the top-level run and every per-improve sub-run. Operator-driven, model-
  // independent, NON-BLOCKING: a failure here is logged and never stops the campaign.
  const allRunIds = new Set([runId]);
  const syncRealTestProgress = (status = 'RUNNING') => {
    if (!realTestEnabled || !engine?.operator || typeof engine.operator.recordCampaignProgress !== 'function') return;
    for (const rid of allRunIds) {
      try {
        engine.operator.recordCampaignProgress({
          runId: rid,
          progress: {
            status,
            findingsAccepted,
            findingsRejected,
            improvementAttempts: batchesTotal,
            invalidAttempts,
            latestSubRunId,
            benchmarkLocked,
            baselineSamples,
            ...coverageSummary()
          }
        });
      } catch { /* dashboard progress cannot change the campaign verdict */ }
    }
  };
  syncRealTestProgress('PREPARING');

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
        const effective = (r && Array.isArray(r.applied))
          ? r.applied.filter((item) => item && (item.adopted || item.approved || item.sludged))
          : [];
        const rejected = (r && Array.isArray(r.applied))
          ? r.applied.filter((item) => item && (item.skipped || item.error))
          : [];
        if (r && r.inbox && effective.length) {
          tx('operator_decisions_applied', { runId: rid, count: effective.length, note: 'dashboard approvals auto-applied between ticks; campaign never paused' });
          // Fix-2: act on resolved promotions — bank approvals, drop sludges. (Loop adoptions and
          // other review kinds are already enforced inside applyDashboardDecisions itself.)
          for (const a of effective) {
            if (!a) continue;
            if (a.kind === 'promotion' && a.approved && a.hypothesisId != null) bankApprovedPromotion(rid, a.hypothesisId);
            else if (a.sludged && a.reviewId != null) dropRejectedPromotion(rid, a.reviewId);
          }
        }
        if (r && r.inbox && (r.reason || rejected.length)) {
          tx('operator_decisions_error', {
            runId: rid,
            reason: r.reason || `${rejected.length} queued decision(s) rejected`,
            codes: rejected.map((item) => item.code).filter(Boolean).join(',') || null
          });
        }
      } catch (e) { tx('inbox_drain_error', { runId: rid, reason: e.message }); }
    }
  };
  drainInbox();

  while (!stopped()) {
    drainInbox();
    if (queue.length === 0) {
      if (config.remineOnEmpty !== true) break;
      if (!miningExhausted) {
        queue.push({ kind: 'mine', routes: config.routes, benchmark: config.benchmark });
        tx('queue_empty_remine', { note: 'empty target queue -> one mining pass for this work epoch' });
        continue;
      }

      idle = true;
      idleCycles++;
      if (!idleAnnounced) {
        idleAnnounced = true;
        tx('campaign_idle', {
          reason: idleReason || 'NO_NOVEL_MINING_WORK',
          miningFingerprint: lastMiningFingerprint,
          note: 'no novel runnable target remains; scheduler stays responsive with zero model calls until new work or operator stop'
        });
        recordCampaignCheckpoint(engine, runId, 'IDLE_NO_NEW_WORK', {
          scenario: lastMiningFingerprint
            ? `idle-no-new-work-${lastMiningFingerprint.slice(0, 12)}`
            : 'idle-no-new-work',
          reasons: [idleReason || 'NO_NOVEL_MINING_WORK']
        });
      }
      if (!idleWait) break;

      let wake = null;
      try {
        wake = idleWait({
          runId,
          reason: idleReason || 'NO_NOVEL_MINING_WORK',
          miningFingerprint: lastMiningFingerprint,
          idleCycles,
          pendingPromotions: pendingPromotions.length
        });
      } catch (error) {
        schedulerError = error;
        tx('campaign_idle_error', { reason: error.message });
        recordCampaignCheckpoint(engine, runId, 'IDLE_WAIT_FAILED', {
          scenario: 'idle-wait-failed',
          reasons: [error.message]
        });
        break;
      }
      if (stopped()) break;
      const newTargets = wakeTargets(wake);
      if (newTargets.length === 0) continue;
      queue.push(...newTargets.map((target) => ({ ...target })));
      miningExhausted = false;
      idle = false;
      idleReason = null;
      idleCycles = 0;
      idleAnnounced = false;
      tx('campaign_wake', {
        count: newTargets.length,
        sourceSha256: wake && wake.sourceSha256 ? wake.sourceSha256 : null,
        archivedAs: wake && wake.archivedAs ? wake.archivedAs : null,
        note: 'new targets accepted; autonomous execution resumed without an approval gate'
      });
      recordCampaignCheckpoint(engine, runId, 'NEW_TARGETS_ACCEPTED', {
        scenario: wake && wake.sourceSha256
          ? `target-inbox-${wake.sourceSha256.slice(0, 12)}`
          : 'new-targets-accepted'
      });
      continue;
    }

    idle = false;
    const target = queue.shift();

    if (target.kind === 'mine') {
      const candidateSchema = realTestEnabled
        ? 'each {loop, title, baselineContent, evidenceRefs:[{path,locator}], hypotheses:[{title,bottleneck,operation,expectedMovement,falsifier},{title,bottleneck,operation,expectedMovement,falsifier}]}; evidenceRefs must name concrete sealed sources and the two hypotheses must be distinct and substantive'
        : 'each {loop, title, baselineContent}';
      const mineReqs = [...(config.requirements || []), `Emit discovered loop candidates as a JSON array inside <CANDIDATES>…</CANDIDATES>; ${candidateSchema}. Public references are reference_only — set referenceOnly:true and never copy them. If no real candidate exists, emit [].`];
      const contract = compilePhaseContract('strip-miner', target.phase || 0, {
        kind: 'mine',
        route: (target.routes || [])[0],
        task: config.task,
        requirements: mineReqs,
        mustProduceComparableOutput: false,
        evidenceCapsule: realTestEnabled ? config.evidenceCapsule : [],
        toolPolicy: realTestEnabled ? 'none' : 'default'
      });
      const d = dispatchWorker(contract, worker, { log, onVerdict: verdictRecorder(engine, runId) });
      if (!d.accepted) {
        idleReason = 'MINER_REJECTED';
        lastMiningFingerprint = sha256(d.reasons.join(','));
        miningExhausted = true;
        tx('mine_worker_rejected', { reason: d.reasons.join(',') });
        continue;
      }
      const miningFingerprint = miningResultFingerprint(d.packet);
      let miningCapture = null;
      if (realTestEnabled) {
        miningCapture = recordStrictExecutorPacket(engine, runId, d.packet, contract.route, {
          label: 'strict-mining'
        });
        if (!miningCapture) {
          idleReason = 'MINING_CAPTURE_FAILED';
          lastMiningFingerprint = miningFingerprint;
          miningExhausted = true;
          tx('mine_capture_rejected', { reason: 'CAPTURE_FAILED' });
          continue;
        }
      }
      // candidates come structured from a mock, or parsed from a real miner's output
      const capturedCandidates = parseCandidates(d.packet.finalOutput);
      const candidates = Array.isArray(d.packet.candidates) ? d.packet.candidates : capturedCandidates;
      if (candidates.length === 0) {
        idleReason = 'NO_CANDIDATES';
        lastMiningFingerprint = miningFingerprint;
        miningExhausted = true;
        tx('mine_saturation', {
          reason: idleReason,
          miningFingerprint,
          note: 'no candidate; advance queued work, or enter zero-inference idle when no target remains'
        });
      } else {
        let queued = 0;
        let duplicates = 0;
        for (const c of candidates) {
          const candidateFingerprint = minedCandidateFingerprint(c);
          if (seenMinedCandidates.has(candidateFingerprint)) {
            duplicates++;
            continue;
          }
          seenMinedCandidates.add(candidateFingerprint);
          if (realTestEnabled) {
            if (findingsAccepted >= REAL_TEST_LIMITS.maxFindings) {
              findingsRejected++;
              tx('finding_rejected', { reason: 'FINDING_CAP_REACHED' });
              continue;
            }
            const qualified = qualifyRealTestFinding(c, seenFindings, {
              capturedOutput: d.packet.finalOutput,
              capturedArtifactId: miningCapture.resultArtifactRef,
              capturedRawArtifactId: miningCapture.rawArtifactRef,
              capturedCandidates,
              findingId: `finding-${String(findingsAccepted + 1).padStart(3, '0')}`,
              evidenceManifest: config.evidenceManifest,
              evidenceCapsule: config.evidenceCapsule
            });
            if (!qualified.ok) {
              findingsRejected++;
              tx('finding_rejected', { reason: qualified.reason });
              continue;
            }
            const finding = qualified.finding;
            queue.push({
              kind: 'improve',
              findingId: finding.id,
              title: finding.title,
              loop: finding.loop,
              baselineContent: finding.baselineContent,
              baselineSha256: finding.baselineSha256,
              miningCaptureArtifactId: finding.miningCaptureArtifactId,
              miningRawArtifactId: finding.miningRawArtifactId,
              evidenceRefs: finding.evidenceRefs,
              hypotheses: finding.hypotheses,
              benchmark: target.benchmark || config.benchmark,
              routes: target.routes || config.routes,
              challengerFamily: c.challengerFamily
            });
            coverage.push({
              findingId: finding.id,
              childRunId: null,
              baselineSha256: finding.baselineSha256,
              miningRawArtifactId: finding.miningRawArtifactId,
              miningCaptureArtifactId: finding.miningCaptureArtifactId,
              evidenceRefs: finding.evidenceRefs.map((ref) => ({ ...ref })),
              hypothesisIds: finding.hypotheses.map((hypothesis) => hypothesis.id),
              planned: finding.hypotheses.length,
              valid: 0,
              invalid: 0,
              status: 'UNTESTED'
            });
            findingsAccepted++;
            queued++;
          } else {
            queue.push({
              kind: 'improve',
              loop: c.loop || 'loop-de-loop',
              baselineContent: c.baselineContent || floorBaselineScaffold(c.title || c.loop),
              benchmark: target.benchmark || config.benchmark,
              routes: target.routes || config.routes,
              challengerFamily: c.challengerFamily
            });
            queued++;
          }
        }
        if (duplicates > 0) {
          tx('mine_candidates_deduplicated', {
            count: duplicates,
            miningFingerprint,
            note: 'previously seen candidates were not re-enqueued'
          });
        }
        tx('mine_candidates', {
          count: queued,
          findingsAccepted: realTestEnabled ? findingsAccepted : undefined,
          findingsRejected: realTestEnabled ? findingsRejected : undefined
        });
        if (queued === 0) {
          idleReason = duplicates === candidates.length
            ? 'DUPLICATE_CANDIDATES'
            : 'NO_NOVEL_QUALIFIED_CANDIDATES';
          lastMiningFingerprint = miningFingerprint;
          miningExhausted = true;
          tx('mine_saturation', {
            reason: idleReason,
            miningFingerprint,
            duplicateCandidates: duplicates,
            note: 'mining produced no novel runnable target; do not pay to repeat the same work epoch'
          });
        } else {
          miningExhausted = false;
          idleReason = null;
          lastMiningFingerprint = miningFingerprint;
        }
        syncRealTestProgress('RUNNING');
      }
    } else if (target.kind === 'improve') {
      seenMinedCandidates.add(minedCandidateFingerprint(target));
      improveIdx++;
      const subRunId = `${runId}-t${improveIdx}`; // each branch is its own measured run
      latestSubRunId = subRunId;
      const coverageEntry = realTestEnabled
        ? coverage.find((item) => item.findingId === target.findingId)
        : null;
      if (coverageEntry) {
        coverageEntry.childRunId = subRunId;
        coverageEntry.status = 'RUNNING';
      }
      const effectiveTarget = {
        ...target,
        benchmark: target.benchmark || config.benchmark,
        routes: target.routes || config.routes
      };
      const r = runImproveTarget(engine, subRunId, effectiveTarget, {
        worker,
        log,
        stopped,
        noImprovePolicy,
        task: config.task,
        answers: config.answers,
        requirements: config.requirements,
        model: config.model,
        modelPolicy: config.modelPolicy,
        realTest: realTestEnabled ? {
          ...config.realTest,
          evidenceManifest: config.evidenceManifest,
          evidenceCapsule: config.evidenceCapsule
        } : null,
        parentRunId: runId,
        onRunReady: () => {
          allRunIds.add(subRunId);
          syncRealTestProgress('RUNNING');
        },
        onBenchmarkLocked: (samples) => {
          benchmarkLocked = true;
          baselineSamples = Math.max(baselineSamples, samples || 0);
          syncRealTestProgress('RUNNING');
        },
        onBatch: () => {
          batchesTotal++;
          syncRealTestProgress(batchesTotal >= maxBatches ? 'CAP_REACHED' : 'RUNNING');
        },
        onInvalidBatch: () => {
          invalidAttempts++;
          syncRealTestProgress('RUNNING');
        }
      });
      transcript.push(...r.transcript);
      if (coverageEntry) {
        coverageEntry.valid = Number.isInteger(r.validAttempts) ? r.validAttempts : coverageEntry.valid;
        coverageEntry.invalid = Number.isInteger(r.invalidAttempts) ? r.invalidAttempts : coverageEntry.invalid;
        coverageEntry.status = r.blocked
          ? 'BLOCKED'
          : (coverageEntry.valid === coverageEntry.planned ? 'COVERED' : 'PARTIAL');
        syncRealTestProgress('RUNNING');
      }
      if (r.stone) { stones.push(r.stone); bankedPromotions.add(`${subRunId}::${r.stone.hypothesisId}`); tx('stone_banked', { stone: r.stone.id }); }
      else if (r.promotionQueued) {
        pendingPromotions.push({ runId: subRunId, hypothesisId: r.hypothesisId, reviewId: r.reviewId, loop: r.loop });
        tx('promotion_queued', { reviewId: r.reviewId, hypothesisId: r.hypothesisId, note: 'measured win queued to dashboard (operator Approve/Sludge) — supervisor continues, never auto-promotes' });
      }
      else if (r.queued) tx('subjective_win_queued', { reviewId: r.reviewId, note: 'judged win queued to dashboard (human Approve/Sludge) — supervisor continues, never auto-promotes' });
      else if (r.retired) tx('branch_retired', { note: 'pivot to next target — NOT campaign stop' });
      else if (r.blocked) tx('improve_blocked', { reason: r.code });
      // Completing an improve target changes the work epoch. One fresh mining pass is
      // allowed after the remaining queued targets drain.
      miningExhausted = false;
      idleReason = null;
    }
  }

  // Final pass: bank any win the operator approved on the last tick before reporting (loop closure).
  drainInbox();
  const coverageComplete = realTestEnabled
    && coverage.length === findingsAccepted
    && findingsAccepted > 0
    && coverage.every((item) => item.status === 'COVERED' && item.valid === item.planned);
  const operatorStopped = stopCheck();
  const finalProgressStatus = operatorStopped
    ? 'OPERATOR_STOP'
    : (queue.length === 0 && (!realTestEnabled || coverageComplete)
        ? 'QUEUE_DRAINED'
        : (batchesTotal >= maxBatches ? 'CAP_REACHED' : 'QUEUE_DRAINED'));
  syncRealTestProgress(
    finalProgressStatus
  );
  if (realTestEnabled) {
    for (const rid of allRunIds) {
      try {
        engine.update_dashboard({ runId: rid });
        engine.report_export({ runId: rid });
      } catch { /* reporting cannot change measured campaign state */ }
    }
  }

  return {
    status: schedulerError ? 'BLOCKED' : 'OK',
    code: schedulerError ? 'IDLE_WAIT_FAILED' : undefined,
    stoppedBy: operatorStopped
      ? 'operator-stop'
      : (batchesTotal >= maxBatches
          ? (realTestEnabled ? 'real-test-improvement-cap (NOT completion)' : 'maxBatches-safety-cap (NOT completion)')
          : (schedulerError
              ? 'idle-wait-error (NOT completion)'
              : (idle ? 'idle-no-new-work (NOT completion)' : 'queue-drained (NOT completion)'))),
    campaignContinues: !operatorStopped,
    idle,
    idleReason,
    idleCycles,
    lastMiningFingerprint,
    stones, batchesTotal, transcript,
    realTest: realTestEnabled ? {
      limits: REAL_TEST_LIMITS,
      findingsAccepted,
      findingsRejected,
      improvementAttempts: batchesTotal,
      invalidAttempts,
      ...coverageSummary(),
      planSha256: realTestValidation.plan.sha256,
      benchmarkSha256: realTestValidation.plan.benchmarkSha256
    } : null,
    note: operatorStopped
      ? 'The operator stop signal ended the scheduler. Persisted run evidence remains available.'
      : (idle
          ? 'The campaign remains open in zero-inference idle. New queued targets resume it; only the operator stop signal ends it.'
          : 'The supervisor never marks the campaign complete. Only the operator stop signal stops it.')
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
  const strictRealTest = ctx.realTest && ctx.realTest.enabled === true;
  const runRequirements = strictRealTest
    ? [...(requirements || []), ...realTestBenchmarkRequirements(target.benchmark)]
    : requirements;
  // Each improve target is its own measured run (own baseline + frozen benchmark),
  // so two targets never collide on the write-once baseline hash-lock.
  engine.initialize_loop_run({
    runId,
    task: task || `improve ${loopId}`,
    answers: ctx.answers || ['a measurably better loop', `improve ${loopId}`, 'measured quality up at equal-or-lower cost', 'keep authorship', 'keep moving'],
    answerSource: Array.isArray(ctx.answers) && ctx.answers.length ? 'config' : 'default',
    model: strictRealTest ? ctx.model : undefined,
    modelPolicy: strictRealTest ? ctx.modelPolicy : undefined,
    config: strictRealTest ? {
      maxCycles: REAL_TEST_LIMITS.maxImprovementAttempts,
      realTest: {
        ...ctx.realTest,
        parentRunId: ctx.parentRunId,
        findingId: target.findingId
      }
    } : undefined
  });
  if (typeof ctx.onRunReady === 'function') ctx.onRunReady();
  const recordMeasurement = (packet, route, comparableContent = null) => {
    const finalOutput = String(packet.finalOutput || '');
    if (!strictRealTest) {
      const art = engine.artifact_record({ runId, role: 'runlog', name: `w-${route}`, content: finalOutput, measure: true });
      return art && art.status === 'OK' ? art.artifactId : null;
    }
    return recordStrictExecutorPacket(engine, runId, packet, route, {
      comparableContent,
      label: 'strict-evaluation'
    });
  };

  engine.loop_start({ runId, loop: loopId });
  const bl = engine.artifact_record({ runId, role: 'baseline', name: 'baseline', content: resolveBaselineContent(target, loopId) });
  if (bl.status !== 'OK') return { blocked: true, code: bl.code, transcript };
  const contractTarget = strictRealTest ? {
    findingId: target.findingId,
    title: target.title,
    baselineArtifactId: bl.artifactId,
    baselineSha256: bl.sha256,
    baselineContent: resolveBaselineContent(target, loopId),
    evidenceRefs: target.evidenceRefs || []
  } : null;
  if (strictRealTest) {
    const frozen = engine.benchmark_freeze_maker({
      runId,
      benchmark: target.benchmark,
      benchPartition: 'gate'
    });
    if (frozen.status !== 'OK') return { blocked: true, code: frozen.code, transcript };
  } else {
    const prop = engine.benchmark_propose({ runId, benchmarks: [target.benchmark] });
    if (prop.status !== 'OK') return { blocked: true, code: prop.code, transcript };
    engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  }

  // Measure the baseline before challengers. Strict real-test mode uses the same
  // 3-5 route batch as challengers so one weak baseline response cannot manufacture
  // frontier movement.
  const baselineRefs = [];
  const baselineRuns = [];
  const baselineRoutes = strictRealTest ? (target.routes || []) : [(target.routes || [])[0]];
  for (const route of baselineRoutes) {
    const baseContract = compilePhaseContract(loopId, 0, {
      kind: strictRealTest ? 'evaluation' : 'baseline',
      evaluationArm: strictRealTest ? 'baseline' : null,
      route,
      task,
      requirements: runRequirements,
      target: contractTarget,
      frozenCases: target.benchmark && target.benchmark.cases,
      evidenceCapsule: strictRealTest ? ctx.realTest.evidenceCapsule : [],
      procedureContent: strictRealTest ? contractTarget.baselineContent : null,
      procedureSha256: strictRealTest ? contractTarget.baselineSha256 : null,
      toolPolicy: strictRealTest ? 'none' : 'default'
    });
    const baseD = dispatchWorker(baseContract, worker, {
      log,
      onVerdict: verdictRecorder(engine, runId)
    });
    if (!baseD.accepted) return { blocked: true, code: 'BASELINE_WORKER_INVALID', transcript };
    const comparableContent = strictRealTest ? canonicalCaseResultsContent(baseD.packet.finalOutput) : null;
    if (strictRealTest && !comparableContent) return { blocked: true, code: 'BASELINE_MEASUREMENT_FAILED', transcript };
    const baseRecorded = recordMeasurement(baseD.packet, route, comparableContent);
    if (!baseRecorded) return { blocked: true, code: 'BASELINE_MEASUREMENT_FAILED', transcript };
    baselineRefs.push(typeof baseRecorded === 'string' ? baseRecorded : baseRecorded.measurementRef);
    if (strictRealTest) baselineRuns.push({ model: route, ...baseRecorded });
  }
  const bar = engine.benchmark_run(strictRealTest
    ? { runId, arm: 'baseline', agentRuns: baselineRuns }
    : { runId, arm: 'baseline', measurementRef: baselineRefs[0] });
  if (bar.status !== 'OK') return { blocked: true, code: bar.code, transcript };
  t('baseline_measured', { samples: baselineRefs.length, strategy: strictRealTest ? 'route-batch' : 'single-run' });
  if (typeof ctx.onBenchmarkLocked === 'function') ctx.onBenchmarkLocked(baselineRefs.length);

  if (strictRealTest) {
    const planned = (target.hypotheses || []).map((hypothesis, index) => ({
      ...hypothesis,
      route: { model: (target.routes || [])[index % Math.max(1, (target.routes || []).length)] }
    }));
    const reg = engine.register_hypotheses({ runId, hypotheses: planned });
    if (reg.status !== 'OK') return { blocked: true, code: reg.code, transcript, validAttempts: 0, invalidAttempts: 0 };
    let validAttempts = 0;
    let invalidAttempts = 0;
    let queuedPromotion = null;
    let bankedStone = null;
    for (let index = 0; index < reg.hypothesisIds.length; index++) {
      const hypothesisId = reg.hypothesisIds[index];
      const hypothesis = { ...planned[index], id: hypothesisId };
      let invalidStreak = 0;
      let counted = false;
      while (!counted && !stopped()) {
        const proposalRoute = planned[index] && planned[index].route && planned[index].route.model
          ? planned[index].route.model
          : (target.routes || [])[0];
        const proposalContract = compilePhaseContract(loopId, 1, {
          kind: 'proposal',
          route: proposalRoute,
          task,
          requirements: runRequirements,
          target: contractTarget,
          hypothesis,
          frozenCases: target.benchmark && target.benchmark.cases,
          evidenceCapsule: ctx.realTest.evidenceCapsule,
          toolPolicy: 'none'
        });
        const proposalDispatch = dispatchWorker(proposalContract, worker, {
          log,
          onVerdict: verdictRecorder(engine, runId)
        });
        if (!proposalDispatch.accepted) {
          invalidAttempts++;
          invalidStreak++;
          t('proposal_invalid', {
            findingId: target.findingId,
            hypothesisId,
            reason: proposalDispatch.reasons.join(','),
            note: 'invalid proposal does not consume the finding attempt or global cap'
          });
          if (typeof ctx.onInvalidBatch === 'function') ctx.onInvalidBatch();
          if (invalidStreak >= 3) {
            engine.update_dashboard({ runId }); engine.report_export({ runId });
            return {
              blocked: true,
              code: 'WORKERS_UNUSABLE',
              transcript,
              findingId: target.findingId,
              hypothesisIds: reg.hypothesisIds,
              validAttempts,
              invalidAttempts
            };
          }
          continue;
        }
        const proposalEvidence = recordStrictExecutorPacket(
          engine,
          runId,
          proposalDispatch.packet,
          proposalRoute,
          { label: `proposal-${hypothesisId}` }
        );
        if (!proposalEvidence) {
          invalidAttempts++;
          invalidStreak++;
          if (typeof ctx.onInvalidBatch === 'function') ctx.onInvalidBatch();
          continue;
        }
        const proposalPayload = parseCaseResults(proposalDispatch.packet.finalOutput).payload;
        const procedureContent = String(proposalPayload && proposalPayload.revisedContent || '');
        const procedureSha256 = sha256(procedureContent);
        const batch = runFullTestBatch(engine, runId, {
          hypothesisId,
          loopId,
          phase: 1,
          task,
          routes: target.routes,
          requirements: runRequirements,
          target: contractTarget,
          hypothesis,
          procedureContent,
          procedureSha256,
          evidenceCapsule: ctx.realTest.evidenceCapsule,
          frozenCases: target.benchmark && target.benchmark.cases,
          worker,
          recordMeasurement: (packet, route, comparableContent) => {
            const recorded = recordMeasurement(packet, route, comparableContent);
            return recorded && typeof recorded === 'object'
              ? {
                  ...recorded,
                  procedureSha256,
                  proposalRawArtifactRef: proposalEvidence.rawArtifactRef,
                  proposalResultArtifactRef: proposalEvidence.resultArtifactRef,
                  proposalStdoutSha256: proposalEvidence.stdoutSha256,
                  proposalResultSha256: proposalEvidence.resultSha256,
                  proposalRequestedModel: proposalEvidence.requestedModel,
                  proposalReportedModel: proposalEvidence.reportedModel,
                  proposalBinaryFamily: proposalEvidence.binaryFamily,
                  proposalArgv: proposalEvidence.argv,
                  proposalModelSelectionAuthority: proposalEvidence.modelSelectionAuthority,
                  proposalModelIdentityAuthority: proposalEvidence.modelIdentityAuthority,
                  proposalReportedModelMatchesRequest: proposalEvidence.reportedModelMatchesRequest,
                  proposalStrictIsolation: proposalEvidence.strictIsolation,
                  proposalDisabledFeatures: proposalEvidence.disabledFeatures,
                  proposalWorkspaceRoot: proposalEvidence.workspaceRoot,
                  proposalOutputSchemaSha256: proposalEvidence.outputSchemaSha256,
                  proposalRawResultSha256: proposalEvidence.rawResultSha256,
                  proposalResultNormalization: proposalEvidence.resultNormalization,
                  proposalCliReportedTotalTokens: proposalEvidence.cliReportedTotalTokens,
                  proposalCliReportedTokenUsage: proposalEvidence.cliReportedTokenUsage,
                  proposalDurationMs: proposalEvidence.durationMs,
                  proposalExitCode: proposalEvidence.exitCode,
                  proposalIsolation: proposalEvidence.isolation
                }
              : recorded;
          },
          log,
          onVerdict: verdictRecorder(engine, runId)
        });
        if (!batch.valid) {
          invalidAttempts++;
          invalidStreak++;
          t('batch_invalid', {
            findingId: target.findingId,
            hypothesisId,
            reason: batch.reason,
            note: 'invalid worker(s) do not consume the finding attempt or global cap'
          });
          if (typeof ctx.onInvalidBatch === 'function') ctx.onInvalidBatch();
          if (invalidStreak >= 3) {
            engine.update_dashboard({ runId }); engine.report_export({ runId });
            return {
              blocked: true,
              code: 'WORKERS_UNUSABLE',
              transcript,
              findingId: target.findingId,
              hypothesisIds: reg.hypothesisIds,
              validAttempts,
              invalidAttempts
            };
          }
          continue;
        }
        counted = true;
        validAttempts++;
        ctx.onBatch();
        t('full_test_batch', { findingId: target.findingId, hypothesisId, verdict: batch.verdict });
        if (batch.verdict === 'MOVED_FRONTIER' && batch.testId) {
          const rv = engine.reverify_run({ runId, testId: batch.testId });
          if (rv.status === 'OK') {
            const promo = engine.promotion_request({ runId, hypothesisId });
            if (promo.status === 'OK' && !bankedStone) {
              bankedStone = {
                id: promo.promotionId,
                loop: loopId,
                hypothesisId,
                kind: promo.decision && promo.decision.kind,
                fixtureOnly: !!(promo.integrity && promo.integrity.fixtureOnly)
              };
            } else if (promo.code === 'PROMOTION_NEEDS_APPROVAL' && !queuedPromotion) {
              queuedPromotion = {
                promotionQueued: true,
                reviewId: promo.queuedReviewId,
                hypothesisId,
                loop: loopId
              };
              t('promotion_queued', { hypothesisId, reviewId: promo.queuedReviewId });
            }
          }
        }
      }
    }
    engine.update_dashboard({ runId }); engine.report_export({ runId });
    return {
      ...(bankedStone ? { stone: bankedStone } : {}),
      ...(queuedPromotion || {}),
      covered: validAttempts === planned.length,
      findingId: target.findingId,
      hypothesisIds: reg.hypothesisIds,
      validAttempts,
      invalidAttempts,
      transcript
    };
  }

  let noImprove = 0;
  let invalidStreak = 0;
  while (noImprove < noImprovePolicy && !stopped()) {
    // a branch = a registered family of 3-5 frontier hypotheses
    const reg = engine.register_hypotheses({
      runId,
      hypotheses: standardSupervisorHypotheses(target, target.routes || [], task)
    });
    if (reg.status !== 'OK') return { blocked: true, code: reg.code, transcript };
    for (const hypothesisId of reg.hypothesisIds) {
      if (stopped()) break;
      const batch = runFullTestBatch(engine, runId, {
        hypothesisId,
        loopId,
        phase: 1,
        task,
        routes: target.routes,
        requirements: runRequirements,
        worker,
        recordMeasurement,
        log,
        onVerdict: verdictRecorder(engine, runId)
      });
      if (!batch.valid) {
        t('batch_invalid', { reason: batch.reason, note: 'invalid worker(s) → batch does NOT count toward retirement or the real-test attempt cap' });
        if (typeof ctx.onInvalidBatch === 'function') ctx.onInvalidBatch();
        invalidStreak++;
        if (invalidStreak >= 3) return { retired: false, blocked: true, code: 'WORKERS_UNUSABLE', transcript };
        continue;
      }
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
    answerSource: Array.isArray(ctx.answers) && ctx.answers.length ? 'config' : 'default',
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
