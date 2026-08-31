import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord,
  createMetaPolicyEpochRecord,
  createRoutingDecisionRecord
} from '../src/adaptive-records.mjs';
import {
  DEFAULT_ADAPTIVE_POLICY,
  applicationUtility,
  classifyFamilyLifecycle,
  createBaselinePolicyEpoch,
  evaluatePolicyDrift,
  proposePolicyEpoch
} from '../src/adaptive-policy.mjs';
import { sha256 } from '../src/util.mjs';

function family(key) {
  const result = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: `${key}-bottleneck`,
      interventionKind: `${key}-intervention`,
      operationKind: `${key}-operation`,
      expectedEffectKind: `${key}-effect`,
      preconditions: ['frozen-benchmark'],
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['quality'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(result.status, 'OK');
  return result.record;
}

function baselineEpoch() {
  const result = createBaselinePolicyEpoch({
    evidenceWindowSha256: sha256('baseline-policy')
  });
  assert.equal(result.status, 'OK', result.message);
  return result.record;
}

function routedWindow(epoch, {
  controlQuality = 0.1,
  relatedQuality = 0.5,
  adjacentQuality = 0.2,
  failureQuality = -0.1,
  wildcardQuality = 0.05,
  failureTransferPassed = true
} = {}) {
  const families = {
    control: family('control'),
    related: family('related'),
    adjacent: family('adjacent'),
    'failure-derived': family('failure'),
    wildcard: family('wildcard')
  };
  const slots = [
    ['control', null, null],
    ['related', families.related.familyId, 'app-receipt-111111111111111111111111'],
    ['adjacent', families.adjacent.familyId, 'app-receipt-222222222222222222222222'],
    ['failure-derived', families['failure-derived'].familyId, 'app-receipt-333333333333333333333333'],
    ['wildcard', families.wildcard.familyId, 'app-receipt-444444444444444444444444']
  ];
  const routed = createRoutingDecisionRecord({
    mode: 'active-canary',
    status: 'COMPLETE',
    targetSha256: 'a'.repeat(64),
    candidatePoolSha256: 'b'.repeat(64),
    candidatePoolCount: 4,
    policyEpochId: epoch.policyEpochId,
    policyEpochSha256: epoch.policyEpochSha256,
    seed: 'policy-window-seed',
    abstentionCode: null,
    allocationSchedule: slots.map(([allocation, familyId, applicationReceiptId]) => ({
      allocation,
      familyId,
      applicationReceiptId,
      probability: allocation === 'control' ? 0.2 : 0.2,
      evidenceStrength: allocation === 'control' ? null : 0.8,
      reasonCodes: [allocation === 'control' ? 'NO_MEMORY_CONTROL' : 'ROUTED_EVIDENCE']
    }))
  });
  assert.equal(routed.status, 'OK', routed.message);
  const qualities = {
    control: controlQuality,
    related: relatedQuality,
    adjacent: adjacentQuality,
    'failure-derived': failureQuality,
    wildcard: wildcardQuality
  };
  const applications = slots.map(([allocation], position) => {
    const verdict = allocation === 'failure-derived' ? 'no_improvement' : 'improvement';
    const transferPassed = allocation !== 'failure-derived' || failureTransferPassed;
    const result = createMechanismApplicationRecord({
      familyId: families[allocation].familyId,
      appliedAt: `2026-07-22T22:00:0${position}.000Z`,
      partition: 'harvest',
      source: {
        runId: `run-${position + 1}`,
        hypothesisId: `hyp-${position + 1}`,
        testId: `test-${position + 1}`
      },
      context: {
        targetSha256: routed.record.targetSha256,
        taskMode: 'improve',
        loopRole: 'supervisor',
        taskValueDimensions: ['quality'],
        resourceDimensions: ['token-cost']
      },
      routing: {
        routingDecisionId: routed.record.routingDecisionId,
        routingDecisionSha256: routed.record.routingDecisionSha256,
        routingPacketSha256: routed.record.routingPacketSha256,
        policyEpochId: epoch.policyEpochId,
        policyEpochSha256: epoch.policyEpochSha256,
        allocation,
        schedulePosition: position
      },
      outcome: {
        verdict,
        valid: true,
        qualityDelta: qualities[allocation],
        tokenCostDeltaPct: 0,
        shamMovement: 0,
        controlRegressions: transferPassed ? 0 : 1,
        reverified: true,
        transferChecks: [{
          kind: 'heldOut',
          attempted: true,
          passed: transferPassed,
          evidenceSha256: sha256(`transfer-${allocation}`)
        }],
        contradictionCodes: transferPassed ? [] : ['FAILED_TRANSFER']
      },
      credit: {
        confidence: 0.8,
        authority: 'tool-computed'
      },
      provenance: {
        legacyReceiptId: `receipt-${String(position + 1).repeat(24)}`,
        legacyReceiptSha256: sha256(`legacy-${position}`),
        benchmarkSha256: sha256('benchmark'),
        artifactSetSha256: sha256(`artifacts-${position}`),
        evidenceSetSha256: sha256(`evidence-${position}`)
      }
    });
    assert.equal(result.status, 'OK', result.message);
    return result.record;
  });
  const evidenceWindowSha256 = sha256(canonicalAdaptiveJson(
    [...applications]
      .sort((a, b) => a.applicationId.localeCompare(b.applicationId))
      .map((application) => ({
        applicationReceiptId: application.applicationReceiptId,
        applicationSha256: application.applicationSha256
      }))
  ));
  return {
    families,
    decision: routed.record,
    applications,
    evidenceWindowSha256
  };
}

test('baseline policy epoch is deterministic and reserves permanent control', () => {
  const first = baselineEpoch();
  const second = baselineEpoch();
  assert.deepEqual(first, second);
  assert.equal(first.policy.allocations.control, 0.2);
  assert.deepEqual(evaluatePolicyDrift(first.baselinePolicy, first.policy), {
    drift: 0,
    driftTier: 0
  });
});

test('five bound applications move one bounded allocation step', () => {
  const epoch0 = baselineEpoch();
  const window = routedWindow(epoch0);
  const result = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: window.applications,
    routingDecisions: [window.decision],
    trigger: 'valid-attempt-window',
    evidenceWindowSha256: window.evidenceWindowSha256
  });
  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.action, 'UPDATE');
  assert.deepEqual(result.transfer, {
    from: 'failure-derived',
    to: 'related',
    amount: 0.05,
    utilityGap: 0.8
  });
  assert.equal(result.epoch.policy.allocations.control, 0.2);
  assert.equal(result.epoch.policy.allocations.related, 0.4);
  assert.equal(result.epoch.policy.allocations.failureDerived, 0.1);
  assert.equal(result.epoch.changes.every((change) => Math.abs(change.delta) <= 0.05), true);
});

