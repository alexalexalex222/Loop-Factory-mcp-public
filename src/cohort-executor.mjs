import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from './canary-runner.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_RUNNER_OUTPUT_BYTES = 1024 * 1024;

function within(base, path, label) {
  const rel = relative(base, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escaped the cohort run directory`);
  }
  return path;
}

function appendBounded(chunks, chunk, size) {
  const value = Buffer.from(chunk);
  if (size.value + value.length > MAX_RUNNER_OUTPUT_BYTES) {
    throw new Error('cohort worker wrapper exceeded its output limit');
  }
  chunks.push(value);
  size.value += value.length;
}

function refusalPacket(contract, reason, message) {
  return {
    route: contract?.route ?? null,
    phase: contract?.phase ?? null,
    __execReason: reason,
    __error: String(message || reason).slice(0, 2000),
    artifacts: [],
    finalOutput: ''
  };
}

export function createCohortSubprocessWorker({
  store,
  runId,
  packageRoot = PACKAGE_ROOT,
  nodePath = process.execPath,
  env = process.env
} = {}) {
  if (!store || typeof store.runDir !== 'function') {
    throw new Error('cohort subprocess worker requires a store');
  }
  const root = resolve(packageRoot);
  const runDir = resolve(store.runDir(runId));
  const scriptPath = resolve(root, 'scripts/run-cohort-worker.mjs');

  return async (contract, context = {}) => {
    const contractPath = within(
      runDir,
      resolve(runDir, String(context.contractPath || '')),
      'contract path'
    );
    const packetPath = within(
      runDir,
      resolve(runDir, String(context.packetPath || '')),
      'packet path'
    );
    const args = [
      scriptPath,
      '--contract', contractPath,
      '--packet', packetPath,
      '--slot-id', String(context.slotId || ''),
      '--contract-sha256', String(context.contractSha256 || '')
    ];
    const stdout = [];
    const stderr = [];
    const stdoutSize = { value: 0 };
    const stderrSize = { value: 0 };
    const exitCode = await new Promise((resolveExit, reject) => {
      const child = spawn(nodePath, args, {
        cwd: root,
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', (chunk) => {
        try {
          appendBounded(stdout, chunk, stdoutSize);
        } catch (error) {
          child.kill('SIGKILL');
          reject(error);
        }
      });
      child.stderr.on('data', (chunk) => {
        try {
          appendBounded(stderr, chunk, stderrSize);
        } catch (error) {
          child.kill('SIGKILL');
          reject(error);
        }
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) {
          reject(new Error(`cohort worker wrapper exited by signal ${signal}`));
          return;
        }
        resolveExit(code);
      });
    });
    if (exitCode !== 0) {
      return refusalPacket(
        contract,
        'COHORT_WORKER_EXIT_NONZERO',
        `cohort worker wrapper exited ${exitCode}: ${Buffer.concat(stderr).toString('utf8').trim()}`
      );
    }
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(packetPath, 'utf8'));
    } catch (error) {
      return refusalPacket(
        contract,
        'COHORT_PACKET_INVALID',
        `cohort worker packet is missing or malformed: ${error.message}`
      );
    }
    const { attempt: _attempt, ...persistedContract } = contract;
    let reopenedContract;
    try {
      reopenedContract = JSON.parse(readFileSync(contractPath, 'utf8'));
    } catch (error) {
      return refusalPacket(
        contract,
        'COHORT_CONTRACT_REPLAY_INVALID',
        `cohort worker contract changed or became malformed: ${error.message}`
      );
    }
    if (envelope?.schemaVersion !== 'cohort-call-packet-v1'
        || envelope.slotId !== context.slotId
        || envelope.contractSha256 !== context.contractSha256
        || !envelope.packet
        || stableJson(reopenedContract) !== stableJson(persistedContract)) {
      return refusalPacket(
        contract,
        'COHORT_PACKET_UNBOUND',
        'cohort worker wrapper returned an unbound packet'
      );
    }
    return envelope.packet;
  };
}
