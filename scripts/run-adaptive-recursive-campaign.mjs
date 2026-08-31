#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareAdaptiveRecursiveCampaignConfig,
  runAdaptiveRecursiveCampaign
} from '../src/adaptive-recursive-campaign.mjs';
import { isExecEnabled } from '../src/executor.mjs';
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
  process.stderr.write('error: --config, --run-id, and --approved-plan are required\n');
  process.exit(2);
}
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(configArg);
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const artifactRoot = resolve(arg('--artifact-root', dirname(configPath)));
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
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== prepared.config.runtimeAuthority.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== prepared.config.runtimeAuthority.binary.sha256) {
  process.stderr.write(
    'RECURSIVE_CAMPAIGN_OAUTH_LOCK_BLOCKED: launch authority is missing or mismatched\n'
  );
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write(
    'error: set SUPER_LOOP_ALLOW_EXEC=1 for the exact approved recursive campaign\n'
  );
  process.exit(3);
}
const stopFile = join(home, 'runs', runId, 'OPERATOR_STOP');
const result = runAdaptiveRecursiveCampaign(createStore(home), prepared.config, {
  runId,
  shouldStop: () => existsSync(stopFile)
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  disposition: result.disposition || result.state?.status || null,
  runId: result.runId || runId,
  reportPath: result.reportPath || null,
  statePath: result.statePath || null,
  verification: result.verification || null,
  stopFile,
  code: result.code || null,
  message: result.message || null
}, null, 2)}\n`);
process.exit(result.verification?.experimentValid === true ? 0 : 1);
