// The SERVED dashboard queues a confirmed Approve/Deny choice to the run inbox,
// which the running campaign adopts on its
// next tick — no file, no command. These tests drive the real http server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createEngine } from '../src/engine.mjs';
import { buildDashboardServer } from '../scripts/dashboard-server.mjs';
import { canaryState } from './fixtures/canary-state.mjs';
import { reviewDecisionBinding } from '../src/review-decisions.mjs';

const TASK = 'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.';
const IMPROVED = 'PHASE ONE INTAKE\nImproved served candidate DELTA with recorded evidence.\n\nPHASE TWO MEASURE\nMeasure it on the frozen benchmark.\n\nPHASE THREE VERIFY\nReverify; the operator is the only stop.';
const DECISION_TOKEN = 'dashboard-test-token';

function req(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        let parsed = null; try { parsed = b ? JSON.parse(b) : null; } catch { /* html */ }
        resolve({ status: res.statusCode, json: parsed, text: b, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function dashboardServer(store) { return buildDashboardServer(store, 0, { decisionToken: DECISION_TOKEN }); }
function decisionHeaders(port, extra = {}) {
  return {
    origin: `http://127.0.0.1:${port}`,
    'x-super-loop-decision-token': DECISION_TOKEN,
    ...extra
  };
}
function boundDecision(store, runId, reviewId, decision, notes) {
  const state = store.load(runId);
  const review = state.humanReviews.find((item) => item.id === reviewId);
  return {
    runId,
    reviewId,
    decision,
    notes,
    reviewSha256: reviewDecisionBinding(state, review)
  };
}

test('served dashboard: a click (POST /apply) queues to the inbox → applies → adopts the improved loop', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({ runId: 'd1', task: TASK, userMessages: ['go'] });
  const q = engine.human_review_request({ runId: 'd1', action: 'add', item: { kind: 'loop-adoption', loopId: 'served-miner', loopContent: IMPROVED } });

  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const before = await req(port, 'GET', '/?run=d1');
    assert.match(before.text, new RegExp(`name="super-loop-decision-token" content="${DECISION_TOKEN}"`));
    assert.ok(!JSON.stringify(store.load('d1')).includes(DECISION_TOKEN), 'session token must not enter persisted run state');
    assert.ok(!store.readRunFile('d1', 'dashboard.html').includes(DECISION_TOKEN), 'session token must not enter exported dashboard files');
    const r = await req(
      port,
      'POST',
      '/apply',
      boundDecision(store, 'd1', q.reviewId, 'approve', 'reviewed'),
      decisionHeaders(port)
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.state, 'APPROVAL_QUEUED');
    // queued to the run inbox (no file handling by the operator)
    const inbox = JSON.parse(store.readRunFile('d1', 'inbox-decisions.json'));
    assert.equal(inbox.decisions[q.reviewId].decision, 'approve');
    assert.match(inbox.decisions[q.reviewId].reviewSha256, /^[a-f0-9]{64}$/);
    const queuedPage = await req(port, 'GET', '/?run=d1');
    assert.match(queuedPage.text, /APPROVAL QUEUED/);
    assert.match(queuedPage.text, /data-review-status="QUEUED"/);
    const queuedApi = await req(port, 'GET', '/api/run?run=d1');
    assert.equal(queuedApi.json.reviews.queued, 1);
    assert.equal(queuedApi.json.reviews.awaiting, 0);
    assert.equal(queuedApi.json.reviews.items[0].queuedDecision, 'approve');
    assert.equal(queuedApi.json.reviews.items[0].queueBindingValid, true);
    // the campaign's drain (here: direct) adopts it
    const ap = engine.operator.applyInboxDecisions('d1');
    assert.equal(ap.applied[0].adopted.loopId, 'served-miner');
    assert.ok(store.readLoop('served-miner').content.includes('DELTA'));
    const duplicate = await req(port, 'POST', '/apply', {
      runId: 'd1',
      reviewId: q.reviewId,
      decision: 'approve',
      reviewSha256: inbox.decisions[q.reviewId].reviewSha256
    }, decisionHeaders(port));
    assert.equal(duplicate.status, 409);
    // GET serves that run's dashboard html
    engine.update_dashboard({ runId: 'd1' });
    const g = await req(port, 'GET', '/?run=d1');
    assert.equal(g.status, 200);
    assert.match(g.text, /Human review|Approve/i);
  } finally { server.close(); }
});

test('served dashboard: unknown run → 404, and a cross-origin POST is refused (CSRF guard)', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash2-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({ runId: 'd2', task: TASK });
  const review = engine.human_review_request({ runId: 'd2', item: { title: 'decision' } });
  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const bound = boundDecision(store, 'd2', review.reviewId, 'approve');
    const missingToken = await req(port, 'POST', '/apply', bound, { origin: `http://127.0.0.1:${port}` });
    assert.equal(missingToken.status, 403);
    const wrongToken = await req(port, 'POST', '/apply', bound, {
      origin: `http://127.0.0.1:${port}`,
      'x-super-loop-decision-token': 'wrong-token'
    });
    assert.equal(wrongToken.status, 403);
    const missingOrigin = await req(port, 'POST', '/apply', bound, { 'x-super-loop-decision-token': DECISION_TOKEN });
    assert.equal(missingOrigin.status, 403);
    const r404 = await req(port, 'POST', '/apply', { ...bound, runId: 'nope' }, decisionHeaders(port));
    assert.equal(r404.status, 404);
    const r403 = await req(port, 'POST', '/apply', bound, {
      origin: 'http://evil.example',
      'x-super-loop-decision-token': DECISION_TOKEN
    });
    assert.equal(r403.status, 403);
    const badHost = await req(port, 'POST', '/apply', bound, decisionHeaders(port, {
      host: `evil.example:${port}`,
      origin: `http://evil.example:${port}`
    }));
    assert.equal(badHost.status, 403);
    const invalidDecision = await req(port, 'POST', '/apply', {
      ...bound,
      decision: 'promote-anyway'
    }, decisionHeaders(port));
    assert.equal(invalidDecision.status, 400);
    const unknownReview = await req(port, 'POST', '/apply', {
      runId: 'd2',
      reviewId: 'rev-999',
      decision: 'sludge',
      reviewSha256: bound.reviewSha256
    }, decisionHeaders(port));
    assert.equal(unknownReview.status, 404);
    const emptyBatch = await req(port, 'POST', '/apply', { runId: 'd2', decisions: {} }, decisionHeaders(port));
    assert.equal(emptyBatch.status, 400);
    const invalidNotes = await req(port, 'POST', '/apply', {
      ...bound,
      decision: 'sludge',
      notes: { unsafe: true }
    }, decisionHeaders(port));
    assert.equal(invalidNotes.status, 400);
    const missingBinding = await req(port, 'POST', '/apply', {
      ...bound,
      decision: 'sludge',
      reviewSha256: null
    }, decisionHeaders(port));
    assert.equal(missingBinding.status, 409);
    assert.equal(missingBinding.json.code, 'REVIEW_BINDING_REQUIRED');
    const staleBinding = await req(port, 'POST', '/apply', {
      ...bound,
      decision: 'sludge',
      reviewSha256: '0'.repeat(64)
    }, decisionHeaders(port));
    assert.equal(staleBinding.status, 409);
    assert.equal(staleBinding.json.code, 'REVIEW_BINDING_CHANGED');
    const denied = await req(port, 'POST', '/apply', {
      ...bound,
      decision: 'sludge',
      notes: 'x'.repeat(5000)
    }, decisionHeaders(port));
    assert.equal(denied.status, 200);
    assert.equal(denied.json.state, 'DENIAL_QUEUED');
    const inbox = JSON.parse(store.readRunFile('d2', 'inbox-decisions.json'));
    assert.equal(inbox.decisions[review.reviewId].decision, 'sludge');
    assert.equal(inbox.decisions[review.reviewId].notes.length, 4000);
  } finally { server.close(); }
});

