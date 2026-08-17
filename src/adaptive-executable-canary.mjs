// Causal proof for adaptive mechanism routing using executable repairs.
//
// Qualification and confirmation use disjoint mutation pools. Workers receive
// only source, an incident report, and (depending on arm) one mechanism capsule.
// The supervisor executes returned modules in a constrained subprocess and owns
// every hidden expected output, score, receipt, and stop decision.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  isAbsolute,
  join,
  posix as pathPosix,
  relative,
  resolve,
  sep
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  STRICT_CODEX_REASONING_EFFORT,
  buildArgs,
  normalizeStructuredWorkerOutput,
  parseReportedModel,
  parseTokenUsage,
  runWorker,
  schemaPathForContract
} from './executor.mjs';
import { parseCaseResults } from './measure.mjs';
import {
  REAL_TEST_MODEL,
  canonicalJson,
  resolveEvidenceCapsule
} from './real-test.mjs';
import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  isCausallyAdmittedCanaryImport,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import {
  buildMechanismRoutingDecision,
  mechanismInstruction
} from './mechanism-router.mjs';
import {
  EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2,
  MECHANISM_COMPILER_VERSION,
  compileMechanismCapsule
} from './mechanism-compiler.mjs';
import {
  captureCodexOAuthAuthority,
  validateCodexOAuthAuthorityRecord
} from './codex-oauth-authority.mjs';
import {
  persistCanaryProposal,
  persistRejectedDispatch,
  stableJson,
  writeCanaryArtifact
} from './canary-runner.mjs';
import { verifyPersistedProposalRun } from './run-verifier.mjs';
import {
  isSafeId,
  nowIso,
  round,
  sha256
} from './util.mjs';

export const ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION =
  'adaptive-executable-canary-v1';
export const ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2 =
  'adaptive-executable-canary-v2';
export const ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3 =
  'adaptive-executable-canary-v3';
export const ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4 =
  'adaptive-executable-canary-v4';
export const EXECUTABLE_CASE_SET_SCHEMA_VERSION =
  'executable-case-set-v1';
export const EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION =
  'executable-interface-contract-v1';
export { EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2 };
export const EXECUTABLE_EVALUATOR_AUTHORITY_SCHEMA_VERSION =
  'executable-evaluator-authority-v1';
export const ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION = '0.145.0';

export const ADAPTIVE_EXECUTABLE_CANARY = Object.freeze({
  qualificationTasks: 5,
  confirmationTasks: 5,
  arms: Object.freeze(['baseline', 'routed', 'sham']),
  qualificationFailureThreshold: 3,
  confirmationBaselineFailureThreshold: 2,
  routedWinThreshold: 2,
  routedAdvantageThreshold: 2,
  maximumCalls: 20,
  retriesPerDispatch: 0,
  perCallTimeoutMs: 10 * 60 * 1000,
  sequentialTimeoutCeilingMs: 200 * 60 * 1000,
  hardTokenLimit: null,
  hardUsdLimit: null,
  promotionEnabled: false,
  candidateTimeoutMs: 15000,
  candidateMaxBytes: 64 * 1024,
  candidateMaxBufferBytes: 1024 * 1024,
  candidateHeapMb: 128
});

export const ADAPTIVE_EXECUTABLE_CONFIRMATION_SCHEDULE = Object.freeze([
  Object.freeze(['baseline', 'routed', 'sham']),
  Object.freeze(['routed', 'sham', 'baseline']),
  Object.freeze(['sham', 'baseline', 'routed']),
  Object.freeze(['baseline', 'sham', 'routed']),
  Object.freeze(['routed', 'baseline', 'sham'])
]);

export const EXECUTABLE_SANDBOX_PROFILE =
  '(version 1)(allow default)(deny network*)';

export const ADAPTIVE_EXECUTABLE_CANARY_IMPLEMENTATION_PATHS = Object.freeze([
  'package.json',
  'docs/EXECUTABLE_CAUSAL_CANARY_V1.md',
  'scripts/executable-canary-sandbox.mjs',
  'scripts/plan-adaptive-executable-canary.mjs',
  'scripts/run-adaptive-executable-canary.mjs',
  'scripts/verify-adaptive-executable-canary.mjs',
  'src/adaptive-executable-canary.mjs',
  'src/adaptive-records.mjs',
  'src/canary-runner.mjs',
  'src/codex-oauth-authority.mjs',
  'src/executor.mjs',
  'src/measure.mjs',
  'src/mechanism-router.mjs',
  'src/real-test.mjs',
  'src/run-verifier.mjs',
  'src/schemas/proposal-output.schema.json',
  'src/store.mjs',
  'src/util.mjs'
]);

export const ADAPTIVE_EXECUTABLE_CANARY_V2_IMPLEMENTATION_PATHS = Object.freeze([
  ...ADAPTIVE_EXECUTABLE_CANARY_IMPLEMENTATION_PATHS,
  'docs/EXECUTABLE_CAUSAL_CANARY_V2.md',
  'src/schemas/executable-interface-contract-v1.schema.json'
].sort());

export const ADAPTIVE_EXECUTABLE_CANARY_V3_IMPLEMENTATION_PATHS = Object.freeze([
  ...ADAPTIVE_EXECUTABLE_CANARY_V2_IMPLEMENTATION_PATHS,
  'docs/EXECUTABLE_CAUSAL_CANARY_V3.md'
].sort());

export const ADAPTIVE_EXECUTABLE_CANARY_V4_IMPLEMENTATION_PATHS = Object.freeze([
  ...ADAPTIVE_EXECUTABLE_CANARY_V3_IMPLEMENTATION_PATHS,
  'docs/EXECUTABLE_CAUSAL_CANARY_V4.md',
  'src/mechanism-compiler.mjs',
  'src/schemas/executable-interface-contract-v2.schema.json',
  'src/schemas/mechanism-family-v1.schema.json',
  'src/schemas/mechanism-program-v1.schema.json'
].sort());

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX_BOOTSTRAP_PATH = join(
  PACKAGE_ROOT,
  'scripts',
  'executable-canary-sandbox.mjs'
);
const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const SHA256_RE = /^[a-f0-9]{64}$/;
const TASK_PHASES = new Set(['qualification', 'confirmation']);
const CASE_GROUPS = new Set(['target', 'control']);
const EXECUTABLE_CANARY_SCHEMA_VERSIONS = new Set([
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4
]);
const INTERFACE_PATH_RE =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?)*$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function deepEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function isExecutableCanaryV2(config = {}) {
  return config.schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2
    || config.schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3
    || config.schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4;
}

function isExecutableCanaryV3(config = {}) {
  return config.schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3;
}

function isExecutableCanaryV4(config = {}) {
  return config.schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4;
}

function parsedCodexVersion(value) {
  const match = String(value || '').trim().match(
    /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
  );
  return match ? {
    parts: match.slice(1, 4).map(Number),
    prerelease: match[4] || null
  } : null;
}

function codexVersionAtLeast(actual, minimum) {
  const current = parsedCodexVersion(actual);
  const floor = parsedCodexVersion(`codex-cli ${minimum}`);
  if (!current || !floor) return false;
  for (let index = 0; index < current.parts.length; index++) {
    if (current.parts[index] !== floor.parts[index]) {
      return current.parts[index] > floor.parts[index];
    }
  }
  return floor.prerelease != null || current.prerelease == null;
}

export function executablePermissionFlag(nodeVersion = process.version) {
  const match = String(nodeVersion || '').match(/^v(\d+)\.(\d+)\./);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 20) return null;
  return major > 23
      || (major === 23 && minor >= 5)
      || (major === 22 && minor >= 13)
    ? '--permission'
    : '--experimental-permission';
}

