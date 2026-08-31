import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_TRANSFER_COHORT,
  ADAPTIVE_TRANSFER_COHORT_EVALUATION_NORMALIZATION,
  ADAPTIVE_TRANSFER_COHORT_PROPOSAL_INSTRUCTION,
  ADAPTIVE_TRANSFER_COHORT_SHAM_INSTRUCTION,
  ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION,
  adaptiveTransferCohortLaunchDisclosure,
  buildAdaptiveTransferCohortPlan,
  buildAdaptiveTransferCohortSchedule,
  normalizeAdaptiveTransferCohortEvaluationProcedure,
  resolveAdaptiveTransferCohortImplementation,
  runAdaptiveTransferCohort,
  validateAdaptiveTransferCohortConfig,
  verifyAdaptiveTransferCohortRun
} from '../src/adaptive-transfer-cohort.mjs';
import {
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
import { createIrrelevantShamCapsule } from '../src/adaptive-meta-canary.mjs';
import { createCohortSubprocessWorker } from '../src/cohort-executor.mjs';
import {
  PRESENTATION_ONLY_SHAM_VALIDATION,
  compilePhaseContract,
  validateWorkerPacket
} from '../src/supervisor.mjs';

const NAMES = ['alpha', 'bravo', 'cinder', 'delta', 'ember'];
const DEVELOPMENT_PATHS = NAMES.map(
  (name) => `test/fixtures/adaptive-transfer-cohort/development-${name}.json`
);
const HELD_OUT_PATHS = NAMES.map(
  (name) => `test/fixtures/adaptive-transfer-cohort/heldout-${name}.json`
);
const MECHANISM_PATH =
  'test/fixtures/adaptive-transfer-cohort/private-mechanism.json';
const FIXTURE_CODEX_PATH = '/opt/codex/codex.real';
const FIXTURE_CODEX_BYTES = Buffer.from('fixture-cohort-codex-v1');
const FIXTURE_CATALOG = JSON.stringify({
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
const ROUTING_TARGET = {
  taskMode: 'improve',
  loopRole: 'supervisor',
  taskValueDimensions: ['transfer-quality'],
  resourceDimensions: ['token-cost']
};

function fixtureRuntimeAuthority({
  binaryPath = FIXTURE_CODEX_PATH,
  binaryBytes = FIXTURE_CODEX_BYTES
} = {}) {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath,
    binaryBytes,
    versionOutput: 'codex-cli 0.0.0-cohort-test',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: FIXTURE_CATALOG,
    requestedModel: REAL_TEST_MODEL,
    reasoningEffort: 'high'
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function mechanismFamily() {
  const built = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'context-fragmentation-hides-transfer-signal',
      interventionKind: 'bind-relevant-mechanism-before-hypothesis',
      operationKind: 'evidence-routed-hypothesis-generation',
      expectedEffectKind: 'more-held-out-task-wins',
      preconditions: ['frozen-transfer-cohort', 'strict-codex-launch'],
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['transfer-quality'],
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
    appliedAt: `2026-07-23T03:0${suffix}:00.000Z`,
    partition,
    source: {
      runId: `cohort-history-${suffix}`,
      hypothesisId: `cohort-history-hypothesis-${suffix}`,
      testId: `cohort-history-test-${suffix}`
    },
    context: {
      targetSha256: sha256(`cohort-history-target-${suffix}`),
      ...ROUTING_TARGET
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
      qualityDelta: 0.2,
      tokenCostDeltaPct: -0.03,
      shamMovement: 0,
      controlRegressions: 0,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: sha256(`cohort-transfer-${suffix}`)
      }],
      contradictionCodes: []
    },
    credit: {
      confidence: 0.95,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256(`cohort-legacy-id-${suffix}`).slice(0, 24)}`,
      legacyReceiptSha256: sha256(`cohort-legacy-${suffix}`),
      benchmarkSha256: sha256('cohort-historical-benchmark'),
      artifactSetSha256: sha256(`cohort-historical-artifacts-${suffix}`),
      evidenceSetSha256: sha256(`cohort-historical-evidence-${suffix}`)
    }
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function rawConfig() {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const development = resolveEvidenceCapsule(repositoryRoot, DEVELOPMENT_PATHS);
  const heldOut = resolveEvidenceCapsule(repositoryRoot, HELD_OUT_PATHS);
  const mechanism = resolveEvidenceCapsule(repositoryRoot, [MECHANISM_PATH]);
  const implementation = resolveAdaptiveTransferCohortImplementation(repositoryRoot);
  assert.equal(development.ok, true, development.errors.join('\n'));
  assert.equal(heldOut.ok, true, heldOut.errors.join('\n'));
  assert.equal(mechanism.ok, true, mechanism.errors.join('\n'));

  const family = mechanismFamily();
  const applications = [
    mechanismApplication(family, 'harvest', 1),
    mechanismApplication(family, 'gate', 2),
    mechanismApplication(family, 'reference', 3)
  ];
  const policy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  policy.allocations.related = 0.8;
  policy.allocations.adjacent = 0;
  policy.allocations.failureDerived = 0;
  policy.allocations.wildcard = 0;
  const epoch = createBaselinePolicyEpoch({
    policy,
    evidenceWindowSha256: sha256('cohort-policy-window'),
    policyScopeId: 'cohort-confirmatory-test'
  });
  assert.equal(epoch.status, 'OK', epoch.message);

  const tasks = NAMES.map((name, index) => {
    const developmentPath = DEVELOPMENT_PATHS[index];
    const heldOutPath = HELD_OUT_PATHS[index];
    const findingId = `finding-${String(index + 1).padStart(3, '0')}`;
    const routed = buildMechanismRoutingDecision({
      families: [family],
      applications,
      target: ROUTING_TARGET,
      policyEpoch: epoch.record,
      seed: `cohort-routing-${name}`,
      hypothesisCount: 2,
      mode: 'active-canary'
    });
    assert.equal(routed.status, 'OK', routed.message);
    assert.equal(routed.capsule.items.length, 1);
    const targetId = `${name}-hidden-target`;
    const cleanId = `${name}-hidden-clean`;
    const guardId = `${name}-hidden-guard`;
    return {
      id: `transfer-${name}`,
      target: {
        findingId,
        title: `Resolve the ${name} transfer boundary`,
        baselineContent: [
          BASELINE_BODY,
          '',
          `## ${name} Frozen Extension`,
          `The ${name} task intentionally preserves one distinct unresolved development boundary while retaining clean acceptance and existing guard rejection behavior.`
        ].join('\n'),
        evidenceRefs: [{
          path: developmentPath,
          locator: `"finding": "${findingId}"`
        }],
        proposalBrief: {
          title: `Repair the ${name} transfer gap`,
          problem: `Proposal-visible ${name} evidence shows a structurally valid case that the frozen procedure still handles incorrectly without exposing the evaluator-only answer.`,
          invariants: [
            `Preserve the ${name} clean acceptance control exactly.`,
            `Preserve the ${name} existing rejection guard exactly.`
          ]
        },
        hypothesis: {
          title: `Route a verified mechanism into ${name}`,
          bottleneck: `The ${name} proposal must discover a transfer rule without evaluator evidence.`,
          operation: `Apply the routed family only when it improves the ${name} target without changing controls.`,
          expectedMovement: `Routed ${name} quality exceeds baseline while sham remains unchanged.`,
          falsifier: `The ${name} routed arm ties baseline or regresses a protected control.`
        }
      },
      developmentEvidencePaths: [developmentPath],
      heldOutEvidencePaths: [heldOutPath],
      developmentCases: [
        {
          id: `${name}-dev-gap`,
          prompt: `Inspect the proposal-visible ${name} development gap without predicting hidden outputs.`,
          evidenceRef: {
            path: developmentPath,
            locator: `"id": "${name}-dev-gap"`
          }
        },
        {
          id: `${name}-dev-control`,
          prompt: `Preserve the proposal-visible ${name} development control behavior.`,
          evidenceRef: {
            path: developmentPath,
            locator: `"id": "${name}-dev-control"`
          }
        }
      ],
      heldOutCases: [
        {
          id: targetId,
          prompt: `Apply the active procedure to the sealed ${name} transfer target.`,
          evidenceRef: {
            path: heldOutPath,
            locator: `"id": "${targetId}"`
          },
          baselineFailureRef: {
            path: heldOutPath,
            locator: `"${name}BaselineMarker": "MISSED"`
          }
        },
        {
          id: cleanId,
          prompt: `Apply the active procedure to the sealed ${name} clean control.`,
          evidenceRef: {
            path: heldOutPath,
            locator: `"id": "${cleanId}"`
          }
        },
        {
          id: guardId,
          prompt: `Apply the active procedure to the sealed ${name} guard control.`,
          evidenceRef: {
            path: heldOutPath,
            locator: `"id": "${guardId}"`
          }
        }
      ],
      oracle: {
        kind: 'case-results-v2',
        passMark: 1,
        cases: [
          {
            caseId: targetId,
            accepted: false,
            code: `${name.toUpperCase()}_TARGET_REJECT`,
            requiredEvidencePaths: [heldOutPath],
            group: 'target'
          },
          {
            caseId: cleanId,
            accepted: true,
            code: `${name.toUpperCase()}_CLEAN_ACCEPT`,
            requiredEvidencePaths: [heldOutPath],
            group: 'control'
          },
          {
            caseId: guardId,
            accepted: false,
            code: `${name.toUpperCase()}_GUARD_REJECT`,
            requiredEvidencePaths: [heldOutPath],
            group: 'control'
          }
        ]
      },
      routing: {
        target: ROUTING_TARGET,
        seed: `cohort-routing-${name}`,
        hypothesisCount: 2,
        routingDecision: routed.decision,
        candidatePool: routed.candidatePool,
        routedCapsule: routed.capsule,
        shamCapsule: createIrrelevantShamCapsule(routed.capsule),
        primaryFamilyId: family.familyId
      }
    };
  });

  return {
    schemaVersion: ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION,
    privateEvidencePolicy: 'source-qualified-v2',
    model: REAL_TEST_MODEL,
    fixtureOnly: true,
    historicalTokenEstimate: 750000,
    maxConcurrency: 2,
    seed: 'confirmatory-cohort-seed-v1',
    developmentEvidenceSources: DEVELOPMENT_PATHS,
    developmentEvidenceManifest: development.manifest,
    developmentEvidenceCapsule: development.capsule,
    heldOutEvidenceSources: HELD_OUT_PATHS,
    heldOutEvidenceManifest: heldOut.manifest,
    heldOutEvidenceCapsule: heldOut.capsule,
    mechanismEvidenceSources: [MECHANISM_PATH],
    mechanismEvidenceManifest: mechanism.manifest,
    mechanismEvidenceCapsule: mechanism.capsule,
    mechanismEvidenceRefs: [{
      path: MECHANISM_PATH,
      locator: '"privateMechanismReceipt": "verified"'
    }],
    implementationManifest: implementation.manifest,
    implementationCapsule: implementation.capsule,
    runtimeAuthority: fixtureRuntimeAuthority(),
    mechanismContext: {
      families: [family],
      applications,
      policyEpoch: epoch.record
    },
    tasks
  };
}

