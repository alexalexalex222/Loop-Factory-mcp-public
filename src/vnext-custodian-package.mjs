import {
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeId, sha256 } from './util.mjs';
import {
  validateVNextAblationProtocol,
  verifyVNextAblationProtocolFromDisk
} from './vnext-ablation-protocol.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  VNEXT_FROZEN_CANDIDATE_IMPLEMENTATION_PATHS,
  resolveVNextFrozenCandidatePrerequisite,
  resolveVNextFrozenValidationCandidate,
  validateVNextFrozenCandidatePrerequisite,
  validateVNextFrozenCandidateSource
} from './vnext-frozen-candidate-study.mjs';
import {
  VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS
} from './vnext-evaluator-proof.mjs';

export const VNEXT_CUSTODIAN_PACKAGE_SCHEMA =
  'loop-factory-vnext-custodian-package-v1';
export const VNEXT_CUSTODIAN_IMPLEMENTATION_PATHS = Object.freeze([
  ...new Set([
    ...VNEXT_FROZEN_CANDIDATE_IMPLEMENTATION_PATHS,
    ...VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS,
    'src/vnext-custodian-package.mjs',
    'scripts/build-vnext-custodian-package.mjs',
    'scripts/plan-vnext-custodian-final.mjs',
    'scripts/verify-vnext-custodian-package.mjs',
    'src/schemas/vnext-custodian-package-v1.schema.json'
  ])
].sort());

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_FILE = 'CUSTODIAN_PACKAGE_MANIFEST.json';
const HASH_FILE = 'FILES.sha256';
const SUPPORT_FILES = Object.freeze([
  'CUSTODIAN_INPUT_TEMPLATE.json',
  'CUSTODIAN_RUNBOOK.md',
  'frozen-protocol.json',
  'frozen-source-snapshot.json',
  'transfer-prerequisite.json'
]);
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

function canonicalBytes(value) {
  return `${canonicalVNextJson(value)}\n`;
}

function implementationFiles(packageRoot = PACKAGE_ROOT) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const files = VNEXT_CUSTODIAN_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full) || !existsSync(full)
          || lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) {
        throw new Error(`Custodian implementation dependency is missing or unsafe: ${path}`);
      }
      const bytes = readFileSync(full);
      return { path, bytes: bytes.length, sha256: sha256(bytes), full };
    });
    return {
      status: 'OK',
      files,
      implementationSha256: sha256(canonicalVNextJson(files.map(({ full, ...row }) => row)))
    };
  } catch (error) {
    return refused('CUSTODIAN_IMPLEMENTATION_INVALID', error.message);
  }
}

function validFileRecords(files) {
  return Array.isArray(files) && files.length > 0
    && files.every((row) => exactKeys(row, ['path', 'bytes', 'sha256'])
      && typeof row.path === 'string' && row.path.length > 0
      && !isAbsolute(row.path) && !row.path.split('/').includes('..')
      && Number.isSafeInteger(row.bytes) && row.bytes >= 0
      && SHA256.test(String(row.sha256 || '')))
    && new Set(files.map((row) => row.path)).size === files.length
    && canonicalVNextJson(files)
      === canonicalVNextJson([...files].sort((left, right) => left.path.localeCompare(right.path)));
}

function manifestCore(input) {
  return {
    schemaVersion: VNEXT_CUSTODIAN_PACKAGE_SCHEMA,
    packageId: input.packageId,
    generatedAt: input.generatedAt,
    protocol: {
      protocolId: input.protocol.protocolId,
      protocolSha256: input.protocol.protocolSha256,
      identityLedgerSha256: input.protocol.identityLedger.ledgerSha256,
      implementationSha256: input.protocol.implementationSha256
    },
    source: {
      sourceHome: input.source.sourceHome,
      sourceRunId: input.source.sourceRunId,
      sourceSnapshotSha256: input.source.sourceSnapshotSha256,
      frozenCandidateSha256: input.source.frozenCandidateSha256,
      sourceVerifierEvidenceSha256: input.source.sourceVerifierEvidenceSha256,
      sourceLeaseEvidenceSha256: input.source.sourceLeaseEvidenceSha256
    },
    transfer: structuredClone(input.prerequisite),
    executionContract: {
      role: 'final',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      authMode: 'chatgpt-oauth',
      maximumCalls: 120,
      retries: 0,
      fallbackModels: [],
      hardTotalTokenCeiling: 4800000,
      hardUsdCeiling: 0,
      billingMode: 'subscription-no-metered-usd',
      candidateRegenerated: false,
      promotionAuthorized: false
    },
    custodyBoundary: {
      implementationAgentMayAccessFinalTaskBytes: false,
      finalTaskBytesIncluded: false,
      finalTaskPackSha256: null,
      finalOracleSha256: null,
      finalPackBuilderAuthority: 'external-custodian',
      finalOpeningsAuthorized: 1,
      repeatedFinalRunsAuthorized: false,
      validationSourceReplayedAtBuild: true,
      transferPrerequisiteReplayedAtBuild: true,
      relocatableAfterBuild: true
    },
    implementationSha256: input.implementationSha256,
    files: input.files,
    fileSetSha256: sha256(canonicalVNextJson(input.files))
  };
}

