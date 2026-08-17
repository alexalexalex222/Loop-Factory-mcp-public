import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildArgs,
  schemaPathForContract,
  STRICT_CODEX_DISABLED_FEATURES
} from './executor.mjs';
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import { validateMechanismEvolutionRecord } from './mechanism-evolution-records.mjs';
import {
  canonicalMechanismProgramJson,
  compileMechanismCapsule
} from './mechanism-compiler.mjs';
import { compareCompiledMechanismTreatments } from './mechanism-mutation.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const ADAPTIVE_RECURSIVE_CANARY_SCHEMA_VERSION =
  'adaptive-recursive-canary-v1';
export const ADAPTIVE_RECURSIVE_CANARY = Object.freeze({
  arms: Object.freeze(['candidate', 'cold', 'parent', 'sham']),
  tasks: 5,
  maximumCalls: 20,
  retries: 0,
  perCallTimeoutMs: 10 * 60 * 1000,
  sequentialTimeoutCeilingMinutes: 200
});
export const ADAPTIVE_RECURSIVE_SUPPORTED_MODELS = Object.freeze([
  'gpt-5.6-luna',
  'gpt-5.6-sol'
]);
export const ADAPTIVE_RECURSIVE_REASONING_EFFORTS = Object.freeze([
  'high',
  'xhigh',
  'max'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const RELATIVE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])])
  );
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function validSha(value) {
  return SHA256_RE.test(String(value || ''));
}

function validArtifact(value) {
  return exactKeys(value, ['path', 'sha256'])
    && RELATIVE_PATH_RE.test(String(value.path || ''))
    && validSha(value.sha256);
}

function sealedCapsule(family, semantics) {
  const payload = {
    schemaVersion: 'mechanism-capsule-v1',
    items: [{
      position: 0,
      familyId: family.familyId,
      familySha256: family.familySha256,
      causalFingerprint: family.causalFingerprint,
      semantics
    }]
  };
  return {
    ...payload,
    mechanismCapsuleSha256: sha256(canonicalMechanismProgramJson(payload))
  };
}

function completeCompilation(value, semantics) {
  return value?.status === 'OK'
    && value.compiledCapsule?.status === 'COMPILED'
    && value.compiledCapsule?.treatmentSemantics === semantics
    && value.compiledCapsule?.coverage?.eligible === 1
    && value.compiledCapsule?.coverage?.compiled === 1
    && value.compiledCapsule?.coverage?.abstained === 0
    && value.compiledCapsule?.coverage?.ratio === 1;
}

export function compileAdaptiveRecursiveTaskTreatments({
  task,
  parentFamily,
  candidateFamily
} = {}) {
  if (!exactKeys(task, [
    'id',
    'incident',
    'interface',
    'interfaceContract',
    'oracle',
    'source'
  ])
      || !isSafeId(task.id)
      || !validArtifact(task.source)
      || !validArtifact(task.incident)
      || !validArtifact(task.interface)
      || !validArtifact(task.oracle)) {
    return refused('RECURSIVE_CANARY_TASK_INVALID', 'A recursive canary task has invalid artifact bindings.');
  }
  const treatment = compareCompiledMechanismTreatments({
    parentProgram: parentFamily.causalFingerprint.program,
    candidateProgram: candidateFamily.causalFingerprint.program,
    interfaceContracts: [task.interfaceContract]
  });
  if (treatment.status !== 'OK') return treatment;
  if (!treatment.treatmentDelta.identifiable) {
    return refused(
      'RECURSIVE_CANARY_TASK_NO_TREATMENT_DELTA',
      `Task ${task.id} does not expose a model-visible parent-to-candidate delta.`
    );
  }
  const parent = compileMechanismCapsule({
    capsule: sealedCapsule(parentFamily, 'positive-transfer'),
    interfaceContract: task.interfaceContract
  });
  const candidate = compileMechanismCapsule({
    capsule: sealedCapsule(candidateFamily, 'positive-transfer'),
    interfaceContract: task.interfaceContract
  });
  const sham = compileMechanismCapsule({
    capsule: sealedCapsule(candidateFamily, 'irrelevant-control'),
    interfaceContract: task.interfaceContract
  });
  if (!completeCompilation(parent, 'positive-transfer')
      || !completeCompilation(candidate, 'positive-transfer')
      || !completeCompilation(sham, 'irrelevant-control')
      || parent.compiledCapsule.items[0].compilation.interfaceSha256
        !== task.interface.sha256
      || candidate.compiledCapsule.items[0].compilation.interfaceSha256
        !== task.interface.sha256
      || sham.compiledCapsule.items[0].compilation.interfaceSha256
        !== task.interface.sha256) {
    return refused(
      'RECURSIVE_CANARY_TASK_COMPILATION_INVALID',
      `Task ${task.id} does not compile complete schema-matched treatments.`
    );
  }
  return ok({
    treatmentDeltaSha256: treatment.treatmentDelta.treatmentDeltaSha256,
    packets: {
      cold: null,
      parent: parent.compiledCapsule,
      candidate: candidate.compiledCapsule,
      sham: sham.compiledCapsule
    }
  });
}

