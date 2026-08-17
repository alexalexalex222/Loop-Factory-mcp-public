import { sha256 } from './util.mjs';
import { isAbsolute } from 'node:path';
import { canonicalVNextJson, validateVNextStageArtifact } from './vnext-contracts.mjs';
import { normalizeVNextFailure } from './vnext-failure.mjs';
import { buildHybridRetrieval, validateHybridRetrievalReceipt } from './hybrid-retrieval.mjs';
import {
  buildAblationBaselineResearchArtifact,
  buildResearchSynthesisArtifact,
  buildResearchSynthesisContract,
  buildResearchSynthesisPrompt,
  freezeExternalResearch,
  freezeVerifiedExternalResearch
} from './vnext-research.mjs';
import {
  buildExternalResearchDiscoveryContract,
  buildExternalResearchDiscoveryPrompt,
  materializeExternalResearchPlan,
  validateExternalResearchPolicy
} from './vnext-external-research.mjs';
import {
  createExternalResearchPortableEvidence,
  fetchExternalResearchPlan,
  verifyExternalResearchPortableEvidence
} from './vnext-external-research-worker.mjs';
import { buildResearchDossier, validateResearchDossier } from './research-dossier.mjs';
import { verifyVNextEvidenceRecordAuthority } from './vnext-evidence-bank.mjs';
import {
  buildVNextHypothesisArtifact,
  buildVNextHypothesisContract,
  buildVNextHypothesisPrompt
} from './vnext-hypothesis.mjs';
import {
  buildAblationBaselineFalsificationArtifact,
  buildHypothesisFalsificationArtifact,
  buildHypothesisFalsifierContract,
  buildHypothesisFalsifierPrompt
} from './hypothesis-falsifier.mjs';
import {
  buildCandidateStageArtifact,
  createCandidateGeneratorRegistry,
  getCandidateGenerator
} from './vnext-candidate-generators.mjs';
import {
  candidateStrategyRequiredEvidenceIds
} from './vnext-candidate-strategies.mjs';
import { verifyVNextModelWorkerFromDisk } from './vnext-model-worker.mjs';
import {
  reserveResourceBudget,
  settleResourceBudget,
  verifyResourceBudgetLedger
} from './resource-budget.mjs';
import {
  validateVNextAblationPreparation,
  validateVNextAblationProfile
} from './vnext-ablation-profile.mjs';

export const VNEXT_PREPARATION_PIPELINE_SCHEMA = 'vnext-preparation-pipeline-v1';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function authorityFor(role, run) {
  return {
    actorId: `vnext-${role}`,
    kind: 'isolated-model-worker',
    model: run.contract.model,
    promptSha256: run.contract.promptSha256,
    toolPolicy: run.contract.toolPolicy
  };
}

function stageRef(artifact) {
  return {
    id: artifact.artifactId,
    stage: artifact.stage,
    status: artifact.status,
    sha256: artifact.artifactSha256
  };
}

function evidenceById({ dossier, retrieval, records }) {
  const result = new Map();
  for (const row of dossier.payload.items) result.set(row.id, row.itemSha256);
  for (const row of dossier.payload.sourceIndex) result.set(row.id, row.sha256);
  const recordById = new Map(records.map((record) => [record.recordId, record]));
  for (const row of retrieval.payload.selection) {
    result.set(row.recordId, recordById.get(row.recordId)?.recordSha256 ?? row.recordSha256);
  }
  return result;
}

function contradictionStatements(selection) {
  return selection
    .filter((row) => ['contradiction', 'regression', 'failure', 'no-improvement'].includes(row.kind))
    .map((row) => {
      const statement = row.content?.statement ?? row.content?.summary;
      return typeof statement === 'string' && statement.trim()
        ? statement.trim()
        : `Negative precedent ${row.recordId}`;
    });
}

