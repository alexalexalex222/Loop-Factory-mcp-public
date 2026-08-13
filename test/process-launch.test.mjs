import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildProcessLaunch } from '../src/process-launch.mjs';

test('native executables retain direct shell-free execFile semantics', () => {
  const prompt = 'never argv; & echo PWNED';
  const spec = buildProcessLaunch({
    binPath: '/opt/tools/codex',
    args: ['exec', '-m', 'gpt-5.6-sol'],
    platform: 'linux',
    env: {},
    prompt
  });
  assert.equal(spec.file, '/opt/tools/codex');
  assert.deepEqual(spec.args, ['exec', '-m', 'gpt-5.6-sol']);
  assert.equal(spec.shell, false);
  assert.equal(spec.windowsVerbatimArguments, false);
  assert.equal(spec.requiresTreeTermination, false);
  assert.equal(spec.adapter, 'native-exec-file');
  assert.equal(JSON.stringify(spec).includes(prompt), false);
});

test('Windows command shims use only the narrow cmd.exe adapter', () => {
  const prompt = '$(touch NO); & echo NO';
  const shim = join('C:\\Program Files', 'Loop & Factory', 'codex.cmd');
  const spec = buildProcessLaunch({
    binPath: shim,
    args: ['exec', '-m', 'gpt-5.6-sol'],
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    prompt
  });
  assert.equal(spec.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spec.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(spec.args[4], /^"/);
  assert.match(spec.args[4], /"$/);
  assert.match(spec.args[4], /codex\.cmd/);
  assert.match(spec.args[4], /\^+&/);
  assert.equal(spec.shell, false);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.equal(spec.requiresTreeTermination, true);
  assert.equal(spec.adapter, 'windows-command-shim');
  assert.equal(JSON.stringify(spec).includes(prompt), false);
});

test('Windows adapter refuses non-shims and command-line control characters', () => {
  assert.throws(() => buildProcessLaunch({
    binPath: 'C:\\tools\\codex.exe', args: [], platform: 'win32', forceCommandShim: true
  }), /\.cmd or \.bat/);
  assert.throws(() => buildProcessLaunch({
    binPath: 'C:\\tools\\codex.cmd', args: ['ok\r\nwhoami'], platform: 'win32'
  }), /control characters/);
  assert.throws(() => buildProcessLaunch({
    binPath: 'C:\\tools\\codex.cmd', args: ['gpt-5.6-sol%CMDCMDLINE%'], platform: 'win32'
  }), /environment expansion syntax/);
  assert.throws(() => buildProcessLaunch({
    binPath: 'C:\\tools%USERNAME%\\codex.cmd', args: [], platform: 'win32'
  }), /environment expansion syntax/);
});

test('Windows shim escaping preserves controller-owned quoted config as data', () => {
  const spec = buildProcessLaunch({
    binPath: 'C:\\tools\\codex.cmd',
    args: ['-c', 'model_reasoning_effort="high"'],
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  });
  assert.match(spec.args[4], /model_reasoning_effort/);
  assert.match(spec.args[4], /high/);
  assert.equal(spec.windowsVerbatimArguments, true);
});