test('served dashboard: reload preserves queued truth and changed evidence becomes stale instead of applied', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-stale-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({ runId: 'stale-1', task: TASK });
  const review = engine.human_review_request({
    runId: 'stale-1',
    item: { title: 'reviewed title', summary: 'reviewed summary', kind: 'change' }
  });
  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const queued = await req(
      port,
      'POST',
      '/apply',
      boundDecision(store, 'stale-1', review.reviewId, 'approve'),
      decisionHeaders(port)
    );
    assert.equal(queued.status, 200);
    assert.match((await req(port, 'GET', '/?run=stale-1')).text, /APPROVAL QUEUED/);

    const changed = store.load('stale-1');
    changed.humanReviews.find((item) => item.id === review.reviewId).summary = 'changed after review';
    store.save(changed);

    const stalePage = await req(port, 'GET', '/?run=stale-1');
    assert.match(stalePage.text, /DECISION STALE/);
    const staleApi = await req(port, 'GET', '/api/run?run=stale-1');
    assert.equal(staleApi.json.reviews.queued, 0);
    assert.equal(staleApi.json.reviews.stale, 1);
    assert.equal(staleApi.json.reviews.awaiting, 1);
    assert.equal(staleApi.json.reviews.items[0].queueBindingValid, false);

    const drained = engine.operator.applyInboxDecisions('stale-1');
    assert.equal(drained.ok, false);
    assert.equal(drained.applied[0].code, 'REVIEW_BINDING_CHANGED');
    assert.equal(store.load('stale-1').humanReviews[0].status, 'PENDING');
  } finally { server.close(); }
});

test('served dashboard: a corrupt inbox is never overwritten by a new browser decision', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-corrupt-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({ runId: 'corrupt-1', task: TASK });
  const review = engine.human_review_request({ runId: 'corrupt-1', item: { title: 'decision' } });
  store.writeRunFile('corrupt-1', 'inbox-decisions.json', '{not valid json');
  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const response = await req(
      port,
      'POST',
      '/apply',
      boundDecision(store, 'corrupt-1', review.reviewId, 'approve'),
      decisionHeaders(port)
    );
    assert.equal(response.status, 409);
    assert.match(response.json.error, /inbox is invalid/i);
    assert.equal(store.readRunFile('corrupt-1', 'inbox-decisions.json'), '{not valid json');
  } finally { server.close(); }
});

