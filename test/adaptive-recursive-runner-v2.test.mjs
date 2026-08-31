import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAdaptiveExecutableCanaryPrompt,
  captureExecutableEvaluatorAuthority
} from '../src/adaptive-executable-canary.mjs';
import {
  prepareAdaptiveRecursiveCanaryV2Config
} from '../src/adaptive-recursive-canary-v2.mjs';
import {
  normalizeAdaptiveRecursivePacket
} from '../src/adaptive-recursive-runner.mjs';
import {
  runAdaptiveRecursiveCanaryV2,
  verifyAdaptiveRecursiveCanaryV2Run
} from '../src/adaptive-recursive-runner-v2.mjs';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import {
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution
} from '../src/mechanism-evolution.mjs';
import {
  canonicalMechanismProgramJson,
  compileMechanismProgram,
  normalizeMechanismProgram
} from '../src/mechanism-compiler.mjs';
import { createMechanismMutationPlan } from '../src/mechanism-mutation.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import {
  listAdaptiveRecords,
  persistAdaptiveRecord,
  persistAdaptiveRecursiveCanaryV2Result
} from '../src/mechanism-catalog.mjs';
import { createBaselinePolicyEpoch } from '../src/adaptive-policy.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import { ADAPTIVE_SCHEMA } from '../src/adaptive-records.mjs';
import {
  MECHANISM_EVOLUTION_ADMISSION_V2
} from '../src/mechanism-evolution-admission-v2.mjs';
import {
  RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
} from '../src/adaptive-recursive-statistics.mjs';
import { sha256 } from '../src/util.mjs';

const isDarwin = process.platform === 'darwin';
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
  const root = `replicatedDomain${index}`;
  return {
    schemaVersion: 'executable-interface-contract-v2',
    exportName: 'decide',
    inputPaths: [`${root}.baselineQuality`, `${root}.candidateQuality`],
    decisions: ['ACCEPT', 'REJECT'],
    codes: [
      { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
      { value: 'NO_GAIN', meaning: 'Quality did not increase.' },
      { value: 'MANUAL_REVIEW', meaning: 'Equal values need review.' }
    ],
    roleBindings: [
      { role: 'baseline.quality', path: `${root}.baselineQuality` },
      { role: 'candidate.quality', path: `${root}.candidateQuality` }
    ]
  };
}

function shadowFixture() {
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
      measurementId: `measurement-${sha256('runner-v2-source').slice(0, 24)}`,
      measurementSha256: sha256('runner-v2-source-record'),
      failureCaseSetSha256: sha256('runner-v2-failures'),
      successCaseSetSha256: sha256('runner-v2-successes'),
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
    reasonCodes: ['FAILED_FALLBACK_DISPOSITION'],
    expectedEffectCode: 'MORE_EXACT_CASES'
  });
  assert.equal(mutation.status, 'OK');
  const proposed = proposeMechanismEvolution({
    parentFamily: parent.record,
    mutationPlan: mutation.plan,
    recordedAt: '2026-08-04T20:00:00.000Z'
  });
  assert.equal(proposed.status, 'OK');
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent.record,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [interfaceContract(0)],
    recordedAt: '2026-08-04T20:01:00.000Z'
  });
  assert.equal(shadow.status, 'OK');
  return {
    parentFamily: parent.record,
    candidateFamily: proposed.candidateFamily,
    evolutionRecord: shadow.record
  };
}

function sourceFor(index, mode) {
  const root = `replicatedDomain${index}`;
  if (mode === 'cold') {
    return `// ${root}\nexport function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; }\n`;
  }
  const equal = mode === 'candidate'
    ? "if (candidateQuality === baselineQuality) return { decision: 'REJECT', code: 'MANUAL_REVIEW' };"
    : '';
  return [
    'export function decide(input) {',
    `  const { baselineQuality, candidateQuality } = input.${root};`,
    `  ${equal}`,
    "  if (candidateQuality > baselineQuality) return { decision: 'ACCEPT', code: 'QUALITY_GAIN' };",
    "  return { decision: 'REJECT', code: 'NO_GAIN' };",
    '}',
    ''
  ].join('\n');
}