function normalizedTask(task, parentFamily, candidateFamily) {
  const compiled = compileAdaptiveRecursiveTaskTreatments({
    task,
    parentFamily,
    candidateFamily
  });
  if (compiled.status !== 'OK') return compiled;
  return ok({
    task: {
      id: String(task.id),
      source: task.source,
      incident: task.incident,
      interface: task.interface,
      oracle: task.oracle,
      treatmentDeltaSha256: compiled.treatmentDeltaSha256,
      treatments: Object.fromEntries(Object.entries(compiled.packets).map(([arm, packet]) => [
        arm,
        packet?.packetSha256 || null
      ])),
      treatmentShapeSha256: sha256(canonical({
        parent: Object.keys(compiled.packets.parent).sort(),
        candidate: Object.keys(compiled.packets.candidate).sort(),
        sham: Object.keys(compiled.packets.sham).sort()
      }))
    }
  });
}

function portableArgv(model, reasoningEffort) {
  const schemaPath = schemaPathForContract({ kind: 'proposal' });
  const args = buildArgs('codex', null, model, {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: '<fresh-model-capsule>',
    reasoningEffort
  });
  return {
    argv: args.map((value) => value === schemaPath ? '<proposal-output-schema>' : value),
    outputSchemaSha256: sha256(readFileSync(schemaPath)),
    disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES]
  };
}

function configCore(config) {
  return {
    schemaVersion: config.schemaVersion,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    authMode: config.authMode,
    retries: config.retries,
    promotionEnabled: config.promotionEnabled,
    historicalTokenEstimate: config.historicalTokenEstimate,
    parentFamily: config.parentFamily,
    candidateFamily: config.candidateFamily,
    evolutionRecord: config.evolutionRecord,
    tasks: [...config.tasks].sort((left, right) => (
      String(left.id).localeCompare(String(right.id))
    ))
  };
}

