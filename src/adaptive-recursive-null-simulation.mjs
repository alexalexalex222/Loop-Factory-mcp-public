import {
  buildRecursivePlaceboCalibration,
  buildRecursiveUntouchedConfirmation,
  canonicalRecursiveAnalysisJson
} from './adaptive-recursive-statistics.mjs';
import { sha256 } from './util.mjs';

export const RECURSIVE_ADAPTIVE_NULL_SIMULATION_SCHEMA =
  'adaptive-recursive-null-simulation-v1';

function round(value, places = 8) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function seededBits(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state & 1) === 1;
  };
}

function results(exact) {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `case-${String(index + 1).padStart(2, '0')}`,
    group: index < 9 ? 'target' : 'control',
    pass: index < exact,
    decisionPass: index < exact,
    codePass: index < exact
  }));
}

function nullBlocks(signs) {
  return signs.flatMap((positive, taskIndex) => (
    Array.from({ length: 3 }, (_, replicate) => ({
      taskId: `task-${taskIndex + 1}`,
      replicate,
      arms: {
        candidate: { results: results(positive ? 7 : 5), tokenCost: 900 },
        cold: { results: results(6), tokenCost: 950 },
        parent: { results: results(6), tokenCost: 950 },
        sham: { results: results(6), tokenCost: 950 }
      }
    }))
  ));
}

function wilsonUpper95(successes, trials) {
  if (!trials) return 1;
  const z = 1.96;
  const rate = successes / trials;
  const denominator = 1 + ((z ** 2) / trials);
  const center = rate + ((z ** 2) / (2 * trials));
  const radius = z * Math.sqrt(
    (rate * (1 - rate) / trials) + ((z ** 2) / (4 * (trials ** 2)))
  );
  return round((center + radius) / denominator);
}

function simulationCore({
  seed,
  campaigns,
  maximumGenerations,
  familywiseAlpha,
  campaignsWithAdmission,
  campaignsWithDevelopmentAdvance,
  ordinaryChildPasses,
  maximumDevelopmentDepth
}) {
  const perGenerationAlpha = familywiseAlpha / maximumGenerations;
  const familywiseAdmissionReachable = perGenerationAlpha >= 0.03125;
  const familywiseErrorRate = campaignsWithAdmission / campaigns;
  const familywiseUpper95 = wilsonUpper95(campaignsWithAdmission, campaigns);
  const selectionExercised = ordinaryChildPasses > 0
    && campaignsWithDevelopmentAdvance > 0
    && (maximumGenerations === 1 || maximumDevelopmentDepth >= 2);
  const gates = {
    familywiseRateAtOrBelowAlpha: familywiseErrorRate <= familywiseAlpha,
    familywiseUpper95AtOrBelowAlpha: familywiseUpper95 <= familywiseAlpha,
    repeatedSelectionObserved: maximumGenerations === 1 || selectionExercised,
    admissionRuleReachable: familywiseAdmissionReachable
  };
  return {
    schemaVersion: RECURSIVE_ADAPTIVE_NULL_SIMULATION_SCHEMA,
    seed,
    campaigns,
    maximumGenerations,
    statisticalAuthority: {
      familywiseAlpha,
      perGenerationAlpha,
      method: 'bonferroni-over-maximum-generations',
      minimumAttainableTaskSignP: 0.03125,
      familywiseAdmissionReachable
    },
    nullModel: {
      kind: 'sharp-exchangeable-task-signs',
      disjointTaskPoolsPerGeneration: true,
      taskClustersPerStage: 5,
      replicatesPerTask: 3,
      arms: ['candidate', 'cold', 'parent', 'sham'],
      adaptiveRule: 'ordinary-causal-pass-advances-development-parent',
      admissionRule: 'ordinary-causal-pass-and-bonferroni-threshold'
    },
    outcomes: {
      campaignsWithAdmission,
      familywiseErrorRate: round(familywiseErrorRate),
      familywiseUpper95,
      campaignsWithDevelopmentAdvance,
      ordinaryChildPasses,
      maximumDevelopmentDepth,
      selectionExercised
    },
    gates,
    calibrated: Object.values(gates).every(Boolean),
    scientificVerdict: familywiseAdmissionReachable
      ? (Object.values(gates).every(Boolean) ? 'CALIBRATED' : 'NOT_CALIBRATED')
      : 'ADMISSION_RULE_UNREACHABLE'
  };
}

