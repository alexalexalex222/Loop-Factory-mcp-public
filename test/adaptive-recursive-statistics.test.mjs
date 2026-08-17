import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecursivePlaceboCalibration,
  buildRecursiveUntouchedConfirmation,
  validateRecursiveReplicatedAnalysis
} from '../src/adaptive-recursive-statistics.mjs';

function results(exact) {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `case-${String(index + 1).padStart(2, '0')}`,
    group: index < 9 ? 'target' : 'control',
    pass: index < exact,
    decisionPass: index < exact,
    codePass: index < exact
  }));
}

function blocks({ candidate = 12, parent = 8, sham = 8, cold = 8 } = {}) {
  return Array.from({ length: 5 }, (_, taskIndex) => (
    Array.from({ length: 3 }, (_, replicate) => ({
      taskId: `task-${taskIndex + 1}`,
      replicate,
      arms: {
        candidate: { results: results(candidate), tokenCost: 900 },
        cold: { results: results(cold), tokenCost: 1000 },
        parent: { results: results(parent), tokenCost: 950 },
        sham: { results: results(sham), tokenCost: 1000 }
      }
    }))
  )).flat();
}

test('replicated placebo calibration qualifies a consistent candidate beyond noise', () => {
  const calibrated = buildRecursivePlaceboCalibration(blocks());
  assert.equal(calibrated.status, 'OK');
  assert.equal(calibrated.record.qualified, true);
  assert.equal(calibrated.record.summary.blockCount, 15);
  assert.equal(calibrated.record.summary.taskCount, 5);
  assert.equal(calibrated.record.summary.adjusted.sampleSize, 5);
  assert.equal(
    calibrated.record.summary.adjusted.method,
    'paired-task-cluster-normal-approximation'
  );
  assert.equal(calibrated.record.summary.adjustedBlockSignTest, undefined);
  assert.equal(calibrated.record.summary.adjustedTaskSignTest.wins, 5);
  assert.equal(calibrated.record.summary.adjustedTaskSignTest.pOneSided, 0.03125);
  assert.equal(validateRecursiveReplicatedAnalysis(calibrated.record).status, 'OK');
});

test('an R4-shaped sham movement blocks calibration instead of being relabeled a win', () => {
  const calibrated = buildRecursivePlaceboCalibration(blocks({
    candidate: 12,
    parent: 11,
    sham: 10,
    cold: 8
  }));
  assert.equal(calibrated.status, 'OK');
  assert.equal(calibrated.record.qualified, false);
  assert.equal(calibrated.record.gates.candidateLowerBoundExceedsNoise, false);
  assert.equal(calibrated.record.gates.allTasksDirectionallyPositive, false);
});

test('untouched confirmation binds calibration and requires the same five-task endpoint', () => {
  const calibrated = buildRecursivePlaceboCalibration(blocks());
  const confirmation = buildRecursiveUntouchedConfirmation({
    calibration: calibrated.record,
    blocks: blocks({ candidate: 12, parent: 9, sham: 9, cold: 8 })
  });
  assert.equal(confirmation.status, 'OK');
  assert.equal(confirmation.record.causalPass, true);
  assert.equal(
    confirmation.record.calibrationAnalysisSha256,
    calibrated.record.analysisSha256
  );
  assert.equal(validateRecursiveReplicatedAnalysis(confirmation.record).status, 'OK');
});

test('confirmation refuses an unqualified calibration and analysis hashes are tamper-evident', () => {
  const weak = buildRecursivePlaceboCalibration(blocks({
    candidate: 9,
    parent: 8,
    sham: 9,
    cold: 8
  }));
  assert.equal(weak.record.qualified, false);
  assert.equal(buildRecursiveUntouchedConfirmation({
    calibration: weak.record,
    blocks: blocks()
  }).status, 'REFUSED');

  const strong = buildRecursivePlaceboCalibration(blocks());
  const tampered = structuredClone(strong.record);
  tampered.placeboUpper95 = 0.9;
  assert.equal(validateRecursiveReplicatedAnalysis(tampered).status, 'REFUSED');
});

test('missing replicate blocks cannot accidentally satisfy the complete design gate', () => {
  const calibrated = buildRecursivePlaceboCalibration(blocks().slice(0, 14));
  assert.equal(calibrated.status, 'OK');
  assert.equal(calibrated.record.qualified, false);
  assert.equal(calibrated.record.gates.completeDesign, false);
});
