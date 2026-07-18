// Public operational view for the local Campaign Console.
//
// This is an allowlist serializer, not a clone-and-redact pass. Arbitrary operator
// text, model output, prompts, artifact bodies, trajectory args/results, environment
// values, notes, loop content, and filesystem paths never enter the returned object.
import { buildScoreMatrix } from './scorecard.mjs';
import { STOP_CONDITION_WARNING } from './constants.mjs';
import { isSafeId } from './util.mjs';

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;
const ROUTE_RE = /^[a-z0-9][a-z0-9._+:/-]{0,119}$/i;
const ARG_RE = /^(?:--?[a-z0-9][a-z0-9._-]{0,79}|[a-z0-9][a-z0-9._+=:/-]{0,159})$/i;
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;

function text(value, max = 120) {
  const s = String(value == null ? '' : value).trim();
  return s && !/[\0\r\n]/.test(s) ? s.slice(0, max) : null;
}

function id(value) {
  const s = text(value, 120);
  return s && isSafeId(s) ? s : null;
}

function route(value) {
  const s = text(value, 120);
  return s && ROUTE_RE.test(s) && !s.startsWith('/') && !s.includes('..') ? s : null;
}

function code(value) {
  const s = text(value, 64);
  return s && CODE_RE.test(s) ? s : null;
}

function hash(value) {
  const s = text(value, 64);
  return s && HASH_RE.test(s) ? s.toLowerCase() : null;
}

function finite(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function timestamp(value) {
  const s = text(value, 40);
  return s && /^\d{4}-\d{2}-\d{2}T/.test(s) ? s : null;
}

function safeArg(value) {
  const s = text(value, 160);
  return s && ARG_RE.test(s) && !s.startsWith('/') && !s.includes('..') ? s : '[redacted]';
}

function safeList(values, mapper, max = 20) {
  return (Array.isArray(values) ? values : []).slice(0, max).map(mapper).filter(Boolean);
}

function publicPolicy(state) {
  const policy = state?.config?.modelPolicy || {};
  const banlist = policy.banlist || {};
  return {
    source: text(policy.source, 80),
    primary: route(policy.primary),
    testRoutes: safeList(policy.testRoutes, route, 8),
    builderRoutes: safeList(policy.builderRoutes, route, 8),
    judgeRoute: route(policy.judgeRoute),
    banlist: {
      mode: ['default', 'strict', 'off'].includes(banlist.mode) ? banlist.mode : 'default',
      extraAllowCount: Array.isArray(banlist.extraAllow) ? banlist.extraAllow.length : 0,
      extraDenyCount: Array.isArray(banlist.extraDeny) ? banlist.extraDeny.length : 0
    },
    allowUnknownFrontier: policy.allowUnknownFrontier !== false
  };
}

function publicLoops(state) {
  return Object.entries(state.loops || {}).map(([loopId, loop]) => {
    const evidence = loop && loop.evidence && typeof loop.evidence === 'object' ? loop.evidence : {};
    return {
      id: id(loopId),
      phase: integer(loop?.phaseCursor) ?? 0,
      totalPhases: integer(loop?.totalPhases) ?? 0,
      evidencedPhases: Object.keys(evidence).filter((key) => Array.isArray(evidence[key]) && evidence[key].length > 0).length,
      evidenceItems: Object.values(evidence).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0),
      origin: text(loop?.origin, 40)
    };
  }).filter((loop) => loop.id);
}

function publicLanes(state) {
  const campaign = state.campaign || {};
  return {
    activeLaneId: id(campaign.activeLaneId),
    lanes: (Array.isArray(campaign.lanes) ? campaign.lanes : []).slice(0, 50).map((lane) => ({
      id: id(lane.id),
      kind: text(lane.kind, 40),
      loop: id(lane.loop),
      status: text(lane.status, 40),
      noImproveBatches: integer(lane.noImproveBatches) ?? 0,
      since: timestamp(lane.since),
      retiredAt: timestamp(lane.retiredAt)
    })).filter((lane) => lane.id),
    transitions: (Array.isArray(campaign.transitions) ? campaign.transitions : []).slice(-50).map((transition) => ({
      id: id(transition.id),
      ts: timestamp(transition.ts),
      cause: text(transition.cause, 60),
      from: id(transition.from),
      to: id(transition.to),
      loop: id(transition.loop || transition.toLoop)
    }))
  };
}

