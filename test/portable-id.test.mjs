import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import {
  isAbsoluteOnAnyPlatform,
  isPortableId,
  isSafeId
} from '../src/util.mjs';

test('portable paths recognize POSIX, drive-letter, and UNC absolute forms', () => {
  for (const path of ['/tmp/file', 'C:\\temp\\file', '\\\\server\\share\\file']) {
    assert.equal(isAbsoluteOnAnyPlatform(path), true, path);
  }
  for (const path of ['relative/file', 'relative\\file']) {
    assert.equal(isAbsoluteOnAnyPlatform(path), false, path);
  }
});

test('portable IDs reject Windows device names and trailing periods without weakening legacy syntax', () => {
  for (const id of ['CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'com9.log', 'LPT1', 'lpt9.foo', 'ends.']) {
    assert.equal(isSafeId(id), true, `${id} remains readable as a legacy-safe id`);
    assert.equal(isPortableId(id), false, `${id} is blocked for new files`);
  }
  for (const id of ['run-1', 'alpha.beta', 'COM10', 'auxiliary']) assert.equal(isPortableId(id), true, id);
});

test('store preserves exact legacy access but blocks unsafe creation and case collisions', () => {
  const home = mkdtempSync(join(tmpdir(), 'loop-factory-id-'));
  try {
    const store = createStore(home);
    if (process.platform === 'win32') {
      assert.equal(store.load('CON'), null, 'reserved legacy names remain absent on Windows');
    } else {
      const legacyDir = join(home, 'runs', 'CON');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, 'state.json'), JSON.stringify({ runId: 'CON', legacy: true }));
      assert.equal(store.load('CON').legacy, true);
      assert.equal(store.load('con'), null, 'case-folded aliases cannot read a different exact id');
    }
    assert.throws(() => store.save({ runId: 'NUL' }), /portable/);

    store.save({ runId: 'Alpha' });
    assert.throws(() => store.save({ runId: 'alpha' }), /case-insensitive collision/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
