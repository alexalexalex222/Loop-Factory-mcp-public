// Step 8: the shipped example campaigns validate against the engine's real schema
// (benchmark_propose is the actual validator the supervisor uses), and the per-host
// MCP snippets are valid JSON pointing at the server entry. Keeps the docs honest —
// a broken example fails the suite, not the operator at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

const EX = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const safeId = (file) => `ex-${file.replace(/[^a-z0-9]+/gi, '-')}`;

for (const file of ['campaign.json', 'campaign-improve-only.json']) {
  test(`examples/${file} validates (structure + engine benchmark schema)`, () => {
    const cfg = loadJson(join(EX, file));
    assert.equal(typeof cfg.task, 'string');
    assert.ok(Array.isArray(cfg.routes) && cfg.routes.length >= 1);
    assert.ok(Array.isArray(cfg.targets) && cfg.targets.length >= 1);
    for (const t of cfg.targets) assert.ok(['mine', 'improve'].includes(t.kind), `valid target kind: ${t.kind}`);
    // oracle must be the object form ({mustInclude,...}), NOT the invalid string form
    assert.equal(typeof cfg.benchmark.oracle, 'object');
    assert.ok(Array.isArray(cfg.benchmark.oracle.mustInclude));
    // feed the benchmark through the engine's real validator
    const { engine } = freshEngine();
    const runId = safeId(file);
    engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
    const prop = engine.benchmark_propose({ runId, benchmarks: [cfg.benchmark] });
    assert.equal(prop.status, 'OK', `benchmark accepted: ${JSON.stringify(prop)}`);
    assert.ok(Array.isArray(prop.benchmarkIds) && prop.benchmarkIds.length === 1);
  });
}

test('campaign-improve-only has only an improve target and does not re-mine', () => {
  const cfg = loadJson(join(EX, 'campaign-improve-only.json'));
  assert.ok(cfg.targets.every((t) => t.kind === 'improve'));
  assert.equal(cfg.remineOnEmpty, false);
});

test('every examples/mcp/*.json is valid JSON, points at the server, and sets the host', () => {
  const dir = join(EX, 'mcp');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 4, `>=4 mcp snippets, got ${files.length}`);
  for (const f of files) {
    const blob = JSON.stringify(loadJson(join(dir, f)));
    assert.match(blob, /src\/server\.mjs/, `${f} references the server entry`);
    assert.match(blob, /SUPER_LOOP_HOST/, `${f} sets SUPER_LOOP_HOST`);
  }
});
