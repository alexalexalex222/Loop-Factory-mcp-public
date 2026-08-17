import { resolve } from 'node:path';
import { persistAdaptiveCanaryImport } from './mechanism-catalog.mjs';

function summary(persisted) {
  return {
    status: 'OK',
    activation: persisted.record.authority.activation,
    familyId: persisted.family.familyId,
    familySha256: persisted.family.familySha256,
    applicationReceiptId: persisted.record.applicationReceiptId,
    applicationSha256: persisted.record.applicationSha256,
    verifierEvidenceSha256: persisted.record.evidence.verifierEvidenceSha256,
    measurementId: persisted.measurementV2.measurementId,
    measurementSha256: persisted.measurementV2.measurementSha256,
    exactCaseDelta: persisted.measurementV2
      .contrasts.treatmentVsBaseline.metrics.exact.delta,
    decisionDelta: persisted.measurementV2
      .contrasts.treatmentVsBaseline.metrics.decision.delta,
    qualityDelta: persisted.record.outcome.qualityDelta,
    tokenCostDeltaPct: persisted.record.outcome.tokenCostDeltaPct,
    familyIdempotent: persisted.familyPersisted.idempotent,
    measurementIdempotent: persisted.measurementPersisted.idempotent,
    importIdempotent: persisted.importPersisted.idempotent
  };
}

export function completeAdaptiveCanaryMemoryImport({
  store,
  homeDir,
  runId,
  config,
  result
} = {}) {
  if (config?.adaptiveMemoryImportEnabled !== true) {
    return {
      status: 'DISABLED',
      code: 'CANARY_MEMORY_IMPORT_NOT_PREDECLARED'
    };
  }
  if (result?.experimentValid !== true) {
    return {
      status: 'NOT_ELIGIBLE',
      code: 'CANARY_EXPERIMENT_INVALID'
    };
  }
  if (result?.causalPass !== true) {
    return {
      status: 'NOT_ELIGIBLE',
      code: 'CANARY_CAUSAL_PASS_ABSENT'
    };
  }
  if (!store || typeof homeDir !== 'string' || !homeDir || typeof runId !== 'string') {
    return {
      status: 'REFUSED',
      code: 'CANARY_MEMORY_IMPORT_INPUT',
      message: 'Automatic memory import requires the persisted source store, destination home, and run ID.'
    };
  }
  const destination = resolve(homeDir);
  const persisted = persistAdaptiveCanaryImport({
    homeDir: destination,
    sourceStore: store,
    runId,
    automatic: true
  });
  if (persisted.status !== 'OK') {
    return {
      status: 'REFUSED',
      code: persisted.code || 'CANARY_MEMORY_IMPORT_FAILED',
      message: persisted.message || 'Verifier-owned canary import was refused.'
    };
  }
  return summary(persisted);
}

export function adaptiveCanaryRunSucceeded({ result, memoryImport } = {}) {
  if (result?.status !== 'OK' || result?.experimentValid !== true) return false;
  if (result.causalPass !== true) return true;
  if (memoryImport?.status === 'DISABLED') return true;
  return memoryImport?.status === 'OK';
}
