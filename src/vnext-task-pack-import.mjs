import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  buildVNextTaskPack,
  loadVNextTaskPackMaterials,
  validateVNextTaskMaterialBundle,
  validateVNextTaskPack
} from './vnext-task-pack.mjs';

export const VNEXT_TASK_PACK_IMPORT_SCHEMA =
  'loop-factory-vnext-task-pack-import-v1';

const LEGACY_SCHEMA = /^adaptive-executable-canary-v[1-4]$/;
const SHA256 = /^[a-f0-9]{64}$/;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...keys].sort());
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readSource(root, path, maximumBytes) {
  if (typeof path !== 'string' || !path || isAbsolute(path)
      || path.includes('\0') || path.split('/').includes('..')) {
    return refused('TASK_PACK_IMPORT_PATH_INVALID', 'Legacy task path is unsafe.');
  }
  const target = resolve(root, path);
  if (!within(root, target) || !existsSync(target)
      || lstatSync(target).isSymbolicLink()
      || realpathSync(target) !== target
      || !lstatSync(target).isFile()) {
    return refused('TASK_PACK_IMPORT_PATH_UNSAFE', `Legacy task path is unavailable: ${path}`);
  }
  const bytes = readFileSync(target);
  return bytes.length <= maximumBytes
    ? { status: 'OK', path, bytes, sha256: sha256(bytes) }
    : refused('TASK_PACK_IMPORT_FILE_TOO_LARGE', `Legacy task file exceeds its cap: ${path}`);
}

function taskDomain(task) {
  const text = [task.id, task.title, task.sourcePath, task.specPath]
    .filter(Boolean).join(' ').toLowerCase();
  if (text.includes('support')) return 'customer-support-agent';
  if (text.includes('summary') || text.includes('summar')) {
    return 'grounded-summarization';
  }
  if (text.includes('review') || text.includes('security')
      || text.includes('refactor')) return 'code-review-agent';
  return 'executable-decision-workflow';
}

function taskId(task) {
  if (isSafeId(task.id)) return task.id;
  return `task-${sha256(String(task.id || task.title || 'legacy-task')).slice(0, 24)}`;
}

function binding(id, source) {
  return {
    id,
    path: source.path,
    sha256: source.sha256
  };
}

function taskFromLegacy(root, task, maximumFileBytes) {
  if (!plainObject(task)
      || !['qualification', 'confirmation'].includes(task.phase)) {
    return refused('TASK_PACK_IMPORT_TASK_INVALID', 'Legacy task identity or phase is invalid.');
  }
  const id = taskId(task);
  const source = readSource(root, task.sourcePath, maximumFileBytes);
  const incident = readSource(root, task.specPath, maximumFileBytes);
  const interfaceFile = readSource(root, task.interfacePath, maximumFileBytes);
  const oracle = readSource(root, task.oraclePath, maximumFileBytes);
  const failed = [source, incident, interfaceFile, oracle]
    .find((item) => item.status !== 'OK');
  if (failed) return failed;
  let interfaceContract;
  try {
    interfaceContract = JSON.parse(interfaceFile.bytes);
  } catch {
    return refused('TASK_PACK_IMPORT_INTERFACE_INVALID', `Interface is not JSON for ${id}.`);
  }
  const domain = taskDomain(task);
  return {
    status: 'OK',
    task: {
      taskId: id,
      clusterId: `cluster-${sha256(id).slice(0, 24)}`,
      domain,
      tags: [...new Set([
        domain,
        task.phase,
        'legacy-executable-canary'
      ])].sort(),
      source: binding(`source-${sha256(`${id}:source`).slice(0, 20)}`, source),
      incident: binding(`incident-${sha256(`${id}:incident`).slice(0, 20)}`, incident),
      interface: binding(`interface-${sha256(`${id}:interface`).slice(0, 20)}`, interfaceFile),
      oracle: binding(`oracle-${sha256(`${id}:oracle`).slice(0, 20)}`, oracle),
      interfaceContractSha256: sha256(canonicalVNextJson(interfaceContract)),
      publicTaskSpecSha256: incident.sha256
    },
    phase: task.phase,
    excludedReferencePath: typeof task.referencePath === 'string'
      ? task.referencePath : null
  };
}

