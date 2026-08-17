import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  validateVNextStageArtifact
} from './vnext-contracts.mjs';
import {
  validateVNextPreparationResult
} from './vnext-pipeline.mjs';
import {
  verifyVNextModelWorkerFromDisk
} from './vnext-model-worker.mjs';
import { verifyResourceBudgetLedger } from './resource-budget.mjs';
import {
  verifyExternalResearchPortableEvidence
} from './vnext-external-research-worker.mjs';
import { validateVNextAblationProfile } from './vnext-ablation-profile.mjs';

export const VNEXT_PREPARATION_PROOF_SCHEMA = 'vnext-preparation-proof-v1';

const MAX_WORKER_ARTIFACT_BYTES = 2 * 1024 * 1024;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function artifactRecord(id, role, content) {
  const text = String(content);
  return { id, name: id, role, content: text, sha256: sha256(text) };
}

function artifactRef(record) {
  return { id: record.id, sha256: record.sha256 };
}

function validArtifact(record, ref) {
  return record && ref
    && record.id === ref.id
    && record.sha256 === ref.sha256
    && record.sha256 === sha256(String(record.content));
}

function readWorkerFile(worker, name) {
  const path = join(worker.contract.stateDirectory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WORKER_ARTIFACT_BYTES) {
    throw new Error(`unsafe worker artifact ${name}`);
  }
  return readFileSync(path, 'utf8');
}

function parseArtifact(record, ref) {
  if (!validArtifact(record, ref)) return null;
  try { return JSON.parse(record.content); } catch { return null; }
}

function stageRef(artifact) {
  return {
    id: artifact.artifactId,
    stage: artifact.stage,
    status: artifact.status,
    sha256: artifact.artifactSha256
  };
}

function receiptWorker(result, worker) {
  return result.receipt.workers.find((row) => (
    row.role === worker.role
    && row.contractSha256 === worker.contract.contractSha256
  ));
}

