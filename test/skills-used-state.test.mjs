// skillsUsed pin array on fresh runs and backward-compatible load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

function skillsUsedFor(state) {
  return Array.isArray(state.skillsUsed) ? state.skillsUsed : [];
}

test('a fresh run initializes skillsUsed as an empty array', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'SU1', task: SPECIFIC_TASK });
  const state = store.load('SU1');
  assert.deepEqual(state.skillsUsed, []);
});

test('runs saved before skillsUsed tolerate a missing field', () => {
  const { store } = freshEngine();
  const legacy = {
    runId: 'legacy',
    version: 1,
    status: 'INITIALIZED',
    trajectory: []
  };
  store.save(legacy);
  const loaded = store.load('legacy');
  assert.equal(loaded.skillsUsed, undefined);
  assert.deepEqual(skillsUsedFor(loaded), []);
});