function receiptCore(receipt) {
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  return core;
}

export function importVNextTaskPackFromExecutableCanary({
  artifactRoot,
  sourceConfigBytes,
  packId,
  partition,
  createdAt,
  builderId,
  evaluatorAuthorityRecord = null,
  priorIdentities = [],
  maximumFileBytes = 1024 * 1024
} = {}) {
  try {
    if (!['development', 'validation'].includes(partition)
        || typeof sourceConfigBytes !== 'string'
        || !isSafeId(builderId)) {
      return refused(
        'TASK_PACK_IMPORT_REQUEST_INVALID',
        'Legacy import is restricted to development or validation and requires exact source-config bytes.'
      );
    }
    const sourceConfig = JSON.parse(sourceConfigBytes);
    if (!plainObject(sourceConfig)
        || !LEGACY_SCHEMA.test(String(sourceConfig.schemaVersion || ''))
        || sourceConfig.fixtureOnly !== false
        || !Array.isArray(sourceConfig.tasks)
        || sourceConfig.tasks.length !== 10
        || sourceConfig.tasks.filter((task) => task.phase === 'qualification').length !== 5
        || sourceConfig.tasks.filter((task) => task.phase === 'confirmation').length !== 5) {
      return refused(
        'TASK_PACK_IMPORT_SOURCE_CONFIG_INVALID',
        'Import requires one non-fixture executable-canary config with five qualification and five confirmation tasks.'
      );
    }
    const root = realpathSync(resolve(artifactRoot));
    const converted = sourceConfig.tasks.map((task) => (
      taskFromLegacy(root, task, maximumFileBytes)
    ));
    const failed = converted.find((item) => item.status !== 'OK');
    if (failed) return failed;
    const taskIds = converted.map((item) => item.task.taskId);
    if (new Set(taskIds).size !== taskIds.length) {
      return refused('TASK_PACK_IMPORT_TASK_DUPLICATED', 'Converted task identities are not unique.');
    }
    const built = buildVNextTaskPack({
      artifactRoot: root,
      packId,
      partition,
      createdAt,
      builderAuthority: { id: builderId, kind: 'deterministic-tool' },
      evaluatorAuthorityRecord,
      tasks: converted.map((item) => item.task),
      priorIdentities,
      maximumFileBytes
    });
    if (built.status !== 'OK') return built;
    const loaded = loadVNextTaskPackMaterials({
      artifactRoot: root,
      pack: built.pack,
      maximumFileBytes
    });
    if (loaded.status !== 'OK') return loaded;
    const phases = Object.fromEntries(converted.map((item) => [
      item.task.taskId,
      item.phase
    ]));
    const core = {
      schemaVersion: VNEXT_TASK_PACK_IMPORT_SCHEMA,
      sourceSchemaVersion: sourceConfig.schemaVersion,
      sourceConfigSha256: sha256(sourceConfigBytes),
      packId: built.pack.packId,
      partition: built.pack.partition,
      packSha256: built.pack.packSha256,
      materialBundleSha256: loaded.bundle.bundleSha256,
      taskCount: built.pack.tasks.length,
      qualificationTaskIds: built.pack.tasks
        .filter((task) => phases[task.taskId] === 'qualification')
        .map((task) => task.taskId).sort(),
      confirmationTaskIds: built.pack.tasks
        .filter((task) => phases[task.taskId] === 'confirmation')
        .map((task) => task.taskId).sort(),
      excludedReferencePaths: converted
        .map((item) => item.excludedReferencePath)
        .filter(Boolean).sort(),
      referenceContentImported: false,
      finalPartitionAuthority: false,
      activationAuthority: false
    };
    const receipt = {
      ...core,
      receiptSha256: sha256(canonicalVNextJson(core))
    };
    const verified = verifyVNextTaskPackImport({
      sourceConfigBytes,
      pack: built.pack,
      bundle: loaded.bundle,
      receipt
    });
    return verified.status === 'OK'
      ? {
          status: 'OK',
          sourceConfig,
          pack: built.pack,
          bundle: loaded.bundle,
          identities: built.identities,
          receipt
        }
      : verified;
  } catch (error) {
    return refused('TASK_PACK_IMPORT_FAILED', error.message);
  }
}

