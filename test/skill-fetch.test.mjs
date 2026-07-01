// skill_fetch: plan + section modes, partition firewall, version pinning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

function skillMarkdown(id, { partition = 'working', tags = ['playwright', 'auth'], extraBody = '' } = {}) {
  return `---
skill_id: ${id}
title: ${id === 'pw-login' ? 'Playwright login-flow testing' : 'Reference held-out skill'}
version: 1
license: MIT
source: operator:test
skillPartition: ${partition}
tags: [${tags.join(', ')}]
supports_tasks: [login_test]
---

## Overview
<!-- section_id: overview purpose: Playwright login scope and prerequisites -->
Use playwright for login end-to-end tests on staging.
${extraBody}

## Login selectors
<!-- section_id: login-selectors purpose: Locator strategies for playwright auth forms -->
Prefer getByRole for email and password fields in playwright tests.

## _synthesis
<!-- section_id: _synthesis purpose: Adapt patterns to target app -->
**Use:** locator order. **Do not copy:** example URLs.
`;
}

function registerSkill(engine, id, opts = {}) {
  return engine.loop_register({ id, role: 'skill', content: skillMarkdown(id, opts) });
}

test('plan mode returns working skill index; reference skill absent', () => {
  const { engine } = freshEngine();
  registerSkill(engine, 'pw-login', { partition: 'working' });
  registerSkill(engine, 'ref-skill', { partition: 'reference' });
  const plan = engine.skill_fetch({ mode: 'plan', query: 'playwright login' });
  assert.equal(plan.status, 'OK');
  assert.equal(plan.mode, 'plan');
  const ids = plan.skills.map((s) => s.skill_id);
  assert.ok(ids.includes('pw-login'));
  assert.ok(!ids.includes('ref-skill'));
  assert.equal(plan.skills[0].body, undefined);
  assert.ok(plan.skills[0].sections.length >= 2);
});

test('plan with partition reference returns reference skill only', () => {
  const { engine } = freshEngine();
  registerSkill(engine, 'pw-login', { partition: 'working' });
  registerSkill(engine, 'ref-skill', { partition: 'reference' });
  const plan = engine.skill_fetch({ mode: 'plan', query: 'playwright', partition: 'reference' });
  assert.equal(plan.status, 'OK');
  const ids = plan.skills.map((s) => s.skill_id);
  assert.ok(ids.includes('ref-skill'));
  assert.ok(!ids.includes('pw-login'));
});

test('section mode returns one section body with provenance', () => {
  const { engine } = freshEngine();
  registerSkill(engine, 'pw-login');
  const fetch = engine.skill_fetch({ mode: 'section', skill_id: 'pw-login', section_id: 'login-selectors' });
  assert.equal(fetch.status, 'OK');
  assert.equal(fetch.mode, 'section');
  assert.equal(fetch.skill_id, 'pw-login');
  assert.equal(fetch.section_id, 'login-selectors');
  assert.match(fetch.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fetch.version, 1);
  assert.equal(fetch.license, 'MIT');
  assert.equal(fetch.source, 'operator:test');
  assert.match(fetch.body, /getByRole/);
  assert.ok(fetch.token_estimate > 0);
});

test('section on reference skill without partition reference is blocked', () => {
  const { engine } = freshEngine();
  registerSkill(engine, 'ref-skill', { partition: 'reference' });
  const fetch = engine.skill_fetch({ mode: 'section', skill_id: 'ref-skill', section_id: 'overview' });
  assert.equal(fetch.status, 'BLOCKED');
  assert.equal(fetch.code, 'BAD_INPUT');
  assert.match(fetch.message, /reference partition/i);
});

test('section with runId pins version in skillsUsed', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'SF1', task: SPECIFIC_TASK });
  registerSkill(engine, 'pw-login');
  const fetch = engine.skill_fetch({
    mode: 'section', skill_id: 'pw-login', section_id: 'overview', runId: 'SF1'
  });
  assert.equal(fetch.status, 'OK');
  const state = store.load('SF1');
  assert.equal(state.skillsUsed.length, 1);
  assert.equal(state.skillsUsed[0].skill_id, 'pw-login');
  assert.equal(state.skillsUsed[0].section_id, 'overview');
  assert.equal(state.skillsUsed[0].sha256, fetch.sha256);
  assert.equal(state.skillsUsed[0].version, 1);
  assert.ok(state.skillsUsed[0].ts);
});

test('section on missing section_id is blocked', () => {
  const { engine } = freshEngine();
  registerSkill(engine, 'pw-login');
  const fetch = engine.skill_fetch({ mode: 'section', skill_id: 'pw-login', section_id: 'no-such-section' });
  assert.equal(fetch.status, 'BLOCKED');
  assert.match(fetch.message, /not found/i);
});

test('default mode without mode arg behaves as plan', () => {
  const { engine } = freshEngine();
  registerSkill(engine, 'pw-login');
  const plan = engine.skill_fetch({ query: 'playwright' });
  assert.equal(plan.status, 'OK');
  assert.equal(plan.mode, 'plan');
});