function implementationPathsFor(schemaVersion) {
  if (schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4) {
    return ADAPTIVE_EXECUTABLE_CANARY_V4_IMPLEMENTATION_PATHS;
  }
  if (schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3) {
    return ADAPTIVE_EXECUTABLE_CANARY_V3_IMPLEMENTATION_PATHS;
  }
  return schemaVersion === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2
    ? ADAPTIVE_EXECUTABLE_CANARY_V2_IMPLEMENTATION_PATHS
    : ADAPTIVE_EXECUTABLE_CANARY_IMPLEMENTATION_PATHS;
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function safeRelativePath(path, label = 'path') {
  const value = String(path || '');
  if (!value
      || value.includes('\0')
      || isAbsolute(value)
      || value === '..'
      || value.startsWith(`..${sep}`)
      || value.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be repository-relative`);
  }
  return value;
}

function safeArtifact(store, runId, artifactId) {
  if (!artifactId) return null;
  try {
    return store.readArtifact(runId, artifactId);
  } catch {
    return null;
  }
}

function artifactHashMatches(artifact) {
  return !!(
    artifact
    && typeof artifact.content === 'string'
    && SHA256_RE.test(String(artifact.sha256 || ''))
    && sha256(artifact.content) === artifact.sha256
  );
}

function evidenceArtifact(store, runId, id, role, value) {
  const artifact = writeCanaryArtifact(store, runId, id, {
    role,
    content: canonicalJson(value)
  });
  return { id: artifact.id, sha256: artifact.sha256 };
}

function capsulePayload(capsule) {
  const payload = { ...object(capsule) };
  delete payload.mechanismCapsuleSha256;
  return payload;
}

function capsuleHash(capsule) {
  return sha256(canonicalAdaptiveJson(capsulePayload(capsule)));
}

function capsuleShape(value) {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: value.map(capsuleShape)
    };
  }
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).sort(),
      values: Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, capsuleShape(value[key])])
      )
    };
  }
  return { type: value === null ? 'null' : typeof value };
}

function capsuleSchemaSha256(capsule) {
  return sha256(stableJson(capsuleShape(capsule)));
}

function capsuleIntegrity(capsule) {
  return object(capsule).schemaVersion === 'mechanism-capsule-v1'
    && SHA256_RE.test(String(capsule.mechanismCapsuleSha256 || ''))
    && capsuleHash(capsule) === capsule.mechanismCapsuleSha256;
}

export function createExecutableShamCapsule(routedCapsule) {
  if (!capsuleIntegrity(routedCapsule)) {
    throw new Error('routed capsule must be valid before deriving a sham');
  }
  const items = (routedCapsule.items || []).map((item, index) => {
    const seed = sha256(canonicalAdaptiveJson({
      routedCapsuleSha256: routedCapsule.mechanismCapsuleSha256,
      index,
      role: 'executable-sham'
    }));
    const shamItem = canonicalValue(item);
    shamItem.familyId = `family-${seed.slice(0, 24)}`;
    shamItem.familySha256 = sha256(`sham-family:${seed}`);
    shamItem.semantics = 'irrelevant-control';
    const fingerprint = object(shamItem.causalFingerprint);
    fingerprint.bottleneckKind = 'inconsistent-document-heading-depth';
    fingerprint.interventionKind = 'normalize-markdown-heading-hierarchy';
    fingerprint.operationKind = 'documentation-presentation-normalization';
    fingerprint.expectedEffectKind = 'more-consistent-document-scanning';
    fingerprint.preconditions = (fingerprint.preconditions || [])
      .map((ignored, position) => `markdown-precondition-${position + 1}`);
    if (Array.isArray(fingerprint.procedureSteps)) {
      fingerprint.procedureSteps = fingerprint.procedureSteps
        .map((ignored, position) => `normalize-document-section-${position + 1}`);
    }
    const applicability = object(fingerprint.applicability);
    const replace = (values, prefix) => (Array.isArray(values) ? values : [])
      .map((ignored, position) => `${prefix}-${position + 1}`);
    applicability.taskModes = replace(applicability.taskModes, 'document-task');
    applicability.loopRoles = replace(applicability.loopRoles, 'reporter-role');
    applicability.taskValueDimensions = replace(
      applicability.taskValueDimensions,
      'readability-value'
    );
    applicability.resourceDimensions = replace(
      applicability.resourceDimensions,
      'document-resource'
    );
    fingerprint.applicability = applicability;
    shamItem.causalFingerprint = fingerprint;
    shamItem.instruction = Array.isArray(fingerprint.procedureSteps)
      ? mechanismInstruction(fingerprint, 'positive-transfer')
      : 'For Markdown documentation, keep heading depth consistent and use one blank line between sections.';
    const evidence = object(shamItem.evidence);
    evidence.applicationReceiptId =
      `app-receipt-${sha256(`sham-app:${seed}`).slice(0, 24)}`;
    evidence.applicationSha256 = sha256(`sham-application:${seed}`);
    if (Object.hasOwn(evidence, 'confidence')) evidence.confidence = 0.8;
    if (Object.hasOwn(evidence, 'reverified')) evidence.reverified = true;
    if (Object.hasOwn(evidence, 'utility')) evidence.utility = 0.1;
    if (Object.hasOwn(evidence, 'verdict')) evidence.verdict = 'improvement';
    shamItem.evidence = evidence;
    return shamItem;
  });
  const sham = {
    ...canonicalValue(routedCapsule),
    items
  };
  sham.mechanismCapsuleSha256 = capsuleHash(sham);
  if (capsuleSchemaSha256(sham) !== capsuleSchemaSha256(routedCapsule)) {
    throw new Error('derived sham capsule changed the treatment schema');
  }
  return sham;
}

export function resolveAdaptiveExecutableCanaryImplementation(
  packageRoot = PACKAGE_ROOT,
  schemaVersion = ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION
) {
  const errors = [];
  const capsule = [];
  for (const relativePath of implementationPathsFor(schemaVersion)) {
    let safePath;
    try {
      safePath = safeRelativePath(relativePath, 'implementation path');
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const absolutePath = resolve(packageRoot, safePath);
    const rel = relative(resolve(packageRoot), absolutePath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      errors.push(`implementation path escaped package root: ${safePath}`);
      continue;
    }
    if (!existsSync(absolutePath)) {
      errors.push(`implementation dependency is missing: ${safePath}`);
      continue;
    }
    const content = readFileSync(absolutePath, 'utf8');
    capsule.push({
      path: safePath,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      content
    });
  }
  capsule.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: errors.length === 0,
    errors,
    manifest: capsule.map(({ path, bytes, sha256: digest }) => ({
      path,
      bytes,
      sha256: digest
    })),
    capsule
  };
}

export function captureExecutableEvaluatorAuthority({
  nodePath = process.execPath,
  sandboxPath = SANDBOX_EXEC_PATH,
  bootstrapPath = SANDBOX_BOOTSTRAP_PATH
} = {}) {
  if (process.platform !== 'darwin') {
    return {
      status: 'BLOCKED',
      code: 'EXECUTABLE_SANDBOX_UNSUPPORTED',
      message: 'executable canary v1 requires the macOS sandbox boundary'
    };
  }
  const permissionFlag = executablePermissionFlag(process.version);
  if (!permissionFlag) {
    return {
      status: 'BLOCKED',
      code: 'EXECUTABLE_NODE_PERMISSION_UNSUPPORTED',
      message: 'executable canary requires the Node permission model from Node 20 or newer'
    };
  }
  for (const [label, path] of [
    ['node', nodePath],
    ['sandbox-exec', sandboxPath],
    ['sandbox bootstrap', bootstrapPath]
  ]) {
    if (!isAbsolute(path) || !existsSync(path)) {
      return {
        status: 'BLOCKED',
        code: 'EXECUTABLE_SANDBOX_MISSING',
        message: `${label} path is missing or not absolute`
      };
    }
  }
  const payload = {
    schemaVersion: EXECUTABLE_EVALUATOR_AUTHORITY_SCHEMA_VERSION,
    platform: process.platform,
    architecture: process.arch,
    node: {
      path: nodePath,
      basename: basename(nodePath),
      version: process.version,
      sha256: fileSha256(nodePath)
    },
    sandbox: {
      path: sandboxPath,
      basename: basename(sandboxPath),
      sha256: fileSha256(sandboxPath),
      profile: EXECUTABLE_SANDBOX_PROFILE,
      profileSha256: sha256(EXECUTABLE_SANDBOX_PROFILE)
    },
    bootstrap: {
      path: bootstrapPath,
      sha256: fileSha256(bootstrapPath)
    },
    limits: {
      timeoutMs: ADAPTIVE_EXECUTABLE_CANARY.candidateTimeoutMs,
      maxBytes: ADAPTIVE_EXECUTABLE_CANARY.candidateMaxBytes,
      maxBufferBytes: ADAPTIVE_EXECUTABLE_CANARY.candidateMaxBufferBytes,
      heapMb: ADAPTIVE_EXECUTABLE_CANARY.candidateHeapMb
    },
    permissions: {
      nodeFlag: permissionFlag,
      filesystem: 'candidate-and-bootstrap-read-only',
      childProcesses: 'denied',
      workers: 'denied',
      network: 'denied'
    }
  };
  return {
    status: 'OK',
    record: {
      ...payload,
      authoritySha256: sha256(canonicalJson(payload))
    }
  };
}

export function validateExecutableEvaluatorAuthorityRecord(record) {
  const authority = object(record);
  const errors = [];
  if (authority.schemaVersion !== EXECUTABLE_EVALUATOR_AUTHORITY_SCHEMA_VERSION) {
    errors.push('evaluator authority schema is invalid');
  }
  if (authority.platform !== 'darwin'
      || !/^[A-Za-z0-9_-]{2,32}$/.test(String(authority.architecture || ''))) {
    errors.push('evaluator authority origin platform or architecture is invalid');
  }
  if (!pathPosix.isAbsolute(String(authority.node?.path || ''))
      || authority.node?.basename !== pathPosix.basename(String(authority.node?.path || ''))
      || !SHA256_RE.test(String(authority.node?.sha256 || ''))
      || executablePermissionFlag(authority.node?.version) == null) {
    errors.push('evaluator Node authority is invalid');
  }
  if (authority.sandbox?.path !== SANDBOX_EXEC_PATH
      || authority.sandbox?.basename !== basename(SANDBOX_EXEC_PATH)
      || !SHA256_RE.test(String(authority.sandbox?.sha256 || ''))
      || authority.sandbox?.profile !== EXECUTABLE_SANDBOX_PROFILE
      || authority.sandbox?.profileSha256 !== sha256(EXECUTABLE_SANDBOX_PROFILE)) {
    errors.push('sandbox executable or profile authority is invalid');
  }
  if (!pathPosix.isAbsolute(String(authority.bootstrap?.path || ''))
      || !SHA256_RE.test(String(authority.bootstrap?.sha256 || ''))) {
    errors.push('sandbox bootstrap authority is invalid');
  }
  if (authority.permissions?.nodeFlag
      !== executablePermissionFlag(authority.node?.version)) {
    errors.push('Node permission flag is invalid for the sealed runtime');
  }
  if (authority.permissions?.filesystem !== 'candidate-and-bootstrap-read-only'
      || authority.permissions?.childProcesses !== 'denied'
      || authority.permissions?.workers !== 'denied'
      || authority.permissions?.network !== 'denied') {
    errors.push('evaluator permission policy changed');
  }
  if (!Number.isInteger(authority.limits?.timeoutMs)
      || authority.limits.timeoutMs < 1
      || authority.limits.timeoutMs > ADAPTIVE_EXECUTABLE_CANARY.candidateTimeoutMs
      || !Number.isInteger(authority.limits?.maxBytes)
      || authority.limits.maxBytes < 1
      || authority.limits.maxBytes > ADAPTIVE_EXECUTABLE_CANARY.candidateMaxBytes
      || !Number.isInteger(authority.limits?.maxBufferBytes)
      || authority.limits.maxBufferBytes < 1
      || authority.limits.maxBufferBytes
        > ADAPTIVE_EXECUTABLE_CANARY.candidateMaxBufferBytes
      || !Number.isInteger(authority.limits?.heapMb)
      || authority.limits.heapMb < 1
      || authority.limits.heapMb > ADAPTIVE_EXECUTABLE_CANARY.candidateHeapMb) {
    errors.push('evaluator resource limits exceed the implementation ceiling');
  }
  const payload = { ...authority };
  delete payload.authoritySha256;
  if (!SHA256_RE.test(String(authority.authoritySha256 || ''))
      || sha256(canonicalJson(payload)) !== authority.authoritySha256) {
    errors.push('evaluator authority hash does not bind the record');
  }
  return {
    status: errors.length ? 'BLOCKED' : 'OK',
    code: errors.length ? 'EXECUTABLE_EVALUATOR_AUTHORITY_INVALID' : undefined,
    errors,
    record: errors.length ? null : authority
  };
}

export function validateExecutableEvaluatorAuthority(record) {
  const authority = object(record);
  const sealed = validateExecutableEvaluatorAuthorityRecord(authority);
  const errors = [...sealed.errors];
  if (authority.platform !== process.platform
      || authority.architecture !== process.arch) {
    errors.push('evaluator authority platform or architecture changed');
  }
  if (authority.node?.path !== process.execPath
      || authority.node?.version !== process.version
      || !existsSync(String(authority.node?.path || ''))
      || fileSha256(authority.node.path) !== authority.node.sha256) {
    errors.push('evaluator Node binary changed');
  }
  if (authority.sandbox?.path !== SANDBOX_EXEC_PATH
      || !existsSync(String(authority.sandbox?.path || ''))
      || fileSha256(authority.sandbox.path) !== authority.sandbox.sha256) {
    errors.push('sandbox executable changed');
  }
  if (authority.bootstrap?.path !== SANDBOX_BOOTSTRAP_PATH
      || !existsSync(String(authority.bootstrap?.path || ''))
      || fileSha256(authority.bootstrap.path) !== authority.bootstrap.sha256) {
    errors.push('sandbox bootstrap changed');
  }
  if (authority.permissions?.nodeFlag
      !== executablePermissionFlag(process.version)) {
    errors.push('Node permission flag changed or is unsupported');
  }
  return {
    status: errors.length ? 'BLOCKED' : 'OK',
    code: errors.length ? 'EXECUTABLE_EVALUATOR_AUTHORITY_HOST_MISMATCH' : undefined,
    errors,
    record: errors.length ? null : authority
  };
}

function parseCaseSet(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch {
    return { ok: false, errors: ['case set is not JSON'], record: null };
  }
  const errors = [];
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (parsed?.schemaVersion !== EXECUTABLE_CASE_SET_SCHEMA_VERSION) {
    errors.push('case set schema is invalid');
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(String(parsed?.exportName || ''))) {
    errors.push('case set exportName is invalid');
  }
  if (cases.length < 5 || cases.length > 12) {
    errors.push('case set must contain 5-12 cases');
  }
  const ids = cases.map((item) => String(item?.id || ''));
  if (ids.some((id) => !isSafeId(id)) || new Set(ids).size !== ids.length) {
    errors.push('case IDs must be unique safe identifiers');
  }
  if (cases.some((item) => (
    !CASE_GROUPS.has(String(item?.group || ''))
    || !Object.hasOwn(object(item), 'input')
    || !Object.hasOwn(object(item), 'expected')
  ))) {
    errors.push('every case requires a target/control group, input, and expected output');
  }
  const targets = cases.filter((item) => item.group === 'target');
  const controls = cases.filter((item) => item.group === 'control');
  if (targets.length < 3 || controls.length < 2) {
    errors.push('case set requires at least three targets and two controls');
  }
  return {
    ok: errors.length === 0,
    errors,
    record: errors.length ? null : canonicalValue(parsed)
  };
}

function parseInterfaceContract(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch {
    return { ok: false, errors: ['interface contract is not JSON'], record: null };
  }
  const errors = [];
  const inputPaths = Array.isArray(parsed?.inputPaths) ? parsed.inputPaths : [];
  const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
  const codes = Array.isArray(parsed?.codes) ? parsed.codes : [];
  const v2 = parsed?.schemaVersion
    === EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2;
  const expectedKeys = v2
    ? ['schemaVersion', 'exportName', 'inputPaths', 'decisions', 'codes', 'roleBindings']
    : ['schemaVersion', 'exportName', 'inputPaths', 'decisions', 'codes'];
  if (![EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION,
    EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2]
    .includes(parsed?.schemaVersion)
      || (v2 && Object.keys(object(parsed)).sort().join(',')
        !== expectedKeys.sort().join(','))) {
    errors.push('interface contract schema is invalid');
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(String(parsed?.exportName || ''))) {
    errors.push('interface contract exportName is invalid');
  }
  if (inputPaths.length < 1
      || inputPaths.length > (v2 ? 160 : 120)
      || inputPaths.some((path) => !INTERFACE_PATH_RE.test(String(path)))
      || new Set(inputPaths).size !== inputPaths.length) {
    errors.push('interface inputPaths must be unique declared property paths');
  }
  if (decisions.length !== 2
      || new Set(decisions).size !== decisions.length
      || !decisions.includes('ACCEPT')
      || !decisions.includes('REJECT')) {
    errors.push('interface decisions must declare ACCEPT and REJECT');
  }
  if (codes.length < 2
      || codes.length > (v2 ? 60 : 40)
      || new Set(codes.map((item) => item?.value)).size !== codes.length
      || codes.some((item) => (
        !item
        || typeof item !== 'object'
        || Array.isArray(item)
        || Object.keys(item).sort().join(',') !== 'meaning,value'
        || !/^[A-Z][A-Z0-9_]{1,119}$/.test(String(item.value || ''))
        || typeof item.meaning !== 'string'
        || item.meaning.trim().length < 8
        || item.meaning.length > 500
      ))) {
    errors.push('interface codes must be unique bounded code/meaning records');
  }
  if (v2) {
    const roleBindings = Array.isArray(parsed?.roleBindings)
      ? parsed.roleBindings
      : [];
    const declaredPaths = new Set(inputPaths);
    if (roleBindings.length < 1
        || roleBindings.length > 100
        || new Set(roleBindings.map((item) => item?.role)).size
          !== roleBindings.length
        || new Set(roleBindings.map((item) => item?.path)).size
          !== roleBindings.length
        || roleBindings.some((item) => (
          !item
          || typeof item !== 'object'
          || Array.isArray(item)
          || Object.keys(item).sort().join(',') !== 'path,role'
          || !/^[a-z][a-z0-9-]{0,79}(?:\.[a-z][a-z0-9-]{0,79})*$/.test(
            String(item.role || '')
          )
          || !declaredPaths.has(item.path)
        ))) {
      errors.push('interface roleBindings must map unique semantic roles to unique declared paths');
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    record: errors.length ? null : canonicalValue(parsed)
  };
}

function inputLeafPaths(value, prefix = '', paths = new Set()) {
  if (Array.isArray(value)) {
    const arrayPath = `${prefix}[]`;
    if (!value.length) paths.add(arrayPath);
    for (const item of value) inputLeafPaths(item, arrayPath, paths);
    return paths;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length && prefix) paths.add(prefix);
    for (const [key, item] of entries) {
      inputLeafPaths(item, prefix ? `${prefix}.${key}` : key, paths);
    }
    return paths;
  }
  if (prefix) paths.add(prefix);
  return paths;
}

export function validateExecutableInterfaceCoverage(caseSet, interfaceContract) {
  const parsedCases = parseCaseSet(canonicalJson(caseSet));
  const parsedInterface = parseInterfaceContract(canonicalJson(interfaceContract));
  const errors = [
    ...parsedCases.errors,
    ...parsedInterface.errors
  ];
  if (!parsedCases.ok || !parsedInterface.ok) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  if (parsedCases.record.exportName !== parsedInterface.record.exportName) {
    errors.push('interface exportName does not match the hidden case set');
  }
  const declaredPaths = new Set(parsedInterface.record.inputPaths);
  const declaredDecisions = new Set(parsedInterface.record.decisions);
  const declaredCodes = new Set(
    parsedInterface.record.codes.map((item) => item.value)
  );
  for (const testCase of parsedCases.record.cases) {
    for (const path of inputLeafPaths(testCase.input)) {
      if (!declaredPaths.has(path)) {
        errors.push(`hidden input path is undeclared: ${path}`);
      }
    }
    if (!declaredDecisions.has(testCase.expected?.decision)) {
      errors.push(`hidden decision is undeclared: ${testCase.expected?.decision}`);
    }
    if (!declaredCodes.has(testCase.expected?.code)) {
      errors.push(`hidden code is undeclared: ${testCase.expected?.code}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)].sort(),
    sha256: sha256(canonicalJson({
      interfaceContract: parsedInterface.record,
      coveredInputPaths: [...new Set(parsedCases.record.cases.flatMap((item) => (
        [...inputLeafPaths(item.input)]
      )))].sort(),
      coveredDecisions: [...new Set(parsedCases.record.cases
        .map((item) => item.expected?.decision))].sort(),
      coveredCodes: [...new Set(parsedCases.record.cases
        .map((item) => item.expected?.code))].sort()
    }))
  };
}

function capsuleMap(config, {
  sourcesField,
  manifestField,
  capsuleField,
  label,
  errors
}) {
  const sources = Array.isArray(config[sourcesField]) ? config[sourcesField].map(String) : [];
  const manifest = Array.isArray(config[manifestField]) ? config[manifestField] : [];
  const capsule = Array.isArray(config[capsuleField]) ? config[capsuleField] : [];
  const map = new Map();
  if (!sources.length) errors.push(`${label} sources are missing`);
  const sourceSet = new Set(sources);
  if (sourceSet.size !== sources.length) errors.push(`${label} sources contain duplicates`);
  if (manifest.length !== sources.length || capsule.length !== sources.length) {
    errors.push(`${label} manifest/capsule count does not match sources`);
  }
  for (const item of capsule) {
    const path = String(item?.path || '');
    let safePath = null;
    try {
      safePath = safeRelativePath(path, `${label} path`);
    } catch (error) {
      errors.push(error.message);
    }
    if (!safePath
        || map.has(safePath)
        || !sourceSet.has(safePath)
        || !Number.isInteger(item?.bytes)
        || typeof item?.content !== 'string'
        || !SHA256_RE.test(String(item?.sha256 || ''))
        || Buffer.byteLength(item.content) !== item.bytes
        || sha256(item.content) !== item.sha256) {
      errors.push(`${label} capsule is invalid: ${path || '<missing>'}`);
      continue;
    }
    map.set(safePath, item);
  }
  const manifestMap = new Map(manifest.map((item) => [String(item?.path || ''), item]));
  if (manifestMap.size !== map.size || [...map.entries()].some(([path, item]) => {
    const sealed = manifestMap.get(path);
    return !sealed
      || sealed.bytes !== item.bytes
      || sealed.sha256 !== item.sha256;
  })) {
    errors.push(`${label} manifest does not bind the capsule`);
  }
  return map;
}

function inspectImplementation(config, errors) {
  const expectedPaths = [...implementationPathsFor(config.schemaVersion)].sort();
  const capsule = Array.isArray(config.implementationCapsule)
    ? config.implementationCapsule
    : [];
  const manifest = Array.isArray(config.implementationManifest)
    ? config.implementationManifest
    : [];
  const paths = capsule.map((item) => String(item?.path || '')).sort();
  if (!deepEqual(paths, expectedPaths)) {
    errors.push('implementation capsule does not contain the exact executable-canary dependencies');
  }
  const capsuleByPath = new Map();
  for (const item of capsule) {
    const path = String(item?.path || '');
    if (!path
        || capsuleByPath.has(path)
        || typeof item?.content !== 'string'
        || item.bytes !== Buffer.byteLength(item.content)
        || item.sha256 !== sha256(item.content)) {
      errors.push(`implementation capsule is invalid: ${path || '<missing>'}`);
      continue;
    }
    capsuleByPath.set(path, item);
  }
  const manifestByPath = new Map(manifest.map((item) => [String(item?.path || ''), item]));
  if (manifestByPath.size !== capsuleByPath.size
      || [...capsuleByPath].some(([path, item]) => (
        manifestByPath.get(path)?.sha256 !== item.sha256
        || manifestByPath.get(path)?.bytes !== item.bytes
      ))) {
    errors.push('implementation manifest does not bind the capsule');
  }
  return {
    ok: errors.length === 0,
    manifest,
    capsule
  };
}