test('policy evidence is order-independent and hash-bound', () => {
  const epoch0 = baselineEpoch();
  const window = routedWindow(epoch0);
  const forward = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: window.applications,
    routingDecisions: [window.decision],
    evidenceWindowSha256: window.evidenceWindowSha256
  });
  const reverse = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: [...window.applications].reverse(),
    routingDecisions: [window.decision],
    evidenceWindowSha256: window.evidenceWindowSha256
  });
  assert.deepEqual(forward, reverse);

  const wrongHash = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: window.applications,
    routingDecisions: [window.decision],
    evidenceWindowSha256: sha256('wrong-window')
  });
  assert.equal(wrongHash.code, 'EVIDENCE_WINDOW_HASH_MISMATCH');
});

test('updates refuse fewer than five applications and missing routing receipts', () => {
  const epoch0 = baselineEpoch();
  const window = routedWindow(epoch0);
  const tooSmall = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: window.applications.slice(0, 4),
    routingDecisions: [window.decision],
    evidenceWindowSha256: sha256('unused')
  });
  assert.equal(tooSmall.code, 'POLICY_WINDOW_TOO_SMALL');

  const missingDecision = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: window.applications,
    routingDecisions: [],
    evidenceWindowSha256: window.evidenceWindowSha256
  });
  assert.equal(missingDecision.code, 'INVALID_POLICY_EVIDENCE');
  assert.ok(missingDecision.rejected.every((item) => item.code === 'MISSING_ROUTING_DECISION'));
});

