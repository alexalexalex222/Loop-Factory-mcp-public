import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStateHome } from '../src/state-home.mjs';

test('state home precedence is explicit option, env, legacy, source checkout, user state', () => {
  const root = mkdtempSync(join(tmpdir(), 'loop-factory-state-root-'));
  const user = mkdtempSync(join(tmpdir(), 'loop-factory-user-'));
  try {
    assert.equal(resolveStateHome(root, { home: join(root, 'explicit'), env: {} }).source, 'explicit');
    assert.equal(resolveStateHome(root, { env: { SUPER_LOOP_HOME: join(root, 'env') } }).source, 'environment');

    mkdirSync(join(root, '.super-loop'));
    const legacy = resolveStateHome(root, { env: {} });
    assert.equal(legacy.source, 'legacy-package-state');
    assert.equal(legacy.homeDir, join(root, '.super-loop'));

    rmSync(join(root, '.super-loop'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n');
    assert.equal(resolveStateHome(root, { env: {} }).source, 'source-checkout');
    rmSync(join(root, '.git'));

    const installed = resolveStateHome(root, {
      platform: 'linux',
      env: { HOME: user, XDG_STATE_HOME: join(user, 'state') }
    });
    assert.equal(installed.source, 'user-state');
    assert.equal(installed.homeDir, join(user, 'state', 'loop-factory'));
    assert.equal(existsSync(installed.homeDir), false, 'resolution does not mutate disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test('Windows and macOS user-state paths are writable-location conventions', () => {
  assert.equal(
    resolveStateHome('C:\\pkg', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ace\\AppData\\Local' } }).homeDir,
    join('C:\\Users\\Ace\\AppData\\Local', 'Loop Factory')
  );
  assert.equal(
    resolveStateHome('/pkg', { platform: 'darwin', env: { HOME: '/Users/ace' } }).homeDir,
    join('/Users/ace', 'Library', 'Application Support', 'Loop Factory')
  );
});
