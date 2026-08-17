import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  STRICT_CODEX_RESEARCH_DISABLED_FEATURES,
  STRICT_CODEX_RESEARCH_ENABLED_FEATURES,
  resolveWorkerBinary
} from './executor.mjs';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from './vnext-model-contracts.mjs';
import { verifyVNextModelInvocation } from './vnext-model-identity.mjs';
import {
  validateEvaluatorProcessDiagnostic
} from './isolated-evaluator.mjs';
import { superviseProcessTree } from './process-tree-supervisor.mjs';

export const VNEXT_MODEL_WORKER_CONTRACT_SCHEMA = 'vnext-model-worker-contract-v1';
export const VNEXT_MODEL_WORKER_RECEIPT_SCHEMA = 'vnext-model-worker-receipt-v1';

const WORKER_PATH = fileURLToPath(new URL('../scripts/vnext-model-worker.mjs', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_WRAPPER_OUTPUT_BYTES = 1024 * 1024;
const KIND = Object.freeze({
  'external-research-discovery': {
    schema: VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY,
    file: 'vnext-external-research-discovery-output-v1.schema.json',
    toolPolicy: 'research-web-read-only'
  },
  research: { schema: VNEXT_MODEL_SCHEMA.RESEARCH, file: 'vnext-research-output-v1.schema.json', toolPolicy: 'none' },
  hypothesis: { schema: VNEXT_MODEL_SCHEMA.HYPOTHESIS, file: 'vnext-hypothesis-output-v1.schema.json', toolPolicy: 'none' },
  falsification: { schema: VNEXT_MODEL_SCHEMA.FALSIFICATION, file: 'vnext-falsification-output-v1.schema.json', toolPolicy: 'none' },
  reranker: { schema: VNEXT_MODEL_SCHEMA.RERANKER, file: 'vnext-reranker-output-v1.schema.json', toolPolicy: 'none' },
  candidate: { schema: VNEXT_MODEL_SCHEMA.CANDIDATE, file: 'vnext-candidate-output-v1.schema.json', toolPolicy: 'none' },
  feedback: { schema: VNEXT_MODEL_SCHEMA.FEEDBACK, file: 'vnext-task-feedback-output-v1.schema.json', toolPolicy: 'none' }
});

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strings(values, maximum = 128) {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const rows = values.map((value) => String(value || '').trim());
  return rows.some((value) => !value || value.length > 240)
    ? null : [...new Set(rows)].sort();
}

function inputRefs(values) {
  if (!Array.isArray(values) || values.length > 256) return null;
  const rows = values.map((value) => (
    plainObject(value) && isSafeId(value.id)
      && typeof value.schemaVersion === 'string' && value.schemaVersion.length <= 120
      && SHA256.test(String(value.sha256 || ''))
      ? { id: value.id, schemaVersion: value.schemaVersion, sha256: value.sha256 }
      : null
  ));
  if (rows.some((row) => row == null)) return null;
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return new Set(rows.map(({ id }) => id)).size === rows.length ? rows : null;
}

function realStateRoot(value) {
  const resolved = resolve(value || join(tmpdir(), 'loop-factory-vnext-model-workers'));
  try {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    if (!lstatSync(resolved).isDirectory()) return null;
    const real = realpathSync(resolved);
    const macosVarAlias = resolved.startsWith('/var/') && real === `/private${resolved}`;
    return real === resolved || macosVarAlias ? real : null;
  } catch {
    return null;
  }
}

function outputSchema(kind) {
  const config = KIND[kind];
  if (!config) return null;
  try {
    return JSON.parse(readFileSync(
      fileURLToPath(new URL(`./schemas/${config.file}`, import.meta.url)),
      'utf8'
    ));
  } catch {
    return null;
  }
}

function outputSchemaRawSha256(kind) {
  const config = KIND[kind];
  if (!config) return null;
  try {
    return sha256(readFileSync(
      fileURLToPath(new URL(`./schemas/${config.file}`, import.meta.url))
    ));
  } catch {
    return null;
  }
}

function executableIdentity(model, env) {
  const resolved = resolveWorkerBinary(model, env);
  if (!resolved.binPath) return null;
  try {
    return { basename: basename(resolved.binPath), sha256: sha256(readFileSync(resolved.binPath)) };
  } catch {
    return null;
  }
}

export function createVNextModelWorkerContract(input = {}) {
  const config = KIND[input.kind];
  const stateRoot = realStateRoot(input.stateRoot);
  const refs = inputRefs(input.inputRefs ?? []);
  const permittedInformation = strings(input.permittedInformation ?? []);
  const forbiddenInformation = strings(input.forbiddenInformation ?? []);
  const schema = input.outputSchema ?? outputSchema(input.kind);
  if (!config || !stateRoot || !refs || !permittedInformation || !forbiddenInformation
      || !isSafeId(input.invocationId)
      || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 120
      || typeof input.reasoningEffort !== 'string' || !input.reasoningEffort.trim()
      || typeof input.prompt !== 'string' || !input.prompt.trim()
      || Buffer.byteLength(input.prompt) > 1024 * 1024
      || !plainObject(schema)
      || !plainObject(input.binaryIdentity)
      || !SHA256.test(String(input.binaryIdentity.sha256 || ''))
      || !plainObject(input.wrapperIdentity)
      || input.wrapperIdentity.basename !== basename(WORKER_PATH)
      || !SHA256.test(String(input.wrapperIdentity.sha256 || ''))) {
    return refused('VNEXT_MODEL_WORKER_CONTRACT_INVALID', 'Model worker requires a bounded prompt, strict schema, fresh state root, and hashed executable identities.');
  }
  const stateDirectory = mkdtempSync(join(stateRoot, `${input.kind}-${input.invocationId}-`));
  const core = {
    schemaVersion: VNEXT_MODEL_WORKER_CONTRACT_SCHEMA,
    invocationId: input.invocationId,
    kind: input.kind,
    expectedOutputSchemaVersion: config.schema,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    promptSha256: sha256(input.prompt),
    outputSchemaSha256: sha256(canonicalVNextJson(schema)),
    executorOutputSchemaSha256: input.executorOutputSchemaSha256
      ?? sha256(canonicalVNextJson(schema)),
    inputRefs: refs,
    permittedInformation,
    forbiddenInformation,
    binaryIdentity: structuredClone(input.binaryIdentity),
    wrapperIdentity: structuredClone(input.wrapperIdentity),
    stateDirectory,
    stateDirectorySha256: sha256(stateDirectory),
    separateProcess: true,
    freshConversation: true,
    conversationId: null,
    toolPolicy: config.toolPolicy,
    activationAuthority: false
  };
  return {
    status: 'OK',
    contract: { ...core, contractSha256: sha256(canonicalVNextJson(core)) },
    outputSchema: schema
  };
}

export function validateVNextModelWorkerContract(contract) {
  if (!plainObject(contract) || contract.schemaVersion !== VNEXT_MODEL_WORKER_CONTRACT_SCHEMA
      || !KIND[contract.kind] || !SHA256.test(String(contract.contractSha256 || ''))
      || contract.expectedOutputSchemaVersion !== KIND[contract.kind].schema
      || contract.toolPolicy !== KIND[contract.kind].toolPolicy
      || contract.separateProcess !== true || contract.freshConversation !== true
      || contract.conversationId !== null
      || contract.activationAuthority !== false
      || !SHA256.test(String(contract.executorOutputSchemaSha256 || ''))
      || contract.stateDirectorySha256 !== sha256(contract.stateDirectory)) {
    return refused('VNEXT_MODEL_WORKER_CONTRACT_INVALID', 'Model worker contract shape or authority is invalid.');
  }
  const core = structuredClone(contract);
  delete core.contractSha256;
  return sha256(canonicalVNextJson(core)) === contract.contractSha256
    ? { status: 'OK', contract }
    : refused('VNEXT_MODEL_WORKER_CONTRACT_TAMPERED', 'Model worker contract hash drifted.');
}

export function buildVNextModelWorkerEnvironment(env, fixtureMode) {
  const allowed = [
    'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'NODE_EXTRA_CA_CERTS', 'PATH',
    'SHELL', 'SSL_CERT_FILE', 'TMPDIR', 'USER',
    'SUPER_LOOP_ALLOW_EXEC',
    'SUPER_LOOP_CODEX_BIN', 'SUPER_LOOP_CODEX_EXECUTABLE_SHA256',
    'SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256', 'SUPER_LOOP_REQUIRE_CHATGPT_OAUTH'
  ];
  const child = Object.fromEntries(allowed.filter((key) => typeof env[key] === 'string')
    .map((key) => [key, env[key]]));
  if (child.SUPER_LOOP_ALLOW_EXEC !== '1') delete child.SUPER_LOOP_ALLOW_EXEC;
  if (fixtureMode) child.LOOP_FACTORY_VNEXT_WORKER_TEST_FIXTURE = '1';
  return child;
}

function spawnWorker(args, cwd, env, timeoutMs) {
  return new Promise((resolveSpawn) => {
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    let timer;
    let terminationCode = null;
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    });
    const supervision = superviseProcessTree(child);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      supervision.release();
      resolveSpawn({ childPid: child.pid, ...result });
    };
    const terminateTree = (code) => {
      if (terminationCode != null) return false;
      terminationCode = code;
      return supervision.terminate(code, 'SIGTERM');
    };
    const waitForTreeExit = async () => {
      let exited = await supervision.waitForExit(
        terminationCode == null ? 500 : 5_000
      );
      if (exited) return true;
      if (terminationCode == null) {
        terminateTree('VNEXT_MODEL_WORKER_DESCENDANT_SURVIVED');
        exited = await supervision.waitForExit(5_000);
      }
      if (exited) return true;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already gone */ }
      return supervision.waitForExit(5_000);
    };
    const capture = (target, chunk) => {
      size += chunk.length;
      if (size > MAX_WRAPPER_OUTPUT_BYTES) {
        terminateTree('VNEXT_MODEL_WORKER_OUTPUT_LIMIT');
      } else target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('error', async (error) => {
      terminateTree('VNEXT_MODEL_WORKER_LAUNCH_FAILED');
      await waitForTreeExit();
      finish({ ok: false, code: 'VNEXT_MODEL_WORKER_LAUNCH_FAILED', error });
    });
    child.once('close', async (code, signal) => {
      const treeReaped = await waitForTreeExit();
      finish({
        ok: terminationCode == null && code === 0 && signal == null,
        code: treeReaped
          ? (terminationCode
            ?? (code === 0 && signal == null ? null : 'VNEXT_MODEL_WORKER_EXITED'))
          : 'VNEXT_MODEL_WORKER_TREE_NOT_REAPED',
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    timer = setTimeout(() => {
      terminateTree('VNEXT_MODEL_WORKER_TIMEOUT');
    }, timeoutMs);
  });
}

function receiptValid(packet, contract, wrapperSha256, childPid, parentPid, fixtureMode) {
  const executor = packet.executorInvocation;
  if (packet.workerPid !== childPid || packet.parentPid !== parentPid
      || packet.processIdentity !== sha256(canonicalVNextJson({
        contractSha256: contract.contractSha256,
        workerPid: childPid,
        parentPid,
        wrapperSha256
      }))) return false;
  if (fixtureMode) {
    return packet.executionMode === 'test-fixture-process'
      && executor === null
      && validateEvaluatorProcessDiagnostic(packet.stdoutDiagnostic).status === 'OK';
  }
  const expectedDisabled = contract.toolPolicy === 'research-web-read-only'
    ? STRICT_CODEX_RESEARCH_DISABLED_FEATURES
    : STRICT_CODEX_DISABLED_FEATURES;
  const expectedEnabled = contract.toolPolicy === 'research-web-read-only'
    ? STRICT_CODEX_RESEARCH_ENABLED_FEATURES
    : [];
  return packet.executionMode === 'spawned-model-worker'
    && plainObject(executor)
    && executor.requestedModel === contract.model
    && executor.reasoningEffort === contract.reasoningEffort
    && executor.strictIsolation === true
    && executor.toolPolicy === contract.toolPolicy
    && canonicalVNextJson(executor.disabledFeatures)
      === canonicalVNextJson([...expectedDisabled])
    && canonicalVNextJson(executor.enabledFeatures)
      === canonicalVNextJson([...expectedEnabled])
    && validateEvaluatorProcessDiagnostic(packet.stdoutDiagnostic).status === 'OK'
    && executor.stdoutSha256 === packet.stdoutDiagnostic.rawSha256
    && executor.isolation.status === 'PASS'
    && executor.isolation.disallowedToolCalls.length === 0
    && (contract.toolPolicy !== 'none' || executor.isolation.toolCalls.length === 0)
    && executor.promptSha256 === contract.promptSha256
    && executor.outputSchemaSha256 === contract.executorOutputSchemaSha256
    && executor.executableBasename === contract.binaryIdentity.basename
    && executor.executableSha256 === contract.binaryIdentity.sha256
    && executor.reportedModelMatchesRequest !== false
    && executor.exitCode === 0;
}

export async function runVNextModelWorker(input = {}, options = {}) {
  const fixtureMode = options.allowTestFixture === true && plainObject(options.testFixtureOutput);
  const env = options.env ?? process.env;
  let wrapperIdentity;
  try {
    wrapperIdentity = { basename: basename(WORKER_PATH), sha256: sha256(readFileSync(WORKER_PATH)) };
  } catch {
    return refused('VNEXT_MODEL_WORKER_WRAPPER_MISSING', 'Official VNext model wrapper is unavailable.');
  }
  const binaryIdentity = fixtureMode ? input.binaryIdentity : executableIdentity(input.model, env);
  if (!binaryIdentity) return refused('VNEXT_MODEL_WORKER_BINARY_UNAVAILABLE', 'Requested model binary is unavailable.');
  const executorOutputSchemaSha256 = outputSchemaRawSha256(input.kind);
  if (!executorOutputSchemaSha256) {
    return refused('VNEXT_MODEL_WORKER_SCHEMA_UNAVAILABLE', 'The executor output schema is unavailable.');
  }
  const built = createVNextModelWorkerContract({
    ...input,
    binaryIdentity,
    wrapperIdentity,
    executorOutputSchemaSha256
  });
  if (built.status !== 'OK') return built;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
    return refused('VNEXT_MODEL_WORKER_TIMEOUT_INVALID', 'Worker timeout must be between one second and one hour.');
  }
  const packetPath = join(built.contract.stateDirectory, 'worker-input.json');
  const resultPath = join(built.contract.stateDirectory, 'worker-result.json');
  const packet = {
    schemaVersion: 'vnext-model-worker-input-v1',
    contract: built.contract,
    prompt: input.prompt,
    outputSchema: built.outputSchema,
    testFixtureOutput: fixtureMode ? options.testFixtureOutput : null,
    testFixtureUsage: fixtureMode ? (options.testFixtureUsage ?? null) : null
  };
  try {
    writeFileSync(packetPath, canonicalVNextJson(packet), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    return refused('VNEXT_MODEL_WORKER_PACKET_WRITE_FAILED', String(error?.message || error));
  }
  const spawned = await spawnWorker([
    WORKER_PATH, '--packet', packetPath, '--output', resultPath,
    '--contract-sha256', built.contract.contractSha256
  ], built.contract.stateDirectory,
  buildVNextModelWorkerEnvironment(env, fixtureMode), timeoutMs);
  if (!spawned.ok) return refused(spawned.code, 'VNext model worker failed.', {
    exitCode: spawned.exitCode ?? null,
    signal: spawned.signal ?? null,
    stderrSha256: sha256(String(spawned.stderr || ''))
  });
  let resultText;
  let result;
  try {
    resultText = readFileSync(resultPath, 'utf8');
    result = JSON.parse(resultText);
  } catch {
    return refused('VNEXT_MODEL_WORKER_RESULT_INVALID', 'VNext worker result is missing or malformed.');
  }
  if (result.contractSha256 !== built.contract.contractSha256
      || !receiptValid(result, built.contract, wrapperIdentity.sha256, spawned.childPid, process.pid, fixtureMode)) {
    return refused('VNEXT_MODEL_WORKER_RECEIPT_UNBOUND', 'VNext worker process or executor receipt is unbound.');
  }
  const output = validateVNextModelOutput(result.output, KIND[input.kind].schema);
  if (output.status !== 'OK') return refused('VNEXT_MODEL_WORKER_OUTPUT_INVALID', 'VNext worker output violates its strict schema.');
  const receiptCore = {
    schemaVersion: VNEXT_MODEL_WORKER_RECEIPT_SCHEMA,
    contractSha256: built.contract.contractSha256,
    workerPacketSha256: sha256(resultText),
    processIdentity: result.processIdentity,
    workerPid: result.workerPid,
    parentPid: result.parentPid,
    executionMode: result.executionMode,
    productionEvidence: result.executionMode === 'spawned-model-worker',
    executorInvocationSha256: result.executorInvocation
      ? sha256(canonicalVNextJson(result.executorInvocation)) : null,
    tokenUsageDetails: result.tokenUsageDetails ?? null,
    tokenUsageAuthority: result.tokenUsageAuthority ?? 'unavailable',
    resultSha256: sha256(canonicalVNextJson(output.output)),
    stdoutSha256: result.stdoutDiagnostic.rawSha256,
    activationAuthority: false
  };
  return {
    status: 'OK',
    output: output.output,
    contract: built.contract,
    receipt: { ...receiptCore, receiptSha256: sha256(canonicalVNextJson(receiptCore)) }
  };
}

export function vnextModelWorkerSchema(kind) {
  return KIND[kind]?.schema ?? null;
}

export function validateVNextModelWorkerReceipt(receipt, contract, output, {
  requireProduction = false
} = {}) {
  const contractValid = validateVNextModelWorkerContract(contract);
  if (contractValid.status !== 'OK'
      || !plainObject(receipt)
      || receipt.schemaVersion !== VNEXT_MODEL_WORKER_RECEIPT_SCHEMA
      || receipt.contractSha256 !== contract.contractSha256
      || !SHA256.test(String(receipt.workerPacketSha256 || ''))
      || !SHA256.test(String(receipt.processIdentity || ''))
      || !Number.isInteger(receipt.workerPid) || receipt.workerPid < 1
      || !Number.isInteger(receipt.parentPid) || receipt.parentPid < 1
      || !['spawned-model-worker', 'test-fixture-process'].includes(receipt.executionMode)
      || receipt.productionEvidence !== (receipt.executionMode === 'spawned-model-worker')
      || (requireProduction && !receipt.productionEvidence)
      || receipt.activationAuthority !== false
      || !['cli-receipt', 'provider-receipt', 'test-fixture', 'unavailable']
        .includes(receipt.tokenUsageAuthority)
      || !SHA256.test(String(receipt.resultSha256 || ''))
      || !SHA256.test(String(receipt.stdoutSha256 || ''))
      || !SHA256.test(String(receipt.receiptSha256 || ''))) {
    return refused('VNEXT_MODEL_WORKER_RECEIPT_INVALID', 'VNext model worker receipt is incomplete or not production evidence.');
  }
  const outputValid = validateVNextModelOutput(output, contract.expectedOutputSchemaVersion);
  if (outputValid.status !== 'OK'
      || receipt.resultSha256 !== sha256(canonicalVNextJson(outputValid.output))) {
    return refused('VNEXT_MODEL_WORKER_RESULT_MISMATCH', 'VNext model output does not match its receipt.');
  }
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  return receipt.receiptSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', receipt, output: outputValid.output }
    : refused('VNEXT_MODEL_WORKER_RECEIPT_TAMPERED', 'VNext model worker receipt hash drifted.');
}

export function verifyVNextModelWorkerFromDisk({
  contract,
  receipt,
  output,
  requireProduction = false,
  identityPolicy = null,
  verifiedAt = null,
  workerInputText = null,
  workerResultText = null
} = {}) {
  const valid = validateVNextModelWorkerReceipt(receipt, contract, output, {
    requireProduction
  });
  if (valid.status !== 'OK') return valid;
  let inputText;
  let inputPacket;
  let text;
  let packet;
  try {
    inputText = typeof workerInputText === 'string'
      ? workerInputText
      : readFileSync(join(contract.stateDirectory, 'worker-input.json'), 'utf8');
    inputPacket = JSON.parse(inputText);
    text = typeof workerResultText === 'string'
      ? workerResultText
      : readFileSync(join(contract.stateDirectory, 'worker-result.json'), 'utf8');
    packet = JSON.parse(text);
  } catch {
    return refused('VNEXT_MODEL_WORKER_EVIDENCE_MISSING', 'Persisted worker input or result evidence is missing or malformed.');
  }
  if (inputPacket.schemaVersion !== 'vnext-model-worker-input-v1'
      || canonicalVNextJson(inputPacket.contract) !== canonicalVNextJson(contract)
      || sha256(String(inputPacket.prompt || '')) !== contract.promptSha256
      || sha256(canonicalVNextJson(inputPacket.outputSchema)) !== contract.outputSchemaSha256
      || (requireProduction && inputPacket.testFixtureOutput !== null)
      || sha256(text) !== receipt.workerPacketSha256
      || packet.contractSha256 !== contract.contractSha256
      || packet.processIdentity !== receipt.processIdentity
      || packet.workerPid !== receipt.workerPid
      || packet.parentPid !== receipt.parentPid
      || packet.executionMode !== receipt.executionMode
      || validateEvaluatorProcessDiagnostic(packet.stdoutDiagnostic).status !== 'OK'
      || packet.stdoutDiagnostic.rawSha256 !== receipt.stdoutSha256
      || sha256(canonicalVNextJson(packet.output)) !== receipt.resultSha256
      || (packet.executorInvocation
        ? sha256(canonicalVNextJson(packet.executorInvocation))
          !== receipt.executorInvocationSha256
        : receipt.executorInvocationSha256 !== null)
      || canonicalVNextJson(packet.tokenUsageDetails ?? null)
        !== canonicalVNextJson(receipt.tokenUsageDetails)
      || packet.tokenUsageAuthority !== receipt.tokenUsageAuthority
      || !receiptValid(
        packet,
        contract,
        contract.wrapperIdentity.sha256,
        receipt.workerPid,
        receipt.parentPid,
        !receipt.productionEvidence
      )) {
    return refused('VNEXT_MODEL_WORKER_EVIDENCE_TAMPERED', 'Persisted worker-result evidence failed replay.');
  }
  let modelIdentityReceipt = null;
  if (requireProduction || identityPolicy != null) {
    if (!identityPolicy || !packet.executorInvocation || !Number.isFinite(Date.parse(verifiedAt))) {
      return refused('VNEXT_MODEL_WORKER_IDENTITY_POLICY_REQUIRED', 'Production worker replay requires a frozen model-identity policy and verification time.');
    }
    const identity = verifyVNextModelInvocation({
      policy: identityPolicy,
      invocation: packet.executorInvocation,
      verifiedAt
    });
    if (identity.status !== 'OK') return identity;
    modelIdentityReceipt = identity.receipt;
  }
  return {
    status: 'OK',
    contract,
    receipt,
    output: valid.output,
    modelIdentityReceipt
  };
}
