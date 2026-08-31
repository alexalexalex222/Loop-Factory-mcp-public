#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveTransferCohortLaunchDisclosure,
  resolveAdaptiveTransferCohortImplementation,
  validateAdaptiveTransferCohortConfig
} from '../src/adaptive-transfer-cohort.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { STRICT_CODEX_REASONING_EFFORT } from '../src/executor.mjs';
import { resolveEvidenceCapsule } from '../src/real-test.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

const configArg = arg('--config');
const runId = arg('--run-id');
if (!configArg || !runId) {
  process.stderr.write(
    'error: --config <transfer-cohort.json> and --run-id <id> are required\n'
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
  approvedPlanSha256: arg('--approved-plan')
};
const disclosure = adaptiveTransferCohortLaunchDisclosure(config, {
  configPath,
  home,
  runId
});
const validation = validateAdaptiveTransferCohortConfig(config);
const approvalError = 'transfer cohort plan is not operator-approved';
const nonApprovalErrors = validation.errors.filter((error) => error !== approvalError);
const status = nonApprovalErrors.length
  ? 'BLOCKED'
  : (validation.ok ? 'READY' : 'AWAITING_EXACT_APPROVAL');

process.stdout.write(`${JSON.stringify({
  status,
  configPath,
  developmentEvidenceManifest: development.manifest,
  heldOutEvidenceManifest: heldOut.manifest,
  mechanismEvidenceManifest: mechanism.manifest,
  ...disclosure,
  validationErrors: validation.errors,
  workerLaunched: false
}, null, 2)}\n`);

if (!validation.ok) {
  if (nonApprovalErrors.length) {
    process.stderr.write('ADAPTIVE_TRANSFER_COHORT_CONFIG BLOCKED\n');
    for (const error of nonApprovalErrors) process.stderr.write(`- ${error}\n`);
  } else {
    process.stderr.write(
      `Operator action required: approve exact plan ${disclosure.planSha256} with --approved-plan ${disclosure.planSha256}\n`
    );
  }
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}

process.stdout.write('Plan-only validation passed. No worker was launched.\n');
