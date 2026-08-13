// Loop Factory core. Every tool handler lives here. The point is simple: a model
// cannot promote, advance, or declare anything "done" from reasoning alone.
// Each gate demands tool-measured artifacts on disk, and the operator is the
// only stop condition.
import {
  STATUS, BLOCK, VERDICT, DEFAULTS, DEFAULT_PRIMARY_MODEL, KNOWN_FRONTIER_EXAMPLES, STOP_CONDITION_WARNING,
  NATIVE_CONTINUATION_NOTICE, COLD_START_NOTICE, CONTINUOUS_MODE_BY_HOST, NEVER_STOP_ON, LANE_KIND, LANE_STATUS, BUILDER_GATING_ROUTES, MANDATED_LOOPS
} from './constants.mjs';
import { sha256, hash8, nowIso, wordCount, round, mean, stdev, isPortableId, isSafeId, clone } from './util.mjs';
import {
  classifyRoute, rejectedRoutes, rejectedBuilderRoutes,
  defaultModelPolicy, normalizeModelPolicy, ensureModelPolicy, parseModelChoiceText, modelPolicyPreset
} from './models.mjs';
import { evaluatePromotion, selectBestMeasuredTest } from './scorecard.mjs';
import { resolveLoopId, loadLoop, loopSummary, makeCustomLoop, isMandatedId, verifyAllLoops } from './loops.mjs';
import {
  parseSkillFile, validateSkillRecord, buildSkillIndex, serializeSkillMarkdown, deriveSectionIds, SKILL_PARTITION
} from './skill-schema.mjs';
import { rankSkills } from './skill-match.mjs';
import { renderDashboard, renderReport } from './dashboard.mjs';
import {
  CASE_RESULTS_ORACLE_KIND_V2, deriveMeasurement, estimateTokens, scoreOracle,
  isDeterministicOracle, isCaseResultsOracle,
  evaluateCaseResultsGameability, parseCaseResults, TOOL_AUTHORITY, CALLER_AUTHORITY
} from './measure.mjs';
import { detectHostCapabilities, hostProfile, hostMatrix, detectHostRuntime } from './host.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep, isAbsolute } from 'node:path';
import {
  STRICT_CODEX_DISABLED_FEATURES, extractResult, inspectWorkerIsolation, isExecEnabled,
  normalizeStructuredWorkerOutput, parseTokenUsage, runWorker, execBinaryForRoute, executorWorker
} from './executor.mjs';
import { runSupervisedCampaign } from './supervisor.mjs';
import { checkBaselineIntegrity, checkHypothesisIntegrity } from './baseline-integrity.mjs';
import { deriveExperimentValidity, verifyPersistedProposalRun } from './run-verifier.mjs';
import { isReviewDecisionBinding, reviewDecisionBinding } from './review-decisions.mjs';
import {
  SEALED, WORKER_MSG, LANE as INTEGRITY_LANE, ARTIFACT_CLASS, DEFAULT_PASS_MARK,
  oracleMarkers, answerKeyEchoGuard, paddedMarkerEchoGuard, negativeControlVerdict, standardNegativeControl,
  routeShaCollapse, evidenceBindingCheck, solutionPressureCheck, classifyArtifact, classifyObjectiveWork,
  isMarkerOracle, isAnswerVisible, normalizeOutputClass, DETERMINISTIC_CLASSES,
  findOverride
} from './integrity.mjs';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const ok = (message, extra = {}) => ({ status: 'OK', message, ...extra });
const blocked = (code, message, extra = {}) => ({ status: 'BLOCKED', code, message, ...extra });

function skillsUsedFor(state) {
  return Array.isArray(state.skillsUsed) ? state.skillsUsed : [];
}

function filterSkillIndicesByPartition(indices, partition) {
  const wantReference = partition === SKILL_PARTITION.REFERENCE;
  return indices.filter((idx) => {
    const part = idx.skillPartition || SKILL_PARTITION.WORKING;
    return wantReference ? part === SKILL_PARTITION.REFERENCE : part === SKILL_PARTITION.WORKING;
  });
}

