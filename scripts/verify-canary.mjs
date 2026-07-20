#!/usr/bin/env node
// Read-only verifier for a persisted one-finding three-arm canary.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCanaryRun } from '../src/canary-runner.mjs';
import { createStore } from '../src/store.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const runId = arg('--run');
if (!runId) {
  process.stderr.write('error: --run <run-id> is required\n');
  process.exit(2);
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const home = arg('--home', process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop'));
const result = verifyCanaryRun(createStore(home), runId);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.experimentValid === true ? 0 : 1);
