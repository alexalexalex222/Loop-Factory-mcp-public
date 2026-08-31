import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTIVE_RECURSIVE_CANARY,
  buildAdaptiveRecursiveCanaryPlan,
  compileAdaptiveRecursiveTaskTreatments
} from './adaptive-recursive-canary.mjs';
import {
  adaptiveExecutableCanaryWorker,
  buildAdaptiveExecutableCanaryPrompt,
  captureExecutableEvaluatorAuthority,
  evaluateExecutableCandidate,
  validateExecutableEvaluatorAuthority,
  validateExecutableInterfaceCoverage
} from './adaptive-executable-canary.mjs';
import { createAdaptiveMeasurementRecord } from './adaptive-measurement-v2.mjs';
import {
  activateMechanismEvolution,
  rejectMechanismEvolution,
  verifyMechanismEvolution
} from './mechanism-evolution.mjs';
import {
  captureCodexOAuthAuthority,
  validateCodexOAuthAuthorityRecord
} from './codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  extractResult,
  normalizeSupervisorBoundProposalOutput,
  schemaPathForContract
} from './executor.mjs';
import {
  persistCanaryProposal,
  persistRejectedDispatch,
  stableJson,
  writeCanaryArtifact
} from './canary-runner.mjs';
import { parseCaseResults } from './measure.mjs';
import { verifyPersistedProposalRun } from './run-verifier.mjs';
import { canonicalJson } from './real-test.mjs';
import { isSafeId, nowIso, sha256 } from './util.mjs';

export const ADAPTIVE_RECURSIVE_RUN_KIND = 'adaptive-recursive-canary';
export const ADAPTIVE_RECURSIVE_IMPLEMENTATION_PATHS = Object.freeze([
  'docs/RECURSIVE_MECHANISM_EVOLUTION_V1.md',
  'package.json',
  'scripts/executable-canary-sandbox.mjs',
  'scripts/plan-adaptive-recursive-canary.mjs',
  'scripts/run-adaptive-recursive-canary.mjs',
  'scripts/verify-adaptive-recursive-canary.mjs',
  'src/adaptive-executable-canary.mjs',
  'src/adaptive-measurement-v2.mjs',
  'src/adaptive-records.mjs',
  'src/adaptive-recursive-canary.mjs',
  'src/adaptive-recursive-runner.mjs',
  'src/canary-runner.mjs',
  'src/codex-oauth-authority.mjs',
  'src/executor.mjs',
  'src/measure.mjs',
  'src/mechanism-compiler.mjs',
  'src/mechanism-evolution-records.mjs',
  'src/mechanism-evolution.mjs',
  'src/mechanism-mutation.mjs',
  'src/run-verifier.mjs',
  'src/schemas/adaptive-measurement-v2.schema.json',
  'src/schemas/adaptive-recursive-canary-v1.schema.json',
  'src/schemas/mechanism-evolution-v1.schema.json',
  'src/schemas/proposal-output.schema.json',
  'src/store.mjs',
  'src/util.mjs'
].sort());

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 512 * 1024;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function within(base, target) {
  const rel = relative(base, target);
  return rel === '' || (
    rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

function artifactRecord(path, content) {
  return {
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    content
  };
}

function readBoundFile(packageRoot, binding, label) {
  const path = String(binding?.path || '');
  if (!path || path.includes('\0') || isAbsolute(path) || path.split('/').includes('..')) {
    return refused('RECURSIVE_ARTIFACT_PATH_INVALID', `${label} path is not a safe repository-relative path.`);
  }
  const root = realpathSync(resolve(packageRoot));
  const absolute = resolve(root, path);
  if (!within(root, absolute) || !existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) {
    return refused('RECURSIVE_ARTIFACT_UNREADABLE', `${label} is missing, outside the package root, or a symlink.`);
  }
  const resolved = realpathSync(absolute);
  if (!within(root, resolved) || lstatSync(resolved).isDirectory()) {
    return refused('RECURSIVE_ARTIFACT_UNREADABLE', `${label} did not resolve to a regular in-root file.`);
  }
  const content = readFileSync(resolved, 'utf8');
  if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
    return refused('RECURSIVE_ARTIFACT_TOO_LARGE', `${label} exceeds the sealed artifact byte limit.`);
  }
  return ok({ artifact: artifactRecord(path, content) });
}

function parseJsonArtifact(artifact, label) {
  try {
    return ok({ record: JSON.parse(artifact.content) });
  } catch {
    return refused('RECURSIVE_ARTIFACT_JSON_INVALID', `${label} is not valid JSON.`);
  }
}

export function taskById(config, taskId) {
  return (config.tasks || []).find((item) => item.id === taskId) || null;
}

export function materialById(config, taskId) {
  return (config.taskMaterials || []).find((item) => item.id === taskId) || null;
}

export function resolveTaskMaterial(packageRoot, task, parentFamily, candidateFamily) {
  const files = {};
  for (const field of ['source', 'incident', 'interface', 'oracle']) {
    const loaded = readBoundFile(packageRoot, task[field], `${task.id} ${field}`);
    if (loaded.status !== 'OK') return loaded;
    files[field] = loaded.artifact;
  }
  for (const field of ['source', 'incident', 'oracle']) {
    if (files[field].sha256 !== task[field].sha256) {
      return refused(
        'RECURSIVE_ARTIFACT_HASH_MISMATCH',
        `${task.id} ${field} bytes do not match the configured SHA-256.`
      );
    }
  }
  const parsedInterface = parseJsonArtifact(files.interface, `${task.id} interface`);
  const parsedOracle = parseJsonArtifact(files.oracle, `${task.id} oracle`);
  if (parsedInterface.status !== 'OK') return parsedInterface;
  if (parsedOracle.status !== 'OK') return parsedOracle;
  if (canonicalJson(parsedInterface.record) !== canonicalJson(task.interfaceContract)) {
    return refused(
      'RECURSIVE_INTERFACE_BINDING_MISMATCH',
      `${task.id} interface file does not equal the embedded frozen interface contract.`
    );
  }
  const coverage = validateExecutableInterfaceCoverage(
    parsedOracle.record,
    parsedInterface.record
  );
  if (!coverage.ok) {
    return refused(
      'RECURSIVE_CASE_INTERFACE_MISMATCH',
      `${task.id} hidden cases are not covered by the visible interface.`,
      { errors: coverage.errors }
    );
  }
  const treatments = compileAdaptiveRecursiveTaskTreatments({
    task,
    parentFamily,
    candidateFamily
  });
  if (treatments.status !== 'OK') return treatments;
  return ok({
    material: {
      id: task.id,
      source: files.source,
      incident: files.incident,
      interface: {
        ...files.interface,
        semanticSha256: task.interface.sha256
      },
      oracle: files.oracle,
      caseSet: parsedOracle.record,
      caseSetSha256: sha256(canonicalJson(parsedOracle.record)),
      interfaceCoverageSha256: coverage.sha256,
      treatmentDeltaSha256: treatments.treatmentDeltaSha256,
      treatmentPackets: treatments.packets
    }
  });
}

export function resolveAdaptiveRecursiveImplementation({
  packageRoot = PACKAGE_ROOT
} = {}) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const capsule = ADAPTIVE_RECURSIVE_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full) || !existsSync(full) || lstatSync(full).isSymbolicLink()) {
        throw new Error(`recursive implementation dependency is missing or unsafe: ${path}`);
      }
      const content = readFileSync(full, 'utf8');
      return artifactRecord(path, content);
    });
    return ok({
      manifest: capsule.map(({ path, bytes, sha256: digest }) => ({
        path,
        bytes,
        sha256: digest
      })),
      capsule
    });
  } catch (error) {
    return refused('RECURSIVE_IMPLEMENTATION_UNRESOLVED', error.message);
  }
}

