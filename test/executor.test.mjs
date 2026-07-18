// Live executor (option B): the SUPERVISOR launches + captures the worker itself,
// so there is no model-supplied run-log to fabricate. Off by default; opt in with
// SUPER_LOOP_ALLOW_EXEC=1. These tests prove the MECHANISM (allowlist, no-shell /
// no-injection, capture, real-token parse, timeout, invalid-batch handling) against
// a FAKE allowlisted binary — a real frontier run is validated in an authed env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { buildArgs, isExecEnabled, execBinaryForRoute, parseTokenUsage, runWorker } from '../src/executor.mjs';
import { freshEngine, initThroughBaselineBar } from './helpers.mjs';

const H = (model, title) => ({ title, bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });

// Build a temp dir with a fake `claude` binary that echoes a deterministic run-log
// plus a usage line. Returns { dir, sentinel } and restores env via the caller.
function fakeBinDir({ sleep = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-fakebin-'));
  const sentinel = join(dir, 'INJECTED');
  const script = sleep
    ? '#!/bin/sh\nsleep 5\n'
    : `#!/bin/sh\n# echoes a deterministic run-log; never executes its prompt-file arg\nprintf '%s\\n' 'STRIP MINER RUN: discovered 3 qualified loops with contradiction sweep and clean-context replay; evidence fidelity high'\nprintf '%s\\n' '{"usage":{"total_tokens":1234}}'\nexit 0\n`;
  for (const name of ['claude', 'glm']) {
    const p = join(dir, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  return { dir, sentinel };
}

test('exec helpers: allowlist mapping + usage parsing + default-off', () => {
  assert.equal(execBinaryForRoute('claude-opus-4-8'), 'claude');
  assert.equal(execBinaryForRoute('glm-5.2'), 'glm');
  assert.equal(execBinaryForRoute('gpt-5.5'), 'codex');
  assert.equal(execBinaryForRoute('totally-unknown-model'), null);
  assert.equal(parseTokenUsage('{"usage":{"total_tokens":1234}}'), 1234);
  assert.equal(parseTokenUsage('tokens: 42'), 42);
  assert.equal(parseTokenUsage('no usage here'), null);
  assert.equal(isExecEnabled({}), false);
  assert.equal(isExecEnabled({ SUPER_LOOP_ALLOW_EXEC: '1' }), true);
  assert.deepEqual(buildArgs('codex', null, 'gpt-5.6-sol'), [
    'exec', '-m', 'gpt-5.6-sol', '--json', '--skip-git-repo-check',
    '--ephemeral', '--ignore-rules', '-s', 'read-only',
    '-c', 'suppress_unstable_features_warning=true'
  ]);
});

test('codex execution selects the requested model explicitly and returns a hashed invocation receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-fakecodex-'));
  const argvPath = join(dir, 'argv.txt');
  const stdinPath = join(dir, 'stdin.txt');
  const bin = join(dir, 'codex');
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > "$ARGV_OUT"
cat > "$STDIN_OUT"
printf '%s\\n' '{"type":"thread.started","model":"gpt-5.6-sol"}'
printf '%s\\n' '{"type":"agent_message","text":"verified output"}'
printf '%s\\n' '{"type":"token_count","input_tokens":12,"output_tokens":8}'
`);
  chmodSync(bin, 0o755);
  const prompt = 'prompt stays on stdin; $(touch SHOULD_NOT_RUN)';
  try {
    const res = runWorker({
      model: 'gpt-5.6-sol',
      prompt,
      env: {
        ...process.env,
        PATH: dir + delimiter + process.env.PATH,
        SUPER_LOOP_ALLOW_EXEC: '1',
        ARGV_OUT: argvPath,
        STDIN_OUT: stdinPath
      }
    });
    assert.equal(res.ok, true, res.message);
    assert.equal(readFileSync(stdinPath, 'utf8'), prompt);
    const argv = readFileSync(argvPath, 'utf8').trim().split('\n');
    assert.deepEqual(argv, [
      'exec', '-m', 'gpt-5.6-sol', '--json', '--skip-git-repo-check',
      '--ephemeral', '--ignore-rules', '-s', 'read-only',
      '-c', 'suppress_unstable_features_warning=true'
    ]);
    assert.ok(!argv.includes(prompt), 'prompt never reaches argv');
    assert.equal(res.invocation.requestedModel, 'gpt-5.6-sol');
    assert.equal(res.invocation.reportedModel, 'gpt-5.6-sol');
    assert.equal(res.invocation.reportedModelMatchesRequest, true);
    assert.equal(res.invocation.modelSelectionAuthority, 'explicit-model-flag');
    assert.equal(res.invocation.tokenUsage, 20);
    assert.match(res.invocation.stdoutSha256, /^[a-f0-9]{64}$/);
    assert.match(res.invocation.resultSha256, /^[a-f0-9]{64}$/);
    assert.equal('prompt' in res.invocation, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTokenUsage reads the FINAL usage + sums cache tokens (claude single result envelope)', () => {
  const out = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'the answer',
    usage: { input_tokens: 5, cache_creation_input_tokens: 4600, cache_read_input_tokens: 0, output_tokens: 300 }
  });
  assert.equal(parseTokenUsage(out), 4905);
});

test('parseTokenUsage regression: a leading cached-system usage no longer makes different calls report the SAME number', () => {
  const stream = (resultUsage) => JSON.stringify([
    { type: 'system', subtype: 'init', usage: { input_tokens: 4607, output_tokens: 0 } },
    { type: 'assistant', message: { usage: { input_tokens: 4607, output_tokens: 100 } } },
    { type: 'result', usage: resultUsage }
  ]);
  const challenger = parseTokenUsage(stream({ input_tokens: 5, cache_creation_input_tokens: 4600, output_tokens: 4000 }));
  const judge = parseTokenUsage(stream({ input_tokens: 5, cache_read_input_tokens: 4600, output_tokens: 200 }));
  assert.equal(challenger, 8605);
  assert.equal(judge, 4805);
  assert.notEqual(challenger, judge);
  assert.notEqual(challenger, 4607);
  assert.notEqual(judge, 4607);
});

test('parseTokenUsage reads the last codex token_count line (JSON Lines)', () => {
  const jsonl = [
    JSON.stringify({ type: 'agent_message', text: 'hello' }),
    JSON.stringify({ type: 'token_count', input_tokens: 120, output_tokens: 80 })
  ].join('\n');
  assert.equal(parseTokenUsage(jsonl), 200);
});

test('execute_full_test is OFF by default (EXEC_DISABLED) — preserves the no-exec posture', () => {
  delete process.env.SUPER_LOOP_ALLOW_EXEC;
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'x0');
  const reg = engine.register_hypotheses({ runId: 'x0', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
  const r = engine.execute_full_test({ runId: 'x0', hypothesisId: reg.hypothesisIds[0], routes: ['claude-opus-4-8', 'claude-opus-4-8', 'claude-opus-4-8'], prompt: 'run the loop' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'EXEC_DISABLED');
});

test('with opt-in, the SUPERVISOR launches a fake worker, captures output, and gates on it', () => {
  const { dir } = fakeBinDir();
  const origPath = process.env.PATH;
  process.env.PATH = dir + delimiter + origPath;
  process.env.SUPER_LOOP_ALLOW_EXEC = '1';
  try {
    const { engine } = freshEngine();
    initThroughBaselineBar(engine, 'x1');
    const reg = engine.register_hypotheses({ runId: 'x1', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
    const r = engine.execute_full_test({ runId: 'x1', hypothesisId: reg.hypothesisIds[0], routes: ['claude-opus-4-8', 'glm-5.2', 'claude-opus-4-8'], prompt: 'run the strip miner loop' });
    assert.equal(r.status, 'OK', r.message);
    assert.equal(r.executed, true);
    assert.equal(r.executor.workers.length, 3);
    // the supervisor captured the worker output and parsed REAL token usage from it
    assert.equal(r.executor.workers[0].realTokenUsage, 1234);
    assert.ok(r.executor.workers[0].bytes > 0, 'captured non-empty output');
    // it flowed through the same gate → a real verdict, not a self-report
    assert.ok(['MOVED_FRONTIER', 'NO_IMPROVEMENT'].includes(r.verdict));
    assert.ok(r.testId, 'produced a real measured test');
  } finally {
    process.env.PATH = origPath;
    delete process.env.SUPER_LOOP_ALLOW_EXEC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no shell / no command injection: a prompt with shell metacharacters is inert data', () => {
  const { dir, sentinel } = fakeBinDir();
  const origPath = process.env.PATH;
  process.env.PATH = dir + delimiter + origPath;
  process.env.SUPER_LOOP_ALLOW_EXEC = '1';
  try {
    // execFile (no shell) + prompt-in-file → these metachars can never run a command
    const evil = `hi; touch ${sentinel}; $(touch ${sentinel}) \`touch ${sentinel}\``;
    const res = runWorker({ model: 'claude-opus-4-8', prompt: evil });
    assert.equal(res.ok, true);
    assert.equal(existsSync(sentinel), false, 'shell metacharacters in the prompt must NOT execute anything');
  } finally {
    process.env.PATH = origPath;
    delete process.env.SUPER_LOOP_ALLOW_EXEC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-allowlisted route never executes', () => {
  process.env.SUPER_LOOP_ALLOW_EXEC = '1';
  try {
    const res = runWorker({ model: 'totally-unknown-model', prompt: 'x' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'NOT_ALLOWLISTED');
  } finally {
    delete process.env.SUPER_LOOP_ALLOW_EXEC;
  }
});

test('a worker timeout is killed and reported (invalid batch, does not count)', () => {
  const { dir } = fakeBinDir({ sleep: true });
  const origPath = process.env.PATH;
  process.env.PATH = dir + delimiter + origPath;
  process.env.SUPER_LOOP_ALLOW_EXEC = '1';
  try {
    const res = runWorker({ model: 'claude-opus-4-8', prompt: 'x', timeoutMs: 250 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'TIMEOUT');
    assert.equal(res.timedOut, true);
  } finally {
    process.env.PATH = origPath;
    delete process.env.SUPER_LOOP_ALLOW_EXEC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed launch is an INVALID batch that does not reach the retirement counter', () => {
  // exec enabled but the binary is absent on a scrubbed PATH → BINARY_MISSING → EXEC_FAILED
  const origPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'superloop-empty-')); // no claude/glm here
  process.env.SUPER_LOOP_ALLOW_EXEC = '1';
  try {
    const { engine, store } = freshEngine();
    initThroughBaselineBar(engine, 'x2');
    const reg = engine.register_hypotheses({ runId: 'x2', hypotheses: [H('claude-opus-4-8', 'a'), H('gpt-5.5', 'b'), H('glm-5.2', 'c')] });
    const r = engine.execute_full_test({ runId: 'x2', hypothesisId: reg.hypothesisIds[0], routes: ['claude-opus-4-8', 'claude-opus-4-8', 'claude-opus-4-8'], prompt: 'run' });
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.code, 'EXEC_FAILED');
    assert.equal(r.countedTowardRetirement, false);
    // no test was recorded, so the failure counter never moved
    assert.equal(store.load('x2').failures.consecutive, 0);
  } finally {
    process.env.PATH = origPath;
    delete process.env.SUPER_LOOP_ALLOW_EXEC;
  }
});
