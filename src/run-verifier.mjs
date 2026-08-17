// Independent, read-only verification for strict real-test runs.
//
// Campaign writers may persist summaries, but those summaries are never evidence.
// This module reopens the parent state, every child state, and every directly linked
// artifact needed to decide whether a run is publication-eligible.
import { DEFAULTS, VERDICT } from './constants.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  extractResult,
  inspectWorkerIsolation,
  normalizeStructuredWorkerOutput,
  normalizeSupervisorBoundProposalOutput,
  parseTokenUsage
} from './executor.mjs';
import { parseCaseResults } from './measure.mjs';
import { sha256 } from './util.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/i;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function dimension(pass, reasons = [], details = {}) {
  const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [reasons].filter(Boolean);
  return {
    status: pass ? 'PASS' : 'FAIL',
    reasons: pass ? [] : list,
    ...details
  };
}

function notApplicable(reason, details = {}) {
  return { status: 'N/A', reasons: [reason], ...details };
}

function safeArtifact(store, runId, artifactId) {
  if (!artifactId) return null;
  try {
    return store.readArtifact(runId, artifactId);
  } catch {
    return null;
  }
}

function safeState(store, runId) {
  if (!runId) return null;
  try {
    return store.exists(runId) ? store.load(runId) : null;
  } catch {
    return null;
  }
}

function artifactHashMatches(artifact) {
  return !!(artifact
    && typeof artifact.content === 'string'
    && SHA256_RE.test(String(artifact.sha256 || ''))
    && sha256(artifact.content) === String(artifact.sha256).toLowerCase());
}

function strictLaunchEvidence(metadata, raw, result, normalizationContract = null) {
  const argv = Array.isArray(metadata?.argv) ? metadata.argv.map(String) : [];
  const disabled = new Set(
    Array.isArray(metadata?.disabledFeatures) ? metadata.disabledFeatures.map(String) : []
  );
  const cwdIndex = argv.indexOf('-C');
  const schemaIndex = argv.indexOf('--output-schema');
  const rawResult = raw ? extractResult('codex', raw.content) : null;
  const supervisorBound = metadata?.resultNormalization
    === 'json-schema-supervisor-bound-v1';
  const normalizedResult = rawResult
    ? (supervisorBound
        ? normalizeSupervisorBoundProposalOutput(normalizationContract || {}, rawResult)
        : normalizeStructuredWorkerOutput({}, rawResult))
    : null;
  const reasons = [];
  if (metadata?.strictIsolation !== true || metadata?.binaryFamily !== 'codex') {
    reasons.push('receipt is not marked as a strict Codex launch');
  }
  if (!argv.includes('--ignore-user-config')) reasons.push('Codex user config was not disabled');
  if (!STRICT_CODEX_DISABLED_FEATURES.every((feature) => (
    disabled.has(feature)
    && argv.some((value, index) => value === feature && argv[index - 1] === '--disable')
  ))) {
    reasons.push('one or more required Codex isolation features were not disabled');
  }
  if (cwdIndex < 0 || !metadata?.workspaceRoot || argv[cwdIndex + 1] !== metadata.workspaceRoot) {
    reasons.push('strict worker cwd is not bound to the recorded capsule root');
  }
  if (schemaIndex < 0 || !argv[schemaIndex + 1]
    || !SHA256_RE.test(String(metadata?.outputSchemaSha256 || ''))) {
    reasons.push('strict worker output schema is not hash-bound in the receipt');
  }
  if (![...(
    normalizationContract ? ['json-schema-supervisor-bound-v1'] : []
  ), 'json-schema-v1'].includes(metadata?.resultNormalization)
    || sha256(String(rawResult || '')) !== String(metadata?.rawResultSha256 || '')
    || normalizedResult !== result?.content) {
    reasons.push('schema-constrained model output does not normalize to the persisted final artifact');
  }
  return { ok: reasons.length === 0, reasons };
}

function runOwner(childStates, run) {
  return childStates.find((child) => child && (
    ((child.benchmark?.baselineScore?.agentRuns) || []).includes(run)
    || (child.tests || []).some((test) => (test.agentRuns || []).includes(run))
  )) || null;
}

