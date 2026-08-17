import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAdaptiveRecursiveCanaryPlan
} from '../src/adaptive-recursive-canary.mjs';
import {
  captureExecutableEvaluatorAuthority,
  buildAdaptiveExecutableCanaryPrompt
} from '../src/adaptive-executable-canary.mjs';
import {
  prepareAdaptiveRecursiveCanaryConfig,
  normalizeAdaptiveRecursivePacket,
  runAdaptiveRecursiveCanary,
  verifyAdaptiveRecursiveCanaryRun
} from '../src/adaptive-recursive-runner.mjs';
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
import { createBaselinePolicyEpoch } from '../src/adaptive-policy.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import {
  listAdaptiveRecords,
  persistAdaptiveRecord,
  persistAdaptiveRecursiveCanaryResult
} from '../src/mechanism-catalog.mjs';
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
  const root = `domain${index}`;
  return {
    schemaVersion: 'executable-interface-contract-v2',
    exportName: 'decide',
    inputPaths: [`${root}.baselineQuality`, `${root}.candidateQuality`],
    decisions: ['ACCEPT', 'REJECT'],
    codes: [{
      value: 'QUALITY_GAIN', meaning: 'The candidate quality is higher.'
    }, {
      value: 'NO_GAIN', meaning: 'The candidate quality did not increase.'
    }, {
      value: 'MANUAL_REVIEW', meaning: 'Equal values require a precise manual review disposition.'
    }],
    roleBindings: [{
      role: 'baseline.quality', path: `${root}.baselineQuality`
    }, {
      role: 'candidate.quality', path: `${root}.candidateQuality`
    }]
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
  assert.equal(parent.status, 'OK', parent.message);
  const normalized = normalizeMechanismProgram(PROGRAM);
  const mutation = createMechanismMutationPlan({
    parent: {
      familyId: parent.record.familyId,
      familySha256: parent.record.familySha256,
      programSha256: normalized.programSha256
    },
    objective: {
      measurementId: `measurement-${sha256('recursive-source').slice(0, 24)}`,
      measurementSha256: sha256('recursive-source-record'),
      failureCaseSetSha256: sha256('recursive-source-failures'),
      successCaseSetSha256: sha256('recursive-source-successes'),
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
  assert.equal(mutation.status, 'OK', mutation.message);
  const proposed = proposeMechanismEvolution({
    parentFamily: parent.record,
    mutationPlan: mutation.plan,
    recordedAt: '2026-08-03T20:00:00.000Z'
  });
  assert.equal(proposed.status, 'OK', proposed.message);
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily: parent.record,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts: [interfaceContract(1)],
    recordedAt: '2026-08-03T20:01:00.000Z'
  });
  assert.equal(shadow.status, 'OK', shadow.message);
  return {
    parentFamily: parent.record,
    candidateFamily: proposed.candidateFamily,
    evolutionRecord: shadow.record
  };
}

function sourceFor(index, mode) {
  const root = `domain${index}`;
  if (mode === 'cold') {
    return `export function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; }\n`;
  }
  const manual = mode === 'candidate'
    ? `if (candidateQuality === baselineQuality) return { decision: 'REJECT', code: 'MANUAL_REVIEW' };`
    : '';
  return [
    'export function decide(input) {',
    `  const { baselineQuality, candidateQuality } = input.${root};`,
    `  ${manual}`,
    "  if (candidateQuality > baselineQuality) return { decision: 'ACCEPT', code: 'QUALITY_GAIN' };",
    "  return { decision: 'REJECT', code: 'NO_GAIN' };",
    '}',
    ''
  ].join('\n');
}

function caseSet(index) {
  const root = `domain${index}`;
  const entry = (id, group, baselineQuality, candidateQuality, decision, code) => ({
    id,
    group,
    input: { [root]: { baselineQuality, candidateQuality } },
    expected: { decision, code }
  });
  return {
    schemaVersion: 'executable-case-set-v1',
    exportName: 'decide',
    cases: [
      entry(`target-${index}-1`, 'target', 1, 2, 'ACCEPT', 'QUALITY_GAIN'),
      entry(`target-${index}-2`, 'target', 3, 5, 'ACCEPT', 'QUALITY_GAIN'),
      entry(`target-${index}-3`, 'target', 4, 4, 'REJECT', 'MANUAL_REVIEW'),
      entry(`control-${index}-1`, 'control', 4, 2, 'REJECT', 'NO_GAIN'),
      entry(`control-${index}-2`, 'control', 8, 1, 'REJECT', 'NO_GAIN')
    ]
  };
}

function writeTaskArtifacts(root, index) {
  const id = `recursive-task-${index}`;
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  const source = sourceFor(index, 'cold');
  const incident = 'The controller misses exact gain and equal-value dispositions while controls must remain unchanged.\n';
  const interfaceValue = interfaceContract(index);
  const oracle = `${JSON.stringify(caseSet(index), null, 2)}\n`;
  const paths = {
    source: `${id}/candidate.mjs`,
    incident: `${id}/incident.md`,
    interface: `${id}/interface.json`,
    oracle: `${id}/oracle.json`
  };
  writeFileSync(join(root, paths.source), source, 'utf8');
  writeFileSync(join(root, paths.incident), incident, 'utf8');
  writeFileSync(join(root, paths.interface), `${JSON.stringify(interfaceValue, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, paths.oracle), oracle, 'utf8');
  const compiled = compileMechanismProgram({ program: PROGRAM, interfaceContract: interfaceValue });
  assert.equal(compiled.status, 'OK', compiled.message);
  return {
    id,
    source: { path: paths.source, sha256: sha256(source) },
    incident: { path: paths.incident, sha256: sha256(incident) },
    interface: {
      path: paths.interface,
      sha256: compiled.compilation.interfaceSha256
    },
    oracle: { path: paths.oracle, sha256: sha256(oracle) },
    interfaceContract: interfaceValue
  };
}

function rawConfig(artifactRoot, model = 'gpt-5.6-sol', reasoningEffort = 'high') {
  return {
    schemaVersion: 'adaptive-recursive-canary-v1',
    model,
    reasoningEffort,
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    historicalTokenEstimate: 500000,
    ...shadowFixture(),
    tasks: Array.from({ length: 5 }, (_, index) => writeTaskArtifacts(artifactRoot, index + 1))
  };
}

function runtimeAuthority(model, reasoningEffort, binaryBytes = 'recursive-fixture-codex') {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from(binaryBytes),
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
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function strictPacket(contract, revisedContent, authority, tokenOffset, {
  corruptEchoes = false
} = {}) {
  const payload = {
    findingId: corruptEchoes ? 'model-corrupted-id' : contract.target.findingId,
    hypothesisId: corruptEchoes ? 'model-corrupted-hypothesis' : contract.hypothesis.id,
    baselineSha256: corruptEchoes
      ? sha256('model-corrupted-baseline')
      : contract.target.baselineSha256,
    revisedContent,
    changeSummary: 'Applied the bounded controller repair represented by the assigned treatment.'
  };
  const rawResult = JSON.stringify(payload);
  const finalOutput = `<IMPROVEMENT>${rawResult}</IMPROVEMENT>`;
  const inputTokens = 400 + tokenOffset;
  const outputTokens = 200;
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({ type: 'agent_message', text: rawResult }),
    JSON.stringify({ type: 'token_count', input_tokens: inputTokens, output_tokens: outputTokens })
  ].join('\n');
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = `/tmp/recursive-model-capsule-${tokenOffset}`;
  const packet = {
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
  };
  return corruptEchoes
    ? normalizeAdaptiveRecursivePacket(contract, packet)
    : packet;
}

function causalWorker(config) {
  let calls = 0;
  return (contract) => {
    calls += 1;
    const taskIndex = config.tasks.findIndex((task) => task.id === contract.target.findingId) + 1;
    const mechanism = contract.mechanismCapsule;
    const semantics = mechanism?.treatmentSemantics
      || mechanism?.items?.[0]?.semantics
      || 'none';
    const familyId = mechanism?.items?.[0]?.familyId || null;
    const mode = !mechanism || semantics === 'irrelevant-control'
      ? 'cold'
      : (familyId === config.parentFamily.familyId ? 'parent' : 'candidate');
    return strictPacket(
      contract,
      sourceFor(taskIndex, mode),
      config.runtimeAuthority,
      calls,
      { corruptEchoes: true }
    );
  };
}

async function preparedFixture() {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursive-artifacts-'));
  const raw = rawConfig(artifactRoot);
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK', evaluator.message);
  const authority = runtimeAuthority(raw.model, raw.reasoningEffort);
  const unapproved = prepareAdaptiveRecursiveCanaryConfig(raw, {
    artifactRoot,
    runtimeAuthorityRecord: authority,
    evaluatorAuthorityRecord: evaluator.record
  });
  assert.equal(unapproved.status, 'OK', unapproved.message);
  const prepared = prepareAdaptiveRecursiveCanaryConfig(raw, {
    artifactRoot,
    runtimeAuthorityRecord: authority,
    evaluatorAuthorityRecord: evaluator.record,
    approvedPlanSha256: unapproved.plan.sha256
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  return prepared.config;
}

test('recursive planner supports exact Luna Max and Sol XHigh without Ultra', () => {
  const root = mkdtempSync(join(tmpdir(), 'recursive-plan-models-'));
  const luna = buildAdaptiveRecursiveCanaryPlan(rawConfig(root, 'gpt-5.6-luna', 'max'));
  assert.equal(luna.status, 'OK', luna.message);
  assert.equal(luna.plan.modelPolicy.model, 'gpt-5.6-luna');
  assert.equal(luna.plan.modelPolicy.reasoningEffort, 'max');
  const invalid = rawConfig(mkdtempSync(join(tmpdir(), 'recursive-plan-ultra-')), 'gpt-5.6-sol', 'ultra');
  assert.equal(buildAdaptiveRecursiveCanaryPlan(invalid).code, 'RECURSIVE_CANARY_CONFIG_INVALID');
});

test('prepared recursive plan hash changes with the exact Codex executable authority', {
  skip: !isDarwin
}, () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursive-authority-plan-'));
  const raw = rawConfig(artifactRoot, 'gpt-5.6-luna', 'max');
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK');
  const first = prepareAdaptiveRecursiveCanaryConfig(raw, {
    artifactRoot,
    runtimeAuthorityRecord: runtimeAuthority(raw.model, raw.reasoningEffort, 'binary-a'),
    evaluatorAuthorityRecord: evaluator.record
  });
  const second = prepareAdaptiveRecursiveCanaryConfig(raw, {
    artifactRoot,
    runtimeAuthorityRecord: runtimeAuthority(raw.model, raw.reasoningEffort, 'binary-b'),
    evaluatorAuthorityRecord: evaluator.record
  });
  assert.equal(first.status, 'OK', first.message);
  assert.equal(second.status, 'OK', second.message);
  assert.notEqual(first.plan.sha256, second.plan.sha256);
  assert.notEqual(
    first.plan.preparedBindings.runtimeExecutableSha256,
    second.plan.preparedBindings.runtimeExecutableSha256
  );
});

test('recursive normalization makes task identity supervisor-owned while preserving raw model evidence', () => {
  const contract = {
    kind: 'proposal',
    target: {
      findingId: 'task-authoritative',
      baselineSha256: sha256('authoritative-baseline')
    },
    hypothesis: { id: 'hypothesis-authoritative' }
  };
  const modelPayload = {
    findingId: 'model-corrupted-id',
    hypothesisId: 'model-corrupted-hypothesis',
    baselineSha256: sha256('model-corrupted-baseline'),
    revisedContent: 'export function decide() { return { decision: "REJECT", code: "SAFE" }; }',
    changeSummary: 'Preserved the model-authored code and summary.'
  };
  const rawStdout = JSON.stringify({ type: 'agent_message', text: JSON.stringify(modelPayload) });
  const rawResultSha256 = sha256(JSON.stringify(modelPayload));
  const packet = normalizeAdaptiveRecursivePacket(contract, {
    executorOwned: true,
    rawStdout,
    finalOutput: `<IMPROVEMENT>${JSON.stringify(modelPayload)}</IMPROVEMENT>`,
    invocation: {
      rawResultSha256,
      resultSha256: sha256(JSON.stringify(modelPayload)),
      resultNormalization: 'json-schema-v1'
    }
  });
  const parsed = JSON.parse(packet.finalOutput.slice('<IMPROVEMENT>'.length, -'</IMPROVEMENT>'.length));
  assert.equal(parsed.findingId, contract.target.findingId);
  assert.equal(parsed.hypothesisId, contract.hypothesis.id);
  assert.equal(parsed.baselineSha256, contract.target.baselineSha256);
  assert.equal(parsed.revisedContent, modelPayload.revisedContent);
  assert.equal(parsed.changeSummary, modelPayload.changeSummary);
  assert.equal(packet.rawStdout, rawStdout);
  assert.equal(packet.invocation.rawResultSha256, rawResultSha256);
  assert.equal(packet.invocation.resultSha256, sha256(packet.finalOutput));
});

test('recursive runner persists 20 calls and independently activates only the causal descendant', {
  skip: !isDarwin
}, async () => {
  const config = await preparedFixture();
  const home = mkdtempSync(join(tmpdir(), 'recursive-run-home-'));
  const store = createStore(home);
  const result = runAdaptiveRecursiveCanary(store, config, {
    runId: 'recursive-causal-pass',
    worker: causalWorker(config),
    clock: () => '2026-08-03T21:00:00.000Z'
  });
  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.experimentValid, true, JSON.stringify(result.verification.reasons));
  assert.equal(result.causalPass, true, JSON.stringify(result.verification.reasons));
  assert.equal(result.activationEligible, true);
  assert.equal(result.verification.measurement.arms.cold.total.exact, 10);
  assert.equal(result.verification.measurement.arms.parent.total.exact, 20);
  assert.equal(result.verification.measurement.arms.candidate.total.exact, 25);
  assert.equal(result.verification.measurement.arms.sham.total.exact, 10);
  assert.equal(result.verification.contrasts.treatmentVsParent.metrics.exact.delta, 0.2);
  assert.equal(result.verification.contrasts.shamVsBaseline.metrics.exact.delta, 0);
  assert.equal(result.verification.activeEvolution.state, 'ACTIVE');
  assert.equal(result.verification.activeEvolution.authority.activation, 'routing-only');
  const generic = persistAdaptiveRecord({
    homeDir: home,
    record: result.verification.activeEvolution
  });
  assert.equal(generic.code, 'MECHANISM_EVOLUTION_VERIFIER_REQUIRED');
  const imported = persistAdaptiveRecursiveCanaryResult({
    homeDir: home,
    sourceStore: store,
    runId: 'recursive-causal-pass'
  });
  assert.equal(imported.status, 'OK', imported.message);
  assert.equal(imported.activationEligible, true);
  assert.ok(imported.persisted.some((item) => item.state === 'ACTIVE'));
  const records = listAdaptiveRecords({ homeDir: home });
  assert.equal(records.status, 'OK');
  assert.ok(records.records.some((record) => record.state === 'ACTIVE'));
  const epoch = createBaselinePolicyEpoch({ policyScopeId: 'recursive-test' });
  assert.equal(epoch.status, 'OK', epoch.message);
  const routed = buildMechanismRoutingDecision({
    families: records.records.filter((record) => record.schemaVersion === 'mechanism-family-v1'),
    applications: [],
    evolutions: records.records.filter((record) => record.schemaVersion === 'mechanism-evolution-v1'),
    measurements: records.records.filter((record) => record.schemaVersion === 'adaptive-measurement-v2'),
    target: {
      taskMode: 'improve',
      loopRole: 'supervisor',
      taskValueDimensions: ['exactness'],
      resourceDimensions: ['token-cost']
    },
    policyEpoch: epoch.record,
    seed: 'recursive-active-routing',
    hypothesisCount: 5,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  assert.equal(routed.filtered.validActiveEvolutions, 1);
  assert.ok(routed.candidatePool.some((item) => (
    item.familyId === config.candidateFamily.familyId
  )));
  const replay = verifyAdaptiveRecursiveCanaryRun(store, 'recursive-causal-pass');
  assert.equal(replay.experimentValid, true, JSON.stringify(replay.reasons));
  assert.equal(replay.evidenceSha256, result.verification.evidenceSha256);
});

test('recursive verifier rejects a rewritten persisted evaluation even when its internal hash is updated', {
  skip: !isDarwin
}, async () => {
  const config = await preparedFixture();
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-tamper-home-')));
  const result = runAdaptiveRecursiveCanary(store, config, {
    runId: 'recursive-tamper',
    worker: causalWorker(config),
    clock: () => '2026-08-03T21:30:00.000Z'
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('recursive-tamper');
  const call = state.calls[0];
  const artifact = store.readArtifact('recursive-tamper', call.evaluationArtifactRef);
  const record = JSON.parse(artifact.content);
  record.results[0].pass = !record.results[0].pass;
  const content = JSON.stringify(record);
  store.writeArtifact('recursive-tamper', artifact.id, {
    ...artifact,
    content,
    sha256: sha256(content)
  });
  const replay = verifyAdaptiveRecursiveCanaryRun(store, 'recursive-tamper');
  assert.equal(replay.experimentValid, false);
  assert.equal(replay.gates.measurementReplay, false);
});

test('recursive runner stops after one call when exact model authority is wrong', {
  skip: !isDarwin
}, async () => {
  const config = await preparedFixture();
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-model-home-')));
  const validWorker = causalWorker(config);
  const result = runAdaptiveRecursiveCanary(store, config, {
    runId: 'recursive-model-mismatch',
    worker: (contract) => {
      const packet = validWorker(contract);
      packet.invocation.requestedModel = 'gpt-5.6-luna';
      return packet;
    },
    clock: () => '2026-08-03T22:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'MODEL_AUTHORITY_UNPROVEN');
  const state = store.load('recursive-model-mismatch');
  assert.equal(state.verdictEvents.length, 1);
  assert.equal(state.calls.length, 0);
  assert.equal(state.failureEvidence.length, 1);
});
