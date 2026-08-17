import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/util.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import {
  buildVNextTaskPack,
  loadVNextTaskPackMaterials,
  validateVNextTaskPack
} from '../src/vnext-task-pack.mjs';
import {
  createResourceBudgetLedger,
  createResourceBudgetPolicy,
  reserveResourceBudget,
  settleResourceBudget
} from '../src/resource-budget.mjs';
import {
  createCampaignSeriesPlan,
  createCampaignSeriesState,
  enqueueCampaignSeriesWave,
  requestCampaignSeriesStop,
  runCampaignSeriesTick,
  runCampaignSeriesTickAsync,
  validateCampaignSeriesPlan,
  validateCampaignSeriesState
} from '../src/campaign-series.mjs';
import { createStore, STORE_DURABILITY } from '../src/store.mjs';
import {
  appendCampaignSeriesCheckpoint,
  initializeCampaignSeriesStore,
  loadCampaignSeriesStore,
  loadCampaignSeriesWaveInputs,
  persistCampaignSeriesWaveInputs
} from '../src/campaign-series-store.mjs';
import {
  cancelVNextCampaignLaunchAuthorization,
  consumeVNextCampaignLaunchAuthorization,
  persistVNextCampaignLaunchAuthorization
} from '../src/vnext-campaign-launch-authorization.mjs';
import {
  createVNextCampaignStopReceipt,
  validateVNextCampaignStopReceipt
} from '../src/vnext-campaign-driver.mjs';

function createPowerLossStore(home) {
  if (process.platform !== 'win32') {
    return createStore(home, { durability: STORE_DURABILITY.POWER_LOSS });
  }
  assert.throws(
    () => createStore(home, { durability: STORE_DURABILITY.POWER_LOSS }),
    { code: 'DURABLE_PLATFORM_UNSUPPORTED' }
  );
  return null;
}

function portableEvaluatorAuthority() {
  const profile = '(version 1)(allow default)(deny network*)';
  const payload = {
    schemaVersion: 'executable-evaluator-authority-v1',
    platform: 'darwin',
    architecture: 'arm64',
    node: {
      path: '/opt/loop-factory/node',
      basename: 'node',
      version: 'v24.0.0',
      sha256: 'a'.repeat(64)
    },
    sandbox: {
      path: '/usr/bin/sandbox-exec',
      basename: 'sandbox-exec',
      sha256: 'b'.repeat(64),
      profile,
      profileSha256: sha256(profile)
    },
    bootstrap: {
      path: '/opt/loop-factory/executable-canary-sandbox.mjs',
      sha256: 'c'.repeat(64)
    },
    limits: {
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
      maxBufferBytes: 1024 * 1024,
      heapMb: 128
    },
    permissions: {
      nodeFlag: '--permission',
      filesystem: 'candidate-and-bootstrap-read-only',
      childProcesses: 'denied',
      workers: 'denied',
      network: 'denied'
    }
  };
  return {
    ...payload,
    authoritySha256: sha256(canonicalVNextJson(payload))
  };
}

