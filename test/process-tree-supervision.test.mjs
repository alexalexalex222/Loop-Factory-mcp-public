import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { sweepEphemeralAuthCapsules } from '../src/ephemeral-auth-capsule.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROCESS_TREE_MODULE = pathToFileURL(join(
  PACKAGE_ROOT,
  'src/process-tree-supervisor.mjs'
)).href;
const AUTH_MODULE = pathToFileURL(join(
  PACKAGE_ROOT,
  'src/ephemeral-auth-capsule.mjs'
)).href;
const GUARDED_EXEC = join(PACKAGE_ROOT, 'scripts/vnext-guarded-exec.mjs');

function waitForOutput(child, marker, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`missing ${marker}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`helper exited before ${marker}: ${code}/${signal}`));
      }
    });
  });
}

function waitForExit(child, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('SIGTERM tears down every tracked child process group', {
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'process-tree-signal-'));
  const pidPath = join(root, 'child.pid');
  const code = `
    import { spawn } from 'node:child_process';
    import { superviseProcessTree } from ${JSON.stringify(PROCESS_TREE_MODULE)};
    const child = spawn('/bin/sh', ['-c', 'printf %s "$$" > "$PID_PATH"; sleep 30'], {
      env: process.env, stdio: 'ignore', detached: true
    });
    superviseProcessTree(child);
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const helper = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PID_PATH: pidPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  await waitForOutput(helper, 'READY');
  const deadline = Date.now() + 5000;
  while (!existsSync(pidPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(pidPath), true);
  const childPid = Number(readFileSync(pidPath, 'utf8'));
  process.kill(helper.pid, 'SIGTERM');
  const exit = await waitForExit(helper);
  assert.equal(exit.code, 143);
  assertGone(childPid);
});

test('guarded synchronous executor kills its detached command on termination', {
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'guarded-exec-signal-'));
  const pidPath = join(root, 'command.pid');
  const command = join(root, 'command');
  writeFileSync(command, `#!/bin/sh
printf '%s' "$$" > '${pidPath}'
sleep 30
`);
  chmodSync(command, 0o755);
  const guard = spawn(process.execPath, [
    GUARDED_EXEC,
    '--parent-pid', String(process.pid),
    '--timeout-ms', '30000',
    '--', command
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const deadline = Date.now() + 5000;
  while (!existsSync(pidPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(pidPath), true);
  const childPid = Number(readFileSync(pidPath, 'utf8'));
  process.kill(guard.pid, 'SIGTERM');
  await waitForExit(guard);
  assertGone(childPid);
});

test('guarded synchronous executor kills its command when the owning parent is SIGKILLed', {
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'guarded-exec-parent-loss-'));
  const pidPath = join(root, 'command.pid');
  const command = join(root, 'command');
  writeFileSync(command, `#!/bin/sh
printf '%s' "$$" > '${pidPath}'
sleep 30
`);
  chmodSync(command, 0o755);
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });
  const guard = spawn(process.execPath, [
    GUARDED_EXEC,
    '--parent-pid', String(owner.pid),
    '--timeout-ms', '30000',
    '--', command
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const deadline = Date.now() + 5000;
  while (!existsSync(pidPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(pidPath), true);
  const childPid = Number(readFileSync(pidPath, 'utf8'));
  process.kill(owner.pid, 'SIGKILL');
  await waitForExit(owner);
  const guardExit = await waitForExit(guard);
  assert.equal(guardExit.code, 143);
  assertGone(childPid);
});

test('guarded executor reaps a descendant left behind by a successful command', {
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'guarded-exec-descendant-'));
  const pidPath = join(root, 'descendant.pid');
  const command = join(root, 'command.mjs');
  writeFileSync(command, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore'
    });
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    child.unref();
  `);
  const guard = spawn(process.execPath, [
    GUARDED_EXEC,
    '--parent-pid', String(process.pid),
    '--timeout-ms', '30000',
    '--', process.execPath, command
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const exit = await waitForExit(guard);
  assert.equal(exit.code, 125);
  assert.equal(existsSync(pidPath), true);
  assertGone(Number(readFileSync(pidPath, 'utf8')));
});

test('guarded executor preserves a fast failure when prompt forwarding hits EPIPE', {
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'guarded-exec-epipe-'));
  const command = join(root, 'command.mjs');
  writeFileSync(command, `
    process.stderr.write('deterministic child failure\\n');
    process.exit(7);
  `);
  const guard = spawn(process.execPath, [
    GUARDED_EXEC,
    '--parent-pid', String(process.pid),
    '--timeout-ms', '30000',
    '--', process.execPath, command
  ], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  guard.stderr.on('data', (chunk) => { stderr += String(chunk); });
  guard.stdin.on('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
  });
  guard.stdin.end('x'.repeat(8 * 1024 * 1024));
  const exit = await waitForExit(guard);
  assert.equal(exit.code, 7);
  assert.equal(stderr, 'deterministic child failure\n');
});

test('SIGKILL residue is swept from the external auth root without entering proof state', {
  skip: process.platform === 'win32'
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'auth-capsule-sigkill-'));
  const source = join(root, 'source');
  const proofState = join(root, 'proof-state');
  const capsuleRoot = join(root, 'capsules');
  mkdirSync(source);
  mkdirSync(proofState);
  writeFileSync(join(source, 'auth.json'), '{}\n', { mode: 0o600 });
  const code = `
    import { prepareEphemeralCodexAuthCapsule } from ${JSON.stringify(AUTH_MODULE)};
    const result = prepareEphemeralCodexAuthCapsule({
      env: { CODEX_HOME: process.env.SOURCE_HOME },
      root: process.env.CAPSULE_ROOT,
      forbiddenRoot: process.env.PROOF_STATE
    });
    if (result.status !== 'OK') process.exit(2);
    process.stdout.write('CAPSULE=' + result.capsule + '\\n');
    setInterval(() => {}, 1000);
  `;
  const helper = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      SOURCE_HOME: source,
      CAPSULE_ROOT: capsuleRoot,
      PROOF_STATE: proofState
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = await waitForOutput(helper, 'CAPSULE=');
  const capsule = output.match(/CAPSULE=(.+)/)?.[1]?.trim();
  assert.ok(capsule);
  assert.equal(capsule.startsWith(proofState), false);
  assert.equal(existsSync(join(capsule, 'auth.json')), true);
  process.kill(helper.pid, 'SIGKILL');
  await waitForExit(helper);
  const swept = sweepEphemeralAuthCapsules({ root: capsuleRoot });
  assert.equal(swept.status, 'OK');
  assert.equal(swept.removed.length, 1);
  assert.equal(existsSync(capsule), false);
  assert.equal(existsSync(join(proofState, 'auth-capsule')), false);
});
