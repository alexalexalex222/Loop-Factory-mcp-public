import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_EXECUTABLE_CANARY,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4,
  ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION,
  EXECUTABLE_CASE_SET_SCHEMA_VERSION,
  EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION,
  EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2,
  adaptiveExecutableCanaryLaunchDisclosure,
  buildAdaptiveExecutableCanaryPlan,
  buildAdaptiveExecutableCanaryPrompt,
  captureExecutableEvaluatorAuthority,
  computeExecutableCanaryPreflight,
  createExecutableShamCapsule,
  evaluateAdaptiveExecutableCanaryOutcome,
  evaluateExecutableCandidate,
  executablePermissionFlag,
  resolveAdaptiveExecutableCanaryImplementation,
  runAdaptiveExecutableCanary,
  validateAdaptiveExecutableCanaryConfig,
  validateExecutableEvaluatorAuthority,
  validateExecutableEvaluatorAuthorityRecord,
  validateExecutableInterfaceCoverage,
  verifyAdaptiveExecutableCanaryRun
} from '../src/adaptive-executable-canary.mjs';
import {
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord
} from '../src/adaptive-records.mjs';
import {
  DEFAULT_ADAPTIVE_POLICY,
  createBaselinePolicyEpoch
} from '../src/adaptive-policy.mjs';
import {
  listAdaptiveRecords,
  loadMechanismCatalog
} from '../src/mechanism-catalog.mjs';
import {
  adaptiveCanaryRunSucceeded,
  completeAdaptiveCanaryMemoryImport
} from '../src/adaptive-canary-auto-import.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from '../src/executor.mjs';
import { buildMechanismRoutingDecision } from '../src/mechanism-router.mjs';
import { REAL_TEST_MODEL } from '../src/real-test.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import { sha256 } from '../src/util.mjs';
import {
  BASELINE_BODY,
  freshEngine,
  recordMeasurement
} from './helpers.mjs';

const isDarwin = process.platform === 'darwin';
const FIXTURE_CODEX_PATH = '/opt/codex/codex.real';
const FIXTURE_CODEX_BYTES = Buffer.from('executable-canary-fixture-binary');
const FIXTURE_CODEX_CATALOG = JSON.stringify({
  models: [{
    slug: REAL_TEST_MODEL,
    display_name: 'GPT-5.6 Sol',
    visibility: 'list',
    supported_in_api: true,
    supported_reasoning_levels: [{
      effort: 'high',
      description: 'Fixture high reasoning'
    }],
    default_reasoning_level: 'high',
    service_tiers: []
  }]
});
const ROUTING_TARGET = {
  taskMode: 'improve',
  loopRole: 'supervisor',
  taskValueDimensions: ['release-admission-accuracy'],
  resourceDimensions: ['token-cost']
};

function admissionMechanismProgram() {
  const equals = (role, value) => ({
    operator: 'equal',
    left: { kind: 'role', id: role },
    right: { kind: 'literal', value }
  });
  return {
    schemaVersion: 'mechanism-program-v1',
    bindingPolicy: 'closed-world',
    roles: [
      'input.authority',
      'input.bound',
      'input.control',
      'input.reverified',
      'input.review'
    ],
    selectors: [],
    bindings: [],
    forbiddenBindings: [{
      leftRole: 'input.authority',
      rightRole: 'input.review',
      reasonCode: 'AUTHORITY_IS_NOT_REVIEW'
    }],
    metrics: [],
    rules: [{
      ruleId: 'preserve-control-allow',
      kind: 'exception',
      exceptionOf: 'reject-non-tool-authority',
      when: equals('input.control', 'allow'),
      emit: { decision: 'ACCEPT', code: 'CONTROL_ALLOW' }
    }, {
      ruleId: 'preserve-control-deny',
      kind: 'guard',
      exceptionOf: null,
      when: equals('input.control', 'deny'),
      emit: { decision: 'REJECT', code: 'CONTROL_DENY' }
    }, {
      ruleId: 'reject-explicit-denial',
      kind: 'guard',
      exceptionOf: null,
      when: equals('input.review', 'DENIED'),
      emit: { decision: 'REJECT', code: 'REVIEW_DENIED' }
    }, {
      ruleId: 'reject-non-tool-authority',
      kind: 'decision',
      exceptionOf: null,
      when: {
        operator: 'not-equal',
        left: { kind: 'role', id: 'input.authority' },
        right: { kind: 'literal', value: 'tool' }
      },
      emit: { decision: 'REJECT', code: 'AUTHORITY_BLOCKED' }
    }, {
      ruleId: 'reject-unreverified',
      kind: 'guard',
      exceptionOf: null,
      when: equals('input.reverified', false),
      emit: { decision: 'REJECT', code: 'NOT_REVERIFIED' }
    }, {
      ruleId: 'reject-stale-binding',
      kind: 'guard',
      exceptionOf: null,
      when: equals('input.bound', false),
      emit: { decision: 'REJECT', code: 'BINDING_STALE' }
    }, {
      ruleId: 'accept-approved',
      kind: 'decision',
      exceptionOf: null,
      when: equals('input.review', 'APPROVED'),
      emit: { decision: 'ACCEPT', code: 'RELEASE_ACCEPTED' }
    }],
    fallback: { decision: 'REJECT', code: 'REVIEW_REQUIRED' }
  };
}

function fixtureRuntimeAuthority(version = ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION) {
  const result = createCodexOAuthAuthorityRecord({
    binaryPath: FIXTURE_CODEX_PATH,
    binaryBytes: FIXTURE_CODEX_BYTES,
    versionOutput: `codex-cli ${version}`,
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: FIXTURE_CODEX_CATALOG,
    requestedModel: REAL_TEST_MODEL,
    reasoningEffort: 'high'
  });
  assert.equal(result.status, 'OK', result.message);
  return result.record;
}

function capsule(items) {
  const records = items.map(({ path, content }) => ({
    path,
    content,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content)
  }));
  return {
    sources: records.map((item) => item.path),
    manifest: records.map(({ path, bytes, sha256: digest }) => ({
      path,
      bytes,
      sha256: digest
    })),
    capsule: records
  };
}