function portableTaskPack(tasks) {
  const evaluatorAuthority = portableEvaluatorAuthority();
  const normalized = tasks.map((task, index) => {
    const number = index + 1;
    const evaluation = {
      instrumentValid: true,
      candidateExecuted: true,
      outputShapeValid: true,
      results: [
        { id: `target-${number}-1`, group: 'target', pass: false },
        { id: `control-${number}-1`, group: 'control', pass: true },
        { id: `control-${number}-2`, group: 'control', pass: true }
      ]
    };
    const interfaceCoverageSha256 = sha256(`coverage-${task.taskId}`);
    const proof = {
      taskId: task.taskId,
      sourceSha256: task.source.sha256,
      interfaceSha256: task.interfaceContractSha256,
      oracleSha256: task.oracle.sha256,
      evaluatorAuthoritySha256: evaluatorAuthority.authoritySha256,
      interfaceCoverageSha256,
      evaluation
    };
    return {
      ...task,
      baselineFailure: {
        status: 'VERIFIED_FAILURE',
        taskId: task.taskId,
        artifactId: `baseline-${task.taskId}`,
        artifactSha256: task.source.sha256,
        verifierEvidenceSha256: sha256(canonicalVNextJson(proof)),
        baselineArtifactSha256: task.source.sha256,
        evaluatorAuthoritySha256: evaluatorAuthority.authoritySha256,
        sourceSha256: task.source.sha256,
        interfaceSha256: task.interfaceContractSha256,
        oracleSha256: task.oracle.sha256,
        interfaceCoverageSha256,
        targetFailureIds: [`target-${number}-1`],
        controlPassIds: [`control-${number}-1`, `control-${number}-2`],
        evaluation
      }
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const identities = normalized.flatMap((task) => [
    `task:${task.taskId}`,
    `cluster:${task.clusterId}`,
    `source-path:${task.source.path}`,
    `source-sha:${task.source.sha256}`,
    `incident-path:${task.incident.path}`,
    `incident-sha:${task.incident.sha256}`,
    `interface-path:${task.interface.path}`,
    `interface-sha:${task.interface.sha256}`,
    `oracle-path:${task.oracle.path}`,
    `oracle-sha:${task.oracle.sha256}`
  ]).sort();
  const base = {
    schemaVersion: 'loop-factory-vnext-task-pack-v1',
    packId: 'pack-1',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    evaluatorAuthority,
    artifactRootSha256: sha256(canonicalVNextJson(normalized.map((task) => ({
      source: task.source,
      incident: task.incident,
      interface: task.interface,
      oracle: task.oracle
    })))),
    priorIdentitySetSha256: sha256(canonicalVNextJson([])),
    tasks: normalized,
    taskIdentitySetSha256: sha256(canonicalVNextJson(identities)),
    leakageChecks: normalized.map((task) => ({
      taskId: task.taskId,
      directOracleLeak: false
    }))
  };
  return { ...base, packSha256: sha256(canonicalVNextJson(base)) };
}

function fixture({ replayable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'campaign-series-'));
  mkdirSync(join(root, 'tasks'));
  const tasks = [1, 2].map((n) => {
    const source = `tasks/s${n}.txt`;
    const incident = `tasks/i${n}.txt`;
    const interfacePath = `tasks/x${n}.json`;
    const oracle = `tasks/o${n}.txt`;
    const interfaceContract = {
      schemaVersion: 'executable-interface-contract-v2',
      exportName: 'decide',
      inputPaths: [`task${n}.baselineQuality`, `task${n}.candidateQuality`],
      decisions: ['ACCEPT', 'REJECT'],
      codes: [
        { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
        { value: 'NO_GAIN', meaning: 'Quality did not increase.' }
      ],
      roleBindings: [
        { role: 'baseline.quality', path: `task${n}.baselineQuality` },
        { role: 'candidate.quality', path: `task${n}.candidateQuality` }
      ]
    };
    const interfaceBytes = JSON.stringify(interfaceContract);
    const row = (id, group, baselineQuality, candidateQuality, decision, code) => ({
      id, group, input: { [`task${n}`]: { baselineQuality, candidateQuality } },
      expected: { decision, code }
    });
    const oracleBytes = JSON.stringify({
      schemaVersion: 'executable-case-set-v1', exportName: 'decide',
      cases: [
        row(`target-${n}-1`, 'target', 1, 2, 'ACCEPT', 'QUALITY_GAIN'),
        row(`target-${n}-2`, 'target', 2, 3, 'ACCEPT', 'QUALITY_GAIN'),
        row(`target-${n}-3`, 'target', 3, 4, 'ACCEPT', 'QUALITY_GAIN'),
        row(`control-${n}-1`, 'control', 4, 2, 'REJECT', 'NO_GAIN'),
        row(`control-${n}-2`, 'control', 5, 1, 'REJECT', 'NO_GAIN')
      ]
    });
    const sourceBytes = `export function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; } // ${n}\n`;
    writeFileSync(join(root, source), sourceBytes);
    writeFileSync(join(root, incident), `incident ${n}`);
    writeFileSync(join(root, interfacePath), interfaceBytes);
    writeFileSync(join(root, oracle), oracleBytes);
    return {
      taskId: `task-${n}`,
      clusterId: `cluster-${n}`,
      domain: 'test',
      tags: [],
      source: { id: `s-${n}`, path: source, sha256: sha256(sourceBytes) },
      incident: { id: `i-${n}`, path: incident, sha256: sha256(`incident ${n}`) },
      interface: { id: `x-${n}`, path: interfacePath, sha256: sha256(interfaceBytes) },
      oracle: { id: `o-${n}`, path: oracle, sha256: sha256(oracleBytes) },
      interfaceContractSha256: sha256(canonicalVNextJson(interfaceContract)),
      publicTaskSpecSha256: 'b'.repeat(64),
      baselineFailure: {
        status: 'VERIFIED_FAILURE', taskId: `task-${n}`, artifactId: `base-${n}`,
        artifactSha256: 'c'.repeat(64), verifierEvidenceSha256: 'd'.repeat(64),
        baselineArtifactSha256: 'e'.repeat(64)
      }
    };
  });
  const built = replayable
    ? buildVNextTaskPack({
        artifactRoot: root,
        packId: 'pack-1',
        partition: 'development',
        createdAt: '2026-08-05T00:00:00.000Z',
        builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
        tasks
      })
    : { status: 'OK', pack: portableTaskPack(tasks) };
  assert.equal(built.status, 'OK', built.message);
  const pack = built.pack;
  assert.equal(validateVNextTaskPack(pack).status, 'OK');
  const policy = createResourceBudgetPolicy({
    policyId: 'series-budget', maxCalls: 10, maxInputTokens: 1000,
    maxOutputTokens: 1000, maxTotalTokens: 2000, maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0, outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd', currency: 'USD'
  }).policy;
  const ledger = createResourceBudgetLedger({
    policy, runId: 'series-run', createdAt: '2026-08-05T00:00:00.000Z'
  }).ledger;
  const wavePolicy = createResourceBudgetPolicy({
    policyId: 'wave-1-budget', maxCalls: 2, maxInputTokens: 200,
    maxOutputTokens: 100, maxTotalTokens: 300, maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0, outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd', currency: 'USD'
  }).policy;
  const plan = createCampaignSeriesPlan({
    seriesId: 'series-1', createdAt: '2026-08-05T00:00:00.000Z', maximumWaves: 3,
    familywiseAlpha: 0.05, maximumCalls: 10, modelPolicySha256: '1'.repeat(64),
    evaluatorPolicySha256: '2'.repeat(64), implementationSha256: '3'.repeat(64),
    budgetPolicy: policy
  }).plan;
  const state = createCampaignSeriesState({ plan, runId: 'series-run' }).state;
  return { root, pack, policy, wavePolicy, ledger, plan, state };
}

function enqueue(data, state = data.state, waveId = 'wave-1') {
  return enqueueCampaignSeriesWave({
    state, plan: data.plan, expectedStateSha256: state.stateSha256, waveId,
    taskPack: data.pack, configId: `config-${waveId}`, configSha256: '4'.repeat(64),
    budgetPolicies: [data.wavePolicy],
    sealedAt: '2026-08-05T00:00:01.000Z', sealAuthority: 'series-builder'
  });
}

test('portable task packs require live evaluator authority for baseline replay', () => {
  const data = fixture();
  const replay = loadVNextTaskPackMaterials({
    artifactRoot: data.root,
    pack: data.pack
  });
  assert.equal(replay.status, 'REFUSED');
  assert.equal(replay.code, 'TASK_PACK_BASELINE_REPLAY_INVALID');
});

test('a finite sealed wave runs once and then idles without inference', () => {
  const data = fixture();
  const queued = enqueue(data);
  let calls = 0;
  const completed = runCampaignSeriesTick({
    state: queued.state, plan: data.plan, budgetLedger: data.ledger,
    runWave: () => { calls += 1; return { calls: 2 }; },
    verifyWave: () => ({ status: 'OK', evidenceSha256: 'f'.repeat(64) }),
    now: '2026-08-05T00:00:02.000Z'
  });
  assert.equal(completed.disposition, 'WAVE_DRAINED');
  const idle = runCampaignSeriesTick({
    state: completed.state, plan: data.plan, budgetLedger: data.ledger,
    runWave: () => { calls += 1; }, verifyWave: () => null,
    now: '2026-08-05T00:00:03.000Z'
  });
  assert.equal(idle.disposition, 'IDLE_NO_NEW_WORK');
  assert.equal(idle.inferenceCalls, 0);
  assert.equal(calls, 1);
});

test('recomputed hashes cannot smuggle extra plan, state, or wave fields', () => {
  const data = fixture();
  assert.equal(validateCampaignSeriesPlan({
    ...data.plan,
    unboundAuthority: true
  }).status, 'REFUSED');

  const extraState = structuredClone(data.state);
  extraState.unboundAuthority = true;
  const extraStateCore = structuredClone(extraState);
  delete extraStateCore.stateSha256;
  extraState.stateSha256 = sha256(canonicalVNextJson(extraStateCore));
  assert.equal(validateCampaignSeriesState(extraState).status, 'REFUSED');

  const queued = enqueue(data).state;
  const extraWave = structuredClone(queued);
  extraWave.queue[0].unboundAuthority = true;
  const extraWaveCore = structuredClone(extraWave);
  delete extraWaveCore.stateSha256;
  extraWave.stateSha256 = sha256(canonicalVNextJson(extraWaveCore));
  assert.equal(validateCampaignSeriesState(extraWave).status, 'REFUSED');
});

test('a cold resume of an ambiguous dispatch never retries', () => {
  const data = fixture();
  const queued = enqueue(data);
  let dispatched;
  assert.throws(() => runCampaignSeriesTick({
    state: queued.state, plan: data.plan, budgetLedger: data.ledger,
    persistState: (state) => { dispatched = state; },
    runWave: () => { throw new Error('crash'); },
    verifyWave: () => null,
    now: '2026-08-05T00:00:02.000Z'
  }));
  let calls = 0;
  const resumed = runCampaignSeriesTick({
    state: dispatched, plan: data.plan, budgetLedger: data.ledger,
    runWave: () => { calls += 1; }, verifyWave: () => null,
    now: '2026-08-05T00:00:03.000Z'
  });
  assert.equal(resumed.disposition, 'AMBIGUOUS_DISPATCH');
  assert.equal(calls, 0);
});

test('operator stop is idempotent and prevents later waves', () => {
  const data = fixture();
  const stopped = requestCampaignSeriesStop(data.state, {
    expectedStateSha256: data.state.stateSha256,
    requestedAt: '2026-08-05T00:00:01.000Z'
  });
  assert.equal(stopped.status, 'OK');
  assert.equal(enqueue(data, stopped.state).code, 'CAMPAIGN_SERIES_STOPPED');
  assert.equal(requestCampaignSeriesStop(stopped.state, {
    expectedStateSha256: stopped.state.stateSha256,
    requestedAt: '2026-08-05T00:00:02.000Z'
  }).idempotent, true);
});

test('operator stop receipt binds the descriptor wave ID while dispatch is active', () => {
  const data = fixture();
  const queued = enqueue(data);
  let dispatched;
  assert.throws(() => runCampaignSeriesTick({
    state: queued.state,
    plan: data.plan,
    budgetLedger: data.ledger,
    persistState: (state) => { dispatched = state; },
    runWave: () => { throw new Error('pause at dispatch'); },
    verifyWave: () => null,
    now: '2026-08-05T00:00:02.000Z'
  }));
  const stopped = requestCampaignSeriesStop(dispatched, {
    expectedStateSha256: dispatched.stateSha256,
    requestedAt: '2026-08-05T00:00:03.000Z'
  });
  assert.equal(stopped.status, 'OK');
  assert.equal(
    stopped.state.events.at(-1).detailSha256,
    sha256(canonicalVNextJson({ currentWave: 'wave-1' }))
  );
});

test('durable stop receipts preserve the queued wave and fail closed on tampering', () => {
  const data = fixture();
  const queued = enqueue(data);
  const created = createVNextCampaignStopReceipt({
    seriesRunId: 'series-run',
    state: queued.state,
    requestedAt: '2026-08-05T00:00:02.000Z'
  });
  assert.equal(created.status, 'OK');
  assert.equal(created.receipt.waveId, 'wave-1');
  assert.equal(validateVNextCampaignStopReceipt(created.receipt).status, 'OK');
  assert.equal(validateVNextCampaignStopReceipt({
    ...created.receipt,
    waveId: 'wave-2'
  }).code, 'VNEXT_CAMPAIGN_STOP_RECEIPT_TAMPERED');
});

function settledWaveLedger(policy) {
  let ledger = createResourceBudgetLedger({
    policy,
    runId: 'wave-1-run',
    createdAt: '2026-08-05T00:00:01.000Z'
  }).ledger;
  for (let index = 0; index < 2; index += 1) {
    const reserved = reserveResourceBudget(ledger, {
      callId: `wave-call-${index + 1}`,
      maxInputTokens: 50,
      maxOutputTokens: 25,
      createdAt: `2026-08-05T00:00:0${index + 2}.000Z`
    });
    assert.equal(reserved.status, 'OK');
    ledger = reserved.ledger;
    const settled = settleResourceBudget(ledger, {
      reservationId: reserved.reservation.reservationId,
      inputTokens: 40,
      outputTokens: 20,
      settledAt: `2026-08-05T00:00:0${index + 4}.000Z`,
      usageAuthority: 'cli-receipt'
    });
    assert.equal(settled.status, 'OK');
    ledger = settled.ledger;
  }
  return ledger;
}

test('async waves persist dispatch before inference and replay every child budget', async () => {
  const data = fixture();
  const queued = enqueue(data);
  const persisted = [];
  const completed = await runCampaignSeriesTickAsync({
    state: queued.state,
    plan: data.plan,
    budgetLedger: data.ledger,
    persistState: async (state) => persisted.push(state.status),
    runWave: async () => ({
      calls: 2,
      budgetLedgers: [settledWaveLedger(data.wavePolicy)]
    }),
    verifyWave: async () => ({
      status: 'OK',
      evidenceSha256: 'f'.repeat(64)
    }),
    now: '2026-08-05T00:00:02.000Z'
  });
  assert.equal(completed.status, 'OK');
  assert.equal(completed.disposition, 'WAVE_DRAINED');
  assert.deepEqual(persisted, ['RUNNING', 'WAVE_DRAINED']);
  assert.equal(completed.state.completedWaves[0].budgetUsage[0].calls, 2);
  assert.equal(completed.state.completedWaves[0].budgetUsage[0].inputTokens, 80);

  const invalid = await runCampaignSeriesTickAsync({
    state: enqueue(fixture()).state,
    plan: data.plan,
    budgetLedger: data.ledger,
    runWave: async () => ({ calls: 2, budgetLedgers: [] }),
    verifyWave: async () => ({ status: 'OK', evidenceSha256: 'f'.repeat(64) }),
    now: '2026-08-05T00:00:02.000Z'
  });
  assert.equal(invalid.status, 'BLOCKED');
  assert.equal(invalid.code, 'CAMPAIGN_SERIES_WAVE_BUDGET_MISSING');
});

test('async dispatch refuses before state mutation when authorization is absent', async () => {
  const data = fixture();
  const queued = enqueue(data);
  let persisted = 0;
  let runs = 0;
  const result = await runCampaignSeriesTickAsync({
    state: queued.state,
    plan: data.plan,
    budgetLedger: data.ledger,
    authorizeDispatch: async () => ({
      status: 'REFUSED',
      code: 'TEST_LAUNCH_AUTHORIZATION_REQUIRED'
    }),
    persistState: async () => { persisted += 1; },
    runWave: async () => { runs += 1; },
    verifyWave: async () => null,
    now: '2026-08-05T00:00:02.000Z'
  });

  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'TEST_LAUNCH_AUTHORIZATION_REQUIRED');
  assert.equal(result.state.stateSha256, queued.state.stateSha256);
  assert.equal(persisted, 0);
  assert.equal(runs, 0);
});

test('paid launch authorization refuses a process-atomic store', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'campaign-launch-unsafe-store-')));
  const refused = persistVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    approvedPlanSha256: '8'.repeat(64),
    protocolSha256: '9'.repeat(64),
    createdAt: '2026-08-05T00:00:01.500Z'
  });
  assert.equal(refused.code, 'VNEXT_CAMPAIGN_LAUNCH_DURABILITY_REQUIRED');
});