export function createVNextCustodianPackageManifest(input = {}) {
  if (!isSafeId(input.packageId)
      || !Number.isFinite(Date.parse(input.generatedAt))
      || validateVNextAblationProtocol(input.protocol).status !== 'OK'
      || validateVNextFrozenCandidateSource(input.source).status !== 'OK'
      || validateVNextFrozenCandidatePrerequisite(input.prerequisite).status !== 'OK'
      || input.prerequisite.protocolSha256 !== input.protocol.protocolSha256
      || input.prerequisite.sourceSnapshotSha256 !== input.source.sourceSnapshotSha256
      || input.prerequisite.frozenCandidateSha256 !== input.source.frozenCandidateSha256
      || !SHA256.test(String(input.implementationSha256 || ''))
      || !validFileRecords(input.files)) {
    return refused(
      'CUSTODIAN_MANIFEST_INPUT_INVALID',
      'Custodian manifest requires one exact protocol, validation candidate, causal transfer proof, and sorted implementation file set.'
    );
  }
  const core = manifestCore(input);
  const manifest = {
    ...core,
    manifestSha256: sha256(canonicalVNextJson(core))
  };
  return validateVNextCustodianPackageManifest(manifest).status === 'OK'
    ? { status: 'OK', manifest }
    : refused('CUSTODIAN_MANIFEST_INVALID', 'Constructed custodian manifest failed replay.');
}

export function validateVNextCustodianPackageManifest(manifest) {
  if (!exactKeys(manifest, [
    'schemaVersion', 'packageId', 'generatedAt', 'protocol', 'source',
    'transfer', 'executionContract', 'custodyBoundary',
    'implementationSha256', 'files', 'fileSetSha256', 'manifestSha256'
  ]) || manifest.schemaVersion !== VNEXT_CUSTODIAN_PACKAGE_SCHEMA
      || !isSafeId(manifest.packageId)
      || !Number.isFinite(Date.parse(manifest.generatedAt))
      || !SHA256.test(String(manifest.protocol?.protocolSha256 || ''))
      || !SHA256.test(String(manifest.protocol?.identityLedgerSha256 || ''))
      || validateVNextFrozenCandidatePrerequisite(manifest.transfer).status !== 'OK'
      || manifest.transfer.protocolSha256 !== manifest.protocol.protocolSha256
      || manifest.transfer.sourceSnapshotSha256 !== manifest.source?.sourceSnapshotSha256
      || manifest.transfer.frozenCandidateSha256 !== manifest.source?.frozenCandidateSha256
      || manifest.executionContract?.role !== 'final'
      || manifest.executionContract?.model !== 'gpt-5.6-sol'
      || manifest.executionContract?.reasoningEffort !== 'high'
      || manifest.executionContract?.maximumCalls !== 120
      || manifest.executionContract?.retries !== 0
      || manifest.executionContract?.fallbackModels?.length !== 0
      || manifest.executionContract?.hardTotalTokenCeiling !== 4800000
      || manifest.executionContract?.hardUsdCeiling !== 0
      || manifest.executionContract?.candidateRegenerated !== false
      || manifest.executionContract?.promotionAuthorized !== false
      || manifest.custodyBoundary?.implementationAgentMayAccessFinalTaskBytes !== false
      || manifest.custodyBoundary?.finalTaskBytesIncluded !== false
      || manifest.custodyBoundary?.finalTaskPackSha256 !== null
      || manifest.custodyBoundary?.finalOracleSha256 !== null
      || manifest.custodyBoundary?.finalPackBuilderAuthority !== 'external-custodian'
      || manifest.custodyBoundary?.finalOpeningsAuthorized !== 1
      || manifest.custodyBoundary?.repeatedFinalRunsAuthorized !== false
      || manifest.custodyBoundary?.validationSourceReplayedAtBuild !== true
      || manifest.custodyBoundary?.transferPrerequisiteReplayedAtBuild !== true
      || manifest.custodyBoundary?.relocatableAfterBuild !== true
      || !SHA256.test(String(manifest.implementationSha256 || ''))
      || !validFileRecords(manifest.files)
      || manifest.fileSetSha256 !== sha256(canonicalVNextJson(manifest.files))
      || !SHA256.test(String(manifest.manifestSha256 || ''))) {
    return refused('CUSTODIAN_MANIFEST_INVALID', 'Custodian manifest shape or no-final-data boundary is invalid.');
  }
  const core = structuredClone(manifest);
  delete core.manifestSha256;
  return manifest.manifestSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', manifest }
    : refused('CUSTODIAN_MANIFEST_TAMPERED', 'Custodian manifest hash failed replay.');
}

