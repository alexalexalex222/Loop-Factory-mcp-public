#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  superviseProcessTree,
  terminateProcessTree
} from '../src/process-tree-supervisor.mjs';

function parse(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0) return null;
  const prefix = argv.slice(0, separator);
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  const values = {};
  for (let index = 0; index < prefix.length; index += 2) {
    const key = prefix[index];
    const value = prefix[index + 1];
    if (!['--parent-pid', '--timeout-ms'].includes(key) || value == null) return null;
    values[key.slice(2)] = Number(value);
  }
  return Number.isInteger(values['parent-pid']) && values['parent-pid'] > 0
      && Number.isInteger(values['timeout-ms']) && values['timeout-ms'] >= 1
      && typeof command === 'string' && command.length > 0
    ? { parentPid: values['parent-pid'], timeoutMs: values['timeout-ms'], command, args }
    : null;
}

function parentAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const parsed = parse(process.argv.slice(2));
if (!parsed) {
  process.stderr.write('invalid guarded execution request\n');
  process.exit(2);
}

const child = spawn(parsed.command, parsed.args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true
});
const supervision = superviseProcessTree(child);
child.stdin.on('error', (error) => {
  if (error?.code !== 'EPIPE') {
    process.stderr.write(`LOOP_FACTORY_GUARDED_EXEC_STDIN_FAILED:${error?.code || 'UNKNOWN'}\n`);
    supervision.terminate('GUARDED_EXEC_STDIN_FAILED', 'SIGKILL');
  }
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  supervision.terminate('GUARDED_EXEC_TIMEOUT', 'SIGKILL');
}, parsed.timeoutMs);
const parentMonitor = setInterval(() => {
  if (!parentAlive(parsed.parentPid)) {
    supervision.terminate('GUARDED_EXEC_PARENT_EXITED', 'SIGKILL');
  }
}, 100);
parentMonitor.unref();

async function reapProcessTree() {
  let exited = await supervision.waitForExit(
    supervision.terminationCode == null ? 500 : 5_000
  );
  if (exited) return true;
  if (supervision.terminationCode == null) {
    supervision.terminate('GUARDED_EXEC_DESCENDANT_SURVIVED', 'SIGTERM');
    exited = await supervision.waitForExit(5_000);
  }
  if (exited) return true;
  terminateProcessTree(child.pid, 'SIGKILL');
  return supervision.waitForExit(5_000);
}

child.once('error', async () => {
  clearTimeout(timeout);
  clearInterval(parentMonitor);
  supervision.terminate('GUARDED_EXEC_LAUNCH_FAILED', 'SIGKILL');
  await reapProcessTree();
  supervision.release();
  process.exit(126);
});

child.once('close', async (code, signal) => {
  clearTimeout(timeout);
  clearInterval(parentMonitor);
  const treeReaped = await reapProcessTree();
  const terminated = supervision.terminationCode;
  supervision.release();
  if (!treeReaped) {
    process.stderr.write('LOOP_FACTORY_GUARDED_EXEC_TREE_NOT_REAPED\n');
    process.exit(125);
  }
  if (timedOut) {
    process.stderr.write('LOOP_FACTORY_GUARDED_EXEC_TIMEOUT\n');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (terminated === 'GUARDED_EXEC_PARENT_EXITED') process.exit(143);
  if (terminated === 'GUARDED_EXEC_DESCENDANT_SURVIVED') {
    process.stderr.write('LOOP_FACTORY_GUARDED_EXEC_DESCENDANT_SURVIVED\n');
    process.exit(125);
  }
  if (signal) {
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
    return;
  }
  process.exit(Number.isInteger(code) ? code : 1);
});
