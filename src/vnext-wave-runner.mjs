import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ADAPTIVE_RECURSIVE_CANARY_V2,
  ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS,
  prepareAdaptiveRecursiveCanaryV2Config
} from './adaptive-recursive-canary-v2.mjs';
import {
  verifyAdaptiveRecursiveCanaryV2Run
} from './adaptive-recursive-runner-v2.mjs';
import {
  runAdaptiveRecursiveCanaryV2WithLease,
  verifyAdaptiveRecursiveVNextLeaseReceipt
} from './adaptive-recursive-vnext-run.mjs';
import {
  loadCampaignSeriesStore,
  loadCampaignSeriesWaveInputs
} from './campaign-series-store.mjs';
import { canonicalMechanismProgramJson } from './mechanism-compiler.mjs';
import {
  createResourceBudgetLedger,
  verifyResourceBudgetLedger
} from './resource-budget.mjs';
import {
  persistResourceBudgetBreachEvidence,
  persistResourceBudgetCheckpoint,
  verifyResourceBudgetCheckpointHistory
} from './resource-budget-store.mjs';
import { isAbsoluteOnAnyPlatform, isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  createVNextMechanismExecutionBinding
} from './vnext-mechanism-execution.mjs';
import { runVNextModelWorker } from './vnext-model-worker.mjs';
import { prepareVNextCandidate } from './vnext-pipeline.mjs';
import {
  persistVNextPreparationResult,
  verifyVNextPreparationRun
} from './vnext-preparation-store.mjs';
import {
  deriveVNextRecursiveEvidence,
  persistVNextRecursiveEvidence
} from './vnext-recursive-import.mjs';
import { readVNextEvidenceBank } from './vnext-evidence-bank.mjs';
import { createVNextEvidenceAuthorityVerifier } from './vnext-evidence-authority.mjs';
import { listAdaptiveRecords } from './mechanism-catalog.mjs';
import {
  validateVNextTaskMaterialBundle
} from './vnext-task-pack.mjs';
import {
  appendVNextWaveEvent,
  loadVNextWaveJournal,
  VNEXT_WAVE_EVENT
} from './vnext-wave-journal.mjs';
import {
  acquireRunLease,
  releaseRunLease,
  renewRunLease
} from './run-lease.mjs';
import { startRunLeaseHeartbeat } from './run-lease-heartbeat.mjs';
import {
  deriveVNextWaveEvaluatorPolicySha256,
  deriveVNextWaveModelPolicySha256,
  validateVNextWaveConfig,
  vnextPreparationMaximumCalls
} from './vnext-wave-config.mjs';
import { vnextAblationPreparationRoleCalls } from './vnext-ablation-profile.mjs';

export const VNEXT_WAVE_RESULT_SCHEMA = 'loop-factory-vnext-wave-result-v1';
export const VNEXT_WAVE_MATERIALIZATION_SCHEMA =
  'loop-factory-vnext-wave-materialization-v1';

const RESULT_FILE = 'result.json';
const MATERIALIZATION_FILE = 'materialization.json';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const VNEXT_WAVE_IMPLEMENTATION_PATHS = Object.freeze([
  ...new Set([
    ...ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS,
    'src/adaptive-canary-import.mjs',
    'src/adaptive-policy.mjs',
    'src/baseline-integrity.mjs',
    'src/constants.mjs',
    'src/host.mjs',
    'src/loops.mjs',
    'src/mechanism-router.mjs',
    'src/meta-policy.mjs',
    'src/models.mjs',
    'src/real-test.mjs',
    'src/skill-schema.mjs',
    'src/supervisor.mjs',
    'src/campaign-series.mjs',
    'src/campaign-series-store.mjs',
    'src/harness-handbook.mjs',
    'src/hybrid-retrieval.mjs',
    'src/hypothesis-falsifier.mjs',
    'src/isolated-evaluator.mjs',
    'src/research-dossier.mjs',
    'src/task-agent-feedback.mjs',
    'src/vnext-campaign-driver.mjs',
    'src/vnext-campaign-launch-authorization.mjs',
    'src/vnext-failure.mjs',
    'src/vnext-hypothesis.mjs',
    'src/isolated-evaluator.mjs',
    'src/vnext-operator-actions.mjs',
    'src/vnext-operator-control-contract.mjs',
    'src/vnext-operator-control.mjs',
    'src/vnext-research.mjs',
    'src/vnext-task-pack.mjs',
    'src/vnext-task-pack-import.mjs',
    'src/vnext-study-plan.mjs',
    'src/vnext-strategy-state.mjs',
    'src/vnext-ablation-protocol.mjs',
    'src/vnext-wave-config.mjs',
    'src/vnext-wave-journal.mjs',
    'src/vnext-wave-runner.mjs',
    'src/vnext-recursive-import.mjs',
    'src/vnext-recursive-import-transaction.mjs',
    'src/vnext-evidence-bank.mjs',
    'src/vnext-evidence-authority.mjs',
    'src/vnext-evaluator-proof.mjs',
    'src/mechanism-catalog.mjs',
    'src/app-contract.mjs',
    'src/console.mjs',
    'src/dashboard.mjs',
    'scripts/dashboard-server.mjs',
    'scripts/run-vnext-campaign-series.mjs',
    'scripts/stop-vnext-campaign-series.mjs',
    'scripts/verify-vnext-campaign-series.mjs',
    'scripts/plan-vnext-study-wave.mjs',
    'scripts/run-vnext-study-wave.mjs',
    'scripts/verify-vnext-study-wave.mjs',
    'scripts/build-vnext-ablation-protocol.mjs',
    'scripts/build-vnext-ablation-protocol-r6.mjs',
    'scripts/commit-vnext-evaluator-counterbalance.mjs',
    'scripts/plan-vnext-semantic-judge-qualification.mjs',
    'scripts/verify-vnext-ablation-protocol.mjs',
    'package.json',
    'src/schemas/vnext-campaign-series-plan-v1.schema.json',
    'src/schemas/vnext-campaign-series-state-v1.schema.json',
    'src/schemas/vnext-campaign-series-checkpoint-v1.schema.json',
    'src/schemas/vnext-campaign-series-wave-input-v1.schema.json',
    'src/schemas/vnext-campaign-verifier-v1.schema.json',
    'src/schemas/vnext-operator-action-v1.schema.json',
    'src/schemas/vnext-operator-control-v1.schema.json',
    'src/schemas/vnext-resource-budget-ledger-v1.schema.json',
    'src/schemas/vnext-task-pack-v1.schema.json',
    'src/schemas/vnext-study-disclosure-v1.schema.json',
    'src/schemas/vnext-strategy-state-bundle-v1.schema.json',
    'src/schemas/vnext-ablation-protocol-v2.schema.json',
    'src/schemas/vnext-ablation-protocol-v3.schema.json',
    'src/schemas/vnext-wave-config-v1.schema.json',
    'src/schemas/vnext-wave-event-v1.schema.json',
    'src/schemas/vnext-wave-materialization-v1.schema.json',
    'src/schemas/vnext-wave-result-v1.schema.json',
    'src/schemas/vnext-wave-verifier-evidence-v1.schema.json'
  ])
]);

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function validateVNextWaveMaterialization(manifest) {
  if (!exactKeys(manifest, [
    'schemaVersion', 'seriesRunId', 'waveId', 'taskMaterialBundleSha256',
    'entries', 'materializationSha256'
  ])
      || manifest.schemaVersion !== VNEXT_WAVE_MATERIALIZATION_SCHEMA
      || !isSafeId(manifest.seriesRunId)
      || !isSafeId(manifest.waveId)
      || !/^[a-f0-9]{64}$/.test(String(manifest.taskMaterialBundleSha256 || ''))
      || !Array.isArray(manifest.entries)
      || manifest.entries.length < 4
      || manifest.entries.some((entry) => !exactKeys(entry, [
        'taskId', 'kind', 'path', 'contentSha256', 'persistedBytesSha256'
      ])
        || !isSafeId(entry.taskId)
        || !['source', 'incident', 'interface', 'oracle'].includes(entry.kind)
        || typeof entry.path !== 'string'
        || isAbsoluteOnAnyPlatform(entry.path)
        || entry.path.split(/[\\/]/).includes('..')
        || ![entry.contentSha256, entry.persistedBytesSha256]
          .every((value) => /^[a-f0-9]{64}$/.test(String(value || ''))))
      || manifest.materializationSha256
        !== sha256(canonicalVNextJson((({ materializationSha256, ...core }) => core)(manifest)))) {
    return refused(
      'VNEXT_WAVE_MATERIALIZATION_INVALID',
      'Wave materialization failed its closed shape or hash contract.'
    );
  }
  return { status: 'OK', manifest };
}

