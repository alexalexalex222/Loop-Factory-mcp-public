import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION,
  ADAPTIVE_META_CANARY_SCHEMA_VERSION,
  createIrrelevantShamCapsule,
  resolveAdaptiveMetaCanaryImplementation
} from '../src/adaptive-meta-canary.mjs';
import {
  ADAPTIVE_TRANSFER_STUDY,
  ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE,
  ADAPTIVE_TRANSFER_STUDY_SCHEMA_VERSION,
  adaptiveTransferStudyCandidateOrder,
  adaptiveTransferStudyLaunchDisclosure,
  buildAdaptiveTransferStudyPlan,
  resolveAdaptiveTransferStudyImplementation,
  runAdaptiveTransferStudy,
  validateAdaptiveTransferStudyConfig,
  verifyAdaptiveTransferStudyRun
} from '../src/adaptive-transfer-study.mjs';
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
import { REAL_TEST_MODEL } from '../src/real-test.mjs';
import { sha256 } from '../src/util.mjs';
import { BASELINE_BODY, freshEngine } from './helpers.mjs';

const ROUTING_TARGET = {
  taskMode: 'improve',
  loopRole: 'supervisor',
  taskValueDimensions: ['evidence-quality'],
  resourceDimensions: ['token-cost']
};
const FIXTURE_CODEX_PATH = '/opt/codex/codex.real';
const FIXTURE_CODEX_BYTES = Buffer.from('fixture-study-codex-v1');
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