export function prepareAdaptiveRecursiveCanaryConfig(raw = {}, {
  packageRoot = PACKAGE_ROOT,
  artifactRoot = packageRoot,
  codexBinaryPath,
  runtimeAuthorityRecord = null,
  evaluatorAuthorityRecord = null,
  approvedPlanSha256 = null
} = {}) {
  const built = buildAdaptiveRecursiveCanaryPlan(raw);
  if (built.status !== 'OK') return built;
  const runtimeAuthority = runtimeAuthorityRecord
    ? validateCodexOAuthAuthorityRecord(runtimeAuthorityRecord)
    : captureCodexOAuthAuthority({
        binaryPath: codexBinaryPath,
        requestedModel: raw.model,
        reasoningEffort: raw.reasoningEffort
      });
  if (runtimeAuthority.status !== 'OK') return runtimeAuthority;
  const evaluatorAuthority = evaluatorAuthorityRecord
    ? validateExecutableEvaluatorAuthority(evaluatorAuthorityRecord)
    : captureExecutableEvaluatorAuthority();
  if (evaluatorAuthority.status !== 'OK') return evaluatorAuthority;
  const implementation = resolveAdaptiveRecursiveImplementation({ packageRoot });
  if (implementation.status !== 'OK') return implementation;
  const taskMaterials = [];
  for (const task of raw.tasks) {
    const resolved = resolveTaskMaterial(
      artifactRoot,
      task,
      raw.parentFamily,
      raw.candidateFamily
    );
    if (resolved.status !== 'OK') return resolved;
    taskMaterials.push(resolved.material);
  }
  taskMaterials.sort((left, right) => left.id.localeCompare(right.id));
  const config = {
    ...raw,
    approvedPlanSha256,
    runtimeAuthority: runtimeAuthority.record,
    evaluatorAuthority: evaluatorAuthority.record,
    implementationManifest: implementation.manifest,
    implementationCapsule: implementation.capsule,
    taskMaterials
  };
  const validation = validateAdaptiveRecursiveCanaryConfig(config, {
    requireApproval: approvedPlanSha256 != null
  });
  return validation.ok
    ? ok({ config, plan: validation.plan })
    : refused('RECURSIVE_PREPARED_CONFIG_INVALID', validation.errors.join('; '), {
        errors: validation.errors,
        plan: validation.plan
      });
}

function validateImplementation(config) {
  const current = resolveAdaptiveRecursiveImplementation();
  if (current.status !== 'OK') return false;
  return stableJson(current.manifest) === stableJson(config.implementationManifest)
    && stableJson(current.capsule) === stableJson(config.implementationCapsule);
}

function validateTaskMaterials(config) {
  if (!Array.isArray(config.taskMaterials)
      || config.taskMaterials.length !== ADAPTIVE_RECURSIVE_CANARY.tasks) return false;
  for (const task of config.tasks) {
    const material = materialById(config, task.id);
    if (!material) return false;
    for (const field of ['source', 'incident', 'interface', 'oracle']) {
      const item = material[field];
      if (!item
          || item.path !== task[field].path
          || item.bytes !== Buffer.byteLength(item.content)
          || item.sha256 !== sha256(item.content)) return false;
    }
    if (material.source.sha256 !== task.source.sha256
        || material.incident.sha256 !== task.incident.sha256
        || material.oracle.sha256 !== task.oracle.sha256
        || material.interface.semanticSha256 !== task.interface.sha256
        || material.caseSetSha256 !== sha256(canonicalJson(material.caseSet))) return false;
    const coverage = validateExecutableInterfaceCoverage(
      material.caseSet,
      task.interfaceContract
    );
    if (!coverage.ok || coverage.sha256 !== material.interfaceCoverageSha256) return false;
    const compiled = compileAdaptiveRecursiveTaskTreatments({
      task,
      parentFamily: config.parentFamily,
      candidateFamily: config.candidateFamily
    });
    if (compiled.status !== 'OK'
        || compiled.treatmentDeltaSha256 !== material.treatmentDeltaSha256
        || stableJson(compiled.packets) !== stableJson(material.treatmentPackets)) return false;
  }
  return true;
}