function inspectMechanismContext(config, errors) {
  const context = object(config.mechanismContext);
  const families = Array.isArray(context.families) ? context.families : [];
  const applications = Array.isArray(context.applications) ? context.applications : [];
  const familiesValid = families.length > 0 && families.every((record) => (
    record?.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
    && validateAdaptiveRecord(record).status === 'OK'
  ));
  const applicationsValid = applications.length > 0 && applications.every((record) => (
    (record?.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
      && validateAdaptiveRecord(record).status === 'OK')
    || isCausallyAdmittedCanaryImport(record)
  ));
  const policyValid = context.policyEpoch?.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH
    && validateAdaptiveRecord(context.policyEpoch).status === 'OK';
  const decisionValid =
    context.routingDecision?.schemaVersion === ADAPTIVE_SCHEMA.ROUTING_DECISION
    && validateAdaptiveRecord(context.routingDecision).status === 'OK';
  if (!familiesValid) errors.push('mechanism families are missing or invalid');
  if (!applicationsValid) errors.push('mechanism applications are missing or invalid');
  if (!policyValid) errors.push('mechanism policy epoch is invalid');
  if (!decisionValid) errors.push('mechanism routing decision is invalid');
  const replay = policyValid
    ? buildMechanismRoutingDecision({
        families,
        applications,
        target: object(context.routingTarget),
        policyEpoch: context.policyEpoch,
        seed: context.seed,
        hypothesisCount: context.hypothesisCount,
        mode: 'active-canary'
      })
    : null;
  const replayValid = replay?.status === 'OK'
    && canonicalAdaptiveJson(replay.decision)
      === canonicalAdaptiveJson(context.routingDecision)
    && canonicalAdaptiveJson(replay.candidatePool)
      === canonicalAdaptiveJson(context.candidatePool)
    && canonicalAdaptiveJson(replay.capsule)
      === canonicalAdaptiveJson(context.routedCapsule);
  if (!replayValid) errors.push('mechanism routing does not replay');
  const familyIds = new Set(families.map((item) => item.familyId));
  const routedItems = Array.isArray(context.routedCapsule?.items)
    ? context.routedCapsule.items
    : [];
  const routedApplicationIds = new Set([
    ...routedItems.map((item) => item.evidence?.applicationReceiptId),
    ...(Array.isArray(context.candidatePool) ? context.candidatePool : [])
      .flatMap((item) => (item.applications || [])
        .map((entry) => entry.applicationReceiptId))
  ].filter(Boolean));
  const nonHarvestIds = new Set(applications
    .filter((item) => item.partition !== 'harvest')
    .map((item) => item.applicationReceiptId));
  const partitionIsolation =
    [...nonHarvestIds].every((id) => !routedApplicationIds.has(id));
  if (!partitionIsolation) {
    errors.push('non-harvest evidence entered the routed candidate pool');
  }
  const routedValid = capsuleIntegrity(context.routedCapsule)
    && routedItems.length === 1
    && routedItems[0].semantics === 'positive-transfer'
    && familyIds.has(routedItems[0].familyId)
    && context.routingDecision?.mechanismCapsuleSha256
      === context.routedCapsule?.mechanismCapsuleSha256;
  if (!routedValid) errors.push('routed mechanism capsule is invalid');
  const shamItems = Array.isArray(context.shamCapsule?.items)
    ? context.shamCapsule.items
    : [];
  const shamValid = capsuleIntegrity(context.shamCapsule)
    && capsuleSchemaSha256(context.shamCapsule)
      === capsuleSchemaSha256(context.routedCapsule)
    && context.shamCapsule.mechanismCapsuleSha256
      !== context.routedCapsule.mechanismCapsuleSha256
    && shamItems.length === routedItems.length
    && shamItems.every((item) => (
      item.semantics === 'irrelevant-control'
      && item.causalFingerprint?.operationKind
        === 'documentation-presentation-normalization'
      && !/do not (?:fix|repair)|presentation-only revision/i.test(
        String(item.instruction || '')
      )
    ));
  if (!shamValid) errors.push('sham mechanism capsule is not a neutral schema-matched control');
  let shamReplayValid = true;
  if (isExecutableCanaryV4(config)) {
    try {
      shamReplayValid = canonicalAdaptiveJson(createExecutableShamCapsule(
        context.routedCapsule
      )) === canonicalAdaptiveJson(context.shamCapsule);
    } catch {
      shamReplayValid = false;
    }
    if (!shamReplayValid) errors.push('V4 sham capsule does not replay');
  }
  return {
    ok: replayValid
      && partitionIsolation
      && routedValid
      && shamValid
      && shamReplayValid,
    replay,
    replayValid,
    partitionIsolation,
    routedValid,
    shamValid,
    shamReplayValid
  };
}

function taskFor(config, taskId) {
  return (Array.isArray(config.tasks) ? config.tasks : [])
    .find((item) => item.id === taskId) || null;
}

function capsuleItem(config, field, path) {
  return (Array.isArray(config[field]) ? config[field] : [])
    .find((item) => item.path === path) || null;
}

function taskMaterials(config, task) {
  const source = capsuleItem(config, 'publicCapsule', task.sourcePath);
  const spec = capsuleItem(config, 'publicCapsule', task.specPath);
  const interfaceArtifact = isExecutableCanaryV2(config)
    ? capsuleItem(config, 'publicCapsule', task.interfacePath)
    : null;
  const oracle = capsuleItem(config, 'oracleCapsule', task.oraclePath);
  const reference = capsuleItem(config, 'referenceCapsule', task.referencePath);
  const parsed = parseCaseSet(oracle?.content);
  const parsedInterface = isExecutableCanaryV2(config)
    ? parseInterfaceContract(interfaceArtifact?.content)
    : { ok: true, errors: [], record: null };
  const interfaceCoverage = isExecutableCanaryV2(config)
    && parsed.ok
    && parsedInterface.ok
    ? validateExecutableInterfaceCoverage(parsed.record, parsedInterface.record)
    : { ok: !isExecutableCanaryV2(config), errors: [] };
  return {
    source,
    spec,
    interfaceArtifact,
    interfaceContract: parsedInterface.record,
    interfaceContractValid: parsedInterface.ok,
    interfaceContractErrors: parsedInterface.errors,
    interfaceCoverage,
    oracle,
    reference,
    caseSet: parsed.record,
    caseSetValid: parsed.ok,
    caseSetErrors: parsed.errors
  };
}

function mechanismCompilationForTask(config, task) {
  if (!isExecutableCanaryV4(config)) return null;
  const materials = taskMaterials(config, task);
  const compile = (capsule) => compileMechanismCapsule({
    capsule,
    interfaceContract: materials.interfaceContract
  });
  const routed = compile(config.mechanismContext?.routedCapsule);
  const sham = compile(config.mechanismContext?.shamCapsule);
  const packet = (result) => result?.status === 'OK'
    ? result.compiledCapsule
    : null;
  const complete = (value, semantics) => value?.status === 'COMPILED'
    && value.treatmentSemantics === semantics
    && value.coverage?.eligible > 0
    && value.coverage?.compiled === value.coverage.eligible
    && value.coverage?.abstained === 0
    && value.coverage?.ratio === 1;
  const routedPacket = packet(routed);
  const shamPacket = packet(sham);
  return {
    routed: routedPacket,
    sham: shamPacket,
    routedComplete: complete(routedPacket, 'positive-transfer'),
    shamComplete: complete(shamPacket, 'irrelevant-control')
  };
}

function normalizedOutput(value) {
  return canonicalValue(value);
}

function scoreSandboxOutputs(caseSet, outputs, { diagnostics = false } = {}) {
  const byId = new Map(
    (Array.isArray(outputs) ? outputs : []).map((item) => [String(item?.id || ''), item])
  );
  const results = caseSet.cases.map((testCase) => {
    const observed = byId.get(testCase.id);
    const present = !!observed && Object.hasOwn(observed, 'output');
    const actual = present ? normalizedOutput(observed.output) : null;
    const decisionPass = present
      && actual?.decision === testCase.expected?.decision;
    const codePass = present
      && actual?.code === testCase.expected?.code;
    return {
      id: testCase.id,
      group: testCase.group,
      pass: present && deepEqual(actual, normalizedOutput(testCase.expected)),
      ...(diagnostics ? { decisionPass, codePass } : {}),
      actual
    };
  });
  const target = results.filter((item) => item.group === 'target');
  const control = results.filter((item) => item.group === 'control');
  const quality = (rows, field) => rows.length
    ? round(rows.filter((item) => item[field]).length / rows.length)
    : null;
  return {
    results,
    targetQuality: quality(target, 'pass'),
    controlQuality: quality(control, 'pass'),
    ...(diagnostics
      ? {
          decisionTargetQuality: quality(target, 'decisionPass'),
          decisionControlQuality: quality(control, 'decisionPass'),
          codeTargetQuality: quality(target, 'codePass'),
          codeControlQuality: quality(control, 'codePass')
        }
      : {})
  };
}

export function evaluateExecutableCandidate({
  source,
  caseSet,
  authority,
  taskId = 'task',
  diagnostics = false
} = {}) {
  const validatedAuthority = validateExecutableEvaluatorAuthority(authority);
  if (validatedAuthority.status !== 'OK') {
    return {
      instrumentValid: false,
      candidateExecuted: false,
      code: 'EVALUATOR_AUTHORITY_INVALID',
      errors: validatedAuthority.errors
    };
  }
  if (typeof source !== 'string'
      || !source.trim()
      || Buffer.byteLength(source) > authority.limits.maxBytes) {
    return {
      instrumentValid: true,
      candidateExecuted: false,
      code: 'CANDIDATE_SOURCE_INVALID',
      errors: ['candidate source is empty or exceeds the sealed byte limit'],
      targetQuality: 0,
      controlQuality: 0,
      ...(diagnostics
        ? {
            decisionTargetQuality: 0,
            decisionControlQuality: 0,
            codeTargetQuality: 0,
            codeControlQuality: 0
          }
        : {}),
      results: caseSet.cases.map((item) => ({
        id: item.id,
        group: item.group,
        pass: false,
        ...(diagnostics ? { decisionPass: false, codePass: false } : {}),
        actual: null
      }))
    };
  }
  const parsedCaseSet = parseCaseSet(canonicalJson(caseSet));
  if (!parsedCaseSet.ok) {
    return {
      instrumentValid: false,
      candidateExecuted: false,
      code: 'CASE_SET_INVALID',
      errors: parsedCaseSet.errors
    };
  }
  const capsuleDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'loop-factory-executable-canary-'))
  );
  const candidatePath = join(capsuleDir, 'candidate.mjs');
  const request = {
    inputs: caseSet.cases.map((item) => ({
      id: item.id,
      input: canonicalValue(item.input)
    }))
  };
  const args = [
    '-p',
    authority.sandbox.profile,
    authority.node.path,
    authority.permissions.nodeFlag,
    `--max-old-space-size=${authority.limits.heapMb}`,
    `--allow-fs-read=${capsuleDir}`,
    `--allow-fs-read=${authority.bootstrap.path}`,
    authority.bootstrap.path,
    candidatePath,
    caseSet.exportName
  ];
  let result;
  try {
    writeFileSync(candidatePath, source, { encoding: 'utf8', flag: 'wx' });
    result = spawnSync(authority.sandbox.path, args, {
      input: canonicalJson(request),
      encoding: 'utf8',
      timeout: authority.limits.timeoutMs,
      maxBuffer: authority.limits.maxBufferBytes,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        NODE_NO_WARNINGS: '1'
      },
      windowsHide: true
    });
  } finally {
    rmSync(capsuleDir, { recursive: true, force: true });
  }
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const instrumentFailure = result.error?.code === 'ENOENT'
    || result.error?.code === 'EACCES';
  if (instrumentFailure) {
    return {
      instrumentValid: false,
      candidateExecuted: false,
      code: 'SANDBOX_LAUNCH_FAILED',
      errors: [result.error.message],
      sandbox: {
        path: authority.sandbox.path,
        argv: args,
        profileSha256: authority.sandbox.profileSha256,
        capsuleDir,
        candidatePath,
        taskId
      },
      stdout,
      stderr,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr)
    };
  }
  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    payload = null;
  }
  const outputRows = Array.isArray(payload?.outputs) ? payload.outputs : [];
  const ids = outputRows.map((item) => String(item?.id || ''));
  const expectedIds = caseSet.cases.map((item) => item.id);
  const outputShapeValid = result.status === 0
    && deepEqual(ids, expectedIds)
    && outputRows.every((item) => Object.hasOwn(object(item), 'output'));
  const scored = outputShapeValid
    ? scoreSandboxOutputs(caseSet, outputRows, { diagnostics })
    : {
        results: caseSet.cases.map((item) => ({
          id: item.id,
          group: item.group,
          pass: false,
          ...(diagnostics ? { decisionPass: false, codePass: false } : {}),
          actual: null
        })),
        targetQuality: 0,
        controlQuality: 0,
        ...(diagnostics
          ? {
              decisionTargetQuality: 0,
              decisionControlQuality: 0,
              codeTargetQuality: 0,
              codeControlQuality: 0
            }
          : {})
      };
  return {
    instrumentValid: true,
    candidateExecuted: result.status === 0,
    code: outputShapeValid ? 'EXECUTED' : (
      result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'
        ? 'CANDIDATE_TIMEOUT'
        : 'CANDIDATE_FAILED'
    ),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    outputShapeValid,
    targetQuality: scored.targetQuality,
    controlQuality: scored.controlQuality,
    ...(diagnostics
      ? {
          decisionTargetQuality: scored.decisionTargetQuality,
          decisionControlQuality: scored.decisionControlQuality,
          codeTargetQuality: scored.codeTargetQuality,
          codeControlQuality: scored.codeControlQuality
        }
      : {}),
    results: scored.results,
    sandbox: {
      path: authority.sandbox.path,
      argv: args,
      profileSha256: authority.sandbox.profileSha256,
      capsuleDir,
      candidatePath,
      taskId
    },
    stdout,
    stderr,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr)
  };
}

export function computeExecutableCanaryPreflight(config = {}) {
  const authority = validateExecutableEvaluatorAuthority(config.evaluatorAuthority);
  if (authority.status !== 'OK') {
    return {
      status: 'BLOCKED',
      code: 'EVALUATOR_AUTHORITY_INVALID',
      errors: authority.errors,
      tasks: []
    };
  }
  const tasks = [];
  const errors = [];
  for (const task of Array.isArray(config.tasks) ? config.tasks : []) {
    const materials = taskMaterials(config, task);
    const v2 = isExecutableCanaryV2(config);
    const v4 = isExecutableCanaryV4(config);
    const compilation = v4 ? mechanismCompilationForTask(config, task) : null;
    if (!materials.source
        || !materials.reference
        || !materials.caseSetValid
        || (v2 && (
          !materials.interfaceArtifact
          || !materials.interfaceContractValid
          || !materials.interfaceCoverage.ok
        ))) {
      errors.push(`${task.id || '<missing>'}: task materials are incomplete`);
      continue;
    }
    const baseline = evaluateExecutableCandidate({
      source: materials.source.content,
      caseSet: materials.caseSet,
      authority: config.evaluatorAuthority,
      taskId: `${task.id}-baseline-preflight`,
      diagnostics: v2
    });
    const reference = evaluateExecutableCandidate({
      source: materials.reference.content,
      caseSet: materials.caseSet,
      authority: config.evaluatorAuthority,
      taskId: `${task.id}-reference-preflight`,
      diagnostics: v2
    });
    const pass = baseline.instrumentValid
      && reference.instrumentValid
      && baseline.controlQuality === 1
      && baseline.targetQuality < 1
      && reference.controlQuality === 1
      && reference.targetQuality === 1
      && (!v4 || (
        compilation?.routedComplete === true
        && compilation?.shamComplete === true
      ));
    if (!pass) errors.push(`${task.id}: baseline/reference preflight failed`);
    tasks.push({
      taskId: task.id,
      phase: task.phase,
      sourceSha256: materials.source.sha256,
      ...(v2
        ? {
            interfaceSha256: materials.interfaceArtifact.sha256,
            interfaceCoverageSha256: materials.interfaceCoverage.sha256
          }
        : {}),
      ...(v4
        ? {
            mechanismCompilerVersion: MECHANISM_COMPILER_VERSION,
            routedCompilationSha256: compilation?.routed?.packetSha256 || null,
            shamCompilationSha256: compilation?.sham?.packetSha256 || null,
            routedCompileCoverage: compilation?.routed?.coverage?.ratio ?? null,
            shamCompileCoverage: compilation?.sham?.coverage?.ratio ?? null
          }
        : {}),
      oracleSha256: materials.oracle.sha256,
      referenceSha256: materials.reference.sha256,
      baseline: {
        code: baseline.code,
        targetQuality: baseline.targetQuality,
        controlQuality: baseline.controlQuality,
        ...(v2
          ? {
              decisionTargetQuality: baseline.decisionTargetQuality,
              decisionControlQuality: baseline.decisionControlQuality,
              codeTargetQuality: baseline.codeTargetQuality,
              codeControlQuality: baseline.codeControlQuality
            }
          : {}),
        stdoutSha256: baseline.stdoutSha256 || null,
        stderrSha256: baseline.stderrSha256 || null
      },
      reference: {
        code: reference.code,
        targetQuality: reference.targetQuality,
        controlQuality: reference.controlQuality,
        ...(v2
          ? {
              decisionTargetQuality: reference.decisionTargetQuality,
              decisionControlQuality: reference.decisionControlQuality,
              codeTargetQuality: reference.codeTargetQuality,
              codeControlQuality: reference.codeControlQuality
            }
          : {}),
        stdoutSha256: reference.stdoutSha256 || null,
        stderrSha256: reference.stderrSha256 || null
      },
      pass
    });
  }
  const basis = {
    schemaVersion: 1,
    tasks
  };
  return {
    ...basis,
    status: errors.length ? 'BLOCKED' : 'PASS',
    code: errors.length ? 'PREFLIGHT_FAILED' : null,
    errors,
    sha256: sha256(canonicalJson(basis))
  };
}

