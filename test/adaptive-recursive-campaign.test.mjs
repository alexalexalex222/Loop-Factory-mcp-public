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
  buildAdaptiveRecursiveCampaignPlan,
  prepareAdaptiveRecursiveCampaignConfig,
  runAdaptiveRecursiveCampaign,
  verifyAdaptiveRecursiveCampaignRun
} from '../src/adaptive-recursive-campaign.mjs';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  buildAdaptiveExecutableCanaryPrompt,
  captureExecutableEvaluatorAuthority
} from '../src/adaptive-executable-canary.mjs';
import {
  normalizeAdaptiveRecursivePacket
} from '../src/adaptive-recursive-runner.mjs';
import { compileMechanismProgram } from '../src/mechanism-compiler.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import { listAdaptiveRecords } from '../src/mechanism-catalog.mjs';
import {
  MECHANISM_EVOLUTION_ADMISSION_V2
} from '../src/mechanism-evolution-admission-v2.mjs';
import { sha256 } from '../src/util.mjs';

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

function family() {
  const built = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback',
      interventionKind: 'evidence-bound-fallback',
      operationKind: 'bounded-program-mutation',
      expectedEffectKind: 'more-exact-dispositions',
      preconditions: ['paired-measurement'],
      procedureSteps: ['measure', 'mutate', 'verify'],
      program: PROGRAM,
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['exactness'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(built.status, 'OK');
  return built.record;
}

function task(stage, index) {
  const id = `${stage}-campaign-task-${index}`;
  return {
    id,
    source: { path: `${id}/source.mjs`, sha256: sha256(`${id}:source`) },
    incident: { path: `${id}/incident.md`, sha256: sha256(`${id}:incident`) },
    interface: { path: `${id}/interface.json`, sha256: sha256(`${id}:interface`) },
    oracle: { path: `${id}/oracle.json`, sha256: sha256(`${id}:oracle`) },
    interfaceContract: { schemaVersion: 'executable-interface-contract-v2', id }
  };
}

function interfaceContract(index) {
  const root = `campaignDomain${index}`;
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

function sourceFor(index, mode) {
  const root = `campaignDomain${index}`;
  if (mode === 'cold') {
    return `// ${root}\nexport function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; }\n`;
  }
  if (mode === 'parent-second') {
    return [
      'export function decide(input) {',
      `  const { baselineQuality, candidateQuality } = input.${root};`,
      "  if (candidateQuality > baselineQuality) return { decision: 'ACCEPT', code: 'QUALITY_GAIN' };",
      "  return { decision: 'REJECT', code: 'MANUAL_REVIEW' };",
      '}',
      ''
    ].join('\n');
  }
  if (mode === 'candidate-second') {
    return [
      'export function decide(input) {',
      `  const { baselineQuality, candidateQuality } = input.${root};`,
      "  if (candidateQuality > baselineQuality) return { decision: 'ACCEPT', code: 'QUALITY_GAIN' };",
      "  if (candidateQuality === baselineQuality) return { decision: 'REJECT', code: 'MANUAL_REVIEW' };",
      "  return { decision: 'REJECT', code: 'NO_GAIN' };",
      '}',
      ''
    ].join('\n');
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

function executableCases(index) {
  const root = `campaignDomain${index}`;
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

function executableTask(root, stage, index) {
  const id = `${stage}-campaign-live-${index}`;
  mkdirSync(join(root, id), { recursive: true });
  const source = sourceFor(index, 'cold');
  const incident = 'Repair gains and equal values while preserving lower-value controls.\n';
  const contract = interfaceContract(index);
  const oracle = `${JSON.stringify(executableCases(index), null, 2)}\n`;
  const paths = {
    source: `${id}/source.mjs`,
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

function raw() {
  return {
    schemaVersion: 'adaptive-recursive-campaign-v1',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    authMode: 'chatgpt-oauth',
    retries: 0,
    promotionEnabled: false,
    maximumGenerations: 1,
    maximumMutationOperations: 3,
    historicalTokenEstimatePerGeneration: 1000000,
    seedParentFamily: family(),
    seedObjective: {
      measurementId: `measurement-${sha256('campaign-source').slice(0, 24)}`,
      measurementSha256: sha256('campaign-source-measurement'),
      failureCaseSetSha256: sha256('campaign-failures'),
      successCaseSetSha256: sha256('campaign-successes'),
      targetMetric: 'exact-case-rate',
      direction: 'increase'
    },
    context: {
      minInputTokens: 1000,
      initialInputTokens: 10000,
      maxInputTokens: 20000,
      permanentControlFraction: 0.2
    },
    taskGenerations: [{
      generation: 0,
      calibrationTasks: Array.from({ length: 5 }, (_, index) => (
        task('calibration', index)
      )),
      confirmationTasks: Array.from({ length: 5 }, (_, index) => (
        task('confirmation', index + 5)
      ))
    }]
  };
}

function executableRaw(root, generationCount = 1) {
  const input = raw();
  input.maximumGenerations = generationCount;
  input.taskGenerations = Array.from({ length: generationCount }, (_, generation) => ({
    generation,
    calibrationTasks: Array.from({ length: 5 }, (__, index) => (
      executableTask(
        root,
        `calibration-g${generation}`,
        generation * 10 + index + 1
      )
    )),
    confirmationTasks: Array.from({ length: 5 }, (__, index) => (
      executableTask(
        root,
        `confirmation-g${generation}`,
        generation * 10 + index + 6
      )
    ))
  }));
  return input;
}

function authority(model, reasoningEffort) {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('campaign-fixture-codex'),
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

function invalidMutationWorker(runtimeAuthority) {
  return ({ contract }) => {
    const resultText = '{}';
    const schemaPath = schemaPathForContract(contract);
    const workspaceRoot = '/tmp/campaign-mutation-capsule';
    return {
      ok: true,
      resultText,
      stdout: JSON.stringify({ type: 'agent_message', text: resultText }),
      invocation: {
        requestedModel: contract.model,
        reasoningEffort: contract.reasoningEffort,
        reportedModel: contract.model,
        binaryFamily: 'codex',
        argv: buildArgs('codex', null, contract.model, {
          strictIsolation: true,
          schemaPath,
          workspaceRoot,
          reasoningEffort: contract.reasoningEffort
        }),
        modelSelectionAuthority: 'explicit-model-flag',
        reportedModelMatchesRequest: true,
        executableBasename: runtimeAuthority.binary.basename,
        executableSha256: runtimeAuthority.binary.sha256,
        executableBytes: runtimeAuthority.binary.bytes,
        authMode: 'chatgpt-oauth',
        oauthAuthoritySha256: runtimeAuthority.authoritySha256,
        strictIsolation: true,
        disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
        workspaceRoot,
        outputSchemaSha256: sha256(readFileSync(schemaPath)),
        exitCode: 0,
        isolation: { status: 'PASS', toolCalls: [], reasons: [] },
        tokenUsage: 1000,
        tokenUsageDetails: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }
      }
    };
  };
}

async function prepared(artifactRoot, input = raw()) {
  const runtimeAuthority = authority(input.model, input.reasoningEffort);
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK');
  const unapproved = prepareAdaptiveRecursiveCampaignConfig(input, {
    artifactRoot,
    runtimeAuthorityRecord: runtimeAuthority,
    evaluatorAuthorityRecord: evaluator.record
  });
  assert.equal(unapproved.status, 'OK', unapproved.message);
  const ready = prepareAdaptiveRecursiveCampaignConfig(input, {
    artifactRoot,
    runtimeAuthorityRecord: runtimeAuthority,
    evaluatorAuthorityRecord: evaluator.record,
    approvedPlanSha256: unapproved.plan.sha256
  });
  assert.equal(ready.status, 'OK', ready.message);
  return ready.config;
}

function validMutationWorker(runtimeAuthority) {
  return ({ contract }) => {
    const fallback = contract.itemInventory.find((item) => (
      item.collection === 'fallback'
    ));
    const resultText = JSON.stringify({
      operations: [{
        action: 'replace',
        collection: 'fallback',
        expectedItemSha256: fallback.itemSha256,
        insertBeforeRuleId: null,
        value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
      }],
      reasonCodes: ['FAILED_FALLBACK_DISPOSITION'],
      expectedEffectCode: 'MORE_EXACT_CASES',
      memoryRecordIds: ['memory-seed-parent'],
      explanation: 'Test an explicit equal-value fallback against untouched tasks.'
    });
    const schemaPath = schemaPathForContract(contract);
    const workspaceRoot = '/tmp/campaign-valid-mutation';
    const stdout = JSON.stringify({ type: 'agent_message', text: resultText });
    return {
      ok: true,
      resultText,
      stdout,
      invocation: {
        requestedModel: contract.model,
        reasoningEffort: contract.reasoningEffort,
        reportedModel: contract.model,
        binaryFamily: 'codex',
        argv: buildArgs('codex', null, contract.model, {
          strictIsolation: true,
          schemaPath,
          workspaceRoot,
          reasoningEffort: contract.reasoningEffort
        }),
        modelSelectionAuthority: 'explicit-model-flag',
        reportedModelMatchesRequest: true,
        executableBasename: runtimeAuthority.binary.basename,
        executableSha256: runtimeAuthority.binary.sha256,
        executableBytes: runtimeAuthority.binary.bytes,
        authMode: 'chatgpt-oauth',
        oauthAuthoritySha256: runtimeAuthority.authoritySha256,
        strictIsolation: true,
        disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
        workspaceRoot,
        outputSchemaSha256: sha256(readFileSync(schemaPath)),
        exitCode: 0,
        isolation: { status: 'PASS', toolCalls: [], reasons: [] },
        tokenUsage: 1000,
        tokenUsageDetails: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }
      }
    };
  };
}

function recursiveMutationWorker(runtimeAuthority) {
  return ({ contract }) => {
    const fallback = contract.itemInventory.find((item) => (
      item.collection === 'fallback'
    ));
    const first = contract.generation === 0;
    const resultText = JSON.stringify({
      operations: first ? [{
        action: 'replace',
        collection: 'fallback',
        expectedItemSha256: fallback.itemSha256,
        insertBeforeRuleId: null,
        value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
      }] : [{
        action: 'add',
        collection: 'rules',
        expectedItemSha256: null,
        insertBeforeRuleId: null,
        value: {
          ruleId: 'reject-loss',
          kind: 'decision',
          exceptionOf: null,
          when: {
            operator: 'less-than',
            left: { kind: 'metric', id: 'quality-delta' },
            right: { kind: 'literal', value: 0 }
          },
          emit: { decision: 'REJECT', code: 'NO_GAIN' }
        }
      }],
      reasonCodes: first
        ? ['FAILED_FALLBACK_DISPOSITION']
        : ['DEVELOPMENT_SIGNAL_TRANSFER'],
      expectedEffectCode: first ? 'MORE_EXACT_CASES' : 'RESTORE_LOSS_DISPOSITION',
      memoryRecordIds: first ? ['memory-seed-parent'] : ['memory-generation-0'],
      explanation: first
        ? 'Test an explicit equal-value fallback.'
        : 'Use the measured first-generation receipt to separate loss from equality.'
    });
    const schemaPath = schemaPathForContract(contract);
    const workspaceRoot = `/tmp/campaign-recursive-mutation-${contract.generation}`;
    return {
      ok: true,
      resultText,
      stdout: JSON.stringify({ type: 'agent_message', text: resultText }),
      invocation: {
        requestedModel: contract.model,
        reasoningEffort: contract.reasoningEffort,
        reportedModel: contract.model,
        binaryFamily: 'codex',
        argv: buildArgs('codex', null, contract.model, {
          strictIsolation: true,
          schemaPath,
          workspaceRoot,
          reasoningEffort: contract.reasoningEffort
        }),
        modelSelectionAuthority: 'explicit-model-flag',
        reportedModelMatchesRequest: true,
        executableBasename: runtimeAuthority.binary.basename,
        executableSha256: runtimeAuthority.binary.sha256,
        executableBytes: runtimeAuthority.binary.bytes,
        authMode: 'chatgpt-oauth',
        oauthAuthoritySha256: runtimeAuthority.authoritySha256,
        strictIsolation: true,
        disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
        workspaceRoot,
        outputSchemaSha256: sha256(readFileSync(schemaPath)),
        exitCode: 0,
        isolation: { status: 'PASS', toolCalls: [], reasons: [] },
        tokenUsage: 1100,
        tokenUsageDetails: { inputTokens: 850, outputTokens: 250, totalTokens: 1100 }
      }
    };
  };
}

function childWorker(config, {
  sparseCandidate = false,
  recursiveTransfer = false
} = {}) {
  let calls = 0;
  const tasks = config.taskGenerations.flatMap((generation) => [
    ...generation.calibrationTasks,
    ...generation.confirmationTasks
  ]);
  const candidateCounts = new Map();
  let firstCandidateFamilyId = null;
  return (contract) => {
    calls += 1;
    const index = tasks.findIndex((task) => task.id === contract.target.findingId) + 1;
    const mechanism = contract.mechanismCapsule;
    const semantics = mechanism?.treatmentSemantics
      || mechanism?.items?.[0]?.semantics
      || 'none';
    const familyId = mechanism?.items?.[0]?.familyId || null;
    const secondGeneration = recursiveTransfer
      && /-g1-/.test(contract.target.findingId);
    let mode;
    if (!mechanism || semantics === 'irrelevant-control') {
      mode = 'cold';
    } else if (secondGeneration) {
      mode = familyId === firstCandidateFamilyId
        ? 'parent-second'
        : 'candidate-second';
    } else {
      mode = familyId === config.seedParentFamily.familyId ? 'parent' : 'candidate';
      if (mode === 'candidate' && familyId) firstCandidateFamilyId = familyId;
    }
    if (mode === 'candidate' && sparseCandidate) {
      const seen = candidateCounts.get(contract.target.findingId) || 0;
      candidateCounts.set(contract.target.findingId, seen + 1);
      if (seen > 0) mode = 'parent';
    }
    const modelPayload = {
      findingId: 'untrusted-child-id',
      hypothesisId: 'untrusted-child-hypothesis',
      baselineSha256: sha256('untrusted-child-baseline'),
      revisedContent: sourceFor(index, mode),
      changeSummary: 'Applied the assigned recursive treatment.'
    };
    const rawResult = JSON.stringify(modelPayload);
    const finalOutput = `<IMPROVEMENT>${rawResult}</IMPROVEMENT>`;
    const inputTokens = 500 + calls;
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
    const workspaceRoot = `/tmp/campaign-child-${calls}`;
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
        reportedModelMatchesRequest: true,
        executableBasename: config.runtimeAuthority.binary.basename,
        executableSha256: config.runtimeAuthority.binary.sha256,
        executableBytes: config.runtimeAuthority.binary.bytes,
        authMode: 'chatgpt-oauth',
        oauthAuthoritySha256: config.runtimeAuthority.authoritySha256,
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
        isolation: { status: 'PASS', toolCalls: [], reasons: [] }
      }
    });
  };
}

test('recursive campaign plan freezes finite exposure and no-promotion autonomy', () => {
  const built = buildAdaptiveRecursiveCampaignPlan(raw());
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.plan.bounds.maximumCalls, 121);
  assert.equal(built.plan.bounds.maximumMutationOperations, 3);
  assert.equal(built.plan.autonomy.invalidMutationRetries, 0);
  assert.equal(built.plan.autonomy.childRetries, 0);
  assert.equal(built.plan.autonomy.promotionEnabled, false);
  assert.equal(built.plan.autonomy.zeroInferenceIdle, true);
  assert.equal(built.plan.statisticalAuthority.familywiseAlpha, 0.05);
  assert.equal(built.plan.statisticalAuthority.perGenerationAlpha, 0.05);
});

test('recursive campaign records one invalid mutation without retrying or launching a child', async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursive-campaign-artifacts-'));
  const config = await prepared(artifactRoot);
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-campaign-home-')));
  const result = runAdaptiveRecursiveCampaign(store, config, {
    runId: 'recursive-campaign-invalid-mutation',
    mutationWorker: invalidMutationWorker(config.runtimeAuthority),
    clock: () => '2026-08-05T03:00:00.000Z'
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.state, undefined);
  const state = store.load('recursive-campaign-invalid-mutation');
  assert.equal(state.status, 'WAVE_DRAINED');
  assert.equal(state.generations.length, 1);
  assert.equal(state.generations[0].status, 'MUTATION_REJECTED');
  assert.equal(state.generations[0].code, 'MUTATION_OUTPUT_INVALID');
  assert.equal(store.listRuns().length, 1);
  const verification = verifyAdaptiveRecursiveCampaignRun(
    store,
    'recursive-campaign-invalid-mutation'
  );
  assert.equal(verification.experimentValid, true, JSON.stringify(verification.reasons));
  assert.equal(verification.mutationCalls, 1);
  assert.equal(verification.childCalls, 0);
  const replay = runAdaptiveRecursiveCampaign(store, config, {
    runId: 'recursive-campaign-invalid-mutation',
    mutationWorker: () => {
      throw new Error('terminal replay must not launch another model');
    }
  });
  assert.equal(replay.idempotent, true);
});

test('recursive campaign executes one full causal generation and banks verifier-owned memory', {
  skip: process.platform !== 'darwin'
}, async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursive-campaign-live-artifacts-'));
  const config = await prepared(artifactRoot, executableRaw(artifactRoot));
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-campaign-live-home-')));
  assert.throws(() => runAdaptiveRecursiveCampaign(store, config, {
    runId: 'recursive-campaign-causal-generation',
    mutationWorker: validMutationWorker(config.runtimeAuthority),
    childWorker: childWorker(config),
    clock: () => '2026-08-05T04:00:00.000Z',
    onMutationPersisted: () => {
      throw new Error('simulated campaign process loss');
    }
  }), /simulated campaign process loss/);
  assert.equal(
    store.load('recursive-campaign-causal-generation').currentGeneration.phase,
    'CHILD_READY'
  );
  const result = runAdaptiveRecursiveCampaign(store, config, {
    runId: 'recursive-campaign-causal-generation',
    mutationWorker: () => {
      throw new Error('persisted mutation must not be relaunched');
    },
    childWorker: childWorker(config),
    clock: () => '2026-08-05T04:00:00.000Z'
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.disposition, 'IDLE_NO_NEW_WORK');
  const state = store.load('recursive-campaign-causal-generation');
  assert.equal(state.generations.length, 1);
  assert.equal(state.generations[0].status, 'VERIFIED_IMPROVEMENT');
  assert.equal(state.generations[0].causalPass, true);
  assert.equal(state.memoryRecords.length, 2);
  assert.equal(state.memoryRecords[1].lifecycle, 'active');
  assert.equal(state.currentParentFamily.familyId, state.generations[0].candidateFamily.familyId);
  assert.equal(state.contextObservations.length, 1);
  const verification = verifyAdaptiveRecursiveCampaignRun(
    store,
    'recursive-campaign-causal-generation'
  );
  assert.equal(verification.experimentValid, true, JSON.stringify(verification.reasons));
  assert.equal(verification.verifiedImprovements, 1);
  assert.equal(verification.mutationCalls, 1);
  assert.equal(verification.childCalls, 120);
  assert.equal(verification.modelCalls, 121);
});

test('campaign-wide alpha keeps an ordinary child pass in development-only memory', {
  skip: process.platform !== 'darwin'
}, async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursive-campaign-alpha-artifacts-'));
  const config = await prepared(artifactRoot, executableRaw(artifactRoot, 2));
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-campaign-alpha-home-')));
  const result = runAdaptiveRecursiveCampaign(store, config, {
    runId: 'recursive-campaign-familywise-alpha',
    mutationWorker: validMutationWorker(config.runtimeAuthority),
    childWorker: childWorker(config, { sparseCandidate: true }),
    shouldStop: () => (
      (store.load('recursive-campaign-familywise-alpha')?.generations?.length || 0) >= 1
    ),
    clock: () => '2026-08-05T04:30:00.000Z'
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.disposition, 'OPERATOR_STOP');
  const state = store.load('recursive-campaign-familywise-alpha');
  assert.equal(state.generations.length, 1);
  assert.equal(state.generations[0].childCausalPass, true);
  assert.equal(state.generations[0].causalPass, false);
  assert.equal(state.generations[0].familywisePass, false);
  assert.equal(state.generations[0].status, 'DEVELOPMENT_ADVANCE');
  assert.equal(state.generations[0].adjustedBlockP, 0.03125);
  assert.equal(state.generations[0].perGenerationAlpha, 0.025);
  assert.equal(state.generations[0].catalogPersistence.mode, 'development-only');
  assert.equal(state.memoryRecords.at(-1).lifecycle, 'observed');
  const catalog = listAdaptiveRecords({ homeDir: store.homeDir });
  assert.equal(catalog.status, 'OK');
  assert.equal(catalog.records.filter((record) => (
    record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2
      && record.state === 'ACTIVE'
  )).length, 0);
  const verification = verifyAdaptiveRecursiveCampaignRun(
    store,
    'recursive-campaign-familywise-alpha'
  );
  assert.equal(verification.experimentValid, true, JSON.stringify(verification.reasons));
  assert.equal(verification.verifiedImprovements, 0);
});

test('a disjoint second generation can cite the first measured learning receipt', {
  skip: process.platform !== 'darwin'
}, async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'recursive-campaign-transfer-artifacts-'));
  const config = await prepared(artifactRoot, executableRaw(artifactRoot, 2));
  const store = createStore(mkdtempSync(join(tmpdir(), 'recursive-campaign-transfer-home-')));
  const result = runAdaptiveRecursiveCampaign(store, config, {
    runId: 'recursive-campaign-disjoint-transfer',
    mutationWorker: recursiveMutationWorker(config.runtimeAuthority),
    childWorker: childWorker(config, {
      sparseCandidate: true,
      recursiveTransfer: true
    }),
    clock: () => '2026-08-05T04:45:00.000Z'
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.disposition, 'IDLE_NO_NEW_WORK');
  const state = store.load('recursive-campaign-disjoint-transfer');
  assert.equal(state.generations.length, 2);
  assert.equal(state.generations[0].status, 'DEVELOPMENT_ADVANCE');
  assert.equal(state.generations[0].causalPass, false);
  assert.equal(state.generations[0].childCausalPass, true);
  assert.equal(state.generations[1].status, 'VERIFIED_IMPROVEMENT');
  assert.equal(state.generations[1].causalPass, true);
  assert.deepEqual(
    state.generations[1].mutationOutput.memoryRecordIds,
    ['memory-generation-0']
  );
  assert.ok(state.generations[1].contextProjection.entries.some((entry) => (
    entry.recordId === 'memory-generation-0' && entry.projection === 'INLINE'
  )));
  assert.equal(state.memoryRecords.at(-2).lifecycle, 'observed');
  assert.equal(state.memoryRecords.at(-1).lifecycle, 'active');
  const catalog = listAdaptiveRecords({ homeDir: store.homeDir });
  assert.equal(catalog.status, 'OK');
  assert.equal(catalog.records.filter((record) => (
    record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2
      && record.state === 'ACTIVE'
  )).length, 1);
  const verification = verifyAdaptiveRecursiveCampaignRun(
    store,
    'recursive-campaign-disjoint-transfer'
  );
  assert.equal(verification.experimentValid, true, JSON.stringify(verification.reasons));
  assert.equal(verification.verifiedImprovements, 1);
  assert.equal(verification.modelCalls, 242);
});

test('recursive campaign schema is closed at the root', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/adaptive-recursive-campaign-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'adaptive-recursive-campaign-v1');
  assert.equal(schema.additionalProperties, false);
});