function runtimeAuthority() {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath: FIXTURE_CODEX_PATH,
    binaryBytes: FIXTURE_CODEX_BYTES,
    versionOutput: 'codex-cli 0.0.0-study-test',
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
      bottleneckKind: 'fragmented-evidence-admission',
      interventionKind: 'ordered-evidence-gates',
      operationKind: 'bind-authority-before-disposition',
      expectedEffectKind: 'fewer-invalid-admissions',
      preconditions: ['frozen-benchmark', 'sealed-evidence'],
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
    appliedAt: `2026-07-24T00:0${suffix}:00.000Z`,
    partition,
    source: {
      runId: `study-history-${suffix}`,
      hypothesisId: `study-history-hypothesis-${suffix}`,
      testId: `study-history-test-${suffix}`
    },
    context: {
      targetSha256: sha256(`study-history-target-${suffix}`),
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
      qualityDelta: 0.25,
      tokenCostDeltaPct: -0.04,
      shamMovement: 0,
      controlRegressions: 0,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: sha256(`study-transfer-${suffix}`)
      }],
      contradictionCodes: []
    },
    credit: {
      confidence: 0.92,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256(`study-legacy-id-${suffix}`).slice(0, 24)}`,
      legacyReceiptSha256: sha256(`study-legacy-${suffix}`),
      benchmarkSha256: sha256('study-historical-benchmark'),
      artifactSetSha256: sha256(`study-artifacts-${suffix}`),
      evidenceSetSha256: sha256(`study-evidence-${suffix}`)
    }
  });
  assert.equal(built.status, 'OK', built.message);
  return built.record;
}

function sealed(path, content) {
  const bytes = Buffer.byteLength(content);
  const digest = sha256(Buffer.from(content));
  return {
    manifest: [{ path, bytes, sha256: digest }],
    capsule: [{ path, bytes, sha256: digest, content }]
  };
}

function sharedMechanism() {
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
    evidenceWindowSha256: sha256('study-policy-window'),
    policyScopeId: 'study-confirmation'
  });
  assert.equal(epoch.status, 'OK', epoch.message);
  return { family, applications, policyEpoch: epoch.record };
}

function childConfig({
  candidateName,
  findingId,
  stage,
  authority,
  mechanism,
  metaImplementation
}) {
  const developmentPath = `study-fixtures/${candidateName}-development.json`;
  const developmentCases = [1, 2, 3].map((number) => ({
    id: `${candidateName}-development-${number}`,
    prompt: `Inspect proposal-visible ${candidateName} development scenario ${number} without predicting hidden answers.`,
    evidenceRef: {
      path: developmentPath,
      locator: `"id": "${candidateName}-development-${number}"`
    }
  }));
  const developmentContent = JSON.stringify({
    finding: findingId,
    cases: developmentCases.map((item) => ({
      id: item.id,
      observed: 'fragmented evidence can reach disposition too early'
    }))
  }, null, 2);
  const development = sealed(developmentPath, developmentContent);
  const prefix = stage === 'qualification' ? 'qual' : 'confirm';
  const heldOut = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    const path = `study-fixtures/${candidateName}-${prefix}-${number}.json`;
    const targetId = `${candidateName}-${prefix}-${number}-target`;
    const cleanId = `${candidateName}-${prefix}-${number}-clean`;
    const guardId = `${candidateName}-${prefix}-${number}-guard`;
    const content = JSON.stringify({
      id: `${candidateName}-${prefix}-${number}`,
      cases: [
        { id: targetId, baselineDisposition: 'MISSED' },
        { id: cleanId, expected: 'accept' },
        { id: guardId, expected: 'reject' }
      ]
    }, null, 2);
    const evidence = sealed(path, content);
    return {
      evidence,
      shard: {
        id: `${candidateName}-${prefix}-shard-${number}`,
        evidencePaths: [path],
        cases: [
          {
            id: targetId,
            prompt: `Apply the active procedure to sealed ${candidateName} ${prefix} target ${number}.`,
            evidenceRef: { path, locator: `"id": "${targetId}"` },
            baselineFailureRef: {
              path,
              locator: '"baselineDisposition": "MISSED"'
            }
          },
          {
            id: cleanId,
            prompt: `Apply the active procedure to sealed ${candidateName} ${prefix} clean control ${number}.`,
            evidenceRef: { path, locator: `"id": "${cleanId}"` }
          },
          {
            id: guardId,
            prompt: `Apply the active procedure to sealed ${candidateName} ${prefix} guard control ${number}.`,
            evidenceRef: { path, locator: `"id": "${guardId}"` }
          }
        ],
        oracle: {
          kind: 'case-results-v2',
          passMark: 1,
          cases: [
            {
              caseId: targetId,
              accepted: false,
              code: `${candidateName.toUpperCase()}_${prefix.toUpperCase()}_TARGET_${number}`,
              requiredEvidencePaths: [path],
              group: 'target'
            },
            {
              caseId: cleanId,
              accepted: true,
              code: `${candidateName.toUpperCase()}_${prefix.toUpperCase()}_CLEAN_${number}`,
              requiredEvidencePaths: [path],
              group: 'control'
            },
            {
              caseId: guardId,
              accepted: false,
              code: `${candidateName.toUpperCase()}_${prefix.toUpperCase()}_GUARD_${number}`,
              requiredEvidencePaths: [path],
              group: 'control'
            }
          ]
        }
      }
    };
  });
  const heldOutManifest = heldOut.flatMap((item) => item.evidence.manifest);
  const heldOutCapsule = heldOut.flatMap((item) => item.evidence.capsule);
  const mechanismPath = 'study-fixtures/private-mechanism.json';
  const mechanismContent = JSON.stringify({
    privateMechanismReceipt: 'verified-study-mechanism'
  });
  const mechanismEvidence = sealed(mechanismPath, mechanismContent);
  const routed = buildMechanismRoutingDecision({
    families: [mechanism.family],
    applications: mechanism.applications,
    target: ROUTING_TARGET,
    policyEpoch: mechanism.policyEpoch,
    seed: `study-routing-${candidateName}`,
    hypothesisCount: 2,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  return {
    schemaVersion: ADAPTIVE_META_CANARY_SCHEMA_VERSION,
    privateEvidencePolicy: 'source-qualified-v2',
    evaluationProcedureNormalization:
      ADAPTIVE_META_CANARY_EVALUATION_NORMALIZATION,
    executionMode: stage === 'qualification'
      ? 'qualification-only'
      : 'full',
    model: REAL_TEST_MODEL,
    fixtureOnly: true,
    historicalTokenEstimate: 500000,
    proposalRoutes: Array(stage === 'qualification' ? 1 : 3)
      .fill(REAL_TEST_MODEL),
    evaluationRoutes: Array(5).fill(REAL_TEST_MODEL),
    evidenceSources: [developmentPath],
    evidenceManifest: development.manifest,
    evidenceCapsule: development.capsule,
    heldOutEvidenceSources: heldOutManifest.map((item) => item.path),
    heldOutEvidenceManifest: heldOutManifest,
    heldOutEvidenceCapsule: heldOutCapsule,
    mechanismEvidenceSources: [mechanismPath],
    mechanismEvidenceManifest: mechanismEvidence.manifest,
    mechanismEvidenceCapsule: mechanismEvidence.capsule,
    mechanismEvidenceRefs: [{
      path: mechanismPath,
      locator: '"privateMechanismReceipt":"verified-study-mechanism"'
    }],
    implementationManifest: metaImplementation.manifest,
    implementationCapsule: metaImplementation.capsule,
    runtimeAuthority: authority,
    target: {
      findingId,
      title: `Repair ${candidateName} evidence admission`,
      baselineContent: BASELINE_BODY,
      evidenceRefs: [{
        path: developmentPath,
        locator: `"finding": "${findingId}"`
      }],
      proposalBrief: {
        title: `Close the ${candidateName} admission gap`,
        problem: `Proposal-visible ${candidateName} evidence shows that a valid-looking decision can be emitted before every required authority and artifact field is bound.`,
        invariants: [
          `Preserve valid ${candidateName} clean admissions exactly.`,
          `Preserve existing ${candidateName} rejection guards exactly.`
        ]
      },
      hypothesis: {
        title: `Order ${candidateName} evidence gates`,
        bottleneck: `The ${candidateName} procedure can reach disposition before its evidence chain is complete.`,
        operation: `Require authority, artifact, and decision gates in that order before emitting a ${candidateName} disposition.`,
        expectedMovement: `Routed ${candidateName} quality exceeds no-memory quality without moving controls.`,
        falsifier: `Routed ${candidateName} quality ties baseline or regresses a protected control.`
      }
    },
    benchmark: {
      name: `${candidateName}-${prefix}-benchmark`,
      developmentCases,
      evaluationShards: heldOut.map((item) => item.shard)
    },
    mechanismContext: {
      families: [mechanism.family],
      applications: mechanism.applications,
      routingTarget: ROUTING_TARGET,
      policyEpoch: mechanism.policyEpoch,
      seed: `study-routing-${candidateName}`,
      hypothesisCount: 2,
      routingDecision: routed.decision,
      candidatePool: routed.candidatePool,
      routedCapsule: routed.capsule,
      shamCapsule: createIrrelevantShamCapsule(routed.capsule),
      primaryFamilyId: mechanism.family.familyId
    },
    approvedPlanSha256: null
  };
}

function studyConfig(candidateCount = 5) {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const authority = runtimeAuthority();
  const mechanism = sharedMechanism();
  const metaImplementation = resolveAdaptiveMetaCanaryImplementation(
    repositoryRoot
  );
  const studyImplementation = resolveAdaptiveTransferStudyImplementation(
    repositoryRoot
  );
  const candidates = Array.from({ length: candidateCount }, (_, index) => {
    const candidateName = `study${index + 1}`;
    const findingId = `finding-${String(201 + index).padStart(3, '0')}`;
    const qualification = childConfig({
      candidateName,
      findingId,
      stage: 'qualification',
      authority,
      mechanism,
      metaImplementation
    });
    const confirmation = childConfig({
      candidateName,
      findingId,
      stage: 'confirmation',
      authority,
      mechanism,
      metaImplementation
    });
    const rawChild = (child) => {
      const raw = structuredClone(child);
      for (const field of [
        'evidenceManifest',
        'evidenceCapsule',
        'heldOutEvidenceManifest',
        'heldOutEvidenceCapsule',
        'mechanismEvidenceManifest',
        'mechanismEvidenceCapsule',
        'implementationManifest',
        'implementationCapsule',
        'runtimeAuthority',
        'approvedPlanSha256'
      ]) {
        delete raw[field];
      }
      return raw;
    };
    const qualificationConfigContent = JSON.stringify(rawChild(qualification));
    const confirmationConfigContent = JSON.stringify(rawChild(confirmation));
    return {
      id: `candidate-${candidateName}`,
      source: {
        qualificationConfigPath:
          `study-fixtures/${candidateName}-qualification.json`,
        qualificationConfigSha256:
          sha256(Buffer.from(qualificationConfigContent)),
        qualificationConfigContent,
        confirmationConfigPath:
          `study-fixtures/${candidateName}-confirmation.json`,
        confirmationConfigSha256:
          sha256(Buffer.from(confirmationConfigContent)),
        confirmationConfigContent
      },
      qualification,
      confirmation
    };
  });
  return {
    schemaVersion: ADAPTIVE_TRANSFER_STUDY_SCHEMA_VERSION,
    model: REAL_TEST_MODEL,
    fixtureOnly: true,
    historicalTokenEstimate: 2800000,
    seed: 'headroom-qualified-study-fixture',
    qualificationStopRule:
      ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE,
    candidates,
    implementationManifest: studyImplementation.manifest,
    implementationCapsule: studyImplementation.capsule,
    runtimeAuthority: authority,
    approvedPlanSha256: null
  };
}

function rawChildConfig(child) {
  const raw = structuredClone(child);
  for (const field of [
    'evidenceManifest',
    'evidenceCapsule',
    'heldOutEvidenceManifest',
    'heldOutEvidenceCapsule',
    'mechanismEvidenceManifest',
    'mechanismEvidenceCapsule',
    'implementationManifest',
    'implementationCapsule',
    'runtimeAuthority',
    'approvedPlanSha256'
  ]) {
    delete raw[field];
  }
  return raw;
}

function refreshCandidateSource(candidate) {
  for (const [stage, child] of [
    ['qualification', candidate.qualification],
    ['confirmation', candidate.confirmation]
  ]) {
    const content = JSON.stringify(rawChildConfig(child));
    candidate.source[`${stage}ConfigContent`] = content;
    candidate.source[`${stage}ConfigSha256`] = sha256(Buffer.from(content));
  }
}

function approvedStudyConfig(candidateCount = 5) {
  const config = studyConfig(candidateCount);
  const plan = buildAdaptiveTransferStudyPlan(config);
  return { ...config, approvedPlanSha256: plan.sha256 };
}

function strictPacket(contract, payload, tag, tokenOffset, authority) {
  const rawResultText = JSON.stringify(payload);
  const finalOutput = `<${tag}>${rawResultText}</${tag}>`;
  const inputTokens = 180 + tokenOffset;
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
  const workspaceRoot = `/tmp/study-${sha256(
    `${payload.findingId}:${tag}:${tokenOffset}`
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
      executableBasename: authority.binary.basename,
      executableSha256: authority.binary.sha256,
      executableBytes: authority.binary.bytes,
      authMode: 'chatgpt-oauth',
      oauthAuthoritySha256: authority.authoritySha256,
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

function studyWorker(config, {
  noHeadroomCandidates = [],
  failedConfirmationCandidates = [],
  unstableQualificationCandidates = []
} = {}) {
  let calls = 0;
  const children = config.candidates.flatMap((candidate) => [
    candidate.qualification,
    candidate.confirmation
  ]);
  return (contract) => {
    calls++;
    const child = children.find((item) => (
      item.target.findingId === contract.target.findingId
      && (contract.kind === 'proposal'
        || item.benchmark.evaluationShards.some((shard) => (
          shard.cases.some((row) => row.id === contract.frozenCases[0]?.id)
        )))
    ));
    assert.ok(child, `missing child config for ${contract.target.findingId}`);
    const candidate = config.candidates.find((item) => (
      item.confirmation.target.findingId === contract.target.findingId
    ));
    assert.ok(candidate);
    if (contract.kind === 'proposal') {
      const semantics = contract.mechanismCapsule?.items?.[0]?.semantics || 'none';
      const marker = semantics === 'positive-transfer'
        ? 'STUDY_ROUTED_ORDERED_GATES'
        : (semantics === 'irrelevant-control'
            ? 'STUDY_SHAM_FORMAT_ONLY'
            : 'STUDY_BASELINE_NO_MEMORY');
      const revisedContent = [
        contract.target.baselineContent,
        '',
        '## Study Proposal',
        marker,
        contract.hypothesis.bottleneck,
        ...contract.requirements,
        `Use ${contract.evidenceCapsule[0]?.path}.`,
        `Ground in ${contract.frozenCases[0]?.id} at ${contract.frozenCases[0]?.evidenceRef?.locator}.`
      ].join('\n');
      return strictPacket(contract, {
        findingId: contract.target.findingId,
        hypothesisId: contract.hypothesis.id,
        baselineSha256: contract.target.baselineSha256,
        revisedContent,
        changeSummary: `Apply ${marker} while preserving controls.`
      }, 'IMPROVEMENT', calls, config.runtimeAuthority);
    }
    const shard = child.benchmark.evaluationShards.find((item) => (
      item.cases.some((row) => row.id === contract.frozenCases[0]?.id)
    ));
    assert.ok(shard);
    const qualification = shard.id.includes('-qual-');
    const routed = contract.procedureContent.includes(
      'STUDY_ROUTED_ORDERED_GATES'
    );
    const baseline = contract.procedureContent.includes(
      'STUDY_BASELINE_NO_MEMORY'
    );
    const baselineSolves = qualification
      && noHeadroomCandidates.includes(candidate.id);
    const routedSolves = routed
      && !(failedConfirmationCandidates.includes(candidate.id)
        && !qualification);
    const unstable = qualification
      && baseline
      && unstableQualificationCandidates.includes(candidate.id);
    const rows = shard.oracle.cases.map((item) => {
      const solvesTarget = routedSolves || (baseline && baselineSolves);
      if (item.group === 'target') {
        return {
          caseId: item.caseId,
          disposition: solvesTarget ? 'REJECTED' : 'ACCEPTED',
          code: solvesTarget ? item.code : `WRONG_${item.code}`,
          evidencePaths: item.requiredEvidencePaths
        };
      }
      if (unstable && item.accepted) {
        return {
          caseId: item.caseId,
          disposition: 'REJECTED',
          code: `WRONG_${item.code}`,
          evidencePaths: item.requiredEvidencePaths
        };
      }
      return {
        caseId: item.caseId,
        disposition: item.accepted ? 'ACCEPTED' : 'REJECTED',
        code: item.code,
        evidencePaths: item.requiredEvidencePaths
      };
    });
    return strictPacket(contract, {
      arm: contract.evaluationArm,
      findingId: contract.target.findingId,
      hypothesisId: contract.hypothesis.id,
      baselineSha256: contract.target.baselineSha256,
      procedureSha256: contract.procedureSha256,
      caseResults: rows
    }, 'EVALUATION', calls, config.runtimeAuthority);
  };
}

test('study plan freezes first-five selection, exact endpoints, and maximum exposure', () => {
  const config = approvedStudyConfig(6);
  const validation = validateAdaptiveTransferStudyConfig(config);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const plan = validation.plan;
  assert.equal(plan.contract.candidateCount, 6);
  assert.equal(plan.contract.requiredQualifiedTasks, 5);
  assert.equal(plan.contract.qualificationCallsPerCandidate, 6);
  assert.equal(plan.contract.confirmationCallsPerTask, 18);
  assert.equal(plan.contract.maximumCalls, 126);
  assert.equal(plan.contract.endpoint.requiredTaskWins, 5);
  assert.equal(plan.contract.endpoint.exactSignTestP, 0.03125);
  assert.equal(plan.contract.endpoint.maxMeanTokenOverheadPct, 25);
  const disclosure = adaptiveTransferStudyLaunchDisclosure(config, {
    configPath: '/tmp/study.json',
    home: '/tmp/study-home',
    runId: 'study-plan'
  });
  assert.equal(disclosure.calls.totalMaximum, 126);
  assert.equal(disclosure.exposure.timeoutCeilingMinutes, 1260);
  assert.equal(disclosure.exposure.hardTokenLimit, null);
  assert.equal(disclosure.exposure.hardUsdLimit, null);
  assert.equal(disclosure.execution.model, REAL_TEST_MODEL);
  assert.equal(disclosure.execution.reasoningEffort, 'high');
  assert.match(disclosure.launchCommand, /verify:transfer-study/);
});

test('study selects the first five qualified tasks and proves five fresh confirmations', () => {
  const config = approvedStudyConfig(6);
  const { store } = freshEngine();
  const orderedCandidates = adaptiveTransferStudyCandidateOrder(config);
  const firstCandidate = orderedCandidates[0].id;
  const worker = studyWorker(config, {
    noHeadroomCandidates: [firstCandidate]
  });
  const result = runAdaptiveTransferStudy(store, config, {
    runId: 'adaptive-transfer-study-pass',
    worker
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.activationEligible, false);
  assert.equal(result.outcome.status, 'PASS', JSON.stringify(result.outcome, null, 2));
  assert.equal(result.outcome.taskWins, 5);
  assert.equal(result.outcome.shamWins, 0);
  assert.equal(result.outcome.controlRegressions, 0);
  assert.equal(result.outcome.exactSignTestP, 0.03125);
  assert.ok(result.outcome.meanTokenOverheadPct <= 25);
  const state = store.load('adaptive-transfer-study-pass');
  assert.equal(state.qualifications.length, 6);
  assert.deepEqual(
    state.selectedCandidateIds,
    orderedCandidates.slice(1).map((item) => item.id)
  );
  assert.equal(state.confirmations.length, 5);
  const verified = verifyAdaptiveTransferStudyRun(
    store,
    'adaptive-transfer-study-pass'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.ok(Object.values(verified.gates).every(Boolean));
  assert.equal(verified.outcome.status, 'PASS');
  assert.equal(verified.selection.qualificationRuns, 6);
  assert.equal(verified.selection.confirmationRuns, 5);
});

test('study returns valid NO_HEADROOM without opening any confirmation arm', () => {
  const config = approvedStudyConfig(5);
  const { store } = freshEngine();
  const result = runAdaptiveTransferStudy(store, config, {
    runId: 'adaptive-transfer-study-no-headroom',
    worker: studyWorker(config, {
      noHeadroomCandidates: config.candidates.map((item) => item.id)
    })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.outcome.status, 'NO_HEADROOM');
  const state = store.load('adaptive-transfer-study-no-headroom');
  assert.equal(state.qualifications.length, 1);
  assert.equal(state.selectedCandidateIds.length, 0);
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.qualificationStop.reason, 'qualification-impossible');
  assert.equal(state.qualificationStop.remainingCandidates, 4);
  assert.equal(result.verification.selection.confirmationRuns, 0);
});

test('study stops when the remaining pool cannot reach five qualified tasks', () => {
  const config = approvedStudyConfig(8);
  const { store } = freshEngine();
  const ordered = adaptiveTransferStudyCandidateOrder(config);
  const result = runAdaptiveTransferStudy(store, config, {
    runId: 'adaptive-transfer-study-impossible',
    worker: studyWorker(config, {
      noHeadroomCandidates: ordered.slice(0, 4).map((item) => item.id)
    })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.outcome.status, 'NO_HEADROOM');
  const state = store.load('adaptive-transfer-study-impossible');
  assert.equal(state.qualifications.length, 4);
  assert.equal(state.selectedCandidateIds.length, 0);
  assert.deepEqual(state.qualificationStop, {
    rule: ADAPTIVE_TRANSFER_STUDY_QUALIFICATION_STOP_RULE,
    reason: 'qualification-impossible',
    afterCandidateId: ordered[3].id,
    qualificationRuns: 4,
    qualifiedTasks: 0,
    remainingCandidates: 4
  });
  assert.equal(result.verification.gates.qualificationStopIntegrity, true);
});

test('historical study configs without the stop rule remain verification-compatible', () => {
  const config = studyConfig(5);
  delete config.qualificationStopRule;
  config.approvedPlanSha256 = buildAdaptiveTransferStudyPlan(config).sha256;
  const current = validateAdaptiveTransferStudyConfig(config);
  assert.equal(current.ok, false);
  assert.ok(current.errors.some((error) => /qualificationStopRule/.test(error)));
  const historical = validateAdaptiveTransferStudyConfig(config, {
    allowHistoricalQualificationStopRule: true
  });
  assert.equal(historical.ok, true, historical.errors.join('\n'));
  assert.equal(
    Object.hasOwn(historical.plan, 'qualificationStopRule'),
    false
  );
});

test('study excludes an unstable no-memory control from deterministic selection', () => {
  const config = approvedStudyConfig(6);
  const { store } = freshEngine();
  const orderedCandidates = adaptiveTransferStudyCandidateOrder(config);
  const unstableCandidate = orderedCandidates[0].id;
  const result = runAdaptiveTransferStudy(store, config, {
    runId: 'adaptive-transfer-study-unstable-control',
    worker: studyWorker(config, {
      unstableQualificationCandidates: [unstableCandidate]
    })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.outcome.status, 'PASS');
  const state = store.load('adaptive-transfer-study-unstable-control');
  assert.equal(state.qualifications[0].outcome, 'UNSTABLE_CONTROL');
  assert.equal(state.qualifications[0].eligible, false);
  assert.ok(!state.selectedCandidateIds.includes(unstableCandidate));
  assert.deepEqual(
    state.selectedCandidateIds,
    orderedCandidates.slice(1).map((item) => item.id)
  );
});

test('study preserves a valid negative treatment instead of weakening the endpoint', () => {
  const config = approvedStudyConfig(5);
  const { store } = freshEngine();
  const failedCandidate = config.candidates[4].id;
  const result = runAdaptiveTransferStudy(store, config, {
    runId: 'adaptive-transfer-study-negative',
    worker: studyWorker(config, {
      failedConfirmationCandidates: [failedCandidate]
    })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.activationEligible, false);
  assert.equal(result.outcome.status, 'FAIL');
  assert.equal(result.outcome.taskWins, 4);
  assert.equal(result.outcome.exactSignTestP, 0.1875);
});

test('study rejects reused confirmatory evidence before execution', () => {
  const config = studyConfig(5);
  const candidate = config.candidates[0];
  candidate.confirmation.heldOutEvidenceSources = [
    ...candidate.qualification.heldOutEvidenceSources
  ];
  candidate.confirmation.heldOutEvidenceManifest = structuredClone(
    candidate.qualification.heldOutEvidenceManifest
  );
  candidate.confirmation.heldOutEvidenceCapsule = structuredClone(
    candidate.qualification.heldOutEvidenceCapsule
  );
  const plan = buildAdaptiveTransferStudyPlan(config);
  config.approvedPlanSha256 = plan.sha256;
  const validation = validateAdaptiveTransferStudyConfig(config);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => (
    /qualification and confirmation evidence must be disjoint/.test(error)
  )));
});

test('study rejects cross-task development and held-out path reuse', () => {
  const config = studyConfig(5);
  const candidate = config.candidates[0];
  const foreignHeldOutPath =
    config.candidates[1].confirmation.heldOutEvidenceManifest[0].path;
  for (const child of [candidate.qualification, candidate.confirmation]) {
    const oldPath = child.evidenceManifest[0].path;
    child.evidenceSources = [foreignHeldOutPath];
    child.evidenceManifest[0].path = foreignHeldOutPath;
    child.evidenceCapsule[0].path = foreignHeldOutPath;
    child.target.evidenceRefs[0].path = foreignHeldOutPath;
    for (const item of child.benchmark.developmentCases) {
      if (item.evidenceRef.path === oldPath) {
        item.evidenceRef.path = foreignHeldOutPath;
      }
    }
  }
  refreshCandidateSource(candidate);
  config.approvedPlanSha256 = buildAdaptiveTransferStudyPlan(config).sha256;
  const validation = validateAdaptiveTransferStudyConfig(config);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => (
    /development and held-out partitions must be globally disjoint/.test(error)
  )));
});

test('study rejects a foreign hidden identity copied into development evidence', () => {
  const config = studyConfig(5);
  const candidate = config.candidates[0];
  const foreignCaseId = config.candidates[1]
    .confirmation.benchmark.evaluationShards[0].cases[0].id;
  for (const child of [candidate.qualification, candidate.confirmation]) {
    const content = `${child.evidenceCapsule[0].content}\n${foreignCaseId}`;
    const digest = sha256(Buffer.from(content));
    const bytes = Buffer.byteLength(content);
    child.evidenceCapsule[0] = {
      ...child.evidenceCapsule[0],
      content,
      sha256: digest,
      bytes
    };
    child.evidenceManifest[0] = {
      ...child.evidenceManifest[0],
      sha256: digest,
      bytes
    };
  }
  refreshCandidateSource(candidate);
  config.approvedPlanSha256 = buildAdaptiveTransferStudyPlan(config).sha256;
  const validation = validateAdaptiveTransferStudyConfig(config);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => (
    /contains another candidate's partition identity/.test(error)
  )));
});

test('study rejects a child config source whose persisted bytes miss its hash', () => {
  const config = studyConfig(5);
  config.candidates[0].source.qualificationConfigContent += '\n';
  config.approvedPlanSha256 = buildAdaptiveTransferStudyPlan(config).sha256;
  const validation = validateAdaptiveTransferStudyConfig(config);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => (
    /qualificationConfigContent must rederive qualificationConfigSha256/.test(error)
  )));
});

test('parent verification fails when a persisted child prompt is changed', () => {
  const config = approvedStudyConfig(5);
  const { store } = freshEngine();
  const result = runAdaptiveTransferStudy(store, config, {
    runId: 'adaptive-transfer-study-tamper',
    worker: studyWorker(config)
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('adaptive-transfer-study-tamper');
  const childState = store.load(state.confirmations[0].runId);
  const proposal = childState.proposals[0];
  const artifact = store.readArtifact(
    state.confirmations[0].runId,
    proposal.promptArtifactRef
  );
  store.writeArtifact(
    state.confirmations[0].runId,
    proposal.promptArtifactRef,
    { ...artifact, content: `${artifact.content}\nTAMPERED` }
  );
  const verified = verifyAdaptiveTransferStudyRun(
    store,
    'adaptive-transfer-study-tamper'
  );
  assert.equal(verified.experimentValid, false);
  assert.equal(verified.gates.childIntegrity, false);
  assert.equal(verified.gates.confirmationBindings, false);
});
