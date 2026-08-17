import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { sha256 } from '../src/util.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { buildVNextTaskPack } from '../src/vnext-task-pack.mjs';
import { createResourceBudgetLedger, createResourceBudgetPolicy } from '../src/resource-budget.mjs';
import { createCampaignSeriesPlan, createCampaignSeriesState, enqueueCampaignSeriesWave } from '../src/campaign-series.mjs';
import { appendCampaignSeriesCheckpoint, initializeCampaignSeriesStore, persistCampaignSeriesWaveInputs } from '../src/campaign-series-store.mjs';
import { createVNextWaveConfig, deriveVNextWaveEvaluatorPolicySha256, deriveVNextWaveModelPolicySha256 } from '../src/vnext-wave-config.mjs';
import {
  mechanismProgramParentItems,
  planVNextCampaignWave,
  resolveVNextWaveImplementation,
  runVNextCampaignWave,
  validateVNextWaveMaterialization,
  validateVNextWaveResult,
  validateVNextWaveVerifierEvidence
} from '../src/vnext-wave-runner.mjs';
import { appendVNextWaveEvent, loadVNextWaveJournal, VNEXT_WAVE_EVENT } from '../src/vnext-wave-journal.mjs';
import { configInput } from './vnext-wave-config.test.mjs';

function fixture() {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'vnext-wave-artifacts-'));
  mkdirSync(join(artifactRoot, 'tasks'));
  const tasks = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const root = `domain${number}`;
    const interfaceContract = {
      schemaVersion: 'executable-interface-contract-v2', exportName: 'decide',
      inputPaths: [`${root}.baselineQuality`, `${root}.candidateQuality`],
      decisions: ['ACCEPT', 'REJECT'],
      codes: [{ value: 'QUALITY_GAIN', meaning: 'Quality increased.' }, { value: 'NO_GAIN', meaning: 'Quality did not increase.' }],
      roleBindings: [{ role: 'baseline.quality', path: `${root}.baselineQuality` }, { role: 'candidate.quality', path: `${root}.candidateQuality` }]
    };
    const contents = {
      source: `export function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; } // ${number}\n`,
      incident: `baseline failure ${number}\n`,
      interface: `${JSON.stringify(interfaceContract)}\n`,
      oracle: `${JSON.stringify({ schemaVersion: 'executable-case-set-v1', exportName: 'decide', cases: [
        { id: `target-${number}-1`, group: 'target', input: { [root]: { baselineQuality: 1, candidateQuality: 2 } }, expected: { decision: 'ACCEPT', code: 'QUALITY_GAIN' } },
        { id: `target-${number}-2`, group: 'target', input: { [root]: { baselineQuality: 2, candidateQuality: 3 } }, expected: { decision: 'ACCEPT', code: 'QUALITY_GAIN' } },
        { id: `target-${number}-3`, group: 'target', input: { [root]: { baselineQuality: 3, candidateQuality: 4 } }, expected: { decision: 'ACCEPT', code: 'QUALITY_GAIN' } },
        { id: `control-${number}-1`, group: 'control', input: { [root]: { baselineQuality: 2, candidateQuality: 1 } }, expected: { decision: 'REJECT', code: 'NO_GAIN' } },
        { id: `control-${number}-2`, group: 'control', input: { [root]: { baselineQuality: 4, candidateQuality: 1 } }, expected: { decision: 'REJECT', code: 'NO_GAIN' } }
      ] })}\n`
    };
    const paths = Object.fromEntries(Object.keys(contents).map((name) => [name, `tasks/${name}-${number}.${name === 'source' ? 'mjs' : name === 'incident' ? 'md' : 'json'}`]));
    for (const name of Object.keys(contents)) writeFileSync(join(artifactRoot, paths[name]), contents[name]);
    return {
      taskId: `task-${number}`, clusterId: `cluster-${number}`, domain: `domain-${number}`,
      tags: ['recursive'],
      source: { id: `source-${number}`, path: paths.source, sha256: sha256(contents.source) },
      incident: { id: `incident-${number}`, path: paths.incident, sha256: sha256(contents.incident) },
      interface: { id: `interface-${number}`, path: paths.interface, sha256: sha256(contents.interface) },
      oracle: { id: `oracle-${number}`, path: paths.oracle, sha256: sha256(contents.oracle) },
      interfaceContractSha256: sha256(canonicalVNextJson(interfaceContract)),
      publicTaskSpecSha256: sha256(`public-task-${number}`),
      baselineFailure: { status: 'VERIFIED_FAILURE', taskId: `task-${number}`, artifactId: `baseline-${number}`, artifactSha256: sha256(`baseline-artifact-${number}`), verifierEvidenceSha256: sha256(`baseline-verifier-${number}`), baselineArtifactSha256: sha256(`baseline-source-${number}`) }
    };
  });
  const taskPack = buildVNextTaskPack({
    artifactRoot, packId: 'wave-pack', partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'wave-builder', kind: 'deterministic-tool' },
    evaluatorAuthorityRecord: configInput().evaluatorAuthority,
    tasks
  }).pack;
  const config = createVNextWaveConfig(configInput()).config;
  const preparationBudget = createResourceBudgetPolicy({
    policyId: config.preparationBudgetPolicyId, maxCalls: 7,
    maxInputTokens: 700, maxOutputTokens: 350, maxTotalTokens: 1050,
    maxUsdMicros: 0, inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd', currency: 'USD'
  }).policy;
  const experimentBudget = createResourceBudgetPolicy({
    policyId: config.experimentBudgetPolicyId, maxCalls: 120,
    maxInputTokens: 12000, maxOutputTokens: 6000, maxTotalTokens: 18000,
    maxUsdMicros: 0, inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd', currency: 'USD'
  }).policy;
  const rootBudget = createResourceBudgetPolicy({
    policyId: 'series-root-budget', maxCalls: 127,
    maxInputTokens: 12700, maxOutputTokens: 6350, maxTotalTokens: 19050,
    maxUsdMicros: 0, inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd', currency: 'USD'
  }).policy;
  const implementation = resolveVNextWaveImplementation();
  assert.equal(implementation.status, 'OK', implementation.message);
  const plan = createCampaignSeriesPlan({
    seriesId: 'series-1', createdAt: '2026-08-05T00:00:00.000Z',
    maximumWaves: 1, familywiseAlpha: 0.05, maximumCalls: 127,
    modelPolicySha256: deriveVNextWaveModelPolicySha256(config),
    evaluatorPolicySha256: deriveVNextWaveEvaluatorPolicySha256(config),
    implementationSha256: implementation.implementationSha256, budgetPolicy: rootBudget
  }).plan;
  return { artifactRoot, taskPack, config, preparationBudget, experimentBudget, rootBudget, plan };
}

