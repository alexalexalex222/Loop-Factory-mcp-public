// Live executor (option B): the SUPERVISOR launches + captures the worker itself,
// so there is no model-supplied run-log to fabricate. Off by default; opt in with
// SUPER_LOOP_ALLOW_EXEC=1. These tests prove the MECHANISM (allowlist, no-shell /
// no-injection, capture, real-token parse, timeout, invalid-batch handling) against
// a FAKE allowlisted binary — a real frontier run is validated in an authed env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  STRICT_CODEX_DISABLED_FEATURES, STRICT_CODEX_REASONING_EFFORT,
  buildArgs, buildExecutorPrompt, execBinaryForRoute, inspectWorkerIsolation, isExecEnabled,
  executorWorker, normalizeStructuredWorkerOutput, parseTokenUsage, parseTokenUsageDetails,
  resolveWorkerBinary, runWorker, schemaPathForContract
} from '../src/executor.mjs';
import { sha256 } from '../src/util.mjs';
import { freshEngine, initThroughBaselineBar } from './helpers.mjs';
import { createFakeCli } from './fixtures/fake-cli.mjs';

const H = (model, title) => ({ title, bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model } });

// Build a temp dir with a fake `claude` binary that echoes a deterministic run-log
// plus a usage line. Returns { dir, sentinel } and restores env via the caller.
function fakeBinDir({ sleep = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop factory fake bin & '));
  const sentinel = join(dir, 'INJECTED');
  const stdout = 'STRIP MINER RUN: discovered 3 qualified loops with contradiction sweep and clean-context replay; evidence fidelity high\n{"usage":{"total_tokens":1234}}\n';
  for (const name of ['claude', 'glm']) {
    createFakeCli(dir, name, sleep ? { delayMs: 5000 } : { stdout });
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
  createFakeCli(dir, 'codex', {
    captureArgvEnv: 'ARGV_OUT',
    captureStdinEnv: 'STDIN_OUT',
    stdout: [
      '{"type":"thread.started","thread_id":"thread-real-shape"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"verified output"}}',
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":0,"output_tokens":8,"reasoning_output_tokens":0}}'
    ].join('\n') + '\n'
  });
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
    assert.equal(res.invocation.reportedModel, null);
    assert.equal(res.invocation.reportedModelMatchesRequest, null);
    assert.equal(res.invocation.modelSelectionAuthority, 'explicit-model-flag');
    assert.equal(res.invocation.modelIdentityAuthority, 'explicit-model-flag');
    assert.equal(res.invocation.tokenUsage, 20);
    assert.match(res.invocation.stdoutSha256, /^[a-f0-9]{64}$/);
    assert.match(res.invocation.resultSha256, /^[a-f0-9]{64}$/);
    assert.equal('prompt' in res.invocation, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed Codex launch preserves supervisor-owned stderr and invocation hashes without becoming valid output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-failed-codex-'));
  const bin = createFakeCli(dir, 'codex', {
    stdout: '{"type":"thread.started","thread_id":"thread-failed-real-shape"}\n',
    stderr: 'deterministic OAuth transport failure\n',
    exitCode: 17
  });
  const env = {
    ...process.env,
    SUPER_LOOP_ALLOW_EXEC: '1',
    SUPER_LOOP_CODEX_BIN: bin
  };
  try {
    const result = runWorker({
      model: 'gpt-5.6-sol',
      prompt: 'x',
      env
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'EXEC_FAILED');
    assert.equal(result.exitCode, 17);
    assert.match(result.stdout, /thread\.started/);
    assert.equal(result.stderr, 'deterministic OAuth transport failure\n');
    assert.equal(result.invocation.reportedModel, null);
    assert.equal(result.invocation.reportedModelMatchesRequest, null);
    assert.equal(result.invocation.modelIdentityAuthority, 'explicit-model-flag');
    assert.equal(result.invocation.stdoutSha256, sha256(result.stdout));
    assert.equal(result.invocation.stderrSha256, sha256(result.stderr));

    const packet = executorWorker({
      route: 'gpt-5.6-sol',
      phase: 1,
      kind: 'proposal',
      toolPolicy: 'none',
      slice: 'Produce one proposal.',
      target: {
        findingId: 'finding-001',
        baselineSha256: 'a'.repeat(64),
        baselineContent: '## Purpose\nBaseline procedure.',
        evidenceRefs: []
      },
      hypothesis: {
        id: 'finding-001-canary-h1',
        title: 'Preserve launch evidence',
        bottleneck: 'Failed launches discard diagnostics.',
        operation: 'Persist stderr and its hash.',
        expectedMovement: 'The blocked run remains independently diagnosable.'
      },
      frozenCases: []
    }, env);
    assert.equal(packet.__execReason, 'EXEC_FAILED');
    assert.equal(packet.phase, 1);
    assert.equal(packet.executorOwned, true);
    assert.equal(packet.rawStderr, result.stderr);
    assert.equal(packet.invocation.stderrSha256, sha256(packet.rawStderr));
    assert.match(packet.artifacts[0].content, /STDERR\ndeterministic OAuth transport failure/);
    assert.equal(packet.finalOutput, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict Codex argv disables tool surfaces, ignores ambient config, and binds a JSON schema + capsule cwd', () => {
  const schemaPath = schemaPathForContract({ kind: 'evaluation' });
  const args = buildArgs('codex', null, 'gpt-5.6-sol', {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: '/tmp/loop-factory-capsule'
  });
  const reasoningConfigIndex = args.indexOf('model_reasoning_effort="high"');
  assert.equal(STRICT_CODEX_REASONING_EFFORT, 'high');
  assert.equal(args[reasoningConfigIndex - 1], '-c');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes(schemaPath));
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '--disable'),
    [...STRICT_CODEX_DISABLED_FEATURES]
  );
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', '/tmp/loop-factory-capsule']);
});

test('schema-constrained JSON is normalized into the existing supervisor wrapper and remains hashable', () => {
  const payload = {
    arm: 'challenger',
    findingId: 'finding-001',
    hypothesisId: 'finding-001-h1',
    baselineSha256: 'a'.repeat(64),
    procedureSha256: 'b'.repeat(64),
    caseResults: [{
      caseId: 'case-1',
      disposition: 'BLOCKED',
      code: 'CASE_OK',
      evidencePaths: ['fixture/case-1.json']
    }]
  };
  assert.equal(
    normalizeStructuredWorkerOutput({ kind: 'evaluation' }, JSON.stringify(payload)),
    `<EVALUATION>${JSON.stringify(payload)}</EVALUATION>`
  );
  assert.equal(normalizeStructuredWorkerOutput({ kind: 'evaluation' }, 'not json'), null);
  const challenger = {
    findingId: 'finding-001',
    hypothesisId: 'finding-001-h1',
    baselineSha256: 'a'.repeat(64),
    revisedContent: '## Purpose\n' + 'substantial revision '.repeat(20),
    changeSummary: 'Apply the assigned evidence-bound challenger operation.',
    caseResults: payload.caseResults
  };
  assert.ok(schemaPathForContract({ kind: 'challenger' }).endsWith('challenger-output.schema.json'));
  assert.equal(
    normalizeStructuredWorkerOutput({}, JSON.stringify(challenger)),
    `<IMPROVEMENT>${JSON.stringify(challenger)}</IMPROVEMENT>`
  );
});

test('strict evaluation prompt requires canonical decision words', () => {
  const prompt = buildExecutorPrompt({
    kind: 'evaluation',
    evaluationArm: 'challenger',
    outputSchemaMode: true,
    target: {
      findingId: 'finding-001',
      baselineSha256: 'a'.repeat(64),
      baselineContent: '## Baseline\n\nApply the original procedure.'
    },
    hypothesis: { id: 'finding-001-h1' },
    procedureSha256: 'b'.repeat(64),
    frozenCases: [{ id: 'case-1', prompt: 'Evaluate the case.' }]
  });
  assert.match(prompt, /"disposition":"ACCEPTED or REJECTED only"/);
});

test('explicit Codex binary override is absolute, basename-locked, and used without widening execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-codex-override-'));
  const bin = createFakeCli(dir, 'codex', {
    stdout: '{"type":"agent_message","text":"override output"}\n'
  });
  try {
    assert.equal(resolveWorkerBinary('gpt-5.6-sol', { SUPER_LOOP_CODEX_BIN: 'relative/codex' }).reason, 'BINARY_OVERRIDE_INVALID');
    assert.equal(resolveWorkerBinary('gpt-5.6-sol', { SUPER_LOOP_CODEX_BIN: join(dir, 'not-codex') }).reason, 'BINARY_OVERRIDE_INVALID');
    const resolved = resolveWorkerBinary('gpt-5.6-sol', { SUPER_LOOP_CODEX_BIN: bin });
    assert.equal(resolved.bin, 'codex');
    assert.equal(resolved.binPath, bin);
    const result = runWorker({
      model: 'gpt-5.6-sol',
      prompt: 'x',
      env: {
        SUPER_LOOP_ALLOW_EXEC: '1',
        SUPER_LOOP_CODEX_BIN: bin,
        PATH: ''
      }
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.resultText, 'override output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawned workers never inherit operator authority or real-test approval values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superloop-worker-env-'));
  const bin = createFakeCli(dir, 'codex', { authorityEcho: true });
  try {
    const result = runWorker({
      model: 'gpt-5.6-sol',
      prompt: 'x',
      env: {
        SUPER_LOOP_ALLOW_EXEC: '1',
        SUPER_LOOP_CODEX_BIN: bin,
        SUPER_LOOP_OPERATOR_AUTHORITY: 'operator-secret',
        SUPER_LOOP_REAL_TEST_APPROVAL: 'plan-secret',
        PATH: ''
      }
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.resultText, 'clean:clean');
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
  assert.deepEqual(parseTokenUsageDetails(jsonl), {
    inputTokens: 120,
    outputTokens: 80,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 200
  });
});

test('strict isolation audit rejects tool events and accepts a tool-free transcript', () => {
  const clean = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-isolation-real-shape' }),
    JSON.stringify({ type: 'agent_message', text: 'final answer' }),
    JSON.stringify({ type: 'token_count', input_tokens: 10, output_tokens: 5 })
  ].join('\n');
  assert.equal(inspectWorkerIsolation(clean).status, 'PASS');
  const contaminated = `${clean}\n${JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'sed -n 1,20p src/measure.mjs' }
  })}`;
  const result = inspectWorkerIsolation(contaminated);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.toolCalls[0].type, 'command_execution');
});

