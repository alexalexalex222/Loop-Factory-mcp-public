import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import {
  ADAPTIVE_RECURSIVE_CANARY_V2,
  ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS,
  prepareAdaptiveRecursiveCanaryV2Config,
  resolveAdaptiveRecursiveV2Implementation,
  validateAdaptiveRecursiveCanaryV2Config
} from './adaptive-recursive-canary-v2.mjs';
import {
  adaptiveRecursiveCanaryWorker,
  artifactMatches,
  parseArtifactJson,
  readArtifact
} from './adaptive-recursive-runner.mjs';
import {
  verifyAdaptiveRecursiveCanaryV2Run
} from './adaptive-recursive-runner-v2.mjs';
import {
  runAdaptiveRecursiveCanaryV2WithLease,
  verifyAdaptiveRecursiveVNextLeaseReceipt
} from './adaptive-recursive-vnext-run.mjs';
import { validateCodexOAuthAuthorityRecord } from './codex-oauth-authority.mjs';
import { validateMechanismEvolutionRecord } from './mechanism-evolution-records.mjs';
import { createResourceBudgetPolicy } from './resource-budget.mjs';
import { createStore } from './store.mjs';
import { isSafeId, sha256 } from './util.mjs';
import {
  validateVNextAblationProtocol,
  verifyVNextAblationProtocolFromDisk,
  vnextAblationInternalIdentityDigests,
  vnextAblationProtocolPhase
} from './vnext-ablation-protocol.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { validateVNextMechanismExecutionBinding } from './vnext-mechanism-execution.mjs';
import {
  validateVNextTaskMaterialBundle,
  validateVNextTaskPack,
  vnextTaskPackIdentities
} from './vnext-task-pack.mjs';
import { VNEXT_WAVE_IMPLEMENTATION_PATHS } from './vnext-wave-runner.mjs';

export const VNEXT_FROZEN_CANDIDATE_STUDY_PLAN_SCHEMA =
  'loop-factory-vnext-frozen-candidate-study-plan-v1';
export const VNEXT_FROZEN_CANDIDATE_STUDY_RESULT_SCHEMA =
  'loop-factory-vnext-frozen-candidate-study-result-v1';
export const VNEXT_FROZEN_CANDIDATE_SOURCE_SCHEMA =
  'loop-factory-vnext-frozen-candidate-source-v1';
export const VNEXT_FROZEN_CANDIDATE_PREREQUISITE_SCHEMA =
  'loop-factory-vnext-frozen-candidate-prerequisite-v1';
export const VNEXT_FROZEN_CANDIDATE_CUSTODY_SCHEMA =
  'loop-factory-vnext-frozen-candidate-custody-v1';

export const VNEXT_FROZEN_CANDIDATE_IMPLEMENTATION_PATHS = Object.freeze([
  ...new Set([
    ...ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS,
    ...VNEXT_WAVE_IMPLEMENTATION_PATHS,
    'src/vnext-frozen-candidate-study.mjs',
    'scripts/plan-vnext-frozen-candidate-study.mjs',
    'scripts/run-vnext-frozen-candidate-study.mjs',
    'scripts/verify-vnext-frozen-candidate-study.mjs',
    'src/schemas/vnext-frozen-candidate-study-plan-v1.schema.json'
  ])
].sort());

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STUDIES_DIR = 'frozen-candidate-studies';
const PLAN_FILE = 'plan.json';
const LAUNCH_FILE = 'launch.json';
const RESULT_FILE = 'result.json';
const MATERIALS_FILE = 'target-materials.json';
const MATERIALIZATION_FILE = 'materialization.json';
const INNER_CONFIG_FILE = 'inner-config.json';
const INNER_PLAN_FILE = 'inner-plan.json';
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set(['transfer', 'final']);
const TARGET_TASKS = 10;
const INPUT_TOKENS_PER_CALL = 32_000;
const OUTPUT_TOKENS_PER_CALL = 8_000;

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

function canonicalBytes(value) {
  return `${canonicalVNextJson(value)}\n`;
}

const CUSTODY_FILES = Object.freeze({
  manifest: 'CUSTODIAN_PACKAGE_MANIFEST.json',
  protocol: 'frozen-protocol.json',
  source: 'frozen-source-snapshot.json',
  prerequisite: 'transfer-prerequisite.json'
});

function validCustodyFileBinding(binding, expectedPath) {
  return exactKeys(binding, ['path', 'bytes', 'sha256'])
    && binding.path === expectedPath
    && Number.isSafeInteger(binding.bytes) && binding.bytes > 0
    && SHA256.test(String(binding.sha256 || ''));
}

function custodyBindingCore(binding) {
  const { bindingSha256, ...core } = binding;
  return core;
}

export function validateVNextFrozenCandidateCustodyBinding(binding) {
  if (!exactKeys(binding, [
    'schemaVersion', 'packageRoot', 'packageId', 'manifestSha256',
    'fileSetSha256', 'packageEvidenceSha256', 'files', 'bindingSha256'
  ]) || binding.schemaVersion !== VNEXT_FROZEN_CANDIDATE_CUSTODY_SCHEMA
      || !isAbsolute(String(binding.packageRoot || ''))
      || !isSafeId(binding.packageId)
      || [
        binding.manifestSha256,
        binding.fileSetSha256,
        binding.packageEvidenceSha256,
        binding.bindingSha256
      ].some((digest) => !SHA256.test(String(digest || '')))
      || !exactKeys(binding.files, Object.keys(CUSTODY_FILES))
      || Object.entries(CUSTODY_FILES).some(([key, path]) => (
        !validCustodyFileBinding(binding.files[key], path)
      ))) {
    return refused('FROZEN_CANDIDATE_CUSTODY_INVALID', 'Custody binding is malformed.');
  }
  return binding.bindingSha256
    === sha256(canonicalVNextJson(custodyBindingCore(binding)))
    ? { status: 'OK', binding }
    : refused('FROZEN_CANDIDATE_CUSTODY_TAMPERED', 'Custody binding hash failed replay.');
}

function readCustodyFile(root, binding) {
  const path = resolve(root, binding.path);
  if (!within(root, path) || !existsSync(path)
      || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
  const bytes = readFileSync(path);
  return bytes.length === binding.bytes && sha256(bytes) === binding.sha256
    ? bytes
    : null;
}

export function createVNextFrozenCandidateCustodyBinding({ verification } = {}) {
  try {
    if (verification?.status !== 'OK'
        || !SHA256.test(String(verification.evidenceSha256 || ''))
        || !verification.manifest) {
      return refused(
        'FROZEN_CANDIDATE_CUSTODY_PACKAGE_INVALID',
        'A successful custodian-package verification is required.'
      );
    }
    const packageRoot = realpathSync(resolve(verification.packageRoot));
    const files = Object.fromEntries(Object.entries(CUSTODY_FILES).map(([key, path]) => {
      const bytes = readFileSync(resolve(packageRoot, path));
      return [key, { path, bytes: bytes.length, sha256: sha256(bytes) }];
    }));
    const core = {
      schemaVersion: VNEXT_FROZEN_CANDIDATE_CUSTODY_SCHEMA,
      packageRoot,
      packageId: verification.manifest.packageId,
      manifestSha256: verification.manifest.manifestSha256,
      fileSetSha256: verification.manifest.fileSetSha256,
      packageEvidenceSha256: verification.evidenceSha256,
      files
    };
    const binding = {
      ...core,
      bindingSha256: sha256(canonicalVNextJson(core))
    };
    return validateVNextFrozenCandidateCustodyBinding(binding).status === 'OK'
      ? { status: 'OK', binding }
      : refused('FROZEN_CANDIDATE_CUSTODY_BUILD_FAILED', 'Custody binding failed replay.');
  } catch (error) {
    return refused('FROZEN_CANDIDATE_CUSTODY_BUILD_FAILED', error.message);
  }
}

export function verifyVNextFrozenCandidateCustodyBinding({
  binding,
  protocol,
  sourceSnapshot,
  transferPrerequisite
} = {}) {
  try {
    const valid = validateVNextFrozenCandidateCustodyBinding(binding);
    if (valid.status !== 'OK') return valid;
    const root = realpathSync(resolve(binding.packageRoot));
    if (root !== binding.packageRoot) {
      return refused('FROZEN_CANDIDATE_CUSTODY_RELOCATED_AFTER_PLAN', 'Custody package moved after plan approval.');
    }
    const bytes = Object.fromEntries(Object.keys(CUSTODY_FILES).map((key) => [
      key,
      readCustodyFile(root, binding.files[key])
    ]));
    if (Object.values(bytes).some((value) => value == null)) {
      return refused('FROZEN_CANDIDATE_CUSTODY_FILE_DRIFT', 'One or more sealed custody files changed.');
    }
    const parsed = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [
      key,
      JSON.parse(value.toString('utf8'))
    ]));
    const manifestCore = structuredClone(parsed.manifest);
    delete manifestCore.manifestSha256;
    const expectedEvidenceSha256 = sha256(canonicalVNextJson({
      manifestSha256: parsed.manifest.manifestSha256,
      fileSetSha256: parsed.manifest.fileSetSha256,
      sourceSnapshotSha256: parsed.source.sourceSnapshotSha256,
      transferPrerequisiteSha256: parsed.prerequisite.prerequisiteSha256
    }));
    if (parsed.manifest.packageId !== binding.packageId
        || parsed.manifest.manifestSha256 !== binding.manifestSha256
        || parsed.manifest.fileSetSha256 !== binding.fileSetSha256
        || parsed.manifest.manifestSha256
          !== sha256(canonicalVNextJson(manifestCore))
        || expectedEvidenceSha256 !== binding.packageEvidenceSha256
        || validateVNextAblationProtocol(parsed.protocol).status !== 'OK'
        || validateVNextFrozenCandidateSource(parsed.source).status !== 'OK'
        || validateVNextFrozenCandidatePrerequisite(parsed.prerequisite).status !== 'OK'
        || canonicalVNextJson(parsed.protocol) !== canonicalVNextJson(protocol)
        || canonicalVNextJson(parsed.source) !== canonicalVNextJson(sourceSnapshot)
        || canonicalVNextJson(parsed.prerequisite)
          !== canonicalVNextJson(transferPrerequisite)) {
      return refused('FROZEN_CANDIDATE_CUSTODY_EVIDENCE_DRIFT', 'Sealed custody evidence failed replay.');
    }
    return { status: 'OK', binding, manifest: parsed.manifest };
  } catch (error) {
    return refused('FROZEN_CANDIDATE_CUSTODY_VERIFY_FAILED', error.message);
  }
}

