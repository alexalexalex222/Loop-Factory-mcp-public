#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptiveRecursiveCanaryV2LaunchDisclosure,
  prepareAdaptiveRecursiveCanaryV2Config,
  validateAdaptiveRecursiveCanaryV2Config
} from '../src/adaptive-recursive-canary-v2.mjs';

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
    'error: --config <recursive-v2.json> and --run-id <id> are required\n'
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
let prepared = prepareAdaptiveRecursiveCanaryV2Config(raw, {
  packageRoot,
  codexBinaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  approvedPlanSha256: raw.vnextBinding ? null : approvedPlanSha256
});
if (prepared.status !== 'OK') {
  process.stderr.write(`${prepared.code}: ${prepared.message}\nNo worker was launched.\n`);
  process.exit(4);
}
if (raw.vnextBinding) {
  if (approvedPlanSha256 != null && approvedPlanSha256 !== prepared.plan.sha256) {
    process.stderr.write('VNEXT_PLAN_HASH_MISMATCH: supplied approval does not match the verified plan\n');
    process.exit(4);
  }
  const config = {
    ...prepared.config,
    approvedPlanSha256: prepared.plan.sha256
  };
  const validation = validateAdaptiveRecursiveCanaryV2Config(config);
  if (!validation.ok) {
    process.stderr.write(`VNEXT_SELF_APPROVAL_BLOCKED: ${validation.errors.join('; ')}\n`);
    process.exit(4);
  }
  prepared = { status: 'OK', config, plan: validation.plan };
}
const validation = validateAdaptiveRecursiveCanaryV2Config(prepared.config);
const approvalError =
  'approved plan SHA-256 does not match the prepared recursive V2 plan';
const nonApprovalErrors = validation.errors.filter((error) => error !== approvalError);
const disclosure = adaptiveRecursiveCanaryV2LaunchDisclosure(prepared.config, {
  configPath,
  home,
  runId
});
const status = nonApprovalErrors.length
  ? 'BLOCKED'
  : (validation.ok
      ? (raw.vnextBinding ? 'READY_VERIFIER_SELF_BOUND' : 'READY')
      : 'AWAITING_EXACT_APPROVAL');
process.stdout.write(`${JSON.stringify({
  status,
  configPath,
  plan: validation.plan,
  disclosure,
  taskManifest: prepared.config.taskMaterials.map((task) => ({
    stage: task.stage,
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
  approvalAuthority: raw.vnextBinding
    ? 'deterministic-verifier'
    : 'operator-exact-plan-hash',
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