export function persistVNextPreparationResult(store, result, {
  runId,
  requireProduction = true
} = {}) {
  try {
    if (!isSafeId(runId)
        || validateVNextPreparationResult(result).status !== 'OK'
        || !Array.isArray(result.workers)
        || result.workers.length !== result.receipt.workers.length
        || (requireProduction && result.workers.some((worker) => (
          worker.receipt?.productionEvidence !== true
        )))) {
      return refused(
        'VNEXT_PREPARATION_PERSIST_INPUT_INVALID',
        'Preparation persistence requires one replayable worker packet per receipt.'
      );
    }
    if (store.exists(runId)) {
      const existing = verifyVNextPreparationRun(store, runId);
      return existing.status === 'OK'
          && existing.result.receipt.receiptSha256 === result.receipt.receiptSha256
        ? { ...existing, idempotent: true }
        : refused(
            'VNEXT_PREPARATION_RUN_EXISTS',
            'An existing preparation proof does not match this pipeline receipt.'
          );
    }

    const workerEvidence = result.workers.map((worker) => ({
      ...worker,
      workerInputText: readWorkerFile(worker, 'worker-input.json'),
      workerResultText: readWorkerFile(worker, 'worker-result.json')
    }));
    for (const worker of workerEvidence) {
      const replay = verifyVNextModelWorkerFromDisk({
        contract: worker.contract,
        receipt: worker.receipt,
        output: worker.output,
        requireProduction,
        identityPolicy: worker.identityPolicy,
        verifiedAt: worker.verifiedAt,
        workerInputText: worker.workerInputText,
        workerResultText: worker.workerResultText
      });
      if (replay.status !== 'OK') return replay;
    }

    const ablationProfile = artifactRecord(
      'vnext-ablation-profile',
      'ablation-profile',
      canonicalVNextJson(result.ablationProfile)
    );
    store.writeArtifact(runId, ablationProfile.id, ablationProfile);
    const pipelineReceipt = artifactRecord(
      'vnext-pipeline-receipt',
      'pipeline-receipt',
      canonicalVNextJson(result.receipt)
    );
    store.writeArtifact(runId, pipelineReceipt.id, pipelineReceipt);
    const stages = result.stages.map((stage, index) => {
      const record = artifactRecord(
        `vnext-stage-${String(index + 1).padStart(3, '0')}`,
        `stage-${stage.stage}`,
        canonicalVNextJson(stage)
      );
      store.writeArtifact(runId, record.id, record);
      return { ...stageRef(stage), artifact: artifactRef(record) };
    });
    const workers = workerEvidence.map((worker, index) => {
      const prefix = `vnext-worker-${String(index + 1).padStart(3, '0')}`;
      const values = {
        contract: worker.contract,
        receipt: worker.receipt,
        output: worker.output,
        identityPolicy: worker.identityPolicy,
        verifiedAt: worker.verifiedAt,
        modelIdentityReceipt: worker.modelIdentityReceipt
      };
      const refs = {};
      for (const [key, value] of Object.entries(values)) {
        const record = artifactRecord(
          `${prefix}-${key.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`,
          `worker-${key}`,
          canonicalVNextJson(value)
        );
        store.writeArtifact(runId, record.id, record);
        refs[key] = artifactRef(record);
      }
      for (const [key, text] of Object.entries({
        workerInput: worker.workerInputText,
        workerResult: worker.workerResultText
      })) {
        const record = artifactRecord(
          `${prefix}-${key.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`,
          key,
          text
        );
        store.writeArtifact(runId, record.id, record);
        refs[key] = artifactRef(record);
      }
      return { role: worker.role, refs };
    });
    let candidateContract = null;
    if (result.candidateContract) {
      const record = artifactRecord(
        'vnext-candidate-contract',
        'candidate-contract',
        canonicalVNextJson(result.candidateContract)
      );
      store.writeArtifact(runId, record.id, record);
      candidateContract = artifactRef(record);
    }
    let resourceBudgetLedger = null;
    if (result.resourceBudgetLedger) {
      const record = artifactRecord(
        'vnext-preparation-resource-budget-ledger',
        'resource-budget-ledger',
        canonicalVNextJson(result.resourceBudgetLedger)
      );
      store.writeArtifact(runId, record.id, record);
      resourceBudgetLedger = artifactRef(record);
    }
    let externalResearchEvidence = null;
    if (result.externalResearchEvidence) {
      const replay = verifyExternalResearchPortableEvidence(
        result.externalResearchEvidence
      );
      if (replay.status !== 'OK') return replay;
      const record = artifactRecord(
        'vnext-external-research-portable-evidence',
        'external-research-portable-evidence',
        canonicalVNextJson(result.externalResearchEvidence)
      );
      store.writeArtifact(runId, record.id, record);
      externalResearchEvidence = artifactRef(record);
    }
    const state = {
      schemaVersion: 1,
      kind: VNEXT_PREPARATION_PROOF_SCHEMA,
      runId,
      pipelineId: result.receipt.pipelineId,
      createdAt: result.receipt.createdAt,
      status: 'SEALED',
      disposition: result.disposition,
      requireProduction,
      ablationProfile: artifactRef(ablationProfile),
      pipelineReceipt: artifactRef(pipelineReceipt),
      stages,
      workers,
      candidateContract,
      resourceBudgetLedger,
      externalResearchEvidence,
      executionBinding: null
    };
    store.save(state);
    const verified = verifyVNextPreparationRun(store, runId);
    return verified.status === 'OK'
      ? { ...verified, idempotent: false }
      : verified;
  } catch (error) {
    return refused('VNEXT_PREPARATION_PERSIST_FAILED', error.message);
  }
}

