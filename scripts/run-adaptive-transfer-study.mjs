#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAdaptiveTransferStudyPlan,
  resolveAdaptiveTransferStudyConfig,
  runAdaptiveTransferStudy,
  validateAdaptiveTransferStudyConfig
} from '../src/adaptive-transfer-study.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import {
  STRICT_CODEX_REASONING_EFFORT,
  executorWorker,
  isExecEnabled
} from '../src/executor.mjs';
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
    'error: --config <transfer-study.json>, --run-id <id>, and --approved-plan <sha256> are required\n'
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
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== runtimeAuthority.record.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== runtimeAuthority.record.binary.sha256) {
  process.stderr.write(
    'ADAPTIVE_TRANSFER_STUDY_OAUTH_LOCK BLOCKED: launch authority or executable hash is missing or mismatched\n'
  );
  process.stderr.write('No worker was launched.\n');
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
  approvedPlanSha256
};
const plan = buildAdaptiveTransferStudyPlan(config);
const validation = validateAdaptiveTransferStudyConfig(config);
process.stdout.write(`adaptive transfer study plan sha256: ${plan.sha256}\n`);
if (!validation.ok) {
  process.stderr.write('ADAPTIVE_TRANSFER_STUDY_CONFIG BLOCKED\n');
  for (const error of validation.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write(
    'error: set SUPER_LOOP_ALLOW_EXEC=1 to launch the approved transfer study\n'
  );
  process.exit(3);
}

const result = runAdaptiveTransferStudy(createStore(home), config, {
  runId,
  worker: executorWorker
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
