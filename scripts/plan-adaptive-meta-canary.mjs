#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_META_CANARY_SCHEMA_VERSION,
  adaptiveMetaCanaryLaunchDisclosure,
  resolveAdaptiveMetaCanaryImplementation,
  validateAdaptiveMetaCanaryConfig
} from '../src/adaptive-meta-canary.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { STRICT_CODEX_REASONING_EFFORT } from '../src/executor.mjs';
import { resolveEvidenceCapsule } from '../src/real-test.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

const configArg = arg('--config');
const runId = arg('--run-id');
if (!configArg || !runId) {
  process.stderr.write('error: --config <meta-canary.json> and --run-id <id> are required\n');
  process.exit(2);
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(configArg);
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const evidence = resolveEvidenceCapsule(packageRoot, raw.evidenceSources);
const heldOutEvidence = raw.schemaVersion === ADAPTIVE_META_CANARY_SCHEMA_VERSION
  ? resolveEvidenceCapsule(packageRoot, raw.heldOutEvidenceSources)
  : { ok: true, errors: [], manifest: [], capsule: [] };
const mechanismEvidence = resolveEvidenceCapsule(packageRoot, raw.mechanismEvidenceSources);
const implementation = resolveAdaptiveMetaCanaryImplementation(packageRoot);
const runtimeAuthority = captureCodexOAuthAuthority({
  binaryPath: process.env.SUPER_LOOP_CODEX_BIN,
  requestedModel: raw.model,
  reasoningEffort: STRICT_CODEX_REASONING_EFFORT
});
if (!evidence.ok || !heldOutEvidence.ok || !mechanismEvidence.ok
    || runtimeAuthority.status !== 'OK') {
  process.stderr.write('ADAPTIVE_META_CANARY_EVIDENCE BLOCKED\n');
  for (const error of evidence.errors) process.stderr.write(`- ${error}\n`);
  for (const error of heldOutEvidence.errors) process.stderr.write(`- ${error}\n`);
  for (const error of mechanismEvidence.errors) process.stderr.write(`- ${error}\n`);
  if (runtimeAuthority.status !== 'OK') {
    process.stderr.write(`- ${runtimeAuthority.code}: ${runtimeAuthority.message}\n`);
  }
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}

const approvedPlanSha256 = arg('--approved-plan');
const config = {
  ...raw,
  evidenceManifest: evidence.manifest,
  evidenceCapsule: evidence.capsule,
  heldOutEvidenceManifest: heldOutEvidence.manifest,
  heldOutEvidenceCapsule: heldOutEvidence.capsule,
  mechanismEvidenceManifest: mechanismEvidence.manifest,
  mechanismEvidenceCapsule: mechanismEvidence.capsule,
  implementationManifest: implementation.manifest,
  implementationCapsule: implementation.capsule,
  runtimeAuthority: runtimeAuthority.record,
  approvedPlanSha256
};
const disclosure = adaptiveMetaCanaryLaunchDisclosure(config, {
  configPath,
  home,
  runId
});
const validation = validateAdaptiveMetaCanaryConfig(config);
const approvalError = 'meta-canary plan is not operator-approved';
const nonApprovalErrors = validation.errors.filter((error) => error !== approvalError);
const status = nonApprovalErrors.length
  ? 'BLOCKED'
  : (validation.ok ? 'READY' : 'AWAITING_EXACT_APPROVAL');

process.stdout.write(`${JSON.stringify({
  status,
  configPath,
  evidenceManifest: evidence.manifest,
  heldOutEvidenceManifest: heldOutEvidence.manifest,
  mechanismEvidenceManifest: mechanismEvidence.manifest,
  ...disclosure,
  validationErrors: validation.errors,
  workerLaunched: false
}, null, 2)}\n`);

if (!validation.ok) {
  if (nonApprovalErrors.length) {
    process.stderr.write('ADAPTIVE_META_CANARY_CONFIG BLOCKED\n');
    for (const error of nonApprovalErrors) process.stderr.write(`- ${error}\n`);
  } else {
    process.stderr.write(
      `Operator action required: approve exact plan ${disclosure.planSha256} with --approved-plan ${disclosure.planSha256}\n`
    );
  }
  process.stderr.write('No worker was launched.\n');
  process.exitCode = 4;
} else {
  process.stdout.write('Plan-only validation passed. No worker was launched.\n');
}
