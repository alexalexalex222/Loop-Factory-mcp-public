import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/util.mjs';
import { canonicalJson, META_POLICY_V1 } from '../src/meta-policy.mjs';
import { buildShadowMechanismPacket } from '../src/mechanism-router.mjs';

function receipt({
  key,
  partition = 'harvest',
  eligible = true,
  verdict = 'improvement',
  lifecycle = 'replicated',
  valid = true,
  reverified = true,
  signatureTokens = ['context', 'isolation', 'hook'],
  taskValueDimensions = ['quality'],
  resourceDimensions = ['token-cost'],
  taskMode = 'improve',
  loopId = 'loop-de-loop',
  qualityDelta = 0.2,
  costDeltaPct = -0.1,
  controls = 0,
  transferPassed = true,
  runId,
  operation,
  secret = ''
}) {
  const hex = sha256(key).slice(0, 24);
  const payload = {
    schemaVersion: 'improvement-mechanism-v1',
    mechanismId: `mech-${hex}`,
    generatedAt: '2026-07-21T00:00:00.000Z',
    partition,
    eligibleForRouting: eligible,
    source: {
      runId: runId || `run-${hex.slice(0, 8)}`,
      findingId: `finding-${hex.slice(0, 3).replace(/[a-f]/g, '1')}`,
      hypothesisId: `hyp-${hex.slice(0, 8)}`,
      testId: `test-${hex.slice(0, 8)}`,
      benchmarkId: `bench-${hex.slice(0, 8)}`,
      benchmarkSha256: sha256(`benchmark-${key}`),
      policyId: null,
      policySha256: null
    },
    target: {
      taskSha256: sha256(`task-${key}`),
      taskMode,
      loopId,
      taskValueDimensions,
      resourceDimensions,
      signatureTokens
    },
    mechanism: {
      title: `Mechanism ${key} ${secret}`,
      bottleneck: `Bottleneck ${key} ${secret}`,
      operation: operation || `Operation ${key} ${secret}`,
      expectedMovement: `Expected movement ${key} ${secret}`,
      falsifier: `Falsifier ${key} ${secret}`
    },
    measurement: {
      baseline: {
        quality: 0.5,
        tokenCost: 100,
        artifactOutputTokenEstimate: 100,
        cliReceiptTokenCost: 100,
        samples: 3
      },
      challenger: {
        quality: qualityDelta == null ? null : 0.5 + qualityDelta,
        tokenCost: 90,
        artifactOutputTokenEstimate: 90,
        cliReceiptTokenCost: 90,
        samples: 3
      },
      delta: {
        quality: qualityDelta,
        tokenCost: -10,
        tokenCostPct: costDeltaPct
      },
      qualityAuthority: 'tool-computed',
      reverified,
      shamMovement: 0,
      controlRegressions: controls,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: transferPassed,
        evidenceSha256: sha256(`transfer-${key}`)
      }]
    },
    outcome: {
      verdict,
      code: verdict === 'improvement' ? 'MOVED_FRONTIER' : 'NO_IMPROVEMENT',
      valid,
      observedAt: '2026-07-21T00:00:00.000Z',
      reverifiedAt: reverified ? '2026-07-21T00:01:00.000Z' : null
    },
    provenance: {
      evidenceRefs: [{
        path: `/private/${secret || key}/source`,
        locator: `SECRET_LOCATOR_${secret || key}`,
        sha256: sha256(`source-${key}`)
      }],
      artifacts: [{
        artifactId: `art-${hex.slice(0, 8)}`,
        role: 'runlog',
        sha256: sha256(`artifact-${key}`)
      }]
    },
    lifecycle: {
      state: lifecycle,
      reason: `Lifecycle reason ${secret || key}`
    }
  };
  const receiptSha256 = sha256(canonicalJson(payload));
  return {
    ...payload,
    receiptId: `receipt-${receiptSha256.slice(0, 24)}`,
    receiptSha256
  };
}

