import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCohortSubprocessWorker } from '../src/cohort-executor.mjs';
import { createStore } from '../src/store.mjs';
import { sha256 } from '../src/util.mjs';

test('malformed persisted cohort contracts return a structured refusal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cohort-executor-malformed-'));
  try {
    const store = createStore(home);
    const runId = 'cohort-malformed-contract';
    store.save({ runId });
    const contractPath = 'call-inputs/malformed.json';
    const bytes = '{not-json';
    store.writeRunFile(runId, contractPath, bytes);
    const worker = createCohortSubprocessWorker({
      store,
      runId,
      env: { ...process.env, SUPER_LOOP_ALLOW_EXEC: '0' }
    });
    const packet = await worker(
      { route: 'gpt-5.6-sol', phase: 'proposal', attempt: 0 },
      {
        slotId: 'malformed-slot',
        contractPath,
        contractSha256: sha256(bytes),
        packetPath: 'call-packets/malformed-slot.json'
      }
    );
    assert.equal(packet.__execReason, 'COHORT_WORKER_EXIT_NONZERO');
    assert.match(packet.__error, /cannot load cohort contract/);
    assert.deepEqual(packet.artifacts, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a contract changed after child execution is refused instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cohort-executor-replay-'));
  const packageRoot = mkdtempSync(join(tmpdir(), 'cohort-executor-package-'));
  try {
    mkdirSync(join(packageRoot, 'scripts'));
    writeFileSync(join(packageRoot, 'scripts', 'run-cohort-worker.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
function arg(name) {
  const index = process.argv.indexOf(name);
  return process.argv[index + 1];
}
const contractPath = arg('--contract');
const packetPath = arg('--packet');
const slotId = arg('--slot-id');
const contractSha256 = arg('--contract-sha256');
JSON.parse(readFileSync(contractPath, 'utf8'));
mkdirSync(dirname(packetPath), { recursive: true });
writeFileSync(packetPath, JSON.stringify({
  schemaVersion: 'cohort-call-packet-v1',
  slotId,
  contractSha256,
  packet: { route: 'gpt-5.6-sol', phase: 'proposal', artifacts: [], finalOutput: '' }
}));
writeFileSync(contractPath, '{broken-after-execution');
`);
    const store = createStore(home);
    const runId = 'cohort-contract-replay';
    store.save({ runId });
    const contract = { route: 'gpt-5.6-sol', phase: 'proposal' };
    const bytes = JSON.stringify(contract);
    const contractPath = 'call-inputs/replay.json';
    store.writeRunFile(runId, contractPath, bytes);
    const worker = createCohortSubprocessWorker({ store, runId, packageRoot });
    const packet = await worker(
      { ...contract, attempt: 0 },
      {
        slotId: 'replay-slot',
        contractPath,
        contractSha256: sha256(bytes),
        packetPath: 'call-packets/replay-slot.json'
      }
    );
    assert.equal(packet.__execReason, 'COHORT_CONTRACT_REPLAY_INVALID');
    assert.match(packet.__error, /changed or became malformed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
  }
});