function mechanismContext({ procedure = false, program = false } = {}) {
  const familyResult = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'ranking-conflates-selection-and-frontier-eligibility',
      interventionKind: 'ordered-evidence-and-frontier-gates',
      operationKind: 'authority-reverify-floor-threshold-tradeoff-adjudication',
      expectedEffectKind: 'fewer-false-admissions-and-missed-cost-frontiers',
      preconditions: [
        'comparison-rule',
        'frozen-baseline',
        'predeclared-thresholds',
        'tool-derived-measurements'
      ],
      ...(procedure
        ? {
            procedureSteps: [
              'reject-non-tool-measurement',
              'require-reverification',
              'bind-current-artifact',
              'enforce-quality-floor',
              'apply-thresholds'
            ]
          }
        : {}),
      ...(program ? { program: admissionMechanismProgram() } : {}),
      applicability: ROUTING_TARGET
    }
  });
  assert.equal(familyResult.status, 'OK', familyResult.message);
  const family = familyResult.record;
  const applicationResult = createMechanismApplicationRecord({
    familyId: family.familyId,
    appliedAt: '2026-07-24T00:00:00.000Z',
    partition: 'harvest',
    source: {
      runId: 'fixture-harvest',
      hypothesisId: 'fixture-hypothesis',
      testId: 'fixture-test'
    },
    context: {
      targetSha256: sha256('fixture-target'),
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
      qualityDelta: 0.3,
      tokenCostDeltaPct: -0.04,
      shamMovement: 0,
      controlRegressions: 0,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: sha256('fixture-transfer')
      }],
      contradictionCodes: []
    },
    credit: {
      confidence: 0.95,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256('fixture-receipt').slice(0, 24)}`,
      legacyReceiptSha256: sha256('fixture-legacy'),
      benchmarkSha256: sha256('fixture-benchmark'),
      artifactSetSha256: sha256('fixture-artifacts'),
      evidenceSetSha256: sha256('fixture-evidence')
    }
  });
  assert.equal(applicationResult.status, 'OK', applicationResult.message);
  const policy = structuredClone(DEFAULT_ADAPTIVE_POLICY);
  policy.allocations.related = 0.8;
  policy.allocations.adjacent = 0;
  policy.allocations.failureDerived = 0;
  policy.allocations.wildcard = 0;
  const epochResult = createBaselinePolicyEpoch({
    policy,
    evidenceWindowSha256: sha256('fixture-window'),
    policyScopeId: 'executable-canary-fixture'
  });
  assert.equal(epochResult.status, 'OK', epochResult.message);
  const routed = buildMechanismRoutingDecision({
    families: [family],
    applications: [applicationResult.record],
    target: ROUTING_TARGET,
    policyEpoch: epochResult.record,
    seed: 'executable-canary-fixture-seed',
    hypothesisCount: 2,
    mode: 'active-canary'
  });
  assert.equal(routed.status, 'OK', routed.message);
  return {
    families: [family],
    applications: [applicationResult.record],
    routingTarget: ROUTING_TARGET,
    policyEpoch: epochResult.record,
    seed: 'executable-canary-fixture-seed',
    hypothesisCount: 2,
    routingDecision: routed.decision,
    candidatePool: routed.candidatePool,
    routedCapsule: routed.capsule,
    shamCapsule: createExecutableShamCapsule(routed.capsule),
    primaryFamilyId: family.familyId
  };
}

function mutantSource(index) {
  return [
    `const TASK_NUMBER = ${index};`,
    '',
    'function controlDisposition(input) {',
    "  if (input.control === 'allow') return { decision: 'ACCEPT', code: 'CONTROL_ALLOW' };",
    "  if (input.control === 'deny') return { decision: 'REJECT', code: 'CONTROL_DENY' };",
    '  return null;',
    '}',
    '',
    'export function decide(input) {',
    '  const control = controlDisposition(input);',
    '  if (control) return control;',
    "  if (input.review === 'DENIED') return { decision: 'REJECT', code: 'REVIEW_DENIED' };",
    "  return input.review === 'APPROVED'",
    "    ? { decision: 'ACCEPT', code: 'RELEASE_ACCEPTED' }",
    "    : { decision: 'REJECT', code: 'REVIEW_REQUIRED' };",
    '}',
    '',
    'export const taskNumber = TASK_NUMBER;'
  ].join('\n');
}

function referenceSource(index) {
  return [
    `const TASK_NUMBER = ${index};`,
    '',
    'function controlDisposition(input) {',
    "  if (input.control === 'allow') return { decision: 'ACCEPT', code: 'CONTROL_ALLOW' };",
    "  if (input.control === 'deny') return { decision: 'REJECT', code: 'CONTROL_DENY' };",
    '  return null;',
    '}',
    '',
    'export function decide(input) {',
    '  const control = controlDisposition(input);',
    '  if (control) return control;',
    "  if (input.review === 'DENIED') return { decision: 'REJECT', code: 'REVIEW_DENIED' };",
    "  if (input.authority !== 'tool') return { decision: 'REJECT', code: 'AUTHORITY_BLOCKED' };",
    "  if (input.reverified !== true) return { decision: 'REJECT', code: 'NOT_REVERIFIED' };",
    "  if (input.bound !== true) return { decision: 'REJECT', code: 'BINDING_STALE' };",
    "  return input.review === 'APPROVED'",
    "    ? { decision: 'ACCEPT', code: 'RELEASE_ACCEPTED' }",
    "    : { decision: 'REJECT', code: 'REVIEW_REQUIRED' };",
    '}',
    '',
    'export const taskNumber = TASK_NUMBER;'
  ].join('\n');
}

function targetOnlySource(index) {
  return [
    `const TASK_NUMBER = ${index};`,
    '',
    'function controlDisposition(input) {',
    "  if (input.control === 'allow') return { decision: 'REJECT', code: 'CONTROL_DENY' };",
    "  if (input.control === 'deny') return { decision: 'REJECT', code: 'CONTROL_DENY' };",
    '  return null;',
    '}',
    '',
    'export function decide(input) {',
    '  const control = controlDisposition(input);',
    '  if (control) return control;',
    "  if (input.review === 'DENIED') return { decision: 'REJECT', code: 'REVIEW_DENIED' };",
    "  if (input.authority !== 'tool') return { decision: 'REJECT', code: 'AUTHORITY_BLOCKED' };",
    "  if (input.reverified !== true) return { decision: 'REJECT', code: 'NOT_REVERIFIED' };",
    "  if (input.bound !== true) return { decision: 'REJECT', code: 'BINDING_STALE' };",
    "  return input.review === 'APPROVED'",
    "    ? { decision: 'ACCEPT', code: 'RELEASE_ACCEPTED' }",
    "    : { decision: 'REJECT', code: 'REVIEW_REQUIRED' };",
    '}',
    '',
    'export const taskNumber = TASK_NUMBER;'
  ].join('\n');
}

function caseSet(index) {
  return {
    schemaVersion: EXECUTABLE_CASE_SET_SCHEMA_VERSION,
    exportName: 'decide',
    cases: [
      {
        id: `task-${index}-authority`,
        group: 'target',
        input: {
          review: 'APPROVED',
          authority: 'model',
          reverified: true,
          bound: true
        },
        expected: { decision: 'REJECT', code: 'AUTHORITY_BLOCKED' }
      },
      {
        id: `task-${index}-reverify`,
        group: 'target',
        input: {
          review: 'APPROVED',
          authority: 'tool',
          reverified: false,
          bound: true
        },
        expected: { decision: 'REJECT', code: 'NOT_REVERIFIED' }
      },
      {
        id: `task-${index}-binding`,
        group: 'target',
        input: {
          review: 'APPROVED',
          authority: 'tool',
          reverified: true,
          bound: false
        },
        expected: { decision: 'REJECT', code: 'BINDING_STALE' }
      },
      {
        id: `task-${index}-allow-control`,
        group: 'control',
        input: { control: 'allow' },
        expected: { decision: 'ACCEPT', code: 'CONTROL_ALLOW' }
      },
      {
        id: `task-${index}-deny-control`,
        group: 'control',
        input: { control: 'deny' },
        expected: { decision: 'REJECT', code: 'CONTROL_DENY' }
      }
    ]
  };
}

function interfaceContract({ v2 = false } = {}) {
  return {
    schemaVersion: v2
      ? EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION_V2
      : EXECUTABLE_INTERFACE_CONTRACT_SCHEMA_VERSION,
    exportName: 'decide',
    inputPaths: [
      'authority',
      'bound',
      'control',
      'reverified',
      'review'
    ],
    decisions: ['ACCEPT', 'REJECT'],
    codes: [
      {
        value: 'AUTHORITY_BLOCKED',
        meaning: 'The supplied measurement authority is not tool owned.'
      },
      {
        value: 'BINDING_STALE',
        meaning: 'The evidence does not bind the current candidate.'
      },
      {
        value: 'CONTROL_ALLOW',
        meaning: 'The explicit allow regression control remains accepted.'
      },
      {
        value: 'CONTROL_DENY',
        meaning: 'The explicit deny regression control remains rejected.'
      },
      {
        value: 'NOT_REVERIFIED',
        meaning: 'The supplied evidence has not passed reverification.'
      },
      {
        value: 'RELEASE_ACCEPTED',
        meaning: 'Every required release gate passed.'
      },
      {
        value: 'REVIEW_DENIED',
        meaning: 'The current review explicitly denies release.'
      },
      {
        value: 'REVIEW_REQUIRED',
        meaning: 'No current approval permits release.'
      }
    ],
    ...(v2
      ? {
          roleBindings: [
            { role: 'input.authority', path: 'authority' },
            { role: 'input.bound', path: 'bound' },
            { role: 'input.control', path: 'control' },
            { role: 'input.reverified', path: 'reverified' },
            { role: 'input.review', path: 'review' }
          ]
        }
      : {})
  };
}

function fixtureConfig({ v2 = false, v3 = false, v4 = false } = {}) {
  const withInterface = v2 || v3 || v4;
  const publicItems = [];
  const oracleItems = [];
  const referenceItems = [];
  const tasks = [];
  for (let index = 1; index <= 10; index++) {
    const prefix = `test/fixtures/executable-canary/task-${index}`;
    const sourcePath = `${prefix}/candidate.mjs`;
    const specPath = `${prefix}/incident.md`;
    const interfacePath = `${prefix}/interface.json`;
    const oraclePath = `${prefix}/oracle.json`;
    const referencePath = `${prefix}/reference.mjs`;
    publicItems.push(
      { path: sourcePath, content: mutantSource(index) },
      {
        path: specPath,
        content: [
          `# Admission incident ${index}`,
          '',
          'An approved release was accepted even though its measurement authority was not tool-owned.',
          'Repair the module so the observed incident is rejected while preserving explicit allow and deny controls.',
          'The module is a standalone extraction of Loop Factory release-admission behavior.'
        ].join('\n')
      }
    );
    if (withInterface) {
      publicItems.push({
        path: interfacePath,
        content: canonicalAdaptiveJson(interfaceContract({ v2: v4 }))
      });
    }
    oracleItems.push({
      path: oraclePath,
      content: canonicalAdaptiveJson(caseSet(index))
    });
    referenceItems.push({
      path: referencePath,
      content: referenceSource(index)
    });
    tasks.push({
      id: `mutation-${String(index).padStart(2, '0')}`,
      phase: index <= 5 ? 'qualification' : 'confirmation',
      findingId: `finding-${String(500 + index).padStart(3, '0')}`,
      title: `Repair admission incident ${index}`,
      sourcePath,
      specPath,
      ...(withInterface ? { interfacePath } : {}),
      oraclePath,
      referencePath,
      outputFile: 'candidate.mjs',
      exportName: 'decide',
      originRefs: [{
        path: 'src/scorecard.mjs',
        locator: 'export function evaluatePromotion'
      }],
      hypothesis: {
        title: 'Restore ordered admission gates',
        bottleneck: 'Approval is evaluated before authority, reverification, and evidence binding.',
        operation: 'Apply evidence gates before deciding whether an approved candidate may be admitted.',
        expectedMovement: 'Invalid approved candidates are rejected while established controls remain stable.',
        falsifier: 'A model-owned, stale, or unreverified approved candidate is still accepted.'
      }
    });
  }
  const publicPartition = capsule(publicItems);
  const oraclePartition = capsule(oracleItems);
  const referencePartition = capsule(referenceItems);
  const provenancePartition = capsule([{
    path: 'src/scorecard.mjs',
    content: readFileSync(
      new URL('../src/scorecard.mjs', import.meta.url),
      'utf8'
    )
  }]);
  const mechanismPartition = capsule([{
    path: 'submission/evidence/fixture-mechanism.json',
    content: JSON.stringify({
      mechanism: 'ordered-evidence-and-frontier-gates',
      authority: 'tool-computed'
    }, null, 2)
  }]);
  const schemaVersion = v4
    ? ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4
    : (v3
      ? ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3
    : (v2
        ? ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2
        : ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION));
  const implementation = resolveAdaptiveExecutableCanaryImplementation(
    undefined,
    schemaVersion
  );
  assert.equal(implementation.ok, true, implementation.errors.join('\n'));
  const config = {
    schemaVersion,
    model: REAL_TEST_MODEL,
    fixtureOnly: true,
    historicalTokenEstimate: 400000,
    routes: Array(10).fill(REAL_TEST_MODEL),
    publicSources: publicPartition.sources,
    publicManifest: publicPartition.manifest,
    publicCapsule: publicPartition.capsule,
    oracleSources: oraclePartition.sources,
    oracleManifest: oraclePartition.manifest,
    oracleCapsule: oraclePartition.capsule,
    referenceSources: referencePartition.sources,
    referenceManifest: referencePartition.manifest,
    referenceCapsule: referencePartition.capsule,
    provenanceSources: provenancePartition.sources,
    provenanceManifest: provenancePartition.manifest,
    provenanceCapsule: provenancePartition.capsule,
    mechanismEvidenceSources: mechanismPartition.sources,
    mechanismEvidenceManifest: mechanismPartition.manifest,
    mechanismEvidenceCapsule: mechanismPartition.capsule,
    mechanismEvidenceRefs: [{
      path: 'submission/evidence/fixture-mechanism.json',
      locator: 'ordered-evidence-and-frontier-gates'
    }],
    implementationManifest: implementation.manifest,
    implementationCapsule: implementation.capsule,
    runtimeAuthority: fixtureRuntimeAuthority(),
    evaluatorAuthority: captureExecutableEvaluatorAuthority().record,
    tasks,
    mechanismContext: mechanismContext({
      procedure: withInterface,
      program: v4
    })
  };
  config.preflight = computeExecutableCanaryPreflight(config);
  const plan = buildAdaptiveExecutableCanaryPlan(config);
  return {
    ...config,
    approvedPlanSha256: plan.sha256
  };
}

