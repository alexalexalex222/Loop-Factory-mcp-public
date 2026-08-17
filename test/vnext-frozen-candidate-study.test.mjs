import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import { captureExecutableEvaluatorAuthority } from '../src/adaptive-executable-canary.mjs';
import { compileAdaptiveRecursiveTaskTreatments } from '../src/adaptive-recursive-canary.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution
} from '../src/mechanism-evolution.mjs';
import {
  canonicalMechanismProgramJson,
  compileMechanismCapsule,
  normalizeMechanismProgram
} from '../src/mechanism-compiler.mjs';
import { createMechanismMutationPlan } from '../src/mechanism-mutation.mjs';
import { createStore } from '../src/store.mjs';
import { sha256 } from '../src/util.mjs';
import {
  createVNextAblationEvaluatorProofBinding,
  createVNextAblationProtocol,
  createVNextAblationProtocolR6,
  createVNextSemanticJudgeQualificationBinding,
  loadVNextAblationPackDescriptor,
  validateVNextAblationProtocol,
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import {
  createVNextEvaluatorProofPlan,
  persistVNextEvaluatorProofPlan,
  resolveVNextEvaluatorProofImplementation,
  runVNextEvaluatorProof
} from '../src/vnext-evaluator-proof.mjs';
import {
  buildEvaluatorSecurityQualification,
  buildIsolatedEvaluatorRequest,
  createEvaluatorCounterbalanceSeedCommitment
} from '../src/isolated-evaluator.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import {
  assembleVNextCustodianPackage,
  createVNextCustodianPackageManifest,
  renderVNextCustodianRunbook,
  verifyVNextCustodianPackage,
  validateVNextCustodianPackageManifest
} from '../src/vnext-custodian-package.mjs';
import {
  VNEXT_FROZEN_CANDIDATE_PREREQUISITE_SCHEMA,
  VNEXT_FROZEN_CANDIDATE_SOURCE_SCHEMA,
  createVNextFrozenCandidateCustodyBinding,
  createVNextFrozenCandidateStudyPlanFromEvidence,
  persistVNextFrozenCandidateStudyPlan,
  runVNextFrozenCandidateStudy,
  validateVNextFrozenCandidatePrerequisite,
  validateVNextFrozenCandidateStudyPlan,
  validateVNextFrozenCandidateTarget,
  validateVNextFrozenCandidateSource,
  verifyVNextFrozenCandidateCustodyBinding
} from '../src/vnext-frozen-candidate-study.mjs';
import {
  buildVNextTaskPack,
  loadVNextTaskPackMaterials
} from '../src/vnext-task-pack.mjs';
import { createFakeCli } from './fixtures/fake-cli.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const executableEvaluatorTest = process.platform === 'darwin' ? test : test.skip;
const NOW = '2026-08-05T16:00:00.000Z';
const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [{
    metricId: 'quality-delta',
    operator: 'subtract',
    leftRole: 'candidate.quality',
    rightRole: 'baseline.quality'
  }],
  rules: [{
    ruleId: 'accept-quality',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

function interfaceContract(index) {
  const root = `studyDomain${index}`;
  return {
    schemaVersion: 'executable-interface-contract-v2',
    exportName: 'decide',
    inputPaths: [`${root}.baselineQuality`, `${root}.candidateQuality`],
    decisions: ['ACCEPT', 'REJECT'],
    codes: [
      { value: 'MANUAL_REVIEW', meaning: 'Equal values are explicit.' },
      { value: 'NO_GAIN', meaning: 'Quality did not increase.' },
      { value: 'QUALITY_GAIN', meaning: 'Quality increased.' }
    ],
    roleBindings: [
      { role: 'baseline.quality', path: `${root}.baselineQuality` },
      { role: 'candidate.quality', path: `${root}.candidateQuality` }
    ]
  };
}

function source(index) {
  const root = `studyDomain${index}`;
  return [
    'export function decide(input) {',
    `  const { baselineQuality, candidateQuality } = input.${root};`,
    "  if (candidateQuality > baselineQuality) return { decision: 'ACCEPT', code: 'QUALITY_GAIN' };",
    "  return { decision: 'REJECT', code: 'NO_GAIN' };",
    '}',
    ''
  ].join('\n');
}

function oracle(index) {
  const root = `studyDomain${index}`;
  const row = (id, group, baselineQuality, candidateQuality, decision, code) => ({
    id,
    group,
    input: { [root]: { baselineQuality, candidateQuality } },
    expected: { decision, code }
  });
  return {
    schemaVersion: 'executable-case-set-v1',
    exportName: 'decide',
    cases: [
      row(`target-${index}-1`, 'target', 4, 4, 'REJECT', 'MANUAL_REVIEW'),
      row(`target-${index}-2`, 'target', 6, 6, 'REJECT', 'MANUAL_REVIEW'),
      row(`target-${index}-3`, 'target', 9, 9, 'REJECT', 'MANUAL_REVIEW'),
      row(`control-${index}-1`, 'control', 4, 2, 'REJECT', 'NO_GAIN'),
      row(`control-${index}-2`, 'control', 8, 1, 'REJECT', 'NO_GAIN')
    ]
  };
}

function writePack(root, role, offset, evaluatorAuthority, {
  partition = role === 'validation' ? 'validation' : 'development',
  builderKind = 'operator',
  collideWithOffset = null
} = {}) {
  const tasks = [];
  for (let index = 0; index < 10; index += 1) {
    const identityIndex = collideWithOffset == null ? offset + index : collideWithOffset + index;
    const contentIndex = offset + index;
    const taskId = `task-${String(identityIndex).padStart(3, '0')}`;
    const directory = `${role}-${contentIndex}`;
    mkdirSync(join(root, directory), { recursive: true });
    const sourceText = source(contentIndex);
    const incidentText = `Repair the explicit equal-value disposition for ${contentIndex}.\n`;
    const contract = interfaceContract(contentIndex);
    const interfaceText = `${JSON.stringify(contract, null, 2)}\n`;
    const oracleText = `${JSON.stringify(oracle(contentIndex), null, 2)}\n`;
    const paths = {
      source: `${directory}/candidate.mjs`,
      incident: `${directory}/incident.md`,
      interface: `${directory}/interface.json`,
      oracle: `${directory}/oracle.json`
    };
    writeFileSync(join(root, paths.source), sourceText);
    writeFileSync(join(root, paths.incident), incidentText);
    writeFileSync(join(root, paths.interface), interfaceText);
    writeFileSync(join(root, paths.oracle), oracleText);
    tasks.push({
      taskId,
      clusterId: `cluster-${String(identityIndex).padStart(3, '0')}`,
      domain: `domain-${contentIndex}`,
      tags: [index < 5 ? 'qualification' : 'confirmation', 'synthetic']
        .sort(),
      source: { id: `source-${contentIndex}`, path: paths.source, sha256: sha256(sourceText) },
      incident: { id: `incident-${contentIndex}`, path: paths.incident, sha256: sha256(incidentText) },
      interface: { id: `interface-${contentIndex}`, path: paths.interface, sha256: sha256(interfaceText) },
      oracle: { id: `oracle-${contentIndex}`, path: paths.oracle, sha256: sha256(oracleText) },
      interfaceContractSha256: sha256(canonicalVNextJson(contract)),
      publicTaskSpecSha256: sha256(incidentText)
    });
  }
  const built = buildVNextTaskPack({
    artifactRoot: root,
    packId: `pack-${role}`,
    partition,
    createdAt: NOW,
    builderAuthority: { id: `builder-${role}`, kind: builderKind },
    evaluatorAuthorityRecord: evaluatorAuthority,
    tasks
  });
  assert.equal(built.status, 'OK', JSON.stringify(built));
  const materials = loadVNextTaskPackMaterials({
    artifactRoot: root,
    pack: built.pack
  });
  assert.equal(materials.status, 'OK', JSON.stringify(materials));
  const sourceConfig = {
    schemaVersion: 'vnext-test-source-config-v1',
    tasks: tasks.map((task, index) => ({
      id: task.taskId,
      sourcePath: task.source.path,
      specPath: task.incident.path,
      interfacePath: task.interface.path,
      oraclePath: task.oracle.path,
      phase: index < 5 ? 'qualification' : 'confirmation'
    }))
  };
  const sourceConfigBytes = `${canonicalVNextJson(sourceConfig)}\n`;
  const receiptCore = {
    schemaVersion: 'loop-factory-vnext-task-pack-import-v1',
    sourceSchemaVersion: sourceConfig.schemaVersion,
    sourceConfigSha256: sha256(sourceConfigBytes),
    packId: built.pack.packId,
    partition: built.pack.partition,
    packSha256: built.pack.packSha256,
    materialBundleSha256: materials.bundle.bundleSha256,
    taskCount: built.pack.tasks.length,
    qualificationTaskIds: built.pack.tasks.slice(0, 5)
      .map((task) => task.taskId).sort(),
    confirmationTaskIds: built.pack.tasks.slice(5)
      .map((task) => task.taskId).sort(),
    excludedReferencePaths: [],
    referenceContentImported: false,
    finalPartitionAuthority: false,
    activationAuthority: false
  };
  const importReceipt = {
    ...receiptCore,
    receiptSha256: sha256(canonicalVNextJson(receiptCore))
  };
  writeFileSync(join(root, 'source-config.json'), sourceConfigBytes);
  writeFileSync(join(root, 'task-pack.json'), `${canonicalVNextJson(built.pack)}\n`);
  writeFileSync(join(root, 'materials.json'), `${canonicalVNextJson(materials.bundle)}\n`);
  writeFileSync(join(root, 'import-receipt.json'), `${canonicalVNextJson(importReceipt)}\n`);
  if (!['generation', 'retrieval', 'generator', 'validation', 'transfer'].includes(role)) {
    return {
      status: 'OK',
      descriptor: {
        role,
        directory: root,
        packId: built.pack.packId,
        partition: built.pack.partition,
        packSha256: built.pack.packSha256,
        taskIdentitySetSha256: built.pack.taskIdentitySetSha256,
        materialBundleSha256: materials.bundle.bundleSha256,
        importReceiptSha256: importReceipt.receiptSha256,
        sourceConfigSha256: importReceipt.sourceConfigSha256,
        taskCount: 10,
        referenceContentImported: false
      },
      taskPack: built.pack,
      bundle: materials.bundle,
      identities: built.identities
    };
  }
  const loaded = loadVNextAblationPackDescriptor({ role, directory: root });
  assert.equal(loaded.status, 'OK', JSON.stringify(loaded));
  return loaded;
}

function mechanism() {
  const parent = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback',
      interventionKind: 'evidence-bound-fallback',
      operationKind: 'bounded-program-mutation',
      expectedEffectKind: 'more-exact-dispositions',
      preconditions: ['paired-measurement'],
      procedureSteps: ['measure-failure', 'mutate-one-rule', 'verify-disjoint'],
      program: PROGRAM,
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['exactness'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(parent.status, 'OK');
  const normalized = normalizeMechanismProgram(PROGRAM);
  const mutation = createMechanismMutationPlan({
    parent: {
      familyId: parent.record.familyId,
      familySha256: parent.record.familySha256,
      programSha256: normalized.programSha256
    },
    objective: {
      measurementId: `measurement-${sha256('frozen-source').slice(0, 24)}`,
      measurementSha256: sha256('frozen-source-measurement'),
      failureCaseSetSha256: sha256('frozen-source-failures'),
      successCaseSetSha256: sha256('frozen-source-successes'),
      targetMetric: 'exact-case-rate',
      direction: 'increase'
    },
    operations: [{
      action: 'replace',
      collection: 'fallback',
      expectedItemSha256: sha256(canonicalMechanismProgramJson(PROGRAM.fallback)),
      insertBeforeRuleId: null,
      value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
    }],
    reasonCodes: ['FAILED_EQUAL_DISPOSITION'],
    expectedEffectCode: 'MORE_EXACT_CASES'
  });
  assert.equal(mutation.status, 'OK');
  const proposed = proposeMechanismEvolution({
    parentFamily: parent.record,
    mutationPlan: mutation.plan,
    recordedAt: NOW
  });
  assert.equal(proposed.status, 'OK');
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent.record,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [interfaceContract(0)],
    recordedAt: '2026-08-05T16:00:01.000Z'
  });
  assert.equal(shadow.status, 'OK', JSON.stringify(shadow));
  return {
    parentFamily: parent.record,
    candidateFamily: proposed.candidateFamily,
    evolutionRecord: shadow.record
  };
}

function runtimeAuthority() {
  const authority = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('frozen-candidate-fixture-codex'),
    versionOutput: 'codex-cli 0.200.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({
      models: [{
        slug: 'gpt-5.6-sol',
        display_name: 'gpt-5.6-sol',
        visibility: 'list',
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: 'high', description: 'fixture' }],
        default_reasoning_level: 'high',
        service_tiers: []
      }]
    }),
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  });
  assert.equal(authority.status, 'OK');
  return authority.record;
}

