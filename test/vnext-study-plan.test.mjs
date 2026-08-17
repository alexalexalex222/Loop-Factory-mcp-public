import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import { captureExecutableEvaluatorAuthority } from '../src/adaptive-executable-canary.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import { createStore, STORE_DURABILITY } from '../src/store.mjs';
import { sha256 } from '../src/util.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import {
  buildVNextTaskPack,
  loadVNextTaskPackMaterials
} from '../src/vnext-task-pack.mjs';
import {
  createVNextStudyWave,
  persistVNextStudyWave,
  verifyVNextStudyPlanFromDisk
} from '../src/vnext-study-plan.mjs';
import {
  runVNextCampaignSeriesTick,
  verifyVNextCampaignSeries
} from '../src/vnext-campaign-driver.mjs';
import {
  consumeVNextCampaignLaunchAuthorization,
  persistVNextCampaignLaunchAuthorization
} from '../src/vnext-campaign-launch-authorization.mjs';
import {
  createVNextMatchedPhasePlan,
  persistVNextMatchedPhasePlan,
  verifyVNextMatchedPhasePlanFromDisk
} from '../src/vnext-matched-phase.mjs';
import { resolveVNextWaveImplementation } from '../src/vnext-wave-runner.mjs';

const executableEvaluatorTest = process.platform === 'darwin' ? test : test.skip;

function createPowerLossStore(home) {
  if (process.platform !== 'win32') {
    return createStore(home, { durability: STORE_DURABILITY.POWER_LOSS });
  }
  assert.throws(
    () => createStore(home, { durability: STORE_DURABILITY.POWER_LOSS }),
    { code: 'DURABLE_PLATFORM_UNSUPPORTED' }
  );
  return null;
}

const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'],
  selectors: [], bindings: [], forbiddenBindings: [],
  metrics: [{
    metricId: 'quality-delta', operator: 'subtract',
    leftRole: 'candidate.quality', rightRole: 'baseline.quality'
  }],
  rules: [{
    ruleId: 'accept-quality', kind: 'decision', exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

function runtimeAuthority() {
  return createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('study-plan-codex'),
    versionOutput: 'codex-cli 1.0.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high', service_tiers: []
    }] }),
    requestedModel: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  }).record;
}

function parentFamily() {
  return createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback',
      interventionKind: 'bounded-exact-rule',
      operationKind: 'mechanism-program-mutation',
      expectedEffectKind: 'more-exact-target-cases',
      preconditions: ['frozen-task-pack'],
      procedureSteps: ['observe', 'mutate', 'verify'],
      program: PROGRAM,
      applicability: {
        taskModes: ['improve'], loopRoles: ['supervisor'],
        taskValueDimensions: ['exactness'], resourceDimensions: ['token-cost']
      }
    }
  }).record;
}

function taskFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-study-tasks-'));
  mkdirSync(join(root, 'tasks'));
  const evaluator = captureExecutableEvaluatorAuthority();
  assert.equal(evaluator.status, 'OK', evaluator.errors?.join('; '));
  const tasks = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const key = `study${number}`;
    const interfaceContract = {
      schemaVersion: 'executable-interface-contract-v2',
      exportName: 'decide',
      inputPaths: [`${key}.baselineQuality`, `${key}.candidateQuality`],
      decisions: ['ACCEPT', 'REJECT'],
      codes: [
        { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
        { value: 'NO_GAIN', meaning: 'Quality did not increase.' }
      ],
      roleBindings: [
        { role: 'baseline.quality', path: `${key}.baselineQuality` },
        { role: 'candidate.quality', path: `${key}.candidateQuality` }
      ]
    };
    const row = (id, group, baselineQuality, candidateQuality, decision, code) => ({
      id, group, input: { [key]: { baselineQuality, candidateQuality } },
      expected: { decision, code }
    });
    const caseSet = {
      schemaVersion: 'executable-case-set-v1', exportName: 'decide',
      cases: [
        row(`target-${number}-1`, 'target', 1, 2, 'ACCEPT', 'QUALITY_GAIN'),
        row(`target-${number}-2`, 'target', 2, 3, 'ACCEPT', 'QUALITY_GAIN'),
        row(`target-${number}-3`, 'target', 3, 4, 'ACCEPT', 'QUALITY_GAIN'),
        row(`control-${number}-1`, 'control', 4, 2, 'REJECT', 'NO_GAIN'),
        row(`control-${number}-2`, 'control', 5, 1, 'REJECT', 'NO_GAIN')
      ]
    };
    const contents = {
      source: `export function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; } // ${number}\n`,
      incident: `Verified target failures for task ${number}.\n`,
      interface: `${JSON.stringify(interfaceContract)}\n`,
      oracle: `${JSON.stringify(caseSet)}\n`
    };
    const paths = {
      source: `tasks/source-${number}.mjs`,
      incident: `tasks/incident-${number}.md`,
      interface: `tasks/interface-${number}.json`,
      oracle: `tasks/oracle-${number}.json`
    };
    for (const name of Object.keys(contents)) {
      writeFileSync(join(root, paths[name]), contents[name]);
    }
    const phase = number <= 5 ? 'qualification' : 'confirmation';
    return {
      taskId: `study-${String(number).padStart(2, '0')}-${phase}`,
      clusterId: `cluster-${number}`,
      domain: `domain-${number}`,
      tags: [phase],
      source: { id: `source-${number}`, path: paths.source, sha256: sha256(contents.source) },
      incident: { id: `incident-${number}`, path: paths.incident, sha256: sha256(contents.incident) },
      interface: { id: `interface-${number}`, path: paths.interface, sha256: sha256(contents.interface) },
      oracle: { id: `oracle-${number}`, path: paths.oracle, sha256: sha256(contents.oracle) },
      interfaceContractSha256: sha256(canonicalVNextJson(interfaceContract)),
      publicTaskSpecSha256: sha256(`public-task-${number}`)
    };
  });
  const pack = buildVNextTaskPack({
    artifactRoot: root,
    packId: 'study-pack',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'study-builder', kind: 'deterministic-tool' },
    evaluatorAuthorityRecord: evaluator.record,
    tasks
  });
  assert.equal(pack.status, 'OK', pack.code);
  const materials = loadVNextTaskPackMaterials({
    artifactRoot: root,
    pack: pack.pack
  });
  assert.equal(materials.status, 'OK', materials.code);
  return { taskPack: pack.pack, taskMaterialBundle: materials.bundle, evaluator: evaluator.record };
}

function input(armId = 'B0') {
  const tasks = taskFixture();
  return {
    packageRoot: fileURLToPath(new URL('..', import.meta.url)),
    seriesRunId: `study-${armId.toLowerCase()}-run`,
    waveId: `study-${armId.toLowerCase()}-wave`,
    armId,
    createdAt: '2026-08-05T01:00:00.000Z',
    ...tasks,
    parentFamily: parentFamily(),
    mutationObjective: {
      measurementId: `measurement-${'b'.repeat(24)}`,
      measurementSha256: 'c'.repeat(64),
      failureCaseSetSha256: 'd'.repeat(64),
      successCaseSetSha256: 'e'.repeat(64),
      targetMetric: 'exact-case-rate', direction: 'increase'
    },
    runtimeAuthority: runtimeAuthority(),
    evaluatorAuthority: tasks.evaluator,
    evidenceRecords: [],
    studyBinding: {
      protocolSha256: 'f'.repeat(64),
      phaseId: 'P0-component-construction',
      memoryLedgerSha256: null
    }
  };
}