function immutableWrite(path, bytes) {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8') === bytes
      ? { status: 'OK', path, idempotent: true }
      : refused('FROZEN_CANDIDATE_IMMUTABLE_CONFLICT', `Immutable bytes conflict at ${path}.`);
  }
  writeFileSync(path, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { status: 'OK', path, idempotent: false };
}

function studyDirectory(proofHome, studyId, { create = false } = {}) {
  if (!isAbsolute(String(proofHome || '')) || !isSafeId(studyId)) return null;
  try {
    if (create) mkdirSync(proofHome, { recursive: true, mode: 0o700 });
    const home = realpathSync(resolve(proofHome));
    const studies = resolve(home, STUDIES_DIR);
    if (create) mkdirSync(studies, { recursive: true, mode: 0o700 });
    if (!existsSync(studies) || lstatSync(studies).isSymbolicLink()) return null;
    const root = realpathSync(studies);
    const directory = resolve(root, studyId);
    if (!within(root, directory)) return null;
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return null;
    return realpathSync(directory);
  } catch {
    return null;
  }
}

function artifactBinding(path, bytes) {
  return {
    path,
    bytes: Buffer.byteLength(bytes),
    sha256: sha256(bytes)
  };
}

function readBinding(directory, binding) {
  try {
    const allowed = exactKeys(binding, ['path', 'bytes', 'sha256'])
      || exactKeys(binding, ['path', 'bytes', 'sha256', 'embeddedBundle']);
    if (!allowed
        || typeof binding.path !== 'string'
        || !binding.path || isAbsolute(binding.path)
        || binding.path.split('/').includes('..')
        || !Number.isSafeInteger(binding.bytes) || binding.bytes < 1
        || !SHA256.test(String(binding.sha256 || ''))) return null;
    const path = resolve(directory, binding.path);
    if (!within(directory, path) || !existsSync(path)
        || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return null;
    const bytes = readFileSync(path, 'utf8');
    return Buffer.byteLength(bytes) === binding.bytes && sha256(bytes) === binding.sha256
      ? { path, bytes }
      : null;
  } catch {
    return null;
  }
}

function implementationManifest(packageRoot = PACKAGE_ROOT) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const manifest = VNEXT_FROZEN_CANDIDATE_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full) || !existsSync(full)
          || lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) {
        throw new Error(`Frozen-candidate dependency is missing or unsafe: ${path}`);
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
    return refused('FROZEN_CANDIDATE_IMPLEMENTATION_INVALID', error.message);
  }
}

function frozenCandidateCore(config) {
  return {
    parentFamily: structuredClone(config.parentFamily),
    candidateFamily: structuredClone(config.candidateFamily),
    evolutionRecord: structuredClone(config.evolutionRecord)
  };
}

function sourceSnapshotCore(snapshot) {
  const { sourceSnapshotSha256, ...core } = snapshot;
  return core;
}

export function validateVNextFrozenCandidateSource(snapshot) {
  if (!exactKeys(snapshot, [
    'schemaVersion', 'sourceHome', 'sourceRunId', 'sourceStateSha256',
    'sourceConfigArtifactId', 'sourceConfigArtifactSha256',
    'sourceVerifierEvidenceSha256', 'sourceLeaseEvidenceSha256',
    'sourceTaskPartition', 'sourceTaskPackSha256', 'sourceBindingSha256',
    'confirmationAnalysisSha256', 'sourceCallCount', 'sourceTokenTotal',
    'zeroShamMovement', 'zeroTargetRegressions', 'zeroControlRegressions',
    'frozenCandidate', 'frozenCandidateSha256', 'sourceSnapshotSha256'
  ]) || snapshot.schemaVersion !== VNEXT_FROZEN_CANDIDATE_SOURCE_SCHEMA
      || !isAbsolute(String(snapshot.sourceHome || ''))
      || !isSafeId(snapshot.sourceRunId)
      || !isSafeId(snapshot.sourceConfigArtifactId)
      || [
        snapshot.sourceStateSha256,
        snapshot.sourceConfigArtifactSha256,
        snapshot.sourceVerifierEvidenceSha256,
        snapshot.sourceLeaseEvidenceSha256,
        snapshot.sourceTaskPackSha256,
        snapshot.sourceBindingSha256,
        snapshot.confirmationAnalysisSha256,
        snapshot.frozenCandidateSha256,
        snapshot.sourceSnapshotSha256
      ].some((digest) => !SHA256.test(String(digest || '')))
      || snapshot.sourceTaskPartition !== 'validation'
      || !Number.isSafeInteger(snapshot.sourceCallCount)
      || snapshot.sourceCallCount !== ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls
      || !Number.isSafeInteger(snapshot.sourceTokenTotal)
      || snapshot.sourceTokenTotal < 0
      || snapshot.zeroShamMovement !== true
      || snapshot.zeroTargetRegressions !== true
      || snapshot.zeroControlRegressions !== true
      || validateAdaptiveRecord(snapshot.frozenCandidate?.parentFamily).status !== 'OK'
      || validateAdaptiveRecord(snapshot.frozenCandidate?.candidateFamily).status !== 'OK'
      || validateMechanismEvolutionRecord(snapshot.frozenCandidate?.evolutionRecord).status !== 'OK'
      || snapshot.frozenCandidate.evolutionRecord.parent.familyId
        !== snapshot.frozenCandidate.parentFamily.familyId
      || snapshot.frozenCandidate.evolutionRecord.parent.familySha256
        !== snapshot.frozenCandidate.parentFamily.familySha256
      || snapshot.frozenCandidate.evolutionRecord.candidate.familyId
        !== snapshot.frozenCandidate.candidateFamily.familyId
      || snapshot.frozenCandidate.evolutionRecord.candidate.familySha256
        !== snapshot.frozenCandidate.candidateFamily.familySha256) {
    return refused('FROZEN_CANDIDATE_SOURCE_INVALID', 'Frozen validation source is malformed or lacks the required causal gates.');
  }
  const candidateCore = frozenCandidateCore(snapshot.frozenCandidate);
  if (snapshot.frozenCandidateSha256 !== sha256(canonicalVNextJson(candidateCore))
      || snapshot.sourceSnapshotSha256
        !== sha256(canonicalVNextJson(sourceSnapshotCore(snapshot)))) {
    return refused('FROZEN_CANDIDATE_SOURCE_TAMPERED', 'Frozen source or candidate hash failed replay.');
  }
  return { status: 'OK', snapshot };
}