function closedProofFixtures() {
  const data = fixture();
  const createdAt = '2026-08-05T00:00:00.000Z';
  const budgetLedgers = [
    createResourceBudgetLedger({
      policy: data.preparationBudget,
      runId: 'preparation-run',
      createdAt
    }).ledger,
    createResourceBudgetLedger({
      policy: data.experimentBudget,
      runId: 'experiment-run',
      createdAt
    }).ledger
  ];
  const materializationCore = {
    schemaVersion: 'loop-factory-vnext-wave-materialization-v1',
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    taskMaterialBundleSha256: '1'.repeat(64),
    entries: ['source', 'incident', 'interface', 'oracle'].map((kind) => ({
      taskId: 'task-1',
      kind,
      path: `campaign-series/waves/wave-1/execution-materials/task-1/${kind}`,
      contentSha256: '2'.repeat(64),
      persistedBytesSha256: '2'.repeat(64)
    }))
  };
  const materialization = {
    ...materializationCore,
    materializationSha256: sha256(canonicalVNextJson(materializationCore))
  };
  const resultCore = {
    schemaVersion: 'loop-factory-vnext-wave-result-v1',
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    wavePlanSha256: '3'.repeat(64),
    waveInputEvidenceSha256: '4'.repeat(64),
    implementationSha256: '5'.repeat(64),
    materializationSha256: materialization.materializationSha256,
    disposition: 'PREPARATION_REJECTED',
    taskPartition: 'development',
    preparationDisposition: 'HYPOTHESIS_REJECTED',
    preparationRunId: 'preparation-run',
    preparationEvidenceSha256: '6'.repeat(64),
    executionBindingSha256: null,
    experimentRunId: 'experiment-run',
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
    calls: 0,
    budgetLedgers,
    recordedAt: createdAt
  };
  const result = {
    ...resultCore,
    receiptSha256: sha256(canonicalVNextJson(resultCore))
  };
  const verifierEvidence = {
    schemaVersion: 'loop-factory-vnext-wave-verifier-evidence-v1',
    seriesRunId: 'series-run',
    waveId: 'wave-1',
    wavePlanSha256: result.wavePlanSha256,
    implementationSha256: result.implementationSha256,
    receiptSha256: result.receiptSha256,
    waveJournalSha256: '7'.repeat(64),
    terminalEventSha256: '8'.repeat(64),
    preparationEvidenceSha256: result.preparationEvidenceSha256,
    experimentEvidenceSha256: null,
    leaseEvidenceSha256: null,
    importedRecordSha256: null,
    taskPartition: result.taskPartition,
    importedRecordId: null,
    evidenceLedgerSha256AtImport: null,
    budgetLedgerSha256s: budgetLedgers.map((ledger) => ledger.ledgerSha256),
    disposition: result.disposition,
    causalPass: false,
    activationEligible: false,
    promotionAuthorized: false
  };
  return { materialization, result, verifierEvidence };
}

