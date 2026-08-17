import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  captureExecutableEvaluatorAuthority,
  evaluateExecutableCandidate,
  validateExecutableEvaluatorAuthority,
  validateExecutableEvaluatorAuthorityRecord,
  validateExecutableInterfaceCoverage
} from './adaptive-executable-canary.mjs';
import { sandboxRecord } from './adaptive-recursive-runner.mjs';

export const VNEXT_TASK_PACK_SCHEMA = 'loop-factory-vnext-task-pack-v1';
export const VNEXT_TASK_MATERIAL_BUNDLE_SCHEMA =
  'loop-factory-vnext-task-material-bundle-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const PARTITIONS = new Set(['development', 'validation', 'final']);
const BUILDER_KINDS = new Set([
  'deterministic-tool',
  'operator',
  'external-custodian'
]);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function bindingValid(value) {
  return exactKeys(value, ['id', 'path', 'sha256'])
    && isSafeId(value.id)
    && typeof value.path === 'string'
    && value.path.length > 0
    && !isAbsolute(value.path)
    && SHA256.test(value.sha256);
}

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readBoundFile(root, binding, maximumBytes) {
  if (!plainObject(binding)
      || !isSafeId(binding.id)
      || typeof binding.path !== 'string'
      || !binding.path
      || isAbsolute(binding.path)
      || !SHA256.test(String(binding.sha256 || ''))) {
    return { status: 'REFUSED', code: 'TASK_PACK_BINDING_INVALID' };
  }
  const path = resolve(root, binding.path);
  if (!within(root, path)
      || !existsSync(path)
      || lstatSync(path).isSymbolicLink()
      || realpathSync(path) !== path) {
    return { status: 'REFUSED', code: 'TASK_PACK_BINDING_UNSAFE' };
  }
  const bytes = readFileSync(path);
  if (bytes.length > maximumBytes || sha256(bytes) !== binding.sha256) {
    return { status: 'REFUSED', code: 'TASK_PACK_BINDING_HASH_OR_SIZE' };
  }
  return { status: 'OK', bytes, path };
}

function baselineValid(value, taskId) {
  const targetFailures = Array.isArray(value?.evaluation?.results)
    ? value.evaluation.results
      .filter((row) => row.group === 'target' && row.pass !== true)
      .map((row) => row.id).sort()
    : [];
  const controls = Array.isArray(value?.evaluation?.results)
    ? value.evaluation.results.filter((row) => row.group === 'control')
    : [];
  const controlPasses = controls.filter((row) => row.pass === true)
    .map((row) => row.id).sort();
  return exactKeys(value, [
    'status', 'taskId', 'artifactId', 'artifactSha256',
    'verifierEvidenceSha256', 'baselineArtifactSha256',
    'evaluatorAuthoritySha256', 'sourceSha256', 'interfaceSha256',
    'oracleSha256', 'interfaceCoverageSha256', 'targetFailureIds',
    'controlPassIds', 'evaluation'
  ])
    && value.status === 'VERIFIED_FAILURE'
    && value.taskId === taskId
    && isSafeId(value.artifactId)
    && SHA256.test(String(value.artifactSha256 || ''))
    && SHA256.test(String(value.verifierEvidenceSha256 || ''))
    && SHA256.test(String(value.baselineArtifactSha256 || ''))
    && SHA256.test(String(value.evaluatorAuthoritySha256 || ''))
    && SHA256.test(String(value.sourceSha256 || ''))
    && SHA256.test(String(value.interfaceSha256 || ''))
    && SHA256.test(String(value.oracleSha256 || ''))
    && SHA256.test(String(value.interfaceCoverageSha256 || ''))
    && Array.isArray(value.targetFailureIds)
    && value.targetFailureIds.length > 0
    && value.targetFailureIds.every(isSafeId)
    && Array.isArray(value.controlPassIds)
    && value.controlPassIds.length >= 2
    && value.controlPassIds.every(isSafeId)
    && plainObject(value.evaluation)
    && value.evaluation.instrumentValid === true
    && value.evaluation.candidateExecuted === true
    && value.evaluation.outputShapeValid === true
    && canonicalVNextJson(value.targetFailureIds) === canonicalVNextJson(targetFailures)
    && controls.length >= 2
    && controlPasses.length === controls.length
    && canonicalVNextJson(value.controlPassIds) === canonicalVNextJson(controlPasses)
    && value.verifierEvidenceSha256 === sha256(canonicalVNextJson({
      taskId: value.taskId,
      sourceSha256: value.sourceSha256,
      interfaceSha256: value.interfaceSha256,
      oracleSha256: value.oracleSha256,
      evaluatorAuthoritySha256: value.evaluatorAuthoritySha256,
      interfaceCoverageSha256: value.interfaceCoverageSha256,
      evaluation: value.evaluation
    }));
}

