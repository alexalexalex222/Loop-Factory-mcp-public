import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildVNextModelWorkerEnvironment,
  runVNextModelWorker,
  verifyVNextModelWorkerFromDisk
} from '../src/vnext-model-worker.mjs';
import { createFakeCli } from './fixtures/fake-cli.mjs';

test('model worker child execution requires inherited operator authority', () => {
  assert.equal(
    buildVNextModelWorkerEnvironment({}, false).SUPER_LOOP_ALLOW_EXEC,
    undefined
  );
  assert.equal(
    buildVNextModelWorkerEnvironment({ SUPER_LOOP_ALLOW_EXEC: '0' }, false)
      .SUPER_LOOP_ALLOW_EXEC,
    undefined
  );
  assert.equal(
    buildVNextModelWorkerEnvironment({ SUPER_LOOP_ALLOW_EXEC: '1' }, false)
      .SUPER_LOOP_ALLOW_EXEC,
    '1'
  );
});

function input(id, overrides = {}) {
  return {
    invocationId: id,
    kind: 'hypothesis',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    prompt: 'Frozen hypothesis context.',
    inputRefs: [{ id: 'dossier-1', schemaVersion: 'stage-v1', sha256: 'a'.repeat(64) }],
    permittedInformation: ['frozen dossier'],
    forbiddenInformation: ['sealed tasks'],
    binaryIdentity: { basename: 'codex', sha256: 'b'.repeat(64) },
    stateRoot: mkdtempSync(join(tmpdir(), 'vnext-worker-test-')),
    ...overrides
  };
}

function output() {
  return {
    schemaVersion: 'vnext-hypothesis-output-v1', component: 'retrieval',
    statement: 'Reserve a negative precedent.', mechanism: 'Selection preserves warning evidence.',
    targetBehavior: 'retrieval', prediction: 'negative recall rises', falsifier: 'recall does not rise',
    taskAgnostic: true, controls: ['irrelevant-memory sham'], evidenceIds: ['dossier-1']
  };
}

test('generic VNext stages run in distinct child processes with strict receipts', async () => {
  const first = await runVNextModelWorker(input('hypothesis-1'), {
    allowTestFixture: true, testFixtureOutput: output(),
    testFixtureUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    timeoutMs: 10_000
  });
  const second = await runVNextModelWorker(input('hypothesis-2'), {
    allowTestFixture: true, testFixtureOutput: output(), timeoutMs: 10_000
  });
  assert.equal(first.status, 'OK');
  assert.equal(second.status, 'OK');
  assert.notEqual(first.receipt.workerPid, process.pid);
  assert.notEqual(first.receipt.workerPid, second.receipt.workerPid);
  assert.notEqual(first.contract.stateDirectory, second.contract.stateDirectory);
  assert.equal(first.receipt.productionEvidence, false);
  assert.equal(first.receipt.activationAuthority, false);
  assert.equal(first.receipt.tokenUsageDetails.totalTokens, 120);
  assert.equal(verifyVNextModelWorkerFromDisk(first).status, 'OK');
  const workerPacket = JSON.parse(readFileSync(
    join(first.contract.stateDirectory, 'worker-result.json'),
    'utf8'
  ));
  assert.equal(typeof workerPacket.stdoutDiagnostic?.text, 'string');
  assert.equal(Object.hasOwn(workerPacket, 'stdout'), false);
});

test('generic VNext timeout kills and reaps the complete worker process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vnext-worker-timeout-'));
  const pidPath = join(root, 'codex.pid');
  const bin = createFakeCli(root, 'codex', {
    delayMs: 30_000,
    pidFilePath: pidPath
  });
  const result = await runVNextModelWorker(input('hypothesis-timeout'), {
    env: {
      ...process.env,
      SUPER_LOOP_ALLOW_EXEC: '1',
      SUPER_LOOP_CODEX_BIN: bin
    },
    timeoutMs: 1_000
  });
  assert.equal(result.code, 'VNEXT_MODEL_WORKER_TIMEOUT');
  const childPid = Number(readFileSync(pidPath, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('generic worker rejects output for the wrong stage schema', async () => {
  const result = await runVNextModelWorker(input('hypothesis-invalid'), {
    allowTestFixture: true,
    testFixtureOutput: { schemaVersion: 'vnext-reranker-output-v1', rankings: [], abstain: true, abstainReason: 'wrong stage' },
    timeoutMs: 10_000
  });
  assert.equal(result.status, 'REFUSED');
});

test('disk replay rejects worker result tampering', async () => {
  const result = await runVNextModelWorker(input('hypothesis-tamper'), {
    allowTestFixture: true, testFixtureOutput: output(), timeoutMs: 10_000
  });
  const tampered = structuredClone(result.output);
  tampered.statement = 'Changed after execution.';
  assert.equal(
    verifyVNextModelWorkerFromDisk({ ...result, output: tampered }).status,
    'REFUSED'
  );
});

test('external discovery workers receive the research-only browser policy', async () => {
  const result = await runVNextModelWorker(input('external-research-1', {
    kind: 'external-research-discovery',
    prompt: 'Find primary sources inside the frozen allowlist.'
  }), {
    allowTestFixture: true,
    testFixtureOutput: {
      schemaVersion: 'vnext-external-research-discovery-output-v1',
      abstain: false,
      abstainReason: null,
      searchSummary: 'Primary evidence found.',
      queries: ['official evidence'],
      sources: [{
        sourceId: 'paper-1',
        url: 'https://arxiv.org/abs/2501.00001',
        title: 'Primary paper',
        reason: 'Official paper.',
        authorityClass: 'primary'
      }],
      uncertainties: []
    },
    timeoutMs: 10_000
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.contract.toolPolicy, 'research-web-read-only');
  assert.equal(verifyVNextModelWorkerFromDisk(result).status, 'OK');
});
