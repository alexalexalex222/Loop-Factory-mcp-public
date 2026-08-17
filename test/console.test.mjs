import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsoleSnapshot } from '../src/console.mjs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';
import { canaryState, historicalBlockedCanaryState } from './fixtures/canary-state.mjs';

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
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.run.id, 'console-1');
  assert.equal(snapshot.policy.primary, 'gpt-5.6-sol');
  assert.equal(snapshot.campaign.lanes[0].loop, 'loop-de-loop');
  assert.equal(snapshot.verdicts[0].code, 'PHASE_SKIP');
  assert.deepEqual(snapshot.verdicts[0].invocation.argv, ['exec', '-m', 'gpt-5.6-sol', '[redacted]']);
  assert.equal(snapshot.reviews.items[0].hasLoopContent, true);
  assert.equal(snapshot.reviews.items[0].kind, 'loop-adoption');
  assert.match(snapshot.reviews.items[0].decisionBindingSha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.reviews.awaiting, 1);
  assert.equal(snapshot.reviews.queued, 0);
});

test('console snapshot tolerates sparse legacy state', () => {
  const snapshot = buildConsoleSnapshot({
    runId: 'legacy',
    status: 'INITIALIZED',
    task: {},
    config: {},
    loops: {}
  });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.run.id, 'legacy');
  assert.deepEqual(snapshot.scoreMatrix, []);
  assert.deepEqual(snapshot.verdicts, []);
  assert.equal(snapshot.evidence.artifacts, 0);
  assert.deepEqual(snapshot.realTest, { enabled: false });
});

test('answerSource distinguishes operator, config, and default answers', () => {
  const { engine, store } = freshEngine();
  for (const source of ['operator', 'config', 'default']) {
    engine.initialize_loop_run({
      runId: `answer-${source}`,
      task: SPECIFIC_TASK,
      answers: ['one', 'two'],
      answerSource: source
    });
    const snapshot = buildConsoleSnapshot(store.load(`answer-${source}`));
    assert.equal(snapshot.intake.answerSources[source], 2);
    assert.equal(Object.values(snapshot.intake.answerSources).reduce((sum, value) => sum + value, 0), 2);
  }
});

test('legacy strict states without machine validity render UNKNOWN', () => {
  const snapshot = buildConsoleSnapshot({
    runId: 'legacy-real',
    status: 'ACTIVE',
    task: {},
    config: { realTest: { enabled: true, maxFindings: 5, maxImprovementAttempts: 10 } },
    realTest: { enabled: true, status: 'RUNNING' },
    loops: {}
  });
  assert.equal(snapshot.realTest.experimentValidity.status, 'UNKNOWN');
  assert.equal(snapshot.realTest.experimentValidity.execution.status, 'UNKNOWN');
});