function taskPlanIdentity(config, task) {
  const materials = taskMaterials(config, task);
  const v2 = isExecutableCanaryV2(config);
  const compilation = isExecutableCanaryV4(config)
    ? mechanismCompilationForTask(config, task)
    : null;
  return {
    id: task.id,
    phase: task.phase,
    findingId: task.findingId,
    title: task.title,
    sourcePath: task.sourcePath,
    sourceSha256: materials.source?.sha256 || null,
    specPath: task.specPath,
    specSha256: materials.spec?.sha256 || null,
    ...(v2
      ? {
          interfacePath: task.interfacePath,
          interfaceSha256: materials.interfaceArtifact?.sha256 || null,
          interfaceCoverageSha256: materials.interfaceCoverage?.sha256 || null
        }
      : {}),
    ...(compilation
      ? {
          mechanismCompilerVersion: MECHANISM_COMPILER_VERSION,
          routedCompilationSha256: compilation.routed?.packetSha256 || null,
          shamCompilationSha256: compilation.sham?.packetSha256 || null,
          routedCompileCoverage: compilation.routed?.coverage?.ratio ?? null,
          shamCompileCoverage: compilation.sham?.coverage?.ratio ?? null
        }
      : {}),
    oraclePath: task.oraclePath,
    oracleSha256: materials.oracle?.sha256 || null,
    referencePath: task.referencePath,
    referenceSha256: materials.reference?.sha256 || null,
    outputFile: task.outputFile,
    exportName: task.exportName,
    hypothesisSha256: sha256(canonicalJson(object(task.hypothesis))),
    originRefs: (Array.isArray(task.originRefs) ? task.originRefs : [])
      .map((item) => ({
        path: item?.path || null,
        locator: item?.locator || null
      }))
  };
}

function mechanismPlanIdentity(context = {}) {
  return {
    familyIds: (context.families || []).map((item) => item.familyId).sort(),
    applicationReceiptIds: (context.applications || [])
      .map((item) => item.applicationReceiptId)
      .sort(),
    policyEpochSha256: context.policyEpoch?.policyEpochSha256 || null,
    routingDecisionSha256: context.routingDecision?.routingDecisionSha256 || null,
    candidatePoolSha256: context.routingDecision?.candidatePoolSha256 || null,
    routedCapsuleSha256: context.routedCapsule?.mechanismCapsuleSha256 || null,
    shamCapsuleSha256: context.shamCapsule?.mechanismCapsuleSha256 || null,
    primaryFamilyId: context.primaryFamilyId || null
  };
}

export function buildAdaptiveExecutableCanaryPlan(config = {}) {
  const tasks = (Array.isArray(config.tasks) ? config.tasks : [])
    .map((task) => taskPlanIdentity(config, task));
  const mechanism = mechanismPlanIdentity(object(config.mechanismContext));
  const blindSeed = sha256(canonicalJson({ tasks, mechanism }));
  const blindLabels = Object.fromEntries(
    ADAPTIVE_EXECUTABLE_CANARY.arms.map((arm) => [
      arm,
      `arm-${sha256(`${blindSeed}:${arm}`).slice(0, 12)}`
    ])
  );
  const qualificationTasks = tasks.filter((task) => task.phase === 'qualification');
  const confirmationTasks = tasks.filter((task) => task.phase === 'confirmation');
  const qualificationSchedule = qualificationTasks.map((task, index) => ({
    stage: 'qualification',
    taskId: task.id,
    armRole: 'baseline',
    blindArm: blindLabels.baseline,
    taskIndex: index,
    position: 0
  }));
  const confirmationSchedule = confirmationTasks.flatMap((task, taskIndex) => (
    ADAPTIVE_EXECUTABLE_CONFIRMATION_SCHEDULE[taskIndex]
      .map((armRole, position) => ({
        stage: 'confirmation',
        taskId: task.id,
        armRole,
        blindArm: blindLabels[armRole],
        taskIndex,
        position
      }))
  ));
  const basis = {
    schemaVersion: 1,
    profile: config.schemaVersion || ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION,
    model: REAL_TEST_MODEL,
    fixtureOnly: config.fixtureOnly === true,
    ...(Object.hasOwn(config, 'adaptiveMemoryImportEnabled')
      ? { adaptiveMemoryImportEnabled: config.adaptiveMemoryImportEnabled === true }
      : {}),
    tasks,
    publicManifest: config.publicManifest || [],
    oracleManifest: config.oracleManifest || [],
    referenceManifest: config.referenceManifest || [],
    provenanceManifest: config.provenanceManifest || [],
    mechanismEvidenceManifest: config.mechanismEvidenceManifest || [],
    implementationManifest: config.implementationManifest || [],
    runtimeAuthority: object(config.runtimeAuthority),
    evaluatorAuthority: object(config.evaluatorAuthority),
    preflight: object(config.preflight),
    mechanism,
    routes: Array.isArray(config.routes) ? [...config.routes] : [],
    contract: {
      ...ADAPTIVE_EXECUTABLE_CANARY,
      arms: [...ADAPTIVE_EXECUTABLE_CANARY.arms],
      ...(usesFullRepairEndpoint(config.schemaVersion)
        ? { repairFailureMetric: 'full-repair' }
        : {}),
      ...(isExecutableCanaryV4(config)
        ? {
            mechanismCompilerVersion: MECHANISM_COMPILER_VERSION,
            regressionMetric: 'paired-target-and-control-quality'
          }
        : {}),
      blindLabels,
      qualificationSchedule,
      confirmationSchedule,
      executionSchedule: [...qualificationSchedule, ...confirmationSchedule]
    }
  };
  return {
    ...basis,
    sha256: sha256(canonicalJson(basis))
  };
}

function validateOriginRef(ref, provenanceMap) {
  const path = String(ref?.path || '');
  const locator = String(ref?.locator || '');
  return !!path
    && !!locator
    && provenanceMap.has(path)
    && provenanceMap.get(path).content.includes(locator);
}

export function validateAdaptiveExecutableCanaryConfig(config = {}, {
  requireApproval = true
} = {}) {
  const errors = [];
  const v2 = isExecutableCanaryV2(config);
  const v4 = isExecutableCanaryV4(config);
  if (!EXECUTABLE_CANARY_SCHEMA_VERSIONS.has(config.schemaVersion)) {
    errors.push(
      `schemaVersion must be ${ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION}, ${ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2}, ${ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3}, or ${ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4}`
    );
  }
  if (config.model !== REAL_TEST_MODEL) {
    errors.push(`model must be ${REAL_TEST_MODEL}`);
  }
  if (typeof config.fixtureOnly !== 'boolean') {
    errors.push('fixtureOnly must explicitly state whether evidence is real');
  }
  if (Object.hasOwn(config, 'adaptiveMemoryImportEnabled')
      && typeof config.adaptiveMemoryImportEnabled !== 'boolean') {
    errors.push('adaptiveMemoryImportEnabled must be boolean when declared');
  }
  if (config.historicalTokenEstimate != null
      && (!Number.isInteger(config.historicalTokenEstimate)
        || config.historicalTokenEstimate <= 0)) {
    errors.push('historicalTokenEstimate must be a positive non-binding integer');
  }
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const expectedRoutes = ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks
    + ADAPTIVE_EXECUTABLE_CANARY.confirmationTasks;
  if (routes.length !== expectedRoutes
      || routes.some((route) => route !== REAL_TEST_MODEL)) {
    errors.push(`routes must contain exactly ${expectedRoutes} ${REAL_TEST_MODEL} entries`);
  }

  const publicMap = capsuleMap(config, {
    sourcesField: 'publicSources',
    manifestField: 'publicManifest',
    capsuleField: 'publicCapsule',
    label: 'public',
    errors
  });
  const oracleMap = capsuleMap(config, {
    sourcesField: 'oracleSources',
    manifestField: 'oracleManifest',
    capsuleField: 'oracleCapsule',
    label: 'oracle',
    errors
  });
  const referenceMap = capsuleMap(config, {
    sourcesField: 'referenceSources',
    manifestField: 'referenceManifest',
    capsuleField: 'referenceCapsule',
    label: 'reference',
    errors
  });
  const provenanceMap = capsuleMap(config, {
    sourcesField: 'provenanceSources',
    manifestField: 'provenanceManifest',
    capsuleField: 'provenanceCapsule',
    label: 'provenance',
    errors
  });
  const mechanismEvidenceMap = capsuleMap(config, {
    sourcesField: 'mechanismEvidenceSources',
    manifestField: 'mechanismEvidenceManifest',
    capsuleField: 'mechanismEvidenceCapsule',
    label: 'mechanism evidence',
    errors
  });
  const partitionMaps = [
    ['public', publicMap],
    ['oracle', oracleMap],
    ['reference', referenceMap],
    ['provenance', provenanceMap],
    ['mechanism evidence', mechanismEvidenceMap]
  ];
  for (let left = 0; left < partitionMaps.length; left++) {
    for (let right = left + 1; right < partitionMaps.length; right++) {
      const [leftName, leftMap] = partitionMaps[left];
      const [rightName, rightMap] = partitionMaps[right];
      const leftPaths = new Set(leftMap.keys());
      const leftHashes = new Set([...leftMap.values()].map((item) => item.sha256));
      if ([...rightMap.keys()].some((path) => leftPaths.has(path))) {
        errors.push(`${leftName} and ${rightName} partitions share a path`);
      }
      if ([...rightMap.values()].some((item) => leftHashes.has(item.sha256))) {
        errors.push(`${leftName} and ${rightName} partitions share content`);
      }
    }
  }

  const tasks = Array.isArray(config.tasks) ? config.tasks : [];
  if (tasks.length !== expectedRoutes) {
    errors.push(`tasks must contain ${expectedRoutes} entries`);
  }
  const taskIds = tasks.map((task) => String(task?.id || ''));
  const findingIds = tasks.map((task) => String(task?.findingId || ''));
  if (taskIds.some((id) => !isSafeId(id))
      || new Set(taskIds).size !== taskIds.length) {
    errors.push('task IDs must be unique safe identifiers');
  }
  if (findingIds.some((id) => !/^finding-\d{3}$/.test(id))
      || new Set(findingIds).size !== findingIds.length) {
    errors.push('finding IDs must be unique finding-NNN identifiers');
  }
  const qualification = tasks.filter((task) => task.phase === 'qualification');
  const confirmation = tasks.filter((task) => task.phase === 'confirmation');
  if (qualification.length !== ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks
      || confirmation.length !== ADAPTIVE_EXECUTABLE_CANARY.confirmationTasks
      || tasks.some((task) => !TASK_PHASES.has(task.phase))) {
    errors.push('tasks must contain five qualification and five confirmation shards');
  }
  const usedMaterialPaths = new Set();
  for (const task of tasks) {
    const materials = taskMaterials(config, task);
    const materialFields = [
      ['sourcePath', publicMap],
      ['specPath', publicMap],
      ['oraclePath', oracleMap],
      ['referencePath', referenceMap]
    ];
    if (v2) materialFields.splice(2, 0, ['interfacePath', publicMap]);
    for (const [field, map] of materialFields) {
      const path = String(task?.[field] || '');
      if (!map.has(path)) errors.push(`${task.id}: ${field} does not resolve`);
      const key = `${field}:${path}`;
      if (usedMaterialPaths.has(key)) errors.push(`${task.id}: ${field} is reused`);
      usedMaterialPaths.add(key);
    }
    if (task.outputFile !== 'candidate.mjs') {
      errors.push(`${task.id}: outputFile must be candidate.mjs`);
    }
    if (!materials.caseSetValid
        || materials.caseSet?.exportName !== task.exportName) {
      errors.push(`${task.id}: case set or export name is invalid`);
    }
    if (v2 && (
      !materials.interfaceContractValid
      || materials.interfaceContract?.exportName !== task.exportName
      || !materials.interfaceCoverage.ok
    )) {
      errors.push(
        `${task.id}: visible interface contract is invalid or does not cover the hidden oracle vocabulary`
      );
    }
    if (v4) {
      if (materials.interfaceContract?.schemaVersion
          !== EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2) {
        errors.push(`${task.id}: V4 requires executable interface contract v2`);
      }
      const compilation = mechanismCompilationForTask(config, task);
      if (compilation?.routedComplete !== true) {
        errors.push(`${task.id}: routed mechanism compile coverage is incomplete`);
      }
      if (compilation?.shamComplete !== true) {
        errors.push(`${task.id}: sham mechanism compile coverage is incomplete`);
      }
      if (compilation?.routedComplete === true
          && compilation?.shamComplete === true
          && capsuleSchemaSha256(compilation.routed)
            !== capsuleSchemaSha256(compilation.sham)) {
        errors.push(`${task.id}: compiled routed and sham treatment schemas differ`);
      }
    }
    if (typeof materials.source?.content !== 'string'
        || Buffer.byteLength(materials.source.content) < 240
        || Buffer.byteLength(materials.source.content)
          > ADAPTIVE_EXECUTABLE_CANARY.candidateMaxBytes) {
      errors.push(`${task.id}: source is too small or exceeds the candidate limit`);
    }
    if (typeof materials.reference?.content !== 'string'
        || materials.reference.content === materials.source?.content
        || Buffer.byteLength(materials.reference.content)
          > ADAPTIVE_EXECUTABLE_CANARY.candidateMaxBytes) {
      errors.push(`${task.id}: reference repair is missing, unchanged, or too large`);
    }
    if (typeof materials.spec?.content !== 'string'
        || Buffer.byteLength(materials.spec.content) < 160) {
      errors.push(`${task.id}: incident report is too shallow`);
    }
    const originRefs = Array.isArray(task.originRefs) ? task.originRefs : [];
    if (!originRefs.length
        || originRefs.some((ref) => !validateOriginRef(ref, provenanceMap))) {
      errors.push(`${task.id}: repository provenance does not resolve`);
    }
    const hypothesis = object(task.hypothesis);
    if (['title', 'bottleneck', 'operation', 'expectedMovement', 'falsifier']
      .some((field) => String(hypothesis[field] || '').trim().length < 12)) {
      errors.push(`${task.id}: repair hypothesis is incomplete`);
    }
  }

  const mechanismRefs = Array.isArray(config.mechanismEvidenceRefs)
    ? config.mechanismEvidenceRefs
    : [];
  if (!mechanismRefs.length
      || mechanismRefs.some((ref) => !validateOriginRef(ref, mechanismEvidenceMap))) {
    errors.push('mechanism evidence references do not resolve');
  }
  const mechanism = inspectMechanismContext(config, errors);
  const implementationErrorsBefore = errors.length;
  const implementation = inspectImplementation(config, errors);
  implementation.ok = errors.length === implementationErrorsBefore;
  const runtimeAuthority = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtimeAuthority.status !== 'OK'
      || runtimeAuthority.record.requestedModel !== REAL_TEST_MODEL
      || runtimeAuthority.record.reasoningEffort !== STRICT_CODEX_REASONING_EFFORT) {
    errors.push('runtime authority must bind ChatGPT OAuth, exact Sol, and high reasoning');
  }
  if (v2 && (
    runtimeAuthority.status !== 'OK'
    || !codexVersionAtLeast(
      runtimeAuthority.record.binary?.version,
      ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION
    )
  )) {
    const profile = isExecutableCanaryV4(config)
      ? 'v4'
      : (isExecutableCanaryV3(config) ? 'v3' : 'v2');
    errors.push(
      `executable canary ${profile} requires Codex CLI ${ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION} or newer`
    );
  }
  const evaluatorAuthority =
    validateExecutableEvaluatorAuthority(config.evaluatorAuthority);
  if (evaluatorAuthority.status !== 'OK') {
    errors.push(...evaluatorAuthority.errors);
  }

  const recomputedPreflight = tasks.length === expectedRoutes
    && evaluatorAuthority.status === 'OK'
    ? computeExecutableCanaryPreflight(config)
    : null;
  if (!recomputedPreflight
      || recomputedPreflight.status !== 'PASS'
      || config.preflight?.status !== 'PASS'
      || canonicalJson(recomputedPreflight) !== canonicalJson(config.preflight)) {
    errors.push('sealed local instrument preflight does not rederive');
  }
  const plan = buildAdaptiveExecutableCanaryPlan(config);
  if (requireApproval && config.approvedPlanSha256 !== plan.sha256) {
    errors.push('executable canary plan is not operator-approved');
  }
  if (/\[(?:OPERATOR|REPLACE|REAL_|CASE_|EXPECTED)|PLACEHOLDER|TODO/i.test(
    canonicalJson({ tasks })
  )) {
    errors.push('task configuration contains unresolved placeholders');
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    plan,
    mechanism,
    implementation,
    runtimeAuthority,
    evaluatorAuthority,
    preflight: recomputedPreflight
  };
}

