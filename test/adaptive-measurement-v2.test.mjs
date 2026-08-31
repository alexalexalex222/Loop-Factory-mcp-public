import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2,
  canonicalAdaptiveMeasurementJson,
  createAdaptiveMeasurementRecord,
  validateAdaptiveMeasurementRecord
} from '../src/adaptive-measurement-v2.mjs';
import { ADAPTIVE_SCHEMA, validateAdaptiveRecord } from '../src/adaptive-records.mjs';
import { listAdaptiveRecords, persistAdaptiveRecord } from '../src/mechanism-catalog.mjs';
import { sha256 } from '../src/util.mjs';

const CASES = Object.freeze([
  ['target-a', 'target'],
  ['target-b', 'target'],
  ['target-c', 'target'],
  ['control-a', 'control']
]);

function evaluation(taskId, armId, passes, {
  decisions = passes,
  codes = passes,
  artifactRef = `${taskId}-${armId}-evaluation`,
  artifactSha256 = sha256(`${taskId}:${armId}:artifact`),
  tokenCost = 100
} = {}) {
  return {
    evaluationArtifactRef: artifactRef,
    evaluationArtifactSha256: artifactSha256,
    tokenCost,
    results: CASES.map(([id, group], index) => ({
      id: `${taskId}-${id}`,
      group,
      pass: passes[index],
      decisionPass: decisions[index],
      codePass: codes[index]
    }))
  };
}

function source(runId = 'measurement-run-001') {
  return {
    kind: 'adaptive-executable-canary-v4',
    runId,
    verifierEvidenceSha256: sha256(`${runId}:verifier`),
    evaluatorAuthoritySha256: sha256(`${runId}:evaluator`),
    caseSetSha256: sha256(`${runId}:case-set`)
  };
}

function retrievalTasks() {
  return ['task-a', 'task-b'].map((taskId, index) => ({
    taskId,
    arms: {
      baseline: evaluation(taskId, 'baseline', [false, true, false, true], {
        decisions: [true, true, true, true],
        tokenCost: 100 + index
      }),
      routed: evaluation(taskId, 'routed', [true, true, true, true], {
        decisions: [true, true, true, true],
        tokenCost: 120 + index
      }),
      sham: evaluation(taskId, 'sham', [false, true, false, true], {
        decisions: [true, true, true, true],
        tokenCost: 130 + index
      })
    }
  }));
}

function recursiveTasks() {
  return ['task-c', 'task-d'].map((taskId, index) => ({
    taskId,
    arms: {
      candidate: evaluation(taskId, 'candidate', [true, true, true, true], {
        tokenCost: 140 + index
      }),
      cold: evaluation(taskId, 'cold', [false, true, false, true], {
        tokenCost: 100 + index
      }),
      parent: evaluation(taskId, 'parent', [true, true, false, true], {
        tokenCost: 130 + index
      }),
      sham: evaluation(taskId, 'sham', [false, true, false, true], {
        tokenCost: 150 + index
      })
    }
  }));
}

test('measurement v2 preserves continuous paired evidence instead of only perfect-task credit', () => {
  const built = createAdaptiveMeasurementRecord({
    source: source(),
    profile: 'retrieval-causal-v1',
    armRoles: {
      baseline: 'baseline',
      parent: null,
      sham: 'sham',
      treatment: 'routed'
    },
    mechanismBindings: {
      baseline: null,
      parent: null,
      sham: null,
      treatment: sha256('routed-program')
    },
    tasks: retrievalTasks()
  });
  assert.equal(built.status, 'OK', built.message);
  const record = built.record;
  assert.equal(record.schemaVersion, ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2);
  assert.equal(validateAdaptiveMeasurementRecord(record).status, 'OK');
  assert.equal(validateAdaptiveRecord(record).status, 'OK');
  assert.equal(record.taskCount, 2);
  assert.equal(record.caseCount, 8);
  assert.equal(record.arms.baseline.total.exact, 4);
  assert.equal(record.arms.routed.total.exact, 8);
  assert.equal(record.arms.sham.total.exact, 4);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.exact.delta, 0.5);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.decision.delta, 0);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.targetExact.delta, 0.6667);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.controlExact.delta, 0);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.fullRepair.delta, 1);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.exact.unit, 'case');
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.fullRepair.unit, 'task');
  assert.equal(record.contrasts.treatmentVsBaseline.tokenCost.absoluteDelta, 40);
  assert.equal(record.contrasts.treatmentVsParent, null);
  assert.equal(record.contrasts.treatmentVsSham.metrics.exact.delta, 0.5);
  assert.deepEqual(record.contrasts.shamVsBaseline.metrics.exact.confidence95, {
    lower: 0,
    upper: 0
  });

  const tampered = structuredClone(record);
  tampered.arms.routed.total.exact = 7;
  assert.equal(validateAdaptiveMeasurementRecord(tampered).status, 'REFUSED');

  const rehashed = structuredClone(record);
  rehashed.contrasts.treatmentVsBaseline.metrics.exact = structuredClone(
    rehashed.contrasts.treatmentVsBaseline.metrics.targetExact
  );
  const { measurementSha256: ignored, ...payload } = rehashed;
  rehashed.measurementSha256 = sha256(canonicalAdaptiveMeasurementJson(payload));
  assert.equal(validateAdaptiveMeasurementRecord(rehashed).status, 'REFUSED');
});