export function validateVNextWaveResult(receipt) {
  const nullableHashes = [
    'executionBindingSha256', 'experimentPlanSha256',
    'experimentEvidenceSha256', 'leaseEvidenceSha256',
    'importedRecordSha256', 'evidenceLedgerSha256AtImport'
  ];
  if (!exactKeys(receipt, [
    'schemaVersion', 'seriesRunId', 'waveId', 'wavePlanSha256',
    'waveInputEvidenceSha256', 'implementationSha256',
    'materializationSha256', 'disposition', 'taskPartition',
    'preparationDisposition', 'preparationRunId',
    'preparationEvidenceSha256', 'executionBindingSha256',
    'experimentRunId', 'experimentPlanSha256', 'experimentEvidenceSha256',
    'leaseEvidenceSha256', 'importedRecordSha256', 'importedRecordId',
    'evidenceLedgerSha256AtImport', 'catalogMode', 'catalogRecords',
    'causalPass', 'activationEligible', 'promotionAuthorized', 'calls',
    'budgetLedgers', 'recordedAt', 'receiptSha256'
  ])
      || receipt.schemaVersion !== VNEXT_WAVE_RESULT_SCHEMA
      || !isSafeId(receipt.seriesRunId)
      || !isSafeId(receipt.waveId)
      || !isSafeId(receipt.preparationRunId)
      || !isSafeId(receipt.experimentRunId)
      || !['PREPARATION_REJECTED', 'EXPERIMENT_VERIFIED'].includes(receipt.disposition)
      || !['development', 'validation'].includes(receipt.taskPartition)
      || typeof receipt.preparationDisposition !== 'string'
      || ![receipt.wavePlanSha256, receipt.waveInputEvidenceSha256,
        receipt.implementationSha256, receipt.materializationSha256,
        receipt.preparationEvidenceSha256, receipt.receiptSha256]
        .every((value) => /^[a-f0-9]{64}$/.test(String(value || '')))
      || nullableHashes.some((field) => receipt[field] != null
        && !/^[a-f0-9]{64}$/.test(String(receipt[field])))
      || (receipt.importedRecordId != null && !isSafeId(receipt.importedRecordId))
      || (receipt.catalogMode != null
        && !['development-only', 'validation-routing'].includes(receipt.catalogMode))
      || !Array.isArray(receipt.catalogRecords)
      || receipt.catalogRecords.some((record) => !exactKeys(record, [
        'schemaVersion', 'state', 'recordId', 'recordSha256', 'idempotent'
      ])
        || typeof record.schemaVersion !== 'string'
        || !isSafeId(record.recordId)
        || !/^[a-f0-9]{64}$/.test(String(record.recordSha256 || ''))
        || !(record.state == null || typeof record.state === 'string')
        || typeof record.idempotent !== 'boolean')
      || typeof receipt.causalPass !== 'boolean'
      || typeof receipt.activationEligible !== 'boolean'
      || receipt.promotionAuthorized !== false
      || !Number.isSafeInteger(receipt.calls)
      || receipt.calls < 0
      || !Array.isArray(receipt.budgetLedgers)
      || receipt.budgetLedgers.length !== 2
      || receipt.budgetLedgers.some((ledger) => verifyResourceBudgetLedger(ledger).status !== 'OK')
      || !Number.isFinite(Date.parse(receipt.recordedAt))
      || receipt.receiptSha256 !== sha256(canonicalVNextJson(resultPayload(receipt)))) {
    return refused(
      'VNEXT_WAVE_RESULT_INVALID',
      'Wave result failed its closed shape, authority, budget, or hash contract.'
    );
  }
  return { status: 'OK', receipt };
}

export function validateVNextWaveVerifierEvidence(evidence) {
  if (!exactKeys(evidence, [
    'schemaVersion', 'seriesRunId', 'waveId', 'wavePlanSha256',
    'implementationSha256', 'receiptSha256', 'waveJournalSha256',
    'terminalEventSha256', 'preparationEvidenceSha256',
    'experimentEvidenceSha256', 'leaseEvidenceSha256',
    'importedRecordSha256', 'taskPartition', 'importedRecordId',
    'evidenceLedgerSha256AtImport', 'budgetLedgerSha256s', 'disposition',
    'causalPass', 'activationEligible', 'promotionAuthorized'
  ])
      || evidence.schemaVersion !== 'loop-factory-vnext-wave-verifier-evidence-v1'
      || !isSafeId(evidence.seriesRunId)
      || !isSafeId(evidence.waveId)
      || ![evidence.wavePlanSha256, evidence.implementationSha256,
        evidence.receiptSha256, evidence.waveJournalSha256,
        evidence.terminalEventSha256, evidence.preparationEvidenceSha256]
        .every((value) => /^[a-f0-9]{64}$/.test(String(value || '')))
      || ['experimentEvidenceSha256', 'leaseEvidenceSha256',
        'importedRecordSha256', 'evidenceLedgerSha256AtImport']
        .some((field) => evidence[field] != null
          && !/^[a-f0-9]{64}$/.test(String(evidence[field])))
      || !['development', 'validation'].includes(evidence.taskPartition)
      || (evidence.importedRecordId != null && !isSafeId(evidence.importedRecordId))
      || !Array.isArray(evidence.budgetLedgerSha256s)
      || evidence.budgetLedgerSha256s.length !== 2
      || evidence.budgetLedgerSha256s.some((value) => (
        !/^[a-f0-9]{64}$/.test(String(value || ''))
      ))
      || !['PREPARATION_REJECTED', 'EXPERIMENT_VERIFIED'].includes(evidence.disposition)
      || typeof evidence.causalPass !== 'boolean'
      || typeof evidence.activationEligible !== 'boolean'
      || evidence.promotionAuthorized !== false) {
    return refused(
      'VNEXT_WAVE_VERIFIER_EVIDENCE_INVALID',
      'Wave verifier evidence failed its closed authority contract.'
    );
  }
  return { status: 'OK', evidence };
}

function wavePath(waveId, file) {
  return `campaign-series/waves/${waveId}/${file}`;
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function resolveVNextWaveImplementation({ packageRoot = PACKAGE_ROOT } = {}) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const manifest = VNEXT_WAVE_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full) || !existsSync(full) || lstatSync(full).isSymbolicLink()) {
        throw new Error(`VNext wave dependency is missing or unsafe: ${path}`);
      }
      const bytes = readFileSync(full);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    });
    return {
      status: 'OK',
      manifest,
      implementationSha256: sha256(canonicalVNextJson(manifest))
    };
  } catch (error) {
    return refused('VNEXT_WAVE_IMPLEMENTATION_UNRESOLVED', error.message);
  }
}

function immutableWrite(store, runId, path, value) {
  const content = typeof value === 'string'
    ? value
    : `${canonicalVNextJson(value)}\n`;
  const current = store.readRunFile(runId, path);
  if (current != null && current !== content) {
    return refused('VNEXT_WAVE_IMMUTABLE_CONFLICT', `Immutable wave artifact conflicts at ${path}.`);
  }
  if (current == null) store.writeRunFile(runId, path, content);
  return { status: 'OK', path, sha256: sha256(content), idempotent: current != null };
}

function exactPolicyExposure(policy, calls, perCall) {
  const input = calls * perCall.maxInputTokens;
  const output = calls * perCall.maxOutputTokens;
  const usd = Math.ceil((input * policy.inputUsdMicrosPerMillionTokens
    + output * policy.outputUsdMicrosPerMillionTokens) / 1_000_000);
  return policy.maxCalls === calls
    && policy.maxInputTokens === input
    && policy.maxOutputTokens === output
    && policy.maxTotalTokens === input + output
    && policy.maxUsdMicros === usd;
}

