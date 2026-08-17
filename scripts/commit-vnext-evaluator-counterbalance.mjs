#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createEvaluatorCounterbalanceSeedCommitment
} from '../src/isolated-evaluator.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--out', '--id', '--seed-file', '--committed-at'].includes(argv[index])
        || typeof argv[index + 1] !== 'string') return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out.out && out.id && out['seed-file'] && out['committed-at'] ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: node scripts/commit-vnext-evaluator-counterbalance.mjs --out <commitment.json> --id <qualification-id> --seed-file <private-seeds.json> --committed-at <ISO>\n');
  process.exit(2);
}
let seeds;
try {
  seeds = JSON.parse(readFileSync(resolve(args['seed-file']), 'utf8'));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED',
    code: 'EVALUATOR_COUNTERBALANCE_SEED_FILE_INVALID',
    message: error.message
  }, null, 2)}\n`);
  process.exit(2);
}
const built = createEvaluatorCounterbalanceSeedCommitment({
  qualificationId: args.id,
  seeds,
  committedAt: args['committed-at']
});
if (built.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
  process.exit(1);
}
const output = resolve(args.out);
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${canonicalVNextJson(built.commitment)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx'
});
renameSync(temporary, output);
process.stdout.write(`${JSON.stringify({
  status: 'OK',
  path: output,
  commitmentSha256: built.commitment.commitmentSha256,
  seedCount: built.commitment.formCount,
  rawSeedsPersistedInCommitment: false,
  paidModelCalls: 0
}, null, 2)}\n`);
