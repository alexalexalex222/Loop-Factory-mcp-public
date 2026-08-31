import {
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord,
  createMetaPolicyEpochRecord
} from '../../src/adaptive-records.mjs';
import { DEFAULT_ADAPTIVE_POLICY } from '../../src/adaptive-policy.mjs';
import { sha256 } from '../../src/util.mjs';

export const ROUTER_SCALE_TARGET = Object.freeze({
  taskMode: 'improve',
  loopRole: 'supervisor',
  taskValueDimensions: ['quality'],
  resourceDimensions: ['token-cost']
});

function record(result, label) {
  if (result.status !== 'OK') {
    throw new Error(`${label}: ${result.code || result.message || 'record construction failed'}`);
  }
  return result.record;
}

export function buildScaleEpoch(
  policy = DEFAULT_ADAPTIVE_POLICY,
  quarantinedFamilyIds = []
) {
  return record(createMetaPolicyEpochRecord({
    epochNumber: 0,
    trigger: 'initial',
    previousEpoch: null,
    validApplicationCount: 0,
    evidenceWindowSha256: sha256(canonicalAdaptiveJson({ policy, quarantinedFamilyIds })),
    baselinePolicy: policy,
    policy,
    quarantinedFamilyIds
  }), 'policy epoch');
}

export function buildScaleEvidence(key, {
  operationKind = `operation-${key}`,
  interventionKind = `intervention-${key}`,
  qualityDelta = 0.3,
  procedureSteps = ['inspect-evidence', 'apply-change', 'verify-result'],
  verdict = 'improvement',
  partition = 'harvest',
  transferPassed = true,
  controlRegressions = 0,
  contradictionCodes = []
} = {}) {
  const family = record(createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: `bottleneck-${key}`,
      interventionKind,
      operationKind,
      expectedEffectKind: `effect-${key}`,
      preconditions: ['frozen-benchmark'],
      procedureSteps,
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['quality'],
        resourceDimensions: ['token-cost']
      }
    }
  }), `family ${key}`);
  const application = record(createMechanismApplicationRecord({
    familyId: family.familyId,
    appliedAt: '2026-08-01T00:00:00.000Z',
    partition,
    source: {
      runId: `run-${key}`,
      hypothesisId: `hyp-${key}`,
      testId: `test-${key}`
    },
    context: {
      targetSha256: sha256(`target-${key}`),
      ...ROUTER_SCALE_TARGET
    },
    routing: {
      routingDecisionId: null,
      routingDecisionSha256: null,
      routingPacketSha256: null,
      policyEpochId: null,
      policyEpochSha256: null,
      allocation: null,
      schedulePosition: null
    },
    outcome: {
      verdict,
      valid: true,
      qualityDelta: verdict === 'improvement' ? qualityDelta : 0,
      tokenCostDeltaPct: 0,
      shamMovement: 0,
      controlRegressions,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: transferPassed,
        evidenceSha256: sha256(`transfer-${key}`)
      }],
      contradictionCodes
    },
    credit: {
      confidence: 0.9,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256(key).slice(0, 24)}`,
      legacyReceiptSha256: sha256(`legacy-${key}`),
      benchmarkSha256: sha256('benchmark'),
      artifactSetSha256: sha256(`artifacts-${key}`),
      evidenceSetSha256: sha256(`evidence-${key}`)
    }
  }), `application ${key}`);
  return { family, application };
}

export function buildScaleCorpus(count = 512) {
  if (!Number.isInteger(count) || count < 1 || count > 4096) {
    throw new Error('Scale corpus count must be an integer from 1 through 4096.');
  }
  return Array.from({ length: count }, (_, index) => buildScaleEvidence(`scale-${index}`, {
    operationKind: `operation-${index % 64}`,
    interventionKind: `intervention-${index % 32}`,
    qualityDelta: 0.1 + (index % 9) / 20,
    procedureSteps: [
      `inspect-${index % 7}`,
      `apply-${index % 11}`,
      `verify-${index % 13}`
    ]
  }));
}