export function resolveVNextFrozenValidationCandidate({ sourceStore, sourceRunId } = {}) {
  try {
    if (!sourceStore || !isSafeId(sourceRunId)) {
      return refused('FROZEN_CANDIDATE_SOURCE_INPUT_INVALID', 'A source store and safe validation run ID are required.');
    }
    const sourceHome = realpathSync(resolve(sourceStore.homeDir));
    const state = sourceStore.load(sourceRunId);
    const configRef = state?.evidenceArtifacts?.config;
    const configArtifact = configRef?.id
      ? readArtifact(sourceStore, sourceRunId, configRef.id)
      : null;
    const config = parseArtifactJson(configArtifact);
    const verification = verifyAdaptiveRecursiveCanaryV2Run(sourceStore, sourceRunId);
    const lease = verifyAdaptiveRecursiveVNextLeaseReceipt(sourceStore, sourceRunId);
    const binding = config?.vnextBinding;
    const confirmation = verification.confirmationAnalysis;
    const summary = confirmation?.summary;
    const taskEffects = Array.isArray(summary?.taskEffects) ? summary.taskEffects : [];
    const zeroShamMovement = summary?.shamVsCold?.mean === 0
      && taskEffects.length === 5
      && taskEffects.every((row) => row.shamVsColdMean === 0);
    if (!state || !artifactMatches(configArtifact)
        || configArtifact.sha256 !== configRef?.sha256
        || !config
        || verification.experimentValid !== true
        || verification.causalPass !== true
        || verification.activationEligible !== true
        || verification.gates?.noPromotion !== true
        || verification.gates?.resourceBudget !== true
        || lease.status !== 'OK'
        || validateVNextMechanismExecutionBinding(binding).status !== 'OK'
        || binding.taskPartition !== 'validation'
        || confirmation?.causalPass !== true
        || summary?.targetRegressions !== 0
        || summary?.controlRegressions !== 0
        || !zeroShamMovement
        || state.promotion?.enabled !== false
        || state.promotion?.recorded !== false
        || verification.tokenUsage?.observedCalls
          !== ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls
        || !Number.isSafeInteger(verification.tokenUsage?.total)) {
      return refused(
        'FROZEN_CANDIDATE_SOURCE_NOT_ELIGIBLE',
        'Source must be a verifier-replayed VNext validation causal pass with a valid lease, zero sham movement, zero regressions, trusted tokens, and no promotion.'
      );
    }
    const candidate = frozenCandidateCore(config);
    const core = {
      schemaVersion: VNEXT_FROZEN_CANDIDATE_SOURCE_SCHEMA,
      sourceHome,
      sourceRunId,
      sourceStateSha256: sha256(canonicalVNextJson(state)),
      sourceConfigArtifactId: configArtifact.id,
      sourceConfigArtifactSha256: configArtifact.sha256,
      sourceVerifierEvidenceSha256: verification.evidenceSha256,
      sourceLeaseEvidenceSha256: lease.evidenceSha256,
      sourceTaskPartition: binding.taskPartition,
      sourceTaskPackSha256: binding.taskPackSha256,
      sourceBindingSha256: binding.bindingSha256,
      confirmationAnalysisSha256: confirmation.analysisSha256,
      sourceCallCount: verification.tokenUsage.observedCalls,
      sourceTokenTotal: verification.tokenUsage.total,
      zeroShamMovement: true,
      zeroTargetRegressions: true,
      zeroControlRegressions: true,
      frozenCandidate: candidate,
      frozenCandidateSha256: sha256(canonicalVNextJson(candidate))
    };
    const snapshot = {
      ...core,
      sourceSnapshotSha256: sha256(canonicalVNextJson(core))
    };
    return validateVNextFrozenCandidateSource(snapshot).status === 'OK'
      ? { status: 'OK', snapshot, verification, lease }
      : refused('FROZEN_CANDIDATE_SOURCE_INVALID', 'Resolved source snapshot failed replay.');
  } catch (error) {
    return refused('FROZEN_CANDIDATE_SOURCE_FAILED', error.message);
  }
}

function prerequisiteCore(prerequisite) {
  const { prerequisiteSha256, ...core } = prerequisite;
  return core;
}

export function validateVNextFrozenCandidatePrerequisite(prerequisite) {
  if (!exactKeys(prerequisite, [
    'schemaVersion', 'proofHome', 'studyId', 'runId', 'role',
    'planSha256', 'resultSha256', 'evidenceSha256',
    'protocolSha256', 'sourceSnapshotSha256', 'frozenCandidateSha256',
    'targetPackSha256', 'verifierEvidenceSha256', 'leaseEvidenceSha256',
    'causalPass', 'prerequisiteSha256'
  ]) || prerequisite.schemaVersion !== VNEXT_FROZEN_CANDIDATE_PREREQUISITE_SCHEMA
      || !isAbsolute(String(prerequisite.proofHome || ''))
      || !isSafeId(prerequisite.studyId) || !isSafeId(prerequisite.runId)
      || prerequisite.role !== 'transfer'
      || [
        prerequisite.planSha256,
        prerequisite.resultSha256,
        prerequisite.evidenceSha256,
        prerequisite.protocolSha256,
        prerequisite.sourceSnapshotSha256,
        prerequisite.frozenCandidateSha256,
        prerequisite.targetPackSha256,
        prerequisite.verifierEvidenceSha256,
        prerequisite.leaseEvidenceSha256,
        prerequisite.prerequisiteSha256
      ].some((digest) => !SHA256.test(String(digest || '')))
      || prerequisite.causalPass !== true) {
    return refused('FROZEN_CANDIDATE_PREREQUISITE_INVALID', 'Final confirmation requires one valid causal transfer prerequisite.');
  }
  return prerequisite.prerequisiteSha256
    === sha256(canonicalVNextJson(prerequisiteCore(prerequisite)))
    ? { status: 'OK', prerequisite }
    : refused('FROZEN_CANDIDATE_PREREQUISITE_TAMPERED', 'Transfer prerequisite hash failed replay.');
}

export function resolveVNextFrozenCandidatePrerequisite({ proofHome, studyId } = {}) {
  const verified = verifyVNextFrozenCandidateStudyFromDisk({ proofHome, studyId });
  if (verified.status !== 'OK' || verified.outcome !== 'PASS'
      || verified.plan.role !== 'transfer' || verified.verification.causalPass !== true) {
    return refused(
      'FROZEN_CANDIDATE_TRANSFER_PREREQUISITE_FAILED',
      'The prerequisite transfer study is missing, invalid, or did not causally pass.'
    );
  }
  const core = {
    schemaVersion: VNEXT_FROZEN_CANDIDATE_PREREQUISITE_SCHEMA,
    proofHome: realpathSync(resolve(proofHome)),
    studyId,
    runId: verified.plan.runId,
    role: 'transfer',
    planSha256: verified.plan.planSha256,
    resultSha256: verified.result.resultSha256,
    evidenceSha256: verified.evidenceSha256,
    protocolSha256: verified.plan.protocolSha256,
    sourceSnapshotSha256: verified.plan.sourceSnapshotSha256,
    frozenCandidateSha256: verified.plan.frozenCandidateSha256,
    targetPackSha256: verified.plan.targetPackSha256,
    verifierEvidenceSha256: verified.verification.verifierEvidenceSha256,
    leaseEvidenceSha256: verified.result.leaseEvidenceSha256,
    causalPass: true
  };
  const prerequisite = {
    ...core,
    prerequisiteSha256: sha256(canonicalVNextJson(core))
  };
  return validateVNextFrozenCandidatePrerequisite(prerequisite).status === 'OK'
    ? { status: 'OK', prerequisite }
    : refused('FROZEN_CANDIDATE_PREREQUISITE_BUILD_FAILED', 'Transfer prerequisite failed replay.');
}

function targetIdentityBinding(taskPack) {
  const identities = vnextTaskPackIdentities(taskPack);
  if (!identities) return null;
  const identityDigests = identities.map((identity) => sha256(identity)).sort();
  return {
    identityCount: identityDigests.length,
    identityDigests,
    identityDigestSetSha256: sha256(canonicalVNextJson(identityDigests))
  };
}

