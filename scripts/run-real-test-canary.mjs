#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealTestCanary } from '../src/canary-runner.mjs';
import { executorWorker, isExecEnabled } from '../src/executor.mjs';
import {
  buildRealTestCanaryPlan,
  resolveEvidenceCapsule,
  validateRealTestCanaryConfig
} from '../src/real-test.mjs';
import { createStore } from '../src/store.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const configPath = arg('--config');
const runId = arg('--run-id');
if (!configPath || !runId) {
  process.stderr.write('error: --config <canary.json> and --run-id <id> are required\n');
  process.exit(2);
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const evidence = resolveEvidenceCapsule(packageRoot, raw.evidenceSources);
if (!evidence.ok) {
  process.stderr.write('CANARY_EVIDENCE BLOCKED\n');
  for (const error of evidence.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
const config = {
  ...raw,
  evidenceManifest: evidence.manifest,
  evidenceCapsule: evidence.capsule,
  approvedPlanSha256: arg('--approved-plan') || raw.approvedPlanSha256 || null
};
const plan = buildRealTestCanaryPlan(config);
const validation = validateRealTestCanaryConfig(config);
process.stdout.write(`strict real-test canary plan sha256: ${plan.sha256}\n`);
if (!validation.ok) {
  process.stderr.write('CANARY_CONFIG BLOCKED\n');
  for (const error of validation.errors) process.stderr.write(`- ${error}\n`);
  if (config.approvedPlanSha256 !== plan.sha256) {
    process.stderr.write(`Operator action required: rerun with --approved-plan ${plan.sha256}\n`);
  }
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write('error: set SUPER_LOOP_ALLOW_EXEC=1 to launch the approved canary\n');
  process.exit(3);
}

const home = arg('--home', process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop'));
const result = runRealTestCanary(createStore(home), config, {
  runId,
  worker: executorWorker
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  runId: result.runId || runId,
  experimentValid: result.experimentValid ?? false,
  canaryOutcome: result.outcome?.status || null,
  reportPath: result.reportPath || null,
  statePath: result.statePath || null,
  code: result.code || null,
  message: result.message || null
}, null, 2)}\n`);
process.exit(result.status === 'OK' && result.experimentValid === true ? 0 : 1);
