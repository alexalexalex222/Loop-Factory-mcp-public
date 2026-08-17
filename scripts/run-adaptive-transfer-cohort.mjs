#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAdaptiveTransferCohortPlan,
  resolveAdaptiveTransferCohortImplementation,
  runAdaptiveTransferCohort,
  validateAdaptiveTransferCohortConfig
} from '../src/adaptive-transfer-cohort.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { createCohortSubprocessWorker } from '../src/cohort-executor.mjs';
import {
  STRICT_CODEX_REASONING_EFFORT,
  isExecEnabled
} from '../src/executor.mjs';
import { resolveEvidenceCapsule } from '../src/real-test.mjs';
import { createStore } from '../src/store.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

const configArg = arg('--config');
const runId = arg('--run-id');
const approvedPlanSha256 = arg('--approved-plan');
if (!configArg || !runId || !approvedPlanSha256) {
  process.stderr.write(
    'error: --config <transfer-cohort.json>, --run-id <id>, and --approved-plan <sha256> are required\n'
  );
  process.exit(2);
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(configArg);
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const development = resolveEvidenceCapsule(
  packageRoot,
  raw.developmentEvidenceSources
);
const heldOut = resolveEvidenceCapsule(packageRoot, raw.heldOutEvidenceSources);
const mechanism = resolveEvidenceCapsule(
  packageRoot,
  raw.mechanismEvidenceSources
);
const implementation = resolveAdaptiveTransferCohortImplementation(packageRoot);
const runtimeAuthority = captureCodexOAuthAuthority({
  binaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  requestedModel: raw.model,
  reasoningEffort: STRICT_CODEX_REASONING_EFFORT
});
if (!development.ok || !heldOut.ok || !mechanism.ok
    || runtimeAuthority.status !== 'OK') {
  process.stderr.write('ADAPTIVE_TRANSFER_COHORT_EVIDENCE BLOCKED\n');
  for (const error of development.errors) process.stderr.write(`- ${error}\n`);
  for (const error of heldOut.errors) process.stderr.write(`- ${error}\n`);
  for (const error of mechanism.errors) process.stderr.write(`- ${error}\n`);
  if (runtimeAuthority.status !== 'OK') {
    process.stderr.write(`- ${runtimeAuthority.code}: ${runtimeAuthority.message}\n`);
  }
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== runtimeAuthority.record.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== runtimeAuthority.record.binary.sha256) {
  process.stderr.write(
    'ADAPTIVE_TRANSFER_COHORT_OAUTH_LOCK BLOCKED: launch authority or executable hash is missing or mismatched\n'
  );
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
const config = {
  ...raw,
  developmentEvidenceManifest: development.manifest,
  developmentEvidenceCapsule: development.capsule,
  heldOutEvidenceManifest: heldOut.manifest,
  heldOutEvidenceCapsule: heldOut.capsule,
  mechanismEvidenceManifest: mechanism.manifest,
  mechanismEvidenceCapsule: mechanism.capsule,
  implementationManifest: implementation.manifest,
  implementationCapsule: implementation.capsule,
  runtimeAuthority: runtimeAuthority.record,
  approvedPlanSha256
};
const plan = buildAdaptiveTransferCohortPlan(config);
const validation = validateAdaptiveTransferCohortConfig(config);
process.stdout.write(`adaptive transfer cohort plan sha256: ${plan.sha256}\n`);
if (!validation.ok) {
  process.stderr.write('ADAPTIVE_TRANSFER_COHORT_CONFIG BLOCKED\n');
  for (const error of validation.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write(
    'error: set SUPER_LOOP_ALLOW_EXEC=1 to launch the approved transfer cohort\n'
  );
  process.exit(3);
}

const store = createStore(home);
const result = await runAdaptiveTransferCohort(store, config, {
  runId,
  worker: createCohortSubprocessWorker({
    store,
    runId,
    packageRoot,
    env: process.env
  })
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  runId: result.runId || runId,
  experimentValid: result.experimentValid ?? false,
  activationEligible: result.activationEligible ?? false,
  outcome: result.outcome?.status || null,
  reportPath: result.reportPath || null,
  statePath: result.statePath || null,
  code: result.code || null,
  message: result.message || null
}, null, 2)}\n`);
process.exit(result.status === 'OK' && result.experimentValid === true ? 0 : 1);
