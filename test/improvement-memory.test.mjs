import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildImprovementMechanismReceipt,
  canonicalMechanismJson,
  listImprovementMechanismReceipts,
  persistImprovementMechanismReceipt,
  summarizeImprovementMechanisms
} from '../src/improvement-memory.mjs';
import { sha256 } from '../src/util.mjs';

const CLOCK = () => '2026-07-21T06:15:00.000Z';

function artifact(id, role = 'runlog') {
  const content = `artifact bytes for ${id}`;
  return { id, role, content, sha256: sha256(content) };
}

function fixture({
  partition = 'harvest',
  verdict = 'MOVED_FRONTIER',
  movementCode = verdict === 'MOVED_FRONTIER' ? 'PROMOTE' : 'BELOW_THRESHOLD',
  quality = 0.84,
  tokenCost = 900,
  reverified = false,
  includeTest = true,
  includeBenchmark = true
} = {}) {
  const artifacts = new Map([
    ['art-baseline', artifact('art-baseline', 'baseline')],
    ['art-run-1', artifact('art-run-1')],
    ['art-run-2', artifact('art-run-2')],
    ['art-run-3', artifact('art-run-3')]
  ]);
  const benchmarkDef = includeBenchmark ? {
    id: 'bench-001',
    name: 'mechanism-memory-fixture',
    benchPartition: partition,
    taskValueDimensions: ['quality', 'evidence-fidelity'],
    resourceDimensions: ['token-cost'],
    cases: [{ id: 'case-001' }]
  } : null;
  const state = {
    runId: 'run-001',
    createdAt: '2026-07-21T06:00:00.000Z',
    updatedAt: '2026-07-21T06:14:45.000Z',
    task: {
      sha256: 'a'.repeat(64),
      mode: 'improve'
    },
    config: {
      realTest: { findingId: 'finding-001' },
      metaLearning: {
        enabled: true,
        mode: 'shadow',
        policyId: 'meta-policy-v1',
        policySha256: 'b'.repeat(64)
      }
    },
    activeLoop: 'loop-de-loop',
    baseline: { recorded: true, artifactId: 'art-baseline' },
    benchmark: includeBenchmark ? {
      def: benchmarkDef,
      baselineScore: {
        quality: 0.7,
        tokenCost: 1000,
        artifactOutputTokenEstimate: 1000,
        cliReceiptTokenCost: null,
        n: 3
      },
      negativeControl: {
        passed: false,
        sha256: 'c'.repeat(64)
      }
    } : {},
    hypotheses: [{
      id: 'hyp-001',
      findingId: 'finding-001',
      title: 'Inspect inherited context before isolation passes',
      bottleneck: 'Executable-event-only inspection misses inherited non-tool context.',
      operation: 'Inspect hook, skill, plugin, and memory diagnostics before passing isolation.',
      expectedMovement: 'Reduce false isolation passes while preserving clean controls.',
      falsifier: 'Reject if inherited contamination still passes or clean controls regress.'
    }],
    tests: includeTest ? [{
      id: 'test-001',
      hypothesisId: 'hyp-001',
      ts: '2026-07-21T06:14:00.000Z',
      source: 'tool',
      qualityAuthority: 'tool-computed',
      reverified,
      reverifiedAt: reverified ? '2026-07-21T06:14:30.000Z' : null,
      verdict,
      movement: {
        code: movementCode
      },
      agg: {
        quality,
        tokenCost,
        artifactOutputTokenEstimate: tokenCost,
        cliReceiptTokenCost: null,
        n: 3,
        stdevQuality: 0.01
      },
      agentRuns: [
        { model: 'gpt-5.6-sol', measurementRef: 'art-run-1' },
        { model: 'gpt-5.6-sol', measurementRef: 'art-run-2' },
        { model: 'gpt-5.6-sol', measurementRef: 'art-run-3' }
      ]
    }] : []
  };
  return {
    state,
    artifacts,
    readArtifact(runId, artifactId) {
      assert.equal(runId, state.runId);
      return artifacts.get(artifactId) || null;
    }
  };
}