export function validateVNextFrozenCandidateTarget({
  role,
  protocol,
  taskPack,
  taskMaterialBundle
} = {}) {
  const validProtocol = validateVNextAblationProtocol(protocol);
  const validPack = validateVNextTaskPack(taskPack);
  const validBundle = validateVNextTaskMaterialBundle({
    bundle: taskMaterialBundle,
    pack: taskPack
  });
  const identity = validPack.status === 'OK' ? targetIdentityBinding(taskPack) : null;
  if (!ROLES.has(role) || validProtocol.status !== 'OK'
      || validPack.status !== 'OK' || validBundle.status !== 'OK'
      || taskPack.tasks.length !== TARGET_TASKS || !identity) {
    return refused('FROZEN_CANDIDATE_TARGET_INVALID', 'Target requires one valid ten-cluster pack and material bundle under the frozen protocol.');
  }
  const internal = new Set(vnextAblationInternalIdentityDigests(protocol));
  const collisions = identity.identityDigests.filter((digest) => internal.has(digest));
  if (role === 'transfer') {
    const descriptor = protocol.packs.find((row) => row.role === 'transfer');
    const phase = vnextAblationProtocolPhase(
      protocol,
      'P4-disjoint-transfer',
      'B6-frozen',
      taskPack.packSha256
    );
    if (!descriptor || !phase
        || taskPack.partition !== 'development'
        || descriptor.packSha256 !== taskPack.packSha256
        || descriptor.materialBundleSha256 !== taskMaterialBundle.bundleSha256
        || descriptor.taskIdentitySetSha256 !== taskPack.taskIdentitySetSha256
        || collisions.length !== identity.identityDigests.length) {
      return refused('FROZEN_CANDIDATE_TRANSFER_MISMATCH', 'Transfer must use the exact frozen P4 pack and materials.');
    }
  } else if (taskPack.partition !== 'final'
      || taskPack.builderAuthority?.kind !== 'external-custodian'
      || protocol.packs.some((row) => row.packSha256 === taskPack.packSha256)
      || collisions.length !== 0) {
    return refused(
      'FROZEN_CANDIDATE_FINAL_NOT_DISJOINT',
      'Final confirmation requires a new external-custodian pack with zero internal identity-digest collisions.'
    );
  }
  return {
    status: 'OK',
    binding: {
      role,
      packId: taskPack.packId,
      partition: taskPack.partition,
      builderAuthority: structuredClone(taskPack.builderAuthority),
      packSha256: taskPack.packSha256,
      materialBundleSha256: taskMaterialBundle.bundleSha256,
      taskIdentitySetSha256: taskPack.taskIdentitySetSha256,
      identityCount: identity.identityCount,
      identityDigestSetSha256: identity.identityDigestSetSha256,
      baselineFailureCount: taskPack.tasks.length,
      baselineFailureSetSha256: sha256(canonicalVNextJson(taskPack.tasks.map((task) => ({
        taskId: task.taskId,
        baselineArtifactSha256: task.baselineFailure.baselineArtifactSha256,
        verifierEvidenceSha256: task.baselineFailure.verifierEvidenceSha256,
        targetFailureIds: task.baselineFailure.targetFailureIds,
        controlPassIds: task.baselineFailure.controlPassIds
      })))),
      internalIdentityLedgerSha256: protocol.identityLedger.ledgerSha256,
      internalIdentityCollisions: collisions.length,
      transferPackFrozenInProtocol: role === 'transfer',
      finalDisjointFromInternal: role === 'final' ? collisions.length === 0 : null
    }
  };
}

function materializeTarget(directory, taskPack, bundle) {
  const entries = [];
  const tasks = [];
  for (const material of bundle.materials) {
    const task = taskPack.tasks.find((row) => row.taskId === material.taskId);
    if (!task) return refused('FROZEN_CANDIDATE_TASK_MISSING', 'Material task is absent from the target pack.');
    const paths = {
      source: `materials/${task.taskId}/candidate.mjs`,
      incident: `materials/${task.taskId}/incident.md`,
      interface: `materials/${task.taskId}/interface.json`,
      oracle: `materials/${task.taskId}/oracle.json`
    };
    for (const kind of Object.keys(paths)) {
      const path = resolve(directory, paths[kind]);
      if (!within(directory, path)) return refused('FROZEN_CANDIDATE_MATERIAL_PATH', 'Material path escaped the study directory.');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const written = immutableWrite(path, material[kind].content);
      if (written.status !== 'OK') return written;
      entries.push({
        taskId: task.taskId,
        kind,
        path: paths[kind],
        sha256: sha256(material[kind].content),
        bytes: Buffer.byteLength(material[kind].content)
      });
    }
    tasks.push({
      id: task.taskId,
      source: { path: paths.source, sha256: material.source.sha256 },
      incident: { path: paths.incident, sha256: material.incident.sha256 },
      interface: { path: paths.interface, sha256: task.interfaceContractSha256 },
      oracle: { path: paths.oracle, sha256: material.oracle.sha256 },
      interfaceContract: structuredClone(material.interfaceContract)
    });
  }
  entries.sort((left, right) => (
    left.taskId.localeCompare(right.taskId) || left.kind.localeCompare(right.kind)
  ));
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  const core = {
    schemaVersion: 'vnext-frozen-candidate-materialization-v1',
    packSha256: taskPack.packSha256,
    materialBundleSha256: bundle.bundleSha256,
    entries
  };
  const manifest = {
    ...core,
    materializationSha256: sha256(canonicalVNextJson(core))
  };
  const persisted = immutableWrite(
    join(directory, MATERIALIZATION_FILE),
    canonicalBytes(manifest)
  );
  return persisted.status === 'OK'
    ? { status: 'OK', manifest, tasks }
    : persisted;
}

function splitTasks(tasks, taskPack) {
  const tags = new Map(taskPack.tasks.map((task) => [task.taskId, new Set(task.tags)]));
  const calibrationTasks = tasks.filter((task) => tags.get(task.id)?.has('qualification'));
  const confirmationTasks = tasks.filter((task) => tags.get(task.id)?.has('confirmation'));
  return calibrationTasks.length === 5 && confirmationTasks.length === 5
    && new Set([...calibrationTasks, ...confirmationTasks].map((task) => task.id)).size === 10
    ? { status: 'OK', calibrationTasks, confirmationTasks }
    : refused(
        'FROZEN_CANDIDATE_STAGE_TAGS_INVALID',
        'Target pack must contain exactly five qualification and five confirmation clusters.'
      );
}

function makeBudget(studyId) {
  return createResourceBudgetPolicy({
    policyId: `frozen-${sha256(studyId).slice(0, 24)}`,
    maxCalls: ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
    maxInputTokens: INPUT_TOKENS_PER_CALL * ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
    maxOutputTokens: OUTPUT_TOKENS_PER_CALL * ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
    maxTotalTokens: (INPUT_TOKENS_PER_CALL + OUTPUT_TOKENS_PER_CALL)
      * ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
    maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd',
    currency: 'USD'
  });
}

function noImportSurface(proofHome) {
  const adaptiveMemory = resolve(proofHome, 'adaptive-memory-v1');
  const evidenceBank = resolve(proofHome, 'vnext-evidence-bank');
  return {
    adaptiveMemoryAbsent: !existsSync(adaptiveMemory),
    evidenceBankAbsent: !existsSync(evidenceBank),
    surfaceSha256: sha256(canonicalVNextJson({
      adaptiveMemoryAbsent: !existsSync(adaptiveMemory),
      evidenceBankAbsent: !existsSync(evidenceBank)
    }))
  };
}

function planCore(input) {
  return {
    schemaVersion: VNEXT_FROZEN_CANDIDATE_STUDY_PLAN_SCHEMA,
    studyId: input.studyId,
    runId: input.runId,
    role: input.role,
    createdAt: input.createdAt,
    proofHome: input.proofHome,
    source: input.source,
    prerequisite: input.prerequisite,
    custody: input.custody ?? null,
    protocol: input.protocol,
    protocolBinding: {
      protocolId: input.protocol.protocolId,
      protocolSha256: input.protocol.protocolSha256,
      phaseId: input.role === 'transfer'
        ? 'P4-disjoint-transfer'
        : 'external-custodian-final',
      identityLedgerSha256: input.protocol.identityLedger.ledgerSha256
    },
    target: input.target,
    targetPack: input.targetPack,
    artifacts: input.artifacts,
    inner: input.inner,
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
    implementationManifest: input.implementation.manifest,
    implementationSha256: input.implementation.implementationSha256,
    authority: {
      candidateRegenerated: false,
      researchEnabled: false,
      retrievalEnabled: false,
      proposerCalls: 0,
      candidateGeneratorCalls: 0,
      catalogImportEnabled: false,
      evidenceBankImportEnabled: false,
      activationAuthority: false,
      promotionAuthorized: false
    },
    exposure: {
      maximumCalls: ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
      calibrationCalls: ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls,
      conditionalConfirmationCalls: ADAPTIVE_RECURSIVE_CANARY_V2.confirmationCalls,
      retries: 0,
      perCallInputTokenCeiling: INPUT_TOKENS_PER_CALL,
      perCallOutputTokenCeiling: OUTPUT_TOKENS_PER_CALL,
      hardInputTokenCeiling: INPUT_TOKENS_PER_CALL
        * ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
      hardOutputTokenCeiling: OUTPUT_TOKENS_PER_CALL
        * ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
      hardTotalTokenCeiling: (INPUT_TOKENS_PER_CALL + OUTPUT_TOKENS_PER_CALL)
        * ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls,
      hardUsdCeiling: 0,
      billingMode: 'subscription-no-metered-usd',
      sequentialTimeoutCeilingMinutes:
        ADAPTIVE_RECURSIVE_CANARY_V2.sequentialTimeoutCeilingMinutes,
      historicalTokenEstimate: input.historicalTokenEstimate,
      historicalEstimateBinding: 'non-binding'
    },
    approval: {
      requiredBeforeLaunch: true,
      authority: 'operator-exact-frozen-candidate-plan-sha256',
      runExactlyOnce: true,
      retriesAuthorized: false,
      workerLaunchedAtPlanning: false,
      paidModelCallsAtPlanning: 0
    }
  };
}

