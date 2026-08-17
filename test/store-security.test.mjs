import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';

test('process-atomic writes ignore stale fixed temp names and leave no new residue', () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-factory-store-atomic-'));
  try {
    const store = createStore(home);
    store.save({ runId: 'atomic-run', value: 1 });
    const statePath = join(home, 'runs', 'atomic-run', 'state.json');
    const stalePath = `${statePath}.tmp`;
    writeFileSync(stalePath, 'stale-writer-evidence');

    store.save({ runId: 'atomic-run', value: 2 });

    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).value, 2);
    assert.equal(readFileSync(stalePath, 'utf8'), 'stale-writer-evidence');
    assert.deepEqual(
      readdirSync(join(home, 'runs', 'atomic-run')).filter((name) => name.endsWith('.tmp')),
      ['state.json.tmp']
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('nested run files refuse symbolic-link traversal before writing outside state', () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-factory-store-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'loop-factory-store-outside-'));
  try {
    const store = createStore(home);
    store.save({ runId: 'symlink-run' });
    const linkedDirectory = join(home, 'runs', 'symlink-run', 'campaign-series');
    symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => store.writeRunFile('symlink-run', 'campaign-series/authorization.json', '{}'),
      /symbolic link/
    );
    assert.equal(existsSync(join(outside, 'authorization.json')), false);
    assert.throws(
      () => store.readRunFile('symlink-run', 'campaign-series/external.json'),
      /symbolic link/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