function protocolFor(inputValue) {
  const implementation = resolveVNextWaveImplementation({
    packageRoot: inputValue.packageRoot
  });
  assert.equal(implementation.status, 'OK');
  const identityDigests = Array.from({ length: 100 }, (_, index) => (
    sha256(`study-identity-${index}`)
  )).sort();
  const identityCore = {
    schemaVersion: 'vnext-internal-identity-digest-ledger-v1',
    algorithm: 'sha256',
    identityCount: identityDigests.length,
    identityDigests
  };
  const phase = (phaseId, packRole, arms, maximumCalls, packSha256) => {
    const policies = {
      'P0-component-construction': [
        'candidate-generation-and-four-arm-evaluation',
        'none',
        'all-planned-arms-experiment-valid'
      ],
      'P1-retrieval-attribution': [
        'candidate-generation-and-four-arm-evaluation',
        'verifier-bank-snapshot-after-P0',
        'B3-and-B4-experiment-valid'
      ],
      'P2-generator-comparison': [
        'candidate-generation-and-four-arm-evaluation',
        'verifier-bank-snapshot-after-P1',
        'at-least-one-generator-ready-and-experiment-valid'
      ],
      'P3-untouched-validation': [
        'one-selected-B6-candidate-generation-and-four-arm-evaluation',
        'verifier-bank-snapshot-after-P2',
        'selected-B6-causal-pass-with-zero-sham-and-control-regressions'
      ],
      'P4-disjoint-transfer': [
        'frozen-candidate-four-arm-evaluation',
        'no-retrieval-or-regeneration',
        'exact-validation-candidate-causal-pass-on-transfer'
      ]
    };
    const [mode, memoryPolicy, continuationGate] = policies[phaseId];
    return {
      phaseId, packRole, mode, arms, memoryPolicy,
      plansShareMemorySnapshot: true,
      continuationGate,
      packSha256,
      taskIdentitySetSha256: inputValue.taskPack.taskIdentitySetSha256,
      maximumCalls,
      promotionEnabled: false
    };
  };
  const packDescriptor = (role, packSha256) => ({
    role,
    directory: '/tmp/matched-phase-fixture',
    packId: `pack-${role}`,
    partition: role === 'validation' ? 'validation' : 'development',
    packSha256,
    taskIdentitySetSha256: inputValue.taskPack.taskIdentitySetSha256,
    materialBundleSha256: inputValue.taskMaterialBundle.bundleSha256,
    importReceiptSha256: sha256(`receipt-${role}`),
    sourceConfigSha256: sha256(`config-${role}`),
    taskCount: 10,
    referenceContentImported: false
  });
  const roleHashes = Object.fromEntries([
    'generation', 'retrieval', 'generator', 'validation', 'transfer'
  ].map((role) => [role, role === 'generation'
    ? inputValue.taskPack.packSha256
    : sha256(`pack-${role}`)]));
  const core = {
    schemaVersion: 'loop-factory-vnext-ablation-protocol-v2',
    protocolId: 'matched-phase-protocol',
    createdAt: inputValue.createdAt,
    parentFamilyId: inputValue.parentFamily.familyId,
    parentFamilySha256: inputValue.parentFamily.familySha256,
    modelPolicy: {
      model: 'gpt-5.6-sol', reasoningEffort: 'high', authMode: 'chatgpt-oauth'
    },
    evaluatorProof: {
      schemaVersion: 'loop-factory-vnext-evaluator-proof-binding-v1',
      proofHome: '/tmp/matched-evaluator-proof',
      proofId: 'matched-evaluator-proof',
      planSha256: sha256('matched-evaluator-plan'),
      resultSha256: sha256('matched-evaluator-result'),
      evidenceSha256: sha256('matched-evaluator-evidence'),
      implementationSha256: sha256('matched-evaluator-implementation'),
      productionEvidence: true,
      activationAuthority: false
    },
    consumedEvaluatorProofs: [],
    implementationSha256: implementation.implementationSha256,
    packs: Object.entries(roleHashes).map(([role, digest]) => (
      packDescriptor(role, digest)
    )),
    identityLedger: {
      ...identityCore,
      ledgerSha256: sha256(canonicalVNextJson(identityCore))
    },
    phases: [
      phase('P0-component-construction', 'generation', ['B0', 'B2', 'B3'], 371, roleHashes.generation),
      phase('P1-retrieval-attribution', 'retrieval', ['B3', 'B4'], 253, roleHashes.retrieval),
      phase('P2-generator-comparison', 'generator', ['B5a', 'B5b', 'B5c'], 381, roleHashes.generator),
      phase('P3-untouched-validation', 'validation', ['B6'], 127, roleHashes.validation),
      phase('P4-disjoint-transfer', 'transfer', ['B6-frozen'], 120, roleHashes.transfer)
    ],
    selectionRule: {
      developmentAuthority: 'selection-only-no-generalized-claim',
      eligibleGeneratorArms: ['B5a', 'B5b', 'B5c'],
      requiredBeforeSelection: [
        'experimentValid', 'causalPass', 'zero-control-regressions',
        'zero-sham-movement', 'trusted-token-usage'
      ],
      order: [
        'highest-confirmation-adjusted-mean',
        'lowest-total-token-usage',
        'lexicographically-smallest-arm-id'
      ],
      abstainWhenNoEligibleArm: true,
      selectedCandidateCount: 1
    },
    inferencePolicy: {
      developmentResultsAreNotFinalClaims: true,
      finalValidationCandidateCount: 1,
      validationAlpha: 0.05,
      transferRequiresExactFrozenCandidate: true,
      transferMayRegenerateCandidate: false,
      generalizedClaimRequiresValidationAndTransfer: true,
      finalCustodianConfirmationStillRequired: true,
      taskClusterIsStatisticalUnit: true,
      noRepeatedFinalOpening: true
    },
    exposure: {
      liveEvaluatorCalls: 1, internalMaximumCalls: 1253,
      externalCustodianMaximumCalls: 120, retriesPerCall: 0,
      hardUsdCeiling: 0, billingMode: 'subscription-no-metered-usd',
      stagedApprovalRequired: true
    },
    authority: {
      implementationAgentMayAccessInternalPacks: true,
      implementationAgentMayAccessFinalCustodianPack: false,
      activationAuthority: false, promotionAuthorized: false
    }
  };
  return { ...core, protocolSha256: sha256(canonicalVNextJson(core)) };
}