function approvedConfig() {
  const config = rawConfig();
  const plan = buildAdaptiveTransferCohortPlan(config);
  return { ...config, approvedPlanSha256: plan.sha256 };
}

function strictPacket(contract, payload, tag, tokenOffset = 0, {
  runtimeAuthority = fixtureRuntimeAuthority()
} = {}) {
  const rawResultText = JSON.stringify(payload);
  const finalOutput = `<${tag}>${rawResultText}</${tag}>`;
  const inputTokens = 160 + tokenOffset;
  const outputTokens = 100;
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({ type: 'agent_message', text: rawResultText }),
    JSON.stringify({
      type: 'token_count',
      input_tokens: inputTokens,
      output_tokens: outputTokens
    })
  ].join('\n');
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = `/tmp/adaptive-transfer-cohort-${sha256(
    `${contract.kind}:${payload.findingId}:${tokenOffset}`
  ).slice(0, 12)}`;
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
      reportedModel: contract.route,
      binaryFamily: 'codex',
      argv: buildArgs('codex', null, contract.route, {
        strictIsolation: true,
        schemaPath,
        workspaceRoot
      }),
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'cli-reported',
      reportedModelMatchesRequest: true,
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
      durationMs: 20,
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  };
}

function cohortWorker(config, tracker, {
  baselineSolves = false,
  routedFails = false,
  invalidSlotId = null,
  invalidSham = false,
  renamedSham = false
} = {}) {
  return async (contract, context) => {
    tracker.active++;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    tracker.calls.push({
      slotId: context.slotId,
      kind: contract.kind,
      findingId: contract.target.findingId,
      proposalValidationMode: contract.proposalValidationMode || null,
      mechanismInstruction:
        contract.mechanismCapsule?.items?.[0]?.instruction || null,
      procedureHasDevelopmentIdentity: contract.kind === 'evaluation'
        ? config.tasks.some((task) => (
            [
              ...task.developmentEvidencePaths,
              ...task.developmentCases.flatMap((item) => [
                item.id,
                item.evidenceRef.locator
              ])
            ].some((identifier) => contract.procedureContent.includes(identifier))
          ))
        : null
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
    tracker.active--;
    if (context.slotId === invalidSlotId) {
      return {
        route: contract.route,
        phase: contract.phase,
        artifacts: [],
        finalOutput: '',
        isolation: { status: 'PASS', toolCalls: [], reasons: [] }
      };
    }
    if (contract.kind === 'proposal') {
      const semantics = contract.mechanismCapsule?.items?.[0]?.semantics || 'none';
      const isSham = semantics === 'irrelevant-control';
      const marker = semantics === 'positive-transfer'
        ? 'COHORT_ROUTED_TRANSFER'
        : (isSham
            ? 'COHORT_SHAM_FORMAT_ONLY'
            : 'COHORT_BASELINE_NO_MEMORY');
      const revisedContent = isSham
        ? (invalidSham
            ? `${contract.target.baselineContent}\n\nReject one additional target.`
            : (renamedSham
                ? contract.target.baselineContent.replace(
                    /^##\s+(.+)$/m,
                    '## 1. Different Heading'
                  )
                : (() => {
                    return contract.target.baselineContent.replace(
                      /^##\s+(.+)$/gm,
                      (heading) => `${heading}\n`
                    );
                  })()))
        : [
            contract.target.baselineContent,
            '',
            '## Cohort Proposal',
            marker,
            contract.hypothesis.bottleneck,
            ...contract.requirements,
            `Use proposal evidence from ${contract.evidenceCapsule[0]?.path}.`,
            `Ground that rule in ${contract.frozenCases[0]?.id} at ${contract.frozenCases[0]?.evidenceRef?.locator}.`,
            'Preserve every protected behavior and use only evidence in this task partition.'
          ].join('\n');
      return strictPacket(contract, {
        findingId: contract.target.findingId,
        hypothesisId: contract.hypothesis.id,
        baselineSha256: contract.target.baselineSha256,
        revisedContent,
        changeSummary: isSham
          ? 'Presentation-only control: normalized heading spacing and kept behavior unchanged.'
          : `Apply the frozen cohort treatment through ${marker}.`
      }, 'IMPROVEMENT', tracker.calls.length, {
        runtimeAuthority: config.runtimeAuthority
      });
    }
    const task = config.tasks.find(
      (item) => item.target.findingId === contract.target.findingId
    );
    assert.ok(task);
    const routed = contract.procedureContent.includes('COHORT_ROUTED_TRANSFER');
    const baseline = contract.procedureContent.includes('COHORT_BASELINE_NO_MEMORY');
    const solvesTarget = (routed && !routedFails) || (baseline && baselineSolves);
    const rows = task.oracle.cases.map((item) => ({
      caseId: item.caseId,
      disposition: item.accepted
        ? 'ACCEPTED'
        : (item.group === 'control' || solvesTarget ? 'REJECTED' : 'ACCEPTED'),
      code: item.group === 'control' || solvesTarget
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
    }, 'EVALUATION', tracker.calls.length, {
      runtimeAuthority: config.runtimeAuthority
    });
  };
}

function tracker() {
  return { active: 0, maxActive: 0, calls: [] };
}

function fakeCodexAuthorityBinary(dir) {
  const path = join(dir, 'codex.real');
  writeFileSync(path, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "codex-cli 0.0.0-cohort-test"',
    'elif [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    '  echo "Logged in using ChatGPT"',
    'elif [ "$1" = "debug" ] && [ "$2" = "models" ]; then',
    `  printf '%s\\n' '${FIXTURE_CATALOG}'`,
    'else',
    '  exit 64',
    'fi',
    ''
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

test('cohort plan freezes five tasks, thirty calls, and deterministic two-wide waves', () => {
  const config = rawConfig();
  const validation = validateAdaptiveTransferCohortConfig(
    config,
    { requireApproval: false }
  );
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const plan = validation.plan;
  assert.equal(plan.profile, ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION);
  assert.equal(plan.contract.taskCount, 5);
  assert.equal(plan.contract.proposalCalls, 15);
  assert.equal(plan.contract.evaluationCalls, 15);
  assert.equal(plan.contract.totalCalls, 30);
  assert.equal(plan.contract.maxConcurrency, 2);
  assert.equal(plan.contract.waveCount, 16);
  assert.equal(plan.contract.exactSignTestP, 0.03125);
  assert.equal(
    plan.contract.evaluationProcedureNormalization,
    ADAPTIVE_TRANSFER_COHORT_EVALUATION_NORMALIZATION
  );
  assert.equal(
    plan.contract.proposalTreatmentInstructionSha256,
    sha256(ADAPTIVE_TRANSFER_COHORT_PROPOSAL_INSTRUCTION)
  );
  assert.equal(
    plan.contract.shamInstructionSha256,
    sha256(ADAPTIVE_TRANSFER_COHORT_SHAM_INSTRUCTION)
  );
  assert.equal(plan.contract.waves.length, 16);
  assert.equal(
    plan.contract.waves.flatMap((wave) => wave.slots).length,
    30
  );
  assert.ok(plan.contract.waves.every((wave) => wave.slots.length <= 2));
  const scheduleAgain = buildAdaptiveTransferCohortSchedule(config);
  assert.deepEqual(scheduleAgain.waves, plan.contract.waves);
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.tasks.every((task) => (
    /^[a-f0-9]{64}$/.test(task.executionShamCapsuleSha256)
    && task.executionShamCapsuleSha256 !== task.shamCapsuleSha256
  )));
  const proposalFirstArms = plan.contract.waves
    .filter((wave) => wave.stage === 'proposal')
    .flatMap((wave) => wave.slots)
    .filter((slot) => slot.roundIndex === 0)
    .map((slot) => slot.armRole);
  assert.deepEqual(proposalFirstArms, [
    'baseline', 'routed', 'sham', 'baseline', 'routed'
  ]);
});

test('cohort config fails closed on cross-task aliases and private evidence leakage', () => {
  const alias = rawConfig();
  alias.tasks[1].heldOutCases[0].id = `${alias.tasks[0].heldOutCases[0].id}-2`;
  alias.tasks[1].oracle.cases[0].caseId = alias.tasks[1].heldOutCases[0].id;
  const aliasValidation = validateAdaptiveTransferCohortConfig(
    alias,
    { requireApproval: false }
  );
  assert.equal(aliasValidation.ok, false);
  assert.ok(aliasValidation.errors.some((error) => (
    /contains another task's hidden or visible identity/.test(error)
  )));

  const leaked = rawConfig();
  leaked.tasks[0].target.proposalBrief.problem +=
    ' "privateMechanismReceipt": "verified"';
  const leakedValidation = validateAdaptiveTransferCohortConfig(
    leaked,
    { requireApproval: false }
  );
  assert.equal(leakedValidation.ok, false);
  assert.ok(leakedValidation.errors.some((error) => (
    /private mechanism evidence leaked/.test(error)
  )));

  const contaminated = rawConfig();
  const foreignId = contaminated.tasks[1].heldOutCases[0].id;
  const capsuleItem = contaminated.developmentEvidenceCapsule[0];
  capsuleItem.content += `\n${foreignId}\n`;
  capsuleItem.bytes = Buffer.byteLength(capsuleItem.content);
  capsuleItem.sha256 = sha256(Buffer.from(capsuleItem.content));
  const manifestItem = contaminated.developmentEvidenceManifest.find(
    (item) => item.path === capsuleItem.path
  );
  manifestItem.bytes = capsuleItem.bytes;
  manifestItem.sha256 = capsuleItem.sha256;
  const contaminatedValidation = validateAdaptiveTransferCohortConfig(
    contaminated,
    { requireApproval: false }
  );
  assert.equal(contaminatedValidation.ok, false);
  assert.ok(contaminatedValidation.errors.some((error) => (
    /contains another task's hidden or visible identity/.test(error)
  )));
});

test('cohort runs all thirty calls at concurrency two and proves five routed wins', async () => {
  const config = approvedConfig();
  const { store } = freshEngine();
  const seen = tracker();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-pass',
    worker: cohortWorker(config, seen)
  });
  assert.equal(result.status, 'OK');
  assert.equal(
    result.experimentValid,
    true,
    result.verification.reasons.join('\n')
  );
  assert.equal(result.activationEligible, true);
  assert.equal(result.outcome.status, 'PASS');
  assert.equal(result.outcome.routedWins, 5);
  assert.equal(result.outcome.shamWins, 0);
  assert.equal(result.outcome.controlRegressions, 0);
  assert.equal(result.outcome.exactSignTestP, 0.03125);
  assert.equal(seen.calls.length, 30);
  assert.equal(seen.maxActive, 2);
  assert.ok(seen.calls.filter((item) => item.kind === 'proposal').every((item) => (
    item.proposalValidationMode === PRESENTATION_ONLY_SHAM_VALIDATION
  )));
  assert.ok(seen.calls.filter((item) => (
    item.kind === 'proposal' && item.slotId.endsWith('-sham')
  )).every((item) => (
    item.mechanismInstruction === ADAPTIVE_TRANSFER_COHORT_SHAM_INSTRUCTION
  )));
  assert.ok(seen.calls.filter((item) => item.kind === 'evaluation').every(
    (item) => item.procedureHasDevelopmentIdentity === false
  ));
  const state = store.load('adaptive-transfer-cohort-pass');
  assert.equal(state.proposals.length, 15);
  assert.equal(state.evaluations.length, 15);
  assert.equal(state.callLedger.length, 30);
  assert.equal(state.waveLedger.length, 16);
  assert.ok(state.callLedger.every((item) => (
    item.status === 'ACCEPTED'
    && item.attempt === 0
    && item.packetSha256
  )));
  assert.equal(state.promotion.enabled, false);
  assert.equal(state.promotion.recorded, false);
  const verified = verifyAdaptiveTransferCohortRun(
    store,
    'adaptive-transfer-cohort-pass'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.equal(verified.activationEligible, true);
  assert.ok(Object.values(verified.gates).every(Boolean));
  assert.equal(verified.evidenceSha256, result.verification.evidenceSha256);
});

test('a valid complete cohort may return a causal FAIL without weakening integrity', async () => {
  const config = approvedConfig();
  const { store } = freshEngine();
  const seen = tracker();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-null',
    worker: cohortWorker(config, seen, { baselineSolves: true })
  });
  assert.equal(result.status, 'OK');
  assert.equal(
    result.experimentValid,
    true,
    result.verification.reasons.join('\n')
  );
  assert.equal(result.activationEligible, false);
  assert.equal(result.outcome.status, 'FAIL');
  assert.equal(result.outcome.routedWins, 0);
  assert.equal(result.outcome.exactSignTestP, 1);
  assert.equal(seen.calls.length, 30);
});

test('a behavioral sham fails closed while preserving exact-model failure evidence', async () => {
  const config = approvedConfig();
  const { store } = freshEngine();
  const seen = tracker();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-invalid-sham',
    worker: cohortWorker(config, seen, { invalidSham: true })
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'COHORT_WAVE_INVALID');
  assert.match(result.message, /SHAM_NOT_PRESENTATION_ONLY/);
  assert.equal(seen.calls.length, 4);
  const state = store.load('adaptive-transfer-cohort-invalid-sham');
  assert.equal(state.completedAt != null, true);
  assert.equal(state.verdictEvents.length, 4);
  assert.ok(state.verdictEvents.every((event) => event.attempt === 0));
  assert.equal(result.verification.gates.modelAuthority, true);
  assert.equal(result.verification.gates.strictIsolation, true);
  assert.equal(result.verification.gates.noRetries, true);
  assert.equal(result.verification.experimentValid, false);
});

