import { sha256 } from './util.mjs';

export const RECURSIVE_REPLICATED_ANALYSIS_SCHEMA =
  'adaptive-recursive-replicated-analysis-v1';
export const RECURSIVE_PLACEBO_CALIBRATION_RULE =
  'paired-placebo-upper-bound-v1';
export const RECURSIVE_CONFIRMATION_RULE =
  'five-task-adjusted-sign-test-v1';

const ARMS = Object.freeze(['candidate', 'cold', 'parent', 'sham']);
const SHA256_RE = /^[a-f0-9]{64}$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => (
    [key, stableValue(value[key])]
  )));
}

export function canonicalRecursiveAnalysisJson(value) {
  return JSON.stringify(stableValue(value));
}

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => (
    sum + ((value - center) ** 2)
  ), 0) / (values.length - 1));
}

function confidence(values) {
  if (!values.length) return null;
  const center = mean(values);
  const standardDeviation = sampleStandardDeviation(values);
  const standardError = standardDeviation / Math.sqrt(values.length);
  return {
    sampleSize: values.length,
    mean: round(center),
    standardDeviation: round(standardDeviation),
    standardError: round(standardError),
    lower95: round(center - (1.96 * standardError)),
    upper95: round(center + (1.96 * standardError)),
    method: 'paired-block-normal-approximation'
  };
}

function combinations(n, k) {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let index = 1; index <= Math.min(k, n - k); index++) {
    value = (value * (n - index + 1)) / index;
  }
  return value;
}

function signTest(values) {
  const wins = values.filter((value) => value > 0).length;
  const losses = values.filter((value) => value < 0).length;
  const ties = values.length - wins - losses;
  const trials = wins + losses;
  let numerator = 0;
  for (let count = wins; count <= trials; count++) {
    numerator += combinations(trials, count);
  }
  return {
    wins,
    losses,
    ties,
    trials,
    pOneSided: trials ? round(numerator / (2 ** trials), 8) : 1,
    method: 'exact-binomial-sign-test'
  };
}