test('closed wave proof validators reject hash-resealed extension fields', () => {
  const proof = closedProofFixtures();
  assert.equal(validateVNextWaveMaterialization(proof.materialization).status, 'OK');
  assert.equal(validateVNextWaveResult(proof.result).status, 'OK');
  assert.equal(validateVNextWaveVerifierEvidence(proof.verifierEvidence).status, 'OK');

  const materialization = { ...proof.materialization, smuggled: true };
  const materializationPayload = { ...materialization };
  delete materializationPayload.materializationSha256;
  materialization.materializationSha256 = sha256(canonicalVNextJson(materializationPayload));
  assert.equal(validateVNextWaveMaterialization(materialization).status, 'REFUSED');

  const windowsAbsolute = structuredClone(proof.materialization);
  windowsAbsolute.entries[0].path = 'C:\\escaped\\source.mjs';
  const windowsAbsolutePayload = { ...windowsAbsolute };
  delete windowsAbsolutePayload.materializationSha256;
  windowsAbsolute.materializationSha256 = sha256(
    canonicalVNextJson(windowsAbsolutePayload)
  );
  assert.equal(validateVNextWaveMaterialization(windowsAbsolute).status, 'REFUSED');

  const result = { ...proof.result, smuggled: true };
  const resultPayload = { ...result };
  delete resultPayload.receiptSha256;
  result.receiptSha256 = sha256(canonicalVNextJson(resultPayload));
  assert.equal(validateVNextWaveResult(result).status, 'REFUSED');

  assert.equal(validateVNextWaveVerifierEvidence({
    ...proof.verifierEvidence,
    smuggled: true
  }).status, 'REFUSED');
});

