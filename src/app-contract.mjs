import { buildConsoleSnapshot } from './console.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const LOOP_FACTORY_APP_API_SCHEMA = 'loop-factory-app-api-v1';
export const LOOP_FACTORY_EVENT_SCHEMA = 'loop-factory-app-event-v1';
export const LOOP_FACTORY_EVIDENCE_INDEX_SCHEMA =
  'loop-factory-app-evidence-index-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_EVENT_DETAIL_KEY = /^(?:index|sequence|callIndex|stage|taskId|replicate|arm|requestedModel|reasoningEffort|tokenCost|status|state|kind|waveId|generation|disposition|causalPass|experimentValid|activationEligible|promotionAuthorized|calls|count|total|code|.*Sha256)$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, maximum = 240) {
  if (value == null) return null;
  const text = String(value).replace(/[\0\r\n]/g, ' ').trim();
  return text ? text.slice(0, maximum) : null;
}

function redactString(value, maximum = 240) {
  const text = safeString(value, maximum * 2);
  if (text == null) return null;
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, maximum);
}

function safeDetail(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? null : null;
  if (typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeDetail(item, depth + 1));
  if (!plainObject(value)) return null;
  const blocked = /(?:secret|token|credential|authorization|prompt|stdout|stderr|content|argv|absolutePath)/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key) && SAFE_EVENT_DETAIL_KEY.test(key))
    .slice(0, 80)
    .map(([key, item]) => [safeString(key, 80), safeDetail(item, depth + 1)]));
}

function rawEvents(state) {
  if (state?.kind === 'vnext-campaign-series') {
    return (state.events || []).map((event) => ({
      type: event.type,
      at: event.at,
      detail: {
        index: event.index,
        detailSha256: event.detailSha256
      }
    }));
  }
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

function boundedLimit(value, fallback = 50) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : fallback;
}

export function buildLoopFactoryEventFeed(state, { after = null, limit = 50 } = {}) {
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
  const pageLimit = boundedLimit(limit);
  const visible = events.slice(start, start + pageLimit);
  const hasMore = start + visible.length < events.length;
  const payload = {
    schemaVersion: LOOP_FACTORY_APP_API_SCHEMA,
    runId,
    after,
    limit: pageLimit,
    events: visible,
    nextCursor: visible.at(-1)?.cursor || after || null,
    latestCursor: events.at(-1)?.cursor || null,
    hasMore
  };
  return {
    status: 'OK',
    ...payload,
    feedSha256: sha256(JSON.stringify(payload))
  };
}

export function buildLoopFactoryRunEnvelope(state, options = {}) {
  const snapshot = options.snapshot || buildConsoleSnapshot(state);
  const stateRevisionSha256 = sha256(JSON.stringify(snapshot));
  const payload = {
    schemaVersion: LOOP_FACTORY_APP_API_SCHEMA,
    runId: snapshot.run?.id || null,
    stateRevisionSha256,
    snapshot,
    capabilities: {
      eventCursor: true,
      operatorStop: snapshot.recursive?.operator?.canStop === true,
      operatorControl: snapshot.kind === 'vnext-campaign-series',
      quarantine: snapshot.kind === 'vnext-campaign-series',
      rollback: snapshot.kind === 'vnext-campaign-series',
      releaseToShadow: snapshot.kind === 'vnext-campaign-series',
      humanReview: Number(snapshot.reviews?.pending || 0) > 0,
      evidenceIndex: true,
      evidenceBodies: false,
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

export function buildLoopFactoryRunList(states, { after = null, limit = 50 } = {}) {
  if (!Array.isArray(states)) {
    return { status: 'REFUSED', code: 'APP_RUN_LIST_INVALID' };
  }
  const pageLimit = boundedLimit(limit);
  const runs = states.map((state) => {
    const summary = plainObject(state?.__appSummary)
      ? state.__appSummary
      : buildLoopFactoryRunSummary(state);
    const cursor = `run-${sha256(JSON.stringify(summary)).slice(0, 32)}`;
    return { ...summary, cursor };
  }).filter((summary) => isSafeId(summary.runId)).sort((left, right) => (
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    || String(left.runId).localeCompare(String(right.runId))
  ));
  let start = 0;
  if (after != null) {
    const index = runs.findIndex((run) => run.cursor === after);
    if (index < 0) {
      return {
        status: 'REFUSED',
        code: 'APP_RUN_CURSOR_UNKNOWN',
        resetCursor: null
      };
    }
    start = index + 1;
  }
  const visible = runs.slice(start, start + pageLimit);
  const payload = {
    schemaVersion: LOOP_FACTORY_APP_API_SCHEMA,
    after,
    limit: pageLimit,
    runs: visible,
    nextCursor: visible.at(-1)?.cursor || after || null,
    hasMore: start + visible.length < runs.length
  };
  return {
    status: 'OK',
    ...payload,
    listSha256: sha256(JSON.stringify(payload))
  };
}

function evidenceHashes(value, path = [], rows = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => evidenceHashes(item, [...path, String(index)], rows));
    return rows;
  }
  if (!plainObject(value)) return rows;
  for (const [key, item] of Object.entries(value)) {
    const next = [...path, key];
    if (typeof item === 'string'
        && /sha256$/i.test(key)
        && SHA256.test(item)) {
      rows.push({ path: next, sha256: item });
    } else {
      evidenceHashes(item, next, rows);
    }
  }
  return rows;
}

export function buildLoopFactoryEvidenceIndex(state, options = {}) {
  const snapshot = options.snapshot || buildConsoleSnapshot(state);
  const runId = snapshot.run?.id;
  if (!isSafeId(runId)) {
    return { status: 'REFUSED', code: 'APP_EVIDENCE_RUN_INVALID' };
  }
  const seen = new Set();
  const boundHashes = new Set([
    snapshot.recursive?.verifier?.status === 'OK'
      && snapshot.recursive?.verifier?.seriesValid === true
      ? snapshot.recursive.verifier.evidenceSha256
      : null
  ].filter((value) => SHA256.test(String(value || ''))));
  const entries = evidenceHashes(snapshot)
    .filter((entry) => {
      if (seen.has(entry.sha256)) return false;
      seen.add(entry.sha256);
      return true;
    })
    .map((entry) => {
      const semanticPath = entry.path.filter((segment) => !/^\d+$/.test(segment));
      const label = semanticPath.slice(-3).join('.');
      return {
        evidenceId: `evidence-${sha256(`${runId}:${entry.sha256}`).slice(0, 24)}`,
        label: safeString(label, 120),
        sha256: entry.sha256,
        verificationState: boundHashes.has(entry.sha256)
          ? 'BOUND'
          : 'REFERENCE',
        artifactAvailable: false
      };
    });
  const payload = {
    schemaVersion: LOOP_FACTORY_EVIDENCE_INDEX_SCHEMA,
    runId,
    entries,
    artifactBodiesExposed: false
  };
  return {
    status: 'OK',
    ...payload,
    indexSha256: sha256(JSON.stringify(payload))
  };
}