test('strict isolation fails on hook, plugin, or installed-skill context diagnostics', () => {
  const hook = inspectWorkerIsolation(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'error',
      message: 'failed to parse hooks config /Users/example/.codex/hooks.json'
    }
  }));
  assert.equal(hook.status, 'FAIL');
  assert.ok(hook.reasons.includes('WORKER_HOOK_CONTEXT'));

  const skills = inspectWorkerIsolation(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'error',
      message: 'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill.'
    }
  }));
  assert.equal(skills.status, 'FAIL');
  assert.ok(skills.reasons.includes('WORKER_SKILL_CONTEXT'));

  const plugins = inspectWorkerIsolation(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'error',
      message: 'Plugin catalog loaded into worker context.'
    }
  }));
  assert.equal(plugins.status, 'FAIL');
  assert.ok(plugins.reasons.includes('WORKER_PLUGIN_CONTEXT'));
});

test('strict isolation fails closed on a malformed nonempty transcript line', () => {
  const result = inspectWorkerIsolation('not-json\n');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.malformedLines, 1);
  assert.deepEqual(result.reasons, ['WORKER_TRANSCRIPT_UNPARSEABLE']);
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

test('allowlisted model argv metacharacters stay inert and never become a command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop factory argv & '));
  const sentinel = join(dir, 'MODEL_ARG_INJECTED');
  const bin = createFakeCli(dir, 'codex', {
    stdout: '{"type":"agent_message","text":"argv remained data"}\n'
  });
  try {
    const model = `gpt-5.6-sol & echo pwned > ${sentinel}`;
    const result = runWorker({
      model,
      prompt: 'prompt remains stdin',
      env: { ...process.env, SUPER_LOOP_ALLOW_EXEC: '1', SUPER_LOOP_CODEX_BIN: bin }
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(existsSync(sentinel), false);
    assert.equal(result.invocation.processAdapter, process.platform === 'win32' ? 'windows-command-shim' : 'native-exec-file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows command shims refuse percent expansion in model argv', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-percent-expansion-'));
  const bin = createFakeCli(dir, 'codex', {
    stdout: '{"type":"agent_message","text":"must not launch"}\n'
  });
  try {
    const result = runWorker({
      model: 'gpt-5.6-sol%CMDCMDLINE%',
      prompt: 'prompt remains stdin',
      env: { ...process.env, SUPER_LOOP_ALLOW_EXEC: '1', SUPER_LOOP_CODEX_BIN: bin }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'EXEC_ADAPTER_REFUSED');
    assert.match(result.message, /environment expansion syntax/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large fake-worker output remains bounded by the executor buffer and hash-receipted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-large-output-'));
  const output = 'x'.repeat(256 * 1024);
  const bin = createFakeCli(dir, 'codex', { stdout: output });
  try {
    const result = runWorker({
      model: 'gpt-5.6-sol', prompt: 'x',
      env: { ...process.env, SUPER_LOOP_ALLOW_EXEC: '1', SUPER_LOOP_CODEX_BIN: bin }
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.stdout.length, output.length);
    assert.equal(result.invocation.stdoutSha256, sha256(output));
  } finally {
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

test('a timed-out Windows command shim kills its complete descendant process tree', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-timeout-tree-'));
  const sentinel = join(dir, 'DESCENDANT_SURVIVED');
  const bin = createFakeCli(dir, 'codex', {
    delayMs: 5000,
    spawnDescendantEnv: 'LOOP_FACTORY_TEST_DESCENDANT',
    descendantDelayMs: 1200
  });
  try {
    const result = runWorker({
      model: 'gpt-5.6-sol',
      prompt: 'timeout tree proof',
      timeoutMs: 300,
      env: {
        ...process.env,
        SUPER_LOOP_ALLOW_EXEC: '1',
        SUPER_LOOP_CODEX_BIN: bin,
        LOOP_FACTORY_TEST_DESCENDANT: sentinel
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'TIMEOUT');
    assert.equal(result.timedOut, true);
    assert.equal(result.invocation.timeoutCleanup, 'windows-taskkill-process-tree-before-return');
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(existsSync(sentinel), false, 'timed-out descendant must not survive to write its sentinel');
  } finally {
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
