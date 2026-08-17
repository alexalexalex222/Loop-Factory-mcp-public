import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';
import { durableWriteExclusiveFileSync } from './durable-file.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from './executor.mjs';
import {
  buildIsolatedEvaluatorRequest,
  runIsolatedEvaluatorProcess,
  verifyIsolatedEvaluatorFromDisk
} from './isolated-evaluator.mjs';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  createVNextModelIdentityPolicy,
  validateVNextModelIdentityPolicy
} from './vnext-model-identity.mjs';

export const VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA =
  'loop-factory-vnext-evaluator-proof-plan-v2';
export const VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA_V1 =
  'loop-factory-vnext-evaluator-proof-plan-v1';
export const VNEXT_EVALUATOR_PROOF_RESULT_SCHEMA =
  'loop-factory-vnext-evaluator-proof-result-v1';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const VNEXT_EVALUATOR_PROOF_ROOT_PATHS = Object.freeze([
  'src/vnext-evaluator-proof.mjs',
  'src/durable-file.mjs',
  'src/isolated-evaluator.mjs',
  'src/vnext-model-identity.mjs',
  'src/executor.mjs',
  'scripts/plan-vnext-evaluator-proof.mjs',
  'scripts/run-vnext-evaluator-proof.mjs',
  'scripts/verify-vnext-evaluator-proof.mjs',
  'scripts/vnext-evaluator-worker.mjs',
  'scripts/vnext-guarded-exec.mjs',
  'src/ephemeral-auth-capsule.mjs',
  'src/process-launch.mjs',
  'src/process-tree-runner.mjs',
  'src/process-tree-supervisor.mjs'
]);

export const VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS = Object.freeze([
  'scripts/plan-vnext-evaluator-proof.mjs',
  'scripts/run-vnext-evaluator-proof.mjs',
  'scripts/verify-vnext-evaluator-proof.mjs',
  'scripts/vnext-evaluator-worker.mjs',
  'scripts/vnext-guarded-exec.mjs',
  'src/codex-oauth-authority.mjs',
  'src/durable-file.mjs',
  'src/native/darwin-fullfsync',
  'src/native/darwin-fullfsync.c',
  'src/executor.mjs',
  'src/ephemeral-auth-capsule.mjs',
  'src/host.mjs',
  'src/isolated-evaluator.mjs',
  'src/process-launch.mjs',
  'src/process-tree-runner.mjs',
  'src/process-tree-supervisor.mjs',
  'src/util.mjs',
  'src/vnext-contracts.mjs',
  'src/vnext-evaluator-proof.mjs',
  'src/vnext-model-contracts.mjs',
  'src/vnext-model-identity.mjs',
  'hosts/registry.json',
  'src/schemas/vnext-evaluator-output-v1.schema.json',
  'src/schemas/vnext-evaluator-proof-plan-v2.schema.json'
]);

const PLAN_FILE = 'plan.json';
const LAUNCH_FILE = 'launch.json';
const RESULT_FILE = 'result.json';
const SHA256 = /^[a-f0-9]{64}$/;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function proofDirectory(proofHome, proofId, { create = false } = {}) {
  if (!isSafeId(proofId) || !isAbsolute(String(proofHome || ''))) return null;
  try {
    if (create) mkdirSync(proofHome, { recursive: true, mode: 0o700 });
    const root = realpathSync(resolve(proofHome));
    const directory = resolve(root, proofId);
    if (!within(root, directory)) return null;
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return null;
    return realpathSync(directory);
  } catch {
    return null;
  }
}