export function prepareAdaptiveExecutableCanaryConfig(raw = {}, {
  packageRoot = PACKAGE_ROOT,
  codexBinaryPath = process.env.SUPER_LOOP_CODEX_BIN,
  approvedPlanSha256 = null
} = {}) {
  const resolutions = {
    public: resolveEvidenceCapsule(packageRoot, raw.publicSources),
    oracle: resolveEvidenceCapsule(packageRoot, raw.oracleSources),
    reference: resolveEvidenceCapsule(packageRoot, raw.referenceSources),
    provenance: resolveEvidenceCapsule(packageRoot, raw.provenanceSources),
    mechanismEvidence: resolveEvidenceCapsule(
      packageRoot,
      raw.mechanismEvidenceSources
    ),
    implementation: resolveAdaptiveExecutableCanaryImplementation(
      packageRoot,
      raw.schemaVersion
    )
  };
  const runtimeAuthority = captureCodexOAuthAuthority({
    binaryPath: codexBinaryPath,
    requestedModel: raw.model,
    reasoningEffort: STRICT_CODEX_REASONING_EFFORT
  });
  const evaluatorAuthority = captureExecutableEvaluatorAuthority();
  const errors = [];
  for (const [name, resolution] of Object.entries(resolutions)) {
    if (!resolution.ok) {
      errors.push(...resolution.errors.map((error) => `${name}: ${error}`));
    }
  }
  if (runtimeAuthority.status !== 'OK') {
    errors.push(`${runtimeAuthority.code}: ${runtimeAuthority.message}`);
  }
  if (evaluatorAuthority.status !== 'OK') {
    errors.push(`${evaluatorAuthority.code}: ${evaluatorAuthority.message}`);
  }
  if (errors.length) {
    return { status: 'BLOCKED', errors, config: null };
  }
  const configWithoutPreflight = {
    ...raw,
    publicManifest: resolutions.public.manifest,
    publicCapsule: resolutions.public.capsule,
    oracleManifest: resolutions.oracle.manifest,
    oracleCapsule: resolutions.oracle.capsule,
    referenceManifest: resolutions.reference.manifest,
    referenceCapsule: resolutions.reference.capsule,
    provenanceManifest: resolutions.provenance.manifest,
    provenanceCapsule: resolutions.provenance.capsule,
    mechanismEvidenceManifest: resolutions.mechanismEvidence.manifest,
    mechanismEvidenceCapsule: resolutions.mechanismEvidence.capsule,
    implementationManifest: resolutions.implementation.manifest,
    implementationCapsule: resolutions.implementation.capsule,
    runtimeAuthority: runtimeAuthority.record,
    evaluatorAuthority: evaluatorAuthority.record,
    approvedPlanSha256
  };
  const preflight = computeExecutableCanaryPreflight(configWithoutPreflight);
  return {
    status: preflight.status === 'PASS' ? 'OK' : 'BLOCKED',
    errors: preflight.errors || [],
    config: {
      ...configWithoutPreflight,
      preflight
    },
    resolutions
  };
}

function proposalMechanism(config, armRole, task = null) {
  if (isExecutableCanaryV4(config)) {
    if (armRole === 'baseline' || !task) return null;
    const compilation = mechanismCompilationForTask(config, task);
    return armRole === 'routed' ? compilation?.routed : compilation?.sham;
  }
  if (armRole === 'routed') return config.mechanismContext.routedCapsule;
  if (armRole === 'sham') return config.mechanismContext.shamCapsule;
  return null;
}

function treatmentPacketSha256(value) {
  return value?.packetSha256 || value?.mechanismCapsuleSha256 || null;
}

function taskPublicCapsule(config, task) {
  return [
    capsuleItem(config, 'publicCapsule', task.sourcePath),
    capsuleItem(config, 'publicCapsule', task.specPath),
    ...(isExecutableCanaryV2(config)
      ? [capsuleItem(config, 'publicCapsule', task.interfacePath)]
      : [])
  ].filter(Boolean).map((item) => ({ ...item }));
}

function repairHypothesis(task) {
  return {
    id: `${task.findingId}-executable-h1`,
    ...object(task.hypothesis)
  };
}

function buildRepairContract(config, task, route, armRole) {
  const materials = taskMaterials(config, task);
  const v2 = isExecutableCanaryV2(config);
  const v4 = isExecutableCanaryV4(config);
  const target = {
    findingId: task.findingId,
    title: task.title,
    baselineArtifactId: task.sourcePath,
    baselineSha256: materials.source.sha256,
    baselineContent: materials.source.content,
    ...(v2
      ? {
          interfaceArtifactId: task.interfacePath,
          interfaceSha256: materials.interfaceArtifact.sha256
        }
      : {}),
    evidenceRefs: [{
      path: task.specPath,
      locator: 'Complete sealed incident report'
    }]
  };
  return {
    loopId: 'executable-causal-repair',
    loopSha: sha256(v4
      ? 'executable-causal-repair-v4'
      : (v2 ? 'executable-causal-repair-v2' : 'executable-causal-repair-v1')),
    phase: 0,
    phaseTitle: 'Repair one visible module',
    slice: 'Repair the supplied module against the visible incident while preserving unrelated behavior.',
    sliceSha: sha256(
      'Repair the supplied module against the visible incident while preserving unrelated behavior.'
    ),
    totalPhases: 1,
    kind: 'proposal',
    route,
    task: task.title,
    requirements: [
      `Return the complete replacement for ${task.outputFile}.`,
      `The module must export function ${task.exportName}.`,
      'Preserve behavior outside the visible incident boundary.',
      ...(v2
        ? [
            'Treat the visible interface contract as authoritative for field names and output codes.',
            'Use only the supplied module, incident report, interface contract, and optional prior mechanism.'
          ]
        : [
            'Use only the supplied module, incident report, and optional prior mechanism.'
          ]),
      ...(v4
        ? [
            'Treat compiled role bindings and the closed-world acceptance predicate as authoritative; do not infer undeclared identity equalities.',
            'Preserve ordered rules and every explicit exception when the compiled mechanism applies.'
          ]
        : []),
      'Do not add verification claims or operational status.'
    ],
    target,
    hypothesis: repairHypothesis(task),
    mechanismCapsule: proposalMechanism(config, armRole, task),
    ...(v4 ? { mechanismCompilerVersion: MECHANISM_COMPILER_VERSION } : {}),
    proposalTreatmentInstruction:
      'Repair the visible incident. Use the optional prior mechanism only when it is applicable to the supplied source and incident.',
    frozenCases: [],
    evidenceCapsule: taskPublicCapsule(config, task),
    evaluationArm: null,
    procedureContent: null,
    procedureSha256: null,
    toolPolicy: 'none',
    phaseRequired: true,
    requires: ['runlog'],
    mustProduceComparableOutput: true,
    evidenceRequired: true,
    outputSchemaMode: true
  };
}

export function buildAdaptiveExecutableCanaryPrompt(contract = {}) {
  const target = object(contract.target);
  const hypothesis = object(contract.hypothesis);
  const source = (contract.evidenceCapsule || [])
    .find((item) => item.path === target.baselineArtifactId);
  const incident = (contract.evidenceCapsule || [])
    .find((item) => item.path === target.evidenceRefs?.[0]?.path);
  const interfaceArtifact = target.interfaceArtifactId
    ? (contract.evidenceCapsule || [])
      .find((item) => item.path === target.interfaceArtifactId)
    : null;
  const mechanism = contract.mechanismCapsule
    ? JSON.stringify(canonicalValue(contract.mechanismCapsule), null, 2)
    : 'NONE';
  const required = {
    findingId: target.findingId,
    hypothesisId: hypothesis.id,
    baselineSha256: target.baselineSha256,
    revisedContent: 'complete replacement ECMAScript module source',
    changeSummary: 'brief description of the concrete repair'
  };
  return [
    'ROLE',
    'You are repairing one isolated JavaScript module for a production controller.',
    '',
    'VISIBLE TASK',
    String(contract.task || ''),
    '',
    'CURRENT MODULE',
    `Path: ${source?.path || target.baselineArtifactId || 'candidate.mjs'}`,
    `SHA-256: ${source?.sha256 || target.baselineSha256 || ''}`,
    String(source?.content || target.baselineContent || ''),
    '',
    'VISIBLE INCIDENT REPORT',
    `Path: ${incident?.path || 'incident.md'}`,
    String(incident?.content || ''),
    ...(interfaceArtifact
      ? [
          '',
          'VISIBLE INTERFACE CONTRACT',
          `Path: ${interfaceArtifact.path}`,
          `SHA-256: ${interfaceArtifact.sha256}`,
          String(interfaceArtifact.content || '')
        ]
      : []),
    '',
    contract.mechanismCompilerVersion === MECHANISM_COMPILER_VERSION
      ? 'OPTIONAL COMPILED PRIOR IMPROVEMENT MECHANISM'
      : 'OPTIONAL PRIOR IMPROVEMENT MECHANISM',
    mechanism,
    '',
    'REPAIR INTENT',
    JSON.stringify({
      title: hypothesis.title,
      bottleneck: hypothesis.bottleneck,
      operation: hypothesis.operation,
      expectedMovement: hypothesis.expectedMovement,
      falsifier: hypothesis.falsifier
    }, null, 2),
    '',
    'DELIVERABLE',
    '- Return one JSON object and nothing else.',
    `- Match this exact shape: ${JSON.stringify(required)}`,
    `- findingId must be ${target.findingId}.`,
    `- hypothesisId must be ${hypothesis.id}.`,
    `- baselineSha256 must be ${target.baselineSha256}.`,
    '- revisedContent must be the complete replacement module, not a diff or fenced block.',
    '- changeSummary must identify the concrete source-level repair.',
    '',
    'CONSTRAINTS',
    ...(contract.requirements || []).map((item) => `- ${item}`),
    '- Work only from the material printed here.',
    '- Do not use tools, files, browsing, memory, subagents, or external context.',
    '- Return only the requested repair record without process commentary.',
    '- Finish in one response.'
  ].join('\n');
}

export function adaptiveExecutableCanaryWorker(contract, env = process.env) {
  const prompt = buildAdaptiveExecutableCanaryPrompt(contract);
  const result = runWorker({
    model: contract.route,
    prompt,
    env,
    executionContract: contract
  });
  if (!result.ok) {
    return {
      route: contract.route,
      phase: contract.phase,
      __execReason: result.reason,
      artifacts: result.stdout
        ? [{ role: 'runlog', content: result.stdout }]
        : [],
      executorOwned: true,
      rawStdout: result.stdout || '',
      rawStderr: result.stderr || '',
      finalOutput: '',
      realTokenUsage: result.tokenUsage,
      isolation: result.isolation,
      invocation: result.invocation
    };
  }
  const finalOutput = normalizeStructuredWorkerOutput(
    contract,
    result.resultText
  );
  if (!finalOutput) {
    return {
      route: contract.route,
      phase: contract.phase,
      __execReason: 'OUTPUT_SCHEMA_INVALID',
      artifacts: [{ role: 'runlog', content: result.stdout }],
      executorOwned: true,
      rawStdout: result.stdout,
      rawStderr: result.stderr || '',
      finalOutput: '',
      realTokenUsage: result.tokenUsage,
      isolation: result.isolation,
      invocation: result.invocation
    };
  }
  const invocation = {
    ...result.invocation,
    rawResultSha256: result.invocation.resultSha256,
    resultSha256: sha256(finalOutput),
    resultNormalization: 'json-schema-v1'
  };
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: result.stdout }],
    executorOwned: true,
    rawStdout: result.stdout,
    rawStderr: result.stderr || '',
    finalOutput,
    realTokenUsage: result.tokenUsage,
    isolation: result.isolation,
    invocation
  };
}

function invocationMatchesRuntimeAuthority(config, invocation, {
  requireSuccess = true
} = {}) {
  const validated = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (validated.status !== 'OK' || !invocation || typeof invocation !== 'object') {
    return false;
  }
  const authority = validated.record;
  const argv = Array.isArray(invocation.argv) ? invocation.argv.map(String) : [];
  const modelIndex = argv.indexOf('-m');
  const reported = invocation.reportedModel == null
    ? null
    : String(invocation.reportedModel).toLowerCase();
  return invocation.requestedModel === authority.requestedModel
    && invocation.binaryFamily === 'codex'
    && invocation.modelSelectionAuthority === 'explicit-model-flag'
    && invocation.executableBasename === authority.binary.basename
    && invocation.executableSha256 === authority.binary.sha256
    && invocation.executableBytes === authority.binary.bytes
    && invocation.authMode === 'chatgpt-oauth'
    && invocation.oauthAuthoritySha256 === authority.authoritySha256
    && modelIndex >= 0
    && argv[modelIndex + 1] === authority.requestedModel
    && (requireSuccess
      ? Number(invocation.exitCode) === 0
      : Number.isInteger(Number(invocation.exitCode)))
    && (reported == null || reported === authority.requestedModel.toLowerCase())
    && invocation.reportedModelMatchesRequest !== false;
}

function validateRepairPacket(contract, packet) {
  const reasons = [];
  const execReason = typeof packet?.__execReason === 'string'
    && packet.__execReason
    ? packet.__execReason
    : null;
  if (execReason) reasons.push(execReason);
  if (!packet
      || packet.executorOwned !== true
      || typeof packet.rawStdout !== 'string'
      || !packet.rawStdout
      || !packet.invocation
      || (!execReason && (
        typeof packet.finalOutput !== 'string'
        || !packet.finalOutput
      ))) {
    reasons.push('EXECUTOR_EVIDENCE_MISSING');
  }
  if (packet?.isolation?.status !== 'PASS'
      || (packet?.isolation?.toolCalls || []).length > 0) {
    reasons.push('ISOLATION_VIOLATION');
  }
  const parsed = execReason
    ? { ok: false, wrapper: null, payload: null }
    : parseCaseResults(packet?.finalOutput || '');
  if (!execReason && (!parsed.ok
      || parsed.wrapper !== 'IMPROVEMENT'
      || !parsed.payload)) {
    reasons.push('OUTPUT_SCHEMA_INVALID');
  } else if (!execReason) {
    const payload = parsed.payload;
    if (payload.findingId !== contract.target.findingId
        || payload.hypothesisId !== contract.hypothesis.id
        || payload.baselineSha256 !== contract.target.baselineSha256) {
      reasons.push('TARGET_UNBOUND');
    }
    if (typeof payload.revisedContent !== 'string'
        || !payload.revisedContent.trim()
        || payload.revisedContent.includes('\0')
        || typeof payload.changeSummary !== 'string'
        || !payload.changeSummary.trim()) {
      reasons.push('REPAIR_CONTENT_INVALID');
    }
  }
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    parsed
  };
}

function persistCallInputs(store, runId, prefix, contract) {
  const contractArtifact = writeCanaryArtifact(store, runId, `${prefix}-contract`, {
    role: 'worker-contract',
    content: canonicalJson(contract)
  });
  const prompt = buildAdaptiveExecutableCanaryPrompt(contract);
  const promptArtifact = writeCanaryArtifact(store, runId, `${prefix}-prompt`, {
    role: 'worker-prompt',
    content: prompt
  });
  return {
    contractArtifactRef: contractArtifact.id,
    contractSha256: contractArtifact.sha256,
    promptArtifactRef: promptArtifact.id,
    promptArtifactSha256: promptArtifact.sha256,
    promptSha256: sha256(prompt)
  };
}

function sandboxResultRecord(result) {
  const diagnostics = Object.hasOwn(result, 'decisionTargetQuality');
  return {
    instrumentValid: result.instrumentValid,
    candidateExecuted: result.candidateExecuted,
    code: result.code,
    exitCode: result.exitCode ?? null,
    signal: result.signal || null,
    timedOut: result.timedOut === true,
    outputShapeValid: result.outputShapeValid === true,
    targetQuality: result.targetQuality,
    controlQuality: result.controlQuality,
    ...(diagnostics
      ? {
          decisionTargetQuality: result.decisionTargetQuality,
          decisionControlQuality: result.decisionControlQuality,
          codeTargetQuality: result.codeTargetQuality,
          codeControlQuality: result.codeControlQuality
        }
      : {}),
    results: result.results,
    stdoutSha256: result.stdoutSha256 || sha256(''),
    stderrSha256: result.stderrSha256 || sha256(''),
    sandbox: {
      path: result.sandbox?.path || null,
      argv: Array.isArray(result.sandbox?.argv)
        ? result.sandbox.argv.map((value) => (
            value === result.sandbox?.candidatePath
              ? '<candidate-path>'
              : (value === result.sandbox?.capsuleDir
                  ? '<candidate-capsule>'
                  : String(value).replace(
                      String(result.sandbox?.capsuleDir || ''),
                      '<candidate-capsule>'
                    ))
          ))
        : [],
      profileSha256: result.sandbox?.profileSha256 || null
    }
  };
}

