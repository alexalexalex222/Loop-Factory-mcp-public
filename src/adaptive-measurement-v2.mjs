import { isSafeId, round, sha256 } from './util.mjs';

export const ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2 = 'adaptive-measurement-v2';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GROUPS = Object.freeze(['target', 'control']);
const ARM_ROLE_KEYS = Object.freeze(['baseline', 'parent', 'sham', 'treatment']);
const CONTRAST_KEYS = Object.freeze([
  'shamVsBaseline',
  'treatmentVsBaseline',
  'treatmentVsParent',
  'treatmentVsSham'
]);
const METRIC_KEYS = Object.freeze([
  'code',
  'controlExact',
  'decision',
  'exact',
  'fullRepair',
  'targetExact'
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])])
  );
}

export function canonicalAdaptiveMeasurementJson(value) {
  return JSON.stringify(stableValue(value));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function validSha(value) {
  return SHA256_RE.test(String(value || ''));
}

function rate(successes, count) {
  return count > 0 ? round(successes / count) : null;
}

function relativeDelta(reference, treatment) {
  return reference > 0 ? round((treatment - reference) / reference) : null;
}

function normalizeArmRoles(value = {}) {
  if (!exactKeys(value, ARM_ROLE_KEYS)) return null;
  const roles = {
    baseline: isSafeId(value.baseline) ? String(value.baseline) : null,
    parent: value.parent == null ? null : (isSafeId(value.parent) ? String(value.parent) : null),
    sham: isSafeId(value.sham) ? String(value.sham) : null,
    treatment: isSafeId(value.treatment) ? String(value.treatment) : null
  };
  const values = Object.values(roles).filter(Boolean);
  return roles.baseline && roles.sham && roles.treatment
    && values.length === new Set(values).size
    ? roles
    : null;
}

function normalizeMechanismBindings(value = {}, hasParent) {
  if (!exactKeys(value, ['baseline', 'parent', 'sham', 'treatment'])) return null;
  const normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item == null ? null : (validSha(item) ? String(item) : undefined)
  ]));
  return !Object.values(normalized).includes(undefined)
    && normalized.treatment != null
    && (hasParent ? normalized.parent != null : normalized.parent == null)
    ? normalized
    : null;
}

function normalizeEvaluation(value, taskId, armId) {
  if (!exactKeys(value, [
    'evaluationArtifactRef',
    'evaluationArtifactSha256',
    'results',
    'tokenCost'
  ])
      || !isSafeId(value.evaluationArtifactRef)
      || !validSha(value.evaluationArtifactSha256)
      || !Number.isInteger(value.tokenCost)
      || value.tokenCost <= 0
      || !Array.isArray(value.results)
      || value.results.length < 2
      || value.results.length > 500) {
    return refused(
      'MEASUREMENT_EVALUATION_INVALID',
      `Task ${taskId} arm ${armId} has an invalid evaluation binding.`
    );
  }
  const results = value.results.map((item) => {
    if (!exactKeys(item, ['codePass', 'decisionPass', 'group', 'id', 'pass'])
        || !isSafeId(item.id)
        || !GROUPS.includes(item.group)
        || typeof item.pass !== 'boolean'
        || typeof item.decisionPass !== 'boolean'
        || typeof item.codePass !== 'boolean') return null;
    return {
      id: String(item.id),
      group: item.group,
      pass: item.pass,
      decisionPass: item.decisionPass,
      codePass: item.codePass
    };
  });
  if (results.some((item) => !item)
      || new Set(results.map((item) => item.id)).size !== results.length
      || GROUPS.some((group) => !results.some((item) => item.group === group))) {
    return refused(
      'MEASUREMENT_CASE_SET_INVALID',
      `Task ${taskId} arm ${armId} has malformed, duplicated, or incomplete cases.`
    );
  }
  results.sort((left, right) => left.id.localeCompare(right.id));
  return ok({
    evaluation: {
      evaluationArtifactRef: String(value.evaluationArtifactRef),
      evaluationArtifactSha256: String(value.evaluationArtifactSha256),
      tokenCost: value.tokenCost,
      results
    }
  });
}

function caseLayout(results) {
  return results.map((item) => ({ id: item.id, group: item.group }));
}

