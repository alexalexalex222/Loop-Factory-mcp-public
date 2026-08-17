import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';

export const VNEXT_MODEL_IDENTITY_POLICY_SCHEMA = 'vnext-model-identity-policy-v1';
export const VNEXT_MODEL_IDENTITY_RECEIPT_SCHEMA = 'vnext-model-identity-receipt-v1';

function policyPayload(policy) {
  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    requestedModel: policy.requestedModel,
    reasoningEffort: policy.reasoningEffort,
    oauthAuthoritySha256: policy.oauthAuthoritySha256,
    executableSha256: policy.executableSha256,
    requireBackendReportedModel: policy.requireBackendReportedModel,
    acceptedSelectionAuthority: policy.acceptedSelectionAuthority
  };
}

export function createVNextModelIdentityPolicy({
  policyId,
  oauthAuthority,
  requireBackendReportedModel = true
} = {}) {
  if (!isSafeId(policyId)
      || validateCodexOAuthAuthorityRecord(oauthAuthority).status !== 'OK'
      || typeof requireBackendReportedModel !== 'boolean') {
    return { status: 'REFUSED', code: 'VNEXT_MODEL_IDENTITY_POLICY_INVALID' };
  }
  const base = {
    schemaVersion: VNEXT_MODEL_IDENTITY_POLICY_SCHEMA,
    policyId,
    requestedModel: oauthAuthority.requestedModel,
    reasoningEffort: oauthAuthority.reasoningEffort,
    oauthAuthoritySha256: oauthAuthority.authoritySha256,
    executableSha256: oauthAuthority.binary.sha256,
    requireBackendReportedModel,
    acceptedSelectionAuthority: 'explicit-model-flag'
  };
  return {
    status: 'OK',
    policy: { ...base, policySha256: sha256(canonicalVNextJson(base)) }
  };
}

export function validateVNextModelIdentityPolicy(policy) {
  if (!policy
      || policy.schemaVersion !== VNEXT_MODEL_IDENTITY_POLICY_SCHEMA
      || policy.policySha256 !== sha256(canonicalVNextJson(policyPayload(policy)))) {
    return { status: 'REFUSED', code: 'VNEXT_MODEL_IDENTITY_POLICY_TAMPERED' };
  }
  return { status: 'OK', policy };
}

function receiptPayload(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    policySha256: receipt.policySha256,
    requestedModel: receipt.requestedModel,
    reportedModel: receipt.reportedModel,
    reasoningEffort: receipt.reasoningEffort,
    selectionAuthority: receipt.selectionAuthority,
    modelIdentityAuthority: receipt.modelIdentityAuthority,
    identityStatus: receipt.identityStatus,
    oauthAuthoritySha256: receipt.oauthAuthoritySha256,
    executableSha256: receipt.executableSha256,
    stdoutSha256: receipt.stdoutSha256,
    resultSha256: receipt.resultSha256,
    verifiedAt: receipt.verifiedAt
  };
}

export function verifyVNextModelInvocation({ policy, invocation, verifiedAt } = {}) {
  if (validateVNextModelIdentityPolicy(policy).status !== 'OK'
      || !invocation
      || invocation.requestedModel !== policy.requestedModel
      || invocation.reasoningEffort !== policy.reasoningEffort
      || invocation.authMode !== 'chatgpt-oauth'
      || invocation.oauthAuthoritySha256 !== policy.oauthAuthoritySha256
      || invocation.executableSha256 !== policy.executableSha256
      || invocation.modelSelectionAuthority !== policy.acceptedSelectionAuthority
      || invocation.strictIsolation !== true
      || invocation.exitCode !== 0
      || !/^[a-f0-9]{64}$/.test(String(invocation.stdoutSha256 || ''))
      || !/^[a-f0-9]{64}$/.test(String(invocation.resultSha256 || ''))
      || !Number.isFinite(Date.parse(verifiedAt))) {
    return { status: 'REFUSED', code: 'VNEXT_MODEL_INVOCATION_SELECTION_INVALID' };
  }
  const reported = invocation.reportedModel == null
    ? null
    : String(invocation.reportedModel).toLowerCase();
  const requested = policy.requestedModel.toLowerCase();
  if (reported != null && reported !== requested) {
    return { status: 'REFUSED', code: 'VNEXT_MODEL_IDENTITY_MISMATCH' };
  }
  if (policy.requireBackendReportedModel && reported == null) {
    return { status: 'REFUSED', code: 'VNEXT_MODEL_IDENTITY_UNAVAILABLE' };
  }
  const base = {
    schemaVersion: VNEXT_MODEL_IDENTITY_RECEIPT_SCHEMA,
    policySha256: policy.policySha256,
    requestedModel: policy.requestedModel,
    reportedModel: reported,
    reasoningEffort: policy.reasoningEffort,
    selectionAuthority: invocation.modelSelectionAuthority,
    modelIdentityAuthority: reported == null ? null : invocation.modelIdentityAuthority,
    identityStatus: reported == null ? 'SELECTION_AUTHORITY_ONLY' : 'BACKEND_REPORTED_MATCH',
    oauthAuthoritySha256: invocation.oauthAuthoritySha256,
    executableSha256: invocation.executableSha256,
    stdoutSha256: invocation.stdoutSha256,
    resultSha256: invocation.resultSha256,
    verifiedAt
  };
  return {
    status: 'OK',
    receipt: { ...base, receiptSha256: sha256(canonicalVNextJson(base)) }
  };
}

export function validateVNextModelIdentityReceipt(receipt) {
  if (!receipt
      || receipt.schemaVersion !== VNEXT_MODEL_IDENTITY_RECEIPT_SCHEMA
      || receipt.receiptSha256 !== sha256(canonicalVNextJson(receiptPayload(receipt)))) {
    return { status: 'REFUSED', code: 'VNEXT_MODEL_IDENTITY_RECEIPT_TAMPERED' };
  }
  return { status: 'OK', receipt };
}