function localStaticImportClosure(packageRoot) {
  const root = realpathSync(resolve(packageRoot));
  const seen = new Set();
  const visit = (path) => {
    const normalized = normalize(path).replaceAll('\\', '/');
    if (seen.has(normalized)) return;
    const full = resolve(root, normalized);
    if (!within(root, full) || !existsSync(full) || lstatSync(full).isSymbolicLink()) {
      throw new Error(`Evaluator proof static dependency is missing or unsafe: ${normalized}`);
    }
    seen.add(normalized);
    if (!normalized.endsWith('.mjs')) return;
    const source = readFileSync(full, 'utf8');
    for (const match of source.matchAll(
      /(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g
    )) {
      let absolute = resolve(dirname(full), match[1]);
      if (!extname(absolute)) absolute += '.mjs';
      const child = relative(root, absolute).replaceAll('\\', '/');
      if (child.startsWith('..') || isAbsolute(child)) {
        throw new Error(`Evaluator proof import escapes the package: ${match[1]}`);
      }
      visit(child);
    }
  };
  VNEXT_EVALUATOR_PROOF_ROOT_PATHS.forEach(visit);
  return [...seen].sort();
}

export function resolveVNextEvaluatorProofImportClosure({
  packageRoot = PACKAGE_ROOT
} = {}) {
  try {
    return { status: 'OK', paths: localStaticImportClosure(packageRoot) };
  } catch (error) {
    return refused('EVALUATOR_PROOF_IMPORT_CLOSURE_INVALID', error.message);
  }
}

function implementationManifest(packageRoot = PACKAGE_ROOT) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const closure = localStaticImportClosure(root);
    const boundSources = VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS
      .filter((path) => path.endsWith('.mjs'))
      .slice()
      .sort();
    if (canonicalVNextJson(closure) !== canonicalVNextJson(boundSources)) {
      const bound = new Set(boundSources);
      const reachable = new Set(closure);
      throw new Error(`Evaluator proof implementation closure mismatch: ${canonicalVNextJson({
        missing: closure.filter((path) => !bound.has(path)),
        extra: boundSources.filter((path) => !reachable.has(path))
      })}`);
    }
    const manifest = VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full) || !existsSync(full) || lstatSync(full).isSymbolicLink()) {
        throw new Error(`Evaluator proof dependency is missing or unsafe: ${path}`);
      }
      const bytes = readFileSync(full);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    });
    return {
      status: 'OK',
      manifest,
      implementationSha256: sha256(canonicalVNextJson(manifest))
    };
  } catch (error) {
    return refused('EVALUATOR_PROOF_IMPLEMENTATION_INVALID', error.message);
  }
}

export function resolveVNextEvaluatorProofImplementation({
  packageRoot = PACKAGE_ROOT
} = {}) {
  return implementationManifest(packageRoot);
}

function portableArgv(model, reasoningEffort) {
  const schemaPath = schemaPathForContract({ kind: 'vnext-evaluation' });
  if (!schemaPath) return null;
  return {
    argv: buildArgs('codex', null, model, {
      strictIsolation: true,
      schemaPath,
      workspaceRoot: '<fresh-model-capsule>',
      toolPolicy: 'none',
      reasoningEffort
    }).map((value) => (
      value === schemaPath ? `<output-schema:${basename(schemaPath)}>` : value
    )),
    outputSchemaPath: `src/schemas/${basename(schemaPath)}`,
    outputSchemaSha256: sha256(readFileSync(schemaPath)),
    disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES]
  };
}

function planCore(input, request, pairwiseReceipt, identityPolicy, implementation) {
  const execution = portableArgv(
    input.runtimeAuthority.requestedModel,
    input.runtimeAuthority.reasoningEffort
  );
  if (!execution) return null;
  return {
    schemaVersion: VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA,
    proofId: input.proofId,
    createdAt: input.createdAt,
    proofHome: realpathSync(resolve(input.proofHome)),
    request,
    pairwiseReceipt,
    prompt: input.prompt,
    route: {
      model: input.runtimeAuthority.requestedModel,
      reasoningEffort: input.runtimeAuthority.reasoningEffort,
      authMode: 'chatgpt-oauth',
      oauthAuthoritySha256: input.runtimeAuthority.authoritySha256,
      executablePath: input.runtimeAuthority.binary.path,
      executableSha256: input.runtimeAuthority.binary.sha256,
      fallbackModels: []
    },
    runtimeAuthority: input.runtimeAuthority,
    identityPolicy,
    invocationPolicy: {
      taskId: input.taskId,
      anonymousArmId: input.anonymousArmId,
      modelGenerationSampling: {
        authority: 'backend-default',
        deterministic: false
      },
      tools: [],
      toolPolicy: 'none',
      timeoutMs: input.timeoutMs,
      isolationPolicy: 'codex-strict-v1',
      separateProcess: true,
      freshConversation: true,
      isolatedHomeAuthCapsule: true
    },
    execution,
    implementationManifest: implementation.manifest,
    implementationSha256: implementation.implementationSha256,
    exposure: {
      maximumCalls: 1,
      retries: 0,
      hardTokenCeiling: null,
      hardUsdCeiling: 0,
      billingMode: 'subscription-no-metered-usd',
      promotionEnabled: false
    },
    approval: {
      requiredBeforeLaunch: true,
      authority: 'operator-exact-evaluator-proof-plan-sha256',
      workerLaunchedAtPlanning: false,
      paidModelCallsAtPlanning: 0
    }
  };
}