test('wave planning binds ten task bytes and exact worst-case child exposures without inference', () => {
  const data = fixture();
  const home = mkdtempSync(join(tmpdir(), 'vnext-wave-home-'));
  const store = createStore(home);
  const state = createCampaignSeriesState({ plan: data.plan, runId: 'series-run' }).state;
  const rootLedger = createResourceBudgetLedger({
    policy: data.rootBudget, runId: 'series-run', createdAt: data.plan.createdAt
  }).ledger;
  assert.equal(initializeCampaignSeriesStore({
    store, runId: 'series-run', plan: data.plan, state, rootBudgetLedger: rootLedger
  }).status, 'OK');
  const inputs = persistCampaignSeriesWaveInputs({
    store, runId: 'series-run', waveId: 'wave-1', taskPack: data.taskPack,
    artifactRoot: data.artifactRoot, config: data.config,
    budgetPolicies: [data.preparationBudget, data.experimentBudget]
  });
  assert.equal(inputs.status, 'OK', inputs.message);
  const queued = enqueueCampaignSeriesWave({
    state, plan: data.plan, expectedStateSha256: state.stateSha256,
    waveId: 'wave-1', taskPack: data.taskPack,
    configId: inputs.manifest.configId, configSha256: inputs.manifest.configSha256,
    budgetPolicies: inputs.budgetPolicies,
    sealedAt: '2026-08-05T00:00:01.000Z', sealAuthority: 'series-builder'
  });
  assert.equal(queued.status, 'OK', queued.code);
  assert.equal(appendCampaignSeriesCheckpoint({
    store, runId: 'series-run', plan: data.plan, state: queued.state
  }).status, 'OK');
  const planned = planVNextCampaignWave({ store, seriesRunId: 'series-run', waveId: 'wave-1' });
  assert.equal(planned.status, 'OK', planned.message);
  assert.equal(planned.exposure.maximumCalls, 127);
  assert.equal(planned.inputs.taskMaterialBundle.materials.length, 10);
  assert.ok(mechanismProgramParentItems(data.config.mechanism.parentFamily.causalFingerprint.program)
    .some((row) => row.target === 'mechanism-program/fallback'));
});

test('an ambiguous preparation dispatch is never retried', async () => {
  const data = fixture();
  const store = createStore(mkdtempSync(join(tmpdir(), 'vnext-wave-ambiguous-')));
  const state = createCampaignSeriesState({ plan: data.plan, runId: 'series-run' }).state;
  const rootLedger = createResourceBudgetLedger({
    policy: data.rootBudget, runId: 'series-run', createdAt: data.plan.createdAt
  }).ledger;
  assert.equal(initializeCampaignSeriesStore({
    store, runId: 'series-run', plan: data.plan, state, rootBudgetLedger: rootLedger
  }).status, 'OK');
  const inputs = persistCampaignSeriesWaveInputs({
    store, runId: 'series-run', waveId: 'wave-1', taskPack: data.taskPack,
    artifactRoot: data.artifactRoot, config: data.config,
    budgetPolicies: [data.preparationBudget, data.experimentBudget]
  });
  const queued = enqueueCampaignSeriesWave({
    state, plan: data.plan, expectedStateSha256: state.stateSha256,
    waveId: 'wave-1', taskPack: data.taskPack,
    configId: inputs.manifest.configId, configSha256: inputs.manifest.configSha256,
    budgetPolicies: inputs.budgetPolicies,
    sealedAt: '2026-08-05T00:00:01.000Z', sealAuthority: 'series-builder'
  });
  assert.equal(appendCampaignSeriesCheckpoint({
    store, runId: 'series-run', plan: data.plan, state: queued.state
  }).status, 'OK');
  const planned = planVNextCampaignWave({ store, seriesRunId: 'series-run', waveId: 'wave-1' });
  assert.equal(appendVNextWaveEvent({
    store, seriesRunId: 'series-run', waveId: 'wave-1',
    type: VNEXT_WAVE_EVENT.STARTED, at: '2026-08-05T00:00:02.000Z',
    detail: { wavePlanSha256: planned.planSha256, waveInputEvidenceSha256: planned.inputs.evidenceSha256 }
  }).status, 'OK');
  assert.equal(appendVNextWaveEvent({
    store, seriesRunId: 'series-run', waveId: 'wave-1',
    type: VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED,
    at: '2026-08-05T00:00:03.000Z',
    detail: { preparationRunId: data.config.preparationRunId, budgetPolicySha256: data.preparationBudget.policySha256 }
  }).status, 'OK');
  const result = await runVNextCampaignWave({
    store, seriesRunId: 'series-run', waveId: 'wave-1'
  });
  assert.equal(result.code, 'VNEXT_WAVE_AMBIGUOUS_PREPARATION_DISPATCH');
  assert.equal(store.exists(data.config.preparationRunId), false);
  assert.equal(loadVNextWaveJournal({
    store, seriesRunId: 'series-run', waveId: 'wave-1'
  }).latest.type, VNEXT_WAVE_EVENT.BLOCKED);
});