test('a renamed sham heading fails the presentation-only contract', async () => {
  const config = approvedConfig();
  const { store } = freshEngine();
  const seen = tracker();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-renamed-sham',
    worker: cohortWorker(config, seen, { renamedSham: true })
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'COHORT_WAVE_INVALID');
  assert.match(result.message, /SHAM_NOT_PRESENTATION_ONLY/);
  assert.equal(seen.calls.length, 4);
});

test('presentation-only validation admits exact spacing control and rejects other Markdown rewrites', () => {
  const baselineSha256 = sha256(BASELINE_BODY);
  const contract = compilePhaseContract('loop-de-loop', 1, {
    kind: 'proposal',
    route: REAL_TEST_MODEL,
    target: {
      findingId: 'finding-999',
      baselineArtifactId: 'baseline-presentation-control',
      baselineSha256,
      baselineContent: BASELINE_BODY,
      evidenceRefs: []
    },
    hypothesis: {
      id: 'finding-999-cohort-h1',
      title: 'Presentation control',
      bottleneck: 'The control must preserve every lexical token.'
    },
    mechanismCapsule: {
      items: [{
        semantics: 'irrelevant-control',
        instruction: 'Change presentation only.'
      }]
    },
    proposalValidationMode: PRESENTATION_ONLY_SHAM_VALIDATION,
    proposalTreatmentInstruction:
      ADAPTIVE_TRANSFER_COHORT_PROPOSAL_INSTRUCTION,
    toolPolicy: 'none'
  });
  const revisedContent = BASELINE_BODY
    .replace(/^##\s+(.+)$/gm, (heading) => `${heading}\n`);
  const payload = {
    findingId: contract.target.findingId,
    hypothesisId: contract.hypothesis.id,
    baselineSha256,
    revisedContent,
    changeSummary: 'Added deterministic heading spacing; no non-whitespace content or behavior changed.'
  };
  const accepted = validateWorkerPacket(
    contract,
    strictPacket(contract, payload, 'IMPROVEMENT')
  );
  assert.equal(accepted.accepted, true, accepted.reasons.join(', '));

  const reformatted = {
    ...payload,
    revisedContent: revisedContent.replace(
      'First, open the corpus read-only',
      '1. First, open the `corpus` read-only'
    )
  };
  const rejected = validateWorkerPacket(
    contract,
    strictPacket(contract, reformatted, 'IMPROVEMENT', 1)
  );
  assert.ok(rejected.reasons.includes('SHAM_NOT_PRESENTATION_ONLY'));
});

test('evaluation procedure normalization removes proposal-only identifiers', () => {
  const config = rawConfig();
  const task = config.tasks[0];
  const source = [
    task.target.baselineContent,
    task.developmentEvidencePaths[0],
    task.developmentCases[0].id,
    task.developmentCases[0].evidenceRef.locator
  ].join('\n');
  const normalized = normalizeAdaptiveTransferCohortEvaluationProcedure(
    task,
    source
  );
  assert.ok(!normalized.includes(task.developmentEvidencePaths[0]));
  assert.ok(!normalized.includes(task.developmentCases[0].id));
  assert.ok(!normalized.includes(task.developmentCases[0].evidenceRef.locator));
  assert.match(normalized, /ASSIGNED_EVIDENCE_PATH/);
  assert.match(normalized, /DEVELOPMENT_CASE_ID/);
  assert.match(normalized, /ASSIGNED_EVIDENCE_LOCATOR/);
});

test('one invalid slot preserves its launched sibling and stops before the next wave', async () => {
  const config = approvedConfig();
  const schedule = buildAdaptiveTransferCohortSchedule(config);
  const invalidSlotId = schedule.waves[0].slots[0].slotId;
  const { store } = freshEngine();
  const seen = tracker();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-invalid-wave',
    worker: cohortWorker(config, seen, { invalidSlotId })
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'COHORT_WAVE_INVALID');
  assert.equal(seen.calls.length, 2);
  assert.equal(seen.maxActive, 2);
  const state = store.load('adaptive-transfer-cohort-invalid-wave');
  assert.equal(state.waveLedger[0].status, 'FAILED');
  assert.ok(state.waveLedger.slice(1).every((wave) => wave.status === 'PLANNED'));
  assert.equal(
    state.callLedger.filter((item) => item.status === 'REJECTED').length,
    1
  );
  assert.equal(
    state.callLedger.filter((item) => item.status === 'ACCEPTED').length,
    1
  );
  assert.equal(
    state.callLedger.filter((item) => item.status === 'PLANNED').length,
    28
  );
  assert.equal(state.verdictEvents.length, 2);
  assert.ok(state.verdictEvents.every((event) => event.attempt === 0));
  assert.equal(state.completedAt != null, true);
  assert.equal(result.verification.gates.noRetries, true);
  assert.equal(result.verification.tokenUsage.observedCalls, 2);
  assert.equal(result.verification.tokenUsage.measuredCalls, 1);
  assert.equal(result.verification.tokenUsage.unmeasuredCalls, 1);
  assert.equal(result.verification.tokenUsage.total, null);
});

