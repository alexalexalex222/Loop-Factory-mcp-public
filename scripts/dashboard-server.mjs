#!/usr/bin/env node
// Zero-dep SERVED dashboard for click-and-done operator review.
//
// Open it in a browser and just click Approve / Sludge — no files, no commands. Each
// click POSTs to /apply, which MERGES the decision into that run's inbox
// (runs/<runId>/inbox-decisions.json). The running campaign's per-tick drain then
// adopts it (operator-driven, model-independent, non-blocking). The model can never
// reach this surface; only you click.
//
//   node scripts/dashboard-server.mjs [--port 8787] [--home <dir>]
//
// Binds to 127.0.0.1 only (never the network). A cross-origin POST is rejected, so a
// random web page cannot drive your reviews; only the served dashboard itself can.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createStore } from '../src/store.mjs';

function flag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = flag('--home', process.env.SUPER_LOOP_HOME || join(PKG_ROOT, '.super-loop'));
const port = Number(flag('--port', process.env.SUPER_LOOP_DASHBOARD_PORT || '8787'));
const store = createStore(home);

const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

export function buildDashboardServer(theStore = store, thePort = port) {
  // Only same-origin (the served dashboard) may POST. A browser attaches Origin on
  // cross-origin requests; we allow a missing Origin (curl/our own page) or one that
  // matches THIS server's port, and reject anything else — a basic CSRF guard for a
  // local tool so a random web page cannot drive your reviews.
  const originOk = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://127.0.0.1:${thePort}` || o === `http://localhost:${thePort}`;
  };
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'POST' && u.pathname === '/apply') {
      if (!originOk(req)) return json(res, 403, { ok: false, error: 'cross-origin POST refused' });
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(buf || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
        const runId = String(body.runId || '');
        if (!runId || !theStore.exists(runId)) return json(res, 404, { ok: false, error: 'unknown run' });
        // merge into the existing inbox so multiple clicks accumulate before the next drain
        const inbox = { runId, decisions: {} };
        const cur = theStore.readRunFile(runId, 'inbox-decisions.json');
        if (cur) { try { const p = JSON.parse(cur); if (p && p.decisions) inbox.decisions = p.decisions; } catch { /* overwrite a corrupt inbox */ } }
        if (body.decisions && typeof body.decisions === 'object') Object.assign(inbox.decisions, body.decisions);
        else if (body.reviewId && body.decision) inbox.decisions[String(body.reviewId)] = { decision: String(body.decision), notes: body.notes || null };
        else return json(res, 400, { ok: false, error: 'need { reviewId, decision } or { decisions }' });
        theStore.writeRunFile(runId, 'inbox-decisions.json', JSON.stringify(inbox, null, 2));
        return json(res, 200, { ok: true, queued: Object.keys(inbox.decisions).length, note: 'queued to the run inbox; the running supervisor adopts it on its next tick' });
      });
      return;
    }

    if (req.method === 'GET') {
      const run = u.searchParams.get('run');
      if (run && theStore.exists(run)) {
        const html = theStore.readRunFile(run, 'dashboard.html');
        if (html) return send(res, 200, 'text/html; charset=utf-8', html);
        return send(res, 404, 'text/plain', `no dashboard yet for ${run}`);
      }
      const runs = theStore.listRuns();
      const links = runs.map((r) => `<li><a href="/?run=${encodeURIComponent(r)}">${r}</a></li>`).join('');
      return send(res, 200, 'text/html; charset=utf-8',
        `<!doctype html><meta charset="utf-8"><title>super-loop runs</title><body style="font-family:system-ui;background:#0b0c0e;color:#ece9e2;padding:40px"><h1>super-loop · runs</h1><ul>${links || '<li>no runs yet</li>'}</ul>`);
    }
    send(res, 404, 'text/plain', 'not found');
  });
}

// Run standalone (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('dashboard-server.mjs')) {
  buildDashboardServer().listen(port, '127.0.0.1', () => {
    console.log(`super-loop dashboard → http://127.0.0.1:${port}  (home: ${home})`);
    console.log('Open it, click Approve/Sludge — the running campaign adopts your choice on its next tick. No files, no commands.');
  });
}
