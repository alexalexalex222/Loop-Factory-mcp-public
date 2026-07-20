import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`condition not met within ${timeoutMs}ms`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`campaign process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('standalone CLI idles after one fake Codex mine and exits through the real stop-file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-factory-cli-idle-'));
  const fakeBin = join(root, 'codex');
  const countFile = join(root, 'worker-count.txt');
  const configPath = join(root, 'campaign.json');
  const home = join(root, 'state');
  const stopFile = join(root, 'STOP');
  const runId = 'cli-idle-smoke';
  const exactModelPolicy = {
    version: 1,
    source: 'operator-init',
    primary: 'gpt-5.6-sol',
    testRoutes: ['gpt-5.6-sol'],
    builderRoutes: ['gpt-5.6-sol'],
    judgeRoute: 'gpt-5.6-sol',
    banlist: { mode: 'strict', extraDeny: [], extraAllow: [] },
    allowUnknownFrontier: false
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(fakeBin, `#!/bin/sh
count=0
if [ -f "$CALL_COUNT_FILE" ]; then count="$(cat "$CALL_COUNT_FILE")"; fi
count=$((count + 1))
printf '%s' "$count" > "$CALL_COUNT_FILE"
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-cli-idle-real-shape"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"<CANDIDATES>[]</CANDIDATES>"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'
`);
  chmodSync(fakeBin, 0o755);
  writeFileSync(configPath, JSON.stringify({
    task: 'Mine the configured corpus for novel evidence-backed loop candidates.',
    model: 'gpt-5.6-sol',
    routes: ['gpt-5.6-sol'],
    modelPolicy: exactModelPolicy,
    remineOnEmpty: true,
    idlePollMs: 250,
    targets: [{ kind: 'mine', routes: ['gpt-5.6-sol'] }]
  }, null, 2));

  const child = spawn(process.execPath, [
    'scripts/run-campaign.mjs',
    '--config', configPath,
    '--run-id', runId,
    '--home', home,
    '--stop-file', stopFile,
    '--no-dashboard'
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SUPER_LOOP_ALLOW_EXEC: '1',
      SUPER_LOOP_CODEX_BIN: fakeBin,
      CALL_COUNT_FILE: countFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitFor(() => output.includes('campaign_idle'));
    assert.equal(readFileSync(countFile, 'utf8'), '1');
    assert.equal(child.exitCode, null, 'the scheduler remains alive while idle');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(readFileSync(countFile, 'utf8'), '1', 'idle polling made no second worker call');

    writeFileSync(stopFile, '');
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, output);
    assert.match(output, /stoppedBy: operator-stop/);
    assert.match(output, /idle policy: zero inference/);
    assert.equal(existsSync(join(home, 'runs', runId, 'state.json')), true);
    const state = JSON.parse(readFileSync(join(home, 'runs', runId, 'state.json'), 'utf8'));
    const workerEvents = (state.supervisionEvents || []).filter((event) => event.type === 'worker_verdict');
    const idleEvents = (state.supervisionEvents || []).filter((event) => event.code === 'IDLE_NO_NEW_WORK');
    assert.equal(workerEvents.length, 1);
    assert.equal(idleEvents.length, 1);
    assert.deepEqual(state.config.modelPolicy, exactModelPolicy);
    assert.equal(workerEvents[0].invocation.requestedModel, 'gpt-5.6-sol');
    assert.equal(workerEvents[0].invocation.reportedModel, null);
    assert.equal(workerEvents[0].invocation.modelSelectionAuthority, 'explicit-model-flag');
    assert.equal(workerEvents[0].invocation.modelIdentityAuthority, 'explicit-model-flag');
  } finally {
    if (child.exitCode == null) {
      writeFileSync(stopFile, '');
      await waitForExit(child).catch(() => child.kill('SIGKILL'));
    }
  }
});
