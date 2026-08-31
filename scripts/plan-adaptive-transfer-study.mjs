#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveTransferStudyLaunchDisclosure,
  resolveAdaptiveTransferStudyConfig,
  validateAdaptiveTransferStudyConfig
} from '../src/adaptive-transfer-study.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { STRICT_CODEX_REASONING_EFFORT } from '../src/executor.mjs';

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
    'error: --config <transfer-study.json> and --run-id <id> are required\n'
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
const runtimeAuthority = captureCodexOAuthAuthority({
  binaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  requestedModel: raw.model,
  reasoningEffort: STRICT_CODEX_REASONING_EFFORT
});
if (runtimeAuthority.status !== 'OK') {
  process.stderr.write(
    `${runtimeAuthority.code}: ${runtimeAuthority.message}\nNo worker was launched.\n`
  );
  process.exit(4);
}
const resolved = resolveAdaptiveTransferStudyConfig(raw, {
  packageRoot,
  runtimeAuthority: runtimeAuthority.record
});
if (!resolved.ok) {
  process.stderr.write('ADAPTIVE_TRANSFER_STUDY_EVIDENCE BLOCKED\n');
  for (const error of resolved.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
const config = {
  ...resolved.config,
  approvedPlanSha256: arg('--approved-plan')
};
const disclosure = adaptiveTransferStudyLaunchDisclosure(config, {
  configPath,
  home,
  runId
});
const validation = validateAdaptiveTransferStudyConfig(config);
const approvalError = 'adaptive transfer study plan is not operator-approved';
const nonApprovalErrors = validation.errors.filter(
  (error) => error !== approvalError
);
const status = nonApprovalErrors.length
  ? 'BLOCKED'
  : (validation.ok ? 'READY' : 'AWAITING_EXACT_APPROVAL');

process.stdout.write(`${JSON.stringify({
  status,
  configPath,
  ...disclosure,
  validationErrors: validation.errors,
  workerLaunched: false
}, null, 2)}\n`);

if (!validation.ok) {
  if (nonApprovalErrors.length) {
    process.stderr.write('ADAPTIVE_TRANSFER_STUDY_CONFIG BLOCKED\n');
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