function strictPacket(contract, revisedContent, tokenOffset = 0) {
  const payload = {
    findingId: contract.target.findingId,
    hypothesisId: contract.hypothesis.id,
    baselineSha256: contract.target.baselineSha256,
    revisedContent,
    changeSummary: 'Applied a concrete ordered evidence-gate repair to the supplied module.'
  };
  const rawResult = JSON.stringify(payload);
  const finalOutput = `<IMPROVEMENT>${rawResult}</IMPROVEMENT>`;
  const inputTokens = 400 + tokenOffset;
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
  const workspaceRoot = '/tmp/executable-canary-model-capsule';
  const authority = fixtureRuntimeAuthority();
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: rawStdout }],
    executorOwned: true,
    rawStdout,
    rawStderr: '',
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
}

function failedPacket(contract) {
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({
      type: 'turn.failed',
      error: { message: 'fixture runtime rejected the requested model' }
    })
  ].join('\n');
  const rawStderr = 'Reading prompt from stdin...\n';
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = '/tmp/executable-canary-model-capsule';
  const authority = fixtureRuntimeAuthority();
  return {
    route: contract.route,
    phase: contract.phase,
    __execReason: 'EXEC_FAILED',
    artifacts: [{ role: 'runlog', content: rawStdout }],
    executorOwned: true,
    rawStdout,
    rawStderr,
    finalOutput: '',
    isolation: { status: 'PASS', toolCalls: [], reasons: [] },
    invocation: {
      requestedModel: contract.route,
      reportedModel: null,
      binaryFamily: 'codex',
      argv: buildArgs('codex', null, contract.route, {
        strictIsolation: true,
        schemaPath,
        workspaceRoot
      }),
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'explicit-model-flag',
      reportedModelMatchesRequest: null,
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
      exitCode: 1,
      stdoutSha256: sha256(rawStdout),
      stderrSha256: sha256(rawStderr),
      resultSha256: null,
      tokenUsage: null,
      tokenUsageDetails: null,
      durationMs: 20,
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  };
}

