import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyAdaptiveRecursiveCanaryV2Run } from './adaptive-recursive-runner-v2.mjs';
import { verifyAdaptiveRecursiveVNextLeaseReceipt } from './adaptive-recursive-vnext-run.mjs';
import { sha256 } from './util.mjs';
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';
import { verifyVNextPreparationRun } from './vnext-preparation-store.mjs';

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function sameStore(sourceStore, homeDir) {
  if (typeof sourceStore?.homeDir !== 'string' || typeof homeDir !== 'string') {
    return false;
  }
  try {
    return realpathSync(resolve(sourceStore.homeDir)) === realpathSync(resolve(homeDir));
  } catch {
    return false;
  }
}

function readBoundConfig(store, runId, state) {
  const ref = state?.evidenceArtifacts?.config;
  const artifact = ref?.id ? store.readArtifact(runId, ref.id) : null;
  if (!artifact || typeof artifact.content !== 'string'
      || artifact.sha256 !== ref.sha256
      || artifact.sha256 !== sha256(artifact.content)) return null;
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

export function replayVNextEvidenceRecordAuthority({
  sourceStore,
  record
} = {}) {
  const valid = validateVNextEvidenceRecord(record);
  if (valid.status !== 'OK' || record.authority.kind !== 'verifier-owned') {
    return refused(
      'EVIDENCE_AUTHORITY_RECORD_INVALID',
      'Authority replay requires one intact verifier-owned evidence record.'
    );
  }
  try {
    const authority = record.authority;
    const state = sourceStore?.load(authority.sourceRunId);
    const config = readBoundConfig(sourceStore, authority.sourceRunId, state);
    const verification = verifyAdaptiveRecursiveCanaryV2Run(
      sourceStore,
      authority.sourceRunId
    );
    const lease = verifyAdaptiveRecursiveVNextLeaseReceipt(
      sourceStore,
      authority.sourceRunId
    );
    const preparation = config?.vnextBinding?.preparationRunId
      ? verifyVNextPreparationRun(sourceStore, config.vnextBinding.preparationRunId)
      : null;
    const expectedHashes = [
      authority.primaryEvidenceSha256,
      authority.leaseEvidenceSha256,
      authority.preparationEvidenceSha256
    ];
    if (!state || !config?.vnextBinding
        || verification.experimentValid !== true
        || verification.gates?.vnextExecutionBinding !== true
        || verification.gates?.paceEvidence !== true
        || lease.status !== 'OK'
        || preparation?.status !== 'OK'
        || state.completedAt !== authority.sourceCompletedAt
        || record.availableAt !== authority.sourceCompletedAt
        || record.createdAt !== authority.sourceCompletedAt
        || verification.evidenceSha256 !== authority.primaryEvidenceSha256
        || lease.evidenceSha256 !== authority.leaseEvidenceSha256
        || preparation.evidenceSha256 !== authority.preparationEvidenceSha256
        || config.vnextBinding.preparationVerifierEvidenceSha256
          !== authority.preparationEvidenceSha256
        || record.content?.sourceRunId !== authority.sourceRunId
        || record.content?.partition !== config.vnextBinding.taskPartition
        || record.content?.taskPackSha256 !== config.vnextBinding.taskPackSha256
        || !record.sourceIds.includes(authority.sourceRunId)
        || expectedHashes.some((digest) => !record.verifierEvidenceHashes.includes(digest))) {
      return refused(
        'EVIDENCE_AUTHORITY_REPLAY_FAILED',
        'Verifier-owned evidence did not replay to the same completed run, lease, preparation, partition, and task pack.'
      );
    }
    return {
      status: 'OK',
      verifierEligible: true,
      authoritySha256: authority.authoritySha256,
      sourceCompletedAt: state.completedAt,
      verificationEvidenceSha256: verification.evidenceSha256
    };
  } catch (error) {
    return refused('EVIDENCE_AUTHORITY_REPLAY_FAILED', error.message);
  }
}

export function createVNextEvidenceAuthorityVerifier({
  sourceStore,
  homeDir
} = {}) {
  if (!sameStore(sourceStore, homeDir)) {
    return refused(
      'EVIDENCE_AUTHORITY_STORE_MISMATCH',
      'Evidence authority must replay from the same normalized local store as the ledger.'
    );
  }
  return {
    status: 'OK',
    verifier(record) {
      return replayVNextEvidenceRecordAuthority({ sourceStore, record });
    }
  };
}
