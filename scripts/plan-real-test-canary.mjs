#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REAL_TEST_CANARY,
  buildRealTestCanaryPlan,
  resolveEvidenceCapsule,
  validateRealTestCanaryConfig
} from '../src/real-test.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const configPath = arg('--config');
if (!configPath) {
  process.stderr.write('error: --config <canary.json> is required\n');
  process.exit(2);
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const evidence = resolveEvidenceCapsule(repositoryRoot, raw.evidenceSources);
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
process.stdout.write('strict real-test canary plan\n');
process.stdout.write(`plan sha256: ${plan.sha256}\n`);
process.stdout.write(`arms: ${REAL_TEST_CANARY.arms.join(', ')}\n`);
process.stdout.write(`replicates: ${REAL_TEST_CANARY.replicatesPerArm} per arm\n`);
process.stdout.write(`promotion enabled: ${REAL_TEST_CANARY.promotionEnabled}\n`);

const check = validateRealTestCanaryConfig(config);
if (!check.ok) {
  process.stderr.write('CANARY_CONFIG BLOCKED\n');
  for (const error of check.errors) process.stderr.write(`- ${error}\n`);
  if (config.approvedPlanSha256 !== plan.sha256) {
    process.stderr.write(`\nOperator action required: review the canary and rerun with --approved-plan ${plan.sha256}\n`);
  }
  process.stderr.write('No worker was launched.\n');
  process.exit(4);
}

process.stdout.write('CANARY_PLAN READY\n');
process.stdout.write('This command is plan-only. No worker was launched and no promotion is permitted.\n');
