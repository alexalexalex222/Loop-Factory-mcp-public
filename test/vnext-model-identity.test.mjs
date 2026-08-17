import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  createVNextModelIdentityPolicy,
  validateVNextModelIdentityReceipt,
  verifyVNextModelInvocation
} from '../src/vnext-model-identity.mjs';

function authority() {
  return createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/bin/codex', binaryBytes: Buffer.from('codex-binary'),
    versionOutput: 'codex-cli 1.0.0', loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high', service_tiers: []
    }] }),
    requestedModel: 'gpt-5.6-sol', reasoningEffort: 'high'
  }).record;
}

function invocation(auth, reportedModel = 'gpt-5.6-sol') {
  return {
    requestedModel: 'gpt-5.6-sol', reasoningEffort: 'high', authMode: 'chatgpt-oauth',
    oauthAuthoritySha256: auth.authoritySha256,
    executableSha256: auth.binary.sha256,
    modelSelectionAuthority: 'explicit-model-flag', strictIsolation: true,
    exitCode: 0, stdoutSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64),
    reportedModel, modelIdentityAuthority: reportedModel ? 'cli-reported' : 'explicit-model-flag'
  };
}

test('strict VNext identity requires a backend-reported exact match', () => {
  const auth = authority();
  const policy = createVNextModelIdentityPolicy({
    policyId: 'identity-1', oauthAuthority: auth, requireBackendReportedModel: true
  }).policy;
  const verified = verifyVNextModelInvocation({
    policy, invocation: invocation(auth), verifiedAt: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(verified.status, 'OK');
  assert.equal(verified.receipt.identityStatus, 'BACKEND_REPORTED_MATCH');
  assert.equal(validateVNextModelIdentityReceipt(verified.receipt).status, 'OK');
  assert.equal(verifyVNextModelInvocation({
    policy, invocation: invocation(auth, null), verifiedAt: '2026-08-05T00:00:00.000Z'
  }).code, 'VNEXT_MODEL_IDENTITY_UNAVAILABLE');
});

test('selection-only mode is explicit and never described as backend identity', () => {
  const auth = authority();
  const policy = createVNextModelIdentityPolicy({
    policyId: 'identity-2', oauthAuthority: auth, requireBackendReportedModel: false
  }).policy;
  const verified = verifyVNextModelInvocation({
    policy, invocation: invocation(auth, null), verifiedAt: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(verified.status, 'OK');
  assert.equal(verified.receipt.identityStatus, 'SELECTION_AUTHORITY_ONLY');
  assert.equal(verified.receipt.modelIdentityAuthority, null);
});

test('reported mismatch and OAuth authority drift fail closed', () => {
  const auth = authority();
  const policy = createVNextModelIdentityPolicy({
    policyId: 'identity-3', oauthAuthority: auth, requireBackendReportedModel: false
  }).policy;
  assert.equal(verifyVNextModelInvocation({
    policy, invocation: invocation(auth, 'gpt-5.6-luna'),
    verifiedAt: '2026-08-05T00:00:00.000Z'
  }).code, 'VNEXT_MODEL_IDENTITY_MISMATCH');
  const drift = invocation(auth);
  drift.oauthAuthoritySha256 = 'f'.repeat(64);
  assert.equal(verifyVNextModelInvocation({
    policy, invocation: drift, verifiedAt: '2026-08-05T00:00:00.000Z'
  }).status, 'REFUSED');
});