function taskValid(task) {
  return exactKeys(task, [
    'taskId', 'clusterId', 'domain', 'tags', 'source', 'incident',
    'interface', 'oracle', 'interfaceContractSha256',
    'publicTaskSpecSha256', 'baselineFailure'
  ])
    && isSafeId(task.taskId)
    && isSafeId(task.clusterId)
    && typeof task.domain === 'string'
    && task.domain.length > 0
    && task.domain.length <= 120
    && Array.isArray(task.tags)
    && task.tags.length <= 32
    && task.tags.every((tag) => (
      typeof tag === 'string' && tag.length > 0 && tag.length <= 120
    ))
    && new Set(task.tags).size === task.tags.length
    && canonicalVNextJson(task.tags)
      === canonicalVNextJson([...task.tags].sort())
    && ['source', 'incident', 'interface', 'oracle']
      .every((name) => bindingValid(task[name]))
    && SHA256.test(task.interfaceContractSha256)
    && SHA256.test(task.publicTaskSpecSha256)
    && baselineValid(task.baselineFailure, task.taskId)
    && task.baselineFailure.artifactSha256 === task.source.sha256
    && task.baselineFailure.baselineArtifactSha256 === task.source.sha256
    && task.baselineFailure.sourceSha256 === task.source.sha256
    && task.baselineFailure.interfaceSha256 === task.interfaceContractSha256
    && task.baselineFailure.oracleSha256 === task.oracle.sha256;
}

function taskIdentities(tasks) {
  return tasks.flatMap((task) => [
    `task:${task.taskId}`,
    `cluster:${task.clusterId}`,
    `source-path:${task.source.path}`,
    `source-sha:${task.source.sha256}`,
    `incident-path:${task.incident.path}`,
    `incident-sha:${task.incident.sha256}`,
    `interface-path:${task.interface.path}`,
    `interface-sha:${task.interface.sha256}`,
    `oracle-path:${task.oracle.path}`,
    `oracle-sha:${task.oracle.sha256}`
  ]).sort();
}

function taskPayload(task) {
  return {
    taskId: task.taskId,
    clusterId: task.clusterId,
    domain: task.domain,
    tags: [...task.tags].sort(),
    source: task.source,
    incident: task.incident,
    interface: task.interface,
    oracle: task.oracle,
    interfaceContractSha256: task.interfaceContractSha256,
    publicTaskSpecSha256: task.publicTaskSpecSha256,
    baselineFailure: task.baselineFailure
  };
}

function packPayload(pack) {
  return {
    schemaVersion: pack.schemaVersion,
    packId: pack.packId,
    partition: pack.partition,
    createdAt: pack.createdAt,
    builderAuthority: pack.builderAuthority,
    evaluatorAuthority: pack.evaluatorAuthority,
    artifactRootSha256: pack.artifactRootSha256,
    priorIdentitySetSha256: pack.priorIdentitySetSha256,
    tasks: pack.tasks,
    taskIdentitySetSha256: pack.taskIdentitySetSha256,
    leakageChecks: pack.leakageChecks
  };
}