function build(options = {}, buildOptions = {}) {
  const data = fixture(options);
  const result = buildImprovementMechanismReceipt({
    state: data.state,
    hypothesisId: 'hyp-001',
    testId: options.includeTest === false ? null : 'test-001',
    clock: CLOCK,
    readArtifact: data.readArtifact,
    evidenceRefs: [{
      path: 'proof/harvest/run-001/state.json',
      locator: 'hypothesis hyp-001 test test-001',
      sha256: 'd'.repeat(64)
    }],
    ...buildOptions
  });
  assert.equal(result.status, 'OK', result.message);
  return { ...data, receipt: result.receipt };
}

test('builds deterministic evidence-bound improvement receipts', () => {
  const first = build();
  const second = build();
  assert.deepEqual(first.receipt, second.receipt);
  const differentWallClock = buildImprovementMechanismReceipt({
    state: first.state,
    hypothesisId: 'hyp-001',
    testId: 'test-001',
    clock: () => '2026-07-21T18:00:00.000Z',
    readArtifact: first.readArtifact,
    evidenceRefs: [{
      path: 'proof/harvest/run-001/state.json',
      locator: 'hypothesis hyp-001 test test-001',
      sha256: 'd'.repeat(64)
    }]
  });
  assert.equal(differentWallClock.status, 'OK');
  assert.deepEqual(
    differentWallClock.receipt,
    first.receipt,
    'persisted test time, not rebuild wall-clock time, owns receipt identity'
  );
  assert.match(first.receipt.mechanismId, /^mech-[a-f0-9]{24}$/);
  assert.match(first.receipt.receiptId, /^receipt-[a-f0-9]{24}$/);
  assert.match(first.receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.receipt.outcome.verdict, 'improvement');
  assert.equal(first.receipt.lifecycle.state, 'observed');
  assert.equal(first.receipt.partition, 'harvest');
  assert.equal(first.receipt.eligibleForRouting, true);
  assert.equal(first.receipt.measurement.delta.quality, 0.14);
  assert.equal(first.receipt.measurement.delta.tokenCost, -100);
  assert.equal(first.receipt.measurement.baseline.cliReceiptTokenCost, null);
  assert.equal(first.receipt.measurement.challenger.cliReceiptTokenCost, null);
  assert.equal(first.receipt.measurement.shamMovement, null);
  assert.equal(first.receipt.provenance.artifacts.length, 4);
  assert.deepEqual(
    first.receipt.provenance.artifacts.map((item) => item.artifactId),
    ['art-baseline', 'art-run-1', 'art-run-2', 'art-run-3']
  );
  assert.equal(first.receipt.provenance.evidenceRefs[0].sha256, 'd'.repeat(64));

  const emptyMeasurements = fixture();
  emptyMeasurements.state.benchmark.baselineScore.cliReceiptTokenCost = '';
  emptyMeasurements.state.tests[0].agg.cliReceiptTokenCost = '';
  const emptyResult = buildImprovementMechanismReceipt({
    state: emptyMeasurements.state,
    hypothesisId: 'hyp-001',
    testId: 'test-001',
    clock: CLOCK,
    readArtifact: emptyMeasurements.readArtifact,
    outcomeOverlay: { shamMovement: '' }
  });
  assert.equal(emptyResult.status, 'OK');
  assert.equal(emptyResult.receipt.measurement.baseline.cliReceiptTokenCost, null);
  assert.equal(emptyResult.receipt.measurement.challenger.cliReceiptTokenCost, null);
  assert.equal(emptyResult.receipt.measurement.shamMovement, null);
});

test('reverified evidence creates a new receipt revision with the same mechanism identity', () => {
  const observed = build();
  const replicated = build({ reverified: true });
  assert.equal(replicated.receipt.mechanismId, observed.receipt.mechanismId);
  assert.notEqual(replicated.receipt.receiptId, observed.receipt.receiptId);
  assert.notEqual(replicated.receipt.receiptSha256, observed.receipt.receiptSha256);
  assert.equal(replicated.receipt.measurement.reverified, true);
  assert.equal(replicated.receipt.outcome.reverifiedAt, '2026-07-21T06:14:30.000Z');
  assert.equal(replicated.receipt.lifecycle.state, 'replicated');
});

