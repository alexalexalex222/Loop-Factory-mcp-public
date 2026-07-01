// campaignContinues heartbeat: additive open-run signal, distinct from continuation.required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, BASELINE_BODY } from './helpers.mjs';

test('INITIALIZED responses carry campaignContinues without forcing continuation.required', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({
    runId: 'hb-init',
    task: 'Improve my code-review loop with measured cost wins.',
    answers: ['better reviews', 'improve existing loop', 'code review', 'whole history', 'lower tokens', 'keep authorship', 'keep moving']
  });
  assert.equal(r.status, 'OK');
  assert.equal(r.runStatus, 'INITIALIZED');
  assert.equal(r.campaignContinues, true);
  assert.equal(r.continuation.required, false);
  assert.ok(r.continuation.next && r.continuation.next.tool);
});

test('progress clears continuation.required but campaignContinues stays true while open', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({
    runId: 'hb-prog',
    task: 'Improve precision by at least 10% under benchmark cost.',
    answers: ['better', 'improve existing loop', 'x', 'whole history', 'quality', 'keep authorship', 'keep moving']
  });
  const blocked = engine.cycle_decision_request({ runId: 'hb-prog', intent: 'mark_complete' });
  assert.equal(blocked.continuation.required, true);
  assert.equal(blocked.campaignContinues, true);

  const progressed = engine.artifact_record({ runId: 'hb-prog', role: 'baseline', content: BASELINE_BODY });
  assert.equal(progressed.continuation.required, false);
  assert.equal(progressed.campaignContinues, true);
});

test('library-level tools do not carry campaignContinues', () => {
  const { engine } = freshEngine();
  const lib = engine.loop_library({});
  assert.equal(lib.campaignContinues, undefined);
  const det = engine.host_runtime_detect({});
  assert.equal(det.campaignContinues, undefined);
});

test('ACTIVE loop_start carries campaignContinues', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({
    runId: 'hb-loop',
    task: 'Improve precision by at least 10% under benchmark cost.',
    answers: ['better', 'improve existing loop', 'x', 'whole history', 'quality', 'keep authorship', 'keep moving']
  });
  const s = engine.loop_start({ runId: 'hb-loop', loop: 'loop-de-loop' });
  assert.equal(s.runStatus, 'ACTIVE');
  assert.equal(s.campaignContinues, true);
});