export function createEngine(store, { clock = nowIso, operatorAuthority = process.env.SUPER_LOOP_OPERATOR_AUTHORITY || null, env = process.env } = {}) {
  // `env` is the host environment the engine reasons about (only env.PATH is read, and only
  // for route-spawnability via the host preflight — never executed). Injectable for tests so
  // "is opencode on PATH" is deterministic regardless of what's installed on the dev machine.
  // Step 1 — the operator authority is an OUT-OF-BAND secret (env SUPER_LOOP_OPERATOR_AUTHORITY
  // or an in-process config value), never a tool argument the model can read. It is the only
  // way a maker/operator baseline waives the integrity floor. The model reaches the engine
  // solely through the MCP server, which forwards arguments verbatim — so a worker can TYPE
  // baselineAuthority, but cannot know this secret, and a fresh deployment leaves it null
  // (fail-closed: maker/operator baselines are refused until the operator configures it).
  // It is never echoed in any tool result.
  // ---- state scaffolding -------------------------------------------------
  function freshRun(runId, ts) {
    return {
      runId, version: 1, createdAt: ts, updatedAt: ts,
      status: STATUS.AWAITING_ANSWERS,
      task: { text: '', sha256: '', sufficiency: 'unknown', acceptanceCriteria: null, mode: 'unknown' },
      config: {
        model: { primary: DEFAULT_PRIMARY_MODEL, declared: false, autoSelected: true },
        modelPolicy: defaultModelPolicy('defaults'),
        failurePatience: DEFAULTS.failurePatience,
        branchRetirementBatches: DEFAULTS.branchRetirementBatches,
        promotion: { ...DEFAULTS.promotion },
        comparisonRule: 'pareto',
        runMode: 'infinite', // 'bounded' only when the operator sets a limit (maxCycles)
        maxCycles: null,     // bounded limit = max full tests; null = infinite (never self-stops)
        realTest: null
      },
      userMessages: [], questions: [], answers: [],
      loops: {}, activeLoop: null, customLoops: {},
      baseline: { recorded: false },
      benchmark: { proposals: [], frozen: false, def: null, baselineScore: null, epoch: 0 },
      hypotheses: [], tests: [],
      failures: { consecutive: 0, total: 0, exhaustionFlagged: false },
      // Supervisor target queue. Lanes are how Loop Factory owns transitions: a 'mine'
      // lane runs the Strip Miner, an 'improve' lane runs Loop-de-loop. On
      // saturation/retirement the supervisor AUTO-TRANSITIONS to the next lane —
      // there is no pause/await/stop lane and no terminal campaign state.
      campaign: { lanes: [], activeLaneId: null, transitions: [] },
      decisions: [], promotions: [], humanReviews: [], observations: [], supervisionEvents: [],
      counters: { artifact: 0, observation: 0, hypothesis: 0, test: 0, review: 0, decision: 0, promotion: 0, benchmark: 0, continuation: 0, lane: 0, transition: 0, toolCall: 0, supervisionEvent: 0 },
      trajectory: [],
      skillsUsed: [],
      dashboardPath: null, reportPath: null,
      dashboard: { alwaysOn: true, reviewAuthority: 'dashboard-only', modelCanResolveReview: false },
      realTest: null,
      continuation: { required: false, id: null, since: null, source: null, reason: null, next: null, clearedAt: null, clearedBy: null, history: [] },
      log: []
    };
  }
  function nextId(state, kind, prefix) {
    state.counters[kind] = (state.counters[kind] || 0) + 1;
    return `${prefix}-${String(state.counters[kind]).padStart(3, '0')}`;
  }
  function logEvent(state, event, detail) {
    state.log.push({ ts: clock(), event, detail: detail || null });
  }
  function invalidIdBlock(label, value) {
    return blocked(BLOCK.BAD_INPUT,
      `Invalid ${label} "${String(value || '')}". Use letters/numbers plus ".", "_" or "-" only; no slashes, spaces, or path traversal.`,
      { label, value: String(value || '') });
  }
  // Integrity Gate: seal the specific reason to the supervisor ledger only; return a coarse worker block.
  function sealReason(state, sealed, detail) {
    logEvent(state, 'integrity_seal', { sealedReason: sealed, ...detail });
    state.integritySeals = state.integritySeals || [];
    state.integritySeals.push({ ts: clock(), sealedReason: sealed, detail: detail || null });
    state.updatedAt = clock();
    store.save(state);
    return blocked(BLOCK.INTEGRITY_GATE, WORKER_MSG[sealed], { lane: INTEGRITY_LANE[sealed] });
  }
  function loadRun(args) {
    if (!args || !args.runId) return null;
    if (!isSafeId(args.runId)) return { __blocked: invalidIdBlock('runId', args.runId) };
    if (!store.exists(args.runId)) return null;
    const state = store.load(args.runId);
    if (state) ensureModelPolicy(state); // resume: backfill pre-modelPolicy runs
    return state;
  }
  function activePolicy(state) {
    return ensureModelPolicy(state);
  }
  function requireInitialized(state) {
    if (state && state.__blocked) return state.__blocked;
    if (![STATUS.INITIALIZED, STATUS.ACTIVE, STATUS.NEEDS_RESUME].includes(state.status)) {
      return blocked(BLOCK.NOT_INITIALIZED,
        'Run is not initialized. Call initialize_loop_run first (the ask-once gate) so the loop never runs on an unconfirmed task.',
        { runStatus: state.status });
    }
    return null;
  }
  // ---- loop resolution (mandated + user-added custom loops) --------------
  // A run pins a snapshot of any custom loop it streams into state.customLoops so
  // the source is immutable for the life of the run (hash-verified on first load per
  // process, then cached — see loops.mjs loadLoop).
  function customLoopRecord(state, id) {
    if (state.customLoops && state.customLoops[id]) return state.customLoops[id];
    return store.readLoop(id);
  }
  function canonLoopId(state, arg) {
    const mandated = resolveLoopId(arg);
    if (mandated) return mandated;
    if (!arg) return null;
    const key = String(arg).toLowerCase().trim();
    if (!isSafeId(key)) return null;
    if ((state.customLoops && state.customLoops[key]) || store.loopExists(key)) return key;
    return null;
  }
  function unknownLoopBlock(state, arg) {
    const value = String(arg == null ? '' : arg);
    const key = value.toLowerCase().trim();
    if (key && !isSafeId(key)) return invalidIdBlock('loop', value);
    const custom = store.listLoops();
    return blocked(BLOCK.UNKNOWN_LOOP,
      `Unknown loop "${value || '<empty>'}". Mandated: strip-miner (The Strip Miner Loop) or loop-de-loop (Loop 2, the improvement loop).${custom.length ? ` Custom local loops: ${custom.join(', ')}.` : ' Register your own with loop_register.'}`,
      { customLoops: custom });
  }
  function requestedLoopTarget(state, arg, { fallbackActive = false } = {}) {
    const explicit = arg != null && String(arg).trim() !== '';
    if (explicit) {
      const id = canonLoopId(state, arg);
      if (!id) return { error: unknownLoopBlock(state, arg) };
      return { id, explicit: true };
    }
    if (fallbackActive && state.activeLoop) return { id: state.activeLoop, explicit: false };
    return { id: null, explicit: false };
  }
  function phaseEvidenceTarget(state, args) {
    const wantsPhase = args.loop != null || Number.isInteger(args.phase);
    if (!wantsPhase) return { wantsPhase: false };
    const target = requestedLoopTarget(state, args.loop, { fallbackActive: true });
    if (target.error) return { error: target.error };
    if (!target.id) {
      return { error: blocked(BLOCK.NO_ACTIVE_LOOP, 'No active loop. Start a loop before recording phase evidence, or pass an explicit valid loop id.') };
    }
    const ls = state.loops[target.id];
    if (!ls) return { error: blocked(BLOCK.NOT_STARTED, `Loop "${target.id}" not started. Call loop_start { loop:"${target.id}" } before recording phase evidence.`) };
    const phase = Number.isInteger(args.phase) ? args.phase : ls.phaseCursor;
    if (phase < 0 || phase >= ls.totalPhases) {
      return { error: blocked(BLOCK.BAD_INPUT, `Phase ${phase} is outside loop "${target.id}" bounds 0..${ls.totalPhases - 1}.`, { loop: target.id, phase, totalPhases: ls.totalPhases }) };
    }
    return { wantsPhase: true, loop: target.id, phase };
  }
  function loadAnyLoop(state, id) {
    if (resolveLoopId(id)) return loadLoop(id);
    const rec = customLoopRecord(state, id);
    if (!rec) throw new Error(`unknown loop: ${id}`);
    return makeCustomLoop(rec);
  }
  function continuationDirective(state, context = '') {
    const prefix = context ? `${context} ` : '';
    return `${prefix}Reports, dashboards, saturation findings, and no-improvement advisories are checkpoints, not stopping points. If this lane is exhausted, pivot to the next runnable improvement lane while the dashboard stays available for operator review.`;
  }
  function ensureContinuation(state) {
    if (!state.continuation) {
      state.continuation = { required: false, id: null, since: null, source: null, reason: null, next: null, clearedAt: null, clearedBy: null, history: [] };
    }
    if (!Array.isArray(state.continuation.history)) state.continuation.history = [];
    return state.continuation;
  }
  function recommendedNextAction(state) {
    const active = state.activeLoop && state.loops[state.activeLoop] ? state.activeLoop : null;
    if (active) {
      const ls = state.loops[active];
      const ev = (ls.evidence && ls.evidence[ls.phaseCursor]) || [];
      if (ev.length === 0) {
        return {
          tool: 'observation_record',
          args: { runId: state.runId, loop: active, phase: ls.phaseCursor, summary: '<evidence from the work just performed>' },
          reason: `current streamed phase ${ls.phaseCursor} needs evidence before the next phase`
        };
      }
      if (ls.phaseCursor + 1 < ls.totalPhases) {
        return { tool: 'request_next_phase', args: { runId: state.runId, loop: active }, reason: 'current phase has evidence; stream the next phase' };
      }
    }
    if (!state.baseline.recorded) {
      return { tool: 'artifact_record', args: { runId: state.runId, role: 'baseline', content: '<frozen baseline loop/artifact bytes>' }, reason: 'hash-lock the baseline before benchmark selection' };
    }
    if (!state.benchmark.frozen) {
      return { tool: 'benchmark_propose', args: { runId: state.runId, benchmarks: ['<scorecard with value dimensions, cost dimensions, and real cases>'] }, reason: 'freeze the task-specific benchmark before challengers' };
    }
    if (!state.benchmark.baselineScore) {
      return { tool: 'benchmark_run', args: { runId: state.runId, arm: 'baseline', measurementRef: '<tool-measured artifact id>' }, reason: 'set the tool-measured baseline bar' };
    }
    const moved = (state.tests || []).find((t) => t.verdict === VERDICT.MOVED_FRONTIER && !t.reverified);
    if (moved) {
      return { tool: 'reverify_run', args: { runId: state.runId, testId: moved.id }, reason: 'deep-reverify the moved-frontier evidence before promotion' };
    }
    const untested = (state.hypotheses || []).find((h) => !(state.tests || []).some((t) => t.hypothesisId === h.id));
    if (untested) {
      return { tool: 'test_hypothesis', args: { runId: state.runId, hypothesisId: untested.id, fullTest: { agentRuns: ['<3-5 frontier measured runs>'] } }, reason: 'run a full measured test for the next registered hypothesis' };
    }
    return {
      tool: 'register_hypotheses',
      args: { runId: state.runId, hypotheses: ['<3-5 new frontier hypotheses for the next bottleneck/lane>'] },
      reason: 'continue into the next runnable improvement lane'
    };
  }
  function continuationPayload(state) {
    const c = ensureContinuation(state);
    return {
      required: !!c.required,
      id: c.id || null,
      source: c.source || null,
      reason: c.reason || null,
      since: c.since || null,
      next: c.next || recommendedNextAction(state),
      inProgress: !!c.inProgress,
      lastCommitment: c.lastCommitment || null,
      clearedAt: c.clearedAt || null,
      clearedBy: c.clearedBy || null
    };
  }
  // Additive open-run heartbeat: campaignContinues means "the run is still open — call next."
  // Distinct from continuation.required (unmet checkpoint debt cleared by progress tools).
  const CAMPAIGN_OPEN_STATUSES = [STATUS.INITIALIZED, STATUS.ACTIVE, STATUS.NEEDS_RESUME];
  const HEARTBEAT_SKIP_TOOLS = new Set(['loop_library', 'host_runtime_detect', 'host_capability_preflight']);
  function campaignIsOpen(state) {
    return !!(state && CAMPAIGN_OPEN_STATUSES.includes(state.status));
  }
  // Bounded-mode stop. ONLY when the operator set a limit (runMode==='bounded') and a
  // TOOL-DETERMINED threshold is reached — full-test count hits maxCycles, or the
  // failure/exhaustion advisory fires. In 'infinite' mode this is ALWAYS false: the run
  // keeps going until the operator stops it. This is a "you may stop your /loop" signal,
  // NOT campaign completion: nothing auto-promotes, pending reviews still await the
  // operator, and the run stays resumable by runId. The model cannot trigger it (the
  // limit is set once at first-init); the operator's limit is the only thing that flips it.
  function boundedComplete(state) {
    if (!state || !state.config || state.config.runMode !== 'bounded') return false;
    const cyclesDone = (state.counters && state.counters.test) || 0;
    const cap = Number.isFinite(state.config.maxCycles) ? state.config.maxCycles : Infinity;
    return cyclesDone >= cap || !!(state.failures && state.failures.exhaustionFlagged);
  }
  function attachCampaignHeartbeat(state, result) {
    if (!result || typeof result !== 'object' || !campaignIsOpen(state)) return result;
    const cont = result.continuation || continuationPayload(state);
    if (boundedComplete(state)) {
      const cyclesDone = (state.counters && state.counters.test) || 0;
      return {
        ...result,
        runStatus: state.status,
        campaignContinues: false,
        boundedComplete: true,
        runMode: 'bounded',
        cyclesDone,
        maxCycles: state.config.maxCycles,
        mayStopLoop: 'Operator-set limit reached — you MAY stop your /loop now. This is NOT a self-completion: nothing auto-promoted, any pending dashboard reviews still await the operator, and the run resumes with this runId if the operator extends the limit. (Bounded mode only; an infinite-mode run never sets this.)',
        continuation: { ...cont },
        next: 'Bounded limit reached: report the final state to the operator and stop the loop. Resume later with this runId if the operator raises the limit.'
      };
    }
    const nextAction = cont.next || recommendedNextAction(state);
    return {
      ...result,
      runStatus: state.status,
      campaignContinues: true,
      continuation: { ...cont, next: nextAction },
      next: result.next ?? nextSentence(state)
    };
  }
  function resolveHeartbeatRunId(toolName, args, result) {
    if (args && args.runId) return args.runId;
    if (toolName === 'initialize_loop_run' && result && result.runId) return result.runId;
    return null;
  }
  function recordTrajectory(runId, toolName, args, result) {
    if (!runId || !isSafeId(runId) || !store.exists(runId)) return;
    const state = store.load(runId);
    state.trajectory = state.trajectory || [];
    const callId = nextId(state, 'toolCall', 'call');
    state.trajectory.push({
      id: callId,
      ts: clock(),
      tool: toolName,
      arguments: clone(args || {}),
      result: {
        status: result && result.status ? result.status : 'OK',
        code: (result && result.code) || null,
        message: (result && result.message) || null
      }
    });
    state.updatedAt = clock();
    store.save(state);
  }
  function resolveExportOutPath(runId, outPath) {
    const raw = String(outPath || '').trim();
    if (!raw) return { error: 'export_trajectories needs a non-empty outPath.' };
    if (isAbsolute(raw)) {
      const target = resolve(raw);
      const exportsRoot = resolve(store.homeDir, 'exports');
      if (target !== exportsRoot && !target.startsWith(exportsRoot + sep)) {
        return { error: `Absolute outPath must be under ${exportsRoot}/ (SUPER_LOOP_HOME/exports).` };
      }
      return { path: target };
    }
    try {
      const base = store.runDir(runId);
      const target = resolve(base, raw);
      if (target !== base && !target.startsWith(base + sep)) {
        return { error: 'Relative outPath must stay inside the run directory.' };
      }
      return { path: target };
    } catch (e) {
      return { error: e.message };
    }
  }
  function wrapToolHandler(toolName, fn) {
    if (HEARTBEAT_SKIP_TOOLS.has(toolName)) return fn;
    return (args = {}) => {
      const result = fn(args);
      const rid = resolveHeartbeatRunId(toolName, args, result);
      if (rid && isSafeId(rid) && store.exists(rid)) recordTrajectory(rid, toolName, args, result);
      if (!rid || !isSafeId(rid) || !store.exists(rid)) return result;
      return attachCampaignHeartbeat(store.load(rid), result);
    };
  }
  // ---- host setup (A1) : turn "engage continuous mode" from advice into an
  // executable, host-correct checklist the model can actually run at start. -----
  // Resolve through hosts/registry.json so all 10 registry hosts get their driver
  // + setupHint (not just claude/codex hard-codes).
  function hostFromEnv() {
    const raw = String((env && env.SUPER_LOOP_HOST) || process.env.SUPER_LOOP_HOST || '').toLowerCase().trim();
    if (!raw) return 'unknown';
    const profile = hostProfile(raw);
    return (profile && profile.id) || 'unknown';
  }
  function trimText(text, max = 160) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }
  function runObjective(state) {
    const task = state.task && state.task.text ? trimText(state.task.text) : '';
    return task || 'Drive this Super Loop campaign — mine/improve loops through the phase gate and keep going until the operator stops you.';
  }
  // ---- campaign path (Step 5) : improve / mine / discover -------------------
  // The "path" steers what the agent should do first. It is an explicit inferred
  // field (stored on state.task.path at init) — NOT a blanket default flip — derived
  // from the operator's answers first, then their task text. When nothing signals a
  // path it stays null and hostSetup step 3 offers both loops (today's behavior).
  function pathFromText(text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    const improve = /\b(improve|harden|optimi[sz]e|refine|tune|existing loop|my loop file|loop-?de-?loop)\b|make (?:it|my loop) better/.test(t);
    const discover = /\b(discover|scout)\b|loop library|find (?:a|the|me)?\s*(?:new|stronger|better)?\s*loop/.test(t);
    const mine = /\b(mine|mining|archaeolog|dig)\b|strip ?miner|whole (?:session )?history|sessions for/.test(t);
    if (discover) return 'discover';            // explicit discover wins
    if (improve && !mine) return 'improve';
    if (mine && !improve) return 'mine';
    return null;                                 // both or neither → neutral
  }
  // First answer that resolves a path wins, so the explicit path-picker question
  // (answered before the library-scout question) is authoritative and a later
  // "scout: no" answer cannot flip it.
  function pathFromAnswers(answers) {
    for (const a of (answers || [])) {
      const p = pathFromText(String(a && a.text != null ? a.text : a));
      if (p) return p;
    }
    return null;
  }
  function computeCampaignPath(state) {
    return pathFromAnswers(state.answers) || pathFromText(state.task && state.task.text) || null;
  }
  function inferCampaignPath(state) {
    const stored = state.task && state.task.path;
    if (stored === 'improve' || stored === 'mine' || stored === 'discover') return stored;
    return computeCampaignPath(state);
  }
  function pathStep3(state) {
    const rid = state.runId;
    const path = inferCampaignPath(state);
    if (path === 'improve')
      return `loop_start { runId:"${rid}", loop:"loop-de-loop" } to improve the loop you already run and prove the cost/quality win. (To mine your history for a new loop instead: { loop:"strip-miner" }.)`;
    if (path === 'discover')
      return `loop_start { runId:"${rid}", loop:"strip-miner" } scoped NARROW — discover/extract a loop from a thin corpus or the loop library; cap the search, do not deep-mine. (To improve a loop you already have instead: { loop:"loop-de-loop" }.)`;
    if (path === 'mine')
      return `loop_start { runId:"${rid}", loop:"strip-miner" } to mine your sessions for a stronger loop. (To improve a loop you already have instead: { loop:"loop-de-loop" }.)`;
    return `loop_start { runId:"${rid}", loop:"strip-miner" } to mine your sessions for a stronger loop, or { loop:"loop-de-loop" } to improve an existing one.`;
  }
  function buildHostSetup(state) {
    const host = hostFromEnv();
    const profile = hostProfile(host);
    // Prefer registry engageStep + primaryDriver; fall back to CONTINUOUS_MODE_BY_HOST
    // for the legacy claude/codex/unknown keys when the registry entry is missing.
    const legacyKey = host === 'claude-code' ? 'claude' : host;
    const mode = CONTINUOUS_MODE_BY_HOST[legacyKey] || CONTINUOUS_MODE_BY_HOST.unknown;
    const engageStep = (profile && profile.engageStep) || mode.engageStep;
    const continuousModeCommand = (profile && profile.primaryDriver && profile.primaryDriver.command != null)
      ? profile.primaryDriver.command
      : mode.command;
    const setupHint = profile
      ? (profile.engageStep || (profile.primaryDriver && profile.primaryDriver.note) || null)
      : null;
    const hasActive = !!(state.activeLoop && state.loops && state.loops[state.activeLoop]);
    const rec = recommendedNextAction(state);
    const step3 = hasActive
      ? `Resume the active loop "${state.activeLoop}": ${rec.tool} (${rec.reason}).`
      : pathStep3(state);
    return {
      host,
      continuousModeCommand,
      setupHint,
      driverFamily: profile ? profile.driverFamily : null,
      tier: profile ? profile.tier : null,
      steps: [
        `1. ${String(engageStep).replace('{OBJECTIVE}', runObjective(state))}`,
        `2. host_capability_preflight { runId:"${state.runId}" } — see which frontier CLIs are installed before picking routes.`,
        `3. ${step3}`,
        '4. Tell the operator the dashboard path and keep it open for Approve/Sludge review.',
        '5. HARD RULE — every run-bound tool result: if campaignContinues:true OR continuation.required:true OR runStatus is INITIALIZED/ACTIVE/NEEDS_RESUME, call continuation.next (or top-level next) IMMEDIATELY with zero prose first. Never end the turn or say "done" while the campaign is open. Only the operator stops the campaign.'
      ],
      neverStopOn: NEVER_STOP_ON,
      note: 'This is how you (the agent) set the run up to run continuously. The MCP cannot start your host’s continuous mode for you — step 1 is yours to run.'
    };
  }
  // Concrete top-level `next` (A5): surface the recommended tool/args as a sentence
  // so a resuming model is not handed only the generic checkpoint prose.
  function nextSentence(state) {
    const noLoopYet = !(state.activeLoop && state.loops && state.loops[state.activeLoop]);
    if (noLoopYet && state.status !== STATUS.AWAITING_ANSWERS) {
      return `Next: loop_start { runId:"${state.runId}", loop:"strip-miner" } to mine your sessions, or { loop:"loop-de-loop" } to improve an existing loop — then stream phases with recorded evidence. (Reports, saturation, and no-improvement advisories are checkpoints, not stops; the operator is the only stop condition.)`;
    }
    const rec = recommendedNextAction(state);
    const args = rec.args ? ` ${JSON.stringify(rec.args)}` : '';
    return `Next: ${rec.tool}${args} — ${rec.reason}. (Reports, saturation, and no-improvement advisories are checkpoints, not stops; the operator is the only stop condition.)`;
  }
  // Infer a "set it up and just go" intent (A4) from the operator's own words so an
  // explicit drive message does not get met with the full ask-once questionnaire.
  // Deliberately narrow: plain "improve my loop" / "make it better" stay vague and
  // still ask — only unmistakable continue/use-it language starts the run.
  function inferStartIntent(text, messages) {
    const parts = [String(text || '')];
    if (Array.isArray(messages)) for (const m of messages) parts.push(String(m && m.text != null ? m.text : m));
    const blob = parts.join(' \n ').toLowerCase();
    if (!blob.trim()) return false;
    return /(keep going|keep running|don'?t stop|do not stop|never stop|until i stop|until you'?re stopped|use it and go|just (?:run|start|go)\b|find it and use|set (?:it|everything) up and (?:go|run)|run it until|use super ?loop (?:and|to))/i.test(blob);
  }
  function startAssumptions(state) {
    const pol = activePolicy(state);
    return [
      'You did not run the ask-once questionnaire — I inferred an actionable start from your message and began moving. Steer anytime from the dashboard or by sending answers.',
      'Default start: MINE your sessions for a stronger loop (Strip Miner); on saturation I auto-pivot to improving the best loop (Loop-de-loop).',
      'Default scope: whole session history, best loops improved first.',
      `Default models (surfaced because you said just go): primary ${pol.primary}; test routes ${pol.testRoutes.join(', ')}; builders ${pol.builderRoutes.join(', ')}; judge ${pol.judgeRoute}; banlist mode "${pol.banlist.mode}". Override at init with answers or { model / modelPolicy }.`,
      `"Better" becomes the frozen, tool-measured benchmark I derive from your goal${state.task && state.task.text ? `: "${trimText(state.task.text, 120)}"` : ''}. Name a hard limit anytime and I will honor it.`
    ];
  }
  function requireContinuation(state, source, reason) {
    const c = ensureContinuation(state);
    const ts = clock();
    if (!c.required) c.id = nextId(state, 'continuation', 'cont');
    c.required = true;
    c.inProgress = false;
    c.since = c.since || ts;
    c.source = source;
    c.reason = reason;
    c.next = recommendedNextAction(state);
    c.clearedAt = null;
    c.clearedBy = null;
    c.history.push({ id: c.id, ts, event: 'required', source, reason, next: c.next });
    logEvent(state, 'continuation_required', { id: c.id, source });
    return c;
  }
  function clearContinuation(state, source, detail = null) {
    const c = ensureContinuation(state);
    if (!c.required) return c;
    const ts = clock();
    c.required = false;
    c.inProgress = false;
    c.clearedAt = ts;
    c.clearedBy = source;
    c.history.push({ id: c.id, ts, event: 'cleared', source, detail });
    logEvent(state, 'continuation_cleared', { id: c.id, source });
    return c;
  }
  // ---- supervisor lanes / target queue / auto-transition -----------------
  // The supervisor owns transitions. Worker output is an untrusted proposal; only
  // a supervisor-accepted transition counts as progress. On saturation or branch
  // retirement the supervisor AUTO-TRANSITIONS to the next lane — it never pauses,
  // awaits the operator, or marks the campaign complete. The operator is the only
  // stop condition.
  function ensureCampaign(state) {
    if (!state.campaign) state.campaign = { lanes: [], activeLaneId: null, transitions: [] };
    if (!Array.isArray(state.campaign.lanes)) state.campaign.lanes = [];
    if (!Array.isArray(state.campaign.transitions)) state.campaign.transitions = [];
    return state.campaign;
  }
  function laneKindForLoop(loopId) {
    const meta = MANDATED_LOOPS[loopId];
    if (meta && meta.role === 'mine') return LANE_KIND.MINE;
    return LANE_KIND.IMPROVE; // loop-de-loop, custom loops, and improvement lanes
  }
  function activeLane(state) {
    const c = ensureCampaign(state);
    return c.lanes.find((l) => l.id === c.activeLaneId) || null;
  }
  // The current improvement branch. If none is active (e.g. after a retirement
  // pivot, or tests run without an explicit loop_start), open a fresh improve lane
  // so branch accounting always has a home. Never returns null.
  function ensureActiveLane(state) {
    const existing = activeLane(state);
    if (existing && existing.status === LANE_STATUS.ACTIVE) return existing;
    return ensureLaneForLoop(state, state.activeLoop || 'loop-de-loop');
  }
  function ensureLaneForLoop(state, loopId) {
    const c = ensureCampaign(state);
    let lane = c.lanes.find((l) => l.loop === loopId && l.status === LANE_STATUS.ACTIVE);
    if (!lane) {
      lane = { id: nextId(state, 'lane', 'lane'), kind: laneKindForLoop(loopId), loop: loopId, status: LANE_STATUS.ACTIVE, noImproveBatches: 0, since: clock(), retiredAt: null };
      c.lanes.push(lane);
    }
    c.activeLaneId = lane.id;
    return lane;
  }
  // Decide the next lane after the current one saturates/retires. Mining → improve
  // the best available loop with Loop-de-loop; improving → the next improvement
  // branch (operator queues the loop; the supervisor never stops to ask).
  function planNextLane(state, fromLane) {
    if (fromLane && fromLane.kind === LANE_KIND.MINE) {
      return { kind: LANE_KIND.IMPROVE, loop: 'loop-de-loop',
        firstAction: 'loop_start { loop:"loop-de-loop" } to harden the best available loop, then lock baseline → freeze benchmark → 3-5 frontier challengers' };
    }
    return { kind: LANE_KIND.IMPROVE, loop: null,
      firstAction: 'open the next improvement branch: register_hypotheses for the next bottleneck (or loop_start a queued loop), then run full measured tests' };
  }
  // The auto-transition itself. `cause` is 'saturation' | 'branch_retirement'.
  function autoTransition(state, cause, detail = {}) {
    const c = ensureCampaign(state);
    const from = activeLane(state);
    if (from) {
      from.status = cause === 'saturation' ? LANE_STATUS.SATURATED : LANE_STATUS.RETIRED;
      from.retiredAt = clock();
    }
    const plan = planNextLane(state, from);
    let to = null;
    if (plan.loop) {
      // reuse an existing active lane for that loop, else queue a fresh one
      to = c.lanes.find((l) => l.loop === plan.loop && l.status === LANE_STATUS.ACTIVE)
        || { id: nextId(state, 'lane', 'lane'), kind: plan.kind, loop: plan.loop, status: LANE_STATUS.ACTIVE, noImproveBatches: 0, since: clock(), retiredAt: null };
      if (!c.lanes.includes(to)) c.lanes.push(to);
      c.activeLaneId = to.id;
    } else {
      // No concrete next loop pinned yet; clear the active lane pointer but keep the
      // campaign running with a continuation that points at opening the next branch.
      c.activeLaneId = null;
    }
    const tid = nextId(state, 'transition', 'trans');
    c.transitions.push({ id: tid, ts: clock(), cause, from: from ? from.id : null, fromKind: from ? from.kind : null, to: to ? to.id : null, toKind: plan.kind, toLoop: plan.loop, detail });
    logEvent(state, 'auto_transition', { cause, from: from ? from.id : null, to: to ? to.id : null, toLoop: plan.loop });
    requireContinuation(state, `auto_transition_${cause}`,
      `${cause === 'saturation' ? 'Mining lane saturated' : 'Branch retired after ' + DEFAULTS.branchRetirementBatches + ' valid no-improvement test batches'} — supervisor auto-transitioned to the next ${plan.kind} lane. This is a pivot, not a stop. ${plan.firstAction}`);
    return { transitionId: tid, from, to, plan };
  }

  function writeDashboardForState(state) {
    if (state.realTest && state.realTest.enabled === true) {
      state.realTest.experimentValidity = deriveExperimentValidity(state, state.realTest, store);
    }
    const html = renderDashboard(state);
    const path = store.writeRunFile(state.runId, 'dashboard.html', html);
    state.dashboardPath = path;
    return { path, warningIncluded: html.includes(STOP_CONDITION_WARNING) };
  }

  // ---- ask-once helpers --------------------------------------------------
  // Honor the operator's chosen primary under the active banlist. NEVER silently
  // rewrite a banned route to the default, and NEVER silently accept it into
  // INITIALIZED — the init path holds at AWAITING_ANSWERS with ONE confirmation
  // question (needsConfirmation). resolveModel only classifies; it does not commit.
  function resolveModel(requested, policy) {
    const pol = policy ? normalizeModelPolicy(policy) : defaultModelPolicy();
    if (!requested) {
      return {
        primary: pol.primary, declared: false, warning: null, banned: false,
        needsConfirmation: false, classification: null, reason: null
      };
    }
    const c = classifyRoute(requested, pol);
    if (c.ok) {
      return {
        primary: requested, declared: true, warning: null, banned: false,
        needsConfirmation: false, classification: c, reason: null
      };
    }
    const pattern = c.matchedPattern ? ` (matched ${c.matchedPattern})` : '';
    const reason = `Requested model "${requested}" is banned under banlist mode "${pol.banlist.mode}"${pattern}: ${c.reason}`;
    return {
      // provisional primary for the confirmation payload only — init will NOT
      // commit this into INITIALIZED until the operator confirms or changes.
      primary: requested,
      declared: true,
      banned: true,
      needsConfirmation: true,
      classification: c,
      reason,
      warning: null
    };
  }
  function modelConfirmationQuestion(pending) {
    const req = pending.requested;
    return `Your requested model "${req}" is banned under the active banlist (${pending.reason}). Confirm in one reply: say "use it anyway" to disable the banlist for this run and keep "${req}", name another model, or press enter / say "defaults" for ${DEFAULT_PRIMARY_MODEL}. This is the only confirmation — I will not ask again.`;
  }
  function modelConfirmationOptions(requested) {
    return {
      useAnyway: `use it anyway — banlist off for this run, keep "${requested}"`,
      pickAnother: 'name another model (e.g. claude-opus-4-8 or gpt-5.5)',
      defaults: `press enter / say "defaults" for ${DEFAULT_PRIMARY_MODEL} + standard frontier set`
    };
  }
  /**
   * Resolve the single confirmation answer. Never re-asks: a still-banned
   * alternate falls through to defaults with a note.
   */
  function resolveModelConfirmationAnswer(answerText, pending, args) {
    const raw = String(answerText == null ? '' : answerText).trim();
    const lower = raw.toLowerCase();
    // Explicit args.model on the confirmation turn wins as "pick another".
    if (args && typeof args.model === 'string' && args.model.trim()
      && (!raw || !/\b(use it anyway|anyway|any model|defaults?|enter)\b/i.test(raw))) {
      const alt = args.model.trim();
      const pol = defaultModelPolicy('operator-init');
      pol.primary = alt;
      const info = resolveModel(alt, pol);
      if (!info.banned) {
        pol.judgeRoute = alt;
        return { policy: normalizeModelPolicy(pol, { source: 'operator-init' }), choice: 'alternate', note: null };
      }
      // still banned via args.model alone → use-anyway if they also said so, else defaults
    }
    if (!raw || /^(defaults?|enter|default|standard|no|cancel|use defaults?|just defaults?)$/i.test(lower)) {
      return { policy: defaultModelPolicy('defaults'), choice: 'defaults', note: null };
    }
    if (/\b(use it anyway|anyway|any model|allow it|yes keep|banlist\s*off|disable (?:the )?banlist|confirm|keep it)\b/i.test(lower)) {
      const pol = defaultModelPolicy('operator-init');
      pol.banlist.mode = 'off';
      pol.primary = pending.requested;
      pol.judgeRoute = pending.requested;
      if (!listIncludes(pol.testRoutes, pol.primary)) {
        pol.testRoutes = [pol.primary, ...pol.testRoutes.filter((r) => r !== pol.primary)].slice(0, 5);
      }
      return {
        policy: normalizeModelPolicy(pol, { source: 'operator-init' }),
        choice: 'use-anyway',
        note: `banlist mode set to "off"; primary kept as "${pending.requested}"`
      };
    }
    // Treat as a new model choice / free-form policy text.
    const parsed = parseModelChoiceText(raw);
    let pol = parsed.policy;
    // If they only named a bare model, ensure banlist stays default unless they said any model.
    const info = resolveModel(pol.primary, pol);
    if (!info.banned) {
      return { policy: normalizeModelPolicy(pol, { source: 'operator-init' }), choice: 'alternate', note: null };
    }
    // Still banned after their reply — never re-ask; fall back to defaults.
    return {
      policy: defaultModelPolicy('defaults'),
      choice: 'defaults-after-still-banned',
      note: `"${pol.primary}" is still banned under the default banlist; using defaults (${DEFAULT_PRIMARY_MODEL}) rather than re-asking.`
    };
  }
  function finalizeInitWithPolicy(state, policy, { startIntent, ts, deeperFromAnswers }) {
    const pol = normalizeModelPolicy(policy, { source: policy.source });
    state.config.modelPolicy = pol;
    state.config.model = {
      primary: pol.primary,
      declared: pol.source !== 'defaults',
      autoSelected: pol.source === 'defaults',
      bannedUnderPolicy: false
    };
    state.pendingModelConfirmation = null;
    state.status = STATUS.INITIALIZED;
    state.task.sufficiency = 'sufficient';
    state.task.path = computeCampaignPath(state) || null;
    state.questions = [];
    logEvent(state, 'initialized', {
      model: state.config.model.primary,
      modelPolicySource: pol.source,
      banlistMode: pol.banlist.mode,
      mode: state.task.mode,
      path: state.task.path
    });
    state.updatedAt = ts;
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok('Initialized. Ask-once is complete; I will not ask again or mark the run complete by myself.', {
      runId: state.runId, runStatus: state.status, model: state.config.model,
      modelPolicy: pol,
      needsConfirmation: false,
      briefing: 'I will keep the run moving after this. The dashboard is always on and available for review. The model can queue or list review items, but only the operator can Approve or Sludge them from the dashboard. If a mining lane saturates or produces no winners, that is a checkpoint; the next step is to improve or harden the best available loop.',
      coldStartNotice: COLD_START_NOTICE,
      stopCondition: STOP_CONDITION_WARNING,
      nativeContinuation: NATIVE_CONTINUATION_NOTICE,
      hostSetup: buildHostSetup(state),
      assumptions: startIntent ? startAssumptions(state) : undefined,
      deeperExplanation: deeperFromAnswers ? deeperExplanation(state) : undefined,
      sotaAdvisory: `Using ${pol.primary} as the primary route (policy source: ${pol.source}, banlist: ${pol.banlist.mode}). Check current SOTA via web search at the start (OpenAI / Anthropic / Google / Z.ai), and override modelPolicy at init if a stronger frontier model exists. Run host_capability_preflight to see which frontier CLIs are installed locally. Under banlist mode "default", non-frontier routes (haiku/mini/nano/lite/prior-gen) are rejected for full tests; say "any model" at init to disable the banlist for this run.`,
      builderRoutingAdvisory: `Builds and in-loop gating route to ${pol.builderRoutes.join(' or ')} under the active modelPolicy. Codex/GPT stays a supported host surface but is not a trusted in-loop builder/gating worker unless listed in modelPolicy.builderRoutes. Frontier test workers default to ${pol.testRoutes.join(', ')}.`,
      failurePatience: state.config.failurePatience, branchRetirementBatches: state.config.branchRetirementBatches, mode: state.task.mode,
      runMode: state.config.runMode, maxCycles: state.config.maxCycles,
      limitNotice: state.config.runMode === 'bounded'
        ? `Bounded run: after ${state.config.maxCycles} full test(s) — or the failure/exhaustion advisory — you MAY stop your /loop (campaignContinues flips to false). Until then, keep going. The operator can still stop earlier or extend the limit.`
        : 'Infinite run: never self-stops. campaignContinues stays true until the operator stops you. Set config.maxCycles at init for a bounded run that may stop itself at the limit.',
      storedUserMessages: state.userMessages.length,
      dashboardPath: dash.path,
      dashboardAlwaysOn: true,
      continuation: continuationPayload(state),
      next: 'Call loop_start { runId, loop:"strip-miner" } (The Strip Miner Loop) or { loop:"loop-de-loop" } (Loop 2), or a custom loop registered with loop_register. Sections stream one at a time and require recorded evidence before the next section unlocks. Reports are checkpoints, not stopping points.'
    });
  }
  function holdForModelConfirmation(state, modelInfo, { ts }) {
    const requested = modelInfo.primary;
    const reason = modelInfo.reason || modelInfo.classification?.reason || 'banned under active banlist';
    const pending = {
      requested,
      reason,
      options: modelConfirmationOptions(requested),
      ts
    };
    state.pendingModelConfirmation = pending;
    state.status = STATUS.AWAITING_ANSWERS;
    state.task.sufficiency = 'insufficient';
    state.questions = [modelConfirmationQuestion(pending)];
    // Do not commit a banned primary as the run's live primary for gates.
    state.config.modelPolicy = defaultModelPolicy('defaults');
    state.config.model = {
      primary: DEFAULT_PRIMARY_MODEL,
      declared: false,
      autoSelected: true,
      bannedUnderPolicy: false,
      pendingRequest: requested
    };
    logEvent(state, 'model_confirmation_required', { requested, reason });
    state.updatedAt = ts;
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok('Your model choice needs a quick confirmation before I start — one question only; I will not ask again after this.', {
      runId: state.runId,
      runStatus: state.status,
      needsConfirmation: true,
      confirmation: {
        requested: pending.requested,
        reason: pending.reason,
        options: pending.options
      },
      questions: state.questions,
      model: state.config.model,
      defaultModelPolicy: state.config.modelPolicy,
      briefing: 'Answer the confirmation, then I initialize and keep moving. The dashboard stays available. You remain the stop condition.',
      coldStartNotice: COLD_START_NOTICE,
      stopCondition: STOP_CONDITION_WARNING,
      nativeContinuation: NATIVE_CONTINUATION_NOTICE,
      hostSetup: buildHostSetup(state),
      dashboardPath: dash.path,
      dashboardAlwaysOn: true,
      continuation: continuationPayload(state),
      next: `Call initialize_loop_run again with { runId:"${state.runId}", answers:["use it anyway" | "<other-model>" | "defaults"] }. This is the only confirmation turn.`
    });
  }
  /**
   * Build the run's modelPolicy from operator inputs (args.modelPolicy,
   * args.modelPreset, args.model,
   * free-form model answer text). Defaults when nothing is said = today's behavior.
   */
  function resolveModelPolicyFromInit(args, answers, questions) {
    const notes = [];
    let partial = null;
    let source = 'defaults';
    const explicitModelPolicy = args && args.modelPolicy && typeof args.modelPolicy === 'object'
      ? args.modelPolicy
      : null;

    if (args && typeof args.modelPreset === 'string' && args.modelPreset.trim()) {
      const preset = modelPolicyPreset(args.modelPreset);
      if (preset) {
        partial = preset;
        source = preset.source;
        notes.push(`model preset "${args.modelPreset.trim()}" selected`);
      }
    }

    // Scan answers for a model-choice reply (keyword hit, or the dedicated question index).
    const answerTexts = (answers || []).map((a) => String(a && a.text != null ? a.text : a));
    let modelAnswer = null;
    if (questions && questions.length) {
      const modelQIdx = questions.findIndex((q) => /which models do you want to use/i.test(q));
      if (modelQIdx >= 0 && answerTexts[modelQIdx] != null && String(answerTexts[modelQIdx]).trim()) {
        modelAnswer = String(answerTexts[modelQIdx]);
      }
    }
    if (!modelAnswer) {
      modelAnswer = answerTexts.find((t) =>
        /\b(defaults?|any models?|banlist|primary\s*[:=]|test\s+routes?|builder\s+routes?|judge\s*[:=]|(?:claude|gpt|glm|gemini|grok|opus|sonnet|haiku)[-_a-z0-9.]+)\b/i.test(t)
      ) || null;
    }
    if (modelAnswer) {
      const parsed = parseModelChoiceText(modelAnswer);
      partial = { ...(partial || {}), ...parsed.policy, banlist: parsed.policy.banlist };
      // If parse said defaults and we already had operator modelPolicy args, keep args.
      if (parsed.source === 'operator-init' || parsed.source.startsWith('preset:')) source = parsed.source;
      notes.push(...parsed.notes);
      if (parsed.source === 'defaults') notes.push('model answer resolved to defaults');
      else notes.push('model answer applied from operator reply');
    }

    // Structured init configuration is authoritative over free-form answer text.
    // Answers may supply omitted policy fields, but cannot widen or replace fields
    // the operator explicitly provided in modelPolicy.
    if (explicitModelPolicy) {
      partial = { ...(partial || {}), ...explicitModelPolicy };
      source = 'operator-init';
      notes.push('modelPolicy supplied in initialize_loop_run args');
    }

    if (args && typeof args.model === 'string' && args.model.trim()) {
      partial = partial || {};
      partial.primary = args.model.trim();
      if (source === 'defaults') source = 'operator-init';
      notes.push(`primary set from args.model="${args.model.trim()}"`);
    }

    const policy = normalizeModelPolicy(partial || defaultModelPolicy(source), { source });
    const modelInfo = resolveModel(policy.primary, policy);
    // If not banned, commit primary into policy; if banned, leave policy as-is for
    // the confirmation hold (do not rewrite — do not commit either).
    if (!modelInfo.banned) {
      policy.primary = modelInfo.primary;
      if (!listIncludes(policy.testRoutes, policy.primary)) {
        if (source === 'operator-init' && policy.testRoutes.length === 3
          && policy.testRoutes[0] === DEFAULT_PRIMARY_MODEL) {
          policy.testRoutes = [policy.primary, ...policy.testRoutes.filter((r) => r !== policy.primary)].slice(0, 5);
        }
      }
      if (!policy.judgeRoute) policy.judgeRoute = policy.primary;
    }
    return { policy: normalizeModelPolicy(policy, { source }), modelInfo, notes };
  }
  function listIncludes(arr, item) {
    const key = String(item || '').toLowerCase();
    return (arr || []).some((x) => String(x).toLowerCase() === key);
  }
  function inferMode(text) {
    const t = String(text || '');
    const subjective = /\b(website|web ?page|landing|copy|copywrit|design|ui|ux|prompt|loop|email|content|brand|hero|logo|article|essay|story)\b/i.test(t);
    const deterministic = /\b(\d+\s?ms|latency|throughput|faster|load time|p9\d|compile|build time|memory|bundle size|fps|deterministic)\b/i.test(t);
    if (subjective && !deterministic) return 'subjective';
    if (deterministic && !subjective) return 'deterministic';
    return 'mixed';
  }
  function isTaskSpecific(text, ac) {
    if (ac && String(ac).trim().length > 0) return true;
    const t = String(text || '').trim();
    const words = wordCount(t);
    const hasMetric = /\b(\d+\s?(?:ms|s|sec|%|px|tokens?|fps)|under|over|at least|at most|<=|>=|pass(?:es|ing)?|score|benchmark|accuracy|conversion|p9\d|latency|reduce|increase)\b/i.test(t);
    const vagueOnly = /^(?:please\s+)?(?:just\s+)?(?:improve|fix|make (?:it|this|the loop) better|optimi[sz]e|enhance|do (?:the )?loop|better)\b/i.test(t) && !hasMetric;
    if (vagueOnly) return false;
    return words >= 8 && hasMetric;
  }
  // Ask-once questions cover what the operator alone can answer: the goal, the
  // starting point, how WIDE to mine, what ORDER to improve in, what "better"
  // means, any task-specific hard limit, and ONE friendly model-choice question.
  // Promotion mode, benchmark policy, measurement authority, integrity, and the
  // standing guarantees stay tool-owned — never posed back. The deeper-explanation
  // offer stays LAST (wantsDeeperExplanation weights the final answer).
  function generateQuestions() {
    return [
      'In one sentence: what is the end result a successful run must produce?',
      'Which path? (a) IMPROVE a loop you already run, (b) DISCOVER/find a loop (optionally scouting a public loop library), or (c) MINE your whole session history (deep). Improving an existing loop is the fastest path to a proven win.',
      'If improving or discovering: name the loop/prompt/repo/page to start from (or the domain to search). If discovering, should I also scout a public loop library for candidates — yes or no?',
      'If mining or discovering: search your WHOLE session history, or stop after a set number of loops? Give a number, or say "whole history". And after mining, improve the BEST loops first, or go in the order found? Heads-up — a run can go for hours, days, or weeks depending on how deep I mine; best-first surfaces value soonest.',
      'In plain English, what would make the result clearly better? I turn this into the frozen, tool-measured benchmark.',
      'Anything task-specific I must not break? The standing guarantees — evidence-gated promotion, a hash-locked baseline, no cost regression, and your authorship — always hold, so name only the extras.',
      'Which models do you want to use? (primary worker, and optionally: test routes, builder routes, judge). Press enter / say \'defaults\' for ' + DEFAULT_PRIMARY_MODEL + ' + the standard frontier set. Say \'any model\' to disable the banlist for this run.',
      'Want me to explain how Loop Factory enforces this before I start, or should I just keep moving after this?'
    ];
  }
  // Explain-first: a brief, plain-English account of what the run does and, more
  // importantly, what the operator decides versus what the tool decides — so the
  // questions above are answerable without a wall of policy choices.
  function askOnceExplanation() {
    return [
      'Loop Factory is the supervisor/harness, not a prompt. It owns campaign state, the target queue, transitions, benchmark math, the dashboard, and stop policy.',
      'I hold the full private Strip Miner and Loop-de-loop inside the harness and stream them one section at a time, each gated on recorded evidence. A worker model can only PROPOSE artifacts or transitions; a summary, a "done", a confidence claim, or a bare tool call is never progress — only a supervisor-accepted transition counts. I freeze a benchmark from your definition of "better", lock the baseline by hash, measure baseline and challenger on the same yardstick, compute the delta myself, and re-verify from sealed bytes before any promotion.',
      'You decide the goal, whether to start by mining or by improving an existing loop, how wide to mine (your whole history or a set number of loops), what order to improve in (best-first or in order), what "better" means, any hard limit, and the models for this run. You choose the models (defaults shown: primary ' + DEFAULT_PRIMARY_MODEL + ', builders ' + BUILDER_GATING_ROUTES.join(' / ') + ', standard frontier test set); the supervisor still owns measurement, integrity, and promotion. Press enter / say defaults for today\'s behavior; say "any model" to turn the banlist off for this run.',
      'If the Strip Miner saturates I auto-transition to Loop-de-loop or the next lane; a branch retires only after ' + DEFAULTS.branchRetirementBatches + ' valid no-improvement test batches and then pivots — it never ends the campaign. The dashboard stays open the whole run for your Approve/Sludge review, and the run never marks itself complete. You are the only stop condition.'
    ].join(' ');
  }
  function storeMessages(list) {
    return list.map((m, i) => ({ index: i, sha256: sha256(String(m)), chars: String(m).length, text: String(m) }));
  }
  // Leak #2: the 6th ask-once question offers a deeper explanation. Honor the
  // answer — if the operator asks for more, return it in the SAME initialized
  // response. Never re-ask, never block on it.
  function wantsDeeperExplanation(answers) {
    const arr = (answers || []).map((a) => String(a && a.text != null ? a.text : a));
    if (!arr.length) return false;
    // The deeper-explanation offer is always the last question, so weight the
    // last answer; still scan them all in case the operator answered out of order.
    const last = arr[arr.length - 1] || '';
    const hay = `${last} ${arr.join(' ')}`.toLowerCase();
    const positive = /(deep|deeper|more detail|more details|explain|elaborate|verbose|full explanation|tell me more|walk me through|go deeper|yes)/.test(hay);
    const negativeOnly = /(no thanks|no thank|keep moving|just start|skip it|brief is fine|move on|don'?t need|no need)/.test(hay)
      && !/(deep|deeper|more detail|explain|elaborate)/.test(hay);
    return positive && !negativeOnly;
  }
  function deeperExplanation(state) {
    const pol = activePolicy(state);
    return [
      'How Loop Factory actually enforces this (the deeper explanation you asked for):',
      `1) Phase-gated streaming — the full private 345-line Strip Miner and 75-line Loop-de-loop (Loop 2) live inside the supervisor. loop_start hands you one section; request_next_phase only unlocks the next section after evidence is recorded for the current one (PHASE_SKIP otherwise). The full loop never collapses into context before real decisions. You can also add your own loops with loop_register, and they stream the same way.`,
      '2) Benchmark-first — you hash-lock a baseline (write-once) and freeze a task-specific scorecard before any challenger. The scorecard carries a deterministic oracle where possible so quality is tool-scored, not asserted.',
      '3) Tool-measured authority — every metric is derived by the MCP from the raw bytes you record (tokenCost always; quality via the frozen oracle). A number typed by the model is caller-reported and refused by the benchmark/test gates. reverify_run re-derives the metrics from the sealed bytes, so a tampered number cannot survive.',
      '4) The honest boundary — the MCP cannot prove the recorded bytes came from a real frontier-agent run, and it cannot judge subjective quality without an oracle. Subjective wins go to the dashboard for your Approve/Sludge decision and never auto-promote. Deterministic wins can promote autonomously. That split is intentional, not hidden.',
      `5) Models + parallel — full tests need 3–5 agents under the active modelPolicy (primary ${pol.primary}, banlist mode "${pol.banlist.mode}"). Under mode "default", haiku/mini/nano/lite/prior-gen are rejected; you chose the models at init (or accepted defaults). Web-search current SOTA and run host_capability_preflight to see which CLIs are installed.`,
      '6) Continuation rule — reports, dashboards, saturation, and no-improvement advisories create a continuation obligation. continue_run records intent but cannot clear that obligation; only a real progress tool clears it. The operator is the only stop condition.'
    ].join('\n');
  }

  // ---- measurement helpers ----------------------------------------------
  // Every measured number must come from a recorded raw artifact, so it can be
  // re-hashed during reverify. Inline model-reported metrics are rejected.
  function resolveMeasurement(state, ref) {
    if (!ref) return { ok: false, reason: 'no measurementRef — record the raw run via artifact_record (content/measurement) and pass its id; the MCP derives the metrics from the bytes' };
    if (!isSafeId(ref)) return { ok: false, reason: 'invalid measurementRef id (no slashes, spaces, or path traversal)' };
    const art = store.readArtifact(state.runId, ref);
    if (!art) return { ok: false, reason: `measurementRef ${ref} not found` };
    if (!art.measurement) return { ok: false, reason: `artifact ${ref} has no measurement` };
    const tokenCost = Number(art.measurement.tokenCost);
    const quality = Number(art.measurement.quality);
    if (!(tokenCost >= 0) || !(quality >= 0 && quality <= 1)) {
      return { ok: false, reason: `measurement must have tokenCost>=0 and quality in [0,1] (got cost ${tokenCost}, quality ${quality})` };
    }
    return {
      ok: true, metrics: { tokenCost, quality },
      authority: { tokenCost: art.measurement.tokenCostAuthority || CALLER_AUTHORITY, quality: art.measurement.qualityAuthority || CALLER_AUTHORITY },
      measurementRef: ref, sha256: art.sha256
    };
  }
  function validateAgentRun(state, run) {
    const c = classifyRoute(run && run.model, activePolicy(state));
    if (!c.ok) return { ok: false, model: c.model, reason: `route ${c.model}: ${c.reason}`, code: BLOCK.BANNED_ROUTE };
    const m = resolveMeasurement(state, run && run.measurementRef);
    if (!m.ok) return { ok: false, model: c.model, reason: `agent run on ${c.model}: ${m.reason}`, code: BLOCK.MODEL_REPORTED };
    if (m.authority.tokenCost !== TOOL_AUTHORITY) {
      return { ok: false, model: c.model, code: BLOCK.MEASUREMENT_AUTHORITY,
        reason: `agent run on ${c.model}: tokenCost authority is "${m.authority.tokenCost}", not tool-computed. The MCP must derive cost from the recorded bytes — record the raw run via artifact_record without { callerReported:true } and pass that measurementRef. A number the model typed is not evidence.` };
    }
    let execution = null;
    let metrics = {
      ...m.metrics,
      artifactOutputTokenEstimate: m.metrics.tokenCost,
      cliReceiptTokenCost: null
    };
    let authority = { ...m.authority };
    const strictExecution = state.config.realTest && state.config.realTest.enabled === true;
    const hasExecutionRefs = !!(run && (run.rawArtifactRef || run.resultArtifactRef));
    if (strictExecution) {
      const rawArtifactRef = run && run.rawArtifactRef;
      const resultArtifactRef = run && run.resultArtifactRef;
      const evaluationArtifactRef = run && (run.evaluationArtifactRef || run.measurementRef);
      const raw = rawArtifactRef && isSafeId(rawArtifactRef) ? store.readArtifact(state.runId, rawArtifactRef) : null;
      const result = resultArtifactRef && isSafeId(resultArtifactRef) ? store.readArtifact(state.runId, resultArtifactRef) : null;
      const evaluation = evaluationArtifactRef && isSafeId(evaluationArtifactRef)
        ? store.readArtifact(state.runId, evaluationArtifactRef)
        : null;
      const isolation = raw ? inspectWorkerIsolation(raw.content) : null;
      const receiptTokens = raw ? parseTokenUsage(raw.content) : null;
      const rawResult = raw ? extractResult('codex', raw.content) : null;
      const normalizedResult = rawResult ? normalizeStructuredWorkerOutput({}, rawResult) : null;
      const argv = Array.isArray(run.argv) ? run.argv.map(String) : [];
      const disabledFeatures = new Set(
        Array.isArray(run.disabledFeatures) ? run.disabledFeatures.map(String) : []
      );
      const cwdIndex = argv.indexOf('-C');
      const schemaIndex = argv.indexOf('--output-schema');
      const strictLaunch = run.strictIsolation === true
        && run.binaryFamily === 'codex'
        && argv.includes('--ignore-user-config')
        && STRICT_CODEX_DISABLED_FEATURES.every((feature) => (
          disabledFeatures.has(feature)
          && argv.some((value, index) => value === feature && argv[index - 1] === '--disable')
        ))
        && cwdIndex >= 0
        && argv[cwdIndex + 1] === run.workspaceRoot
        && schemaIndex >= 0
        && !!argv[schemaIndex + 1]
        && /^[a-f0-9]{64}$/i.test(String(run.outputSchemaSha256 || ''))
        && run.resultNormalization === 'json-schema-v1'
        && sha256(String(rawResult || '')) === String(run.rawResultSha256 || '')
        && normalizedResult === result?.content;
      const hasProposalEvidence = !!(run.proposalRawArtifactRef
        || run.proposalResultArtifactRef
        || run.proposalStdoutSha256
        || run.proposalResultSha256);
      const proposalVerification = hasProposalEvidence
        ? verifyPersistedProposalRun(store, state.runId, {
            model: c.model,
            rawArtifactRef: run.proposalRawArtifactRef,
            resultArtifactRef: run.proposalResultArtifactRef,
            stdoutSha256: run.proposalStdoutSha256,
            resultSha256: run.proposalResultSha256,
            requestedModel: run.proposalRequestedModel,
            reportedModel: run.proposalReportedModel,
            binaryFamily: run.proposalBinaryFamily,
            argv: run.proposalArgv,
            modelSelectionAuthority: run.proposalModelSelectionAuthority,
            modelIdentityAuthority: run.proposalModelIdentityAuthority,
            reportedModelMatchesRequest: run.proposalReportedModelMatchesRequest,
            strictIsolation: run.proposalStrictIsolation,
            disabledFeatures: run.proposalDisabledFeatures,
            workspaceRoot: run.proposalWorkspaceRoot,
            outputSchemaSha256: run.proposalOutputSchemaSha256,
            rawResultSha256: run.proposalRawResultSha256,
            resultNormalization: run.proposalResultNormalization,
            cliReportedTotalTokens: run.proposalCliReportedTotalTokens,
            cliReportedTokenUsage: run.proposalCliReportedTokenUsage,
            durationMs: run.proposalDurationMs,
            exitCode: run.proposalExitCode,
            isolation: run.proposalIsolation,
            procedureSha256: run.procedureSha256
          })
        : { ok: true };
      if (!raw || !result || !evaluation || evaluationArtifactRef !== m.measurementRef
        || raw.sha256 !== String(run.stdoutSha256 || '')
        || result.sha256 !== String(run.resultSha256 || '')
        || String(run.requestedModel || '') !== c.model
        || String(run.modelSelectionAuthority || '') !== 'explicit-model-flag'
        || Number(run.exitCode) !== 0
        || (run.reportedModel && String(run.reportedModel).toLowerCase() !== c.model.toLowerCase())
        || !isolation || isolation.status !== 'PASS'
        || !strictLaunch
        || !proposalVerification.ok
        || !Number.isFinite(receiptTokens) || receiptTokens <= 0
        || receiptTokens !== Number(run.cliReportedTotalTokens)) {
        return {
          ok: false,
          model: c.model,
          reason: `agent run on ${c.model}: strict executor evidence must directly link matching raw/final/evaluation artifacts, a clean no-tool transcript, exact model routing, exit 0, and re-derived CLI token usage`,
          code: BLOCK.MODEL_REPORTED
        };
      }
      metrics = { ...metrics, tokenCost: receiptTokens, cliReceiptTokenCost: receiptTokens };
      authority = { ...authority, tokenCost: TOOL_AUTHORITY };
      execution = {
        rawArtifactRef,
        resultArtifactRef,
        evaluationArtifactRef,
        requestedModel: String(run.requestedModel || ''),
        reportedModel: run.reportedModel || null,
        binaryFamily: run.binaryFamily || null,
        argv,
        modelSelectionAuthority: run.modelSelectionAuthority || null,
        modelIdentityAuthority: run.modelIdentityAuthority || null,
        reportedModelMatchesRequest: run.reportedModelMatchesRequest ?? null,
        strictIsolation: run.strictIsolation === true,
        disabledFeatures: [...disabledFeatures],
        workspaceRoot: run.workspaceRoot || null,
        outputSchemaSha256: run.outputSchemaSha256 || null,
        rawResultSha256: run.rawResultSha256 || null,
        resultNormalization: run.resultNormalization || null,
        cliReportedTotalTokens: Number.isFinite(run.cliReportedTotalTokens) ? run.cliReportedTotalTokens : null,
        cliReportedTokenUsage: run.cliReportedTokenUsage || null,
        durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
        exitCode: Number.isFinite(run.exitCode) ? run.exitCode : null,
        isolation,
        stdoutSha256: raw.sha256,
        resultSha256: result.sha256,
        procedureSha256: run.procedureSha256 || null,
        proposalRawArtifactRef: run.proposalRawArtifactRef || null,
        proposalResultArtifactRef: run.proposalResultArtifactRef || null,
        proposalStdoutSha256: run.proposalStdoutSha256 || null,
        proposalResultSha256: run.proposalResultSha256 || null,
        proposalRequestedModel: run.proposalRequestedModel || null,
        proposalReportedModel: run.proposalReportedModel || null,
        proposalBinaryFamily: run.proposalBinaryFamily || null,
        proposalArgv: Array.isArray(run.proposalArgv) ? run.proposalArgv.map(String) : [],
        proposalModelSelectionAuthority: run.proposalModelSelectionAuthority || null,
        proposalModelIdentityAuthority: run.proposalModelIdentityAuthority || null,
        proposalReportedModelMatchesRequest: run.proposalReportedModelMatchesRequest ?? null,
        proposalStrictIsolation: run.proposalStrictIsolation === true,
        proposalDisabledFeatures: Array.isArray(run.proposalDisabledFeatures)
          ? run.proposalDisabledFeatures.map(String)
          : [],
        proposalWorkspaceRoot: run.proposalWorkspaceRoot || null,
        proposalOutputSchemaSha256: run.proposalOutputSchemaSha256 || null,
        proposalRawResultSha256: run.proposalRawResultSha256 || null,
        proposalResultNormalization: run.proposalResultNormalization || null,
        proposalCliReportedTotalTokens: Number.isFinite(run.proposalCliReportedTotalTokens)
          ? run.proposalCliReportedTotalTokens
          : null,
        proposalCliReportedTokenUsage: run.proposalCliReportedTokenUsage || null,
        proposalDurationMs: Number.isFinite(run.proposalDurationMs) ? run.proposalDurationMs : null,
        proposalExitCode: Number.isFinite(run.proposalExitCode) ? run.proposalExitCode : null,
        proposalIsolation: run.proposalIsolation || null
      };
    } else if (hasExecutionRefs) {
      const rawArtifactRef = run && run.rawArtifactRef;
      const resultArtifactRef = run && run.resultArtifactRef;
      const raw = rawArtifactRef && isSafeId(rawArtifactRef) ? store.readArtifact(state.runId, rawArtifactRef) : null;
      const result = resultArtifactRef && isSafeId(resultArtifactRef) ? store.readArtifact(state.runId, resultArtifactRef) : null;
      if (!raw || !result || resultArtifactRef !== m.measurementRef) {
        return {
          ok: false,
          model: c.model,
          reason: `agent run on ${c.model}: executor evidence must directly link raw and measured result artifacts`,
          code: BLOCK.MODEL_REPORTED
        };
      }
      execution = {
        rawArtifactRef,
        resultArtifactRef,
        requestedModel: String(run.requestedModel || ''),
        reportedModel: run.reportedModel || null,
        modelIdentityAuthority: run.modelIdentityAuthority || null,
        cliReportedTotalTokens: Number.isFinite(run.cliReportedTotalTokens) ? run.cliReportedTotalTokens : null,
        durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
        stdoutSha256: raw.sha256,
        resultSha256: result.sha256
      };
    }
    return {
      ok: true,
      model: c.model,
      metrics,
      authority,
      measurementRef: m.measurementRef,
      reverifiable: true,
      execution
    };
  }
  function summarizeBenchmark(def) {
    const ov = Array.isArray(def.integrityOverride) ? def.integrityOverride : (def.integrityOverride ? [def.integrityOverride] : []);
    return {
      id: def.id, name: def.name,
      taskValueDimensions: def.taskValueDimensions, resourceDimensions: def.resourceDimensions,
      cases: def.cases.length, comparisonRule: def.comparisonRule,
      benchSource: def.benchSource || 'worker',
      benchPartition: def.benchPartition || 'harvest',
      outputClass: normalizeOutputClass(def.outputClass),
      markerOracle: isMarkerOracle(def.oracle),
      integrityOverrides: ov.map((o) => ({ guard: o.guard, scope: o.scope || null, approvedBy: o.approvedBy, reason: o.reason, honored: findOverride({ integrityOverride: [o] }, o.guard).valid }))
    };
  }
  function normalizeBenchmarkInput(b) {
    const tv = b.taskValueDimensions || b.qualityDimensions || [];
    const rd = b.resourceDimensions || b.costDimensions || [];
    const cases = b.cases || [];
    if (!Array.isArray(tv) || tv.length < 1 || !Array.isArray(rd) || rd.length < 1 || !Array.isArray(cases) || cases.length < 1) {
      return { error: blocked(BLOCK.WEAK_BENCHMARK,
        'A benchmark must declare ≥1 task-value dimension, ≥1 resource/cost dimension, and ≥1 concrete case drawn from real prior uses/failures. The benchmark is the bar — it cannot be hand-waved.',
        { got: { taskValueDimensions: tv.length, resourceDimensions: rd.length, cases: cases.length } }) };
    }
    return {
      tv, rd, cases,
      record: {
        name: b.name || null,
        taskValueDimensions: tv, resourceDimensions: rd, cases,
        oracle: b.oracle || null, qualityScale: b.qualityScale || '0..1',
        comparisonRule: b.comparisonRule || null,
        forbiddenShortcuts: b.forbiddenShortcuts || [], invariants: b.invariants || [],
        negativeControl: b.negativeControl || null,
        requireSolutionPressure: b.requireSolutionPressure === true,
        solutionPressure: b.solutionPressure || null,
        routeIndependence: b.routeIndependence || null, requiredRoutes: b.requiredRoutes,
        evidenceBinding: b.evidenceBinding || null,
        outputClass: b.outputClass || null, integrityOverride: b.integrityOverride || null
      }
    };
  }
  function sectionResult(loop, ls, section, mode) {
    const hasNext = section.index + 1 < loop.sections.length;
    return ok(`Streaming ${loop.meta.title} — phase ${section.index + 1}/${loop.sections.length}: ${section.title} (${mode})`, {
      loop: loop.id, trigger: loop.meta.trigger,
      phase: section.index, totalPhases: loop.sections.length, title: section.title,
      section: section.body,
      gate: hasNext
        ? `To unlock phase ${section.index + 1} (0-indexed), record evidence for THIS phase: observation_record or artifact_record with { loop:"${loop.id}", phase:${section.index} }. request_next_phase without evidence returns BLOCKED (PHASE_SKIP).`
        : 'This is the final section. Streaming complete is NOT campaign complete — proceed to baseline/benchmark/hypotheses.',
      note: 'The full loop is held inside the MCP. You get one section at a time so 300+ lines never collapse into the model before real decisions.'
    });
  }

  // ============================ TOOLS ====================================

  function initialize_loop_run(args = {}) {
    if (typeof args.modelPreset === 'string' && args.modelPreset.trim() && !modelPolicyPreset(args.modelPreset)) {
      return blocked(
        BLOCK.BAD_INPUT,
        `Unknown modelPreset "${args.modelPreset.trim()}". Supported preset: "gpt-5.6-sol". No fallback was applied.`
      );
    }
    const ts = clock();
    const answerSource = ['operator', 'config', 'default'].includes(args.answerSource)
      ? args.answerSource
      : 'operator';
    const answerRecord = (answer, index) => ({
      index,
      sha256: sha256(String(answer)),
      text: String(answer),
      source: answerSource,
      ts
    });
    const runId = args.runId || `run-${hash8(String(args.task || '') + ts)}`;
    if (!isSafeId(runId)) return invalidIdBlock('runId', runId);
    if (!store.exists(runId) && !isPortableId(runId)) {
      return blocked(BLOCK.BAD_INPUT, `runId "${runId}" is unsafe for a new cross-platform state directory.`);
    }
    const runCollision = store.runIdCollision(runId);
    if (!store.exists(runId) && runCollision) {
      return blocked(BLOCK.BAD_INPUT, `runId "${runId}" has a case-insensitive collision with existing run "${runCollision}".`);
    }
    let state = store.exists(runId) ? store.load(runId) : freshRun(runId, ts);
    ensureModelPolicy(state); // resume-safe: backfill pre-modelPolicy state.json

    // Always (re)store user messages + task hash locally — this is the hook corpus.
    if (Array.isArray(args.userMessages)) state.userMessages = storeMessages(args.userMessages);
    if (typeof args.task === 'string' && args.task.trim()) {
      state.task.text = args.task;
      state.task.sha256 = sha256(args.task);
    }
    if (args.acceptanceCriteria) state.task.acceptanceCriteria = String(args.acceptanceCriteria);

    // Ask-once already satisfied → idempotent. NEVER ask again.
    if ([STATUS.INITIALIZED, STATUS.ACTIVE, STATUS.NEEDS_RESUME].includes(state.status)) {
      if (Array.isArray(args.answers)) {
        state.answers = args.answers.map(answerRecord);
        state.task.path = computeCampaignPath(state) || state.task.path || null;
      }
      state.updatedAt = ts;
      const dash = writeDashboardForState(state);
      store.save(state);
      const deeper = wantsDeeperExplanation(state.answers) ? deeperExplanation(state) : undefined;
      return ok('Already initialized. Ask-once is satisfied; I will not ask again or mark the run complete by myself.',
        { runId, runStatus: state.status, model: state.config.model, modelPolicy: activePolicy(state), needsConfirmation: false, dashboardPath: dash.path, dashboardAlwaysOn: true, stopCondition: STOP_CONDITION_WARNING, nativeContinuation: NATIVE_CONTINUATION_NOTICE, hostSetup: buildHostSetup(state), deeperExplanation: deeper, continuation: continuationPayload(state), next: nextSentence(state) });
    }

    // Pending banned-model confirmation: resolve ONE answer, never re-ask.
    if (state.status === STATUS.AWAITING_ANSWERS && state.pendingModelConfirmation) {
      const answersProvided = Array.isArray(args.answers) && args.answers.length > 0;
      if (!answersProvided && !(args && typeof args.model === 'string' && args.model.trim())
        && !(args && args.modelPolicy && typeof args.modelPolicy === 'object')) {
        // Re-surface the same confirmation — do not invent a second question.
        const pending = state.pendingModelConfirmation;
        const dash = writeDashboardForState(state);
        store.save(state);
        return ok('Still waiting on the model confirmation (one question only).', {
          runId, runStatus: state.status,
          needsConfirmation: true,
          confirmation: { requested: pending.requested, reason: pending.reason, options: pending.options },
          questions: state.questions,
          dashboardPath: dash.path,
          dashboardAlwaysOn: true,
          stopCondition: STOP_CONDITION_WARNING,
          next: `Call initialize_loop_run with { runId:"${runId}", answers:["use it anyway" | "<other-model>" | "defaults"] }.`
        });
      }
      const confText = answersProvided
        ? String(args.answers[args.answers.length - 1] && args.answers[args.answers.length - 1].text != null
          ? args.answers[args.answers.length - 1].text
          : args.answers[args.answers.length - 1])
        : '';
      if (answersProvided) {
        state.answers = [
          ...(state.answers || []),
          ...args.answers.map((a, i) => answerRecord(a, (state.answers || []).length + i))
        ];
      }
      const resolvedConf = resolveModelConfirmationAnswer(confText, state.pendingModelConfirmation, args);
      if (args && args.modelPolicy && typeof args.modelPolicy === 'object') {
        // Explicit full policy on the confirmation turn wins.
        const pol = normalizeModelPolicy(args.modelPolicy, { source: 'operator-init' });
        const info = resolveModel(pol.primary, pol);
        if (!info.banned) {
          return finalizeInitWithPolicy(state, pol, {
            startIntent: false, ts,
            deeperFromAnswers: wantsDeeperExplanation(state.answers)
          });
        }
      }
      return finalizeInitWithPolicy(state, resolvedConf.policy, {
        startIntent: false, ts,
        deeperFromAnswers: wantsDeeperExplanation(state.answers)
      });
    }

    // First-time configuration (failure patience / bounds / comparison — model policy
    // is resolved later once we know answers vs just-go, so banlist honor is consistent).
    if (args.config && Number.isFinite(args.config.failurePatience)) {
      state.config.failurePatience = clamp(Math.round(args.config.failurePatience), 10, 15);
    }
    if (args.config && Number.isFinite(args.config.maxCycles) && args.config.maxCycles > 0) {
      // Operator-set bounded limit (max full tests). Parsed once at first-init — a worker
      // cannot set it mid-run — so bounded-mode stop never weakens "operator is the only
      // stop": the operator set the limit; the engine enforces it; the host obeys.
      state.config.maxCycles = Math.round(args.config.maxCycles);
      state.config.runMode = 'bounded';
    }
    if (args.config && args.config.realTest && args.config.realTest.enabled === true) {
      const raw = args.config.realTest;
      const cleanHash = (value) => /^[a-f0-9]{64}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
      state.config.realTest = {
        enabled: true,
        maxFindings: Number.isInteger(raw.maxFindings) ? Math.max(1, raw.maxFindings) : 5,
        maxImprovementAttempts: Number.isInteger(raw.maxImprovementAttempts) ? Math.max(1, raw.maxImprovementAttempts) : 10,
        planSha256: cleanHash(raw.planSha256),
        benchmarkSha256: cleanHash(raw.benchmarkSha256),
        approvedPlanSha256: cleanHash(raw.approvedPlanSha256),
        planApproved: raw.planApproved === true,
        benchmarkAuthority: raw.benchmarkAuthority === 'maker' ? 'maker' : null,
        baselineStrategy: raw.baselineStrategy === 'route-batch' ? 'route-batch' : null,
        parentRunId: isSafeId(raw.parentRunId) ? raw.parentRunId : null,
        findingId: isSafeId(raw.findingId) ? raw.findingId : null,
        evidenceManifest: Array.isArray(raw.evidenceManifest)
          ? raw.evidenceManifest
              .filter((item) => item && typeof item === 'object')
              .map((item) => ({
                path: String(item.path || ''),
                bytes: Number.isInteger(item.bytes) ? item.bytes : null,
                sha256: /^[a-f0-9]{64}$/i.test(String(item.sha256 || '')) ? String(item.sha256).toLowerCase() : null
              }))
          : []
      };
      state.realTest = {
        enabled: true,
        status: 'PREPARING',
        findingsAccepted: 0,
        findingsRejected: 0,
        findingsTested: 0,
        findingsBlocked: 0,
        attemptsPlanned: 0,
        attemptsValid: 0,
        attemptsInvalid: 0,
        coverage: [],
        improvementAttempts: 0,
        invalidAttempts: 0,
        latestSubRunId: null,
        benchmarkLocked: false,
        baselineSamples: 0,
        updatedAt: ts,
        experimentValidity: null
      };
      state.realTest.experimentValidity = deriveExperimentValidity(state, state.realTest, store);
    }
    if (args.config && args.config.comparisonRule) state.config.comparisonRule = args.config.comparisonRule;
    if (args.config && args.config.promotion) state.config.promotion = { ...state.config.promotion, ...args.config.promotion };
    state.task.mode = (args.config && args.config.mode) || inferMode(state.task.text);

    const answersProvided = Array.isArray(args.answers) && args.answers.length > 0;
    if (answersProvided) {
      state.answers = args.answers.map(answerRecord);
    }

    // A4: an explicit "set it up and just go" message starts the run with surfaced
    // default assumptions instead of the full questionnaire. Narrow on purpose —
    // plain "improve my loop" stays vague and still asks.
    const startIntent = !answersProvided
      && !isTaskSpecific(state.task.text, state.task.acceptanceCriteria)
      && inferStartIntent(state.task.text, state.userMessages);
    const specific = isTaskSpecific(state.task.text, state.task.acceptanceCriteria) || answersProvided || startIntent;

    // Anchor an objective when an explicit drive message starts the run without a task
    // string (the run-1d313906 case: userMessages set, task.text empty → path null and
    // the benchmark/objective never anchored). Derive it from the operator's own
    // message; never fabricate one. computeCampaignPath below then picks up the text.
    if (startIntent && !String(state.task.text || '').trim() && state.userMessages.length) {
      state.task.text = trimText(state.userMessages.map((m) => m.text).join(' '), 400);
      state.task.sha256 = sha256(state.task.text);
    }

    if (!specific) {
      state.status = STATUS.AWAITING_ANSWERS;
      state.task.sufficiency = 'insufficient';
      state.questions = generateQuestions();
      state.pendingModelConfirmation = null;
      // Seed default policy on the awaiting state so the dashboard shows defaults early.
      state.config.modelPolicy = defaultModelPolicy('defaults');
      state.config.model = { primary: state.config.modelPolicy.primary, declared: false, autoSelected: true };
      logEvent(state, 'ask_once', { count: state.questions.length });
      state.updatedAt = ts;
      const dash = writeDashboardForState(state);
      store.save(state);
      return ok('First, a brief on what this does and what you decide; then a few short questions so we do not burn tokens on the wrong task. This is the only time I will ask. After this I keep moving, and you remain the stop condition.', {
        runId, runStatus: state.status,
        explanation: askOnceExplanation(),
        questions: state.questions,
        needsConfirmation: false,
        defaultModelPolicy: state.config.modelPolicy,
        briefing: 'I will keep the run moving after this. The dashboard is always on and available for review. The model can queue or list review items, but only the operator can Approve or Sludge them from the dashboard. If a mining lane saturates or produces no winners, that is a checkpoint; the next step is to improve or harden the best available loop.',
        coldStartNotice: COLD_START_NOTICE,
        stopCondition: STOP_CONDITION_WARNING,
        nativeContinuation: NATIVE_CONTINUATION_NOTICE,
        hostSetup: buildHostSetup(state),
        dashboardPath: dash.path,
        dashboardAlwaysOn: true,
        continuation: continuationPayload(state),
        next: 'Call initialize_loop_run again with { runId, answers:[...] } to begin. If the operator already told you the goal and to just go, you can infer the answers from their message and pass them now instead of waiting. Answer the last question to request a deeper explanation in that same response.'
      });
    }

    // Resolve model policy now that we know answers / just-go / args.model.
    // "Just go" and specific-task paths with no model input → defaults (today's behavior).
    const resolved = resolveModelPolicyFromInit(
      args,
      state.answers,
      state.questions.length ? state.questions : generateQuestions()
    );
    const modelInfo = resolved.modelInfo;

    // Banned under active banlist → hold at AWAITING_ANSWERS with ONE confirmation.
    // Never silently rewrite; never proceed to INITIALIZED with a buried warning.
    if (modelInfo.banned || modelInfo.needsConfirmation) {
      return holdForModelConfirmation(state, modelInfo, { ts });
    }

    return finalizeInitWithPolicy(state, resolved.policy, {
      startIntent: !!startIntent,
      ts,
      deeperFromAnswers: wantsDeeperExplanation(state.answers)
    });
  }

  function loop_start(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}". Call initialize_loop_run first.`);
    const g = requireInitialized(state); if (g) return g;
    const target = requestedLoopTarget(state, args.loop);
    if (target.error) return target.error;
    if (!target.id) return unknownLoopBlock(state, args.loop);
    const id = target.id;
    // Pin an immutable, hash-locked snapshot of a custom loop into the run.
    if (!resolveLoopId(id) && !(state.customLoops && state.customLoops[id])) {
      const rec = store.readLoop(id);
      if (rec) { state.customLoops = state.customLoops || {}; state.customLoops[id] = rec; }
    }
    const loop = loadAnyLoop(state, id);
    if (!state.loops[id]) state.loops[id] = { phaseCursor: 0, totalPhases: loop.sections.length, evidence: {}, startedAt: clock(), origin: loop.meta.origin || 'mandated' };
    state.activeLoop = id;
    if (state.status === STATUS.INITIALIZED) state.status = STATUS.ACTIVE;
    const lane = ensureLaneForLoop(state, id); // supervisor opens/activates the lane for this loop
    const ls = state.loops[id];
    const section = loop.sections[ls.phaseCursor];
    clearContinuation(state, 'loop_start', { loop: id, phase: ls.phaseCursor });
    logEvent(state, 'loop_start', { loop: id, phase: ls.phaseCursor, lane: lane.id, laneKind: lane.kind });
    state.updatedAt = clock();
    store.save(state);
    return { ...sectionResult(loop, ls, section, 'started'), lane: { id: lane.id, kind: lane.kind }, continuation: continuationPayload(state) };
  }

  function advancePhase(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const target = requestedLoopTarget(state, args.loop, { fallbackActive: true });
    if (target.error) return target.error;
    const id = target.id;
    if (!id) return blocked(BLOCK.NO_ACTIVE_LOOP, 'No active loop. Call loop_start first.');
    const ls = state.loops[id];
    if (!ls) return blocked(BLOCK.NOT_STARTED, `Loop "${id}" not started. Call loop_start { loop:"${id}" }.`);
    const loop = loadAnyLoop(state, id);
    const current = ls.phaseCursor;
    const ev = ls.evidence[current] || [];
    if (ev.length === 0) {
      return blocked(BLOCK.PHASE_SKIP,
        `Phase ${current} ("${loop.sections[current].title}") has no recorded evidence. Record evidence (observation_record or artifact_record with { loop:"${id}", phase:${current} }) before requesting the next phase. No skipping.`,
        { loop: id, phase: current, title: loop.sections[current].title });
    }
    if (current + 1 >= loop.sections.length) {
      requireContinuation(state, 'stream_complete', `All sections of ${id} streamed; continue into benchmark/hypothesis work or the next lane.`);
      state.updatedAt = clock();
      store.save(state);
      return ok(`All ${loop.sections.length} sections of ${id} have streamed. Streaming complete is not campaign completion. Proceed to baseline, benchmark, and hypotheses; if this lane saturates, pivot to the next improvement lane.`,
        { loop: id, phase: current, totalPhases: loop.sections.length, streamComplete: true, continuation: continuationPayload(state), next: continuationDirective(state, 'Do not stop here.') });
    }
    ls.phaseCursor = current + 1;
    const section = loop.sections[ls.phaseCursor];
    clearContinuation(state, 'request_next_phase', { loop: id, phase: ls.phaseCursor });
    logEvent(state, 'advance_phase', { loop: id, phase: ls.phaseCursor });
    state.updatedAt = clock();
    store.save(state);
    return { ...sectionResult(loop, ls, section, 'advanced'), continuation: continuationPayload(state) };
  }

  function observation_record(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const summary = String(args.summary || '').trim();
    if (!summary) return blocked(BLOCK.BAD_INPUT, 'observation_record needs a non-empty summary (what you actually did/observed for this phase).');
    const target = phaseEvidenceTarget(state, args);
    if (target.error) return target.error;
    const oid = nextId(state, 'observation', 'obs');
    let unlocked = null;
    let lid = null, phase = null;
    if (target.wantsPhase) {
      lid = target.loop;
      phase = target.phase;
      (state.loops[lid].evidence[phase] = state.loops[lid].evidence[phase] || []).push(oid);
      unlocked = { loop: lid, phase };
    }
    state.observations.push({ id: oid, ts: clock(), loop: lid, phase, kind: args.kind || 'observation', summary, sourceRef: args.sourceRef || null });
    if (unlocked) clearContinuation(state, 'observation_record', unlocked);
    state.updatedAt = clock();
    store.save(state);
    return ok(`Observation ${oid} recorded.`, {
      observationId: oid, evidenceFor: unlocked,
      note: unlocked ? `Phase ${unlocked.phase} now has evidence; request_next_phase will advance.` : 'No loop/phase attached; this does not unlock a phase.',
      continuation: continuationPayload(state)
    });
  }

  function artifact_record(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const phaseTarget = phaseEvidenceTarget(state, args);
    if (phaseTarget.error) return phaseTarget.error;

    let content = args.content;
    if (content == null && args.sourcePath) {
      return blocked(BLOCK.BAD_INPUT,
        'sourcePath reads are disabled. Pass explicit content captured by host-approved tools; the MCP will not read arbitrary local files on a model-supplied path.');
    }
    content = String(content == null ? '' : content);
    const digest = sha256(content);
    const aid = nextId(state, 'artifact', 'art');
    const role = args.role || 'evidence';

    // Measurement authority (leak #3 hardening): the MCP DERIVES the measurement
    // from the recorded bytes — tokenCost always, quality via the frozen
    // benchmark's deterministic oracle when one exists. The caller's numbers are
    // retained only as `claimed`. The one way to record a weak caller-reported
    // measurement is to opt in explicitly with { callerReported:true }, which
    // exists solely so the benchmark/test/promotion gates can prove they refuse it.
    let measurement = null;
    const wantsMeasurement = (args.measurement && typeof args.measurement === 'object') || args.measure === true;
    if (wantsMeasurement) {
      const claimed = (args.measurement && typeof args.measurement === 'object') ? args.measurement : {};
      if (args.callerReported === true) {
        const tc = Number(claimed.tokenCost); const q = Number(claimed.quality);
        measurement = {
          tokenCost: tc, quality: Number.isFinite(q) ? q : null,
          tokenCostAuthority: CALLER_AUTHORITY, qualityAuthority: CALLER_AUTHORITY,
          claimed: { tokenCost: Number.isFinite(tc) ? tc : null, quality: Number.isFinite(q) ? q : null },
          oracleScored: false
        };
      } else {
        const oracle = (state.benchmark && state.benchmark.frozen && state.benchmark.def) ? state.benchmark.def.oracle : null;
        measurement = deriveMeasurement(content, oracle, claimed);
      }
    }
    const classification = classifyArtifact({ role, name: args.name || aid, content, artifactClass: args.artifactClass, provesBehaviorChange: args.provesBehaviorChange });
    const record = { id: aid, ts: clock(), role, name: args.name || aid, sha256: digest, chars: content.length, content, measurement, ...classification };

    // Step 3 — manual-run provenance. An artifact recorded AS EVIDENCE FOR a hypothesis
    // (hypothesisId) that has NO Loop Factory-executed run must carry provenance, so a hand-run
    // (or unspawnable-route) result is traceable rather than an invisible, unbacked claim.
    if (args.hypothesisId != null) {
      const hyp = state.hypotheses.find((x) => x.id === args.hypothesisId);
      if (!hyp) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
      record.hypothesisId = hyp.id;
      if (hyp.executorRan !== true) {
        const prov = typeof args.provenance === 'string' ? args.provenance.trim() : '';
        if (!prov) {
          return blocked(BLOCK.MANUAL_PROVENANCE_REQUIRED,
            `Hypothesis ${hyp.id} (route ${hyp.route && hyp.route.model}) has no Loop Factory-executed run on record. A manually recorded artifact for it must carry { provenance:"<CLI command + timestamp + operator note>" } so a hand-run result is traceable, not an unbacked claim.`,
            { hypothesisId: hyp.id, route: hyp.route && hyp.route.model });
        }
        record.provenance = prov;
      }
    }

    if (role === 'baseline') {
      // Step 1 — author authority + integrity floor, BEFORE any hash-lock write.
      const claimedSource = ['operator', 'maker', 'worker'].includes(args.baselineSource) ? args.baselineSource : 'worker';
      let baselineSource = 'worker';
      if (claimedSource === 'maker' || claimedSource === 'operator') {
        if (operatorAuthority && args.baselineAuthority === operatorAuthority) {
          baselineSource = claimedSource; // operator-authorized out of band → trusted, floor waived
        } else {
          return blocked(BLOCK.BASELINE_AUTHOR_FORBIDDEN,
            `A "${claimedSource}" baseline requires the operator authority (operator-controlled, out of band). Without it the claim is refused, so a worker cannot self-elevate to skip the integrity floor.`,
            { claimedSource });
        }
      }
      if (baselineSource === 'worker') {
        const floor = checkBaselineIntegrity(content);
        if (!floor.ok) return blocked(floor.code, floor.reason, { evidence: floor.evidence });
      }
      record.baselineSource = baselineSource;
      if (state.baseline.recorded) {
        if (state.baseline.sha256 === digest) {
          // idempotent re-record of the same baseline
        } else if (args.newEpoch && args.rationale) {
          state.baseline = { recorded: true, artifactId: aid, sha256: digest, name: record.name, lockedAt: clock(), epoch: (state.baseline.epoch || 1) + 1, rationale: String(args.rationale), baselineSource, selfBar: false };
          store.writeArtifact(state.runId, aid, record);
        } else {
          return blocked(BLOCK.BASELINE_LOCKED,
            `Baseline already hash-locked to ${state.baseline.sha256}. A different baseline (${digest}) is refused to prevent tampering. To replace it, pass { newEpoch:true, rationale:"..." } (a new metric epoch between cycles).`,
            { existing: state.baseline.sha256, incoming: digest });
        }
      } else {
        state.baseline = { recorded: true, artifactId: aid, sha256: digest, name: record.name, lockedAt: clock(), epoch: 1, baselineSource, selfBar: false };
        store.writeArtifact(state.runId, aid, record);
      }
    } else {
      // Step 1 — a non-baseline artifact that reuses the locked baseline's exact bytes
      // means the worker authored both the bar and a challenger; flag it so benchmark_run
      // refuses to let that baseline set the bar (the Opus self-bar pattern).
      if (state.baseline.recorded && digest === state.baseline.sha256) state.baseline.selfBar = true;
      store.writeArtifact(state.runId, aid, record);
    }

    // Optional phase evidence.
    let unlocked = null;
    if (phaseTarget.wantsPhase) {
      const lid = phaseTarget.loop;
      const phase = phaseTarget.phase;
      (state.loops[lid].evidence[phase] = state.loops[lid].evidence[phase] || []).push(aid);
      unlocked = { loop: lid, phase };
    }
    logEvent(state, 'artifact_record', { id: aid, role });
    if (role === 'baseline' || measurement || unlocked) clearContinuation(state, 'artifact_record', { artifactId: aid, role, evidenceFor: unlocked });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Artifact ${aid} recorded (sha256 ${digest.slice(0, 12)}…).`, {
      artifactId: aid, sha256: digest, role,
      artifactClass: classification.artifactClass, stoneEligible: classification.stoneEligible, eligibilityReason: classification.eligibilityReason,
      baseline: role === 'baseline' ? state.baseline : undefined,
      measurementRecorded: !!measurement,
      measurement: measurement ? {
        tokenCost: measurement.tokenCost, quality: measurement.quality,
        tokenCostAuthority: measurement.tokenCostAuthority, qualityAuthority: measurement.qualityAuthority,
        note: measurement.qualityAuthority === TOOL_AUTHORITY
          ? 'tokenCost + quality tool-computed from the recorded bytes; reverifiable.'
          : 'tokenCost tool-computed from bytes; quality is caller-reported (no deterministic oracle) → dashboard authority, cannot auto-promote.'
      } : undefined,
      evidenceFor: unlocked,
      continuation: continuationPayload(state)
    });
  }

  function benchmark_propose(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (state.benchmark.frozen && state.benchmark.def && state.benchmark.def.benchSource === 'maker') {
      return ok('Worker benchmark proposals are ignored while a bench-maker benchmark is frozen.', {
        benchmarkIds: [], makerFrozen: true, frozen: summarizeBenchmark(state.benchmark.def), continuation: continuationPayload(state)
      });
    }
    const benches = Array.isArray(args.benchmarks) ? args.benchmarks : (args.benchmark ? [args.benchmark] : []);
    if (!benches.length) return blocked(BLOCK.BAD_INPUT, 'Provide benchmarks:[{name, taskValueDimensions:[...], resourceDimensions:[...], cases:[...], oracle, qualityScale}].');
    const created = [];
    for (const b of benches) {
      if (b.benchSource === 'maker') {
        return blocked(BLOCK.BAD_INPUT, 'benchSource:"maker" is set only via benchmark_freeze_maker, not worker benchmark_propose.');
      }
      const norm = normalizeBenchmarkInput(b);
      if (norm.error) return norm.error;
      const bid = nextId(state, 'benchmark', 'bench');
      state.benchmark.proposals.push({
        id: bid, name: norm.record.name || bid,
        ...norm.record,
        comparisonRule: norm.record.comparisonRule || state.config.comparisonRule,
        benchSource: 'worker',
        benchPartition: b.benchPartition === 'gate' ? 'gate' : 'harvest',
        ts: clock()
      });
      created.push(bid);
    }
    clearContinuation(state, 'benchmark_propose', { benchmarkIds: created });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Recorded ${created.length} benchmark proposal(s).`, {
      benchmarkIds: created,
      continuation: continuationPayload(state),
      next: 'Hash-lock the baseline (artifact_record role=baseline), then benchmark_select to freeze one scorecard before any hypothesis.'
    });
  }

  // Integrity Gate v0: deterministic-oracle negative-control precondition. Returns a
  // sealed INTEGRITY_GATE block if the benchmark cannot fail a fake; otherwise records
  // the failing negative control on state and returns null. Run on EVERY freeze path
  // (first-freeze AND newEpoch) so a deterministic oracle introduced via newEpoch also
  // records its NC and can later promote — the gap that blocked a real win in
  // run-1d313906 (deterministic oracle added via newEpoch never recorded its NC, so
  // promotion sealed NEGATIVE_CONTROL_PASSED on null).
  function applyNegativeControlPrecondition(state, def) {
    if (!isDeterministicOracle(def.oracle)) { state.benchmark.negativeControl = null; return null; }
    if (state.config.realTest && state.config.realTest.enabled === true) {
      if (def.oracle?.kind !== CASE_RESULTS_ORACLE_KIND_V2 || !isCaseResultsOracle(def.oracle)) {
        return blocked(BLOCK.BENCHMARK_GAMEABLE,
          'Strict real-test benchmarks must use the case-results-v2 decision oracle; legacy or answer-visible marker oracles are refused before worker execution.');
      }
      const gameability = evaluateCaseResultsGameability(def.oracle);
      if (!gameability.ok) {
        return blocked(BLOCK.BENCHMARK_GAMEABLE,
          'Strict real-test benchmark failed the freeze-time gameability controls.',
          { gameability });
      }
      state.benchmark.gameability = { ...gameability, checkedAt: clock() };
    }
    const ncRaw = def.negativeControl;
    const ncContent = (ncRaw && typeof ncRaw === 'object') ? String(ncRaw.content == null ? '' : ncRaw.content) : (typeof ncRaw === 'string' ? ncRaw : standardNegativeControl());
    const passMark = Number.isFinite(ncRaw && ncRaw.passMark) ? Number(ncRaw.passMark)
      : (Number.isFinite(def.oracle && def.oracle.passMark) ? Number(def.oracle.passMark) : DEFAULT_PASS_MARK);
    const nc = negativeControlVerdict(ncContent, def.oracle, passMark);
    const source = ncRaw ? 'author' : 'auto';
    if (nc.passed) return sealReason(state, SEALED.NEGATIVE_CONTROL_PASSED, { benchmarkId: def.id, score: nc.score, passMark: nc.passMark, ncSha256: nc.sha256, source });
    state.benchmark.negativeControl = { sha256: nc.sha256, score: nc.score, passMark: nc.passMark, passed: false, chars: nc.chars, source, ts: clock() };
    return null;
  }

  function benchmark_select(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline first (artifact_record { role:"baseline", content:"..." }). The baseline is the thing challengers must beat.');
    const def = state.benchmark.proposals.find((p) => p.id === args.benchmarkId);
    if (!def) return blocked(BLOCK.BAD_INPUT, `Unknown benchmarkId "${args.benchmarkId}". Propose one first (benchmark_propose).`, { proposals: state.benchmark.proposals.map((p) => p.id) });
    if (state.benchmark.frozen) {
      if (state.benchmark.def.id === def.id) return ok('Benchmark already frozen (idempotent).', { frozen: summarizeBenchmark(state.benchmark.def) });
      if (args.newEpoch && args.rationale) {
        // Run the same NC precondition the first-freeze path runs — a deterministic
        // oracle introduced via newEpoch must record its NC (or be sealed), else it
        // could never autonomously promote.
        const sealed = applyNegativeControlPrecondition(state, def); if (sealed) return sealed;
        state.benchmark.def = def; state.benchmark.frozenAt = clock(); state.benchmark.epoch = (state.benchmark.epoch || 1) + 1; state.benchmark.baselineScore = null;
        clearContinuation(state, 'benchmark_select', { benchmarkId: def.id, newEpoch: true });
        store.save(state);
        return ok('New metric epoch: benchmark re-frozen. Re-run the baseline arm before challengers.', { frozen: summarizeBenchmark(def), epoch: state.benchmark.epoch, continuation: continuationPayload(state) });
      }
      return blocked(BLOCK.BENCHMARK_FROZEN, `Benchmark/scorecard already frozen to ${state.benchmark.def.id}. Changing it mid-cycle is refused (anti-gaming). Open a new epoch with { newEpoch:true, rationale:"..." } only between cycles.`, { frozenId: state.benchmark.def.id });
    }
    // Integrity Gate v0: negative-control precondition (deterministic oracles), run
    // BEFORE freezing — a failing benchmark must not leave benchmark.frozen=true.
    const sealedFirst = applyNegativeControlPrecondition(state, def); if (sealedFirst) return sealedFirst;
    state.benchmark.frozen = true; state.benchmark.def = def; state.benchmark.frozenAt = clock(); state.benchmark.epoch = 1;
    clearContinuation(state, 'benchmark_select', { benchmarkId: def.id });
    logEvent(state, 'benchmark_frozen', { id: def.id, negativeControl: state.benchmark.negativeControl ? { passed: false, score: state.benchmark.negativeControl.score, source: state.benchmark.negativeControl.source } : null });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Benchmark "${def.name}" is frozen. The scorecard is now immutable for this cycle.`, {
      frozen: summarizeBenchmark(def),
      continuation: continuationPayload(state),
      next: 'Run the baseline arm through it (benchmark_run { arm:"baseline", measurementRef }) to set the tool-measured bar, then register 3–5 frontier hypotheses.'
    });
  }

  // Bench-maker path: freeze a held-out or campaign benchmark directly, bypassing
  // worker benchmark_propose. Used by an out-of-lineage bench-maker session only.
  function benchmark_freeze_maker(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline first (artifact_record { role:"baseline", content:"..." }).');
    const b = args.benchmark;
    if (!b || typeof b !== 'object') return blocked(BLOCK.BAD_INPUT, 'benchmark_freeze_maker needs { benchmark:{ name, taskValueDimensions, resourceDimensions, cases, oracle? } }.');
    const norm = normalizeBenchmarkInput(b);
    if (norm.error) return norm.error;
    const partition = args.benchPartition === 'harvest' ? 'harvest' : 'gate';
    if (state.benchmark.frozen) {
      if (state.benchmark.def && state.benchmark.def.benchSource === 'maker' && state.benchmark.def.id && !args.newEpoch) {
        return ok('Bench-maker benchmark already frozen (idempotent).', { frozen: summarizeBenchmark(state.benchmark.def), benchSource: 'maker' });
      }
      if (!(args.newEpoch && args.rationale)) {
        return blocked(BLOCK.BENCHMARK_FROZEN, 'A worker-frozen benchmark is already locked. Bench-maker re-freeze needs { newEpoch:true, rationale:"..." }.', { frozenId: state.benchmark.def && state.benchmark.def.id });
      }
    }
    const bid = nextId(state, 'benchmark', 'bench');
    const def = {
      id: bid, name: norm.record.name || bid,
      ...norm.record,
      comparisonRule: norm.record.comparisonRule || state.config.comparisonRule,
      benchSource: 'maker',
      benchPartition: partition,
      ts: clock()
    };
    const sealed = applyNegativeControlPrecondition(state, def);
    if (sealed) return sealed;
    state.benchmark.proposals.push(def);
    const replacing = state.benchmark.frozen && args.newEpoch;
    state.benchmark.frozen = true;
    state.benchmark.def = def;
    state.benchmark.frozenAt = clock();
    state.benchmark.epoch = replacing ? (state.benchmark.epoch || 1) + 1 : 1;
    if (replacing) state.benchmark.baselineScore = null;
    clearContinuation(state, 'benchmark_freeze_maker', { benchmarkId: def.id, benchSource: 'maker', benchPartition: partition });
    logEvent(state, 'benchmark_frozen', { id: def.id, benchSource: 'maker', benchPartition: partition, negativeControl: state.benchmark.negativeControl ? { passed: false, score: state.benchmark.negativeControl.score, source: state.benchmark.negativeControl.source } : null });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Bench-maker benchmark "${def.name}" frozen (benchSource:maker, benchPartition:${partition}). Worker benchmark_propose is now a no-op for this scorecard.`, {
      frozen: summarizeBenchmark(def), benchSource: 'maker', benchPartition: partition,
      continuation: continuationPayload(state),
      next: 'Run the baseline arm (benchmark_run arm=baseline) if not already set, then proceed with hypotheses/tests on the worker run.'
    });
  }

  function benchmark_run(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze a benchmark first (benchmark_select). The scorecard must be frozen before any measured run.');
    const arm = args.arm || 'baseline';
    const strictRealTest = state.config.realTest && state.config.realTest.enabled === true;
    const baselineAgentRuns = arm === 'baseline' && Array.isArray(args.agentRuns) ? args.agentRuns : [];
    const batchRefs = arm === 'baseline' && Array.isArray(args.measurementRefs)
      ? args.measurementRefs.map(String).filter(Boolean)
      : [];
    let m = null;
    if (baselineAgentRuns.length) {
      if (!strictRealTest) {
        return blocked(BLOCK.BAD_INPUT, 'baseline agentRuns are reserved for strict real-test executor receipts.');
      }
      if (baselineAgentRuns.length < DEFAULTS.fullTestAgentsMin || baselineAgentRuns.length > DEFAULTS.fullTestAgentsMax) {
        return blocked(
          BLOCK.FULLTEST_AGENTS,
          `Strict real-test baseline must use ${DEFAULTS.fullTestAgentsMin}-${DEFAULTS.fullTestAgentsMax} captured worker runs; received ${baselineAgentRuns.length}.`
        );
      }
      const validated = baselineAgentRuns.map((run) => validateAgentRun(state, run));
      const failed = validated.filter((item) => !item.ok);
      if (failed.length) {
        return blocked(BLOCK.MODEL_REPORTED, `Baseline batch rejected: ${failed[0].reason}. Every baseline route must bind to re-readable executor receipts.`);
      }
      if (validated.some((item) => item.authority.quality !== TOOL_AUTHORITY)) {
        return blocked(BLOCK.MEASUREMENT_AUTHORITY, 'Strict real-test baseline rejected: every route quality must be tool-computed by the frozen deterministic oracle.');
      }
      const qualities = validated.map((item) => item.metrics.quality);
      const costs = validated.map((item) => item.metrics.tokenCost);
      const outputEstimates = validated.map((item) => item.metrics.artifactOutputTokenEstimate);
      m = {
        ok: true,
        metrics: {
          tokenCost: round(mean(costs)),
          artifactOutputTokenEstimate: round(mean(outputEstimates)),
          cliReceiptTokenCost: round(mean(costs)),
          quality: round(mean(qualities)),
          n: validated.length,
          stdevQuality: round(stdev(qualities)),
          minQuality: round(Math.min(...qualities)),
          maxQuality: round(Math.max(...qualities))
        },
        authority: { tokenCost: TOOL_AUTHORITY, quality: TOOL_AUTHORITY },
        measurementRef: null,
        measurementRefs: validated.map((item) => item.measurementRef),
        agentRuns: validated.map((item) => ({
          model: item.model,
          tokenCost: item.metrics.tokenCost,
          artifactOutputTokenEstimate: item.metrics.artifactOutputTokenEstimate,
          cliReceiptTokenCost: item.metrics.cliReceiptTokenCost,
          quality: item.metrics.quality,
          measurementRef: item.measurementRef,
          qualityAuthority: item.authority.quality,
          ...(item.execution || {})
        }))
      };
    } else if (batchRefs.length) {
      if (strictRealTest && (batchRefs.length < DEFAULTS.fullTestAgentsMin || batchRefs.length > DEFAULTS.fullTestAgentsMax)) {
        return blocked(
          BLOCK.FULLTEST_AGENTS,
          `Strict real-test baseline must use ${DEFAULTS.fullTestAgentsMin}-${DEFAULTS.fullTestAgentsMax} captured worker runs; received ${batchRefs.length}.`
        );
      }
      if (new Set(batchRefs).size !== batchRefs.length) {
        return blocked(BLOCK.BAD_INPUT, 'Baseline measurementRefs must be unique; duplicate evidence cannot simulate an independent route batch.');
      }
      const measured = batchRefs.map((measurementRef) => resolveMeasurement(state, measurementRef));
      const failed = measured.filter((item) => !item.ok);
      if (failed.length) {
        return blocked(BLOCK.MODEL_REPORTED, `Baseline batch rejected: ${failed[0].reason}. Every baseline route must bind to a captured measurementRef.`);
      }
      if (measured.some((item) => item.authority.tokenCost !== TOOL_AUTHORITY)) {
        return blocked(BLOCK.MEASUREMENT_AUTHORITY, 'Baseline batch rejected: every route cost must be tool-computed from captured bytes.');
      }
      if (strictRealTest && measured.some((item) => item.authority.quality !== TOOL_AUTHORITY)) {
        return blocked(BLOCK.MEASUREMENT_AUTHORITY, 'Strict real-test baseline rejected: every route quality must be tool-computed by the frozen deterministic oracle.');
      }
      const qualities = measured.map((item) => item.metrics.quality);
      const costs = measured.map((item) => item.metrics.tokenCost);
      m = {
        ok: true,
        metrics: {
          tokenCost: round(mean(costs)),
          quality: round(mean(qualities)),
          n: measured.length,
          stdevQuality: round(stdev(qualities)),
          minQuality: round(Math.min(...qualities)),
          maxQuality: round(Math.max(...qualities))
        },
        authority: {
          tokenCost: TOOL_AUTHORITY,
          quality: measured.every((item) => item.authority.quality === TOOL_AUTHORITY) ? TOOL_AUTHORITY : CALLER_AUTHORITY
        },
        measurementRef: null,
        measurementRefs: measured.map((item) => item.measurementRef)
      };
    } else {
      m = resolveMeasurement(state, args.measurementRef);
    }
    if (!m.ok) return blocked(BLOCK.MODEL_REPORTED, `Benchmark run rejected: ${m.reason}. The bar must be tool-measured with a raw artifact (measurementRef); model self-report never sets or moves the bar.`);
    if (m.authority.tokenCost !== TOOL_AUTHORITY) {
      return blocked(BLOCK.MEASUREMENT_AUTHORITY, `Benchmark run rejected: tokenCost authority is "${m.authority.tokenCost}", not tool-computed. The MCP must derive the bar's cost from recorded bytes; a caller-reported number cannot set the bar challengers are measured against.`, { authority: m.authority });
    }
    if (arm === 'baseline') {
      // Step 1 — block only when there is no author provenance, OR the baseline is
      // worker-authored AND its bytes were also recorded as a challenger (self-bar:
      // worker authored both sides). A clean worker baseline without selfBar is a
      // legitimate bar — do not demand operator/maker authorship in that case.
      if (!state.baseline.baselineSource || (state.baseline.baselineSource === 'worker' && state.baseline.selfBar)) {
        const why = !state.baseline.baselineSource
          ? 'Baseline has no author provenance (baselineSource missing). Record the baseline with explicit authorship, or use an operator/maker-authorized baseline.'
          : 'Worker authored both the baseline and a challenger from the same bytes (selfBar). A worker may set a clean baseline bar, but cannot also author the challenger it is measured against.';
        return blocked(BLOCK.BASELINE_AUTHOR_FORBIDDEN, why,
          { baselineSource: state.baseline.baselineSource || null, selfBar: !!state.baseline.selfBar });
      }
      state.benchmark.baselineScore = {
        tokenCost: m.metrics.tokenCost,
        artifactOutputTokenEstimate: m.metrics.artifactOutputTokenEstimate ?? m.metrics.tokenCost,
        cliReceiptTokenCost: m.metrics.cliReceiptTokenCost ?? null,
        quality: m.metrics.quality,
        source: 'tool',
        qualityAuthority: m.authority.quality,
        measurementRef: m.measurementRef,
        measurementRefs: m.measurementRefs || undefined,
        agentRuns: m.agentRuns || undefined,
        n: m.metrics.n || 1,
        stdevQuality: m.metrics.stdevQuality ?? 0,
        minQuality: m.metrics.minQuality ?? m.metrics.quality,
        maxQuality: m.metrics.maxQuality ?? m.metrics.quality,
        ts: clock()
      };
      clearContinuation(state, 'benchmark_run', {
        arm: 'baseline',
        measurementRef: m.measurementRef,
        measurementRefs: m.measurementRefs || undefined
      });
      logEvent(state, 'baseline_bar_set', {
        ...m.metrics,
        artifactOutputTokenEstimate: m.metrics.artifactOutputTokenEstimate ?? m.metrics.tokenCost,
        cliReceiptTokenCost: m.metrics.cliReceiptTokenCost ?? null,
        strategy: m.measurementRefs ? 'route-batch' : 'single-run'
      });
      state.updatedAt = clock();
      store.save(state);
      return ok(`Baseline bar set: quality ${m.metrics.quality}, tokenCost ${m.metrics.tokenCost} (${m.measurementRefs ? `${m.measurementRefs.length}-run route batch` : 'single run'}, tool-measured).`, {
        baselineScore: state.benchmark.baselineScore, continuation: continuationPayload(state), next: 'Register 3–5 frontier hypotheses (register_hypotheses).'
      });
    }
    const h = state.hypotheses.find((x) => x.id === arm);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `arm "${arm}" is neither "baseline" nor a known hypothesis id.`, { known: state.hypotheses.map((x) => x.id) });
    h.singleRuns = h.singleRuns || [];
    h.singleRuns.push({ ...m.metrics, source: 'tool', measurementRef: m.measurementRef, ts: clock() });
    clearContinuation(state, 'benchmark_run', { arm, measurementRef: m.measurementRef });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Recorded measured arm for ${arm}.`, { arm, metrics: m.metrics, continuation: continuationPayload(state) });
  }

  function register_hypotheses(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline before registering hypotheses (benchmark-first).');
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark/scorecard before registering hypotheses (benchmark-first).');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Run the baseline arm through the frozen benchmark (benchmark_run arm=baseline, tool-measured) to set the bar before challengers. The first benchmark is the whole point — it is not optional.');
    const hyps = Array.isArray(args.hypotheses) ? args.hypotheses : [];
    const strictRealTest = state.config.realTest && state.config.realTest.enabled === true;
    const countOk = strictRealTest
      ? hyps.length === 2
      : hyps.length >= DEFAULTS.hypothesisMin && hyps.length <= DEFAULTS.hypothesisMax;
    if (!countOk) {
      const expected = strictRealTest ? 'exactly 2' : `${DEFAULTS.hypothesisMin}–${DEFAULTS.hypothesisMax}`;
      return blocked(BLOCK.HYPOTHESIS_COUNT, `A ${strictRealTest ? 'strict finding' : 'full test'} needs ${expected} substantive hypotheses; you provided ${hyps.length}.`, { provided: hyps.length });
    }
    if (strictRealTest) {
      for (const hypothesis of hyps) {
        const integrity = checkHypothesisIntegrity(hypothesis, hyps);
        if (!integrity.ok) return blocked(BLOCK.HYPOTHESIS_TOO_SHALLOW, integrity.reason, { evidence: integrity.evidence });
      }
    }
    const pol = activePolicy(state);
    const routes = hyps.map((h) => (h.route && h.route.model) || h.model || '');
    const bad = rejectedRoutes(routes, pol);
    if (bad.length) return blocked(BLOCK.BANNED_ROUTE, `Route(s) rejected under modelPolicy banlist mode "${pol.banlist.mode}": ${bad.map((b) => b.model).join(', ')}. Default frontier set: ${KNOWN_FRONTIER_EXAMPLES.join(', ')}. Say "any model" at init (banlist off) or add banlist.extraAllow to permit a previously-banned route for this run.`, { rejected: bad, modelPolicy: { banlist: pol.banlist, primary: pol.primary } });
    // Builder/gating routing: a hypothesis MAY name the worker that BUILDS its
    // challenger. If named, it must be a trusted builder/gating route under the
    // active modelPolicy (defaults: Opus 4.8 / GLM 5.2). Codex/GPT is a fine
    // frontier TEST worker under the default banlist but not an in-loop builder
    // unless listed in modelPolicy.builderRoutes.
    const builderRoutes = hyps.map((h) => (h.builderRoute && h.builderRoute.model) || h.builderRoute || '').filter(Boolean);
    const badBuilders = rejectedBuilderRoutes(builderRoutes, pol);
    if (badBuilders.length) return blocked(BLOCK.BUILDER_ROUTE, `Builder/gating route(s) rejected: ${badBuilders.map((b) => b.model).join(', ')}. Builds and in-loop gating route to ${pol.builderRoutes.join(' or ')} under the active modelPolicy; Codex/GPT stays a host surface, not an in-loop builder, unless listed in modelPolicy.builderRoutes.`, { rejected: badBuilders, builderRoutes: pol.builderRoutes });
    // Step 3 — wire OR block: a route that passes classifyRoute but maps to no executor
    // binary (opencode not on PATH) is NOT silently accepted. It is refused unless the caller
    // explicitly records it manually WITH provenance, so a hand-run route is honest, not invisible.
    const routeMeta = hyps.map((h) => {
      const route = (h.route && h.route.model) || h.model || '';
      const bin = execBinaryForRoute(route, env);
      const provenance = typeof h.provenance === 'string' ? h.provenance.trim() : '';
      const manual = h.manualRecord === true && provenance.length > 0;
      return { route, bin: bin || null, manual, provenance: manual ? provenance : null };
    });
    const unspawnable = routeMeta.filter((r) => !r.bin && !r.manual);
    if (unspawnable.length) {
      return blocked(BLOCK.ROUTE_UNSPAWNABLE,
        `Route(s) ${unspawnable.map((u) => u.route).join(', ')} have no executor binary and opencode is not on PATH. Either install opencode, register a different (spawnable) route, or record manually with { manualRecord:true, provenance:"<CLI command + timestamp + operator note>" } so a hand-run result is traceable.`,
        { route: unspawnable[0].route, unspawnable: unspawnable.map((u) => u.route), manualAllowed: true });
    }
    const created = [];
    hyps.forEach((h, i) => {
      const suppliedId = strictRealTest ? String(h.id || '') : '';
      const expectedId = strictRealTest && state.config.realTest.findingId
        ? `${state.config.realTest.findingId}-h${i + 1}`
        : null;
      const hid = suppliedId || nextId(state, 'hypothesis', 'hyp');
      if (suppliedId) state.counters.hypothesis = (state.counters.hypothesis || 0) + 1;
      const builderRoute = (h.builderRoute && h.builderRoute.model) || h.builderRoute || null;
      const meta = routeMeta[i];
      if (strictRealTest && (!isSafeId(hid) || (expectedId && hid !== expectedId)
        || state.hypotheses.some((item) => item.id === hid))) {
        created.push(null);
        return;
      }
      state.hypotheses.push({
        id: hid, title: h.title || hid, bottleneck: h.bottleneck || '', operation: h.operation || '',
        expectedMovement: h.expectedMovement || '', route: { model: (h.route && h.route.model) || h.model },
        builderRoute: builderRoute || null,
        executorBin: meta.bin, spawnable: !!meta.bin, manualRecord: meta.manual, provenance: meta.provenance, executorRan: false,
        tradeoff: h.tradeoff || '', falsifier: h.falsifier || '',
        findingId: strictRealTest ? state.config.realTest.findingId : null,
        status: 'REGISTERED', ts: clock()
      });
      created.push(hid);
    });
    if (created.some((id) => !id)) {
      return blocked(BLOCK.HYPOTHESIS_TOO_SHALLOW, 'Strict hypothesis IDs must match the supervisor-assigned finding IDs and be unique.');
    }
    logEvent(state, 'hypotheses_registered', { count: created.length });
    clearContinuation(state, 'register_hypotheses', { hypothesisIds: created });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Registered ${created.length} frontier hypotheses.`, {
      hypothesisIds: created,
      executorBindings: routeMeta.map((m) => ({ route: m.route, executorBin: m.bin, manual: m.manual, spawnable: !!m.bin })),
      continuation: continuationPayload(state),
      next: 'For each, run a full test (test_hypothesis) = 3–5 frontier agents actually running the loop, each metric tool-measured. One no-improvement run is never "perfect".'
    });
  }

  function test_hypothesis(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark before full tests.');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Set the tool-measured baseline bar (benchmark_run arm=baseline) before full tests.');
    const h = state.hypotheses.find((x) => x.id === args.hypothesisId);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
    const ft = args.fullTest || {};
    const runs = Array.isArray(ft.agentRuns) ? ft.agentRuns : [];
    if (runs.length < DEFAULTS.fullTestAgentsMin || runs.length > DEFAULTS.fullTestAgentsMax) {
      return blocked(BLOCK.FULLTEST_AGENTS, `A full test must run the loop with ${DEFAULTS.fullTestAgentsMin}–${DEFAULTS.fullTestAgentsMax} frontier agents (not ${runs.length}). "Think hard and count it as a test" is not a test.`, { provided: runs.length });
    }
    const pol = activePolicy(state);
    const routeBad = runs.map((r) => classifyRoute(r && r.model, pol)).filter((c) => !c.ok);
    if (routeBad.length) return blocked(BLOCK.BANNED_ROUTE, `Full test rejected under banlist mode "${pol.banlist.mode}": agent route(s) ${routeBad.map((c) => c.model).join(', ')}.`, { rejected: routeBad.map((c) => ({ model: c.model, reason: c.reason })) });
    const validated = runs.map((r) => validateAgentRun(state, r));
    const unmeasured = validated.filter((v) => !v.ok);
    if (unmeasured.length) {
      const authorityFail = unmeasured.find((v) => v.code === BLOCK.MEASUREMENT_AUTHORITY);
      if (authorityFail) {
        return blocked(BLOCK.MEASUREMENT_AUTHORITY, `Full test rejected: ${authorityFail.reason} Caller-reported measurements are refused; the MCP owns the cost, derived from the recorded bytes.`, { rejected: unmeasured.map((v) => v.reason) });
      }
      return blocked(BLOCK.MODEL_REPORTED, `Full test rejected: ${unmeasured.length} agent run(s) are not tool-measured. ${unmeasured[0].reason}. Record each raw run via artifact_record (pass the run-log content; the MCP derives cost from the bytes) and pass measurementRef. Model self-reported metrics never count.`, { unmeasured: unmeasured.map((v) => v.reason) });
    }

    const quals = validated.map((v) => v.metrics.quality);
    const costs = validated.map((v) => v.metrics.tokenCost);
    const outputEstimates = validated.map((v) => v.metrics.artifactOutputTokenEstimate);
    const cliReceiptCosts = validated.map((v) => v.metrics.cliReceiptTokenCost);
    const qualityAuthority = validated.every((v) => v.authority.quality === TOOL_AUTHORITY) ? TOOL_AUTHORITY : CALLER_AUTHORITY;
    const agg = {
      tokenCost: round(mean(costs)),
      artifactOutputTokenEstimate: round(mean(outputEstimates)),
      cliReceiptTokenCost: cliReceiptCosts.every(Number.isFinite) ? round(mean(cliReceiptCosts)) : null,
      quality: round(mean(quals)),
      n: validated.length,
      stdevQuality: round(stdev(quals)),
      minQuality: round(Math.min(...quals)),
      maxQuality: round(Math.max(...quals))
    };
    // Movement math uses the same thresholds as promotion, but this batch is NOT yet
    // reverified — store reverified:false and label the response so consumers cannot
    // misread a pre-reverify MOVED_FRONTIER as a shippable win. Promotion gating itself
    // still requires reverify_run (untouched).
    const mv = evaluatePromotion(state.benchmark.baselineScore, { tokenCost: agg.tokenCost, quality: agg.quality, source: 'tool', reverified: true }, state.config.promotion, state.config.comparisonRule);
    const moved = mv.promote === true;
    const verdict = moved
      ? VERDICT.MOVED_FRONTIER
      : (mv.code === BLOCK.STAGED_TRADEOFF ? BLOCK.STAGED_TRADEOFF : VERDICT.NO_IMPROVEMENT);
    const tid = nextId(state, 'test', 'test');
    state.tests.push({
      id: tid, hypothesisId: h.id, ts: clock(),
      agentRuns: validated.map((v) => ({
        model: v.model,
        tokenCost: v.metrics.tokenCost,
        artifactOutputTokenEstimate: v.metrics.artifactOutputTokenEstimate,
        cliReceiptTokenCost: v.metrics.cliReceiptTokenCost,
        quality: v.metrics.quality,
        measurementRef: v.measurementRef,
        qualityAuthority: v.authority.quality,
        reverifiable: v.reverifiable,
        ...(v.execution || {})
      })),
      agg, source: 'tool', qualityAuthority, reverified: false, verdict, movement: mv, verdictBasis: 'pre-reverify'
    });
    if (validated.length > 0 && validated.every((v) => v.execution)) h.executorRan = true;
    if (moved && h.status !== 'PROMOTED_INTERNAL') h.status = VERDICT.MOVED_FRONTIER;
    else if (h.status === 'REGISTERED') h.status = 'TESTED';

    // Supervisor branch/lane accounting. This point is reached ONLY for a VALID
    // full real test batch (3-5 frontier measured runs that passed every gate);
    // invalid, fake-metric, banned-route, model-reported, and summary-only batches
    // were BLOCKED above and never reach here, so they cannot count toward the
    // advisory or toward branch retirement.
    const lane = ensureActiveLane(state);
    let advisory = null;
    let retirement = null;
    if (!moved) {
      state.failures.consecutive++; state.failures.total++;
      lane.noImproveBatches = (lane.noImproveBatches || 0) + 1;
    } else {
      state.failures.consecutive = 0;
      lane.noImproveBatches = 0; // a qualifying improvement keeps this branch alive
    }
    if (state.failures.consecutive >= state.config.failurePatience && !state.failures.exhaustionFlagged) state.failures.exhaustionFlagged = true;
    if (state.failures.exhaustionFlagged) {
      advisory = `Risk advisory: ${state.failures.consecutive} consecutive valid full tests produced no frontier movement (advisory band ${state.config.failurePatience}). This REPORTS RISK ONLY and does not stop the run. Keep running another bottleneck or lane unless the operator explicitly stops the campaign.`;
    }
    // Branch retirement: only after N VALID no-improvement batches in this lane.
    // Retirement PIVOTS to the next lane via the supervisor; it never ends the run.
    if (lane.noImproveBatches >= state.config.branchRetirementBatches && lane.status === LANE_STATUS.ACTIVE) {
      if (h.status !== 'PROMOTED_INTERNAL') h.status = 'RETIRED';
      const t = autoTransition(state, 'branch_retirement', { lane: lane.id, batches: lane.noImproveBatches, hypothesisId: h.id });
      retirement = { laneId: lane.id, batches: lane.noImproveBatches, pivotedToKind: t.plan.kind, pivotedToLoop: t.plan.loop, transitionId: t.transitionId };
    } else if (!moved) {
      requireContinuation(state, 'no_improvement', `Full test ${tid} did not move the frontier; continue into another hypothesis, operation, or lane.`);
    } else {
      clearContinuation(state, 'test_hypothesis', { testId: tid, verdict });
    }
    logEvent(state, 'full_test', { id: tid, hypothesisId: h.id, verdict, lane: lane.id, noImproveBatches: lane.noImproveBatches });
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`Full test ${tid} for ${h.id}: quality ${agg.quality} vs baseline ${state.benchmark.baselineScore.quality}, tokenCost ${agg.tokenCost} vs ${state.benchmark.baselineScore.tokenCost}. Verdict ${verdict} (pre-reverify — not yet shippable). ${mv.message}${retirement ? ` Branch retired after ${retirement.batches} valid no-improvement batches — supervisor auto-pivoted to the next lane (NOT a stop).` : ''}`, {
      testId: tid,
      verdict, // provisional movement signal only — see provisionalVerdict + verdictBasis
      provisionalVerdict: verdict,
      verdictBasis: 'pre-reverify',
      reverified: false,
      aggregate: agg, movement: mv, qualityAuthority,
      qualityNote: qualityAuthority === TOOL_AUTHORITY
        ? 'quality is tool-computed against the frozen oracle — eligible for autonomous promotion after reverify + operator Approve.'
        : 'quality is caller-reported (no deterministic oracle) — a quality win here must go through the dashboard and cannot auto-promote.',
      failureCounter: { consecutive: state.failures.consecutive, total: state.failures.total, patience: state.config.failurePatience, exhaustionFlagged: state.failures.exhaustionFlagged },
      branchRetirement: { laneId: lane.id, noImproveBatches: lane.noImproveBatches, threshold: state.config.branchRetirementBatches, retired: !!retirement },
      retirement: retirement || undefined,
      advisory: advisory || undefined,
      dashboardPath: dash.path,
      continuation: continuationPayload(state),
      next: retirement
        ? `Branch retired and the supervisor auto-pivoted. ${retirement.pivotedToLoop ? `loop_start { loop:"${retirement.pivotedToLoop}" }` : 'open the next improvement branch (register_hypotheses for the next bottleneck)'}. The campaign keeps running.`
        : verdict === VERDICT.MOVED_FRONTIER
        ? `Deep-reverify the winning evidence (reverify_run { testId:"${tid}" }), then promotion_request. The verdict above is pre-reverify only.`
        : 'No promotable movement. This is not a final answer and not a stopping point; iterate another hypothesis, try another operation, or pivot lanes.'
    });
  }

  // OPTIONAL live execution (off by default). When the operator opts in
  // (SUPER_LOOP_ALLOW_EXEC=1) the SUPERVISOR launches the 3-5 frontier workers
  // itself and captures their output, so the evidence is tool-owned end-to-end —
  // there is no model-supplied run-log to fabricate. The captured bytes then flow
  // through the SAME measure/gate/aggregate/verdict/retirement path as a recorded
  // full test. A failed/timed-out/non-allowlisted launch is an INVALID batch and
  // never reaches the counters.
  function execute_full_test(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!isExecEnabled()) {
      return blocked(BLOCK.EXEC_DISABLED,
        'Live worker execution is OFF by default (the audited no-exec posture). This is a CHECKPOINT, not a stop: either set SUPER_LOOP_ALLOW_EXEC=1 to let Loop Factory launch and meter the workers itself, OR run the 3-5 frontier workers in the host and record each run-log via artifact_record + test_hypothesis. Keep going — the operator is the only stop condition.',
        { allowEnv: 'SUPER_LOOP_ALLOW_EXEC=1', campaignContinues: true, next: recommendedNextAction(state) });
    }
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark before an executed full test.');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Set the tool-measured baseline bar before an executed full test.');
    const h = state.hypotheses.find((x) => x.id === args.hypothesisId);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
    const routes = Array.isArray(args.routes) ? args.routes.map((r) => (r && r.model) || r).filter(Boolean) : [];
    if (routes.length < DEFAULTS.fullTestAgentsMin || routes.length > DEFAULTS.fullTestAgentsMax) {
      return blocked(BLOCK.FULLTEST_AGENTS, `execute_full_test launches ${DEFAULTS.fullTestAgentsMin}-${DEFAULTS.fullTestAgentsMax} frontier workers; you gave ${routes.length} route(s).`, { provided: routes.length });
    }
    const pol = activePolicy(state);
    const routeBad = routes.map((r) => classifyRoute(r, pol)).filter((c) => !c.ok);
    if (routeBad.length) return blocked(BLOCK.BANNED_ROUTE, `Route(s) refused under banlist mode "${pol.banlist.mode}": ${routeBad.map((c) => c.model).join(', ')}.`, { rejected: routeBad.map((c) => ({ model: c.model, reason: c.reason })) });
    const notAllow = routes.filter((r) => !execBinaryForRoute(r, env));
    if (notAllow.length) return blocked(BLOCK.EXEC_FAILED, `Routes with no allowlisted executor binary (claude/codex/glm/gemini/opencode families only): ${notAllow.join(', ')}. Family mapping is exec safety — not a model-policy endorsement.`, { notAllowlisted: notAllow });
    const prompt = String(args.prompt == null ? '' : args.prompt).trim();
    if (!prompt) return blocked(BLOCK.BAD_INPUT, 'execute_full_test needs { prompt } — the loop + task the launched worker should actually run.');

    // Launch each worker (sequential; one tool call at a time over stdio).
    const launches = routes.map((model) => runWorker({ model, prompt, timeoutMs: Number(args.timeoutMs) || undefined }));
    const failed = launches.filter((l) => !l.ok);
    if (failed.length) {
      logEvent(state, 'execute_full_test_invalid', { failed: failed.map((f) => f.model) });
      state.updatedAt = clock();
      store.save(state);
      return blocked(BLOCK.EXEC_FAILED,
        `Launched ${routes.length} worker(s); ${failed.length} failed before producing evidence (${failed.map((f) => `${f.model}:${f.reason}`).join(', ')}). An invalid/failed batch does NOT count toward the ${state.config.branchRetirementBatches}-batch retirement.`,
        { failures: failed.map((f) => ({ model: f.model, reason: f.reason, message: f.message })), countedTowardRetirement: false });
    }

    // Persist both the raw CLI envelope and the extracted comparable result. The
    // direct links and invocation hashes travel with the agent run into test_hypothesis.
    const agentRuns = [];
    const workers = [];
    for (const l of launches) {
      const raw = artifact_record({ runId: state.runId, role: 'executor-raw', name: `exec-raw-${l.model}`, content: l.stdout });
      const resultArt = artifact_record({ runId: state.runId, role: 'runlog', name: `exec-result-${l.model}`, content: l.resultText || l.stdout, measure: true });
      agentRuns.push({
        model: l.model,
        measurementRef: resultArt.artifactId,
        rawArtifactRef: raw.artifactId,
        resultArtifactRef: resultArt.artifactId,
        requestedModel: l.invocation.requestedModel,
        reportedModel: l.invocation.reportedModel,
        modelIdentityAuthority: l.invocation.modelSelectionAuthority,
        cliReportedTotalTokens: l.tokenUsage,
        durationMs: l.durationMs,
        stdoutSha256: l.invocation.stdoutSha256,
        resultSha256: l.invocation.resultSha256
      });
      workers.push({
        model: l.model,
        bin: l.bin,
        exitCode: l.exitCode,
        durationMs: l.durationMs,
        bytes: String(l.stdout).length,
        realTokenUsage: l.tokenUsage,
        rawArtifactRef: raw.artifactId,
        resultArtifactRef: resultArt.artifactId,
        measurementRef: resultArt.artifactId
      });
    }
    // Same gate/aggregate/verdict/retirement path as a recorded full test.
    const result = test_hypothesis({ runId: state.runId, hypothesisId: h.id, fullTest: { agentRuns, notes: 'tool-executed via execute_full_test' } });

    const s2 = store.load(state.runId);
    s2.executions = s2.executions || [];
    s2.executions.push({ ts: clock(), hypothesisId: h.id, testId: result.testId || null, workers });
    logEvent(s2, 'execute_full_test', { hypothesisId: h.id, workers: workers.length, testId: result.testId || null, verdict: result.verdict || null });
    s2.updatedAt = clock();
    store.save(s2);
    return {
      ...result,
      executed: true,
      executor: {
        workers,
        note: 'Output was captured by the supervisor (tool-executed) — there is no model-supplied run-log to fabricate. The gate uses the reproducible byte-derived metric; realTokenUsage is the worker-reported count when the CLI emits one (else null → byte estimate).'
      }
    };
  }

  function reverify_run(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    let test = args.testId ? state.tests.find((t) => t.id === args.testId) : null;
    if (!test && args.hypothesisId) {
      test = state.tests.filter((t) => t.hypothesisId === args.hypothesisId && t.verdict === VERDICT.MOVED_FRONTIER).sort((a, b) => b.agg.quality - a.agg.quality)[0];
    }
    if (!test) return blocked(BLOCK.BAD_INPUT, 'Provide testId (or hypothesisId with a moved-frontier test) to reverify.');
    // Re-derive the metrics from the sealed bytes — NOT from the stored measurement
    // field. This is the teeth: a tamper that rewrites the recorded number cannot
    // survive, because the MCP recomputes tokenCost (and oracle quality) from the
    // artifact content and compares to what the test recorded.
    const oracle = (state.benchmark && state.benchmark.def) ? state.benchmark.def.oracle : null;
    const problems = [];
    const recomputed = [];
    for (const run of test.agentRuns) {
      if (!run.measurementRef) { problems.push(`run ${run.model}: no measurementRef`); continue; }
      const art = store.readArtifact(state.runId, run.measurementRef);
      if (!art) { problems.push(`run ${run.model}: artifact ${run.measurementRef} missing`); continue; }
      const reHash = sha256(art.content);
      if (reHash !== art.sha256) { problems.push(`run ${run.model}: artifact bytes tampered (content hash ${reHash}!=${art.sha256})`); continue; }
      const reArtifactOutputTokenEstimate = estimateTokens(art.content);
      let reCost = reArtifactOutputTokenEstimate;
      if (run.rawArtifactRef || run.resultArtifactRef || run.evaluationArtifactRef) {
        const raw = run.rawArtifactRef && store.readArtifact(state.runId, run.rawArtifactRef);
        const result = run.resultArtifactRef && store.readArtifact(state.runId, run.resultArtifactRef);
        const evaluation = run.evaluationArtifactRef && store.readArtifact(state.runId, run.evaluationArtifactRef);
        if (!raw || !result || !evaluation
          || evaluation.id !== run.measurementRef
          || sha256(raw.content) !== raw.sha256
          || sha256(result.content) !== result.sha256
          || raw.sha256 !== run.stdoutSha256
          || result.sha256 !== run.resultSha256) {
          problems.push(`run ${run.model}: linked raw/final/evaluation artifacts do not reverify`);
          continue;
        }
        const isolation = inspectWorkerIsolation(raw.content);
        if (isolation.status !== 'PASS') {
          problems.push(`run ${run.model}: isolation transcript contains tool activity`);
          continue;
        }
        const receiptTokens = parseTokenUsage(raw.content);
        if (!Number.isFinite(receiptTokens) || receiptTokens !== run.cliReportedTotalTokens) {
          problems.push(`run ${run.model}: CLI token receipt does not rederive`);
          continue;
        }
        if (run.requestedModel !== run.model || run.modelSelectionAuthority !== 'explicit-model-flag'
          || run.exitCode !== 0
          || (run.reportedModel && String(run.reportedModel).toLowerCase() !== String(run.model).toLowerCase())) {
          problems.push(`run ${run.model}: model or exit receipt does not match the strict contract`);
          continue;
        }
        if (run.proposalRawArtifactRef || run.proposalResultArtifactRef) {
          const proposalRaw = run.proposalRawArtifactRef && store.readArtifact(state.runId, run.proposalRawArtifactRef);
          const proposalResult = run.proposalResultArtifactRef && store.readArtifact(state.runId, run.proposalResultArtifactRef);
          const proposalPayload = proposalResult ? parseCaseResults(proposalResult.content).payload : null;
          if (!proposalRaw || !proposalResult || !proposalPayload
            || proposalRaw.sha256 !== run.proposalStdoutSha256
            || proposalResult.sha256 !== run.proposalResultSha256
            || inspectWorkerIsolation(proposalRaw.content).status !== 'PASS'
            || sha256(String(proposalPayload.revisedContent || '')) !== run.procedureSha256) {
            problems.push(`run ${run.model}: proposal artifacts or procedure hash do not reverify`);
            continue;
          }
        }
        reCost = receiptTokens;
      }
      if (Number.isFinite(run.artifactOutputTokenEstimate)
        && reArtifactOutputTokenEstimate !== run.artifactOutputTokenEstimate) {
        problems.push(`run ${run.model}: re-derived artifactOutputTokenEstimate ${reArtifactOutputTokenEstimate} != recorded ${run.artifactOutputTokenEstimate} (bytes do not back the cost)`);
        continue;
      }
      const reQual = isDeterministicOracle(oracle)
        ? scoreOracle(art.content, oracle)
        : (art.measurement ? Number(art.measurement.quality) : NaN);
      if (reCost !== run.tokenCost) { problems.push(`run ${run.model}: re-derived tokenCost ${reCost} != recorded ${run.tokenCost} (bytes do not back the cost)`); continue; }
      if (!(Math.abs(reQual - run.quality) < 1e-9)) { problems.push(`run ${run.model}: re-derived quality ${reQual} != recorded ${run.quality} (bytes do not back the quality)`); continue; }
      recomputed.push({
        tokenCost: reCost,
        artifactOutputTokenEstimate: reArtifactOutputTokenEstimate,
        quality: reQual
      });
    }
    let aggOk = false;
    if (recomputed.length === test.agentRuns.length && recomputed.length > 0) {
      const q = round(mean(recomputed.map((r) => r.quality)));
      const c = round(mean(recomputed.map((r) => r.tokenCost)));
      const outputEstimate = round(mean(recomputed.map((r) => r.artifactOutputTokenEstimate)));
      aggOk = Math.abs(q - test.agg.quality) < 1e-9
        && Math.abs(c - test.agg.tokenCost) < 1e-9
        && (!Number.isFinite(test.agg.artifactOutputTokenEstimate)
          || Math.abs(outputEstimate - test.agg.artifactOutputTokenEstimate) < 1e-9);
      if (!aggOk) problems.push(`recomputed aggregate (q${q},c${c}) != stored (q${test.agg.quality},c${test.agg.tokenCost})`);
    }
    const reverified = problems.length === 0 && aggOk;
    test.reverified = reverified; test.reverifiedAt = clock(); test.reverifyProblems = problems;
    if (reverified) clearContinuation(state, 'reverify_run', { testId: test.id });
    logEvent(state, 'reverify', { testId: test.id, reverified });
    state.updatedAt = clock();
    store.save(state);
    if (!reverified) return blocked(BLOCK.NOT_REVERIFIED, `Reverify FAILED for ${test.id}: ${problems.join('; ')}. Promotion stays blocked until the winning evidence reproduces from sealed raw artifacts.`, { testId: test.id, problems });
    return ok(`Reverify PASSED for ${test.id}: all ${test.agentRuns.length} raw artifacts re-hashed clean and metrics reproduce. Winning evidence is independently confirmed.`, { testId: test.id, reverified: true, continuation: continuationPayload(state) });
  }

  function promotion_request(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    if (!state.baseline.recorded) return blocked(BLOCK.BASELINE_FIRST, 'Hash-lock the baseline before promotion.');
    if (!state.benchmark.frozen) return blocked(BLOCK.BENCHMARK_FIRST, 'Freeze the benchmark before promotion.');
    if (!state.benchmark.baselineScore) return blocked(BLOCK.BASELINE_BAR_FIRST, 'Set the tool-measured baseline bar before promotion.');
    const h = state.hypotheses.find((x) => x.id === args.hypothesisId);
    if (!h) return blocked(BLOCK.UNKNOWN_HYPOTHESIS, `Unknown hypothesisId "${args.hypothesisId}".`, { known: state.hypotheses.map((x) => x.id) });
    const tests = state.tests.filter((t) => t.hypothesisId === h.id && t.source === 'tool');
    if (!tests.length) {
      return blocked(BLOCK.NO_SCORE_MATRIX, `No tool-measured full test on the frozen benchmark for ${h.id}. "Old green tests" (e.g. 21/21 unit tests) without a frozen-benchmark score matrix cannot promote. Run test_hypothesis first.`);
    }
    const best = selectBestMeasuredTest(tests, state.benchmark.baselineScore, state.config.promotion, state.config.comparisonRule);
    if (!best) {
      return blocked(BLOCK.NO_SCORE_MATRIX, `No tool-measured full test on the frozen benchmark for ${h.id}. "Old green tests" (e.g. 21/21 unit tests) without a frozen-benchmark score matrix cannot promote. Run test_hypothesis first.`);
    }
    if (!best.reverified) return blocked(BLOCK.NOT_REVERIFIED, `Best test ${best.id} for ${h.id} is not deep-reverified. Run reverify_run { testId:"${best.id}" } before promotion.`, { testId: best.id });
    if (best.qualityAuthority !== TOOL_AUTHORITY) {
      // Honest boundary: the MCP cannot tool-verify subjective quality. Such a win
      // is real work but is HUMAN-gated through the dashboard (Approve/Sludge); the
      // model never auto-promotes it. This is a checkpoint, not a stop.
      requireContinuation(state, 'quality_unverified', `Promotion of ${h.id} needs human Approve on the dashboard (quality is not tool-verifiable); queue it and continue the next lane.`);
      state.updatedAt = clock();
      const dash = writeDashboardForState(state);
      store.save(state);
      return blocked(BLOCK.QUALITY_UNVERIFIED,
        `Promotion refused for ${h.id}: the winning test's quality authority is "${best.qualityAuthority}", not tool-computed. The MCP cannot prove subjective quality moved. For autonomous promotion, freeze a benchmark with a deterministic oracle so quality is tool-computed; otherwise, send this candidate to the dashboard for operator Approve/Sludge. The run remains active; continue the next lane.`,
        { hypothesisId: h.id, qualityAuthority: best.qualityAuthority, dashboardPath: dash.path, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state) });
    }
    const challenger = { tokenCost: best.agg.tokenCost, quality: best.agg.quality, source: 'tool', reverified: true };
    const decision = evaluatePromotion(state.benchmark.baselineScore, challenger, state.config.promotion, state.config.comparisonRule);
    if (!decision.promote) {
      return blocked(decision.code, `Promotion refused for ${h.id}: ${decision.message}.`, { hypothesisId: h.id, baseline: state.benchmark.baselineScore, challenger, deltas: decision.deltas });
    }

    // ===================== Integrity Gate v0 (Option A defaults) =====================
    // Always ON: negative-control teeth + answer-key echo guard.
    // OPT-IN via benchmark fields: routeIndependence:'required', evidenceBinding:'required',
    // requireSolutionPressure:true.
    const def = state.benchmark.def || {};
    const oracle = def.oracle;
    const routeOutputs = best.agentRuns.map((r) => {
      const art = store.readArtifact(state.runId, r.measurementRef);
      return { route: r.model, ref: r.measurementRef, sha256: art ? art.sha256 : null, content: art ? art.content : '', name: art ? art.name : '', role: art ? art.role : 'runlog', record: art };
    });

    if (isDeterministicOracle(oracle)) {
      const nc = state.benchmark.negativeControl;
      if (!nc || nc.passed !== false) {
        return sealReason(state, SEALED.NEGATIVE_CONTROL_PASSED, { hypothesisId: h.id, detail: 'no verified failing negative control on record for this deterministic benchmark' });
      }
      const echoOverride = findOverride(def, 'answer_key_echo');
      const echoSkippable = echoOverride.valid && echoOverride.fixture;
      if (!echoSkippable) {
        for (const ro of routeOutputs) {
          const eg = answerKeyEchoGuard(ro.content, oracle);
          const pg = paddedMarkerEchoGuard(ro.content, oracle);
          if (eg.echo || pg.padded) {
            const qart = store.readArtifact(state.runId, ro.ref);
            if (qart) { qart.quarantineEligible = true; qart.quarantineReason = SEALED.ANSWER_KEY_ECHO_GUARD; store.writeArtifact(state.runId, ro.ref, qart); }
            return sealReason(state, SEALED.ANSWER_KEY_ECHO_GUARD, { hypothesisId: h.id, route: ro.route, ref: ro.ref, markerShare: eg.share, independentChars: eg.independentChars, padded: pg.padded, fillerShare: pg.fillerShare, reason: eg.echo ? eg.reason : pg.reason, quarantined: ro.ref });
          }
        }
      }
    }

    const normOutputClass = normalizeOutputClass(def.outputClass);
    const collapseForced = def.routeIndependence === 'required';
    const collapseExempt = DETERMINISTIC_CLASSES.has(normOutputClass);
    const collapseOverride = findOverride(def, 'route_sha_collapse');
    if (collapseForced && !collapseExempt && !collapseOverride.valid) {
      const rc = routeShaCollapse(routeOutputs, { requiredRoutes: Number.isFinite(def.requiredRoutes) ? def.requiredRoutes : routeOutputs.length, deterministicCommand: collapseExempt });
      if (rc.collapsed) {
        return sealReason(state, SEALED.ROUTE_SHA_COLLAPSE, { hypothesisId: h.id, independentRoutes: rc.independentRoutes, requiredRoutes: rc.requiredRoutes, outputClass: normOutputClass, optIn: true });
      }
    }

    let evidenceBindingPassed = false;
    if (isDeterministicOracle(oracle)) {
      const ebRequired = def.evidenceBinding === 'required';
      const ebOverride = findOverride(def, 'evidence_binding');
      if (ebRequired && !ebOverride.valid) {
        const markers = oracleMarkers(oracle);
        const present = markers.filter((m) => routeOutputs.some((ro) => String(ro.content).includes(m)));
        const bindings = (args.evidence && Array.isArray(args.evidence.bindings)) ? args.evidence.bindings : [];
        const eb = evidenceBindingCheck(present, bindings);
        if (!eb.ok) {
          return sealReason(state, SEALED.EVIDENCE_BINDING_MISSING, { hypothesisId: h.id, unbound: eb.unbound, boundCount: eb.boundCount, requiredCount: eb.requiredCount, optIn: true });
        }
        evidenceBindingPassed = true;
      }

      if (isAnswerVisible(oracle) || def.requireSolutionPressure === true) {
        const spOverride = findOverride(def, 'answer_without_solution');
        let heldOut = null;
        const ho = def.solutionPressure && def.solutionPressure.heldOut;
        if (ho && ho.oracle) {
          const sp = args.solutionProof || {};
          const hoContent = sp.heldOutContent != null
            ? String(sp.heldOutContent)
            : (sp.heldOutRef ? String((store.readArtifact(state.runId, sp.heldOutRef) || {}).content || '') : '');
          heldOut = { score: scoreOracle(hoContent, ho.oracle), floor: Number.isFinite(ho.floor) ? ho.floor : DEFAULT_PASS_MARK, echo: answerKeyEchoGuard(hoContent, ho.oracle).echo };
        }
        const sp = solutionPressureCheck({
          answerVisible: isAnswerVisible(oracle),
          strict: def.requireSolutionPressure === true,
          negativeControl: state.benchmark.negativeControl,
          evidenceBindingPassed, heldOut,
          metamorphic: args.solutionProof && args.solutionProof.metamorphic,
          perturbation: args.solutionProof && args.solutionProof.perturbation,
          freshReplay: args.solutionProof && args.solutionProof.freshReplay
        });
        if (!sp.ok) {
          if (!(spOverride.valid && spOverride.fixture)) {
            return sealReason(state, SEALED.ANSWER_WITHOUT_SOLUTION, { hypothesisId: h.id, reason: sp.reason, strict: def.requireSolutionPressure === true, heldOut, optIn: def.requireSolutionPressure === true });
          }
        }
      }
    }

    const winRec = routeOutputs.find((ro) => ro.record && ro.record.stoneEligible === false) || routeOutputs.find((ro) => ro.record) || routeOutputs[0];
    const cls = classifyArtifact({ role: winRec && winRec.role, name: winRec && winRec.name, content: winRec && winRec.content, artifactClass: winRec && winRec.record && winRec.record.artifactClass, provesBehaviorChange: winRec && winRec.record && winRec.record.provesBehaviorChange });
    if (!cls.stoneEligible) {
      const ow = classifyObjectiveWork({ artifactClass: cls.artifactClass, targetSaturated: !!args.targetSaturated, hasRealTarget: !!args.hasRealTarget });
      return sealReason(state, SEALED.STONE_INELIGIBLE, { hypothesisId: h.id, artifactClass: cls.artifactClass, eligibilityReason: cls.eligibilityReason, route: ow.route, saturationCode: ow.code });
    }
    // ===================== end Integrity Gate =====================

    // ===================== Step 2 — mandatory operator approval =====================
    // A pareto win that clears the integrity gate is NECESSARY but NOT SUFFICIENT.
    // The champion ships only after the operator Approves it on the dashboard (out of
    // band). The model can queue/list reviews but can NEVER resolve them (DASHBOARD_ONLY);
    // resolution flows only through engine.operator.applyDashboardDecisions (the dashboard
    // server's inbox). This closes auto-promotion: even a real, measured, reverified win
    // cannot self-ship.
    const promoReview = (state.humanReviews || []).find((r) => r.kind === 'promotion' && r.hypothesisId === h.id);
    if (!promoReview) {
      const rid = nextId(state, 'review', 'rev');
      state.humanReviews.push({ id: rid, ts: clock(), status: 'PENDING', title: `promote ${h.id}`, kind: 'promotion', summary: `${decision.kind}: ${decision.message}`, hypothesisId: h.id, evidenceRef: best.id, loopId: null, loopContent: null, notes: null });
      requireContinuation(state, 'promotion_needs_approval', `Promotion of ${h.id} won the pareto math and cleared integrity, but needs operator Approve on the dashboard; queue it and continue the next lane while it waits.`);
      logEvent(state, 'promotion_review_queued', { reviewId: rid, hypothesisId: h.id });
      state.updatedAt = clock();
      const dash = writeDashboardForState(state);
      store.save(state);
      return blocked(BLOCK.PROMOTION_NEEDS_APPROVAL,
        'Challenger won the pareto math but cannot ship without operator approval. Queue a promotion review.',
        { queuedReviewId: rid, hypothesisId: h.id, reviewAuthority: 'dashboard-only', dashboardPath: dash.path, continuation: continuationPayload(state) });
    }
    if (promoReview.status === 'PENDING') {
      state.updatedAt = clock();
      store.save(state);
      return blocked(BLOCK.PROMOTION_NEEDS_APPROVAL,
        `Promotion of ${h.id} is queued for operator Approve on the dashboard (review ${promoReview.id}) and cannot ship yet.`,
        { queuedReviewId: promoReview.id, hypothesisId: h.id, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state) });
    }
    if (promoReview.status !== 'APPROVED') {
      // SLUDGE / REJECTED → the operator declined this champion on the dashboard.
      // NB: key is reviewStatus, not status — an extra `status` would clobber blocked()'s.
      return blocked(BLOCK.PROMOTION_REJECTED,
        `Promotion of ${h.id} was declined by the operator on the dashboard (${promoReview.status}).`,
        { reviewId: promoReview.id, hypothesisId: h.id, reviewStatus: promoReview.status });
    }
    // Idempotency: an already-recorded approved promotion is not re-banked.
    const existingPromo = (state.promotions || []).find((p) => p.hypothesisId === h.id);
    if (existingPromo) {
      return ok(`Promotion ${existingPromo.id} for ${h.id} already recorded (operator-approved).`, { promotionId: existingPromo.id, decision: { promote: true, kind: existingPromo.kind }, integrity: existingPromo.integrity, alreadyRecorded: true, continuation: continuationPayload(state) });
    }
    // promoReview.status === 'APPROVED' and not yet recorded → record the promotion below.
    // ===================== end Step 2 approval gate =====================

    const defOverrides = (Array.isArray(def.integrityOverride) ? def.integrityOverride : (def.integrityOverride ? [def.integrityOverride] : []));
    const overridesApplied = defOverrides
      .map((o) => ({ o, v: findOverride({ integrityOverride: [o] }, o.guard) }))
      .filter((x) => x.v.valid)
      .map((x) => ({ guard: x.o.guard, scope: x.v.scope, fixture: !!x.v.fixture, reason: x.o.reason }));
    const fixtureOnly = overridesApplied.some((o) => o.fixture);
    const promotedClass = fixtureOnly ? ARTIFACT_CLASS.TEST_FIXTURE : cls.artifactClass;

    const pid = nextId(state, 'promotion', 'promo');
    state.promotions.push({
      id: pid, hypothesisId: h.id, kind: decision.kind, baseline: state.benchmark.baselineScore, challenger,
      deltas: decision.deltas, ts: clock(), authority: 'measured-frontier-movement', canonicalChange: false,
      integrity: { passed: true, artifactClass: promotedClass, stoneEligible: !fixtureOnly, fixtureOnly, negativeControl: state.benchmark.negativeControl || null, overrides: overridesApplied },
      note: "Disposition recorded as internal champion. Changing the operator's canonical loop file requires explicit operator authority (HUMAN-GATED); this tool never overwrites it."
    });
    h.status = 'PROMOTED_INTERNAL';
    logEvent(state, 'promotion', { id: pid, hypothesisId: h.id, kind: decision.kind, fixtureOnly });
    requireContinuation(state, 'promotion', `Promotion ${pid} recorded as an internal champion; continue into the next bottleneck/lane while dashboard review stays available.`);
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`PROMOTE ${h.id} (${decision.kind}): ${decision.message}. Recorded as internal champion. Changing the canonical loop still requires operator authority through the dashboard. The campaign remains active.`, { promotionId: pid, decision, integrity: { passed: true, artifactClass: promotedClass, stoneEligible: !fixtureOnly, fixtureOnly }, dashboardPath: dash.path, continuation: continuationPayload(state), next: continuationDirective(state) });
  }

  function cycle_decision_request(args = {}) {
    const pre = loadRun(args);
    if (!pre) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(pre); if (g) return g;
    const intent = String(args.intent || '').toLowerCase();
    let result;
    switch (intent) {
      case 'promote':
        result = promotion_request({ runId: args.runId, hypothesisId: args.hypothesisId }); break;
      case 'advance_phase':
        result = advancePhase({ runId: args.runId, loop: args.loop }); break;
      case 'change_baseline':
        result = (args.newEpoch && args.rationale) ? ok('Baseline epoch change acknowledged — re-record via artifact_record { role:"baseline", newEpoch:true, rationale }.') : blocked(BLOCK.BASELINE_LOCKED, 'Refused: baseline is hash-locked. A change needs { newEpoch:true, rationale } between cycles (anti-tampering).'); break;
      case 'change_benchmark':
        result = (args.newEpoch && args.rationale) ? ok('Benchmark epoch change acknowledged — re-select via benchmark_select { newEpoch:true, rationale }.') : blocked(BLOCK.BENCHMARK_FROZEN, 'Refused: benchmark is frozen mid-cycle. Open a new epoch with { newEpoch:true, rationale } between cycles only.'); break;
      case 'saturate':
      case 'transition':
        result = report_saturation({ runId: args.runId, evidence: args.rationale }); break;
      default:
        result = blocked(BLOCK.OPERATOR_IS_STOP, `Refused unsupported terminal or checkpoint intent "${args.intent}". Allowed progress/transition intents are: promote, advance_phase, change_baseline, change_benchmark, saturate. Continue with the next runnable bottleneck or lane.`);
    }
    // Re-load (delegated handlers saved their own copy) and append the audited decision.
    const state = store.load(args.runId);
    const did = nextId(state, 'decision', 'dec');
    state.decisions.push({ id: did, ts: clock(), intent, args: { hypothesisId: args.hypothesisId || null, loop: args.loop || null }, outcome: result.status, code: result.code || null });
    if (result.code === BLOCK.OPERATOR_IS_STOP) {
      requireContinuation(state, 'blocked_terminal_intent', `Rejected "${args.intent}" through the decision hook; continue into the next runnable lane.`);
    }
    state.updatedAt = clock();
    store.save(state);
    return { ...result, decisionId: did, hookNote: 'Routed through the Loop Factory evidence gate. Reasoning alone is not evidence; only tool-measured artifacts unlock promotion. Checkpoints must continue into the next lane.', continuation: continuationPayload(state) };
  }

  // Supervisor saturation transition. The Strip Miner may saturate; on saturation
  // the supervisor AUTO-TRANSITIONS to Loop-de-loop (or the next improvement lane).
  // It never pauses, awaits the operator, or marks "no re-mining warranted" as a
  // terminal — saturation is a pivot. The operator is the only stop condition.
  function report_saturation(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const lane = ensureActiveLane(state);
    const evidence = args.evidence ? String(args.evidence) : null;
    const t = autoTransition(state, 'saturation', { lane: lane.id, evidence });
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`Saturation recorded for lane ${lane.id} (${lane.kind}). Supervisor auto-transitioned to the next ${t.plan.kind} lane${t.plan.loop ? ` (${t.plan.loop})` : ''}. This is a pivot, not a stop — the campaign keeps running.`, {
      saturatedLane: { id: lane.id, kind: lane.kind },
      transition: { id: t.transitionId, toKind: t.plan.kind, toLoop: t.plan.loop, firstAction: t.plan.firstAction },
      autoTransitioned: true,
      campaignContinues: true,
      dashboardPath: dash.path,
      continuation: continuationPayload(state),
      next: t.plan.loop ? `loop_start { runId:"${state.runId}", loop:"${t.plan.loop}" }` : t.plan.firstAction
    });
  }

  // Read-only supervisor status: the target queue (lanes), transitions, branch
  // accounting, and whether anything is pending in the human-review dashboard
  // (which never blocks the campaign).
  function campaign_status(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const c = ensureCampaign(state);
    const cur = activeLane(state);
    const pendingReviews = (state.humanReviews || []).filter((r) => r.status === 'PENDING').length;
    return ok(`Campaign ${state.runId}: ${c.lanes.length} lane(s), ${c.transitions.length} auto-transition(s). ${pendingReviews} review item(s) pending (dashboard-only; never blocks the run). The operator is the only stop condition.`, {
      runStatus: state.status,
      activeLane: cur ? { id: cur.id, kind: cur.kind, loop: cur.loop, status: cur.status, noImproveBatches: cur.noImproveBatches } : null,
      lanes: c.lanes.map((l) => ({ id: l.id, kind: l.kind, loop: l.loop, status: l.status, noImproveBatches: l.noImproveBatches })),
      transitions: c.transitions,
      branchRetirementThreshold: state.config.branchRetirementBatches,
      advisoryBand: state.config.failurePatience,
      failureCounter: state.failures,
      pendingDashboardReview: pendingReviews,
      pendingReviewBlocksCampaign: false,
      modelPolicy: activePolicy(state),
      // Convenience mirror of the active policy's builder routes (same list as modelPolicy.builderRoutes).
      builderGatingRoutes: activePolicy(state).builderRoutes,
      runMode: state.config.runMode,
      maxCycles: state.config.maxCycles,
      cyclesDone: (state.counters && state.counters.test) || 0,
      boundedComplete: boundedComplete(state),
      realTest: state.realTest ? clone(state.realTest) : null,
      stopCondition: STOP_CONDITION_WARNING,
      continuation: continuationPayload(state)
    });
  }

  function continue_run(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const lane = String(args.lane || args.nextLane || '').trim();
    const firstAction = String(args.firstAction || args.first_action || '').trim();
    if (!lane || !firstAction) {
      return blocked(BLOCK.BAD_INPUT,
        'continue_run requires { lane, firstAction }. Use it only when the model is actually moving into the next runnable improvement lane.',
        { continuation: continuationPayload(state) });
    }
    const ts = clock();
    state.continuationCommitments = state.continuationCommitments || [];
    state.continuationCommitments.push({ ts, lane, firstAction, rationale: args.rationale ? String(args.rationale) : null });
    const c = ensureContinuation(state);
    c.inProgress = true;
    c.lastCommitment = { ts, lane, firstAction, rationale: args.rationale ? String(args.rationale) : null };
    c.history.push({ id: c.id || null, ts, event: 'commitment_recorded', source: 'continue_run', lane, firstAction });
    logEvent(state, 'continuation_commitment_recorded', { lane, firstAction });
    state.updatedAt = clock();
    store.save(state);
    return ok(`Continuation commitment recorded: ${lane}. This does not clear the obligation; a real progress tool must run next.`, {
      lane, firstAction,
      continuation: continuationPayload(state),
      next: firstAction,
      clearsWhen: 'A real progress tool runs, such as artifact_record, benchmark_propose, register_hypotheses, test_hypothesis, loop_start, request_next_phase, or reverify_run.'
    });
  }

  function human_review_request(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    const action = args.action || (args.item ? 'add' : 'list');
    if (action === 'add') {
      const rid = nextId(state, 'review', 'rev');
      const item = args.item || {};
      // loopId + loopContent let the model PROPOSE a concrete loop adoption for operator
      // review: "here is the improved loop text; adopt it as <loopId> if you Approve".
      // The model can only queue this; applying it is operator-only (api.operator).
      state.humanReviews.push({ id: rid, ts: clock(), status: 'PENDING', title: item.title || rid, kind: item.kind || 'change', summary: item.summary || '', hypothesisId: item.hypothesisId || null, evidenceRef: item.evidenceRef || null, loopId: item.loopId ? String(item.loopId) : null, loopContent: typeof item.loopContent === 'string' ? item.loopContent : null, notes: null });
      requireContinuation(state, 'human_review_queued', `Review item ${rid} was queued; dashboard review cannot block deterministic progress.`);
      state.updatedAt = clock();
      const dash = writeDashboardForState(state);
      store.save(state);
      return ok(`Review item ${rid} queued for operator review in the dashboard (Approve / Sludge). The model cannot resolve it, and deterministic lanes continue without waiting on review.`, { reviewId: rid, pending: state.humanReviews.filter((r) => r.status === 'PENDING').length, dashboardPath: dash.path, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state) });
    }
    if (action === 'resolve') {
      requireContinuation(state, 'human_review_spoof_blocked', 'Model-callable review resolution was blocked; continue deterministic work while the operator reviews the dashboard.');
      state.updatedAt = clock();
      store.save(state);
      return blocked(BLOCK.DASHBOARD_ONLY,
        'Human review resolution is dashboard-only. The model-callable MCP tool may queue or list review items, but it cannot approve or sludge its own work. Continue the next lane while the operator reviews the dashboard.',
        { reviewId: args.reviewId || null, reviewAuthority: 'dashboard-only', pending: state.humanReviews.filter((r) => r.status === 'PENDING').length, continuation: continuationPayload(state) });
    }
    return ok(`${state.humanReviews.length} review item(s).`, { reviews: state.humanReviews, reviewAuthority: 'dashboard-only', note: 'The model can only list review state. Approve/Sludge is not a model-callable action.', continuation: continuationPayload(state) });
  }

  function update_dashboard(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    requireContinuation(state, 'dashboard_update', 'Dashboard was rendered; dashboard review is not a stopping condition.');
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return ok(`Dashboard written to ${dash.path}. It remains available throughout the run. Approve/Sludge is operator-only from the dashboard; model-callable tools cannot resolve human review. The stop-condition notice appears at the top.`, {
      path: dash.path, warningIncluded: dash.warningIncluded, reviewItems: state.humanReviews.length, reviewAuthority: 'dashboard-only', continuation: continuationPayload(state)
    });
  }

  function report_export(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    const g = requireInitialized(state); if (g) return g;
    requireContinuation(state, 'report_export', 'Report was exported; a report is a checkpoint, not completion.');
    if (state.realTest && state.realTest.enabled === true) {
      state.realTest.experimentValidity = deriveExperimentValidity(state, state.realTest, store);
    }
    const md = renderReport(state);
    const path = store.writeRunFile(state.runId, 'report.md', md);
    state.reportPath = path;
    state.updatedAt = clock();
    store.save(state);
    return ok(`Report written to ${path}.`, { path, continuation: continuationPayload(state) });
  }

  function export_trajectories(args = {}) {
    const state = loadRun(args);
    if (!state) return blocked(BLOCK.UNKNOWN_RUN, `No run "${args.runId}".`);
    if (state.benchmark && state.benchmark.frozen && state.benchmark.def && state.benchmark.def.benchPartition === 'gate') {
      return blocked(BLOCK.BAD_INPUT,
        'Refused: this run is tied to a gate-partitioned (held-out) benchmark. Trajectories from gate runs are not exported — train only on harvest-partition runs.',
        { benchPartition: 'gate', benchSource: state.benchmark.def.benchSource || 'worker' });
    }
    const resolved = resolveExportOutPath(args.runId, args.outPath);
    if (resolved.error) return blocked(BLOCK.BAD_INPUT, resolved.error);
    const trajectory = Array.isArray(state.trajectory) ? state.trajectory : [];
    const lines = trajectory.map((entry) => JSON.stringify({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: entry.id,
        type: 'function',
        function: { name: entry.tool, arguments: entry.arguments || {} }
      }],
      label: {
        verdict: entry.result && entry.result.status === 'OK' ? 'ok' : 'blocked',
        code: (entry.result && entry.result.code) || null,
        reason: (entry.result && entry.result.message) || ''
      }
    }));
    const body = lines.length ? `${lines.join('\n')}\n` : '';
    mkdirSync(dirname(resolved.path), { recursive: true });
    writeFileSync(resolved.path, body, 'utf8');
    const digest = sha256(body);
    return ok(`Exported ${lines.length} trajectory line(s) to ${resolved.path}.`, {
      path: resolved.path, sha256: digest, lines: lines.length, runId: state.runId
    });
  }

  function skill_fetch(args = {}) {
    const mode = String(args.mode || 'plan').toLowerCase();
    const partition = String(args.partition || SKILL_PARTITION.WORKING).toLowerCase();
    if (partition !== SKILL_PARTITION.WORKING && partition !== SKILL_PARTITION.REFERENCE) {
      return blocked(BLOCK.BAD_INPUT, `Invalid skill partition "${partition}". Use "working" (default) or "reference" (opt-in only).`);
    }

    if (mode === 'plan') {
      const query = String(args.query || '');
      const topK = Number.isFinite(args.topK) ? Math.max(1, args.topK) : 5;
      const allIndices = store.listSkills()
        .map((id) => store.readIndex(id))
        .filter(Boolean);
      const filtered = filterSkillIndicesByPartition(allIndices, partition);
      const ranked = rankSkills(query, filtered, topK);
      return ok(`Skill plan: ${ranked.length} skill(s) for partition "${partition}".`, {
        mode: 'plan',
        partition,
        skills: ranked,
        note: 'Index metadata only — no section bodies. Read titles and purposes, then call skill_fetch { mode:"section", skill_id, section_id } for each section you need.'
      });
    }

    if (mode === 'section') {
      const skillId = String(args.skill_id || '').toLowerCase().trim();
      const sectionId = String(args.section_id || '').trim();
      if (!isSafeId(skillId)) return invalidIdBlock('skill_id', skillId);
      if (!sectionId) return blocked(BLOCK.BAD_INPUT, 'section mode requires section_id.');
      if (!store.skillExists(skillId)) {
        return blocked(BLOCK.BAD_INPUT, `Unknown skill "${skillId}". Register it with loop_register { role:"skill" } or check loop_library.`);
      }
      const index = store.readIndex(skillId);
      if (!index) {
        return blocked(BLOCK.BAD_INPUT, `Skill "${skillId}" is missing its index file. Re-register the skill.`);
      }
      const skillPart = index.skillPartition || SKILL_PARTITION.WORKING;
      if (skillPart === SKILL_PARTITION.REFERENCE && partition !== SKILL_PARTITION.REFERENCE) {
        return blocked(BLOCK.BAD_INPUT,
          `Refused: skill "${skillId}" is in the reference partition (held-out). Pass partition:"reference" to fetch it — reference skills are invisible to default working fetches.`,
          { skillPartition: 'reference', requestedPartition: partition });
      }
      if (skillPart === SKILL_PARTITION.WORKING && partition === SKILL_PARTITION.REFERENCE) {
        return blocked(BLOCK.BAD_INPUT,
          `Refused: skill "${skillId}" is a working-partition skill. Pass partition:"working" (default) — working and reference skills are never mixed in one call.`,
          { skillPartition: 'working', requestedPartition: partition });
      }
      const sectionMeta = (index.sections || []).find((s) => s.section_id === sectionId);
      if (!sectionMeta) {
        return blocked(BLOCK.BAD_INPUT, `Section "${sectionId}" not found in skill "${skillId}". Check loop_library or a plan response for valid section_id values.`, {
          skill_id: skillId, section_id: sectionId, available: (index.sections || []).map((s) => s.section_id)
        });
      }
      const parsed = store.readSkill(skillId);
      if (!parsed) {
        return blocked(BLOCK.BAD_INPUT, `Skill file "${skillId}" is missing on disk.`);
      }
      const sections = deriveSectionIds(parsed.body);
      const section = sections.find((s) => s.section_id === sectionId);
      if (!section) {
        return blocked(BLOCK.BAD_INPUT, `Section "${sectionId}" could not be resolved from the skill body (index/body drift). Re-register the skill.`, {
          skill_id: skillId, section_id: sectionId
        });
      }
      if (args.runId && isSafeId(args.runId) && store.exists(args.runId)) {
        const state = store.load(args.runId);
        state.skillsUsed = skillsUsedFor(state);
        state.skillsUsed.push({
          skill_id: skillId,
          sha256: index.sha256,
          version: index.version,
          section_id: sectionId,
          ts: clock()
        });
        state.updatedAt = clock();
        store.save(state);
        logEvent(state, 'skill_fetch', { skill_id: skillId, section_id: sectionId, sha256: index.sha256, version: index.version });
      }
      const tokenEstimate = sectionMeta.token_estimate ?? Math.ceil(section.body.length / 4);
      return ok(`Fetched section "${sectionId}" from skill "${skillId}" (version ${index.version}).`, {
        mode: 'section',
        skill_id: skillId,
        section_id: sectionId,
        version: index.version,
        sha256: index.sha256,
        license: index.license,
        source: index.source,
        title: sectionMeta.title,
        body: section.body,
        chars: section.body.length,
        token_estimate: tokenEstimate
      });
    }

    return blocked(BLOCK.BAD_INPUT, `Unknown skill_fetch mode "${mode}". Use "plan" (default) or "section".`);
  }

  // ---- local loop library (leak #1: users add their own loops) -----------
  function loopJournal(args, event, detail) {
    if (args.runId && isSafeId(args.runId) && store.exists(args.runId)) {
      const s = store.load(args.runId);
      logEvent(s, event, detail);
      s.updatedAt = clock();
      store.save(s);
    }
  }

  function loop_register(args = {}) {
    // Library-level operation: it adds a loop to THIS machine's local MCP so the
    // model can stream it phase-gated. runId is optional (only used to journal).
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const id = String(args.id || args.loopId || '').toLowerCase().trim();
    if (!isSafeId(id)) return invalidIdBlock('loop id', id);
    const existingLibraryId = args.role === 'skill' ? store.skillExists(id) : store.loopExists(id);
    if (!existingLibraryId && !isPortableId(id)) {
      return blocked(BLOCK.BAD_INPUT, `id "${id}" is unsafe for a new cross-platform library file.`);
    }
    const libraryCollision = args.role === 'skill' ? store.skillIdCollision(id) : store.loopIdCollision(id);
    if (!existingLibraryId && libraryCollision) {
      return blocked(BLOCK.BAD_INPUT, `id "${id}" has a case-insensitive collision with existing id "${libraryCollision}".`);
    }
    if (isMandatedId(id)) {
      return blocked(BLOCK.LOOP_EXISTS, `"${id}" collides with a hash-locked mandated loop (The Strip Miner Loop / Loop-de-loop). Those are never overwritten — choose another id for your custom loop.`);
    }

    // ---- skill ingest (role:"skill") — retrievable knowledge, not phase-streamed
    if (args.role === 'skill') {
      if (args.content == null && args.sourcePath) {
        return blocked(BLOCK.BAD_INPUT, 'sourcePath reads are disabled. Paste the skill markdown as `content`.');
      }
      const content = String(args.content == null ? '' : args.content);
      if (content.trim().length < 40) {
        return blocked(BLOCK.LOOP_SOURCE, 'Skill source is too small. Provide the full skill markdown (frontmatter + body with a _synthesis section).');
      }
      let parsed;
      try {
        parsed = parseSkillFile(content);
      } catch (e) {
        return blocked(BLOCK.BAD_INPUT, `Skill parse failed: ${e.message}`);
      }
      const fm = { ...parsed.frontmatter, skill_id: id };
      if (args.title) fm.title = String(args.title);
      if (args.license) fm.license = String(args.license);
      if (args.source) fm.source = String(args.source);
      if (args.tags) fm.tags = args.tags;
      if (args.stack) fm.stack = args.stack;
      if (args.supports_tasks) fm.supports_tasks = args.supports_tasks;
      if (args.anti_patterns) fm.anti_patterns = args.anti_patterns;
      if (args.synthesis_guidance) fm.synthesis_guidance = String(args.synthesis_guidance);
      if (args.token_budget_hint != null) fm.token_budget_hint = Number(args.token_budget_hint);
      if (args.source_paths) fm.source_paths = args.source_paths;
      if (args.skillPartition) fm.skillPartition = String(args.skillPartition);
      let validated;
      try {
        validated = validateSkillRecord(fm, parsed.body);
      } catch (e) {
        return blocked(BLOCK.BAD_INPUT, `Skill rejected: ${e.message}`);
      }
      const digest = validated.sha256;
      if (fm.sha256 && fm.sha256 !== digest) {
        return blocked(BLOCK.BAD_INPUT, `Skill sha256 mismatch (tamper): frontmatter ${fm.sha256} != computed ${digest}`);
      }
      validated.frontmatter.sha256 = digest;
      validated.frontmatter.version = validated.version;
      validated.frontmatter.skillPartition = validated.skillPartition;
      if (!validated.frontmatter.registeredAt) {
        validated.frontmatter.registeredAt = clock();
      }
      if (store.skillExists(id)) {
        const prevIndex = store.readIndex(id);
        const prevSha = prevIndex?.sha256;
        if (!args.overwrite) {
          if (prevSha && prevSha === digest) {
            const index = prevIndex || buildSkillIndex(id, validated.frontmatter, validated.sections);
            return ok(`Skill "${id}" already registered with identical bytes (sha256 ${digest.slice(0, 12)}…).`, {
              skill: {
                id, title: validated.frontmatter.title || id, version: validated.version,
                sha256: digest, license: validated.frontmatter.license, source: validated.frontmatter.source,
                skillPartition: validated.skillPartition, sections: validated.sections.length
              }
            });
          }
          return blocked(BLOCK.LOOP_EXISTS, `Skill "${id}" is already registered with a different hash. Pass { overwrite:true } to replace it.`, { existing: prevSha || null, incoming: digest });
        }
        if (prevSha && prevSha !== digest) {
          store.archiveSkill(id);
        }
      }
      const canonical = serializeSkillMarkdown(validated.frontmatter, parsed.body);
      store.writeSkill({ id, content: canonical });
      const indexObj = buildSkillIndex(id, validated.frontmatter, validated.sections);
      store.writeIndex(id, indexObj);
      loopJournal(args, 'skill_register', { id, sections: validated.sections.length, sha256: digest });
      return ok(`Skill "${id}" registered locally (sha256 ${digest.slice(0, 12)}…, ${validated.sections.length} sections, partition ${validated.skillPartition}). Fetch sections via skill_fetch (Phase B).`, {
        skill: {
          id, title: validated.frontmatter.title || id, version: validated.version,
          sha256: digest, license: validated.frontmatter.license, source: validated.frontmatter.source,
          skillPartition: validated.skillPartition, sections: validated.sections.length
        }
      });
    }

    if (args.content == null && args.sourcePath) {
      return blocked(BLOCK.BAD_INPUT, 'sourcePath reads are disabled. Paste the loop text as `content`; the MCP will not read an arbitrary local file path.');
    }
    const content = String(args.content == null ? '' : args.content);
    if (content.trim().length < 40) {
      return blocked(BLOCK.LOOP_SOURCE, 'Custom loop source is too small to phase-gate. Provide the real multi-section loop text (headers or paragraph breaks become streamable phases).');
    }
    const digest = sha256(content);
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    if (store.loopExists(id) && !args.overwrite) {
      const prev = store.readLoop(id);
      if (!(prev && prev.sha256 === digest)) {
        return blocked(BLOCK.LOOP_EXISTS, `Custom loop "${id}" is already registered with a different hash. Pass { overwrite:true } to replace it (a new local version).`, { existing: prev ? prev.sha256 : null, incoming: digest });
      }
    }
    const record = {
      id, title: args.title ? String(args.title) : id,
      trigger: args.trigger ? String(args.trigger) : `/loop ${id}`,
      role: args.role ? String(args.role) : 'custom', aka: [], origin: 'custom',
      content, sha256: digest, lines, registeredAt: clock()
    };
    let built;
    try { built = makeCustomLoop(record); } catch (e) { return blocked(BLOCK.LOOP_SOURCE, `Custom loop rejected: ${e.message}`); }
    if (built.sections.length < 2) {
      return blocked(BLOCK.LOOP_SOURCE, `Custom loop "${id}" produced only ${built.sections.length} streamable section(s); phase-gated streaming needs ≥2. Add section headers or blank-line-separated paragraphs.`, { sections: built.sections.length });
    }
    record.sections = built.sections.length;
    store.writeLoop(record);
    loopJournal(args, 'loop_register', { id, sections: built.sections.length, sha256: digest });
    return ok(`Custom loop "${id}" registered locally (sha256 ${digest.slice(0, 12)}…, ${built.sections.length} phase-gated sections). Stream it with loop_start { loop:"${id}" }.`, {
      loop: { id, title: record.title, trigger: record.trigger, sha256: digest, lines, sections: built.sections.length, origin: 'custom' },
      note: 'Hash-locked locally exactly like the mandated loops, and streamed one section at a time through the same phase gate. The bundled 345-line Strip Miner and 75-line Loop-de-loop are untouched. Nothing leaves your machine.'
    });
  }

  function loop_library(args = {}) {
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const mandated = verifyAllLoops().map((m) => ({
      id: m.id, title: m.title, trigger: m.trigger, role: m.role,
      sha256: m.sha256, lines: m.lines, sections: m.sections, origin: 'mandated', hashLocked: true
    }));
    const custom = store.listLoops().map((cid) => {
      const r = store.readLoop(cid);
      try {
        const b = makeCustomLoop(r);
        return { id: cid, title: r.title, trigger: r.trigger, role: r.role || 'custom', sha256: b.sha256, lines: b.lines, sections: b.sections.length, origin: 'custom', hashLocked: true };
      } catch (e) {
        return { id: cid, title: (r && r.title) || cid, origin: 'custom', hashLocked: false, error: e.message };
      }
    });
    const skills = store.listSkills().map((sid) => {
      const index = store.readIndex(sid);
      if (!index) {
        return { id: sid, origin: 'skill', error: 'missing index' };
      }
      return {
        id: sid,
        title: index.title,
        version: index.version,
        sha256: index.sha256,
        license: index.license,
        source: index.source,
        skillPartition: index.skillPartition,
        tags: index.tags || [],
        stack: index.stack || [],
        supports_tasks: index.supports_tasks || [],
        sections: (index.sections || []).length,
        token_budget_hint: index.token_budget_hint ?? null,
        origin: 'skill'
      };
    });
    loopJournal(args, 'loop_library', { mandated: mandated.length, custom: custom.length, skills: skills.length });
    return ok(`Loop library: ${mandated.length} mandated (hash-locked) + ${custom.length} custom local loop(s) + ${skills.length} skill(s).`, {
      mandated, custom, skills,
      registerWith: 'loop_register { id, title, content, trigger? } — add your own loops; they stream phase-gated like the mandated ones.',
      streamWith: 'loop_start { runId, loop:"<id>" }'
    });
  }

  // ---- host capability preflight (leak #7) -------------------------------
  function host_capability_preflight(args = {}) {
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const report = detectHostCapabilities();
    // Worker-route detection (above) is "which CLIs are installed"; the host PROFILE
    // (below) is "which runtime is the agent driving + how does it keep going". Both
    // are returned. Old consumers still read report.routes / report.installed.
    const profile = hostProfile(process.env.SUPER_LOOP_HOST);
    const isUnknownHost = profile.id === 'unknown';
    const hasCmd = !!(profile.primaryDriver && profile.primaryDriver.command);
    const setupHint = isUnknownHost
      ? 'Host not identified — set SUPER_LOOP_HOST. See hostMatrix for supported hosts; if none fits, drive the campaign with the super-loop-run CLI fallback.'
      : (hasCmd
        ? `${profile.id}: tier ${profile.tier} (${profile.driverFamily}). Engage ${profile.primaryDriver.command} with an operator-stop objective — see the initialize_loop_run hostSetup for the exact step.`
        : `${profile.id}: tier ${profile.tier} (${profile.driverFamily}). No continuous slash command — drive via the continuation-rules snippet or the ${profile.cliFallback || 'super-loop-run'} CLI fallback.`);
    loopJournal(args, 'host_preflight', { installed: report.installed, host: profile.id, tier: profile.tier });
    return ok(`Host preflight: ${report.installedCount}/${report.routes.length} known frontier-agent CLIs found on PATH${report.installed.length ? ` (${report.installed.join(', ')})` : ' (none)'}. Host: ${profile.id} (tier ${profile.tier == null ? 'n/a' : profile.tier}, ${profile.driverFamily}).`, {
      ...report,
      workerRoutes: report.routes,
      hostProfile: {
        id: profile.id,
        driverFamily: profile.driverFamily,
        tier: profile.tier,
        primaryDriver: profile.primaryDriver,
        mcpConfigPaths: profile.mcpConfigPaths || [],
        cliFallback: profile.cliFallback || 'super-loop-run',
        verified: !!profile.verified,
        docs: profile.docs || null
      },
      tier: profile.tier,
      driverFamily: profile.driverFamily,
      setupHint,
      hostMatrix: isUnknownHost ? hostMatrix() : undefined,
      advisory: `This is a LOCAL capability check, not SOTA/web research and not an auth check. Use it to pick routes that are actually installed, then web-search current SOTA (OpenAI / Anthropic / Google / Z.ai) and confirm auth before relying on any route. Non-frontier routes are still rejected by register_hypotheses/test_hypothesis.`
    });
  }

  // Advisory host-runtime guess from which MCP config files exist on disk. READ-ONLY
  // (existence check only — never reads contents, never mutates). SUPER_LOOP_HOST wins.
  function host_runtime_detect(args = {}) {
    if (args.runId && !isSafeId(args.runId)) return invalidIdBlock('runId', args.runId);
    const report = detectHostRuntime();
    loopJournal(args, 'host_runtime_detect', { guess: report.guess, candidates: report.candidates.map((c) => c.id) });
    const msg = report.guess
      ? `Host runtime guess: ${report.guess}${report.explicitHost ? ' (from SUPER_LOOP_HOST)' : ' (sole config match)'}.`
      : (report.candidates.length
        ? `Ambiguous host: config found for ${report.candidates.map((c) => c.id).join(', ')} — set SUPER_LOOP_HOST to disambiguate.`
        : `No known host config found — set SUPER_LOOP_HOST or drive the campaign with the ${report.cliFallback} CLI.`);
    return ok(msg, { ...report });
  }

  // ---- registry ----------------------------------------------------------
  // ============== operator-gated loop adoption (NOT model-callable) ========
  // The dashboard captures the operator's Approve/Sludge and EXPORTS decisions.json;
  // these functions CONSUME that operator decision and actually apply it. Approving a
  // loop-adoption review installs the improved loop as a new VERSION of a CUSTOM loop
  // (the prior version is archived for rollback), which loop_start then streams next
  // cycle. The hash-locked mandated loops (Strip Miner / Loop-de-loop) are immutable
  // and are NEVER touched (canonical is never silently overwritten). Applying a
  // decision is NON-BLOCKING — it never stops a run; the operator (or full
  // exhaustion) is still the only stop. These live under api.operator (an object, not
  // a top-level function) so a worker model cannot reach them through the tools/call
  // dispatch (engine[name]) and adopt its own work — adoption is the operator's.
  function installLoopVersion(loopId, content, meta) {
    const prior = store.readLoop(loopId);
    const built = makeCustomLoop({ id: loopId, content });
    const version = ((prior && prior.version) || 0) + 1;
    const history = (prior && Array.isArray(prior.history)) ? prior.history.slice() : [];
    if (prior) history.push({ version: prior.version || 1, sha256: prior.sha256, content: prior.content, supersededAt: meta.ts, supersededBy: version });
    const record = {
      id: loopId,
      title: (prior && prior.title) || meta.title || loopId,
      trigger: (prior && prior.trigger) || `/loop ${loopId}`,
      role: (prior && prior.role) || 'improve', aka: [], origin: 'custom',
      content, sha256: built.sha256, lines: built.lines, sections: built.sections.length,
      version, adopted: true, adoptedFrom: meta.from || null, adoptedAt: meta.ts,
      registeredAt: (prior && prior.registeredAt) || meta.ts, history
    };
    store.writeLoop(record);
    return { loopId, version, sha256: built.sha256, sections: built.sections.length, replacedVersion: prior ? (prior.version || 1) : null };
  }
  function adoptLoop({ loopId, content, from } = {}) {
    const id = String(loopId || '').toLowerCase().trim();
    if (!isSafeId(id)) return { ok: false, reason: `invalid loop id "${loopId}"` };
    if (!store.loopExists(id) && !isPortableId(id)) return { ok: false, reason: `loop id "${loopId}" is unsafe for a new cross-platform library file` };
    const collision = store.loopIdCollision(id);
    if (!store.loopExists(id) && collision) return { ok: false, reason: `loop id "${loopId}" collides case-insensitively with "${collision}"` };
    if (isMandatedId(id)) return { ok: false, reason: `"${id}" is a hash-locked mandated loop (the Strip Miner / Loop-de-loop) and is immutable. Adopt the improvement under a NEW custom loop id; the canonical loop is never overwritten.` };
    const text = String(content == null ? '' : content);
    if (text.trim().length < 40) return { ok: false, reason: 'adopted loop content is too small to phase-gate (provide the real multi-section loop text)' };
    let built;
    try { built = makeCustomLoop({ id, content: text }); } catch (e) { return { ok: false, reason: `adopted loop rejected: ${e.message}` }; }
    if (built.sections.length < 2) return { ok: false, reason: `adopted loop produced ${built.sections.length} streamable section(s); phase-gated streaming needs >= 2` };
    return { ok: true, ...installLoopVersion(id, text, { ts: clock(), from: from || null }) };
  }
  function rollbackLoop({ loopId } = {}) {
    const id = String(loopId || '').toLowerCase().trim();
    if (!isSafeId(id)) return { ok: false, reason: `invalid loop id "${loopId}"` };
    if (isMandatedId(id)) return { ok: false, reason: `"${id}" is a mandated loop; it is never versioned or rolled back` };
    const cur = store.readLoop(id);
    if (!cur) return { ok: false, reason: `no custom loop "${id}" to roll back` };
    const hist = Array.isArray(cur.history) ? cur.history : [];
    if (!hist.length) return { ok: false, reason: `"${id}" has no prior version to roll back to (only one version exists)` };
    const prev = hist[hist.length - 1];
    const info = installLoopVersion(id, prev.content, { ts: clock(), from: { rollbackToVersion: prev.version } });
    return { ok: true, loopId: id, restoredFromVersion: prev.version, newVersion: info.version };
  }
  function recordSupervisorEvent({ runId, event } = {}) {
    if (!isSafeId(runId)) return { ok: false, reason: `invalid runId "${runId}"` };
    if (!store.exists(runId)) return { ok: false, reason: `no run "${runId}"` };
    const input = event && typeof event === 'object' ? event : {};
    const type = String(input.type || 'worker_verdict');
    if (!['worker_verdict', 'model_invocation', 'proof_checkpoint'].includes(type)) {
      return { ok: false, reason: `unsupported supervisor event type "${type}"` };
    }
    const state = store.load(runId);
    state.supervisionEvents = Array.isArray(state.supervisionEvents) ? state.supervisionEvents : [];
    const receipt = input.invocation && typeof input.invocation === 'object'
      ? {
          requestedModel: input.invocation.requestedModel || null,
          reportedModel: input.invocation.reportedModel || null,
          modelSelectionAuthority: input.invocation.modelSelectionAuthority || null,
          modelIdentityAuthority: input.invocation.modelIdentityAuthority || null,
          reportedModelMatchesRequest: input.invocation.reportedModelMatchesRequest ?? null,
          binaryFamily: input.invocation.binaryFamily || null,
          argv: Array.isArray(input.invocation.argv) ? input.invocation.argv.map(String) : [],
          durationMs: Number.isFinite(input.invocation.durationMs) ? input.invocation.durationMs : null,
          exitCode: Number.isFinite(input.invocation.exitCode) ? input.invocation.exitCode : null,
          stdoutSha256: input.invocation.stdoutSha256 || null,
          resultSha256: input.invocation.resultSha256 || null,
          tokenUsage: Number.isFinite(input.invocation.tokenUsage) ? input.invocation.tokenUsage : null,
          tokenUsageDetails: input.invocation.tokenUsageDetails && typeof input.invocation.tokenUsageDetails === 'object'
            ? { ...input.invocation.tokenUsageDetails }
            : null,
          tokenUsageAuthority: input.invocation.tokenUsageAuthority || null,
          strictIsolation: input.invocation.strictIsolation === true,
          disabledFeatures: Array.isArray(input.invocation.disabledFeatures)
            ? input.invocation.disabledFeatures.map(String)
            : [],
          workspaceRoot: input.invocation.workspaceRoot || null,
          outputSchemaSha256: input.invocation.outputSchemaSha256 || null,
          rawResultSha256: input.invocation.rawResultSha256 || null,
          resultNormalization: input.invocation.resultNormalization || null,
          isolation: input.invocation.isolation && typeof input.invocation.isolation === 'object'
            ? {
                status: input.invocation.isolation.status || null,
                toolCalls: Array.isArray(input.invocation.isolation.toolCalls)
                  ? input.invocation.isolation.toolCalls.map((item) => ({ ...item }))
                  : []
              }
            : null
        }
      : null;
    const rec = {
      id: nextId(state, 'supervisionEvent', 'sev'),
      ts: clock(),
      type,
      accepted: input.accepted === true,
      code: input.code ? String(input.code) : null,
      reasons: Array.isArray(input.reasons) ? input.reasons.map(String) : [],
      route: input.route ? String(input.route) : null,
      phase: Number.isInteger(input.phase) ? input.phase : null,
      workerKind: input.workerKind ? String(input.workerKind) : null,
      attempt: Number.isInteger(input.attempt) ? input.attempt : null,
      scenario: input.scenario ? String(input.scenario) : null,
      invocation: receipt
    };
    state.supervisionEvents.push(rec);
    logEvent(state, 'supervisor_event', {
      id: rec.id,
      type: rec.type,
      accepted: rec.accepted,
      code: rec.code,
      reasons: rec.reasons,
      route: rec.route,
      phase: rec.phase,
      scenario: rec.scenario
    });
    state.updatedAt = clock();
    store.save(state);
    return { ok: true, event: rec };
  }
  function recordCampaignProgress({ runId, progress } = {}) {
    if (!isSafeId(runId)) return { ok: false, reason: `invalid runId "${runId}"` };
    if (!store.exists(runId)) return { ok: false, reason: `no run "${runId}"` };
    const state = store.load(runId);
    const current = state.realTest && typeof state.realTest === 'object'
      ? state.realTest
      : { enabled: true };
    const input = progress && typeof progress === 'object' ? progress : {};
    const status = ['PREPARING', 'RUNNING', 'CAP_REACHED', 'QUEUE_DRAINED', 'OPERATOR_STOP', 'BLOCKED'].includes(input.status)
      ? input.status
      : current.status || 'RUNNING';
    const safeCount = (value, fallback = 0) => Number.isInteger(value) && value >= 0 ? value : fallback;
    const coverage = Array.isArray(input.coverage)
      ? input.coverage
          .filter((item) => item && typeof item === 'object' && isSafeId(item.findingId))
          .map((item) => ({
            findingId: item.findingId,
            childRunId: isSafeId(item.childRunId) ? item.childRunId : null,
            baselineSha256: /^[a-f0-9]{64}$/i.test(String(item.baselineSha256 || '')) ? String(item.baselineSha256).toLowerCase() : null,
            miningRawArtifactId: isSafeId(item.miningRawArtifactId) ? item.miningRawArtifactId : null,
            miningCaptureArtifactId: isSafeId(item.miningCaptureArtifactId) ? item.miningCaptureArtifactId : null,
            evidenceRefs: Array.isArray(item.evidenceRefs)
              ? item.evidenceRefs.map((ref) => ({
                  path: String(ref && ref.path || ''),
                  locator: String(ref && ref.locator || ''),
                  sourceSha256: /^[a-f0-9]{64}$/i.test(String(ref && ref.sourceSha256 || ''))
                    ? String(ref.sourceSha256).toLowerCase()
                    : null,
                  resolvedSha256: /^[a-f0-9]{64}$/i.test(String(ref && ref.resolvedSha256 || ''))
                    ? String(ref.resolvedSha256).toLowerCase()
                    : null
                }))
              : [],
            hypothesisIds: Array.isArray(item.hypothesisIds) ? item.hypothesisIds.filter(isSafeId) : [],
            planned: safeCount(item.planned, 0),
            valid: safeCount(item.valid, 0),
            invalid: safeCount(item.invalid, 0),
            status: ['UNTESTED', 'RUNNING', 'PARTIAL', 'COVERED', 'BLOCKED'].includes(item.status) ? item.status : 'UNTESTED'
          }))
      : (Array.isArray(current.coverage) ? current.coverage : []);
    state.realTest = {
      enabled: true,
      status,
      findingsAccepted: safeCount(input.findingsAccepted, current.findingsAccepted),
      findingsRejected: safeCount(input.findingsRejected, current.findingsRejected),
      findingsTested: safeCount(input.findingsTested, current.findingsTested),
      findingsBlocked: safeCount(input.findingsBlocked, current.findingsBlocked),
      attemptsPlanned: safeCount(input.attemptsPlanned, current.attemptsPlanned),
      attemptsValid: safeCount(input.attemptsValid, current.attemptsValid),
      attemptsInvalid: safeCount(input.attemptsInvalid, current.attemptsInvalid),
      coverage,
      improvementAttempts: safeCount(input.improvementAttempts, current.improvementAttempts),
      invalidAttempts: safeCount(input.invalidAttempts, current.invalidAttempts),
      latestSubRunId: isSafeId(input.latestSubRunId) ? input.latestSubRunId : current.latestSubRunId || null,
      benchmarkLocked: input.benchmarkLocked === true || current.benchmarkLocked === true,
      baselineSamples: safeCount(input.baselineSamples, current.baselineSamples),
      updatedAt: clock()
    };
    state.realTest.experimentValidity = deriveExperimentValidity(state, state.realTest, store);
    logEvent(state, 'real_test_progress', {
      status: state.realTest.status,
      findingsAccepted: state.realTest.findingsAccepted,
      improvementAttempts: state.realTest.improvementAttempts,
      invalidAttempts: state.realTest.invalidAttempts,
      latestSubRunId: state.realTest.latestSubRunId
    });
    state.updatedAt = clock();
    const dash = writeDashboardForState(state);
    store.save(state);
    return { ok: true, progress: clone(state.realTest), dashboardPath: dash.path };
  }
  function applyDashboardDecisions({ runId, decisions, requireBinding = false } = {}) {
    if (!isSafeId(runId)) return { ok: false, reason: `invalid runId "${runId}"` };
    if (!store.exists(runId)) return { ok: false, reason: `no run "${runId}"` };
    const state = store.load(runId);
    const ts = clock();
    const decided = (decisions && typeof decisions === 'object') ? decisions : {};
    const applied = [];
    for (const reviewId of Object.keys(decided)) {
      const d = decided[reviewId] || {};
      const review = (state.humanReviews || []).find((r) => r.id === reviewId);
      if (!review) { applied.push({ reviewId, skipped: 'no such review' }); continue; }
      if (review.status !== 'PENDING') { applied.push({ reviewId, skipped: `already ${review.status}` }); continue; }
      const currentReviewSha256 = reviewDecisionBinding(state, review);
      if (requireBinding) {
        const queuedReviewSha256 = String(d.reviewSha256 || '').toLowerCase();
        const code = !isReviewDecisionBinding(queuedReviewSha256)
          ? 'REVIEW_BINDING_REQUIRED'
          : (queuedReviewSha256 !== currentReviewSha256 ? 'REVIEW_BINDING_CHANGED' : null);
        if (code) {
          review.lastDecisionError = {
            code,
            ts,
            queuedReviewSha256: isReviewDecisionBinding(queuedReviewSha256) ? queuedReviewSha256 : null,
            currentReviewSha256
          };
          logEvent(state, 'review_decision_rejected', { reviewId, code });
          applied.push({
            reviewId,
            code,
            skipped: code === 'REVIEW_BINDING_REQUIRED'
              ? 'queued decision is not bound to the reviewed state'
              : 'reviewed state changed after the decision was queued',
            currentReviewSha256,
            queuedReviewSha256: isReviewDecisionBinding(queuedReviewSha256) ? queuedReviewSha256 : null
          });
          continue;
        }
      }
      delete review.lastDecisionError;
      if (d.decision === 'approve') {
        if (review.loopId && typeof review.loopContent === 'string' && review.loopContent.trim()) {
          const a = adoptLoop({ loopId: review.loopId, content: review.loopContent, from: { reviewId, runId } });
          if (!a.ok) { applied.push({ reviewId, error: a.reason }); continue; }
          // drop any pinned snapshot of this loop in THIS run so the next loop_start
          // re-pins the freshly adopted version (a fresh run reads it from the store).
          if (state.customLoops && state.customLoops[review.loopId]) delete state.customLoops[review.loopId];
          review.status = 'APPROVED'; review.resolvedAt = ts; review.notes = d.notes || review.notes;
          review.adoption = { loopId: a.loopId, version: a.version, sha256: a.sha256 };
          logEvent(state, 'loop_adopted', { reviewId, loopId: a.loopId, version: a.version });
          applied.push({ reviewId, reviewSha256: currentReviewSha256, adopted: { loopId: a.loopId, version: a.version }, enforcedVia: `loop_start { loop:"${a.loopId}" }` });
        } else if (review.kind === 'promotion') {
          // Step 2 — operator-approves a champion. Flipping the review to APPROVED is the
          // gate; the next promotion_request for this hypothesis records the champion.
          review.status = 'APPROVED'; review.resolvedAt = ts; review.notes = d.notes || review.notes;
          logEvent(state, 'promotion_approved', { reviewId, hypothesisId: review.hypothesisId });
          applied.push({ reviewId, reviewSha256: currentReviewSha256, approved: true, kind: 'promotion', hypothesisId: review.hypothesisId, enforcedVia: `promotion_request { hypothesisId:"${review.hypothesisId}" }` });
        } else {
          review.status = 'APPROVED'; review.resolvedAt = ts; review.notes = d.notes || review.notes;
          applied.push({ reviewId, reviewSha256: currentReviewSha256, approved: true, note: 'informational review (no loop to adopt)' });
        }
      } else if (d.decision === 'sludge') {
        review.status = 'SLUDGE'; review.resolvedAt = ts; review.notes = d.notes || review.notes;
        applied.push({ reviewId, reviewSha256: currentReviewSha256, sludged: true });
      } else {
        applied.push({ reviewId, skipped: `unknown decision "${d.decision}"` });
      }
    }
    const rejected = applied.filter((item) => item && (item.skipped || item.error));
    state.updatedAt = ts;
    const dash = writeDashboardForState(state);
    store.save(state);
    return {
      ok: rejected.length === 0,
      runId,
      applied,
      appliedCount: applied.length - rejected.length,
      rejectedCount: rejected.length,
      reason: rejected.length ? `${rejected.length} decision(s) were rejected or skipped` : null,
      dashboardPath: dash.path,
      note: 'Operator dashboard decisions applied. The campaign was never paused for this — the operator (or full exhaustion) remains the only stop.'
    };
  }
  // Auto-apply: read the operator's exported decisions dropped into the run inbox
  // (runs/<runId>/inbox-decisions.json), apply them, and archive the file so it is not
  // re-applied. The autonomous supervisor calls this each tick → dashboard approvals
  // take effect with NO command and NO model involvement, and the run is never paused.
  function applyInboxDecisions(runId) {
    if (!isSafeId(runId) || !store.exists(runId)) return { ok: true, inbox: false, applied: [] };
    const raw = store.readRunFile(runId, 'inbox-decisions.json');
    if (raw == null) return { ok: true, inbox: false, applied: [] };
    const stamp = String(clock()).replace(/[:.]/g, '-');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      store.moveRunFile(runId, 'inbox-decisions.json', `inbox-decisions.invalid-${stamp}.json`);
      return { ok: false, inbox: true, applied: [], reason: `inbox decisions JSON invalid: ${e.message}` };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      store.moveRunFile(runId, 'inbox-decisions.json', `inbox-decisions.invalid-${stamp}.json`);
      return { ok: false, inbox: true, applied: [], reason: 'inbox decisions payload must be an object' };
    }
    if (payload.runId != null && payload.runId !== runId) {
      store.moveRunFile(runId, 'inbox-decisions.json', `inbox-decisions.rejected-${stamp}.json`);
      return { ok: false, inbox: true, applied: [], reason: `inbox runId "${payload.runId}" does not match "${runId}"` };
    }
    const decisions = payload.decisions || payload;
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions) || Object.keys(decisions).length === 0) {
      store.moveRunFile(runId, 'inbox-decisions.json', `inbox-decisions.rejected-${stamp}.json`);
      return { ok: false, inbox: true, applied: [], reason: 'inbox decisions must contain at least one review' };
    }
    const res = applyDashboardDecisions({ runId, decisions, requireBinding: true });
    store.moveRunFile(
      runId,
      'inbox-decisions.json',
      `inbox-decisions.${res.ok ? 'applied' : 'rejected'}-${stamp}.json`
    );
    return { ...res, inbox: true };
  }

  const rawApi = {
    initialize_loop_run,
    loop_register,
    loop_library,
    host_capability_preflight,
    host_runtime_detect,
    loop_start,
    loop_next: advancePhase,
    request_next_phase: advancePhase,
    observation_record,
    artifact_record,
    benchmark_propose,
    benchmark_select,
    benchmark_freeze_maker,
    benchmark_run,
    register_hypotheses,
    test_hypothesis,
    execute_full_test,
    reverify_run,
    promotion_request,
    cycle_decision_request,
    report_saturation,
    campaign_status,
    continue_run,
    human_review_request,
    update_dashboard,
    report_export,
    export_trajectories,
    skill_fetch,
    // exposed for tooling/tests
    _loopSummary: loopSummary
  };
  const api = {};
  for (const [name, fn] of Object.entries(rawApi)) api[name] = wrapToolHandler(name, fn);
  // Operator-only surface — consumed by the apply-decisions CLI and the autonomous
  // supervisor, NEVER by the model. It is an object (not a top-level function), so the
  // tools/call dispatch (`engine[name]`, function-typed only) cannot reach it.
  api.operator = { adoptLoop, rollbackLoop, recordSupervisorEvent, recordCampaignProgress, applyDashboardDecisions, applyInboxDecisions };
  // The autonomous supervisor: one call drives the whole campaign (intake → mine →
  // improve targets → bank Stones → advance/retire → re-mine) with the executor as
  // the real worker, validating every worker output through the enforcement boundary.
  // Bounded by maxBatches inside the MCP call (a safety cap, not completion); the
  // standalone CLI runs it until the operator stop-file. Requires the exec opt-in.
  api.run_campaign = (args = {}) => {
    if (!isExecEnabled()) {
      return blocked(BLOCK.EXEC_DISABLED, 'The autonomous supervisor must run real workers; set SUPER_LOOP_ALLOW_EXEC=1. (Without it, drive the MCP tools from a host agent, or use mock workers via the supervisor API in tests.)', { allowEnv: 'SUPER_LOOP_ALLOW_EXEC=1' });
    }
    let stopFile = args.stopFile || null;
    return runSupervisedCampaign(api, { ...(args.config || {}), runId: args.runId }, {
      worker: executorWorker,
      maxBatches: Number.isFinite(args.maxBatches) ? args.maxBatches : (Number.isFinite(args.maxRounds) ? args.maxRounds : 3),
      stopCheck: stopFile ? () => { try { return existsSync(stopFile); } catch { return false; } } : () => false
    });
  };
  return api;
}