function persistSandboxEvaluation(store, runId, prefix, source, result) {
  const candidate = writeCanaryArtifact(store, runId, `${prefix}-candidate`, {
    role: 'candidate-source',
    content: source
  });
  const stdout = writeCanaryArtifact(store, runId, `${prefix}-sandbox-stdout`, {
    role: 'sandbox-stdout',
    content: result.stdout || ''
  });
  const stderr = writeCanaryArtifact(store, runId, `${prefix}-sandbox-stderr`, {
    role: 'sandbox-stderr',
    content: result.stderr || ''
  });
  const record = sandboxResultRecord(result);
  const evaluation = writeCanaryArtifact(store, runId, `${prefix}-evaluation`, {
    role: 'deterministic-evaluation',
    content: canonicalJson(record),
    measurement: {
      targetQuality: record.targetQuality,
      controlQuality: record.controlQuality,
      ...(Object.hasOwn(record, 'decisionTargetQuality')
        ? {
            decisionTargetQuality: record.decisionTargetQuality,
            decisionControlQuality: record.decisionControlQuality,
            codeTargetQuality: record.codeTargetQuality,
            codeControlQuality: record.codeControlQuality
          }
        : {}),
      qualityAuthority: 'tool-computed',
      tokenCostAuthority: 'cli-reported'
    }
  });
  return {
    candidateArtifactRef: candidate.id,
    candidateSha256: candidate.sha256,
    sandboxStdoutArtifactRef: stdout.id,
    sandboxStdoutSha256: stdout.sha256,
    sandboxStderrArtifactRef: stderr.id,
    sandboxStderrSha256: stderr.sha256,
    evaluationArtifactRef: evaluation.id,
    evaluationSha256: evaluation.sha256,
    measurementRef: evaluation.id,
    evaluation: record
  };
}

function fullRepair(call) {
  return call?.targetQuality === 1 && call?.controlQuality === 1;
}

function usesFullRepairEndpoint(profile) {
  return profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3
    || profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4;
}

function qualificationFailure(call, profile) {
  return usesFullRepairEndpoint(profile)
    ? !fullRepair(call)
    : call?.targetQuality < 1;
}

function expectedQualificationStop(calls, profile) {
  let failures = 0;
  for (let index = 0; index < calls.length; index++) {
    if (qualificationFailure(calls[index], profile)) failures += 1;
    const remaining = ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks - index - 1;
    if (failures + remaining
        < ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold) {
      return index + 1;
    }
  }
  return null;
}

export function evaluateAdaptiveExecutableCanaryOutcome(calls = [], {
  terminalStatus = null,
  profile = ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION
} = {}) {
  const qualification = calls.filter((item) => item.stage === 'qualification');
  const confirmation = calls.filter((item) => item.stage === 'confirmation');
  const fullRepairEndpoint = usesFullRepairEndpoint(profile);
  const pairwiseEndpoint = profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4;
  const qualificationFailures = qualification
    .filter((item) => qualificationFailure(item, profile))
    .length;
  const endpointFields = fullRepairEndpoint
    ? { repairFailureMetric: 'full-repair' }
    : {};
  const incompletePairwiseFields = pairwiseEndpoint
    ? { routedPairwise: null }
    : {};
  if (terminalStatus === 'NO_HEADROOM') {
    return {
      status: 'NO_HEADROOM',
      ...endpointFields,
      qualificationFailures,
      confirmationBaselineFailures: null,
      routedPairedWins: null,
      shamPairedWins: null,
      routedAdvantage: null,
      routedControlFailures: null,
      routedTargetRegressions: null,
      ...incompletePairwiseFields,
      promotionEnabled: false,
      reasons: [fullRepairEndpoint
        ? 'The separate unaided qualification pool left insufficient full-repair headroom.'
        : 'The separate unaided qualification pool left insufficient executable headroom.']
    };
  }
  if (confirmation.length !==
      ADAPTIVE_EXECUTABLE_CANARY.confirmationTasks
        * ADAPTIVE_EXECUTABLE_CANARY.arms.length) {
    return {
      status: 'INCOMPLETE',
      ...endpointFields,
      qualificationFailures,
      confirmationBaselineFailures: null,
      routedPairedWins: null,
      shamPairedWins: null,
      routedAdvantage: null,
      routedControlFailures: null,
      routedTargetRegressions: null,
      ...incompletePairwiseFields,
      promotionEnabled: false,
      reasons: ['The confirmation schedule is incomplete.']
    };
  }
  const taskIds = [...new Set(confirmation.map((item) => item.taskId))];
  let baselineFailures = 0;
  let routedWins = 0;
  let shamWins = 0;
  let routedControlFailures = 0;
  let routedTargetRegressions = 0;
  const routedPairwise = {
    target: { improved: 0, matched: 0, regressed: 0 },
    control: { improved: 0, matched: 0, regressed: 0 }
  };
  const recordMovement = (bucket, current, baseline) => {
    if (current > baseline) bucket.improved += 1;
    else if (current < baseline) bucket.regressed += 1;
    else bucket.matched += 1;
  };
  for (const taskId of taskIds) {
    const baseline = confirmation.find((item) => (
      item.taskId === taskId && item.armRole === 'baseline'
    ));
    const routed = confirmation.find((item) => (
      item.taskId === taskId && item.armRole === 'routed'
    ));
    const sham = confirmation.find((item) => (
      item.taskId === taskId && item.armRole === 'sham'
    ));
    const baselineFailed = qualificationFailure(baseline, profile);
    if (pairwiseEndpoint) {
      recordMovement(
        routedPairwise.target,
        routed.targetQuality,
        baseline.targetQuality
      );
      recordMovement(
        routedPairwise.control,
        routed.controlQuality,
        baseline.controlQuality
      );
    }
    if (baselineFailed) {
      baselineFailures += 1;
      if (fullRepair(routed) && (
        fullRepairEndpoint
        || routed.targetQuality > baseline.targetQuality
      )) {
        routedWins += 1;
      }
      if (fullRepair(sham) && (
        fullRepairEndpoint
        || sham.targetQuality > baseline.targetQuality
      )) {
        shamWins += 1;
      }
    } else if (
      fullRepairEndpoint
        ? !fullRepair(routed)
        : routed?.targetQuality < baseline?.targetQuality
    ) {
      routedTargetRegressions += 1;
    }
    if (routed?.controlQuality < 1) routedControlFailures += 1;
  }
  const routedAdvantage = routedWins - shamWins;
  const pass = baselineFailures
      >= ADAPTIVE_EXECUTABLE_CANARY.confirmationBaselineFailureThreshold
    && routedWins >= ADAPTIVE_EXECUTABLE_CANARY.routedWinThreshold
    && routedAdvantage >= ADAPTIVE_EXECUTABLE_CANARY.routedAdvantageThreshold
    && routedControlFailures === 0
    && routedTargetRegressions === 0
    && (!pairwiseEndpoint || (
      routedPairwise.target.regressed === 0
      && routedPairwise.control.regressed === 0
    ));
  const reasons = [];
  if (baselineFailures
      < ADAPTIVE_EXECUTABLE_CANARY.confirmationBaselineFailureThreshold) {
    reasons.push(fullRepairEndpoint
      ? 'The untouched confirmation pool left insufficient full-repair baseline headroom.'
      : 'The untouched confirmation pool left insufficient baseline headroom.');
  }
  if (routedWins < ADAPTIVE_EXECUTABLE_CANARY.routedWinThreshold) {
    reasons.push(fullRepairEndpoint
      ? 'Routed memory did not complete enough baseline-incomplete shards.'
      : 'Routed memory did not fully repair enough baseline-failed shards.');
  }
  if (routedAdvantage < ADAPTIVE_EXECUTABLE_CANARY.routedAdvantageThreshold) {
    reasons.push('Routed paired wins did not exceed sham wins by the predeclared margin.');
  }
  if (routedControlFailures > 0) {
    reasons.push('Routed memory regressed one or more confirmation controls.');
  }
  if (routedTargetRegressions > 0 && !pairwiseEndpoint) {
    reasons.push(fullRepairEndpoint
      ? 'Routed memory made a complete no-memory repair incomplete.'
      : 'Routed memory regressed a target solved by the no-memory arm.');
  }
  if (pairwiseEndpoint && routedPairwise.target.regressed > 0) {
    reasons.push('Routed memory moved target quality below its paired baseline.');
  }
  if (pairwiseEndpoint && routedPairwise.control.regressed > 0) {
    reasons.push('Routed memory moved control quality below its paired baseline.');
  }
  return {
    status: pass ? 'PASS' : 'NO_CAUSAL_LIFT',
    ...endpointFields,
    qualificationFailures,
    confirmationBaselineFailures: baselineFailures,
    ...(fullRepairEndpoint
      ? {
          confirmationBaselineFullRepairFailures: baselineFailures,
          routedFullRepairRegressions: routedTargetRegressions
        }
      : {}),
    routedPairedWins: routedWins,
    shamPairedWins: shamWins,
    routedAdvantage,
    routedControlFailures,
    routedTargetRegressions: pairwiseEndpoint
      ? routedPairwise.target.regressed
      : routedTargetRegressions,
    ...(pairwiseEndpoint ? { routedPairwise } : {}),
    promotionEnabled: false,
    reasons
  };
}

function renderAdaptiveExecutableCanaryReport(state) {
  const verification = object(state.verification);
  const outcome = object(verification.outcome);
  const profile = state.plan?.profile;
  const v2 = profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2
    || profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3
    || profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4;
  const lines = [
    '# Loop Factory Executable Causal Canary',
    '',
    `- **run**: \`${state.runId}\``,
    `- **status**: ${state.status}`,
    `- **experiment valid**: ${verification.experimentValid === true}`,
    `- **causal outcome**: ${outcome.status || 'UNKNOWN'}`,
    `- **model**: ${state.model}`,
    `- **plan sha256**: \`${state.plan.sha256}\``,
    `- **verification sha256**: \`${verification.evidenceSha256 || 'missing'}\``,
    `- **qualification failures**: ${state.qualification?.observedFailures ?? 'unmeasured'}/5`,
    ...(usesFullRepairEndpoint(profile)
      ? ['- **qualification metric**: full repair (targets and controls)']
      : []),
    '- **promotion**: disabled',
    '',
    '## Gates',
    '',
    '| gate | result |',
    '|---|---|',
    ...Object.entries(verification.gates || {})
      .map(([name, pass]) => `| ${name} | ${pass ? 'PASS' : 'FAIL'} |`),
    '',
    '## Executable Results',
    '',
    ...(v2
      ? [
          '| stage | task | role | blind arm | exact target | decision target | code target | exact controls | decision controls | code controls | tokens | candidate |',
          '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
          ...(state.calls || []).map((item) => (
            `| ${item.stage} | ${item.taskId} | ${item.armRole} | ${item.blindArm} | ${item.targetQuality} | ${item.decisionTargetQuality} | ${item.codeTargetQuality} | ${item.controlQuality} | ${item.decisionControlQuality} | ${item.codeControlQuality} | ${item.cliReportedTotalTokens ?? 'unmeasured'} | ${item.candidateArtifactRef} |`
          ))
        ]
      : [
          '| stage | task | role | blind arm | target | controls | tokens | candidate |',
          '|---|---|---|---|---:|---:|---:|---|',
          ...(state.calls || []).map((item) => (
            `| ${item.stage} | ${item.taskId} | ${item.armRole} | ${item.blindArm} | ${item.targetQuality} | ${item.controlQuality} | ${item.cliReportedTotalTokens ?? 'unmeasured'} | ${item.candidateArtifactRef} |`
          ))
        ]),
    '',
    '## Causal Decision',
    '',
    `- confirmation baseline failures: ${outcome.confirmationBaselineFailures ?? 'unmeasured'}`,
    `- routed paired full repairs: ${outcome.routedPairedWins ?? 'unmeasured'}`,
    `- sham paired full repairs: ${outcome.shamPairedWins ?? 'unmeasured'}`,
    `- routed advantage: ${outcome.routedAdvantage ?? 'unmeasured'}`,
    `- routed control failures: ${outcome.routedControlFailures ?? 'unmeasured'}`,
    `- routed target regressions: ${outcome.routedTargetRegressions ?? 'unmeasured'}`,
    ...(profile === ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4
      ? [
          `- routed pairwise target movement: ${canonicalJson(outcome.routedPairwise?.target || null)}`,
          `- routed pairwise control movement: ${canonicalJson(outcome.routedPairwise?.control || null)}`
        ]
      : []),
    ...(outcome.reasons || []).map((reason) => `- ${reason}`),
    '',
    'This report proves only the persisted executable canary. It does not promote, publish, or modify a production loop.'
  ];
  return `${lines.join('\n')}\n`;
}