function summarizeResults(results) {
  const groupSummary = Object.fromEntries(GROUPS.map((group) => {
    const rows = results.filter((item) => item.group === group);
    return [group, {
      cases: rows.length,
      exact: rows.filter((item) => item.pass).length,
      decisions: rows.filter((item) => item.decisionPass).length,
      codes: rows.filter((item) => item.codePass).length
    }];
  }));
  const total = {
    cases: results.length,
    exact: results.filter((item) => item.pass).length,
    decisions: results.filter((item) => item.decisionPass).length,
    codes: results.filter((item) => item.codePass).length
  };
  return { ...groupSummary, total };
}

function summarizeArm(tasks, armId) {
  const summary = {
    tasks: tasks.length,
    fullRepairs: 0,
    target: { cases: 0, exact: 0, decisions: 0, codes: 0 },
    control: { cases: 0, exact: 0, decisions: 0, codes: 0 },
    total: { cases: 0, exact: 0, decisions: 0, codes: 0 },
    tokenCost: 0
  };
  for (const task of tasks) {
    const evaluation = task.arms[armId];
    const counts = summarizeResults(evaluation.results);
    summary.tokenCost += evaluation.tokenCost;
    summary.fullRepairs += Number(counts.total.exact === counts.total.cases);
    for (const group of [...GROUPS, 'total']) {
      for (const field of ['cases', 'exact', 'decisions', 'codes']) {
        summary[group][field] += counts[group][field];
      }
    }
  }
  return {
    ...summary,
    rates: {
      exact: rate(summary.total.exact, summary.total.cases),
      decision: rate(summary.total.decisions, summary.total.cases),
      code: rate(summary.total.codes, summary.total.cases),
      targetExact: rate(summary.target.exact, summary.target.cases),
      controlExact: rate(summary.control.exact, summary.control.cases),
      fullRepair: rate(summary.fullRepairs, summary.tasks)
    }
  };
}

function pairedEstimate(referenceValues, treatmentValues, unit) {
  const sampleSize = referenceValues.length;
  const differences = referenceValues.map((value, index) => (
    Number(treatmentValues[index]) - Number(value)
  ));
  const referenceSuccesses = referenceValues.filter(Boolean).length;
  const treatmentSuccesses = treatmentValues.filter(Boolean).length;
  const wins = differences.filter((value) => value === 1).length;
  const regressions = differences.filter((value) => value === -1).length;
  const delta = rate(treatmentSuccesses - referenceSuccesses, sampleSize);
  let standardError = null;
  let confidence95 = null;
  if (sampleSize > 1) {
    const mean = (treatmentSuccesses - referenceSuccesses) / sampleSize;
    const squared = differences.reduce((sum, value) => sum + ((value - mean) ** 2), 0);
    standardError = round(Math.sqrt((squared / (sampleSize - 1)) / sampleSize));
    confidence95 = {
      lower: round(Math.max(-1, mean - (1.96 * standardError))),
      upper: round(Math.min(1, mean + (1.96 * standardError)))
    };
  }
  return {
    sampleSize,
    referenceSuccesses,
    treatmentSuccesses,
    wins,
    regressions,
    delta,
    standardError,
    confidence95,
    method: 'paired-normal-approximation',
    unit
  };
}

function metricValues(tasks, armId, metric) {
  if (metric === 'fullRepair') {
    return tasks.map((task) => task.arms[armId].results.every((item) => item.pass));
  }
  const [field, group] = metric === 'decision'
    ? ['decisionPass', null]
    : metric === 'code'
      ? ['codePass', null]
      : metric === 'targetExact'
        ? ['pass', 'target']
        : metric === 'controlExact'
          ? ['pass', 'control']
          : ['pass', null];
  return tasks.flatMap((task) => task.arms[armId].results
    .filter((item) => group == null || item.group === group)
    .map((item) => item[field]));
}