export function createVNextEvaluatorProofPlan(input = {}) {
  const authority = validateCodexOAuthAuthorityRecord(input.runtimeAuthority);
  const builtRequest = buildIsolatedEvaluatorRequest(input.requestInput);
  const identity = authority.status === 'OK'
    ? createVNextModelIdentityPolicy({
        policyId: `${input.proofId}-identity`,
        oauthAuthority: authority.record,
        requireBackendReportedModel: true
      })
    : authority;
  const implementation = implementationManifest(input.packageRoot);
  const directory = proofDirectory(input.proofHome, input.proofId, { create: true });
  if (!directory || !isSafeId(input.taskId) || !isSafeId(input.anonymousArmId)
      || !Number.isFinite(Date.parse(input.createdAt))
      || typeof input.prompt !== 'string' || !input.prompt.trim()
      || !Number.isInteger(input.timeoutMs)
      || input.timeoutMs < 1000 || input.timeoutMs > 60 * 60 * 1000
      || builtRequest.status !== 'OK' || identity.status !== 'OK'
      || implementation.status !== 'OK') {
    return refused(
      'EVALUATOR_PROOF_PLAN_INPUT_INVALID',
      'Evaluator proof planning requires one frozen anonymous request, honest backend-default sampling disclosure, exact OAuth route, complete implementation closure, and proof directory.'
    );
  }
  const core = planCore(
    { ...input, proofHome: realpathSync(resolve(input.proofHome)) },
    builtRequest.request,
    builtRequest.pairwiseReceipt,
    identity.policy,
    implementation
  );
  if (!core) return refused('EVALUATOR_PROOF_PLAN_INVALID', 'Evaluator execution disclosure could not be frozen.');
  const plan = { ...core, planSha256: sha256(canonicalVNextJson(core)) };
  return validateVNextEvaluatorProofPlan(plan).status === 'OK'
    ? { status: 'OK', plan, directory }
    : refused('EVALUATOR_PROOF_PLAN_INVALID', 'Evaluator proof plan failed replay.');
}