function buildBaselineFailure({ task, source, oracle, interfaceContract, evaluatorAuthority }) {
  const coverage = validateExecutableInterfaceCoverage(oracle, interfaceContract);
  if (!coverage.ok) {
    return { status: 'REFUSED', code: 'TASK_PACK_BASELINE_INTERFACE_INVALID' };
  }
  const measured = evaluateExecutableCandidate({
    source,
    caseSet: oracle,
    authority: evaluatorAuthority,
    taskId: task.taskId,
    diagnostics: true
  });
  const evaluation = measured.instrumentValid ? sandboxRecord(measured) : null;
  const targetFailureIds = (evaluation?.results || [])
    .filter((row) => row.group === 'target' && row.pass !== true)
    .map((row) => row.id)
    .sort();
  const controls = (evaluation?.results || []).filter((row) => row.group === 'control');
  const controlPassIds = controls.filter((row) => row.pass === true)
    .map((row) => row.id)
    .sort();
  if (!evaluation
      || measured.candidateExecuted !== true
      || measured.outputShapeValid !== true
      || targetFailureIds.length < 1
      || controls.length < 2
      || controlPassIds.length !== controls.length) {
    return {
      status: 'REFUSED',
      code: 'TASK_PACK_BASELINE_FAILURE_NOT_PROVEN'
    };
  }
  const proofCore = {
    taskId: task.taskId,
    sourceSha256: task.source.sha256,
    interfaceSha256: task.interfaceContractSha256,
    oracleSha256: task.oracle.sha256,
    evaluatorAuthoritySha256: evaluatorAuthority.authoritySha256,
    interfaceCoverageSha256: coverage.sha256,
    evaluation
  };
  const baselineFailure = {
    status: 'VERIFIED_FAILURE',
    taskId: task.taskId,
    artifactId: `baseline-${sha256(task.taskId).slice(0, 24)}`,
    artifactSha256: task.source.sha256,
    verifierEvidenceSha256: sha256(canonicalVNextJson(proofCore)),
    baselineArtifactSha256: task.source.sha256,
    evaluatorAuthoritySha256: evaluatorAuthority.authoritySha256,
    sourceSha256: task.source.sha256,
    interfaceSha256: task.interfaceContractSha256,
    oracleSha256: task.oracle.sha256,
    interfaceCoverageSha256: coverage.sha256,
    targetFailureIds,
    controlPassIds,
    evaluation
  };
  return baselineValid(baselineFailure, task.taskId)
    ? { status: 'OK', baselineFailure }
    : { status: 'REFUSED', code: 'TASK_PACK_BASELINE_PROOF_INVALID' };
}