function buildContrast(tasks, arms, referenceId, treatmentId) {
  if (referenceId == null || treatmentId == null) return null;
  const metrics = Object.fromEntries(METRIC_KEYS.map((metric) => [
    metric,
    pairedEstimate(
      metricValues(tasks, referenceId, metric),
      metricValues(tasks, treatmentId, metric),
      metric === 'fullRepair' ? 'task' : 'case'
    )
  ]));
  return {
    referenceArm: referenceId,
    treatmentArm: treatmentId,
    metrics,
    targetRegressions: metrics.targetExact.regressions,
    controlRegressions: metrics.controlExact.regressions,
    tokenCost: {
      reference: arms[referenceId].tokenCost,
      treatment: arms[treatmentId].tokenCost,
      absoluteDelta: arms[treatmentId].tokenCost - arms[referenceId].tokenCost,
      relativeDelta: relativeDelta(arms[referenceId].tokenCost, arms[treatmentId].tokenCost)
    }
  };
}

function measurementPayload(record) {
  const payload = { ...record };
  delete payload.measurementSha256;
  return payload;
}

function metricShapeValid(metric) {
  if (!exactKeys(metric, [
    'confidence95',
    'delta',
    'method',
    'referenceSuccesses',
    'regressions',
    'sampleSize',
    'standardError',
    'treatmentSuccesses',
    'unit',
    'wins'
  ])
      || !Number.isInteger(metric.sampleSize)
      || metric.sampleSize < 1
      || ![metric.referenceSuccesses, metric.treatmentSuccesses, metric.wins, metric.regressions]
        .every((value) => Number.isInteger(value) && value >= 0 && value <= metric.sampleSize)
      || metric.method !== 'paired-normal-approximation') return false;
  if (!['case', 'task'].includes(metric.unit)) return false;
  const expectedDelta = rate(
    metric.treatmentSuccesses - metric.referenceSuccesses,
    metric.sampleSize
  );
  if (metric.delta !== expectedDelta
      || metric.wins - metric.regressions
        !== metric.treatmentSuccesses - metric.referenceSuccesses) return false;
  if (metric.sampleSize === 1) {
    return metric.standardError == null && metric.confidence95 == null;
  }
  if (!Number.isFinite(metric.standardError)
      || !exactKeys(metric.confidence95, ['lower', 'upper'])
      || !Number.isFinite(metric.confidence95.lower)
      || !Number.isFinite(metric.confidence95.upper)
      || metric.confidence95.lower > metric.confidence95.upper) return false;
  const mean = (metric.treatmentSuccesses - metric.referenceSuccesses) / metric.sampleSize;
  const squared = metric.wins * ((1 - mean) ** 2)
    + metric.regressions * ((-1 - mean) ** 2)
    + (metric.sampleSize - metric.wins - metric.regressions) * (mean ** 2);
  const expectedSe = round(Math.sqrt((squared / (metric.sampleSize - 1)) / metric.sampleSize));
  return metric.standardError === expectedSe
    && metric.confidence95.lower === round(Math.max(-1, mean - (1.96 * expectedSe)))
    && metric.confidence95.upper === round(Math.min(1, mean + (1.96 * expectedSe)));
}

function armSummaryValid(summary, taskCount, caseCount) {
  if (!exactKeys(summary, [
    'control',
    'fullRepairs',
    'rates',
    'target',
    'tasks',
    'tokenCost',
    'total'
  ])
      || summary.tasks !== taskCount
      || !Number.isInteger(summary.fullRepairs)
      || summary.fullRepairs < 0
      || summary.fullRepairs > taskCount
      || !Number.isInteger(summary.tokenCost)
      || summary.tokenCost <= 0) return false;
  for (const group of [...GROUPS, 'total']) {
    if (!exactKeys(summary[group], ['cases', 'codes', 'decisions', 'exact'])) return false;
    const values = summary[group];
    if (![values.cases, values.exact, values.decisions, values.codes]
      .every((value) => Number.isInteger(value) && value >= 0)
        || [values.exact, values.decisions, values.codes]
          .some((value) => value > values.cases)) return false;
  }
  if (summary.total.cases !== caseCount
      || summary.target.cases + summary.control.cases !== caseCount
      || summary.target.exact + summary.control.exact !== summary.total.exact
      || summary.target.decisions + summary.control.decisions !== summary.total.decisions
      || summary.target.codes + summary.control.codes !== summary.total.codes
      || !exactKeys(summary.rates, [
        'code',
        'controlExact',
        'decision',
        'exact',
        'fullRepair',
        'targetExact'
      ])) return false;
  return summary.rates.exact === rate(summary.total.exact, summary.total.cases)
    && summary.rates.decision === rate(summary.total.decisions, summary.total.cases)
    && summary.rates.code === rate(summary.total.codes, summary.total.cases)
    && summary.rates.targetExact === rate(summary.target.exact, summary.target.cases)
    && summary.rates.controlExact === rate(summary.control.exact, summary.control.cases)
    && summary.rates.fullRepair === rate(summary.fullRepairs, summary.tasks);
}

