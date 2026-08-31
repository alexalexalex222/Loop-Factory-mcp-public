import { buildConsoleSnapshot } from './console.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const LOOP_FACTORY_APP_API_SCHEMA = 'loop-factory-app-api-v1';
export const LOOP_FACTORY_EVENT_SCHEMA = 'loop-factory-app-event-v1';

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, maximum = 240) {
  if (value == null) return null;
  const text = String(value).replace(/[\0\r\n]/g, ' ').trim();
  return text ? text.slice(0, maximum) : null;
}

function safeDetail(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? null : null;
  if (typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeDetail(item, depth + 1));
  if (!plainObject(value)) return null;
  const blocked = /(?:secret|token|credential|authorization|prompt|stdout|stderr|content|argv|absolutePath)/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key))
    .slice(0, 80)
    .map(([key, item]) => [safeString(key, 80), safeDetail(item, depth + 1)]));
}

function rawEvents(state) {
  if (state?.kind === 'adaptive-recursive-campaign') {
    return (state.events || []).map((event) => ({
      type: event.type,
      at: event.createdAt,
      detail: event.detail
    }));
  }
  if (state?.kind === 'adaptive-recursive-canary-v2') {
    const calls = (state.calls || []).map((call) => ({
      type: 'CALL_MEASURED',
      at: state.updatedAt,
      detail: {
        callIndex: call.callIndex,
        stage: call.stage,
        taskId: call.taskId,
        replicate: call.replicate,
        arm: call.arm,
        requestedModel: call.requestedModel,
        reasoningEffort: call.reasoningEffort,
        tokenCost: call.cliReportedTotalTokens,
        evaluationSha256: call.evaluationSha256
      }
    }));
    return [{
      type: 'RUN_CREATED',
      at: state.createdAt,
      detail: { planSha256: state.plan?.sha256 }
    }, ...calls, ...(['CALIBRATION_REJECTED', 'QUEUE_DRAINED', 'BLOCKED', 'OPERATOR_STOP']
      .includes(state.status) ? [{
        type: state.status,
        at: state.completedAt || state.updatedAt,
        detail: {
          experimentValid: state.verification?.experimentValid ?? false,
          causalPass: state.verification?.causalPass ?? false,
          evidenceSha256: state.verification?.evidenceSha256 || null
        }
      }] : [])];
  }
  return (state?.runlog || []).map((event) => ({
    type: event.type || event.event || 'RUN_EVENT',
    at: event.at || event.createdAt || state.updatedAt,
    detail: event
  }));
}

export function buildLoopFactoryEventFeed(state, { after = null } = {}) {
  const runId = isSafeId(state?.runId) ? state.runId : null;
  if (!runId) {
    return { status: 'REFUSED', code: 'APP_EVENT_RUN_INVALID' };
  }
  let previousCursor = null;
  const events = rawEvents(state).map((event, sequence) => {
    const payload = {
      schemaVersion: LOOP_FACTORY_EVENT_SCHEMA,
      runId,
      sequence,
      previousCursor,
      type: safeString(event.type, 80) || 'RUN_EVENT',
      at: safeString(event.at, 40),
      detail: safeDetail(event.detail)
    };
    const cursor = `evt-${sha256(JSON.stringify(payload)).slice(0, 32)}`;
    previousCursor = cursor;
    return { ...payload, cursor };
  });
  let start = 0;
  if (after != null) {
    const index = events.findIndex((event) => event.cursor === after);
    if (index < 0) {
      return {
        status: 'REFUSED',
        code: 'APP_EVENT_CURSOR_UNKNOWN',
        latestCursor: events.at(-1)?.cursor || null
      };
    }
    start = index + 1;
  }
  const visible = events.slice(start);
  const payload = {
    schemaVersion: LOOP_FACTORY_APP_API_SCHEMA,
    runId,
    after,
    events: visible,
    latestCursor: events.at(-1)?.cursor || null,
    hasMore: false
  };
  return {
    status: 'OK',
    ...payload,
    feedSha256: sha256(JSON.stringify(payload))
  };
}

export function buildLoopFactoryRunEnvelope(state, options = {}) {
  const snapshot = options.snapshot || buildConsoleSnapshot(state);
  const payload = {
    schemaVersion: LOOP_FACTORY_APP_API_SCHEMA,
    runId: snapshot.run?.id || null,
    snapshot,
    capabilities: {
      eventCursor: true,
      operatorStop: snapshot.recursive?.operator?.canStop === true,
      humanReview: Number(snapshot.reviews?.pending || 0) > 0,
      promotion: false
    }
  };
  return {
    ...payload,
    envelopeSha256: sha256(JSON.stringify(payload))
  };
}

export function buildLoopFactoryRunSummary(state) {
  const snapshot = buildConsoleSnapshot(state);
  return {
    runId: snapshot.run?.id || null,
    kind: snapshot.kind || 'campaign',
    status: snapshot.run?.status || null,
    model: snapshot.run?.model || snapshot.policy?.primary || null,
    updatedAt: snapshot.run?.updatedAt || null,
    experimentValid: snapshot.recursive?.experimentValid
      ?? snapshot.canary?.proof?.experimentValid
      ?? null,
    causalPass: snapshot.recursive?.causalPass ?? null,
    pendingDecisions: Number(snapshot.reviews?.pending || 0),
    stopRequested: snapshot.recursive?.operator?.stopRequested === true
  };
}
