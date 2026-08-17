#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyAdaptiveRecursiveCanaryV2Run
} from '../src/adaptive-recursive-runner-v2.mjs';
import { createStore } from '../src/store.mjs';
import {
  verifyAdaptiveRecursiveVNextLeaseReceipt
} from '../src/adaptive-recursive-vnext-run.mjs';

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
const home = resolve(arg(
  '--home',
  process.env.SUPER_LOOP_HOME || join(packageRoot, '.super-loop')
));
const store = createStore(home);
const result = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
const state = store.load(runId);
let config = null;
try {
  config = JSON.parse(store.readArtifact(
    runId,
    state?.evidenceArtifacts?.config?.id
  )?.content || '');
} catch {}
const lease = config?.vnextBinding
  ? verifyAdaptiveRecursiveVNextLeaseReceipt(store, runId)
  : null;
process.stdout.write(`${JSON.stringify({
  ...result,
  vnextLease: lease
}, null, 2)}\n`);
process.exit(result.experimentValid === true && (!lease || lease.status === 'OK') ? 0 : 1);
