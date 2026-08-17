#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { executorWorker } from '../src/executor.mjs';
import { stableJson } from '../src/canary-runner.mjs';
import { nowIso, sha256 } from '../src/util.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
}

const contractArg = arg('--contract');
const packetArg = arg('--packet');
const slotId = arg('--slot-id');
const contractSha256 = arg('--contract-sha256');
if (!contractArg || !packetArg || !slotId || !contractSha256) {
  process.stderr.write(
    'error: --contract, --packet, --slot-id, and --contract-sha256 are required\n'
  );
  process.exit(2);
}

const contractPath = resolve(contractArg);
const packetPath = resolve(packetArg);
let contract;
let contractText;
try {
  contractText = readFileSync(contractPath, 'utf8');
  contract = JSON.parse(contractText);
} catch (error) {
  process.stderr.write(`error: cannot load cohort contract: ${error.message}\n`);
  process.exit(2);
}
if (sha256(contractText) !== contractSha256) {
  process.stderr.write('error: cohort contract hash mismatch\n');
  process.exit(4);
}

const packet = executorWorker({ ...contract, attempt: 0 });
const envelope = {
  schemaVersion: 'cohort-call-packet-v1',
  slotId,
  contractSha256,
  persistedAt: nowIso(),
  packet
};
const content = stableJson(envelope);
const temporaryPath = `${packetPath}.tmp-${process.pid}`;
mkdirSync(dirname(packetPath), { recursive: true });
writeFileSync(temporaryPath, content);
renameSync(temporaryPath, packetPath);
process.stdout.write(`${JSON.stringify({
  status: 'PACKET_PERSISTED',
  slotId,
  packetSha256: sha256(content)
})}\n`);
