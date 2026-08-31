#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareAdaptiveRecursiveCanaryConfig,
  adaptiveRecursiveCanaryWorker,
  runAdaptiveRecursiveCanary
} from '../src/adaptive-recursive-runner.mjs';
import { isExecEnabled } from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import { persistAdaptiveRecursiveCanaryResult } from '../src/mechanism-catalog.mjs';

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
  process.stderr.write('error: --config, --run-id, and --approved-plan are required\n');
  process.exit(2);
}
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const home = resolve(arg('--home', process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')));
const raw = JSON.parse(readFileSync(resolve(configArg), 'utf8'));
const prepared = prepareAdaptiveRecursiveCanaryConfig(raw, {
  packageRoot,
  codexBinaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  approvedPlanSha256
});
if (prepared.status !== 'OK') {
  process.stderr.write(`${prepared.code}: ${prepared.message}\nNo worker was launched.\n`);
  process.exit(4);
}
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== prepared.config.runtimeAuthority.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== prepared.config.runtimeAuthority.binary.sha256) {
  process.stderr.write('RECURSIVE_OAUTH_LOCK_BLOCKED: launch authority is missing or mismatched\n');
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write('error: set SUPER_LOOP_ALLOW_EXEC=1 for the exact approved recursive run\n');
  process.exit(3);
}
const store = createStore(home);
const result = runAdaptiveRecursiveCanary(store, prepared.config, {
  runId,
  worker: adaptiveRecursiveCanaryWorker
});
const catalogPersistence = result.experimentValid === true
  ? persistAdaptiveRecursiveCanaryResult({
      homeDir: home,
      sourceStore: store,
      runId
    })
  : null;
process.stdout.write(`${JSON.stringify({
  status: result.status,
  runId: result.runId || runId,
  experimentValid: result.experimentValid ?? false,
  causalPass: result.causalPass ?? false,
  activationEligible: result.activationEligible ?? false,
  reportPath: result.reportPath || null,
  statePath: result.statePath || null,
  catalogPersistence: catalogPersistence ? {
    status: catalogPersistence.status,
    causalPass: catalogPersistence.causalPass ?? false,
    activationEligible: catalogPersistence.activationEligible ?? false,
    verifierEvidenceSha256: catalogPersistence.verifierEvidenceSha256 || null,
    persisted: catalogPersistence.persisted || [],
    code: catalogPersistence.code || null,
    message: catalogPersistence.message || null
  } : null,
  code: result.code || null,
  message: result.message || null
}, null, 2)}\n`);
process.exit(
  result.experimentValid === true
    && catalogPersistence?.status === 'OK'
    ? 0
    : 1
);