function causalWorker(config, {
  baselineSolves = false
} = {}) {
  let calls = 0;
  return (contract) => {
    calls += 1;
    const task = config.tasks.find(
      (item) => item.findingId === contract.target.findingId
    );
    const semantics = contract.mechanismCapsule?.items?.[0]?.semantics || 'none';
    const source = baselineSolves || semantics === 'positive-transfer'
      ? config.referenceCapsule.find((item) => item.path === task.referencePath).content
      : contract.target.baselineContent;
    return strictPacket(contract, source, calls);
  };
}

function controlRepairWorker(config) {
  let calls = 0;
  return (contract) => {
    calls += 1;
    const taskIndex = config.tasks.findIndex(
      (item) => item.findingId === contract.target.findingId
    );
    const task = config.tasks[taskIndex];
    const semantics =
      contract.mechanismCapsule?.items?.[0]?.semantics || 'none';
    const source = semantics === 'positive-transfer'
      ? config.referenceCapsule
        .find((item) => item.path === task.referencePath).content
      : targetOnlySource(taskIndex + 1);
    return strictPacket(contract, source, calls);
  };
}

test('executable evaluator selects the permission flag supported by its Node runtime', () => {
  assert.equal(executablePermissionFlag('v18.20.8'), null);
  assert.equal(executablePermissionFlag('v20.20.2'), '--experimental-permission');
  assert.equal(executablePermissionFlag('v22.12.0'), '--experimental-permission');
  assert.equal(executablePermissionFlag('v22.13.0'), '--permission');
  assert.equal(executablePermissionFlag('v23.4.0'), '--experimental-permission');
  assert.equal(executablePermissionFlag('v23.5.0'), '--permission');
  assert.equal(executablePermissionFlag('v24.0.0'), '--permission');
  assert.equal(executablePermissionFlag('not-a-version'), null);
});

test('sealed evaluator authority is portable but execution remains host-bound', () => {
  const profile = '(version 1)(allow default)(deny network*)';
  const payload = {
    schemaVersion: 'executable-evaluator-authority-v1',
    platform: 'darwin',
    architecture: 'arm64',
    node: {
      path: '/opt/loop-factory/node', basename: 'node', version: 'v24.0.0',
      sha256: 'a'.repeat(64)
    },
    sandbox: {
      path: '/usr/bin/sandbox-exec', basename: 'sandbox-exec',
      sha256: 'b'.repeat(64), profile, profileSha256: sha256(profile)
    },
    bootstrap: {
      path: '/opt/loop-factory/executable-canary-sandbox.mjs',
      sha256: 'c'.repeat(64)
    },
    limits: {
      timeoutMs: 15000, maxBytes: 65536, maxBufferBytes: 1048576, heapMb: 128
    },
    permissions: {
      nodeFlag: '--permission',
      filesystem: 'candidate-and-bootstrap-read-only',
      childProcesses: 'denied', workers: 'denied', network: 'denied'
    }
  };
  const authority = {
    ...payload,
    authoritySha256: sha256(canonicalAdaptiveJson(payload))
  };
  assert.equal(validateExecutableEvaluatorAuthorityRecord(authority).status, 'OK');
  assert.equal(validateExecutableEvaluatorAuthority(authority).status, 'BLOCKED');
});

test('executable evaluator refuses unsupported hosts before sandbox access', {
  skip: process.platform === 'darwin'
}, () => {
  const captured = captureExecutableEvaluatorAuthority();
  assert.equal(captured.status, 'BLOCKED');
  assert.equal(captured.code, 'EXECUTABLE_SANDBOX_UNSUPPORTED');
});

test('executable evaluator runs correct code and blocks filesystem access', {
  skip: !isDarwin
}, () => {
  const authority = captureExecutableEvaluatorAuthority();
  assert.equal(authority.status, 'OK');
  assert.equal(authority.record.limits.timeoutMs, 15000);
  const oversized = structuredClone(authority.record);
  oversized.limits.timeoutMs = 60000;
  const oversizedPayload = { ...oversized };
  delete oversizedPayload.authoritySha256;
  oversized.authoritySha256 = sha256(canonicalAdaptiveJson(oversizedPayload));
  assert.equal(validateExecutableEvaluatorAuthority(oversized).status, 'BLOCKED');
  const cases = caseSet(1);
  const passing = evaluateExecutableCandidate({
    source: referenceSource(1),
    caseSet: cases,
    authority: authority.record
  });
  assert.equal(passing.instrumentValid, true);
  assert.equal(passing.targetQuality, 1);
  assert.equal(passing.controlQuality, 1);
  assert.equal(existsSync(passing.sandbox.capsuleDir), false);

  const denied = evaluateExecutableCandidate({
    source: [
      "import fs from 'node:fs';",
      'export function decide(input) {',
      "  fs.readFileSync('/etc/hosts');",
      "  return { decision: 'ACCEPT', code: 'CONTROL_ALLOW' };",
      '}'
    ].join('\n'),
    caseSet: cases,
    authority: authority.record
  });
  assert.equal(denied.instrumentValid, true);
  assert.equal(denied.candidateExecuted, false);
  assert.match(denied.stderr, /ERR_ACCESS_DENIED|restricted/);
  assert.equal(existsSync(denied.sandbox.capsuleDir), false);

  const shortAuthority = structuredClone(authority.record);
  shortAuthority.limits.timeoutMs = 1;
  const shortPayload = { ...shortAuthority };
  delete shortPayload.authoritySha256;
  shortAuthority.authoritySha256 = sha256(canonicalAdaptiveJson(shortPayload));
  const timedOut = evaluateExecutableCandidate({
    source: referenceSource(1),
    caseSet: cases,
    authority: shortAuthority
  });
  assert.equal(timedOut.instrumentValid, true);
  assert.equal(timedOut.candidateExecuted, false);
  assert.equal(timedOut.code, 'CANDIDATE_TIMEOUT');
  assert.equal(timedOut.timedOut, true);
  assert.equal(existsSync(timedOut.sandbox.capsuleDir), false);
});

test('V2 interface coverage exposes vocabulary without exposing hidden values', () => {
  const cases = caseSet(1);
  const visible = interfaceContract();
  const covered = validateExecutableInterfaceCoverage(cases, visible);
  assert.equal(covered.ok, true, covered.errors.join('\n'));
  assert.match(covered.sha256, /^[a-f0-9]{64}$/);

  const missingPath = {
    ...visible,
    inputPaths: visible.inputPaths.filter((path) => path !== 'authority')
  };
  const pathFailure = validateExecutableInterfaceCoverage(cases, missingPath);
  assert.equal(pathFailure.ok, false);
  assert.ok(pathFailure.errors.includes('hidden input path is undeclared: authority'));

  const missingCode = {
    ...visible,
    codes: visible.codes.filter((item) => item.value !== 'NOT_REVERIFIED')
  };
  const codeFailure = validateExecutableInterfaceCoverage(cases, missingCode);
  assert.equal(codeFailure.ok, false);
  assert.ok(codeFailure.errors.includes('hidden code is undeclared: NOT_REVERIFIED'));

  const visibleBytes = canonicalAdaptiveJson(visible);
  assert.doesNotMatch(visibleBytes, /task-1-authority|\"model\"|\"tool\"/);
});

test('V2 rejects a Codex runtime below the observed Sol compatibility floor', {
  skip: !isDarwin
}, () => {
  const v2 = fixtureConfig({ v2: true });
  v2.runtimeAuthority = fixtureRuntimeAuthority('0.142.2');
  v2.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(v2).sha256;
  const blocked = validateAdaptiveExecutableCanaryConfig(v2);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.includes(
    `executable canary v2 requires Codex CLI ${ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION} or newer`
  ));

  const v3 = fixtureConfig({ v3: true });
  v3.runtimeAuthority = fixtureRuntimeAuthority('0.142.2');
  v3.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(v3).sha256;
  const v3Blocked = validateAdaptiveExecutableCanaryConfig(v3);
  assert.equal(v3Blocked.ok, false);
  assert.ok(v3Blocked.errors.includes(
    `executable canary v3 requires Codex CLI ${ADAPTIVE_EXECUTABLE_CANARY_V2_MIN_CODEX_VERSION} or newer`
  ));

  const v1 = fixtureConfig();
  v1.runtimeAuthority = fixtureRuntimeAuthority('0.142.2');
  v1.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(v1).sha256;
  const historical = validateAdaptiveExecutableCanaryConfig(v1);
  assert.equal(historical.ok, true, historical.errors.join('\n'));
});

