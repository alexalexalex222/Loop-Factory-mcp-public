#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveRecursiveCampaignLaunchDisclosure,
  prepareAdaptiveRecursiveCampaignConfig,
  validateAdaptiveRecursiveCampaignConfig
} from '../src/adaptive-recursive-campaign.mjs';

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
    'error: --config <recursive-campaign.json> and --run-id <id> are required\n'
  );
  process.exit(2);
}
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(configArg);
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const artifactRoot = resolve(arg('--artifact-root', dirname(configPath)));
const approvedPlanSha256 = arg('--approved-plan');
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const prepared = prepareAdaptiveRecursiveCampaignConfig(raw, {
  packageRoot,
  artifactRoot,
  codexBinaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  approvedPlanSha256
});
if (prepared.status !== 'OK') {
  process.stderr.write(`${prepared.code}: ${prepared.message}\nNo worker was launched.\n`);
  process.exit(4);
}
const validation = validateAdaptiveRecursiveCampaignConfig(prepared.config);
const approvalError =
  'approved plan SHA-256 does not match the prepared recursive campaign plan';
const nonApprovalErrors = validation.errors.filter((error) => error !== approvalError);
const disclosure = adaptiveRecursiveCampaignLaunchDisclosure(prepared.config, {
  configPath,
  home,
  runId
});
const status = nonApprovalErrors.length
  ? 'BLOCKED'
  : (validation.ok ? 'READY' : 'AWAITING_EXACT_APPROVAL');
process.stdout.write(`${JSON.stringify({
  status,
  configPath,
  artifactRoot,
  plan: validation.plan,
  disclosure,
  validationErrors: validation.errors,
  workerLaunched: false
}, null, 2)}\n`);
if (!validation.ok) {
  if (nonApprovalErrors.length) {
    for (const error of nonApprovalErrors) process.stderr.write(`- ${error}\n`);
  } else {
    process.stderr.write(
      `Operator action required: approve exact plan ${validation.plan.sha256} with --approved-plan ${validation.plan.sha256}\n`
    );
  }
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