async function verifiedEvaluatorProof() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-protocol-evaluator-'));
  const proofHome = join(root, 'proof');
  const authHome = join(root, 'auth');
  mkdirSync(proofHome);
  mkdirSync(authHome);
  writeFileSync(join(authHome, 'auth.json'), '{}\n', { mode: 0o600 });
  const example = JSON.parse(readFileSync(
    join(PACKAGE_ROOT, 'examples/vnext-evaluator-proof.json'),
    'utf8'
  ));
  const request = buildIsolatedEvaluatorRequest(example.requestInput).request;
  const evaluatorOutput = {
    schemaVersion: 'vnext-evaluator-output-v1',
    rubricSha256: request.rubricSha256,
    measurements: request.publicRubric.dimensions.map(({ id }) => ({
      dimension: id,
      score: 0.8,
      evidenceRefs: ['incident-window'],
      confidence: 0.7
    })),
    uncertainty: 0.3,
    protocolViolations: []
  };
  const lines = [
    {
      type: 'thread.started',
      thread_id: 'local-protocol-proof',
      model: 'gpt-5.6-sol'
    },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'item-0',
        type: 'agent_message',
        text: JSON.stringify(evaluatorOutput)
      }
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 12,
        cached_input_tokens: 0,
        output_tokens: 8,
        reasoning_output_tokens: 0
      }
    }
  ];
  const binaryPath = createFakeCli(
    root,
    process.platform === 'win32' ? 'codex' : 'codex.real',
    { stdout: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n` }
  );
  const authority = createCodexOAuthAuthorityRecord({
    binaryPath,
    binaryBytes: readFileSync(binaryPath),
    versionOutput: 'codex-cli 0.200.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({
      models: [{
        slug: 'gpt-5.6-sol',
        display_name: 'gpt-5.6-sol',
        visibility: 'list',
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: 'high', description: 'fixture' }],
        default_reasoning_level: 'high',
        service_tiers: []
      }]
    }),
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  });
  assert.equal(authority.status, 'OK');
  const built = createVNextEvaluatorProofPlan({
    packageRoot: PACKAGE_ROOT,
    proofHome,
    proofId: 'protocol-evaluator-proof',
    createdAt: NOW,
    runtimeAuthority: authority.record,
    ...example
  });
  assert.equal(built.status, 'OK', built.message);
  const persisted = persistVNextEvaluatorProofPlan(built);
  assert.equal(persisted.status, 'OK', persisted.message);
  const times = [NOW, '2026-08-05T16:00:01.000Z'];
  const verified = await runVNextEvaluatorProof({
    plan: built.plan,
    directory: built.directory,
    approvedPlanSha256: built.plan.planSha256,
    env: {
      ...process.env,
      CODEX_HOME: authHome,
      SUPER_LOOP_ALLOW_EXEC: '1',
      SUPER_LOOP_CODEX_BIN: binaryPath,
      SUPER_LOOP_REQUIRE_CHATGPT_OAUTH: '1',
      SUPER_LOOP_CODEX_EXECUTABLE_SHA256: authority.record.binary.sha256,
      SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256: authority.record.authoritySha256
    },
    clock: () => times.shift()
  });
  assert.equal(verified.status, 'OK', JSON.stringify(verified));
  const workerPacket = JSON.parse(readFileSync(
    join(verified.result.invocation.stateDirectory, 'worker-result.json'),
    'utf8'
  ));
  assert.equal(typeof workerPacket.stdoutDiagnostic?.text, 'string');
  assert.equal(Object.hasOwn(workerPacket, 'stdout'), false);
  return verified;
}

function sourceSnapshot(sourceHome, frozenCandidate) {
  const candidateCore = structuredClone(frozenCandidate);
  const core = {
    schemaVersion: VNEXT_FROZEN_CANDIDATE_SOURCE_SCHEMA,
    sourceHome,
    sourceRunId: 'validation-b6-run',
    sourceStateSha256: sha256('validation-state'),
    sourceConfigArtifactId: 'validation-config',
    sourceConfigArtifactSha256: sha256('validation-config-bytes'),
    sourceVerifierEvidenceSha256: sha256('validation-verifier'),
    sourceLeaseEvidenceSha256: sha256('validation-lease'),
    sourceTaskPartition: 'validation',
    sourceTaskPackSha256: sha256('validation-pack'),
    sourceBindingSha256: sha256('validation-binding'),
    confirmationAnalysisSha256: sha256('validation-analysis'),
    sourceCallCount: 120,
    sourceTokenTotal: 100000,
    zeroShamMovement: true,
    zeroTargetRegressions: true,
    zeroControlRegressions: true,
    frozenCandidate: candidateCore,
    frozenCandidateSha256: sha256(canonicalVNextJson(candidateCore))
  };
  return {
    ...core,
    sourceSnapshotSha256: sha256(canonicalVNextJson(core))
  };
}

function prerequisite(proofHome, protocol, source, transferPack) {
  const core = {
    schemaVersion: VNEXT_FROZEN_CANDIDATE_PREREQUISITE_SCHEMA,
    proofHome,
    studyId: 'transfer-study',
    runId: 'transfer-run',
    role: 'transfer',
    planSha256: sha256('transfer-plan'),
    resultSha256: sha256('transfer-result'),
    evidenceSha256: sha256('transfer-evidence'),
    protocolSha256: protocol.protocolSha256,
    sourceSnapshotSha256: source.sourceSnapshotSha256,
    frozenCandidateSha256: source.frozenCandidateSha256,
    targetPackSha256: transferPack.taskPack.packSha256,
    verifierEvidenceSha256: sha256('transfer-verifier'),
    leaseEvidenceSha256: sha256('transfer-lease'),
    causalPass: true
  };
  return {
    ...core,
    prerequisiteSha256: sha256(canonicalVNextJson(core))
  };
}

let sharedFixture = null;

async function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-frozen-packs-'));
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK');
  const roles = ['generation', 'retrieval', 'generator', 'validation', 'transfer'];
  const packs = roles.map((role, index) => {
    const packRoot = join(root, role);
    mkdirSync(packRoot);
    return writePack(packRoot, role, index * 20, evaluator.record);
  });
  const frozenCandidate = mechanism();
  const evaluatorImplementation = resolveVNextEvaluatorProofImplementation({
    packageRoot: PACKAGE_ROOT
  });
  assert.equal(evaluatorImplementation.status, 'OK');
  assert.equal(createVNextAblationEvaluatorProofBinding({
    status: 'OK',
    plan: {
      proofHome: '/tmp/plan-only-evaluator-proof',
      proofId: 'plan-only-evaluator-proof',
      planSha256: sha256('plan-only-evaluator-plan'),
      implementationSha256: evaluatorImplementation.implementationSha256
    }
  }).status, 'REFUSED');
  const fabricatedEvaluatorProof = createVNextAblationEvaluatorProofBinding({
    status: 'OK',
    plan: {
      proofHome: '/tmp/vnext-frozen-evaluator-proof',
      proofId: 'frozen-evaluator-proof',
      planSha256: sha256('evaluator-proof-plan'),
      implementationSha256: evaluatorImplementation.implementationSha256
    },
    result: {
      resultSha256: sha256('evaluator-proof-result'),
      productionEvidence: true,
      activationAuthority: false
    },
    evidenceSha256: sha256('evaluator-proof-evidence')
  });
  assert.equal(fabricatedEvaluatorProof.status, 'OK');
  const evaluatorVerification = await verifiedEvaluatorProof();
  const evaluatorProof = createVNextAblationEvaluatorProofBinding(
    evaluatorVerification
  );
  assert.equal(evaluatorProof.status, 'OK');
  const protocolInput = {
    packageRoot: PACKAGE_ROOT,
    protocolId: 'frozen-study-protocol',
    createdAt: NOW,
    parentFamily: frozenCandidate.parentFamily,
    modelPolicy: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      authMode: 'chatgpt-oauth'
    },
    evaluatorProof: evaluatorProof.binding,
    consumedEvaluatorProofs: [],
    packs
  };
  assert.equal(createVNextAblationProtocol({
    ...protocolInput,
    evaluatorProof: fabricatedEvaluatorProof.binding
  }).status, 'REFUSED');
  const mismatchedEvaluator = createVNextAblationProtocol({
    ...protocolInput,
    evaluatorProof: {
      ...evaluatorProof.binding,
      implementationSha256: sha256('stale-evaluator')
    }
  });
  assert.equal(mismatchedEvaluator.status, 'REFUSED');
  const protocol = createVNextAblationProtocol(protocolInput);
  assert.equal(protocol.status, 'OK', JSON.stringify(protocol));
  const sourceHome = mkdtempSync(join(tmpdir(), 'vnext-frozen-source-'));
  const source = sourceSnapshot(sourceHome, frozenCandidate);
  assert.equal(validateVNextFrozenCandidateSource(source).status, 'OK');
  return {
    root,
    evaluator: evaluator.record,
    packs,
    protocol: protocol.protocol,
    frozenCandidate,
    source,
    runtimeAuthority: runtimeAuthority()
  };
}

function fixture() {
  if (!sharedFixture) sharedFixture = buildFixture();
  return sharedFixture;
}

executableEvaluatorTest('protocol ledger and frozen transfer plan bind one exact candidate without generation calls', async () => {
  const data = await fixture();
  assert.equal(data.protocol.identityLedger.identityCount, 500);
  assert.equal(data.protocol.exposure.liveEvaluatorCalls, 1);
  assert.equal(data.protocol.exposure.internalMaximumCalls, 1253);
  const resealed = structuredClone(data.protocol);
  resealed.phases[0].maximumCalls += 1;
  const { protocolSha256, ...resealedCore } = resealed;
  resealed.protocolSha256 = sha256(canonicalVNextJson(resealedCore));
  assert.equal(validateVNextAblationProtocol(resealed).status, 'REFUSED');
  const transfer = data.packs.find((row) => row.descriptor.role === 'transfer');
  const target = validateVNextFrozenCandidateTarget({
    role: 'transfer',
    protocol: data.protocol,
    taskPack: transfer.taskPack,
    taskMaterialBundle: transfer.bundle
  });
  assert.equal(target.status, 'OK', target.message);
  const home = mkdtempSync(join(tmpdir(), 'vnext-frozen-plan-'));
  const firstTask = transfer.taskPack.tasks[0];
  const firstMaterial = transfer.bundle.materials[0];
  const compiled = compileAdaptiveRecursiveTaskTreatments({
    task: {
      id: firstTask.taskId,
      source: { path: firstTask.source.path, sha256: firstTask.source.sha256 },
      incident: { path: firstTask.incident.path, sha256: firstTask.incident.sha256 },
      interface: {
        path: firstTask.interface.path,
        sha256: firstTask.interfaceContractSha256
      },
      oracle: { path: firstTask.oracle.path, sha256: firstTask.oracle.sha256 },
      interfaceContract: firstMaterial.interfaceContract
    },
    parentFamily: data.frozenCandidate.parentFamily,
    candidateFamily: data.frozenCandidate.candidateFamily
  });
  const capsuleFor = (family, semantics) => {
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
  };
  const parentCompiled = compileMechanismCapsule({
    capsule: capsuleFor(data.frozenCandidate.parentFamily, 'positive-transfer'),
    interfaceContract: firstMaterial.interfaceContract
  });
  const candidateCompiled = compileMechanismCapsule({
    capsule: capsuleFor(data.frozenCandidate.candidateFamily, 'positive-transfer'),
    interfaceContract: firstMaterial.interfaceContract
  });
  assert.equal(parentCompiled.status, 'OK', JSON.stringify(parentCompiled));
  assert.equal(candidateCompiled.status, 'OK', JSON.stringify(candidateCompiled));
  assert.equal(
    parentCompiled.compiledCapsule.interfaceSha256,
    firstTask.interfaceContractSha256,
    JSON.stringify(parentCompiled)
  );
  assert.equal(compiled.status, 'OK', JSON.stringify(compiled));
  const built = createVNextFrozenCandidateStudyPlanFromEvidence({
    packageRoot: PACKAGE_ROOT,
    proofHome: home,
    studyId: 'transfer-study',
    runId: 'transfer-run',
    role: 'transfer',
    createdAt: NOW,
    protocol: data.protocol,
    sourceSnapshot: data.source,
    taskPack: transfer.taskPack,
    taskMaterialBundle: transfer.bundle,
    runtimeAuthority: data.runtimeAuthority,
    historicalTokenEstimate: 4000000
  });
  assert.equal(built.status, 'OK', JSON.stringify(built));
  assert.equal(built.plan.authority.proposerCalls, 0);
  assert.equal(built.plan.authority.candidateGeneratorCalls, 0);
  assert.equal(built.plan.inner.candidateFrozenAgainstSource, true);
  assert.equal(built.plan.exposure.maximumCalls, 120);
  assert.equal(built.plan.exposure.hardTotalTokenCeiling, 4800000);
  assert.equal(validateVNextFrozenCandidateStudyPlan(built.plan).status, 'OK');
  assert.equal(persistVNextFrozenCandidateStudyPlan({
    directory: built.directory,
    plan: built.plan
  }).status, 'OK');
  const wrongApproval = runVNextFrozenCandidateStudy({
    proofHome: home,
    studyId: 'transfer-study',
    approvedPlanSha256: sha256('wrong-plan')
  });
  assert.equal(wrongApproval.code, 'FROZEN_CANDIDATE_APPROVAL_MISMATCH');
  let calls = 0;
  const injectedSource = runVNextFrozenCandidateStudy({
    proofHome: home,
    studyId: 'transfer-study',
    approvedPlanSha256: built.plan.planSha256,
    worker() { calls += 1; return null; }
  });
  assert.equal(injectedSource.code, 'FROZEN_CANDIDATE_SOURCE_DRIFT');
  assert.equal(calls, 0);
  assert.equal(createStore(home).exists('transfer-run'), false);
});

executableEvaluatorTest('protocol r6 keeps semantic judging outside deterministic causal phases', async () => {
  const data = await fixture();
  const supportedArtifact = {
    text: 'Checkout errors began at 14:05 UTC and no stored payment data was lost.'
  };
  const contradictedArtifact = {
    text: 'All checkout requests failed after stored payment data was deleted.'
  };
  const objectiveVerifierFacts = { formatValid: true };
  const taskLocalEvidence = [{
    id: 'incident-window',
    content: 'Checkout errors began at 14:05 UTC; no stored payment data was lost.'
  }];
  const criteria = [
    'Every factual statement is supported by task-local evidence.',
    'The item covers the required facts.',
    'The item is concise and internally coherent.'
  ];
  let qualification;
  let seeds;
  for (let index = 1; index < 100 && !qualification; index += 1) {
    const candidateSeeds = ['protocol-r6-seed-0', `protocol-r6-seed-${index}`];
    const commitment = createEvaluatorCounterbalanceSeedCommitment({
      qualificationId: 'semantic-judge-r6',
      seeds: candidateSeeds,
      committedAt: NOW
    });
    const candidate = buildEvaluatorSecurityQualification({
      seedCommitment: commitment.commitment,
      seeds: candidateSeeds,
      supportedArtifact,
      contradictedArtifact,
      objectiveVerifierFacts,
      taskLocalEvidence,
      criteria,
      scale: { minimum: 0, maximum: 1 }
    });
    if (candidate.status === 'OK') {
      qualification = candidate.qualification;
      seeds = candidateSeeds;
    }
  }
  assert.ok(qualification);
  const proofHome = mkdtempSync(join(tmpdir(), 'semantic-judge-r6-plans-'));
  const authority = runtimeAuthority();
  const plans = qualification.forms.map((form, index) => {
    const built = createVNextEvaluatorProofPlan({
      packageRoot: PACKAGE_ROOT,
      proofHome,
      proofId: `semantic-judge-r6-form-${index + 1}`,
      createdAt: NOW,
      runtimeAuthority: authority,
      taskId: `semantic-judge-r6-form-${index + 1}`,
      anonymousArmId: `anonymous-form-${index + 1}`,
      prompt: 'Measure both visible items using only the public evidence and rubric.',
      timeoutMs: 600000,
      requestInput: {
        taskSpecification: form.request.taskSpecification,
        publicRubric: form.request.publicRubric,
        anonymousCandidateArtifact: supportedArtifact,
        objectiveVerifierFacts,
        taskLocalEvidence,
        pairwise: {
          secondAnonymousArtifact: contradictedArtifact,
          seed: seeds[index]
        }
      }
    });
    assert.equal(built.status, 'OK', built.message);
    assert.equal(persistVNextEvaluatorProofPlan(built).status, 'OK');
    return built.plan;
  });
  const binding = createVNextSemanticJudgeQualificationBinding({
    qualification,
    formPlans: plans,
    packageRoot: PACKAGE_ROOT
  });
  assert.equal(binding.status, 'OK', binding.message);
  const built = createVNextAblationProtocolR6({
    packageRoot: PACKAGE_ROOT,
    protocolId: 'frozen-study-protocol-r6',
    createdAt: NOW,
    parentFamily: data.frozenCandidate.parentFamily,
    modelPolicy: {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      authMode: 'chatgpt-oauth'
    },
    semanticJudgeQualification: binding.binding,
    consumedEvaluatorProofs: [],
    packs: data.packs
  });
  assert.equal(built.status, 'OK', JSON.stringify(built));
  assert.equal(built.protocol.exposure.liveEvaluatorCalls, 0);
  assert.equal(
    built.protocol.exposure.semanticJudgeSecurityQualificationMaximumCalls,
    2
  );
  assert.equal(built.protocol.exposure.internalMaximumCalls, 1252);
  assert.equal(
    built.protocol.semanticJudgeQualification.requiredForDeterministicPhases,
    false
  );
  assert.equal(verifyVNextAblationProtocolFromDisk({
    protocol: built.protocol,
    packageRoot: PACKAGE_ROOT
  }).status, 'OK');

  const tampered = structuredClone(built.protocol);
  tampered.semanticJudgeQualification.causalScoringAuthority = true;
  const bindingCore = structuredClone(tampered.semanticJudgeQualification);
  delete bindingCore.bindingSha256;
  tampered.semanticJudgeQualification.bindingSha256 = sha256(
    canonicalVNextJson(bindingCore)
  );
  const protocolCore = structuredClone(tampered);
  delete protocolCore.protocolSha256;
  tampered.protocolSha256 = sha256(canonicalVNextJson(protocolCore));
  assert.equal(validateVNextAblationProtocol(tampered).status, 'REFUSED');

  const reusedProof = structuredClone(built.protocol);
  reusedProof.consumedEvaluatorProofs = [{
    schemaVersion: 'loop-factory-vnext-consumed-evaluator-proof-v1',
    proofHome: proofHome,
    proofId: reusedProof.semanticJudgeQualification.forms[0].proofId,
    planSha256: sha256('consumed-plan'),
    planFileSha256: sha256('consumed-plan-file'),
    launchSha256: sha256('consumed-launch'),
    launchFileSha256: sha256('consumed-launch-file'),
    failureEvidencePath: 'failure.json',
    failureEvidenceSha256: sha256('consumed-failure'),
    status: 'CONSUMED_FAILURE_NO_RETRY',
    maximumCalls: 1,
    retriesAuthorized: false
  }];
  reusedProof.exposure.historicalConsumedEvaluatorCalls = 1;
  const reusedCore = structuredClone(reusedProof);
  delete reusedCore.protocolSha256;
  reusedProof.protocolSha256 = sha256(canonicalVNextJson(reusedCore));
  assert.equal(validateVNextAblationProtocol(reusedProof).status, 'REFUSED');

  const wrongRole = structuredClone(built.protocol);
  wrongRole.packs[0].role = 'unknown-role';
  wrongRole.phases = wrongRole.phases.map((phase) => (
    phase.packRole === 'generation'
      ? { ...phase, packSha256: undefined }
      : phase
  ));
  const wrongRoleCore = structuredClone(wrongRole);
  delete wrongRoleCore.protocolSha256;
  wrongRole.protocolSha256 = sha256(canonicalVNextJson(wrongRoleCore));
  assert.equal(validateVNextAblationProtocol(wrongRole).status, 'REFUSED');
});

executableEvaluatorTest('external final pack must be disjoint and bind a successful exact transfer prerequisite', async () => {
  const data = await fixture();
  const finalPack = writePack(data.root, 'final', 200, data.evaluator, {
    partition: 'final',
    builderKind: 'external-custodian'
  });
  const accepted = validateVNextFrozenCandidateTarget({
    role: 'final',
    protocol: data.protocol,
    taskPack: finalPack.taskPack,
    taskMaterialBundle: finalPack.bundle
  });
  assert.equal(accepted.status, 'OK', accepted.message);
  assert.equal(accepted.binding.internalIdentityCollisions, 0);

  const colliding = writePack(data.root, 'final-collision', 400, data.evaluator, {
    partition: 'final',
    builderKind: 'external-custodian',
    collideWithOffset: 0
  });
  assert.equal(validateVNextFrozenCandidateTarget({
    role: 'final',
    protocol: data.protocol,
    taskPack: colliding.taskPack,
    taskMaterialBundle: colliding.bundle
  }).code, 'FROZEN_CANDIDATE_FINAL_NOT_DISJOINT');

  const transfer = data.packs.find((row) => row.descriptor.role === 'transfer');
  const transferHome = mkdtempSync(join(tmpdir(), 'vnext-frozen-transfer-proof-'));
  const boundPrerequisite = prerequisite(
    transferHome,
    data.protocol,
    data.source,
    transfer
  );
  assert.equal(validateVNextFrozenCandidatePrerequisite(boundPrerequisite).status, 'OK');
  const home = mkdtempSync(join(tmpdir(), 'vnext-frozen-final-plan-'));
  const built = createVNextFrozenCandidateStudyPlanFromEvidence({
    packageRoot: PACKAGE_ROOT,
    proofHome: home,
    studyId: 'final-study',
    runId: 'final-run',
    role: 'final',
    createdAt: NOW,
    protocol: data.protocol,
    sourceSnapshot: data.source,
    transferPrerequisite: boundPrerequisite,
    taskPack: finalPack.taskPack,
    taskMaterialBundle: finalPack.bundle,
    runtimeAuthority: data.runtimeAuthority,
    historicalTokenEstimate: 4000000
  });
  assert.equal(built.status, 'OK', JSON.stringify(built));
  assert.equal(built.plan.prerequisite.prerequisiteSha256,
    boundPrerequisite.prerequisiteSha256);
  assert.equal(validateVNextFrozenCandidateStudyPlan(built.plan).status, 'OK');

  const missingPrerequisite = createVNextFrozenCandidateStudyPlanFromEvidence({
    packageRoot: PACKAGE_ROOT,
    proofHome: mkdtempSync(join(tmpdir(), 'vnext-frozen-final-missing-')),
    studyId: 'final-missing',
    runId: 'final-missing-run',
    role: 'final',
    createdAt: NOW,
    protocol: data.protocol,
    sourceSnapshot: data.source,
    taskPack: finalPack.taskPack,
    taskMaterialBundle: finalPack.bundle,
    runtimeAuthority: data.runtimeAuthority,
    historicalTokenEstimate: 4000000
  });
  assert.equal(missingPrerequisite.code, 'FROZEN_CANDIDATE_PREREQUISITE_INVALID');
});

executableEvaluatorTest('custodian manifest contains executable authority but no final task or oracle bytes', async () => {
  const data = await fixture();
  const transfer = data.packs.find((row) => row.descriptor.role === 'transfer');
  const transferHome = mkdtempSync(join(tmpdir(), 'vnext-custodian-transfer-'));
  const boundPrerequisite = prerequisite(
    transferHome,
    data.protocol,
    data.source,
    transfer
  );
  const files = [
    { path: 'package.json', bytes: 10, sha256: sha256('package') },
    { path: 'src/runner.mjs', bytes: 20, sha256: sha256('runner') }
  ];
  const built = createVNextCustodianPackageManifest({
    packageId: 'custodian-package',
    generatedAt: NOW,
    protocol: data.protocol,
    source: data.source,
    prerequisite: boundPrerequisite,
    implementationSha256: sha256('implementation'),
    files
  });
  assert.equal(built.status, 'OK', JSON.stringify(built));
  assert.equal(built.manifest.custodyBoundary.finalTaskBytesIncluded, false);
  assert.equal(built.manifest.custodyBoundary.finalTaskPackSha256, null);
  assert.equal(built.manifest.custodyBoundary.finalOracleSha256, null);
  assert.equal(built.manifest.executionContract.candidateRegenerated, false);
  assert.equal(validateVNextCustodianPackageManifest(built.manifest).status, 'OK');
  const tampered = structuredClone(built.manifest);
  tampered.custodyBoundary.finalOpeningsAuthorized = 2;
  const core = structuredClone(tampered);
  delete core.manifestSha256;
  tampered.manifestSha256 = sha256(canonicalVNextJson(core));
  assert.equal(validateVNextCustodianPackageManifest(tampered).status, 'REFUSED');
});

executableEvaluatorTest('custodian capsule verifies and plans from sealed evidence after relocation', async () => {
  const data = await fixture();
  const transfer = data.packs.find((row) => row.descriptor.role === 'transfer');
  const transferHome = mkdtempSync(join(tmpdir(), 'vnext-custodian-relocated-transfer-'));
  const boundPrerequisite = prerequisite(
    transferHome,
    data.protocol,
    data.source,
    transfer
  );
  const stagingParent = mkdtempSync(join(tmpdir(), 'vnext-custodian-staging-'));
  const relocatedParent = mkdtempSync(join(tmpdir(), 'vnext-custodian-relocated-'));
  const stagingRoot = join(stagingParent, 'capsule');
  const relocatedRoot = join(relocatedParent, 'moved capsule');
  const finalRoot = mkdtempSync(join(tmpdir(), 'vnext-custodian-final-pack-'));
  const proofHome = mkdtempSync(join(tmpdir(), 'vnext-custodian-final-proof-'));
  try {
    const assembled = assembleVNextCustodianPackage({
      packageRoot: PACKAGE_ROOT,
      outputRoot: stagingRoot,
      packageId: 'relocatable-custodian-package',
      generatedAt: NOW,
      protocol: data.protocol,
      sourceSnapshot: data.source,
      transferPrerequisite: boundPrerequisite
    });
    assert.equal(assembled.status, 'OK', JSON.stringify(assembled));
    renameSync(stagingRoot, relocatedRoot);

    const verified = verifyVNextCustodianPackage({ packageRoot: relocatedRoot });
    assert.equal(verified.status, 'OK', JSON.stringify(verified));
    assert.equal(verified.packageRoot, realpathSync(relocatedRoot));
    const runbook = readFileSync(join(relocatedRoot, 'CUSTODIAN_RUNBOOK.md'), 'utf8');
    assert.equal(runbook, `${renderVNextCustodianRunbook()}\n`);
    assert.match(runbook, /--package-root "\$PWD"/);
    assert.doesNotMatch(runbook, new RegExp(data.source.sourceHome.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(runbook, new RegExp(transferHome.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const custody = createVNextFrozenCandidateCustodyBinding({ verification: verified });
    assert.equal(custody.status, 'OK', JSON.stringify(custody));
    assert.equal(verifyVNextFrozenCandidateCustodyBinding({
      binding: custody.binding,
      protocol: data.protocol,
      sourceSnapshot: data.source,
      transferPrerequisite: boundPrerequisite
    }).status, 'OK');

    const finalPack = writePack(finalRoot, 'final', 800, data.evaluator, {
      partition: 'final',
      builderKind: 'external-custodian'
    });
    const planned = createVNextFrozenCandidateStudyPlanFromEvidence({
      packageRoot: relocatedRoot,
      proofHome,
      studyId: 'relocated-final-study',
      runId: 'relocated-final-run',
      role: 'final',
      createdAt: NOW,
      protocol: data.protocol,
      sourceSnapshot: data.source,
      transferPrerequisite: boundPrerequisite,
      custodyBinding: custody.binding,
      taskPack: finalPack.taskPack,
      taskMaterialBundle: finalPack.bundle,
      runtimeAuthority: data.runtimeAuthority,
      historicalTokenEstimate: 4_000_000
    });
    assert.equal(planned.status, 'OK', JSON.stringify(planned));
    assert.equal(planned.plan.custody.packageRoot, realpathSync(relocatedRoot));
    assert.equal(planned.plan.custody.bindingSha256, custody.binding.bindingSha256);
    assert.equal(validateVNextFrozenCandidateStudyPlan(planned.plan).status, 'OK');
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
    rmSync(relocatedParent, { recursive: true, force: true });
    rmSync(finalRoot, { recursive: true, force: true });
    rmSync(proofHome, { recursive: true, force: true });
    rmSync(transferHome, { recursive: true, force: true });
  }
});