export function loadVNextPreparationResult(store, runId) {
  try {
    const state = store.load(runId);
    if (!state || state.kind !== VNEXT_PREPARATION_PROOF_SCHEMA
        || state.status !== 'SEALED') {
      return refused('VNEXT_PREPARATION_STATE_INVALID', 'Preparation proof state is missing or invalid.');
    }
    const ablationProfile = parseArtifact(
      store.readArtifact(runId, state.ablationProfile?.id),
      state.ablationProfile
    );
    const receipt = parseArtifact(
      store.readArtifact(runId, state.pipelineReceipt.id),
      state.pipelineReceipt
    );
    const stages = state.stages.map((row) => parseArtifact(
      store.readArtifact(runId, row.artifact.id),
      row.artifact
    ));
    const workers = state.workers.map((row) => {
      const refsValid = Object.values(row.refs).every((ref) => validArtifact(
        store.readArtifact(runId, ref.id),
        ref
      ));
      const readJson = (key) => parseArtifact(
        store.readArtifact(runId, row.refs[key].id),
        row.refs[key]
      );
      const readText = (key) => {
        const record = store.readArtifact(runId, row.refs[key].id);
        return validArtifact(record, row.refs[key]) ? record.content : null;
      };
      return {
        role: row.role,
        contract: readJson('contract'),
        receipt: readJson('receipt'),
        output: readJson('output'),
        identityPolicy: readJson('identityPolicy'),
        verifiedAt: readJson('verifiedAt'),
        modelIdentityReceipt: readJson('modelIdentityReceipt'),
        workerInputText: readText('workerInput'),
        workerResultText: readText('workerResult'),
        refsValid
      };
    });
    const candidateContract = state.candidateContract
      ? parseArtifact(
          store.readArtifact(runId, state.candidateContract.id),
          state.candidateContract
        )
      : null;
    const resourceBudgetLedger = state.resourceBudgetLedger
      ? parseArtifact(
          store.readArtifact(runId, state.resourceBudgetLedger.id),
          state.resourceBudgetLedger
        )
      : null;
    const externalResearchEvidence = state.externalResearchEvidence
      ? parseArtifact(
          store.readArtifact(runId, state.externalResearchEvidence.id),
          state.externalResearchEvidence
        )
      : null;
    if (!ablationProfile
        || validateVNextAblationProfile(ablationProfile).status !== 'OK'
        || !receipt || stages.some((stage) => !stage)
        || workers.some((worker) => !worker.refsValid
          || !worker.contract
          || !worker.receipt
          || !worker.output
          || typeof worker.verifiedAt !== 'string'
          || typeof worker.workerInputText !== 'string'
          || typeof worker.workerResultText !== 'string')
        || (state.candidateContract && !candidateContract)
        || (state.resourceBudgetLedger && !resourceBudgetLedger)
        || (state.externalResearchEvidence && !externalResearchEvidence)) {
      return refused('VNEXT_PREPARATION_ARTIFACT_INVALID', 'Preparation proof artifacts failed hash or JSON replay.');
    }
    const byStage = Object.fromEntries(stages.map((stage) => [stage.stage, stage]));
    return {
      status: 'OK',
      state,
      result: {
        status: 'OK',
        disposition: state.disposition,
        ablationProfile,
        stages,
        workers,
        resourceBudgetLedger,
        externalResearchEvidence,
        receipt,
        candidateContract,
        failure: byStage[VNEXT_STAGE.FAILURE] ?? null,
        retrieval: byStage[VNEXT_STAGE.RETRIEVAL] ?? null,
        externalResearch: byStage[VNEXT_STAGE.EXTERNAL_RESEARCH] ?? null,
        research: byStage[VNEXT_STAGE.INTERNAL_RESEARCH] ?? null,
        dossier: byStage[VNEXT_STAGE.DOSSIER] ?? null,
        hypothesis: byStage[VNEXT_STAGE.HYPOTHESIS] ?? null,
        falsification: byStage[VNEXT_STAGE.FALSIFICATION] ?? null,
        candidate: byStage[VNEXT_STAGE.CANDIDATE] ?? null
      }
    };
  } catch (error) {
    return refused('VNEXT_PREPARATION_LOAD_FAILED', error.message);
  }
}