export function validateAdaptiveRecursiveCanaryConfig(config = {}, {
  requireApproval = true
} = {}) {
  const errors = [];
  const built = buildAdaptiveRecursiveCanaryPlan(config);
  if (built.status !== 'OK') errors.push(`${built.code}: ${built.message}`);
  const runtime = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtime.status !== 'OK'
      || runtime.record?.requestedModel !== config.model
      || runtime.record?.reasoningEffort !== config.reasoningEffort) {
    errors.push('Codex OAuth authority does not bind the exact recursive model and reasoning effort');
  }
  const evaluator = validateExecutableEvaluatorAuthority(config.evaluatorAuthority);
  if (evaluator.status !== 'OK') errors.push(...(evaluator.errors || ['evaluator authority is invalid']));
  if (!validateImplementation(config)) errors.push('recursive implementation capsule does not match current bytes');
  if (!validateTaskMaterials(config)) errors.push('recursive task materials do not match their sealed artifacts and treatments');
  if (requireApproval && config.approvedPlanSha256 !== built.plan?.sha256) {
    errors.push('approved plan SHA-256 does not match the prepared recursive plan');
  }
  return {
    ok: errors.length === 0,
    errors,
    plan: built.plan || null,
    runtimeAuthority: runtime,
    evaluatorAuthority: evaluator
  };
}

export function mechanismForArm(config, task, arm) {
  const material = materialById(config, task.id);
  return material?.treatmentPackets?.[arm] || null;
}

