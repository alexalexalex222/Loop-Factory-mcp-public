// Skill store: write/read round-trip, path escape, archive, list excludes archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';

const SAMPLE_SKILL = `---
skill_id: test-skill
title: Test Skill
version: 1
license: MIT
source: operator:test:2026-06-27
sha256: abc123
skillPartition: working
tags: [test, demo]
---

## Overview

This is the overview section with enough content to be meaningful.

## _synthesis

**Use:** patterns only.
**Do not copy:** verbatim prose.
`;

test('write/read round-trip preserves frontmatter + body', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-store-'));
  const store = createStore(home);
  store.writeSkill({ id: 'test-skill', content: SAMPLE_SKILL });
  const parsed = store.readSkill('test-skill');
  assert.ok(parsed);
  assert.equal(parsed.frontmatter.skill_id, 'test-skill');
  assert.equal(parsed.frontmatter.title, 'Test Skill');
  assert.equal(parsed.frontmatter.license, 'MIT');
  assert.equal(parsed.frontmatter.source, 'operator:test:2026-06-27');
  assert.deepEqual(parsed.frontmatter.tags, ['test', 'demo']);
  assert.match(parsed.body.trim(), /^## Overview/);
  assert.match(parsed.body, /## _synthesis/);
});

test('path-escape id is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-store-'));
  const store = createStore(home);
  assert.throws(
    () => store.writeSkill({ id: '../evil', content: SAMPLE_SKILL }),
    /skillId must match/
  );
  assert.throws(
    () => store.skillPath('../evil'),
    /skillId must match/
  );
});

test('listSkills excludes archive subdirectory entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-store-'));
  const store = createStore(home);
  store.writeSkill({ id: 'live-skill', content: SAMPLE_SKILL });
  store.writeIndex('live-skill', { skill_id: 'live-skill', version: 1, sha256: 'deadbeef' });
  store.archiveSkill('live-skill');
  assert.deepEqual(store.listSkills(), []);
  const archiveDir = join(home, 'skills', 'archive');
  assert.ok(existsSync(archiveDir));
  const archived = readdirSync(archiveDir);
  assert.ok(archived.some((f) => f.startsWith('live-skill-v1-') && f.endsWith('.md')));
  assert.ok(archived.some((f) => f.startsWith('live-skill-v1-') && f.endsWith('.index.json')));
});

test('archive moves both .md and .index.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-store-'));
  const store = createStore(home);
  store.writeSkill({ id: 'arch-me', content: SAMPLE_SKILL });
  store.writeIndex('arch-me', { skill_id: 'arch-me', version: 2, sha256: 'cafebabe1234' });
  assert.ok(store.skillExists('arch-me'));
  assert.ok(existsSync(store.indexPath('arch-me')));
  store.archiveSkill('arch-me');
  assert.equal(store.skillExists('arch-me'), false);
  assert.equal(store.readIndex('arch-me'), null);
  const archiveDir = join(home, 'skills', 'archive');
  const files = readdirSync(archiveDir);
  assert.ok(files.includes('arch-me-v2-cafebabe1234.md'));
  assert.ok(files.includes('arch-me-v2-cafebabe1234.index.json'));
});