function preparedBindings(config) {
  const present = [
    config.runtimeAuthority,
    config.evaluatorAuthority,
    config.implementationManifest,
    config.taskMaterials
  ].filter((value) => value != null).length;
  if (present === 0) return null;
  if (present !== 4
      || !validSha(config.runtimeAuthority?.authoritySha256)
      || !validSha(config.runtimeAuthority?.binary?.sha256)
      || !validSha(config.evaluatorAuthority?.authoritySha256)
      || !Array.isArray(config.implementationManifest)
      || !Array.isArray(config.taskMaterials)) return false;
  const taskMaterialBindings = config.taskMaterials.map((task) => ({
    id: task.id,
    sourceSha256: task.source?.sha256,
    incidentSha256: task.incident?.sha256,
    interfaceSha256: task.interface?.sha256,
    interfaceSemanticSha256: task.interface?.semanticSha256,
    oracleSha256: task.oracle?.sha256,
    caseSetSha256: task.caseSetSha256,
    interfaceCoverageSha256: task.interfaceCoverageSha256,
    treatmentDeltaSha256: task.treatmentDeltaSha256,
    treatmentPacketSha256s: Object.fromEntries(Object.entries(
      task.treatmentPackets || {}
    ).map(([arm, packet]) => [arm, packet?.packetSha256 || null]))
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    runtimeAuthoritySha256: config.runtimeAuthority.authoritySha256,
    runtimeExecutableSha256: config.runtimeAuthority.binary.sha256,
    runtimeVersion: config.runtimeAuthority.binary.version,
    evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
    implementationManifestSha256: sha256(canonical(config.implementationManifest)),
    taskMaterialSetSha256: sha256(canonical(taskMaterialBindings))
  };
}

export function buildAdaptiveRecursiveCanaryPlan(config = {}) {
  try {
    if (config.schemaVersion !== ADAPTIVE_RECURSIVE_CANARY_SCHEMA_VERSION
        || !ADAPTIVE_RECURSIVE_SUPPORTED_MODELS.includes(config.model)
        || !ADAPTIVE_RECURSIVE_REASONING_EFFORTS.includes(config.reasoningEffort)
        || config.authMode !== 'chatgpt-oauth'
        || config.retries !== 0
        || config.promotionEnabled !== false
        || !Number.isInteger(config.historicalTokenEstimate)
        || config.historicalTokenEstimate <= 0
        || validateAdaptiveRecord(config.parentFamily).status !== 'OK'
        || validateAdaptiveRecord(config.candidateFamily).status !== 'OK'
        || !config.parentFamily.causalFingerprint?.program
        || !config.candidateFamily.causalFingerprint?.program
        || validateMechanismEvolutionRecord(config.evolutionRecord).status !== 'OK'
        || config.evolutionRecord.state !== 'SHADOW'
        || config.evolutionRecord.parent.familyId !== config.parentFamily.familyId
        || config.evolutionRecord.parent.familySha256 !== config.parentFamily.familySha256
        || config.evolutionRecord.candidate.familyId !== config.candidateFamily.familyId
        || config.evolutionRecord.candidate.familySha256 !== config.candidateFamily.familySha256
        || !Array.isArray(config.tasks)
        || config.tasks.length !== ADAPTIVE_RECURSIVE_CANARY.tasks) {
      return refused(
        'RECURSIVE_CANARY_CONFIG_INVALID',
        'Recursive canary requires one shadow descendant, an allowed exact GPT-5.6 OAuth route, five tasks, zero retries, and no promotion.'
      );
    }
    const tasks = [];
    for (const task of config.tasks) {
      const normalized = normalizedTask(task, config.parentFamily, config.candidateFamily);
      if (normalized.status !== 'OK') return normalized;
      tasks.push(normalized.task);
    }
    const bindings = preparedBindings(config);
    if (bindings === false) {
      return refused(
        'RECURSIVE_CANARY_PREPARED_BINDINGS_INVALID',
        'Prepared recursive authority, implementation, and task bindings must be complete.'
      );
    }
    tasks.sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length
        || new Set(tasks.flatMap((task) => Object.values(task.treatments).filter(Boolean))).size
          !== tasks.length * 3) {
      return refused(
        'RECURSIVE_CANARY_TREATMENT_SET_INVALID',
        'Tasks and compiled treatment packets must be unique across the verification set.'
      );
    }
    const configSha256 = sha256(canonical(configCore(config)));
    const calls = tasks.flatMap((task) => ADAPTIVE_RECURSIVE_CANARY.arms.map((arm) => ({
      taskId: task.id,
      arm,
      treatmentPacketSha256: task.treatments[arm],
      outputSchemaKind: 'proposal'
    }))).sort((left, right) => (
      sha256(`${configSha256}:${left.taskId}:${left.arm}`)
        .localeCompare(sha256(`${configSha256}:${right.taskId}:${right.arm}`))
    )).map((call, index) => ({ callIndex: index, ...call }));
    const execution = portableArgv(config.model, config.reasoningEffort);
    const payload = {
      schemaVersion: ADAPTIVE_RECURSIVE_CANARY_SCHEMA_VERSION,
      configSha256,
      modelPolicy: {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        authMode: 'chatgpt-oauth',
        retries: 0,
        fallbackModels: [],
        strictIsolation: true,
        promotionEnabled: false
      },
      exposure: {
        tasks: tasks.length,
        arms: [...ADAPTIVE_RECURSIVE_CANARY.arms],
        calls: calls.length,
        perCallTimeoutMs: ADAPTIVE_RECURSIVE_CANARY.perCallTimeoutMs,
        sequentialTimeoutCeilingMinutes:
          ADAPTIVE_RECURSIVE_CANARY.sequentialTimeoutCeilingMinutes,
        historicalTokenEstimate: config.historicalTokenEstimate,
        hardTokenCeiling: null,
        hardUsdCeiling: null
      },
      evolution: {
        evolutionId: config.evolutionRecord.evolutionId,
        evolutionReceiptId: config.evolutionRecord.evolutionReceiptId,
        evolutionSha256: config.evolutionRecord.evolutionSha256,
        parentFamilyId: config.parentFamily.familyId,
        parentProgramSha256: config.evolutionRecord.parent.programSha256,
        candidateFamilyId: config.candidateFamily.familyId,
        candidateProgramSha256: config.evolutionRecord.candidate.programSha256,
        sourceMeasurementId: config.evolutionRecord.evidence.sourceMeasurementId,
        sourceMeasurementSha256: config.evolutionRecord.evidence.sourceMeasurementSha256,
        treatmentDeltaSha256: config.evolutionRecord.evidence.treatmentDeltaSha256
      },
      execution,
      preparedBindings: bindings,
      tasks,
      calls
    };
    return ok({
      plan: {
        ...payload,
        sha256: sha256(canonical(payload))
      }
    });
  } catch (error) {
    return refused('RECURSIVE_CANARY_PLAN_FAILED', error.message);
  }
}

export function adaptiveRecursiveCanaryLaunchDisclosure(config = {}, {
  configPath = '',
  home = '',
  runId = ''
} = {}) {
  const built = buildAdaptiveRecursiveCanaryPlan(config);
  if (built.status !== 'OK') return built;
  const launchCommand = [
    `SUPER_LOOP_CODEX_BIN='${config.runtimeAuthority?.binary?.path || ''}'`,
    'SUPER_LOOP_REQUIRE_CHATGPT_OAUTH=1',
    `SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256=${config.runtimeAuthority?.authoritySha256 || ''}`,
    `SUPER_LOOP_CODEX_EXECUTABLE_SHA256=${config.runtimeAuthority?.binary?.sha256 || ''}`,
    'SUPER_LOOP_ALLOW_EXEC=1',
    'npm run recursive-canary --',
    `--config '${resolve(configPath)}'`,
    `--approved-plan ${built.plan.sha256}`,
    `--run-id '${runId}'`,
    `--home '${resolve(home)}'`,
    '&& npm run verify:recursive-canary --',
    `--home '${resolve(home)}'`,
    `--run '${runId}'`
  ].join(' ');
  return ok({
    planSha256: built.plan.sha256,
    configSha256: built.plan.configSha256,
    calls: built.plan.exposure.calls,
    exposure: built.plan.exposure,
    exactCodexArgv: built.plan.execution.argv,
    disabledFeatures: built.plan.execution.disabledFeatures,
    outputSchemaSha256: built.plan.execution.outputSchemaSha256,
    launchCommand,
    workerLaunched: false,
    launchAvailable: true,
    nextRequiredBoundary: config.approvedPlanSha256 === built.plan.sha256
      ? 'LAUNCH_EXACT_APPROVED_PLAN'
      : 'APPROVE_EXACT_PLAN_SHA256'
  });
}
