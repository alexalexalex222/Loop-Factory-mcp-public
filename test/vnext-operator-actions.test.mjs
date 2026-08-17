import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyVNextOperatorAction,
  createVNextOperatorAction,
  listVNextOperatorActions,
  persistVNextOperatorAction
} from '../src/vnext-operator-actions.mjs';
import {
  applyAndPersistVNextOperatorControl,
  initializeVNextOperatorControl,
  loadVNextOperatorControlProjection,
  operatorControlForRouting
} from '../src/vnext-operator-control.mjs';
import {
  canonicalAdaptiveJson,
  createMechanismFamilyRecord,
  createMetaPolicyEpochRecord
} from '../src/adaptive-records.mjs';
import { DEFAULT_ADAPTIVE_POLICY } from '../src/adaptive-policy.mjs';
import { sha256 } from '../src/util.mjs';

function action(overrides = {}) {
  return createVNextOperatorAction({
    actionId: 'action-1',
    runId: 'run-1',
    kind: 'quarantine-family',
    target: { type: 'family', id: 'family-1', sha256: 'a'.repeat(64) },
    expectedRevisionSha256: 'b'.repeat(64),
    reasonCode: 'CONTROL_REGRESSION',
    evidenceSha256: 'c'.repeat(64),
    authority: { operatorId: 'operator-1', sessionId: 'session-1' },
    createdAt: '2026-08-05T00:00:00.000Z',
    ...overrides
  });
}

test('operator actions can restrict but cannot approve or promote', () => {
  assert.equal(action().status, 'OK');
  assert.equal(createVNextOperatorAction({
    ...action().action,
    actionId: 'approve-1',
    kind: 'approve'
  }).status, 'REFUSED');
  const applied = applyVNextOperatorAction({
    action: action().action,
    current: {
      id: 'family-1', sha256: 'a'.repeat(64), revisionSha256: 'b'.repeat(64),
      status: 'ACTIVE'
    }
  });
  assert.equal(applied.disposition, 'QUARANTINED');
  assert.equal(applied.restrictive, true);
});

test('operator action kind and target authority must agree at construction', () => {
  assert.equal(action({
    target: { type: 'policy', id: 'policy-1', sha256: 'a'.repeat(64) }
  }).status, 'REFUSED');
  assert.equal(action({
    kind: 'deny-review',
    target: { type: 'family', id: 'family-1', sha256: 'a'.repeat(64) }
  }).status, 'REFUSED');
  assert.equal(action({
    kind: 'rollback-policy',
    target: { type: 'policy', id: 'policy-1', sha256: 'a'.repeat(64) },
    rollbackTarget: null
  }).status, 'REFUSED');
});

test('stale target and revision bindings fail closed', () => {
  const applied = applyVNextOperatorAction({
    action: action().action,
    current: {
      id: 'family-1', sha256: 'a'.repeat(64), revisionSha256: 'd'.repeat(64),
      status: 'ACTIVE'
    }
  });
  assert.equal(applied.code, 'VNEXT_OPERATOR_ACTION_STALE_BINDING');
});

test('rollback requires a bound ancestor and quarantine release returns to shadow only', () => {
  const rollback = action({
    actionId: 'rollback-1',
    kind: 'rollback-policy',
    target: { type: 'policy', id: 'policy-2', sha256: 'a'.repeat(64) },
    rollbackTarget: { id: 'policy-1', sha256: 'd'.repeat(64) }
  });
  assert.equal(applyVNextOperatorAction({
    action: rollback.action,
    current: {
      id: 'policy-2', sha256: 'a'.repeat(64), revisionSha256: 'b'.repeat(64),
      status: 'ACTIVE', ancestors: [{ id: 'policy-1', sha256: 'd'.repeat(64) }]
    }
  }).disposition, 'ROLLED_BACK');

  assert.equal(action({
    actionId: 'release-1',
    kind: 'release-quarantine'
  }).status, 'REFUSED');
  const release = action({
    actionId: 'release-1',
    kind: 'release-quarantine',
    verifierEvidenceSha256: 'e'.repeat(64)
  });
  const released = applyVNextOperatorAction({
    action: release.action,
    current: {
      id: 'family-1', sha256: 'a'.repeat(64), revisionSha256: 'b'.repeat(64),
      status: 'QUARANTINED'
    }
  });
  assert.equal(released.disposition, 'RELEASED_TO_SHADOW');
  assert.equal(released.routingEligible, false);
});

