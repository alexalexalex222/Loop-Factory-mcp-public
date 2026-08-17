#!/usr/bin/env node

import {
  simulateRecursiveAdaptiveNull,
  validateRecursiveAdaptiveNullSimulation
} from '../src/adaptive-recursive-null-simulation.mjs';

const repeated = simulateRecursiveAdaptiveNull({
  seed: 'loop-factory-recursive-null-repeated-v1',
  campaigns: 2048,
  maximumGenerations: 5
});
const single = simulateRecursiveAdaptiveNull({
  seed: 'loop-factory-recursive-null-single-v1',
  campaigns: 2048,
  maximumGenerations: 1
});
const repeatedDiagnosed = repeated.status === 'OK'
  && repeated.record.calibrated === false
  && repeated.record.scientificVerdict === 'ADMISSION_RULE_UNREACHABLE'
  && repeated.record.statisticalAuthority.familywiseAdmissionReachable === false
  && validateRecursiveAdaptiveNullSimulation(repeated.record).status === 'OK';
const singleCalibrated = single.status === 'OK'
  && single.record.calibrated === true
  && single.record.scientificVerdict === 'CALIBRATED'
  && validateRecursiveAdaptiveNullSimulation(single.record).status === 'OK';
const valid = repeatedDiagnosed && singleCalibrated;

process.stdout.write(`${JSON.stringify({
  status: valid ? 'PASS_WITH_MULTI_GENERATION_DIAGNOSTIC' : 'FAIL',
  paidModelCalls: 0,
  repeatedSelection: repeated.record ?? repeated,
  singleGeneration: single.record ?? single
}, null, 2)}\n`);
process.exit(valid ? 0 : 1);