const target = {
  signatureTokens: ['context', 'isolation', 'hook'],
  taskValueDimensions: ['quality'],
  resourceDimensions: ['token-cost'],
  taskMode: 'improve',
  loopId: 'loop-de-loop'
};

test('routing is deterministic and independent of receipt input order', () => {
  const receipts = [
    receipt({ key: 'related-a' }),
    receipt({ key: 'related-b' }),
    receipt({ key: 'adjacent', signatureTokens: ['context', 'plugin', 'security'] }),
    receipt({ key: 'wild-a', signatureTokens: ['database', 'retry'] }),
    receipt({ key: 'wild-b', signatureTokens: ['browser', 'layout'] }),
    receipt({ key: 'failed', verdict: 'no_improvement', qualityDelta: 0 })
  ];
  const first = buildShadowMechanismPacket({ receipts, target, seed: 'same-seed' });
  const second = buildShadowMechanismPacket({ receipts: [...receipts].reverse(), target, seed: 'same-seed' });
  assert.deepEqual(first, second);
  assert.equal(first.affectedExecution, false);
});

test('seeded wildcard selection is reproducible and records its probability', () => {
  const receipts = [
    receipt({
      key: 'wild-1',
      signatureTokens: ['database'],
      taskValueDimensions: ['latency'],
      resourceDimensions: ['wall-time'],
      taskMode: 'research',
      loopId: 'other-loop'
    }),
    receipt({
      key: 'wild-2',
      signatureTokens: ['browser'],
      taskValueDimensions: ['latency'],
      resourceDimensions: ['wall-time'],
      taskMode: 'research',
      loopId: 'other-loop'
    }),
    receipt({
      key: 'wild-3',
      signatureTokens: ['queue'],
      taskValueDimensions: ['latency'],
      resourceDimensions: ['wall-time'],
      taskMode: 'research',
      loopId: 'other-loop'
    })
  ];
  const one = buildShadowMechanismPacket({ receipts, target, seed: 'wild-seed' });
  const two = buildShadowMechanismPacket({ receipts, target, seed: 'wild-seed' });
  const wildcard = one.selected.find((item) => item.slot === 'wildcard');
  assert.deepEqual(one, two);
  assert.ok(wildcard);
  assert.equal(wildcard.selectionProbability, 0.3333);
  assert.match(one.seed, /^seed-[a-f0-9]{16}$/);
});

test('gate, reference, ineligible, and malformed receipts never enter the pool', () => {
  const harvest = receipt({ key: 'harvest' });
  const packet = buildShadowMechanismPacket({
    receipts: [
      harvest,
      receipt({ key: 'gate', partition: 'gate' }),
      receipt({ key: 'reference', partition: 'reference' }),
      receipt({ key: 'ineligible', eligible: false }),
      { ...receipt({ key: 'tampered' }), receiptSha256: '0'.repeat(64) }
    ],
    target
  });
  assert.equal(packet.eligiblePool.count, 1);
  assert.equal(packet.filtered.wrongPartition, 2);
  assert.equal(packet.filtered.ineligible, 1);
  assert.equal(packet.filtered.malformed, 1);
  assert.equal(packet.eligiblePool.items[0].mechanismId, harvest.mechanismId);
});

test('contradictory evidence lowers an otherwise equivalent rank', () => {
  const observed = receipt({ key: 'observed', lifecycle: 'observed', transferPassed: true });
  const contradicted = receipt({
    key: 'contradicted',
    lifecycle: 'contradicted',
    transferPassed: false,
    controls: 1
  });
  const packet = buildShadowMechanismPacket({ receipts: [observed, contradicted], target });
  const observedRow = packet.eligiblePool.items.find((item) => item.mechanismId === observed.mechanismId);
  const contradictedRow = packet.eligiblePool.items.find((item) => item.mechanismId === contradicted.mechanismId);
  assert.ok(observedRow.score > contradictedRow.score);
  assert.ok(contradictedRow.contradiction > observedRow.contradiction);
});

