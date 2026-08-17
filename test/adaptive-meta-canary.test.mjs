import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_META_CANARY,
  ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION,
  ADAPTIVE_META_CANARY_SCHEMA_VERSION,
  adaptiveMetaCanaryLaunchDisclosure,
  buildAdaptiveMetaCanaryPlan,
  capsuleSchemaSha256,
  createIrrelevantShamCapsule,
  normalizeAdaptiveMetaCanaryEvaluationProcedure,
  resolveAdaptiveMetaCanaryImplementation,
  runAdaptiveMetaCanary,
  validateAdaptiveMetaCanaryConfig,
  verifyAdaptiveMetaCanaryRun
} from '../src/adaptive-meta-canary.mjs';
import {
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord
} from '../src/adaptive-records.mjs';
import {
  DEFAULT_ADAPTIVE_POLICY,
  createBaselinePolicyEpoch
} from '../src/adaptive-policy.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  buildExecutorPrompt,
  schemaPathForContract
} from '../src/executor.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import {
  REAL_TEST_MODEL,
  resolveEvidenceCapsule
} from '../src/real-test.mjs';
import { sha256 } from '../src/util.mjs';
import { BASELINE_BODY, freshEngine } from './helpers.mjs';
import { createFakeCodexAuthorityCli } from './fixtures/fake-cli.mjs';

const SOURCE_PATH = 'test/fixtures/adaptive-meta-canary/development.json';
const HELD_OUT_SOURCE_PATHS = Array.from(
  { length: ADAPTIVE_META_CANARY.evaluationsPerArm },
  (_, index) => `test/fixtures/adaptive-meta-canary/held-out-${index + 1}.json`
);
const MECHANISM_SOURCE_PATH = 'src/executor.mjs';
const FIXTURE_CODEX_PATH = '/opt/codex/codex.real';
const FIXTURE_CODEX_BYTES = Buffer.from('fixture-codex-executable-v1');
const FIXTURE_CODEX_CATALOG = JSON.stringify({
  models: [{
    slug: REAL_TEST_MODEL,
    display_name: 'GPT-5.6 Sol',
    visibility: 'list',
    supported_in_api: true,
    supported_reasoning_levels: [
      { effort: 'high', description: 'Fixture high reasoning' }
    ],
    default_reasoning_level: 'high',
    service_tiers: []
  }]
});
const TARGET = {
  taskMode: 'improve',
  loopRole: 'supervisor',
  taskValueDimensions: ['evidence-quality'],
  resourceDimensions: ['token-cost']
};