export function verifyPersistedAgentRun(store, runId, run) {
  const reasons = [];
  const checks = {
    directArtifacts: false,
    hashes: false,
    canonicalEvaluation: false,
    isolation: false,
    tokenUsage: false,
    modelReceipt: false,
    strictLaunch: false,
    proposal: 'N/A'
  };
  if (!run || typeof run !== 'object') {
    return { ok: false, reasons: ['agent run record is missing'], checks };
  }

  const raw = safeArtifact(store, runId, run.rawArtifactRef);
  const result = safeArtifact(store, runId, run.resultArtifactRef);
  const evaluation = safeArtifact(store, runId, run.evaluationArtifactRef);
  checks.directArtifacts = !!(raw && result && evaluation
    && run.measurementRef === run.evaluationArtifactRef);
  if (!checks.directArtifacts) {
    reasons.push('missing directly linked raw, final, or evaluation artifact');
  }

  checks.hashes = checks.directArtifacts
    && artifactHashMatches(raw)
    && artifactHashMatches(result)
    && artifactHashMatches(evaluation)
    && raw.sha256 === run.stdoutSha256
    && result.sha256 === run.resultSha256;
  if (!checks.hashes) reasons.push('raw, final, or evaluation artifact hash does not rederive');

  const parsedEvaluation = evaluation
    ? parseCaseResults(evaluation.content, { allowProposalWrappers: false })
    : null;
  checks.canonicalEvaluation = !!(evaluation?.measurement
    && parsedEvaluation?.ok
    && parsedEvaluation.wrapper === 'CASE_RESULTS');
  if (!checks.canonicalEvaluation) {
    reasons.push('evaluation artifact is not a measured canonical CASE_RESULTS record');
  }

  const isolation = raw ? inspectWorkerIsolation(raw.content) : null;
  checks.isolation = !!(isolation
    && isolation.status === 'PASS'
    && run.isolation?.status === 'PASS'
    && (!Array.isArray(run.isolation.toolCalls) || run.isolation.toolCalls.length === 0));
  if (!checks.isolation) reasons.push('worker transcript does not prove strict tool and context isolation');

  const receiptTokens = raw ? parseTokenUsage(raw.content) : null;
  checks.tokenUsage = Number.isFinite(receiptTokens)
    && receiptTokens > 0
    && receiptTokens === Number(run.cliReportedTotalTokens);
  if (!checks.tokenUsage) reasons.push('CLI token usage does not rederive from the raw transcript');

  const requested = String(run.requestedModel || '');
  const measuredModel = String(run.model || '');
  const reported = run.reportedModel == null ? null : String(run.reportedModel);
  checks.modelReceipt = requested === measuredModel
    && run.modelSelectionAuthority === 'explicit-model-flag'
    && Number(run.exitCode) === 0
    && (!reported || reported.toLowerCase() === measuredModel.toLowerCase());
  if (!checks.modelReceipt) {
    reasons.push('requested model, model authority, backend identity, or exit receipt violates the strict contract');
  }
  const launch = strictLaunchEvidence(run, raw, result);
  checks.strictLaunch = launch.ok;
  if (!launch.ok) reasons.push(...launch.reasons);

  const hasProposalRefs = !!(run.proposalRawArtifactRef
    || run.proposalResultArtifactRef
    || run.proposalStdoutSha256
    || run.proposalResultSha256);
  if (hasProposalRefs) {
    const proposalVerification = verifyPersistedProposalRun(store, runId, {
      model: run.model,
      rawArtifactRef: run.proposalRawArtifactRef,
      resultArtifactRef: run.proposalResultArtifactRef,
      stdoutSha256: run.proposalStdoutSha256,
      resultSha256: run.proposalResultSha256,
      requestedModel: run.proposalRequestedModel,
      reportedModel: run.proposalReportedModel,
      binaryFamily: run.proposalBinaryFamily,
      argv: run.proposalArgv,
      modelSelectionAuthority: run.proposalModelSelectionAuthority,
      modelIdentityAuthority: run.proposalModelIdentityAuthority,
      reportedModelMatchesRequest: run.proposalReportedModelMatchesRequest,
      strictIsolation: run.proposalStrictIsolation,
      disabledFeatures: run.proposalDisabledFeatures,
      workspaceRoot: run.proposalWorkspaceRoot,
      outputSchemaSha256: run.proposalOutputSchemaSha256,
      rawResultSha256: run.proposalRawResultSha256,
      resultNormalization: run.proposalResultNormalization,
      cliReportedTotalTokens: run.proposalCliReportedTotalTokens,
      cliReportedTokenUsage: run.proposalCliReportedTokenUsage,
      durationMs: run.proposalDurationMs,
      exitCode: run.proposalExitCode,
      isolation: run.proposalIsolation,
      procedureSha256: run.procedureSha256
    });
    checks.proposal = proposalVerification.ok;
    if (!proposalVerification.ok) {
      reasons.push(...proposalVerification.reasons.map((reason) => `proposal: ${reason}`));
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    checks,
    refs: {
      raw: run.rawArtifactRef || null,
      result: run.resultArtifactRef || null,
      evaluation: run.evaluationArtifactRef || null,
      proposalRaw: run.proposalRawArtifactRef || null,
      proposalResult: run.proposalResultArtifactRef || null
    }
  };
}

export function verifyPersistedProposalRun(store, runId, run, {
  normalizationContract = null
} = {}) {
  const reasons = [];
  const raw = safeArtifact(store, runId, run?.rawArtifactRef);
  const result = safeArtifact(store, runId, run?.resultArtifactRef);
  if (!raw || !result) reasons.push('proposal raw or final artifact is missing');
  if (!artifactHashMatches(raw) || !artifactHashMatches(result)
    || raw?.sha256 !== run?.stdoutSha256
    || result?.sha256 !== run?.resultSha256) {
    reasons.push('proposal raw or final artifact hash does not rederive');
  }
  if (!raw || inspectWorkerIsolation(raw.content).status !== 'PASS') {
    reasons.push('proposal transcript does not prove strict tool and context isolation');
  }
  const receiptTokens = raw ? parseTokenUsage(raw.content) : null;
  if (!Number.isFinite(receiptTokens)
    || receiptTokens <= 0
    || receiptTokens !== Number(run?.cliReportedTotalTokens)) {
    reasons.push('proposal CLI token usage does not rederive');
  }
  if (String(run?.requestedModel || '') !== String(run?.model || '')
    || run?.modelSelectionAuthority !== 'explicit-model-flag'
    || Number(run?.exitCode) !== 0
    || (run?.reportedModel
      && String(run.reportedModel).toLowerCase() !== String(run.model || '').toLowerCase())) {
    reasons.push('proposal model receipt violates the strict model contract');
  }
  const parsed = result ? parseCaseResults(result.content) : null;
  if (!parsed?.ok
    || parsed.wrapper !== 'IMPROVEMENT'
    || !SHA256_RE.test(String(run?.procedureSha256 || ''))
    || sha256(String(parsed.payload?.revisedContent || '')) !== run.procedureSha256) {
    reasons.push('proposal revised procedure does not rederive from the persisted final artifact');
  }
  const launch = strictLaunchEvidence(run, raw, result, normalizationContract);
  if (!launch.ok) reasons.push(...launch.reasons);
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    checks: {
      artifacts: !!(raw && result),
      isolation: !!raw && inspectWorkerIsolation(raw.content).status === 'PASS',
      tokenUsage: Number.isFinite(receiptTokens) && receiptTokens > 0,
      strictLaunch: launch.ok,
      procedure: parsed?.ok && parsed.wrapper === 'IMPROVEMENT'
    }
  };
}