test('launch authorization requires the exact persisted study disclosure at consumption', async () => {
  const data = fixture();
  const home = mkdtempSync(join(tmpdir(), 'campaign-launch-auth-'));
  const store = createPowerLossStore(home);
  if (!store) return;
  assert.equal(initializeCampaignSeriesStore({
    store,
    runId: 'series-run',
    plan: data.plan,
    state: data.state,
    rootBudgetLedger: data.ledger
  }).status, 'OK');
  const queued = enqueue(data);
  assert.equal(appendCampaignSeriesCheckpoint({
    store,
    runId: 'series-run',
    plan: data.plan,
    state: queued.state
  }).status, 'OK');
  const pending = persistVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    approvedPlanSha256: '8'.repeat(64),
    protocolSha256: '9'.repeat(64),
    createdAt: '2026-08-05T00:00:01.500Z'
  });
  assert.equal(pending.status, 'OK', pending.message);
  store.writeRunFile(
    'series-run',
    'campaign-series/launch-authorizations/wave-2.pending.json',
    store.readRunFile(
      'series-run',
      'campaign-series/launch-authorizations/wave-1.pending.json'
    )
  );
  assert.equal(consumeVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    descriptor: { ...queued.state.queue[0], waveId: 'wave-2' },
    state: queued.state,
    authorizationSha256: pending.authorization.authorizationSha256,
    protocolSha256: '9'.repeat(64)
  }).code, 'VNEXT_CAMPAIGN_LAUNCH_AUTHORIZATION_REQUIRED');

  const blocked = consumeVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    descriptor: queued.state.queue[0],
    state: queued.state,
    authorizationSha256: pending.authorization.authorizationSha256,
    protocolSha256: '9'.repeat(64)
  });
  assert.equal(blocked.code, 'VNEXT_CAMPAIGN_LAUNCH_APPROVAL_REPLAY_FAILED');
  assert.equal(store.runFileExists(
    'series-run',
    'campaign-series/launch-authorizations/wave-1.pending.json'
  ), true);
  assert.equal(store.runFileExists(
    'series-run',
    'campaign-series/launch-authorizations/wave-1.consumed.json'
  ), false);
});

