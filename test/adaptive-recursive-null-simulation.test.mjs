import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateRecursiveAdaptiveNull,
  validateRecursiveAdaptiveNullSimulation
} from '../src/adaptive-recursive-null-simulation.mjs';

test('multi-generation null simulation exposes unreachable admission instead of passing trivially', () => {
  const first = simulateRecursiveAdaptiveNull({
    seed: 'recursive-null-repeated-test',
    campaigns: 2048,
    maximumGenerations: 5
  });
  const deterministicA = simulateRecursiveAdaptiveNull({
    seed: 'recursive-null-determinism-test',
    campaigns: 128,
    maximumGenerations: 2
  });
  const deterministicB = simulateRecursiveAdaptiveNull({
    seed: 'recursive-null-determinism-test',
    campaigns: 128,
    maximumGenerations: 2
  });
  assert.deepEqual(deterministicB, deterministicA);
  assert.equal(first.status, 'OK');
  assert.equal(first.record.calibrated, false);
  assert.equal(first.record.scientificVerdict, 'ADMISSION_RULE_UNREACHABLE');
  assert.equal(first.record.gates.admissionRuleReachable, false);
  assert.ok(first.record.outcomes.ordinaryChildPasses > 0);
  assert.equal(first.record.outcomes.campaignsWithAdmission, 0);
  assert.equal(
    first.record.statisticalAuthority.familywiseAdmissionReachable,
    false
  );
  assert.equal(validateRecursiveAdaptiveNullSimulation(first.record).status, 'OK');
});

test('single-generation null calibration exercises the reachable admission rule', () => {
  const result = simulateRecursiveAdaptiveNull({
    seed: 'recursive-null-single-test',
    campaigns: 4096,
    maximumGenerations: 1
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.record.calibrated, true);
  assert.equal(result.record.scientificVerdict, 'CALIBRATED');
  assert.equal(
    result.record.statisticalAuthority.familywiseAdmissionReachable,
    true
  );
  assert.ok(result.record.outcomes.campaignsWithAdmission > 0);
  assert.ok(result.record.outcomes.familywiseUpper95 < 0.05);

  const tampered = structuredClone(result.record);
  tampered.outcomes.familywiseErrorRate = 1;
  assert.equal(validateRecursiveAdaptiveNullSimulation(tampered).status, 'REFUSED');
});
