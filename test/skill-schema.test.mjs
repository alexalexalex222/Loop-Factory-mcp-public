// Skill schema: provenance validation, sha256, slugify, section overrides, source_paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSkillFile,
  computeSkillSha256,
  slugify,
  deriveSectionIds,
  validateSkillRecord
} from '../src/skill-schema.mjs';

function bodyWithSections(extraFrontmatter = '') {
  return {
    frontmatter: {
      skill_id: 'demo',
      title: 'Demo',
      version: 1,
      license: 'MIT',
      source: 'operator:test',
      skillPartition: 'working',
      ...extraFrontmatter
    },
    body: [
      '## Overview',
      '<!-- section_id: overview purpose: Scope and prerequisites -->',
      'Overview text here with enough content.',
      '',
      '## Details',
      'More detail content for the skill body.',
      '',
      '## _synthesis',
      '<!-- section_id: _synthesis purpose: Anti-copy rules -->',
      '**Use:** patterns. **Do not copy:** prose.'
    ].join('\n')
  };
}

test('missing license throws', () => {
  const { frontmatter, body } = bodyWithSections();
  delete frontmatter.license;
  assert.throws(() => validateSkillRecord(frontmatter, body), /missing license/);
});

test('missing source throws', () => {
  const { frontmatter, body } = bodyWithSections();
  delete frontmatter.source;
  assert.throws(() => validateSkillRecord(frontmatter, body), /missing source/);
});

test('missing _synthesis throws', () => {
  const { frontmatter, body } = bodyWithSections();
  const noSynth = body.split('\n').filter((l) => !l.includes('_synthesis') && !l.includes('Anti-copy')).join('\n');
  assert.throws(() => validateSkillRecord(frontmatter, noSynth), /missing required _synthesis/);
});

test('sha256 recomputation matches known fixture', () => {
  const body = '## Overview\n\nHello world.\n\n## _synthesis\n<!-- section_id: _synthesis -->\nAdapt.';
  const expected = computeSkillSha256(body);
  assert.match(expected, /^[0-9a-f]{64}$/);
  const frontmatter = {
    skill_id: 'demo',
    title: 'Demo',
    version: 1,
    license: 'MIT',
    source: 'operator:test',
    sha256: expected
  };
  assert.doesNotThrow(() => validateSkillRecord(frontmatter, body));
  assert.throws(
    () => validateSkillRecord({ ...frontmatter, sha256: 'deadbeef' }, body),
    /sha256 mismatch/
  );
});

test('slugify cases from spec', () => {
  assert.equal(slugify('Login flow selectors'), 'login-flow-selectors');
  assert.equal(slugify('API: POST /auth/login'), 'api-post-auth-login');
  assert.equal(slugify('Overview'), 'overview');
});

test('section override comment seeds the id at ingest', () => {
  const body = [
    '## Login flow selectors',
    '<!-- section_id: login-selectors purpose: Locator strategies -->',
    'Prefer getByRole.',
    '',
    '## _synthesis',
    '<!-- section_id: _synthesis purpose: Adapt -->',
    'Do not copy.'
  ].join('\n');
  const sections = deriveSectionIds(body);
  assert.ok(sections.some((s) => s.section_id === 'login-selectors'));
  assert.ok(sections.some((s) => s.section_id === '_synthesis'));
  assert.equal(sections.find((s) => s.section_id === 'login-selectors').purpose, 'Locator strategies');
});

test('source_paths array parses from frontmatter', () => {
  const raw = `---
skill_id: multi
title: Multi
version: 1
license: MIT
source: operator:test
source_paths: [ref/a.ts, ref/b.ts]
---

## One
<!-- section_id: one -->
A

## Two
<!-- section_id: two -->
B

## _synthesis
<!-- section_id: _synthesis -->
C
`;
  const { frontmatter } = parseSkillFile(raw);
  assert.deepEqual(frontmatter.source_paths, ['ref/a.ts', 'ref/b.ts']);
});
