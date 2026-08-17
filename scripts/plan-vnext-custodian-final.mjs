#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { resolveWorkerBinary } from '../src/executor.mjs';
import { verifyVNextCustodianPackage } from '../src/vnext-custodian-package.mjs';
import {
  createVNextFrozenCandidateCustodyBinding,
  createVNextFrozenCandidateStudyPlanFromEvidence,
  persistVNextFrozenCandidateStudyPlan
} from '../src/vnext-frozen-candidate-study.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED = new Set([
  'packageRoot', 'home', 'study', 'runId', 'taskPack', 'materials'
]);
const OPTIONAL = new Set([
  'codexBin', 'createdAt', 'historicalTokenEstimate'
]);

function parse(argv) {
  if (argv.length % 2 !== 0) return null;
  const out = { historicalTokenEstimate: 4_000_000 };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || typeof value !== 'string') return null;
    const name = key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!REQUIRED.has(name) && !OPTIONAL.has(name)) return null;
    out[name] = value;
  }
  out.historicalTokenEstimate = Number(out.historicalTokenEstimate);
  return [...REQUIRED].every((key) => typeof out[key] === 'string' && out[key])
      && Number.isSafeInteger(out.historicalTokenEstimate)
      && out.historicalTokenEstimate > 0
    ? out
    : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fail(result, code = 1) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write([
    'usage: node scripts/plan-vnext-custodian-final.mjs',
    '--package-root <extracted-capsule> --home <new-proof-home>',
    '--study <study-id> --run-id <run-id>',
    '--task-pack <final-task-pack.json> --materials <final-materials.json>',
    '[--codex-bin <absolute>] [--created-at <ISO>]',
    '[--historical-token-estimate 4000000]'
  ].join(' ') + '\n');
  process.exit(2);
}

const packageRoot = resolve(args.packageRoot);
const packageVerification = verifyVNextCustodianPackage({ packageRoot });
if (packageVerification.status !== 'OK') fail(packageVerification);
const custody = createVNextFrozenCandidateCustodyBinding({
  verification: packageVerification
});
if (custody.status !== 'OK') fail(custody);

let protocol;
let sourceSnapshot;
let transferPrerequisite;
let taskPack;
let taskMaterialBundle;
try {
  protocol = readJson(resolve(packageRoot, 'frozen-protocol.json'));
  sourceSnapshot = readJson(resolve(packageRoot, 'frozen-source-snapshot.json'));
  transferPrerequisite = readJson(resolve(packageRoot, 'transfer-prerequisite.json'));
  taskPack = readJson(args.taskPack);
  taskMaterialBundle = readJson(args.materials);
} catch (error) {
  fail({
    status: 'REFUSED',
    code: 'CUSTODIAN_FINAL_INPUT_JSON_INVALID',
    message: error.message
  }, 2);
}

const binary = args.codexBin
  ? { binPath: resolve(args.codexBin) }
  : resolveWorkerBinary('gpt-5.6-sol', process.env);
const runtimeAuthority = captureCodexOAuthAuthority({
  binaryPath: binary.binPath,
  requestedModel: 'gpt-5.6-sol',
  reasoningEffort: 'high'
});
if (runtimeAuthority.status !== 'OK') fail(runtimeAuthority);

const home = resolve(args.home);
const built = createVNextFrozenCandidateStudyPlanFromEvidence({
  packageRoot,
  proofHome: home,
  studyId: args.study,
  runId: args.runId,
  role: 'final',
  createdAt: args.createdAt ?? new Date().toISOString(),
  protocol,
  sourceSnapshot,
  transferPrerequisite,
  custodyBinding: custody.binding,
  taskPack,
  taskMaterialBundle,
  runtimeAuthority: runtimeAuthority.record,
  historicalTokenEstimate: args.historicalTokenEstimate
});
if (built.status !== 'OK') fail(built);
const persisted = persistVNextFrozenCandidateStudyPlan({
  directory: built.directory,
  plan: built.plan
});
if (persisted.status !== 'OK') fail(persisted);

const runScript = fileURLToPath(new URL('./run-vnext-frozen-candidate-study.mjs', import.meta.url));
const verifyScript = fileURLToPath(new URL('./verify-vnext-frozen-candidate-study.mjs', import.meta.url));
const exactLaunchCommand = [
  shellQuote(process.execPath), shellQuote(runScript),
  '--home', shellQuote(home),
  '--study', shellQuote(args.study),
  '--approved-plan', built.plan.planSha256
].join(' ');
const exactVerifyCommand = [
  shellQuote(process.execPath), shellQuote(verifyScript),
  '--home', shellQuote(home),
  '--study', shellQuote(args.study)
].join(' ');

process.stdout.write(`${JSON.stringify({
  status: 'OK',
  workerLaunched: false,
  paidModelCalls: 0,
  studyId: built.plan.studyId,
  runId: built.plan.runId,
  role: built.plan.role,
  approvalPlanSha256: built.plan.planSha256,
  custodyBindingSha256: built.plan.custody.bindingSha256,
  custodianManifestSha256: built.plan.custody.manifestSha256,
  sourceSnapshotSha256: built.plan.source.sourceSnapshotSha256,
  frozenCandidateSha256: built.plan.source.frozenCandidateSha256,
  targetPackSha256: built.plan.target.packSha256,
  prerequisiteSha256: built.plan.prerequisite.prerequisiteSha256,
  exposure: built.plan.exposure,
  exactLaunchCommand,
  exactVerifyCommand
}, null, 2)}\n`);