export function verifyVNextPreparationRun(store, runId) {
  const loaded = loadVNextPreparationResult(store, runId);
  if (loaded.status !== 'OK') return loaded;
  const { state, result } = loaded;
  if (validateVNextPreparationResult(result).status !== 'OK'
      || result.stages.some((stage) => validateVNextStageArtifact(stage).status !== 'OK')
      || canonicalVNextJson(result.stages.map(stageRef))
        !== canonicalVNextJson(result.receipt.stages)) {
    return refused('VNEXT_PREPARATION_PIPELINE_REPLAY_INVALID', 'Pipeline stages or receipt failed replay.');
  }
  const modelIdentityReceipts = [];
  for (const worker of result.workers) {
    const expected = receiptWorker(result, worker);
    const replay = verifyVNextModelWorkerFromDisk({
      contract: worker.contract,
      receipt: worker.receipt,
      output: worker.output,
      requireProduction: state.requireProduction,
      identityPolicy: worker.identityPolicy,
      verifiedAt: worker.verifiedAt,
      workerInputText: worker.workerInputText,
      workerResultText: worker.workerResultText
    });
    if (replay.status !== 'OK'
        || !expected
        || expected.receiptSha256 !== worker.receipt.receiptSha256
        || expected.stateDirectorySha256 !== worker.contract.stateDirectorySha256
        || expected.processIdentity !== worker.receipt.processIdentity
        || expected.productionEvidence !== worker.receipt.productionEvidence
        || expected.modelIdentityReceiptSha256
          !== (replay.modelIdentityReceipt?.receiptSha256 ?? null)
        || canonicalVNextJson(replay.modelIdentityReceipt)
          !== canonicalVNextJson(worker.modelIdentityReceipt)) {
      return refused('VNEXT_PREPARATION_WORKER_REPLAY_INVALID', 'A preparation worker failed portable replay.');
    }
    modelIdentityReceipts.push(replay.modelIdentityReceipt);
  }
  let budgetTotals = null;
  if (result.resourceBudgetLedger) {
    const budget = verifyResourceBudgetLedger(result.resourceBudgetLedger);
    if (budget.status !== 'OK'
        || result.receipt.resourceBudgetLedgerSha256
          !== result.resourceBudgetLedger.ledgerSha256
        || budget.totals.callsReserved !== result.workers.length
        || budget.totals.callsSettled !== result.workers.length) {
      return refused('VNEXT_PREPARATION_BUDGET_REPLAY_INVALID', 'Preparation resource use failed ledger replay.');
    }
    budgetTotals = budget.totals;
  } else if (state.requireProduction || result.receipt.resourceBudgetLedgerSha256 !== null) {
    return refused('VNEXT_PREPARATION_BUDGET_MISSING', 'Production preparation lacks its settled resource ledger.');
  }
  const evidence = {
    schemaVersion: VNEXT_PREPARATION_PROOF_SCHEMA,
    runId,
    pipelineReceiptSha256: result.receipt.receiptSha256,
    ablationProfileSha256: result.ablationProfile.profileSha256,
    stageArtifactSha256s: result.stages.map((stage) => stage.artifactSha256),
    workerReceiptSha256s: result.workers.map((worker) => worker.receipt.receiptSha256),
    modelIdentityReceiptSha256s: modelIdentityReceipts.map((receipt) => (
      receipt?.receiptSha256 ?? null
    )),
    resourceBudgetLedgerSha256: result.resourceBudgetLedger?.ledgerSha256 ?? null,
    externalResearchEvidenceSha256:
      result.externalResearchEvidence?.evidenceSha256 ?? null,
    productionEvidence: state.requireProduction,
    budgetTotals
  };
  return {
    status: 'OK',
    state,
    result,
    evidence,
    evidenceSha256: sha256(canonicalVNextJson(evidence))
  };
}
