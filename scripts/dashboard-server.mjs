#!/usr/bin/env node
// Zero-dep served dashboard for explicit operator review.
//
// Open it in a browser, choose Approve or Deny, then confirm the local queue action.
// The POST to /apply MERGES the decision into that run's inbox
// (runs/<runId>/inbox-decisions.json). The running campaign's per-tick drain then
// revalidates it (operator-driven, model-independent, non-blocking). The MCP tool
// surface cannot resolve reviews; the served browser path requires a session token
// plus the exact reviewed-state hash.
//
//   node scripts/dashboard-server.mjs [--port 8787] [--home <dir>]
//
// Binds to 127.0.0.1 only. Non-loopback Host values, missing/cross-origin browser
// Origins, missing session tokens, and stale review bindings are rejected.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createStore } from '../src/store.mjs';
import { buildConsoleSnapshot } from '../src/console.mjs';
import { renderDashboard, renderRunSelector } from '../src/dashboard.mjs';
import { isSafeId, sha256 } from '../src/util.mjs';
import { isReviewDecisionBinding, reviewDecisionBinding } from '../src/review-decisions.mjs';
import {
  LOOP_FACTORY_APP_API_SCHEMA,
  buildLoopFactoryEvidenceIndex,
  buildLoopFactoryEventFeed,
  buildLoopFactoryRunEnvelope,
  buildLoopFactoryRunList,
  buildLoopFactoryRunSummary
} from '../src/app-contract.mjs';
import { loadCampaignSeriesWaveInputs } from '../src/campaign-series-store.mjs';
import { verifyVNextCampaignSeries } from '../src/vnext-campaign-driver.mjs';
import { verifyVNextCampaignWave } from '../src/vnext-wave-runner.mjs';
import {
  listAdaptiveRecords,
  loadMechanismCatalog
} from '../src/mechanism-catalog.mjs';
import { ADAPTIVE_SCHEMA } from '../src/adaptive-records.mjs';
import { createVNextOperatorAction } from '../src/vnext-operator-actions.mjs';
import {
  applyAndPersistVNextOperatorControl,
  initializeVNextOperatorControl,
  loadVNextOperatorControlProjection
} from '../src/vnext-operator-control.mjs';
import { createInitialVNextOperatorControl } from '../src/vnext-operator-control-contract.mjs';
import { resolveStateHome } from '../src/state-home.mjs';

function flag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function pathRunId(value) {
  try {
    const decoded = decodeURIComponent(String(value || ''));
    return isSafeId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = resolveStateHome(PKG_ROOT, { home: flag('--home') }).homeDir;
const port = Number(flag('--port', process.env.SUPER_LOOP_DASHBOARD_PORT || '8787'));
const store = createStore(home);

const send = (res, code, type, body, headers = {}) => {
  res.writeHead(code, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers
  });
  res.end(body);
};
const json = (res, code, obj, headers) => send(res, code, 'application/json', JSON.stringify(obj), headers);

function readInbox(theStore, runId) {
  const raw = theStore.readRunFile(runId, 'inbox-decisions.json');
  if (raw == null) return { status: 'NONE', runId, decisions: {} };
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 'INVALID', runId, decisions: {} };
    }
    const decisions = payload.decisions == null ? payload : payload.decisions;
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
      return { status: 'INVALID', runId, decisions: {} };
    }
    if (payload.runId != null && payload.runId !== runId) {
      return { status: 'INVALID', runId, decisions: {} };
    }
    return { status: 'OK', runId, decisions };
  } catch {
    return { status: 'INVALID', runId, decisions: {} };
  }
}