function pipelineReceipt({
  pipelineId,
  createdAt,
  disposition,
  stages,
  workers,
  revisionCount,
  ablationProfile,
  resourceBudgetLedger
}) {
  const stateDirectories = workers.map(({ contract }) => contract.stateDirectory);
  const processIdentities = workers.map(({ receipt }) => receipt.processIdentity);
  const contextIsolationPassed = new Set(stateDirectories).size === stateDirectories.length
    && new Set(processIdentities).size === processIdentities.length;
  const core = {
    schemaVersion: VNEXT_PREPARATION_PIPELINE_SCHEMA,
    pipelineId,
    createdAt,
    disposition,
    revisionCount,
    ablationProfileSha256: ablationProfile.profileSha256,
    stages: stages.map(stageRef),
    workers: workers.map(({ role, contract, receipt, modelIdentityReceipt }) => ({
      role,
      kind: contract.kind,
      contractSha256: contract.contractSha256,
      receiptSha256: receipt.receiptSha256,
      stateDirectorySha256: contract.stateDirectorySha256,
      processIdentity: receipt.processIdentity,
      productionEvidence: receipt.productionEvidence,
      modelIdentityReceiptSha256: modelIdentityReceipt?.receiptSha256 ?? null
    })),
    contextIsolationPassed,
    resourceBudgetLedgerSha256: resourceBudgetLedger?.ledgerSha256 ?? null,
    executionAuthority: false,
    activationAuthority: false
  };
  return { ...core, receiptSha256: sha256(canonicalVNextJson(core)) };
}

