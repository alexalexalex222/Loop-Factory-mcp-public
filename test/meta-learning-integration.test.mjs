import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { buildConsoleSnapshot } from '../src/console.mjs';
import { renderDashboard } from '../src/dashboard.mjs';
import { createEngine } from '../src/engine.mjs';
import { listImprovementMechanismReceipts } from '../src/improvement-memory.mjs';
import { DEFAULT_QUALITY_ORACLE, buildMeasuredContent } from '../src/measure.mjs';
import { createStore } from '../src/store.mjs';
import { runSupervisedCampaign } from '../src/supervisor.mjs';
import {
  BASELINE_BODY,
  SPECIFIC_TASK,
  freshEngine,
  recordMeasurement
} from './helpers.mjs';

const ROUTES = ['gpt-5.6-sol', 'claude-fable-5', 'gpt-5.6-terra'];
const BENCHMARK = {
  name: 'meta-learning-integration',
  taskValueDimensions: ['candidate-precision', 'evidence-fidelity'],
  resourceDimensions: ['token-cost'],
  cases: [{ id: 'case-1', input: 'sealed-session-corpus', expect: 'qualified loops' }],
  oracle: DEFAULT_QUALITY_ORACLE
};

function mechanismHypotheses(prefix = 'mechanism') {
  return ROUTES.map((model, index) => ({
    title: `${prefix} ${index + 1}: preserve evidence while reducing false positives`,
    bottleneck: 'The current workflow admits candidates before every claimed improvement is tied to a persisted measurement and a concrete evidence locator.',
    operation: 'Require each candidate to carry a frozen evidence reference, run the unchanged benchmark, and reject any result whose saved artifact cannot be reopened and rehashed.',
    expectedMovement: 'Increase tool-measured candidate precision without increasing the frozen token-cost bar.',
    falsifier: 'Reject the mechanism if the measured batch does not move the frozen frontier or if any artifact fails independent reverification.',
    evidenceRefs: [{
      path: 'test/meta-learning-integration.test.mjs',
      locator: `mechanismHypotheses:${index + 1}`
    }],
    route: { model }
  }));
}

function initializeMeasuredRun(engine, runId, {
  metaLearning = false,
  benchPartition = 'harvest'
} = {}) {
  const initialized = engine.initialize_loop_run({
    runId,
    task: SPECIFIC_TASK,
    config: metaLearning
      ? {
          metaLearning: {
            enabled: true,
            mode: 'shadow',
            policyId: 'meta-policy-v1',
            seed: `${runId}-seed`
          }
        }
      : undefined
  });
  assert.equal(initialized.status, 'OK');
  assert.equal(engine.artifact_record({
    runId,
    role: 'baseline',
    name: 'baseline.md',
    content: BASELINE_BODY
  }).status, 'OK');
  const proposed = engine.benchmark_propose({
    runId,
    benchmarks: [{ ...BENCHMARK, benchPartition }]
  });
  assert.equal(proposed.status, 'OK');
  assert.equal(engine.benchmark_select({
    runId,
    benchmarkId: proposed.benchmarkIds[0]
  }).status, 'OK');
  const baselineRef = recordMeasurement(engine, runId, 'baseline-bar', 1000, 0.7);
  assert.equal(engine.benchmark_run({
    runId,
    arm: 'baseline',
    measurementRef: baselineRef
  }).status, 'OK');
}

function measuredRuns(engine, runId, prefix = 'challenger') {
  return [
    ['gpt-5.6-sol', 940, 0.82],
    ['claude-fable-5', 950, 0.83],
    ['gpt-5.6-terra', 945, 0.84]
  ].map(([model, cost, quality], index) => ({
    model,
    measurementRef: recordMeasurement(
      engine,
      runId,
      `${prefix}-${index + 1}`,
      cost,
      quality
    )
  }));
}