function publicReceipt(invocation) {
  if (!invocation || typeof invocation !== 'object') return null;
  return {
    requestedModel: route(invocation.requestedModel),
    reportedModel: route(invocation.reportedModel),
    modelSelectionAuthority: text(invocation.modelSelectionAuthority, 60),
    modelIdentityAuthority: text(invocation.modelIdentityAuthority, 60),
    reportedModelMatchesRequest: typeof invocation.reportedModelMatchesRequest === 'boolean'
      ? invocation.reportedModelMatchesRequest
      : null,
    binaryFamily: text(invocation.binaryFamily, 40),
    argv: safeList(invocation.argv, safeArg, 24),
    durationMs: finite(invocation.durationMs),
    exitCode: integer(invocation.exitCode),
    stdoutSha256: hash(invocation.stdoutSha256),
    resultSha256: hash(invocation.resultSha256),
    tokenUsage: finite(invocation.tokenUsage),
    tokenUsageAuthority: text(invocation.tokenUsageAuthority, 60)
  };
}

function publicVerdicts(state) {
  return (Array.isArray(state.supervisionEvents) ? state.supervisionEvents : []).slice(-100).map((event) => ({
    id: id(event.id),
    ts: timestamp(event.ts),
    type: text(event.type, 60),
    accepted: event.accepted === true,
    code: code(event.code),
    reasons: safeList(event.reasons, code, 12),
    route: route(event.route),
    phase: integer(event.phase),
    workerKind: text(event.workerKind, 60),
    attempt: integer(event.attempt),
    scenario: id(event.scenario),
    invocation: publicReceipt(event.invocation)
  })).filter((event) => event.id);
}

function activityDetail(event, detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  switch (event) {
    case 'initialized':
      return {
        model: route(d.model),
        policy: text(d.modelPolicySource, 80),
        banlist: text(d.banlistMode, 20),
        mode: text(d.mode, 40)
      };
    case 'loop_start':
    case 'advance_phase':
      return { loop: id(d.loop), phase: integer(d.phase), lane: id(d.lane), laneKind: text(d.laneKind, 40) };
    case 'supervisor_event':
      return {
        id: id(d.id),
        accepted: d.accepted === true,
        code: code(d.code),
        route: route(d.route),
        phase: integer(d.phase),
        scenario: id(d.scenario)
      };
    case 'full_test':
    case 'execute_full_test':
      return {
        id: id(d.id || d.testId),
        hypothesisId: id(d.hypothesisId),
        verdict: code(d.verdict),
        lane: id(d.lane)
      };
    case 'reverify':
      return { testId: id(d.testId), reverified: d.reverified === true };
    case 'promotion':
      return { id: id(d.id), hypothesisId: id(d.hypothesisId), kind: text(d.kind, 60) };
    case 'promotion_review_queued':
    case 'promotion_approved':
      return { reviewId: id(d.reviewId), hypothesisId: id(d.hypothesisId) };
    case 'auto_transition':
      return { cause: text(d.cause, 60), from: id(d.from), to: id(d.to), loop: id(d.toLoop) };
    case 'continuation_required':
    case 'continuation_cleared':
      return { id: id(d.id), source: text(d.source, 60) };
    case 'hypotheses_registered':
      return { count: integer(d.count) };
    case 'baseline_bar_set':
      return { tokenCost: finite(d.tokenCost), quality: finite(d.quality) };
    default:
      return {};
  }
}

function publicActivity(state) {
  return (Array.isArray(state.log) ? state.log : []).slice(-100).map((entry) => {
    const event = text(entry.event, 64);
    if (!event || !EVENT_RE.test(event)) return null;
    return {
      ts: timestamp(entry.ts),
      event,
      detail: activityDetail(event, entry.detail)
    };
  }).filter(Boolean);
}