export function validateVNextFrozenCandidateStudyPlan(plan) {
  const custody = plan?.custody === null
    ? { status: 'OK' }
    : validateVNextFrozenCandidateCustodyBinding(plan?.custody);
  if (!exactKeys(plan, [
    'schemaVersion', 'studyId', 'runId', 'role', 'createdAt', 'proofHome',
    'source', 'prerequisite', 'custody', 'protocol', 'protocolBinding', 'target', 'targetPack',
    'artifacts', 'inner', 'route', 'runtimeAuthority',
    'implementationManifest', 'implementationSha256', 'authority',
    'exposure', 'approval', 'planSha256'
  ]) || plan.schemaVersion !== VNEXT_FROZEN_CANDIDATE_STUDY_PLAN_SCHEMA
      || !isSafeId(plan.studyId) || !isSafeId(plan.runId)
      || !ROLES.has(plan.role) || !isAbsolute(String(plan.proofHome || ''))
      || !Number.isFinite(Date.parse(plan.createdAt))
      || validateVNextFrozenCandidateSource(plan.source).status !== 'OK'
      || (plan.role === 'transfer'
        ? plan.prerequisite !== null
        : validateVNextFrozenCandidatePrerequisite(plan.prerequisite).status !== 'OK')
      || custody.status !== 'OK'
      || (plan.custody !== null && plan.role !== 'final')
      || validateVNextAblationProtocol(plan.protocol).status !== 'OK'
      || validateVNextTaskPack(plan.targetPack).status !== 'OK'
      || validateCodexOAuthAuthorityRecord(plan.runtimeAuthority).status !== 'OK'
      || plan.route?.model !== 'gpt-5.6-sol'
      || plan.route?.reasoningEffort !== 'high'
      || plan.route?.authMode !== 'chatgpt-oauth'
      || plan.route?.fallbackModels?.length !== 0
      || plan.route.oauthAuthoritySha256 !== plan.runtimeAuthority.authoritySha256
      || plan.route.executablePath !== plan.runtimeAuthority.binary.path
      || plan.route.executableSha256 !== plan.runtimeAuthority.binary.sha256
      || plan.protocolBinding?.protocolSha256 !== plan.protocol.protocolSha256
      || plan.protocolBinding?.identityLedgerSha256
        !== plan.protocol.identityLedger.ledgerSha256
      || plan.protocolBinding?.phaseId !== (plan.role === 'transfer'
        ? 'P4-disjoint-transfer'
        : 'external-custodian-final')
      || plan.protocol.parentFamilyId
        !== plan.source.frozenCandidate.parentFamily.familyId
      || plan.protocol.parentFamilySha256
        !== plan.source.frozenCandidate.parentFamily.familySha256
      || plan.inner?.candidateFamilySha256
        !== plan.source.frozenCandidate.candidateFamily.familySha256
      || plan.inner?.candidateProgramSha256
        !== plan.source.frozenCandidate.evolutionRecord.candidate.programSha256
      || plan.inner?.candidateFrozenAgainstSource !== true
      || plan.inner?.noVNextPreparationBinding !== true
      || plan.inner?.noPacePolicy !== true
      || plan.authority?.candidateRegenerated !== false
      || plan.authority?.proposerCalls !== 0
      || plan.authority?.candidateGeneratorCalls !== 0
      || plan.authority?.catalogImportEnabled !== false
      || plan.authority?.evidenceBankImportEnabled !== false
      || plan.authority?.activationAuthority !== false
      || plan.authority?.promotionAuthorized !== false
      || plan.exposure?.maximumCalls !== 120
      || plan.exposure?.retries !== 0
      || plan.exposure?.hardTotalTokenCeiling !== 4_800_000
      || plan.exposure?.hardUsdCeiling !== 0
      || plan.approval?.requiredBeforeLaunch !== true
      || plan.approval?.runExactlyOnce !== true
      || plan.approval?.retriesAuthorized !== false
      || plan.approval?.workerLaunchedAtPlanning !== false
      || plan.approval?.paidModelCallsAtPlanning !== 0
      || !Array.isArray(plan.implementationManifest)
      || plan.implementationSha256
        !== sha256(canonicalVNextJson(plan.implementationManifest))
      || !SHA256.test(String(plan.implementationSha256 || ''))
      || !SHA256.test(String(plan.planSha256 || ''))) {
    return refused('FROZEN_CANDIDATE_PLAN_INVALID', 'Frozen-candidate plan shape or authority boundary is invalid.');
  }
  if (plan.role === 'final'
      && (plan.prerequisite.protocolSha256 !== plan.protocol.protocolSha256
        || plan.prerequisite.sourceSnapshotSha256
          !== plan.source.sourceSnapshotSha256
        || plan.prerequisite.frozenCandidateSha256
          !== plan.source.frozenCandidateSha256)) {
    return refused('FROZEN_CANDIDATE_PREREQUISITE_MISMATCH', 'Final confirmation drifted from the exact validation and transfer candidate.');
  }
  const target = validateVNextFrozenCandidateTarget({
    role: plan.role,
    protocol: plan.protocol,
    taskPack: plan.targetPack,
    taskMaterialBundle: plan.artifacts?.targetMaterials?.embeddedBundle
  });
  if (target.status !== 'OK'
      || canonicalVNextJson(target.binding) !== canonicalVNextJson(plan.target)) {
    return refused('FROZEN_CANDIDATE_PLAN_TARGET_INVALID', 'Plan target no longer satisfies the protocol.');
  }
  const core = structuredClone(plan);
  delete core.planSha256;
  return plan.planSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', plan }
    : refused('FROZEN_CANDIDATE_PLAN_TAMPERED', 'Frozen-candidate plan hash failed replay.');
}

