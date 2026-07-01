// STEP 6 — skill-hardening flywheel: one hardening pass wired through the EXISTING gates.
// A floor-clean candidate, once the operator Approves it on the dashboard, bumps the canonical
// version, archives the prior one (never deletes), and emits a lineage record. A placeholder or
// malformed candidate is rejected by the reused STEP 1 floor / skill-schema validation — and the
// flywheel adds no new verdict logic of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { freshEngine } from './helpers.mjs';
import {
  proposeSkillHardening,
  applySkillHardening,
  readLineage
} from '../scripts/flywheel-harden.mjs';

// Valid skill: 3 `##` headers (clears the integrity floor) + a `_synthesis` override section
// (required by validateSkillRecord) + license/source + comfortably over the 200-token floor.
const SKILL_V1 = `---
skill_id: demo-skill
title: Demo verification skill
version: 1
license: MIT
source: operator:hand-authored:2026-06-28
skillPartition: working
---

## Overview
<!-- section_id: overview purpose: when to use this skill -->

Use this when a task produces an answer you can check a second, independent way. The rule it
follows from is simple: do not trust a single result that merely looks right; confirm it by a
different route before you report it. The first number is a draft, not the answer.

## Method
<!-- section_id: method purpose: the core procedure -->

Restate the problem precisely, compute the result with the most exact tool available, then verify
it independently — substitute back, re-derive, or enumerate a small case by hand. Keep full
precision until the final step and round exactly once when you report the value.

## Synthesis — adapt, do not copy
<!-- section_id: _synthesis purpose: adaptation rules -->

Apply the compute-then-verify discipline to the operator's real task. The examples are stand-ins;
run the actual numbers and confirm every answer a second, independent way before reporting it.
`;

// Genuine improvement: a different body (so the body sha changes and the prior version archives).
const SKILL_V2 = `---
skill_id: demo-skill
title: Demo verification skill
version: 1
license: MIT
source: operator:hand-authored:2026-06-28
skillPartition: working
---

## Overview
<!-- section_id: overview purpose: when to use this skill -->

Use this when a task produces an answer you can check a second, independent way. The rule it
follows from is simple: do not trust a single result that merely looks right; confirm it by a
different route before you report it. The first number is a draft, not the answer.

## Method
<!-- section_id: method purpose: the core procedure -->

Restate the problem precisely, compute the result with the most exact tool available, then verify
it independently — substitute back, re-derive, or enumerate a small case by hand. Keep full
precision until the final step and round exactly once when you report the value.

## Pitfalls
<!-- section_id: pitfalls purpose: traps that produce confident wrong answers -->

Watch for float-equality comparisons, silent overflow or NaN, off-by-one ranges, unseeded
randomness, and — most expensive — perfectly computing the wrong problem. Restate the setup and
confirm it against the question before trusting any output.

## Synthesis — adapt, do not copy
<!-- section_id: _synthesis purpose: adaptation rules -->

Apply the compute-then-verify discipline to the operator's real task. The examples are stand-ins;
run the actual numbers and confirm every answer a second, independent way before reporting it.
`;

// Valid schema (license/source/_synthesis) but a placeholder body → the STEP 1 floor must reject it.
const SKILL_PLACEHOLDER = `---
skill_id: demo-skill
title: Demo verification skill
version: 1
license: MIT
source: operator:hand-authored:2026-06-28
---

## Synthesis — adapt, do not copy
<!-- section_id: _synthesis purpose: adaptation rules -->

TODO: write the real hardening content here later.
`;

// Missing the required _synthesis section → skill-schema validation must reject it.
const SKILL_MALFORMED = `---
skill_id: demo-skill
title: Demo verification skill
version: 1
license: MIT
source: operator:hand-authored:2026-06-28
---

## Overview

Real prose with enough length and three header lines to clear the integrity floor on its own, yet
it omits the required synthesis section so the skill-schema validator must reject it as malformed.

## Method

More than enough additional text here to comfortably exceed the two-hundred-token integrity floor,
ensuring the rejection comes from the schema check and not from a too-shallow body verdict.

## Pitfalls

A third section so the header count clears three; still no synthesis section anywhere in the body.
`;

function registerV1(engine) {
  const reg = engine.loop_register({ role: 'skill', id: 'demo-skill', content: SKILL_V1 });
  assert.equal(reg.status, 'OK');
  assert.equal(reg.skill.version, 1);
  return reg.skill.sha256;
}