function publicScoreMatrix(state) {
  const scoreState = {
    ...state,
    hypotheses: Array.isArray(state.hypotheses) ? state.hypotheses : [],
    tests: Array.isArray(state.tests) ? state.tests : []
  };
  return buildScoreMatrix(scoreState).map((row) => ({
    hypothesisId: id(row.hypothesisId),
    route: route(row.route && row.route.model),
    status: text(row.status, 40),
    measured: row.measured === true,
    tokenCost: finite(row.tokenCost),
    quality: finite(row.quality),
    qualityAuthority: text(row.qualityAuthority, 60),
    reverified: row.reverified === true,
    deltaQuality: finite(row.deltaQuality),
    deltaCostPct: finite(row.deltaCostPct),
    verdict: code(row.verdict),
    promotable: row.promotable === true
  })).filter((row) => row.hypothesisId);
}

function publicReviews(state) {
  const items = (Array.isArray(state.humanReviews) ? state.humanReviews : []).slice(0, 100).map((review) => ({
    id: id(review.id),
    ts: timestamp(review.ts),
    status: text(review.status, 20),
    kind: text(review.kind, 40),
    hypothesisId: id(review.hypothesisId),
    evidenceRef: id(review.evidenceRef),
    loopId: id(review.loopId),
    hasLoopContent: typeof review.loopContent === 'string' && review.loopContent.length > 0
  })).filter((review) => review.id);
  return {
    pending: items.filter((review) => review.status === 'PENDING').length,
    approved: items.filter((review) => review.status === 'APPROVED').length,
    sludge: items.filter((review) => review.status === 'SLUDGE').length,
    items
  };
}

function publicPromotions(state) {
  return (Array.isArray(state.promotions) ? state.promotions : []).slice(-100).map((promotion) => ({
    id: id(promotion.id),
    hypothesisId: id(promotion.hypothesisId),
    kind: text(promotion.kind, 60),
    qualityGain: finite(promotion.deltas && promotion.deltas.qualityGain),
    costRegressionPct: finite(promotion.deltas && promotion.deltas.costRegressionPct)
  })).filter((promotion) => promotion.id);
}

export function buildConsoleSnapshot(state) {
  const loops = publicLoops(state);
  const benchmark = state.benchmark || {};
  const baseline = state.baseline || {};
  const continuation = state.continuation || {};
  return {
    schemaVersion: 1,
    generatedAt: timestamp(state.updatedAt),
    stopCondition: STOP_CONDITION_WARNING,
    run: {
      id: id(state.runId),
      status: text(state.status, 40),
      createdAt: timestamp(state.createdAt),
      updatedAt: timestamp(state.updatedAt),
      mode: text(state.task && state.task.mode, 40),
      taskSha256: hash(state.task && state.task.sha256),
      runMode: text(state.config && state.config.runMode, 20),
      activeLoop: id(state.activeLoop)
    },
    policy: publicPolicy(state),
    continuation: {
      required: continuation.required === true,
      id: id(continuation.id),
      since: timestamp(continuation.since),
      source: text(continuation.source, 60),
      inProgress: continuation.inProgress === true,
      nextTool: text(continuation.next && continuation.next.tool, 80)
    },
    failures: {
      consecutive: integer(state.failures && state.failures.consecutive) ?? 0,
      total: integer(state.failures && state.failures.total) ?? 0,
      patience: integer(state.config && state.config.failurePatience) ?? 0,
      retirementBatches: integer(state.config && state.config.branchRetirementBatches) ?? 0,
      exhaustionFlagged: state.failures && state.failures.exhaustionFlagged === true
    },
    loops,
    campaign: publicLanes(state),
    evidence: {
      baselineLocked: baseline.recorded === true,
      baselineSha256: hash(baseline.sha256),
      benchmarkFrozen: benchmark.frozen === true,
      benchmarkCases: Array.isArray(benchmark.def && benchmark.def.cases) ? benchmark.def.cases.length : 0,
      baselineQuality: finite(benchmark.baselineScore && benchmark.baselineScore.quality),
      baselineTokenCost: finite(benchmark.baselineScore && benchmark.baselineScore.tokenCost),
      observations: Array.isArray(state.observations) ? state.observations.length : 0,
      artifacts: integer(state.counters && state.counters.artifact) ?? 0,
      evidencedPhases: loops.reduce((sum, loop) => sum + loop.evidencedPhases, 0)
    },
    scoreMatrix: publicScoreMatrix(state),
    verdicts: publicVerdicts(state),
    activity: publicActivity(state),
    reviews: publicReviews(state),
    promotions: publicPromotions(state)
  };
}
