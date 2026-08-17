import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_CONTROL_ARM_SCHEMA,
  ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA,
  ADAPTIVE_CONTROL_SOURCE_SCHEMA,
  adaptiveControlCaseIdsSha256,
  deriveAdaptiveControlEvidence,
  sealAdaptiveControlArmEvidence
} from '../src/adaptive-control-evidence.mjs';
import { canonicalAdaptiveJson } from '../src/adaptive-records.mjs';
import { sha256 } from '../src/util.mjs';

const ROLES = ['baseline', 'routed', 'sham'];

function buildFixture({ shamQuality = 0.5, routedControlQuality = 1 } = {}) {
  const caseIds = ['case-1'];
  const common = {
    runId: 'adaptive-control-run',
    testId: 'test-1',
    benchmarkSha256: sha256('benchmark'),
    caseSetSha256: sha256('case-set'),
    caseIdsSha256: adaptiveControlCaseIdsSha256(caseIds),
    oracleSha256: sha256('oracle'),
    evaluatorSha256: sha256('evaluator'),
    measurementSchemaVersion: ADAPTIVE_CONTROL_MEASUREMENT_SCHEMA,
    measurementAuthority: 'tool-computed'
  };
  const measurements = {
    baseline: [{ caseId: 'case-1', targetQuality: 0.5, controlQuality: 1 }],
    routed: [{
      caseId: 'case-1',
      targetQuality: 0.8,
      controlQuality: routedControlQuality
    }],
    sham: [{ caseId: 'case-1', targetQuality: shamQuality, controlQuality: 1 }]
  };
  const arms = {};
  for (const armRole of ROLES) {
    const sealed = sealAdaptiveControlArmEvidence({
      schemaVersion: ADAPTIVE_CONTROL_ARM_SCHEMA,
      armRole,
      provenance: { ...common },
      measurements: measurements[armRole]
    });
    assert.equal(sealed.status, 'OK', sealed.message);
    arms[armRole] = sealed.armEvidence;
  }
  const source = { schemaVersion: ADAPTIVE_CONTROL_SOURCE_SCHEMA, arms };
  return {
    source,
    expected: {
      runId: common.runId,
      testId: common.testId,
      benchmarkSha256: common.benchmarkSha256,
      caseSetSha256: common.caseSetSha256,
      caseIdsSha256: common.caseIdsSha256,
      oracleSha256: common.oracleSha256,
      evaluatorSha256: common.evaluatorSha256,
      sourceEvidenceSha256: sha256(canonicalAdaptiveJson(source)),
      armEvidenceSha256: Object.fromEntries(ROLES.map((role) => [
        role,
        arms[role].armEvidenceSha256
      ]))
    }
  };
}

test('derives a banking-eligible receipt only from sealed paired evidence', () => {
  const fixture = buildFixture();
  const first = deriveAdaptiveControlEvidence(fixture.source, fixture.expected);
  const second = deriveAdaptiveControlEvidence(
    structuredClone(fixture.source),
    structuredClone(fixture.expected)
  );

  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(first.controlEvidence.controlRegressions, 0);
  assert.equal(first.controlEvidence.shamMovement, 0);
  assert.equal(first.controlEvidence.automaticBankingEligible, true);
  assert.deepEqual(first.controlEvidence.reasonCodes, []);
  assert.equal(first.sourceSummary.caseCount, 1);
});

test('valid positive sham movement is retained as disqualifying evidence', () => {
  const fixture = buildFixture({ shamQuality: 0.7 });
  const result = deriveAdaptiveControlEvidence(fixture.source, fixture.expected);

  assert.equal(result.status, 'OK');
  assert.equal(result.controlEvidence.shamMovement, 0.2);
  assert.equal(result.controlEvidence.automaticBankingEligible, false);
  assert.deepEqual(result.controlEvidence.reasonCodes, ['POSITIVE_SHAM_MOVEMENT']);
  assert.deepEqual(result.sourceSummary.positiveShamCaseIds, ['case-1']);
});

test('valid control regression is retained and blocks automatic banking', () => {
  const fixture = buildFixture({ routedControlQuality: 0.6 });
  const result = deriveAdaptiveControlEvidence(fixture.source, fixture.expected);

  assert.equal(result.status, 'OK');
  assert.equal(result.controlEvidence.controlRegressions, 1);
  assert.equal(result.controlEvidence.automaticBankingEligible, false);
  assert.deepEqual(result.controlEvidence.reasonCodes, ['CONTROL_REGRESSION']);
  assert.deepEqual(result.sourceSummary.controlRegressionCaseIds, ['case-1']);
});

test('tampering after sealing is refused even when the claimed aggregate looks safe', () => {
  const fixture = buildFixture();
  fixture.source.arms.sham.measurements[0].targetQuality = 0.9;

  const result = deriveAdaptiveControlEvidence(fixture.source, fixture.expected);
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'SOURCE_HASH_MISMATCH');
});

test('caller aggregates and missing trusted bindings are refused', () => {
  const fixture = buildFixture();
  fixture.source.arms.sham.shamMovement = 0;
  fixture.expected.sourceEvidenceSha256 = sha256(canonicalAdaptiveJson(fixture.source));
  const aggregate = deriveAdaptiveControlEvidence(fixture.source, fixture.expected);
  assert.equal(aggregate.status, 'REFUSED');
  assert.equal(aggregate.code, 'ARM_SCHEMA_MISMATCH');

  const unbound = buildFixture();
  const missing = deriveAdaptiveControlEvidence(unbound.source);
  assert.equal(missing.status, 'REFUSED');
  assert.equal(missing.code, 'EXPECTED_BINDING_REQUIRED');
});

test('missing numeric evidence remains missing instead of coercing to zero', () => {
  const fixture = buildFixture();
  const arm = fixture.source.arms.baseline;
  arm.measurements[0].targetQuality = null;
  const payload = { ...arm };
  delete payload.armEvidenceSha256;
  arm.armEvidenceSha256 = sha256(canonicalAdaptiveJson(payload));
  fixture.expected.armEvidenceSha256.baseline = arm.armEvidenceSha256;
  fixture.expected.sourceEvidenceSha256 = sha256(canonicalAdaptiveJson(fixture.source));

  const result = deriveAdaptiveControlEvidence(fixture.source, fixture.expected);
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'MEASUREMENT_MISSING');
});
