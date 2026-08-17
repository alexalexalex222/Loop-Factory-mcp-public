#!/usr/bin/env node

import {
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../src/executor.mjs';
import {
  EVALUATOR_WORKER_FAILURE_SCHEMA,
  buildEvaluatorProcessDiagnostic,
  buildIsolatedEvaluatorPrompt,
  validateEvaluatorInvocationContract,
  validateEvaluatorWorkerFailure,
  validateIsolatedEvaluatorRequest
} from '../src/isolated-evaluator.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';
import {
  validateEphemeralAuthCapsuleMarker
} from '../src/ephemeral-auth-capsule.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--packet', '--output', '--invocation-sha256'].includes(key)
        || typeof value !== 'string') return null;
    values[key.slice(2)] = value;
  }
  return Object.keys(values).length === 3 ? values : null;
}

function within(root, path) {
  if (!isAbsolute(path)) return null;
  const resolved = resolve(path);
  const rel = relative(root, resolved);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    ? null
    : resolved;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

const args = parseArgs(process.argv.slice(2));
if (!args || !/^[a-f0-9]{64}$/.test(args['invocation-sha256'])) {
  fail('invalid evaluator worker arguments');
}

const stateRoot = realpathSync(process.cwd());
const packetPath = within(stateRoot, args.packet);
const outputPath = within(stateRoot, args.output);
if (!packetPath || !outputPath || dirname(packetPath) !== stateRoot
    || dirname(outputPath) !== stateRoot || packetPath === outputPath) {
  fail('evaluator worker paths escaped the fresh state directory');
}
if (statSync(packetPath).size > MAX_INPUT_BYTES) fail('evaluator worker input exceeded its limit');

let packet;
try {
  packet = JSON.parse(readFileSync(packetPath, 'utf8'));
} catch {
  fail('evaluator worker input is not strict JSON');
}
if (!exactKeys(packet, [
  'invocation',
  'outputSchema',
  'prompt',
  'request',
  'schemaVersion',
  'testFixtureOutput'
]) || packet.schemaVersion !== 'vnext-evaluator-worker-input-v2') {
  fail('evaluator worker input shape is invalid');
}

const invocationValidation = validateEvaluatorInvocationContract(packet.invocation);
const requestValidation = validateIsolatedEvaluatorRequest(packet.request);
const selfSha256 = sha256(readFileSync(SELF_PATH));
let environmentValid = false;
try {
  const home = realpathSync(process.env.HOME || '');
  const temporary = realpathSync(process.env.TMPDIR || '');
  const homeRel = relative(stateRoot, home);
  const temporaryRel = relative(stateRoot, temporary);
  const localHome = homeRel && homeRel !== '..' && !homeRel.startsWith(`..${sep}`)
    && !isAbsolute(homeRel);
  const localTemporary = temporaryRel && temporaryRel !== '..'
    && !temporaryRel.startsWith(`..${sep}`) && !isAbsolute(temporaryRel);
  if (packet.invocation.isolationPolicy === 'codex-strict-v1') {
    const codexHome = realpathSync(process.env.CODEX_HOME || '');
    const codexRel = relative(stateRoot, codexHome);
    const marker = JSON.parse(readFileSync(resolve(codexHome, 'owner.json'), 'utf8'));
    environmentValid = localHome && localTemporary
      && (codexRel === '..' || codexRel.startsWith(`..${sep}`) || isAbsolute(codexRel))
      && validateEphemeralAuthCapsuleMarker(marker).status === 'OK'
      && marker.ownerPid === process.ppid
      && packet.invocation.environmentIsolation === 'ephemeral-external-auth-capsule-v2';
  } else {
    environmentValid = localHome && localTemporary
      && !process.env.CODEX_HOME
      && packet.invocation.environmentIsolation === 'isolated-home-no-auth-v1';
  }
} catch {
  environmentValid = false;
}
const reconstructedPrompt = buildIsolatedEvaluatorPrompt(
  packet.request,
  String(packet.prompt || '').split('\n\nFROZEN_EVALUATION_INPUT_SHA256=')[0]
);
if (invocationValidation.status !== 'OK'
    || requestValidation.status !== 'OK'
    || packet.invocation.invocationSha256 !== args['invocation-sha256']
    || packet.invocation.stateDirectory !== stateRoot
    || !environmentValid
    || packet.invocation.wrapperIdentity.sha256 !== selfSha256
    || packet.invocation.promptSha256 !== sha256(String(packet.prompt || ''))
    || reconstructedPrompt !== packet.prompt
    || packet.invocation.inputSha256 !== packet.request.requestSha256
    || packet.invocation.outputSchemaSha256
      !== sha256(canonicalVNextJson(packet.outputSchema))) {
  fail('evaluator worker input failed frozen-contract replay');
}

const fixtureMode = process.env.LOOP_FACTORY_EVALUATOR_TEST_FIXTURE === '1';
if ((fixtureMode && !packet.testFixtureOutput)
    || (!fixtureMode && packet.testFixtureOutput != null)) {
  fail('evaluator fixture mode is not authorized');
}

let output;
let stdout;
let executorInvocation;
let executionMode;
if (fixtureMode) {
  output = packet.testFixtureOutput;
  stdout = canonicalVNextJson(output);
  executorInvocation = null;
  executionMode = 'test-fixture-process';
} else {
  const run = runWorker({
    model: packet.invocation.model,
    prompt: packet.prompt,
    env: process.env,
    executionContract: {
      kind: 'vnext-evaluation',
      toolPolicy: 'none',
      reasoningEffort: packet.invocation.reasoningEffort
    }
  });
  if (!run.ok) {
    const failureCore = {
      schemaVersion: EVALUATOR_WORKER_FAILURE_SCHEMA,
      invocationSha256: packet.invocation.invocationSha256,
      reason: run.reason ?? 'EVALUATOR_MODEL_FAILED',
      stdout: buildEvaluatorProcessDiagnostic(run.stdout),
      stderr: buildEvaluatorProcessDiagnostic(run.stderr),
      executorInvocation: run.invocation ?? null
    };
    const failure = {
      ...failureCore,
      failureSha256: sha256(canonicalVNextJson(failureCore))
    };
    if (validateEvaluatorWorkerFailure(failure, {
      invocationSha256: packet.invocation.invocationSha256
    }).status !== 'OK') {
      fail('evaluator failure evidence did not replay');
    }
    const failurePath = `${outputPath}.failure`;
    writeFileSync(failurePath, canonicalVNextJson(failure), {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    fail('evaluator model invocation failed');
  }
  try {
    output = JSON.parse(run.resultText);
  } catch {
    fail('evaluator model output is not strict JSON');
  }
  stdout = run.stdout;
  executorInvocation = run.invocation;
  executionMode = 'spawned-model-worker';
}

const processCore = {
  invocationSha256: packet.invocation.invocationSha256,
  workerPid: process.pid,
  parentPid: process.ppid,
  wrapperSha256: selfSha256
};
const result = {
  schemaVersion: 'vnext-evaluator-worker-result-v2',
  invocationSha256: packet.invocation.invocationSha256,
  processIdentity: sha256(canonicalVNextJson(processCore)),
  workerPid: process.pid,
  parentPid: process.ppid,
  executionMode,
  output,
  stdoutDiagnostic: buildEvaluatorProcessDiagnostic(stdout),
  executorInvocation
};
const temporary = `${outputPath}.tmp-${process.pid}`;
writeFileSync(temporary, canonicalVNextJson(result), {
  encoding: 'utf8', mode: 0o600, flag: 'wx'
});
renameSync(temporary, outputPath);
process.stdout.write(`${sha256(canonicalVNextJson(result))}\n`);