test('classifies no-improvement, tradeoff, and regression without inventing a win', () => {
  const noImprovement = build({
    verdict: 'NO_IMPROVEMENT',
    movementCode: 'BELOW_THRESHOLD',
    quality: 0.7,
    tokenCost: 1000
  }).receipt;
  const tradeoff = build({
    verdict: 'STAGED_TRADEOFF',
    movementCode: 'STAGED_TRADEOFF',
    quality: 0.82,
    tokenCost: 1500
  }).receipt;
  const regression = build({
    verdict: 'NO_IMPROVEMENT',
    movementCode: 'BELOW_FLOOR',
    quality: 0.6,
    tokenCost: 900
  }).receipt;

  assert.equal(noImprovement.outcome.verdict, 'no_improvement');
  assert.equal(noImprovement.lifecycle.state, 'observed');
  assert.equal(tradeoff.outcome.verdict, 'tradeoff');
  assert.equal(tradeoff.measurement.delta.tokenCostPct, 0.5);
  assert.equal(regression.outcome.verdict, 'regression');
  assert.equal(regression.lifecycle.state, 'contradicted');

  const overlayCannotUpgrade = build({
    verdict: 'NO_IMPROVEMENT',
    movementCode: 'BELOW_THRESHOLD',
    quality: 0.7,
    tokenCost: 1000
  }, {
    outcomeOverlay: {
      verdict: 'improvement',
      valid: true
    }
  }).receipt;
  assert.equal(overlayCannotUpgrade.outcome.verdict, 'no_improvement');
});

test('failed transfer or control evidence contradicts a mechanism', () => {
  const { receipt } = build({}, {
    outcomeOverlay: {
      controlRegressions: 1,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: false,
        evidenceSha256: 'e'.repeat(64)
      }]
    }
  });
  assert.equal(receipt.outcome.verdict, 'regression');
  assert.equal(receipt.lifecycle.state, 'contradicted');
  assert.equal(receipt.measurement.controlRegressions, 1);
  assert.equal(receipt.measurement.transferChecks.find((item) => item.kind === 'heldOut').passed, false);
});

test('gate receipts remain local evidence but are never routing eligible', () => {
  const { receipt } = build({ partition: 'gate', reverified: true });
  assert.equal(receipt.partition, 'gate');
  assert.equal(receipt.eligibleForRouting, false);
  assert.equal(receipt.lifecycle.state, 'replicated');
});

test('sparse historical state records an invalid attempt without a migration', () => {
  const sparse = build(
    { includeTest: false, includeBenchmark: false },
    { testId: null }
  );
  const { receipt } = sparse;
  const rebuilt = buildImprovementMechanismReceipt({
    state: sparse.state,
    hypothesisId: 'hyp-001',
    testId: null,
    clock: () => '2026-07-21T19:59:59.000Z',
    readArtifact: sparse.readArtifact,
    evidenceRefs: [{
      path: 'proof/harvest/run-001/state.json',
      locator: 'hypothesis hyp-001 test test-001',
      sha256: 'd'.repeat(64)
    }]
  });
  assert.equal(rebuilt.status, 'OK');
  assert.deepEqual(rebuilt.receipt, receipt);
  assert.equal(receipt.generatedAt, sparse.state.updatedAt);
  assert.equal(receipt.partition, 'reference');
  assert.equal(receipt.eligibleForRouting, false);
  assert.equal(receipt.source.testId, null);
  assert.equal(receipt.outcome.verdict, 'invalid');
  assert.equal(receipt.outcome.valid, false);
  assert.equal(receipt.outcome.code, 'NO_PERSISTED_TEST');
  assert.equal(receipt.lifecycle.state, 'observed');

  const malformedTestTime = fixture();
  malformedTestTime.state.tests[0].ts = 'not-a-timestamp';
  const persistedFallback = buildImprovementMechanismReceipt({
    state: malformedTestTime.state,
    hypothesisId: 'hyp-001',
    testId: 'test-001',
    clock: () => '2026-07-21T20:00:00.000Z',
    readArtifact: malformedTestTime.readArtifact
  });
  assert.equal(persistedFallback.status, 'OK');
  assert.equal(persistedFallback.receipt.generatedAt, malformedTestTime.state.updatedAt);
});

