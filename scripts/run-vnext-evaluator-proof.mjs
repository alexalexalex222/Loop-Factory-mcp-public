#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  loadVNextEvaluatorProofPlan,
  runVNextEvaluatorProof
} from '../src/vnext-evaluator-proof.mjs';

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--home', '--id', '--approved-plan'].includes(argv[index])
        || typeof argv[index + 1] !== 'string') return null;
    out[argv[index].slice(2).replace('-', '')] = argv[index + 1];
  }
  return out.home && out.id && out.approvedplan ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:evaluator:run -- --home <proof-home> --id <proof-id> --approved-plan <plan-sha256>\n');
  process.exit(2);
}
const loaded = loadVNextEvaluatorProofPlan({
  proofHome: resolve(args.home),
  proofId: args.id
});
if (loaded.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(loaded, null, 2)}\n`);
  process.exit(1);
}
const runtime = loaded.plan.runtimeAuthority;
const env = {
  ...process.env,
  SUPER_LOOP_ALLOW_EXEC: '1',
  SUPER_LOOP_REQUIRE_CHATGPT_OAUTH: '1',
  SUPER_LOOP_CODEX_BIN: runtime.binary.path,
  SUPER_LOOP_CODEX_EXECUTABLE_SHA256: runtime.binary.sha256,
  SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256: runtime.authoritySha256
};
const result = await runVNextEvaluatorProof({
  plan: loaded.plan,
  directory: loaded.directory,
  approvedPlanSha256: args.approvedplan,
  env
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
