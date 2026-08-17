#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAdaptiveRecursiveCanaryRun } from '../src/adaptive-recursive-runner.mjs';
import { createStore } from '../src/store.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

const runId = arg('--run');
if (!runId) {
  process.stderr.write('error: --run <run-id> is required\n');
  process.exit(2);
}
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const home = resolve(arg('--home', process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')));
const result = verifyAdaptiveRecursiveCanaryRun(createStore(home), runId);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.experimentValid === true ? 0 : 1);
