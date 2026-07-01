// The SERVED dashboard makes review click-and-done: a browser POST from an Approve/
// Sludge click is queued to the run inbox, which the running campaign adopts on its
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

const TASK = 'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.';
const IMPROVED = 'PHASE ONE INTAKE\nImproved served candidate DELTA with recorded evidence.\n\nPHASE TWO MEASURE\nMeasure it on the frozen benchmark.\n\nPHASE THREE VERIFY\nReverify; the operator is the only stop.';

function req(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        let parsed = null; try { parsed = b ? JSON.parse(b) : null; } catch { /* html */ }
        resolve({ status: res.statusCode, json: parsed, text: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

test('served dashboard: a click (POST /apply) queues to the inbox → applies → adopts the improved loop', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash-')));
  const engine = createEngine(store);
  engine.initialize_loop_run({ runId: 'd1', task: TASK, userMessages: ['go'] });
  const q = engine.human_review_request({ runId: 'd1', action: 'add', item: { kind: 'loop-adoption', loopId: 'served-miner', loopContent: IMPROVED } });

  const server = buildDashboardServer(store, 0);
  const port = await listen(server);
  try {
    const r = await req(port, 'POST', '/apply', { runId: 'd1', reviewId: q.reviewId, decision: 'approve' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    // queued to the run inbox (no file handling by the operator)
    const inbox = JSON.parse(store.readRunFile('d1', 'inbox-decisions.json'));
    assert.equal(inbox.decisions[q.reviewId].decision, 'approve');
    // the campaign's drain (here: direct) adopts it
    const ap = engine.operator.applyInboxDecisions('d1');
    assert.equal(ap.applied[0].adopted.loopId, 'served-miner');
    assert.ok(store.readLoop('served-miner').content.includes('DELTA'));
    // GET serves that run's dashboard html
    engine.update_dashboard({ runId: 'd1' });
    const g = await req(port, 'GET', '/?run=d1');
    assert.equal(g.status, 200);
    assert.match(g.text, /Human review|Approve/i);
  } finally { server.close(); }
});

test('served dashboard: unknown run → 404, and a cross-origin POST is refused (CSRF guard)', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'sl-dash2-')));
  const server = buildDashboardServer(store, 0);
  const port = await listen(server);
  try {
    const r404 = await req(port, 'POST', '/apply', { runId: 'nope', reviewId: 'x', decision: 'approve' });
    assert.equal(r404.status, 404);
    const r403 = await req(port, 'POST', '/apply', { runId: 'x' }, { origin: 'http://evil.example' });
    assert.equal(r403.status, 403);
  } finally { server.close(); }
});
