import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  validateCampaignSeriesPlan,
  validateCampaignSeriesState
} from './campaign-series.mjs';
import {
  loadVNextTaskPackMaterials,
  validateVNextTaskMaterialBundle,
  validateVNextTaskPack
} from './vnext-task-pack.mjs';
import { createResourceBudgetPolicy, verifyResourceBudgetLedger } from './resource-budget.mjs';
import { validateVNextWaveConfig } from './vnext-wave-config.mjs';

export const CAMPAIGN_SERIES_CHECKPOINT_SCHEMA =
  'loop-factory-campaign-series-checkpoint-v1';

const ROOT = 'campaign-series';
const PLAN_FILE = `${ROOT}/plan.json`;
const BUDGET_FILE = `${ROOT}/root-budget-ledger.json`;
const CHECKPOINT_FILE = `${ROOT}/checkpoints.jsonl`;

function wavePath(waveId, file) {
  return `${ROOT}/waves/${waveId}/${file}`;
}

function parseJson(raw, code, message) {
  try { return { status: 'OK', value: JSON.parse(raw || '') }; } catch {
    return refused(code, message);
  }
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function immutableWrite(store, runId, path, value) {
  const bytes = `${canonicalVNextJson(value)}\n`;
  const current = store.readRunFile(runId, path);
  if (current != null) {
    return current === bytes
      ? { status: 'OK', path, sha256: sha256(bytes), idempotent: true }
      : refused('CAMPAIGN_SERIES_IMMUTABLE_CONFLICT', `Immutable series artifact conflicts at ${path}.`);
  }
  const written = store.writeRunFile(runId, path, bytes);
  return { status: 'OK', path: written, sha256: sha256(bytes), idempotent: false };
}

function checkpointPayload(checkpoint) {
  return {
    schemaVersion: checkpoint.schemaVersion,
    sequence: checkpoint.sequence,
    runId: checkpoint.runId,
    planSha256: checkpoint.planSha256,
    previousCheckpointSha256: checkpoint.previousCheckpointSha256,
    recordedAt: checkpoint.recordedAt,
    stateSha256: checkpoint.stateSha256,
    state: checkpoint.state
  };
}

function parseCheckpoints(raw, { runId, plan }) {
  if (raw == null || raw === '') return { status: 'OK', checkpoints: [] };
  const checkpoints = [];
  let previous = null;
  for (const [index, line] of raw.split('\n').filter(Boolean).entries()) {
    let checkpoint;
    try { checkpoint = JSON.parse(line); } catch {
      return refused('CAMPAIGN_SERIES_CHECKPOINT_JSON', `Checkpoint ${index} is invalid JSON.`);
    }
    if (checkpoint.schemaVersion !== CAMPAIGN_SERIES_CHECKPOINT_SCHEMA
        || checkpoint.sequence !== index
        || checkpoint.runId !== runId
        || checkpoint.planSha256 !== plan.planSha256
        || checkpoint.previousCheckpointSha256
          !== (previous?.checkpointSha256 ?? null)
        || checkpoint.stateSha256 !== checkpoint.state?.stateSha256
        || validateCampaignSeriesState(checkpoint.state).status !== 'OK'
        || checkpoint.state.runId !== runId
        || checkpoint.state.planSha256 !== plan.planSha256
        || checkpoint.checkpointSha256
          !== sha256(canonicalVNextJson(checkpointPayload(checkpoint)))
        || (previous && checkpoint.state.revision !== previous.state.revision + 1)) {
      return refused('CAMPAIGN_SERIES_CHECKPOINT_TAMPERED', `Checkpoint ${index} failed replay.`);
    }
    checkpoints.push(checkpoint);
    previous = checkpoint;
  }
  return { status: 'OK', checkpoints };
}

export function initializeCampaignSeriesStore({
  store,
  runId,
  plan,
  state,
  rootBudgetLedger
} = {}) {
  if (!store || !isSafeId(runId)
      || validateCampaignSeriesPlan(plan).status !== 'OK'
      || validateCampaignSeriesState(state).status !== 'OK'
      || state.runId !== runId
      || state.planSha256 !== plan.planSha256
      || verifyResourceBudgetLedger(rootBudgetLedger).status !== 'OK'
      || canonicalVNextJson(rootBudgetLedger.policy)
        !== canonicalVNextJson(plan.budgetPolicy)) {
    return refused('CAMPAIGN_SERIES_STORE_INPUT_INVALID', 'Series store inputs are invalid or unbound.');
  }
  const planWrite = immutableWrite(store, runId, PLAN_FILE, plan);
  if (planWrite.status !== 'OK') return planWrite;
  const budgetWrite = immutableWrite(store, runId, BUDGET_FILE, rootBudgetLedger);
  if (budgetWrite.status !== 'OK') return budgetWrite;
  return appendCampaignSeriesCheckpoint({ store, runId, plan, state });
}

export function appendCampaignSeriesCheckpoint({ store, runId, plan, state } = {}) {
  if (!store || !isSafeId(runId)
      || validateCampaignSeriesPlan(plan).status !== 'OK'
      || validateCampaignSeriesState(state).status !== 'OK'
      || state.runId !== runId
      || state.planSha256 !== plan.planSha256) {
    return refused('CAMPAIGN_SERIES_CHECKPOINT_INPUT_INVALID', 'Checkpoint state is invalid or unbound.');
  }
  const raw = store.readRunFile(runId, CHECKPOINT_FILE) ?? '';
  const parsed = parseCheckpoints(raw, { runId, plan });
  if (parsed.status !== 'OK') return parsed;
  const previous = parsed.checkpoints.at(-1) ?? null;
  if (previous?.stateSha256 === state.stateSha256) {
    return {
      status: 'OK',
      checkpoint: previous,
      checkpointCount: parsed.checkpoints.length,
      idempotent: true
    };
  }
  if (previous && state.revision !== previous.state.revision + 1) {
    return refused('CAMPAIGN_SERIES_CHECKPOINT_REVISION_GAP', 'Every durable state transition must be checkpointed in order.');
  }
  const core = {
    schemaVersion: CAMPAIGN_SERIES_CHECKPOINT_SCHEMA,
    sequence: parsed.checkpoints.length,
    runId,
    planSha256: plan.planSha256,
    previousCheckpointSha256: previous?.checkpointSha256 ?? null,
    recordedAt: state.updatedAt,
    stateSha256: state.stateSha256,
    state
  };
  const checkpoint = {
    ...core,
    checkpointSha256: sha256(canonicalVNextJson(core))
  };
  const next = [...parsed.checkpoints, checkpoint]
    .map((row) => canonicalVNextJson(row)).join('\n');
  store.writeRunFile(runId, CHECKPOINT_FILE, `${next}\n`);
  const reopened = parseCheckpoints(
    store.readRunFile(runId, CHECKPOINT_FILE),
    { runId, plan }
  );
  return reopened.status === 'OK'
      && reopened.checkpoints.at(-1)?.checkpointSha256 === checkpoint.checkpointSha256
    ? {
        status: 'OK',
        checkpoint,
        checkpointCount: reopened.checkpoints.length,
        idempotent: false
      }
    : refused('CAMPAIGN_SERIES_CHECKPOINT_REOPEN_FAILED', 'Checkpoint did not replay after persistence.');
}

export function loadCampaignSeriesStore({ store, runId } = {}) {
  try {
    const plan = JSON.parse(store.readRunFile(runId, PLAN_FILE) || '');
    const rootBudgetLedger = JSON.parse(store.readRunFile(runId, BUDGET_FILE) || '');
    if (validateCampaignSeriesPlan(plan).status !== 'OK'
        || verifyResourceBudgetLedger(rootBudgetLedger).status !== 'OK'
        || canonicalVNextJson(rootBudgetLedger.policy)
          !== canonicalVNextJson(plan.budgetPolicy)) {
      return refused('CAMPAIGN_SERIES_STORE_ARTIFACT_INVALID', 'Plan or root budget failed replay.');
    }
    const parsed = parseCheckpoints(
      store.readRunFile(runId, CHECKPOINT_FILE),
      { runId, plan }
    );
    if (parsed.status !== 'OK' || parsed.checkpoints.length === 0) return parsed;
    return {
      status: 'OK',
      plan,
      rootBudgetLedger,
      state: parsed.checkpoints.at(-1).state,
      checkpoints: parsed.checkpoints,
      evidenceSha256: sha256(canonicalVNextJson({
        planSha256: plan.planSha256,
        rootBudgetLedgerSha256: rootBudgetLedger.ledgerSha256,
        checkpointSha256: parsed.checkpoints.at(-1).checkpointSha256
      }))
    };
  } catch (error) {
    return refused('CAMPAIGN_SERIES_STORE_LOAD_FAILED', error.message);
  }
}

export function persistCampaignSeriesWaveInputs({
  store,
  runId,
  waveId,
  taskPack,
  taskMaterialBundle = null,
  artifactRoot = null,
  maximumFileBytes = 1024 * 1024,
  config,
  budgetPolicies
} = {}) {
  if (!store || !isSafeId(runId) || !isSafeId(waveId)
      || validateVNextTaskPack(taskPack).status !== 'OK'
      || !config || typeof config !== 'object' || Array.isArray(config)
      || (config.schemaVersion === 'loop-factory-vnext-wave-config-v1'
        && (validateVNextWaveConfig(config).status !== 'OK'
          || config.waveId !== waveId))
      || !Array.isArray(budgetPolicies) || budgetPolicies.length < 1
      || ((taskMaterialBundle == null) === (artifactRoot == null))) {
    return refused('CAMPAIGN_SERIES_WAVE_INPUT_INVALID', 'Wave inputs are incomplete or invalid.');
  }
  const loadedMaterials = taskMaterialBundle == null
    ? loadVNextTaskPackMaterials({ artifactRoot, pack: taskPack, maximumFileBytes })
    : { status: 'OK', bundle: taskMaterialBundle };
  if (loadedMaterials.status !== 'OK'
      || validateVNextTaskMaterialBundle({
        bundle: loadedMaterials.bundle,
        pack: taskPack
      }).status !== 'OK') {
    return refused('CAMPAIGN_SERIES_WAVE_MATERIAL_INVALID', 'Task materials do not replay against the frozen task pack.');
  }
  const checked = budgetPolicies.map((policy) => createResourceBudgetPolicy(policy));
  if (checked.some((result) => result.status !== 'OK')) {
    return refused('CAMPAIGN_SERIES_WAVE_BUDGET_INVALID', 'A child budget policy is invalid.');
  }
  const policies = checked.map((result) => result.policy)
    .sort((left, right) => left.policyId.localeCompare(right.policyId));
  const taskPackWrite = immutableWrite(
    store,
    runId,
    wavePath(waveId, 'task-pack.json'),
    taskPack
  );
  if (taskPackWrite.status !== 'OK') return taskPackWrite;
  const configWrite = immutableWrite(
    store,
    runId,
    wavePath(waveId, 'config.json'),
    config
  );
  if (configWrite.status !== 'OK') return configWrite;
  const budgetWrite = immutableWrite(
    store,
    runId,
    wavePath(waveId, 'budget-policies.json'),
    policies
  );
  if (budgetWrite.status !== 'OK') return budgetWrite;
  const materialWrite = immutableWrite(
    store,
    runId,
    wavePath(waveId, 'materials.json'),
    loadedMaterials.bundle
  );
  if (materialWrite.status !== 'OK') return materialWrite;
  const core = {
    schemaVersion: 'loop-factory-campaign-series-wave-input-v1',
    runId,
    waveId,
    taskPackId: taskPack.packId,
    taskPackSha256: taskPack.packSha256,
    taskMaterialBundleSha256: loadedMaterials.bundle.bundleSha256,
    configId: `config-${waveId}`,
    configSha256: sha256(canonicalVNextJson(config)),
    budgetPolicySetSha256: sha256(canonicalVNextJson(policies)),
    artifacts: {
      taskPackSha256: taskPackWrite.sha256,
      configSha256: configWrite.sha256,
      budgetPoliciesSha256: budgetWrite.sha256,
      taskMaterialsSha256: materialWrite.sha256
    }
  };
  const manifest = {
    ...core,
    manifestSha256: sha256(canonicalVNextJson(core))
  };
  const manifestWrite = immutableWrite(
    store,
    runId,
    wavePath(waveId, 'manifest.json'),
    manifest
  );
  return manifestWrite.status === 'OK'
    ? {
        status: 'OK', manifest, taskPack,
        taskMaterialBundle: loadedMaterials.bundle,
        config, budgetPolicies: policies
      }
    : manifestWrite;
}

export function loadCampaignSeriesWaveInputs({ store, runId, waveId } = {}) {
  if (!store || !isSafeId(runId) || !isSafeId(waveId)) {
    return refused('CAMPAIGN_SERIES_WAVE_LOAD_INVALID', 'A store and safe run/wave IDs are required.');
  }
  const names = {
    manifest: 'manifest.json',
    taskPack: 'task-pack.json',
    taskMaterialBundle: 'materials.json',
    config: 'config.json',
    budgetPolicies: 'budget-policies.json'
  };
  const raws = Object.fromEntries(Object.entries(names).map(([name, file]) => [
    name,
    store.readRunFile(runId, wavePath(waveId, file))
  ]));
  const parsed = Object.fromEntries(Object.entries(raws).map(([name, raw]) => [
    name,
    parseJson(raw, 'CAMPAIGN_SERIES_WAVE_JSON_INVALID', `${name} is not valid persisted JSON.`)
  ]));
  const failed = Object.values(parsed).find((result) => result.status !== 'OK');
  if (failed) return failed;
  const values = Object.fromEntries(Object.entries(parsed).map(([name, result]) => [name, result.value]));
  const { manifest, taskPack, taskMaterialBundle, config, budgetPolicies } = values;
  if (!exactKeys(manifest, [
    'schemaVersion', 'runId', 'waveId', 'taskPackId', 'taskPackSha256',
    'taskMaterialBundleSha256', 'configId', 'configSha256',
    'budgetPolicySetSha256', 'artifacts', 'manifestSha256'
  ])
      || manifest.schemaVersion !== 'loop-factory-campaign-series-wave-input-v1'
      || manifest.runId !== runId
      || manifest.waveId !== waveId
      || !exactKeys(manifest.artifacts, [
        'taskPackSha256', 'configSha256', 'budgetPoliciesSha256',
        'taskMaterialsSha256'
      ])
      || manifest.manifestSha256 !== sha256(canonicalVNextJson((({ manifestSha256, ...core }) => core)(manifest)))
      || validateVNextTaskPack(taskPack).status !== 'OK'
      || (config.schemaVersion === 'loop-factory-vnext-wave-config-v1'
        && (validateVNextWaveConfig(config).status !== 'OK'
          || config.waveId !== waveId))
      || validateVNextTaskMaterialBundle({ bundle: taskMaterialBundle, pack: taskPack }).status !== 'OK'
      || manifest.taskPackId !== taskPack.packId
      || manifest.taskPackSha256 !== taskPack.packSha256
      || manifest.taskMaterialBundleSha256 !== taskMaterialBundle.bundleSha256
      || manifest.configId !== `config-${waveId}`
      || manifest.configSha256 !== sha256(canonicalVNextJson(config))
      || !Array.isArray(budgetPolicies)
      || budgetPolicies.length < 1) {
    return refused('CAMPAIGN_SERIES_WAVE_REPLAY_INVALID', 'Persisted wave inputs failed semantic replay.');
  }
  const checkedPolicies = budgetPolicies.map((policy) => createResourceBudgetPolicy(policy));
  if (checkedPolicies.some((result) => result.status !== 'OK')) {
    return refused('CAMPAIGN_SERIES_WAVE_REPLAY_INVALID', 'Persisted child budget policy is invalid.');
  }
  const normalizedPolicies = checkedPolicies.map((result) => result.policy)
    .sort((left, right) => left.policyId.localeCompare(right.policyId));
  const artifactHashes = {
    taskPackSha256: sha256(raws.taskPack),
    configSha256: sha256(raws.config),
    budgetPoliciesSha256: sha256(raws.budgetPolicies),
    taskMaterialsSha256: sha256(raws.taskMaterialBundle)
  };
  if (canonicalVNextJson(normalizedPolicies) !== canonicalVNextJson(budgetPolicies)
      || manifest.budgetPolicySetSha256 !== sha256(canonicalVNextJson(normalizedPolicies))
      || canonicalVNextJson(manifest.artifacts) !== canonicalVNextJson(artifactHashes)) {
    return refused('CAMPAIGN_SERIES_WAVE_ARTIFACT_TAMPERED', 'Persisted wave bytes or budget ordering drifted.');
  }
  return {
    status: 'OK', manifest, taskPack, taskMaterialBundle,
    config, budgetPolicies: normalizedPolicies,
    evidenceSha256: sha256(canonicalVNextJson({
      manifestSha256: manifest.manifestSha256,
      taskPackSha256: taskPack.packSha256,
      taskMaterialBundleSha256: taskMaterialBundle.bundleSha256,
      configSha256: manifest.configSha256,
      budgetPolicySetSha256: manifest.budgetPolicySetSha256
    }))
  };
}
