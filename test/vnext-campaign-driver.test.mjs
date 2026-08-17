import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createResourceBudgetLedger, createResourceBudgetPolicy } from '../src/resource-budget.mjs';
import { createCampaignSeriesPlan, createCampaignSeriesState } from '../src/campaign-series.mjs';
import { initializeCampaignSeriesStore } from '../src/campaign-series-store.mjs';
import {
  recoverVNextCampaignWave,
  runVNextCampaignSeriesContinuous,
  runVNextCampaignSeriesTick,
  validateVNextCampaignVerifierEvidence,
  verifyVNextCampaignSeries
} from '../src/vnext-campaign-driver.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'vnext-campaign-driver-'));
  const store = createStore(home);
  const policy = createResourceBudgetPolicy({
    policyId: 'driver-root-budget', maxCalls: 10, maxInputTokens: 1000,
    maxOutputTokens: 500, maxTotalTokens: 1500, maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0, outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd', currency: 'USD'
  }).policy;
  const plan = createCampaignSeriesPlan({
    seriesId: 'driver-series', createdAt: '2026-08-05T00:00:00.000Z',
    maximumWaves: 1, familywiseAlpha: 0.05, maximumCalls: 10,
    modelPolicySha256: '1'.repeat(64), evaluatorPolicySha256: '2'.repeat(64),
    implementationSha256: '3'.repeat(64), budgetPolicy: policy
  }).plan;
  const state = createCampaignSeriesState({ plan, runId: 'driver-run' }).state;
  const ledger = createResourceBudgetLedger({
    policy, runId: 'driver-run', createdAt: plan.createdAt
  }).ledger;
  assert.equal(initializeCampaignSeriesStore({
    store, runId: 'driver-run', plan, state, rootBudgetLedger: ledger
  }).status, 'OK');
  return { store };
}

test('continuous idle polling performs zero inference and no state churn', async () => {
  const { store } = fixture();
  const first = await runVNextCampaignSeriesTick({ store, seriesRunId: 'driver-run' });
  assert.equal(first.status, 'OK');
  assert.equal(first.inferenceCalls, 0);
  const revision = first.state.revision;
  const loop = await runVNextCampaignSeriesContinuous({
    store, seriesRunId: 'driver-run', pollIntervalMs: 100, maximumTicks: 2
  });
  assert.equal(loop.inferenceCalls, 0);
  assert.equal(loop.state.revision, revision);
  assert.equal(verifyVNextCampaignSeries({
    store, seriesRunId: 'driver-run'
  }).seriesValid, true);
});

test('the persisted stop file terminates the campaign without inference', async () => {
  const { store } = fixture();
  store.writeRunFile('driver-run', 'campaign-series/STOP', 'operator stop\n');
  const stopped = await runVNextCampaignSeriesTick({
    store, seriesRunId: 'driver-run'
  });
  assert.equal(stopped.status, 'OK');
  assert.equal(stopped.disposition, 'OPERATOR_STOP');
  assert.equal(stopped.inferenceCalls, 0);
  assert.equal(stopped.state.operatorStop, true);
});

test('campaign verifier evidence rejects extension fields at the authority boundary', () => {
  const evidence = {
    schemaVersion: 'loop-factory-vnext-campaign-verifier-v1',
    seriesRunId: 'driver-run',
    planSha256: '1'.repeat(64),
    stateSha256: '2'.repeat(64),
    checkpointSha256: '3'.repeat(64),
    rootBudgetLedgerSha256: '4'.repeat(64),
    leaseHistorySha256: null,
    waves: [{
      waveId: 'wave-1',
      disposition: 'QUEUED',
      valid: true,
      evidenceSha256: '5'.repeat(64)
    }],
    status: 'ACTIVE',
    operatorStop: false,
    seriesValid: true,
    promotionAuthorized: false
  };
  assert.equal(validateVNextCampaignVerifierEvidence(evidence).status, 'OK');
  assert.equal(validateVNextCampaignVerifierEvidence({
    ...evidence,
    smuggled: true
  }).status, 'REFUSED');
  assert.equal(validateVNextCampaignVerifierEvidence({
    ...evidence,
    waves: [{ ...evidence.waves[0], smuggled: true }]
  }).status, 'REFUSED');
});

test('outer campaign recovery invokes the inner durable wave runner, not verify-only replay', async () => {
  const { store } = fixture();
  let received = null;
  const recovered = await recoverVNextCampaignWave({
    store,
    seriesRunId: 'driver-run',
    descriptor: { waveId: 'wave-1' },
    shouldStop: () => false,
    progressObserver: () => {},
    resumeWave: async (input) => {
      received = input;
      return { status: 'OK', resumed: true };
    }
  });
  assert.equal(recovered.status, 'OK');
  assert.equal(recovered.resumed, true);
  assert.equal(received.seriesRunId, 'driver-run');
  assert.equal(received.waveId, 'wave-1');
  assert.equal(typeof received.shouldStop, 'function');
  assert.equal(typeof received.progressObserver, 'function');
});
