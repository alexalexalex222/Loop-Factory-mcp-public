import { sha256 } from '../../src/util.mjs';

const ARM_ORDER = ['baseline', 'challenger', 'sham'];
const SCHEDULE = [
  ['baseline', 'challenger', 'sham'],
  ['challenger', 'sham', 'baseline'],
  ['sham', 'baseline', 'challenger'],
  ['baseline', 'sham', 'challenger'],
  ['challenger', 'baseline', 'sham']
];

function receipt(seed, tokenCost, overrides = {}) {
  return {
    model: 'gpt-5.6-sol',
    requestedModel: 'gpt-5.6-sol',
    reportedModel: null,
    binaryFamily: 'codex',
    argv: ['exec', '-m', 'gpt-5.6-sol', '/Users/operator/private/PROMPT_SECRET'],
    modelSelectionAuthority: 'explicit-model-flag',
    modelIdentityAuthority: 'explicit-model-flag',
    reportedModelMatchesRequest: null,
    strictIsolation: true,
    disabledFeatures: ['skills', 'memories'],
    workspaceRoot: '/Users/operator/private/workspace',
    outputSchemaSha256: sha256('evaluation-schema'),
    rawResultSha256: sha256(`raw-${seed}`),
    resultNormalization: 'case-results-v2',
    cliReportedTotalTokens: tokenCost,
    cliReportedTokenUsage: {
      inputTokens: tokenCost - 400,
      outputTokens: 400,
      totalTokens: tokenCost
    },
    durationMs: 12000 + seed * 100,
    exitCode: 0,
    stdoutSha256: sha256(`stdout-${seed}`),
    resultSha256: sha256(`result-${seed}`),
    isolation: { status: 'PASS', toolCalls: [] },
    env: { PRIVATE_ENV: 'ENV_SECRET' },
    prompt: 'PROMPT_SECRET',
    procedure: 'PROCEDURE_SECRET',
    ...overrides
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function canaryState({
  target = {
    baseline: [0, 0, 0, 0, 0],
    challenger: [0.6667, 0.3333, 0.3333, 0.3333, 0.6667],
    sham: [0, 0, 0, 0, 0]
  },
  control = {
    baseline: [1, 1, 1, 1, 1],
    challenger: [1, 1, 1, 1, 1],
    sham: [1, 1, 1, 1, 1]
  },
  tokenBase = {
    baseline: 27340,
    challenger: 27800,
    sham: 27420
  },
  includeEvaluations = true,
  experimentValid = true,
  verificationStatus = experimentValid ? 'PASS' : 'FAIL',
  outcomeStatus = 'PASS',
  promotionEnabled = false,
  promotionRecorded = false,
  gateOverrides = {},
  receiptOverrides = {}
} = {}) {
  let seed = 1;
  const evaluations = includeEvaluations
    ? SCHEDULE.flatMap((row, replicate) => row.map((armRole, position) => {
        const tokenCost = tokenBase[armRole] + replicate * 10 + position;
        const record = {
          ...receipt(seed, tokenCost, receiptOverrides),
          armRole,
          blindArm: `arm-${sha256(armRole).slice(0, 12)}`,
          replicate,
          position,
          procedureSha256: sha256(`procedure-${armRole}`),
          tokenCost,
          quality: (target[armRole][replicate] + control[armRole][replicate]) / 2,
          targetQuality: target[armRole][replicate],
          controlQuality: control[armRole][replicate],
          measurementRef: `eval-r${replicate + 1}-p${position + 1}-evaluation`,
          evaluationArtifactRef: `eval-r${replicate + 1}-p${position + 1}-evaluation`,
          rawArtifactRef: `eval-r${replicate + 1}-p${position + 1}-raw`,
          resultArtifactRef: `eval-r${replicate + 1}-p${position + 1}-final`
        };
        seed += 1;
        return record;
      }))
    : [];
  const pairedTargetWins = includeEvaluations
    ? target.challenger.filter((value, index) => value > target.baseline[index]).length
    : 0;
  const shamWins = includeEvaluations
    ? target.sham.filter((value, index) => value > target.baseline[index]).length
    : 0;
  const controlRegressions = includeEvaluations
    ? control.challenger.filter((value, index) => value < control.baseline[index]).length
    : 0;
  const gates = {
    scorerFixtures: experimentValid,
    receipts: experimentValid,
    isolation: experimentValid,
    schemaIdentity: experimentValid,
    stateConsistency: experimentValid,
    ...gateOverrides
  };
  const series = Object.fromEntries(ARM_ORDER.map((armRole) => [
    armRole,
    evaluations
      .filter((item) => item.armRole === armRole)
      .sort((a, b) => a.replicate - b.replicate)
      .map((item) => ({
        targetQuality: item.targetQuality,
        controlQuality: item.controlQuality,
        tokenCost: item.tokenCost,
        artifactRef: item.evaluationArtifactRef
      }))
  ]));
  const outcome = {
    status: outcomeStatus,
    promotionEnabled: false,
    seriesValid: includeEvaluations,
    pairedTargetWins,
    shamWins,
    controlRegressions,
    failedGates: Object.entries(gates).filter(([, passed]) => passed !== true).map(([name]) => name),
    reasons: []
  };
  const proposal = receipt(0, 28368, {
    outputSchemaSha256: sha256('proposal-schema'),
    rawArtifactRef: 'proposal-raw',
    resultArtifactRef: 'proposal-final',
    procedureSha256: sha256('proposal-procedure')
  });
  return {
    schemaVersion: 1,
    kind: 'real-test-canary',
    runId: 'canary-ui-fixture',
    createdAt: '2026-07-20T10:01:43.977Z',
    updatedAt: '2026-07-20T10:05:48.826Z',
    completedAt: '2026-07-20T10:05:48.826Z',
    status: 'QUEUE_DRAINED',
    model: 'gpt-5.6-sol',
    approvedPlanSha256: sha256('approved-plan'),
    plan: {
      schemaVersion: 1,
      profile: 'one-finding-three-arm-canary',
      model: 'gpt-5.6-sol',
      findingId: 'finding-001',
      baselineSha256: sha256('baseline'),
      hypothesisSha256: sha256('hypothesis'),
      shamSha256: sha256('sham'),
      benchmarkSha256: sha256('benchmark'),
      evidenceRefs: [{ path: '/Users/operator/private/source.mjs', locator: 'PROCEDURE_SECRET' }],
      evidenceManifest: [{
        path: '/Users/operator/private/source.mjs',
        bytes: 120,
        sha256: sha256('source')
      }],
      routes: ['gpt-5.6-sol'],
      contract: {
        maxFindings: 1,
        realHypotheses: 1,
        replicatesPerArm: 5,
        minCases: 6,
        maxCases: 10,
        arms: ARM_ORDER,
        blinded: true,
        retriesPerDispatch: 0,
        promotionEnabled: false,
        blindLabels: Object.fromEntries(ARM_ORDER.map((armRole) => [
          armRole,
          `arm-${sha256(armRole).slice(0, 12)}`
        ])),
        schedule: SCHEDULE
      },
      sha256: sha256('approved-plan')
    },
    benchmark: {
      name: 'PRIVATE_BENCHMARK_NAME',
      cases: [{ id: 'case-1', prompt: 'BENCHMARK_PROMPT_SECRET' }],
      oracle: {
        kind: 'case-results-v2',
        passMark: 1,
        cases: []
      },
      negativeControl: {
        content: 'NEGATIVE_CONTROL_SECRET',
        passMark: 1
      }
    },
    evidenceManifest: [{
      path: '/Users/operator/private/source.mjs',
      bytes: 120,
      sha256: sha256('source')
    }],
    evidenceArtifacts: {
      benchmark: { id: 'frozen-benchmark', sha256: sha256('benchmark-artifact') },
      capsule: { id: 'sealed-evidence-capsule', sha256: sha256('capsule-artifact') }
    },
    target: {
      findingId: 'finding-001',
      baselineSha256: sha256('baseline'),
      shamSha256: sha256('sham'),
      hypothesisSha256: sha256('hypothesis')
    },
    proposal,
    evaluations,
    verdictEvents: [
      {
        kind: 'proposal',
        accepted: true,
        reasons: [],
        attempt: 0,
        invocation: proposal
      },
      ...evaluations.map((item) => ({
        kind: 'evaluation',
        armRole: item.armRole,
        blindArm: item.blindArm,
        replicate: item.replicate,
        position: item.position,
        accepted: item.exitCode === 0,
        reasons: item.exitCode === 0 ? [] : ['WORKER_FAILED'],
        attempt: 0,
        invocation: item
      }))
    ],
    promotion: {
      enabled: promotionEnabled,
      recorded: promotionRecorded
    },
    verification: {
      schemaVersion: 1,
      runId: 'canary-ui-fixture',
      status: verificationStatus,
      experimentValid,
      gates,
      armCounts: Object.fromEntries(ARM_ORDER.map((armRole) => [
        armRole,
        evaluations.filter((item) => item.armRole === armRole).length
      ])),
      series,
      outcome,
      failedReceipts: [],
      reasons: experimentValid ? [] : ['PRIVATE_VERIFIER_REASON'],
      evidenceSha256: sha256('verification')
    },
    outcome,
    blocker: null,
    reportPath: '/Users/operator/private/canary-report.md',
    workspaceRoot: '/Users/operator/private/workspace',
    userMessages: ['USER_MESSAGE_SECRET'],
    summary: {
      challengerTargetMean: mean(target.challenger),
      privateProcedure: 'PROCEDURE_SECRET'
    }
  };
}

export function historicalBlockedCanaryState() {
  const reasons = [
    'SUMMARY_ONLY',
    'MISSING_ARTIFACTS',
    'MISSING_EVIDENCE',
    'NO_COMPARABLE_OUTPUT',
    'PHASE_SKIP',
    'ISOLATION_VIOLATION',
    'WRONG_PHASE_OUTPUT'
  ];
  const state = canaryState({
    includeEvaluations: false,
    experimentValid: false,
    verificationStatus: 'FAIL',
    outcomeStatus: 'FAIL'
  });
  state.runId = 'submission-canary-20260720-final';
  state.status = 'BLOCKED';
  state.proposal = null;
  state.verdictEvents = [{
    kind: 'proposal',
    accepted: false,
    reasons,
    attempt: 0,
    invocation: null
  }];
  state.verification.failedReceipts = [{ kind: 'proposal', reasons }];
  state.blocker = {
    code: 'PROPOSAL_INVALID',
    message: 'PRIVATE_HISTORICAL_BLOCKER_PROSE'
  };
  delete state.failureEvidence;
  return state;
}