function vnextOperatorControlView(theStore, state) {
  const loaded = loadVNextOperatorControlProjection({ homeDir: theStore.homeDir });
  const virtual = loaded.status === 'NOT_INITIALIZED'
    ? createInitialVNextOperatorControl({ createdAt: state.createdAt })
    : null;
  const projection = loaded.status === 'OK'
    ? loaded.projection
    : virtual?.status === 'OK'
      ? virtual.projection
      : null;
  const catalog = loadMechanismCatalog({ homeDir: theStore.homeDir });
  const listed = listAdaptiveRecords({ homeDir: theStore.homeDir });
  const policyRecords = listed.status === 'OK'
    ? listed.records.filter((record) => record.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH)
    : [];
  const heads = [...new Set(policyRecords.map((record) => record.policyScopeId))]
    .sort()
    .map((scopeId) => {
      const chain = policyRecords
        .filter((record) => record.policyScopeId === scopeId)
        .sort((left, right) => left.epochNumber - right.epochNumber);
      return projection?.policyOverride?.scopeId === scopeId
        ? chain.find((record) => record.policyEpochId === projection.policyOverride.id)
        : chain.at(-1);
    })
    .filter(Boolean)
    .map((record) => ({
      id: record.policyEpochId,
      sha256: record.policyEpochSha256,
      scopeId: record.policyScopeId,
      epochNumber: record.epochNumber,
      trigger: record.trigger,
      active: true,
      ancestors: policyRecords.filter((candidate) => (
        candidate.policyScopeId === record.policyScopeId
        && candidate.epochNumber < record.epochNumber
      )).sort((left, right) => right.epochNumber - left.epochNumber)
        .map((candidate) => ({
          id: candidate.policyEpochId,
          sha256: candidate.policyEpochSha256,
          epochNumber: candidate.epochNumber
        }))
    }));
  const families = catalog.status === 'OK'
    ? catalog.catalog.families.map((family) => ({
        id: family.familyId,
        sha256: family.familySha256,
        lifecycle: family.lifecycle,
        status: projection?.quarantinedFamilyIds.includes(family.familyId)
          ? 'QUARANTINED'
          : projection?.shadowOnlyFamilyIds.includes(family.familyId)
            ? 'SHADOW_ONLY'
            : family.quarantined
              ? 'EVIDENCE_QUARANTINED'
              : family.routingEligible
                ? 'ROUTING_ELIGIBLE'
                : 'OBSERVED',
        routingEligible: family.routingEligible === true
          && !projection?.quarantinedFamilyIds.includes(family.familyId)
          && !projection?.shadowOnlyFamilyIds.includes(family.familyId),
        positiveEvidenceCount: family.positiveEvidenceCount,
        contradictionEvidenceCount: family.contradictionEvidenceCount,
        failedTransferCount: family.failedTransferCount
      }))
    : [];
  const payload = {
    schemaVersion: 'loop-factory-vnext-operator-control-view-v1',
    status: projection ? 'OK' : 'BLOCKED',
    sourceStatus: loaded.status,
    revision: projection?.revision ?? null,
    revisionSha256: projection?.projectionSha256 || null,
    disposition: projection?.disposition || null,
    activationAuthorized: false,
    promotionAuthorized: false,
    families,
    policyHeads: heads,
    capabilities: {
      quarantine: projection != null,
      rollback: projection != null,
      releaseToShadow: projection != null,
      activate: false,
      promote: false
    }
  };
  return { ...payload, viewSha256: sha256(JSON.stringify(payload)) };
}

function releaseEvidenceVerifier(theStore, familyId) {
  return (evidenceSha256) => {
    for (const runId of theStore.listRuns()) {
      let state;
      try { state = theStore.load(runId); } catch { continue; }
      if (state.kind !== 'vnext-campaign-series') continue;
      for (const wave of state.completedWaves || []) {
        if (wave.status !== 'VERIFIED') continue;
        const verified = verifyVNextCampaignWave({
          store: theStore,
          seriesRunId: runId,
          waveId: wave.waveId
        });
        if (verified.status === 'OK'
            && verified.evidenceSha256 === evidenceSha256
            && verified.receipt.taskPartition === 'validation'
            && verified.causalPass === true
            && verified.receipt.catalogRecords.some((record) => (
              record.recordId === familyId
            ))) {
          return { status: 'OK', evidenceSha256 };
        }
      }
    }
    return { status: 'REFUSED', code: 'VNEXT_RELEASE_EVIDENCE_NOT_FOUND' };
  };
}

