#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { resolveWorkerBinary } from '../src/executor.mjs';
import {
  createVNextEvaluatorProofPlan,
  persistVNextEvaluatorProofPlan
} from '../src/vnext-evaluator-proof.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = { model: 'gpt-5.6-sol', reasoning: 'high' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--home', '--id', '--input', '--model', '--reasoning',
      '--codex-bin', '--created-at'].includes(key)
        || typeof argv[index + 1] !== 'string') return null;
    out[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
      = argv[index + 1];
  }
  return out.home && out.id && out.input ? out : null;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function finish(value, code = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(code);
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:evaluator:plan -- --home <proof-home> --id <proof-id> --input <request.json> [--model gpt-5.6-sol] [--reasoning high] [--codex-bin <absolute>] [--created-at <ISO>]\n');
  process.exit(2);
}
let input;
try {
  input = JSON.parse(readFileSync(resolve(args.input), 'utf8'));
} catch (error) {
  finish({ status: 'REFUSED', code: 'EVALUATOR_PROOF_INPUT_JSON_INVALID', message: error.message }, 2);
}
const binary = args.codexBin
  ? { binPath: resolve(args.codexBin) }
  : resolveWorkerBinary(args.model, process.env);
const authority = captureCodexOAuthAuthority({
  binaryPath: binary.binPath,
  requestedModel: args.model,
  reasoningEffort: args.reasoning
});
if (authority.status !== 'OK') finish(authority, 1);
const built = createVNextEvaluatorProofPlan({
  packageRoot: PACKAGE_ROOT,
  proofHome: resolve(args.home),
  proofId: args.id,
  createdAt: args.createdAt ?? new Date().toISOString(),
  runtimeAuthority: authority.record,
  ...input
});
if (built.status !== 'OK') finish(built, 1);
const persisted = persistVNextEvaluatorProofPlan(built);
if (persisted.status !== 'OK') finish(persisted, 1);
const runScript = fileURLToPath(new URL('./run-vnext-evaluator-proof.mjs', import.meta.url));
const verifyScript = fileURLToPath(new URL('./verify-vnext-evaluator-proof.mjs', import.meta.url));
const runCommand = [
  quote(process.execPath), quote(runScript),
  '--home', quote(built.plan.proofHome),
  '--id', quote(built.plan.proofId),
  '--approved-plan', built.plan.planSha256
].join(' ');
const verifyCommand = [
  quote(process.execPath), quote(verifyScript),
  '--home', quote(built.plan.proofHome),
  '--id', quote(built.plan.proofId)
].join(' ');
finish({
  status: 'OK',
  workerLaunched: false,
  paidModelCalls: 0,
  approvalPlanSha256: built.plan.planSha256,
  plan: built.plan,
  exactLaunchCommand: runCommand,
  exactVerifyCommand: verifyCommand
});
