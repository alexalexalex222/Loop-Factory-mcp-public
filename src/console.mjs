// Public operational view for the local Campaign Console.
//
// This is an allowlist serializer, not a clone-and-redact pass. Arbitrary operator
// text, model output, prompts, artifact bodies, trajectory args/results, environment
// values, notes, loop content, and filesystem paths never enter the returned object.
import { buildScoreMatrix } from './scorecard.mjs';
import { STOP_CONDITION_WARNING } from './constants.mjs';
import { isSafeId } from './util.mjs';
import { isDeterministicOracle } from './measure.mjs';
import { reviewDecisionBinding } from './review-decisions.mjs';

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;
const ROUTE_RE = /^[a-z0-9][a-z0-9._+:/-]{0,119}$/i;
const ARG_RE = /^(?:--?[a-z0-9][a-z0-9._-]{0,79}|[a-z0-9][a-z0-9._+=:/-]{0,159})$/i;
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const AUTHORITY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CANARY_ARMS = ['baseline', 'challenger', 'sham'];
const CANARY_GATE_LABELS = {
  scorerFixtures: 'Scorer fixtures',
  receipts: 'Invocation receipts',
  isolation: 'Context isolation',
  schemaIdentity: 'Schema identity',
  stateConsistency: 'State consistency'
};

function text(value, max = 120) {
  const s = String(value == null ? '' : value).trim();
  return s && !/[\0\r\n]/.test(s) ? s.slice(0, max) : null;
}

function id(value) {
  const s = text(value, 120);
  return s && isSafeId(s) ? s : null;
}

function route(value) {
  const s = text(value, 120);
  return s && ROUTE_RE.test(s) && !s.startsWith('/') && !s.includes('..') ? s : null;
}

function code(value) {
  const s = text(value, 64);
  return s && CODE_RE.test(s) ? s : null;
}

function authority(value) {
  const s = text(value, 64);
  return s && AUTHORITY_RE.test(s) ? s : null;
}

function hash(value) {
  const s = text(value, 64);
  return s && HASH_RE.test(s) ? s.toLowerCase() : null;
}