test('hardening pass: floor-clean candidate, operator approves → version bumps, prior archived, lineage emitted', () => {
  const { engine, store } = freshEngine();
  const v1sha = registerV1(engine);

  const prop = proposeSkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard1', improvedContent: SKILL_V2 });
  assert.equal(prop.status, 'PROPOSED');
  assert.equal(prop.from_version, 1);
  assert.equal(prop.to_version, 2);
  assert.equal(prop.from_sha, v1sha);

  // STEP 2 gate: applying before the operator approves is refused.
  const early = applySkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard1', reviewId: prop.reviewId, improvedContent: SKILL_V2 });
  assert.equal(early.status, 'BLOCKED');
  assert.equal(early.code, 'PROMOTION_NEEDS_APPROVAL');
  assert.equal(store.readIndex('demo-skill').version, 1, 'no bump before approval');

  // Operator approves out of band — the existing dashboard gate, exactly as for any review.
  engine.operator.applyDashboardDecisions({ runId: 'hard1', decisions: { [prop.reviewId]: { decision: 'approve' } } });

  const applied = applySkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard1', reviewId: prop.reviewId, improvedContent: SKILL_V2 });
  assert.equal(applied.status, 'PROMOTED');
  assert.equal(applied.from_version, 1);
  assert.equal(applied.to_version, 2);
  assert.equal(applied.from_sha, v1sha);
  assert.notEqual(applied.to_sha, v1sha, 'a genuine body change yields a new sha');

  // Live skill is now v2.
  const idx = store.readIndex('demo-skill');
  assert.equal(idx.version, 2);
  assert.equal(idx.sha256, applied.to_sha);

  // Prior version archived (never deleted).
  const archiveDir = join(dirname(store.skillPath('demo-skill')), 'archive');
  const archived = readdirSync(archiveDir).filter((f) => f.startsWith('demo-skill-v1-') && f.endsWith('.md'));
  assert.equal(archived.length, 1, 'the prior v1 must be archived');

  // Lineage emitted.
  const lineage = readLineage(store, 'demo-skill');
  assert.equal(lineage.length, 1);
  assert.deepEqual(
    { from_version: lineage[0].from_version, to_version: lineage[0].to_version, from_sha: lineage[0].from_sha, to_sha: lineage[0].to_sha, runId: lineage[0].runId },
    { from_version: 1, to_version: 2, from_sha: v1sha, to_sha: applied.to_sha, runId: 'hard1' }
  );
  assert.ok(lineage[0].promoted_at, 'lineage carries a promotion timestamp');
});

test('hardening pass: placeholder candidate is rejected by the reused STEP 1 integrity floor', () => {
  const { engine, store } = freshEngine();
  registerV1(engine);
  const prop = proposeSkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-ph', improvedContent: SKILL_PLACEHOLDER });
  assert.equal(prop.status, 'BLOCKED');
  assert.match(prop.code, /^BASELINE_(PLACEHOLDER|TOO_SHALLOW)$/);
  assert.equal(store.readIndex('demo-skill').version, 1, 'a rejected candidate never changes the skill');
});

test('hardening pass: malformed candidate (no _synthesis) is rejected by skill-schema validation', () => {
  const { engine, store } = freshEngine();
  registerV1(engine);
  const prop = proposeSkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-mal', improvedContent: SKILL_MALFORMED });
  assert.equal(prop.status, 'BLOCKED');
  assert.equal(prop.code, 'SKILL_MALFORMED');
});

test('hardening pass: unknown skill is refused', () => {
  const { engine, store } = freshEngine();
  const prop = proposeSkillHardening(engine, store, { skillId: 'no-such-skill', runId: 'hard-x', improvedContent: SKILL_V2 });
  assert.equal(prop.status, 'BLOCKED');
  assert.equal(prop.code, 'UNKNOWN_SKILL');
});

test('hardening pass: operator Sludge blocks the version bump', () => {
  const { engine, store } = freshEngine();
  registerV1(engine);
  const prop = proposeSkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-sl', improvedContent: SKILL_V2 });
  assert.equal(prop.status, 'PROPOSED');
  engine.operator.applyDashboardDecisions({ runId: 'hard-sl', decisions: { [prop.reviewId]: { decision: 'sludge' } } });
  const applied = applySkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-sl', reviewId: prop.reviewId, improvedContent: SKILL_V2 });
  assert.equal(applied.status, 'BLOCKED');
  assert.equal(applied.code, 'PROMOTION_REJECTED');
  assert.equal(store.readIndex('demo-skill').version, 1);
});

test('hardening pass: re-applying an approved review is idempotent (no double bump, one lineage record)', () => {
  const { engine, store } = freshEngine();
  registerV1(engine);
  const prop = proposeSkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-idem', improvedContent: SKILL_V2 });
  engine.operator.applyDashboardDecisions({ runId: 'hard-idem', decisions: { [prop.reviewId]: { decision: 'approve' } } });
  const first = applySkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-idem', reviewId: prop.reviewId, improvedContent: SKILL_V2 });
  assert.equal(first.status, 'PROMOTED');
  const second = applySkillHardening(engine, store, { skillId: 'demo-skill', runId: 'hard-idem', reviewId: prop.reviewId, improvedContent: SKILL_V2 });
  assert.equal(second.status, 'OK');
  assert.equal(second.code, 'ALREADY_APPLIED');
  assert.equal(store.readIndex('demo-skill').version, 2, 'no second bump');
  assert.equal(readLineage(store, 'demo-skill').length, 1, 'one lineage record only');
});