export function createVNextFrozenCandidateStudyPlanFromEvidence(input = {}) {
  const source = validateVNextFrozenCandidateSource(input.sourceSnapshot);
  const protocol = verifyVNextAblationProtocolFromDisk({
    protocol: input.protocol,
    packageRoot: input.packageRoot ?? PACKAGE_ROOT
  });
  const target = validateVNextFrozenCandidateTarget({
    role: input.role,
    protocol: input.protocol,
    taskPack: input.taskPack,
    taskMaterialBundle: input.taskMaterialBundle
  });
  const runtime = validateCodexOAuthAuthorityRecord(input.runtimeAuthority);
  const implementation = implementationManifest(input.packageRoot);
  const innerImplementation = resolveAdaptiveRecursiveV2Implementation({
    packageRoot: input.packageRoot ?? PACKAGE_ROOT
  });
  const prerequisite = input.role === 'final'
    ? validateVNextFrozenCandidatePrerequisite(input.transferPrerequisite)
    : { status: input.transferPrerequisite == null ? 'OK' : 'REFUSED' };
  const custody = input.custodyBinding == null
    ? { status: 'OK', binding: null }
    : verifyVNextFrozenCandidateCustodyBinding({
        binding: input.custodyBinding,
        protocol: input.protocol,
        sourceSnapshot: input.sourceSnapshot,
        transferPrerequisite: input.transferPrerequisite
      });
  const directory = studyDirectory(input.proofHome, input.studyId, { create: true });
  for (const boundary of [source, protocol, target, runtime, implementation,
    innerImplementation, prerequisite, custody]) {
    if (boundary.status !== 'OK') return boundary;
  }
  if (!directory || !isSafeId(input.runId)
      || !Number.isFinite(Date.parse(input.createdAt))
      || runtime.record.requestedModel !== 'gpt-5.6-sol'
      || runtime.record.reasoningEffort !== 'high'
      || !Number.isSafeInteger(input.historicalTokenEstimate)
      || input.historicalTokenEstimate < 1
      || (input.custodyBinding != null && input.role !== 'final')
      || realpathSync(resolve(input.proofHome)) === source.snapshot.sourceHome) {
    return refused(
      'FROZEN_CANDIDATE_PLAN_INPUT_INVALID',
      'Planning requires separate source/target homes, exact Sol/high OAuth, a verifier-owned source, one eligible target, and current implementation.'
    );
  }
  const bundleBytes = canonicalBytes(input.taskMaterialBundle);
  const bundleWrite = immutableWrite(join(directory, MATERIALS_FILE), bundleBytes);
  if (bundleWrite.status !== 'OK') return bundleWrite;
  const materialized = materializeTarget(
    directory,
    input.taskPack,
    input.taskMaterialBundle
  );
  if (materialized.status !== 'OK') return materialized;
  const split = splitTasks(materialized.tasks, input.taskPack);
  if (split.status !== 'OK') return split;
  const budget = makeBudget(input.studyId);
  if (budget.status !== 'OK') return budget;
  const raw = {
    schemaVersion: 'adaptive-recursive-canary-v2',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    historicalTokenEstimate: input.historicalTokenEstimate,
    replicatesPerArm: 3,
    calibrationRule: 'paired-placebo-upper-bound-v1',
    confirmationRule: 'five-task-adjusted-sign-test-v1',
    ...source.snapshot.frozenCandidate,
    resourceBudgetPolicy: budget.policy,
    perCallBudget: {
      maxInputTokens: INPUT_TOKENS_PER_CALL,
      maxOutputTokens: OUTPUT_TOKENS_PER_CALL
    },
    calibrationTasks: split.calibrationTasks,
    confirmationTasks: split.confirmationTasks
  };
  const unbound = prepareAdaptiveRecursiveCanaryV2Config(raw, {
    packageRoot: input.packageRoot ?? PACKAGE_ROOT,
    artifactRoot: directory,
    runtimeAuthorityRecord: runtime.record,
    evaluatorAuthorityRecord: input.taskPack.evaluatorAuthority,
    approvedPlanSha256: null
  });
  if (unbound.status !== 'OK') return unbound;
  const prepared = prepareAdaptiveRecursiveCanaryV2Config(raw, {
    packageRoot: input.packageRoot ?? PACKAGE_ROOT,
    artifactRoot: directory,
    runtimeAuthorityRecord: runtime.record,
    evaluatorAuthorityRecord: input.taskPack.evaluatorAuthority,
    approvedPlanSha256: unbound.plan.sha256
  });
  if (prepared.status !== 'OK') return prepared;
  const configBytes = canonicalBytes(prepared.config);
  const innerPlanBytes = canonicalBytes(prepared.plan);
  const configWrite = immutableWrite(join(directory, INNER_CONFIG_FILE), configBytes);
  if (configWrite.status !== 'OK') return configWrite;
  const innerPlanWrite = immutableWrite(join(directory, INNER_PLAN_FILE), innerPlanBytes);
  if (innerPlanWrite.status !== 'OK') return innerPlanWrite;
  const materializationBytes = canonicalBytes(materialized.manifest);
  const artifacts = {
    targetMaterials: {
      ...artifactBinding(MATERIALS_FILE, bundleBytes),
      embeddedBundle: structuredClone(input.taskMaterialBundle)
    },
    materialization: artifactBinding(MATERIALIZATION_FILE, materializationBytes),
    innerConfig: artifactBinding(INNER_CONFIG_FILE, configBytes),
    innerPlan: artifactBinding(INNER_PLAN_FILE, innerPlanBytes)
  };
  const core = planCore({
    ...input,
    proofHome: realpathSync(resolve(input.proofHome)),
    source: source.snapshot,
    prerequisite: input.role === 'final' ? prerequisite.prerequisite : null,
    custody: custody.binding,
    target: target.binding,
    targetPack: structuredClone(input.taskPack),
    artifacts,
    inner: {
      planSha256: prepared.plan.sha256,
      configSha256: prepared.plan.configSha256,
      implementationManifestSha256:
        prepared.plan.preparedBindings.implementationManifestSha256,
      taskMaterialSetSha256: prepared.plan.preparedBindings.taskMaterialSetSha256,
      resourceBudgetPolicySha256: budget.policy.policySha256,
      candidateFamilySha256: prepared.config.candidateFamily.familySha256,
      candidateProgramSha256: prepared.config.evolutionRecord.candidate.programSha256,
      candidateFrozenAgainstSource: prepared.config.candidateFamily.familySha256
        === source.snapshot.frozenCandidate.candidateFamily.familySha256,
      noVNextPreparationBinding: prepared.config.vnextBinding == null,
      noPacePolicy: prepared.config.pacePolicy == null
    },
    runtimeAuthority: runtime.record,
    implementation,
    historicalTokenEstimate: input.historicalTokenEstimate
  });
  const plan = { ...core, planSha256: sha256(canonicalVNextJson(core)) };
  const validation = validateVNextFrozenCandidateStudyPlan(plan);
  return validation.status === 'OK'
    ? { status: 'OK', plan, directory, innerConfig: prepared.config, innerPlan: prepared.plan }
    : validation;
}

export function createVNextFrozenCandidateStudyPlan(input = {}) {
  const resolved = resolveVNextFrozenValidationCandidate({
    sourceStore: input.sourceStore,
    sourceRunId: input.sourceRunId
  });
  if (resolved.status !== 'OK') return resolved;
  const prerequisite = input.role === 'final'
    ? resolveVNextFrozenCandidatePrerequisite({
        proofHome: input.transferProofHome,
        studyId: input.transferStudyId
      })
    : { status: input.transferProofHome == null && input.transferStudyId == null
        ? 'OK'
        : 'REFUSED' };
  return prerequisite.status === 'OK'
    ? createVNextFrozenCandidateStudyPlanFromEvidence({
        ...input,
        sourceSnapshot: resolved.snapshot,
        transferPrerequisite: input.role === 'final'
          ? prerequisite.prerequisite
          : null
      })
    : prerequisite;
}

export function persistVNextFrozenCandidateStudyPlan({ directory, plan } = {}) {
  if (validateVNextFrozenCandidateStudyPlan(plan).status !== 'OK'
      || realpathSync(directory) !== studyDirectory(plan.proofHome, plan.studyId)) {
    return refused('FROZEN_CANDIDATE_PLAN_PERSIST_INVALID', 'Plan directory or bytes are unbound.');
  }
  const written = immutableWrite(join(directory, PLAN_FILE), canonicalBytes(plan));
  return written.status === 'OK' ? { ...written, plan } : written;
}

function loadPlanBytes(proofHome, studyId) {
  const directory = studyDirectory(proofHome, studyId);
  if (!directory) return refused('FROZEN_CANDIDATE_DIRECTORY_INVALID', 'Study directory is missing or unsafe.');
  try {
    const bytes = readFileSync(join(directory, PLAN_FILE), 'utf8');
    const plan = JSON.parse(bytes);
    const valid = validateVNextFrozenCandidateStudyPlan(plan);
    return valid.status === 'OK'
      ? { status: 'OK', directory, plan, planBytesSha256: sha256(bytes) }
      : valid;
  } catch {
    return refused('FROZEN_CANDIDATE_PLAN_MISSING', 'Frozen-candidate plan is missing or malformed.');
  }
}