function metricSuccesses(summary, metric) {
  return metric === 'exact'
    ? [summary.total.exact, summary.total.cases]
    : metric === 'decision'
      ? [summary.total.decisions, summary.total.cases]
      : metric === 'code'
        ? [summary.total.codes, summary.total.cases]
        : metric === 'targetExact'
          ? [summary.target.exact, summary.target.cases]
          : metric === 'controlExact'
            ? [summary.control.exact, summary.control.cases]
            : [summary.fullRepairs, summary.tasks];
}

function contrastValid(contrast, arms, referenceId, treatmentId) {
  if (contrast == null) return referenceId == null || treatmentId == null;
  if (!exactKeys(contrast, [
    'controlRegressions',
    'metrics',
    'referenceArm',
    'targetRegressions',
    'tokenCost',
    'treatmentArm'
  ])
      || contrast.referenceArm !== referenceId
      || contrast.treatmentArm !== treatmentId
      || !exactKeys(contrast.metrics, METRIC_KEYS)
      || METRIC_KEYS.some((key) => !metricShapeValid(contrast.metrics[key]))
      || contrast.targetRegressions !== contrast.metrics.targetExact.regressions
      || contrast.controlRegressions !== contrast.metrics.controlExact.regressions
      || !exactKeys(contrast.tokenCost, [
        'absoluteDelta',
        'reference',
        'relativeDelta',
        'treatment'
      ])) return false;
  for (const metric of METRIC_KEYS) {
    const [referenceSuccesses, sampleSize] = metricSuccesses(arms[referenceId], metric);
    const [treatmentSuccesses, treatmentSampleSize] = metricSuccesses(
      arms[treatmentId],
      metric
    );
    if (sampleSize !== treatmentSampleSize
        || contrast.metrics[metric].sampleSize !== sampleSize
        || contrast.metrics[metric].unit !== (metric === 'fullRepair' ? 'task' : 'case')
        || contrast.metrics[metric].referenceSuccesses !== referenceSuccesses
        || contrast.metrics[metric].treatmentSuccesses !== treatmentSuccesses) return false;
  }
  const reference = arms[referenceId].tokenCost;
  const treatment = arms[treatmentId].tokenCost;
  return contrast.tokenCost.reference === reference
    && contrast.tokenCost.treatment === treatment
    && contrast.tokenCost.absoluteDelta === treatment - reference
    && contrast.tokenCost.relativeDelta === relativeDelta(reference, treatment);
}