test('executable canary plan freezes disjoint qualification and balanced confirmation', {
  skip: !isDarwin
}, () => {
  const config = fixtureConfig();
  const validation = validateAdaptiveExecutableCanaryConfig(config);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(config.preflight.status, 'PASS');
  const plan = validation.plan;
  assert.equal(config.evaluatorAuthority.limits.timeoutMs, 15000);
  assert.equal(plan.contract.candidateTimeoutMs, 15000);
  assert.equal(plan.contract.maximumCalls, 20);
  assert.equal(plan.contract.qualificationSchedule.length, 5);
  assert.equal(plan.contract.confirmationSchedule.length, 15);
  assert.equal(
    new Set(plan.contract.qualificationSchedule.map((item) => item.taskId)).size,
    5
  );
  assert.equal(
    new Set(plan.contract.confirmationSchedule.map((item) => item.taskId)).size,
    5
  );
  for (const task of config.tasks.filter((item) => item.phase === 'confirmation')) {
    const rows = plan.contract.confirmationSchedule
      .filter((item) => item.taskId === task.id);
    assert.deepEqual(
      new Set(rows.map((item) => item.armRole)),
      new Set(['baseline', 'routed', 'sham'])
    );
  }
  const disclosure = adaptiveExecutableCanaryLaunchDisclosure(config, {
    configPath: '/tmp/executable.json',
    home: '/tmp/executable-home',
    runId: 'executable-run'
  });
  assert.equal(disclosure.calls.totalMaximum, 20);
  assert.equal(disclosure.calls.retries, 0);
  assert.equal(disclosure.exposure.hardTokenLimit, null);
  assert.equal(disclosure.evaluator.hiddenExpectedOutputsEnterCandidateProcess, false);
  assert.match(disclosure.launchCommand, /verify:executable-canary/);
});

test('V2 seals actionable procedures, visible interfaces, and diagnostic replay', {
  skip: !isDarwin
}, () => {
  const { store } = freshEngine();
  const config = fixtureConfig({ v2: true });
  const validation = validateAdaptiveExecutableCanaryConfig(config);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.plan.profile, ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V2);
  assert.ok(validation.plan.tasks.every((task) => (
    task.interfaceSha256 && task.interfaceCoverageSha256
  )));
  assert.match(
    config.mechanismContext.routedCapsule.items[0].instruction,
    /Apply this evidence-backed procedure in order/
  );
  assert.deepEqual(
    config.mechanismContext.routedCapsule.items[0]
      .causalFingerprint.procedureSteps,
    [
      'reject-non-tool-measurement',
      'require-reverification',
      'bind-current-artifact',
      'enforce-quality-floor',
      'apply-thresholds'
    ]
  );
  assert.equal(
    config.mechanismContext.shamCapsule.items[0]
      .causalFingerprint.procedureSteps.length,
    5
  );

  const result = runAdaptiveExecutableCanary(store, config, {
    runId: 'executable-v2-causal-pass',
    worker: causalWorker(config)
  });
  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.causalPass, true);
  assert.equal(result.verification.gates.interfaceCoverage, true);
  const state = store.load('executable-v2-causal-pass');
  assert.ok(state.calls.every((call) => (
    Number.isFinite(call.decisionTargetQuality)
    && Number.isFinite(call.decisionControlQuality)
    && Number.isFinite(call.codeTargetQuality)
    && Number.isFinite(call.codeControlQuality)
  )));
  const routed = state.calls.find((call) => call.armRole === 'routed');
  assert.equal(routed.targetQuality, 1);
  assert.equal(routed.decisionTargetQuality, 1);
  assert.equal(routed.codeTargetQuality, 1);
  const prompt = store.readArtifact(
    'executable-v2-causal-pass',
    routed.promptArtifactRef
  ).content;
  assert.match(prompt, /VISIBLE INTERFACE CONTRACT/);
  assert.match(prompt, /AUTHORITY_BLOCKED/);
  assert.doesNotMatch(prompt, /task-6-authority|task-6-reverify|task-6-binding/);

  const verified = verifyAdaptiveExecutableCanaryRun(
    store,
    'executable-v2-causal-pass'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.equal(verified.causalPass, true);
  assert.equal(verified.gates.measurementDerivation, true);
  assert.ok(verified.series.routed.every((item) => (
    Number.isFinite(item.decisionTargetQuality)
    && Number.isFinite(item.codeTargetQuality)
  )));
});

test('V3 binds a full-repair endpoint while V2 remains target-only', {
  skip: !isDarwin
}, () => {
  const v2 = fixtureConfig({ v2: true });
  const v2Validation = validateAdaptiveExecutableCanaryConfig(v2);
  assert.equal(v2Validation.ok, true, v2Validation.errors.join('\n'));
  assert.equal(
    Object.hasOwn(v2Validation.plan.contract, 'repairFailureMetric'),
    false
  );

  const v3 = fixtureConfig({ v3: true });
  const v3Validation = validateAdaptiveExecutableCanaryConfig(v3);
  assert.equal(v3Validation.ok, true, v3Validation.errors.join('\n'));
  assert.equal(
    v3Validation.plan.profile,
    ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V3
  );
  assert.equal(
    v3Validation.plan.contract.repairFailureMetric,
    'full-repair'
  );
  assert.ok(v3Validation.plan.implementationManifest.some(
    (item) => item.path === 'docs/EXECUTABLE_CAUSAL_CANARY_V3.md'
  ));
  const disclosure = adaptiveExecutableCanaryLaunchDisclosure(v3, {
    configPath: '/tmp/executable-v3.json',
    home: '/tmp/executable-v3-home',
    runId: 'executable-v3-run'
  });
  assert.equal(disclosure.calls.qualificationFailureMetric, 'full-repair');
});