export function validateVNextEvaluatorProofPlan(plan) {
  const keys = [
    'schemaVersion', 'proofId', 'createdAt', 'proofHome', 'request',
    'pairwiseReceipt', 'prompt', 'route', 'runtimeAuthority',
    'identityPolicy', 'invocationPolicy', 'execution',
    'implementationManifest', 'implementationSha256', 'exposure',
    'approval', 'planSha256'
  ];
  if (!exactKeys(plan, keys)
      || plan.schemaVersion !== VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA
      || !isSafeId(plan.proofId) || !isAbsolute(String(plan.proofHome || ''))
      || !Number.isFinite(Date.parse(plan.createdAt))
      || validateCodexOAuthAuthorityRecord(plan.runtimeAuthority).status !== 'OK'
      || validateVNextModelIdentityPolicy(plan.identityPolicy).status !== 'OK'
      || plan.identityPolicy.oauthAuthoritySha256 !== plan.runtimeAuthority.authoritySha256
      || plan.route.model !== plan.runtimeAuthority.requestedModel
      || plan.route.reasoningEffort !== plan.runtimeAuthority.reasoningEffort
      || plan.route.fallbackModels?.length !== 0
      || plan.invocationPolicy?.separateProcess !== true
      || plan.invocationPolicy?.freshConversation !== true
      || plan.invocationPolicy?.isolatedHomeAuthCapsule !== true
      || !exactKeys(plan.invocationPolicy?.modelGenerationSampling, [
        'authority', 'deterministic'
      ])
      || plan.invocationPolicy.modelGenerationSampling.authority !== 'backend-default'
      || plan.invocationPolicy.modelGenerationSampling.deterministic !== false
      || plan.invocationPolicy?.toolPolicy !== 'none'
      || plan.invocationPolicy?.tools?.length !== 0
      || plan.exposure?.maximumCalls !== 1 || plan.exposure?.retries !== 0
      || plan.exposure?.promotionEnabled !== false
      || plan.approval?.requiredBeforeLaunch !== true
      || plan.approval?.workerLaunchedAtPlanning !== false
      || plan.approval?.paidModelCallsAtPlanning !== 0
      || !SHA256.test(String(plan.implementationSha256 || ''))
      || !SHA256.test(String(plan.planSha256 || ''))) {
    return refused('EVALUATOR_PROOF_PLAN_INVALID', 'Evaluator proof plan shape or safety boundary is invalid.');
  }
  const core = structuredClone(plan);
  delete core.planSha256;
  return plan.planSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', plan }
    : refused('EVALUATOR_PROOF_PLAN_TAMPERED', 'Evaluator proof plan hash failed replay.');
}

export function validateVNextEvaluatorProofPlanForReplay(plan) {
  if (plan?.schemaVersion !== VNEXT_EVALUATOR_PROOF_PLAN_SCHEMA_V1) {
    return validateVNextEvaluatorProofPlan(plan);
  }
  const keys = [
    'schemaVersion', 'proofId', 'createdAt', 'proofHome', 'request',
    'pairwiseReceipt', 'prompt', 'route', 'runtimeAuthority',
    'identityPolicy', 'invocationPolicy', 'execution',
    'implementationManifest', 'implementationSha256', 'exposure',
    'approval', 'planSha256'
  ];
  if (!exactKeys(plan, keys)
      || !isSafeId(plan.proofId) || !isAbsolute(String(plan.proofHome || ''))
      || !Number.isFinite(Date.parse(plan.createdAt))
      || validateCodexOAuthAuthorityRecord(plan.runtimeAuthority).status !== 'OK'
      || validateVNextModelIdentityPolicy(plan.identityPolicy).status !== 'OK'
      || plan.identityPolicy.oauthAuthoritySha256
        !== plan.runtimeAuthority.authoritySha256
      || plan.route?.model !== plan.runtimeAuthority.requestedModel
      || plan.route?.reasoningEffort !== plan.runtimeAuthority.reasoningEffort
      || plan.route?.fallbackModels?.length !== 0
      || plan.invocationPolicy?.separateProcess !== true
      || plan.invocationPolicy?.freshConversation !== true
      || plan.invocationPolicy?.isolatedHomeAuthCapsule !== true
      || !exactKeys(plan.invocationPolicy?.sampling, [
        'seed', 'temperature', 'topP'
      ])
      || !Number.isSafeInteger(plan.invocationPolicy.sampling.seed)
      || plan.invocationPolicy.sampling.temperature !== 0
      || plan.invocationPolicy.sampling.topP !== 1
      || plan.invocationPolicy?.toolPolicy !== 'none'
      || plan.invocationPolicy?.tools?.length !== 0
      || plan.exposure?.maximumCalls !== 1 || plan.exposure?.retries !== 0
      || plan.exposure?.promotionEnabled !== false
      || plan.approval?.requiredBeforeLaunch !== true
      || plan.approval?.workerLaunchedAtPlanning !== false
      || plan.approval?.paidModelCallsAtPlanning !== 0
      || !SHA256.test(String(plan.implementationSha256 || ''))
      || !SHA256.test(String(plan.planSha256 || ''))) {
    return refused(
      'EVALUATOR_PROOF_PLAN_REPLAY_INVALID',
      'Legacy evaluator proof plan is not safe to replay as historical evidence.'
    );
  }
  const core = structuredClone(plan);
  delete core.planSha256;
  return plan.planSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', plan }
    : refused(
        'EVALUATOR_PROOF_PLAN_REPLAY_TAMPERED',
        'Legacy evaluator proof plan hash failed replay.'
      );
}

