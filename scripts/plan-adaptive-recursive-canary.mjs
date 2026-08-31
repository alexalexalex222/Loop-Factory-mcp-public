#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveRecursiveCanaryLaunchDisclosure
} from '../src/adaptive-recursive-canary.mjs';
import {
  prepareAdaptiveRecursiveCanaryConfig,
  validateAdaptiveRecursiveCanaryConfig
} from '../src/adaptive-recursive-runner.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

const configArg = arg('--config');
const runId = arg('--run-id');
if (!configArg || !runId) {
  process.stderr.write('error: --config <recursive-canary.json> and --run-id <id> are required\n');
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
const prepared = prepareAdaptiveRecursiveCanaryConfig(raw, {
  packageRoot,
  codexBinaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  approvedPlanSha256
});
if (prepared.status !== 'OK') {
  process.stderr.write(`${prepared.code}: ${prepared.message}\nNo worker was launched.\n`);
  process.exit(4);
}
const validation = validateAdaptiveRecursiveCanaryConfig(prepared.config);
const approvalError = 'approved plan SHA-256 does not match the prepared recursive plan';
const nonApprovalErrors = validation.errors.filter((error) => error !== approvalError);
const disclosure = adaptiveRecursiveCanaryLaunchDisclosure(prepared.config, {
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
  plan: validation.plan,
  disclosure,
  taskManifest: prepared.config.taskMaterials.map((task) => ({
    id: task.id,
    source: { path: task.source.path, sha256: task.source.sha256 },
    incident: { path: task.incident.path, sha256: task.incident.sha256 },
    interface: {
      path: task.interface.path,
      sha256: task.interface.sha256,
      semanticSha256: task.interface.semanticSha256
    },
    oracle: { path: task.oracle.path, sha256: task.oracle.sha256 },
    caseSetSha256: task.caseSetSha256,
    interfaceCoverageSha256: task.interfaceCoverageSha256,
    treatmentDeltaSha256: task.treatmentDeltaSha256
  })),
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