function copyImplementation(packageRoot, outputRoot, files) {
  for (const file of files) {
    const source = resolve(packageRoot, file.path);
    const target = resolve(outputRoot, file.path);
    if (!within(outputRoot, target)) return refused('CUSTODIAN_COPY_PATH_INVALID', 'Implementation path escaped the package.');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  return { status: 'OK' };
}

export function renderVNextCustodianRunbook() {
  return [
    '# External Custodian Runbook',
    '',
    'This capsule contains no final task, answer, or oracle bytes.',
    'The custodian creates one new 10-cluster `final` pack with builder kind',
    '`external-custodian`, then plans and runs the exact frozen candidate once.',
    '',
    '## 1. Verify this capsule',
    '',
    '```sh',
    'node scripts/verify-vnext-custodian-package.mjs --package-root "$PWD"',
    '```',
    '',
    '## 2. Plan without launching',
    '',
    '```sh',
    [
      'node scripts/plan-vnext-custodian-final.mjs',
      '--package-root "$PWD"',
      '--home <NEW_CUSTODIAN_PROOF_HOME>',
      '--study <FINAL_STUDY_ID>',
      '--run-id <FINAL_RUN_ID>',
      '--task-pack <FINAL_TASK_PACK_JSON>',
      '--materials <FINAL_MATERIAL_BUNDLE_JSON>'
    ].join(' \\\n  '),
    '```',
    '',
    'Confirm the printed plan SHA-256 and the 120-call, 4,800,000-token ledger ceiling.',
    '',
    '## 3. Launch exactly once',
    '',
    'Run only the exact launch command printed by step 2. Do not retry a failed,',
    'interrupted, rejected, or completed final study.',
    '',
    '## 4. Verify independently',
    '',
    'Run the exact verifier command printed by step 2. Return the verifier JSON and',
    'this package manifest SHA-256. Do not send final task or oracle bytes back to',
    'the implementation agent.',
    ''
  ].join('\n');
}

function supportPayloads({ protocol, source, prerequisite }) {
  return {
    'frozen-protocol.json': canonicalBytes(protocol),
    'frozen-source-snapshot.json': canonicalBytes(source),
    'transfer-prerequisite.json': canonicalBytes(prerequisite),
    'CUSTODIAN_INPUT_TEMPLATE.json': canonicalBytes({
      schemaVersion: 'loop-factory-vnext-custodian-input-template-v1',
      finalTaskPackPath: '<FINAL_TASK_PACK_JSON>',
      finalMaterialBundlePath: '<FINAL_MATERIAL_BUNDLE_JSON>',
      custodianPackageRoot: '<EXTRACTED_CUSTODIAN_PACKAGE_ROOT>',
      newProofHome: '<NEW_CUSTODIAN_PROOF_HOME>',
      finalStudyId: '<FINAL_STUDY_ID>',
      finalRunId: '<FINAL_RUN_ID>',
      finalPackRequirements: {
        partition: 'final',
        builderKind: 'external-custodian',
        taskClusters: 10,
        qualificationClusters: 5,
        confirmationClusters: 5,
        disjointFromInternalIdentityLedger: true,
        referenceContentImported: false
      }
    }),
    'CUSTODIAN_RUNBOOK.md': `${renderVNextCustodianRunbook()}\n`
  };
}

function fileRecords(root, paths) {
  return paths.map((path) => {
    const full = resolve(root, path);
    const bytes = readFileSync(full);
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function assembleVNextCustodianPackage({
  packageRoot = PACKAGE_ROOT,
  outputRoot,
  packageId,
  generatedAt,
  protocol,
  sourceSnapshot,
  transferPrerequisite
} = {}) {
  const implementation = implementationFiles(packageRoot);
  const validProtocol = verifyVNextAblationProtocolFromDisk({
    protocol,
    packageRoot
  });
  const source = validateVNextFrozenCandidateSource(sourceSnapshot).status === 'OK'
    ? { status: 'OK', snapshot: sourceSnapshot }
    : refused('CUSTODIAN_SOURCE_EVIDENCE_INVALID', 'Frozen validation source failed replay.');
  const transfer = validateVNextFrozenCandidatePrerequisite(transferPrerequisite).status === 'OK'
    ? { status: 'OK', prerequisite: transferPrerequisite }
    : refused('CUSTODIAN_TRANSFER_EVIDENCE_INVALID', 'Transfer prerequisite failed replay.');
  if (!isAbsolute(String(outputRoot || '')) || existsSync(outputRoot)
      || !isSafeId(packageId) || !Number.isFinite(Date.parse(generatedAt))
      || implementation.status !== 'OK' || validProtocol.status !== 'OK'
      || source.status !== 'OK' || transfer.status !== 'OK'
      || transfer.prerequisite.protocolSha256 !== protocol.protocolSha256
      || transfer.prerequisite.sourceSnapshotSha256
        !== source.snapshot.sourceSnapshotSha256
      || transfer.prerequisite.frozenCandidateSha256
        !== source.snapshot.frozenCandidateSha256) {
    return refused(
      'CUSTODIAN_PACKAGE_INPUT_INVALID',
      'Package build requires a new output path, frozen protocol, verifier-owned validation source, and successful exact transfer proof.'
    );
  }
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const root = realpathSync(outputRoot);
  const copied = copyImplementation(
    realpathSync(resolve(packageRoot)),
    root,
    implementation.files
  );
  if (copied.status !== 'OK') return copied;
  const support = supportPayloads({
    protocol,
    source: source.snapshot,
    prerequisite: transfer.prerequisite
  });
  for (const [path, bytes] of Object.entries(support)) {
    writeFileSync(join(root, path), bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const paths = [
    ...implementation.files.map((row) => row.path),
    ...SUPPORT_FILES
  ].sort();
  const records = fileRecords(root, paths);
  const built = createVNextCustodianPackageManifest({
    packageId,
    generatedAt,
    protocol,
    source: source.snapshot,
    prerequisite: transfer.prerequisite,
    implementationSha256: implementation.implementationSha256,
    files: records
  });
  if (built.status !== 'OK') return built;
  writeFileSync(join(root, MANIFEST_FILE), canonicalBytes(built.manifest), {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
  const allRecords = fileRecords(root, [...paths, MANIFEST_FILE].sort());
  writeFileSync(join(root, HASH_FILE), allRecords
    .map((row) => `${row.sha256}  ${row.path}`)
    .join('\n') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return verifyVNextCustodianPackage({ packageRoot: root });
}

export function buildVNextCustodianPackage({
  packageRoot = PACKAGE_ROOT,
  outputRoot,
  packageId,
  generatedAt,
  protocol,
  sourceStore,
  sourceRunId,
  transferProofHome,
  transferStudyId
} = {}) {
  const validProtocol = verifyVNextAblationProtocolFromDisk({
    protocol,
    packageRoot
  });
  if (validProtocol.status !== 'OK') return validProtocol;
  const source = resolveVNextFrozenValidationCandidate({ sourceStore, sourceRunId });
  if (source.status !== 'OK') return source;
  const transfer = resolveVNextFrozenCandidatePrerequisite({
    proofHome: transferProofHome,
    studyId: transferStudyId
  });
  if (transfer.status !== 'OK') return transfer;
  return assembleVNextCustodianPackage({
    packageRoot,
    outputRoot,
    packageId,
    generatedAt,
    protocol,
    sourceSnapshot: source.snapshot,
    transferPrerequisite: transfer.prerequisite
  });
}

function collectPackageFiles(root, directory = root, rows = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink in custodian package: ${full}`);
    if (entry.isDirectory()) collectPackageFiles(root, full, rows);
    else if (entry.isFile()) rows.push(relative(root, full).replaceAll('\\', '/'));
    else throw new Error(`unsupported custodian package entry: ${full}`);
  }
  return rows;
}

export function verifyVNextCustodianPackage({ packageRoot } = {}) {
  try {
    if (!isAbsolute(String(packageRoot || ''))) {
      return refused('CUSTODIAN_PACKAGE_PATH_INVALID', 'Package root must be absolute.');
    }
    const root = realpathSync(resolve(packageRoot));
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
    const valid = validateVNextCustodianPackageManifest(manifest);
    if (valid.status !== 'OK') return valid;
    const expectedPaths = [
      ...manifest.files.map((row) => row.path),
      MANIFEST_FILE,
      HASH_FILE
    ].sort();
    const actualPaths = collectPackageFiles(root).sort();
    if (canonicalVNextJson(actualPaths) !== canonicalVNextJson(expectedPaths)) {
      return refused('CUSTODIAN_PACKAGE_FILE_SET_DRIFT', 'Package contains missing or unexpected files.');
    }
    const replayed = fileRecords(root, manifest.files.map((row) => row.path));
    if (canonicalVNextJson(replayed) !== canonicalVNextJson(manifest.files)) {
      return refused('CUSTODIAN_PACKAGE_FILE_HASH_DRIFT', 'Package file bytes failed manifest replay.');
    }
    const manifestRecord = fileRecords(root, [MANIFEST_FILE])[0];
    const expectedHashText = [...manifest.files, manifestRecord]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((row) => `${row.sha256}  ${row.path}`)
      .join('\n') + '\n';
    if (readFileSync(join(root, HASH_FILE), 'utf8') !== expectedHashText) {
      return refused('CUSTODIAN_PACKAGE_HASH_LIST_DRIFT', 'FILES.sha256 failed replay.');
    }
    const protocol = JSON.parse(readFileSync(join(root, 'frozen-protocol.json'), 'utf8'));
    const source = JSON.parse(readFileSync(join(root, 'frozen-source-snapshot.json'), 'utf8'));
    const prerequisite = JSON.parse(readFileSync(join(root, 'transfer-prerequisite.json'), 'utf8'));
    const runbookBytes = readFileSync(join(root, 'CUSTODIAN_RUNBOOK.md'), 'utf8');
    const implementation = implementationFiles(root);
    if (validateVNextAblationProtocol(protocol).status !== 'OK'
        || protocol.protocolSha256 !== manifest.protocol.protocolSha256
        || validateVNextFrozenCandidateSource(source).status !== 'OK'
        || source.sourceSnapshotSha256 !== manifest.source.sourceSnapshotSha256
        || validateVNextFrozenCandidatePrerequisite(prerequisite).status !== 'OK'
        || prerequisite.prerequisiteSha256 !== manifest.transfer.prerequisiteSha256
        || implementation.status !== 'OK'
        || implementation.implementationSha256 !== manifest.implementationSha256) {
      return refused('CUSTODIAN_PACKAGE_SEALED_INPUT_DRIFT', 'Protocol, source, transfer, or implementation failed replay.');
    }
    if (!runbookBytes.includes('--package-root "$PWD"')
        || runbookBytes.includes(source.sourceHome)
        || runbookBytes.includes(prerequisite.proofHome)) {
      return refused(
        'CUSTODIAN_PACKAGE_RUNBOOK_NOT_RELOCATABLE',
        'Runbook must use only the relocated capsule and must not reference builder-machine proof paths.'
      );
    }
    return {
      status: 'OK',
      packageRoot: root,
      manifest,
      finalTaskBytesIncluded: false,
      sourceSnapshotSha256: source.sourceSnapshotSha256,
      transferPrerequisiteSha256: prerequisite.prerequisiteSha256,
      evidenceSha256: sha256(canonicalVNextJson({
        manifestSha256: manifest.manifestSha256,
        fileSetSha256: manifest.fileSetSha256,
        sourceSnapshotSha256: source.sourceSnapshotSha256,
        transferPrerequisiteSha256: prerequisite.prerequisiteSha256
      }))
    };
  } catch (error) {
    return refused('CUSTODIAN_PACKAGE_VERIFY_FAILED', error.message);
  }
}
