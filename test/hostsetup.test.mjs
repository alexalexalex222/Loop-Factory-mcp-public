// A1/A2/A4/A5: the run hands the agent an EXECUTABLE, host-correct startup
// checklist; measurement checkpoints (EXEC_DISABLED, saturation) read as "keep
// going", not "stop"; an explicit drive message starts the run; and a resume
// surfaces a concrete next action. The hard invariant under test: Claude Code's
// convergence driver is /goal (progress-driven) — NOT self-paced /loop.
// (Ref: https://code.claude.com/docs/en/goal — /goal is the right primitive for a
// supervisor-driven campaign; /loop is interval polling or self-paced wake-ups.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK, initThroughBaselineBar } from './helpers.mjs';

function withHost(host, fn) {
  const prev = process.env.SUPER_LOOP_HOST;
  if (host == null) delete process.env.SUPER_LOOP_HOST;
  else process.env.SUPER_LOOP_HOST = host;
  try { return fn(); }
  finally {
    if (prev == null) delete process.env.SUPER_LOOP_HOST;
    else process.env.SUPER_LOOP_HOST = prev;
  }
}

test('A1: Claude hostSetup engages /goal (progress-driven), never self-paced /loop', () => {
  withHost('claude', () => {
    const { engine } = freshEngine();
    const r = engine.initialize_loop_run({ runId: 'h1', task: SPECIFIC_TASK });
    // Canonical registry id (alias "claude" → "claude-code")
    assert.equal(r.hostSetup.host, 'claude-code');
    assert.equal(r.hostSetup.continuousModeCommand, '/goal');
    assert.equal(r.hostSetup.tier, 1);
    assert.equal(r.hostSetup.driverFamily, 'goal_progress');
    const step1 = r.hostSetup.steps[0];
    assert.match(step1, /\/goal/, 'step 1 tells Claude to run /goal');
    assert.match(step1, /objective|operator/i, 'step 1 frames an operator-stop objective');
    // /goal is Claude Code's OWN native command — never mis-frame it as a Codex goal.
    assert.doesNotMatch(step1, /codex goal/i, 'must NOT call it a Codex goal');
    assert.ok(Array.isArray(r.hostSetup.neverStopOn) && r.hostSetup.neverStopOn.length >= 1);
    assert.match(r.hostSetup.neverStopOn.join(' '), /EXEC_DISABLED/);
  });
});

test('A1: Codex hostSetup engages /goal', () => {
  withHost('codex', () => {
    const { engine } = freshEngine();
    const r = engine.initialize_loop_run({ runId: 'h2', task: SPECIFIC_TASK });
    assert.equal(r.hostSetup.host, 'codex');
    assert.equal(r.hostSetup.continuousModeCommand, '/goal');
    assert.equal(r.hostSetup.tier, 1);
    assert.match(r.hostSetup.steps[0], /\/goal/, 'step 1 tells Codex to use /goal');
  });
});

test('A1: SUPER_LOOP_HOST=cursor resolves through registry (setupHint + tier 2)', () => {
  withHost('cursor', () => {
    const { engine } = freshEngine();
    const r = engine.initialize_loop_run({ runId: 'h-cursor', task: SPECIFIC_TASK });
    assert.equal(r.hostSetup.host, 'cursor');
    assert.equal(r.hostSetup.driverFamily, 'mcp_reactive');
    assert.equal(r.hostSetup.tier, 2);
    assert.equal(r.hostSetup.continuousModeCommand, null);
    assert.ok(typeof r.hostSetup.setupHint === 'string' && /cursor|rules|continuation/i.test(r.hostSetup.setupHint));
    assert.match(r.hostSetup.steps[0], /cursor|rules|continuation/i);
  });
});

test('A1: unknown host names both /loop and /goal', () => {
  withHost(null, () => {
    const { engine } = freshEngine();
    const r = engine.initialize_loop_run({ runId: 'h3', task: SPECIFIC_TASK });
    assert.equal(r.hostSetup.host, 'unknown');
    assert.match(r.hostSetup.steps[0], /\/loop/);
    assert.match(r.hostSetup.steps[0], /\/goal/);
  });
});

test('A1: hostSetup is also present alongside the ask-once questions', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'h4', task: 'improve my loop' });
  assert.ok(Array.isArray(r.questions), 'still asks for a vague task');
  assert.ok(r.hostSetup && Array.isArray(r.hostSetup.steps), 'hostSetup shipped with the questions too');
});

test('A4: an explicit "find it, use it, keep going" message starts the run with surfaced assumptions', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({
    runId: 'a4a',
    task: 'I just got super loop. Find it, use it, keep going until I stop you.'
  });
  assert.equal(r.status, 'OK');
  assert.equal(r.runStatus, 'INITIALIZED');
  assert.equal(r.questions, undefined, 'drive intent skips the questionnaire');
  assert.ok(Array.isArray(r.assumptions) && r.assumptions.length >= 2, 'defaults are surfaced, not hidden');
  assert.match(r.assumptions.join(' '), /did not run the ask-once|infer/i);
});