test('console snapshot exposes strict real-test budgets and benchmark authority without private config content', () => {
  const { engine, store } = freshEngine();
  engine.initialize_loop_run({
    runId: 'console-real',
    task: SPECIFIC_TASK,
    answers: ['goal', 'mine', 'better', 'preserve', 'defaults', 'go'],
    config: {
      maxCycles: 10,
      realTest: {
        enabled: true,
        maxFindings: 5,
        maxImprovementAttempts: 10,
        planSha256: 'a'.repeat(64),
        benchmarkSha256: 'b'.repeat(64),
        approvedPlanSha256: 'a'.repeat(64),
        planApproved: true,
        benchmarkAuthority: 'maker',
        baselineStrategy: 'route-batch',
        parentRunId: 'console-real',
        evidenceManifest: [{ path: 'src/supervisor.mjs', bytes: 10, sha256: 'c'.repeat(64) }]
      }
    }
  });
  engine.operator.recordCampaignProgress({
    runId: 'console-real',
    progress: {
      status: 'RUNNING',
      findingsAccepted: 3,
      findingsRejected: 2,
      findingsTested: 2,
      findingsBlocked: 0,
      improvementAttempts: 4,
      invalidAttempts: 7,
      attemptsPlanned: 6,
      attemptsValid: 4,
      attemptsInvalid: 7,
      coverage: [
        {
          findingId: 'finding-001',
          childRunId: 'console-real-t1',
          baselineSha256: 'c'.repeat(64),
          hypothesisIds: ['finding-001-h1', 'finding-001-h2'],
          planned: 2,
          valid: 2,
          invalid: 0,
          status: 'COVERED'
        },
        {
          findingId: 'finding-002',
          childRunId: 'console-real-t2',
          baselineSha256: 'd'.repeat(64),
          hypothesisIds: ['finding-002-h1', 'finding-002-h2'],
          planned: 2,
          valid: 2,
          invalid: 7,
          status: 'COVERED'
        },
        {
          findingId: 'finding-003',
          childRunId: null,
          baselineSha256: 'e'.repeat(64),
          hypothesisIds: ['finding-003-h1', 'finding-003-h2'],
          planned: 2,
          valid: 0,
          invalid: 0,
          status: 'UNTESTED'
        }
      ],
      latestSubRunId: 'console-real-t2',
      benchmarkLocked: true,
      baselineSamples: 3
    }
  });
  const snapshot = buildConsoleSnapshot(store.load('console-real'));
  const { experimentValidity, ...publicProgress } = snapshot.realTest;
  assert.deepEqual(publicProgress, {
    enabled: true,
    status: 'RUNNING',
    planApproved: true,
    planSha256: 'a'.repeat(64),
    benchmarkSha256: 'b'.repeat(64),
    benchmarkAuthority: 'maker',
    baselineStrategy: 'route-batch',
    parentRunId: 'console-real',
    latestSubRunId: 'console-real-t2',
    maxFindings: 5,
    findingsAccepted: 3,
    findingsRejected: 2,
    findingsTested: 2,
    findingsBlocked: 0,
    findingsRemaining: 2,
    maxImprovementAttempts: 10,
    improvementAttempts: 4,
    invalidAttempts: 7,
    attemptsPlanned: 6,
    attemptsValid: 4,
    attemptsInvalid: 7,
    improvementAttemptsRemaining: 6,
    benchmarkLocked: true,
    baselineSamples: 3,
    coverage: [
      {
        findingId: 'finding-001',
        childRunId: 'console-real-t1',
        baselineSha256: 'c'.repeat(64),
        hypothesisIds: ['finding-001-h1', 'finding-001-h2'],
        planned: 2,
        valid: 2,
        invalid: 0,
        status: 'COVERED'
      },
      {
        findingId: 'finding-002',
        childRunId: 'console-real-t2',
        baselineSha256: 'd'.repeat(64),
        hypothesisIds: ['finding-002-h1', 'finding-002-h2'],
        planned: 2,
        valid: 2,
        invalid: 7,
        status: 'COVERED'
      },
      {
        findingId: 'finding-003',
        childRunId: null,
        baselineSha256: 'e'.repeat(64),
        hypothesisIds: ['finding-003-h1', 'finding-003-h2'],
        planned: 2,
        valid: 0,
        invalid: 0,
        status: 'UNTESTED'
      }
    ],
    updatedAt: '2026-06-23T00:00:04.000Z'
  });
  assert.equal(experimentValidity.status, 'FAIL');
  assert.equal(experimentValidity.publicationEligible, false);
  assert.equal(experimentValidity.execution.status, 'FAIL');
  assert.ok(experimentValidity.execution.reasons.some((reason) => /child states/.test(reason)));
  assert.equal(experimentValidity.targetGrounding.status, 'FAIL');
  assert.equal(experimentValidity.benchmark.status, 'FAIL');
  assert.equal(experimentValidity.isolation.status, 'FAIL');
  assert.equal(experimentValidity.comparability.status, 'FAIL');
  assert.equal(experimentValidity.coverage.status, 'FAIL');
  assert.equal(experimentValidity.promotionSafety.status, 'N/A');
  assert.equal(experimentValidity.stateConsistency.status, 'FAIL');
  assert.ok(!JSON.stringify(snapshot).includes('approvedPlanSha256'));
});