test('independent verification rejects a persisted prompt mutation', async () => {
  const config = approvedConfig();
  const { store } = freshEngine();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-tamper',
    worker: cohortWorker(config, tracker())
  });
  assert.equal(
    result.experimentValid,
    true,
    result.verification.reasons.join('\n')
  );
  const state = store.load('adaptive-transfer-cohort-tamper');
  const first = state.proposals[0];
  const artifact = store.readArtifact(
    'adaptive-transfer-cohort-tamper',
    first.promptArtifactRef
  );
  store.writeArtifact('adaptive-transfer-cohort-tamper', artifact.id, {
    ...artifact,
    content: `${artifact.content}\nTAMPERED`
  });
  const verified = verifyAdaptiveTransferCohortRun(
    store,
    'adaptive-transfer-cohort-tamper'
  );
  assert.equal(verified.experimentValid, false);
  assert.equal(verified.gates.promptBinding, false);
  assert.equal(verified.gates.artifactHashes, false);
});

test('independent verification rejects schedule and packet-envelope tampering', async () => {
  const config = approvedConfig();
  const { store } = freshEngine();
  const result = await runAdaptiveTransferCohort(store, config, {
    runId: 'adaptive-transfer-cohort-state-tamper',
    worker: cohortWorker(config, tracker())
  });
  assert.equal(
    result.experimentValid,
    true,
    result.verification.reasons.join('\n')
  );
  const state = store.load('adaptive-transfer-cohort-state-tamper');
  state.callLedger[0].waveId = 'proposal-wave-99';
  state.callLedger[1].packetSha256 = '0'.repeat(64);
  const firstProposal = state.proposals[0];
  store.save(state);
  const envelope = JSON.parse(store.readRunFile(
    'adaptive-transfer-cohort-state-tamper',
    firstProposal.packetPath
  ));
  envelope.slotId = 'proposal-forged-slot';
  store.writeRunFile(
    'adaptive-transfer-cohort-state-tamper',
    firstProposal.packetPath,
    JSON.stringify(envelope)
  );
  const verified = verifyAdaptiveTransferCohortRun(
    store,
    'adaptive-transfer-cohort-state-tamper'
  );
  assert.equal(verified.experimentValid, false);
  assert.equal(verified.gates.schedule, false);
  assert.equal(verified.gates.ledgerBindings, false);
  assert.equal(verified.gates.packetIntegrity, false);
});