test('unsafe or incomplete persisted identities return structured refusals', () => {
  const data = fixture();
  const unknown = buildImprovementMechanismReceipt({
    state: data.state,
    hypothesisId: 'hyp-missing',
    clock: CLOCK,
    readArtifact: data.readArtifact
  });
  assert.equal(unknown.status, 'REFUSED');
  assert.equal(unknown.code, 'UNKNOWN_HYPOTHESIS');

  const unsafe = buildImprovementMechanismReceipt({
    state: data.state,
    hypothesisId: '../hyp',
    clock: CLOCK,
    readArtifact: data.readArtifact
  });
  assert.equal(unsafe.status, 'REFUSED');
  assert.equal(unsafe.code, 'INVALID_HYPOTHESIS_ID');

  data.state.hypotheses[0].falsifier = '';
  const incomplete = buildImprovementMechanismReceipt({
    state: data.state,
    hypothesisId: 'hyp-001',
    clock: CLOCK,
    readArtifact: data.readArtifact
  });
  assert.equal(incomplete.status, 'REFUSED');
  assert.equal(incomplete.code, 'INCOMPLETE_HYPOTHESIS');

  const fresh = fixture({ includeTest: false });
  const invalidCannotClaimImprovement = buildImprovementMechanismReceipt({
    state: fresh.state,
    hypothesisId: 'hyp-001',
    clock: CLOCK,
    readArtifact: fresh.readArtifact,
    outcomeOverlay: { verdict: 'improvement', valid: false }
  });
  assert.equal(invalidCannotClaimImprovement.status, 'OK');
  assert.equal(invalidCannotClaimImprovement.receipt.outcome.verdict, 'invalid');

  const missingEvidenceCannotBeUpgraded = buildImprovementMechanismReceipt({
    state: fresh.state,
    hypothesisId: 'hyp-001',
    clock: CLOCK,
    readArtifact: fresh.readArtifact,
    outcomeOverlay: { verdict: 'improvement', valid: true }
  });
  assert.equal(missingEvidenceCannotBeUpgraded.status, 'OK');
  assert.equal(missingEvidenceCannotBeUpgraded.receipt.outcome.verdict, 'invalid');
  assert.equal(missingEvidenceCannotBeUpgraded.receipt.outcome.valid, false);

  const partialEvidence = fixture();
  partialEvidence.artifacts.delete('art-run-2');
  const missingOneArtifact = buildImprovementMechanismReceipt({
    state: partialEvidence.state,
    hypothesisId: 'hyp-001',
    testId: 'test-001',
    clock: CLOCK,
    readArtifact: partialEvidence.readArtifact
  });
  assert.equal(missingOneArtifact.status, 'OK');
  assert.equal(missingOneArtifact.receipt.outcome.verdict, 'invalid');
  assert.equal(missingOneArtifact.receipt.outcome.valid, false);
  assert.equal(missingOneArtifact.receipt.eligibleForRouting, false);
});

test('persistence is append-only, deterministic, and idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'mechanism-memory-'));
  const { receipt } = build({ reverified: true });
  const first = persistImprovementMechanismReceipt({ homeDir: home, receipt });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(first.idempotent, false);
  assert.equal(existsSync(first.receiptPath), true);
  assert.equal(
    readFileSync(first.receiptPath, 'utf8'),
    `${canonicalMechanismJson(receipt)}\n`
  );

  const second = persistImprovementMechanismReceipt({ homeDir: home, receipt });
  assert.equal(second.status, 'OK');
  assert.equal(second.idempotent, true);
  const ledgerLines = readFileSync(second.ledgerPath, 'utf8').trim().split('\n');
  assert.equal(ledgerLines.length, 1);
  assert.equal(JSON.parse(ledgerLines[0]).receiptId, receipt.receiptId);
});