test('operator stop atomically cancels pending launch authority without deleting it', () => {
  const data = fixture();
  const store = createPowerLossStore(
    mkdtempSync(join(tmpdir(), 'campaign-launch-cancel-'))
  );
  if (!store) return;
  assert.equal(initializeCampaignSeriesStore({
    store,
    runId: 'series-run',
    plan: data.plan,
    state: data.state,
    rootBudgetLedger: data.ledger
  }).status, 'OK');
  const queued = enqueue(data);
  assert.equal(appendCampaignSeriesCheckpoint({
    store,
    runId: 'series-run',
    plan: data.plan,
    state: queued.state
  }).status, 'OK');
  const pending = persistVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    approvedPlanSha256: '8'.repeat(64),
    protocolSha256: '9'.repeat(64),
    createdAt: '2026-08-05T00:00:01.500Z'
  });
  const cancelled = cancelVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    waveId: 'wave-1'
  });
  assert.equal(cancelled.status, 'OK');
  assert.equal(cancelled.cancelled, true);
  assert.equal(store.runFileExists(
    'series-run',
    'campaign-series/launch-authorizations/wave-1.pending.json'
  ), false);
  assert.equal(store.runFileExists(
    'series-run',
    'campaign-series/launch-authorizations/wave-1.cancelled.json'
  ), true);
  assert.equal(consumeVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    descriptor: queued.state.queue[0],
    state: queued.state,
    authorizationSha256: pending.authorization.authorizationSha256,
    protocolSha256: '9'.repeat(64)
  }).code, 'VNEXT_CAMPAIGN_LAUNCH_CANCELLED');
  assert.equal(cancelVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    waveId: 'wave-1'
  }).idempotent, true);
  assert.equal(persistVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    approvedPlanSha256: '8'.repeat(64),
    protocolSha256: '9'.repeat(64),
    createdAt: '2026-08-05T00:00:02.000Z'
  }).code, 'VNEXT_CAMPAIGN_LAUNCH_CANCELLED');
});

