#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  verifyVNextFrozenCandidateStudyFromDisk
} from '../src/vnext-frozen-candidate-study.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
}

const home = arg('--home');
const studyId = arg('--study');
if (!home || !studyId) {
  process.stderr.write('usage: npm run verify:vnext:frozen -- --home <proof-home> --study <study-id>\n');
  process.exit(2);
}

const result = verifyVNextFrozenCandidateStudyFromDisk({
  proofHome: resolve(home),
  studyId
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