test('subprocess worker atomically persists one execution-disabled packet envelope', async () => {
  const { store } = freshEngine();
  const runId = 'adaptive-transfer-cohort-subprocess';
  store.save({ runId, kind: 'cohort-subprocess-fixture' });
  const contract = compilePhaseContract('loop-de-loop', 1, {
    kind: 'proposal',
    route: REAL_TEST_MODEL,
    task: 'Produce a fixture proposal without launching a real executor.',
    target: {
      findingId: 'finding-001',
      title: 'Subprocess fixture',
      baselineArtifactId: 'baseline-fixture',
      baselineSha256: sha256(BASELINE_BODY),
      baselineContent: BASELINE_BODY,
      evidenceRefs: []
    },
    hypothesis: {
      id: 'finding-001-cohort-h1',
      title: 'Subprocess fixture',
      bottleneck: 'No live execution is allowed in this test.'
    },
    frozenCases: [],
    evidenceCapsule: [],
    mechanismCapsule: null,
    toolPolicy: 'none'
  });
  const contractContent = JSON.stringify(contract);
  const contractPath = 'call-inputs/subprocess-fixture.contract.json';
  store.writeRunFile(runId, contractPath, contractContent);
  const worker = createCohortSubprocessWorker({
    store,
    runId,
    env: {
      ...process.env,
      SUPER_LOOP_ALLOW_EXEC: '0'
    }
  });
  const packet = await worker(
    { ...contract, attempt: 0 },
    {
      runId,
      slotId: 'proposal-subprocess-fixture',
      contractPath,
      contractSha256: sha256(contractContent),
      packetPath: 'call-packets/proposal-subprocess-fixture.json'
    }
  );
  assert.equal(packet.__execReason, 'EXEC_DISABLED');
  const persisted = JSON.parse(store.readRunFile(
    runId,
    'call-packets/proposal-subprocess-fixture.json'
  ));
  assert.equal(persisted.schemaVersion, 'cohort-call-packet-v1');
  assert.equal(persisted.slotId, 'proposal-subprocess-fixture');
  assert.deepEqual(persisted.packet, packet);
});