test('async cold recovery finalizes verified evidence without another inference call', async () => {
  const data = fixture();
  const queued = enqueue(data);
  let dispatched;
  await assert.rejects(() => runCampaignSeriesTickAsync({
    state: queued.state, plan: data.plan, budgetLedger: data.ledger,
    persistState: async (state) => { dispatched = state; },
    runWave: async () => { throw new Error('process loss'); },
    verifyWave: async () => null,
    now: '2026-08-05T00:00:02.000Z'
  }), /process loss/);
  let runs = 0;
  const recoveredLedger = settledWaveLedger(data.wavePolicy);
  const recovered = await runCampaignSeriesTickAsync({
    state: dispatched, plan: data.plan, budgetLedger: data.ledger,
    runWave: async () => { runs += 1; return null; },
    recoverWave: async () => ({ calls: 2, budgetLedgers: [recoveredLedger] }),
    verifyWave: async () => ({ status: 'OK', evidenceSha256: 'f'.repeat(64) }),
    now: '2026-08-05T00:00:03.000Z'
  });
  assert.equal(recovered.status, 'OK');
  assert.equal(recovered.disposition, 'WAVE_DRAINED');
  assert.equal(recovered.inferenceCalls, 0);
  assert.equal(recovered.recoveredCalls, 2);
  assert.equal(runs, 0);
});

