import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createStore } from '../../src/store.mjs';
import {
  createCampaignSeriesPlan,
  createCampaignSeriesState
} from '../../src/campaign-series.mjs';
import {
  createResourceBudgetLedger,
  createResourceBudgetPolicy
} from '../../src/resource-budget.mjs';
import { initializeCampaignSeriesStore } from '../../src/campaign-series-store.mjs';
import {
  createMechanismFamilyRecord,
  createMetaPolicyEpochRecord
} from '../../src/adaptive-records.mjs';
import { DEFAULT_ADAPTIVE_POLICY } from '../../src/adaptive-policy.mjs';
import { persistAdaptiveRecord } from '../../src/mechanism-catalog.mjs';
import { initializeVNextOperatorControl } from '../../src/vnext-operator-control.mjs';
import { sha256 } from '../../src/util.mjs';
import { canaryState } from './canary-state.mjs';

const homeFlag = process.argv.indexOf('--home');
if (homeFlag >= 0 && process.argv[homeFlag + 1]) {
const homeDir = resolve(process.argv[homeFlag + 1]);
const store = createStore(homeDir);
const createdAt = '2026-08-05T05:30:00.000Z';
const budget = createResourceBudgetPolicy({
  policyId: 'ui-fixture-root-budget',
  maxCalls: 254,
  maxInputTokens: 254000,
  maxOutputTokens: 127000,
  maxTotalTokens: 381000,
  maxUsdMicros: 0,
  inputUsdMicrosPerMillionTokens: 0,
  outputUsdMicrosPerMillionTokens: 0,
  billingMode: 'subscription-no-metered-usd',
  currency: 'USD'
});
assert.equal(budget.status, 'OK');
const plan = createCampaignSeriesPlan({
  seriesId: 'ui-fixture-series',
  createdAt,
  maximumWaves: 2,
  familywiseAlpha: 0.05,
  maximumCalls: 254,
  modelPolicySha256: sha256('ui-fixture-gpt-5.6-sol-high'),
  evaluatorPolicySha256: sha256('ui-fixture-isolated-evaluator'),
  implementationSha256: sha256('ui-fixture-implementation'),
  budgetPolicy: budget.policy
});
assert.equal(plan.status, 'OK');
const state = createCampaignSeriesState({
  plan: plan.plan,
  runId: 'ui-fixture-vnext'
});
assert.equal(state.status, 'OK');
const ledger = createResourceBudgetLedger({
  policy: budget.policy,
  runId: 'ui-fixture-vnext',
  createdAt
});
assert.equal(ledger.status, 'OK');
assert.equal(initializeCampaignSeriesStore({
  store,
  runId: 'ui-fixture-vnext',
  plan: plan.plan,
  state: state.state,
  rootBudgetLedger: ledger.ledger
}).status, 'OK');
store.save(state.state);

const family = createMechanismFamilyRecord({
  causalFingerprint: {
    bottleneckKind: 'cross-domain-evidence-retrieval',
    interventionKind: 'negative-precedent-diversification',
    operationKind: 'bounded-context-selection',
    expectedEffectKind: 'fewer-repeated-failures',
    preconditions: ['verified-evidence', 'partition-firewall'],
    applicability: {
      taskModes: ['improve'],
      loopRoles: ['hypothesizer'],
      taskValueDimensions: ['quality', 'generalization'],
      resourceDimensions: ['token-cost']
    }
  }
});
assert.equal(family.status, 'OK');
assert.equal(persistAdaptiveRecord({ homeDir, record: family.record }).status, 'OK');

const epoch0 = createMetaPolicyEpochRecord({
  policyScopeId: 'ui-fixture-routing',
  epochNumber: 0,
  trigger: 'initial',
  previousEpoch: null,
  validApplicationCount: 0,
  evidenceWindowSha256: sha256('ui-fixture-epoch-0'),
  baselinePolicy: DEFAULT_ADAPTIVE_POLICY,
  policy: DEFAULT_ADAPTIVE_POLICY,
  quarantinedFamilyIds: []
});
assert.equal(epoch0.status, 'OK');
const epoch1 = createMetaPolicyEpochRecord({
  policyScopeId: 'ui-fixture-routing',
  epochNumber: 1,
  trigger: 'lane-boundary',
  previousEpoch: epoch0.record,
  validApplicationCount: 5,
  evidenceWindowSha256: sha256('ui-fixture-epoch-1'),
  baselinePolicy: DEFAULT_ADAPTIVE_POLICY,
  policy: DEFAULT_ADAPTIVE_POLICY,
  quarantinedFamilyIds: []
});
assert.equal(epoch1.status, 'OK');
assert.equal(persistAdaptiveRecord({ homeDir, record: epoch0.record }).status, 'OK');
assert.equal(persistAdaptiveRecord({ homeDir, record: epoch1.record }).status, 'OK');
assert.equal(initializeVNextOperatorControl({ homeDir, createdAt }).status, 'OK');

const canary = canaryState();
canary.runId = 'ui-fixture-causal-canary';
canary.verification.runId = canary.runId;
store.save(canary);

console.log(JSON.stringify({
  status: 'OK',
  fixtureOnly: true,
  homeDir,
  runs: store.listRuns(),
  familyId: family.record.familyId
}, null, 2));
}