test('canary snapshot is a first-class allowlisted causal experiment view', () => {
  const snapshot = buildConsoleSnapshot(canaryState());
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.kind, 'real-test-canary');
  assert.equal(snapshot.run.id, 'canary-ui-fixture');
  assert.equal(snapshot.run.model, 'gpt-5.6-sol');
  assert.equal(snapshot.policy.primary, 'gpt-5.6-sol');
  assert.equal(snapshot.canary.enabled, true);
  assert.equal(snapshot.canary.contract.replicatesPerArm, 5);
  assert.equal(snapshot.canary.proof.pairedTargetWins, 5);
  assert.equal(snapshot.canary.proof.shamWins, 0);
  assert.equal(snapshot.canary.proof.controlRegressions, 0);
  assert.equal(snapshot.canary.proof.callCount, 16);
  assert.equal(snapshot.canary.proof.retryCount, 0);
  assert.equal(snapshot.canary.proof.isolationStatus, 'PASS');
  assert.equal(snapshot.canary.verdict.causalMovement, true);
  assert.equal(snapshot.canary.verdict.experimentValid, true);
  assert.equal(snapshot.canary.verdict.promoted, false);
  assert.match(snapshot.canary.verdict.qualifier, /causal movement detected/i);
  assert.match(snapshot.canary.verdict.qualifier, /target accuracy remains partial at 46\.7%/i);
  assert.deepEqual(snapshot.canary.arms.map((arm) => arm.role), ['baseline', 'challenger', 'sham']);
  assert.equal(snapshot.canary.arms[0].targetMean, 0);
  assert.equal(snapshot.canary.arms[1].targetMean, 0.4667);
  assert.equal(snapshot.canary.arms[1].controlMean, 1);
  assert.equal(snapshot.canary.arms[1].replicates.length, 5);
  assert.equal(snapshot.canary.receipts.length, 16);
  assert.ok(snapshot.canary.gates.every((gate) => gate.status === 'PASS'));
});

test('canary snapshot never exposes prompts, procedures, artifact bodies, paths, environment values, messages, or argv', () => {
  const snapshot = buildConsoleSnapshot(canaryState());
  const json = JSON.stringify(snapshot);
  for (const forbidden of [
    'PROMPT_SECRET',
    'PROCEDURE_SECRET',
    'BENCHMARK_PROMPT_SECRET',
    'NEGATIVE_CONTROL_SECRET',
    'ENV_SECRET',
    'USER_MESSAGE_SECRET',
    '/Users/operator',
    'workspaceRoot',
    '"argv"',
    '"path"',
    '"prompt"',
    '"procedure"'
  ]) {
    assert.ok(!json.includes(forbidden), `canary snapshot must omit ${forbidden}`);
  }
  assert.ok(json.includes('procedureSha256'), 'procedure identity hash remains public evidence');
  assert.ok(json.includes('evaluationId'), 'safe artifact ids remain public evidence');
});

test('sparse and failed canaries fail closed without inventing movement', () => {
  const sparse = buildConsoleSnapshot(canaryState({
    includeEvaluations: false,
    experimentValid: false,
    verificationStatus: 'FAIL',
    outcomeStatus: 'FAIL'
  }));
  assert.equal(sparse.canary.proof.callCount, 1);
  assert.equal(sparse.canary.proof.seriesValid, false);
  assert.equal(sparse.canary.verdict.causalMovement, false);
  assert.match(sparse.canary.verdict.qualifier, /causal claim is blocked/i);
  assert.ok(sparse.canary.arms.every((arm) => arm.count === 0));

  const failed = buildConsoleSnapshot(canaryState({
    experimentValid: false,
    verificationStatus: 'FAIL',
    outcomeStatus: 'FAIL',
    receiptOverrides: { exitCode: 1, isolation: { status: 'FAIL', toolCalls: [] } }
  }));
  assert.equal(failed.canary.proof.failedReceipts, 15);
  assert.equal(failed.canary.proof.isolationStatus, 'FAIL');
  assert.equal(failed.canary.verdict.experimentValid, false);
  assert.match(failed.canary.verdict.headline, /validity failed/i);
});