test('plan CLI discloses exact exposure and never launches a worker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cohort-plan-cli-'));
  const codexPath = fakeCodexAuthorityBinary(dir);
  const configPath = join(dir, 'cohort.json');
  const home = join(dir, 'proof-home');
  const config = rawConfig();
  delete config.approvedPlanSha256;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const first = spawnSync(process.execPath, [
    'scripts/plan-adaptive-transfer-cohort.mjs',
    '--config', configPath,
    '--run-id', 'cohort-plan-cli',
    '--home', home
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPER_LOOP_CODEX_BIN: codexPath
    }
  });
  assert.equal(first.status, 4, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.status, 'AWAITING_EXACT_APPROVAL');
  assert.equal(output.workerLaunched, false);
  assert.equal(output.calls.total, 30);
  assert.equal(output.schedule.maxConcurrency, 2);
  assert.equal(output.schedule.waves, 16);
  assert.equal(output.schedule.conditionalContinuation, false);
  assert.equal(output.exposure.timeoutCeilingMinutes, 160);
  assert.equal(output.exposure.hardTokenLimit, null);
  assert.equal(output.exposure.hardUsdLimit, null);
  assert.equal(output.execution.model, REAL_TEST_MODEL);
  assert.equal(output.execution.reasoningEffort, 'high');
  assert.match(output.planSha256, /^[a-f0-9]{64}$/);
  assert.match(first.stderr, /Operator action required/);
  assert.match(first.stderr, /No worker was launched/);

  const approved = spawnSync(process.execPath, [
    'scripts/plan-adaptive-transfer-cohort.mjs',
    '--config', configPath,
    '--approved-plan', output.planSha256,
    '--run-id', 'cohort-plan-cli',
    '--home', home
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPER_LOOP_CODEX_BIN: codexPath
    }
  });
  assert.equal(approved.status, 0, approved.stderr);
  const approvedOutput = JSON.parse(
    approved.stdout.slice(0, approved.stdout.lastIndexOf('\nPlan-only'))
  );
  assert.equal(approvedOutput.status, 'READY');
  assert.equal(approvedOutput.planSha256, output.planSha256);
  assert.equal(approvedOutput.workerLaunched, false);
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert.equal(
    pkg.scripts['transfer-cohort:plan'],
    'node scripts/plan-adaptive-transfer-cohort.mjs'
  );
  assert.equal(
    pkg.scripts['transfer-cohort'],
    'node scripts/run-adaptive-transfer-cohort.mjs'
  );
  assert.equal(
    pkg.scripts['verify:transfer-cohort'],
    'node scripts/verify-adaptive-transfer-cohort.mjs'
  );
});