test('A4 is narrow: plain "improve my loop" still asks (no fabricated start)', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'a4b', task: 'improve my loop', userMessages: ['improve my loop'] });
  assert.ok(Array.isArray(r.questions), 'vague task still asks');
  assert.equal(r.assumptions, undefined, 'no inferred-start assumptions for a vague task');
});

test('A5: a resume surfaces a concrete next action + hostSetup', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'a5', task: SPECIFIC_TASK });
  const again = engine.initialize_loop_run({ runId: 'a5', task: SPECIFIC_TASK });
  assert.match(again.message, /Already initialized/i);
  assert.equal(typeof again.next, 'string');
  assert.match(again.next, /Next:\s*loop_start/, 'resume points at the concrete next tool, not generic prose');
  assert.ok(again.hostSetup && Array.isArray(again.hostSetup.steps));
  // the structured continuation.next object is still there for machine readers
  assert.ok(again.continuation && again.continuation.next);
});

test('A2: EXEC_DISABLED is a CHECKPOINT (campaignContinues + concrete next), not a stop', () => {
  delete process.env.SUPER_LOOP_ALLOW_EXEC;
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'a2a');
  const reg = engine.register_hypotheses({
    runId: 'a2a',
    hypotheses: ['claude-opus-4-8', 'gpt-5.5', 'glm-5.2'].map((m, i) => ({ title: `h${i}`, bottleneck: 'b', operation: 'o', route: { model: m } }))
  });
  const r = engine.execute_full_test({
    runId: 'a2a', hypothesisId: reg.hypothesisIds[0],
    routes: ['claude-opus-4-8', 'claude-opus-4-8', 'claude-opus-4-8'], prompt: 'run the loop'
  });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'EXEC_DISABLED');
  assert.equal(r.campaignContinues, true, 'the cliff is explicitly a checkpoint');
  assert.ok(r.next && r.next.tool, 'a concrete fallback action is provided');
  assert.match(r.message, /checkpoint, not a stop/i);
});

test('A2: report_saturation explicitly continues the campaign', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'a2b', task: SPECIFIC_TASK });
  const r = engine.report_saturation({ runId: 'a2b', evidence: 'final confirmation batch changed nothing' });
  assert.equal(r.status, 'OK');
  assert.equal(r.campaignContinues, true);
  assert.equal(r.autoTransitioned, true);
});

// ---- Step 5: hostSetup step 3 is campaign-path aware ----------------------
// Design choice (documented here): the path is an EXPLICIT inferred field stored on
// state.task.path — improve / mine / discover — not a blanket default flip. When no
// signal is present the path stays null and step 3 offers BOTH loops (no regression).
const step3of = (r) => r.hostSetup.steps[2];

test('Step 5: an improve-first answer makes step 3 lead with loop-de-loop and stores path=improve', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 's5a', task: 'make it better' }); // → questions
  const r = engine.initialize_loop_run({ runId: 's5a', answers: ['precision up', 'improve my existing loop file', 'fewer tokens same quality', 'keep authorship', 'keep moving'] });
  const step3 = step3of(r);
  assert.match(step3, /loop-de-loop/);
  assert.match(step3, /loop_start/);
  assert.ok(step3.indexOf('loop-de-loop') < step3.indexOf('strip-miner'), 'improve leads; strip-miner is the alternate');
  assert.equal(store.load('s5a').task.path, 'improve', 'path stored on state');
});

test('Step 5: a mine-first answer makes step 3 lead with strip-miner (path=mine)', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 's5b', task: 'make it better' });
  const r = engine.initialize_loop_run({ runId: 's5b', answers: ['a stronger loop', 'mine my whole history', 'best first', 'keep authorship', 'keep moving'] });
  const step3 = step3of(r);
  assert.match(step3, /strip-miner/);
  assert.ok(step3.indexOf('strip-miner') < step3.indexOf('loop-de-loop'), 'mine leads');
  assert.equal(store.load('s5b').task.path, 'mine');
});

test('Step 5: a discover answer scopes step 3 to a narrow strip-miner (path=discover)', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 's5d', task: 'make it better' });
  const r = engine.initialize_loop_run({ runId: 's5d', answers: ['a usable loop', 'discover a new loop, scout the public library', 'best first', 'keep authorship', 'keep moving'] });
  const step3 = step3of(r);
  assert.match(step3, /strip-miner/);
  assert.match(step3, /narrow|thin corpus|library|do not deep-mine/i);
  assert.equal(store.load('s5d').task.path, 'discover');
});

test('Step 5: a path-neutral vague task keeps step 3 offering BOTH loops (no regression)', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 's5n', task: 'help me with my workflow' }); // stays AWAITING_ANSWERS
  assert.ok(Array.isArray(r.questions), 'still asks for a vague task');
  const step3 = step3of(r);
  assert.match(step3, /strip-miner/);
  assert.match(step3, /loop-de-loop/);
});