export function runAdaptiveExecutableCanary(store, config, {
  runId,
  worker,
  clock = nowIso
} = {}) {
  if (!isSafeId(runId)) {
    return {
      status: 'BLOCKED',
      code: 'BAD_RUN_ID',
      message: 'a safe --run-id is required'
    };
  }
  if (store.exists(runId)) {
    return {
      status: 'BLOCKED',
      code: 'RUN_EXISTS',
      message: `run "${runId}" already exists; executable canaries are append-only`
    };
  }
  if (typeof worker !== 'function') {
    return {
      status: 'BLOCKED',
      code: 'NO_WORKER',
      message: 'executable canary requires a worker backend'
    };
  }
  const validation = validateAdaptiveExecutableCanaryConfig(config);
  if (!validation.ok) {
    return {
      status: 'BLOCKED',
      code: 'EXECUTABLE_CANARY_CONFIG',
      errors: validation.errors,
      plan: validation.plan
    };
  }
  const plan = validation.plan;
  const createdAt = clock();
  const state = {
    schemaVersion: 1,
    kind: 'adaptive-executable-canary',
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'RUNNING',
    model: config.model,
    approvedPlanSha256: config.approvedPlanSha256,
    plan,
    evidenceArtifacts: {},
    calls: [],
    verdictEvents: [],
    failureEvidence: [],
    qualification: {
      status: 'PENDING',
      requiredFailures:
        ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold,
      ...(usesFullRepairEndpoint(config.schemaVersion)
        ? { failureMetric: 'full-repair' }
        : {}),
      observedFailures: 0,
      stoppedAfterCalls: null
    },
    promotion: { enabled: false, recorded: false },
    verification: null,
    outcome: null,
    blocker: null,
    reportPath: null
  };
  store.save(state);
  state.evidenceArtifacts = {
    config: evidenceArtifact(
      store,
      runId,
      'sealed-executable-canary-config',
      'config',
      config
    ),
    public: evidenceArtifact(
      store,
      runId,
      'sealed-public-capsule',
      'worker-visible',
      config.publicCapsule
    ),
    oracle: evidenceArtifact(
      store,
      runId,
      'sealed-oracle-capsule',
      'supervisor-private',
      config.oracleCapsule
    ),
    reference: evidenceArtifact(
      store,
      runId,
      'sealed-reference-capsule',
      'supervisor-private',
      config.referenceCapsule
    ),
    provenance: evidenceArtifact(
      store,
      runId,
      'sealed-provenance-capsule',
      'supervisor-private',
      config.provenanceCapsule
    ),
    mechanismEvidence: evidenceArtifact(
      store,
      runId,
      'sealed-mechanism-evidence',
      'supervisor-private',
      config.mechanismEvidenceCapsule
    ),
    implementation: evidenceArtifact(
      store,
      runId,
      'sealed-executable-implementation',
      'implementation',
      config.implementationCapsule
    ),
    runtimeAuthority: evidenceArtifact(
      store,
      runId,
      'sealed-codex-oauth-authority',
      'runtime-authority',
      config.runtimeAuthority
    ),
    evaluatorAuthority: evidenceArtifact(
      store,
      runId,
      'sealed-executable-evaluator-authority',
      'evaluator-authority',
      config.evaluatorAuthority
    ),
    preflight: evidenceArtifact(
      store,
      runId,
      'sealed-local-preflight',
      'preflight',
      config.preflight
    ),
    mechanismContext: evidenceArtifact(
      store,
      runId,
      'sealed-mechanism-context',
      'adaptive-records',
      config.mechanismContext
    )
  };
  const proposalSchema = readFileSync(
    schemaPathForContract({ kind: 'proposal' }),
    'utf8'
  );
  state.evidenceArtifacts.proposalSchema = evidenceArtifact(
    store,
    runId,
    'proposal-output-schema',
    'output-schema',
    proposalSchema
  );
  store.save(state);

  const block = (code, message) => {
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.updatedAt = clock();
    store.save(state);
    state.verification = verifyAdaptiveExecutableCanaryRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-executable-canary-report.md',
      renderAdaptiveExecutableCanaryReport(state)
    );
    store.save(state);
    return {
      status: 'BLOCKED',
      code,
      message,
      runId,
      reportPath: state.reportPath,
      verification: state.verification
    };
  };

  const finish = (status) => {
    state.status = status;
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
    state.verification = verifyAdaptiveExecutableCanaryRun(store, runId);
    state.outcome = state.verification.outcome;
    store.save(state);
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-executable-canary-report.md',
      renderAdaptiveExecutableCanaryReport(state)
    );
    store.save(state);
    return {
      status: 'OK',
      runId,
      reportPath: state.reportPath,
      statePath: `${store.runDir(runId)}/state.json`,
      experimentValid: state.verification.experimentValid,
      causalPass: state.verification.causalPass,
      outcome: state.verification.outcome,
      verification: state.verification
    };
  };

  const execute = (scheduleItem, callIndex) => {
    const task = taskFor(config, scheduleItem.taskId);
    const taskRouteIndex = config.tasks.findIndex((item) => item.id === task.id);
    const route = config.routes[taskRouteIndex];
    const contract = buildRepairContract(
      config,
      task,
      route,
      scheduleItem.armRole
    );
    const prefix = `call-${String(callIndex + 1).padStart(2, '0')}`;
    const inputs = persistCallInputs(store, runId, prefix, contract);
    let packet = null;
    try {
      packet = worker({ ...contract, attempt: 0 });
    } catch (error) {
      packet = { __error: error?.message || String(error) };
    }
    const packetValidation = validateRepairPacket(contract, packet);
    state.verdictEvents.push({
      kind: 'executable-repair',
      ...scheduleItem,
      accepted: packetValidation.ok,
      reasons: packetValidation.reasons,
      attempt: 0,
      invocation: packet?.invocation || null
    });
    store.save(state);
    if (!packetValidation.ok) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        packet,
        route,
        {
          artifactPrefix: `${prefix}-failed`,
          kind: 'executable-repair',
          reasons: packetValidation.reasons,
          attempt: 0,
          context: { ...scheduleItem, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'REPAIR_OUTPUT_INVALID',
          `${task.id}: ${packetValidation.reasons.join(',')}`
        )
      };
    }
    if (!invocationMatchesRuntimeAuthority(config, packet.invocation)) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        packet,
        route,
        {
          artifactPrefix: `${prefix}-authority-failed`,
          kind: 'executable-repair',
          reasons: ['MODEL_AUTHORITY_UNPROVEN'],
          attempt: 0,
          context: { ...scheduleItem, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'MODEL_AUTHORITY_UNPROVEN',
          `${task.id}: OAuth route, executable, or backend identity mismatch`
        )
      };
    }
    const persisted = persistCanaryProposal(store, runId, packet, route, {
      artifactPrefix: prefix
    });
    if (!persisted.ok) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        packet,
        route,
        {
          artifactPrefix: `${prefix}-receipt-failed`,
          kind: 'executable-repair',
          reasons: [persisted.reason],
          attempt: 0,
          context: { ...scheduleItem, ...inputs }
        }
      ));
      store.save(state);
      return {
        blocked: block(
          'REPAIR_RECEIPT_INVALID',
          `${task.id}: ${persisted.reason}`
        )
      };
    }
    const materials = taskMaterials(config, task);
    const evaluation = evaluateExecutableCandidate({
      source: persisted.revisedContent,
      caseSet: materials.caseSet,
      authority: config.evaluatorAuthority,
      taskId: task.id,
      diagnostics: isExecutableCanaryV2(config)
    });
    if (!evaluation.instrumentValid) {
      return {
        blocked: block(
          'EXECUTABLE_EVALUATOR_INVALID',
          `${task.id}: ${evaluation.code}`
        )
      };
    }
    const measured = persistSandboxEvaluation(
      store,
      runId,
      prefix,
      persisted.revisedContent,
      evaluation
    );
    state.calls.push({
      ...persisted.record,
      ...inputs,
      ...scheduleItem,
      callIndex,
      sourceSha256: materials.source.sha256,
      specSha256: materials.spec.sha256,
      ...(isExecutableCanaryV2(config)
        ? { interfaceSha256: materials.interfaceArtifact.sha256 }
        : {}),
      oracleSha256: materials.oracle.sha256,
      mechanismCapsuleSha256:
        treatmentPacketSha256(proposalMechanism(
          config,
          scheduleItem.armRole,
          task
        )),
      candidateArtifactRef: measured.candidateArtifactRef,
      candidateSha256: measured.candidateSha256,
      sandboxStdoutArtifactRef: measured.sandboxStdoutArtifactRef,
      sandboxStdoutSha256: measured.sandboxStdoutSha256,
      sandboxStderrArtifactRef: measured.sandboxStderrArtifactRef,
      sandboxStderrSha256: measured.sandboxStderrSha256,
      evaluationArtifactRef: measured.evaluationArtifactRef,
      evaluationSha256: measured.evaluationSha256,
      measurementRef: measured.measurementRef,
      evaluationCode: measured.evaluation.code,
      targetQuality: measured.evaluation.targetQuality,
      controlQuality: measured.evaluation.controlQuality,
      ...(isExecutableCanaryV2(config)
        ? {
            decisionTargetQuality:
              measured.evaluation.decisionTargetQuality,
            decisionControlQuality:
              measured.evaluation.decisionControlQuality,
            codeTargetQuality: measured.evaluation.codeTargetQuality,
            codeControlQuality: measured.evaluation.codeControlQuality
          }
        : {})
    });
    state.updatedAt = clock();
    store.save(state);
    return { blocked: null };
  };

  let callIndex = 0;
  const qualificationSchedule = plan.contract.qualificationSchedule;
  for (const item of qualificationSchedule) {
    const execution = execute(item, callIndex++);
    if (execution.blocked) return execution.blocked;
    const qualificationCalls = state.calls
      .filter((call) => call.stage === 'qualification');
    const failures = qualificationCalls
      .filter((call) => qualificationFailure(call, config.schemaVersion))
      .length;
    state.qualification.observedFailures = failures;
    const remaining = ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks
      - qualificationCalls.length;
    if (failures + remaining
        < ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold) {
      state.qualification.status = 'NO_HEADROOM';
      state.qualification.stoppedAfterCalls = qualificationCalls.length;
      state.updatedAt = clock();
      store.save(state);
      return finish('NO_HEADROOM');
    }
  }
  if (state.qualification.observedFailures
      < ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold) {
    state.qualification.status = 'NO_HEADROOM';
    state.qualification.stoppedAfterCalls =
      ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks;
    state.updatedAt = clock();
    store.save(state);
    return finish('NO_HEADROOM');
  }
  state.qualification.status = 'QUALIFIED';
  state.qualification.stoppedAfterCalls =
    ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks;
  state.updatedAt = clock();
  store.save(state);

  for (const item of plan.contract.confirmationSchedule) {
    const execution = execute(item, callIndex++);
    if (execution.blocked) return execution.blocked;
  }
  return finish('QUEUE_DRAINED');
}

function flattenArtifactRefs(value) {
  if (Array.isArray(value)) return value.flatMap(flattenArtifactRefs);
  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return [value.id];
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(flattenArtifactRefs);
  }
  return [];
}