function verifyMiningEvidence(state, progress, store) {
  const coverage = Array.isArray(progress?.coverage) ? progress.coverage : [];
  const accepted = Number(progress?.findingsAccepted) || 0;
  if (accepted === 0) {
    return { ok: false, reasons: ['no accepted finding is bound to a persisted mining capture'], refs: [] };
  }
  const pairs = [...new Map(coverage.map((item) => {
    const key = `${item.miningRawArtifactId || ''}:${item.miningCaptureArtifactId || ''}`;
    return [key, {
      rawArtifactId: item.miningRawArtifactId || null,
      resultArtifactId: item.miningCaptureArtifactId || null
    }];
  })).values()];
  const reasons = [];
  if (pairs.length !== 1 || !pairs[0].rawArtifactId || !pairs[0].resultArtifactId) {
    reasons.push('accepted findings are not bound to one immutable mining raw/final capture pair');
  }
  const pair = pairs[0] || {};
  const raw = safeArtifact(store, state.runId, pair.rawArtifactId);
  const result = safeArtifact(store, state.runId, pair.resultArtifactId);
  if (!artifactHashMatches(raw) || !artifactHashMatches(result)) {
    reasons.push('mining raw or final artifact hash does not rederive');
  }
  const matchingEvent = (state.supervisionEvents || []).find((event) => (
    event?.accepted === true
    && event.workerKind === 'mine'
    && event.invocation
    && event.invocation.stdoutSha256 === raw?.sha256
    && event.invocation.resultSha256 === result?.sha256
  ));
  if (!matchingEvent) {
    reasons.push('no accepted mining invocation receipt matches the persisted raw/final capture');
  } else {
    const invocation = matchingEvent.invocation;
    const requestedModel = String(invocation.requestedModel || '');
    const configuredModel = String(state.config?.model?.primary || '');
    if (requestedModel !== configuredModel
      || invocation.modelSelectionAuthority !== 'explicit-model-flag'
      || Number(invocation.exitCode) !== 0
      || (invocation.reportedModel
        && String(invocation.reportedModel).toLowerCase() !== configuredModel.toLowerCase())) {
      reasons.push('mining model receipt violates the strict model contract');
    }
    const receiptTokens = raw ? parseTokenUsage(raw.content) : null;
    if (!Number.isFinite(receiptTokens)
      || receiptTokens <= 0
      || receiptTokens !== Number(invocation.tokenUsage)) {
      reasons.push('mining CLI token usage does not rederive from the raw transcript');
    }
    const launch = strictLaunchEvidence(invocation, raw, result);
    if (!launch.ok) reasons.push(...launch.reasons.map((reason) => `mining: ${reason}`));
  }
  if (!raw || inspectWorkerIsolation(raw.content).status !== 'PASS') {
    reasons.push('mining transcript does not prove zero tool activity');
  }
  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    refs: pairs
  };
}