test('immutable receipt conflicts are refused instead of overwritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'mechanism-conflict-'));
  const { receipt } = build();
  const first = persistImprovementMechanismReceipt({ homeDir: home, receipt });
  assert.equal(first.status, 'OK');
  writeFileSync(first.receiptPath, '{}\n');
  const conflict = persistImprovementMechanismReceipt({ homeDir: home, receipt });
  assert.equal(conflict.status, 'REFUSED');
  assert.equal(conflict.code, 'RECEIPT_CONFLICT');
  assert.equal(readFileSync(first.receiptPath, 'utf8'), '{}\n');
});

test('listing defaults to eligible harvest receipts and filters gate evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'mechanism-list-'));
  const harvest = build({ partition: 'harvest', reverified: true }).receipt;
  const gate = build({ partition: 'gate', reverified: true }).receipt;
  assert.equal(persistImprovementMechanismReceipt({ homeDir: home, receipt: harvest }).status, 'OK');
  assert.equal(persistImprovementMechanismReceipt({ homeDir: home, receipt: gate }).status, 'OK');

  const defaultList = listImprovementMechanismReceipts({ homeDir: home });
  assert.equal(defaultList.status, 'OK');
  assert.deepEqual(defaultList.receipts.map((item) => item.receiptId), [harvest.receiptId]);

  const gateList = listImprovementMechanismReceipts({
    homeDir: home,
    partitions: ['gate'],
    includeIneligible: true
  });
  assert.equal(gateList.status, 'OK');
  assert.deepEqual(gateList.receipts.map((item) => item.receiptId), [gate.receiptId]);
  assert.equal(gateList.receipts[0].eligibleForRouting, false);
});

test('invalid receipt files are quarantined from listing without throwing', () => {
  const home = mkdtempSync(join(tmpdir(), 'mechanism-corrupt-'));
  const { receipt } = build();
  const persisted = persistImprovementMechanismReceipt({ homeDir: home, receipt });
  assert.equal(persisted.status, 'OK');
  writeFileSync(
    join(home, 'mechanisms', 'receipts', 'receipt-000000000000000000000000.json'),
    '{bad json'
  );
  const listed = listImprovementMechanismReceipts({
    homeDir: home,
    partitions: ['harvest'],
    includeIneligible: true
  });
  assert.equal(listed.status, 'OK');
  assert.equal(listed.receipts.length, 1);
  assert.deepEqual(listed.rejected, [{
    filename: 'receipt-000000000000000000000000.json',
    code: 'RECEIPT_PARSE_FAILED'
  }]);
});

test('path traversal and tampered receipt identities fail closed', () => {
  const { receipt } = build();
  const relative = persistImprovementMechanismReceipt({
    homeDir: '../outside',
    receipt
  });
  assert.equal(relative.status, 'REFUSED');
  assert.equal(relative.code, 'UNSAFE_HOME');

  const traversing = persistImprovementMechanismReceipt({
    homeDir: `${tmpdir()}/safe/../outside`,
    receipt
  });
  assert.equal(traversing.status, 'REFUSED');
  assert.equal(traversing.code, 'UNSAFE_HOME');

  const tampered = {
    ...receipt,
    receiptId: 'receipt-000000000000000000000000'
  };
  const rejected = persistImprovementMechanismReceipt({
    homeDir: mkdtempSync(join(tmpdir(), 'mechanism-tamper-')),
    receipt: tampered
  });
  assert.equal(rejected.status, 'REFUSED');
  assert.equal(rejected.code, 'RECEIPT_HASH_MISMATCH');

  const malformedPayload = {
    ...receipt,
    mechanism: {
      ...receipt.mechanism
    }
  };
  delete malformedPayload.mechanism.operation;
  delete malformedPayload.receiptId;
  delete malformedPayload.receiptSha256;
  const malformedSha = sha256(canonicalMechanismJson(malformedPayload));
  const malformed = {
    ...malformedPayload,
    receiptId: `receipt-${malformedSha.slice(0, 24)}`,
    receiptSha256: malformedSha
  };
  const malformedResult = persistImprovementMechanismReceipt({
    homeDir: mkdtempSync(join(tmpdir(), 'mechanism-malformed-')),
    receipt: malformed
  });
  assert.equal(malformedResult.status, 'REFUSED');
  assert.equal(malformedResult.code, 'INVALID_RECEIPT');

  const extraPayload = {
    ...receipt,
    unexpected: true
  };
  delete extraPayload.receiptId;
  delete extraPayload.receiptSha256;
  const extraSha = sha256(canonicalMechanismJson(extraPayload));
  const extra = {
    ...extraPayload,
    receiptId: `receipt-${extraSha.slice(0, 24)}`,
    receiptSha256: extraSha
  };
  const extraResult = persistImprovementMechanismReceipt({
    homeDir: mkdtempSync(join(tmpdir(), 'mechanism-extra-')),
    receipt: extra
  });
  assert.equal(extraResult.status, 'REFUSED');
  assert.equal(extraResult.code, 'INVALID_RECEIPT');
});

