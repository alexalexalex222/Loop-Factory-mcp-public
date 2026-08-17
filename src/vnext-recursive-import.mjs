import { sha256 } from './util.mjs';
import { canonicalVNextJson, VNEXT_STAGE } from './vnext-contracts.mjs';
import {
  createVNextEvidenceRecord,
  appendVNextEvidenceRecord,
  createVerifierOwnedVNextEvidenceAuthority
} from './vnext-evidence-bank.mjs';
import {
  createVNextEvidenceAuthorityVerifier
} from './vnext-evidence-authority.mjs';
import {
  verifyAdaptiveRecursiveCanaryV2Run
} from './adaptive-recursive-runner-v2.mjs';
import {
  verifyAdaptiveRecursiveVNextLeaseReceipt
} from './adaptive-recursive-vnext-run.mjs';
import {
  verifyVNextPreparationRun
} from './vnext-preparation-store.mjs';
import { verifyResourceBudgetLedger } from './resource-budget.mjs';
import {
  persistAdaptiveRecursiveCanaryV2DevelopmentResult,
  persistAdaptiveRecursiveCanaryV2Result
} from './mechanism-catalog.mjs';
import {
  commitVNextRecursiveImportTransaction,
  persistVNextRecursiveImportPending
} from './vnext-recursive-import-transaction.mjs';

export const VNEXT_RECURSIVE_IMPORT_SCHEMA = 'vnext-recursive-import-v1';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function artifactValid(artifact, ref) {
  return artifact && ref
    && typeof artifact.content === 'string'
    && artifact.sha256 === ref.sha256
    && artifact.sha256 === sha256(artifact.content);
}

function parseConfig(store, runId, state) {
  const ref = state?.evidenceArtifacts?.config;
  const artifact = ref?.id ? store.readArtifact(runId, ref.id) : null;
  if (!artifactValid(artifact, ref)) return null;
  try { return JSON.parse(artifact.content); } catch { return null; }
}

function stage(result, name) {
  return [...(result?.stages || [])].reverse().find((artifact) => (
    artifact.stage === name
  )) ?? null;
}

function outcomeKind(verification) {
  const confirmation = verification.confirmationAnalysis?.summary;
  if ((confirmation?.targetRegressions || 0) > 0
      || (confirmation?.controlRegressions || 0) > 0) return 'regression';
  return verification.causalPass ? 'positive' : 'no-improvement';
}

function compatibility(config, hypothesis, partition) {
  const fingerprint = config.candidateFamily.causalFingerprint;
  const applicability = fingerprint.applicability;
  return {
    domains: [],
    tags: [
      fingerprint.bottleneckKind,
      fingerprint.interventionKind,
      fingerprint.operationKind,
      fingerprint.expectedEffectKind,
      ...(applicability.taskModes || []),
      ...(applicability.loopRoles || []),
      ...(applicability.taskValueDimensions || []),
      ...(applicability.resourceDimensions || [])
    ].filter(Boolean),
    component: hypothesis?.component ?? 'mechanism-program',
    schemaVersions: [
      config.schemaVersion,
      config.vnextBinding.schemaVersion,
      config.evolutionRecord.schemaVersion
    ],
    models: [config.model],
    harnessSha256s: [sha256(canonicalVNextJson(config.implementationManifest))],
    toolEnvironmentSha256s: [
      config.runtimeAuthority.binary.sha256,
      config.evaluatorAuthority.authoritySha256
    ],
    permissions: [partition === 'validation' ? 'routing-only' : 'development-only'],
    securityRequirements: [
      'fresh-context-workers',
      'protected-surfaces',
      'strict-model-identity',
      'verifier-owned-admission'
    ],
    versionConstraints: [
      `adapter=${config.vnextBinding.adapterId}`,
      `reasoning=${config.reasoningEffort}`
    ]
  };
}