executableEvaluatorTest('a B0 study plan persists one approval-locked 122-call wave without inference', async () => {
  const built = createVNextStudyWave(input('B0'));
  assert.equal(built.status, 'OK', built.message);
  assert.equal(built.build.preparationBudget.maxCalls, 2);
  assert.equal(built.build.rootBudget.maxCalls, 122);
  const store = createStore(mkdtempSync(join(tmpdir(), 'vnext-study-home-')));
  const persisted = persistVNextStudyWave({ store, build: built.build });
  assert.equal(persisted.status, 'OK', persisted.message);
  assert.equal(persisted.disclosure.approval.paidModelCallsAtPlanning, 0);
  assert.equal(persisted.disclosure.exposure.maximumCalls, 122);
  assert.equal(verifyVNextStudyPlanFromDisk({
    store,
    seriesRunId: built.build.seriesRunId,
    waveId: built.build.waveId
  }).status, 'OK');
  assert.equal(verifyVNextCampaignSeries({
    store,
    seriesRunId: built.build.seriesRunId
  }).seriesValid, true);
  assert.equal(verifyVNextStudyPlanFromDisk({
    store,
    seriesRunId: built.build.seriesRunId,
    waveId: built.build.waveId,
    approvedPlanSha256: '0'.repeat(64),
    requireApproval: true
  }).code, 'VNEXT_STUDY_APPROVAL_MISMATCH');
  const blocked = await runVNextCampaignSeriesTick({
    store,
    seriesRunId: built.build.seriesRunId
  });
  assert.equal(blocked.code, 'VNEXT_CAMPAIGN_PROTOCOL_REQUIRED');
});

