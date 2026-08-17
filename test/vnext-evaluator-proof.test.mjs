import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  createVNextEvaluatorProofPlan,
  loadVNextEvaluatorProofPlan,
  persistVNextEvaluatorProofPlan,
  resolveVNextEvaluatorProofImplementation,
  runVNextEvaluatorProof,
  validateVNextEvaluatorProofPlan,
  verifyVNextEvaluatorProofPlanImplementation,
  VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS
} from '../src/vnext-evaluator-proof.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function authority() {
  return createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('evaluator-proof-codex'),
    versionOutput: 'codex-cli 1.0.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high', service_tiers: []
    }] }),
    requestedModel: 'gpt-5.6-sol', reasoningEffort: 'high'
  }).record;
}

function input() {
  const example = JSON.parse(readFileSync(
    join(PACKAGE_ROOT, 'examples/vnext-evaluator-proof.json'),
    'utf8'
  ));
  return {
    packageRoot: PACKAGE_ROOT,
    proofHome: mkdtempSync(join(tmpdir(), 'vnext-evaluator-proof-')),
    proofId: 'evaluator-proof-test',
    createdAt: '2026-08-05T00:00:00.000Z',
    runtimeAuthority: authority(),
    ...example
  };
}

test('evaluator proof planning freezes one call and never launches a worker', async () => {
  const built = createVNextEvaluatorProofPlan(input());
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.plan.exposure.maximumCalls, 1);
  assert.equal(built.plan.exposure.hardTokenCeiling, null);
  assert.deepEqual(built.plan.invocationPolicy.modelGenerationSampling, {
    authority: 'backend-default',
    deterministic: false
  });
  assert.equal(JSON.stringify(built.plan).includes('samplingSha256'), false);
  assert.equal(JSON.stringify(built.plan).includes('temperature'), false);
  assert.equal(JSON.stringify(built.plan).includes('topP'), false);
  assert.ok(built.plan.pairwiseReceipt.seedSha256);
  assert.equal(built.plan.approval.paidModelCallsAtPlanning, 0);
  assert.equal(validateVNextEvaluatorProofPlan(built.plan).status, 'OK');
  assert.equal(persistVNextEvaluatorProofPlan(built).status, 'OK');
  assert.equal(persistVNextEvaluatorProofPlan(built).idempotent, true);
  const loaded = loadVNextEvaluatorProofPlan({
    proofHome: built.plan.proofHome,
    proofId: built.plan.proofId
  });
  assert.equal(loaded.status, 'OK', loaded.message);
  const blocked = await runVNextEvaluatorProof({
    plan: loaded.plan,
    directory: loaded.directory,
    approvedPlanSha256: '0'.repeat(64)
  });
  assert.equal(blocked.code, 'EVALUATOR_PROOF_APPROVAL_MISMATCH');
});

test('evaluator proof hash and implementation capsule reject drift', () => {
  const built = createVNextEvaluatorProofPlan(input());
  assert.equal(built.status, 'OK', built.message);
  const changed = structuredClone(built.plan);
  changed.prompt += ' changed';
  assert.equal(validateVNextEvaluatorProofPlan(changed).status, 'REFUSED');
  assert.ok(VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.includes(
    'scripts/vnext-evaluator-worker.mjs'
  ));
  assert.ok(VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.includes(
    'src/isolated-evaluator.mjs'
  ));
  assert.ok(VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.includes(
    'src/codex-oauth-authority.mjs'
  ));
  assert.ok(VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.includes(
    'src/host.mjs'
  ));
  assert.ok(VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.includes(
    'hosts/registry.json'
  ));
  assert.equal(verifyVNextEvaluatorProofPlanImplementation({
    plan: built.plan,
    packageRoot: PACKAGE_ROOT
  }).status, 'OK');

  const driftRoot = mkdtempSync(join(tmpdir(), 'vnext-evaluator-drift-'));
  for (const path of VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS) {
    const destination = join(driftRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(PACKAGE_ROOT, path), destination);
  }
  writeFileSync(
    join(driftRoot, VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS[0]),
    '\n// drift\n',
    { flag: 'a' }
  );
  const drifted = verifyVNextEvaluatorProofPlanImplementation({
    plan: built.plan,
    packageRoot: driftRoot
  });
  assert.equal(drifted.code, 'EVALUATOR_PROOF_IMPLEMENTATION_DRIFT');

  const closureRoot = mkdtempSync(join(tmpdir(), 'vnext-evaluator-closure-'));
  for (const path of VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS) {
    const destination = join(closureRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(PACKAGE_ROOT, path), destination);
  }
  writeFileSync(
    join(closureRoot, 'src/vnext-evaluator-proof.mjs'),
    "\nimport './unbound-evaluator-dependency.mjs';\n",
    { flag: 'a' }
  );
  writeFileSync(
    join(closureRoot, 'src/unbound-evaluator-dependency.mjs'),
    'export const unbound = true;\n'
  );
  const unbound = resolveVNextEvaluatorProofImplementation({
    packageRoot: closureRoot
  });
  assert.equal(unbound.code, 'EVALUATOR_PROOF_IMPLEMENTATION_INVALID');
  assert.match(unbound.message, /implementation closure mismatch/);
});