test('V3 measures control-preservation lift that V2 intentionally excludes', {
  skip: !isDarwin
}, () => {
  const historical = freshEngine();
  const v2 = fixtureConfig({ v2: true });
  const v2Result = runAdaptiveExecutableCanary(historical.store, v2, {
    runId: 'executable-v2-control-only-headroom',
    worker: controlRepairWorker(v2)
  });
  assert.equal(v2Result.status, 'OK');
  assert.equal(v2Result.experimentValid, true);
  assert.equal(v2Result.outcome.status, 'NO_HEADROOM');
  assert.equal(
    historical.store.load('executable-v2-control-only-headroom').calls.length,
    3
  );
  assert.equal(v2Result.verification.qualification.targetFailures, 0);

  const current = freshEngine();
  const v3 = fixtureConfig({ v3: true });
  const v3Result = runAdaptiveExecutableCanary(current.store, v3, {
    runId: 'executable-v3-control-repair',
    worker: controlRepairWorker(v3)
  });
  assert.equal(v3Result.status, 'OK', JSON.stringify(v3Result, null, 2));
  assert.equal(
    v3Result.experimentValid,
    true,
    v3Result.verification.reasons.join('\n')
  );
  assert.equal(v3Result.causalPass, true, JSON.stringify(v3Result.outcome, null, 2));
  assert.equal(v3Result.outcome.status, 'PASS');
  assert.equal(v3Result.outcome.repairFailureMetric, 'full-repair');
  assert.equal(v3Result.outcome.qualificationFailures, 5);
  assert.equal(v3Result.outcome.confirmationBaselineFailures, 5);
  assert.equal(v3Result.outcome.confirmationBaselineFullRepairFailures, 5);
  assert.equal(v3Result.outcome.routedPairedWins, 5);
  assert.equal(v3Result.outcome.shamPairedWins, 0);
  assert.equal(v3Result.outcome.routedControlFailures, 0);
  assert.equal(v3Result.outcome.routedFullRepairRegressions, 0);
  assert.equal(
    v3Result.verification.qualification.failureMetric,
    'full-repair'
  );
  assert.equal(v3Result.verification.qualification.fullRepairFailures, 5);
  assert.equal(v3Result.verification.qualification.targetFailures, 0);
  assert.equal(v3Result.verification.qualification.controlFailures, 5);
  assert.equal(
    current.store.load('executable-v3-control-repair').calls.length,
    ADAPTIVE_EXECUTABLE_CANARY.maximumCalls
  );

  const verified = verifyAdaptiveExecutableCanaryRun(
    current.store,
    'executable-v3-control-repair'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.equal(verified.causalPass, true);

  const state = current.store.load('executable-v3-control-repair');
  state.qualification.failureMetric = 'target';
  current.store.save(state);
  const tampered = verifyAdaptiveExecutableCanaryRun(
    current.store,
    'executable-v3-control-repair'
  );
  assert.equal(tampered.experimentValid, false);
  assert.equal(tampered.gates.stateConsistency, false);
});

test('V4 freezes complete compiled treatment coverage into the approved plan', {
  skip: !isDarwin
}, () => {
  const config = fixtureConfig({ v4: true });
  const validation = validateAdaptiveExecutableCanaryConfig(config);

  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(
    validation.plan.profile,
    ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4
  );
  assert.equal(validation.plan.contract.mechanismCompilerVersion, 'mechanism-compiler-v1');
  assert.ok(validation.plan.tasks.every((task) => (
    task.routedCompilationSha256
    && task.shamCompilationSha256
    && task.routedCompileCoverage === 1
    && task.shamCompileCoverage === 1
  )));
  assert.ok(validation.plan.implementationManifest.some(
    (item) => item.path === 'src/mechanism-compiler.mjs'
  ));

  const brokenTask = config.tasks[0];
  const artifact = config.publicCapsule.find(
    (item) => item.path === brokenTask.interfacePath
  );
  const parsed = JSON.parse(artifact.content);
  parsed.roleBindings = parsed.roleBindings.filter(
    (binding) => binding.role !== 'input.authority'
  );
  artifact.content = canonicalAdaptiveJson(parsed);
  artifact.bytes = Buffer.byteLength(artifact.content);
  artifact.sha256 = sha256(artifact.content);
  Object.assign(
    config.publicManifest.find((item) => item.path === artifact.path),
    { bytes: artifact.bytes, sha256: artifact.sha256 }
  );
  config.preflight = computeExecutableCanaryPreflight(config);
  config.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(config).sha256;

  const blocked = validateAdaptiveExecutableCanaryConfig(config);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.includes(
    `${brokenTask.id}: routed mechanism compile coverage is incomplete`
  ));
});

