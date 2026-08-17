import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JUDGE_MODEL,
  MIN_CODEX_VERSION,
  codexCandidatePaths,
  findCompatibleCodex,
  parseCodexVersion,
  versionAtLeast
} from '../scripts/judge-build-week.mjs';
import { createFakeCli } from './fixtures/fake-cli.mjs';

function fakeCodex(version) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-judge-codex-'));
  const path = createFakeCli(dir, 'codex', { stdout: `codex-cli ${version}\n` });
  return { dir, path };
}

test('judge kit pins the exact Sol model and requires Codex CLI 0.144.0+', () => {
  assert.equal(JUDGE_MODEL, 'gpt-5.6-sol');
  assert.equal(MIN_CODEX_VERSION, '0.144.0');
  assert.deepEqual(parseCodexVersion('codex-cli 0.145.0-alpha.18'), {
    raw: '0.145.0',
    parts: [0, 145, 0]
  });
  assert.equal(versionAtLeast('0.143.9'), false);
  assert.equal(versionAtLeast('0.144.0'), true);
  assert.equal(versionAtLeast('0.145.0'), true);
});

test('judge kit skips an old PATH candidate and selects a compatible installed Codex binary', () => {
  const old = fakeCodex('0.142.2');
  const current = fakeCodex('0.145.0-alpha.18');
  try {
    const result = findCompatibleCodex({ candidates: [old.path, current.path], env: {} });
    assert.equal(result.checked.length, 2);
    assert.equal(result.checked[0].ok, false);
    assert.equal(result.checked[1].ok, true);
    assert.equal(result.selected.path, current.path);
    assert.equal(result.selected.version, '0.145.0');
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('operator Codex override is the only candidate when explicitly supplied', () => {
  const fake = fakeCodex('0.145.0');
  try {
    assert.deepEqual(codexCandidatePaths({ SUPER_LOOP_CODEX_BIN: fake.path }, 'darwin'), [fake.path]);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('package exposes the one-command live judge path and deterministic fallback', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['judge:gpt56-sol'], 'node scripts/judge-build-week.mjs');
  assert.equal(pkg.scripts.demo, 'node scripts/demo.mjs');
});

test('every local README link is included in the package boundary', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const localTargets = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].split('#')[0])
    .filter((target) => target && !/^(?:https?:|mailto:|#)/i.test(target));
  const includesTarget = (target) => pkg.files.some((entry) => (
    !entry.startsWith('!')
    && (entry === target || (entry.endsWith('/') && target.startsWith(entry)))
  ));
  assert.deepEqual(localTargets.filter((target) => !includesTarget(target)), []);
});

test('Build Week docs expose the exact judge path, honest split, and unresolved external placeholders', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const readme = read('../README.md');
  const submission = read('../docs/BUILD_WEEK_SUBMISSION.md');
  const video = read('../docs/BUILD_WEEK_VIDEO.md');
  assert.match(readme, /Make AI agents prove they got better/);
  assert.match(readme, /npm run judge:gpt56-sol/);
  assert.match(readme, /GPT-5\.6 Sol/);
  assert.match(readme, /Fable 5/);
  assert.match(readme, /0\.6190/);
  assert.match(readme, /1\.0000/);
  assert.doesNotMatch(readme, /claude-opus-4-8|gpt-5\.5|glm-5\.2/i);
  assert.match(submission, /\[PUBLIC_YOUTUBE_URL\]/);
  assert.match(submission, /\[CODEX_FEEDBACK_SESSION_ID\]/);
  assert.match(submission, /Monday, July 20, 2026 at 11:30 PM PT/);
  assert.match(submission, /production frontier packet/i);
  assert.match(video, /Target length: 2 minutes 40 seconds/);
  assert.match(video, /spoken audio/i);
  assert.match(video, /original `0\.6190` and improved `1\.0000`/i);
  assert.match(video, /do not claim a promotion/i);
});
