import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  buildEvaluatorProcessDiagnostic,
  EVALUATOR_WORKER_FAILURE_SCHEMA,
  EVALUATOR_WORKER_FAILURE_SCHEMA_V1,
  validateEvaluatorWorkerFailure
} from '../src/isolated-evaluator.mjs';
import {
  replayConsumedEvaluatorProof
} from '../src/vnext-ablation-protocol.mjs';
import {
  createVNextEvaluatorProofPlan,
  persistVNextEvaluatorProofPlan,
  VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA_V1
} from '../src/vnext-evaluator-proof.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('legacy consumed evaluator failures remain replayable', () => {
  const authority = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('consumed-v1-fixture'),
    versionOutput: 'codex-cli 1.0.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high',
      service_tiers: []
    }] }),
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  });
  assert.equal(authority.status, 'OK');
  const example = JSON.parse(readFileSync(
    join(PACKAGE_ROOT, 'examples/vnext-evaluator-proof.json'),
    'utf8'
  ));
  const proofHome = mkdtempSync(join(tmpdir(), 'consumed-v1-proof-'));
  const built = createVNextEvaluatorProofPlan({
    packageRoot: PACKAGE_ROOT,
    proofHome,
    proofId: 'consumed-v1-proof',
    createdAt: '2026-08-16T00:00:00.000Z',
    runtimeAuthority: authority.record,
    ...example
  });
  assert.equal(built.status, 'OK', built.message);
  const legacyPlanCore = structuredClone(built.plan);
  delete legacyPlanCore.planSha256;
  legacyPlanCore.schemaVersion = VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA_V1;
  legacyPlanCore.invocationPolicy.sampling = {
    seed: 1729,
    temperature: 0,
    topP: 1
  };
  delete legacyPlanCore.invocationPolicy.modelGenerationSampling;
  const legacyPlan = {
    ...legacyPlanCore,
    planSha256: sha256(canonicalVNextJson(legacyPlanCore))
  };
  const planText = `${canonicalVNextJson(legacyPlan)}\n`;
  writeFileSync(join(built.directory, 'plan.json'), planText);

  const launchCore = {
    schemaVersion: 'loop-factory-vnext-evaluator-proof-launch-v1',
    proofId: legacyPlan.proofId,
    planSha256: legacyPlan.planSha256,
    startedAt: '2026-08-16T00:00:01.000Z',
    executionAuthority: 'operator-exact-evaluator-proof-plan-sha256',
    maximumCalls: 1,
    retriesAuthorized: false
  };
  const launch = {
    ...launchCore,
    launchSha256: sha256(canonicalVNextJson(launchCore))
  };
  const launchText = `${canonicalVNextJson(launch)}\n`;
  writeFileSync(join(built.directory, 'launch.json'), launchText);

  const stdoutSha256 = sha256('');
  const stderrSha256 = sha256('legacy fixture failure');
  const failure = {
    schemaVersion: EVALUATOR_WORKER_FAILURE_SCHEMA_V1,
    invocationSha256: '1'.repeat(64),
    reason: 'EXEC_FAILED',
    stdoutSha256,
    stderrSha256,
    executorInvocation: { exitCode: 1, stdoutSha256, stderrSha256 }
  };
  assert.equal(validateEvaluatorWorkerFailure(failure).status, 'OK');
  mkdirSync(join(built.directory, 'state'));
  const failureText = `${canonicalVNextJson(failure)}\n`;
  writeFileSync(join(built.directory, 'state', 'failure.json'), failureText);
  const record = {
    schemaVersion: 'loop-factory-vnext-consumed-evaluator-proof-v1',
    proofHome: legacyPlan.proofHome,
    proofId: legacyPlan.proofId,
    planSha256: legacyPlan.planSha256,
    planFileSha256: sha256(planText),
    launchSha256: launch.launchSha256,
    launchFileSha256: sha256(launchText),
    failureEvidencePath: 'state/failure.json',
    failureEvidenceSha256: sha256(failureText),
    status: 'CONSUMED_FAILURE_NO_RETRY',
    maximumCalls: 1,
    retriesAuthorized: false
  };

  assert.equal(replayConsumedEvaluatorProof(record).status, 'OK');
});

test('current v2 evaluator failures can be consumed and replayed', () => {
  const authority = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('consumed-v2-fixture'),
    versionOutput: 'codex-cli 1.0.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high',
      service_tiers: []
    }] }),
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  });
  assert.equal(authority.status, 'OK');
  const example = JSON.parse(readFileSync(
    join(PACKAGE_ROOT, 'examples/vnext-evaluator-proof.json'),
    'utf8'
  ));
  const proofHome = mkdtempSync(join(tmpdir(), 'consumed-v2-proof-'));
  const built = createVNextEvaluatorProofPlan({
    packageRoot: PACKAGE_ROOT,
    proofHome,
    proofId: 'consumed-v2-proof',
    createdAt: '2026-08-16T00:00:00.000Z',
    runtimeAuthority: authority.record,
    ...example
  });
  assert.equal(built.status, 'OK', built.message);
  assert.equal(persistVNextEvaluatorProofPlan(built).status, 'OK');
  const directory = built.directory;
  const launchCore = {
    schemaVersion: 'loop-factory-vnext-evaluator-proof-launch-v1',
    proofId: built.plan.proofId,
    planSha256: built.plan.planSha256,
    startedAt: '2026-08-16T00:00:01.000Z',
    executionAuthority: 'operator-exact-evaluator-proof-plan-sha256',
    maximumCalls: 1,
    retriesAuthorized: false
  };
  const launch = {
    ...launchCore,
    launchSha256: sha256(canonicalVNextJson(launchCore))
  };
  const launchText = `${canonicalVNextJson(launch)}\n`;
  writeFileSync(join(directory, 'launch.json'), launchText);
  const stdout = buildEvaluatorProcessDiagnostic('');
  const stderr = buildEvaluatorProcessDiagnostic('fixture process failed');
  const failureCore = {
    schemaVersion: EVALUATOR_WORKER_FAILURE_SCHEMA,
    invocationSha256: '1'.repeat(64),
    reason: 'EXEC_FAILED',
    stdout,
    stderr,
    executorInvocation: {
      exitCode: 1,
      stdoutSha256: stdout.rawSha256,
      stderrSha256: stderr.rawSha256
    }
  };
  const failure = {
    ...failureCore,
    failureSha256: sha256(canonicalVNextJson(failureCore))
  };
  assert.equal(validateEvaluatorWorkerFailure(failure).status, 'OK');
  mkdirSync(join(directory, 'state'));
  const failureText = `${canonicalVNextJson(failure)}\n`;
  writeFileSync(join(directory, 'state', 'failure.json'), failureText);
  const planText = readFileSync(join(directory, 'plan.json'), 'utf8');
  const record = {
    schemaVersion: 'loop-factory-vnext-consumed-evaluator-proof-v1',
    proofHome: built.plan.proofHome,
    proofId: built.plan.proofId,
    planSha256: built.plan.planSha256,
    planFileSha256: sha256(planText),
    launchSha256: launch.launchSha256,
    launchFileSha256: sha256(launchText),
    failureEvidencePath: 'state/failure.json',
    failureEvidenceSha256: sha256(failureText),
    status: 'CONSUMED_FAILURE_NO_RETRY',
    maximumCalls: 1,
    retriesAuthorized: false
  };

  assert.equal(replayConsumedEvaluatorProof(record).status, 'OK');
});
