// Step C: an explicit drive message that arrives via userMessages with no `task` string
// (the run-1d313906 shape — task.text was "") must still ANCHOR an objective from the
// operator's own message, so the run isn't driven with a blank goal/path. Never fabricate
// one; a vague message with no drive language still asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine } from './helpers.mjs';

test('drive-intent with empty task anchors the objective from userMessages', () => {
  const { engine, store } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'di1', userMessages: ['find and use super loop and just go, keep going until I stop you'] });
  assert.equal(r.runStatus, 'INITIALIZED', 'explicit drive language starts the run');
  assert.equal(r.questions, undefined, 'no ask-once questionnaire');
  const s = store.load('di1');
  assert.ok(s.task.text && s.task.text.trim().length > 0, 'objective anchored from the operator message (no blank task)');
  assert.match(s.task.sha256, /^[0-9a-f]{64}$/, 'task hash set');
});

test('a vague message with no drive language still asks (anchoring is drive-only, never fabricated)', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'di2', userMessages: ['help me with my workflow'] });
  assert.ok(Array.isArray(r.questions), 'vague → still asks; no fabricated objective');
});