export function createAdaptiveMeasurementRecord({
  source = {},
  profile,
  armRoles: inputArmRoles,
  mechanismBindings: inputMechanismBindings,
  tasks: inputTasks
} = {}) {
  try {
    const armRoles = normalizeArmRoles(inputArmRoles);
    const expectedProfile = armRoles?.parent == null
      ? 'retrieval-causal-v1'
      : 'recursive-causal-v1';
    const mechanismBindings = normalizeMechanismBindings(
      inputMechanismBindings,
      armRoles?.parent != null
    );
    if (!armRoles || !mechanismBindings || profile !== expectedProfile
        || !isSafeId(source.kind)
        || !isSafeId(source.runId)
        || !validSha(source.verifierEvidenceSha256)
        || !validSha(source.evaluatorAuthoritySha256)
        || !validSha(source.caseSetSha256)
        || !Array.isArray(inputTasks)
        || inputTasks.length < 1
        || inputTasks.length > 100) {
      return refused(
        'MEASUREMENT_INPUT_INVALID',
        'Measurement v2 requires verifier-bound source authority, a valid arm profile, and bounded paired tasks.'
      );
    }
    const armIds = Object.values(armRoles).filter(Boolean).sort();
    const tasks = [];
    const artifactRefs = new Set();
    for (const inputTask of inputTasks) {
      if (!exactKeys(inputTask, ['arms', 'taskId'])
          || !isSafeId(inputTask.taskId)
          || !exactKeys(inputTask.arms, armIds)) {
        return refused('MEASUREMENT_TASK_INVALID', 'Every task must bind the exact declared arm set.');
      }
      const arms = {};
      let expectedLayout = null;
      for (const armId of armIds) {
        const normalized = normalizeEvaluation(inputTask.arms[armId], inputTask.taskId, armId);
        if (normalized.status !== 'OK') return normalized;
        const evaluation = normalized.evaluation;
        if (artifactRefs.has(evaluation.evaluationArtifactRef)) {
          return refused(
            'MEASUREMENT_ARTIFACT_REUSED',
            'Every arm evaluation must bind a unique persisted artifact.'
          );
        }
        artifactRefs.add(evaluation.evaluationArtifactRef);
        const layout = canonicalAdaptiveMeasurementJson(caseLayout(evaluation.results));
        if (expectedLayout != null && layout !== expectedLayout) {
          return refused(
            'MEASUREMENT_CASE_PAIRING_MISMATCH',
            `Task ${inputTask.taskId} does not expose the same case IDs and groups in every arm.`
          );
        }
        expectedLayout = layout;
        arms[armId] = evaluation;
      }
      tasks.push({ taskId: String(inputTask.taskId), arms });
    }
    tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
    if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
      return refused('MEASUREMENT_TASK_DUPLICATED', 'Measurement task IDs must be unique.');
    }
    const arms = Object.fromEntries(armIds.map((armId) => [
      armId,
      summarizeArm(tasks, armId)
    ]));
    const caseCount = arms[armRoles.baseline].total.cases;
    if (Object.values(arms).some((summary) => summary.total.cases !== caseCount)) {
      return refused('MEASUREMENT_CASE_COUNT_MISMATCH', 'Every arm must contain the same paired case count.');
    }
    const taskEvidence = tasks.map((task) => ({
      taskId: task.taskId,
      caseLayoutSha256: sha256(canonicalAdaptiveMeasurementJson(
        caseLayout(task.arms[armRoles.baseline].results)
      )),
      arms: Object.fromEntries(armIds.map((armId) => {
        const evaluation = task.arms[armId];
        const counts = summarizeResults(evaluation.results);
        return [armId, {
          evaluationArtifactRef: evaluation.evaluationArtifactRef,
          evaluationArtifactSha256: evaluation.evaluationArtifactSha256,
          tokenCost: evaluation.tokenCost,
          targetCases: counts.target.cases,
          controlCases: counts.control.cases
        }];
      }))
    }));
    const derivedCaseLayoutSha256 = sha256(canonicalAdaptiveMeasurementJson(
      taskEvidence.map((task) => ({
        taskId: task.taskId,
        caseLayoutSha256: task.caseLayoutSha256
      }))
    ));
    const artifactSetSha256 = sha256(canonicalAdaptiveMeasurementJson(
      taskEvidence.flatMap((task) => Object.values(task.arms).map((arm) => ({
        evaluationArtifactRef: arm.evaluationArtifactRef,
        evaluationArtifactSha256: arm.evaluationArtifactSha256
      }))).sort((left, right) => (
        left.evaluationArtifactRef.localeCompare(right.evaluationArtifactRef)
      ))
    ));
    const contrasts = {
      shamVsBaseline: buildContrast(
        tasks,
        arms,
        armRoles.baseline,
        armRoles.sham
      ),
      treatmentVsBaseline: buildContrast(
        tasks,
        arms,
        armRoles.baseline,
        armRoles.treatment
      ),
      treatmentVsParent: buildContrast(
        tasks,
        arms,
        armRoles.parent,
        armRoles.treatment
      ),
      treatmentVsSham: buildContrast(
        tasks,
        arms,
        armRoles.sham,
        armRoles.treatment
      )
    };
    const identity = {
      sourceKind: String(source.kind),
      runId: String(source.runId),
      verifierEvidenceSha256: String(source.verifierEvidenceSha256),
      profile,
      armRoles,
      mechanismBindings,
      derivedCaseLayoutSha256
    };
    const measurementId = `measurement-${sha256(
      canonicalAdaptiveMeasurementJson(identity)
    ).slice(0, 24)}`;
    const payload = {
      schemaVersion: ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2,
      measurementId,
      profile,
      authority: 'tool-derived-from-persisted-evaluations',
      source: {
        kind: String(source.kind),
        runId: String(source.runId),
        verifierEvidenceSha256: String(source.verifierEvidenceSha256),
        evaluatorAuthoritySha256: String(source.evaluatorAuthoritySha256),
        caseSetSha256: String(source.caseSetSha256)
      },
      armRoles,
      mechanismBindings,
      taskCount: tasks.length,
      caseCount,
      derivedCaseLayoutSha256,
      artifactSetSha256,
      taskEvidence,
      arms,
      contrasts
    };
    return ok({
      record: {
        ...payload,
        measurementSha256: sha256(canonicalAdaptiveMeasurementJson(payload))
      }
    });
  } catch (error) {
    return refused('MEASUREMENT_BUILD_FAILED', error.message);
  }
}

