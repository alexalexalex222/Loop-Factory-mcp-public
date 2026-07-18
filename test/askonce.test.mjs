// Req 4: ask-once. A brief explanation first, then a few short questions when the
// task is underspecified; never asks again after init; user messages stored
// locally with sha256 hashes. Operator-scope questions include ONE friendly
// model-choice question; promotion mode / benchmark policy / standing guarantees
// remain tool-owned and are never posed back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';
import { DEFAULT_PRIMARY_MODEL } from './fixtures/model-policy.mjs';

test('vague task returns a brief explanation + a few short questions exactly once', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'r1', task: 'improve my loop', userMessages: ['improve my loop'] });
  assert.equal(r.status, 'OK');
  assert.equal(r.runId, 'r1');
  assert.ok(Array.isArray(r.questions));
  assert.ok(r.questions.length >= 5 && r.questions.length <= 8, `expected 5-8 short questions, got ${r.questions.length}`);
  const qblob = r.questions.join('\n');
  // the two operator-scope questions must be present, with the runtime warning
  assert.match(qblob, /whole .*history|set number of loops/i, 'asks the mine-scope question (whole history vs a set number)');
  assert.match(qblob, /best loops first|order found|in the order/i, 'asks the improvement-order question');
  assert.match(qblob, /hours, days, or weeks/i, 'warns the run can take hours/days/weeks');
  // Step 6: the path picker is first-class (improve / discover / mine) and the
  // loop-library scout question is present.
  assert.match(qblob, /improve[\s\S]*discover[\s\S]*mine/i, 'offers the path picker (improve / discover / mine)');
  assert.match(qblob, /scout.*library|loop library/i, 'asks the loop-library scout question');
  // on-start native-continuation notice, so the runtime does not stop the run early.
  // Both tokens stay present: /goal is the convergence driver (Claude Code + Codex),
  // /loop is named only as Claude's polling/self-paced alternate.
  assert.match(r.nativeContinuation, /\/goal/, 'names /goal as the convergence driver');
  assert.match(r.nativeContinuation, /\/loop/, 'still names /loop (Claude polling/self-paced alternate)');
  // Explain-first: the brief must arrive with the questions so the operator knows how to answer.
  assert.ok(typeof r.explanation === 'string' && r.explanation.length > 80, 'a brief explanation is included');
  assert.match(r.briefing, /dashboard is always on/i);
  assert.match(r.briefing, /improve or harden/i);
  assert.equal(r.dashboardAlwaysOn, true);
  assert.equal(r.continuation.required, false);
});

test('ask-once asks ONE model question; never promotion mode / subjective routing / standing guarantees', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'rpol', task: 'improve my loop' });
  const blob = r.questions.join('\n');
  // Model choice IS asked (friendly, enter = defaults).
  assert.match(blob, /which models do you want to use/i, 'asks the operator which models to use');
  assert.match(blob, /defaults|any model/i, 'offers defaults and any-model escape hatch');
  // These model-internal policy choices must still NOT be posed back.
  assert.doesNotMatch(blob, /promotion mode/i, 'must not ask the operator to choose promotion mode');
  assert.doesNotMatch(blob, /\bdeterministic\b[\s\S]*\bsubjective\b|\bsubjective\b[\s\S]*\bdeterministic\b/i, 'must not pose deterministic-vs-subjective as an operator choice');
  assert.doesNotMatch(blob, /char ?cap|≤?\s*3000\s*char|3000\s*char/i, 'must never introduce a 3000-char cap');
  // Explanation: operator chooses models; supervisor owns measurement/integrity/promotion.
  assert.match(r.explanation, /you choose the models/i);
  assert.match(r.explanation, /supervisor still owns measurement, integrity, and promotion/i);
  assert.match(r.explanation, /you decide the goal/i);
});

test('Step 6: the ask-once path picker is offered up front (improve / discover / mine)', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'q6', task: 'help me with my workflow' });
  const q = r.questions;
  assert.ok(q.length >= 5 && q.length <= 8, `5-8 questions, got ${q.length}`);
  assert.match(q[1], /improve/i, 'path picker is the second question');
  assert.match(q[1], /discover|find/i);
  assert.match(q[1], /mine/i);
  assert.match(q.join('\n'), /scout.*library|loop library/i, 'library-scout question present');
});

test('answers move the run to INITIALIZED and never re-ask', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r2', task: 'make it better' });
  const r2 = engine.initialize_loop_run({ runId: 'r2', answers: ['precision up 10%', 'my loop file', 'fewer tokens, same pass rate', 'keep my authorship', 'keep moving'] });
  assert.equal(r2.status, 'OK');
  assert.equal(r2.questions, undefined); // no more questions
  // a third call must not ask again
  const r3 = engine.initialize_loop_run({ runId: 'r2', task: 'make it better' });
  assert.equal(r3.questions, undefined);
  assert.match(r3.message, /Already initialized/i);
});

