#!/usr/bin/env node

import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../src/executor.mjs';
import {
  validateVNextModelWorkerContract,
  vnextModelWorkerSchema
} from '../src/vnext-model-worker.mjs';
import { buildEvaluatorProcessDiagnostic } from '../src/isolated-evaluator.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { validateVNextModelOutput } from '../src/vnext-model-contracts.mjs';
import { sha256 } from '../src/util.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!['--packet', '--output', '--contract-sha256'].includes(values[index])
        || typeof values[index + 1] !== 'string') return null;
    result[values[index].slice(2)] = values[index + 1];
  }
  return Object.keys(result).length === 3 ? result : null;
}

function within(root, value) {
  if (!isAbsolute(value)) return null;
  const path = resolve(value);
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : path;
}

const parsed = args(process.argv.slice(2));
if (!parsed || !/^[a-f0-9]{64}$/.test(parsed['contract-sha256'])) fail('invalid arguments');
const root = realpathSync(process.cwd());
const packetPath = within(root, parsed.packet);
const outputPath = within(root, parsed.output);
if (!packetPath || !outputPath || dirname(packetPath) !== root || dirname(outputPath) !== root
    || statSync(packetPath).size > 2 * 1024 * 1024) fail('worker paths or input size invalid');

let packet;
try { packet = JSON.parse(readFileSync(packetPath, 'utf8')); } catch { fail('worker input is not JSON'); }
const contract = packet?.contract;
const wrapperSha256 = sha256(readFileSync(SELF_PATH));
if (packet?.schemaVersion !== 'vnext-model-worker-input-v1'
    || validateVNextModelWorkerContract(contract).status !== 'OK'
    || contract.contractSha256 !== parsed['contract-sha256']
    || contract.stateDirectory !== root
    || contract.wrapperIdentity.sha256 !== wrapperSha256
    || contract.promptSha256 !== sha256(String(packet.prompt || ''))
    || contract.outputSchemaSha256 !== sha256(canonicalVNextJson(packet.outputSchema))) {
  fail('worker contract replay failed');
}

const fixtureMode = process.env.LOOP_FACTORY_VNEXT_WORKER_TEST_FIXTURE === '1';
if ((fixtureMode && !packet.testFixtureOutput) || (!fixtureMode && packet.testFixtureOutput != null)) {
  fail('fixture authority invalid');
}
let output;
let stdout;
let executorInvocation;
let executionMode;
let tokenUsageDetails;
let tokenUsageAuthority;
if (fixtureMode) {
  output = packet.testFixtureOutput;
  stdout = canonicalVNextJson(output);
  executorInvocation = null;
  executionMode = 'test-fixture-process';
  tokenUsageDetails = packet.testFixtureUsage;
  tokenUsageAuthority = packet.testFixtureUsage ? 'test-fixture' : 'unavailable';
} else {
  const run = runWorker({
    model: contract.model,
    prompt: packet.prompt,
    env: process.env,
    executionContract: {
      kind: `vnext-${contract.kind}`,
      toolPolicy: contract.toolPolicy,
      reasoningEffort: contract.reasoningEffort
    }
  });
  if (!run.ok) {
    writeFileSync(`${outputPath}.failure`, canonicalVNextJson({
      schemaVersion: 'vnext-model-worker-failure-v1',
      contractSha256: contract.contractSha256,
      reason: run.reason ?? 'MODEL_CALL_FAILED',
      stdoutSha256: sha256(String(run.stdout || '')),
      stderrSha256: sha256(String(run.stderr || '')),
      executorInvocation: run.invocation ?? null
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fail('model call failed');
  }
  try { output = JSON.parse(run.resultText); } catch { fail('model output is not JSON'); }
  stdout = run.stdout;
  executorInvocation = run.invocation;
  executionMode = 'spawned-model-worker';
  tokenUsageDetails = run.invocation?.tokenUsageDetails ?? null;
  tokenUsageAuthority = tokenUsageDetails ? 'cli-receipt' : 'unavailable';
}
if (validateVNextModelOutput(output, vnextModelWorkerSchema(contract.kind)).status !== 'OK') {
  fail('model output violates schema');
}
const processCore = {
  contractSha256: contract.contractSha256,
  workerPid: process.pid,
  parentPid: process.ppid,
  wrapperSha256
};
const result = {
  schemaVersion: 'vnext-model-worker-result-v1',
  contractSha256: contract.contractSha256,
  processIdentity: sha256(canonicalVNextJson(processCore)),
  workerPid: process.pid,
  parentPid: process.ppid,
  executionMode,
  output,
  stdoutDiagnostic: buildEvaluatorProcessDiagnostic(stdout),
  executorInvocation,
  tokenUsageDetails,
  tokenUsageAuthority
};
const temporary = `${outputPath}.tmp-${process.pid}`;
writeFileSync(temporary, canonicalVNextJson(result), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
renameSync(temporary, outputPath);
process.stdout.write(`${sha256(canonicalVNextJson(result))}\n`);