function fixtureRuntimeAuthority({
  binaryPath = FIXTURE_CODEX_PATH,
  binaryBytes = FIXTURE_CODEX_BYTES
} = {}) {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath,
    binaryBytes,
    versionOutput: 'codex-cli 0.0.0-test',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: FIXTURE_CODEX_CATALOG,
    requestedModel: REAL_TEST_MODEL,
    reasoningEffort: 'high'
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function mechanismFamily() {
  const built = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'non-atomic-receipt-measurement',
      interventionKind: 'bind-receipts-before-measurement',
      operationKind: 'atomic-receipt-transaction',
      expectedEffectKind: 'fewer-unverifiable-attempts',
      preconditions: ['frozen-benchmark', 'executor-receipts'],
      procedureSteps: [
        'bind-current-receipt',
        'reject-missing-final-hash'
      ],
      program: {
        schemaVersion: 'mechanism-program-v1',
        bindingPolicy: 'closed-world',
        roles: ['receipt.final-hash'],
        selectors: [],
        bindings: [],
        forbiddenBindings: [],
        metrics: [],
        rules: [{
          ruleId: 'reject-missing-final-hash',
          kind: 'guard',
          exceptionOf: null,
          when: {
            operator: 'equal',
            left: { kind: 'role', id: 'receipt.final-hash' },
            right: { kind: 'literal', value: '' }
          },
          emit: { decision: 'REJECT', code: 'FINAL_HASH_MISSING' }
        }],
        fallback: { decision: 'ACCEPT', code: 'RECEIPT_BOUND' }
      },
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['evidence-quality'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function mechanismApplication(family, partition, suffix) {
  const built = createMechanismApplicationRecord({
    familyId: family.familyId,
    appliedAt: `2026-07-22T22:5${suffix}:00.000Z`,
    partition,
    source: {
      runId: `historical-run-${suffix}`,
      hypothesisId: `historical-hyp-${suffix}`,
      testId: `historical-test-${suffix}`
    },
    context: {
      targetSha256: sha256(`historical-target-${suffix}`),
      ...TARGET
    },
    routing: {
      routingDecisionId: null,
      routingDecisionSha256: null,
      routingPacketSha256: null,
      policyEpochId: null,
      policyEpochSha256: null,
      allocation: null,
      schedulePosition: null
    },
    outcome: {
      verdict: 'improvement',
      valid: true,
      qualityDelta: 0.25,
      tokenCostDeltaPct: -0.05,
      shamMovement: 0,
      controlRegressions: 0,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: sha256(`transfer-${suffix}`)
      }],
      contradictionCodes: []
    },
    credit: {
      confidence: 0.9,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256(`legacy-id-${suffix}`).slice(0, 24)}`,
      legacyReceiptSha256: sha256(`legacy-${suffix}`),
      benchmarkSha256: sha256('historical-benchmark'),
      artifactSetSha256: sha256(`historical-artifacts-${suffix}`),
      evidenceSetSha256: sha256(`historical-evidence-${suffix}`)
    }
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function rawConfig() {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const evidence = resolveEvidenceCapsule(repositoryRoot, [SOURCE_PATH]);
  const heldOutEvidence = resolveEvidenceCapsule(repositoryRoot, HELD_OUT_SOURCE_PATHS);
  const mechanismEvidence = resolveEvidenceCapsule(repositoryRoot, [MECHANISM_SOURCE_PATH]);
  const implementation = resolveAdaptiveMetaCanaryImplementation(repositoryRoot);
  assert.equal(evidence.ok, true, evidence.errors.join('\n'));
  assert.equal(heldOutEvidence.ok, true, heldOutEvidence.errors.join('\n'));
  assert.equal(mechanismEvidence.ok, true, mechanismEvidence.errors.join('\n'));
  const family = mechanismFamily();
  const harvest = mechanismApplication(family, 'harvest', 1);
  const gate = mechanismApplication(family, 'gate', 2);
  const reference = mechanismApplication(family, 'reference', 3);
  const policy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  policy.allocations.related = 0.8;
  policy.allocations.adjacent = 0;
  policy.allocations.failureDerived = 0;
  policy.allocations.wildcard = 0;
  const policyBuilt = createBaselinePolicyEpoch({
    policy,
    evidenceWindowSha256: sha256('meta-canary-policy'),
    policyScopeId: 'meta-canary-test'
  });
  assert.equal(policyBuilt.status, 'OK', policyBuilt.message);
  const routed = buildMechanismRoutingDecision({
    families: [family],
    applications: [harvest, gate, reference],
    target: TARGET,
    policyEpoch: policyBuilt.record,
    seed: 'meta-canary-routing-seed',
    hypothesisCount: 2,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  assert.equal(routed.capsule.items.length, 1);
  const shamCapsule = createIrrelevantShamCapsule(routed.capsule);
  const developmentCases = [
    'development-missing-final-hash',
    'development-clean-receipt',
    'development-route-mismatch'
  ].map((id) => ({
    id,
    prompt: `Inspect the proposal-visible ${id} scenario and preserve its evidence boundary.`,
    evidenceRef: { path: SOURCE_PATH, locator: `"id": "${id}"` }
  }));
  const evaluationShards = HELD_OUT_SOURCE_PATHS.map((path, index) => {
    const number = index + 1;
    const cases = [
      {
        id: `hidden-${number}-target`,
        prompt: `Apply the active procedure to sealed receipt-bound target scenario ${number}.`,
        evidenceRef: { path, locator: `"id": "hidden-${number}-target"` },
        baselineFailureRef: { path, locator: '"baselineDisposition": "COUNTED"' }
      },
      {
        id: `hidden-${number}-clean`,
        prompt: `Apply the active procedure to sealed valid-receipt control ${number}.`,
        evidenceRef: { path, locator: `"id": "hidden-${number}-clean"` }
      },
      {
        id: `hidden-${number}-control`,
        prompt: `Apply the active procedure to sealed existing-guard control ${number}.`,
        evidenceRef: { path, locator: `"id": "hidden-${number}-control"` }
      }
    ];
    return {
      id: `held-out-${number}`,
      evidencePaths: [path],
      cases,
      oracle: {
        kind: 'case-results-v2',
        passMark: 1,
        cases: [
          {
            caseId: `hidden-${number}-target`,
            accepted: false,
            code: `RECEIPT_ATOMIC_REJECT_${number}`,
            requiredEvidencePaths: [path],
            group: 'target'
          },
          {
            caseId: `hidden-${number}-clean`,
            accepted: true,
            code: `RECEIPT_ACCEPT_${number}`,
            requiredEvidencePaths: [path],
            group: 'control'
          },
          {
            caseId: `hidden-${number}-control`,
            accepted: false,
            code: `EXISTING_GUARD_REJECT_${number}`,
            requiredEvidencePaths: [path],
            group: 'control'
          }
        ]
      }
    };
  });
  return {
    schemaVersion: ADAPTIVE_META_CANARY_SCHEMA_VERSION,
    privateEvidencePolicy: 'source-qualified-v2',
    evaluationProcedureNormalization:
      ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION,
    model: REAL_TEST_MODEL,
    fixtureOnly: true,
    historicalTokenEstimate: 540000,
    proposalRoutes: Array(3).fill(REAL_TEST_MODEL),
    evaluationRoutes: Array(5).fill(REAL_TEST_MODEL),
    evidenceSources: [SOURCE_PATH],
    evidenceManifest: evidence.manifest,
    evidenceCapsule: evidence.capsule,
    heldOutEvidenceSources: HELD_OUT_SOURCE_PATHS,
    heldOutEvidenceManifest: heldOutEvidence.manifest,
    heldOutEvidenceCapsule: heldOutEvidence.capsule,
    mechanismEvidenceSources: [MECHANISM_SOURCE_PATH],
    mechanismEvidenceManifest: mechanismEvidence.manifest,
    mechanismEvidenceCapsule: mechanismEvidence.capsule,
    mechanismEvidenceRefs: [{
      path: MECHANISM_SOURCE_PATH,
      locator: "code: 'WORKER_PLUGIN_CONTEXT'"
    }],
    implementationManifest: implementation.manifest,
    implementationCapsule: implementation.capsule,
    runtimeAuthority: fixtureRuntimeAuthority(),
    target: {
      findingId: 'finding-002',
      title: 'Atomic receipt-bound measurement',
      baselineContent: BASELINE_BODY,
      evidenceRefs: [{ path: SOURCE_PATH, locator: '"finding":' }],
      proposalBrief: {
        title: 'Close the receipt-to-measurement gap',
        problem: 'Development evidence shows that related receipt checks can be individually correct while measurement still begins before the complete evidence set is bound.',
        invariants: [
          'Preserve valid complete receipts without changing their disposition.',
          'Preserve every existing route, schema, transcript, and malformed-input guard.',
          'Do not trust caller-reported measurements or unbound artifact references.'
        ]
      },
      hypothesis: {
        title: 'Bind receipt verification to measurement',
        bottleneck: 'Sequential receipt and artifact checks can leave counted work dependent on caller discipline.',
        operation: 'Use one supervisor-owned transaction that verifies route, exit, raw hash, final hash, and artifact references before returning a measurement reference.',
        expectedMovement: 'Unverifiable attempts fail before measurement while valid receipt-bound attempts retain their result.',
        falsifier: 'A mismatched or missing receipt artifact still creates a counted measurement.'
      }
    },
    benchmark: {
      name: 'adaptive-meta-canary-fixture',
      developmentCases,
      evaluationShards
    },
    mechanismContext: {
      families: [family],
      applications: [harvest, gate, reference],
      routingTarget: TARGET,
      policyEpoch: policyBuilt.record,
      seed: 'meta-canary-routing-seed',
      hypothesisCount: 2,
      routingDecision: routed.decision,
      candidatePool: routed.candidatePool,
      routedCapsule: routed.capsule,
      shamCapsule,
      primaryFamilyId: family.familyId
    }
  };
}

function approvedConfig() {
  const config = rawConfig();
  const plan = buildAdaptiveMetaCanaryPlan(config);
  return { ...config, approvedPlanSha256: plan.sha256 };
}

function approvedQualificationConfig() {
  const config = {
    ...rawConfig(),
    executionMode: 'qualification-only',
    proposalRoutes: [REAL_TEST_MODEL]
  };
  const plan = buildAdaptiveMetaCanaryPlan(config);
  return { ...config, approvedPlanSha256: plan.sha256 };
}

function strictPacket(contract, payload, tag, tokenOffset = 0, {
  reportModel = true,
  reportedModel = contract.route,
  runtimeAuthority = fixtureRuntimeAuthority()
} = {}) {
  const rawResultText = JSON.stringify(payload);
  const finalOutput = `<${tag}>${rawResultText}</${tag}>`;
  const inputTokens = 130 + tokenOffset;
  const outputTokens = 90;
  const rawStdout = [
    JSON.stringify({
      type: 'thread.started',
      ...(reportModel ? { model: reportedModel } : {})
    }),
    JSON.stringify({ type: 'agent_message', text: rawResultText }),
    JSON.stringify({ type: 'token_count', input_tokens: inputTokens, output_tokens: outputTokens })
  ].join('\n');
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = '/tmp/adaptive-meta-canary-test-capsule';
  const prompt = buildExecutorPrompt({ ...contract, outputSchemaMode: true });
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: rawStdout }],
    executorOwned: true,
    rawStdout,
    finalOutput,
    isolation: { status: 'PASS', toolCalls: [], reasons: [] },
    invocation: {
      requestedModel: contract.route,
      reportedModel: reportModel ? reportedModel : null,
      binaryFamily: 'codex',
      argv: buildArgs('codex', null, contract.route, {
        strictIsolation: true,
        schemaPath,
        workspaceRoot
      }),
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: reportModel ? 'cli-reported' : 'explicit-model-flag',
      reportedModelMatchesRequest: reportModel
        ? reportedModel === contract.route
        : null,
      executableBasename: runtimeAuthority.binary.basename,
      executableSha256: runtimeAuthority.binary.sha256,
      executableBytes: runtimeAuthority.binary.bytes,
      authMode: 'chatgpt-oauth',
      oauthAuthoritySha256: runtimeAuthority.authoritySha256,
      promptSha256: sha256(prompt),
      strictIsolation: true,
      disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
      workspaceRoot,
      outputSchemaSha256: sha256(readFileSync(schemaPath)),
      rawResultSha256: sha256(rawResultText),
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
      durationMs: 25,
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  };
}

function metaCanaryWorker(config, seen = [], options = {}) {
  const procedures = new Map();
  return (contract) => {
    seen.push(contract);
    if (contract.kind === 'proposal') {
      const semantics = contract.mechanismCapsule?.items?.[0]?.semantics || 'none';
      const marker = semantics === 'positive-transfer'
        ? 'ROUTED_ATOMIC_TRANSACTION'
        : (semantics === 'irrelevant-control' ? 'SHAM_FORMAT_ONLY' : 'BASELINE_GENERIC');
      const revisedContent = options.unchangedSham && semantics === 'irrelevant-control'
        ? contract.target.baselineContent
        : [
            contract.target.baselineContent,
            '',
            '## Meta-Canary Revision',
            marker,
            contract.hypothesis.bottleneck,
            ...contract.requirements,
            `Use proposal evidence from ${contract.evidenceCapsule[0]?.path}.`,
            `Ground the rule in ${contract.frozenCases[0]?.id} at ${contract.frozenCases[0]?.evidenceRef?.locator}.`,
            'Preserve every frozen acceptance criterion and return evidence-bound decisions only.'
          ].join('\n');
      procedures.set(marker, revisedContent);
      return strictPacket(contract, {
        findingId: contract.target.findingId,
        hypothesisId: contract.hypothesis.id,
        baselineSha256: contract.target.baselineSha256,
        revisedContent,
        changeSummary: `${contract.hypothesis.title}: ${marker}`
      }, 'IMPROVEMENT', seen.length, {
        ...options,
        runtimeAuthority: config.runtimeAuthority
      });
    }
    const routed = contract.procedureContent.includes('ROUTED_ATOMIC_TRANSACTION');
    const baseline = contract.procedureContent.includes('BASELINE_GENERIC');
    const solvesTargets = routed || (baseline && options.baselineSolves === true);
    const firstCaseId = contract.frozenCases[0]?.id;
    const shard = config.benchmark.evaluationShards.find((item) => (
      item.cases.some((candidate) => candidate.id === firstCaseId)
    ));
    assert.ok(shard, `missing fixture shard for ${firstCaseId}`);
    const rows = shard.oracle.cases.map((item) => ({
      caseId: item.caseId,
      disposition: item.accepted
        ? 'ACCEPTED'
        : (item.group === 'control' || solvesTargets ? 'REJECTED' : 'ACCEPTED'),
      code: item.group === 'control' || solvesTargets
        ? item.code
        : `WRONG_${item.code}`,
      evidencePaths: item.requiredEvidencePaths
    }));
    return strictPacket(contract, {
      arm: contract.evaluationArm,
      findingId: contract.target.findingId,
      hypothesisId: contract.hypothesis.id,
      baselineSha256: contract.target.baselineSha256,
      procedureSha256: contract.procedureSha256,
      caseResults: rows
    }, 'EVALUATION', seen.length, {
      ...options,
      runtimeAuthority: config.runtimeAuthority
    });
  };
}

function fakeCodexAuthorityBinary(dir) {
  return createFakeCodexAuthorityCli(dir, {
    catalog: FIXTURE_CODEX_CATALOG
  });
}

test('adaptive meta-canary v2 freezes a six-call headroom gate and 18-call maximum', () => {
  const config = approvedConfig();
  const validation = validateAdaptiveMetaCanaryConfig(config);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const plan = validation.plan;
  assert.equal(plan.profile, ADAPTIVE_META_CANARY_SCHEMA_VERSION);
  assert.equal(plan.privateEvidencePolicy, 'source-qualified-v2');
  assert.equal(
    plan.evaluationProcedureNormalization,
    ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION
  );
  assert.equal(plan.contract.totalCalls, 18);
  assert.equal(plan.contract.proposalCalls, 3);
  assert.equal(plan.contract.evaluationCalls, 15);
  assert.equal(plan.contract.retriesPerDispatch, 0);
  assert.equal(plan.contract.sequentialTimeoutCeilingMs, 180 * 60 * 1000);
  assert.equal(plan.contract.hardTokenLimit, null);
  assert.equal(plan.contract.hardUsdLimit, null);
  assert.equal(plan.contract.qualificationCalls, 6);
  assert.equal(plan.contract.conditionalCalls, 12);
  assert.equal(plan.contract.executionSchedule.length, 18);
  assert.deepEqual(
    plan.contract.executionSchedule.slice(0, 6).map((item) => item.armRole),
    Array(6).fill('baseline')
  );
  assert.equal(
    capsuleSchemaSha256(config.mechanismContext.routedCapsule),
    capsuleSchemaSha256(config.mechanismContext.shamCapsule)
  );
  assert.notEqual(
    config.mechanismContext.routedCapsule.mechanismCapsuleSha256,
    config.mechanismContext.shamCapsule.mechanismCapsuleSha256
  );
  assert.equal(config.mechanismContext.candidatePool.length, 1);
  assert.ok(config.mechanismContext.candidatePool[0].applications
    .every((item) => item.applicationReceiptId
      === config.mechanismContext.applications[0].applicationReceiptId));
  const disclosure = adaptiveMetaCanaryLaunchDisclosure(config, {
    configPath: '/tmp/meta.json',
    home: '/tmp/meta-home',
    runId: 'meta-run'
  });
  assert.equal(disclosure.calls.totalMaximum, 18);
  assert.equal(disclosure.calls.qualificationBeforeDecision, 6);
  assert.equal(disclosure.calls.conditionalAfterQualification, 12);
  assert.equal(disclosure.partitions.heldOutShards, 5);
  assert.equal(disclosure.exposure.sequentialTimeoutCeilingMinutes, 180);
  assert.equal(disclosure.exposure.hardTokenLimit, null);
  assert.equal(disclosure.exposure.hardUsdLimit, null);
  assert.equal(disclosure.execution.reasoningEffort, 'high');
  assert.match(disclosure.launchCommand, /verify:meta-canary/);
});

test('schema-identical sham capsules retain the operator-control binding field', () => {
  const config = rawConfig();
  assert.ok(Object.hasOwn(config.mechanismContext.routedCapsule, 'operatorControlSha256'));
  assert.ok(Object.hasOwn(config.mechanismContext.shamCapsule, 'operatorControlSha256'));
  assert.equal(
    config.mechanismContext.shamCapsule.operatorControlSha256,
    config.mechanismContext.routedCapsule.operatorControlSha256
  );
});

test('adaptive meta-canary persists 3 proposals and 15 blinded evaluations with prompt-bound treatment', () => {
  const { store, home } = freshEngine();
  const config = approvedConfig();
  const seen = [];
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-pass',
    worker: metaCanaryWorker(config, seen)
  });
  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.experimentValid, true, JSON.stringify(result.verification, null, 2));
  assert.equal(result.activationEligible, false, 'fixture-only runs cannot activate');
  assert.equal(result.outcome.status, 'PASS');
  assert.equal(result.outcome.baselineTargetFailures, 5);
  assert.equal(result.outcome.routedPairedTargetWins, 5);
  assert.equal(result.outcome.shamTargetWins, 0);
  assert.equal(result.outcome.controlRegressions, 0);
  assert.equal(seen.length, ADAPTIVE_META_CANARY.totalCalls);
  const state = store.load('adaptive-meta-pass');
  assert.equal(state.proposals.length, 3);
  assert.equal(state.evaluations.length, 15);
  assert.equal(state.verdictEvents.length, 18);
  assert.equal(state.qualification.status, 'QUALIFIED');
  assert.equal(state.qualification.observedBaselineFailures, 5);
  assert.ok(state.verdictEvents.every((event) => event.attempt === 0));
  assert.equal(state.proposals.find((item) => item.armRole === 'baseline').mechanismCapsuleSha256, null);
  assert.equal(
    state.proposals.find((item) => item.armRole === 'routed').mechanismCapsuleSha256,
    config.mechanismContext.routedCapsule.mechanismCapsuleSha256
  );
  assert.equal(
    state.proposals.find((item) => item.armRole === 'sham').mechanismCapsuleSha256,
    config.mechanismContext.shamCapsule.mechanismCapsuleSha256
  );
  assert.ok(seen.filter((contract) => contract.kind === 'evaluation').every((contract) => (
    contract.mechanismCapsule === null
    && contract.target.baselineContent === null
    && contract.target.title === null
    && contract.hypothesis.bottleneck === null
    && contract.hypothesis.expectedMovement === null
    && !ADAPTIVE_META_CANARY.arms.includes(contract.evaluationArm)
  )));
  const proposalContracts = seen.filter((contract) => contract.kind === 'proposal');
  assert.ok(proposalContracts.every((contract) => (
    contract.hypothesis.operation === null
    && contract.hypothesis.expectedMovement === null
    && contract.hypothesis.falsifier === null
    && contract.evidenceCapsule.every((item) => item.path === SOURCE_PATH)
    && !JSON.stringify(contract).includes('hidden-1-target')
  )));
  const evaluationContracts = seen.filter((contract) => contract.kind === 'evaluation');
  assert.equal(new Set(evaluationContracts.map((contract) => (
    contract.evidenceCapsule[0]?.path
  ))).size, 5);
  assert.ok(evaluationContracts.every((contract) => contract.evidenceCapsule.length === 1));
  assert.ok(evaluationContracts.every((contract) => (
    !contract.procedureContent.includes(SOURCE_PATH)
    && !contract.procedureContent.includes(config.benchmark.developmentCases[0].id)
    && !contract.procedureContent.includes(
      config.benchmark.developmentCases[0].evidenceRef.locator
    )
  )));
  for (const armRole of ADAPTIVE_META_CANARY.arms) {
    const rows = state.evaluations.filter((item) => item.armRole === armRole);
    assert.equal(new Set(rows.map((item) => item.shardId)).size, 5);
    assert.equal(new Set(rows.map((item) => item.promptArtifactSha256)).size, 5);
    assert.equal(new Set(rows.map((item) => item.rawResultSha256)).size, 5);
  }
  const independent = verifyAdaptiveMetaCanaryRun(store, 'adaptive-meta-pass');
  assert.equal(independent.experimentValid, true, JSON.stringify(independent, null, 2));
  assert.equal(independent.gates.promptBinding, true);
  assert.equal(independent.gates.proposalInputParity, true);
  assert.equal(independent.gates.proposalBlindness, true);
  assert.equal(independent.gates.evaluationPartitionIsolation, true);
  assert.equal(independent.gates.distinctEvaluationShards, true);
  assert.equal(independent.gates.callOrder, true);
  assert.equal(independent.gates.partitionIsolation, true);
  assert.equal(independent.gates.privateEvidenceWithheld, true);
  assert.equal(independent.gates.sealedEvidenceIntegrity, true);
  assert.equal(independent.gates.implementationIntegrity, true);
  assert.ok(seen.every((contract) => (
    !JSON.stringify(contract).includes('WORKER_PLUGIN_CONTEXT')
  )), 'private mechanism evidence must never enter a worker contract');
  const cli = spawnSync(process.execPath, [
    'scripts/verify-adaptive-meta-canary.mjs',
    '--home', home,
    '--run', 'adaptive-meta-pass'
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).experimentValid, true);
});

test('v2 stops after six calls when the no-memory control leaves no measurable headroom', () => {
  const { store } = freshEngine();
  const config = approvedConfig();
  const seen = [];
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-no-headroom',
    worker: metaCanaryWorker(config, seen, { baselineSolves: true })
  });
  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.experimentValid, true, JSON.stringify(result.verification, null, 2));
  assert.equal(result.activationEligible, false);
  assert.equal(result.outcome.status, 'NO_HEADROOM');
  assert.equal(result.outcome.baselineTargetFailures, 0);
  assert.equal(result.outcome.routedPairedTargetWins, null);
  assert.equal(seen.length, ADAPTIVE_META_CANARY.qualificationCalls);
  const state = store.load('adaptive-meta-no-headroom');
  assert.equal(state.status, 'NO_HEADROOM');
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].armRole, 'baseline');
  assert.equal(state.evaluations.length, 5);
  assert.ok(state.evaluations.every((item) => item.armRole === 'baseline'));
  assert.equal(state.qualification.status, 'NO_HEADROOM');
  assert.equal(state.verdictEvents.length, 6);
  assert.equal(result.verification.gates.callOrder, true);
  assert.equal(result.verification.gates.distinctEvaluationShards, true);
  assert.equal(result.verification.tokenUsage.observedCalls, 6);
});

test('qualification-only mode stops after a valid six-call headroom decision', () => {
  const { store } = freshEngine();
  const config = approvedQualificationConfig();
  const seen = [];
  const plan = buildAdaptiveMetaCanaryPlan(config);
  assert.equal(plan.contract.executionMode, 'qualification-only');
  assert.equal(plan.contract.proposalCalls, 1);
  assert.equal(plan.contract.evaluationCalls, 5);
  assert.equal(plan.contract.totalCalls, 6);
  assert.equal(plan.contract.executionSchedule.length, 6);
  const disclosure = adaptiveMetaCanaryLaunchDisclosure(config, {
    configPath: '/tmp/qualification.json',
    home: '/tmp/qualification-home',
    runId: 'qualification-only'
  });
  assert.equal(disclosure.calls.totalMaximum, 6);
  assert.equal(disclosure.calls.conditionalAfterQualification, 0);
  assert.equal(disclosure.exposure.sequentialTimeoutCeilingMinutes, 60);

  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-qualified-only',
    worker: metaCanaryWorker(config, seen)
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.activationEligible, false);
  assert.equal(result.outcome.status, 'QUALIFIED');
  assert.equal(result.outcome.baselineTargetFailures, 5);
  assert.equal(result.outcome.baselineControlFailures, 0);
  assert.equal(seen.length, 6);
  const state = store.load('adaptive-meta-qualified-only');
  assert.equal(state.status, 'QUALIFIED');
  assert.equal(state.proposals.length, 1);
  assert.equal(state.evaluations.length, 5);
  assert.equal(state.qualification.status, 'QUALIFIED');
  assert.equal(state.qualification.observedBaselineControlFailures, 0);
  const verified = verifyAdaptiveMetaCanaryRun(
    store,
    'adaptive-meta-qualified-only'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.equal(verified.outcome.status, 'QUALIFIED');
});

test('evaluation normalization removes proposal-only identifiers', () => {
  const config = rawConfig();
  const source = [
    BASELINE_BODY,
    SOURCE_PATH,
    config.benchmark.developmentCases[0].id,
    config.benchmark.developmentCases[0].evidenceRef.locator
  ].join('\n');
  const normalized = normalizeAdaptiveMetaCanaryEvaluationProcedure(
    config,
    source
  );
  assert.ok(!normalized.includes(SOURCE_PATH));
  assert.ok(!normalized.includes(config.benchmark.developmentCases[0].id));
  assert.ok(!normalized.includes(
    config.benchmark.developmentCases[0].evidenceRef.locator
  ));
  assert.match(normalized, /ASSIGNED_EVIDENCE_PATH/);
  assert.match(normalized, /DEVELOPMENT_CASE_ID/);
  assert.match(normalized, /ASSIGNED_EVIDENCE_LOCATOR/);
});

test('OAuth launch authority remains valid when Codex omits backend model identity', () => {
  const { store } = freshEngine();
  const config = approvedConfig();
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-missing-model-identity',
    worker: metaCanaryWorker(config, [], { reportModel: false })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, JSON.stringify(result.verification, null, 2));
  assert.equal(result.verification.gates.modelAuthority, true);
  assert.equal(result.verification.modelAuthority.backendModelIdentity, 'UNAVAILABLE');
  assert.equal(result.verification.modelAuthority.backendReportedCalls, 0);
});

test('adaptive meta-canary fails fast when a reported backend model mismatches the OAuth route', () => {
  const { store } = freshEngine();
  const config = approvedConfig();
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-model-mismatch',
    worker: metaCanaryWorker(config, [], { reportedModel: 'gpt-5.5' })
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'MODEL_AUTHORITY_UNPROVEN');
  assert.equal(result.verification.gates.modelAuthority, false);
  assert.equal(result.verification.modelAuthority.backendModelIdentity, 'MISMATCH');
  assert.equal(result.verification.tokenUsage.observedCalls, 1);
});

test('incomplete run preserves failed-call evidence, counts exposure, and reports no invented outcome', () => {
  const { store } = freshEngine();
  const config = approvedConfig();
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-incomplete',
    worker: metaCanaryWorker(config, [], { unchangedSham: true })
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'PROPOSAL_INVALID');
  const verification = result.verification;
  assert.equal(verification.gates.noRetries, true);
  assert.equal(verification.gates.failureEvidenceIntegrity, true);
  assert.equal(verification.gates.artifactHashes, true);
  assert.equal(verification.tokenUsage.observedCalls, 8);
  assert.equal(verification.tokenUsage.measuredCalls, 8);
  assert.equal(
    verification.tokenUsage.total,
    verification.tokenUsage.proposalTotal + verification.tokenUsage.evaluationTotal
  );
  assert.ok(verification.tokenUsage.failedDispatchTotal > 0);
  assert.equal(verification.outcome.status, 'INCOMPLETE');
  assert.equal(verification.outcome.baselineTargetFailures, null);
  assert.equal(verification.outcome.routedPairedTargetWins, null);
  assert.equal(verification.outcome.shamTargetWins, null);
  assert.equal(verification.outcome.controlRegressions, null);
  assert.deepEqual(
    verification.outcome.reasons,
    ['Each arm must have five complete target/control evaluations.']
  );
  const state = store.load('adaptive-meta-incomplete');
  assert.equal(state.failureEvidence.length, 1);
  assert.match(state.failureEvidence[0].result.artifactRef, /failed-final$/);
  const failedFinal = store.readArtifact(
    'adaptive-meta-incomplete',
    state.failureEvidence[0].result.artifactRef
  );
  store.writeArtifact(
    'adaptive-meta-incomplete',
    state.failureEvidence[0].result.artifactRef,
    { ...failedFinal, content: `${failedFinal.content}\nTAMPERED` }
  );
  const tampered = verifyAdaptiveMetaCanaryRun(store, 'adaptive-meta-incomplete');
  assert.equal(tampered.gates.failureEvidenceIntegrity, false);
  assert.equal(tampered.gates.artifactHashes, false);
});

test('independent meta-canary verification fails when a persisted prompt is changed', () => {
  const { store } = freshEngine();
  const config = approvedConfig();
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-prompt-tamper',
    worker: metaCanaryWorker(config)
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('adaptive-meta-prompt-tamper');
  const routed = state.proposals.find((item) => item.armRole === 'routed');
  const prompt = store.readArtifact('adaptive-meta-prompt-tamper', routed.promptArtifactRef);
  store.writeArtifact('adaptive-meta-prompt-tamper', routed.promptArtifactRef, {
    ...prompt,
    content: `${prompt.content}\nTAMPERED`
  });
  const verification = verifyAdaptiveMetaCanaryRun(store, 'adaptive-meta-prompt-tamper');
  assert.equal(verification.experimentValid, false);
  assert.equal(verification.gates.promptBinding, false);
  assert.equal(verification.gates.artifactHashes, false);
});

test('meta-canary plan CLI discloses exposure and exits before execution without exact approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adaptive-meta-plan-'));
  const path = join(dir, 'config.json');
  const config = rawConfig();
  const serialized = {
    ...config,
    evidenceManifest: undefined,
    evidenceCapsule: undefined,
    heldOutEvidenceManifest: undefined,
    heldOutEvidenceCapsule: undefined,
    mechanismEvidenceManifest: undefined,
    mechanismEvidenceCapsule: undefined,
    implementationManifest: undefined,
    implementationCapsule: undefined,
    runtimeAuthority: undefined
  };
  writeFileSync(path, JSON.stringify(serialized));
  try {
    const codexPath = fakeCodexAuthorityBinary(dir);
    const result = spawnSync(process.execPath, [
      'scripts/plan-adaptive-meta-canary.mjs',
      '--config', path,
      '--run-id', 'adaptive-meta-cli',
      '--home', join(dir, 'proof-home')
    ], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPER_LOOP_CODEX_BIN: codexPath
      }
    });
    assert.equal(result.status, 4, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'AWAITING_EXACT_APPROVAL');
    assert.equal(output.calls.totalMaximum, 18);
    assert.equal(output.calls.qualificationBeforeDecision, 6);
    assert.equal(output.calls.conditionalAfterQualification, 12);
    assert.equal(output.partitions.heldOutShards, 5);
    assert.equal(output.calls.retries, 0);
    assert.equal(output.exposure.sequentialTimeoutCeilingMinutes, 180);
    assert.equal(output.exposure.hardTokenLimit, null);
    assert.equal(output.exposure.hardUsdLimit, null);
    assert.equal(output.workerLaunched, false);
    assert.match(output.planSha256, /^[a-f0-9]{64}$/);
    assert.match(result.stderr, /Operator action required/);
    assert.match(result.stderr, /No worker was launched/);
    const blockedLaunch = spawnSync(process.execPath, [
      'scripts/run-adaptive-meta-canary.mjs',
      '--config', path,
      '--approved-plan', output.planSha256,
      '--run-id', 'adaptive-meta-cli-oauth-block',
      '--home', join(dir, 'blocked-proof-home')
    ], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPER_LOOP_CODEX_BIN: codexPath,
        SUPER_LOOP_ALLOW_EXEC: '1'
      }
    });
    assert.equal(blockedLaunch.status, 4);
    assert.match(blockedLaunch.stderr, /ADAPTIVE_META_CANARY_OAUTH_LOCK BLOCKED/);
    assert.match(blockedLaunch.stderr, /No worker was launched/);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['meta-canary:plan'], 'node scripts/plan-adaptive-meta-canary.mjs');
    assert.equal(pkg.scripts['meta-canary'], 'node scripts/run-adaptive-meta-canary.mjs');
    assert.equal(pkg.scripts['verify:meta-canary'], 'node scripts/verify-adaptive-meta-canary.mjs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2 config rejects held-out leakage and evidence reuse before execution', () => {
  const leaked = rawConfig();
  leaked.target.proposalBrief.problem = [
    leaked.target.proposalBrief.problem,
    HELD_OUT_SOURCE_PATHS[0]
  ].join(' ');
  leaked.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(leaked).sha256;
  const leakedValidation = validateAdaptiveMetaCanaryConfig(leaked);
  assert.equal(leakedValidation.ok, false);
  assert.ok(leakedValidation.errors.some((error) => /leaked into proposal-visible/.test(error)));

  const codeLeak = rawConfig();
  codeLeak.target.proposalBrief.problem += ' RECEIPT_ATOMIC_REJECT_1';
  codeLeak.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(codeLeak).sha256;
  const codeLeakValidation = validateAdaptiveMetaCanaryConfig(codeLeak);
  assert.equal(codeLeakValidation.ok, false);
  assert.ok(codeLeakValidation.errors.some((error) => /leaked into proposal-visible/.test(error)));

  const reused = rawConfig();
  reused.benchmark.evaluationShards[1].evidencePaths.push(HELD_OUT_SOURCE_PATHS[0]);
  reused.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(reused).sha256;
  const reusedValidation = validateAdaptiveMetaCanaryConfig(reused);
  assert.equal(reusedValidation.ok, false);
  assert.ok(reusedValidation.errors.some((error) => /exactly one shard/.test(error)));

  const copiedBytes = rawConfig();
  copiedBytes.heldOutEvidenceCapsule[1].content =
    copiedBytes.heldOutEvidenceCapsule[0].content;
  copiedBytes.heldOutEvidenceCapsule[1].bytes = Buffer.byteLength(
    copiedBytes.heldOutEvidenceCapsule[1].content
  );
  copiedBytes.heldOutEvidenceCapsule[1].sha256 = sha256(
    Buffer.from(copiedBytes.heldOutEvidenceCapsule[1].content)
  );
  copiedBytes.heldOutEvidenceManifest[1].bytes =
    copiedBytes.heldOutEvidenceCapsule[1].bytes;
  copiedBytes.heldOutEvidenceManifest[1].sha256 =
    copiedBytes.heldOutEvidenceCapsule[1].sha256;
  copiedBytes.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(copiedBytes).sha256;
  const copiedBytesValidation = validateAdaptiveMetaCanaryConfig(copiedBytes);
  assert.equal(copiedBytesValidation.ok, false);
  assert.ok(copiedBytesValidation.errors.some((error) => /byte-distinct/.test(error)));

  const copiedChallenge = rawConfig();
  for (const shard of copiedChallenge.benchmark.evaluationShards.slice(0, 2)) {
    const targetCase = shard.cases[0];
    targetCase.evidenceRef.locator = '"baselineDisposition": "COUNTED"';
    shard.oracle.cases[0].code = 'RECEIPT_ATOMIC_REJECT';
  }
  copiedChallenge.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(copiedChallenge).sha256;
  const copiedChallengeValidation = validateAdaptiveMetaCanaryConfig(copiedChallenge);
  assert.equal(copiedChallengeValidation.ok, false);
  assert.ok(copiedChallengeValidation.errors.some((error) => (
    /distinct evidence and failure signatures/.test(error)
  )));

  const crossShardIdentity = rawConfig();
  crossShardIdentity.benchmark.evaluationShards[1].cases[0].prompt +=
    ` ${crossShardIdentity.benchmark.evaluationShards[0].cases[0].id}`;
  crossShardIdentity.approvedPlanSha256 =
    buildAdaptiveMetaCanaryPlan(crossShardIdentity).sha256;
  const crossShardIdentityValidation =
    validateAdaptiveMetaCanaryConfig(crossShardIdentity);
  assert.equal(crossShardIdentityValidation.ok, false);
  assert.ok(crossShardIdentityValidation.errors.some((error) => (
    /contains another shard's identity, prompt, locator, or path/.test(error)
  )));

  const prefixedCaseId = rawConfig();
  const firstShardTargetId =
    prefixedCaseId.benchmark.evaluationShards[0].cases[0].id;
  prefixedCaseId.benchmark.evaluationShards[1].cases[0].id =
    `${firstShardTargetId}-2`;
  prefixedCaseId.benchmark.evaluationShards[1].oracle.cases[0].caseId =
    `${firstShardTargetId}-2`;
  prefixedCaseId.approvedPlanSha256 =
    buildAdaptiveMetaCanaryPlan(prefixedCaseId).sha256;
  const prefixedCaseIdValidation =
    validateAdaptiveMetaCanaryConfig(prefixedCaseId);
  assert.equal(prefixedCaseIdValidation.ok, false);
  assert.ok(prefixedCaseIdValidation.errors.some((error) => (
    /contains another shard's identity, prompt, locator, or path/.test(error)
  )));

  const legacyLaunch = rawConfig();
  delete legacyLaunch.schemaVersion;
  legacyLaunch.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(legacyLaunch).sha256;
  const legacyValidation = validateAdaptiveMetaCanaryConfig(legacyLaunch);
  assert.equal(legacyValidation.ok, false);
  assert.ok(legacyValidation.errors.some((error) => /v1 is verification-only/.test(error)));

  const missingPrivatePolicy = rawConfig();
  delete missingPrivatePolicy.privateEvidencePolicy;
  missingPrivatePolicy.approvedPlanSha256 =
    buildAdaptiveMetaCanaryPlan(missingPrivatePolicy).sha256;
  const missingPrivatePolicyValidation =
    validateAdaptiveMetaCanaryConfig(missingPrivatePolicy);
  assert.equal(missingPrivatePolicyValidation.ok, false);
  assert.ok(missingPrivatePolicyValidation.errors.some((error) => (
    /privateEvidencePolicy must be source-qualified-v2/.test(error)
  )));

  const historicalPrivatePolicyValidation = validateAdaptiveMetaCanaryConfig(
    missingPrivatePolicy,
    { allowHistoricalPrivateEvidencePolicy: true }
  );
  assert.equal(
    historicalPrivatePolicyValidation.ok,
    true,
    historicalPrivatePolicyValidation.errors.join('\n')
  );
});

test('v2 config rejects private mechanism evidence in worker-visible partitions', () => {
  const pathLeak = rawConfig();
  pathLeak.target.proposalBrief.problem += ` ${MECHANISM_SOURCE_PATH}`;
  pathLeak.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(pathLeak).sha256;
  const pathLeakValidation = validateAdaptiveMetaCanaryConfig(pathLeak);
  assert.equal(pathLeakValidation.ok, false);
  assert.ok(pathLeakValidation.errors.some((error) => (
    /private mechanism evidence leaked into worker-visible partitions/.test(error)
  )));

  const locatorLeak = rawConfig();
  locatorLeak.target.proposalBrief.problem += " code: 'WORKER_PLUGIN_CONTEXT'";
  locatorLeak.approvedPlanSha256 = buildAdaptiveMetaCanaryPlan(locatorLeak).sha256;
  const locatorLeakValidation = validateAdaptiveMetaCanaryConfig(locatorLeak);
  assert.equal(locatorLeakValidation.ok, false);
  assert.ok(locatorLeakValidation.errors.some((error) => (
    /private mechanism evidence leaked into worker-visible partitions/.test(error)
  )));
});

test('independent v2 verification rejects a persisted shard rebind', () => {
  const { store } = freshEngine();
  const config = approvedConfig();
  const result = runAdaptiveMetaCanary(store, config, {
    runId: 'adaptive-meta-shard-tamper',
    worker: metaCanaryWorker(config)
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('adaptive-meta-shard-tamper');
  state.evaluations[0].shardId = state.evaluations[1].shardId;
  store.save(state);
  const verification = verifyAdaptiveMetaCanaryRun(store, 'adaptive-meta-shard-tamper');
  assert.equal(verification.experimentValid, false);
  assert.equal(verification.gates.armSchedule, false);
  assert.equal(verification.gates.evaluationPartitionIsolation, false);
  assert.equal(verification.gates.distinctEvaluationShards, false);
  assert.equal(verification.gates.measurementDerivation, false);
});

test('adaptive config hash changes when routing evidence or capsule bytes change', () => {
  const config = approvedConfig();
  const first = buildAdaptiveMetaCanaryPlan(config);
  const changed = structuredClone(config);
  changed.mechanismContext.shamCapsule.items[0].instruction = 'Different irrelevant bytes.';
  changed.mechanismContext.shamCapsule.mechanismCapsuleSha256 = sha256(
    canonicalAdaptiveJson((({ mechanismCapsuleSha256, ...payload }) => payload)(
      changed.mechanismContext.shamCapsule
    ))
  );
  const second = buildAdaptiveMetaCanaryPlan(changed);
  assert.notEqual(first.sha256, second.sha256);
  const validation = validateAdaptiveMetaCanaryConfig({
    ...changed,
    approvedPlanSha256: second.sha256
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => /sham capsule/.test(error)));
});

test('adaptive plan hash binds the executable implementation manifest', () => {
  const config = approvedConfig();
  const first = buildAdaptiveMetaCanaryPlan(config);
  const changed = structuredClone(config);
  changed.implementationManifest[0].sha256 = sha256('different implementation bytes');
  const second = buildAdaptiveMetaCanaryPlan(changed);
  assert.notEqual(first.sha256, second.sha256);
  const validation = validateAdaptiveMetaCanaryConfig({
    ...changed,
    approvedPlanSha256: second.sha256
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => /implementation capsule/.test(error)));
});