test('ambiguous evaluator failure writes a one-shot launch barrier', async () => {
  const built = createVNextEvaluatorProofPlan(input());
  assert.equal(built.status, 'OK', built.message);
  assert.equal(persistVNextEvaluatorProofPlan(built).status, 'OK');
  const loaded = loadVNextEvaluatorProofPlan({
    proofHome: built.plan.proofHome,
    proofId: built.plan.proofId
  });
  assert.equal(loaded.status, 'OK', loaded.message);

  let calls = 0;
  const badClock = await runVNextEvaluatorProof({
    plan: loaded.plan,
    directory: loaded.directory,
    approvedPlanSha256: loaded.plan.planSha256,
    evaluatorRunner: async () => {
      calls += 1;
      return { status: 'OK' };
    },
    clock: () => 'not-a-timestamp'
  });
  assert.equal(badClock.code, 'EVALUATOR_PROOF_CLOCK_INVALID');
  assert.equal(calls, 0);
  assert.equal(existsSync(join(loaded.directory, 'launch.json')), false);

  const failedDurability = await runVNextEvaluatorProof({
    plan: loaded.plan,
    directory: loaded.directory,
    approvedPlanSha256: loaded.plan.planSha256,
    evaluatorRunner: async () => {
      calls += 1;
      return { status: 'OK' };
    },
    durableWriter: () => {
      const error = new Error('simulated storage flush failure');
      error.code = 'EIO';
      throw error;
    },
    clock: () => '2026-08-05T00:59:00.000Z'
  });
  assert.equal(failedDurability.code, 'EVALUATOR_PROOF_LAUNCH_DURABILITY_FAILED');
  assert.equal(calls, 0);
  assert.equal(existsSync(join(loaded.directory, 'launch.json')), false);

  const failed = await runVNextEvaluatorProof({
    plan: loaded.plan,
    directory: loaded.directory,
    approvedPlanSha256: loaded.plan.planSha256,
    evaluatorRunner: async () => {
      calls += 1;
      return {
        status: 'REFUSED',
        code: 'SIMULATED_AMBIGUOUS_EVALUATOR_FAILURE'
      };
    },
    clock: () => '2026-08-05T01:00:00.000Z'
  });
  assert.equal(failed.code, 'SIMULATED_AMBIGUOUS_EVALUATOR_FAILURE');
  assert.equal(calls, 1);
  assert.equal(existsSync(join(loaded.directory, 'launch.json')), true);

  const retry = await runVNextEvaluatorProof({
    plan: loaded.plan,
    directory: loaded.directory,
    approvedPlanSha256: loaded.plan.planSha256,
    evaluatorRunner: async () => {
      calls += 1;
      return { status: 'OK' };
    }
  });
  assert.equal(retry.code, 'EVALUATOR_PROOF_NOT_FRESH');
  assert.equal(calls, 1);
});