export function verifyVNextTaskPackImport({
  sourceConfigBytes,
  pack,
  bundle,
  receipt
} = {}) {
  let sourceConfig;
  try {
    sourceConfig = JSON.parse(sourceConfigBytes);
  } catch {
    return refused('TASK_PACK_IMPORT_SOURCE_CONFIG_INVALID', 'Source config bytes are not JSON.');
  }
  if (!exactKeys(receipt, [
    'schemaVersion', 'sourceSchemaVersion', 'sourceConfigSha256', 'packId',
    'partition', 'packSha256', 'materialBundleSha256', 'taskCount',
    'qualificationTaskIds', 'confirmationTaskIds', 'excludedReferencePaths',
    'referenceContentImported', 'finalPartitionAuthority',
    'activationAuthority', 'receiptSha256'
  ])
      || receipt.schemaVersion !== VNEXT_TASK_PACK_IMPORT_SCHEMA
      || receipt.sourceConfigSha256 !== sha256(sourceConfigBytes)
      || receipt.sourceSchemaVersion !== sourceConfig.schemaVersion
      || !SHA256.test(String(receipt.receiptSha256 || ''))
      || receipt.receiptSha256 !== sha256(canonicalVNextJson(receiptCore(receipt)))
      || receipt.referenceContentImported !== false
      || receipt.finalPartitionAuthority !== false
      || receipt.activationAuthority !== false
      || !['development', 'validation'].includes(receipt.partition)
      || validateVNextTaskPack(pack).status !== 'OK'
      || validateVNextTaskMaterialBundle({ bundle, pack }).status !== 'OK'
      || receipt.packId !== pack.packId
      || receipt.partition !== pack.partition
      || receipt.packSha256 !== pack.packSha256
      || receipt.materialBundleSha256 !== bundle.bundleSha256
      || receipt.taskCount !== 10
      || receipt.taskCount !== pack.tasks.length) {
    return refused('TASK_PACK_IMPORT_RECEIPT_INVALID', 'Imported task pack receipt failed replay.');
  }
  const sourceTasks = new Map(sourceConfig.tasks.map((task) => [taskId(task), task]));
  const expectedQualification = [];
  const expectedConfirmation = [];
  const expectedReferences = [];
  for (const task of pack.tasks) {
    const sourceTask = sourceTasks.get(task.taskId);
    const material = bundle.materials.find((item) => item.taskId === task.taskId);
    if (!sourceTask || !material
        || task.source.path !== sourceTask.sourcePath
        || task.incident.path !== sourceTask.specPath
        || task.interface.path !== sourceTask.interfacePath
        || task.oracle.path !== sourceTask.oraclePath
        || task.publicTaskSpecSha256 !== task.incident.sha256
        || material.source.content.includes(String(sourceTask.referencePath || '\0'))) {
      return refused(
        'TASK_PACK_IMPORT_BINDING_INVALID',
        'Imported task paths, public specification, or reference exclusion drifted.'
      );
    }
    (sourceTask.phase === 'qualification'
      ? expectedQualification : expectedConfirmation).push(task.taskId);
    if (typeof sourceTask.referencePath === 'string') {
      expectedReferences.push(sourceTask.referencePath);
    }
  }
  expectedQualification.sort();
  expectedConfirmation.sort();
  expectedReferences.sort();
  if (canonicalVNextJson(receipt.qualificationTaskIds)
        !== canonicalVNextJson(expectedQualification)
      || canonicalVNextJson(receipt.confirmationTaskIds)
        !== canonicalVNextJson(expectedConfirmation)
      || canonicalVNextJson(receipt.excludedReferencePaths)
        !== canonicalVNextJson(expectedReferences)) {
    return refused('TASK_PACK_IMPORT_SPLIT_INVALID', 'Imported task generation split drifted.');
  }
  return { status: 'OK', pack, bundle, receipt };
}