function buildServedSnapshot(theStore, runId, state = theStore.load(runId)) {
  const snapshot = buildConsoleSnapshot(state);
  if (snapshot.recursive?.enabled) {
    const vnext = state.kind === 'vnext-campaign-series';
    snapshot.recursive.operator.stopRequested = vnext
      ? state.operatorStop === true
        || theStore.readRunFile(runId, 'campaign-series/STOP') != null
      : theStore.readRunFile(runId, 'OPERATOR_STOP') != null;
    if (vnext) {
      snapshot.recursive.operatorControl = vnextOperatorControlView(theStore, state);
      const verification = verifyVNextCampaignSeries({
        store: theStore,
        seriesRunId: runId
      });
      snapshot.recursive.verifier = {
        status: verification.status,
        seriesValid: verification.seriesValid === true,
        campaignContinues: verification.campaignContinues === true,
        evidenceSha256: /^[a-f0-9]{64}$/.test(String(verification.evidenceSha256 || ''))
          ? verification.evidenceSha256
          : null
      };
      snapshot.recursive.gates.push({
        id: 'series-replay',
        label: 'Independent series replay',
        status: verification.seriesValid === true ? 'PASS' : 'FAIL'
      }, {
        id: 'promotion-disabled',
        label: 'Canonical promotion disabled',
        status: verification.evidence?.promotionAuthorized === false ? 'PASS' : 'UNKNOWN'
      });
      const latestWave = state.currentWave?.descriptor
        || [...(state.completedWaves || [])].reverse().find((wave) => wave.waveId)
        || state.queue?.[0]
        || null;
      if (latestWave) {
        const inputs = loadCampaignSeriesWaveInputs({
          store: theStore,
          runId,
          waveId: latestWave.waveId
        });
        if (inputs.status === 'OK') {
          const model = inputs.config.recursiveCanary?.model || null;
          const reasoningEffort = inputs.config.recursiveCanary?.reasoningEffort || null;
          snapshot.run.model = model;
          snapshot.run.reasoningEffort = reasoningEffort;
          snapshot.policy.primary = model;
          snapshot.policy.testRoutes = model ? [model] : [];
          snapshot.policy.builderRoutes = model ? [model] : [];
          snapshot.policy.judgeRoute = model;
          snapshot.recursive.current.childRunId = inputs.config.experimentRunId;
          snapshot.recursive.latestWave = {
            waveId: latestWave.waveId,
            partition: inputs.taskPack.partition,
            taskPackId: inputs.taskPack.packId,
            taskPackSha256: inputs.taskPack.packSha256,
            configSha256: inputs.config.configSha256,
            evidenceSha256: latestWave.evidenceSha256 || null,
            preparationRunId: inputs.config.preparationRunId,
            experimentRunId: inputs.config.experimentRunId
          };
        }
      }
    }
    const latestChildRunId = state.currentGeneration?.childRunId
      || snapshot.recursive.current?.childRunId
      || [...(state.generations || [])].reverse()
        .find((generation) => generation.childRunId)?.childRunId
      || null;
    if (latestChildRunId && theStore.exists(latestChildRunId)) {
      const childSnapshot = buildConsoleSnapshot(theStore.load(latestChildRunId));
      if (childSnapshot.recursive?.enabled) {
        snapshot.recursive.latestChild = {
          runId: latestChildRunId,
          experimentValid: childSnapshot.recursive.experimentValid,
          causalPass: childSnapshot.recursive.causalPass,
          stages: childSnapshot.recursive.stages,
          gates: childSnapshot.recursive.gates,
          tokenUsage: childSnapshot.recursive.tokenUsage
        };
      }
    }
  }
  if (!snapshot.reviews || !Array.isArray(snapshot.reviews.items)) return snapshot;
  const inbox = readInbox(theStore, runId);
  let queued = 0;
  let stale = 0;
  for (const review of snapshot.reviews.items) {
    if (review.status !== 'PENDING') continue;
    const decision = inbox.decisions[review.id];
    if (!decision || !['approve', 'sludge'].includes(decision.decision)) continue;
    review.queuedDecision = decision.decision;
    review.queuedAt = typeof decision.queuedAt === 'string' && !/[\0\r\n]/.test(decision.queuedAt)
      ? decision.queuedAt.slice(0, 40)
      : null;
    review.queueBindingValid = decision.reviewSha256 === review.decisionBindingSha256;
    if (review.queueBindingValid) queued += 1;
    else stale += 1;
  }
  snapshot.reviews.queued = queued;
  snapshot.reviews.stale = stale;
  snapshot.reviews.awaiting = Math.max(0, snapshot.reviews.pending - queued);
  snapshot.reviews.inboxStatus = inbox.status;
  return snapshot;
}

