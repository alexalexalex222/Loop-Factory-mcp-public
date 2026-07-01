// loop_library lists skills separately from custom loops (metadata only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

const CUSTOM = [
  '# INTAKE', 'Read the operator goal and the frozen benchmark first.',
  '', '# MEASURE', 'Run the candidate and record the raw log so the MCP derives the cost.',
  '', '# DECIDE', 'Promote only on tool-computed, reverified movement; else continue.'
].join('\n');

function skillContent(id = 'lib-skill') {
  return `---
skill_id: ${id}
title: Library Skill
version: 1
license: MIT
source: operator:test
skillPartition: working
tags: [demo, auth]
stack: [node]
supports_tasks: [login_test]
token_budget_hint: 1200
---

## Overview
<!-- section_id: overview purpose: Scope -->
Overview content for the skill library test.

## _synthesis
<!-- section_id: _synthesis purpose: Adapt -->
Adapt patterns to the target app.
`;
}

test('loop_library returns skills separate from custom, metadata only', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'LL1', task: SPECIFIC_TASK });
  engine.loop_register({ runId: 'LL1', id: 'extra-loop', content: CUSTOM });
  engine.loop_register({ id: 'lib-skill', role: 'skill', content: skillContent() });
  const lib = engine.loop_library({ runId: 'LL1' });
  assert.equal(lib.status, 'OK');
  assert.equal(lib.mandated.length, 2);
  assert.ok(lib.custom.some((c) => c.id === 'extra-loop'));
  assert.ok(Array.isArray(lib.skills));
  const skill = lib.skills.find((s) => s.id === 'lib-skill');
  assert.ok(skill);
  assert.equal(skill.title, 'Library Skill');
  assert.equal(skill.license, 'MIT');
  assert.equal(skill.skillPartition, 'working');
  assert.deepEqual(skill.tags, ['demo', 'auth']);
  assert.equal(skill.sections, 2);
  assert.equal(skill.token_budget_hint, 1200);
  assert.equal(skill.body, undefined);
  assert.equal(skill.content, undefined);
});

test('loop_library unchanged fields for mandated and custom', () => {
  const { engine } = freshEngine();
  const lib = engine.loop_library({});
  assert.equal(lib.status, 'OK');
  assert.ok(lib.mandated.every((m) => m.hashLocked === true));
  assert.ok(lib.registerWith);
  assert.ok(lib.streamWith);
  assert.deepEqual(lib.skills, []);
});