export function deriveExperimentValidity(state, progress = state?.realTest, store) {
  const coverage = Array.isArray(progress?.coverage) ? progress.coverage : [];
  const strictConfig = state?.config?.realTest || {};
  const findingsAccepted = Number(progress?.findingsAccepted) || 0;
  const attemptsValid = Number(progress?.attemptsValid) || 0;
  const childStates = coverage.map((item) => safeState(store, item.childRunId));
  const persistedRuns = childStates.flatMap((child) => [
    ...((child?.benchmark?.baselineScore?.agentRuns) || []),
    ...((child?.tests) || []).flatMap((test) => test.agentRuns || [])
  ]);
  const receiptChecks = persistedRuns.map((run, index) => {
    const child = runOwner(childStates, run);
    return child
      ? { runId: child.runId, index, ...verifyPersistedAgentRun(store, child.runId, run) }
      : { runId: null, index, ok: false, reasons: ['agent run is not bound to a persisted child state'] };
  });
  const mining = verifyMiningEvidence(state, progress, store);

  const expectedRunCount = childStates.reduce((sum, child) => (
    sum
    + Number(child?.benchmark?.baselineScore?.agentRuns?.length || 0)
    + (child?.tests || []).reduce((testSum, test) => testSum + Number(test?.agentRuns?.length || 0), 0)
  ), 0);
  const executionReasons = [];
  if (attemptsValid <= 0) executionReasons.push('no valid improvement attempt was persisted');
  if (attemptsValid !== Number(progress?.improvementAttempts)) {
    executionReasons.push('valid-attempt and improvement-attempt counters disagree');
  }
  if (childStates.length !== findingsAccepted || childStates.some((child) => !child)) {
    executionReasons.push('accepted findings do not map one-to-one to persisted child states');
  }
  if (persistedRuns.length === 0 || persistedRuns.length !== expectedRunCount) {
    executionReasons.push('persisted baseline/evaluation run inventory is incomplete');
  }
  if (receiptChecks.some((check) => !check.ok)) {
    executionReasons.push('one or more counted agent receipts failed direct artifact verification');
  }
  if (!mining.ok) executionReasons.push(...mining.reasons);
  const execution = dimension(executionReasons.length === 0, executionReasons, {
    checkedAgentRuns: receiptChecks.length,
    failedAgentRuns: receiptChecks.filter((check) => !check.ok).map((check) => ({
      runId: check.runId,
      index: check.index,
      reasons: check.reasons
    })),
    miningRefs: mining.refs
  });

  const groundingReasons = [];
  if (findingsAccepted <= 0 || coverage.length !== findingsAccepted) {
    groundingReasons.push('accepted finding count does not match coverage records');
  }
  for (const item of coverage) {
    if (!item.findingId || !SHA256_RE.test(String(item.baselineSha256 || ''))) {
      groundingReasons.push(`coverage entry ${item.findingId || '<missing>'} lacks an immutable finding/baseline identity`);
    }
    if (!Array.isArray(item.hypothesisIds) || item.hypothesisIds.length !== 2
      || new Set(item.hypothesisIds).size !== 2) {
      groundingReasons.push(`coverage entry ${item.findingId || '<missing>'} is not bound to exactly two unique hypotheses`);
    }
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0
      || item.evidenceRefs.some((ref) => (
        !ref.path || !ref.locator
        || !SHA256_RE.test(String(ref.sourceSha256 || ''))
        || !SHA256_RE.test(String(ref.resolvedSha256 || ''))
      ))) {
      groundingReasons.push(`coverage entry ${item.findingId || '<missing>'} has unresolved evidence provenance`);
    }
  }
  const targetGrounding = dimension(groundingReasons.length === 0, groundingReasons);

  const benchmarkReasons = [];
  if (strictConfig.planApproved !== true
    || !SHA256_RE.test(String(strictConfig.planSha256 || ''))
    || strictConfig.approvedPlanSha256 !== strictConfig.planSha256) {
    benchmarkReasons.push('strict plan is not bound to the exact operator-approved plan hash');
  }
  if (!SHA256_RE.test(String(strictConfig.benchmarkSha256 || ''))) {
    benchmarkReasons.push('strict benchmark hash is missing');
  }
  if (!Array.isArray(strictConfig.evidenceManifest)
    || strictConfig.evidenceManifest.length === 0
    || strictConfig.evidenceManifest.some((item) => (
      !item.path || !Number.isInteger(item.bytes) || item.bytes < 0
      || !SHA256_RE.test(String(item.sha256 || ''))
    ))) {
    benchmarkReasons.push('sealed source manifest is missing or malformed');
  }
  if (progress?.benchmarkLocked !== true
    || Number(progress?.baselineSamples) < DEFAULTS.fullTestAgentsMin) {
    benchmarkReasons.push('receipt-backed route-batch baseline is not locked');
  }
  if (findingsAccepted <= 0
    || childStates.length !== findingsAccepted
    || childStates.some((child) => !child)) {
    benchmarkReasons.push('accepted findings do not map to persisted child benchmarks');
  }
  for (const child of childStates.filter(Boolean)) {
    const baselineRuns = child.benchmark?.baselineScore?.agentRuns || [];
    if (!child.benchmark?.frozen
      || child.benchmark?.def?.benchSource !== 'maker'
      || child.benchmark?.def?.benchPartition !== 'gate'
      || child.benchmark?.gameability?.ok !== true
      || baselineRuns.length < DEFAULTS.fullTestAgentsMin) {
      benchmarkReasons.push(`child ${child.runId} lacks a frozen maker gate benchmark and full baseline route batch`);
    }
  }
  const benchmark = dimension(benchmarkReasons.length === 0, benchmarkReasons);

  const isolationFailures = receiptChecks.filter((check) => check.checks?.isolation !== true);
  const isolation = dimension(
    mining.ok && persistedRuns.length > 0 && isolationFailures.length === 0,
    [
      ...(!mining.ok ? ['mining isolation failed'] : []),
      ...(persistedRuns.length === 0 ? ['no persisted agent run exists to audit'] : []),
      ...(isolationFailures.length ? ['one or more persisted worker transcripts contain tools or unparsable events'] : [])
    ],
    { failedAgentRuns: isolationFailures.map((check) => ({ runId: check.runId, index: check.index })) }
  );

  const comparabilityFailures = receiptChecks.filter((check) => check.checks?.canonicalEvaluation !== true);
  const comparability = dimension(
    persistedRuns.length > 0 && comparabilityFailures.length === 0,
    [
      ...(persistedRuns.length === 0 ? ['no persisted baseline/challenger measurements exist'] : []),
      ...(comparabilityFailures.length
        ? ['baseline and challenger measurements are not all canonical CASE_RESULTS artifacts']
        : [])
    ],
    { failedAgentRuns: comparabilityFailures.map((check) => ({ runId: check.runId, index: check.index })) }
  );

  const coverageReasons = [];
  if (findingsAccepted <= 0 || coverage.length !== findingsAccepted) {
    coverageReasons.push('coverage does not enumerate every accepted finding');
  }
  if (coverage.some((item) => item.status !== 'COVERED' || item.valid !== item.planned)) {
    coverageReasons.push('at least one accepted finding is blocked, partial, untested, or missing a planned valid attempt');
  }
  const coveredAttempts = coverage.reduce((sum, item) => sum + Number(item.valid || 0), 0);
  const plannedAttempts = coverage.reduce((sum, item) => sum + Number(item.planned || 0), 0);
  if (coveredAttempts !== attemptsValid || plannedAttempts !== Number(progress?.attemptsPlanned)) {
    coverageReasons.push('coverage attempt totals disagree with persisted campaign counters');
  }
  const coverageValidity = dimension(coverageReasons.length === 0, coverageReasons);

  const promotionReasons = [];
  const promotions = childStates.flatMap((child) => child?.promotions || []);
  for (const child of childStates.filter(Boolean)) {
    for (const promotion of child.promotions || []) {
      const tests = (child.tests || []).filter((test) => test.hypothesisId === promotion.hypothesisId);
      if (!tests.some((test) => test.reverified === true && test.verdict === VERDICT.MOVED_FRONTIER)) {
        promotionReasons.push(`promotion ${promotion.id || promotion.hypothesisId} lacks a reverified MOVED_FRONTIER test`);
      }
    }
  }
  const promotionSafety = promotions.length === 0
    ? notApplicable('No promotion was recorded; this experiment cannot claim an improved champion.')
    : dimension(promotionReasons.length === 0, promotionReasons, { promotionsChecked: promotions.length });

  const consistencyReasons = [];
  if (progress?.status !== 'QUEUE_DRAINED') {
    consistencyReasons.push('publication requires a queue-drained checkpoint');
  }
  if (coverageValidity.status !== 'PASS'
    || Number(progress?.attemptsValid) !== Number(progress?.attemptsPlanned)) {
    consistencyReasons.push('queue state and complete-coverage counters disagree');
  }
  if (Number(progress?.findingsTested) !== coverage.filter((item) => item.valid > 0).length
    || Number(progress?.findingsBlocked) !== coverage.filter((item) => item.status === 'BLOCKED').length) {
    consistencyReasons.push('finding tested/blocked counters disagree with coverage records');
  }
  for (const child of childStates.filter(Boolean)) {
    if (!child.baseline?.recorded || !child.benchmark?.frozen || !child.benchmark?.baselineScore) {
      consistencyReasons.push(`child ${child.runId} is missing baseline or benchmark state`);
    }
    for (const test of child.tests || []) {
      const moved = test.verdict === VERDICT.MOVED_FRONTIER;
      if (moved !== (test.movement?.promote === true)) {
        consistencyReasons.push(`child ${child.runId} test ${test.id} has a verdict/movement contradiction`);
      }
    }
  }
  const stateConsistency = dimension(consistencyReasons.length === 0, consistencyReasons);

  const dimensions = {
    execution,
    targetGrounding,
    benchmark,
    isolation,
    comparability,
    coverage: coverageValidity,
    promotionSafety,
    stateConsistency
  };
  const publicationEligible = Object.values(dimensions)
    .every((item) => item.status === 'PASS' || item.status === 'N/A');
  const result = {
    schemaVersion: 1,
    ...dimensions,
    status: publicationEligible ? 'PASS' : 'FAIL',
    publicationEligible
  };
  return {
    ...result,
    evidenceSha256: sha256(stableJson(result))
  };
}

export function verifyRun(store, runId) {
  const state = safeState(store, runId);
  if (!state) {
    return {
      schemaVersion: 1,
      runId,
      status: 'FAIL',
      publicationEligible: false,
      reasons: [`run "${runId}" does not exist`]
    };
  }
  if (state.realTest?.enabled !== true) {
    return {
      schemaVersion: 1,
      runId,
      status: 'FAIL',
      publicationEligible: false,
      reasons: ['independent publication verification is defined only for strict real-test runs']
    };
  }
  return {
    runId,
    ...deriveExperimentValidity(state, state.realTest, store)
  };
}