export function buildDashboardServer(theStore = store, thePort = port, options = {}) {
  const decisionToken = String(
    options.decisionToken
    || process.env.SUPER_LOOP_DECISION_TOKEN
    || randomBytes(32).toString('hex')
  );
  const hostOk = (req) => /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(String(req.headers.host || ''));
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return false;
    const host = String(req.headers.host || '');
    return o === `http://${host}`;
  };
  const decisionTokenOk = (req) => {
    const supplied = Buffer.from(String(req.headers['x-super-loop-decision-token'] || ''), 'utf8');
    const expected = Buffer.from(decisionToken, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (!hostOk(req)) return json(res, 403, { ok: false, error: 'non-loopback Host refused' });

    if (req.method === 'GET' && u.pathname === '/api/run') {
      const runId = String(u.searchParams.get('run') || '');
      if (!isSafeId(runId) || !theStore.exists(runId)) {
        return json(res, 404, { ok: false, error: 'unknown run' }, { 'cache-control': 'no-store' });
      }
      const snapshot = buildServedSnapshot(theStore, runId);
      const body = JSON.stringify(snapshot);
      const etag = `"${sha256(body)}"`;
      const headers = { etag, 'cache-control': 'no-store' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      return send(res, 200, 'application/json; charset=utf-8', body, headers);
    }

    if (req.method === 'GET' && u.pathname === '/api/v1/runs') {
      const states = theStore.listRuns().map((runId) => {
        try {
          const state = theStore.load(runId);
          const summary = buildLoopFactoryRunSummary(state);
          if (summary.kind === 'adaptive-recursive-campaign'
              || summary.kind === 'adaptive-recursive-canary-v2'
              || summary.kind === 'vnext-campaign-series') {
            summary.stopRequested = summary.kind === 'vnext-campaign-series'
              ? state.operatorStop === true
                || theStore.readRunFile(runId, 'campaign-series/STOP') != null
              : theStore.readRunFile(runId, 'OPERATOR_STOP') != null;
          }
          return { state, summary };
        } catch {
          return null;
        }
      }).filter(Boolean);
      const page = buildLoopFactoryRunList(
        states.map(({ state, summary }) => ({ ...state, __appSummary: summary })),
        {
          after: u.searchParams.get('after'),
          limit: Number(u.searchParams.get('limit') || 50)
        }
      );
      if (page.status !== 'OK') {
        return json(res, 409, {
          ok: false,
          error: page.code,
          resetCursor: page.resetCursor ?? null
        }, { 'cache-control': 'no-store' });
      }
      return json(res, 200, page, { 'cache-control': 'no-store' });
    }

    const appRunMatch = u.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (req.method === 'GET' && appRunMatch) {
      const runId = pathRunId(appRunMatch[1]);
      if (!runId || !theStore.exists(runId)) {
        return json(res, 404, { ok: false, error: 'unknown run' }, { 'cache-control': 'no-store' });
      }
      const state = theStore.load(runId);
      const snapshot = buildServedSnapshot(theStore, runId, state);
      const envelope = buildLoopFactoryRunEnvelope(state, { snapshot });
      const body = JSON.stringify(envelope);
      const etag = `"${envelope.envelopeSha256}"`;
      const headers = { etag, 'cache-control': 'no-store' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      return send(res, 200, 'application/json; charset=utf-8', body, headers);
    }

    const appEventsMatch = u.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    if (req.method === 'GET' && appEventsMatch) {
      const runId = pathRunId(appEventsMatch[1]);
      if (!runId || !theStore.exists(runId)) {
        return json(res, 404, { ok: false, error: 'unknown run' }, { 'cache-control': 'no-store' });
      }
      const feed = buildLoopFactoryEventFeed(theStore.load(runId), {
        after: u.searchParams.get('after'),
        limit: Number(u.searchParams.get('limit') || 50)
      });
      if (feed.status !== 'OK') {
        return json(res, 409, {
          ok: false,
          error: feed.code,
          latestCursor: feed.latestCursor || null,
          resetCursor: null
        }, { 'cache-control': 'no-store' });
      }
      return json(res, 200, feed, { 'cache-control': 'no-store' });
    }

    const appEvidenceMatch = u.pathname.match(
      /^\/api\/v1\/runs\/([^/]+)\/evidence$/
    );
    if (req.method === 'GET' && appEvidenceMatch) {
      const runId = pathRunId(appEvidenceMatch[1]);
      if (!runId || !theStore.exists(runId)) {
        return json(res, 404, { ok: false, error: 'unknown run' }, { 'cache-control': 'no-store' });
      }
      const state = theStore.load(runId);
      const snapshot = buildServedSnapshot(theStore, runId, state);
      const evidence = buildLoopFactoryEvidenceIndex(state, { snapshot });
      return evidence.status === 'OK'
        ? json(res, 200, evidence, { 'cache-control': 'no-store' })
        : json(res, 409, { ok: false, error: evidence.code }, { 'cache-control': 'no-store' });
    }

    const operatorControlMatch = u.pathname.match(
      /^\/api\/v1\/runs\/([^/]+)\/operator-control$/
    );
    if (operatorControlMatch) {
      const runId = pathRunId(operatorControlMatch[1]);
      if (!runId || !theStore.exists(runId)) {
        return json(res, 404, { ok: false, error: 'unknown run' }, { 'cache-control': 'no-store' });
      }
      const state = theStore.load(runId);
      if (state.kind !== 'vnext-campaign-series') {
        return json(res, 409, { ok: false, error: 'operator control requires a VNext campaign' });
      }
      if (req.method === 'GET') {
        return json(res, 200, vnextOperatorControlView(theStore, state), {
          'cache-control': 'no-store'
        });
      }
      if (req.method === 'POST') {
        if (!originOk(req)) {
          return json(res, 403, { ok: false, error: 'same-origin browser POST required' });
        }
        if (!decisionTokenOk(req)) {
          return json(res, 403, { ok: false, error: 'decision session token required' });
        }
        let buf = '';
        req.on('data', (chunk) => {
          buf += chunk;
          if (buf.length > 64 * 1024) req.destroy();
        });
        req.on('end', () => {
          let body;
          try { body = JSON.parse(buf || '{}'); } catch {
            return json(res, 400, { ok: false, error: 'bad json' });
          }
          const stateSnapshot = buildServedSnapshot(theStore, runId, state);
          const stateRevisionSha256 = buildLoopFactoryRunEnvelope(state, {
            snapshot: stateSnapshot
          }).stateRevisionSha256;
          if (!/^[a-f0-9]{64}$/.test(String(body.expectedRunRevisionSha256 || ''))
              || body.expectedRunRevisionSha256 !== stateRevisionSha256) {
            return json(res, 409, {
              ok: false,
              error: 'run changed; reload before applying operator control',
              code: 'RUN_REVISION_CHANGED',
              stateRevisionSha256
            });
          }
          const kind = String(body.kind || '');
          if (!['quarantine-family', 'rollback-policy', 'release-quarantine']
            .includes(kind)) {
            return json(res, 400, { ok: false, error: 'unsupported operator action' });
          }
          const current = loadVNextOperatorControlProjection({ homeDir: theStore.homeDir });
          if (current.status === 'NOT_INITIALIZED') {
            const initial = initializeVNextOperatorControl({
              homeDir: theStore.homeDir,
              createdAt: state.createdAt
            });
            if (initial.status !== 'OK'
                || body.expectedRevisionSha256 !== initial.projection.projectionSha256) {
              return json(res, 409, { ok: false, error: 'operator control changed; reload' });
            }
          } else if (current.status !== 'OK'
              || body.expectedRevisionSha256 !== current.projection.projectionSha256) {
            return json(res, 409, { ok: false, error: 'operator control changed; reload' });
          }
          const createdAt = new Date().toISOString();
          const actionId = `action-${sha256(JSON.stringify({
            runId,
            kind,
            target: body.target,
            expectedRevisionSha256: body.expectedRevisionSha256,
            rollbackTarget: body.rollbackTarget || null,
            evidenceSha256: body.evidenceSha256,
            verifierEvidenceSha256: body.verifierEvidenceSha256 || null,
            createdAt
          })).slice(0, 24)}`;
          const built = createVNextOperatorAction({
            actionId,
            runId,
            kind,
            target: body.target,
            expectedRevisionSha256: body.expectedRevisionSha256,
            rollbackTarget: body.rollbackTarget ?? null,
            reasonCode: body.reasonCode,
            evidenceSha256: body.evidenceSha256,
            verifierEvidenceSha256: body.verifierEvidenceSha256 ?? null,
            authority: {
              operatorId: 'dashboard-operator',
              sessionId: `session-${sha256(decisionToken).slice(0, 24)}`
            },
            createdAt
          });
          if (built.status !== 'OK') {
            return json(res, 400, { ok: false, error: built.code });
          }
          const records = listAdaptiveRecords({ homeDir: theStore.homeDir });
          if (records.status !== 'OK') {
            return json(res, 409, { ok: false, error: records.code });
          }
          const applied = applyAndPersistVNextOperatorControl({
            homeDir: theStore.homeDir,
            action: built.action,
            records: records.records,
            verifyReleaseEvidence: kind === 'release-quarantine'
              ? releaseEvidenceVerifier(theStore, body.target?.id)
              : null
          });
          if (applied.status !== 'OK') {
            return json(res, 409, { ok: false, error: applied.code });
          }
          return json(res, 200, {
            ok: true,
            actionId,
            disposition: applied.disposition,
            restrictive: applied.restrictive,
            revision: applied.projection.revision,
            revisionSha256: applied.projection.projectionSha256,
            activationAuthorized: false,
            promotionAuthorized: false
          });
        });
        return;
      }
    }

    const appStopMatch = u.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/stop$/);
    if (req.method === 'POST' && appStopMatch) {
      if (!originOk(req)) {
        return json(res, 403, { ok: false, error: 'same-origin browser POST required' });
      }
      if (!decisionTokenOk(req)) {
        return json(res, 403, { ok: false, error: 'decision session token required' });
      }
      let buf = '';
      req.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 16 * 1024) req.destroy();
      });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(buf || '{}'); } catch {
          return json(res, 400, { ok: false, error: 'bad json' });
        }
        const runId = pathRunId(appStopMatch[1]);
        if (!runId || !theStore.exists(runId)) {
          return json(res, 404, { ok: false, error: 'unknown run' });
        }
        const state = theStore.load(runId);
        if (!['adaptive-recursive-campaign', 'adaptive-recursive-canary-v2',
          'vnext-campaign-series'].includes(state.kind)) {
          return json(res, 409, { ok: false, error: 'run does not support operator stop' });
        }
        if (state.kind !== 'vnext-campaign-series'
            && ['WAVE_DRAINED', 'IDLE_NO_NEW_WORK', 'CALIBRATION_REJECTED',
              'QUEUE_DRAINED', 'BLOCKED'].includes(state.status)) {
          return json(res, 409, { ok: false, error: `run is already ${state.status}` });
        }
        const snapshot = buildServedSnapshot(theStore, runId, state);
        const stateRevisionSha256 = buildLoopFactoryRunEnvelope(state, { snapshot })
          .stateRevisionSha256;
        if (!/^[a-f0-9]{64}$/.test(String(body.expectedRevisionSha256 || ''))) {
          return json(res, 409, {
            ok: false,
            error: 'exact run revision required before stopping',
            code: 'RUN_REVISION_REQUIRED',
            stateRevisionSha256
          });
        }
        if (body.expectedRevisionSha256 !== stateRevisionSha256) {
          return json(res, 409, {
            ok: false,
            error: 'run changed; reload before stopping',
            code: 'RUN_REVISION_CHANGED',
            stateRevisionSha256
          });
        }
        const stopPath = state.kind === 'vnext-campaign-series'
          ? 'campaign-series/STOP'
          : 'OPERATOR_STOP';
        const existing = theStore.readRunFile(runId, stopPath);
        const requestedAt = (() => {
          if (!existing) return new Date().toISOString();
          try {
            const parsed = JSON.parse(existing);
            return Number.isFinite(Date.parse(parsed.requestedAt))
              ? parsed.requestedAt
              : new Date().toISOString();
          } catch {
            return new Date().toISOString();
          }
        })();
        if (!existing) {
          const recordCore = {
            schemaVersion: 'loop-factory-operator-stop-v2',
            runId,
            requestedAt,
            authority: 'dashboard-session-token',
            expectedRevisionSha256: body.expectedRevisionSha256
          };
          theStore.writeRunFile(runId, stopPath, JSON.stringify({
            ...recordCore,
            recordSha256: sha256(JSON.stringify(recordCore))
          }, null, 2));
        }
        const persisted = theStore.readRunFile(runId, stopPath);
        const receiptCore = {
          schemaVersion: 'loop-factory-operator-stop-receipt-v1',
          operationId: `stop-${sha256(`${runId}:${requestedAt}`).slice(0, 24)}`,
          runId,
          state: 'STOP_REQUESTED',
          requestedAt,
          stateRevisionSha256,
          stopRecordSha256: sha256(persisted || ''),
          idempotent: existing != null,
          activationAuthorized: false,
          promotionAuthorized: false
        };
        return json(res, 200, {
          ok: true,
          ...receiptCore,
          receiptSha256: sha256(JSON.stringify(receiptCore))
        });
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/apply') {
      if (!originOk(req)) return json(res, 403, { ok: false, error: 'same-origin browser POST required' });
      if (!decisionTokenOk(req)) return json(res, 403, { ok: false, error: 'decision session token required' });
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(buf || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
        const runId = String(body.runId || '');
        if (!runId || !theStore.exists(runId)) return json(res, 404, { ok: false, error: 'unknown run' });
        const state = theStore.load(runId);
        const reviews = new Map((Array.isArray(state.humanReviews) ? state.humanReviews : []).map((review) => [review.id, review]));
        const incoming = [];
        if (body.decisions && typeof body.decisions === 'object' && !Array.isArray(body.decisions)) {
          for (const [reviewId, value] of Object.entries(body.decisions)) {
            incoming.push([String(reviewId), value]);
          }
        } else if (body.reviewId && body.decision) {
          incoming.push([String(body.reviewId), {
            decision: body.decision,
            notes: body.notes,
            reviewSha256: body.reviewSha256
          }]);
        } else {
          return json(res, 400, { ok: false, error: 'need { reviewId, decision } or { decisions }' });
        }
        if (incoming.length === 0) {
          return json(res, 400, { ok: false, error: 'decisions must contain at least one review' });
        }
        const validated = {};
        for (const [reviewId, value] of incoming) {
          if (!isSafeId(reviewId)) return json(res, 400, { ok: false, error: 'invalid review id' });
          const review = reviews.get(reviewId);
          if (!review) return json(res, 404, { ok: false, error: `unknown review ${reviewId}` });
          if (review.status !== 'PENDING') {
            return json(res, 409, { ok: false, error: `review ${reviewId} is already ${review.status}` });
          }
          const decision = String(value && value.decision || '');
          if (!['approve', 'sludge'].includes(decision)) {
            return json(res, 400, { ok: false, error: 'decision must be approve or sludge' });
          }
          const notes = value && value.notes;
          if (notes != null && typeof notes !== 'string') {
            return json(res, 400, { ok: false, error: 'notes must be a string or null' });
          }
          const reviewSha256 = String(value && value.reviewSha256 || '').toLowerCase();
          const currentReviewSha256 = reviewDecisionBinding(state, review);
          if (!isReviewDecisionBinding(reviewSha256) || reviewSha256 !== currentReviewSha256) {
            return json(res, 409, {
              ok: false,
              error: 'review changed or is not bound; reload before deciding',
              code: isReviewDecisionBinding(reviewSha256) ? 'REVIEW_BINDING_CHANGED' : 'REVIEW_BINDING_REQUIRED'
            });
          }
          validated[reviewId] = {
            decision,
            notes: notes ? notes.slice(0, 4000) : null,
            reviewSha256,
            queuedAt: new Date().toISOString()
          };
        }
        // merge into the existing inbox so multiple clicks accumulate before the next drain
        const currentInbox = readInbox(theStore, runId);
        if (currentInbox.status === 'INVALID') {
          return json(res, 409, {
            ok: false,
            error: 'decision inbox is invalid; let the supervisor archive it before retrying'
          });
        }
        const inbox = { runId, decisions: { ...currentInbox.decisions } };
        const replaced = Object.keys(validated).filter((reviewId) => inbox.decisions[reviewId] != null);
        Object.assign(inbox.decisions, validated);
        theStore.writeRunFile(runId, 'inbox-decisions.json', JSON.stringify(inbox, null, 2));
        const decisions = Object.values(validated).map((item) => item.decision);
        const queuedState = decisions.length === 1
          ? (decisions[0] === 'approve' ? 'APPROVAL_QUEUED' : 'DENIAL_QUEUED')
          : 'DECISIONS_QUEUED';
        return json(res, 200, {
          ok: true,
          state: queuedState,
          queued: Object.keys(inbox.decisions).length,
          queuedThisRequest: Object.keys(validated).length,
          replaced,
          note: 'queued to the run inbox; persisted review state changes only when the running supervisor applies it'
        });
      });
      return;
    }

    if (req.method === 'GET') {
      const run = u.searchParams.get('run');
      if (run) {
        if (!isSafeId(run) || !theStore.exists(run)) return send(res, 404, 'text/plain', 'unknown run');
        try {
          const state = theStore.load(run);
          const snapshot = buildServedSnapshot(theStore, run, state);
          const rendered = renderDashboard(state, { snapshot, decisionToken });
          return send(res, 200, 'text/html; charset=utf-8', rendered, {
            'cache-control': 'no-store',
            'x-dashboard-source': 'state'
          });
        } catch {
          const html = theStore.readRunFile(run, 'dashboard.html');
          if (html) return send(res, 200, 'text/html; charset=utf-8', html, { 'x-dashboard-source': 'persisted-fallback' });
          return send(res, 500, 'text/plain', 'dashboard rendering failed');
        }
      }
      const runs = theStore.listRuns();
      const snapshots = runs.map((runId) => {
        try { return buildServedSnapshot(theStore, runId); } catch { return null; }
      }).filter(Boolean);
      return send(res, 200, 'text/html; charset=utf-8', renderRunSelector(snapshots), {
        'cache-control': 'no-store'
      });
    }
    send(res, 404, 'text/plain', 'not found');
  });
}

// Run standalone (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('dashboard-server.mjs')) {
  buildDashboardServer().listen(port, '127.0.0.1', () => {
    console.log(`super-loop dashboard → http://127.0.0.1:${port}  (home: ${home})`);
    console.log('Review admission evidence, queue any human decisions, or request an operator stop at a durable boundary.');
  });
}
