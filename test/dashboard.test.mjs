// Req 10: the always-on dashboard exists, is written to disk, carries the
// stop-condition notice, and is the only human Approve / Deny surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';
import { STOP_CONDITION_WARNING } from '../src/constants.mjs';
import { renderDashboard } from '../src/dashboard.mjs';
import { canaryState, historicalBlockedCanaryState } from './fixtures/canary-state.mjs';

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

test('the dashboard renders an evidence-backed Approve / Deny decision desk', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd2', task: SPECIFIC_TASK });
  engine.human_review_request({ runId: 'd2', item: { title: 'change A', summary: 's' } });
  const r = engine.update_dashboard({ runId: 'd2' });
  const html = readFileSync(r.path, 'utf8');
  assert.match(html, /Approval desk/);
  assert.match(html, /Effect of approval/);
  assert.match(html, /Session-authorized operator action/);
  assert.match(html, /decision hash/);
  assert.match(html, /hash-bound decision/);
  assert.match(html, /data-review-filter="QUEUED"/);
  assert.ok(/data-act="approve"/.test(html), 'Approve affordance');
  assert.ok(/data-act="sludge"/.test(html), 'backward-compatible denial value');
  assert.match(html, /data-act="sludge"[^>]*>Deny</);
  assert.match(html, /data-submit/);
  assert.match(html, /Choose approve or deny/);
  assert.ok(/class="notes"/.test(html), 'notes textarea');
  assert.ok(
    html.indexOf('id="operator-review"') < html.indexOf('id="run-control"'),
    'approval desk must precede the run contract'
  );
  assert.ok(/Score matrix/i.test(html), 'score matrix section');
  assert.match(html, /artifact output token estimate/i);
  assert.match(html, /CLI receipt token cost/i);
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

test('dashboard decisions are not optimistic on file:// or after queue acceptance', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({ runId: 'd5', task: SPECIFIC_TASK });
  engine.human_review_request({ runId: 'd5', item: { title: 'promotion candidate', kind: 'promotion', summary: 'win' } });
  const r = engine.update_dashboard({ runId: 'd5' });
  const html = readFileSync(r.path, 'utf8');
  // Selecting a decision is only a draft; a separate submit action queues it.
  assert.match(html, /Approval selected\. Queue to confirm\./);
  assert.match(html, /Denial selected\. Queue to confirm\./);
  assert.match(html, /local draft - export to apply/, 'file:// path labels draft, does not claim APPROVED');
  assert.match(html, /isFileProtocol|location\.protocol === 'file:'/, 'detects file:// protocol');
  assert.match(html, /APPROVAL QUEUED/);
  assert.match(html, /DENIAL QUEUED/);
  assert.match(html, /x-super-loop-decision-token/);
  assert.match(html, /reviewSha256/);
  assert.match(html, /DECISION STALE/);
  assert.match(html, /'DECISION STALE','SATURATED'/, 'live stale decisions retain warning styling');
  assert.match(html, /delete decisions\[id\];\s*enableExport\(\);/,
    'queued drafts stop being exportable before the next poll');
  assert.doesNotMatch(html, /\.then\(function\([^)]*\)\{[\s\S]{0,500}textContent=act==='approve'\?'APPROVED':'SLUDGE'/,
    'POST acceptance must not claim the supervisor already applied the decision');
});

test('dashboard is a live sanitized Campaign Console with polling, ETags, and complete async states', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({
    runId: 'd6',
    task: SPECIFIC_TASK,
    modelPreset: 'gpt-5.6-sol',
    userMessages: ['DASHBOARD_USER_SECRET']
  });
  engine.loop_start({ runId: 'd6', loop: 'loop-de-loop' });
  const r = engine.update_dashboard({ runId: 'd6' });
  const html = readFileSync(r.path, 'utf8');
  assert.match(html, /data-console-root/);
  assert.match(html, /Supervisor verdict timeline/);
  assert.match(html, /Model policy/);
  assert.match(html, /\/api\/run\?run=/);
  assert.match(html, /If-None-Match/);
  assert.match(html, /setInterval\(pollRun,1000\)/);
  assert.match(html, /Live state is unavailable/);
  assert.match(html, /file snapshot/);
  assert.ok(!html.includes(SPECIFIC_TASK), 'task prompt is not embedded in the public console');
  assert.ok(!html.includes('DASHBOARD_USER_SECRET'), 'user messages are not embedded in the public console');
});