function normalizeResults(arm, taskId, replicate) {
  if (!plainObject(arm)
      || !Array.isArray(arm.results)
      || !Number.isInteger(arm.tokenCost)
      || arm.tokenCost < 0) {
    throw new Error(`invalid replicated arm for ${taskId} replicate ${replicate}`);
  }
  const results = arm.results.map((result) => {
    if (!plainObject(result)
        || typeof result.id !== 'string'
        || !['target', 'control'].includes(result.group)
        || typeof result.pass !== 'boolean'
        || typeof result.decisionPass !== 'boolean'
        || typeof result.codePass !== 'boolean') {
      throw new Error(`invalid replicated result for ${taskId} replicate ${replicate}`);
    }
    return {
      id: result.id,
      group: result.group,
      pass: result.pass,
      decisionPass: result.decisionPass,
      codePass: result.codePass
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (!results.length || new Set(results.map((result) => result.id)).size !== results.length) {
    throw new Error(`duplicated or empty replicated results for ${taskId} replicate ${replicate}`);
  }
  return { results, tokenCost: arm.tokenCost };
}

function resultLayout(results) {
  return results.map((result) => ({ id: result.id, group: result.group }));
}

function rate(results, field = 'pass', group = null) {
  const selected = group ? results.filter((result) => result.group === group) : results;
  return selected.length
    ? selected.filter((result) => result[field] === true).length / selected.length
    : 0;
}

function regressions(reference, treatment, group) {
  const byId = new Map(treatment.map((result) => [result.id, result]));
  return reference.filter((result) => (
    result.group === group
    && result.pass === true
    && byId.get(result.id)?.pass === false
  )).length;
}

function summarizeArm(blocks, arm) {
  const results = blocks.flatMap((block) => block.arms[arm].results);
  const target = results.filter((result) => result.group === 'target');
  const control = results.filter((result) => result.group === 'control');
  return {
    blocks: blocks.length,
    cases: results.length,
    exact: results.filter((result) => result.pass).length,
    decisions: results.filter((result) => result.decisionPass).length,
    codes: results.filter((result) => result.codePass).length,
    targetCases: target.length,
    targetExact: target.filter((result) => result.pass).length,
    controlCases: control.length,
    controlExact: control.filter((result) => result.pass).length,
    tokenCost: blocks.reduce((sum, block) => sum + block.arms[arm].tokenCost, 0)
  };
}

export function summarizeRecursiveReplicatedStage(inputBlocks = []) {
  try {
    if (!Array.isArray(inputBlocks) || !inputBlocks.length) {
      return { status: 'REFUSED', code: 'REPLICATED_BLOCKS_REQUIRED' };
    }
    const blocks = inputBlocks.map((input) => {
      if (!plainObject(input)
          || typeof input.taskId !== 'string'
          || !input.taskId
          || !Number.isInteger(input.replicate)
          || input.replicate < 0
          || !plainObject(input.arms)) {
        throw new Error('replicated block identity is invalid');
      }
      const arms = Object.fromEntries(ARMS.map((arm) => (
        [arm, normalizeResults(input.arms[arm], input.taskId, input.replicate)]
      )));
      const layout = canonicalRecursiveAnalysisJson(resultLayout(arms.cold.results));
      if (ARMS.some((arm) => (
        canonicalRecursiveAnalysisJson(resultLayout(arms[arm].results)) !== layout
      ))) {
        throw new Error(`replicated arm layouts differ for ${input.taskId}`);
      }
      const candidateExact = rate(arms.candidate.results);
      const parentExact = rate(arms.parent.results);
      const shamExact = rate(arms.sham.results);
      const coldExact = rate(arms.cold.results);
      return {
        taskId: input.taskId,
        replicate: input.replicate,
        arms,
        exact: {
          candidateVsParent: candidateExact - parentExact,
          shamVsCold: shamExact - coldExact,
          adjusted: (candidateExact - parentExact) - (shamExact - coldExact)
        },
        targetRegressions: regressions(
          arms.parent.results,
          arms.candidate.results,
          'target'
        ),
        controlRegressions: regressions(
          arms.parent.results,
          arms.candidate.results,
          'control'
        )
      };
    }).sort((left, right) => (
      left.taskId.localeCompare(right.taskId) || left.replicate - right.replicate
    ));
    const identities = blocks.map((block) => `${block.taskId}:${block.replicate}`);
    if (new Set(identities).size !== identities.length) {
      throw new Error('replicated block identities are duplicated');
    }
    const taskGroups = [...new Set(blocks.map((block) => block.taskId))].map((taskId) => {
      const rows = blocks.filter((block) => block.taskId === taskId);
      return {
        taskId,
        blocks: rows.length,
        candidateVsParentMean: round(mean(rows.map((row) => row.exact.candidateVsParent))),
        shamVsColdMean: round(mean(rows.map((row) => row.exact.shamVsCold))),
        adjustedMean: round(mean(rows.map((row) => row.exact.adjusted)))
      };
    });
    const candidateDeltas = blocks.map((block) => block.exact.candidateVsParent);
    const placeboDeltas = blocks.map((block) => block.exact.shamVsCold);
    const adjustedDeltas = blocks.map((block) => block.exact.adjusted);
    const taskAdjusted = taskGroups.map((task) => task.adjustedMean);
    const summary = {
      blockCount: blocks.length,
      taskCount: taskGroups.length,
      replicatesPerTask: taskGroups.every((task) => task.blocks === taskGroups[0].blocks)
        ? taskGroups[0].blocks
        : null,
      arms: Object.fromEntries(ARMS.map((arm) => [arm, summarizeArm(blocks, arm)])),
      candidateVsParent: confidence(candidateDeltas),
      shamVsCold: confidence(placeboDeltas),
      adjusted: confidence(adjustedDeltas),
      adjustedBlockSignTest: signTest(adjustedDeltas),
      adjustedTaskSignTest: signTest(taskAdjusted),
      targetRegressions: blocks.reduce((sum, block) => sum + block.targetRegressions, 0),
      controlRegressions: blocks.reduce((sum, block) => sum + block.controlRegressions, 0),
      tokenCost: {
        candidateVsParentRelative: blocks.reduce((sum, block) => (
          sum + block.arms.parent.tokenCost
        ), 0) > 0
          ? round((
              blocks.reduce((sum, block) => sum + block.arms.candidate.tokenCost, 0)
              - blocks.reduce((sum, block) => sum + block.arms.parent.tokenCost, 0)
            ) / blocks.reduce((sum, block) => sum + block.arms.parent.tokenCost, 0))
          : null
      },
      taskEffects: taskGroups,
      blockEvidenceSha256: sha256(canonicalRecursiveAnalysisJson(blocks.map((block) => ({
        taskId: block.taskId,
        replicate: block.replicate,
        exact: Object.fromEntries(Object.entries(block.exact).map(([key, value]) => [key, round(value)])),
        targetRegressions: block.targetRegressions,
        controlRegressions: block.controlRegressions,
        armEvidence: Object.fromEntries(ARMS.map((arm) => [arm, {
          resultSha256: sha256(canonicalRecursiveAnalysisJson(block.arms[arm].results)),
          tokenCost: block.arms[arm].tokenCost
        }]))
      }))))
    };
    return { status: 'OK', summary };
  } catch (error) {
    return {
      status: 'REFUSED',
      code: 'REPLICATED_STAGE_INVALID',
      message: error.message
    };
  }
}

function stageGates(summary, threshold) {
  const candidate = summary.arms.candidate;
  const parent = summary.arms.parent;
  const taskSign = summary.adjustedTaskSignTest;
  const blockSign = summary.adjustedBlockSignTest;
  return {
    completeDesign: summary.taskCount === 5
      && summary.replicatesPerTask === 3
      && summary.blockCount === 15,
    candidateBeatsParent: candidate.exact > parent.exact,
    candidateLowerBoundExceedsNoise:
      summary.candidateVsParent.lower95 > threshold,
    adjustedBlockSignificant:
      blockSign.wins > blockSign.losses && blockSign.pOneSided <= 0.05,
    allTasksDirectionallyPositive:
      taskSign.wins === 5 && taskSign.losses === 0 && taskSign.ties === 0,
    noTargetRegressions: summary.targetRegressions === 0,
    noControlRegressions: summary.controlRegressions === 0,
    boundedCandidateCost:
      summary.tokenCost.candidateVsParentRelative != null
      && summary.tokenCost.candidateVsParentRelative <= 0.25
  };
}

export function buildRecursivePlaceboCalibration(blocks = []) {
  const summarized = summarizeRecursiveReplicatedStage(blocks);
  if (summarized.status !== 'OK') return summarized;
  const summary = summarized.summary;
  const placeboUpper95 = Math.max(0, summary.shamVsCold.upper95);
  const gates = stageGates(summary, placeboUpper95);
  const qualified = Object.values(gates).every(Boolean);
  const payload = {
    schemaVersion: RECURSIVE_REPLICATED_ANALYSIS_SCHEMA,
    stage: 'calibration',
    calibrationRule: RECURSIVE_PLACEBO_CALIBRATION_RULE,
    placeboUpper95: round(placeboUpper95),
    summary,
    gates,
    qualified
  };
  return {
    status: 'OK',
    record: {
      ...payload,
      analysisSha256: sha256(canonicalRecursiveAnalysisJson(payload))
    }
  };
}

export function buildRecursiveUntouchedConfirmation({ calibration, blocks } = {}) {
  if (!plainObject(calibration)
      || calibration.schemaVersion !== RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
      || calibration.stage !== 'calibration'
      || calibration.calibrationRule !== RECURSIVE_PLACEBO_CALIBRATION_RULE
      || calibration.qualified !== true
      || !SHA256_RE.test(String(calibration.analysisSha256 || ''))) {
    return { status: 'REFUSED', code: 'CALIBRATION_NOT_QUALIFIED' };
  }
  const summarized = summarizeRecursiveReplicatedStage(blocks);
  if (summarized.status !== 'OK') return summarized;
  const threshold = calibration.placeboUpper95;
  const gates = stageGates(summarized.summary, threshold);
  const causalPass = Object.values(gates).every(Boolean);
  const payload = {
    schemaVersion: RECURSIVE_REPLICATED_ANALYSIS_SCHEMA,
    stage: 'confirmation',
    confirmationRule: RECURSIVE_CONFIRMATION_RULE,
    calibrationAnalysisSha256: calibration.analysisSha256,
    frozenNoiseThreshold: threshold,
    summary: summarized.summary,
    gates,
    causalPass
  };
  return {
    status: 'OK',
    record: {
      ...payload,
      analysisSha256: sha256(canonicalRecursiveAnalysisJson(payload))
    }
  };
}

export function validateRecursiveReplicatedAnalysis(record) {
  if (!plainObject(record)
      || record.schemaVersion !== RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
      || !['calibration', 'confirmation'].includes(record.stage)
      || !SHA256_RE.test(String(record.analysisSha256 || ''))) {
    return { status: 'REFUSED', code: 'REPLICATED_ANALYSIS_SCHEMA' };
  }
  const payload = structuredClone(record);
  delete payload.analysisSha256;
  return sha256(canonicalRecursiveAnalysisJson(payload)) === record.analysisSha256
    ? { status: 'OK', record: structuredClone(record) }
    : { status: 'REFUSED', code: 'REPLICATED_ANALYSIS_HASH_MISMATCH' };
}