test('measurement v2 cannot enter the catalog through caller-owned persistence', () => {
  const built = createAdaptiveMeasurementRecord({
    source: source('catalog-measurement-run'),
    profile: 'retrieval-causal-v1',
    armRoles: {
      baseline: 'baseline',
      parent: null,
      sham: 'sham',
      treatment: 'routed'
    },
    mechanismBindings: {
      baseline: null,
      parent: null,
      sham: null,
      treatment: sha256('routed-program')
    },
    tasks: retrievalTasks()
  });
  assert.equal(built.status, 'OK', built.message);
  const homeDir = mkdtempSync(join(tmpdir(), 'adaptive-measurement-v2-'));
  const persisted = persistAdaptiveRecord({ homeDir, record: built.record });
  assert.equal(persisted.status, 'REFUSED');
  assert.equal(persisted.code, 'ADAPTIVE_MEASUREMENT_VERIFIER_REQUIRED');
  const listed = listAdaptiveRecords({
    homeDir,
    schemaVersion: ADAPTIVE_SCHEMA.MEASUREMENT
  });
  assert.equal(listed.status, 'OK');
  assert.equal(listed.records.length, 0);
});

test('measurement v2 supports a cold-parent-candidate-sham recursive contrast', () => {
  const built = createAdaptiveMeasurementRecord({
    source: source('recursive-measurement-run'),
    profile: 'recursive-causal-v1',
    armRoles: {
      baseline: 'cold',
      parent: 'parent',
      sham: 'sham',
      treatment: 'candidate'
    },
    mechanismBindings: {
      baseline: null,
      parent: sha256('parent-program'),
      sham: null,
      treatment: sha256('candidate-program')
    },
    tasks: recursiveTasks()
  });
  assert.equal(built.status, 'OK', built.message);
  const record = built.record;
  assert.equal(validateAdaptiveMeasurementRecord(record).status, 'OK');
  assert.equal(record.arms.cold.total.exact, 4);
  assert.equal(record.arms.parent.total.exact, 6);
  assert.equal(record.arms.candidate.total.exact, 8);
  assert.equal(record.contrasts.treatmentVsBaseline.metrics.exact.delta, 0.5);
  assert.equal(record.contrasts.treatmentVsParent.metrics.exact.delta, 0.25);
  assert.equal(record.contrasts.treatmentVsSham.metrics.exact.delta, 0.5);
  assert.equal(record.contrasts.treatmentVsParent.controlRegressions, 0);
  assert.equal(record.contrasts.shamVsBaseline.metrics.exact.delta, 0);
});

test('measurement v2 refuses unpaired cases and reused evaluation evidence', () => {
  const mismatched = retrievalTasks();
  mismatched[0].arms.routed.results[0].id = 'different-case';
  const pairing = createAdaptiveMeasurementRecord({
    source: source(),
    profile: 'retrieval-causal-v1',
    armRoles: {
      baseline: 'baseline',
      parent: null,
      sham: 'sham',
      treatment: 'routed'
    },
    mechanismBindings: {
      baseline: null,
      parent: null,
      sham: null,
      treatment: sha256('routed-program')
    },
    tasks: mismatched
  });
  assert.equal(pairing.status, 'REFUSED');
  assert.equal(pairing.code, 'MEASUREMENT_CASE_PAIRING_MISMATCH');

  const reused = retrievalTasks();
  reused[0].arms.sham.evaluationArtifactRef =
    reused[0].arms.baseline.evaluationArtifactRef;
  const duplicate = createAdaptiveMeasurementRecord({
    source: source(),
    profile: 'retrieval-causal-v1',
    armRoles: {
      baseline: 'baseline',
      parent: null,
      sham: 'sham',
      treatment: 'routed'
    },
    mechanismBindings: {
      baseline: null,
      parent: null,
      sham: null,
      treatment: sha256('routed-program')
    },
    tasks: reused
  });
  assert.equal(duplicate.status, 'REFUSED');
  assert.equal(duplicate.code, 'MEASUREMENT_ARTIFACT_REUSED');
});