test('a specific task initializes immediately with no questions', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'r3', task: SPECIFIC_TASK });
  assert.equal(r.status, 'OK');
  assert.equal(r.questions, undefined);
  assert.match(r.message, /Initialized/);
  assert.equal(r.dashboardAlwaysOn, true);
  assert.match(r.briefing, /dashboard is always on/i);
});

test('user messages are stored locally with sha256 hashes', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r4', task: SPECIFIC_TASK, userMessages: ['msg one', 'msg two', 'stop stalling build the real thing'] });
  const state = store.load('r4');
  assert.equal(state.userMessages.length, 3);
  for (const m of state.userMessages) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof m.text, 'string');
  }
});

test('banned requested model holds at AWAITING_ANSWERS with needsConfirmation — never silent rewrite or silent accept', () => {
  const { engine, store } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'r5', task: SPECIFIC_TASK, model: 'claude-haiku-4-5' });
  assert.equal(r.status, 'OK');
  assert.equal(r.needsConfirmation, true, 'must surface needsConfirmation');
  assert.equal(r.runStatus, 'AWAITING_ANSWERS', 'must NOT proceed to INITIALIZED');
  assert.ok(r.confirmation && r.confirmation.requested === 'claude-haiku-4-5');
  assert.match(r.confirmation.reason, /haiku|banned|non-frontier/i);
  assert.ok(r.confirmation.options && r.confirmation.options.useAnyway);
  assert.ok(Array.isArray(r.questions) && r.questions.length === 1, 'exactly ONE confirmation question');
  assert.match(r.questions[0], /use it anyway|defaults/i);
  const state = store.load('r5');
  assert.equal(state.status, 'AWAITING_ANSWERS');
  assert.ok(state.pendingModelConfirmation);
  // Live primary is NOT the banned choice (gates must not run on it yet).
  assert.notEqual(state.config.model.primary, 'claude-haiku-4-5');
  assert.equal(state.config.modelPolicy.banlist.mode, 'default');
});

test('model confirmation: "use it anyway" sets banlist off and keeps requested primary — never re-asks', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r5c', task: SPECIFIC_TASK, model: 'claude-haiku-4-5' });
  const r = engine.initialize_loop_run({ runId: 'r5c', answers: ['use it anyway'] });
  assert.equal(r.status, 'OK');
  assert.equal(r.needsConfirmation, false);
  assert.equal(r.runStatus, 'INITIALIZED');
  assert.equal(r.questions, undefined);
  assert.equal(store.load('r5c').config.model.primary, 'claude-haiku-4-5');
  assert.equal(store.load('r5c').config.modelPolicy.banlist.mode, 'off');
  // Third call must not re-ask.
  const r3 = engine.initialize_loop_run({ runId: 'r5c', task: SPECIFIC_TASK });
  assert.match(r3.message, /Already initialized/i);
  assert.equal(r3.needsConfirmation, false);
});

test('model confirmation: "defaults" / enter uses historical primary — never re-asks', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r5e', task: SPECIFIC_TASK, model: 'claude-haiku-4-5' });
  const r = engine.initialize_loop_run({ runId: 'r5e', answers: ['defaults'] });
  assert.equal(r.runStatus, 'INITIALIZED');
  assert.equal(store.load('r5e').config.model.primary, DEFAULT_PRIMARY_MODEL);
  assert.equal(store.load('r5e').config.modelPolicy.banlist.mode, 'default');
});

test('model confirmation: naming an allowed alternate resolves without re-ask', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r5alt', task: SPECIFIC_TASK, model: 'claude-haiku-4-5' });
  const r = engine.initialize_loop_run({ runId: 'r5alt', answers: ['gpt-5.5'] });
  assert.equal(r.runStatus, 'INITIALIZED');
  assert.equal(store.load('r5alt').config.model.primary, 'gpt-5.5');
});

test('defaults on enter: empty model answer yields historical primary + banlist default', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r5d', task: 'make it better' });
  const r = engine.initialize_loop_run({
    runId: 'r5d',
    answers: ['precision up 10%', 'my loop file', 'my loop', 'whole history best first', 'fewer tokens same quality', 'keep authorship', 'defaults', 'keep moving']
  });
  assert.equal(r.status, 'OK');
  assert.equal(store.load('r5d').config.model.primary, DEFAULT_PRIMARY_MODEL);
  assert.equal(store.load('r5d').config.modelPolicy.banlist.mode, 'default');
  assert.equal(store.load('r5d').config.modelPolicy.source, 'defaults');
});