export function deriveVNextRecursiveEvidence({
  sourceStore,
  runId
} = {}) {
  try {
    const state = sourceStore?.load(runId);
    const config = parseConfig(sourceStore, runId, state);
    const verification = verifyAdaptiveRecursiveCanaryV2Run(sourceStore, runId);
    const partition = config?.vnextBinding?.taskPartition;
    if (!['development', 'validation'].includes(partition)
        || !state || !config?.vnextBinding
        || verification.experimentValid !== true
        || verification.gates?.vnextExecutionBinding !== true
        || verification.gates?.paceEvidence !== true) {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_NOT_ELIGIBLE',
        'Import requires one currently valid VNext-bound recursive experiment.'
      );
    }
    const lease = verifyAdaptiveRecursiveVNextLeaseReceipt(sourceStore, runId);
    const preparation = verifyVNextPreparationRun(
      sourceStore,
      config.vnextBinding.preparationRunId
    );
    const budget = verifyResourceBudgetLedger(verification.resourceBudgetLedger);
    if (lease.status !== 'OK'
        || preparation.status !== 'OK'
        || preparation.evidenceSha256
          !== config.vnextBinding.preparationVerifierEvidenceSha256
        || budget.status !== 'OK') {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_PROOF_INVALID',
        'Lease, preparation, execution, or resource evidence failed replay.',
        { lease, preparation, budget }
      );
    }
    const hypothesisArtifact = stage(preparation.result, VNEXT_STAGE.HYPOTHESIS);
    const candidateArtifact = stage(preparation.result, VNEXT_STAGE.CANDIDATE);
    const hypothesis = hypothesisArtifact?.payload?.hypothesis ?? null;
    const candidate = candidateArtifact?.payload?.candidate ?? null;
    if (!hypothesis || !candidate
        || candidateArtifact.artifactSha256
          !== config.vnextBinding.candidateArtifactSha256) {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_CANDIDATE_INVALID',
        'The preparation proof no longer exposes the bound hypothesis and candidate.'
      );
    }
    const kind = outcomeKind(verification);
    const positive = kind === 'positive';
    const regressed = kind === 'regression';
    const routingEligible = partition === 'validation'
      && verification.activationEligible === true;
    const qualityDelta = verification.confirmationAnalysis?.summary?.adjusted?.mean
      ?? verification.calibrationAnalysis?.summary?.candidateVsParent?.mean
      ?? null;
    const verifierEvidenceHashes = [
      verification.evidenceSha256,
      lease.evidenceSha256,
      preparation.evidenceSha256,
      verification.vnextExecutionEvidence?.executionEvidenceSha256,
      verification.paceState?.stateSha256,
      verification.paceGateRecord?.recordSha256
    ].filter(Boolean);
    const authority = createVerifierOwnedVNextEvidenceAuthority({
      sourceRunId: runId,
      sourceCompletedAt: state.completedAt,
      primaryEvidenceSha256: verification.evidenceSha256,
      leaseEvidenceSha256: lease.evidenceSha256,
      preparationEvidenceSha256: preparation.evidenceSha256
    });
    if (authority.status !== 'OK') return authority;
    const built = createVNextEvidenceRecord({
      kind,
      availableAt: state.completedAt,
      createdAt: state.completedAt,
      sourceIds: [
        runId,
        config.vnextBinding.preparationRunId,
        config.candidateFamily.familyId,
        config.evolutionRecord.evolutionId
      ],
      authority: authority.authority,
      verifierEvidenceHashes,
      compatibility: compatibility(config, hypothesis, partition),
      lifecycle: {
        state: positive && routingEligible
          ? 'active'
          : (regressed ? 'contradicted' : 'replicated'),
        quarantined: regressed,
        quarantineReason: regressed
          ? 'Replicated confirmation recorded a target or control regression.'
          : null
      },
      metrics: {
        qualityDelta,
        costUsd: budget.totals.usdUsed / 1_000_000,
        latencyMs: null,
        tokenCost: verification.tokenUsage.total,
        uncertainty: null
      },
      content: {
        schemaVersion: VNEXT_RECURSIVE_IMPORT_SCHEMA,
        sourceRunId: runId,
        partition,
        taskPackSha256: config.vnextBinding.taskPackSha256,
        preparationRunId: config.vnextBinding.preparationRunId,
        candidateFamilyId: config.candidateFamily.familyId,
        evolutionId: config.evolutionRecord.evolutionId,
        outcome: positive ? 'causal-improvement' : kind,
        hypothesis: hypothesis.statement,
        prediction: hypothesis.prediction,
        falsifier: hypothesis.falsifier,
        strategy: candidate.strategy,
        component: candidate.component,
        operationCount: candidate.operations.length,
        operationTargets: candidate.operations.map((operation) => operation.target),
        paceDisposition: verification.paceGateRecord?.disposition ?? null,
        calibrationQualified: verification.calibrationQualified,
        childActivationEligible: verification.activationEligible,
        routingActivationEligible: routingEligible,
        promotionAuthorized: false
      },
      callerClaims: {}
    });
    return built.status === 'OK'
      ? {
          status: 'OK',
          record: built.record,
          verification,
          lease,
          preparation,
          budget
        }
      : built;
  } catch (error) {
    return refused('VNEXT_RECURSIVE_IMPORT_DERIVE_FAILED', error.message);
  }
}

