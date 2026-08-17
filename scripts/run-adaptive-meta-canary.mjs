#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_META_CANARY_SCHEMA_VERSION,
  buildAdaptiveMetaCanaryPlan,
  resolveAdaptiveMetaCanaryImplementation,
  runAdaptiveMetaCanary,
  validateAdaptiveMetaCanaryConfig
} from '../src/adaptive-meta-canary.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import {
  STRICT_CODEX_REASONING_EFFORT,
  executorWorker,
  isExecEnabled
} from '../src/executor.mjs';
import { resolveEvidenceCapsule } from '../src/real-test.mjs';
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
    'error: --config <meta-canary.json>, --run-id <id>, and --approved-plan <sha256> are required\n'
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
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== runtimeAuthority.record.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== runtimeAuthority.record.binary.sha256) {
  process.stderr.write(
    'ADAPTIVE_META_CANARY_OAUTH_LOCK BLOCKED: launch authority or executable hash is missing or mismatched\n'
  );
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
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
const plan = buildAdaptiveMetaCanaryPlan(config);
const validation = validateAdaptiveMetaCanaryConfig(config);
process.stdout.write(`adaptive meta-canary plan sha256: ${plan.sha256}\n`);
if (!validation.ok) {
  process.stderr.write('ADAPTIVE_META_CANARY_CONFIG BLOCKED\n');
  for (const error of validation.errors) process.stderr.write(`- ${error}\n`);
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write('error: set SUPER_LOOP_ALLOW_EXEC=1 to launch the approved meta-canary\n');
  process.exit(3);
}

const result = runAdaptiveMetaCanary(createStore(home), config, {
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