export function buildVNextTaskPack({
  artifactRoot,
  packId,
  partition,
  createdAt,
  builderAuthority,
  evaluatorAuthorityRecord = null,
  tasks,
  priorIdentities = [],
  maximumFileBytes = 1024 * 1024
} = {}) {
  try {
    if (!isSafeId(packId)
        || !PARTITIONS.has(partition)
        || !Number.isFinite(Date.parse(createdAt))
        || !plainObject(builderAuthority)
        || !isSafeId(builderAuthority.id)
        || !BUILDER_KINDS.has(builderAuthority.kind)
        || (partition === 'final' && builderAuthority.kind !== 'external-custodian')
        || !Array.isArray(tasks)
        || tasks.length < 2
        || tasks.length > 1000
        || !Array.isArray(priorIdentities)
        || !priorIdentities.every((value) => typeof value === 'string')) {
      return { status: 'REFUSED', code: 'TASK_PACK_REQUEST_INVALID' };
    }
    const evaluatorAuthority = evaluatorAuthorityRecord
      ? validateExecutableEvaluatorAuthority(evaluatorAuthorityRecord)
      : captureExecutableEvaluatorAuthority();
    if (evaluatorAuthority.status !== 'OK') {
      return {
        status: 'REFUSED',
        code: evaluatorAuthority.code || 'TASK_PACK_EVALUATOR_AUTHORITY_INVALID',
        message: evaluatorAuthority.message || evaluatorAuthority.errors?.join('; ')
      };
    }
    const root = realpathSync(resolve(artifactRoot));
    const prior = new Set(priorIdentities);
    const identities = [];
    const normalized = [];
    const leakageChecks = [];
    for (const task of tasks) {
      if (!plainObject(task)
          || !isSafeId(task.taskId)
          || !isSafeId(task.clusterId)
          || typeof task.domain !== 'string'
          || task.domain.length < 1
          || task.domain.length > 120
          || !Array.isArray(task.tags)
          || task.tags.length > 32
          || !task.tags.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 120)
          || !SHA256.test(String(task.interfaceContractSha256 || ''))
          || !SHA256.test(String(task.publicTaskSpecSha256 || ''))) {
        return { status: 'REFUSED', code: 'TASK_PACK_TASK_INVALID' };
      }
      const source = readBoundFile(root, task.source, maximumFileBytes);
      const incident = readBoundFile(root, task.incident, maximumFileBytes);
      const interfaceFile = readBoundFile(root, task.interface, maximumFileBytes);
      const oracle = readBoundFile(root, task.oracle, maximumFileBytes);
      if ([source, incident, interfaceFile, oracle].some((value) => value.status !== 'OK')) {
        return [source, incident, interfaceFile, oracle]
          .find((value) => value.status !== 'OK');
      }
      let interfaceContract;
      let caseSet;
      try {
        interfaceContract = JSON.parse(interfaceFile.bytes);
        caseSet = JSON.parse(oracle.bytes);
      } catch {
        return { status: 'REFUSED', code: 'TASK_PACK_INTERFACE_JSON_INVALID' };
      }
      if (!plainObject(interfaceContract)
          || sha256(canonicalVNextJson(interfaceContract))
            !== task.interfaceContractSha256) {
        return { status: 'REFUSED', code: 'TASK_PACK_INTERFACE_HASH_INVALID' };
      }
      const taskIdentities = [
        `task:${task.taskId}`,
        `cluster:${task.clusterId}`,
        `source-path:${task.source.path}`,
        `source-sha:${task.source.sha256}`,
        `incident-path:${task.incident.path}`,
        `incident-sha:${task.incident.sha256}`,
        `interface-path:${task.interface.path}`,
        `interface-sha:${task.interface.sha256}`,
        `oracle-path:${task.oracle.path}`,
        `oracle-sha:${task.oracle.sha256}`
      ];
      if (taskIdentities.some((identity) => prior.has(identity) || identities.includes(identity))) {
        return { status: 'REFUSED', code: 'TASK_PACK_NOT_DISJOINT' };
      }
      identities.push(...taskIdentities);
      const oracleText = oracle.bytes.toString('utf8').trim();
      const sourceText = source.bytes.toString('utf8');
      const directOracleLeak = oracleText.length >= 16 && sourceText.includes(oracleText);
      leakageChecks.push({ taskId: task.taskId, directOracleLeak });
      if (directOracleLeak) return { status: 'REFUSED', code: 'TASK_PACK_ORACLE_LEAK' };
      const baseline = buildBaselineFailure({
        task,
        source: source.bytes.toString('utf8'),
        oracle: caseSet,
        interfaceContract,
        evaluatorAuthority: evaluatorAuthority.record
      });
      if (baseline.status !== 'OK') return baseline;
      normalized.push(taskPayload({ ...task, baselineFailure: baseline.baselineFailure }));
    }
    normalized.sort((left, right) => left.taskId.localeCompare(right.taskId));
    identities.sort();
    const artifactRootSha256 = sha256(canonicalVNextJson(normalized.map((task) => ({
      source: task.source,
      incident: task.incident,
      interface: task.interface,
      oracle: task.oracle
    }))));
    const base = {
      schemaVersion: VNEXT_TASK_PACK_SCHEMA,
      packId,
      partition,
      createdAt,
      builderAuthority: {
        id: builderAuthority.id,
        kind: builderAuthority.kind
      },
      evaluatorAuthority: evaluatorAuthority.record,
      artifactRootSha256,
      priorIdentitySetSha256: sha256(canonicalVNextJson([...prior].sort())),
      tasks: normalized,
      taskIdentitySetSha256: sha256(canonicalVNextJson(identities)),
      leakageChecks: leakageChecks.sort((left, right) => left.taskId.localeCompare(right.taskId))
    };
    return {
      status: 'OK',
      pack: {
        ...base,
        packSha256: sha256(canonicalVNextJson(base))
      },
      identities
    };
  } catch (error) {
    return { status: 'REFUSED', code: 'TASK_PACK_BUILD_FAILED', message: error.message };
  }
}