function preparationExposure(config) {
  const counts = vnextAblationPreparationRoleCalls(config.ablationProfile, {
    externalResearchEnabled: config.preparation.externalResearchEnabled
  });
  if (counts == null) return null;
  return Object.entries(counts).reduce((sum, [role, calls]) => {
    if (calls === 0) return sum;
    return {
      calls: sum.calls + calls,
      input: sum.input + calls * config.preparation.callBudgets[role].maxInputTokens,
      output: sum.output + calls * config.preparation.callBudgets[role].maxOutputTokens
    };
  }, { calls: 0, input: 0, output: 0 });
}

function preparationPolicyExact(policy, config) {
  const exposure = preparationExposure(config);
  if (exposure == null) return false;
  const usd = Math.ceil((exposure.input * policy.inputUsdMicrosPerMillionTokens
    + exposure.output * policy.outputUsdMicrosPerMillionTokens) / 1_000_000);
  return exposure.calls === vnextPreparationMaximumCalls(config)
    && policy.maxCalls === exposure.calls
    && policy.maxInputTokens === exposure.input
    && policy.maxOutputTokens === exposure.output
    && policy.maxTotalTokens === exposure.input + exposure.output
    && policy.maxUsdMicros === usd;
}

function policiesFor(inputs) {
  const config = inputs.config;
  const byId = new Map(inputs.budgetPolicies.map((policy) => [policy.policyId, policy]));
  const preparation = byId.get(config.preparationBudgetPolicyId);
  const experiment = byId.get(config.experimentBudgetPolicyId);
  if (byId.size !== 2 || !preparation || !experiment
      || !preparationPolicyExact(preparation, config)
      || !exactPolicyExposure(
        experiment,
        ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
        config.recursiveCanary.perCallBudget
      )) {
    return refused(
      'VNEXT_WAVE_BUDGET_EXPOSURE_INVALID',
      'Wave child policies must exactly equal the worst-case preparation and recursive-call exposure.'
    );
  }
  return { status: 'OK', preparation, experiment };
}

function itemId(collection, value) {
  if (collection === 'selectors') return value.selectorId;
  if (collection === 'bindings') return value.bindingId;
  if (collection === 'metrics') return value.metricId;
  if (collection === 'rules') return value.ruleId;
  return sha256(canonicalMechanismProgramJson(value)).slice(0, 24);
}

export function mechanismProgramParentItems(program) {
  const rows = [{
    target: 'mechanism-program/fallback',
    component: 'mechanism-program',
    sha256: sha256(canonicalMechanismProgramJson(program.fallback))
  }];
  for (const collection of [
    'bindings', 'forbiddenBindings', 'metrics', 'rules', 'selectors'
  ]) {
    const targetCollection = collection.toLowerCase();
    for (const item of program[collection] || []) {
      rows.push({
        target: `mechanism-program/${targetCollection}/${itemId(collection, item)}`,
        component: 'mechanism-program',
        sha256: sha256(canonicalMechanismProgramJson(item))
      });
    }
  }
  return rows.sort((left, right) => left.target.localeCompare(right.target));
}

function materializeTaskBundle({ store, seriesRunId, waveId, inputs }) {
  const checked = validateVNextTaskMaterialBundle({
    bundle: inputs.taskMaterialBundle,
    pack: inputs.taskPack
  });
  if (checked.status !== 'OK') return checked;
  const entries = [];
  const tasks = [];
  for (const material of inputs.taskMaterialBundle.materials) {
    const base = wavePath(waveId, `execution-materials/${material.taskId}`);
    const bindings = {};
    for (const [name, fileName] of Object.entries({
      source: 'candidate.mjs',
      incident: 'incident.md',
      interface: 'interface.json',
      oracle: 'oracle.json'
    })) {
      const path = `${base}/${fileName}`;
      const written = immutableWrite(store, seriesRunId, path, material[name].content);
      if (written.status !== 'OK') return written;
      bindings[name] = {
        path,
        sha256: name === 'interface'
          ? sha256(canonicalVNextJson(material.interfaceContract))
          : material[name].sha256
      };
      entries.push({
        taskId: material.taskId,
        kind: name,
        path,
        contentSha256: material[name].sha256,
        persistedBytesSha256: written.sha256
      });
    }
    tasks.push({
      id: material.taskId,
      source: bindings.source,
      incident: bindings.incident,
      interface: bindings.interface,
      oracle: bindings.oracle,
      interfaceContract: material.interfaceContract
    });
  }
  entries.sort((left, right) => (
    left.taskId.localeCompare(right.taskId) || left.kind.localeCompare(right.kind)
  ));
  const core = {
    schemaVersion: VNEXT_WAVE_MATERIALIZATION_SCHEMA,
    seriesRunId,
    waveId,
    taskMaterialBundleSha256: inputs.taskMaterialBundle.bundleSha256,
    entries
  };
  const manifest = {
    ...core,
    materializationSha256: sha256(canonicalVNextJson(core))
  };
  const persisted = immutableWrite(
    store,
    seriesRunId,
    wavePath(waveId, MATERIALIZATION_FILE),
    manifest
  );
  return persisted.status === 'OK'
    ? { status: 'OK', manifest, tasks }
    : persisted;
}