test('operator action persistence is append-only and idempotent', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'vnext-actions-'));
  const created = action().action;
  assert.equal(persistVNextOperatorAction({ homeDir, action: created }).status, 'OK');
  assert.equal(persistVNextOperatorAction({ homeDir, action: created }).idempotent, true);
  const tampered = { ...created, evidenceSha256: 'f'.repeat(64) };
  assert.equal(persistVNextOperatorAction({ homeDir, action: tampered }).status, 'REFUSED');
  assert.equal(listVNextOperatorActions({ homeDir }).actions.length, 1);
});

function adaptiveFixture() {
  const family = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'operator-control-bottleneck',
      interventionKind: 'operator-control-intervention',
      operationKind: 'operator-control-operation',
      expectedEffectKind: 'operator-control-effect',
      preconditions: ['verified-evidence'],
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['quality'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(family.status, 'OK');
  const epoch0 = createMetaPolicyEpochRecord({
    policyScopeId: 'operator-scope',
    epochNumber: 0,
    trigger: 'initial',
    previousEpoch: null,
    validApplicationCount: 0,
    evidenceWindowSha256: sha256('operator-epoch-0'),
    baselinePolicy: DEFAULT_ADAPTIVE_POLICY,
    policy: DEFAULT_ADAPTIVE_POLICY,
    quarantinedFamilyIds: []
  });
  assert.equal(epoch0.status, 'OK');
  const epoch1 = createMetaPolicyEpochRecord({
    policyScopeId: 'operator-scope',
    epochNumber: 1,
    trigger: 'lane-boundary',
    previousEpoch: epoch0.record,
    validApplicationCount: 0,
    evidenceWindowSha256: sha256(canonicalAdaptiveJson({ epoch: 1 })),
    baselinePolicy: DEFAULT_ADAPTIVE_POLICY,
    policy: DEFAULT_ADAPTIVE_POLICY,
    quarantinedFamilyIds: []
  });
  assert.equal(epoch1.status, 'OK');
  return {
    family: family.record,
    epoch0: epoch0.record,
    epoch1: epoch1.record,
    records: [family.record, epoch0.record, epoch1.record]
  };
}

test('operator control projection quarantines, releases only to shadow, and binds rollback', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'vnext-control-'));
  const data = adaptiveFixture();
  const initialized = initializeVNextOperatorControl({
    homeDir,
    createdAt: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(initialized.status, 'OK');

  const quarantined = createVNextOperatorAction({
    actionId: 'quarantine-real-family',
    runId: 'run-operator-control',
    kind: 'quarantine-family',
    target: {
      type: 'family',
      id: data.family.familyId,
      sha256: data.family.familySha256
    },
    expectedRevisionSha256: initialized.projection.projectionSha256,
    reasonCode: 'CONTROL_REGRESSION',
    evidenceSha256: 'a'.repeat(64),
    authority: { operatorId: 'operator-1', sessionId: 'session-1' },
    createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(quarantined.status, 'OK');
  const quarantineApplied = applyAndPersistVNextOperatorControl({
    homeDir,
    action: quarantined.action,
    records: data.records
  });
  assert.equal(quarantineApplied.status, 'OK');
  assert.deepEqual(quarantineApplied.projection.quarantinedFamilyIds, [data.family.familyId]);
  assert.equal(quarantineApplied.projection.activationAuthorized, false);

  const missingVerifier = createVNextOperatorAction({
    actionId: 'release-real-family',
    runId: 'run-operator-control',
    kind: 'release-quarantine',
    target: {
      type: 'family',
      id: data.family.familyId,
      sha256: data.family.familySha256
    },
    expectedRevisionSha256: quarantineApplied.projection.projectionSha256,
    reasonCode: 'REVERIFIED_SAFE',
    evidenceSha256: 'b'.repeat(64),
    verifierEvidenceSha256: 'c'.repeat(64),
    authority: { operatorId: 'operator-1', sessionId: 'session-1' },
    createdAt: '2026-08-05T00:02:00.000Z'
  });
  assert.equal(missingVerifier.status, 'OK');
  assert.equal(applyAndPersistVNextOperatorControl({
    homeDir,
    action: missingVerifier.action,
    records: data.records
  }).code, 'VNEXT_OPERATOR_RELEASE_VERIFIER_REQUIRED');
  const releaseApplied = applyAndPersistVNextOperatorControl({
    homeDir,
    action: missingVerifier.action,
    records: data.records,
    verifyReleaseEvidence: (evidenceSha256) => ({ status: 'OK', evidenceSha256 })
  });
  assert.equal(releaseApplied.status, 'OK');
  assert.deepEqual(releaseApplied.projection.quarantinedFamilyIds, []);
  assert.deepEqual(releaseApplied.projection.shadowOnlyFamilyIds, [data.family.familyId]);
  assert.equal(releaseApplied.projection.activationAuthorized, false);

  const rollback = createVNextOperatorAction({
    actionId: 'rollback-real-policy',
    runId: 'run-operator-control',
    kind: 'rollback-policy',
    target: {
      type: 'policy',
      id: data.epoch1.policyEpochId,
      sha256: data.epoch1.policyEpochSha256
    },
    expectedRevisionSha256: releaseApplied.projection.projectionSha256,
    rollbackTarget: {
      id: data.epoch0.policyEpochId,
      sha256: data.epoch0.policyEpochSha256
    },
    reasonCode: 'POLICY_REGRESSION',
    evidenceSha256: 'd'.repeat(64),
    authority: { operatorId: 'operator-1', sessionId: 'session-1' },
    createdAt: '2026-08-05T00:03:00.000Z'
  });
  assert.equal(rollback.status, 'OK');
  const rollbackApplied = applyAndPersistVNextOperatorControl({
    homeDir,
    action: rollback.action,
    records: data.records
  });
  assert.equal(rollbackApplied.status, 'OK');
  assert.equal(rollbackApplied.projection.policyOverride.id, data.epoch0.policyEpochId);
  const routing = operatorControlForRouting({ homeDir, records: data.records });
  assert.equal(routing.status, 'OK');
  assert.equal(routing.policyOverride.policyEpochId, data.epoch0.policyEpochId);
  assert.deepEqual(routing.shadowOnlyFamilyIds, [data.family.familyId]);
  assert.equal(loadVNextOperatorControlProjection({ homeDir }).status, 'OK');
});

test('an action persisted without its projection blocks routing until reconciled', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'vnext-control-pending-'));
  const data = adaptiveFixture();
  const initialized = initializeVNextOperatorControl({
    homeDir,
    createdAt: '2026-08-05T00:00:00.000Z'
  });
  const pending = createVNextOperatorAction({
    actionId: 'pending-quarantine',
    runId: 'run-operator-control',
    kind: 'quarantine-family',
    target: {
      type: 'family',
      id: data.family.familyId,
      sha256: data.family.familySha256
    },
    expectedRevisionSha256: initialized.projection.projectionSha256,
    reasonCode: 'CONTROL_REGRESSION',
    evidenceSha256: 'e'.repeat(64),
    authority: { operatorId: 'operator-1', sessionId: 'session-1' },
    createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(persistVNextOperatorAction({ homeDir, action: pending.action }).status, 'OK');
  assert.equal(
    loadVNextOperatorControlProjection({ homeDir }).code,
    'VNEXT_OPERATOR_CONTROL_ACTION_PENDING'
  );
});