test('failed transfer evidence quarantines the family and raises its penalty', () => {
  const epoch0 = baselineEpoch();
  const window = routedWindow(epoch0, { failureTransferPassed: false });
  const result = proposePolicyEpoch({
    previousEpoch: epoch0,
    applications: window.applications,
    routingDecisions: [window.decision],
    evidenceWindowSha256: window.evidenceWindowSha256
  });
  assert.equal(result.status, 'OK', result.message);
  assert.deepEqual(result.quarantinedFamilyIds, [window.families['failure-derived'].familyId]);
  assert.equal(result.epoch.policy.penalties.failedTransfer, 0.3);
  assert.ok(result.epoch.quarantinedFamilyIds.includes(
    window.families['failure-derived'].familyId
  ));
});

test('a routed regression against control creates a bounded rollback epoch', () => {
  const epoch0 = baselineEpoch();
  const shiftedPolicy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  shiftedPolicy.allocations.related = 0.4;
  shiftedPolicy.allocations.failureDerived = 0.1;
  const epoch1 = createMetaPolicyEpochRecord({
    epochNumber: 1,
    trigger: 'lane-boundary',
    previousEpoch: epoch0,
    validApplicationCount: 0,
    evidenceWindowSha256: sha256('shifted-policy'),
    baselinePolicy: DEFAULT_ADAPTIVE_POLICY,
    policy: shiftedPolicy,
    quarantinedFamilyIds: []
  });
  assert.equal(epoch1.status, 'OK', epoch1.message);
  const window = routedWindow(epoch1.record, {
    controlQuality: 0.5,
    relatedQuality: -0.4,
    adjacentQuality: -0.3,
    failureQuality: -0.5,
    wildcardQuality: -0.2,
    failureTransferPassed: false
  });
  const result = proposePolicyEpoch({
    previousEpoch: epoch1.record,
    baselineEpoch: epoch0,
    applications: window.applications,
    routingDecisions: [window.decision],
    evidenceWindowSha256: window.evidenceWindowSha256
  });
  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.action, 'ROLLBACK');
  assert.equal(result.epoch.trigger, 'rollback');
  assert.equal(result.epoch.rollbackTargetEpochId, epoch0.policyEpochId);
  assert.equal(result.epoch.policy.allocations.related, 0.35);
  assert.equal(result.epoch.policy.allocations.failureDerived, 0.15);
  assert.equal(result.epoch.policy.allocations.control, 0.2);
});

test('utility preserves missing evidence and lifecycle needs independent replication', () => {
  const epoch0 = baselineEpoch();
  const window = routedWindow(epoch0);
  const missing = structuredClone(window.applications[0]);
  missing.outcome.qualityDelta = null;
  missing.outcome.tokenCostDeltaPct = null;
  missing.credit.failureDerived = false;
  assert.equal(applicationUtility(missing), null);

  const related = window.applications[1];
  assert.deepEqual(classifyFamilyLifecycle({
    familyId: related.familyId,
    applications: [related]
  }), {
    state: 'observed',
    reason: 'INSUFFICIENT_REPLICATION'
  });
  const replicaResult = createMechanismApplicationRecord({
    familyId: related.familyId,
    appliedAt: '2026-07-22T23:00:00.000Z',
    partition: related.partition,
    source: { ...related.source, runId: 'independent-run' },
    context: related.context,
    routing: related.routing,
    outcome: related.outcome,
    credit: related.credit,
    provenance: {
      ...related.provenance,
      legacyReceiptId: 'receipt-999999999999999999999999',
      legacyReceiptSha256: sha256('independent-legacy')
    }
  });
  assert.equal(replicaResult.status, 'OK', replicaResult.message);
  assert.deepEqual(classifyFamilyLifecycle({
    familyId: related.familyId,
    applications: [related, replicaResult.record]
  }), {
    state: 'replicated',
    reason: 'TWO_REVERIFIED_RUNS'
  });
});