export function persistVNextRecursiveEvidence({
  sourceStore,
  homeDir,
  runId,
  hooks = {}
} = {}) {
  const derived = deriveVNextRecursiveEvidence({ sourceStore, runId });
  if (derived.status !== 'OK') return derived;
  const partition = derived.record.content.partition;
  const authority = createVNextEvidenceAuthorityVerifier({
    sourceStore,
    homeDir
  });
  if (authority.status !== 'OK') return authority;
  const pending = persistVNextRecursiveImportPending({
    homeDir,
    runId,
    partition,
    record: derived.record,
    verifierEvidenceSha256: derived.verification.evidenceSha256,
    createdAt: derived.record.createdAt
  });
  if (pending.status !== 'OK') return pending;
  if (typeof hooks.afterPending === 'function') hooks.afterPending(pending);
  const evidence = appendVNextEvidenceRecord(homeDir, derived.record, {
    authorityVerifier: authority.verifier
  });
  if (evidence.status !== 'OK') {
    return refused(
      'VNEXT_RECURSIVE_EVIDENCE_PERSIST_FAILED',
      'VNext evidence-bank persistence failed before any adaptive catalog write.',
      { evidence }
    );
  }
  if (typeof hooks.afterEvidence === 'function') hooks.afterEvidence(evidence);
  const committed = commitVNextRecursiveImportTransaction({
    homeDir,
    transactionId: pending.pending.transactionId,
    evidenceLedgerSha256: evidence.ledgerSha256,
    committedAt: derived.record.createdAt
  });
  if (committed.status !== 'OK') return committed;
  if (typeof hooks.afterCommit === 'function') hooks.afterCommit(committed);
  const vnextImportCommit = {
    transactionId: committed.commit.transactionId,
    commitSha256: committed.commit.commitSha256
  };
  const catalog = partition === 'development'
    ? persistAdaptiveRecursiveCanaryV2DevelopmentResult({
        homeDir,
        sourceStore,
        runId,
        vnextImportCommit
      })
    : persistAdaptiveRecursiveCanaryV2Result({
        homeDir,
        sourceStore,
        runId,
        vnextImportCommit
      });
  if (catalog.status !== 'OK') return catalog;
  return {
    status: 'OK',
    runId,
    partition,
    record: evidence.record,
    evidenceAppended: evidence.appended,
    evidenceLedgerSha256: evidence.ledgerSha256,
    importTransaction: {
      transactionId: committed.commit.transactionId,
      transactionSha256: committed.commit.transactionSha256,
      commitSha256: committed.commit.commitSha256
    },
    catalog,
    causalPass: derived.verification.causalPass,
    activationEligible: partition === 'validation'
      && derived.verification.activationEligible,
    promotionAuthorized: false
  };
}