export function simulateRecursiveAdaptiveNull({
  seed = 'loop-factory-recursive-null-v1',
  campaigns = 2048,
  maximumGenerations = 5,
  familywiseAlpha = 0.05
} = {}) {
  if (typeof seed !== 'string' || !seed
      || !Number.isInteger(campaigns) || campaigns < 128 || campaigns > 100_000
      || !Number.isInteger(maximumGenerations)
      || maximumGenerations < 1 || maximumGenerations > 50
      || !Number.isFinite(familywiseAlpha)
      || familywiseAlpha <= 0 || familywiseAlpha >= 1) {
    return { status: 'REFUSED', code: 'RECURSIVE_NULL_SIMULATION_INPUT_INVALID' };
  }
  const nextBit = seededBits(seed);
  const perGenerationAlpha = familywiseAlpha / maximumGenerations;
  let campaignsWithAdmission = 0;
  let campaignsWithDevelopmentAdvance = 0;
  let ordinaryChildPasses = 0;
  let maximumDevelopmentDepth = 0;

  for (let campaign = 0; campaign < campaigns; campaign += 1) {
    let admitted = false;
    let developmentDepth = 0;
    for (let generation = 0; generation < maximumGenerations; generation += 1) {
      const calibrationSigns = Array.from({ length: 5 }, () => nextBit());
      const calibration = buildRecursivePlaceboCalibration(
        nullBlocks(calibrationSigns)
      );
      if (calibration.status !== 'OK') {
        return { status: 'REFUSED', code: 'RECURSIVE_NULL_CALIBRATION_FAILED' };
      }
      if (!calibration.record.qualified) continue;
      const confirmationSigns = Array.from({ length: 5 }, () => nextBit());
      const confirmation = buildRecursiveUntouchedConfirmation({
        calibration: calibration.record,
        blocks: nullBlocks(confirmationSigns)
      });
      if (confirmation.status !== 'OK') {
        return { status: 'REFUSED', code: 'RECURSIVE_NULL_CONFIRMATION_FAILED' };
      }
      const childCausalPass = confirmation.record.causalPass === true;
      if (!childCausalPass) continue;
      ordinaryChildPasses += 1;
      developmentDepth += 1;
      const taskP = confirmation.record.summary.adjustedTaskSignTest.pOneSided;
      if (taskP <= perGenerationAlpha) admitted = true;
    }
    if (developmentDepth > 0) campaignsWithDevelopmentAdvance += 1;
    if (admitted) campaignsWithAdmission += 1;
    maximumDevelopmentDepth = Math.max(maximumDevelopmentDepth, developmentDepth);
  }

  const payload = simulationCore({
    seed,
    campaigns,
    maximumGenerations,
    familywiseAlpha,
    campaignsWithAdmission,
    campaignsWithDevelopmentAdvance,
    ordinaryChildPasses,
    maximumDevelopmentDepth
  });
  const record = {
    ...payload,
    simulationSha256: sha256(canonicalRecursiveAnalysisJson(payload))
  };
  return { status: 'OK', record };
}

export function validateRecursiveAdaptiveNullSimulation(record) {
  if (!record || record.schemaVersion !== RECURSIVE_ADAPTIVE_NULL_SIMULATION_SCHEMA
      || !/^[a-f0-9]{64}$/.test(String(record.simulationSha256 || ''))) {
    return { status: 'REFUSED', code: 'RECURSIVE_NULL_SIMULATION_SCHEMA' };
  }
  const payload = structuredClone(record);
  delete payload.simulationSha256;
  return record.simulationSha256
      === sha256(canonicalRecursiveAnalysisJson(payload))
    ? { status: 'OK', record: structuredClone(record) }
    : { status: 'REFUSED', code: 'RECURSIVE_NULL_SIMULATION_HASH_MISMATCH' };
}
