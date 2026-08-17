#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStore } from '../src/store.mjs';
import {
  verifyVNextMatchedPhasePlanFromDisk,
  verifyVNextMatchedPhaseResults
} from '../src/vnext-matched-phase.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
}

const home = arg('--home');
const protocolPath = arg('--protocol');
const phaseId = arg('--phase');
const mode = arg('--mode') ?? 'plan';
if (!home || !protocolPath || !phaseId || !['plan', 'results'].includes(mode)) {
  process.stderr.write('usage: npm run verify:vnext:matched -- --home <proof-home> --protocol <protocol.json> --phase <id> [--mode plan|results]\n');
  process.exit(2);
}

let protocol;
try {
  protocol = JSON.parse(readFileSync(resolve(protocolPath), 'utf8'));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED', code: 'MATCHED_PHASE_PROTOCOL_JSON_INVALID', message: error.message
  }, null, 2)}\n`);
  process.exit(2);
}
const input = {
  store: createStore(resolve(home)),
  protocolSha256: protocol.protocolSha256,
  phaseId
};
const result = mode === 'results'
  ? verifyVNextMatchedPhaseResults(input)
  : verifyVNextMatchedPhasePlanFromDisk(input);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
