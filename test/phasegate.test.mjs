// Req 5: phase-gated streaming. The full loop stays inside the MCP; the next
// section only unlocks after the current section has recorded evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';
import { loadLoop } from '../src/loops.mjs';

function initActive(engine, runId) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
}

test('loop_start streams ONLY section 0, not the whole loop', () => {
  const { engine } = freshEngine();
  initActive(engine, 'p1');
  const r = engine.loop_start({ runId: 'p1', loop: 'strip-miner' });
  assert.equal(r.status, 'OK');
  assert.equal(r.phase, 0);
  assert.ok(r.totalPhases > 1);
  const whole = loadLoop('strip-miner').text;
  assert.ok(r.section.length < whole.length, 'a single section must be smaller than the whole loop');
  assert.ok(r.section.includes('/loop loop-de-loop'));
});

test('request_next_phase is BLOCKED (PHASE_SKIP) without evidence', () => {
  const { engine } = freshEngine();
  initActive(engine, 'p2');
  engine.loop_start({ runId: 'p2', loop: 'strip-miner' });
  const r = engine.request_next_phase({ runId: 'p2' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'PHASE_SKIP');
  assert.equal(r.phase, 0);
});

test('recording evidence unlocks the next section', () => {
  const { engine } = freshEngine();
  initActive(engine, 'p3');
  engine.loop_start({ runId: 'p3', loop: 'strip-miner' });
  const ev = engine.observation_record({ runId: 'p3', loop: 'strip-miner', phase: 0, summary: 'mapped accessible sources' });
  assert.equal(ev.status, 'OK');
  assert.deepEqual(ev.evidenceFor, { loop: 'strip-miner', phase: 0 });
  const r = engine.request_next_phase({ runId: 'p3' });
  assert.equal(r.status, 'OK');
  assert.equal(r.phase, 1);
});

test('artifact_record can also satisfy the phase gate', () => {
  const { engine } = freshEngine();
  initActive(engine, 'p3b');
  engine.loop_start({ runId: 'p3b', loop: 'strip-miner' });
  engine.artifact_record({ runId: 'p3b', loop: 'strip-miner', phase: 0, name: 'coverage', content: 'coverage map' });
  const r = engine.request_next_phase({ runId: 'p3b' });
  assert.equal(r.status, 'OK');
  assert.equal(r.phase, 1);
});

test('request_next_phase before loop_start is BLOCKED (NO_ACTIVE_LOOP)', () => {
  const { engine } = freshEngine();
  initActive(engine, 'p4');
  const r = engine.request_next_phase({ runId: 'p4' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'NO_ACTIVE_LOOP');
});

test('streaming to the end is not campaign completion', () => {
  const { engine } = freshEngine();
  initActive(engine, 'p5');
  const total = loadLoop('strip-miner').sections.length;
  engine.loop_start({ runId: 'p5', loop: 'strip-miner' });
  for (let i = 0; i < total; i++) {
    engine.observation_record({ runId: 'p5', loop: 'strip-miner', phase: i, summary: `phase ${i} done` });
    const r = engine.request_next_phase({ runId: 'p5' });
    if (r.streamComplete) {
      assert.match(r.message, /not campaign completion/i);
      return;
    }
  }
  assert.fail('never reached stream completion');
});