test('symbolic-link persistence and listing roots are refused', () => {
  const { receipt } = build();
  const outside = mkdtempSync(join(tmpdir(), 'mechanism-outside-'));
  const homeLinkParent = mkdtempSync(join(tmpdir(), 'mechanism-home-link-parent-'));
  const homeLink = join(homeLinkParent, 'home');
  symlinkSync(outside, homeLink, 'dir');
  const homeWriteResult = persistImprovementMechanismReceipt({
    homeDir: homeLink,
    receipt
  });
  assert.equal(homeWriteResult.status, 'REFUSED');
  assert.equal(homeWriteResult.code, 'SYMLINK_REFUSED');

  const writeHome = mkdtempSync(join(tmpdir(), 'mechanism-symlink-write-'));
  symlinkSync(outside, join(writeHome, 'mechanisms'), 'dir');
  const writeResult = persistImprovementMechanismReceipt({
    homeDir: writeHome,
    receipt
  });
  assert.equal(writeResult.status, 'REFUSED');
  assert.equal(writeResult.code, 'SYMLINK_REFUSED');

  const listHome = mkdtempSync(join(tmpdir(), 'mechanism-symlink-list-'));
  mkdirSync(join(listHome, 'mechanisms'));
  symlinkSync(outside, join(listHome, 'mechanisms', 'receipts'), 'dir');
  const listResult = listImprovementMechanismReceipts({
    homeDir: listHome,
    partitions: ['harvest']
  });
  assert.equal(listResult.status, 'REFUSED');
  assert.equal(listResult.code, 'SYMLINK_REFUSED');

  const parentListHome = mkdtempSync(join(tmpdir(), 'mechanism-parent-symlink-list-'));
  symlinkSync(outside, join(parentListHome, 'mechanisms'), 'dir');
  const parentListResult = listImprovementMechanismReceipts({
    homeDir: parentListHome,
    partitions: ['harvest']
  });
  assert.equal(parentListResult.status, 'REFUSED');
  assert.equal(parentListResult.code, 'SYMLINK_REFUSED');
});

test('summaries retain positive, null, tradeoff, and contradiction evidence', () => {
  const receipts = [
    build({ reverified: true }).receipt,
    build({
      verdict: 'NO_IMPROVEMENT',
      movementCode: 'BELOW_THRESHOLD',
      quality: 0.7,
      tokenCost: 1000
    }).receipt,
    build({
      verdict: 'STAGED_TRADEOFF',
      movementCode: 'STAGED_TRADEOFF',
      quality: 0.82,
      tokenCost: 1500
    }).receipt,
    build({
      verdict: 'NO_IMPROVEMENT',
      movementCode: 'BELOW_FLOOR',
      quality: 0.6,
      tokenCost: 900
    }).receipt,
    build({ includeTest: false, includeBenchmark: false }, { testId: null }).receipt
  ];
  const result = summarizeImprovementMechanisms(receipts);
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.summary, {
    total: 5,
    uniqueMechanisms: 1,
    eligibleForRouting: 4,
    ineligibleForRouting: 1,
    byVerdict: {
      improvement: 1,
      no_improvement: 1,
      tradeoff: 1,
      invalid: 1,
      regression: 1
    },
    byLifecycle: {
      observed: 3,
      replicated: 1,
      contradicted: 1
    },
    byPartition: {
      harvest: 4,
      reference: 1,
      gate: 0
    },
    invalidEntries: 0
  });
});