test('missing numeric evidence remains absent instead of becoming measured zero', () => {
  const missing = receipt({
    key: 'missing-numbers',
    qualityDelta: null,
    costDeltaPct: '',
    controls: null
  });
  const packet = buildShadowMechanismPacket({ receipts: [missing], target });
  const row = packet.eligiblePool.items[0];
  assert.equal(row.effect, 0);
  assert.ok(!row.reasonCodes.includes('QUALITY_FLAT'));
  assert.ok(!row.reasonCodes.includes('COST_FLAT'));
  assert.ok(!row.reasonCodes.includes('CONTROL_REGRESSION'));
});

test('slots are diverse, contain no duplicate mechanisms, and include failure-derived evidence', () => {
  const receipts = [
    receipt({ key: 'related-1', runId: 'run-related-1', operation: 'inspect inherited context' }),
    receipt({
      key: 'related-same-run',
      runId: 'run-related-1',
      qualityDelta: 0.4,
      operation: 'inspect another inherited context'
    }),
    receipt({ key: 'related-2', runId: 'run-related-2', operation: 'reject hidden hooks' }),
    receipt({
      key: 'adjacent-1',
      runId: 'run-adjacent',
      signatureTokens: ['context', 'plugin', 'security', 'boundary'],
      taskValueDimensions: ['precision'],
      resourceDimensions: ['latency'],
      taskMode: 'audit',
      loopId: 'other-loop',
      operation: 'inspect plugin boundary'
    }),
    receipt({
      key: 'wild-1',
      signatureTokens: ['database', 'retry'],
      taskValueDimensions: ['latency'],
      resourceDimensions: ['wall-time'],
      taskMode: 'research',
      loopId: 'other-loop',
      operation: 'retry transactions'
    }),
    receipt({
      key: 'wild-2',
      signatureTokens: ['browser', 'layout'],
      taskValueDimensions: ['latency'],
      resourceDimensions: ['wall-time'],
      taskMode: 'research',
      loopId: 'other-loop',
      operation: 'measure layout'
    }),
    receipt({
      key: 'failure-1',
      verdict: 'no_improvement',
      qualityDelta: 0,
      operation: 'repeat broad rewrite'
    })
  ];
  const packet = buildShadowMechanismPacket({ receipts, target, seed: 'diverse' });
  const ids = packet.selected.map((item) => item.mechanismId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(packet.status, 'COMPLETE');
  assert.deepEqual(
    new Set(packet.selected.map((item) => item.slot)),
    new Set(['related-1', 'related-2', 'adjacent', 'wildcard', 'failure-derived'])
  );
  const relatedRuns = packet.selected
    .filter((item) => item.slot.startsWith('related-'))
    .map((item) => item.source.runId);
  assert.equal(new Set(relatedRuns).size, 2, 'related slots should diversify source runs when possible');
  assert.equal(packet.selected.find((item) => item.slot === 'failure-derived').verdict, 'no_improvement');
});

test('insufficient evidence abstains instead of manufacturing filler', () => {
  const packet = buildShadowMechanismPacket({
    receipts: [receipt({ key: 'gate-only', partition: 'gate' })],
    target
  });
  assert.equal(packet.status, 'ABSTAINED');
  assert.equal(packet.abstentionReason, 'NO_ELIGIBLE_HARVEST_RECEIPTS');
  assert.deepEqual(packet.selected, []);
  assert.equal(packet.missingSlots.length, 5);
});

test('policy, eligible pool, and packet hashes bind canonical public data', () => {
  const packet = buildShadowMechanismPacket({
    receipts: [receipt({ key: 'hash-a' }), receipt({ key: 'hash-b' })],
    target,
    seed: 'hash-seed'
  });
  const { packetSha256, ...payload } = packet;
  assert.match(META_POLICY_V1.policySha256, /^[a-f0-9]{64}$/);
  assert.match(packet.targetSha256, /^[a-f0-9]{64}$/);
  assert.match(packet.eligiblePool.sha256, /^[a-f0-9]{64}$/);
  assert.equal(packet.policySha256, META_POLICY_V1.policySha256);
  assert.equal(packetSha256, sha256(canonicalJson(payload)));
});

test('target hash binds routing context without exposing target text', () => {
  const privateTarget = {
    ...target,
    title: 'PRIVATE_TARGET_TEXT',
    signatureTokens: [...target.signatureTokens, 'private-target-token']
  };
  const changedTarget = {
    ...privateTarget,
    signatureTokens: [...privateTarget.signatureTokens, 'changed-target-token']
  };
  const receipts = [receipt({ key: 'target-binding' })];
  const first = buildShadowMechanismPacket({ receipts, target: privateTarget, seed: 'target-seed' });
  const second = buildShadowMechanismPacket({ receipts, target: changedTarget, seed: 'target-seed' });
  assert.notEqual(first.targetSha256, second.targetSha256);
  assert.notEqual(first.packetSha256, second.packetSha256);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_TARGET_TEXT'));
  assert.ok(!JSON.stringify(first).includes('private-target-token'));
});

test('public packet omits mechanism prose, evidence paths, locators, and raw seed', () => {
  const privateText = 'PRIVATE_MECHANISM_TEXT';
  const rawSeed = 'PRIVATE_RAW_SEED';
  const packet = buildShadowMechanismPacket({
    receipts: [
      receipt({ key: 'private', secret: privateText }),
      receipt({ key: 'private-failure', verdict: 'tradeoff', secret: privateText })
    ],
    target,
    seed: rawSeed
  });
  const json = JSON.stringify(packet);
  for (const forbidden of [
    privateText,
    'SECRET_LOCATOR',
    '/private/',
    rawSeed,
    'title',
    'bottleneck',
    'operation',
    'expectedMovement',
    'falsifier'
  ]) {
    assert.ok(!json.includes(forbidden), `packet must omit ${forbidden}`);
  }
});

test('hash-valid receipts with schema-invalid public enums are filtered', () => {
  const base = receipt({ key: 'private-enum' });
  const payload = {
    ...base,
    outcome: { ...base.outcome, verdict: 'PRIVATE_VERDICT' }
  };
  delete payload.receiptId;
  delete payload.receiptSha256;
  const digest = sha256(canonicalJson(payload));
  const invalid = {
    ...payload,
    receiptId: `receipt-${digest.slice(0, 24)}`,
    receiptSha256: digest
  };
  const packet = buildShadowMechanismPacket({ receipts: [invalid], target });
  assert.equal(packet.status, 'ABSTAINED');
  assert.equal(packet.filtered.malformed, 1);
  assert.ok(!JSON.stringify(packet).includes('PRIVATE_VERDICT'));
});

test('eligible receipts with invalid outcomes are filtered before the eligible pool', () => {
  const invalid = receipt({ key: 'invalid-outcome', valid: false });
  const packet = buildShadowMechanismPacket({ receipts: [invalid], target });
  assert.equal(packet.status, 'ABSTAINED');
  assert.equal(packet.eligiblePool.count, 0);
  assert.equal(packet.filtered.malformed, 1);
});

test('duplicate mechanism revisions collapse to one deterministic eligible row', () => {
  const older = receipt({ key: 'same-mechanism', lifecycle: 'observed', reverified: false });
  const newerBase = receipt({ key: 'same-mechanism-new', lifecycle: 'replicated', reverified: true });
  const newerPayload = {
    ...newerBase,
    mechanismId: older.mechanismId
  };
  delete newerPayload.receiptId;
  delete newerPayload.receiptSha256;
  const digest = sha256(canonicalJson(newerPayload));
  const newer = {
    ...newerPayload,
    receiptId: `receipt-${digest.slice(0, 24)}`,
    receiptSha256: digest
  };
  const packet = buildShadowMechanismPacket({ receipts: [older, newer], target });
  assert.equal(packet.eligiblePool.count, 1);
  assert.equal(packet.filtered.duplicateMechanism, 1);
  assert.equal(packet.eligiblePool.items[0].receiptId, newer.receiptId);
});