export function loadVNextTaskPackMaterials({
  artifactRoot,
  pack,
  maximumFileBytes = 1024 * 1024
} = {}) {
  try {
    if (validateVNextTaskPack(pack).status !== 'OK') {
      return { status: 'REFUSED', code: 'TASK_PACK_INVALID' };
    }
    const root = realpathSync(resolve(artifactRoot));
    const materials = [];
    for (const task of pack.tasks) {
      const files = Object.fromEntries(['source', 'incident', 'interface', 'oracle']
        .map((name) => [name, readBoundFile(root, task[name], maximumFileBytes)]));
      const failed = Object.values(files).find((result) => result.status !== 'OK');
      if (failed) return failed;
      let interfaceContract;
      let caseSet;
      try {
        interfaceContract = JSON.parse(files.interface.bytes);
        caseSet = JSON.parse(files.oracle.bytes);
      } catch {
        return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_JSON_INVALID' };
      }
      if (!plainObject(interfaceContract)
          || !plainObject(caseSet)
          || sha256(canonicalVNextJson(interfaceContract))
            !== task.interfaceContractSha256) {
        return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_BINDING_INVALID' };
      }
      materials.push({
        taskId: task.taskId,
        clusterId: task.clusterId,
        domain: task.domain,
        tags: task.tags,
        source: { ...task.source, content: files.source.bytes.toString('utf8') },
        incident: { ...task.incident, content: files.incident.bytes.toString('utf8') },
        interface: { ...task.interface, content: files.interface.bytes.toString('utf8') },
        oracle: { ...task.oracle, content: files.oracle.bytes.toString('utf8') },
        interfaceContract,
        caseSet,
        publicTaskSpecSha256: task.publicTaskSpecSha256,
        baselineFailure: task.baselineFailure
      });
    }
    const core = {
      schemaVersion: VNEXT_TASK_MATERIAL_BUNDLE_SCHEMA,
      packId: pack.packId,
      packSha256: pack.packSha256,
      materials
    };
    const bundle = { ...core, bundleSha256: sha256(canonicalVNextJson(core)) };
    const validated = validateVNextTaskMaterialBundle({ bundle, pack });
    return validated.status === 'OK'
      ? { status: 'OK', bundle }
      : validated;
  } catch (error) {
    return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_LOAD_FAILED', message: error.message };
  }
}

export function validateVNextTaskPack(pack) {
  const packKeys = [
    'schemaVersion', 'packId', 'partition', 'createdAt', 'builderAuthority',
    'evaluatorAuthority',
    'artifactRootSha256', 'priorIdentitySetSha256', 'tasks',
    'taskIdentitySetSha256', 'leakageChecks', 'packSha256'
  ];
  if (!exactKeys(pack, packKeys)
      || pack.schemaVersion !== VNEXT_TASK_PACK_SCHEMA
      || !isSafeId(pack.packId)
      || pack.packSha256 !== sha256(canonicalVNextJson(packPayload(pack)))
      || !PARTITIONS.has(pack.partition)
      || !Number.isFinite(Date.parse(pack.createdAt))
      || !exactKeys(pack.builderAuthority, ['id', 'kind'])
      || !isSafeId(pack.builderAuthority.id)
      || !BUILDER_KINDS.has(pack.builderAuthority.kind)
      || validateExecutableEvaluatorAuthorityRecord(pack.evaluatorAuthority).status !== 'OK'
      || (pack.partition === 'final' && pack.builderAuthority?.kind !== 'external-custodian')
      || !SHA256.test(pack.artifactRootSha256)
      || !SHA256.test(pack.priorIdentitySetSha256)
      || !SHA256.test(pack.taskIdentitySetSha256)
      || !Array.isArray(pack.tasks)
      || pack.tasks.length < 2
      || pack.tasks.length > 1000
      || pack.tasks.some((task) => !taskValid(task))
      || canonicalVNextJson(pack.tasks.map((task) => task.taskId))
        !== canonicalVNextJson(pack.tasks.map((task) => task.taskId).sort())
      || new Set(pack.tasks.map((task) => task.taskId)).size !== pack.tasks.length
      || pack.tasks.some((task) => (
        task.baselineFailure.evaluatorAuthoritySha256
          !== pack.evaluatorAuthority.authoritySha256
      ))
      || !Array.isArray(pack.leakageChecks)
      || pack.leakageChecks.length !== pack.tasks.length
      || pack.leakageChecks.some((check) => (
        !exactKeys(check, ['taskId', 'directOracleLeak'])
        || !isSafeId(check.taskId)
        || check.directOracleLeak !== false
      ))) {
    return { status: 'REFUSED', code: 'TASK_PACK_INVALID' };
  }
  const identities = taskIdentities(pack.tasks);
  const leakageTaskIds = pack.leakageChecks.map((check) => check.taskId);
  const expectedArtifactRootSha256 = sha256(canonicalVNextJson(pack.tasks.map((task) => ({
    source: task.source,
    incident: task.incident,
    interface: task.interface,
    oracle: task.oracle
  }))));
  if (new Set(identities).size !== identities.length
      || pack.taskIdentitySetSha256 !== sha256(canonicalVNextJson(identities))
      || pack.artifactRootSha256 !== expectedArtifactRootSha256
      || canonicalVNextJson(leakageTaskIds)
        !== canonicalVNextJson(pack.tasks.map((task) => task.taskId))) {
    return { status: 'REFUSED', code: 'TASK_PACK_INVALID' };
  }
  return { status: 'OK', pack };
}