export function verifyVNextEvaluatorProofPlanImplementation({
  plan,
  packageRoot = PACKAGE_ROOT
} = {}) {
  const valid = validateVNextEvaluatorProofPlan(plan);
  if (valid.status !== 'OK') return valid;
  const implementation = implementationManifest(packageRoot);
  if (implementation.status !== 'OK'
      || canonicalVNextJson(implementation.manifest)
        !== canonicalVNextJson(plan.implementationManifest)
      || implementation.implementationSha256 !== plan.implementationSha256) {
    return refused(
      'EVALUATOR_PROOF_IMPLEMENTATION_DRIFT',
      'Evaluator proof implementation changed after planning.'
    );
  }
  return {
    status: 'OK',
    plan,
    implementationManifest: implementation.manifest,
    implementationSha256: implementation.implementationSha256
  };
}

export function persistVNextEvaluatorProofPlan({ directory, plan } = {}) {
  if (validateVNextEvaluatorProofPlan(plan).status !== 'OK'
      || realpathSync(directory) !== proofDirectory(plan.proofHome, plan.proofId)) {
    return refused('EVALUATOR_PROOF_PLAN_PERSIST_INVALID', 'Plan directory or bytes are unbound.');
  }
  const path = join(directory, PLAN_FILE);
  const bytes = `${canonicalVNextJson(plan)}\n`;
  if (existsSync(path)) {
    return readFileSync(path, 'utf8') === bytes
      ? { status: 'OK', path, plan, idempotent: true }
      : refused('EVALUATOR_PROOF_PLAN_CONFLICT', 'Immutable evaluator plan bytes conflict.');
  }
  writeFileSync(path, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { status: 'OK', path, plan, idempotent: false };
}

export function loadVNextEvaluatorProofPlan({ proofHome, proofId } = {}) {
  const directory = proofDirectory(proofHome, proofId);
  if (!directory) return refused('EVALUATOR_PROOF_DIRECTORY_INVALID', 'Evaluator proof directory is invalid.');
  try {
    const plan = JSON.parse(readFileSync(join(directory, PLAN_FILE), 'utf8'));
    const valid = validateVNextEvaluatorProofPlan(plan);
    if (valid.status !== 'OK' || plan.proofHome !== realpathSync(resolve(proofHome))) return valid;
    const implementation = verifyVNextEvaluatorProofPlanImplementation({ plan });
    if (implementation.status !== 'OK') return implementation;
    return { status: 'OK', directory, plan };
  } catch {
    return refused('EVALUATOR_PROOF_PLAN_MISSING', 'Evaluator proof plan is missing or malformed.');
  }
}

function readWorkerUsage(invocation) {
  try {
    const bytes = readFileSync(join(invocation.stateDirectory, 'worker-result.json'), 'utf8');
    const packet = JSON.parse(bytes);
    return {
      workerResultSha256: sha256(bytes),
      tokenUsageDetails: packet.executorInvocation?.tokenUsageDetails ?? null,
      reportedModel: packet.executorInvocation?.reportedModel ?? null,
      executorInvocationSha256: packet.executorInvocation
        ? sha256(canonicalVNextJson(packet.executorInvocation))
        : null
    };
  } catch {
    return null;
  }
}

export async function runVNextEvaluatorProof({
  plan,
  directory,
  approvedPlanSha256,
  env = process.env,
  evaluatorRunner = runIsolatedEvaluatorProcess,
  durableWriter = durableWriteExclusiveFileSync,
  clock = () => new Date().toISOString()
} = {}) {
  const implementation = verifyVNextEvaluatorProofPlanImplementation({ plan });
  if (implementation.status !== 'OK'
      || approvedPlanSha256 !== plan.planSha256
      || realpathSync(directory) !== proofDirectory(plan.proofHome, plan.proofId)
      || existsSync(join(directory, LAUNCH_FILE))
      || existsSync(join(directory, RESULT_FILE))) {
    return refused(
      approvedPlanSha256 !== plan?.planSha256
        ? 'EVALUATOR_PROOF_APPROVAL_MISMATCH'
        : 'EVALUATOR_PROOF_NOT_FRESH',
      'The evaluator proof requires the exact approved plan and may run only once.'
    );
  }
  const startedAt = clock();
  if (!Number.isFinite(Date.parse(startedAt))) {
    return refused(
      'EVALUATOR_PROOF_CLOCK_INVALID',
      'Evaluator launch requires a valid receipt timestamp before dispatch.'
    );
  }
  const launchCore = {
    schemaVersion: 'loop-factory-vnext-evaluator-proof-launch-v1',
    proofId: plan.proofId,
    planSha256: plan.planSha256,
    startedAt,
    executionAuthority: 'operator-exact-evaluator-proof-plan-sha256',
    maximumCalls: 1,
    retriesAuthorized: false
  };
  const launch = {
    ...launchCore,
    launchSha256: sha256(canonicalVNextJson(launchCore))
  };
  try {
    durableWriter(
      join(directory, LAUNCH_FILE),
      `${canonicalVNextJson(launch)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (error) {
    return refused(
      error?.code === 'EEXIST'
        ? 'EVALUATOR_PROOF_NOT_FRESH'
        : 'EVALUATOR_PROOF_LAUNCH_DURABILITY_FAILED',
      error?.code === 'EEXIST'
        ? 'The evaluator proof launch receipt already exists.'
        : 'The evaluator proof launch receipt did not reach durable storage.'
    );
  }
  const result = await evaluatorRunner({
    taskId: plan.invocationPolicy.taskId,
    anonymousArmId: plan.invocationPolicy.anonymousArmId,
    request: plan.request,
    model: plan.route.model,
    reasoningEffort: plan.route.reasoningEffort,
    tools: [],
    toolPolicy: 'none',
    prompt: plan.prompt,
    stateRoot: join(directory, 'state')
  }, {
    env,
    timeoutMs: plan.invocationPolicy.timeoutMs
  });
  if (result.status !== 'OK') return result;
  const verifiedAt = clock();
  const replay = verifyIsolatedEvaluatorFromDisk({
    invocation: result.invocation,
    receipt: result.receipt,
    artifact: result.artifact,
    requireProduction: true,
    identityPolicy: plan.identityPolicy,
    verifiedAt
  });
  const usage = readWorkerUsage(result.invocation);
  if (replay.status !== 'OK' || !usage
      || usage.executorInvocationSha256 !== result.receipt.executorInvocationSha256) {
    return replay.status === 'OK'
      ? refused('EVALUATOR_PROOF_USAGE_UNBOUND', 'Evaluator executor usage did not replay from disk.')
      : replay;
  }
  const core = {
    schemaVersion: VNEXT_EVALUATOR_PROOF_RESULT_SCHEMA,
    proofId: plan.proofId,
    planSha256: plan.planSha256,
    launchSha256: launch.launchSha256,
    completedAt: verifiedAt,
    invocation: result.invocation,
    receipt: result.receipt,
    artifact: result.artifact,
    modelIdentityReceipt: replay.modelIdentityReceipt,
    workerResultSha256: usage.workerResultSha256,
    tokenUsageDetails: usage.tokenUsageDetails,
    reportedModel: usage.reportedModel,
    productionEvidence: true,
    activationAuthority: false
  };
  const proofResult = {
    ...core,
    resultSha256: sha256(canonicalVNextJson(core))
  };
  durableWriter(
    join(directory, RESULT_FILE),
    `${canonicalVNextJson(proofResult)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return verifyVNextEvaluatorProofFromDisk({
    proofHome: plan.proofHome,
    proofId: plan.proofId
  });
}

export function verifyVNextEvaluatorProofFromDisk({ proofHome, proofId } = {}) {
  const loaded = loadVNextEvaluatorProofPlan({ proofHome, proofId });
  if (loaded.status !== 'OK') return loaded;
  let launch;
  let result;
  try {
    launch = JSON.parse(readFileSync(join(loaded.directory, LAUNCH_FILE), 'utf8'));
    result = JSON.parse(readFileSync(join(loaded.directory, RESULT_FILE), 'utf8'));
  } catch {
    return refused(
      'EVALUATOR_PROOF_RESULT_MISSING',
      'Evaluator proof launch or result is missing or malformed; the run must not be retried.'
    );
  }
  const launchCore = structuredClone(launch);
  delete launchCore.launchSha256;
  if (!exactKeys(launch, [
    'schemaVersion', 'proofId', 'planSha256', 'startedAt',
    'executionAuthority', 'maximumCalls', 'retriesAuthorized', 'launchSha256'
  ]) || launch.schemaVersion !== 'loop-factory-vnext-evaluator-proof-launch-v1'
      || launch.proofId !== proofId
      || launch.planSha256 !== loaded.plan.planSha256
      || !Number.isFinite(Date.parse(launch.startedAt))
      || launch.executionAuthority
        !== 'operator-exact-evaluator-proof-plan-sha256'
      || launch.maximumCalls !== 1 || launch.retriesAuthorized !== false
      || launch.launchSha256 !== sha256(canonicalVNextJson(launchCore))) {
    return refused(
      'EVALUATOR_PROOF_LAUNCH_INVALID',
      'Evaluator launch receipt failed one-shot replay.'
    );
  }
  if (!exactKeys(result, [
    'schemaVersion', 'proofId', 'planSha256', 'launchSha256', 'completedAt',
    'invocation', 'receipt', 'artifact', 'modelIdentityReceipt',
    'workerResultSha256', 'tokenUsageDetails', 'reportedModel',
    'productionEvidence', 'activationAuthority', 'resultSha256'
  ]) || result.schemaVersion !== VNEXT_EVALUATOR_PROOF_RESULT_SCHEMA
      || result.proofId !== proofId || result.planSha256 !== loaded.plan.planSha256
      || result.launchSha256 !== launch.launchSha256
      || result.productionEvidence !== true || result.activationAuthority !== false
      || !Number.isFinite(Date.parse(result.completedAt))
      || !SHA256.test(String(result.resultSha256 || ''))) {
    return refused('EVALUATOR_PROOF_RESULT_INVALID', 'Evaluator proof result shape is invalid.');
  }
  const core = structuredClone(result);
  delete core.resultSha256;
  const replay = verifyIsolatedEvaluatorFromDisk({
    invocation: result.invocation,
    receipt: result.receipt,
    artifact: result.artifact,
    requireProduction: true,
    identityPolicy: loaded.plan.identityPolicy,
    verifiedAt: result.completedAt
  });
  const usage = readWorkerUsage(result.invocation);
  if (result.resultSha256 !== sha256(canonicalVNextJson(core))
      || replay.status !== 'OK' || !usage
      || usage.workerResultSha256 !== result.workerResultSha256
      || canonicalVNextJson(usage.tokenUsageDetails)
        !== canonicalVNextJson(result.tokenUsageDetails)
      || usage.reportedModel !== result.reportedModel
      || replay.modelIdentityReceipt?.receiptSha256
        !== result.modelIdentityReceipt?.receiptSha256) {
    return refused('EVALUATOR_PROOF_REPLAY_FAILED', 'Evaluator process, model identity, usage, or result failed independent replay.');
  }
  return {
    status: 'OK',
    plan: loaded.plan,
    result,
    evaluation: result.artifact.payload.evaluation,
    evidenceSha256: sha256(canonicalVNextJson({
      planSha256: loaded.plan.planSha256,
      launchSha256: launch.launchSha256,
      resultSha256: result.resultSha256,
      receiptSha256: result.receipt.receiptSha256,
      modelIdentityReceiptSha256: result.modelIdentityReceipt.receiptSha256,
      workerResultSha256: result.workerResultSha256
    }))
  };
}