function parseArtifactJson(artifact) {
  if (!artifactHashMatches(artifact)) return null;
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

function expectedTreatment(config, armRole, task) {
  return proposalMechanism(config, armRole, task);
}

function normalizedParityContract(contract) {
  return canonicalValue({
    ...contract,
    mechanismCapsule: '<ASSIGNED_TREATMENT>'
  });
}

function privatePromptNeedles(config) {
  return [
    ...(config.oracleCapsule || []),
    ...(config.referenceCapsule || []),
    ...(config.provenanceCapsule || []),
    ...(config.mechanismEvidenceCapsule || [])
  ].flatMap((item) => [
    String(item.path || ''),
    String(item.content || '')
  ]).filter((item) => item.length >= 8);
}

function callArtifacts(store, runId, call) {
  return {
    contract: safeArtifact(store, runId, call.contractArtifactRef),
    prompt: safeArtifact(store, runId, call.promptArtifactRef),
    raw: safeArtifact(store, runId, call.rawArtifactRef),
    result: safeArtifact(store, runId, call.resultArtifactRef),
    candidate: safeArtifact(store, runId, call.candidateArtifactRef),
    evaluation: safeArtifact(store, runId, call.evaluationArtifactRef),
    sandboxStdout: safeArtifact(
      store,
      runId,
      call.sandboxStdoutArtifactRef
    ),
    sandboxStderr: safeArtifact(
      store,
      runId,
      call.sandboxStderrArtifactRef
    )
  };
}

function verificationFailure(runId, reason) {
  const base = {
    schemaVersion: 1,
    runId,
    status: 'FAIL',
    experimentValid: false,
    causalPass: false,
    gates: {},
    outcome: {
      status: 'INCOMPLETE',
      promotionEnabled: false,
      reasons: [reason]
    },
    reasons: [reason]
  };
  return {
    ...base,
    evidenceSha256: sha256(stableJson(base))
  };
}

function executableCallSlotKey(item = {}) {
  return [
    item.stage,
    item.taskId,
    item.armRole,
    item.blindArm,
    item.taskIndex,
    item.position
  ].map((value) => String(value ?? '')).join(':');
}

function verifyRecordedExecutableCallInputs(store, runId, record) {
  const contractArtifact = safeArtifact(
    store,
    runId,
    record.contractArtifactRef
  );
  const promptArtifact = safeArtifact(
    store,
    runId,
    record.promptArtifactRef
  );
  const contract = parseArtifactJson(contractArtifact);
  const expectedPrompt = contract
    ? buildAdaptiveExecutableCanaryPrompt(contract)
    : null;
  return {
    ok: artifactHashMatches(contractArtifact)
      && artifactHashMatches(promptArtifact)
      && contractArtifact.sha256 === record.contractSha256
      && promptArtifact.sha256 === record.promptArtifactSha256
      && record.invocation?.promptSha256 === record.promptArtifactSha256
      && promptArtifact.content === expectedPrompt,
    contract,
    promptArtifact
  };
}

function failureArtifactMatches(store, runId, evidence, receiptSha256) {
  if (!evidence) return receiptSha256 == null || receiptSha256 === sha256('');
  const artifact = safeArtifact(store, runId, evidence.artifactRef);
  return artifactHashMatches(artifact)
    && artifact.sha256 === evidence.sha256
    && evidence.receiptSha256 === receiptSha256
    && evidence.matchesReceipt === true
    && artifact.sha256 === receiptSha256
    && evidence.bytes === Buffer.byteLength(artifact.content);
}

export function verifyAdaptiveExecutableCanaryRun(store, runId) {
  const state = store.load(runId);
  if (!state || state.kind !== 'adaptive-executable-canary') {
    return verificationFailure(
      runId,
      'executable canary state is missing or has the wrong kind'
    );
  }
  const configArtifact = safeArtifact(
    store,
    runId,
    state.evidenceArtifacts?.config?.id
  );
  const config = parseArtifactJson(configArtifact);
  if (!config) {
    return verificationFailure(runId, 'sealed executable canary config is invalid');
  }
  const validation = validateAdaptiveExecutableCanaryConfig(config, {
    requireApproval: false
  });
  const v2 = isExecutableCanaryV2(config);
  const plan = validation.plan;
  const calls = Array.isArray(state.calls) ? state.calls : [];
  const verdictEvents = Array.isArray(state.verdictEvents)
    ? state.verdictEvents
    : [];
  const failureEvidence = Array.isArray(state.failureEvidence)
    ? state.failureEvidence
    : [];
  const observedEvents = verdictEvents.filter((event) => (
    event?.invocation && typeof event.invocation === 'object'
  ));
  const privateNeedles = privatePromptNeedles(config);
  const proposalChecks = [];
  let promptBinding = true;
  let treatmentBinding = true;
  let privateEvidenceWithheld = true;
  let measurementDerivation = true;
  let sandboxAuthority = true;
  let modelAuthority = true;
  let strictIsolation = true;
  for (const call of calls) {
    const artifacts = callArtifacts(store, runId, call);
    const contract = parseArtifactJson(artifacts.contract);
    const proposal = verifyPersistedProposalRun(store, runId, call);
    proposalChecks.push({ call, proposal });
    if (!contract
        || !artifactHashMatches(artifacts.prompt)
        || artifacts.contract.sha256 !== call.contractSha256
        || artifacts.prompt.sha256 !== call.promptArtifactSha256
        || call.promptSha256 !== call.promptArtifactSha256
        || artifacts.prompt.content
          !== buildAdaptiveExecutableCanaryPrompt(contract)
        || call.promptSha256 !== sha256(artifacts.prompt.content)) {
      promptBinding = false;
    }
    const task = taskFor(config, call.taskId);
    const expected = expectedTreatment(config, call.armRole, task);
    if (canonicalJson(contract?.mechanismCapsule || null)
        !== canonicalJson(expected || null)
        || call.mechanismCapsuleSha256
          !== treatmentPacketSha256(expected)) {
      treatmentBinding = false;
    }
    if (privateNeedles.some((needle) => artifacts.prompt?.content?.includes(needle))) {
      privateEvidenceWithheld = false;
    }
    if (!proposal.ok) {
      strictIsolation = false;
    }
    if (!invocationMatchesRuntimeAuthority(config, call)) {
      modelAuthority = false;
    }
    const candidate = artifacts.candidate?.content;
    const materials = task ? taskMaterials(config, task) : null;
    const persistedEvaluation = parseArtifactJson(artifacts.evaluation);
    const replay = candidate && materials?.caseSet
      ? evaluateExecutableCandidate({
          source: candidate,
          caseSet: materials.caseSet,
          authority: config.evaluatorAuthority,
          taskId: call.taskId,
          diagnostics: v2
        })
      : null;
    if (!replay?.instrumentValid) sandboxAuthority = false;
    const replayRecord = replay ? sandboxResultRecord(replay) : null;
    if (!persistedEvaluation
        || !replayRecord
        || !artifactHashMatches(artifacts.candidate)
        || !artifactHashMatches(artifacts.evaluation)
        || !artifactHashMatches(artifacts.sandboxStdout)
        || !artifactHashMatches(artifacts.sandboxStderr)
        || persistedEvaluation.code !== replayRecord.code
        || persistedEvaluation.exitCode !== replayRecord.exitCode
        || persistedEvaluation.outputShapeValid
          !== replayRecord.outputShapeValid
        || persistedEvaluation.targetQuality
          !== replayRecord.targetQuality
        || persistedEvaluation.controlQuality
          !== replayRecord.controlQuality
        || (v2 && (
          persistedEvaluation.decisionTargetQuality
            !== replayRecord.decisionTargetQuality
          || persistedEvaluation.decisionControlQuality
            !== replayRecord.decisionControlQuality
          || persistedEvaluation.codeTargetQuality
            !== replayRecord.codeTargetQuality
          || persistedEvaluation.codeControlQuality
            !== replayRecord.codeControlQuality
          || call.decisionTargetQuality
            !== replayRecord.decisionTargetQuality
          || call.decisionControlQuality
            !== replayRecord.decisionControlQuality
          || call.codeTargetQuality !== replayRecord.codeTargetQuality
          || call.codeControlQuality !== replayRecord.codeControlQuality
        ))
        || canonicalJson(persistedEvaluation.results)
          !== canonicalJson(replayRecord.results)
        || canonicalJson(persistedEvaluation.sandbox)
          !== canonicalJson(replayRecord.sandbox)
        || call.targetQuality !== replayRecord.targetQuality
        || call.controlQuality !== replayRecord.controlQuality
        || artifacts.candidate?.sha256 !== call.candidateSha256
        || artifacts.evaluation?.sha256 !== call.evaluationSha256
        || artifacts.sandboxStdout?.sha256 !== call.sandboxStdoutSha256
        || artifacts.sandboxStderr?.sha256 !== call.sandboxStderrSha256) {
      measurementDerivation = false;
    }
  }
  const failedPromptChecks = failureEvidence.map((failure) => ({
    failure,
    input: verifyRecordedExecutableCallInputs(store, runId, failure)
  }));
  for (const { failure, input } of failedPromptChecks) {
    if (!input.ok) promptBinding = false;
    const expected = expectedTreatment(
      config,
      failure.armRole,
      taskFor(config, failure.taskId)
    );
    if (canonicalJson(input.contract?.mechanismCapsule || null)
        !== canonicalJson(expected || null)) {
      treatmentBinding = false;
    }
    if (privateNeedles.some((needle) => (
      input.promptArtifact?.content?.includes(needle)
    ))) {
      privateEvidenceWithheld = false;
    }
  }
  modelAuthority = observedEvents.length > 0
    && observedEvents.every((event) => invocationMatchesRuntimeAuthority(
      config,
      event.invocation,
      { requireSuccess: event.accepted === true }
    ));
  strictIsolation = strictIsolation
    && observedEvents.length > 0
    && observedEvents.every((event) => (
      event.invocation.strictIsolation === true
      && event.invocation.isolation?.status === 'PASS'
      && (event.invocation.isolation?.toolCalls || []).length === 0
    ));

  let treatmentParity = true;
  const confirmationOpened = calls.some((call) => call.stage === 'confirmation');
  for (const task of (config.tasks || [])
    .filter((item) => item.phase === 'confirmation')) {
    const rows = calls.filter((call) => (
      call.stage === 'confirmation' && call.taskId === task.id
    ));
    if (!confirmationOpened) continue;
    if (rows.length !== 3) {
      treatmentParity = false;
      continue;
    }
    const contracts = rows.map((call) => parseArtifactJson(
      safeArtifact(store, runId, call.contractArtifactRef)
    ));
    if (contracts.some((contract) => !contract)
        || new Set(contracts.map((contract) => (
          canonicalJson(normalizedParityContract(contract))
        ))).size !== 1) {
      treatmentParity = false;
    }
  }

  const qualificationCalls = calls.filter((item) => item.stage === 'qualification');
  const confirmationCalls = calls.filter((item) => item.stage === 'confirmation');
  const actualSchedule = verdictEvents.map((item) => ({
    stage: item.stage,
    taskId: item.taskId,
    armRole: item.armRole,
    blindArm: item.blindArm,
    taskIndex: item.taskIndex,
    position: item.position
  }));
  const fullSchedule = plan.contract.executionSchedule;
  const stopAfter = expectedQualificationStop(
    qualificationCalls,
    config.schemaVersion
  );
  const expectedSchedule = state.status === 'NO_HEADROOM'
    ? plan.contract.qualificationSchedule.slice(0, stopAfter || qualificationCalls.length)
    : (state.status === 'BLOCKED'
        ? fullSchedule.slice(0, verdictEvents.length)
        : fullSchedule);
  const acceptedEventSlots = verdictEvents
    .filter((event) => event.accepted === true)
    .map(executableCallSlotKey);
  const acceptedCallSlots = calls.map(executableCallSlotKey);
  const schedule = canonicalJson(actualSchedule)
    === canonicalJson(expectedSchedule)
    && canonicalJson(acceptedCallSlots) === canonicalJson(acceptedEventSlots)
    && (
      state.status === 'NO_HEADROOM'
        ? (
            confirmationCalls.length === 0
            && verdictEvents.length === calls.length
          )
        : (state.status === 'QUEUE_DRAINED'
            ? (
                calls.length === ADAPTIVE_EXECUTABLE_CANARY.maximumCalls
                && verdictEvents.length === calls.length
              )
            : (
                state.status === 'BLOCKED'
                && verdictEvents.length <= ADAPTIVE_EXECUTABLE_CANARY.maximumCalls
                && failureEvidence.length === 1
              ))
    );

  const evidenceRefs = flattenArtifactRefs(state.evidenceArtifacts);
  const callRefs = calls.flatMap((call) => [
    call.contractArtifactRef,
    call.promptArtifactRef,
    call.rawArtifactRef,
    call.resultArtifactRef,
    call.candidateArtifactRef,
    call.evaluationArtifactRef,
    call.sandboxStdoutArtifactRef,
    call.sandboxStderrArtifactRef
  ]).filter(Boolean);
  const failureRefs = failureEvidence.flatMap((failure) => [
    failure.stdout?.artifactRef,
    failure.stderr?.artifactRef,
    failure.result?.artifactRef,
    failure.contractArtifactRef,
    failure.promptArtifactRef
  ]).filter(Boolean);
  const artifactRefs = [...new Set([...evidenceRefs, ...callRefs, ...failureRefs])];
  const artifactHashes = artifactRefs.length > 0
    && artifactRefs.every((id) => artifactHashMatches(
      safeArtifact(store, runId, id)
    ));
  const expectedFailureEvidenceCount = state.status === 'BLOCKED' ? 1 : 0;
  const failureEvidenceIntegrity =
    failureEvidence.length === expectedFailureEvidenceCount
    && failureEvidence.every((failure) => {
      const event = observedEvents.find((candidate) => (
        executableCallSlotKey(candidate) === executableCallSlotKey(failure)
        && candidate.accepted === false
        && candidate.invocation?.stdoutSha256
          === failure.invocation?.stdoutSha256
      ));
      const input = failedPromptChecks.find((item) => item.failure === failure)?.input;
      const stdout = failure.stdout
        ? safeArtifact(store, runId, failure.stdout.artifactRef)
        : null;
      const tokens = stdout ? parseTokenUsage(stdout.content) : null;
      return !!event
        && input?.ok === true
        && failure.attempt === 0
        && typeof failure.execReason === 'string'
        && failure.execReason.length > 0
        && failureArtifactMatches(
          store,
          runId,
          failure.stdout,
          failure.invocation?.stdoutSha256
        )
        && failureArtifactMatches(
          store,
          runId,
          failure.stderr,
          failure.invocation?.stderrSha256
        )
        && failureArtifactMatches(
          store,
          runId,
          failure.result,
          failure.invocation?.resultSha256
        )
        && (failure.invocation?.cliReportedTotalTokens == null
          || tokens === failure.invocation.cliReportedTotalTokens);
    });
  const observedSlots = verdictEvents.map(executableCallSlotKey);
  const noRetries = verdictEvents.length <= ADAPTIVE_EXECUTABLE_CANARY.maximumCalls
    && observedEvents.length === verdictEvents.length
    && verdictEvents.every((event) => event.attempt === 0)
    && new Set(observedSlots).size === observedSlots.length;
  const noPromotion = state.promotion?.enabled === false
    && state.promotion?.recorded === false;
  const qualificationFailures = qualificationCalls
    .filter((call) => qualificationFailure(call, config.schemaVersion))
    .length;
  const fullRepairEndpoint = usesFullRepairEndpoint(config.schemaVersion);
  const qualificationConsistency = state.qualification?.observedFailures
      === qualificationFailures
    && state.qualification?.requiredFailures
      === ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold
    && (
      fullRepairEndpoint
        ? state.qualification?.failureMetric === 'full-repair'
        : !Object.hasOwn(object(state.qualification), 'failureMetric')
    )
    && (
      state.status === 'NO_HEADROOM'
        ? (
            state.qualification.status === 'NO_HEADROOM'
            && qualificationFailures
              + (ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks
                - qualificationCalls.length)
              < ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold
          )
        : (
            state.status === 'QUEUE_DRAINED'
            && state.qualification.status === 'QUALIFIED'
            && qualificationFailures
              >= ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold
          )
    );
  const outcome = evaluateAdaptiveExecutableCanaryOutcome(calls, {
    terminalStatus: state.status,
    profile: config.schemaVersion
  });
  const stateConsistency = state.approvedPlanSha256 === plan.sha256
    && state.plan?.sha256 === plan.sha256
    && qualificationConsistency
    && canonicalJson(state.outcome || outcome) === canonicalJson(outcome);

  const gates = {
    configIntegrity: validation.ok,
    implementationIntegrity: validation.implementation?.ok === true,
    ...(v2
      ? {
          interfaceCoverage: (config.tasks || []).every((task) => (
            taskMaterials(config, task).interfaceCoverage.ok === true
          ))
        }
      : {}),
    ...(isExecutableCanaryV4(config)
      ? {
          mechanismCompileCoverage: (config.tasks || []).every((task) => {
            const compilation = mechanismCompilationForTask(config, task);
            return compilation?.routedComplete === true
              && compilation?.shamComplete === true
              && capsuleSchemaSha256(compilation.routed)
                === capsuleSchemaSha256(compilation.sham);
          }),
          shamReplay: validation.mechanism?.shamReplayValid === true
        }
      : {}),
    partitionIsolation: validation.mechanism?.partitionIsolation === true,
    privateEvidenceWithheld,
    preflight: validation.preflight?.status === 'PASS',
    receipts: proposalChecks.length === calls.length
      && proposalChecks.every((item) => item.proposal.ok),
    modelAuthority,
    strictIsolation,
    promptBinding,
    treatmentBinding,
    treatmentParity,
    schedule,
    sandboxAuthority,
    measurementDerivation,
    artifactHashes,
    failureEvidenceIntegrity,
    noRetries,
    noPromotion,
    stateConsistency
  };
  const experimentValid = Object.values(gates).every(Boolean);
  const reasons = Object.entries(gates)
    .filter(([, pass]) => !pass)
    .map(([name]) => `${name} gate failed`);
  const eventUsage = observedEvents.map((event) => ({
    event,
    tokens: Number.isFinite(event.invocation?.tokenUsage)
      ? event.invocation.tokenUsage
      : null
  }));
  const usageTotal = (rows) => rows.some((item) => !Number.isFinite(item.tokens))
    ? null
    : rows.reduce((sum, item) => sum + item.tokens, 0);
  const tokenUsage = {
    observedCalls: observedEvents.length,
    measuredCalls: eventUsage
      .filter((item) => Number.isFinite(item.tokens))
      .length,
    unmeasuredCalls: eventUsage
      .filter((item) => !Number.isFinite(item.tokens))
      .length,
    total: usageTotal(eventUsage),
    failedDispatchTotal: usageTotal(
      eventUsage.filter((item) => item.event.accepted !== true)
    ),
    byArm: Object.fromEntries(
      ADAPTIVE_EXECUTABLE_CANARY.arms.map((arm) => {
        const rows = eventUsage.filter((item) => item.event.armRole === arm);
        return [arm, {
          calls: rows.length,
          total: usageTotal(rows),
          failedDispatchTotal: usageTotal(
            rows.filter((item) => item.event.accepted !== true)
          )
        }];
      })
    )
  };
  const reportedModels = observedEvents
    .map((event) => event.invocation.reportedModel)
    .filter((value) => value != null);
  const base = {
    schemaVersion: 1,
    runId,
    status: experimentValid ? 'PASS' : 'FAIL',
    experimentValid,
    causalPass: experimentValid && outcome.status === 'PASS',
    activationEligible: false,
    modelAuthority: {
      launchAuthority: modelAuthority,
      requestedModel: REAL_TEST_MODEL,
      authMode: config.runtimeAuthority.authMode,
      backendModelIdentity:
        reportedModels.length === observedEvents.length && observedEvents.length
        ? 'REPORTED_MATCH'
        : (reportedModels.length ? 'PARTIAL_MATCH' : 'UNAVAILABLE'),
      backendReportedCalls: reportedModels.length,
      observedCalls: observedEvents.length
    },
    gates,
    qualification: {
      observedCalls: observedEvents
        .filter((event) => event.stage === 'qualification').length,
      ...(fullRepairEndpoint
        ? {
            failureMetric: 'full-repair',
            fullRepairFailures: qualificationFailures,
            targetFailures: qualificationCalls
              .filter((call) => call.targetQuality < 1).length,
            controlFailures: qualificationCalls
              .filter((call) => call.controlQuality < 1).length
          }
        : { targetFailures: qualificationFailures }),
      requiredFailures:
        ADAPTIVE_EXECUTABLE_CANARY.qualificationFailureThreshold
    },
    armCounts: Object.fromEntries(
      ADAPTIVE_EXECUTABLE_CANARY.arms.map((arm) => [
        arm,
        observedEvents.filter((event) => event.armRole === arm).length
      ])
    ),
    series: Object.fromEntries(
      ADAPTIVE_EXECUTABLE_CANARY.arms.map((arm) => [
        arm,
        calls.filter((call) => call.armRole === arm).map((call) => ({
          stage: call.stage,
          taskId: call.taskId,
          targetQuality: call.targetQuality,
          controlQuality: call.controlQuality,
          ...(v2
            ? {
                decisionTargetQuality: call.decisionTargetQuality,
                decisionControlQuality: call.decisionControlQuality,
                codeTargetQuality: call.codeTargetQuality,
                codeControlQuality: call.codeControlQuality
              }
            : {}),
          tokenCost: call.cliReportedTotalTokens,
          artifactRef: call.evaluationArtifactRef
        }))
      ])
    ),
    tokenUsage,
    outcome,
    failedReceipts: [
      ...proposalChecks
        .filter((item) => !item.proposal.ok)
        .map((item) => ({
          taskId: item.call.taskId,
          armRole: item.call.armRole,
          reasons: item.proposal.reasons
        })),
      ...failureEvidence.map((failure) => ({
        taskId: failure.taskId,
        armRole: failure.armRole,
        reasons: failure.reasons,
        execReason: failure.execReason,
        exitCode: failure.invocation?.exitCode ?? null
      }))
    ],
    reasons
  };
  return {
    ...base,
    evidenceSha256: sha256(stableJson(base))
  };
}

function resolvedConfigSha256(config) {
  return sha256(canonicalJson({
    ...config,
    approvedPlanSha256: null
  }));
}

export function adaptiveExecutableCanaryLaunchDisclosure(config, {
  configPath,
  home,
  runId
} = {}) {
  const plan = buildAdaptiveExecutableCanaryPlan(config);
  const schemaPath = schemaPathForContract({ kind: 'proposal' });
  const proposalArgv = buildArgs('codex', null, REAL_TEST_MODEL, {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: '<fresh-model-capsule>'
  });
  const evaluator = object(config.evaluatorAuthority);
  const launchCommand = [
    `SUPER_LOOP_CODEX_BIN='${config.runtimeAuthority?.binary?.path || ''}'`,
    'SUPER_LOOP_REQUIRE_CHATGPT_OAUTH=1',
    `SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256=${config.runtimeAuthority?.authoritySha256 || ''}`,
    `SUPER_LOOP_CODEX_EXECUTABLE_SHA256=${config.runtimeAuthority?.binary?.sha256 || ''}`,
    'SUPER_LOOP_ALLOW_EXEC=1',
    'npm run executable-canary --',
    `--config '${resolve(configPath || '')}'`,
    `--approved-plan ${plan.sha256}`,
    `--run-id '${runId || ''}'`,
    `--home '${resolve(home || '')}'`,
    '&& npm run verify:executable-canary --',
    `--home '${resolve(home || '')}'`,
    `--run '${runId || ''}'`
  ].join(' ');
  return {
    profile: config.schemaVersion || ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION,
    planSha256: plan.sha256,
    resolvedConfigSha256: resolvedConfigSha256(config),
    proofHome: resolve(home || ''),
    runId,
    calls: {
      qualificationMaximum: ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks,
      ...(usesFullRepairEndpoint(config.schemaVersion)
        ? { qualificationFailureMetric: 'full-repair' }
        : {}),
      confirmationConditional:
        ADAPTIVE_EXECUTABLE_CANARY.confirmationTasks
          * ADAPTIVE_EXECUTABLE_CANARY.arms.length,
      totalMaximum: ADAPTIVE_EXECUTABLE_CANARY.maximumCalls,
      retries: 0
    },
    exposure: {
      perCallTimeoutMs: ADAPTIVE_EXECUTABLE_CANARY.perCallTimeoutMs,
      sequentialTimeoutCeilingMinutes:
        ADAPTIVE_EXECUTABLE_CANARY.sequentialTimeoutCeilingMs / 60000,
      hardTokenLimit: null,
      hardUsdLimit: null,
      historicalTokenEstimate: config.historicalTokenEstimate || null,
      historicalEstimateBinding: 'non-binding'
    },
    execution: {
      model: REAL_TEST_MODEL,
      reasoningEffort: STRICT_CODEX_REASONING_EFFORT,
      authMode: config.runtimeAuthority?.authMode || null,
      proposalArgv,
      disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
      promotionEnabled: false
    },
    evaluator: {
      authoritySha256: evaluator.authoritySha256 || null,
      nodeSha256: evaluator.node?.sha256 || null,
      sandboxSha256: evaluator.sandbox?.sha256 || null,
      profileSha256: evaluator.sandbox?.profileSha256 || null,
      bootstrapSha256: evaluator.bootstrap?.sha256 || null,
      timeoutMs: evaluator.limits?.timeoutMs || null,
      heapMb: evaluator.limits?.heapMb || null,
      hiddenExpectedOutputsEnterCandidateProcess: false
    },
    partitions: {
      qualificationTasks: plan.tasks
        .filter((task) => task.phase === 'qualification').length,
      confirmationTasks: plan.tasks
        .filter((task) => task.phase === 'confirmation').length,
      publicSources: config.publicManifest?.length || 0,
      oracleSources: config.oracleManifest?.length || 0,
      referenceSources: config.referenceManifest?.length || 0,
      provenanceSources: config.provenanceManifest?.length || 0
    },
    launchCommand
  };
}