export function vnextTaskPackIdentities(pack) {
  return validateVNextTaskPack(pack).status === 'OK'
    ? taskIdentities(pack.tasks)
    : null;
}

export function validateVNextTaskMaterialBundle({ bundle, pack } = {}) {
  if (validateVNextTaskPack(pack).status !== 'OK'
      || !exactKeys(bundle, [
        'schemaVersion', 'packId', 'packSha256', 'materials', 'bundleSha256'
      ])
      || bundle.schemaVersion !== VNEXT_TASK_MATERIAL_BUNDLE_SCHEMA
      || bundle.packId !== pack.packId
      || bundle.packSha256 !== pack.packSha256
      || !Array.isArray(bundle.materials)
      || bundle.materials.length !== pack.tasks.length) {
    return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_BUNDLE_INVALID' };
  }
  const core = structuredClone(bundle);
  delete core.bundleSha256;
  if (!SHA256.test(String(bundle.bundleSha256 || ''))
      || bundle.bundleSha256 !== sha256(canonicalVNextJson(core))) {
    return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_BUNDLE_TAMPERED' };
  }
  for (const [index, material] of bundle.materials.entries()) {
    const task = pack.tasks[index];
    if (!exactKeys(material, [
      'taskId', 'clusterId', 'domain', 'tags', 'source', 'incident',
      'interface', 'oracle', 'interfaceContract', 'caseSet',
      'publicTaskSpecSha256', 'baselineFailure'
    ])
        || material.taskId !== task.taskId
        || material.clusterId !== task.clusterId
        || material.domain !== task.domain
        || canonicalVNextJson(material.tags) !== canonicalVNextJson(task.tags)
        || material.publicTaskSpecSha256 !== task.publicTaskSpecSha256
        || canonicalVNextJson(material.baselineFailure)
          !== canonicalVNextJson(task.baselineFailure)) {
      return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_BUNDLE_INVALID' };
    }
    for (const name of ['source', 'incident', 'interface', 'oracle']) {
      const file = material[name];
      if (!exactKeys(file, ['id', 'path', 'sha256', 'content'])
          || typeof file.content !== 'string'
          || file.id !== task[name].id
          || file.path !== task[name].path
          || file.sha256 !== task[name].sha256
          || sha256(file.content) !== file.sha256) {
        return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_FILE_INVALID' };
      }
    }
    let parsedInterface;
    let parsedOracle;
    try {
      parsedInterface = JSON.parse(material.interface.content);
      parsedOracle = JSON.parse(material.oracle.content);
    } catch {
      return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_JSON_INVALID' };
    }
    if (!plainObject(material.interfaceContract)
        || !plainObject(material.caseSet)
        || canonicalVNextJson(parsedInterface)
          !== canonicalVNextJson(material.interfaceContract)
        || canonicalVNextJson(parsedOracle) !== canonicalVNextJson(material.caseSet)
        || sha256(canonicalVNextJson(material.interfaceContract))
          !== task.interfaceContractSha256) {
      return { status: 'REFUSED', code: 'TASK_PACK_MATERIAL_BINDING_INVALID' };
    }
    const baseline = buildBaselineFailure({
      task,
      source: material.source.content,
      oracle: material.caseSet,
      interfaceContract: material.interfaceContract,
      evaluatorAuthority: pack.evaluatorAuthority
    });
    if (baseline.status !== 'OK'
        || canonicalVNextJson(baseline.baselineFailure)
          !== canonicalVNextJson(task.baselineFailure)) {
      return { status: 'REFUSED', code: 'TASK_PACK_BASELINE_REPLAY_INVALID' };
    }
  }
  return { status: 'OK', bundle, pack };
}
