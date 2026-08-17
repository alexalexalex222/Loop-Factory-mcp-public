#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveExecutableCanaryWorker,
  prepareAdaptiveExecutableCanaryConfig,
  runAdaptiveExecutableCanary,
  validateAdaptiveExecutableCanaryConfig
} from '../src/adaptive-executable-canary.mjs';
import { isExecEnabled } from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import {
  adaptiveCanaryRunSucceeded,
  completeAdaptiveCanaryMemoryImport
} from '../src/adaptive-canary-auto-import.mjs';

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
    'error: --config <executable-canary.json>, --run-id <id>, and --approved-plan <sha256> are required\n'
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
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== config.runtimeAuthority.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== config.runtimeAuthority.binary.sha256) {
  process.stderr.write(
    'ADAPTIVE_EXECUTABLE_CANARY_OAUTH_LOCK BLOCKED: launch authority or executable hash is missing or mismatched\n'
  );
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
const validation = validateAdaptiveExecutableCanaryConfig(config);
process.stdout.write(
  `adaptive executable canary plan sha256: ${validation.plan.sha256}\n`
);
if (!validation.ok) {
  process.stderr.write('ADAPTIVE_EXECUTABLE_CANARY_CONFIG BLOCKED\n');
  for (const error of validation.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write(
    'error: set SUPER_LOOP_ALLOW_EXEC=1 to launch the approved executable canary\n'
  );
  process.exit(3);
}

const store = createStore(home);
const result = runAdaptiveExecutableCanary(store, config, {
  runId,
  worker: adaptiveExecutableCanaryWorker
});
const memoryImport = completeAdaptiveCanaryMemoryImport({
  store,
  homeDir: home,
  runId,
  config,
  result
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  runId: result.runId || runId,
  experimentValid: result.experimentValid ?? false,
  causalPass: result.causalPass ?? false,
  outcome: result.outcome?.status || null,
  reportPath: result.reportPath || null,
  statePath: result.statePath || null,
  memoryImport,
  code: result.code || null,
  message: result.message || null
}, null, 2)}\n`);
process.exit(adaptiveCanaryRunSucceeded({ result, memoryImport }) ? 0 : 1);
