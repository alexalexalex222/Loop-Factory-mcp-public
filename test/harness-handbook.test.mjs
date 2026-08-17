import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHarnessHandbook,
  verifyHarnessHandbookFreshness
} from '../src/harness-handbook.mjs';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'loop-factory-handbook-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'router.mjs'), [
    'export function routeFailure(input) {',
    '  return input.kind === "failure";',
    '}',
    ''
  ].join('\n'));
  writeFileSync(join(root, 'test', 'router.test.mjs'), [
    'test("routeFailure rejects successes", () => {});',
    ''
  ].join('\n'));
  return root;
}

function behavior(overrides = {}) {
  return {
    id: 'route-failure',
    description: 'Routes normalized failures to eligible evidence.',
    generatedSummary: 'Failure routing lives in the router component.',
    locators: [{
      path: 'src/router.mjs',
      symbol: 'routeFailure',
      startLine: 1,
      endLine: 3
    }],
    tests: [{
      path: 'test/router.test.mjs',
      symbol: 'routeFailure rejects successes',
      startLine: 1,
      endLine: 1
    }],
    dependencies: ['node:path', 'failure-normalizer'],
    permissions: ['read repository source', 'describe locations'],
    ...overrides
  };
}

test('behavior maps bind exact facts deterministically without edit authority', () => {
  const root = repository();
  const first = buildHarnessHandbook({ repositoryRoot: root, behaviors: [behavior()] });
  const reordered = behavior({
    dependencies: ['failure-normalizer', 'node:path'],
    permissions: ['describe locations', 'read repository source']
  });
  const second = buildHarnessHandbook({ repositoryRoot: root, behaviors: [reordered] });

  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(first.behaviorMap.canAuthorizeEdits, false);
  assert.equal(first.behaviorMap.behaviors[0].summary.authority, 'descriptive-only');
  assert.equal(first.behaviorMap.behaviors[0].summary.canAuthorizeEdits, false);
  assert.match(first.behaviorMap.behaviors[0].locators[0].sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(first.behaviorMap.behaviors[0].locators[0].locatorSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    verifyHarnessHandbookFreshness({ repositoryRoot: root, behaviorMap: first.behaviorMap }),
    { status: 'OK', fresh: true, findings: [] }
  );
});

test('freshness replay detects source tamper and stale symbols/locators', () => {
  const root = repository();
  const built = buildHarnessHandbook({ repositoryRoot: root, behaviors: [behavior()] });
  assert.equal(built.status, 'OK');

  writeFileSync(join(root, 'src', 'router.mjs'), [
    'export function dispatchIncident(input) {',
    '  return input.kind === "failure";',
    '}',
    ''
  ].join('\n'));
  const replay = verifyHarnessHandbookFreshness({
    repositoryRoot: root,
    behaviorMap: built.behaviorMap
  });
  assert.equal(replay.status, 'OK');
  assert.equal(replay.fresh, false);
  assert.deepEqual(
    new Set(replay.findings.map(({ code }) => code)),
    new Set([
      'HANDBOOK_SOURCE_TAMPERED',
      'HANDBOOK_LOCATOR_STALE',
      'HANDBOOK_SYMBOL_STALE'
    ])
  );
});

test('freshness replay detects source-byte tamper outside the exact locator', () => {
  const root = repository();
  const built = buildHarnessHandbook({ repositoryRoot: root, behaviors: [behavior()] });
  writeFileSync(join(root, 'src', 'router.mjs'), [
    'export function routeFailure(input) {',
    '  return input.kind === "failure";',
    '}',
    '// unrelated source bytes changed',
    ''
  ].join('\n'));
  const replay = verifyHarnessHandbookFreshness({ repositoryRoot: root, behaviorMap: built.behaviorMap });
  assert.equal(replay.fresh, false);
  assert.deepEqual(
    [...new Set(replay.findings.map(({ code }) => code))],
    ['HANDBOOK_SOURCE_TAMPERED']
  );
});

test('behavior maps reject traversal, symlinks, and oversized source files', () => {
  const root = repository();
  const traversal = buildHarnessHandbook({
    repositoryRoot: root,
    behaviors: [behavior({
      locators: [{ path: '../outside.mjs', symbol: 'outside', startLine: 1, endLine: 1 }]
    })]
  });
  assert.equal(traversal.code, 'HANDBOOK_PATH_TRAVERSAL');

  symlinkSync(join(root, 'src', 'router.mjs'), join(root, 'src', 'linked-router.mjs'));
  const symlink = buildHarnessHandbook({
    repositoryRoot: root,
    behaviors: [behavior({
      locators: [{ path: 'src/linked-router.mjs', symbol: 'routeFailure', startLine: 1, endLine: 3 }]
    })]
  });
  assert.equal(symlink.code, 'HANDBOOK_SYMLINK_REJECTED');

  const oversized = buildHarnessHandbook({
    repositoryRoot: root,
    behaviors: [behavior()],
    maxFileBytes: 24
  });
  assert.equal(oversized.code, 'HANDBOOK_FILE_TOO_LARGE');
});
