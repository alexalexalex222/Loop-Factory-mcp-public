#!/usr/bin/env node
// Read-only verifier for a persisted strict real-test run.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.mjs';
import { verifyRun } from '../src/run-verifier.mjs';
import { resolveStateHome } from '../src/state-home.mjs';

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
const home = resolveStateHome(packageRoot, { home: arg('--home') }).homeDir;
const result = verifyRun(createStore(home), runId);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.publicationEligible === true ? 0 : 1);
