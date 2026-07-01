// Leak #1: a first-class LOCAL loop library. Users add their own loops to the
// local MCP; they hash-lock, get safe ids, persist locally, and stream through the
// exact same phase gate as the mandated loops — which they can never overwrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

const CUSTOM = [
  '# INTAKE', 'Read the operator goal and the frozen benchmark first.',
  '', '# MEASURE', 'Run the candidate and record the raw log so the MCP derives the cost.',
  '', '# DECIDE', 'Promote only on tool-computed, reverified movement; else continue.'
].join('\n');

test('a custom loop registers, hash-locks, and reports phase-gated sections', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'L1', task: SPECIFIC_TASK });
  const r = engine.loop_register({ runId: 'L1', id: 'my-loop', title: 'My Loop', content: CUSTOM });
  assert.equal(r.status, 'OK');
  assert.equal(r.loop.id, 'my-loop');
  assert.equal(r.loop.origin, 'custom');
  assert.ok(r.loop.sections >= 2, 'must split into >=2 streamable phases');
  assert.match(r.loop.sha256, /^[0-9a-f]{64}$/);
  // persisted locally under the home dir
  assert.deepEqual(store.listLoops(), ['my-loop']);
});

test('a custom loop cannot overwrite a mandated hash-locked loop', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'L2', task: SPECIFIC_TASK });
  for (const id of ['strip-miner', 'loop-de-loop', 'loop-hardener', 'loop-2']) {
    const r = engine.loop_register({ runId: 'L2', id, content: CUSTOM });
    assert.equal(r.status, 'BLOCKED', `${id} must be refused`);
    assert.equal(r.code, 'LOOP_EXISTS');
  }
});

test('a too-small source and a path-like id are refused', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'L3', task: SPECIFIC_TASK });
  const small = engine.loop_register({ runId: 'L3', id: 'tiny', content: 'hi' });
  assert.equal(small.status, 'BLOCKED');
  assert.equal(small.code, 'LOOP_SOURCE');
  const traversal = engine.loop_register({ runId: 'L3', id: '../evil', content: CUSTOM });
  assert.equal(traversal.status, 'BLOCKED');
  assert.equal(traversal.code, 'BAD_INPUT');
});

test('re-registering identical bytes is idempotent; different bytes need overwrite', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'L4', task: SPECIFIC_TASK });
  assert.equal(engine.loop_register({ runId: 'L4', id: 'dup', content: CUSTOM }).status, 'OK');
  assert.equal(engine.loop_register({ runId: 'L4', id: 'dup', content: CUSTOM }).status, 'OK'); // same bytes → OK
  const changed = engine.loop_register({ runId: 'L4', id: 'dup', content: CUSTOM + '\n# EXTRA\nmore' });
  assert.equal(changed.status, 'BLOCKED');
  assert.equal(changed.code, 'LOOP_EXISTS');
  const forced = engine.loop_register({ runId: 'L4', id: 'dup', content: CUSTOM + '\n# EXTRA\nmore', overwrite: true });
  assert.equal(forced.status, 'OK');
});

test('loop_library lists the 2 mandated loops plus custom ones', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'L5', task: SPECIFIC_TASK });
  engine.loop_register({ runId: 'L5', id: 'extra', title: 'Extra', content: CUSTOM });
  const lib = engine.loop_library({ runId: 'L5' });
  assert.equal(lib.status, 'OK');
  assert.equal(lib.mandated.length, 2);
  assert.ok(lib.mandated.every((m) => m.hashLocked === true));
  assert.ok(lib.custom.some((c) => c.id === 'extra' && c.hashLocked === true));
});

test('a registered custom loop streams phase-gated exactly like a mandated loop', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'L6', task: SPECIFIC_TASK });
  engine.loop_register({ runId: 'L6', id: 'streamy', content: CUSTOM });
  const s0 = engine.loop_start({ runId: 'L6', loop: 'streamy' });
  assert.equal(s0.status, 'OK');
  assert.equal(s0.phase, 0);
  assert.ok(s0.totalPhases >= 2);
  const skip = engine.request_next_phase({ runId: 'L6', loop: 'streamy' });
  assert.equal(skip.status, 'BLOCKED');
  assert.equal(skip.code, 'PHASE_SKIP');
  engine.observation_record({ runId: 'L6', loop: 'streamy', phase: 0, summary: 'did the intake' });
  const s1 = engine.request_next_phase({ runId: 'L6', loop: 'streamy' });
  assert.equal(s1.status, 'OK');
  assert.equal(s1.phase, 1);
});

test('streaming a custom loop pins an immutable snapshot for the run', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'L7', task: SPECIFIC_TASK });
  engine.loop_register({ runId: 'L7', id: 'pinned', content: CUSTOM });
  engine.loop_start({ runId: 'L7', loop: 'pinned' });
  const state = store.load('L7');
  assert.ok(state.customLoops && state.customLoops.pinned, 'run pins the custom loop record');
  assert.match(state.customLoops.pinned.sha256, /^[0-9a-f]{64}$/);
});

test('explicit unknown loop names never fall back to the active loop', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'L8', task: SPECIFIC_TASK });
  engine.loop_start({ runId: 'L8', loop: 'strip-miner' });

  const obs = engine.observation_record({ runId: 'L8', loop: 'missing-loop', phase: 0, summary: 'should not attach to active loop' });
  assert.equal(obs.status, 'BLOCKED');
  assert.equal(obs.code, 'UNKNOWN_LOOP');

  const art = engine.artifact_record({ runId: 'L8', loop: 'missing-loop', phase: 0, content: 'should not attach to active loop' });
  assert.equal(art.status, 'BLOCKED');
  assert.equal(art.code, 'UNKNOWN_LOOP');

  const next = engine.request_next_phase({ runId: 'L8', loop: 'missing-loop' });
  assert.equal(next.status, 'BLOCKED');
  assert.equal(next.code, 'UNKNOWN_LOOP');

  const state = store.load('L8');
  assert.deepEqual(state.loops['strip-miner'].evidence, {}, 'bad loop evidence must not land on the active loop');
});

test('explicit custom-loop evidence attaches to that loop even when another loop is active', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'L9', task: SPECIFIC_TASK });
  engine.loop_register({ runId: 'L9', id: 'custom-a', content: CUSTOM });
  engine.loop_start({ runId: 'L9', loop: 'custom-a' });
  engine.loop_start({ runId: 'L9', loop: 'strip-miner' });

  const art = engine.artifact_record({ runId: 'L9', loop: 'custom-a', phase: 0, content: 'custom phase zero evidence' });
  assert.equal(art.status, 'OK');
  assert.deepEqual(art.evidenceFor, { loop: 'custom-a', phase: 0 });

  const customNext = engine.request_next_phase({ runId: 'L9', loop: 'custom-a' });
  assert.equal(customNext.status, 'OK');
  assert.equal(customNext.phase, 1);

  const activeNext = engine.request_next_phase({ runId: 'L9', loop: 'strip-miner' });
  assert.equal(activeNext.status, 'BLOCKED');
  assert.equal(activeNext.code, 'PHASE_SKIP');
});