test('strict dashboard exposes the 5x10 contract, Sol routing, trust checks, and mobile anchor offset', () => {
  const { engine } = freshEngine();
  engine.initialize_loop_run({
    runId: 'd7',
    task: SPECIFIC_TASK,
    answers: ['goal', 'mine', 'better', 'preserve', 'gpt-5.6-sol', 'go'],
    model: 'gpt-5.6-sol',
    modelPolicy: {
      primary: 'gpt-5.6-sol',
      testRoutes: ['gpt-5.6-sol'],
      builderRoutes: ['gpt-5.6-sol'],
      judgeRoute: 'gpt-5.6-sol'
    },
    config: {
      maxCycles: 10,
      realTest: {
        enabled: true,
        maxFindings: 5,
        maxImprovementAttempts: 10,
        planSha256: 'a'.repeat(64),
        approvedPlanSha256: 'a'.repeat(64),
        planApproved: true,
        benchmarkAuthority: 'maker',
        baselineStrategy: 'route-batch'
      }
    }
  });
  engine.operator.recordCampaignProgress({
    runId: 'd7',
    progress: {
      status: 'CAP_REACHED',
      findingsAccepted: 5,
      findingsRejected: 0,
      improvementAttempts: 10,
      invalidAttempts: 0,
      benchmarkLocked: true,
      baselineSamples: 3
    }
  });
  const r = engine.update_dashboard({ runId: 'd7' });
  const html = readFileSync(r.path, 'utf8');
  assert.match(html, /Strict real-test contract/);
  assert.match(html, /Accepted findings/);
  assert.match(html, /Valid improvement attempts/);
  assert.match(html, /Evidence trust/);
  assert.match(html, /Benchmark integrity/);
  assert.match(html, /gpt-5\.6-sol/);
  assert.match(html, /#operator-review\{scroll-margin-top:84px\}/);
});

test('experiment validity banner renders PASS, FAIL, and UNKNOWN without crashing on legacy state', () => {
  const { engine, store } = freshEngine();
  const init = (runId) => engine.initialize_loop_run({
    runId,
    task: SPECIFIC_TASK,
    answers: ['goal', 'mine', 'better', 'preserve', 'gpt-5.6-sol', 'go'],
    config: {
      realTest: {
        enabled: true,
        maxFindings: 5,
        maxImprovementAttempts: 10,
        planSha256: 'a'.repeat(64),
        benchmarkSha256: 'b'.repeat(64),
        planApproved: true,
        benchmarkAuthority: 'maker',
        baselineStrategy: 'route-batch',
        evidenceManifest: [{ path: 'src/supervisor.mjs', bytes: 10, sha256: 'c'.repeat(64) }]
      }
    }
  });

  init('validity-fail');
  const failHtml = readFileSync(engine.update_dashboard({ runId: 'validity-fail' }).path, 'utf8');
  assert.match(failHtml, /id="validityStatus"[^>]*>FAIL</);

  init('validity-pass');
  engine.operator.recordCampaignProgress({
    runId: 'validity-pass',
    progress: {
      status: 'CAP_REACHED',
      findingsAccepted: 1,
      findingsTested: 1,
      findingsBlocked: 0,
      improvementAttempts: 2,
      attemptsPlanned: 2,
      attemptsValid: 2,
      attemptsInvalid: 0,
      benchmarkLocked: true,
      baselineSamples: 3,
      coverage: [{
        findingId: 'finding-001',
        childRunId: 'validity-pass-t1',
        baselineSha256: 'a'.repeat(64),
        hypothesisIds: ['finding-001-h1', 'finding-001-h2'],
        planned: 2,
        valid: 2,
        invalid: 0,
        status: 'COVERED'
      }]
    }
  });
  const passState = store.load('validity-pass');
  passState.realTest.experimentValidity = {
    execution: { status: 'PASS', reasons: [] },
    targetGrounding: { status: 'PASS', reasons: [] },
    benchmark: { status: 'PASS', reasons: [] },
    isolation: { status: 'PASS', reasons: [] },
    comparability: { status: 'PASS', reasons: [] },
    coverage: { status: 'PASS', reasons: [] },
    promotionSafety: {
      status: 'N/A',
      reasons: ['No promotion was recorded; promotion safety is not applicable to this no-promotion experiment.']
    },
    stateConsistency: { status: 'PASS', reasons: [] },
    publicationEligible: true,
    status: 'PASS'
  };
  const passHtml = renderDashboard(passState);
  assert.match(passHtml, /id="validityStatus"[^>]*>PASS</);
  store.save(passState);
  const failClosedHtml = readFileSync(engine.update_dashboard({ runId: 'validity-pass' }).path, 'utf8');
  assert.match(failClosedHtml, /id="validityStatus"[^>]*>FAIL</);

  init('validity-legacy');
  const legacy = store.load('validity-legacy');
  delete legacy.realTest.experimentValidity;
  const unknownHtml = renderDashboard(legacy);
  assert.match(unknownHtml, /id="validityStatus"[^>]*>UNKNOWN</);
});

test('canary dashboard answers the causal experiment questions in the first viewport and preserves privacy', () => {
  const html = renderDashboard(canaryState());
  assert.match(html, /data-canary-console/);
  assert.match(html, /data-evidence-stage/);
  assert.match(html, /data-verification-spine/);
  assert.match(html, /data-causal-matrix/);
  assert.match(html, /data-receipt-explorer/);
  assert.match(html, /Loop Factory/);
  assert.match(html, /canary-ui-fixture/);
  assert.match(html, /gpt-5\.6-sol/);
  assert.match(html, /Challenger causally beat baseline/);
  assert.match(html, /5\/5 paired wins/i);
  assert.match(html, /target accuracy remains partial at 46\.7%/i);
  assert.match(html, /Experiment valid/);
  assert.match(html, /Sham stayed flat/);
  assert.match(html, /Controls held/);
  assert.match(html, /Promotion disabled/);
  assert.match(html, /data-decision-boundary/);
  assert.match(html, /No approval action is available/i);
  assert.match(html, /honest limitation/i);
  assert.match(html, /Baseline[\s\S]*0\.0%[\s\S]*Challenger[\s\S]*46\.7%[\s\S]*Sham[\s\S]*0\.0%/);
  assert.match(html, /Protected controls[\s\S]*100\.0%/);
  assert.match(html, /5\/5 gates/i);
  assert.match(html, /16 valid receipts/i);
  assert.match(html, /0 retries/i);
  assert.equal((html.match(/data-causal-arm="(?:baseline|challenger|sham)"/g) || []).length, 3);
  assert.equal((html.match(/data-causal-row/g) || []).length, 5);
  assert.doesNotMatch(html, /class="answer-grid"|class="arm-grid"/);
  assert.match(html, /Target versus control/);
  assert.match(html, /Machine verification gates/);
  assert.match(html, /Evidence hashes/);
  assert.match(html, /Receipt ledger/);
  assert.match(html, /data-ledger-column-headings/);
  assert.match(html, /id="armFilter"/);
  assert.match(html, /id="replicateFilter"/);
  assert.match(html, /If-None-Match/);
  assert.match(html, /setInterval\(pollRun,1000\)/);
  assert.match(html, /loading/i);
  assert.match(html, /empty/i);
  assert.match(html, /stale snapshot/i);
  assert.match(html, /reconnecting/i);
  assert.match(html, /success/i);
  assert.match(html, /failure/i);
  assert.match(html, /disabled/i);
  assert.match(html, /file snapshot/i);
  assert.doesNotMatch(html, /linear-gradient|radial-gradient/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  for (const forbidden of [
    'PROMPT_SECRET',
    'PROCEDURE_SECRET',
    'BENCHMARK_PROMPT_SECRET',
    'NEGATIVE_CONTROL_SECRET',
    'ENV_SECRET',
    'USER_MESSAGE_SECRET',
    '/Users/operator'
  ]) {
    assert.ok(!html.includes(forbidden), `dashboard must omit ${forbidden}`);
  }
});

test('sparse failed canary dashboard renders honest failure and empty states', () => {
  const html = renderDashboard(canaryState({
    includeEvaluations: false,
    experimentValid: false,
    verificationStatus: 'FAIL',
    outcomeStatus: 'FAIL'
  }));
  assert.match(html, /Experiment validity failed/);
  assert.match(html, /causal claim is blocked/i);
  assert.match(html, /No replicate measurements are available/i);
  assert.match(html, /No evaluation receipts match this filter/i);
  assert.match(html, /0 of 5/);
});

test('historical blocked canary renders its safe blocker and unavailable diagnostics honestly', () => {
  const state = historicalBlockedCanaryState();
  const html = renderDashboard(state);
  assert.match(html, /data-blocked-launch/);
  assert.match(html, /Launch blocked before causal evidence/);
  assert.match(html, /PROPOSAL_INVALID/);
  assert.match(html, /SUMMARY_ONLY/);
  assert.match(html, /ISOLATION_VIOLATION/);
  assert.match(html, /diagnostics unavailable for this historical failure/i);
  assert.match(html, /0 of 5/);
  assert.ok(!html.includes(state.blocker.message), 'free-form blocker prose must stay private');
  for (const forbidden of ['workspaceRoot', '"argv"', 'rawStdout', 'rawStderr']) {
    assert.ok(!html.includes(forbidden), `blocked dashboard must omit ${forbidden}`);
  }
});

test('blocked canary dashboard renders allowlisted failure evidence without raw diagnostics', () => {
  const state = canaryState({
    includeEvaluations: false,
    experimentValid: false,
    verificationStatus: 'FAIL',
    outcomeStatus: 'FAIL'
  });
  state.runId = 'canary-failure-evidence';
  state.status = 'BLOCKED';
  state.proposal = null;
  state.blocker = { code: 'EVALUATION_INVALID', message: 'PRIVATE_BLOCKER_PROSE' };
  state.verdictEvents = [{
    kind: 'evaluation',
    armRole: 'challenger',
    blindArm: 'arm-e7ac827c27b0',
    replicate: 0,
    position: 1,
    accepted: false,
    reasons: ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT'],
    attempt: 0,
    invocation: null
  }];
  state.failureEvidence = [{
    kind: 'evaluation',
    armRole: 'challenger',
    blindArm: 'arm-e7ac827c27b0',
    replicate: 0,
    position: 1,
    attempt: 0,
    reasons: ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT'],
    execReason: 'EXEC_FAILED',
    invocation: {
      requestedModel: 'gpt-5.6-sol',
      reportedModel: 'gpt-5.6-sol',
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'backend-handshake',
      reportedModelMatchesRequest: true,
      exitCode: 29,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64),
      argv: ['exec', '/Users/operator/private/PROMPT_SECRET'],
      workspaceRoot: '/Users/operator/private/workspace'
    },
    stdout: {
      artifactRef: 'evaluation-failed-stdout',
      sha256: 'a'.repeat(64),
      matchesReceipt: true,
      bytes: 123,
      content: 'RAW_STDOUT_SECRET'
    },
    stderr: {
      artifactRef: 'evaluation-failed-stderr',
      sha256: 'b'.repeat(64),
      matchesReceipt: true,
      bytes: 45,
      content: 'RAW_STDERR_SECRET'
    }
  }];
  const html = renderDashboard(state);
  assert.match(html, /data-failure-evidence/);
  assert.match(html, /EVALUATION_INVALID/);
  assert.match(html, /Failure evidence available/i);
  assert.match(html, /Challenger/);
  assert.match(html, /Replicate 1/);
  assert.match(html, /Position 2/);
  assert.match(html, /EXEC_FAILED/);
  assert.match(html, /Exit code[\s\S]*29/);
  assert.match(html, new RegExp(`stdout[\\s\\S]*${'a'.repeat(64)}[\\s\\S]*123 bytes[\\s\\S]*receipt match yes`, 'i'));
  assert.match(html, new RegExp(`stderr[\\s\\S]*${'b'.repeat(64)}[\\s\\S]*45 bytes[\\s\\S]*receipt match yes`, 'i'));
  for (const forbidden of [
    'PRIVATE_BLOCKER_PROSE',
    'PROMPT_SECRET',
    '/Users/operator',
    'RAW_STDOUT_SECRET',
    'RAW_STDERR_SECRET',
    '"argv"',
    'workspaceRoot'
  ]) {
    assert.ok(!html.includes(forbidden), `failure dashboard must omit ${forbidden}`);
  }
});
