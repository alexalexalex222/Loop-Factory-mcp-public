// Step 9: host_runtime_detect — advisory host guess from which MCP config files
// exist on disk. READ-ONLY (existence check only): never reads file contents, never
// mutates config. SUPER_LOOP_HOST is authoritative when set. All tests use injected
// fixture paths + a fake fileExists — no real home directory is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHostRuntime } from '../src/host.mjs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

const HOME = '/fake/home';
// fileExists factory over a fixed set of "present" absolute paths.
const existsOf = (present) => (p) => present.includes(p);

test('a single matching config yields a confident guess (no env override)', () => {
  const r = detectHostRuntime({
    env: {}, home: HOME,
    fileExists: existsOf([`${HOME}/.claude.json`])
  });
  assert.equal(r.guess, 'claude-code');
  assert.equal(r.explicitHost, null);
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0].evidence, [`${HOME}/.claude.json`]);
  assert.match(r.method, /read-only|no mutation/i);
});

test('multiple matching configs are ambiguous (no guess) until SUPER_LOOP_HOST is set', () => {
  const present = [`${HOME}/.claude.json`, `${HOME}/.codex/config.toml`];
  const ambiguous = detectHostRuntime({ env: {}, home: HOME, fileExists: existsOf(present) });
  assert.equal(ambiguous.guess, null, 'two candidates → no single guess');
  assert.equal(ambiguous.candidates.length, 2);
  const disamb = detectHostRuntime({ env: { SUPER_LOOP_HOST: 'codex' }, home: HOME, fileExists: existsOf(present) });
  assert.equal(disamb.explicitHost, 'codex');
  assert.equal(disamb.guess, 'codex', 'SUPER_LOOP_HOST wins');
});

test('no config found → no guess, just the CLI fallback advice', () => {
  const r = detectHostRuntime({ env: {}, home: HOME, fileExists: () => false });
  assert.equal(r.guess, null);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.cliFallback, 'super-loop-run');
});

test('SUPER_LOOP_HOST is authoritative even with no config file on disk', () => {
  const r = detectHostRuntime({ env: { SUPER_LOOP_HOST: 'claude' }, home: HOME, fileExists: () => false });
  assert.equal(r.explicitHost, 'claude-code');
  assert.equal(r.guess, 'claude-code');
});

test('the tool surfaces the guess and an honest read-only advisory; rejects a path-like runId', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'HD1', task: SPECIFIC_TASK });
  const r = engine.host_runtime_detect({ runId: 'HD1' });
  assert.equal(r.status, 'OK');
  assert.ok('guess' in r && Array.isArray(r.candidates));
  assert.match(r.advisory, /advisory only|never auto-applied/i);
  const bad = engine.host_runtime_detect({ runId: '../escape' });
  assert.equal(bad.status, 'BLOCKED');
  assert.equal(bad.code, 'BAD_INPUT');
});