test('served dashboard: sanitized run API returns ETag and 304 without exposing raw state fields', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-api-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({
    runId: 'api-1',
    task: TASK,
    userMessages: ['API_USER_MESSAGE_SECRET'],
    modelPreset: 'gpt-5.6-sol'
  });
  engine.loop_start({ runId: 'api-1', loop: 'loop-de-loop' });
  engine.human_review_request({
    runId: 'api-1',
    item: { title: 'API_REVIEW_SECRET', summary: 'API_SUMMARY_SECRET', loopContent: 'API_LOOP_SECRET' }
  });
  const state = store.load('api-1');
  state.dashboardPath = '/Users/operator/private/dashboard.html';
  store.save(state);

  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const first = await req(port, 'GET', '/api/run?run=api-1');
    assert.equal(first.status, 200);
    assert.equal(first.json.schemaVersion, 2);
    assert.equal(first.json.run.id, 'api-1');
    assert.equal(first.json.policy.primary, 'gpt-5.6-sol');
    assert.match(first.json.reviews.items[0].decisionBindingSha256, /^[a-f0-9]{64}$/);
    const etag = first.json && first.status === 200
      ? await new Promise((resolve, reject) => {
          const r = request({ host: '127.0.0.1', port, path: '/api/run?run=api-1', method: 'GET' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.headers.etag));
          });
          r.on('error', reject);
          r.end();
        })
      : null;
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    const notModified = await req(port, 'GET', '/api/run?run=api-1', null, { 'if-none-match': etag });
    assert.equal(notModified.status, 304);
    for (const forbidden of [TASK, 'API_USER_MESSAGE_SECRET', 'API_REVIEW_SECRET', 'API_SUMMARY_SECRET', 'API_LOOP_SECRET', '/Users/operator']) {
      assert.ok(!first.text.includes(forbidden), `API must omit ${forbidden}`);
    }
    assert.equal((await req(port, 'GET', '/api/run?run=../bad')).status, 404);
    assert.equal((await req(port, 'GET', '/?run=nope')).status, 404);
  } finally { server.close(); }
});

test('served dashboard: renders a canary from state on demand without mutating persisted evidence', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-canary-')));
  const state = canaryState();
  store.save(state);
  assert.equal(store.runFileExists(state.runId, 'dashboard.html'), false);

  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const page = await req(port, 'GET', `/?run=${state.runId}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers['x-dashboard-source'], 'state');
    assert.match(page.text, /data-canary-console/);
    assert.match(page.text, /Challenger causally beat baseline/);
    assert.doesNotMatch(page.text, /super-loop-decision-token/);
    assert.equal(store.runFileExists(state.runId, 'dashboard.html'), false, 'on-demand rendering must not alter the run');

    const api = await req(port, 'GET', `/api/run?run=${state.runId}`);
    assert.equal(api.status, 200);
    assert.equal(api.json.kind, 'real-test-canary');
    assert.equal(api.json.canary.proof.pairedTargetWins, 5);
    for (const forbidden of ['PROMPT_SECRET', 'PROCEDURE_SECRET', 'ENV_SECRET', '/Users/operator', '"argv"']) {
      assert.ok(!api.text.includes(forbidden), `canary API must omit ${forbidden}`);
      assert.ok(!page.text.includes(forbidden), `canary page must omit ${forbidden}`);
    }
  } finally { server.close(); }
});

test('served dashboard: run selection is a polished, filterable operational index', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-index-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({ runId: 'campaign-index', task: TASK, modelPreset: 'gpt-5.6-sol' });
  engine.human_review_request({
    runId: 'campaign-index',
    item: { title: 'promotion candidate', kind: 'promotion', hypothesisId: 'hyp-001', evidenceRef: 'test-001' }
  });
  store.save(canaryState());

  const server = dashboardServer(store);
  const port = await listen(server);
  try {
    const page = await req(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /data-run-selector/);
    assert.match(page.text, /data-run-index/);
    assert.match(page.text, /Campaign runs/);
    assert.match(page.text, /Public snapshot index/);
    assert.match(page.text, /id="runSearch"/);
    assert.match(page.text, /campaign-index/);
    assert.match(page.text, /canary-ui-fixture/);
    assert.match(page.text, /gpt-5\.6-sol/);
    assert.match(page.text, /QUEUE_DRAINED/);
    assert.match(page.text, /data-run-proof/);
    assert.match(page.text, /5\/5 paired wins/i);
    assert.match(page.text, /Promotion disabled/i);
    assert.match(page.text, /Decision required/i);
    assert.match(page.text, /1 pending/i);
    assert.doesNotMatch(page.text, /<body style=/);
  } finally { server.close(); }
});