test('launch disclosure binds exact Sol argv, schemas, endpoint, and no retry policy', () => {
  const config = rawConfig();
  const disclosure = adaptiveTransferCohortLaunchDisclosure(config, {
    configPath: '/tmp/cohort.json',
    home: '/tmp/cohort-proof',
    runId: 'cohort-disclosure'
  });
  assert.equal(disclosure.calls.total, 30);
  assert.equal(disclosure.calls.retries, 0);
  assert.equal(disclosure.calls.fallbackModels, 0);
  assert.equal(disclosure.schedule.maxConcurrency, 2);
  assert.equal(disclosure.endpoint.requiredRoutedWins, 5);
  assert.equal(disclosure.endpoint.exactOneSidedSignTestP, 0.03125);
  assert.ok(disclosure.execution.proposalArgv.includes('-m'));
  assert.ok(disclosure.execution.proposalArgv.includes(REAL_TEST_MODEL));
  assert.ok(disclosure.execution.evaluationArgv.includes('--output-schema'));
  assert.deepEqual(
    disclosure.execution.disabledFeatures,
    [...STRICT_CODEX_DISABLED_FEATURES]
  );
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/adaptive-transfer-cohort-v1.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, ADAPTIVE_TRANSFER_COHORT_SCHEMA_VERSION);
  assert.equal(schema.properties.maxConcurrency.const, 2);
  assert.equal(schema.properties.tasks.minItems, 5);
  assert.equal(schema.properties.tasks.maxItems, 5);
});
