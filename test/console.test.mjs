import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsoleSnapshot } from '../src/console.mjs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

test('console snapshot is allowlisted operational state with no prompt, artifact, path, or environment leakage', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({
    runId: 'console-1',
    task: SPECIFIC_TASK,
    modelPreset: 'gpt-5.6-sol',
    userMessages: ['USER_MESSAGE_SECRET']
  });
  engine.loop_start({ runId: 'console-1', loop: 'loop-de-loop' });
  engine.human_review_request({
    runId: 'console-1',
    item: {
      title: 'REVIEW_TITLE_SECRET',
      summary: 'REVIEW_SUMMARY_SECRET',
      kind: 'loop-adoption',
      loopId: 'candidate-loop',
      loopContent: 'LOOP_CONTENT_SECRET'
    }
  });
  engine.operator.recordSupervisorEvent({
    runId: 'console-1',
    event: {
      type: 'worker_verdict',
      accepted: false,
      code: 'PHASE_SKIP',
      reasons: ['PHASE_SKIP'],
      route: 'gpt-5.6-sol',
      phase: 1,
      scenario: 'phase-skip',
      invocation: {
        requestedModel: 'gpt-5.6-sol',
        modelSelectionAuthority: 'explicit-model-flag',
        modelIdentityAuthority: 'explicit-model-flag',
        binaryFamily: 'codex',
        argv: ['exec', '-m', 'gpt-5.6-sol', 'PROMPT SECRET WITH SPACES'],
        stdoutSha256: 'a'.repeat(64),
        resultSha256: 'b'.repeat(64),
        tokenUsage: 42,
        tokenUsageAuthority: 'cli-reported',
        env: { SENSITIVE_NAME: 'ENV_SECRET' },
        prompt: 'PROMPT_SECRET'
      }
    }
  });
  const state = store.load('console-1');
  state.answers = [{ text: 'ANSWER_SECRET' }];
  state.dashboardPath = '/Users/operator/private/dashboard.html';
  state.reportPath = '/Users/operator/private/report.md';
  state.trajectory.push({
    id: 'call-secret',
    ts: state.updatedAt,
    tool: 'execute_full_test',
    arguments: { prompt: 'TRAJECTORY_PROMPT_SECRET', env: 'TRAJECTORY_ENV_SECRET' },
    result: { message: 'TRAJECTORY_RESULT_SECRET' }
  });
  store.save(state);

  const snapshot = buildConsoleSnapshot(store.load('console-1'));
  const json = JSON.stringify(snapshot);
  for (const forbidden of [
    SPECIFIC_TASK,
    'USER_MESSAGE_SECRET',
    'ANSWER_SECRET',
    'REVIEW_TITLE_SECRET',
    'REVIEW_SUMMARY_SECRET',
    'LOOP_CONTENT_SECRET',
    'PROMPT_SECRET',
    'ENV_SECRET',
    'TRAJECTORY_PROMPT_SECRET',
    'TRAJECTORY_ENV_SECRET',
    'TRAJECTORY_RESULT_SECRET',
    '/Users/operator'
  ]) {
    assert.ok(!json.includes(forbidden), `snapshot must omit ${forbidden}`);
  }
  assert.equal(snapshot.run.id, 'console-1');
  assert.equal(snapshot.policy.primary, 'gpt-5.6-sol');
  assert.equal(snapshot.campaign.lanes[0].loop, 'loop-de-loop');
  assert.equal(snapshot.verdicts[0].code, 'PHASE_SKIP');
  assert.deepEqual(snapshot.verdicts[0].invocation.argv, ['exec', '-m', 'gpt-5.6-sol', '[redacted]']);
  assert.equal(snapshot.reviews.items[0].hasLoopContent, true);
  assert.equal(snapshot.reviews.items[0].kind, 'loop-adoption');
});

test('console snapshot tolerates sparse legacy state', () => {
  const snapshot = buildConsoleSnapshot({
    runId: 'legacy',
    status: 'INITIALIZED',
    task: {},
    config: {},
    loops: {}
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.run.id, 'legacy');
  assert.deepEqual(snapshot.scoreMatrix, []);
  assert.deepEqual(snapshot.verdicts, []);
  assert.equal(snapshot.evidence.artifacts, 0);
});
