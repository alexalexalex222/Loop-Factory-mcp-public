// Req 10: the always-on dashboard exists, is written to disk, carries the
// stop-condition notice, and is the only human Approve / Sludge surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';
import { STOP_CONDITION_WARNING } from '../src/constants.mjs';

test('update_dashboard writes a file containing the stop-condition notice', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd1', task: SPECIFIC_TASK });
  engine.human_review_request({ runId: 'd1', item: { title: 'reworded hero', kind: 'copy', summary: 'tightened the H1' } });
  const r = engine.update_dashboard({ runId: 'd1' });
  assert.equal(r.status, 'OK');
  assert.equal(r.warningIncluded, true);
  assert.equal(r.continuation.required, true);
  const html = readFileSync(r.path, 'utf8');
  assert.ok(html.includes(STOP_CONDITION_WARNING), 'stop-condition notice must be present');
  assert.ok(/Continuation required/i.test(html), 'dashboard must expose pending continuation obligation');
  assert.equal(STOP_CONDITION_WARNING, 'WARNING: You are the stop condition. This loop does not stop until you stop it.');
});

test('the dashboard renders Approve / Sludge / notes affordances and the score matrix', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd2', task: SPECIFIC_TASK });
  engine.human_review_request({ runId: 'd2', item: { title: 'change A', summary: 's' } });
  const r = engine.update_dashboard({ runId: 'd2' });
  const html = readFileSync(r.path, 'utf8');
  assert.ok(/data-act="approve"/.test(html), 'Approve affordance');
  assert.ok(/data-act="sludge"/.test(html), 'Sludge affordance');
  assert.ok(/class="notes"/.test(html), 'notes textarea');
  assert.ok(/Score matrix/i.test(html), 'score matrix section');
});

test('human review queues, but model-callable resolve is blocked as dashboard-only', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd3', task: SPECIFIC_TASK });
  const add = engine.human_review_request({ runId: 'd3', item: { title: 'x' } });
  assert.equal(add.status, 'OK');
  assert.equal(add.reviewAuthority, 'dashboard-only');
  const res = engine.human_review_request({ runId: 'd3', action: 'resolve', reviewId: add.reviewId, decision: 'sludge', notes: 'not it' });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.code, 'DASHBOARD_ONLY');
  assert.equal(res.continuation.required, true);
  const list = engine.human_review_request({ runId: 'd3', action: 'list' });
  assert.equal(list.reviews[0].status, 'PENDING');
  assert.equal(list.reviewAuthority, 'dashboard-only');
  assert.equal(list.continuation.required, true);
});

test('report_export writes a reproducible markdown report', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd4', task: SPECIFIC_TASK });
  const r = engine.report_export({ runId: 'd4' });
  assert.equal(r.status, 'OK');
  assert.equal(r.continuation.required, true);
  const md = readFileSync(r.path, 'utf8');
  assert.ok(/super-loop-mcp campaign report/.test(md));
  assert.ok(/operator is the only stop condition/i.test(md));
  assert.ok(/continuation obligation\*\*: REQUIRED/i.test(md));
});

test('dashboard Approve is not optimistic on file:// — labels local draft instead', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd5', task: SPECIFIC_TASK });
  engine.human_review_request({ runId: 'd5', item: { title: 'promotion candidate', kind: 'promotion', summary: 'win' } });
  const r = engine.update_dashboard({ runId: 'd5' });
  const html = readFileSync(r.path, 'utf8');
  // Script must not flip the chip to APPROVED before confirmed POST; file:// path labels draft.
  assert.match(html, /local draft — export to apply/, 'file:// path labels draft, does not claim APPROVED');
  assert.match(html, /isFileProtocol|location\.protocol === 'file:'/, 'detects file:// protocol');
  // Must not optimistically set APPROVED before fetch resolves
  assert.doesNotMatch(html, /statusEl\.textContent = act === 'approve' \? 'APPROVED'[\s\S]{0,40}postDecision/, 'no optimistic APPROVED before postDecision');
  // Confirmed apply path still sets APPROVED only inside the fetch .then
  assert.match(html, /\.then\(function\(\)\{[\s\S]*?APPROVED/, 'APPROVED only after confirmed POST apply');
});