test('"any model" answer disables the banlist for this run', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r5a', task: 'make it better' });
  const r = engine.initialize_loop_run({
    runId: 'r5a',
    answers: ['precision up 10%', 'my loop file', 'my loop', 'whole history best first', 'fewer tokens', 'keep authorship', 'any model', 'keep moving']
  });
  assert.equal(r.status, 'OK');
  assert.equal(store.load('r5a').config.modelPolicy.banlist.mode, 'off');
  assert.equal(store.load('r5a').config.modelPolicy.source, 'operator-init');
  assert.ok(r.modelPolicy);
});

test('failure patience is clamped into the 10–15 advisory band', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({ runId: 'r6', task: SPECIFIC_TASK, config: { failurePatience: 99 } });
  assert.equal(store.load('r6').config.failurePatience, 15);
  engine.initialize_loop_run({ runId: 'r7', task: SPECIFIC_TASK, config: { failurePatience: 2 } });
  assert.equal(store.load('r7').config.failurePatience, 10);
});

test('tools require initialization first (BLOCKED before ask-once is satisfied)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r8', task: 'vague' }); // stays AWAITING_ANSWERS
  const r = engine.loop_start({ runId: 'r8', loop: 'strip-miner' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'NOT_INITIALIZED');
});

test('the stop-condition notice is surfaced at the very start (leak #5)', () => {
  const { engine } = freshEngine();
  const exact = 'WARNING: You are the stop condition. This loop does not stop until you stop it.';
  const vague = engine.initialize_loop_run({ runId: 'r9', task: 'improve my loop' });
  assert.equal(vague.stopCondition, exact); // shown with the questions
  const initd = engine.initialize_loop_run({ runId: 'r10', task: SPECIFIC_TASK });
  assert.equal(initd.stopCondition, exact); // and on immediate init
});

test('the deeper-explanation answer is honored in the same response, no re-ask (leak #2)', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r11', task: 'make it better' }); // → questions
  // operator answers the final question asking to go deeper
  const initd = engine.initialize_loop_run({ runId: 'r11', answers: ['precision up', 'my loop', 'fewer tokens same quality', 'keep authorship', 'yes go deeper please'] });
  assert.equal(initd.status, 'OK');
  assert.equal(initd.questions, undefined, 'must not re-ask');
  assert.ok(initd.deeperExplanation, 'a deeper explanation is included');
  assert.match(initd.deeperExplanation, /phase-gated|tool-measured|stop condition/i);
});

test('no deeper explanation when the operator says keep moving', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'r12', task: 'make it better' });
  const initd = engine.initialize_loop_run({ runId: 'r12', answers: ['precision up', 'my loop', 'fewer tokens', 'no regress', 'no just keep moving after the brief'] });
  assert.equal(initd.status, 'OK');
  assert.equal(initd.deeperExplanation, undefined);
});

// ---- Step 7: cold-start contract + inferStartIntent lock ------------------

test('Step 7: a fresh init surfaces the cold-start notice; a resume does not', () => {
  const { engine } = freshEngine();
  const fresh = engine.initialize_loop_run({ runId: 'cs1', task: SPECIFIC_TASK });
  assert.ok(typeof fresh.coldStartNotice === 'string' && /new run/i.test(fresh.coldStartNotice));
  assert.match(fresh.coldStartNotice, /runId/, 'tells the operator how to resume instead');
  assert.match(fresh.coldStartNotice, /memory|recalled/i, 'warns against assuming from memory');
  const resume = engine.initialize_loop_run({ runId: 'cs1', task: SPECIFIC_TASK });
  assert.match(resume.message, /Already initialized/i);
  assert.equal(resume.coldStartNotice, undefined, 'a resume is a continuation, not a cold start');
});

test('Step 7: the cold-start notice also rides with the ask-once questions (vague task)', () => {
  const { engine } = freshEngine();
  const r = engine.initialize_loop_run({ runId: 'cs2', task: 'help me with my workflow' });
  assert.ok(Array.isArray(r.questions));
  assert.ok(typeof r.coldStartNotice === 'string' && /new run/i.test(r.coldStartNotice));
});

test('Step 7: inferStartIntent — vague "improve my loop" still asks; explicit drive language skips', () => {
  const { engine } = freshEngine();
  const vague = engine.initialize_loop_run({ runId: 'cs3', task: 'improve my loop' });
  assert.ok(Array.isArray(vague.questions), 'vague "improve my loop" still asks');
  const drive = engine.initialize_loop_run({ runId: 'cs4', task: 'use super loop and go' });
  assert.equal(drive.questions, undefined, 'explicit drive language skips the questionnaire');
  assert.equal(drive.runStatus, 'INITIALIZED');
});
