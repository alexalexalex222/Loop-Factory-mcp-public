#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareAdaptiveRecursiveCanaryV2Config
} from '../src/adaptive-recursive-canary-v2.mjs';
import {
  runAdaptiveRecursiveCanaryV2
} from '../src/adaptive-recursive-runner-v2.mjs';
import {
  runAdaptiveRecursiveCanaryV2WithLease
} from '../src/adaptive-recursive-vnext-run.mjs';
import { adaptiveRecursiveCanaryWorker } from '../src/adaptive-recursive-runner.mjs';
import { isExecEnabled } from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import {
  persistAdaptiveRecursiveCanaryV2Result
} from '../src/mechanism-catalog.mjs';
import {
  persistVNextRecursiveEvidence
} from '../src/vnext-recursive-import.mjs';
import {
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
const approvedPlanSha256 = arg('--approved-plan');
if (!configArg || !runId) {
  process.stderr.write('error: --config and --run-id are required\n');
  process.exit(2);
}
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const raw = JSON.parse(readFileSync(resolve(configArg), 'utf8'));
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
} else if (!approvedPlanSha256) {
  process.stderr.write('error: legacy recursive V2 runs require --approved-plan\n');
  process.exit(2);
}
if (process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH !== '1'
    || process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256
      !== prepared.config.runtimeAuthority.authoritySha256
    || process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256
      !== prepared.config.runtimeAuthority.binary.sha256) {
  process.stderr.write(
    'RECURSIVE_V2_OAUTH_LOCK_BLOCKED: launch authority is missing or mismatched\n'
  );
  process.exit(4);
}
if (!isExecEnabled()) {
  process.stderr.write(
    'error: set SUPER_LOOP_ALLOW_EXEC=1 for the exact approved recursive V2 run\n'
  );
  process.exit(3);
}
const store = createStore(home);
const stopFile = join(home, 'runs', runId, 'OPERATOR_STOP');
const run = prepared.config.resourceBudgetPolicy
  ? runAdaptiveRecursiveCanaryV2WithLease
  : runAdaptiveRecursiveCanaryV2;
const result = run(store, prepared.config, {
  runId,
  worker: adaptiveRecursiveCanaryWorker,
  shouldStop: () => existsSync(stopFile)
});
const catalogPersistence = result.experimentValid === true
  ? (prepared.config.vnextBinding
      ? persistVNextRecursiveEvidence({
          homeDir: home,
          sourceStore: store,
          runId
        })
      : persistAdaptiveRecursiveCanaryV2Result({
      homeDir: home,
      sourceStore: store,
      runId
        }))
  : null;
process.stdout.write(`${JSON.stringify({
  status: result.status,
  runId: result.runId || runId,
  experimentValid: result.experimentValid ?? false,
  calibrationQualified: result.calibrationQualified ?? null,
  causalPass: result.causalPass ?? false,
  activationEligible: result.activationEligible ?? false,
  reportPath: result.reportPath || null,
  statePath: result.statePath || null,
  stopFile,
  approvalAuthority: prepared.config.vnextBinding
    ? 'deterministic-verifier'
    : 'operator-exact-plan-hash',
  approvedPlanSha256: prepared.config.approvedPlanSha256,
  leaseReceiptSha256: result.leaseReceiptSha256 || null,
  catalogPersistence: catalogPersistence ? {
    status: catalogPersistence.status,
    causalPass: catalogPersistence.causalPass ?? false,
    activationEligible: catalogPersistence.activationEligible ?? false,
    verifierEvidenceSha256: catalogPersistence.verifierEvidenceSha256
      || catalogPersistence.catalog?.verifierEvidenceSha256
      || null,
    evidenceRecordSha256: catalogPersistence.record?.recordSha256 || null,
    evidenceLedgerSha256: catalogPersistence.evidenceLedgerSha256 || null,
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