function caseSet(index) {
  const root = `replicatedDomain${index}`;
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
      row(`target-${index}-1`, 'target', 1, 2, 'ACCEPT', 'QUALITY_GAIN'),
      row(`target-${index}-2`, 'target', 3, 5, 'ACCEPT', 'QUALITY_GAIN'),
      row(`target-${index}-3`, 'target', 4, 4, 'REJECT', 'MANUAL_REVIEW'),
      row(`control-${index}-1`, 'control', 4, 2, 'REJECT', 'NO_GAIN'),
      row(`control-${index}-2`, 'control', 8, 1, 'REJECT', 'NO_GAIN')
    ]
  };
}

function writeTask(root, index, stage) {
  const id = `${stage}-runner-v2-${index}`;
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  const source = sourceFor(index, 'cold');
  const incident = 'Repair gains and equal values while preserving lower-value controls.\n';
  const contract = interfaceContract(index);
  const oracle = `${JSON.stringify(caseSet(index), null, 2)}\n`;
  const paths = {
    source: `${id}/candidate.mjs`,
    incident: `${id}/incident.md`,
    interface: `${id}/interface.json`,
    oracle: `${id}/oracle.json`
  };
  writeFileSync(join(root, paths.source), source);
  writeFileSync(join(root, paths.incident), incident);
  writeFileSync(join(root, paths.interface), `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(root, paths.oracle), oracle);
  const compiled = compileMechanismProgram({ program: PROGRAM, interfaceContract: contract });
  assert.equal(compiled.status, 'OK');
  return {
    id,
    source: { path: paths.source, sha256: sha256(source) },
    incident: { path: paths.incident, sha256: sha256(incident) },
    interface: { path: paths.interface, sha256: compiled.compilation.interfaceSha256 },
    oracle: { path: paths.oracle, sha256: sha256(oracle) },
    interfaceContract: contract
  };
}

function runtimeAuthority(model, reasoningEffort) {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('recursive-v2-fixture-codex'),
    versionOutput: 'codex-cli 0.200.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({
      models: [{
        slug: model,
        display_name: model,
        visibility: 'list',
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: reasoningEffort, description: 'fixture' }],
        default_reasoning_level: reasoningEffort,
        service_tiers: []
      }]
    }),
    requestedModel: model,
    reasoningEffort
  });
  assert.equal(built.status, 'OK');
  return built.record;
}

function strictPacket(contract, revisedContent, authority, tokenOffset) {
  const modelPayload = {
    findingId: 'untrusted-model-id',
    hypothesisId: 'untrusted-model-hypothesis',
    baselineSha256: sha256('untrusted-model-baseline'),
    revisedContent,
    changeSummary: 'Applied the assigned treatment.'
  };
  const rawResult = JSON.stringify(modelPayload);
  const finalOutput = `<IMPROVEMENT>${rawResult}</IMPROVEMENT>`;
  const inputTokens = 500 + tokenOffset;
  const outputTokens = 200;
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({ type: 'agent_message', text: rawResult }),
    JSON.stringify({
      type: 'token_count',
      input_tokens: inputTokens,
      output_tokens: outputTokens
    })
  ].join('\n');
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = `/tmp/recursive-v2-capsule-${tokenOffset}`;
  return normalizeAdaptiveRecursivePacket(contract, {
    route: contract.route,
    phase: contract.phase,
    executorOwned: true,
    rawStdout,
    rawStderr: '',
    finalOutput,
    isolation: { status: 'PASS', toolCalls: [], reasons: [] },
    invocation: {
      requestedModel: contract.route,
      reasoningEffort: contract.reasoningEffort,
      reportedModel: contract.route,
      binaryFamily: 'codex',
      argv: buildArgs('codex', null, contract.route, {
        strictIsolation: true,
        schemaPath,
        workspaceRoot,
        reasoningEffort: contract.reasoningEffort
      }),
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'cli-reported',
      reportedModelMatchesRequest: true,
      executableBasename: authority.binary.basename,
      executableSha256: authority.binary.sha256,
      executableBytes: authority.binary.bytes,
      authMode: 'chatgpt-oauth',
      oauthAuthoritySha256: authority.authoritySha256,
      promptSha256: sha256(buildAdaptiveExecutableCanaryPrompt(contract)),
      strictIsolation: true,
      disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
      workspaceRoot,
      outputSchemaSha256: sha256(readFileSync(schemaPath)),
      rawResultSha256: sha256(rawResult),
      resultNormalization: 'json-schema-v1',
      exitCode: 0,
      stdoutSha256: sha256(rawStdout),
      resultSha256: sha256(finalOutput),
      tokenUsage: inputTokens + outputTokens,
      tokenUsageDetails: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      },
      durationMs: 20,
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  });
}

async function preparedConfig() {
  const root = mkdtempSync(join(tmpdir(), 'recursive-v2-artifacts-'));
  const raw = {
    schemaVersion: 'adaptive-recursive-canary-v2',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    historicalTokenEstimate: 4000000,
    replicatesPerArm: 3,
    calibrationRule: 'paired-placebo-upper-bound-v1',
    confirmationRule: 'five-task-adjusted-sign-test-v1',
    ...shadowFixture(),
    calibrationTasks: Array.from({ length: 5 }, (_, index) => (
      writeTask(root, index + 1, 'calibration')
    )),
    confirmationTasks: Array.from({ length: 5 }, (_, index) => (
      writeTask(root, index + 6, 'confirmation')
    ))
  };
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK');
  const authority = runtimeAuthority(raw.model, raw.reasoningEffort);
  const unapproved = prepareAdaptiveRecursiveCanaryV2Config(raw, {
    artifactRoot: root,
    runtimeAuthorityRecord: authority,
    evaluatorAuthorityRecord: evaluator.record
  });
  assert.equal(unapproved.status, 'OK', JSON.stringify(unapproved));
  const prepared = prepareAdaptiveRecursiveCanaryV2Config(raw, {
    artifactRoot: root,
    runtimeAuthorityRecord: authority,
    evaluatorAuthorityRecord: evaluator.record,
    approvedPlanSha256: unapproved.plan.sha256
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  return prepared.config;
}

function workerFor(config, { candidateWorks = true } = {}) {
  let calls = 0;
  const allTasks = [...config.calibrationTasks, ...config.confirmationTasks];
  return (contract) => {
    calls += 1;
    const taskIndex = allTasks.findIndex((task) => (
      task.id === contract.target.findingId
    ));
    const index = taskIndex + 1;
    const mechanism = contract.mechanismCapsule;
    const semantics = mechanism?.treatmentSemantics
      || mechanism?.items?.[0]?.semantics
      || 'none';
    const familyId = mechanism?.items?.[0]?.familyId || null;
    let mode = !mechanism || semantics === 'irrelevant-control'
      ? 'cold'
      : (familyId === config.parentFamily.familyId ? 'parent' : 'candidate');
    if (!candidateWorks && mode === 'candidate') mode = 'parent';
    return strictPacket(
      contract,
      sourceFor(index, mode),
      config.runtimeAuthority,
      calls
    );
  };
}

test('recursive V2 independently gates and verifies both replicated generations', {
  skip: !isDarwin
}, async () => {
  const config = await preparedConfig();
  const home = mkdtempSync(join(tmpdir(), 'recursive-v2-pass-'));
  const store = createStore(home);
  assert.throws(() => runAdaptiveRecursiveCanaryV2(store, config, {
    runId: 'recursive-v2-causal-pass',
    worker: workerFor(config),
    clock: () => '2026-08-04T22:00:00.000Z',
    onCallPersisted: () => {
      throw new Error('simulated process loss after a durable call');
    }
  }), /simulated process loss/);
  assert.equal(store.load('recursive-v2-causal-pass').calls.length, 1);
  const result = runAdaptiveRecursiveCanaryV2(store, config, {
    runId: 'recursive-v2-causal-pass',
    worker: workerFor(config),
    clock: () => '2026-08-04T22:00:00.000Z'
  });
  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.experimentValid, true, JSON.stringify(result.verification.reasons));
  assert.equal(result.calibrationQualified, true);
  assert.equal(result.causalPass, true, JSON.stringify(result.verification.reasons));
  assert.equal(result.activationEligible, true);
  assert.equal(result.verification.tokenUsage.observedCalls, 120);
  assert.equal(result.verification.calibrationAnalysis.summary.blockCount, 15);
  assert.equal(result.verification.confirmationAnalysis.summary.blockCount, 15);
  assert.equal(result.verification.confirmationAnalysis.summary.adjustedTaskSignTest.wins, 5);
  assert.equal(result.verification.activeAdmission.state, 'ACTIVE');
  assert.equal(result.verification.activeAdmission.authority.activation, 'routing-only');
  const injected = persistAdaptiveRecord({
    homeDir: home,
    record: result.verification.activeAdmission
  });
  assert.equal(injected.code, 'MECHANISM_EVOLUTION_ADMISSION_VERIFIER_REQUIRED');
  const imported = persistAdaptiveRecursiveCanaryV2Result({
    homeDir: home,
    sourceStore: store,
    runId: 'recursive-v2-causal-pass'
  });
  assert.equal(imported.status, 'OK', imported.message);
  assert.equal(imported.activationEligible, true);
  const catalog = listAdaptiveRecords({ homeDir: home });
  assert.equal(catalog.status, 'OK');
  const epoch = createBaselinePolicyEpoch({ policyScopeId: 'recursive-v2-test' });
  assert.equal(epoch.status, 'OK');
  const routed = buildMechanismRoutingDecision({
    families: catalog.records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
    )),
    applications: [],
    evolutions: catalog.records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION
    )),
    measurements: catalog.records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT
    )),
    admissions: catalog.records.filter((record) => (
      record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2
    )),
    analyses: catalog.records.filter((record) => (
      record.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
    )),
    target: {
      taskMode: 'improve',
      loopRole: 'supervisor',
      taskValueDimensions: ['exactness'],
      resourceDimensions: ['token-cost']
    },
    policyEpoch: epoch.record,
    seed: 'recursive-v2-active-routing',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  assert.equal(routed.filtered.validActiveEvolutions, 1);
  assert.ok(routed.candidatePool.some((item) => (
    item.familyId === config.candidateFamily.familyId
  )));
  const replay = verifyAdaptiveRecursiveCanaryV2Run(store, 'recursive-v2-causal-pass');
  assert.equal(replay.experimentValid, true, JSON.stringify(replay.reasons));
  assert.equal(replay.evidenceSha256, result.verification.evidenceSha256);
});

test('recursive V2 stops after calibration when replicated candidate lift is absent', {
  skip: !isDarwin
}, async () => {
  const config = await preparedConfig();
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-v2-reject-')));
  const result = runAdaptiveRecursiveCanaryV2(store, config, {
    runId: 'recursive-v2-calibration-reject',
    worker: workerFor(config, { candidateWorks: false }),
    clock: () => '2026-08-04T22:30:00.000Z'
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, JSON.stringify(result.verification.reasons));
  assert.equal(result.calibrationQualified, false);
  assert.equal(result.causalPass, false);
  assert.equal(result.verification.tokenUsage.observedCalls, 60);
  assert.equal(result.verification.confirmationMeasurement, null);
  assert.equal(result.verification.rejectedEvolution.state, 'REJECTED');
  assert.deepEqual(
    result.verification.rejectedEvolution.reasonCodes,
    ['REPLICATED_CALIBRATION_FAILED']
  );
});

test('recursive V2 verifier rejects a tampered evaluation artifact', {
  skip: !isDarwin
}, async () => {
  const config = await preparedConfig();
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-v2-tamper-')));
  const result = runAdaptiveRecursiveCanaryV2(store, config, {
    runId: 'recursive-v2-tamper',
    worker: workerFor(config),
    clock: () => '2026-08-04T23:00:00.000Z'
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('recursive-v2-tamper');
  const call = state.calls[0];
  const artifact = store.readArtifact('recursive-v2-tamper', call.evaluationArtifactRef);
  const evaluation = JSON.parse(artifact.content);
  evaluation.results[0].pass = !evaluation.results[0].pass;
  const content = JSON.stringify(evaluation);
  store.writeArtifact('recursive-v2-tamper', artifact.id, {
    ...artifact,
    content,
    sha256: sha256(content)
  });
  const replay = verifyAdaptiveRecursiveCanaryV2Run(store, 'recursive-v2-tamper');
  assert.equal(replay.experimentValid, false);
  assert.equal(replay.gates.measurementReplay, false);
});