function finite(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function timestamp(value) {
  const s = text(value, 40);
  return s && /^\d{4}-\d{2}-\d{2}T/.test(s) ? s : null;
}

function safeArg(value) {
  const s = text(value, 160);
  return s && ARG_RE.test(s) && !s.startsWith('/') && !s.includes('..') ? s : '[redacted]';
}

function safeList(values, mapper, max = 20) {
  return (Array.isArray(values) ? values : []).slice(0, max).map(mapper).filter(Boolean);
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function roundNumber(value, decimals = 4) {
  const number = finite(value);
  if (number == null) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function meanNumber(values) {
  const numbers = values.map(finite).filter((value) => value != null);
  if (!numbers.length) return null;
  return roundNumber(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function canaryArm(value) {
  return CANARY_ARMS.includes(value) ? value : null;
}

function canaryReceiptStatus(invocation, accepted) {
  if (!invocation || typeof invocation !== 'object') return 'MISSING';
  const exitCode = integer(invocation.exitCode);
  const resultSha256 = hash(invocation.resultSha256);
  const isolationStatus = code(invocation.isolation && invocation.isolation.status);
  if (accepted === false || (exitCode != null && exitCode !== 0) || isolationStatus === 'FAIL') {
    return 'FAILED';
  }
  if (exitCode === 0 && resultSha256 && isolationStatus === 'PASS') return 'VALID';
  return 'INCOMPLETE';
}

function publicCanaryReceipt(invocation, accepted = null) {
  if (!invocation || typeof invocation !== 'object') {
    return {
      status: 'MISSING',
      requestedModel: null,
      binaryFamily: null,
      modelSelectionAuthority: null,
      modelIdentityAuthority: null,
      reportedModelMatchesRequest: null,
      strictIsolation: null,
      isolationStatus: null,
      durationMs: null,
      exitCode: null,
      cliReportedTotalTokens: null,
      stdoutSha256: null,
      resultSha256: null,
      rawResultSha256: null,
      outputSchemaSha256: null
    };
  }
  return {
    status: canaryReceiptStatus(invocation, accepted),
    requestedModel: route(invocation.requestedModel || invocation.model),
    binaryFamily: text(invocation.binaryFamily, 40),
    modelSelectionAuthority: text(invocation.modelSelectionAuthority, 60),
    modelIdentityAuthority: text(invocation.modelIdentityAuthority, 60),
    reportedModelMatchesRequest: bool(invocation.reportedModelMatchesRequest),
    strictIsolation: bool(invocation.strictIsolation),
    isolationStatus: code(invocation.isolation && invocation.isolation.status),
    durationMs: finite(invocation.durationMs),
    exitCode: integer(invocation.exitCode),
    cliReportedTotalTokens: finite(
      invocation.cliReportedTotalTokens
      ?? (invocation.cliReportedTokenUsage && invocation.cliReportedTokenUsage.totalTokens)
      ?? invocation.tokenUsage
      ?? invocation.tokenCost
    ),
    stdoutSha256: hash(invocation.stdoutSha256),
    resultSha256: hash(invocation.resultSha256),
    rawResultSha256: hash(invocation.rawResultSha256),
    outputSchemaSha256: hash(invocation.outputSchemaSha256)
  };
}

function canaryEventKey(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.kind === 'proposal') return 'proposal';
  const armRole = canaryArm(event.armRole);
  const replicate = integer(event.replicate);
  const position = integer(event.position);
  return armRole && replicate != null && position != null
    ? `${armRole}:${replicate}:${position}`
    : null;
}

function canaryEventMap(state) {
  const events = Array.isArray(state.verdictEvents) ? state.verdictEvents : [];
  const latest = new Map();
  for (const event of events) {
    const key = canaryEventKey(event);
    if (!key) continue;
    const previous = latest.get(key);
    const attempt = integer(event.attempt) ?? 0;
    const previousAttempt = integer(previous && previous.attempt) ?? -1;
    if (!previous || attempt >= previousAttempt) latest.set(key, event);
  }
  return latest;
}

function canaryRetryCount(state) {
  const events = Array.isArray(state.verdictEvents) ? state.verdictEvents : [];
  const attempts = new Map();
  for (const event of events) {
    const key = canaryEventKey(event);
    if (!key) continue;
    attempts.set(key, Math.max(attempts.get(key) || 0, integer(event.attempt) ?? 0));
  }
  return [...attempts.values()].reduce((sum, attempt) => sum + attempt, 0);
}

function publicCanaryFailureStream(value, invocationSha256) {
  const stream = value && typeof value === 'object' ? value : {};
  const artifactId = id(stream.artifactRef || stream.artifactId);
  const sha256 = hash(stream.sha256 || invocationSha256);
  const bytes = integer(stream.bytes);
  const matchesReceipt = bool(stream.matchesReceipt ?? stream.receiptMatch);
  if (!artifactId && !sha256 && bytes == null && matchesReceipt == null) return null;
  return {
    artifactId,
    sha256,
    bytes,
    matchesReceipt
  };
}

function publicCanaryFailure(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = ['proposal', 'evaluation'].includes(value.kind) ? value.kind : null;
  if (!kind) return null;
  const invocationValue = value.invocation && typeof value.invocation === 'object'
    ? value.invocation
    : null;
  const invocation = invocationValue ? {
    exitCode: integer(invocationValue.exitCode),
    requestedModel: route(invocationValue.requestedModel || invocationValue.model),
    reportedModel: route(invocationValue.reportedModel),
    modelSelectionAuthority: authority(invocationValue.modelSelectionAuthority),
    modelIdentityAuthority: authority(
      invocationValue.modelIdentityAuthority || invocationValue.modelSelectionAuthority
    ),
    reportedModelMatchesRequest: bool(invocationValue.reportedModelMatchesRequest)
  } : null;
  const replicateIndex = integer(value.replicate);
  const positionIndex = integer(value.position);
  return {
    kind,
    arm: kind === 'evaluation' ? canaryArm(value.armRole) : null,
    blindArmId: kind === 'evaluation' ? id(value.blindArm) : null,
    replicate: replicateIndex != null && replicateIndex >= 0 ? replicateIndex + 1 : null,
    position: positionIndex != null && positionIndex >= 0 ? positionIndex + 1 : null,
    attempt: integer(value.attempt),
    execReason: code(value.execReason),
    reasons: safeList(value.reasons, code, 12),
    invocation,
    stdout: publicCanaryFailureStream(value.stdout, invocationValue?.stdoutSha256),
    stderr: publicCanaryFailureStream(value.stderr, invocationValue?.stderrSha256),
    rawArtifactId: id(value.rawArtifactRef || value.rawArtifactId),
    resultArtifactId: id(value.resultArtifactRef || value.resultArtifactId)
  };
}

function publicCanaryBlockedState(state) {
  const failures = safeList(state.failureEvidence, publicCanaryFailure, 20);
  const reasonValues = [];
  for (const event of Array.isArray(state.verdictEvents) ? state.verdictEvents : []) {
    if (event && event.accepted === false) reasonValues.push(...(Array.isArray(event.reasons) ? event.reasons : []));
  }
  for (const failure of Array.isArray(state.failureEvidence) ? state.failureEvidence : []) {
    reasonValues.push(...(Array.isArray(failure?.reasons) ? failure.reasons : []));
  }
  for (const failedReceipt of Array.isArray(state.verification?.failedReceipts)
    ? state.verification.failedReceipts
    : []) {
    reasonValues.push(...(Array.isArray(failedReceipt?.reasons) ? failedReceipt.reasons : []));
  }
  const reasons = [...new Set(reasonValues.map(code).filter(Boolean))].slice(0, 20);
  const blockerCode = code(state.blocker?.code);
  const active = blockerCode != null || String(state.status).toUpperCase() === 'BLOCKED';
  const diagnosticsAvailable = failures.some((failure) => Boolean(
    failure.execReason
    || failure.invocation
    || failure.stdout
    || failure.stderr
    || failure.rawArtifactId
    || failure.resultArtifactId
  ));
  return {
    active,
    code: blockerCode,
    reasons,
    failureEvidenceAvailable: failures.length > 0,
    diagnosticsAvailable,
    failures
  };
}

function publicCanaryEvaluation(item, events) {
  if (!item || typeof item !== 'object') return null;
  const armRole = canaryArm(item.armRole);
  const replicateIndex = integer(item.replicate);
  const positionIndex = integer(item.position);
  if (!armRole || replicateIndex == null || positionIndex == null) return null;
  const event = events.get(`${armRole}:${replicateIndex}:${positionIndex}`) || null;
  const evaluationId = id(item.evaluationArtifactRef);
  return {
    id: evaluationId || `evaluation-${armRole}-${replicateIndex + 1}`,
    kind: 'evaluation',
    arm: armRole,
    blindArmId: id(item.blindArm),
    replicate: replicateIndex + 1,
    position: positionIndex + 1,
    targetQuality: finite(item.targetQuality),
    controlQuality: finite(item.controlQuality),
    quality: finite(item.quality),
    tokenCost: finite(item.tokenCost),
    measurementId: id(item.measurementRef),
    evaluationId,
    procedureSha256: hash(item.procedureSha256),
    accepted: event ? event.accepted === true : null,
    reasons: safeList(event && event.reasons, code, 8),
    receipt: publicCanaryReceipt(item, event ? event.accepted === true : null)
  };
}

function publicCanaryArms(evaluations, expectedReplicates) {
  const summaries = CANARY_ARMS.map((armRole) => {
    const replicates = evaluations
      .filter((item) => item.arm === armRole)
      .sort((a, b) => a.replicate - b.replicate);
    return {
      role: armRole,
      label: armRole[0].toUpperCase() + armRole.slice(1),
      count: replicates.length,
      expectedReplicates,
      targetMean: meanNumber(replicates.map((item) => item.targetQuality)),
      controlMean: meanNumber(replicates.map((item) => item.controlQuality)),
      tokenMean: meanNumber(replicates.map((item) => item.tokenCost)),
      durationMeanMs: meanNumber(replicates.map((item) => item.receipt.durationMs)),
      replicates
    };
  });
  const baseline = summaries.find((arm) => arm.role === 'baseline');
  return summaries.map((arm) => ({
    ...arm,
    targetDeltaVsBaseline: arm.targetMean != null && baseline?.targetMean != null
      ? roundNumber(arm.targetMean - baseline.targetMean)
      : null,
    controlDeltaVsBaseline: arm.controlMean != null && baseline?.controlMean != null
      ? roundNumber(arm.controlMean - baseline.controlMean)
      : null,
    tokenDeltaPctVsBaseline: arm.tokenMean != null && baseline?.tokenMean
      ? roundNumber((arm.tokenMean - baseline.tokenMean) / baseline.tokenMean)
      : null
  }));
}

function pairedCanaryProof(arms, expectedReplicates) {
  const byRole = Object.fromEntries(arms.map((arm) => [
    arm.role,
    new Map(arm.replicates.map((item) => [item.replicate, item]))
  ]));
  let pairedComparisons = 0;
  let pairedTargetWins = 0;
  let shamWins = 0;
  let controlRegressions = 0;
  for (let replicate = 1; replicate <= expectedReplicates; replicate++) {
    const baseline = byRole.baseline.get(replicate);
    const challenger = byRole.challenger.get(replicate);
    const sham = byRole.sham.get(replicate);
    if (!baseline || !challenger || !sham) continue;
    if (![baseline.targetQuality, challenger.targetQuality, sham.targetQuality,
      baseline.controlQuality, challenger.controlQuality].every((value) => value != null)) continue;
    pairedComparisons += 1;
    if (challenger.targetQuality > baseline.targetQuality) pairedTargetWins += 1;
    if (sham.targetQuality > baseline.targetQuality) shamWins += 1;
    if (challenger.controlQuality < baseline.controlQuality) controlRegressions += 1;
  }
  return {
    pairedComparisons,
    pairedTargetWins,
    shamWins,
    controlRegressions,
    seriesValid: pairedComparisons === expectedReplicates
      && arms.every((arm) => arm.count === expectedReplicates)
  };
}

function canaryPercent(value) {
  return value == null ? 'unavailable' : `${(value * 100).toFixed(1)}%`;
}

function canaryVerdict({
  experimentValid,
  seriesValid,
  pairedTargetWins,
  expectedReplicates,
  shamWins,
  controlRegressions,
  challengerTargetMean,
  promotionRecorded
}) {
  const causalMovement = experimentValid
    && seriesValid
    && pairedTargetWins >= Math.max(1, expectedReplicates - 1)
    && shamWins === 0
    && controlRegressions === 0;
  if (!experimentValid) {
    return {
      status: 'FAIL',
      headline: 'Experiment validity failed',
      qualifier: 'The causal claim is blocked until every independent verification gate passes.',
      limitation: 'Persisted receipts, isolation, schema identity, scorer fixtures, and state consistency must all verify.',
      causalMovement: false,
      experimentValid: false,
      shamMoved: shamWins > 0,
      controlsRegressed: controlRegressions > 0,
      promoted: promotionRecorded
    };
  }
  if (!seriesValid) {
    return {
      status: 'INCOMPLETE',
      headline: 'Canary evidence is incomplete',
      qualifier: 'The causal claim is blocked until all paired baseline, challenger, and sham replicates are present.',
      limitation: `Only ${pairedTargetWins} challenger target win(s) can be compared across ${expectedReplicates} planned replicates.`,
      causalMovement: false,
      experimentValid: true,
      shamMoved: shamWins > 0,
      controlsRegressed: controlRegressions > 0,
      promoted: promotionRecorded
    };
  }
  if (shamWins > 0) {
    return {
      status: 'FAIL',
      headline: 'Sham movement blocks attribution',
      qualifier: `The irrelevant-edit sham beat baseline in ${shamWins} paired replicate(s).`,
      limitation: 'The harness remains sensitive to non-causal edits, so challenger movement cannot be attributed cleanly.',
      causalMovement: false,
      experimentValid: true,
      shamMoved: true,
      controlsRegressed: controlRegressions > 0,
      promoted: promotionRecorded
    };
  }
  if (controlRegressions > 0) {
    return {
      status: 'FAIL',
      headline: 'Control regression blocks the win',
      qualifier: `The challenger regressed control quality in ${controlRegressions} paired replicate(s).`,
      limitation: 'Target movement is not accepted when protected controls move backward.',
      causalMovement: false,
      experimentValid: true,
      shamMoved: false,
      controlsRegressed: true,
      promoted: promotionRecorded
    };
  }
  if (!causalMovement) {
    return {
      status: 'FAIL',
      headline: 'No reliable causal win established',
      qualifier: `The challenger beat baseline in ${pairedTargetWins} of ${expectedReplicates} paired target evaluations.`,
      limitation: `The canary requires at least ${Math.max(1, expectedReplicates - 1)} paired target wins with no sham movement or control regression.`,
      causalMovement: false,
      experimentValid: true,
      shamMoved: false,
      controlsRegressed: false,
      promoted: promotionRecorded
    };
  }
  const targetComplete = challengerTargetMean != null && challengerTargetMean >= 1;
  return {
    status: 'PASS',
    headline: 'Challenger causally beat baseline',
    qualifier: targetComplete
      ? `Causal movement detected; mean target accuracy reached ${canaryPercent(challengerTargetMean)}.`
      : `Causal movement detected; target accuracy remains partial at ${canaryPercent(challengerTargetMean)}.`,
    limitation: targetComplete
      ? 'This canary establishes movement for one sealed finding only; it does not establish broad generalization.'
      : `The challenger won ${pairedTargetWins} of ${expectedReplicates} paired target evaluations, but mean target quality did not reach 100%.`,
    causalMovement: true,
    experimentValid: true,
    shamMoved: false,
    controlsRegressed: false,
    promoted: promotionRecorded
  };
}

function blockedCanaryVerdict(blocked, promotionRecorded) {
  return {
    status: 'BLOCKED',
    headline: 'Launch blocked before causal evidence',
    qualifier: `${blocked.code || 'BLOCKED'} stopped the canary before an independently valid causal series was established.`,
    limitation: blocked.diagnosticsAvailable
      ? 'Failure evidence is available as allowlisted metadata and hashes; raw stdout and stderr remain private.'
      : 'Diagnostics unavailable for this historical failure.',
    causalMovement: false,
    experimentValid: false,
    shamMoved: false,
    controlsRegressed: false,
    promoted: promotionRecorded
  };
}

function publicCanaryHashes(state) {
  const hashes = [];
  const add = (idValue, label, sha256Value, bytesValue = null) => {
    const digest = hash(sha256Value);
    if (!digest) return;
    hashes.push({
      id: idValue,
      label,
      sha256: digest,
      bytes: integer(bytesValue)
    });
  };
  add('approved-plan', 'Approved plan', state.approvedPlanSha256 || state.plan?.sha256);
  add('verification', 'Independent verification', state.verification?.evidenceSha256);
  add('benchmark', 'Frozen benchmark', state.evidenceArtifacts?.benchmark?.sha256);
  add('capsule', 'Sealed evidence capsule', state.evidenceArtifacts?.capsule?.sha256);
  add('baseline', 'Baseline procedure', state.target?.baselineSha256 || state.plan?.baselineSha256);
  add('challenger', 'Challenger hypothesis', state.target?.hypothesisSha256 || state.plan?.hypothesisSha256);
  add('sham', 'Sham procedure', state.target?.shamSha256 || state.plan?.shamSha256);
  (Array.isArray(state.evidenceManifest) ? state.evidenceManifest : []).slice(0, 20)
    .forEach((item, index) => add(`evidence-source-${index + 1}`, `Evidence source ${index + 1}`, item?.sha256, item?.bytes));
  return hashes;
}

function buildCanaryConsoleSnapshot(state) {
  const events = canaryEventMap(state);
  const contract = state.plan && state.plan.contract && typeof state.plan.contract === 'object'
    ? state.plan.contract
    : {};
  const expectedReplicates = integer(contract.replicatesPerArm) ?? 5;
  const evaluations = (Array.isArray(state.evaluations) ? state.evaluations : [])
    .map((item) => publicCanaryEvaluation(item, events))
    .filter(Boolean);
  const arms = publicCanaryArms(evaluations, expectedReplicates);
  const paired = pairedCanaryProof(arms, expectedReplicates);
  const proposalEvent = events.get('proposal') || null;
  const proposalReceipt = state.proposal ? {
    id: 'proposal',
    kind: 'proposal',
    arm: null,
    replicate: null,
    position: null,
    targetQuality: null,
    controlQuality: null,
    tokenCost: finite(
      state.proposal.cliReportedTotalTokens
      ?? (state.proposal.cliReportedTokenUsage && state.proposal.cliReportedTokenUsage.totalTokens)
      ?? state.proposal.tokenUsage
    ),
    measurementId: null,
    evaluationId: null,
    procedureSha256: hash(state.proposal.procedureSha256),
    accepted: proposalEvent ? proposalEvent.accepted === true : null,
    reasons: safeList(proposalEvent && proposalEvent.reasons, code, 8),
    receipt: publicCanaryReceipt(state.proposal, proposalEvent ? proposalEvent.accepted === true : null)
  } : null;
  const receipts = [
    ...(proposalReceipt ? [proposalReceipt] : []),
    ...evaluations
  ];
  const validReceipts = receipts.filter((item) => item.receipt.status === 'VALID').length;
  const failedReceipts = receipts.filter((item) => item.receipt.status === 'FAILED').length;
  const incompleteReceipts = receipts.filter((item) => ['MISSING', 'INCOMPLETE'].includes(item.receipt.status)).length;
  const isolationStatuses = receipts.map((item) => item.receipt.isolationStatus).filter(Boolean);
  const isolationStatus = isolationStatuses.includes('FAIL')
    ? 'FAIL'
    : (receipts.length > 0 && isolationStatuses.length === receipts.length
      && isolationStatuses.every((status) => status === 'PASS') ? 'PASS' : 'UNKNOWN');
  const rawGates = state.verification && state.verification.gates && typeof state.verification.gates === 'object'
    ? state.verification.gates
    : {};
  const gates = Object.entries(CANARY_GATE_LABELS).map(([gateId, label]) => ({
    id: gateId,
    label,
    status: rawGates[gateId] === true ? 'PASS' : (rawGates[gateId] === false ? 'FAIL' : 'UNKNOWN')
  }));
  const experimentValid = state.verification?.experimentValid === true;
  const challenger = arms.find((arm) => arm.role === 'challenger');
  const promotionEnabled = state.promotion?.enabled === true;
  const promotionRecorded = state.promotion?.recorded === true;
  const blocked = publicCanaryBlockedState(state);
  const verdict = blocked.active
    ? blockedCanaryVerdict(blocked, promotionRecorded)
    : canaryVerdict({
        experimentValid,
        seriesValid: paired.seriesValid,
        pairedTargetWins: paired.pairedTargetWins,
        expectedReplicates,
        shamWins: paired.shamWins,
        controlRegressions: paired.controlRegressions,
        challengerTargetMean: challenger?.targetMean ?? null,
        promotionRecorded
      });
  const model = route(state.model || state.plan?.model || state.proposal?.requestedModel);
  return {
    schemaVersion: 2,
    kind: 'real-test-canary',
    generatedAt: timestamp(state.updatedAt),
    stopCondition: STOP_CONDITION_WARNING,
    run: {
      id: id(state.runId),
      status: text(state.status, 40),
      createdAt: timestamp(state.createdAt),
      updatedAt: timestamp(state.updatedAt),
      completedAt: timestamp(state.completedAt),
      mode: 'canary',
      runMode: 'real-test-canary',
      activeLoop: null,
      parentRunId: null,
      model
    },
    policy: {
      source: 'canary-plan',
      primary: model,
      testRoutes: model ? [model] : [],
      builderRoutes: model ? [model] : [],
      judgeRoute: model,
      banlist: {
        mode: 'strict',
        extraAllowCount: 0,
        extraDenyCount: 0
      },
      allowUnknownFrontier: false
    },
    intake: {
      answerSources: { operator: 0, config: 0, default: 0 }
    },
    continuation: {
      required: false,
      id: null,
      since: null,
      source: null,
      inProgress: false,
      nextTool: null
    },
    failures: {
      consecutive: 0,
      total: failedReceipts,
      patience: 0,
      retirementBatches: 0,
      exhaustionFlagged: false
    },
    loops: [],
    campaign: {
      activeLaneId: null,
      lanes: [],
      transitions: []
    },
    evidence: {
      baselineLocked: Boolean(hash(state.target?.baselineSha256 || state.plan?.baselineSha256)),
      baselineSha256: hash(state.target?.baselineSha256 || state.plan?.baselineSha256),
      benchmarkFrozen: Boolean(hash(state.evidenceArtifacts?.benchmark?.sha256)),
      benchmarkSource: 'sealed-canary',
      benchmarkPartition: null,
      benchmarkCases: Array.isArray(state.benchmark?.cases) ? state.benchmark.cases.length : 0,
      deterministicOracle: isDeterministicOracle(state.benchmark?.oracle),
      routeIndependenceRequired: state.benchmark?.routeIndependence === 'required',
      requiredRoutes: integer(state.benchmark?.requiredRoutes),
      integrityOverrideCount: 0,
      negativeControl: null,
      baselineQuality: arms.find((arm) => arm.role === 'baseline')?.targetMean ?? null,
      baselineArtifactOutputTokenEstimate: null,
      baselineCliReceiptTokenCost: arms.find((arm) => arm.role === 'baseline')?.tokenMean ?? null,
      baselineQualityAuthority: 'machine-verifier',
      baselineSamples: arms.find((arm) => arm.role === 'baseline')?.count ?? 0,
      baselineStdevQuality: null,
      observations: evaluations.length,
      artifacts: receipts.length,
      evidencedPhases: 0
    },
    scoreMatrix: [],
    verdicts: [],
    activity: [],
    reviews: {
      pending: 0,
      approved: 0,
      sludge: 0,
      items: []
    },
    promotions: [],
    realTest: { enabled: false },
    canary: {
      enabled: true,
      contract: {
        profile: text(state.plan?.profile, 60),
        expectedArms: CANARY_ARMS.length,
        replicatesPerArm: expectedReplicates,
        plannedEvaluations: CANARY_ARMS.length * expectedReplicates,
        blinded: contract.blinded === true,
        concealment: contract.blinded === true ? 'ARM_CONCEALED' : 'OPEN',
        retriesPerDispatch: integer(contract.retriesPerDispatch) ?? 0,
        promotionEnabled: contract.promotionEnabled === true
      },
      verdict,
      blocked,
      proof: {
        ...paired,
        callCount: receipts.length,
        validReceipts,
        failedReceipts,
        incompleteReceipts,
        retryCount: canaryRetryCount(state),
        isolationStatus,
        verifierStatus: code(state.verification?.status) || 'UNKNOWN',
        experimentValid,
        promotionEnabled,
        promotionRecorded,
        reportedOutcomeStatus: code(state.verification?.outcome?.status || state.outcome?.status) || 'UNKNOWN'
      },
      arms,
      gates,
      hashes: publicCanaryHashes(state),
      receipts,
      proposal: proposalReceipt,
      updatedAt: timestamp(state.updatedAt)
    }
  };
}

function publicPolicy(state) {
  const policy = state?.config?.modelPolicy || {};
  const banlist = policy.banlist || {};
  return {
    source: text(policy.source, 80),
    primary: route(policy.primary),
    testRoutes: safeList(policy.testRoutes, route, 8),
    builderRoutes: safeList(policy.builderRoutes, route, 8),
    judgeRoute: route(policy.judgeRoute),
    banlist: {
      mode: ['default', 'strict', 'off'].includes(banlist.mode) ? banlist.mode : 'default',
      extraAllowCount: Array.isArray(banlist.extraAllow) ? banlist.extraAllow.length : 0,
      extraDenyCount: Array.isArray(banlist.extraDeny) ? banlist.extraDeny.length : 0
    },
    allowUnknownFrontier: policy.allowUnknownFrontier !== false
  };
}

function publicLoops(state) {
  return Object.entries(state.loops || {}).map(([loopId, loop]) => {
    const evidence = loop && loop.evidence && typeof loop.evidence === 'object' ? loop.evidence : {};
    return {
      id: id(loopId),
      phase: integer(loop?.phaseCursor) ?? 0,
      totalPhases: integer(loop?.totalPhases) ?? 0,
      evidencedPhases: Object.keys(evidence).filter((key) => Array.isArray(evidence[key]) && evidence[key].length > 0).length,
      evidenceItems: Object.values(evidence).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0),
      origin: text(loop?.origin, 40)
    };
  }).filter((loop) => loop.id);
}

function publicLanes(state) {
  const campaign = state.campaign || {};
  return {
    activeLaneId: id(campaign.activeLaneId),
    lanes: (Array.isArray(campaign.lanes) ? campaign.lanes : []).slice(0, 50).map((lane) => ({
      id: id(lane.id),
      kind: text(lane.kind, 40),
      loop: id(lane.loop),
      status: text(lane.status, 40),
      noImproveBatches: integer(lane.noImproveBatches) ?? 0,
      since: timestamp(lane.since),
      retiredAt: timestamp(lane.retiredAt)
    })).filter((lane) => lane.id),
    transitions: (Array.isArray(campaign.transitions) ? campaign.transitions : []).slice(-50).map((transition) => ({
      id: id(transition.id),
      ts: timestamp(transition.ts),
      cause: text(transition.cause, 60),
      from: id(transition.from),
      to: id(transition.to),
      loop: id(transition.loop || transition.toLoop)
    }))
  };
}

function publicReceipt(invocation) {
  if (!invocation || typeof invocation !== 'object') return null;
  return {
    requestedModel: route(invocation.requestedModel),
    reportedModel: route(invocation.reportedModel),
    modelSelectionAuthority: text(invocation.modelSelectionAuthority, 60),
    modelIdentityAuthority: text(invocation.modelIdentityAuthority, 60),
    reportedModelMatchesRequest: typeof invocation.reportedModelMatchesRequest === 'boolean'
      ? invocation.reportedModelMatchesRequest
      : null,
    binaryFamily: text(invocation.binaryFamily, 40),
    argv: safeList(invocation.argv, safeArg, 24),
    durationMs: finite(invocation.durationMs),
    exitCode: integer(invocation.exitCode),
    stdoutSha256: hash(invocation.stdoutSha256),
    resultSha256: hash(invocation.resultSha256),
    cliReportedTotalTokens: finite(invocation.tokenUsage),
    tokenUsageAuthority: text(invocation.tokenUsageAuthority, 60),
    isolationStatus: text(invocation.isolation && invocation.isolation.status, 20)
  };
}

function publicVerdicts(state) {
  return (Array.isArray(state.supervisionEvents) ? state.supervisionEvents : []).slice(-100).map((event) => ({
    id: id(event.id),
    ts: timestamp(event.ts),
    type: text(event.type, 60),
    accepted: event.accepted === true,
    code: code(event.code),
    reasons: safeList(event.reasons, code, 12),
    route: route(event.route),
    phase: integer(event.phase),
    workerKind: text(event.workerKind, 60),
    attempt: integer(event.attempt),
    scenario: id(event.scenario),
    invocation: publicReceipt(event.invocation)
  })).filter((event) => event.id);
}

function activityDetail(event, detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  switch (event) {
    case 'initialized':
      return {
        model: route(d.model),
        policy: text(d.modelPolicySource, 80),
        banlist: text(d.banlistMode, 20),
        mode: text(d.mode, 40)
      };
    case 'loop_start':
    case 'advance_phase':
      return { loop: id(d.loop), phase: integer(d.phase), lane: id(d.lane), laneKind: text(d.laneKind, 40) };
    case 'supervisor_event':
      return {
        id: id(d.id),
        accepted: d.accepted === true,
        code: code(d.code),
        route: route(d.route),
        phase: integer(d.phase),
        scenario: id(d.scenario)
      };
    case 'full_test':
    case 'execute_full_test':
      return {
        id: id(d.id || d.testId),
        hypothesisId: id(d.hypothesisId),
        verdict: code(d.verdict),
        lane: id(d.lane)
      };
    case 'reverify':
      return { testId: id(d.testId), reverified: d.reverified === true };
    case 'promotion':
      return { id: id(d.id), hypothesisId: id(d.hypothesisId), kind: text(d.kind, 60) };
    case 'promotion_review_queued':
    case 'promotion_approved':
      return { reviewId: id(d.reviewId), hypothesisId: id(d.hypothesisId) };
    case 'auto_transition':
      return { cause: text(d.cause, 60), from: id(d.from), to: id(d.to), loop: id(d.toLoop) };
    case 'continuation_required':
    case 'continuation_cleared':
      return { id: id(d.id), source: text(d.source, 60) };
    case 'hypotheses_registered':
      return { count: integer(d.count) };
    case 'baseline_bar_set':
      return {
        artifactOutputTokenEstimate: finite(d.artifactOutputTokenEstimate ?? d.tokenCost),
        cliReceiptTokenCost: finite(d.cliReceiptTokenCost),
        quality: finite(d.quality),
        samples: integer(d.n),
        strategy: text(d.strategy, 40)
      };
    case 'benchmark_frozen':
      return {
        id: id(d.id),
        source: text(d.benchSource, 20),
        partition: text(d.benchPartition, 20)
      };
    case 'real_test_progress':
      return {
        status: code(d.status),
        findingsAccepted: integer(d.findingsAccepted),
        improvementAttempts: integer(d.improvementAttempts),
        invalidAttempts: integer(d.invalidAttempts),
        latestSubRunId: id(d.latestSubRunId)
      };
    default:
      return {};
  }
}

function publicActivity(state) {
  return (Array.isArray(state.log) ? state.log : []).slice(-100).map((entry) => {
    const event = text(entry.event, 64);
    if (!event || !EVENT_RE.test(event)) return null;
    return {
      ts: timestamp(entry.ts),
      event,
      detail: activityDetail(event, entry.detail)
    };
  }).filter(Boolean);
}

function publicScoreMatrix(state) {
  const scoreState = {
    ...state,
    hypotheses: Array.isArray(state.hypotheses) ? state.hypotheses : [],
    tests: Array.isArray(state.tests) ? state.tests : []
  };
  return buildScoreMatrix(scoreState).map((row) => ({
    hypothesisId: id(row.hypothesisId),
    route: route(row.route && row.route.model),
    status: text(row.status, 40),
    measured: row.measured === true,
    artifactOutputTokenEstimate: finite(row.artifactOutputTokenEstimate),
    cliReceiptTokenCost: finite(row.cliReceiptTokenCost),
    quality: finite(row.quality),
    qualityAuthority: text(row.qualityAuthority, 60),
    reverified: row.reverified === true,
    deltaQuality: finite(row.deltaQuality),
    deltaCostPct: finite(row.deltaCostPct),
    verdict: code(row.verdict),
    promotable: row.promotable === true
  })).filter((row) => row.hypothesisId);
}

function publicReviews(state) {
  const items = (Array.isArray(state.humanReviews) ? state.humanReviews : []).slice(0, 100).map((review) => ({
    id: id(review.id),
    ts: timestamp(review.ts),
    status: text(review.status, 20),
    kind: text(review.kind, 40),
    hypothesisId: id(review.hypothesisId),
    evidenceRef: id(review.evidenceRef),
    loopId: id(review.loopId),
    hasLoopContent: typeof review.loopContent === 'string' && review.loopContent.length > 0,
    decisionBindingSha256: reviewDecisionBinding(state, review),
    decisionError: code(review.lastDecisionError?.code),
    decisionErrorAt: timestamp(review.lastDecisionError?.ts)
  })).filter((review) => review.id);
  const pending = items.filter((review) => review.status === 'PENDING').length;
  return {
    pending,
    awaiting: pending,
    queued: 0,
    stale: 0,
    approved: items.filter((review) => review.status === 'APPROVED').length,
    sludge: items.filter((review) => review.status === 'SLUDGE').length,
    items
  };
}

function publicPromotions(state) {
  return (Array.isArray(state.promotions) ? state.promotions : []).slice(-100).map((promotion) => ({
    id: id(promotion.id),
    hypothesisId: id(promotion.hypothesisId),
    kind: text(promotion.kind, 60),
    qualityGain: finite(promotion.deltas && promotion.deltas.qualityGain),
    costRegressionPct: finite(promotion.deltas && promotion.deltas.costRegressionPct)
  })).filter((promotion) => promotion.id);
}

function publicRealTest(state) {
  const config = state?.config?.realTest || {};
  const progress = state?.realTest || {};
  const enabled = config.enabled === true || progress.enabled === true;
  if (!enabled) return { enabled: false };
  const maxFindings = integer(config.maxFindings) ?? 0;
  const maxImprovementAttempts = integer(config.maxImprovementAttempts) ?? 0;
  const findingsAccepted = integer(progress.findingsAccepted) ?? 0;
  const improvementAttempts = integer(progress.improvementAttempts) ?? 0;
  const coverage = (Array.isArray(progress.coverage) ? progress.coverage : []).map((item) => ({
    findingId: id(item.findingId),
    childRunId: id(item.childRunId),
    baselineSha256: hash(item.baselineSha256),
    hypothesisIds: safeList(item.hypothesisIds, id, 2),
    planned: integer(item.planned) ?? 0,
    valid: integer(item.valid) ?? 0,
    invalid: integer(item.invalid) ?? 0,
    status: code(item.status) || 'UNTESTED'
  })).filter((item) => item.findingId);
  const rawValidity = progress.experimentValidity && typeof progress.experimentValidity === 'object'
    ? progress.experimentValidity
    : null;
  const validityDimension = (name) => {
    const dimension = rawValidity && rawValidity[name];
    return {
      status: dimension && ['PASS', 'FAIL', 'N/A'].includes(dimension.status) ? dimension.status : 'UNKNOWN',
      reasons: safeList(dimension && dimension.reasons, (reason) => text(reason, 240), 8)
    };
  };
  return {
    enabled: true,
    status: code(progress.status) || 'PREPARING',
    planApproved: config.planApproved === true,
    planSha256: hash(config.planSha256),
    benchmarkSha256: hash(config.benchmarkSha256),
    benchmarkAuthority: text(config.benchmarkAuthority, 20),
    baselineStrategy: text(config.baselineStrategy, 30),
    parentRunId: id(config.parentRunId),
    latestSubRunId: id(progress.latestSubRunId),
    maxFindings,
    findingsAccepted,
    findingsRejected: integer(progress.findingsRejected) ?? 0,
    findingsTested: integer(progress.findingsTested) ?? 0,
    findingsBlocked: integer(progress.findingsBlocked) ?? 0,
    findingsRemaining: Math.max(0, maxFindings - findingsAccepted),
    maxImprovementAttempts,
    improvementAttempts,
    invalidAttempts: integer(progress.invalidAttempts) ?? 0,
    attemptsPlanned: integer(progress.attemptsPlanned) ?? 0,
    attemptsValid: integer(progress.attemptsValid) ?? 0,
    attemptsInvalid: integer(progress.attemptsInvalid) ?? 0,
    improvementAttemptsRemaining: Math.max(0, maxImprovementAttempts - improvementAttempts),
    benchmarkLocked: progress.benchmarkLocked === true,
    baselineSamples: integer(progress.baselineSamples) ?? 0,
    coverage,
    experimentValidity: {
      execution: validityDimension('execution'),
      targetGrounding: validityDimension('targetGrounding'),
      benchmark: validityDimension('benchmark'),
      isolation: validityDimension('isolation'),
      comparability: validityDimension('comparability'),
      coverage: validityDimension('coverage'),
      promotionSafety: validityDimension('promotionSafety'),
      stateConsistency: validityDimension('stateConsistency'),
      publicationEligible: rawValidity ? rawValidity.publicationEligible === true : false,
      status: rawValidity
        ? (rawValidity.publicationEligible === true ? 'PASS' : 'FAIL')
        : 'UNKNOWN'
    },
    updatedAt: timestamp(progress.updatedAt)
  };
}

export function buildConsoleSnapshot(state) {
  if (state && state.kind === 'real-test-canary') {
    return buildCanaryConsoleSnapshot(state);
  }
  const loops = publicLoops(state);
  const benchmark = state.benchmark || {};
  const baseline = state.baseline || {};
  const continuation = state.continuation || {};
  return {
    schemaVersion: 2,
    generatedAt: timestamp(state.updatedAt),
    stopCondition: STOP_CONDITION_WARNING,
    run: {
      id: id(state.runId),
      status: text(state.status, 40),
      createdAt: timestamp(state.createdAt),
      updatedAt: timestamp(state.updatedAt),
      mode: text(state.task && state.task.mode, 40),
      taskSha256: hash(state.task && state.task.sha256),
      runMode: text(state.config && state.config.runMode, 20),
      activeLoop: id(state.activeLoop),
      parentRunId: id(state.config && state.config.realTest && state.config.realTest.parentRunId)
    },
    policy: publicPolicy(state),
    intake: {
      answerSources: (Array.isArray(state.answers) ? state.answers : []).reduce((counts, answer) => {
        const source = ['operator', 'config', 'default'].includes(answer && answer.source) ? answer.source : 'operator';
        counts[source] = (counts[source] || 0) + 1;
        return counts;
      }, { operator: 0, config: 0, default: 0 })
    },
    continuation: {
      required: continuation.required === true,
      id: id(continuation.id),
      since: timestamp(continuation.since),
      source: text(continuation.source, 60),
      inProgress: continuation.inProgress === true,
      nextTool: text(continuation.next && continuation.next.tool, 80)
    },
    failures: {
      consecutive: integer(state.failures && state.failures.consecutive) ?? 0,
      total: integer(state.failures && state.failures.total) ?? 0,
      patience: integer(state.config && state.config.failurePatience) ?? 0,
      retirementBatches: integer(state.config && state.config.branchRetirementBatches) ?? 0,
      exhaustionFlagged: state.failures && state.failures.exhaustionFlagged === true
    },
    loops,
    campaign: publicLanes(state),
    evidence: {
      baselineLocked: baseline.recorded === true,
      baselineSha256: hash(baseline.sha256),
      benchmarkFrozen: benchmark.frozen === true,
      benchmarkSource: text(benchmark.def && benchmark.def.benchSource, 20),
      benchmarkPartition: text(benchmark.def && benchmark.def.benchPartition, 20),
      benchmarkCases: Array.isArray(benchmark.def && benchmark.def.cases) ? benchmark.def.cases.length : 0,
      deterministicOracle: isDeterministicOracle(benchmark.def && benchmark.def.oracle),
      routeIndependenceRequired: benchmark.def && benchmark.def.routeIndependence === 'required',
      requiredRoutes: integer(benchmark.def && benchmark.def.requiredRoutes),
      integrityOverrideCount: Array.isArray(benchmark.def && benchmark.def.integrityOverride)
        ? benchmark.def.integrityOverride.length
        : (benchmark.def && benchmark.def.integrityOverride ? 1 : 0),
      negativeControl: benchmark.negativeControl ? {
        status: benchmark.negativeControl.passed === false ? 'FAILED_AS_EXPECTED' : 'INVALID',
        source: text(benchmark.negativeControl.source, 20),
        sha256: hash(benchmark.negativeControl.sha256)
      } : null,
      baselineQuality: finite(benchmark.baselineScore && benchmark.baselineScore.quality),
      baselineArtifactOutputTokenEstimate: finite(benchmark.baselineScore
        && (benchmark.baselineScore.artifactOutputTokenEstimate ?? benchmark.baselineScore.tokenCost)),
      baselineCliReceiptTokenCost: finite(benchmark.baselineScore && benchmark.baselineScore.cliReceiptTokenCost),
      baselineQualityAuthority: text(benchmark.baselineScore && benchmark.baselineScore.qualityAuthority, 60),
      baselineSamples: integer(benchmark.baselineScore && benchmark.baselineScore.n) ?? (benchmark.baselineScore ? 1 : 0),
      baselineStdevQuality: finite(benchmark.baselineScore && benchmark.baselineScore.stdevQuality),
      observations: Array.isArray(state.observations) ? state.observations.length : 0,
      artifacts: integer(state.counters && state.counters.artifact) ?? 0,
      evidencedPhases: loops.reduce((sum, loop) => sum + loop.evidencedPhases, 0)
    },
    scoreMatrix: publicScoreMatrix(state),
    verdicts: publicVerdicts(state),
    activity: publicActivity(state),
    reviews: publicReviews(state),
    promotions: publicPromotions(state),
    realTest: publicRealTest(state)
  };
}
