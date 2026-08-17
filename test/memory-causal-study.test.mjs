import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMemoryCausalStudy,
  validateMemoryCausalStudyReport
} from '../src/memory-causal-study.mjs';

function arm(armId, quality, selectedRecordIds) {
  return {
    armId,
    contract: {
      model: 'gpt-5.6-sol', reasoningEffort: 'high', modelIdentitySha256: 'a'.repeat(64),
      promptTemplateSha256: 'b'.repeat(64), outputSchemaSha256: 'c'.repeat(64),
      taskPackSha256: 'd'.repeat(64), budget: { calls: 24, tokens: 100000 }
    },
    contextPackageSha256: armId[0].repeat(64).replaceAll('r', 'e').replaceAll('n', 'f').replaceAll('i', 'a'),
    selectedRecordIds,
    taskClusters: Array.from({ length: 10 }, (_, task) => ({
      taskId: `task-${task + 1}`,
      sourceIdentity: `source-task-${task + 1}`,
      replicates: Array.from({ length: 3 }, (_, replicate) => ({
        replicate,
        quality,
        tokenCost: 100,
        controlRegressions: 0,
        objectiveEvidenceSha256: String((task + replicate) % 10).repeat(64)
      }))
    }))
  };
}

function study(overrides = {}) {
  return {
    studyId: 'memory-study-1', manifestSha256: 'f'.repeat(64),
    generationOne: { learnedRecordIds: ['learned-1'], sourceIdentities: ['generation-one-source'] },
    generationTwo: { taskIdentities: Array.from({ length: 10 }, (_, index) => `source-task-${index + 1}`), irrelevantRecordIds: ['irrelevant-1'] },
    arms: [
      arm('relevant-memory', 1, ['learned-1']),
      arm('no-memory', 0, []),
      arm('irrelevant-memory', 0, ['irrelevant-1'])
    ],
    policy: { alpha: 0.025, familyAlpha: 0.05, maximumRelativeTokenIncrease: 0.1, policySha256: 'e'.repeat(64) },
    untouchedConfirmation: { verifierOwned: true, untouched: true, passed: true, evidenceSha256: '1'.repeat(64), taskIdentities: ['confirmation-task-1'] },
    ...overrides
  };
}

test('relevant memory must beat both no-memory and irrelevant-memory on disjoint task clusters', () => {
  const result = analyzeMemoryCausalStudy(study());
  assert.equal(result.status, 'OK');
  assert.equal(result.report.memoryCausalEffectSupported, true);
  assert.equal(result.report.contrasts.relevantVsNoMemory.taskCount, 10);
  assert.equal(result.report.contrasts.relevantVsIrrelevantMemory.taskCount, 10);
  assert.equal(validateMemoryCausalStudyReport(result.report).status, 'OK');
});

test('overlap, irrelevant contamination, and null effects fail closed or remain unsupported', () => {
  const overlap = study({
    generationOne: { learnedRecordIds: ['learned-1'], sourceIdentities: ['source-task-1'] }
  });
  assert.equal(analyzeMemoryCausalStudy(overlap).status, 'REFUSED');

  const nullStudy = study({
    arms: [
      arm('relevant-memory', 0, ['learned-1']),
      arm('no-memory', 0, []),
      arm('irrelevant-memory', 0, ['irrelevant-1'])
    ]
  });
  const result = analyzeMemoryCausalStudy(nullStudy);
  assert.equal(result.status, 'OK');
  assert.equal(result.report.memoryCausalEffectSupported, false);
  assert.equal(result.report.disposition, 'MEMORY_EFFECT_NOT_ESTABLISHED');
});