function verifyMaterialization({ store, seriesRunId, waveId, inputs, manifest }) {
  if (!manifest
      || manifest.schemaVersion !== VNEXT_WAVE_MATERIALIZATION_SCHEMA
      || manifest.seriesRunId !== seriesRunId
      || manifest.waveId !== waveId
      || manifest.taskMaterialBundleSha256
        !== inputs.taskMaterialBundle.bundleSha256
      || !Array.isArray(manifest.entries)
      || manifest.entries.length !== inputs.taskMaterialBundle.materials.length * 4) {
    return false;
  }
  const expected = new Map(inputs.taskMaterialBundle.materials.flatMap((material) => (
    Object.entries({
      source: 'candidate.mjs',
      incident: 'incident.md',
      interface: 'interface.json',
      oracle: 'oracle.json'
    }).map(([kind, fileName]) => {
      const path = wavePath(
        waveId,
        `execution-materials/${material.taskId}/${fileName}`
      );
      return [`${material.taskId}:${kind}`, {
        taskId: material.taskId,
        kind,
        path,
        contentSha256: material[kind].sha256
      }];
    })
  )));
  const seen = new Set();
  for (const entry of manifest.entries) {
    const key = `${entry.taskId}:${entry.kind}`;
    const wanted = expected.get(key);
    const content = wanted ? store.readRunFile(seriesRunId, wanted.path) : null;
    if (!wanted || seen.has(key)
        || entry.path !== wanted.path
        || entry.contentSha256 !== wanted.contentSha256
        || typeof content !== 'string'
        || sha256(content) !== entry.contentSha256
        || sha256(content) !== entry.persistedBytesSha256) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}

function splitTasks(config, taskPack, tasks) {
  const packIds = taskPack.tasks.map((task) => task.taskId).sort();
  const configured = [
    ...config.taskSplit.calibrationTaskIds,
    ...config.taskSplit.confirmationTaskIds
  ].sort();
  if (canonicalVNextJson(packIds) !== canonicalVNextJson(configured)
      || tasks.length !== 10) {
    return refused(
      'VNEXT_WAVE_TASK_SPLIT_INVALID',
      'The wave requires exactly ten pack-bound tasks split into disjoint five-task generations.'
    );
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    status: 'OK',
    calibrationTasks: config.taskSplit.calibrationTaskIds.map((id) => byId.get(id)),
    confirmationTasks: config.taskSplit.confirmationTaskIds.map((id) => byId.get(id))
  };
}

function pacePolicy(config, series, descriptor) {
  const outerAlphaAllocation = {
    allocationId: `allocation-${sha256(`${series.plan.planSha256}:${descriptor.waveSha256}`).slice(0, 24)}`,
    alpha: descriptor.alpha,
    familyAlpha: series.plan.familywiseAlpha,
    policySha256: series.plan.planSha256
  };
  const core = {
    schemaVersion: 'vnext-pace-canary-policy-v1',
    outerAlphaAllocation,
    lambdaPolicy: config.pace.lambdaPolicy,
    maximumShamMovement: config.pace.maximumShamMovement,
    maximumRelativeTokenIncrease: config.pace.maximumRelativeTokenIncrease,
    ordering: 'policy-hash-task-id-v1'
  };
  return { ...core, policySha256: sha256(canonicalVNextJson(core)) };
}

function currentDescriptor(series, waveId) {
  const candidates = [
    series.state.currentWave?.descriptor,
    ...series.state.queue,
    ...series.state.completedWaves
  ].filter(Boolean);
  return candidates.find((wave) => wave.waveId === waveId) ?? null;
}

function resultPayload(receipt) {
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  return core;
}

function persistResult(store, seriesRunId, waveId, core) {
  const receipt = {
    ...core,
    receiptSha256: sha256(canonicalVNextJson(core))
  };
  const written = immutableWrite(
    store,
    seriesRunId,
    wavePath(waveId, RESULT_FILE),
    receipt
  );
  return written.status === 'OK'
    ? { status: 'OK', receipt }
    : written;
}

function emptyLedger(policy, runId, createdAt) {
  return createResourceBudgetLedger({ policy, runId, createdAt });
}

function preparationInput(
  config,
  inputs,
  ledger,
  invokeModel,
  onWorkerCompleted,
  onBudgetLedgerChanged,
  evidenceAuthorityVerifier,
  externalResearchStateRoot
) {
  const p = config.preparation;
  const program = config.mechanism.parentFamily.causalFingerprint.program;
  return {
    pipelineId: config.preparationRunId,
    createdAt: config.createdAt,
    ablationProfile: config.ablationProfile,
    failure: p.failure,
    evidenceRecords: p.evidenceRecords,
    behaviorMap: p.behaviorMap,
    targetBehaviorIds: p.targetBehaviorIds,
    feedbackArtifacts: p.feedbackArtifacts,
    architectureFacts: p.architectureFacts,
    architectureConstraints: p.architectureConstraints,
    publicMeasurementContract: p.publicMeasurementContract,
    compatibility: p.compatibility,
    embeddings: p.embeddings,
    queryEmbedding: p.queryEmbedding,
    maximumCandidates: p.maximumCandidates,
    maximumSelected: p.maximumSelected,
    exploreUncertainty: p.exploreUncertainty,
    enableModelReranker: p.enableModelReranker,
    externalResearchEnabled: p.externalResearchEnabled,
    sealedMode: p.sealedMode,
    externalSources: p.externalSources,
    externalSourceAllowlist: p.externalSourceAllowlist,
    externalResearchPolicy: p.externalResearchPolicy ?? null,
    externalResearchStateRoot,
    dossierMaximumItems: p.dossierMaximumItems,
    dossierMaximumBytes: p.dossierMaximumBytes,
    parentArtifactSha256: sha256(canonicalVNextJson(program)),
    parentArtifact: program,
    parentItemHashes: mechanismProgramParentItems(program),
    protectedSurfaces: p.protectedSurfaces,
    maxOperations: p.maxOperations,
    candidateStrategy: p.candidateStrategy,
    candidateFeatureFlags: p.candidateFeatureFlags,
    candidateStrategyState: p.candidateStrategyState,
    requiredComponent: 'mechanism-program',
    modelPolicy: p.modelPolicy,
    callBudgets: p.callBudgets,
    resourceBudgetLedger: ledger,
    requireProductionWorkerEvidence: true,
    evidenceAuthorityVerifier,
    onWorkerCompleted,
    onBudgetLedgerChanged,
    invokeModel
  };
}

export function planVNextCampaignWave({ store, seriesRunId, waveId } = {}) {
  const series = loadCampaignSeriesStore({ store, runId: seriesRunId });
  const inputs = loadCampaignSeriesWaveInputs({ store, runId: seriesRunId, waveId });
  if (series.status !== 'OK' || inputs.status !== 'OK') {
    return refused('VNEXT_WAVE_INPUT_REPLAY_FAILED', 'Series or wave inputs failed cold replay.', { series, inputs });
  }
  if (validateVNextWaveConfig(inputs.config).status !== 'OK'
      || inputs.config.waveId !== waveId
      || inputs.manifest.configSha256 !== sha256(canonicalVNextJson(inputs.config))) {
    return refused('VNEXT_WAVE_CONFIG_REPLAY_FAILED', 'The persisted wave config is invalid or bound to another wave.');
  }
  const descriptor = currentDescriptor(series, waveId);
  const policies = policiesFor(inputs);
  const implementation = resolveVNextWaveImplementation();
  if (!descriptor
      || descriptor.taskPackSha256 !== inputs.taskPack.packSha256
      || descriptor.configSha256 !== inputs.manifest.configSha256
      || descriptor.budgetPolicySetSha256 !== inputs.manifest.budgetPolicySetSha256
      || series.plan.modelPolicySha256 !== deriveVNextWaveModelPolicySha256(inputs.config)
      || series.plan.evaluatorPolicySha256 !== deriveVNextWaveEvaluatorPolicySha256(inputs.config)
      || canonicalVNextJson(inputs.config.evaluatorAuthority)
        !== canonicalVNextJson(inputs.taskPack.evaluatorAuthority)
      || policies.status !== 'OK'
      || implementation.status !== 'OK'
      || implementation.implementationSha256 !== series.plan.implementationSha256) {
    return refused('VNEXT_WAVE_DESCRIPTOR_MISMATCH', 'The queued descriptor does not bind the replayed task, config, and budgets.', { policies });
  }
  return {
    status: 'OK',
    series,
    inputs,
    descriptor,
    policies,
    implementation,
    exposure: {
      preparationCalls: policies.preparation.maxCalls,
      recursiveCalls: policies.experiment.maxCalls,
      maximumCalls: policies.preparation.maxCalls + policies.experiment.maxCalls,
      maximumInputTokens: policies.preparation.maxInputTokens + policies.experiment.maxInputTokens,
      maximumOutputTokens: policies.preparation.maxOutputTokens + policies.experiment.maxOutputTokens,
      maximumTotalTokens: policies.preparation.maxTotalTokens + policies.experiment.maxTotalTokens,
      maximumUsdMicros: policies.preparation.maxUsdMicros + policies.experiment.maxUsdMicros
    },
    planSha256: sha256(canonicalVNextJson({
      seriesPlanSha256: series.plan.planSha256,
      waveSha256: descriptor.waveSha256,
      waveInputEvidenceSha256: inputs.evidenceSha256,
      implementationSha256: implementation.implementationSha256,
      preparationPolicySha256: policies.preparation.policySha256,
      experimentPolicySha256: policies.experiment.policySha256
    }))
  };
}

async function runVNextCampaignWaveLocked({
  store,
  seriesRunId,
  waveId,
  shouldStop = () => false,
  onProgress = () => {}
} = {}) {
  const planned = planVNextCampaignWave({ store, seriesRunId, waveId });
  if (planned.status !== 'OK') return planned;
  const { inputs, series, descriptor, policies } = planned;
  const config = inputs.config;
  let journal = loadVNextWaveJournal({ store, seriesRunId, waveId });
  if (journal.status !== 'OK') return journal;
  const emit = (type, detail) => {
    const appended = appendVNextWaveEvent({
      store,
      seriesRunId,
      waveId,
      type,
      at: new Date().toISOString(),
      detail
    });
    if (appended.status === 'OK') {
      journal = loadVNextWaveJournal({ store, seriesRunId, waveId });
    }
    return appended;
  };
  const block = (code, message, extra = {}) => {
    if (journal.latest?.type !== VNEXT_WAVE_EVENT.BLOCKED) {
      const recorded = emit(VNEXT_WAVE_EVENT.BLOCKED, { code, message });
      if (recorded.status !== 'OK') return recorded;
    }
    return refused(code, message, extra);
  };
  if (journal.events.length === 0) {
    const started = emit(VNEXT_WAVE_EVENT.STARTED, {
      wavePlanSha256: planned.planSha256,
      waveInputEvidenceSha256: inputs.evidenceSha256
    });
    if (started.status !== 'OK') return started;
  }
  if (journal.latest?.type === VNEXT_WAVE_EVENT.BLOCKED) {
    return refused(
      'VNEXT_WAVE_PREVIOUSLY_BLOCKED',
      'A blocked wave cannot be retried; its journal is preserved.'
    );
  }
  if (store.readRunFile(seriesRunId, wavePath(waveId, RESULT_FILE)) != null) {
    if (journal.latest?.type === VNEXT_WAVE_EVENT.IMPORT_PERSISTED
        || journal.latest?.type === VNEXT_WAVE_EVENT.PREPARATION_REJECTED) {
      const rawReceipt = store.readRunFile(seriesRunId, wavePath(waveId, RESULT_FILE));
      let receipt;
      try { receipt = JSON.parse(rawReceipt); } catch { receipt = null; }
      const completed = receipt ? emit(VNEXT_WAVE_EVENT.RESULT_PERSISTED, {
        receiptSha256: receipt.receiptSha256
      }) : refused('VNEXT_WAVE_RESULT_JSON_INVALID', 'Existing result is not valid JSON.');
      if (completed.status !== 'OK') return completed;
    }
    if (journal.latest?.type !== VNEXT_WAVE_EVENT.RESULT_PERSISTED) {
      return refused(
        'VNEXT_WAVE_RESULT_PHASE_INVALID',
        'An existing result is not bound to a terminal journal event.'
      );
    }
    const verified = verifyVNextCampaignWave({ store, seriesRunId, waveId });
    return verified.status === 'OK'
      ? { ...verified, idempotent: true }
      : refused('VNEXT_WAVE_RESULT_ALREADY_INVALID', 'An existing wave result failed replay.');
  }
  const materialized = materializeTaskBundle({ store, seriesRunId, waveId, inputs });
  if (materialized.status !== 'OK') return materialized;
  const split = splitTasks(config, inputs.taskPack, materialized.tasks);
  if (split.status !== 'OK') return split;

  const prepLedger = emptyLedger(
    policies.preparation,
    config.preparationRunId,
    config.createdAt
  );
  const unusedExperimentLedger = emptyLedger(
    policies.experiment,
    config.experimentRunId,
    config.createdAt
  );
  if (prepLedger.status !== 'OK' || unusedExperimentLedger.status !== 'OK') {
    return refused('VNEXT_WAVE_LEDGER_INIT_FAILED', 'Child resource ledgers could not be initialized.');
  }
  const stateRoot = join(store.runDir(seriesRunId), 'campaign-series', 'waves', waveId, 'model-workers');
  const externalResearchStateRoot = join(
    store.runDir(seriesRunId),
    'campaign-series',
    'waves',
    waveId,
    'external-research'
  );
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(externalResearchStateRoot, { recursive: true, mode: 0o700 });
  const preparationBudgetRoot = wavePath(
    waveId,
    'budget-checkpoints/preparation'
  );
  const checkpointPreparationBudget = ({ kind, callId, ledger, settlement }) => {
    const persisted = kind === 'breach'
      ? persistResourceBudgetBreachEvidence({
          store,
          runId: seriesRunId,
          checkpointRoot: preparationBudgetRoot,
          callId,
          ledger,
          settlement,
          recordedAt: new Date().toISOString()
        })
      : persistResourceBudgetCheckpoint({
          store,
          runId: seriesRunId,
          checkpointRoot: preparationBudgetRoot,
          kind,
          callId,
          ledger,
          recordedAt: new Date().toISOString()
        });
    if (persisted.status === 'OK') onProgress();
    return persisted;
  };
  const invokeModel = ({ role, ...workerInput }) => (
    runVNextModelWorker({ ...workerInput, stateRoot })
  );
  const evidenceAuthority = createVNextEvidenceAuthorityVerifier({
    sourceStore: store,
    homeDir: store.homeDir
  });
  if (evidenceAuthority.status !== 'OK') return evidenceAuthority;
  let preparationVerification;
  if (journal.latest?.type === VNEXT_WAVE_EVENT.STARTED) {
    const dispatched = emit(VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED, {
      preparationRunId: config.preparationRunId,
      budgetPolicySha256: policies.preparation.policySha256
    });
    if (dispatched.status !== 'OK') return dispatched;
    const preparedCandidate = await prepareVNextCandidate(
      preparationInput(
        config,
        inputs,
        prepLedger.ledger,
        invokeModel,
        onProgress,
        checkpointPreparationBudget,
        evidenceAuthority.verifier,
        externalResearchStateRoot
      )
    );
    if (preparedCandidate.status !== 'OK') {
      return block(
        preparedCandidate.code || 'VNEXT_WAVE_PREPARATION_FAILED',
        preparedCandidate.message || 'Candidate preparation failed.',
        { preparation: preparedCandidate }
      );
    }
    const persistedPreparation = persistVNextPreparationResult(
      store,
      preparedCandidate,
      { runId: config.preparationRunId, requireProduction: true }
    );
    if (persistedPreparation.status !== 'OK') {
      return block(
        persistedPreparation.code || 'VNEXT_PREPARATION_PERSIST_FAILED',
        persistedPreparation.message || 'Preparation proof could not be persisted.'
      );
    }
    preparationVerification = verifyVNextPreparationRun(
      store,
      config.preparationRunId
    );
    if (preparationVerification.status !== 'OK') {
      return block(
        preparationVerification.code || 'VNEXT_PREPARATION_VERIFY_FAILED',
        preparationVerification.message || 'Preparation proof failed replay.'
      );
    }
    const persisted = emit(VNEXT_WAVE_EVENT.PREPARATION_PERSISTED, {
      preparationRunId: config.preparationRunId,
      preparationEvidenceSha256: preparationVerification.evidenceSha256
    });
    if (persisted.status !== 'OK') return persisted;
  } else {
    preparationVerification = verifyVNextPreparationRun(
      store,
      config.preparationRunId
    );
    if (journal.latest?.type === VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED) {
      if (preparationVerification.status !== 'OK') {
        const budgetHistory = verifyResourceBudgetCheckpointHistory({
          store,
          runId: seriesRunId,
          checkpointRoot: preparationBudgetRoot
        });
        return block(
          'VNEXT_WAVE_AMBIGUOUS_PREPARATION_DISPATCH',
          'Preparation was dispatched without a complete replayable proof; it will not be retried.',
          {
            budgetCheckpointStatus: budgetHistory.status,
            unresolvedBudgetReservations:
              budgetHistory.unresolvedReservations?.length ?? 0
          }
        );
      }
      const recovered = emit(VNEXT_WAVE_EVENT.PREPARATION_PERSISTED, {
        preparationRunId: config.preparationRunId,
        preparationEvidenceSha256: preparationVerification.evidenceSha256
      });
      if (recovered.status !== 'OK') return recovered;
    } else if (preparationVerification.status !== 'OK') {
      return block(
        'VNEXT_WAVE_PREPARATION_PROOF_MISSING',
        'The journal advanced beyond preparation, but its proof no longer replays.'
      );
    }
  }
  const preparation = preparationVerification.result;
  const preparationBudgetHistory = verifyResourceBudgetCheckpointHistory({
    store,
    runId: seriesRunId,
    checkpointRoot: preparationBudgetRoot
  });
  const preparationBudgetEntries = preparation.resourceBudgetLedger?.entries?.length ?? -1;
  if ((preparationBudgetEntries === 0
        && preparationBudgetHistory.code !== 'RESOURCE_BUDGET_CHECKPOINT_HISTORY_MISSING')
      || (preparationBudgetEntries > 0
        && (preparationBudgetHistory.status !== 'OK'
          || preparationBudgetHistory.ledger.ledgerSha256
            !== preparation.resourceBudgetLedger.ledgerSha256
          || preparationBudgetHistory.unresolvedReservations.length !== 0))) {
    return block(
      'VNEXT_WAVE_PREPARATION_BUDGET_CHECKPOINT_INVALID',
      'Preparation budget reservations and settlements did not replay from per-call checkpoints.'
    );
  }

  if (preparation.disposition !== 'CANDIDATE_READY_FOR_EXPERIMENT') {
    if (journal.latest?.type === VNEXT_WAVE_EVENT.PREPARATION_PERSISTED) {
      const rejected = emit(VNEXT_WAVE_EVENT.PREPARATION_REJECTED, {
        disposition: preparation.disposition,
        preparationEvidenceSha256: preparationVerification.evidenceSha256
      });
      if (rejected.status !== 'OK') return rejected;
    }
    if (journal.latest?.type !== VNEXT_WAVE_EVENT.PREPARATION_REJECTED) {
      return block(
        'VNEXT_WAVE_REJECTION_PHASE_INVALID',
        'Preparation is non-executable but the journal advanced into an experiment phase.'
      );
    }
    const stored = persistResult(store, seriesRunId, waveId, {
      schemaVersion: VNEXT_WAVE_RESULT_SCHEMA,
      seriesRunId,
      waveId,
      wavePlanSha256: planned.planSha256,
      waveInputEvidenceSha256: inputs.evidenceSha256,
      implementationSha256: planned.implementation.implementationSha256,
      materializationSha256: materialized.manifest.materializationSha256,
      disposition: 'PREPARATION_REJECTED',
      taskPartition: inputs.taskPack.partition,
      preparationDisposition: preparation.disposition,
      preparationRunId: config.preparationRunId,
      preparationEvidenceSha256: preparationVerification.evidenceSha256,
      executionBindingSha256: null,
      experimentRunId: config.experimentRunId,
      experimentPlanSha256: null,
      experimentEvidenceSha256: null,
      leaseEvidenceSha256: null,
      importedRecordSha256: null,
      importedRecordId: null,
      evidenceLedgerSha256AtImport: null,
      catalogMode: null,
      catalogRecords: [],
      causalPass: false,
      activationEligible: false,
      promotionAuthorized: false,
      calls: preparation.workers.length,
      budgetLedgers: [
        preparation.resourceBudgetLedger,
        unusedExperimentLedger.ledger
      ],
      recordedAt: new Date().toISOString()
    });
    if (stored.status !== 'OK') return stored;
    const completed = emit(VNEXT_WAVE_EVENT.RESULT_PERSISTED, {
      receiptSha256: stored.receipt.receiptSha256
    });
    if (completed.status !== 'OK') return completed;
    return verifyVNextCampaignWave({ store, seriesRunId, waveId });
  }

  const execution = createVNextMechanismExecutionBinding({
    preparationRunId: config.preparationRunId,
    taskPartition: inputs.taskPack.partition,
    taskPackSha256: inputs.taskPack.packSha256,
    preparationVerification,
    parentFamily: config.mechanism.parentFamily,
    mutationObjective: config.mechanism.mutationObjective,
    reasonCodes: config.mechanism.reasonCodes,
    expectedEffectCode: config.mechanism.expectedEffectCode,
    interfaceContracts: inputs.taskMaterialBundle.materials.map((row) => row.interfaceContract),
    behaviorMap: config.preparation.behaviorMap,
    proposalRecordedAt: config.proposalRecordedAt,
    shadowRecordedAt: config.shadowRecordedAt
  }, { requireProduction: true });
  if (execution.status !== 'OK') {
    return block(
      execution.code || 'VNEXT_WAVE_EXECUTION_BINDING_FAILED',
      execution.message || 'Prepared candidate could not be bound to one executable mechanism.'
    );
  }
  if (journal.latest?.type === VNEXT_WAVE_EVENT.PREPARATION_PERSISTED) {
    const bound = emit(VNEXT_WAVE_EVENT.EXECUTION_BOUND, {
      bindingSha256: execution.binding.bindingSha256,
      candidateFamilySha256: execution.candidateFamily.familySha256,
      evolutionSha256: execution.evolutionRecord.evolutionSha256
    });
    if (bound.status !== 'OK') return bound;
  }
  const boundEvent = journal.events.find((event) => (
    event.type === VNEXT_WAVE_EVENT.EXECUTION_BOUND
  ));
  if (!boundEvent
      || boundEvent.detail.bindingSha256 !== execution.binding.bindingSha256) {
    return block(
      'VNEXT_WAVE_EXECUTION_BINDING_DRIFT',
      'The rederived execution binding does not match the durable wave journal.'
    );
  }

  const rawCanary = {
    schemaVersion: 'adaptive-recursive-canary-v2',
    model: config.recursiveCanary.model,
    reasoningEffort: config.recursiveCanary.reasoningEffort,
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    historicalTokenEstimate: config.recursiveCanary.historicalTokenEstimate,
    replicatesPerArm: 3,
    calibrationRule: 'paired-placebo-upper-bound-v1',
    confirmationRule: 'five-task-adjusted-sign-test-v1',
    parentFamily: execution.parentFamily,
    candidateFamily: execution.candidateFamily,
    evolutionRecord: execution.evolutionRecord,
    resourceBudgetPolicy: policies.experiment,
    perCallBudget: config.recursiveCanary.perCallBudget,
    vnextBinding: execution.binding,
    vnextBehaviorMap: config.preparation.behaviorMap,
    pacePolicy: pacePolicy(config, series, descriptor),
    calibrationTasks: split.calibrationTasks,
    confirmationTasks: split.confirmationTasks
  };
  const artifactRoot = store.runDir(seriesRunId);
  const unbound = prepareAdaptiveRecursiveCanaryV2Config(rawCanary, {
    artifactRoot,
    runtimeAuthorityRecord: config.runtimeAuthority,
    evaluatorAuthorityRecord: config.evaluatorAuthority,
    approvedPlanSha256: null
  });
  if (unbound.status !== 'OK') {
    return block(
      unbound.code || 'VNEXT_WAVE_CANARY_PLAN_FAILED',
      unbound.message || 'The recursive canary plan could not be built.'
    );
  }
  const prepared = prepareAdaptiveRecursiveCanaryV2Config(rawCanary, {
    artifactRoot,
    runtimeAuthorityRecord: unbound.config.runtimeAuthority,
    evaluatorAuthorityRecord: unbound.config.evaluatorAuthority,
    approvedPlanSha256: unbound.plan.sha256
  });
  if (prepared.status !== 'OK') {
    return block(
      prepared.code || 'VNEXT_WAVE_CANARY_CONFIG_FAILED',
      prepared.message || 'The self-bound recursive canary config failed validation.'
    );
  }
  const runnerOptions = {
    runId: config.experimentRunId,
    shouldStop,
    onCallPersisted: onProgress
  };
  let experiment = null;
  if (journal.latest?.type === VNEXT_WAVE_EVENT.EXECUTION_BOUND) {
    const dispatched = emit(VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED, {
      experimentRunId: config.experimentRunId,
      experimentPlanSha256: prepared.plan.sha256,
      maximumCalls: ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls
    });
    if (dispatched.status !== 'OK') return dispatched;
    experiment = runAdaptiveRecursiveCanaryV2WithLease(
      store,
      prepared.config,
      runnerOptions
    );
  } else {
    const dispatchEvent = journal.events.find((event) => (
      event.type === VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED
    ));
    if (!dispatchEvent
        || dispatchEvent.detail.experimentPlanSha256 !== prepared.plan.sha256) {
      return block(
        'VNEXT_WAVE_EXPERIMENT_PLAN_DRIFT',
        'The rebuilt recursive plan does not match the durable dispatch journal.'
      );
    }
    if (journal.latest?.type === VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED
        && !store.exists(config.experimentRunId)) {
      return block(
        'VNEXT_WAVE_AMBIGUOUS_EXPERIMENT_DISPATCH',
        'The experiment was dispatched without durable state and will not be retried.'
      );
    }
  }
  const verification = verifyAdaptiveRecursiveCanaryV2Run(
    store,
    config.experimentRunId
  );
  const lease = verifyAdaptiveRecursiveVNextLeaseReceipt(
    store,
    config.experimentRunId
  );
  if ((experiment && experiment.status !== 'OK')
      || verification.experimentValid !== true
      || lease.status !== 'OK') {
    return block(
      'VNEXT_WAVE_EXPERIMENT_INVALID',
      'The recursive experiment or exclusive lease failed independent replay.',
      { experiment, verification, lease }
    );
  }
  if (journal.latest?.type === VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED) {
    const verifiedEvent = emit(VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED, {
      experimentRunId: config.experimentRunId,
      experimentEvidenceSha256: verification.evidenceSha256,
      leaseEvidenceSha256: lease.evidenceSha256
    });
    if (verifiedEvent.status !== 'OK') return verifiedEvent;
  }
  const imported = persistVNextRecursiveEvidence({
    sourceStore: store,
    homeDir: store.homeDir,
    runId: config.experimentRunId
  });
  if (imported.status !== 'OK') {
    return block(
      imported.code || 'VNEXT_WAVE_IMPORT_FAILED',
      imported.message || 'Verifier-owned evidence import failed.'
    );
  }
  if (journal.latest?.type === VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED) {
    const importedEvent = emit(VNEXT_WAVE_EVENT.IMPORT_PERSISTED, {
      recordId: imported.record.recordId,
      recordSha256: imported.record.recordSha256,
      evidenceLedgerSha256: imported.evidenceLedgerSha256,
      catalogRecordSetSha256: sha256(canonicalVNextJson(imported.catalog.persisted))
    });
    if (importedEvent.status !== 'OK') return importedEvent;
  }
  if (journal.latest?.type !== VNEXT_WAVE_EVENT.IMPORT_PERSISTED) {
    return block(
      'VNEXT_WAVE_IMPORT_PHASE_INVALID',
      'Evidence import succeeded outside the expected durable phase.'
    );
  }
  const experimentState = store.load(config.experimentRunId);
  const stored = persistResult(store, seriesRunId, waveId, {
    schemaVersion: VNEXT_WAVE_RESULT_SCHEMA,
    seriesRunId,
    waveId,
    wavePlanSha256: planned.planSha256,
    waveInputEvidenceSha256: inputs.evidenceSha256,
    implementationSha256: planned.implementation.implementationSha256,
    materializationSha256: materialized.manifest.materializationSha256,
    disposition: 'EXPERIMENT_VERIFIED',
    taskPartition: inputs.taskPack.partition,
    preparationDisposition: preparation.disposition,
    preparationRunId: config.preparationRunId,
    preparationEvidenceSha256: preparationVerification.evidenceSha256,
    executionBindingSha256: execution.binding.bindingSha256,
    experimentRunId: config.experimentRunId,
    experimentPlanSha256: prepared.plan.sha256,
    experimentEvidenceSha256: verification.evidenceSha256,
    leaseEvidenceSha256: lease.evidenceSha256,
    importedRecordSha256: imported.record.recordSha256,
    importedRecordId: imported.record.recordId,
    evidenceLedgerSha256AtImport: imported.evidenceLedgerSha256,
    catalogMode: imported.catalog.mode ?? 'validation-routing',
    catalogRecords: imported.catalog.persisted,
    causalPass: verification.causalPass,
    activationEligible: imported.activationEligible,
    promotionAuthorized: false,
    calls: preparation.workers.length + experimentState.calls.length,
    budgetLedgers: [
      preparation.resourceBudgetLedger,
      experimentState.resourceBudgetLedger
    ],
    recordedAt: new Date().toISOString()
  });
  if (stored.status !== 'OK') return stored;
  const completed = emit(VNEXT_WAVE_EVENT.RESULT_PERSISTED, {
    receiptSha256: stored.receipt.receiptSha256
  });
  if (completed.status !== 'OK') return completed;
  return verifyVNextCampaignWave({ store, seriesRunId, waveId });
}

export async function runVNextCampaignWave(input = {}) {
  const { store, seriesRunId, waveId } = input;
  if (!store || !isSafeId(seriesRunId) || !isSafeId(waveId)) {
    return refused('VNEXT_WAVE_RUN_INPUT_INVALID', 'A store and safe series/wave IDs are required.');
  }
  const controlRunId = `wave-control-${sha256(`${seriesRunId}:${waveId}`).slice(0, 24)}`;
  const ownerId = `wave-supervisor-${process.pid}`;
  const nonce = `nonce-${randomUUID()}`;
  const ttlMs = ADAPTIVE_RECURSIVE_CANARY_V2.perCallTimeoutMs + 60_000;
  const acquired = acquireRunLease({
    homeDir: store.homeDir,
    runId: controlRunId,
    ownerId,
    nonce,
    ttlMs
  });
  if (acquired.status !== 'OK') {
    return refused(
      acquired.code || 'VNEXT_WAVE_CONTROL_LEASE_FAILED',
      'Another supervisor owns this wave or its control lease is invalid.'
    );
  }
  let current = acquired.lease;
  const heartbeat = startRunLeaseHeartbeat({
    homeDir: store.homeDir,
    lease: current
  });
  if (heartbeat.status !== 'OK') {
    releaseRunLease({
      homeDir: store.homeDir,
      runId: controlRunId,
      ownerId,
      nonce,
      expectedLeaseSha256: current.leaseSha256
    });
    return refused(
      heartbeat.code || 'VNEXT_WAVE_CONTROL_HEARTBEAT_FAILED',
      'Wave control could not establish an independent lease heartbeat.'
    );
  }
  const onProgress = () => {
    const renewed = renewRunLease({
      homeDir: store.homeDir,
      runId: controlRunId,
      ownerId,
      nonce,
      expectedLeaseSha256: current.leaseSha256,
      ttlMs
    });
    if (renewed.status !== 'OK') {
      const error = new Error('VNext wave control lease was lost.');
      error.code = renewed.code || 'VNEXT_WAVE_CONTROL_LEASE_LOST';
      throw error;
    }
    current = renewed.lease;
    if (typeof input.progressObserver === 'function') input.progressObserver();
  };
  let result;
  try {
    result = await runVNextCampaignWaveLocked({ ...input, onProgress });
  } catch (error) {
    result = refused(
      error.code || 'VNEXT_WAVE_RUN_FAILED',
      error.message || 'The VNext wave failed.'
    );
  }
  const heartbeatStopped = heartbeat.stop();
  const released = releaseRunLease({
    homeDir: store.homeDir,
    runId: controlRunId,
    ownerId,
    nonce,
    expectedLeaseSha256: current.leaseSha256
  });
  if (heartbeatStopped.status !== 'OK') {
    return refused(
      heartbeatStopped.code || 'VNEXT_WAVE_CONTROL_HEARTBEAT_STOP_FAILED',
      'Wave result was preserved, but control heartbeat cleanup failed.',
      { result }
    );
  }
  return released.status === 'OK'
    ? result
    : refused(
        released.code || 'VNEXT_WAVE_CONTROL_LEASE_RELEASE_FAILED',
        'Wave result was preserved, but exclusive control release failed.',
        { result }
      );
}

export function verifyVNextCampaignWave({ store, seriesRunId, waveId } = {}) {
  try {
    if (!store || !isSafeId(seriesRunId) || !isSafeId(waveId)) {
      return refused('VNEXT_WAVE_VERIFY_INPUT_INVALID', 'Safe series and wave IDs are required.');
    }
    const planned = planVNextCampaignWave({ store, seriesRunId, waveId });
    if (planned.status !== 'OK') return planned;
    const raw = store.readRunFile(seriesRunId, wavePath(waveId, RESULT_FILE));
    const receipt = raw ? JSON.parse(raw) : null;
    const journal = loadVNextWaveJournal({ store, seriesRunId, waveId });
    const materializationRaw = store.readRunFile(
      seriesRunId,
      wavePath(waveId, MATERIALIZATION_FILE)
    );
    const materialization = materializationRaw ? JSON.parse(materializationRaw) : null;
    if (validateVNextWaveResult(receipt).status !== 'OK'
        || receipt.seriesRunId !== seriesRunId
        || receipt.waveId !== waveId
        || receipt.wavePlanSha256 !== planned.planSha256
        || receipt.waveInputEvidenceSha256 !== planned.inputs.evidenceSha256
        || receipt.implementationSha256
          !== planned.implementation.implementationSha256
        || journal.status !== 'OK'
        || journal.latest?.type !== VNEXT_WAVE_EVENT.RESULT_PERSISTED
        || journal.latest.detail.receiptSha256 !== receipt.receiptSha256
        || validateVNextWaveMaterialization(materialization).status !== 'OK'
        || receipt.materializationSha256 !== materialization.materializationSha256
        || !verifyMaterialization({
          store,
          seriesRunId,
          waveId,
          inputs: planned.inputs,
          manifest: materialization
        })
        || receipt.taskPartition !== planned.inputs.taskPack.partition
        || receipt.promotionAuthorized !== false
        || !['development', 'validation'].includes(receipt.taskPartition)) {
      return refused('VNEXT_WAVE_RECEIPT_INVALID', 'The wave result or materialization receipt is malformed or tampered.');
    }
    const [prepBudget, experimentBudget] = receipt.budgetLedgers;
    const prepBudgetCheck = verifyResourceBudgetLedger(prepBudget);
    const experimentBudgetCheck = verifyResourceBudgetLedger(experimentBudget);
    const preparation = verifyVNextPreparationRun(
      store,
      planned.inputs.config.preparationRunId
    );
    const preparationBudgetHistory = verifyResourceBudgetCheckpointHistory({
      store,
      runId: seriesRunId,
      checkpointRoot: wavePath(waveId, 'budget-checkpoints/preparation')
    });
    const budgetCalls = (prepBudgetCheck.totals?.callsSettled ?? -1)
      + (experimentBudgetCheck.totals?.callsSettled ?? -1);
    if (prepBudgetCheck.status !== 'OK'
        || experimentBudgetCheck.status !== 'OK'
        || canonicalVNextJson(prepBudget.policy)
          !== canonicalVNextJson(planned.policies.preparation)
        || canonicalVNextJson(experimentBudget.policy)
          !== canonicalVNextJson(planned.policies.experiment)
        || prepBudgetCheck.totals.callsReserved !== prepBudgetCheck.totals.callsSettled
        || experimentBudgetCheck.totals.callsReserved
          !== experimentBudgetCheck.totals.callsSettled
        || (prepBudget.entries.length === 0
          ? preparationBudgetHistory.code
            !== 'RESOURCE_BUDGET_CHECKPOINT_HISTORY_MISSING'
          : preparationBudgetHistory.status !== 'OK'
            || preparationBudgetHistory.ledger.ledgerSha256
              !== prepBudget.ledgerSha256
            || preparationBudgetHistory.unresolvedReservations.length !== 0)
        || preparation.status !== 'OK'
        || preparation.evidenceSha256 !== receipt.preparationEvidenceSha256
        || receipt.calls !== budgetCalls) {
      return refused('VNEXT_WAVE_PROOF_REPLAY_INVALID', 'Preparation or child resource evidence failed replay.');
    }
    if (receipt.disposition === 'PREPARATION_REJECTED') {
      if (preparation.result.disposition === 'CANDIDATE_READY_FOR_EXPERIMENT'
          || experimentBudgetCheck.totals.callsSettled !== 0
          || receipt.executionBindingSha256 !== null
          || receipt.experimentPlanSha256 !== null
          || receipt.experimentEvidenceSha256 !== null
          || receipt.leaseEvidenceSha256 !== null
          || receipt.importedRecordSha256 !== null
          || receipt.importedRecordId !== null
          || receipt.evidenceLedgerSha256AtImport !== null
          || receipt.catalogMode !== null
          || receipt.catalogRecords.length !== 0
          || receipt.causalPass !== false
          || receipt.activationEligible !== false
          || store.exists(receipt.experimentRunId)) {
        return refused('VNEXT_WAVE_REJECTION_INVALID', 'A preparation rejection contains experiment or activation evidence.');
      }
    } else if (receipt.disposition === 'EXPERIMENT_VERIFIED') {
      const verification = verifyAdaptiveRecursiveCanaryV2Run(
        store,
        receipt.experimentRunId
      );
      const lease = verifyAdaptiveRecursiveVNextLeaseReceipt(
        store,
        receipt.experimentRunId
      );
      const derived = deriveVNextRecursiveEvidence({
        sourceStore: store,
        runId: receipt.experimentRunId
      });
      const state = store.load(receipt.experimentRunId);
      const evidenceAuthority = createVNextEvidenceAuthorityVerifier({
        sourceStore: store,
        homeDir: store.homeDir
      });
      const bank = evidenceAuthority.status === 'OK'
        ? readVNextEvidenceBank(store.homeDir, {
            authorityVerifier: evidenceAuthority.verifier
          })
        : evidenceAuthority;
      const catalog = listAdaptiveRecords({ homeDir: store.homeDir });
      const bankRecord = bank.status === 'OK'
        ? bank.records.find((record) => record.recordId === receipt.importedRecordId)
        : null;
      const catalogRecords = catalog.status === 'OK' ? catalog.records : [];
      const persistedCatalogRowsPresent = Array.isArray(receipt.catalogRecords)
        && receipt.catalogRecords.every((row) => catalogRecords.some((record) => (
          record.schemaVersion === row.schemaVersion
          && Object.values(record).includes(row.recordId)
          && Object.values(record).includes(row.recordSha256)
        )));
      if (verification.experimentValid !== true
          || verification.evidenceSha256 !== receipt.experimentEvidenceSha256
          || state?.plan?.sha256 !== receipt.experimentPlanSha256
          || state?.calls?.length !== experimentBudgetCheck.totals.callsSettled
          || canonicalVNextJson(state?.resourceBudgetLedger)
            !== canonicalVNextJson(experimentBudget)
          || lease.status !== 'OK'
          || lease.evidenceSha256 !== receipt.leaseEvidenceSha256
          || derived.status !== 'OK'
          || derived.record.content.partition !== receipt.taskPartition
          || derived.record.content.taskPackSha256
            !== planned.inputs.taskPack.packSha256
          || derived.record.recordSha256 !== receipt.importedRecordSha256
          || derived.record.recordId !== receipt.importedRecordId
          || bank.status !== 'OK'
          || bankRecord?.recordSha256 !== receipt.importedRecordSha256
          || catalog.status !== 'OK'
          || !persistedCatalogRowsPresent
          || (receipt.taskPartition === 'development'
            && (receipt.activationEligible !== false
              || receipt.catalogMode !== 'development-only'
              || receipt.catalogRecords.some((row) => row.state === 'ACTIVE')))
          || (receipt.taskPartition === 'validation'
            && receipt.catalogMode !== 'validation-routing')
          || verification.causalPass !== receipt.causalPass
          || (receipt.taskPartition === 'validation'
            && verification.activationEligible !== receipt.activationEligible)
          || (receipt.taskPartition === 'development'
            && receipt.activationEligible !== false)) {
        return refused('VNEXT_WAVE_EXPERIMENT_REPLAY_INVALID', 'Experiment, lease, admission, or imported evidence failed replay.');
      }
    } else {
      return refused('VNEXT_WAVE_DISPOSITION_INVALID', 'Unknown wave disposition.');
    }
    const evidence = {
      schemaVersion: 'loop-factory-vnext-wave-verifier-evidence-v1',
      seriesRunId,
      waveId,
      wavePlanSha256: planned.planSha256,
      implementationSha256: planned.implementation.implementationSha256,
      receiptSha256: receipt.receiptSha256,
      waveJournalSha256: journal.journalSha256,
      terminalEventSha256: journal.latest.eventSha256,
      preparationEvidenceSha256: receipt.preparationEvidenceSha256,
      experimentEvidenceSha256: receipt.experimentEvidenceSha256,
      leaseEvidenceSha256: receipt.leaseEvidenceSha256,
      importedRecordSha256: receipt.importedRecordSha256,
      taskPartition: receipt.taskPartition,
      importedRecordId: receipt.importedRecordId,
      evidenceLedgerSha256AtImport: receipt.evidenceLedgerSha256AtImport,
      budgetLedgerSha256s: receipt.budgetLedgers.map((ledger) => ledger.ledgerSha256),
      disposition: receipt.disposition,
      causalPass: receipt.causalPass,
      activationEligible: receipt.activationEligible,
      promotionAuthorized: false
    };
    const evidenceValidation = validateVNextWaveVerifierEvidence(evidence);
    if (evidenceValidation.status !== 'OK') return evidenceValidation;
    return {
      status: 'OK',
      receipt,
      calls: receipt.calls,
      budgetLedgers: receipt.budgetLedgers,
      disposition: receipt.disposition,
      causalPass: receipt.causalPass,
      activationEligible: receipt.activationEligible,
      evidence,
      evidenceSha256: sha256(canonicalVNextJson(evidence))
    };
  } catch (error) {
    return refused('VNEXT_WAVE_VERIFY_FAILED', error.message);
  }
}