executableEvaluatorTest('the final authorization boundary consumes only the exact replayed study disclosure', () => {
  const built = createVNextStudyWave(input('B0'));
  assert.equal(built.status, 'OK', built.message);
  const store = createPowerLossStore(
    mkdtempSync(join(tmpdir(), 'vnext-study-authorization-'))
  );
  if (!store) return;
  const persisted = persistVNextStudyWave({ store, build: built.build });
  assert.equal(persisted.status, 'OK', persisted.message);
  const replay = verifyVNextStudyPlanFromDisk({
    store,
    seriesRunId: built.build.seriesRunId,
    waveId: built.build.waveId,
    approvedPlanSha256: persisted.disclosure.disclosureSha256,
    requireApproval: true
  });
  assert.equal(replay.status, 'OK', replay.message);
  const authorization = persistVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: built.build.seriesRunId,
    waveId: built.build.waveId,
    approvedPlanSha256: persisted.disclosure.disclosureSha256,
    protocolSha256: persisted.disclosure.studyBinding.protocolSha256,
    createdAt: '2026-08-05T01:00:01.000Z'
  });
  assert.equal(authorization.status, 'OK', authorization.message);
  const consumed = consumeVNextCampaignLaunchAuthorization({
    store,
    seriesRunId: built.build.seriesRunId,
    descriptor: replay.planned.series.state.queue[0],
    state: replay.planned.series.state,
    authorizationSha256: authorization.authorization.authorizationSha256,
    protocolSha256: persisted.disclosure.studyBinding.protocolSha256
  });
  assert.equal(consumed.status, 'OK', consumed.message);
  assert.equal(consumed.authorization.approvedPlanSha256,
    persisted.disclosure.disclosureSha256);
});

executableEvaluatorTest('B2 and B3 expose their exact stage-dependent call counts', () => {
  const b2 = createVNextStudyWave(input('B2'));
  const b3 = createVNextStudyWave(input('B3'));
  assert.equal(b2.status, 'OK', b2.message);
  assert.equal(b3.status, 'OK', b3.message);
  assert.equal(b2.build.preparationBudget.maxCalls, 3);
  assert.equal(b2.build.rootBudget.maxCalls, 123);
  assert.equal(b3.build.preparationBudget.maxCalls, 6);
  assert.equal(b3.build.rootBudget.maxCalls, 126);
});

executableEvaluatorTest('B4 cannot masquerade as hybrid retrieval with an empty verifier-owned bank', () => {
  const built = createVNextStudyWave(input('B4'));
  assert.equal(built.status, 'REFUSED');
  assert.equal(built.code, 'VNEXT_STUDY_EVIDENCE_INSUFFICIENT');
});

executableEvaluatorTest('P0 arms freeze as one matched phase before any child worker launches', () => {
  const base = input('B0');
  const protocol = protocolFor(base);
  const store = createStore(mkdtempSync(join(tmpdir(), 'vnext-matched-phase-home-')));
  const children = [];
  for (const armId of ['B0', 'B2', 'B3']) {
    const built = createVNextStudyWave({
      ...base,
      armId,
      seriesRunId: `matched-${armId.toLowerCase()}-run`,
      waveId: `matched-${armId.toLowerCase()}-wave`,
      studyBinding: {
        protocolSha256: protocol.protocolSha256,
        phaseId: 'P0-component-construction',
        memoryLedgerSha256: null
      }
    });
    assert.equal(built.status, 'OK', built.message);
    const persisted = persistVNextStudyWave({ store, build: built.build });
    assert.equal(persisted.status, 'OK', persisted.message);
    children.push({
      seriesRunId: built.build.seriesRunId,
      waveId: built.build.waveId
    });
  }
  const matched = createVNextMatchedPhasePlan({
    store,
    protocol,
    phaseId: 'P0-component-construction',
    children,
    packageRoot: base.packageRoot
  });
  assert.equal(matched.status, 'OK', JSON.stringify(matched));
  assert.equal(matched.plan.exposure.maximumCalls, 371);
  assert.equal(matched.plan.authority.paidModelCallsAtFreeze, 0);
  assert.equal(matched.plan.children.every((row) => row.pristineAtFreeze), true);
  assert.equal(persistVNextMatchedPhasePlan({ store, plan: matched.plan }).status, 'OK');
  const replay = verifyVNextMatchedPhasePlanFromDisk({
    store,
    protocolSha256: protocol.protocolSha256,
    phaseId: 'P0-component-construction'
  });
  assert.equal(replay.status, 'OK', replay.message);
  assert.equal(replay.readyToLaunch, true);
  assert.equal(replay.children.length, 3);
});
