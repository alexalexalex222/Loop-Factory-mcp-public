// Skill registration via loop_register { role:"skill" }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

// Re-use loop library custom content pattern for unchanged-path test.
const CUSTOM = [
  '# INTAKE', 'Read the operator goal and the frozen benchmark first.',
  '', '# MEASURE', 'Run the candidate and record the raw log so the MCP derives the cost.',
  '', '# DECIDE', 'Promote only on tool-computed, reverified movement; else continue.'
].join('\n');

function skillContent(overrides = {}) {
  const fm = {
    skill_id: 'my-skill',
    title: 'My Skill',
    version: 1,
    license: 'MIT',
    source: 'operator:test:2026-06-27',
    skillPartition: 'working',
    ...overrides
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push(
    '---',
    '',
    '## Overview',
    '<!-- section_id: overview purpose: Scope -->',
    'Use this skill for operator tasks that need stable patterns.',
    '',
    '## Details',
    '<!-- section_id: details purpose: Technical guidance -->',
    'Apply role-first locators and env-based credentials in every task.',
    '',
    '## _synthesis',
    '<!-- section_id: _synthesis purpose: Anti-copy rules -->',
    '**Use:** patterns. **Do not copy:** example prose verbatim.'
  );
  return lines.join('\n');
}

test('register with role:"skill" writes to skills/ not custom-loops/', () => {
  const { engine, store, home } = freshEngine();
  engine.initialize_loop_run({ runId: 'S1', task: SPECIFIC_TASK });
  const r = engine.loop_register({ runId: 'S1', id: 'my-skill', role: 'skill', content: skillContent() });
  assert.equal(r.status, 'OK');
  assert.equal(r.skill.id, 'my-skill');
  assert.equal(r.skill.skillPartition, 'working');
  assert.ok(r.skill.sections >= 3);
  assert.match(r.skill.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!r.skill.content, 'skill path returns metadata only');
  assert.deepEqual(store.listSkills(), ['my-skill']);
  assert.deepEqual(store.listLoops(), []);
  assert.ok(existsSync(join(home, 'skills', 'my-skill.md')));
  assert.ok(existsSync(join(home, 'skills', 'my-skill.index.json')));
});

test('missing license is blocked', () => {
  const { engine } = freshEngine();
  const r = engine.loop_register({ id: 'no-lic', role: 'skill', content: skillContent({ license: '' }) });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BAD_INPUT');
  assert.match(r.message, /license/i);
});

test('missing source is blocked', () => {
  const { engine } = freshEngine();
  const r = engine.loop_register({ id: 'no-src', role: 'skill', content: skillContent({ source: '' }) });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BAD_INPUT');
  assert.match(r.message, /source/i);
});

test('missing _synthesis is blocked', () => {
  const { engine } = freshEngine();
  const bad = skillContent().replace(/## _synthesis[\s\S]*$/, '');
  const r = engine.loop_register({ id: 'no-synth', role: 'skill', content: bad });
  assert.equal(r.status, 'BLOCKED');
  assert.match(r.message, /_synthesis/i);
});

test('default partition is working', () => {
  const { engine } = freshEngine();
  const content = skillContent();
  const withoutPartition = content.replace('skillPartition: working\n', '');
  const r = engine.loop_register({ id: 'def-part', role: 'skill', content: withoutPartition });
  assert.equal(r.status, 'OK');
  assert.equal(r.skill.skillPartition, 'working');
});

test('overwrite archives prior version when bytes differ', () => {
  const { engine, store, home } = freshEngine();
  engine.loop_register({ id: 'ver-skill', role: 'skill', content: skillContent() });
  const archiveBefore = existsSync(join(home, 'skills', 'archive'));
  const changed = skillContent({ version: 2 }) + '\n\nExtra paragraph in details section.';
  const r = engine.loop_register({ id: 'ver-skill', role: 'skill', content: changed, overwrite: true });
  assert.equal(r.status, 'OK');
  const archiveDir = join(home, 'skills', 'archive');
  assert.ok(existsSync(archiveDir));
  const archived = store.readSkill('ver-skill');
  assert.ok(archived);
});

test('loop register without role:"skill" behaves identically', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'S2', task: SPECIFIC_TASK });
  const r = engine.loop_register({ runId: 'S2', id: 'my-loop', title: 'My Loop', content: CUSTOM });
  assert.equal(r.status, 'OK');
  assert.equal(r.loop.id, 'my-loop');
  assert.equal(r.loop.origin, 'custom');
  assert.ok(r.loop.sections >= 2);
  assert.deepEqual(store.listLoops(), ['my-loop']);
  assert.deepEqual(store.listSkills(), []);
});
