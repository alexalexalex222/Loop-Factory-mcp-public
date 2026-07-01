// Keyword pre-filter for skill_fetch plan mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSkillAgainstQuery, rankSkills } from '../src/skill-match.mjs';

const playwrightSkill = {
  skill_id: 'playwright-login',
  title: 'Playwright login-flow testing',
  tags: ['playwright', 'e2e', 'auth'],
  supports_tasks: ['login_test', 'auth_e2e'],
  sections: [
    { section_id: 'overview', title: 'Overview', purpose: 'Scope for playwright login tests' },
    { section_id: 'login-selectors', title: 'Login flow selectors', purpose: 'Locator strategies for auth forms' }
  ]
};

const unrelatedSkill = {
  skill_id: 'css-grid',
  title: 'CSS grid layout patterns',
  tags: ['css', 'layout'],
  supports_tasks: ['responsive_layout'],
  sections: [
    { section_id: 'overview', title: 'Overview', purpose: 'Grid track sizing' }
  ]
};

test('query "playwright login" ranks playwright skill above unrelated', () => {
  const pw = scoreSkillAgainstQuery(playwrightSkill, 'playwright login');
  const other = scoreSkillAgainstQuery(unrelatedSkill, 'playwright login');
  assert.ok(pw > other);
  const ranked = rankSkills('playwright login', [unrelatedSkill, playwrightSkill], 5);
  assert.equal(ranked[0].skill_id, 'playwright-login');
});

test('empty query returns all skills sorted by id', () => {
  const ranked = rankSkills('', [playwrightSkill, unrelatedSkill], 10);
  assert.equal(ranked.length, 2);
  assert.deepEqual(ranked.map((s) => s.skill_id), ['css-grid', 'playwright-login']);
});

test('ordering is deterministic for the same query and indices', () => {
  const a = {
    skill_id: 'alpha',
    title: 'Alpha task helper',
    tags: ['task'],
    supports_tasks: [],
    sections: [{ section_id: 's0', title: 'One', purpose: 'task patterns' }]
  };
  const b = {
    skill_id: 'beta',
    title: 'Beta task helper',
    tags: ['task'],
    supports_tasks: [],
    sections: [{ section_id: 's0', title: 'One', purpose: 'task patterns' }]
  };
  const first = rankSkills('task', [a, b], 5).map((s) => s.skill_id);
  const second = rankSkills('task', [b, a], 5).map((s) => s.skill_id);
  assert.deepEqual(first, second);
});