export async function prepareVNextCandidate(input = {}) {
  if (typeof input.invokeModel !== 'function'
      || typeof input.pipelineId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.pipelineId)
      || typeof input.createdAt !== 'string'
      || !Number.isFinite(Date.parse(input.createdAt))
      || !plainObject(input.modelPolicy)
      || !Array.isArray(input.evidenceRecords)
      || !plainObject(input.publicMeasurementContract)
      || validateVNextAblationProfile(input.ablationProfile).status !== 'OK'
      || validateVNextAblationPreparation(input.ablationProfile, {
        internalResearchEnabled: input.ablationProfile?.internalResearchEnabled,
        hypothesisFalsificationEnabled:
          input.ablationProfile?.hypothesisFalsificationEnabled,
        enableModelReranker: input.enableModelReranker,
        candidateStrategy: input.candidateStrategy
      }).status !== 'OK') {
    return refused('VNEXT_PIPELINE_INPUT_INVALID', 'Pipeline requires a frozen identity, model policy, evidence set, measurement contract, and isolated model invoker.');
  }
  const stages = [];
  const workers = [];
  const ablationProfile = input.ablationProfile;
  const requireProduction = input.requireProductionWorkerEvidence !== false;
  if (requireProduction && input.allowFixtureRecords === true) {
    return refused(
      'VNEXT_PIPELINE_FIXTURE_EVIDENCE_FORBIDDEN',
      'Production preparation cannot enable fixture evidence.'
    );
  }
  if (requireProduction) {
    for (const record of input.evidenceRecords) {
      if (record?.verifierEligible !== true) continue;
      const authority = verifyVNextEvidenceRecordAuthority(record, {
        authorityVerifier: input.evidenceAuthorityVerifier
      });
      if (authority.status !== 'OK') {
        return refused(
          'VNEXT_PIPELINE_EVIDENCE_AUTHORITY_INVALID',
          'Production preparation requires every eligible memory record to replay from its local source store.',
          { recordId: record?.recordId ?? null, authority }
        );
      }
    }
  }
  let resourceBudgetLedger = input.resourceBudgetLedger ?? null;
  if (requireProduction && (
    !resourceBudgetLedger
    || verifyResourceBudgetLedger(resourceBudgetLedger).status !== 'OK'
    || !plainObject(input.callBudgets)
  )) {
    return refused('VNEXT_PIPELINE_RESOURCE_BUDGET_REQUIRED', 'Production preparation requires a valid hard budget ledger and per-role call reservations.');
  }
  let sequence = 0;
  const invoke = async (role, kind, prompt, inputRefs, permittedInformation, forbiddenInformation) => {
    const route = input.modelPolicy[role];
    if (!plainObject(route) || typeof route.model !== 'string'
        || typeof route.reasoningEffort !== 'string'
        || (requireProduction && !plainObject(route.identityPolicy))) {
      return refused('VNEXT_PIPELINE_MODEL_POLICY_INVALID', `Missing model policy for ${role}.`);
    }
    sequence += 1;
    let reservation = null;
    if (resourceBudgetLedger) {
      const budgetRole = role.startsWith('falsifier-')
        ? 'falsifier'
        : (role === 'hypothesis-reviser' ? 'hypothesizer' : role);
      const callBudget = input.callBudgets?.[budgetRole] ?? input.callBudgets?.[kind];
      if (!plainObject(callBudget)) {
        return refused('VNEXT_PIPELINE_CALL_BUDGET_MISSING', `No call budget is frozen for ${budgetRole}.`);
      }
      const reserved = reserveResourceBudget(resourceBudgetLedger, {
        callId: `${input.pipelineId}-${String(sequence).padStart(2, '0')}-${role}`,
        maxInputTokens: callBudget.maxInputTokens,
        maxOutputTokens: callBudget.maxOutputTokens,
        createdAt: new Date(Date.parse(input.createdAt) + sequence).toISOString()
      });
      if (reserved.status !== 'OK') return reserved;
      resourceBudgetLedger = reserved.ledger;
      reservation = reserved.reservation;
      if (typeof input.onBudgetLedgerChanged === 'function') {
        const persisted = await input.onBudgetLedgerChanged({
          kind: 'reservation',
          role,
          callId: reservation.callId,
          reservation,
          settlement: null,
          ledger: resourceBudgetLedger
        });
        if (persisted?.status !== 'OK') {
          return persisted ?? refused(
            'VNEXT_PIPELINE_BUDGET_CHECKPOINT_FAILED',
            `${role} budget reservation was not durably checkpointed.`
          );
        }
      }
    }
    const result = await input.invokeModel({
      role,
      invocationId: `${input.pipelineId}-${String(sequence).padStart(2, '0')}-${role}`,
      kind,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      prompt,
      inputRefs,
      permittedInformation,
      forbiddenInformation
    });
    if (result?.status !== 'OK') return result ?? refused('VNEXT_PIPELINE_MODEL_FAILED', `${role} returned no evidence.`);
    const verifiedAt = new Date(Date.parse(input.createdAt) + sequence + 2).toISOString();
    const replay = verifyVNextModelWorkerFromDisk({
      contract: result.contract,
      receipt: result.receipt,
      output: result.output,
      requireProduction,
      identityPolicy: route.identityPolicy ?? null,
      verifiedAt
    });
    if (replay.status !== 'OK' || result.contract.kind !== kind
        || result.contract.promptSha256 !== sha256(prompt)
        || result.contract.model !== route.model
        || result.contract.reasoningEffort !== route.reasoningEffort) {
      return refused('VNEXT_PIPELINE_MODEL_EVIDENCE_INVALID', `${role} worker evidence failed disk replay or route binding.`);
    }
    if (resourceBudgetLedger) {
      const details = result.receipt.tokenUsageDetails;
      const inputTokens = Number(details?.inputTokens ?? 0)
        + Number(details?.cacheCreationInputTokens ?? 0)
        + Number(details?.cacheReadInputTokens ?? 0);
      const outputTokens = Number(details?.outputTokens);
      if (!Number.isInteger(inputTokens) || inputTokens < 0
          || !Number.isInteger(outputTokens) || outputTokens < 0
          || !['cli-receipt', 'provider-receipt'].includes(result.receipt.tokenUsageAuthority)) {
        return refused('VNEXT_PIPELINE_USAGE_RECEIPT_REQUIRED', `${role} did not return trusted token usage.`);
      }
      const settled = settleResourceBudget(resourceBudgetLedger, {
        reservationId: reservation.reservationId,
        inputTokens,
        outputTokens,
        settledAt: new Date(Date.parse(input.createdAt) + sequence + 1).toISOString(),
        usageAuthority: result.receipt.tokenUsageAuthority
      });
      resourceBudgetLedger = settled.ledger;
      let persisted = null;
      if (typeof input.onBudgetLedgerChanged === 'function') {
        persisted = await input.onBudgetLedgerChanged({
          kind: settled.status === 'BLOCKED' ? 'breach' : 'settlement',
          role,
          callId: reservation.callId,
          reservation,
          settlement: settled.settlement,
          ledger: resourceBudgetLedger
        });
        if (persisted?.status !== 'OK') {
          return persisted ?? refused(
            'VNEXT_PIPELINE_BUDGET_CHECKPOINT_FAILED',
            `${role} budget settlement was not durably checkpointed.`
          );
        }
      }
      if (settled.status !== 'OK') {
        return {
          ...settled,
          breachEvidence: persisted?.evidence ?? null
        };
      }
    }
    workers.push({
      role,
      contract: result.contract,
      receipt: result.receipt,
      output: result.output,
      identityPolicy: route.identityPolicy ?? null,
      verifiedAt,
      modelIdentityReceipt: replay.modelIdentityReceipt
    });
    if (typeof input.onWorkerCompleted === 'function') {
      input.onWorkerCompleted({
        role,
        receiptSha256: result.receipt.receiptSha256,
        resourceBudgetLedgerSha256: resourceBudgetLedger?.ledgerSha256 ?? null
      });
    }
    return result;
  };

  const failure = normalizeVNextFailure({ ...input.failure, observedAt: input.createdAt });
  if (failure.status !== 'OK') return failure;
  stages.push(failure.artifact);

  let rerankerRun = null;
  const retrieval = await buildHybridRetrieval({
    records: input.evidenceRecords,
    query: input.retrievalQuery ?? {
      summary: failure.artifact.payload.summary,
      behavior: failure.artifact.payload.behavior,
      component: failure.artifact.payload.component,
      uncertainty: input.queryUncertainty ?? 0.5
    },
    queryAt: input.createdAt,
    compatibility: input.compatibility ?? {},
    embeddings: input.embeddings ?? {},
    queryEmbedding: input.queryEmbedding ?? null,
    maximumCandidates: input.maximumCandidates ?? 64,
    maximumSelected: input.maximumSelected ?? 4,
    allowFixtureRecords: input.allowFixtureRecords === true,
    exploreUncertainty: input.exploreUncertainty === true,
    rerankerWorker: input.enableModelReranker === false ? null : async (packet) => {
      const refs = packet.candidates.map((row) => ({
        id: row.recordId,
        schemaVersion: 'vnext-evidence-record-v1',
        sha256: row.recordSha256
      }));
      rerankerRun = await invoke(
        'reranker',
        'reranker',
        ['Rank only the eligible evidence rows in this frozen packet.', 'Return strict JSON matching vnext-reranker-output-v1. You cannot activate or restore records.', '', canonicalVNextJson(packet)].join('\n'),
        refs,
        ['normalized failure', 'eligible evidence records'],
        ['activation authority', 'final sealed tasks', 'future outcomes', 'quarantined records']
      );
      return rerankerRun.status === 'OK' ? rerankerRun.output : { invalidWorkerOutput: true };
    }
  });
  if (!retrieval.artifact || validateHybridRetrievalReceipt(retrieval.artifact).status !== 'OK') return retrieval;
  if (rerankerRun && rerankerRun.status !== 'OK') return rerankerRun;
  stages.push(retrieval.artifact);

  let externalResearchEvidence = null;
  let decisionAt = input.createdAt;
  let external;
  if (input.externalResearchEnabled === true) {
    if (input.sealedMode === true) {
      return refused(
        'VNEXT_PIPELINE_EXTERNAL_RESEARCH_SEALED',
        'External research is forbidden in sealed mode.'
      );
    }
    const policy = validateExternalResearchPolicy(input.externalResearchPolicy);
    if (policy.status !== 'OK'
        || typeof input.externalResearchStateRoot !== 'string'
        || !isAbsolute(input.externalResearchStateRoot)
        || (requireProduction && (input.externalSources?.length ?? 0) > 0)
        || (requireProduction && input.externalResearchTransport != null)) {
      return refused(
        'VNEXT_PIPELINE_EXTERNAL_RESEARCH_POLICY_REQUIRED',
        'Production external research requires a frozen policy, isolated state root, and deterministic production transport.'
      );
    }
    const discoveryAt = requireProduction
      ? new Date().toISOString()
      : (input.externalResearchDecisionAt ?? input.createdAt);
    const discovery = buildExternalResearchDiscoveryContract({
      createdAt: discoveryAt,
      failureArtifact: failure.artifact,
      retrievalArtifact: retrieval.artifact,
      policy: policy.policy
    });
    if (discovery.status !== 'OK') return discovery;
    const discoveryRun = await invoke(
      'external-researcher',
      'external-research-discovery',
      buildExternalResearchDiscoveryPrompt(discovery.contract),
      [discovery.contract.failureRef, discovery.contract.retrievalRef]
        .map((ref) => ({
          id: ref.id,
          schemaVersion: 'loop-factory-vnext-stage-envelope-v1',
          sha256: ref.sha256
        })),
      discovery.contract.permittedInformation,
      discovery.contract.forbiddenInformation
    );
    if (discoveryRun.status !== 'OK') return discoveryRun;
    const planned = materializeExternalResearchPlan({
      contract: discovery.contract,
      output: discoveryRun.output,
      planId: `${input.pipelineId}-external-research`,
      createdAt: discoveryAt
    });
    if (planned.status !== 'OK') return planned;
    const fetched = await fetchExternalResearchPlan({
      plan: planned.plan,
      stateRoot: input.externalResearchStateRoot,
      transport: requireProduction ? null : (input.externalResearchTransport ?? null),
      allowTestTransport: !requireProduction && input.externalResearchTransport != null,
      now: !requireProduction && typeof input.externalResearchNow === 'function'
        ? input.externalResearchNow
        : undefined
    });
    if (fetched.status !== 'OK') return fetched;
    const portable = createExternalResearchPortableEvidence({ runDir: fetched.runDir });
    if (portable.status !== 'OK') return portable;
    externalResearchEvidence = portable.evidence;
    external = freezeVerifiedExternalResearch({ evidence: externalResearchEvidence });
    if (external.status === 'OK') decisionAt = external.artifact.createdAt;
  } else {
    external = freezeExternalResearch({
      createdAt: input.createdAt,
      enabled: false,
      sealedMode: input.sealedMode === true,
      sources: [],
      allowlist: []
    });
  }
  if (external.status !== 'OK') return external;
  stages.push(external.artifact);

  const researchContract = buildResearchSynthesisContract({
    createdAt: decisionAt,
    failureArtifact: failure.artifact,
    retrievalArtifact: retrieval.artifact,
    externalResearchArtifact: external.artifact,
    architectureFacts: input.architectureFacts ?? {}
  });
  if (researchContract.status !== 'OK') return researchContract;
  let research;
  if (ablationProfile.internalResearchEnabled) {
    const researchPrompt = buildResearchSynthesisPrompt(researchContract.contract);
    const researchRun = await invoke(
      'researcher', 'research', researchPrompt,
      [researchContract.contract.failureRef, researchContract.contract.retrievalRef, researchContract.contract.externalResearchRef]
        .map((ref) => ({ id: ref.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: ref.sha256 })),
      researchContract.contract.permittedInformation,
      researchContract.contract.forbiddenInformation
    );
    if (researchRun.status !== 'OK') return researchRun;
    research = buildResearchSynthesisArtifact({
      contract: researchContract.contract,
      output: researchRun.output,
      authority: authorityFor('researcher', researchRun)
    });
  } else {
    research = buildAblationBaselineResearchArtifact({
      contract: researchContract.contract,
      profile: ablationProfile
    });
  }
  if (research.status !== 'OK') return research;
  stages.push(research.artifact);

  const selectedIds = new Set(retrieval.artifact.payload.selection.map(({ recordId }) => recordId));
  const selectedRecords = input.evidenceRecords.filter(({ recordId }) => selectedIds.has(recordId));
  const dossier = buildResearchDossier({
    decisionTime: decisionAt,
    failureArtifact: failure.artifact,
    failureSummary: failure.artifact.payload.summary,
    internalEvidence: selectedRecords,
    allowFixtureRecords: input.allowFixtureRecords === true,
    researchArtifact: research.artifact,
    externalResearchEnabled: external.artifact.payload.enabled,
    sealedMode: input.sealedMode === true,
    externalSources: external.artifact.payload.sources,
    externalSourceAllowlist: external.artifact.payload.sources.map((source) => (
      new URL(source.url).hostname.toLowerCase()
    )),
    architectureConstraints: input.architectureConstraints ?? [],
    contradictions: contradictionStatements(retrieval.artifact.payload.selection),
    maximumItems: input.dossierMaximumItems ?? 64,
    maximumBytes: input.dossierMaximumBytes ?? 64 * 1024
  });
  if (dossier.status !== 'OK' || validateResearchDossier(dossier.artifact).status !== 'OK') return dossier;
  stages.push(dossier.artifact);

  const requiredStrategyEvidenceIds = candidateStrategyRequiredEvidenceIds(
    input.candidateStrategy ?? 'native',
    input.candidateStrategyState ?? null
  );
  if (requiredStrategyEvidenceIds == null) {
    return refused(
      'VNEXT_PIPELINE_STRATEGY_EVIDENCE_INVALID',
      'The frozen candidate strategy state does not expose valid evidence identities.'
    );
  }

  const buildHypothesis = async ({ revisionNumber, priorHypothesisArtifact = null, falsificationArtifact = null }) => {
    const built = buildVNextHypothesisContract({
      createdAt: decisionAt,
      dossierArtifact: dossier.artifact,
      retrievalArtifact: retrieval.artifact,
      researchArtifact: research.artifact,
      behaviorMap: input.behaviorMap,
      targetBehaviorIds: input.targetBehaviorIds,
      feedbackArtifacts: input.feedbackArtifacts ?? [],
      parentArtifactSha256: input.parentArtifactSha256,
      requiredEvidenceIds: requiredStrategyEvidenceIds,
      revisionNumber,
      priorHypothesisArtifact,
      falsificationArtifact
    });
    if (built.status !== 'OK') return built;
    const prompt = buildVNextHypothesisPrompt(built.contract);
    const run = await invoke(
      revisionNumber ? 'hypothesis-reviser' : 'hypothesizer',
      'hypothesis', prompt,
      [built.contract.dossierRef, built.contract.retrievalRef, built.contract.researchRef]
        .map((ref) => ({ id: ref.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: ref.sha256 })),
      built.contract.permittedInformation,
      built.contract.forbiddenInformation
    );
    if (run.status !== 'OK') return run;
    return buildVNextHypothesisArtifact({
      contract: built.contract,
      output: run.output,
      authority: authorityFor(revisionNumber ? 'hypothesis-reviser' : 'hypothesizer', run)
    });
  };

  const falsify = async (hypothesisArtifact, suffix) => {
    const built = buildHypothesisFalsifierContract({
      createdAt: decisionAt,
      hypothesisArtifact,
      dossierArtifact: dossier.artifact,
      evidenceRecords: selectedRecords,
      allowFixtureRecords: input.allowFixtureRecords === true,
      architectureFacts: input.architectureFacts ?? {},
      publicMeasurementContract: input.publicMeasurementContract
    });
    if (built.status !== 'OK') return built;
    if (!ablationProfile.hypothesisFalsificationEnabled) {
      return buildAblationBaselineFalsificationArtifact({
        contract: built.contract,
        profile: ablationProfile
      });
    }
    const prompt = buildHypothesisFalsifierPrompt(built.contract);
    const run = await invoke(
      `falsifier-${suffix}`, 'falsification', prompt,
      [built.contract.hypothesisRef, built.contract.dossierRef]
        .map((ref) => ({ id: ref.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: ref.sha256 })),
      built.contract.permittedInformation,
      built.contract.forbiddenInformation
    );
    if (run.status !== 'OK') return run;
    return buildHypothesisFalsificationArtifact({
      contract: built.contract,
      output: run.output,
      authority: authorityFor(`falsifier-${suffix}`, run)
    });
  };

  let hypothesis = await buildHypothesis({ revisionNumber: 0 });
  if (hypothesis.status !== 'OK') return hypothesis;
  stages.push(hypothesis.artifact);
  let falsification = await falsify(hypothesis.artifact, 'initial');
  if (falsification.status !== 'OK') return falsification;
  stages.push(falsification.artifact);
  let revisionCount = 0;
  if (falsification.artifact.payload.falsification.verdict === 'REVISE') {
    revisionCount = 1;
    const revised = await buildHypothesis({
      revisionNumber: 1,
      priorHypothesisArtifact: hypothesis.artifact,
      falsificationArtifact: falsification.artifact
    });
    if (revised.status !== 'OK') return revised;
    hypothesis = revised;
    stages.push(hypothesis.artifact);
    falsification = await falsify(hypothesis.artifact, 'revision');
    if (falsification.status !== 'OK') return falsification;
    stages.push(falsification.artifact);
  }

  if (falsification.artifact.payload.falsification.verdict !== 'TEST') {
    const receipt = pipelineReceipt({
      pipelineId: input.pipelineId,
      createdAt: input.createdAt,
      disposition: 'HYPOTHESIS_REJECTED',
      stages,
      workers,
      revisionCount,
      ablationProfile,
      resourceBudgetLedger
    });
    return receipt.contextIsolationPassed
      ? {
          status: 'OK', disposition: 'HYPOTHESIS_REJECTED', stages, workers,
          ablationProfile,
          externalResearchEvidence, resourceBudgetLedger, receipt
        }
      : refused('VNEXT_PIPELINE_CONTEXT_REUSED', 'Model contexts were reused across independent roles.');
  }

  const hypothesisOutput = hypothesis.artifact.payload.hypothesis;
  if (input.requiredComponent != null
      && hypothesisOutput.component !== input.requiredComponent) {
    const receipt = pipelineReceipt({
      pipelineId: input.pipelineId,
      createdAt: input.createdAt,
      disposition: 'HYPOTHESIS_OUT_OF_SCOPE',
      stages,
      workers,
      revisionCount,
      ablationProfile,
      resourceBudgetLedger
    });
    return receipt.contextIsolationPassed
      ? {
          status: 'OK',
          disposition: 'HYPOTHESIS_OUT_OF_SCOPE',
          stages,
          workers,
          ablationProfile,
          externalResearchEvidence,
          resourceBudgetLedger,
          receipt
        }
      : refused('VNEXT_PIPELINE_CONTEXT_REUSED', 'Model contexts were reused across independent roles.');
  }
  const evidenceHashes = evidenceById({
    dossier: dossier.artifact,
    retrieval: retrieval.artifact,
    records: input.evidenceRecords
  });
  const selectedEvidence = hypothesisOutput.evidenceIds.map((id) => ({
    id,
    sha256: evidenceHashes.get(id)
  }));
  if (selectedEvidence.some(({ sha256: digest }) => !/^[a-f0-9]{64}$/.test(String(digest || '')))) {
    return refused('VNEXT_PIPELINE_EVIDENCE_HASH_MISSING', 'Hypothesis evidence lacks an immutable source hash.');
  }
  const registry = createCandidateGeneratorRegistry(input.candidateFeatureFlags ?? {});
  const selected = getCandidateGenerator(registry, input.candidateStrategy ?? 'native');
  if (selected.status !== 'OK') return selected;
  const candidateContract = selected.plugin.createContract({
    hypothesisArtifact: hypothesis.artifact,
    falsificationArtifact: falsification.artifact,
    retrievalArtifact: retrieval.artifact,
    selectedEvidence,
    behaviorMap: input.behaviorMap,
    allowedComponent: hypothesisOutput.component,
    parentArtifact: input.parentArtifact,
    parentItemHashes: input.parentItemHashes,
    maxOperations: input.maxOperations ?? 1,
    protectedSurfaces: input.protectedSurfaces,
    taskAgnostic: true,
    strategyState: input.candidateStrategyState ?? null
  });
  if (candidateContract.status !== 'OK') return candidateContract;
  const candidatePrompt = selected.plugin.buildPrompt(candidateContract.contract);
  const candidateRun = await invoke(
    'candidate-generator', 'candidate', candidatePrompt,
    [candidateContract.contract.hypothesisRef, candidateContract.contract.falsificationRef, candidateContract.contract.retrievalRef],
    ['frozen hypothesis', 'independent falsification', 'selected evidence', 'bounded parent component'],
    ['evaluator state', 'final sealed tasks', 'promotion authority', 'protected surfaces', 'statistical gate']
  );
  if (candidateRun.status !== 'OK') return candidateRun;
  const verified = selected.plugin.verifyCandidate(candidateRun.output, candidateContract.contract);
  if (verified.status !== 'OK') return verified;
  const candidate = buildCandidateStageArtifact({
    candidate: verified.candidate,
    verification: verified.verification,
    contract: candidateContract.contract,
    createdAt: decisionAt,
    authority: authorityFor('candidate-generator', candidateRun)
  });
  if (candidate.status !== 'OK') return candidate;
  stages.push(candidate.artifact);

  const receipt = pipelineReceipt({
    pipelineId: input.pipelineId,
    createdAt: input.createdAt,
    disposition: 'CANDIDATE_READY_FOR_EXPERIMENT',
    stages,
    workers,
    revisionCount,
    ablationProfile,
    resourceBudgetLedger
  });
  if (!receipt.contextIsolationPassed) {
    return refused('VNEXT_PIPELINE_CONTEXT_REUSED', 'Model contexts were reused across independent roles.');
  }
  return {
    status: 'OK',
    disposition: 'CANDIDATE_READY_FOR_EXPERIMENT',
    failure: failure.artifact,
    retrieval: retrieval.artifact,
    externalResearch: external.artifact,
    research: research.artifact,
    dossier: dossier.artifact,
    hypothesis: hypothesis.artifact,
    falsification: falsification.artifact,
    candidate: candidate.artifact,
    candidateContract: candidateContract.contract,
    stages,
    workers,
    ablationProfile,
    externalResearchEvidence,
    resourceBudgetLedger,
    receipt
  };
}

