#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.mjs';
import {
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import {
  createVNextMatchedPhasePlan,
  persistVNextMatchedPhasePlan,
  verifyVNextMatchedPhasePlanFromDisk
} from '../src/vnext-matched-phase.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = { children: [] };
  if (argv.length % 2 !== 0) return null;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--home', '--protocol', '--phase', '--child'].includes(key)
        || typeof value !== 'string') return null;
    if (key === '--child') {
      const parts = value.split(':');
      if (parts.length !== 2) return null;
      out.children.push({ seriesRunId: parts[0], waveId: parts[1] });
    } else out[key.slice(2)] = value;
  }
  return out.home && out.protocol && out.phase && out.children.length
    ? out
    : null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write([
    'usage: npm run vnext:matched:plan --',
    '--home <proof-home> --protocol <protocol.json> --phase <P0-P3-id>',
    '--child <series-run-id>:<wave-id> [--child ...]'
  ].join(' ') + '\n');
  process.exit(2);
}

let protocol;
try {
  protocol = JSON.parse(readFileSync(resolve(args.protocol), 'utf8'));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED', code: 'MATCHED_PHASE_PROTOCOL_JSON_INVALID', message: error.message
  }, null, 2)}\n`);
  process.exit(2);
}

const home = resolve(args.home);
const store = createStore(home);
const protocolReplay = verifyVNextAblationProtocolFromDisk({
  protocol,
  packageRoot: PACKAGE_ROOT
});
if (protocolReplay.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(protocolReplay, null, 2)}\n`);
  process.exit(1);
}
const built = createVNextMatchedPhasePlan({
  store,
  protocol,
  phaseId: args.phase,
  children: args.children,
  packageRoot: PACKAGE_ROOT
});
if (built.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
  process.exit(1);
}
const persisted = persistVNextMatchedPhasePlan({ store, plan: built.plan });
if (persisted.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
  process.exit(1);
}
const replay = verifyVNextMatchedPhasePlanFromDisk({
  store,
  protocolSha256: protocol.protocolSha256,
  phaseId: args.phase
});
if (replay.status !== 'OK' || replay.readyToLaunch !== true) {
  process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
  process.exit(1);
}
const runScript = fileURLToPath(new URL('./run-vnext-study-wave.mjs', import.meta.url));
const launchCommands = built.plan.children.map((child) => ({
  armId: child.armId,
  disclosureSha256: child.disclosureSha256,
  command: [
    shellQuote(process.execPath), shellQuote(runScript),
    '--home', shellQuote(home),
    '--run', shellQuote(child.seriesRunId),
    '--wave', shellQuote(child.waveId),
    '--approved-plan', child.disclosureSha256,
    '--protocol', shellQuote(resolve(args.protocol))
  ].join(' ')
}));

process.stdout.write(`${JSON.stringify({
  status: 'OK',
  workerLaunched: false,
  paidModelCalls: 0,
  matchedPhasePlanSha256: built.plan.planSha256,
  phaseId: built.plan.phaseId,
  common: built.plan.common,
  exposure: built.plan.exposure,
  launchPolicy: 'approve-and-run-each-child-command-separately',
  launchCommands
}, null, 2)}\n`);