export function loadVNextFrozenCandidateStudyPlan({ proofHome, studyId } = {}) {
  const loaded = loadPlanBytes(proofHome, studyId);
  if (loaded.status !== 'OK') return loaded;
  const current = implementationManifest();
  if (current.status !== 'OK'
      || current.implementationSha256 !== loaded.plan.implementationSha256
      || canonicalVNextJson(current.manifest)
        !== canonicalVNextJson(loaded.plan.implementationManifest)) {
    return refused('FROZEN_CANDIDATE_IMPLEMENTATION_DRIFT', 'Implementation changed after exact-plan approval.');
  }
  const configFile = readBinding(loaded.directory, loaded.plan.artifacts.innerConfig);
  const innerPlanFile = readBinding(loaded.directory, loaded.plan.artifacts.innerPlan);
  const materialsFile = readBinding(loaded.directory, loaded.plan.artifacts.targetMaterials);
  const materializationFile = readBinding(loaded.directory, loaded.plan.artifacts.materialization);
  if (!configFile || !innerPlanFile || !materialsFile || !materializationFile) {
    return refused('FROZEN_CANDIDATE_ARTIFACT_DRIFT', 'One or more sealed planning artifacts changed.');
  }
  try {
    const config = JSON.parse(configFile.bytes);
    const innerPlan = JSON.parse(innerPlanFile.bytes);
    const materials = JSON.parse(materialsFile.bytes);
    const materialization = JSON.parse(materializationFile.bytes);
    const validation = validateAdaptiveRecursiveCanaryV2Config(config);
    if (!validation.ok
        || validation.plan.sha256 !== loaded.plan.inner.planSha256
        || canonicalVNextJson(validation.plan) !== canonicalVNextJson(innerPlan)
        || canonicalVNextJson(materials)
          !== canonicalVNextJson(loaded.plan.artifacts.targetMaterials.embeddedBundle)
        || materialization.materializationSha256
          !== sha256(canonicalVNextJson((({ materializationSha256, ...core }) => core)(materialization)))
        || config.candidateFamily.familySha256
          !== loaded.plan.source.frozenCandidate.candidateFamily.familySha256
        || config.evolutionRecord.evolutionSha256
          !== loaded.plan.source.frozenCandidate.evolutionRecord.evolutionSha256
        || config.vnextBinding != null || config.pacePolicy != null) {
      return refused('FROZEN_CANDIDATE_INNER_REPLAY_FAILED', 'Inner V2 plan, config, candidate, or materials failed replay.');
    }
    return { ...loaded, config, innerPlan, materials, materialization };
  } catch (error) {
    return refused('FROZEN_CANDIDATE_ARTIFACT_PARSE_FAILED', error.message);
  }
}

function verifySourceAgainstPlan(plan) {
  if (plan.custody !== null) {
    const replay = verifyVNextFrozenCandidateCustodyBinding({
      binding: plan.custody,
      protocol: plan.protocol,
      sourceSnapshot: plan.source,
      transferPrerequisite: plan.prerequisite
    });
    return replay.status === 'OK'
      ? { status: 'OK', custody: replay }
      : replay;
  }
  const sourceStore = createStore(plan.source.sourceHome);
  const source = resolveVNextFrozenValidationCandidate({
    sourceStore,
    sourceRunId: plan.source.sourceRunId
  });
  return source.status === 'OK'
    && canonicalVNextJson(source.snapshot) === canonicalVNextJson(plan.source)
    ? { status: 'OK', source }
    : refused('FROZEN_CANDIDATE_SOURCE_DRIFT', 'Validation source no longer replays to the approved candidate.');
}

function verifyPrerequisiteAgainstPlan(plan) {
  if (plan.role === 'transfer') return plan.prerequisite == null
    ? { status: 'OK' }
    : refused('FROZEN_CANDIDATE_PREREQUISITE_UNEXPECTED', 'Transfer cannot depend on another transfer result.');
  if (plan.custody !== null) {
    const replay = verifyVNextFrozenCandidateCustodyBinding({
      binding: plan.custody,
      protocol: plan.protocol,
      sourceSnapshot: plan.source,
      transferPrerequisite: plan.prerequisite
    });
    return replay.status === 'OK'
      ? { status: 'OK', custody: replay }
      : replay;
  }
  const replay = resolveVNextFrozenCandidatePrerequisite({
    proofHome: plan.prerequisite.proofHome,
    studyId: plan.prerequisite.studyId
  });
  return replay.status === 'OK'
    && canonicalVNextJson(replay.prerequisite)
      === canonicalVNextJson(plan.prerequisite)
    ? { status: 'OK', replay }
    : refused('FROZEN_CANDIDATE_PREREQUISITE_DRIFT', 'Transfer prerequisite no longer replays against the final plan.');
}

function publicPlanSummary(plan) {
  return {
    schemaVersion: 'loop-factory-vnext-frozen-candidate-public-plan-v1',
    studyId: plan.studyId,
    runId: plan.runId,
    role: plan.role,
    planSha256: plan.planSha256,
    protocolSha256: plan.protocol.protocolSha256,
    sourceSnapshotSha256: plan.source.sourceSnapshotSha256,
    frozenCandidateSha256: plan.source.frozenCandidateSha256,
    targetPackSha256: plan.target.packSha256,
    targetMaterialBundleSha256: plan.target.materialBundleSha256,
    baselineFailureSetSha256: plan.target.baselineFailureSetSha256,
    prerequisiteSha256: plan.prerequisite?.prerequisiteSha256 ?? null,
    exposure: structuredClone(plan.exposure),
    authority: structuredClone(plan.authority),
    finalTaskOrOracleBytesIncluded: false
  };
}

function publicStageSummary(record) {
  if (!record) return null;
  const summary = structuredClone(record.summary ?? null);
  if (summary) delete summary.taskEffects;
  return {
    stage: record.stage,
    analysisSha256: record.analysisSha256,
    summary,
    gates: structuredClone(record.gates ?? null),
    qualified: record.qualified ?? null,
    causalPass: record.causalPass ?? null
  };
}

function publicVerificationSummary(verification) {
  return {
    schemaVersion: 'loop-factory-vnext-frozen-candidate-public-verification-v1',
    runId: verification.runId,
    status: verification.status,
    runDisposition: verification.runDisposition,
    experimentValid: verification.experimentValid,
    calibrationQualified: verification.calibrationQualified,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible,
    promotionEnabled: verification.promotionEnabled,
    modelAuthority: structuredClone(verification.modelAuthority),
    gates: structuredClone(verification.gates),
    verifierEvidenceSha256: verification.evidenceSha256,
    tokenUsage: structuredClone(verification.tokenUsage),
    calibration: publicStageSummary(verification.calibrationAnalysis),
    confirmation: publicStageSummary(verification.confirmationAnalysis),
    paceDisposition: verification.paceGateRecord?.disposition ?? null,
    reasons: [...verification.reasons],
    finalTaskOrOracleBytesIncluded: false
  };
}

function launchCore(plan, startedAt) {
  return {
    schemaVersion: 'loop-factory-vnext-frozen-candidate-launch-v1',
    studyId: plan.studyId,
    runId: plan.runId,
    planSha256: plan.planSha256,
    startedAt,
    executionAuthority: 'operator-exact-plan-sha256',
    retriesAuthorized: false,
    candidateRegenerated: false
  };
}