test('historical blocked canary exposes safe blocker codes and admits missing diagnostics', () => {
  const state = historicalBlockedCanaryState();
  const snapshot = buildConsoleSnapshot(state);
  assert.equal(snapshot.canary.blocked.active, true);
  assert.equal(snapshot.canary.blocked.code, 'PROPOSAL_INVALID');
  assert.equal(snapshot.canary.blocked.failureEvidenceAvailable, false);
  assert.equal(snapshot.canary.blocked.diagnosticsAvailable, false);
  assert.deepEqual(snapshot.canary.blocked.failures, []);
  assert.ok(snapshot.canary.blocked.reasons.includes('SUMMARY_ONLY'));
  assert.ok(snapshot.canary.blocked.reasons.includes('ISOLATION_VIOLATION'));
  assert.equal(snapshot.canary.verdict.status, 'BLOCKED');
  assert.match(snapshot.canary.verdict.headline, /launch blocked/i);
  assert.doesNotMatch(snapshot.canary.verdict.headline, /validity failed/i);

  const json = JSON.stringify(snapshot);
  assert.ok(!json.includes(state.blocker.message), 'free-form blocker prose must stay private');
  for (const forbidden of ['workspaceRoot', '"argv"', 'rawStdout', 'rawStderr', '"content"']) {
    assert.ok(!json.includes(forbidden), `blocked canary snapshot must omit ${forbidden}`);
  }
});

test('new blocked canary failure evidence is strictly allowlisted', () => {
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
    reasons: ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT', 'unsafe free form reason'],
    attempt: 0,
    invocation: {
      exitCode: 29,
      argv: ['exec', '/Users/operator/private/PROMPT_SECRET'],
      workspaceRoot: '/Users/operator/private/workspace'
    }
  }];
  state.failureEvidence = [{
    kind: 'evaluation',
    armRole: 'challenger',
    blindArm: 'arm-e7ac827c27b0',
    replicate: 0,
    position: 1,
    attempt: 0,
    reasons: ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT', 'unsafe free form reason'],
    execReason: 'EXEC_FAILED',
    rawArtifactRef: 'evaluation-failed-raw',
    resultArtifactRef: 'evaluation-failed-result',
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
      workspaceRoot: '/Users/operator/private/workspace',
      env: { PRIVATE_ENV: 'ENV_SECRET' }
    },
    stdout: {
      artifactRef: 'evaluation-failed-stdout',
      sha256: 'a'.repeat(64),
      receiptSha256: 'a'.repeat(64),
      matchesReceipt: true,
      bytes: 123,
      content: 'RAW_STDOUT_SECRET'
    },
    stderr: {
      artifactRef: 'evaluation-failed-stderr',
      sha256: 'b'.repeat(64),
      receiptSha256: 'b'.repeat(64),
      matchesReceipt: true,
      bytes: 45,
      content: 'RAW_STDERR_SECRET'
    }
  }];
  state.verification.failedReceipts = [{
    kind: 'evaluation',
    reasons: ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT']
  }];

  const snapshot = buildConsoleSnapshot(state);
  assert.equal(snapshot.canary.blocked.active, true);
  assert.equal(snapshot.canary.blocked.code, 'EVALUATION_INVALID');
  assert.equal(snapshot.canary.blocked.failureEvidenceAvailable, true);
  assert.equal(snapshot.canary.blocked.diagnosticsAvailable, true);
  assert.deepEqual(snapshot.canary.blocked.reasons, ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT']);
  assert.equal(snapshot.canary.blocked.failures.length, 1);
  assert.deepEqual(snapshot.canary.blocked.failures[0], {
    kind: 'evaluation',
    arm: 'challenger',
    blindArmId: 'arm-e7ac827c27b0',
    replicate: 1,
    position: 2,
    attempt: 0,
    execReason: 'EXEC_FAILED',
    reasons: ['PHASE_SKIP', 'WRONG_PHASE_OUTPUT'],
    invocation: {
      exitCode: 29,
      requestedModel: 'gpt-5.6-sol',
      reportedModel: 'gpt-5.6-sol',
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'backend-handshake',
      reportedModelMatchesRequest: true
    },
    stdout: {
      artifactId: 'evaluation-failed-stdout',
      sha256: 'a'.repeat(64),
      bytes: 123,
      matchesReceipt: true
    },
    stderr: {
      artifactId: 'evaluation-failed-stderr',
      sha256: 'b'.repeat(64),
      bytes: 45,
      matchesReceipt: true
    },
    rawArtifactId: 'evaluation-failed-raw',
    resultArtifactId: 'evaluation-failed-result'
  });

  const json = JSON.stringify(snapshot);
  for (const forbidden of [
    'PRIVATE_BLOCKER_PROSE',
    'PROMPT_SECRET',
    '/Users/operator',
    'ENV_SECRET',
    'RAW_STDOUT_SECRET',
    'RAW_STDERR_SECRET',
    'unsafe free form reason',
    '"argv"',
    'workspaceRoot',
    '"content"'
  ]) {
    assert.ok(!json.includes(forbidden), `failure allowlist must omit ${forbidden}`);
  }
});

