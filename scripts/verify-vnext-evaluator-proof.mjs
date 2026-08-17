#!/usr/bin/env node

import { resolve } from 'node:path';
import { verifyVNextEvaluatorProofFromDisk } from '../src/vnext-evaluator-proof.mjs';

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--home', '--id'].includes(argv[index])
        || typeof argv[index + 1] !== 'string') return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out.home && out.id ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run verify:vnext:evaluator -- --home <proof-home> --id <proof-id>\n');
  process.exit(2);
}
const result = verifyVNextEvaluatorProofFromDisk({
  proofHome: resolve(args.home),
  proofId: args.id
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