export function runVNextFrozenCandidateStudy({
  proofHome,
  studyId,
  approvedPlanSha256,
  env = process.env,
  worker = null,
  clock = () => new Date().toISOString(),
  leaseClock = null
} = {}) {
  const loaded = loadVNextFrozenCandidateStudyPlan({ proofHome, studyId });
  if (loaded.status !== 'OK') return loaded;
  const { plan, directory, config } = loaded;
  const protocolReplay = verifyVNextAblationProtocolFromDisk({
    protocol: plan.protocol,
    packageRoot: PACKAGE_ROOT
  });
  if (protocolReplay.status !== 'OK') return protocolReplay;
  const store = createStore(plan.proofHome);
  if (approvedPlanSha256 !== plan.planSha256
      || existsSync(join(directory, LAUNCH_FILE))
      || existsSync(join(directory, RESULT_FILE))
      || store.exists(plan.runId)) {
    return refused(
      approvedPlanSha256 !== plan.planSha256
        ? 'FROZEN_CANDIDATE_APPROVAL_MISMATCH'
        : 'FROZEN_CANDIDATE_NOT_FRESH',
      'The exact approved study may launch once and never retry.'
    );
  }
  const source = verifySourceAgainstPlan(plan);
  const prerequisite = verifyPrerequisiteAgainstPlan(plan);
  const before = noImportSurface(plan.proofHome);
  if (source.status !== 'OK' || prerequisite.status !== 'OK'
      || !before.adaptiveMemoryAbsent || !before.evidenceBankAbsent) {
    return source.status === 'OK' && prerequisite.status === 'OK'
      ? refused('FROZEN_CANDIDATE_IMPORT_SURFACE_NOT_CLEAN', 'Target proof home already contains an adaptive catalog or VNext evidence bank.')
      : (source.status !== 'OK' ? source : prerequisite);
  }
  const startedAt = clock();
  const launchPayload = launchCore(plan, startedAt);
  const launch = {
    ...launchPayload,
    launchSha256: sha256(canonicalVNextJson(launchPayload))
  };
  const launched = immutableWrite(join(directory, LAUNCH_FILE), canonicalBytes(launch));
  if (launched.status !== 'OK') return launched;
  const sealedEnv = {
    ...env,
    SUPER_LOOP_ALLOW_EXEC: '1',
    SUPER_LOOP_REQUIRE_CHATGPT_OAUTH: '1',
    SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256:
      config.runtimeAuthority.authoritySha256,
    SUPER_LOOP_CODEX_EXECUTABLE_SHA256: config.runtimeAuthority.binary.sha256
  };
  let runnerResult;
  try {
    runnerResult = runAdaptiveRecursiveCanaryV2WithLease(store, config, {
      runId: plan.runId,
      worker: worker ?? ((contract) => adaptiveRecursiveCanaryWorker(contract, sealedEnv)),
      shouldStop: () => existsSync(join(store.runDir(plan.runId), 'OPERATOR_STOP')),
      clock,
      leaseClock: leaseClock ?? clock
    });
  } catch (error) {
    runnerResult = {
      status: 'THREW',
      code: error.code || 'FROZEN_CANDIDATE_RUNNER_THREW',
      message: error.message
    };
  }
  const verification = store.exists(plan.runId)
    ? verifyAdaptiveRecursiveCanaryV2Run(store, plan.runId)
    : null;
  const lease = store.exists(plan.runId)
    ? verifyAdaptiveRecursiveVNextLeaseReceipt(store, plan.runId)
    : null;
  const after = noImportSurface(plan.proofHome);
  const completedAt = clock();
  const resultCore = {
    schemaVersion: VNEXT_FROZEN_CANDIDATE_STUDY_RESULT_SCHEMA,
    studyId: plan.studyId,
    runId: plan.runId,
    role: plan.role,
    planSha256: plan.planSha256,
    launchSha256: launch.launchSha256,
    startedAt,
    completedAt,
    runnerStatus: runnerResult?.status ?? 'UNKNOWN',
    runnerCode: runnerResult?.code ?? null,
    runDisposition: verification?.runDisposition ?? null,
    experimentValid: verification?.experimentValid === true,
    causalPass: verification?.causalPass === true,
    activationEligible: verification?.activationEligible === true,
    verifierEvidenceSha256: verification?.evidenceSha256 ?? null,
    leaseEvidenceSha256: lease?.status === 'OK' ? lease.evidenceSha256 : null,
    tokenUsage: verification?.tokenUsage ?? null,
    sourceSnapshotSha256: plan.source.sourceSnapshotSha256,
    frozenCandidateSha256: plan.source.frozenCandidateSha256,
    targetPackSha256: plan.target.packSha256,
    authoritySurfaceBefore: before,
    authoritySurfaceAfter: after,
    candidateRegenerated: false,
    catalogImported: false,
    evidenceBankImported: false,
    promotionAuthorized: false
  };
  const result = {
    ...resultCore,
    resultSha256: sha256(canonicalVNextJson(resultCore))
  };
  const persisted = immutableWrite(join(directory, RESULT_FILE), canonicalBytes(result));
  return persisted.status === 'OK'
    ? verifyVNextFrozenCandidateStudyFromDisk({ proofHome, studyId })
    : persisted;
}

export function verifyVNextFrozenCandidateStudyFromDisk({ proofHome, studyId } = {}) {
  const loaded = loadVNextFrozenCandidateStudyPlan({ proofHome, studyId });
  if (loaded.status !== 'OK') return loaded;
  let launch;
  let result;
  try {
    launch = JSON.parse(readFileSync(join(loaded.directory, LAUNCH_FILE), 'utf8'));
    result = JSON.parse(readFileSync(join(loaded.directory, RESULT_FILE), 'utf8'));
  } catch {
    return refused('FROZEN_CANDIDATE_RESULT_MISSING', 'Launch or result receipt is missing; the run must not be retried.');
  }
  const plan = loaded.plan;
  const source = verifySourceAgainstPlan(plan);
  const prerequisite = verifyPrerequisiteAgainstPlan(plan);
  const store = createStore(plan.proofHome);
  const verification = verifyAdaptiveRecursiveCanaryV2Run(store, plan.runId);
  const lease = verifyAdaptiveRecursiveVNextLeaseReceipt(store, plan.runId);
  const state = store.load(plan.runId);
  const surface = noImportSurface(plan.proofHome);
  const launchPayload = structuredClone(launch);
  delete launchPayload.launchSha256;
  const resultPayload = structuredClone(result);
  delete resultPayload.resultSha256;
  const valid = exactKeys(launch, [
    'schemaVersion', 'studyId', 'runId', 'planSha256', 'startedAt',
    'executionAuthority', 'retriesAuthorized', 'candidateRegenerated',
    'launchSha256'
  ]) && exactKeys(result, [
    'schemaVersion', 'studyId', 'runId', 'role', 'planSha256',
    'launchSha256', 'startedAt', 'completedAt', 'runnerStatus',
    'runnerCode', 'runDisposition', 'experimentValid', 'causalPass',
    'activationEligible', 'verifierEvidenceSha256', 'leaseEvidenceSha256',
    'tokenUsage', 'sourceSnapshotSha256', 'frozenCandidateSha256',
    'targetPackSha256', 'authoritySurfaceBefore', 'authoritySurfaceAfter',
    'candidateRegenerated', 'catalogImported', 'evidenceBankImported',
    'promotionAuthorized', 'resultSha256'
  ]) && launch.schemaVersion === 'loop-factory-vnext-frozen-candidate-launch-v1'
    && result.schemaVersion === VNEXT_FROZEN_CANDIDATE_STUDY_RESULT_SCHEMA
    && launch.studyId === plan.studyId && launch.runId === plan.runId
    && launch.planSha256 === plan.planSha256
    && launch.executionAuthority === 'operator-exact-plan-sha256'
    && launch.retriesAuthorized === false && launch.candidateRegenerated === false
    && launch.launchSha256 === sha256(canonicalVNextJson(launchPayload))
    && result.studyId === plan.studyId && result.runId === plan.runId
    && result.role === plan.role && result.planSha256 === plan.planSha256
    && result.launchSha256 === launch.launchSha256
    && result.resultSha256 === sha256(canonicalVNextJson(resultPayload))
    && source.status === 'OK'
    && prerequisite.status === 'OK'
    && verification.experimentValid === true
    && lease.status === 'OK'
    && result.experimentValid === true
    && result.causalPass === verification.causalPass
    && result.activationEligible === verification.activationEligible
    && result.verifierEvidenceSha256 === verification.evidenceSha256
    && result.leaseEvidenceSha256 === lease.evidenceSha256
    && canonicalVNextJson(result.tokenUsage)
      === canonicalVNextJson(verification.tokenUsage)
    && result.sourceSnapshotSha256 === plan.source.sourceSnapshotSha256
    && result.frozenCandidateSha256 === plan.source.frozenCandidateSha256
    && result.targetPackSha256 === plan.target.packSha256
    && result.candidateRegenerated === false
    && result.catalogImported === false
    && result.evidenceBankImported === false
    && result.promotionAuthorized === false
    && result.authoritySurfaceBefore?.adaptiveMemoryAbsent === true
    && result.authoritySurfaceBefore?.evidenceBankAbsent === true
    && result.authoritySurfaceAfter?.adaptiveMemoryAbsent === true
    && result.authoritySurfaceAfter?.evidenceBankAbsent === true
    && surface.adaptiveMemoryAbsent === true && surface.evidenceBankAbsent === true
    && state?.promotion?.enabled === false && state?.promotion?.recorded === false;
  if (!valid) {
    return refused(
      'FROZEN_CANDIDATE_STUDY_REPLAY_FAILED',
      'Source, target, run receipts, lease, token usage, or no-import/no-promotion authority failed replay.'
    );
  }
  const evidence = {
    planSha256: plan.planSha256,
    launchSha256: launch.launchSha256,
    resultSha256: result.resultSha256,
    sourceSnapshotSha256: source.source.snapshot.sourceSnapshotSha256,
    runnerEvidenceSha256: verification.evidenceSha256,
    leaseEvidenceSha256: lease.evidenceSha256
  };
  return {
    status: 'OK',
    outcome: verification.causalPass ? 'PASS' : 'VALID_FAIL',
    generalizedClaimEligible: plan.role === 'final'
      && prerequisite.status === 'OK'
      && verification.causalPass === true,
    plan: publicPlanSummary(plan),
    result,
    verification: publicVerificationSummary(verification),
    lease: lease.receipt,
    evidenceSha256: sha256(canonicalVNextJson(evidence))
  };
}
