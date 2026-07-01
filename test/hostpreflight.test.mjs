// Leak #7: host capability preflight. A LOCAL report of which known frontier-agent
// CLIs are installed on PATH — filesystem stat only, never executing a command and
// never probing a model-supplied binary name. Presence on PATH is reported as
// presence on PATH, not as proof of working auth and not as SOTA/web research.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectHostCapabilities, KNOWN_ROUTE_CLIS } from '../src/host.mjs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

test('detects a known CLI placed on an injected PATH, and misses an absent one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-bin-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\necho hi\n');
  chmodSync(bin, 0o755);
  const report = detectHostCapabilities({ env: { PATH: dir }, platform: 'linux' });
  const claude = report.routes.find((r) => r.name === 'claude');
  const codex = report.routes.find((r) => r.name === 'codex');
  assert.equal(claude.installed, true);
  assert.equal(claude.path, bin);
  assert.equal(codex.installed, false);
  assert.equal(codex.path, null);
  assert.equal(report.installed.includes('claude'), true);
});

test('the allowlist is fixed — exactly the known frontier CLIs, nothing model-supplied', () => {
  const report = detectHostCapabilities({ env: { PATH: '' }, platform: 'linux' });
  assert.deepEqual(report.routes.map((r) => r.name), KNOWN_ROUTE_CLIS.map((c) => c.name));
  assert.match(report.method, /no command executed/i);
  assert.match(report.boundary, /not.*auth|not.*research/i);
});

test('the tool surfaces the report and the honest boundary', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'HP1', task: SPECIFIC_TASK });
  const r = engine.host_capability_preflight({ runId: 'HP1' });
  assert.equal(r.status, 'OK');
  assert.ok(Array.isArray(r.routes) && r.routes.some((x) => x.name === 'claude'));
  assert.match(r.method, /filesystem stat only/i);
  assert.match(r.advisory, /not.*SOTA|not.*research/i);
});

test('preflight works without a run (library-level) and rejects a path-like runId', () => {
  const { engine } = freshEngine();
  const ok = engine.host_capability_preflight({});
  assert.equal(ok.status, 'OK');
  const bad = engine.host_capability_preflight({ runId: '../escape' });
  assert.equal(bad.status, 'BLOCKED');
  assert.equal(bad.code, 'BAD_INPUT');
});

// ---- Step 4: preflight also returns the host profile + tier ---------------

function withHost(host, fn) {
  const prev = process.env.SUPER_LOOP_HOST;
  if (host == null) delete process.env.SUPER_LOOP_HOST;
  else process.env.SUPER_LOOP_HOST = host;
  try { return fn(); }
  finally {
    if (prev == null) delete process.env.SUPER_LOOP_HOST;
    else process.env.SUPER_LOOP_HOST = prev;
  }
}

test('preflight stays backward compatible: routes / installed / method survive', () => {
  const { engine } = freshEngine();
  const r = engine.host_capability_preflight({});
  assert.ok(Array.isArray(r.routes), 'old field routes preserved');
  assert.ok(Array.isArray(r.installed), 'old field installed preserved');
  assert.match(r.method, /filesystem stat only/i, 'old field method preserved');
  assert.match(r.advisory, /not.*SOTA|not.*research/i, 'old advisory preserved');
});

test('preflight returns the host profile + tier + driverFamily for a known host', () => {
  withHost('claude', () => {
    const { engine } = freshEngine();
    const r = engine.host_capability_preflight({});
    assert.equal(r.status, 'OK');
    assert.equal(r.hostProfile.id, 'claude-code');
    assert.equal(r.tier, 1);
    assert.equal(r.driverFamily, 'goal_progress');
    assert.equal(r.hostProfile.primaryDriver.command, '/goal');
    assert.match(r.setupHint, /\/goal/);
    // workerRoutes mirrors the worker-CLI report, distinct from the host profile
    assert.ok(Array.isArray(r.workerRoutes) && r.workerRoutes.some((x) => x.name === 'claude'));
    assert.equal(r.hostMatrix, undefined, 'no matrix needed for a known host');
  });
});

test('preflight surfaces the host matrix + CLI fallback when the host is unknown', () => {
  withHost(null, () => {
    const { engine } = freshEngine();
    const r = engine.host_capability_preflight({});
    assert.equal(r.hostProfile.id, 'unknown');
    assert.equal(r.tier, null);
    assert.ok(Array.isArray(r.hostMatrix) && r.hostMatrix.length >= 10, 'matrix shown for unknown host');
    assert.match(r.setupHint, /SUPER_LOOP_HOST|super-loop-run/);
    assert.equal(r.hostProfile.cliFallback, 'super-loop-run');
  });
});

test('preflight maps a non-goal host to its tier + driver family', () => {
  withHost('cursor', () => {
    const { engine } = freshEngine();
    const r = engine.host_capability_preflight({});
    assert.equal(r.hostProfile.id, 'cursor');
    assert.equal(r.tier, 2);
    assert.equal(r.driverFamily, 'mcp_reactive');
    assert.equal(r.hostProfile.primaryDriver.command, null);
    assert.match(r.setupHint, /continuation-rules|super-loop-run/i);
  });
});