test('campaign series checkpoints and wave inputs replay after a cold restart', {
  skip: process.platform !== 'darwin'
}, () => {
  const data = fixture({ replayable: true });
  const home = mkdtempSync(join(tmpdir(), 'campaign-series-store-'));
  const store = createStore(home);
  const initialized = initializeCampaignSeriesStore({
    store,
    runId: 'series-run',
    plan: data.plan,
    state: data.state,
    rootBudgetLedger: data.ledger
  });
  assert.equal(initialized.status, 'OK', initialized.message);
  const inputs = persistCampaignSeriesWaveInputs({
    store,
    runId: 'series-run',
    waveId: 'wave-1',
    taskPack: data.pack,
    artifactRoot: data.root,
    config: { schemaVersion: 'wave-config-v1', objective: 'test' },
    budgetPolicies: [data.wavePolicy]
  });
  assert.equal(inputs.status, 'OK', inputs.message);
  const waveInputs = loadCampaignSeriesWaveInputs({
    store,
    runId: 'series-run',
    waveId: 'wave-1'
  });
  assert.equal(waveInputs.status, 'OK', waveInputs.message);
  assert.equal(waveInputs.taskMaterialBundle.materials.length, 2);
  const queued = enqueueCampaignSeriesWave({
    state: data.state,
    plan: data.plan,
    expectedStateSha256: data.state.stateSha256,
    waveId: 'wave-1',
    taskPack: data.pack,
    configId: inputs.manifest.configId,
    configSha256: inputs.manifest.configSha256,
    budgetPolicies: inputs.budgetPolicies,
    sealedAt: '2026-08-05T00:00:01.000Z',
    sealAuthority: 'series-builder'
  });
  assert.equal(appendCampaignSeriesCheckpoint({
    store,
    runId: 'series-run',
    plan: data.plan,
    state: queued.state
  }).status, 'OK');
  const reopened = loadCampaignSeriesStore({ store, runId: 'series-run' });
  assert.equal(reopened.status, 'OK', reopened.message);
  assert.equal(reopened.state.status, 'READY');
  assert.equal(reopened.checkpoints.length, 2);

  const ledger = store.readRunFile('series-run', 'campaign-series/checkpoints.jsonl');
  store.writeRunFile(
    'series-run',
    'campaign-series/checkpoints.jsonl',
    ledger.replace('"status":"READY"', '"status":"RUNNING"')
  );
  assert.equal(
    loadCampaignSeriesStore({ store, runId: 'series-run' }).status,
    'REFUSED'
  );
});

test('campaign wave material bytes are immutable and replay-verified', {
  skip: process.platform !== 'darwin'
}, () => {
  const data = fixture({ replayable: true });
  const home = mkdtempSync(join(tmpdir(), 'campaign-series-materials-'));
  const store = createStore(home);
  assert.equal(initializeCampaignSeriesStore({
    store, runId: 'series-run', plan: data.plan, state: data.state,
    rootBudgetLedger: data.ledger
  }).status, 'OK');
  assert.equal(persistCampaignSeriesWaveInputs({
    store, runId: 'series-run', waveId: 'wave-1', taskPack: data.pack,
    artifactRoot: data.root,
    config: { schemaVersion: 'wave-config-v1', objective: 'test' },
    budgetPolicies: [data.wavePolicy]
  }).status, 'OK');
  const path = 'campaign-series/waves/wave-1/materials.json';
  store.writeRunFile('series-run', path, store.readRunFile('series-run', path)
    .replace('// 1\\n', '// X\\n'));
  assert.equal(loadCampaignSeriesWaveInputs({
    store, runId: 'series-run', waveId: 'wave-1'
  }).status, 'REFUSED');
});
