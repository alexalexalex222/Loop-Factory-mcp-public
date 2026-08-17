#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { resolveWorkerBinary } from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import {
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import {
  createVNextFrozenCandidateStudyPlan,
  persistVNextFrozenCandidateStudyPlan
} from '../src/vnext-frozen-candidate-study.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = { historicalTokenEstimate: 4_000_000 };
  const flags = new Set([
    '--home', '--study', '--run-id', '--role', '--protocol',
    '--source-home', '--source-run', '--task-pack', '--materials',
    '--transfer-home', '--transfer-study', '--codex-bin', '--created-at',
    '--historical-token-estimate'
  ]);
  if (argv.length % 2 !== 0) return null;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!flags.has(key) || typeof value !== 'string') return null;
    const name = key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[name] = value;
  }
  out.historicalTokenEstimate = Number(out.historicalTokenEstimate);
  const base = out.home && out.study && out.runId
    && ['transfer', 'final'].includes(out.role)
    && out.protocol && out.sourceHome && out.sourceRun
    && out.taskPack && out.materials
    && Number.isSafeInteger(out.historicalTokenEstimate)
    && out.historicalTokenEstimate > 0;
  const prerequisite = out.role === 'final'
    ? out.transferHome && out.transferStudy
    : !out.transferHome && !out.transferStudy;
  return base && prerequisite ? out : null;
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
    'usage: npm run vnext:frozen:plan --',
    '--home <new-proof-home> --study <study-id> --run-id <run-id>',
    '--role transfer|final --protocol <protocol.json>',
    '--source-home <validation-proof-home> --source-run <B6-run-id>',
    '--task-pack <task-pack.json> --materials <materials.json>',
    '[--transfer-home <transfer-proof-home> --transfer-study <study-id>]',
    '[--codex-bin <absolute>] [--created-at <ISO>]',
    '[--historical-token-estimate 4000000]'
  ].join(' ') + '\n');
  process.exit(2);
}

let protocol;
let taskPack;
let taskMaterialBundle;
try {
  protocol = readJson(args.protocol);
  taskPack = readJson(args.taskPack);
  taskMaterialBundle = readJson(args.materials);
} catch (error) {
  fail({ status: 'REFUSED', code: 'FROZEN_CANDIDATE_INPUT_JSON_INVALID', message: error.message }, 2);
}

const protocolReplay = verifyVNextAblationProtocolFromDisk({
  protocol,
  packageRoot: PACKAGE_ROOT
});
if (protocolReplay.status !== 'OK') fail(protocolReplay);
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
const sourceHome = resolve(args.sourceHome);
const built = createVNextFrozenCandidateStudyPlan({
  packageRoot: PACKAGE_ROOT,
  proofHome: home,
  studyId: args.study,
  runId: args.runId,
  role: args.role,
  createdAt: args.createdAt ?? new Date().toISOString(),
  protocol,
  sourceStore: createStore(sourceHome),
  sourceRunId: args.sourceRun,
  taskPack,
  taskMaterialBundle,
  runtimeAuthority: runtimeAuthority.record,
  historicalTokenEstimate: args.historicalTokenEstimate,
  transferProofHome: args.transferHome ? resolve(args.transferHome) : null,
  transferStudyId: args.transferStudy ?? null
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
  innerPlanSha256: built.plan.inner.planSha256,
  sourceSnapshotSha256: built.plan.source.sourceSnapshotSha256,
  frozenCandidateSha256: built.plan.source.frozenCandidateSha256,
  targetPackSha256: built.plan.target.packSha256,
  prerequisiteSha256: built.plan.prerequisite?.prerequisiteSha256 ?? null,
  exposure: built.plan.exposure,
  exactLaunchCommand,
  exactVerifyCommand
}, null, 2)}\n`);
