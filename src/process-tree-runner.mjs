#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { join, win32 } from 'node:path';

const TIMEOUT_TREE_KILLED = 'LOOP_FACTORY_TIMEOUT_TREE_KILLED';
const TIMEOUT_TREE_KILL_FAILED = 'LOOP_FACTORY_TIMEOUT_TREE_KILL_FAILED';
const OUTPUT_LIMIT_TREE_KILLED = 'LOOP_FACTORY_OUTPUT_LIMIT_TREE_KILLED';

function fail(message) {
  writeSync(2, `Loop Factory process runner: ${message}\n`);
  process.exit(127);
}

let spec;
try {
  spec = JSON.parse(Buffer.from(String(process.argv[2] || ''), 'base64url').toString('utf8'));
} catch {
  fail('invalid launch payload');
}
if (process.platform !== 'win32') fail('Windows process runner invoked on a non-Windows host');
if (!spec || typeof spec.file !== 'string' || !Array.isArray(spec.args)) fail('invalid launch specification');
if (win32.basename(spec.file).toLowerCase() !== 'cmd.exe') fail('launch target must be cmd.exe');

const timeoutMs = Math.max(1, Number(spec.timeoutMs) || 1);
const maxBuffer = Math.max(1024, Number(spec.maxBuffer) || (64 * 1024 * 1024));
const stdout = [];
const stderr = [];
let outputBytes = 0;
let finalized = false;
let terminationReason = null;
let treeKilled = false;
let timeout = null;

const child = spawn(spec.file, spec.args.map(String), {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
  shell: false
});

function emitBuffers() {
  for (const chunk of stdout) writeSync(1, chunk);
  for (const chunk of stderr) writeSync(2, chunk);
}

function finalize(code) {
  if (finalized) return;
  finalized = true;
  clearTimeout(timeout);
  emitBuffers();
  if (terminationReason === 'timeout') {
    writeSync(2, `\n${treeKilled ? TIMEOUT_TREE_KILLED : TIMEOUT_TREE_KILL_FAILED}\n`);
    process.exit(treeKilled ? 124 : 125);
  }
  if (terminationReason === 'output-limit') {
    writeSync(2, `\n${treeKilled ? OUTPUT_LIMIT_TREE_KILLED : TIMEOUT_TREE_KILL_FAILED}\n`);
    process.exit(treeKilled ? 126 : 125);
  }
  process.exit(Number.isInteger(code) ? code : 1);
}

function terminateTree(reason) {
  if (terminationReason) return;
  terminationReason = reason;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || '';
  const taskkill = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
  try {
    execFileSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 15_000,
      stdio: 'ignore',
      shell: false
    });
    treeKilled = true;
  } catch {
    try { child.kill('SIGKILL'); } catch { /* best-effort direct-child fallback */ }
  }
  setTimeout(() => finalize(null), 5_000).unref();
}

function capture(target, chunk) {
  if (terminationReason) return;
  const data = Buffer.from(chunk);
  const remaining = maxBuffer - outputBytes;
  if (remaining > 0) {
    target.push(data.length <= remaining ? data : data.subarray(0, remaining));
    outputBytes += Math.min(data.length, remaining);
  }
  if (data.length > remaining) terminateTree('output-limit');
}

child.stdout.on('data', (chunk) => capture(stdout, chunk));
child.stderr.on('data', (chunk) => capture(stderr, chunk));
child.on('error', (error) => {
  stderr.push(Buffer.from(`Loop Factory process runner spawn failed: ${error.message}\n`));
  finalize(127);
});
child.on('close', (code) => finalize(code));
process.stdin.on('error', () => { /* child exit can close stdin early */ });
child.stdin.on('error', () => { /* provider may close stdin after reading */ });
process.stdin.pipe(child.stdin);

timeout = setTimeout(() => terminateTree('timeout'), timeoutMs);
