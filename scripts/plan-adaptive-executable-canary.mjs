#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveExecutableCanaryLaunchDisclosure,
  prepareAdaptiveExecutableCanaryConfig,
  validateAdaptiveExecutableCanaryConfig
} from '../src/adaptive-executable-canary.mjs';

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
    'error: --config <executable-canary.json> and --run-id <id> are required\n'
  );
  process.exit(2);
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(configArg);
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const approvedPlanSha256 = arg('--approved-plan');
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const prepared = prepareAdaptiveExecutableCanaryConfig(raw, {
  packageRoot,
  codexBinaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  approvedPlanSha256
});
if (prepared.status !== 'OK') {
  process.stderr.write('ADAPTIVE_EXECUTABLE_CANARY_PREP BLOCKED\n');
  for (const error of prepared.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}

const config = prepared.config;
const disclosure = adaptiveExecutableCanaryLaunchDisclosure(config, {
  configPath,
  home,
  runId
});
const validation = validateAdaptiveExecutableCanaryConfig(config);
const approvalError = 'executable canary plan is not operator-approved';
const nonApprovalErrors = validation.errors
  .filter((error) => error !== approvalError);
const status = nonApprovalErrors.length
  ? 'BLOCKED'
  : (validation.ok ? 'READY' : 'AWAITING_EXACT_APPROVAL');

process.stdout.write(`${JSON.stringify({
  status,
  configPath,
  publicManifest: config.publicManifest,
  oracleManifest: config.oracleManifest,
  referenceManifest: config.referenceManifest,
  provenanceManifest: config.provenanceManifest,
  mechanismEvidenceManifest: config.mechanismEvidenceManifest,
  preflight: config.preflight,
  ...disclosure,
  validationErrors: validation.errors,
  workerLaunched: false
}, null, 2)}\n`);

if (!validation.ok) {
  if (nonApprovalErrors.length) {
    process.stderr.write('ADAPTIVE_EXECUTABLE_CANARY_CONFIG BLOCKED\n');
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