test('VNext campaign snapshot separates banked evidence from routing admission', () => {
  const snapshot = buildConsoleSnapshot({
    schemaVersion: 'loop-factory-campaign-series-state-v1',
    kind: 'vnext-campaign-series',
    seriesId: 'series-console',
    runId: 'vnext-console',
    planSha256: '1'.repeat(64),
    status: 'IDLE_NO_NEW_WORK',
    revision: 4,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:04:00.000Z',
    queue: [],
    currentWave: null,
    completedWaves: [{
      waveId: 'wave-development',
      position: 0,
      configId: 'config-wave-development',
      maximumCalls: 127,
      status: 'VERIFIED',
      evidenceSha256: '2'.repeat(64),
      budgetUsageSha256: '3'.repeat(64),
      budgetUsage: [{
        policyId: 'development-budget',
        policySha256: '4'.repeat(64),
        ledgerSha256: '5'.repeat(64),
        calls: 16,
        inputTokens: 1200,
        outputTokens: 300,
        usdMicros: 0
      }],
      outcome: {
        disposition: 'DEVELOPMENT_EVIDENCE_BANKED',
        causalPass: true,
        activationEligible: false,
        promotionAuthorized: false
      }
    }],
    taskIdentities: ['task:task-1', 'task:task-2', 'source:secret-source-hash'],
    totalAuthorizedCalls: 127,
    totalAuthorizedInputTokens: 10000,
    totalAuthorizedOutputTokens: 5000,
    totalAuthorizedTokens: 15000,
    totalAuthorizedUsdMicros: 0,
    operatorStop: false,
    events: [{
      index: 0,
      type: 'SERIES_INITIALIZED',
      at: '2026-08-05T00:00:00.000Z',
      detailSha256: '6'.repeat(64),
      privatePrompt: 'VNEXT_EVENT_SECRET'
    }],
    stateSha256: '7'.repeat(64)
  });

  assert.equal(snapshot.kind, 'vnext-campaign-series');
  assert.equal(snapshot.recursive.mode, 'vnext-campaign');
  assert.equal(snapshot.recursive.callsObserved, 16);
  assert.equal(snapshot.recursive.callsMaximum, 127);
  assert.equal(snapshot.recursive.taskCount, 2);
  assert.equal(snapshot.recursive.causalPass, true);
  assert.equal(snapshot.recursive.decisions[0].status, 'EVIDENCE_BANKED');
  assert.equal(snapshot.recursive.reviews, undefined);
  assert.equal(snapshot.reviews.approved, 0);
  assert.equal(snapshot.recursive.operator.canStop, true);
  assert.equal(snapshot.recursive.operator.stopRequested, false);
  assert.equal(snapshot.recursive.tokenUsage.total, 1500);
  assert.ok(!JSON.stringify(snapshot).includes('VNEXT_EVENT_SECRET'));
});

test('an unmeasured VNext campaign remains unknown rather than failing by default', () => {
  const snapshot = buildConsoleSnapshot({
    schemaVersion: 'loop-factory-campaign-series-state-v1',
    kind: 'vnext-campaign-series',
    seriesId: 'series-unmeasured',
    runId: 'vnext-unmeasured',
    planSha256: '1'.repeat(64),
    status: 'IDLE_NO_NEW_WORK',
    revision: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    queue: [],
    currentWave: null,
    completedWaves: [],
    taskIdentities: [],
    totalAuthorizedCalls: 0,
    operatorStop: false,
    events: [],
    stateSha256: '2'.repeat(64)
  });
  assert.equal(snapshot.recursive.experimentValid, null);
  assert.equal(snapshot.recursive.causalPass, null);
});
