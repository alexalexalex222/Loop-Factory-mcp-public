#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  runVNextFrozenCandidateStudy
} from '../src/vnext-frozen-candidate-study.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
}

const home = arg('--home');
const studyId = arg('--study');
const approvedPlanSha256 = arg('--approved-plan');
if (!home || !studyId || !approvedPlanSha256) {
  process.stderr.write('usage: npm run vnext:frozen:run -- --home <proof-home> --study <study-id> --approved-plan <sha256>\n');
  process.exit(2);
}

const result = runVNextFrozenCandidateStudy({
  proofHome: resolve(home),
  studyId,
  approvedPlanSha256
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