export function validateVNextPreparationResult(result) {
  const externalStage = Array.isArray(result?.stages)
    ? result.stages.find((artifact) => artifact.stage === 'external-research')
    : null;
  const fetchedEvidenceRequired = externalStage?.payload?.networkFetchPerformedByStage === true;
  const fetchedEvidence = fetchedEvidenceRequired
    ? verifyExternalResearchPortableEvidence(result.externalResearchEvidence)
    : null;
  if (!plainObject(result) || result.status !== 'OK'
      || !plainObject(result.receipt)
      || validateVNextAblationProfile(result.ablationProfile).status !== 'OK'
      || result.receipt.schemaVersion !== VNEXT_PREPARATION_PIPELINE_SCHEMA
      || result.receipt.ablationProfileSha256
        !== result.ablationProfile.profileSha256
      || result.receipt.activationAuthority !== false
      || result.receipt.executionAuthority !== false
      || result.receipt.contextIsolationPassed !== true
      || !Array.isArray(result.stages)
      || result.stages.some((artifact) => validateVNextStageArtifact(artifact).status !== 'OK')
      || fetchedEvidenceRequired && (
        fetchedEvidence?.status !== 'OK'
        || fetchedEvidence.evidenceSha256 !== externalStage.payload.fetchEvidenceSha256
        || fetchedEvidence.plan.planSha256 !== externalStage.payload.fetchPlanSha256
        || fetchedEvidence.receipt.receiptSha256
          !== externalStage.payload.fetchReceiptSha256
      )
      || !fetchedEvidenceRequired && result.externalResearchEvidence != null) {
    return refused('VNEXT_PIPELINE_RESULT_INVALID', 'Preparation pipeline result is incomplete or authority-bearing.');
  }
  const core = structuredClone(result.receipt);
  delete core.receiptSha256;
  if (sha256(canonicalVNextJson(core)) !== result.receipt.receiptSha256
      || canonicalVNextJson(result.stages.map(stageRef))
        !== canonicalVNextJson(result.receipt.stages)) {
    return refused('VNEXT_PIPELINE_RESULT_TAMPERED', 'Preparation pipeline receipt failed replay.');
  }
  return { status: 'OK', result };
}