test('feature-off runs retain legacy state and create no mechanism artifacts', () => {
  const { engine, store, home } = freshEngine();
  initializeMeasuredRun(engine, 'meta-off');
  const registered = engine.register_hypotheses({
    runId: 'meta-off',
    hypotheses: mechanismHypotheses('off')
  });
  assert.equal(registered.status, 'OK');
  const result = engine.test_hypothesis({
    runId: 'meta-off',
    hypothesisId: registered.hypothesisIds[0],
    fullTest: { agentRuns: measuredRuns(engine, 'meta-off') }
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.mechanismReceipt, undefined);
  const state = store.load('meta-off');
  assert.equal(state.config.metaLearning, undefined);
  assert.equal(state.metaLearning, undefined);
  assert.equal(existsSync(join(home, 'mechanisms')), false);
  assert.equal(store.runFileExists('meta-off', 'meta-shadow-packet.json'), false);
});

test('relative store homes resolve safely for mechanism persistence', () => {
  const absoluteHome = mkdtempSync(join(tmpdir(), 'meta-learning-relative-'));
  const relativeHome = relative(process.cwd(), absoluteHome);
  const store = createStore(relativeHome);
  const engine = createEngine(store);
  initializeMeasuredRun(engine, 'meta-relative', { metaLearning: true });
  const registered = engine.register_hypotheses({
    runId: 'meta-relative',
    hypotheses: mechanismHypotheses('relative')
  });
  const tested = engine.test_hypothesis({
    runId: 'meta-relative',
    hypothesisId: registered.hypothesisIds[0],
    fullTest: { agentRuns: measuredRuns(engine, 'meta-relative') }
  });
  assert.equal(tested.status, 'OK');
  assert.equal(tested.mechanismReceipt.status, 'OK');
  assert.equal(existsSync(join(absoluteHome, 'mechanisms', 'ledger.jsonl')), true);
});

test('enabled runs persist observed and reverified receipt revisions without changing hypotheses', () => {
  const { engine, store, home } = freshEngine();
  initializeMeasuredRun(engine, 'meta-on', { metaLearning: true });
  const hypotheses = mechanismHypotheses('enabled');
  const frozenInput = structuredClone(hypotheses);
  const registered = engine.register_hypotheses({
    runId: 'meta-on',
    hypotheses
  });
  assert.equal(registered.status, 'OK');
  assert.deepEqual(hypotheses, frozenInput, 'shadow routing must not mutate supplied hypotheses');
  assert.equal(store.runFileExists('meta-on', 'meta-shadow-packet.json'), true);
  const initialPacket = JSON.parse(store.readRunFile('meta-on', 'meta-shadow-packet.json'));
  assert.equal(initialPacket.status, 'ABSTAINED');
  assert.equal(initialPacket.affectedExecution, false);

  const tested = engine.test_hypothesis({
    runId: 'meta-on',
    hypothesisId: registered.hypothesisIds[0],
    fullTest: { agentRuns: measuredRuns(engine, 'meta-on') }
  });
  assert.equal(tested.status, 'OK');
  assert.equal(tested.verdict, 'MOVED_FRONTIER');
  assert.equal(tested.mechanismReceipt.status, 'OK');
  assert.equal(tested.mechanismReceipt.partition, 'harvest');
  assert.equal(tested.mechanismReceipt.eligibleForRouting, true);
  assert.equal(tested.mechanismReceipt.lifecycle, 'observed');

  const reverified = engine.reverify_run({
    runId: 'meta-on',
    testId: tested.testId
  });
  assert.equal(reverified.status, 'OK');
  assert.equal(reverified.mechanismReceipt.status, 'OK');
  assert.equal(reverified.mechanismReceipt.lifecycle, 'replicated');
  assert.equal(
    reverified.mechanismReceipt.mechanismId,
    tested.mechanismReceipt.mechanismId
  );
  assert.notEqual(
    reverified.mechanismReceipt.receiptId,
    tested.mechanismReceipt.receiptId
  );

  const listed = listImprovementMechanismReceipts({
    homeDir: home,
    partitions: ['harvest', 'reference', 'gate'],
    includeIneligible: true
  });
  assert.equal(listed.status, 'OK');
  assert.equal(listed.receipts.length, 2);
  assert.deepEqual(
    listed.receipts.map((receipt) => receipt.lifecycle.state).sort(),
    ['observed', 'replicated']
  );
  assert.ok(listed.receipts.every((receipt) => (
    receipt.provenance.artifacts.length === 4
    && receipt.provenance.evidenceRefs.length === 1
  )));
  const state = store.load('meta-on');
  assert.equal(state.metaLearning.ledger.total, 2);
  assert.equal(state.metaLearning.ledger.eligibleForRouting, 2);
  assert.equal(state.metaLearning.affectedExecution, false);
});

test('gate-partition receipts remain persisted evidence but never enter routing', () => {
  const { engine, home } = freshEngine();
  initializeMeasuredRun(engine, 'meta-gate', {
    metaLearning: true,
    benchPartition: 'gate'
  });
  const registered = engine.register_hypotheses({
    runId: 'meta-gate',
    hypotheses: mechanismHypotheses('gate')
  });
  const tested = engine.test_hypothesis({
    runId: 'meta-gate',
    hypothesisId: registered.hypothesisIds[0],
    fullTest: { agentRuns: measuredRuns(engine, 'meta-gate') }
  });
  assert.equal(tested.status, 'OK');
  assert.equal(tested.mechanismReceipt.partition, 'gate');
  assert.equal(tested.mechanismReceipt.eligibleForRouting, false);
  assert.deepEqual(
    listImprovementMechanismReceipts({ homeDir: home }).receipts,
    []
  );
  const all = listImprovementMechanismReceipts({
    homeDir: home,
    partitions: ['gate'],
    includeIneligible: true
  });
  assert.equal(all.receipts.length, 1);
  assert.equal(all.receipts[0].eligibleForRouting, false);
});

test('meta-layer persistence failure falls back without changing the measured verdict', () => {
  const { engine, store, home } = freshEngine();
  initializeMeasuredRun(engine, 'meta-fallback', { metaLearning: true });
  const registered = engine.register_hypotheses({
    runId: 'meta-fallback',
    hypotheses: mechanismHypotheses('fallback')
  });
  const outside = mkdtempSync(join(tmpdir(), 'meta-learning-outside-'));
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(home, 'mechanisms'));

  const tested = engine.test_hypothesis({
    runId: 'meta-fallback',
    hypothesisId: registered.hypothesisIds[0],
    fullTest: { agentRuns: measuredRuns(engine, 'meta-fallback') }
  });
  assert.equal(tested.status, 'OK');
  assert.equal(tested.verdict, 'MOVED_FRONTIER');
  assert.deepEqual(tested.mechanismReceipt, {
    status: 'FALLBACK',
    code: 'META_POLICY_FALLBACK'
  });
  const state = store.load('meta-fallback');
  assert.equal(state.metaLearning.shadow.status, 'FALLBACK');
  assert.equal(state.metaLearning.shadow.fallbackCode, 'META_POLICY_FALLBACK');
  assert.equal(state.metaLearning.shadow.affectedExecution, false);
  assert.ok(state.metaLearning.fallbacks.length >= 1);
});