export function repairContract(config, task, arm) {
  const material = materialById(config, task.id);
  const hypothesisId = `recursive-${sha256(task.id).slice(0, 24)}`;
  return {
    loopId: 'recursive-mechanism-canary',
    loopSha: sha256('recursive-mechanism-canary-v1'),
    phase: 0,
    phaseTitle: 'Repair one visible module',
    slice: 'Repair the supplied module against the visible incident while preserving unrelated behavior.',
    sliceSha: sha256('Repair the supplied module against the visible incident while preserving unrelated behavior.'),
    totalPhases: 1,
    kind: 'proposal',
    route: config.model,
    reasoningEffort: config.reasoningEffort,
    task: 'Repair one isolated controller module from the supplied evidence.',
    requirements: [
      `Return the complete replacement for ${basename(task.source.path)}.`,
      `The module must export function ${material.caseSet.exportName}.`,
      'Preserve behavior outside the visible incident boundary.',
      'Treat the visible interface contract as authoritative for field names and output codes.',
      'Use only the supplied module, incident report, interface contract, and optional compiled mechanism.',
      'Do not add verification claims or operational status.'
    ],
    target: {
      findingId: task.id,
      title: 'Visible controller repair',
      baselineArtifactId: task.source.path,
      baselineSha256: material.source.sha256,
      baselineContent: material.source.content,
      interfaceArtifactId: task.interface.path,
      interfaceSha256: material.interface.sha256,
      evidenceRefs: [{
        path: task.incident.path,
        locator: 'Complete sealed incident report'
      }]
    },
    hypothesis: {
      id: hypothesisId,
      title: 'Repair the visible failure without regressing declared controls',
      bottleneck: 'The supplied controller mishandles one or more declared cases.',
      operation: 'Apply the smallest source-level repair supported by the visible evidence.',
      expectedMovement: 'More exact target dispositions with preserved controls.',
      falsifier: 'The revised module fails a declared control or does not repair the visible failure.'
    },
    mechanismCapsule: mechanismForArm(config, task, arm),
    mechanismCompilerVersion: 'mechanism-compiler-v1',
    proposalTreatmentInstruction:
      'Repair the visible incident. Use the optional compiled mechanism only when it applies to the supplied source and interface.',
    frozenCases: [],
    evidenceCapsule: [material.source, material.incident, material.interface],
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

export function proposalPayload(contract, packet) {
  const parsed = parseCaseResults(packet?.finalOutput || '');
  if (!parsed.ok || parsed.wrapper !== 'IMPROVEMENT' || !parsed.payload) return null;
  const payload = parsed.payload;
  return payload.findingId === contract.target.findingId
    && payload.hypothesisId === contract.hypothesis.id
    && payload.baselineSha256 === contract.target.baselineSha256
    && typeof payload.revisedContent === 'string'
    && payload.revisedContent.trim()
    && typeof payload.changeSummary === 'string'
    && payload.changeSummary.trim()
    ? payload
    : null;
}

export function normalizeAdaptiveRecursivePacket(contract, packet) {
  if (!packet || packet.__execReason || typeof packet.finalOutput !== 'string') {
    return packet;
  }
  const rawResult = extractResult('codex', packet.rawStdout || '');
  const finalOutput = normalizeSupervisorBoundProposalOutput(contract, rawResult);
  if (!finalOutput) return packet;
  return {
    ...packet,
    finalOutput,
    invocation: packet.invocation ? {
      ...packet.invocation,
      resultSha256: sha256(finalOutput),
      resultNormalization: 'json-schema-supervisor-bound-v1'
    } : packet.invocation
  };
}

export function adaptiveRecursiveCanaryWorker(contract, env = process.env) {
  return normalizeAdaptiveRecursivePacket(
    contract,
    adaptiveExecutableCanaryWorker(contract, env)
  );
}

export function invocationMatches(config, invocation, { requireSuccess = true } = {}) {
  const runtime = validateCodexOAuthAuthorityRecord(config.runtimeAuthority);
  if (runtime.status !== 'OK' || !invocation) return false;
  const schemaPath = schemaPathForContract({ kind: 'proposal' });
  const expectedArgv = buildArgs('codex', null, config.model, {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: invocation.workspaceRoot,
    reasoningEffort: config.reasoningEffort
  });
  const reported = invocation.reportedModel == null
    ? null
    : String(invocation.reportedModel).toLowerCase();
  return invocation.requestedModel === config.model
    && invocation.reasoningEffort === config.reasoningEffort
    && invocation.binaryFamily === 'codex'
    && invocation.modelSelectionAuthority === 'explicit-model-flag'
    && invocation.executableBasename === runtime.record.binary.basename
    && invocation.executableSha256 === runtime.record.binary.sha256
    && invocation.executableBytes === runtime.record.binary.bytes
    && invocation.authMode === 'chatgpt-oauth'
    && invocation.oauthAuthoritySha256 === runtime.record.authoritySha256
    && stableJson(invocation.argv) === stableJson(expectedArgv)
    && invocation.strictIsolation === true
    && stableJson(invocation.disabledFeatures) === stableJson(STRICT_CODEX_DISABLED_FEATURES)
    && invocation.outputSchemaSha256 === sha256(readFileSync(schemaPath))
    && invocation.isolation?.status === 'PASS'
    && (invocation.isolation?.toolCalls || []).length === 0
    && (requireSuccess ? invocation.exitCode === 0 : Number.isInteger(invocation.exitCode))
    && (reported == null || reported === config.model.toLowerCase())
    && invocation.reportedModelMatchesRequest !== false;
}

export function evidenceArtifact(store, runId, id, role, value) {
  return writeCanaryArtifact(store, runId, id, {
    role,
    content: typeof value === 'string' ? value : canonicalJson(value)
  });
}

export function persistInputs(store, runId, prefix, contract) {
  const contractArtifact = evidenceArtifact(
    store,
    runId,
    `${prefix}-contract`,
    'worker-contract',
    contract
  );
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

export function sandboxRecord(result) {
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
    decisionTargetQuality: result.decisionTargetQuality,
    decisionControlQuality: result.decisionControlQuality,
    codeTargetQuality: result.codeTargetQuality,
    codeControlQuality: result.codeControlQuality,
    results: result.results,
    stdoutSha256: result.stdoutSha256 || sha256(''),
    stderrSha256: result.stderrSha256 || sha256(''),
    sandbox: {
      path: result.sandbox?.path || null,
      argv: Array.isArray(result.sandbox?.argv)
        ? result.sandbox.argv.map((value) => String(value)
          .replace(String(result.sandbox?.candidatePath || ''), '<candidate-path>')
          .replace(String(result.sandbox?.capsuleDir || ''), '<candidate-capsule>'))
        : [],
      profileSha256: result.sandbox?.profileSha256 || null
    }
  };
}

export function persistEvaluation(store, runId, prefix, source, result) {
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
  const record = sandboxRecord(result);
  const evaluation = evidenceArtifact(
    store,
    runId,
    `${prefix}-evaluation`,
    'deterministic-evaluation',
    record
  );
  return {
    record,
    candidateArtifactRef: candidate.id,
    candidateSha256: candidate.sha256,
    sandboxStdoutArtifactRef: stdout.id,
    sandboxStdoutSha256: stdout.sha256,
    sandboxStderrArtifactRef: stderr.id,
    sandboxStderrSha256: stderr.sha256,
    evaluationArtifactRef: evaluation.id,
    evaluationSha256: evaluation.sha256
  };
}

export function artifactMatches(artifact) {
  return artifact
    && isSafeId(artifact.id)
    && typeof artifact.content === 'string'
    && SHA256_RE.test(String(artifact.sha256 || ''))
    && artifact.sha256 === sha256(artifact.content);
}

export function readArtifact(store, runId, id) {
  try {
    return isSafeId(id) ? store.readArtifact(runId, id) : null;
  } catch {
    return null;
  }
}

export function parseArtifactJson(artifact) {
  if (!artifactMatches(artifact)) return null;
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

export function callArtifacts(store, runId, call) {
  return Object.fromEntries([
    ['contract', call.contractArtifactRef],
    ['prompt', call.promptArtifactRef],
    ['raw', call.rawArtifactRef],
    ['result', call.resultArtifactRef],
    ['candidate', call.candidateArtifactRef],
    ['evaluation', call.evaluationArtifactRef],
    ['sandboxStdout', call.sandboxStdoutArtifactRef],
    ['sandboxStderr', call.sandboxStderrArtifactRef]
  ].map(([key, id]) => [key, readArtifact(store, runId, id)]));
}

function measurementInput(calls, config, verifierEvidenceSha256) {
  const tasks = config.tasks.map((task) => ({
    taskId: task.id,
    arms: Object.fromEntries(ADAPTIVE_RECURSIVE_CANARY.arms.map((arm) => {
      const call = calls.find((item) => item.taskId === task.id && item.arm === arm);
      return [arm, {
        evaluationArtifactRef: call.evaluationArtifactRef,
        evaluationArtifactSha256: call.evaluationSha256,
        tokenCost: call.cliReportedTotalTokens,
        results: call.evaluation.results.map((item) => ({
          id: item.id,
          group: item.group,
          pass: item.pass,
          decisionPass: item.decisionPass,
          codePass: item.codePass
        }))
      }];
    }))
  }));
  return createAdaptiveMeasurementRecord({
    source: {
      kind: 'adaptive-recursive-canary-v1',
      runId: config.__runId,
      verifierEvidenceSha256,
      evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
      caseSetSha256: sha256(canonicalJson(config.taskMaterials.map((item) => ({
        taskId: item.id,
        caseSetSha256: item.caseSetSha256
      })).sort((left, right) => left.taskId.localeCompare(right.taskId))))
    },
    profile: 'recursive-causal-v1',
    armRoles: {
      baseline: 'cold',
      parent: 'parent',
      treatment: 'candidate',
      sham: 'sham'
    },
    mechanismBindings: {
      baseline: null,
      parent: config.evolutionRecord.parent.programSha256,
      treatment: config.evolutionRecord.candidate.programSha256,
      sham: config.evolutionRecord.candidate.programSha256
    },
    tasks
  });
}

function verifierEvidencePayload(state, config, calls) {
  return {
    schemaVersion: 'adaptive-recursive-verifier-evidence-v1',
    runId: state.runId,
    planSha256: state.plan.sha256,
    configSha256: state.plan.configSha256,
    runtimeAuthoritySha256: config.runtimeAuthority.authoritySha256,
    evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
    implementationManifestSha256: sha256(canonicalJson(config.implementationManifest)),
    calls: calls.map((call) => ({
      callIndex: call.callIndex,
      taskId: call.taskId,
      arm: call.arm,
      treatmentPacketSha256: call.treatmentPacketSha256,
      promptArtifactSha256: call.promptArtifactSha256,
      rawArtifactSha256: readArtifact(state.__store, state.runId, call.rawArtifactRef)?.sha256 || null,
      resultArtifactSha256: readArtifact(state.__store, state.runId, call.resultArtifactRef)?.sha256 || null,
      candidateSha256: call.candidateSha256,
      evaluationSha256: call.evaluationSha256,
      tokenCost: call.cliReportedTotalTokens
    }))
  };
}

function verificationFailure(runId, reason) {
  const base = {
    schemaVersion: 1,
    runId,
    status: 'FAIL',
    experimentValid: false,
    causalPass: false,
    activationEligible: false,
    gates: {},
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function verifyAdaptiveRecursiveCanaryRun(store, runId) {
  const state = store.load(runId);
  if (!state || state.kind !== ADAPTIVE_RECURSIVE_RUN_KIND) {
    return verificationFailure(runId, 'recursive canary state is missing or has the wrong kind');
  }
  const configArtifact = readArtifact(store, runId, state.evidenceArtifacts?.config?.id);
  const config = parseArtifactJson(configArtifact);
  if (!config) return verificationFailure(runId, 'sealed recursive canary config is invalid');
  config.__runId = runId;
  const validation = validateAdaptiveRecursiveCanaryConfig(config, { requireApproval: false });
  const plan = validation.plan;
  const calls = Array.isArray(state.calls) ? state.calls : [];
  const events = Array.isArray(state.verdictEvents) ? state.verdictEvents : [];
  let promptBinding = true;
  let treatmentBinding = true;
  let privateEvidenceWithheld = true;
  let receipts = true;
  let modelAuthority = true;
  let strictIsolation = true;
  let measurementReplay = true;
  let artifactHashes = artifactMatches(configArtifact);
  for (const call of calls) {
    const task = taskById(config, call.taskId);
    const material = materialById(config, call.taskId);
    const expectedContract = task ? repairContract(config, task, call.arm) : null;
    const artifacts = callArtifacts(store, runId, call);
    const contract = parseArtifactJson(artifacts.contract);
    const evaluation = parseArtifactJson(artifacts.evaluation);
    const proposal = verifyPersistedProposalRun(store, runId, call, {
      normalizationContract: expectedContract
    });
    if (!proposal.ok) receipts = false;
    if (!expectedContract
        || stableJson(contract) !== stableJson(expectedContract)
        || artifacts.prompt?.content !== buildAdaptiveExecutableCanaryPrompt(expectedContract)
        || artifacts.prompt?.sha256 !== call.promptArtifactSha256
        || call.promptSha256 !== call.promptArtifactSha256) promptBinding = false;
    const expectedTreatment = mechanismForArm(config, task, call.arm);
    if (stableJson(contract?.mechanismCapsule || null) !== stableJson(expectedTreatment)
        || call.treatmentPacketSha256 !== (expectedTreatment?.packetSha256 || null)) {
      treatmentBinding = false;
    }
    if ([material?.oracle?.path, material?.oracle?.content].filter(Boolean)
      .some((needle) => artifacts.prompt?.content?.includes(needle))) {
      privateEvidenceWithheld = false;
    }
    if (!invocationMatches(config, call)) modelAuthority = false;
    if (call.strictIsolation !== true
        || call.isolation?.status !== 'PASS'
        || (call.isolation?.toolCalls || []).length) strictIsolation = false;
    const replay = artifacts.candidate && material
      ? evaluateExecutableCandidate({
          source: artifacts.candidate.content,
          caseSet: material.caseSet,
          authority: config.evaluatorAuthority,
          taskId: call.taskId,
          diagnostics: true
        })
      : null;
    const replayRecord = replay?.instrumentValid ? sandboxRecord(replay) : null;
    if (!replayRecord
        || stableJson(replayRecord) !== stableJson(evaluation)
        || artifacts.candidate?.sha256 !== call.candidateSha256
        || artifacts.evaluation?.sha256 !== call.evaluationSha256
        || artifacts.sandboxStdout?.sha256 !== call.sandboxStdoutSha256
        || artifacts.sandboxStderr?.sha256 !== call.sandboxStderrSha256) {
      measurementReplay = false;
    }
    if (Object.values(artifacts).some((artifact) => !artifactMatches(artifact))) {
      artifactHashes = false;
    }
  }
  const expectedSchedule = plan?.calls || [];
  const observedSchedule = calls.map((call) => ({
    callIndex: call.callIndex,
    taskId: call.taskId,
    arm: call.arm,
    treatmentPacketSha256: call.treatmentPacketSha256,
    outputSchemaKind: call.outputSchemaKind
  }));
  const schedule = calls.length === ADAPTIVE_RECURSIVE_CANARY.maximumCalls
    && events.length === calls.length
    && stableJson(observedSchedule) === stableJson(expectedSchedule)
    && events.every((event, index) => (
      event.callIndex === calls[index].callIndex
      && event.taskId === calls[index].taskId
      && event.arm === calls[index].arm
      && event.accepted === true
      && event.attempt === 0
    ));
  const noRetries = events.length === ADAPTIVE_RECURSIVE_CANARY.maximumCalls
    && events.every((event) => event.attempt === 0)
    && new Set(events.map((event) => `${event.taskId}:${event.arm}`)).size === events.length;
  const noPromotion = state.promotion?.enabled === false
    && state.promotion?.recorded === false;
  const baseGates = {
    configIntegrity: validation.ok,
    implementationIntegrity: validateImplementation(config),
    taskMaterialIntegrity: validateTaskMaterials(config),
    promptBinding,
    treatmentBinding,
    privateEvidenceWithheld,
    receipts,
    modelAuthority,
    strictIsolation,
    measurementReplay,
    artifactHashes,
    schedule,
    noRetries,
    noPromotion,
    terminalState: state.status === 'QUEUE_DRAINED'
      && state.approvedPlanSha256 === plan?.sha256
      && state.plan?.sha256 === plan?.sha256
  };
  const preMeasurementValid = Object.values(baseGates).every(Boolean);
  const evidencePayload = preMeasurementValid
    ? verifierEvidencePayload({ ...state, __store: store }, config, calls)
    : null;
  const verifierEvidenceSha256 = evidencePayload
    ? sha256(canonicalJson(evidencePayload))
    : null;
  const measured = preMeasurementValid
    ? measurementInput(calls.map((call) => ({
        ...call,
        evaluation: parseArtifactJson(readArtifact(store, runId, call.evaluationArtifactRef))
      })), config, verifierEvidenceSha256)
    : refused('RECURSIVE_MEASUREMENT_BLOCKED', 'Pre-measurement verifier gates failed.');
  let verified = null;
  let active = null;
  let rejected = null;
  if (measured.status === 'OK') {
    const verification = verifyMechanismEvolution({
      currentRecord: config.evolutionRecord,
      parentFamily: config.parentFamily,
      candidateFamily: config.candidateFamily,
      measurementRecord: measured.record,
      verifierEvidenceSha256,
      recordedAt: state.completedAt
    });
    if (verification.status === 'OK') {
      verified = verification.record;
      const activation = activateMechanismEvolution({
        currentRecord: verified,
        parentFamily: config.parentFamily,
        candidateFamily: config.candidateFamily,
        activationEvidenceSha256: verifierEvidenceSha256,
        recordedAt: state.completedAt
      });
      if (activation.status === 'OK') active = activation.record;
    } else {
      const rejection = rejectMechanismEvolution({
        currentRecord: config.evolutionRecord,
        parentFamily: config.parentFamily,
        candidateFamily: config.candidateFamily,
        rejectionEvidenceSha256: verifierEvidenceSha256,
        reasonCodes: ['RECURSIVE_CAUSAL_GATES_FAILED'],
        recordedAt: state.completedAt
      });
      if (rejection.status === 'OK') rejected = rejection.record;
    }
  }
  const derived = state.derivedArtifacts || {};
  const derivedArtifactMatches = (ref, record) => {
    if (!ref) return true;
    const artifact = readArtifact(store, runId, ref.id);
    return artifactMatches(artifact)
      && artifact.sha256 === ref.sha256
      && artifact.content === canonicalJson(record);
  };
  const derivedArtifacts = derivedArtifactMatches(derived.measurement, measured.record)
    && derivedArtifactMatches(derived.verifiedEvolution, verified)
    && derivedArtifactMatches(derived.activeEvolution, active)
    && derivedArtifactMatches(derived.rejectedEvolution, rejected);
  const gates = {
    ...baseGates,
    measurementBuilt: measured.status === 'OK',
    derivedArtifacts
  };
  const experimentValid = Object.values(gates).every(Boolean);
  const causalPass = experimentValid && !!verified && !!active;
  const reasons = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => `${name} gate failed`);
  if (experimentValid && !causalPass) reasons.push('candidate did not pass recursive causal admission');
  const tokenUsage = {
    observedCalls: calls.length,
    measuredCalls: calls.filter((call) => Number.isInteger(call.cliReportedTotalTokens)).length,
    total: calls.every((call) => Number.isInteger(call.cliReportedTotalTokens))
      ? calls.reduce((sum, call) => sum + call.cliReportedTotalTokens, 0)
      : null,
    byArm: Object.fromEntries(ADAPTIVE_RECURSIVE_CANARY.arms.map((arm) => {
      const rows = calls.filter((call) => call.arm === arm);
      return [arm, {
        calls: rows.length,
        total: rows.every((call) => Number.isInteger(call.cliReportedTotalTokens))
          ? rows.reduce((sum, call) => sum + call.cliReportedTotalTokens, 0)
          : null
      }];
    }))
  };
  const base = {
    schemaVersion: 1,
    runId,
    status: experimentValid ? 'PASS' : 'FAIL',
    experimentValid,
    causalPass,
    activationEligible: causalPass,
    promotionEnabled: false,
    modelAuthority: {
      requestedModel: config.model,
      reasoningEffort: config.reasoningEffort,
      authMode: config.runtimeAuthority.authMode,
      observedCalls: calls.length,
      backendReportedCalls: calls.filter((call) => call.reportedModel != null).length
    },
    gates,
    verifierEvidenceSha256,
    measurement: measured.status === 'OK' ? measured.record : null,
    verifiedEvolution: verified,
    activeEvolution: active,
    rejectedEvolution: rejected,
    tokenUsage,
    armResults: measured.status === 'OK' ? measured.record.arms : null,
    contrasts: measured.status === 'OK' ? measured.record.contrasts : null,
    reasons
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

function renderReport(state, verification) {
  const rows = ADAPTIVE_RECURSIVE_CANARY.arms.map((arm) => {
    const result = verification.armResults?.[arm];
    return result
      ? `| ${arm} | ${result.total.exact}/${result.total.cases} | ${result.total.decisions}/${result.total.cases} | ${result.fullRepairs}/${result.tasks} | ${result.tokenCost} |`
      : `| ${arm} | - | - | - | - |`;
  });
  return [
    '# Adaptive Recursive Canary',
    '',
    `- run: \`${state.runId}\``,
    `- status: **${verification.status}**`,
    `- experiment valid: **${verification.experimentValid}**`,
    `- causal pass: **${verification.causalPass}**`,
    `- active routing eligible: **${verification.activationEligible}**`,
    `- model: \`${verification.modelAuthority.requestedModel}\``,
    `- reasoning: \`${verification.modelAuthority.reasoningEffort}\``,
    `- verifier evidence: \`${verification.evidenceSha256}\``,
    '',
    '| arm | exact cases | decisions | full repairs | tokens |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
    '## Contrasts',
    '',
    `- candidate vs cold exact delta: ${verification.contrasts?.treatmentVsBaseline?.metrics?.exact?.delta ?? 'unmeasured'}`,
    `- candidate vs parent exact delta: ${verification.contrasts?.treatmentVsParent?.metrics?.exact?.delta ?? 'unmeasured'}`,
    `- sham vs cold exact delta: ${verification.contrasts?.shamVsBaseline?.metrics?.exact?.delta ?? 'unmeasured'}`,
    `- candidate vs parent token delta: ${verification.contrasts?.treatmentVsParent?.tokenCost?.relativeDelta ?? 'unmeasured'}`,
    '',
    'No canonical loop was promoted or modified. A passing descendant is eligible only for adaptive routing.',
    ''
  ].join('\n');
}

export function runAdaptiveRecursiveCanary(store, config, {
  runId,
  worker = adaptiveRecursiveCanaryWorker,
  clock = nowIso
} = {}) {
  if (!isSafeId(runId)) return refused('BAD_RUN_ID', 'A safe recursive --run-id is required.');
  if (store.exists(runId)) return refused('RUN_EXISTS', 'Recursive canary runs are append-only.');
  if (typeof worker !== 'function') return refused('NO_WORKER', 'Recursive canary requires a worker backend.');
  const validation = validateAdaptiveRecursiveCanaryConfig(config);
  if (!validation.ok) {
    return refused('RECURSIVE_CANARY_CONFIG_INVALID', validation.errors.join('; '), {
      errors: validation.errors,
      plan: validation.plan
    });
  }
  const createdAt = clock();
  const state = {
    schemaVersion: 1,
    kind: ADAPTIVE_RECURSIVE_RUN_KIND,
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'RUNNING',
    approvedPlanSha256: config.approvedPlanSha256,
    plan: validation.plan,
    evidenceArtifacts: {},
    derivedArtifacts: {},
    calls: [],
    verdictEvents: [],
    failureEvidence: [],
    promotion: { enabled: false, recorded: false },
    verification: null,
    outcome: null,
    blocker: null,
    reportPath: null
  };
  store.save(state);
  state.evidenceArtifacts = {
    config: evidenceArtifact(store, runId, 'sealed-recursive-config', 'config', config),
    plan: evidenceArtifact(store, runId, 'sealed-recursive-plan', 'plan', validation.plan),
    runtimeAuthority: evidenceArtifact(store, runId, 'sealed-codex-oauth-authority', 'runtime-authority', config.runtimeAuthority),
    evaluatorAuthority: evidenceArtifact(store, runId, 'sealed-executable-evaluator-authority', 'evaluator-authority', config.evaluatorAuthority),
    implementation: evidenceArtifact(store, runId, 'sealed-recursive-implementation', 'implementation', config.implementationCapsule),
    taskMaterials: evidenceArtifact(store, runId, 'sealed-recursive-task-materials', 'task-materials', config.taskMaterials),
    proposalSchema: evidenceArtifact(store, runId, 'proposal-output-schema', 'output-schema', readFileSync(schemaPathForContract({ kind: 'proposal' }), 'utf8'))
  };
  store.save(state);

  const block = (code, message, packet = null, context = {}) => {
    if (packet) {
      state.failureEvidence.push(persistRejectedDispatch(store, runId, packet, config.model, {
        artifactPrefix: `failed-${String(state.verdictEvents.length).padStart(2, '0')}`,
        kind: 'recursive-repair',
        reasons: [code],
        attempt: 0,
        context
      }));
    }
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.updatedAt = clock();
    store.save(state);
    const verification = verifyAdaptiveRecursiveCanaryRun(store, runId);
    state.verification = verification;
    state.outcome = { experimentValid: false, causalPass: false };
    state.reportPath = store.writeRunFile(runId, 'adaptive-recursive-canary-report.md', renderReport(state, verification));
    store.save(state);
    return { status: 'BLOCKED', code, message, runId, verification, reportPath: state.reportPath };
  };

  for (const scheduled of validation.plan.calls) {
    const task = taskById(config, scheduled.taskId);
    const contract = repairContract(config, task, scheduled.arm);
    const prefix = `call-${String(scheduled.callIndex + 1).padStart(2, '0')}`;
    const inputs = persistInputs(store, runId, prefix, contract);
    let packet;
    try {
      packet = worker({ ...contract, attempt: 0 });
    } catch (error) {
      packet = { __execReason: 'WORKER_THROW', __error: String(error?.message || error) };
    }
    const payload = proposalPayload(contract, packet);
    const accepted = !!payload && invocationMatches(config, packet?.invocation);
    state.verdictEvents.push({
      ...scheduled,
      accepted,
      attempt: 0,
      reasons: accepted ? [] : [payload ? 'MODEL_AUTHORITY_UNPROVEN' : 'REPAIR_OUTPUT_INVALID'],
      invocation: packet?.invocation || null
    });
    store.save(state);
    if (!payload) {
      return block('REPAIR_OUTPUT_INVALID', `${task.id} returned an invalid bound repair.`, packet, {
        ...scheduled,
        ...inputs
      });
    }
    if (!invocationMatches(config, packet.invocation)) {
      return block('MODEL_AUTHORITY_UNPROVEN', `${task.id} model authority or isolation did not match the sealed plan.`, packet, {
        ...scheduled,
        ...inputs
      });
    }
    const persisted = persistCanaryProposal(store, runId, packet, config.model, {
      artifactPrefix: prefix,
      normalizationContract: contract
    });
    if (!persisted.ok) {
      return block('REPAIR_RECEIPT_INVALID', `${task.id}: ${persisted.reason}`, packet, {
        ...scheduled,
        ...inputs
      });
    }
    const material = materialById(config, task.id);
    const evaluation = evaluateExecutableCandidate({
      source: persisted.revisedContent,
      caseSet: material.caseSet,
      authority: config.evaluatorAuthority,
      taskId: task.id,
      diagnostics: true
    });
    if (!evaluation.instrumentValid) {
      return block('EXECUTABLE_EVALUATOR_INVALID', `${task.id}: ${evaluation.code}`, packet, {
        ...scheduled,
        ...inputs
      });
    }
    const measured = persistEvaluation(store, runId, prefix, persisted.revisedContent, evaluation);
    state.calls.push({
      ...persisted.record,
      ...inputs,
      ...scheduled,
      sourceSha256: material.source.sha256,
      incidentSha256: material.incident.sha256,
      interfaceSha256: material.interface.semanticSha256,
      oracleSha256: material.oracle.sha256,
      candidateArtifactRef: measured.candidateArtifactRef,
      candidateSha256: measured.candidateSha256,
      sandboxStdoutArtifactRef: measured.sandboxStdoutArtifactRef,
      sandboxStdoutSha256: measured.sandboxStdoutSha256,
      sandboxStderrArtifactRef: measured.sandboxStderrArtifactRef,
      sandboxStderrSha256: measured.sandboxStderrSha256,
      evaluationArtifactRef: measured.evaluationArtifactRef,
      evaluationSha256: measured.evaluationSha256
    });
    state.updatedAt = clock();
    store.save(state);
  }

  state.status = 'QUEUE_DRAINED';
  state.completedAt = clock();
  state.updatedAt = state.completedAt;
  store.save(state);
  let verification = verifyAdaptiveRecursiveCanaryRun(store, runId);
  if (verification.measurement) {
    state.derivedArtifacts.measurement = evidenceArtifact(store, runId, 'derived-recursive-measurement', 'measurement-v2', verification.measurement);
  }
  if (verification.verifiedEvolution) {
    state.derivedArtifacts.verifiedEvolution = evidenceArtifact(store, runId, 'derived-verified-evolution', 'verified-evolution', verification.verifiedEvolution);
  }
  if (verification.activeEvolution) {
    state.derivedArtifacts.activeEvolution = evidenceArtifact(store, runId, 'derived-active-evolution', 'active-evolution', verification.activeEvolution);
  }
  if (verification.rejectedEvolution) {
    state.derivedArtifacts.rejectedEvolution = evidenceArtifact(store, runId, 'derived-rejected-evolution', 'rejected-evolution', verification.rejectedEvolution);
  }
  store.save(state);
  verification = verifyAdaptiveRecursiveCanaryRun(store, runId);
  state.verification = verification;
  state.outcome = {
    experimentValid: verification.experimentValid,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible
  };
  state.reportPath = store.writeRunFile(runId, 'adaptive-recursive-canary-report.md', renderReport(state, verification));
  store.save(state);
  return {
    status: 'OK',
    runId,
    reportPath: state.reportPath,
    statePath: `${store.runDir(runId)}/state.json`,
    experimentValid: verification.experimentValid,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible,
    verification
  };
}