export function validateAdaptiveMeasurementRecord(record) {
  try {
    if (!exactKeys(record, [
      'armRoles',
      'arms',
      'artifactSetSha256',
      'authority',
      'caseCount',
      'contrasts',
      'derivedCaseLayoutSha256',
      'measurementId',
      'measurementSha256',
      'mechanismBindings',
      'profile',
      'schemaVersion',
      'source',
      'taskCount',
      'taskEvidence'
    ])
        || record.schemaVersion !== ADAPTIVE_MEASUREMENT_SCHEMA_VERSION_V2
        || !/^measurement-[a-f0-9]{24}$/.test(String(record.measurementId || ''))
        || !validSha(record.measurementSha256)
        || record.authority !== 'tool-derived-from-persisted-evaluations'
        || !Number.isInteger(record.taskCount)
        || record.taskCount < 1
        || !Number.isInteger(record.caseCount)
        || record.caseCount < 1
        || !validSha(record.derivedCaseLayoutSha256)
        || !validSha(record.artifactSetSha256)
        || !exactKeys(record.source, [
          'caseSetSha256',
          'evaluatorAuthoritySha256',
          'kind',
          'runId',
          'verifierEvidenceSha256'
        ])) return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement v2 shape is invalid.');
    const armRoles = normalizeArmRoles(record.armRoles);
    const expectedProfile = armRoles?.parent == null
      ? 'retrieval-causal-v1'
      : 'recursive-causal-v1';
    const mechanismBindings = normalizeMechanismBindings(
      record.mechanismBindings,
      armRoles?.parent != null
    );
    if (!armRoles || !mechanismBindings || record.profile !== expectedProfile
        || !isSafeId(record.source.kind)
        || !isSafeId(record.source.runId)
        || !validSha(record.source.verifierEvidenceSha256)
        || !validSha(record.source.evaluatorAuthoritySha256)
        || !validSha(record.source.caseSetSha256)) {
      return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement source or arm roles are invalid.');
    }
    const armIds = Object.values(armRoles).filter(Boolean).sort();
    if (!exactKeys(record.arms, armIds)
        || armIds.some((armId) => !armSummaryValid(
          record.arms[armId],
          record.taskCount,
          record.caseCount
        ))
        || !exactKeys(record.contrasts, CONTRAST_KEYS)
        || !contrastValid(
          record.contrasts.shamVsBaseline,
          record.arms,
          armRoles.baseline,
          armRoles.sham
        )
        || !contrastValid(
          record.contrasts.treatmentVsBaseline,
          record.arms,
          armRoles.baseline,
          armRoles.treatment
        )
        || !contrastValid(
          record.contrasts.treatmentVsParent,
          record.arms,
          armRoles.parent,
          armRoles.treatment
        )
        || !contrastValid(
          record.contrasts.treatmentVsSham,
          record.arms,
          armRoles.sham,
          armRoles.treatment
        )) {
      return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement summaries or contrasts are invalid.');
    }
    if (!Array.isArray(record.taskEvidence)
        || record.taskEvidence.length !== record.taskCount
        || new Set(record.taskEvidence.map((task) => task.taskId)).size !== record.taskCount) {
      return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement task evidence is incomplete.');
    }
    const orderedTasks = [...record.taskEvidence].sort((left, right) => (
      String(left.taskId).localeCompare(String(right.taskId))
    ));
    if (canonicalAdaptiveMeasurementJson(orderedTasks)
        !== canonicalAdaptiveMeasurementJson(record.taskEvidence)) {
      return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement task evidence is not canonical.');
    }
    const artifactRefs = new Set();
    const tokenTotals = Object.fromEntries(armIds.map((armId) => [armId, 0]));
    const targetCaseTotals = Object.fromEntries(armIds.map((armId) => [armId, 0]));
    const controlCaseTotals = Object.fromEntries(armIds.map((armId) => [armId, 0]));
    for (const task of record.taskEvidence) {
      if (!exactKeys(task, ['arms', 'caseLayoutSha256', 'taskId'])
          || !isSafeId(task.taskId)
          || !validSha(task.caseLayoutSha256)
          || !exactKeys(task.arms, armIds)) {
        return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement task evidence is malformed.');
      }
      for (const armId of armIds) {
        const evidence = task.arms[armId];
        if (!exactKeys(evidence, [
          'controlCases',
          'evaluationArtifactRef',
          'evaluationArtifactSha256',
          'targetCases',
          'tokenCost'
        ])
            || !isSafeId(evidence.evaluationArtifactRef)
            || !validSha(evidence.evaluationArtifactSha256)
            || !Number.isInteger(evidence.tokenCost)
            || evidence.tokenCost <= 0
            || !Number.isInteger(evidence.targetCases)
            || evidence.targetCases < 1
            || !Number.isInteger(evidence.controlCases)
            || evidence.controlCases < 1
            || artifactRefs.has(evidence.evaluationArtifactRef)) {
          return refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement artifact evidence is invalid.');
        }
        artifactRefs.add(evidence.evaluationArtifactRef);
        tokenTotals[armId] += evidence.tokenCost;
        targetCaseTotals[armId] += evidence.targetCases;
        controlCaseTotals[armId] += evidence.controlCases;
      }
    }
    if (armIds.some((armId) => (
      tokenTotals[armId] !== record.arms[armId].tokenCost
      || targetCaseTotals[armId] !== record.arms[armId].target.cases
      || controlCaseTotals[armId] !== record.arms[armId].control.cases
    ))) {
      return refused(
        'INVALID_ADAPTIVE_MEASUREMENT',
        'Measurement token or case totals do not match task evidence.'
      );
    }
    const derivedCaseLayoutSha256 = sha256(canonicalAdaptiveMeasurementJson(
      record.taskEvidence.map((task) => ({
        taskId: task.taskId,
        caseLayoutSha256: task.caseLayoutSha256
      }))
    ));
    const artifactSetSha256 = sha256(canonicalAdaptiveMeasurementJson(
      record.taskEvidence.flatMap((task) => Object.values(task.arms).map((arm) => ({
        evaluationArtifactRef: arm.evaluationArtifactRef,
        evaluationArtifactSha256: arm.evaluationArtifactSha256
      }))).sort((left, right) => (
        left.evaluationArtifactRef.localeCompare(right.evaluationArtifactRef)
      ))
    ));
    const identity = {
      sourceKind: record.source.kind,
      runId: record.source.runId,
      verifierEvidenceSha256: record.source.verifierEvidenceSha256,
      profile: record.profile,
      armRoles,
      mechanismBindings,
      derivedCaseLayoutSha256
    };
    const measurementId = `measurement-${sha256(
      canonicalAdaptiveMeasurementJson(identity)
    ).slice(0, 24)}`;
    return record.derivedCaseLayoutSha256 === derivedCaseLayoutSha256
      && record.artifactSetSha256 === artifactSetSha256
      && record.measurementId === measurementId
      && record.measurementSha256 === sha256(canonicalAdaptiveMeasurementJson(
        measurementPayload(record)
      ))
      ? ok({ schemaVersion: record.schemaVersion })
      : refused('INVALID_ADAPTIVE_MEASUREMENT', 'Measurement hashes do not match its evidence.');
  } catch (error) {
    return refused('INVALID_ADAPTIVE_MEASUREMENT', error.message);
  }
}