test('supervisor child runs inherit shadow mode and target evidence references', () => {
  const { engine, store } = freshEngine();
  const worker = (contract) => {
    if (contract.kind === 'baseline') {
      return {
        route: contract.route,
        artifacts: [{ role: 'runlog', content: buildMeasuredContent(1000, 0.7) }],
        finalOutput: buildMeasuredContent(1000, 0.7)
      };
    }
    return {
      route: contract.route,
      artifacts: [{ role: 'runlog', content: buildMeasuredContent(900, 0.86) }],
      finalOutput: buildMeasuredContent(900, 0.86)
    };
  };
  const result = runSupervisedCampaign(engine, {
    runId: 'meta-supervisor',
    task: SPECIFIC_TASK,
    engineConfig: {
      metaLearning: {
        enabled: true,
        mode: 'shadow',
        policyId: 'meta-policy-v1',
        seed: 'meta-supervisor-seed'
      }
    },
    targets: [{
      kind: 'improve',
      loop: 'loop-de-loop',
      baselineContent: BASELINE_BODY,
      benchmark: BENCHMARK,
      routes: ROUTES,
      evidenceRefs: [{
        path: 'src/supervisor.mjs',
        locator: 'runImproveTarget'
      }]
    }]
  }, {
    worker,
    maxBatches: 10
  });
  assert.equal(result.status, 'OK');
  const child = store.load('meta-supervisor-t1');
  assert.equal(child.config.metaLearning.enabled, true);
  assert.equal(child.config.metaLearning.mode, 'shadow');
  assert.equal(child.metaLearning.affectedExecution, false);
  assert.ok(child.metaLearning.ledger.total >= 2);
  assert.ok(child.hypotheses.every((hypothesis) => (
    hypothesis.evidenceRefs.length === 1
    && hypothesis.evidenceRefs[0].path === 'src/supervisor.mjs'
  )));
  assert.equal(store.runFileExists('meta-supervisor-t1', 'meta-shadow-packet.json'), true);
});