test('V4 automatic memory import authorization is optional, boolean, and plan-bound', () => {
  const config = fixtureConfig({ v4: true });
  const originalPlan = buildAdaptiveExecutableCanaryPlan(config);
  config.adaptiveMemoryImportEnabled = true;
  const enabledPlan = buildAdaptiveExecutableCanaryPlan(config);
  assert.notEqual(enabledPlan.sha256, originalPlan.sha256);
  assert.equal(enabledPlan.adaptiveMemoryImportEnabled, true);
  config.adaptiveMemoryImportEnabled = 'yes';
  const validation = validateAdaptiveExecutableCanaryConfig(config, {
    requireApproval: false
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes(
    'adaptiveMemoryImportEnabled must be boolean when declared'
  ));
  assert.equal(completeAdaptiveCanaryMemoryImport({
    config: {},
    result: { status: 'OK', experimentValid: true, causalPass: true }
  }).status, 'DISABLED');
  const validFailure = completeAdaptiveCanaryMemoryImport({
    config: { adaptiveMemoryImportEnabled: true },
    result: { status: 'OK', experimentValid: true, causalPass: false }
  });
  assert.equal(validFailure.status, 'NOT_ELIGIBLE');
  assert.equal(adaptiveCanaryRunSucceeded({
    result: { status: 'OK', experimentValid: true, causalPass: false },
    memoryImport: validFailure
  }), true, 'a causal FAIL remains valid evidence and does not require an import');
  assert.equal(adaptiveCanaryRunSucceeded({
    result: { status: 'OK', experimentValid: true, causalPass: true },
    memoryImport: { status: 'REFUSED' }
  }), false, 'a causal PASS cannot report closed-loop success when its sealed import fails');
});

test('V4 runs schema-matched compiled treatments and independently replays them', {
  skip: !isDarwin
}, () => {
  const { engine, store, home } = freshEngine();
  const config = fixtureConfig({ v4: true });
  config.fixtureOnly = false;
  config.adaptiveMemoryImportEnabled = true;
  config.preflight = computeExecutableCanaryPreflight(config);
  config.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(config).sha256;
  const result = runAdaptiveExecutableCanary(store, config, {
    runId: 'executable-v4-compiled-pass',
    worker: controlRepairWorker(config)
  });

  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.causalPass, true, JSON.stringify(result.outcome, null, 2));
  assert.equal(result.verification.gates.mechanismCompileCoverage, true);
  assert.equal(result.verification.gates.shamReplay, true);
  const state = store.load('executable-v4-compiled-pass');
  const routed = state.calls.find((call) => call.armRole === 'routed');
  const sham = state.calls.find((call) => call.armRole === 'sham');
  const routedContract = JSON.parse(store.readArtifact(
    'executable-v4-compiled-pass',
    routed.contractArtifactRef
  ).content);
  const shamContract = JSON.parse(store.readArtifact(
    'executable-v4-compiled-pass',
    sham.contractArtifactRef
  ).content);
  assert.equal(routedContract.mechanismCapsule.schemaVersion, 'compiled-mechanism-capsule-v1');
  assert.equal(routedContract.mechanismCapsule.status, 'COMPILED');
  assert.equal(shamContract.mechanismCapsule.status, 'COMPILED');
  assert.equal(
    routedContract.mechanismCapsule.items[0].semantics,
    'positive-transfer'
  );
  assert.equal(
    shamContract.mechanismCapsule.items[0].semantics,
    'irrelevant-control'
  );
  assert.notEqual(
    routedContract.mechanismCapsule.packetSha256,
    shamContract.mechanismCapsule.packetSha256
  );

  const verified = verifyAdaptiveExecutableCanaryRun(
    store,
    'executable-v4-compiled-pass'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.equal(verified.gates.treatmentBinding, true);
  assert.equal(verified.gates.treatmentParity, true);

  const imported = completeAdaptiveCanaryMemoryImport({
    store,
    homeDir: home,
    runId: 'executable-v4-compiled-pass',
    config,
    result
  });
  assert.equal(imported.status, 'OK', JSON.stringify(imported, null, 2));
  assert.equal(imported.activation, 'routing-only');
  assert.match(imported.measurementId, /^measurement-[a-f0-9]{24}$/);
  assert.match(imported.measurementSha256, /^[a-f0-9]{64}$/);
  assert.ok(imported.exactCaseDelta > 0);
  assert.ok(imported.decisionDelta >= 0);
  assert.equal(imported.qualityDelta, imported.exactCaseDelta);
  assert.equal(imported.qualityDelta, 0.2);
  assert.ok(imported.tokenCostDeltaPct > 0);
  assert.equal(imported.familyIdempotent, false);
  assert.equal(imported.measurementIdempotent, false);
  assert.equal(imported.importIdempotent, false);
  assert.equal(adaptiveCanaryRunSucceeded({ result, memoryImport: imported }), true);

  const repeated = completeAdaptiveCanaryMemoryImport({
    store,
    homeDir: home,
    runId: 'executable-v4-compiled-pass',
    config,
    result
  });
  assert.equal(repeated.status, 'OK', JSON.stringify(repeated, null, 2));
  assert.equal(repeated.applicationSha256, imported.applicationSha256);
  assert.equal(repeated.familyIdempotent, true);
  assert.equal(repeated.measurementIdempotent, true);
  assert.equal(repeated.importIdempotent, true);
  const measurements = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: 'adaptive-measurement-v2'
  });
  assert.equal(measurements.status, 'OK');
  assert.equal(measurements.records.length, 1);
  assert.equal(measurements.records[0].measurementId, imported.measurementId);
  const imports = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: 'adaptive-canary-import-v1'
  });
  assert.equal(imports.status, 'OK');
  assert.equal(imports.records.length, 1);
  assert.equal(measurements.records[0].mechanismBindings.treatment,
    imports.records[0].evidence.programSha256);
  assert.equal(imports.records[0].evidence.tokenReceiptArtifactCount, 20);
  assert.equal(imports.records[0].evidence.tokenReceiptArtifactSha256s.length, 20);

  const importedConfig = structuredClone(config);
  const importedRoute = buildMechanismRoutingDecision({
    families: importedConfig.mechanismContext.families,
    applications: imports.records,
    target: importedConfig.mechanismContext.routingTarget,
    policyEpoch: importedConfig.mechanismContext.policyEpoch,
    seed: importedConfig.mechanismContext.seed,
    hypothesisCount: importedConfig.mechanismContext.hypothesisCount,
    mode: 'active-canary'
  });
  assert.equal(importedRoute.status, 'OK', importedRoute.message);
  importedConfig.mechanismContext.applications = imports.records;
  importedConfig.mechanismContext.routingDecision = importedRoute.decision;
  importedConfig.mechanismContext.candidatePool = importedRoute.candidatePool;
  importedConfig.mechanismContext.routedCapsule = importedRoute.capsule;
  importedConfig.mechanismContext.shamCapsule = createExecutableShamCapsule(
    importedRoute.capsule
  );
  importedConfig.preflight = computeExecutableCanaryPreflight(importedConfig);
  importedConfig.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(
    importedConfig
  ).sha256;
  const importedValidation = validateAdaptiveExecutableCanaryConfig(importedConfig);
  assert.equal(
    importedValidation.ok,
    true,
    importedValidation.errors.join('\n')
  );

  const catalog = loadMechanismCatalog({ homeDir: home });
  assert.equal(catalog.status, 'OK', catalog.message);
  assert.equal(catalog.catalog.counts['adaptive-canary-import-v1'], 1);
  assert.doesNotMatch(readFileSync(catalog.catalogPath, 'utf8'), new RegExp(home));
  assert.doesNotMatch(readFileSync(catalog.catalogPath, 'utf8'), /Repair admission incident/);

  const followupRunId = 'executable-v4-imported-followup';
  const initialized = engine.initialize_loop_run({
    runId: followupRunId,
    task: 'Improve release admission accuracy against the frozen evaluator while preserving token cost controls.',
    answers: ['improve admission accuracy', 'improve', 'tool-measured quality', 'preserve controls', 'defaults'],
    config: {
      metaLearning: {
        enabled: true,
        mode: 'active-canary',
        seed: 'verified-canary-followup',
        policyScopeId: 'verified-canary-followup-policy'
      }
    }
  });
  assert.equal(initialized.status, 'OK', initialized.message);
  assert.equal(engine.artifact_record({
    runId: followupRunId,
    role: 'baseline',
    name: 'baseline',
    content: BASELINE_BODY
  }).status, 'OK');
  const benchmark = engine.benchmark_propose({
    runId: followupRunId,
    benchmarks: [{
      name: 'verified-canary-followup-benchmark',
      taskValueDimensions: [...ROUTING_TARGET.taskValueDimensions],
      resourceDimensions: [...ROUTING_TARGET.resourceDimensions],
      cases: [{ id: 'admission-case', input: 'sealed candidate', expect: 'correct admission' }],
      oracle: DEFAULT_QUALITY_ORACLE
    }]
  });
  assert.equal(benchmark.status, 'OK', benchmark.message);
  assert.equal(engine.benchmark_select({
    runId: followupRunId,
    benchmarkId: benchmark.benchmarkIds[0]
  }).status, 'OK');
  const baselineRef = recordMeasurement(
    engine,
    followupRunId,
    'followup-baseline',
    1000,
    0.5
  );
  assert.equal(engine.benchmark_run({
    runId: followupRunId,
    arm: 'baseline',
    measurementRef: baselineRef
  }).status, 'OK');
  const preparedRoute = engine.operator.prepareMechanismRouting({
    runId: followupRunId,
    hypothesisCount: 5,
    interfaceContract: interfaceContract({ v2: true }),
    target: ROUTING_TARGET
  });
  assert.equal(preparedRoute.status, 'OK', preparedRoute.message);
  assert.equal(preparedRoute.decision.candidatePoolCount, 1);
  assert.ok(preparedRoute.decision.allocationSchedule.some((item) => (
    item.familyId === imported.familyId && item.allocation !== 'control'
  )));
  assert.ok(preparedRoute.decision.allocationSchedule.some((item) => (
    item.allocation === 'control' && item.familyId === null
  )));
  assert.ok(preparedRoute.treatment.positions.some((item) => (
    item.familyId === imported.familyId
    && item.compiledTreatment?.status === 'COMPILED'
  )));

  const evaluatorRef = state.evidenceArtifacts.evaluatorAuthority.id;
  const evaluatorArtifact = store.readArtifact(
    'executable-v4-compiled-pass',
    evaluatorRef
  );
  const substitutedEvaluator = {
    ...evaluatorArtifact,
    content: canonicalAdaptiveJson({ schemaVersion: 'substituted-evaluator' })
  };
  substitutedEvaluator.sha256 = sha256(substitutedEvaluator.content);
  store.writeArtifact(
    'executable-v4-compiled-pass',
    evaluatorRef,
    substitutedEvaluator
  );
  const evaluatorTamper = engine.operator.importAdaptiveExecutableCanary({
    canaryHome: home,
    canaryRunId: 'executable-v4-compiled-pass'
  });
  assert.equal(evaluatorTamper.status, 'BLOCKED');
  assert.equal(evaluatorTamper.reasonCode, 'CANARY_EVALUATOR_ARTIFACT_INVALID');
  store.writeArtifact(
    'executable-v4-compiled-pass',
    evaluatorRef,
    evaluatorArtifact
  );

  const candidate = store.readArtifact(
    'executable-v4-compiled-pass',
    routed.candidateArtifactRef
  );
  store.writeArtifact('executable-v4-compiled-pass', routed.candidateArtifactRef, {
    ...candidate,
    content: `${candidate.content}\n// import-tamper`
  });
  const tampered = engine.operator.importAdaptiveExecutableCanary({
    canaryHome: home,
    canaryRunId: 'executable-v4-compiled-pass'
  });
  assert.equal(tampered.status, 'BLOCKED');
  assert.equal(tampered.code, 'ADAPTIVE_CANARY_IMPORT_REFUSED');
  assert.equal(tampered.reasonCode, 'CANARY_VERIFICATION_FAILED');
});