test('public console and dashboard expose only bounded observational learning data', () => {
  const { engine, store } = freshEngine();
  initializeMeasuredRun(engine, 'meta-public', { metaLearning: true });
  const state = store.load('meta-public');
  state.metaLearning.privateMechanism = 'PRIVATE_MECHANISM_PROSE';
  state.metaLearning.privatePath = '/Users/operator/private/evidence.json';
  state.metaLearning.shadow = {
    status: 'COMPLETE',
    packetSha256: 'a'.repeat(64),
    eligibleCount: 99,
    abstentionCode: null,
    fallbackCode: null,
    affectedExecution: false,
    selected: Array.from({ length: 7 }, (_, index) => ({
      slot: index < 2 ? `related-${index + 1}` : 'wildcard',
      mechanismId: `mech-${String(index + 1).padStart(24, '0')}`,
      receiptId: `receipt-${String(index + 1).padStart(24, '0')}`,
      receiptSha256: String(index + 1).repeat(64).slice(0, 64),
      source: {
        runId: `source-run-secret-${index}`,
        hypothesisId: `source-hyp-secret-${index}`,
        testId: `source-test-secret-${index}`
      },
      score: index === 1 ? null : 0.8 - index * 0.01,
      selectionProbability: 0.2
    }))
  };
  store.save(state);

  const snapshot = buildConsoleSnapshot(store.load('meta-public'));
  assert.equal(snapshot.learning.enabled, true);
  assert.equal(snapshot.learning.mode, 'shadow');
  assert.equal(snapshot.learning.affectedExecution, false);
  assert.equal(snapshot.learning.shadow.status, 'PARTIAL');
  assert.equal(snapshot.learning.shadow.selected.length, 4);
  assert.ok(snapshot.learning.shadow.selected.every((item) => (
    item.sourceRunId.startsWith('runref-')
    && item.hypothesisId.startsWith('hypref-')
    && item.testId.startsWith('testref-')
  )));
  const json = JSON.stringify(snapshot);
  for (const forbidden of [
    'PRIVATE_MECHANISM_PROSE',
    '/Users/operator',
    'source-run-secret',
    'source-hyp-secret',
    'source-test-secret',
    '"privateMechanism"',
    '"privatePath"'
  ]) {
    assert.ok(!json.includes(forbidden), `public snapshot must omit ${forbidden}`);
  }

  const html = renderDashboard(store.load('meta-public'));
  assert.match(html, /data-learning-panel/);
  assert.match(html, /data-learning-status/);
  assert.match(html, /Observed only\. Did not affect execution\./);
  assert.match(html, /Partial/);
  assert.match(html, /function renderLearning\(data\)/);
  const initialMarkup = html.split('<script id="run-data"')[0];
  assert.equal((initialMarkup.match(/data-learning-selection/g) || []).length, 4);
  assert.ok(html.indexOf('Learning layer') < html.indexOf('Failure budget'));
  assert.doesNotMatch(html, /PRIVATE_MECHANISM_PROSE|\/Users\/operator|source-run-secret/);
});