test('V4 refuses a rehashed schema-matched sham that does not replay', {
  skip: !isDarwin
}, () => {
  const config = fixtureConfig({ v4: true });
  const sham = config.mechanismContext.shamCapsule;
  sham.items[0].causalFingerprint.program.rules[0].when.right.value = 'permit';
  const payload = { ...sham };
  delete payload.mechanismCapsuleSha256;
  sham.mechanismCapsuleSha256 = sha256(canonicalAdaptiveJson(payload));
  config.preflight = computeExecutableCanaryPreflight(config);
  config.approvedPlanSha256 = buildAdaptiveExecutableCanaryPlan(config).sha256;

  const validation = validateAdaptiveExecutableCanaryConfig(config);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes('V4 sham capsule does not replay'));
});

test('V4 counts pairwise target regressions even when the baseline is incomplete', () => {
  const calls = Array.from({ length: 5 }, (_, index) => ({
    stage: 'qualification',
    taskId: `qualification-${index}`,
    armRole: 'baseline',
    targetQuality: 1,
    controlQuality: 0
  }));
  for (let index = 0; index < 5; index++) {
    const taskId = `confirmation-${index}`;
    calls.push(
      {
        stage: 'confirmation',
        taskId,
        armRole: 'baseline',
        targetQuality: 0.666667,
        controlQuality: 1
      },
      {
        stage: 'confirmation',
        taskId,
        armRole: 'routed',
        targetQuality: 0.333333,
        controlQuality: 1
      },
      {
        stage: 'confirmation',
        taskId,
        armRole: 'sham',
        targetQuality: 0.666667,
        controlQuality: 1
      }
    );
  }
  const outcome = evaluateAdaptiveExecutableCanaryOutcome(calls, {
    terminalStatus: 'QUEUE_DRAINED',
    profile: ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4
  });

  assert.equal(outcome.status, 'NO_CAUSAL_LIFT');
  assert.equal(outcome.routedTargetRegressions, 5);
  assert.deepEqual(outcome.routedPairwise.target, {
    improved: 0,
    matched: 0,
    regressed: 5
  });
  assert.deepEqual(outcome.routedPairwise.control, {
    improved: 0,
    matched: 5,
    regressed: 0
  });
  assert.match(outcome.reasons.join('\n'), /target quality below its paired baseline/);
});

test('executable canary proves routed causal lift with hidden deterministic tests', {
  skip: !isDarwin
}, () => {
  const { store } = freshEngine();
  const config = fixtureConfig();
  const result = runAdaptiveExecutableCanary(store, config, {
    runId: 'executable-causal-pass',
    worker: causalWorker(config)
  });
  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.causalPass, true, JSON.stringify(result.outcome, null, 2));
  assert.equal(result.outcome.status, 'PASS');
  assert.equal(result.outcome.confirmationBaselineFailures, 5);
  assert.equal(result.outcome.routedPairedWins, 5);
  assert.equal(result.outcome.shamPairedWins, 0);
  assert.equal(result.outcome.routedControlFailures, 0);
  const state = store.load('executable-causal-pass');
  assert.equal(state.calls.length, ADAPTIVE_EXECUTABLE_CANARY.maximumCalls);
  assert.equal(state.verdictEvents.length, ADAPTIVE_EXECUTABLE_CANARY.maximumCalls);
  assert.ok(state.verdictEvents.every((event) => event.attempt === 0));
  for (const call of state.calls) {
    const prompt = store.readArtifact(
      'executable-causal-pass',
      call.promptArtifactRef
    );
    assert.doesNotMatch(
      prompt.content,
      /\b(?:benchmark|hidden cases|experiment|arm|score)\b/i
    );
  }
  const verified = verifyAdaptiveExecutableCanaryRun(
    store,
    'executable-causal-pass'
  );
  assert.equal(verified.experimentValid, true, verified.reasons.join('\n'));
  assert.equal(verified.causalPass, true);
  assert.equal(verified.gates.treatmentParity, true);
  assert.equal(verified.gates.privateEvidenceWithheld, true);
  assert.equal(verified.gates.measurementDerivation, true);
});

test('executable canary stops after headroom becomes mathematically impossible', {
  skip: !isDarwin
}, () => {
  const { store } = freshEngine();
  const config = fixtureConfig();
  const result = runAdaptiveExecutableCanary(store, config, {
    runId: 'executable-no-headroom',
    worker: causalWorker(config, { baselineSolves: true })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true, result.verification.reasons.join('\n'));
  assert.equal(result.causalPass, false);
  assert.equal(result.outcome.status, 'NO_HEADROOM');
  const state = store.load('executable-no-headroom');
  assert.equal(state.calls.length, 3);
  assert.equal(state.qualification.stoppedAfterCalls, 3);
  assert.ok(state.calls.every((call) => call.stage === 'qualification'));
  assert.equal(result.verification.gates.schedule, true);
});

test('independent executable verifier rejects candidate artifact tampering', {
  skip: !isDarwin
}, () => {
  const { store } = freshEngine();
  const config = fixtureConfig();
  const result = runAdaptiveExecutableCanary(store, config, {
    runId: 'executable-tamper',
    worker: causalWorker(config)
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('executable-tamper');
  const call = state.calls.find((item) => item.armRole === 'routed');
  const candidate = store.readArtifact(
    'executable-tamper',
    call.candidateArtifactRef
  );
  store.writeArtifact('executable-tamper', call.candidateArtifactRef, {
    ...candidate,
    content: `${candidate.content}\n// tampered`
  });
  const verified = verifyAdaptiveExecutableCanaryRun(
    store,
    'executable-tamper'
  );
  assert.equal(verified.experimentValid, false);
  assert.equal(verified.gates.artifactHashes, false);
  assert.equal(verified.gates.measurementDerivation, false);
});

test('failed runtime calls remain counted, hash-bound, and zero-retry', {
  skip: !isDarwin
}, () => {
  const { store } = freshEngine();
  const config = fixtureConfig({ v2: true });
  const result = runAdaptiveExecutableCanary(store, config, {
    runId: 'executable-runtime-failure',
    worker: failedPacket
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'REPAIR_OUTPUT_INVALID');
  assert.match(result.message, /EXEC_FAILED/);

  const verification = result.verification;
  assert.equal(verification.experimentValid, false);
  assert.equal(verification.gates.schedule, true);
  assert.equal(verification.gates.noRetries, true);
  assert.equal(verification.gates.failureEvidenceIntegrity, true);
  assert.equal(verification.gates.artifactHashes, true);
  assert.equal(verification.gates.promptBinding, true);
  assert.equal(verification.gates.treatmentBinding, true);
  assert.equal(verification.gates.modelAuthority, true);
  assert.equal(verification.gates.stateConsistency, false);
  assert.equal(verification.tokenUsage.observedCalls, 1);
  assert.equal(verification.tokenUsage.measuredCalls, 0);
  assert.equal(verification.tokenUsage.unmeasuredCalls, 1);
  assert.equal(verification.tokenUsage.total, null);
  assert.equal(verification.tokenUsage.failedDispatchTotal, null);
  assert.equal(verification.outcome.status, 'INCOMPLETE');
  assert.equal(verification.failedReceipts.length, 1);
  assert.equal(verification.failedReceipts[0].execReason, 'EXEC_FAILED');
  assert.equal(verification.failedReceipts[0].exitCode, 1);

  const state = store.load('executable-runtime-failure');
  assert.equal(state.calls.length, 0);
  assert.equal(state.verdictEvents.length, 1);
  assert.equal(state.failureEvidence.length, 1);
  const failed = state.failureEvidence[0];
  const artifact = store.readArtifact(
    'executable-runtime-failure',
    failed.stdout.artifactRef
  );
  store.writeArtifact(
    'executable-runtime-failure',
    failed.stdout.artifactRef,
    { ...artifact, content: `${artifact.content}\nTAMPERED` }
  );
  const tampered = verifyAdaptiveExecutableCanaryRun(
    store,
    'executable-runtime-failure'
  );
  assert.equal(tampered.gates.failureEvidenceIntegrity, false);
  assert.equal(tampered.gates.artifactHashes, false);
});
