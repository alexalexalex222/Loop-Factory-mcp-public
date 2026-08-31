// Executable one-finding, three-arm canary.
//
// Evaluation workers see one active procedure, opaque arm labels, sealed
// evidence, and frozen visible cases. The runner withholds baseline/hypothesis
// details and owns ordering, arm identity, scoring, persistence, receipt
// verification, and the no-promotion decision.
import {
  TOOL_AUTHORITY,
  canonicalCaseResultsContent,
  evaluateCaseResultsGameability,
  parseCaseResults,
  scoreCaseResults
} from './measure.mjs';
import { parseTokenUsage } from './executor.mjs';
import {
  REAL_TEST_CANARY,
  buildRealTestCanaryPlan,
  evaluateRealTestCanaryOutcome,
  validateRealTestCanaryConfig
} from './real-test.mjs';
import { compilePhaseContract, dispatchWorker } from './supervisor.mjs';
import {
  verifyPersistedAgentRun,
  verifyPersistedProposalRun
} from './run-verifier.mjs';
import { isSafeId, nowIso, sha256 } from './util.mjs';

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

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function writeCanaryArtifact(store, runId, artifactId, {
  role,
  name = artifactId,
  content,
  measurement = null
}) {
  const record = {
    id: artifactId,
    name,
    role,
    content: String(content || ''),
    sha256: sha256(String(content || '')),
    ...(measurement ? { measurement } : {})
  };
  store.writeArtifact(runId, artifactId, record);
  return record;
}

function invocationRecord(invocation, route) {
  return {
    model: route,
    requestedModel: invocation.requestedModel || route,
    reasoningEffort: invocation.reasoningEffort || null,
    reportedModel: invocation.reportedModel || null,
    binaryFamily: invocation.binaryFamily || null,
    argv: Array.isArray(invocation.argv) ? invocation.argv.map(String) : [],
    modelSelectionAuthority: invocation.modelSelectionAuthority || null,
    modelIdentityAuthority: invocation.modelIdentityAuthority || invocation.modelSelectionAuthority || null,
    reportedModelMatchesRequest: invocation.reportedModelMatchesRequest ?? null,
    executableBasename: invocation.executableBasename || null,
    executableSha256: invocation.executableSha256 || null,
    executableBytes: Number.isInteger(invocation.executableBytes)
      ? invocation.executableBytes
      : null,
    authMode: invocation.authMode || null,
    oauthAuthoritySha256: invocation.oauthAuthoritySha256 || null,
    promptSha256: invocation.promptSha256 || null,
    strictIsolation: invocation.strictIsolation === true,
    disabledFeatures: Array.isArray(invocation.disabledFeatures)
      ? invocation.disabledFeatures.map(String)
      : [],
    workspaceRoot: invocation.workspaceRoot || null,
    outputSchemaSha256: invocation.outputSchemaSha256 || null,
    rawResultSha256: invocation.rawResultSha256 || null,
    resultNormalization: invocation.resultNormalization || null,
    cliReportedTotalTokens: Number.isFinite(invocation.tokenUsage) ? invocation.tokenUsage : null,
    cliReportedTokenUsage: invocation.tokenUsageDetails || null,
    durationMs: Number.isFinite(invocation.durationMs) ? invocation.durationMs : null,
    exitCode: Number.isFinite(invocation.exitCode) ? invocation.exitCode : null,
    processErrorCode: invocation.processErrorCode || null,
    stdoutSha256: invocation.stdoutSha256 || null,
    stderrSha256: invocation.stderrSha256 || null,
    resultSha256: invocation.resultSha256 || null,
    isolation: invocation.isolation && typeof invocation.isolation === 'object'
      ? {
          status: invocation.isolation.status || null,
          toolCalls: Array.isArray(invocation.isolation.toolCalls)
            ? invocation.isolation.toolCalls.map((item) => ({ ...item }))
            : []
        }
      : null
  };
}

export function persistRejectedDispatch(store, runId, packet, route, {
  artifactPrefix,
  kind,
  reasons,
  attempt,
  context = {}
}) {
  const executorOwned = packet?.executorOwned === true;
  const rawStdout = executorOwned ? String(packet.rawStdout || '') : '';
  const rawStderr = executorOwned ? String(packet.rawStderr || '') : '';
  const finalOutput = executorOwned ? String(packet.finalOutput || '') : '';
  const invocation = packet?.invocation && typeof packet.invocation === 'object'
    ? invocationRecord(packet.invocation, route)
    : null;
  const stdoutArtifact = rawStdout
    ? writeCanaryArtifact(store, runId, `${artifactPrefix}-stdout`, {
        role: 'executor-failed-stdout',
        content: rawStdout
      })
    : null;
  const stderrArtifact = rawStderr
    ? writeCanaryArtifact(store, runId, `${artifactPrefix}-stderr`, {
        role: 'executor-failed-stderr',
        content: rawStderr
      })
    : null;
  const resultArtifact = finalOutput
    ? writeCanaryArtifact(store, runId, `${artifactPrefix}-final`, {
        role: 'executor-failed-final',
        content: finalOutput
      })
    : null;
  const evidenceRecord = (artifact, receiptSha256, content) => artifact ? {
    artifactRef: artifact.id,
    sha256: artifact.sha256,
    receiptSha256: receiptSha256 || null,
    matchesReceipt: receiptSha256 ? artifact.sha256 === receiptSha256 : null,
    bytes: Buffer.byteLength(content)
  } : null;
  return {
    kind,
    route,
    reasons: [...new Set((reasons || []).map(String))],
    attempt: Number.isInteger(attempt) ? attempt : null,
    execReason: packet?.__execReason || null,
    invocation,
    stdout: evidenceRecord(stdoutArtifact, invocation?.stdoutSha256, rawStdout),
    stderr: evidenceRecord(stderrArtifact, invocation?.stderrSha256, rawStderr),
    result: evidenceRecord(resultArtifact, invocation?.resultSha256, finalOutput),
    ...context
  };
}

function packetEvidence(packet) {
  const invocation = packet?.invocation;
  const rawStdout = packet?.executorOwned === true ? String(packet.rawStdout || '') : '';
  const finalOutput = String(packet?.finalOutput || '');
  if (!invocation || !rawStdout || !finalOutput
    || sha256(rawStdout) !== invocation.stdoutSha256
    || sha256(finalOutput) !== invocation.resultSha256
    || packet?.isolation?.status !== 'PASS'
    || (Array.isArray(packet?.isolation?.toolCalls) && packet.isolation.toolCalls.length > 0)) {
    return { ok: false, reason: 'packet lacks matching supervisor-owned raw/final receipts' };
  }
  const tokens = parseTokenUsage(rawStdout);
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens !== Number(invocation.tokenUsage)) {
    return { ok: false, reason: 'packet CLI token usage does not rederive' };
  }
  return { ok: true, invocation, rawStdout, finalOutput, tokens };
}

function oracleForGroup(oracle, group) {
  return {
    ...oracle,
    cases: (oracle?.cases || []).filter((item) => item.group === group)
  };
}

function groupQuality(content, oracle, group) {
  const grouped = oracleForGroup(oracle, group);
  const expected = new Set(grouped.cases.map((item) => String(item.caseId)));
  const parsed = parseCaseResults(content, { allowProposalWrappers: false });
  if (!parsed.ok || grouped.cases.length === 0) return null;
  const subset = parsed.results.filter((row) => expected.has(String(row?.caseId || '')));
  return scoreCaseResults(`<CASE_RESULTS>${JSON.stringify(subset)}</CASE_RESULTS>`, grouped);
}

export function persistCanaryProposal(store, runId, packet, route, {
  artifactPrefix = 'proposal',
  normalizationContract = null
} = {}) {
  const evidence = packetEvidence(packet);
  if (!evidence.ok) return evidence;
  const parsed = parseCaseResults(evidence.finalOutput);
  const revisedContent = String(parsed?.payload?.revisedContent || '');
  if (!parsed?.ok || parsed.wrapper !== 'IMPROVEMENT' || !revisedContent.trim()) {
    return { ok: false, reason: 'proposal final output is not a complete IMPROVEMENT record' };
  }
  const raw = writeCanaryArtifact(store, runId, `${artifactPrefix}-raw`, {
    role: 'executor-raw',
    content: evidence.rawStdout
  });
  const result = writeCanaryArtifact(store, runId, `${artifactPrefix}-final`, {
    role: 'worker-final',
    content: evidence.finalOutput
  });
  const record = {
    ...invocationRecord(evidence.invocation, route),
    rawArtifactRef: raw.id,
    resultArtifactRef: result.id,
    procedureSha256: sha256(revisedContent)
  };
  const verification = verifyPersistedProposalRun(store, runId, record, {
    normalizationContract
  });
  return verification.ok
    ? { ok: true, record, revisedContent, verification }
    : { ok: false, reason: verification.reasons.join('; '), record, verification };
}

export function persistCanaryEvaluation(store, runId, packet, route, {
  artifactPrefix,
  oracle,
  armRole,
  blindArm,
  replicate,
  position,
  procedureSha256
}) {
  const evidence = packetEvidence(packet);
  if (!evidence.ok) return evidence;
  const comparable = canonicalCaseResultsContent(evidence.finalOutput);
  if (!comparable) return { ok: false, reason: 'evaluation output is not canonical case results' };
  const quality = scoreCaseResults(comparable, oracle);
  const targetQuality = groupQuality(comparable, oracle, 'target');
  const controlQuality = groupQuality(comparable, oracle, 'control');
  if (![quality, targetQuality, controlQuality].every(Number.isFinite)) {
    return { ok: false, reason: 'target/control quality could not be derived from the frozen oracle' };
  }
  const raw = writeCanaryArtifact(store, runId, `${artifactPrefix}-raw`, {
    role: 'executor-raw',
    content: evidence.rawStdout
  });
  const result = writeCanaryArtifact(store, runId, `${artifactPrefix}-final`, {
    role: 'worker-final',
    content: evidence.finalOutput
  });
  const evaluation = writeCanaryArtifact(store, runId, `${artifactPrefix}-evaluation`, {
    role: 'runlog',
    content: comparable,
    measurement: {
      tokenCost: evidence.tokens,
      quality,
      targetQuality,
      controlQuality,
      tokenCostAuthority: TOOL_AUTHORITY,
      qualityAuthority: TOOL_AUTHORITY
    }
  });
  const record = {
    ...invocationRecord(evidence.invocation, route),
    armRole,
    blindArm,
    replicate,
    position,
    procedureSha256,
    tokenCost: evidence.tokens,
    quality,
    targetQuality,
    controlQuality,
    measurementRef: evaluation.id,
    evaluationArtifactRef: evaluation.id,
    rawArtifactRef: raw.id,
    resultArtifactRef: result.id
  };
  const verification = verifyPersistedAgentRun(store, runId, record);
  return verification.ok
    ? { ok: true, record, verification }
    : { ok: false, reason: verification.reasons.join('; '), record, verification };
}

export function expectedCanarySchedule(plan) {
  return (plan?.contract?.schedule || []).flatMap((row, replicate) => (
    row.map((armRole, position) => ({
      armRole,
      blindArm: plan.contract.blindLabels[armRole],
      replicate,
      position
    }))
  ));
}

function verificationFailure(runId, reason) {
  const base = {
    schemaVersion: 1,
    runId,
    status: 'FAIL',
    experimentValid: false,
    gates: {
      scorerFixtures: false,
      receipts: false,
      isolation: false,
      schemaIdentity: false,
      stateConsistency: false
    },
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function verifyCanaryRun(store, runId) {
  const state = store.load(runId);
  if (!state || state.kind !== 'real-test-canary') {
    return verificationFailure(runId, 'canary state is missing or has the wrong kind');
  }
  const oracle = state.benchmark?.oracle;
  const evaluations = Array.isArray(state.evaluations) ? state.evaluations : [];
  const proposalCheck = state.proposal
    ? verifyPersistedProposalRun(store, runId, state.proposal)
    : { ok: false, reasons: ['proposal record is missing'], checks: {} };
  const evaluationChecks = evaluations.map((record) => ({
    record,
    verification: verifyPersistedAgentRun(store, runId, record)
  }));
  const scorerCheck = evaluateCaseResultsGameability(oracle);
  const scorerFixtures = scorerCheck.ok === true
    && oracleForGroup(oracle, 'target').cases.length > 0
    && oracleForGroup(oracle, 'control').cases.length > 0;
  const receipts = proposalCheck.ok
    && evaluationChecks.length === REAL_TEST_CANARY.arms.length * REAL_TEST_CANARY.replicatesPerArm
    && evaluationChecks.every((item) => item.verification.ok);
  const isolation = proposalCheck.checks?.isolation === true
    && proposalCheck.checks?.strictLaunch === true
    && evaluationChecks.every((item) => (
      item.verification.checks?.isolation === true
      && item.verification.checks?.strictLaunch === true
    ));

  const expectedCaseIds = (oracle?.cases || []).map((item) => String(item.caseId)).sort();
  const schemaHashes = new Set(evaluations.map((item) => item.outputSchemaSha256).filter(Boolean));
  let measurementMatches = true;
  let schemaRowsMatch = true;
  for (const record of evaluations) {
    const artifact = store.readArtifact(runId, record.evaluationArtifactRef);
    const raw = store.readArtifact(runId, record.rawArtifactRef);
    const parsed = artifact ? parseCaseResults(artifact.content, { allowProposalWrappers: false }) : null;
    const ids = parsed?.ok ? parsed.results.map((row) => String(row?.caseId || '')).sort() : [];
    if (stableJson(ids) !== stableJson(expectedCaseIds)) schemaRowsMatch = false;
    const recomputed = artifact ? {
      tokenCost: raw ? parseTokenUsage(raw.content) : null,
      quality: scoreCaseResults(artifact.content, oracle),
      targetQuality: groupQuality(artifact.content, oracle, 'target'),
      controlQuality: groupQuality(artifact.content, oracle, 'control')
    } : null;
    if (!recomputed
      || recomputed.tokenCost !== record.tokenCost
      || recomputed.quality !== record.quality
      || recomputed.targetQuality !== record.targetQuality
      || recomputed.controlQuality !== record.controlQuality) {
      measurementMatches = false;
    }
  }
  const schemaIdentity = evaluations.length > 0
    && schemaHashes.size === 1
    && schemaRowsMatch
    && measurementMatches;

  const schedule = expectedCanarySchedule(state.plan);
  const actualSchedule = evaluations.map((item) => ({
    armRole: item.armRole,
    blindArm: item.blindArm,
    replicate: item.replicate,
    position: item.position
  }));
  const armCounts = Object.fromEntries(REAL_TEST_CANARY.arms.map((arm) => [
    arm,
    evaluations.filter((item) => item.armRole === arm).length
  ]));
  const stateConsistency = state.status === 'QUEUE_DRAINED'
    && state.plan?.sha256 === state.approvedPlanSha256
    && stableJson(actualSchedule) === stableJson(schedule)
    && Object.values(armCounts).every((count) => count === REAL_TEST_CANARY.replicatesPerArm)
    && state.promotion?.enabled === false
    && state.promotion?.recorded === false;

  const gates = {
    scorerFixtures,
    receipts,
    isolation,
    schemaIdentity,
    stateConsistency
  };
  const series = Object.fromEntries(REAL_TEST_CANARY.arms.map((arm) => [
    arm,
    evaluations
      .filter((item) => item.armRole === arm)
      .sort((a, b) => a.replicate - b.replicate)
      .map((item) => ({
        targetQuality: item.targetQuality,
        controlQuality: item.controlQuality,
        tokenCost: item.tokenCost,
        artifactRef: item.evaluationArtifactRef
      }))
  ]));
  const outcome = evaluateRealTestCanaryOutcome({
    baseline: series.baseline,
    challenger: series.challenger,
    sham: series.sham,
    gates
  });
  const experimentValid = Object.values(gates).every(Boolean);
  const reasons = [
    ...(!scorerFixtures ? [`scorer fixture gate failed: ${scorerCheck.reason || 'target/control groups missing'}`] : []),
    ...(!receipts ? ['one or more proposal/evaluation receipts failed direct verification'] : []),
    ...(!isolation ? ['one or more strict launches or transcripts failed isolation verification'] : []),
    ...(!schemaIdentity ? ['evaluation schemas, case identities, or re-derived measurements diverged'] : []),
    ...(!stateConsistency ? ['persisted schedule, counts, plan approval, or no-promotion state is inconsistent'] : [])
  ];
  const base = {
    schemaVersion: 1,
    runId,
    status: experimentValid ? 'PASS' : 'FAIL',
    experimentValid,
    gates,
    armCounts,
    series,
    outcome,
    failedReceipts: [
      ...(!proposalCheck.ok ? [{ kind: 'proposal', reasons: proposalCheck.reasons }] : []),
      ...evaluationChecks
        .filter((item) => !item.verification.ok)
        .map((item) => ({
          kind: 'evaluation',
          artifactRef: item.record.evaluationArtifactRef,
          reasons: item.verification.reasons
        }))
    ],
    reasons
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

function renderCanaryReport(state) {
  const verification = state.verification || {};
  const outcome = verification.outcome || { status: 'FAIL', reasons: [] };
  const lines = [
    '# Loop Factory Real-Test Canary',
    '',
    `- **run**: \`${state.runId}\``,
    `- **status**: ${state.status}`,
    `- **experiment validity**: ${verification.status || 'UNKNOWN'}`,
    `- **canary outcome**: ${outcome.status || 'UNKNOWN'}`,
    `- **model**: ${state.model}`,
    `- **plan sha256**: \`${state.plan.sha256}\``,
    `- **verification sha256**: \`${verification.evidenceSha256 || 'missing'}\``,
    ...(state.blocker ? [`- **blocker**: \`${state.blocker.code}\` — ${state.blocker.message}`] : []),
    '- **promotion**: disabled; no champion or source change can be recorded by this runner',
    '- **arm concealment**: evaluators received opaque labels with locked-baseline and hypothesis details withheld; they necessarily saw the active procedure they judged',
    '',
    '## Gates',
    '',
    '| gate | result |',
    '|---|---|',
    ...Object.entries(verification.gates || {}).map(([name, pass]) => `| ${name} | ${pass ? 'PASS' : 'FAIL'} |`),
    '',
    '## Measurements',
    '',
    '| replicate | position | role | blind arm | target quality | control quality | tokens | artifact |',
    '|---:|---:|---|---|---:|---:|---:|---|',
    ...(state.evaluations || []).map((item) => (
      `| ${item.replicate + 1} | ${item.position + 1} | ${item.armRole} | ${item.blindArm} | ${item.targetQuality} | ${item.controlQuality} | ${item.tokenCost} | ${item.evaluationArtifactRef} |`
    )),
    '',
    '## Decision',
    '',
    `- paired challenger target wins: ${outcome.pairedTargetWins ?? 0}/5`,
    `- sham target wins: ${outcome.shamWins ?? 0}`,
    `- challenger control regressions: ${outcome.controlRegressions ?? 0}`,
    `- promotion enabled: ${outcome.promotionEnabled === true}`,
    ...((outcome.reasons || []).map((reason) => `- ${reason}`)),
    ...((state.failureEvidence || []).length ? [
      '',
      '## Failed Launch Evidence',
      '',
      '| kind | executor reason | exit | stdout evidence | stderr evidence |',
      '|---|---|---:|---|---|',
      ...(state.failureEvidence || []).map((item) => (
        `| ${item.kind} | ${item.execReason || 'unknown'} | ${item.invocation?.exitCode ?? '—'} | ${item.stdout ? `${item.stdout.artifactRef} (${item.stdout.bytes} bytes, \`${item.stdout.sha256}\`)` : 'none'} | ${item.stderr ? `${item.stderr.artifactRef} (${item.stderr.bytes} bytes, \`${item.stderr.sha256}\`)` : 'none'} |`
      ))
    ] : []),
    '',
    'This report is evidence from the canary only. It does not publish, promote, or modify a loop.'
  ];
  return `${lines.join('\n')}\n`;
}

export function runRealTestCanary(store, config, {
  runId,
  worker,
  clock = nowIso
} = {}) {
  if (!isSafeId(runId)) return { status: 'BLOCKED', code: 'BAD_RUN_ID', message: 'a safe --run-id is required' };
  if (store.exists(runId)) {
    return { status: 'BLOCKED', code: 'RUN_EXISTS', message: `run "${runId}" already exists; canary runs are append-only` };
  }
  if (typeof worker !== 'function') {
    return { status: 'BLOCKED', code: 'NO_WORKER', message: 'canary runner requires a worker backend' };
  }
  const validation = validateRealTestCanaryConfig(config);
  if (!validation.ok) {
    return { status: 'BLOCKED', code: 'CANARY_CONFIG', errors: validation.errors, plan: validation.plan };
  }
  const plan = buildRealTestCanaryPlan(config);
  const target = {
    findingId: config.target.findingId,
    title: config.target.title || config.target.findingId,
    baselineArtifactId: 'baseline-procedure',
    baselineSha256: plan.baselineSha256,
    baselineContent: config.target.baselineContent,
    evidenceRefs: config.target.evidenceRefs.map((item) => ({ ...item }))
  };
  const hypothesis = {
    id: `${target.findingId}-canary-h1`,
    ...config.target.hypothesis
  };
  const createdAt = clock();
  const state = {
    schemaVersion: 1,
    kind: 'real-test-canary',
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'RUNNING',
    model: config.model,
    approvedPlanSha256: config.approvedPlanSha256,
    plan,
    benchmark: config.benchmark,
    evidenceManifest: config.evidenceManifest,
    evidenceArtifacts: {},
    target: {
      findingId: target.findingId,
      baselineSha256: target.baselineSha256,
      shamSha256: plan.shamSha256,
      hypothesisSha256: plan.hypothesisSha256
    },
    proposal: null,
    evaluations: [],
    verdictEvents: [],
    failureEvidence: [],
    promotion: { enabled: false, recorded: false },
    verification: null,
    outcome: null,
    blocker: null,
    reportPath: null
  };
  store.save(state);
  const benchmarkArtifact = writeCanaryArtifact(store, runId, 'frozen-benchmark', {
    role: 'benchmark',
    content: stableJson(config.benchmark)
  });
  const capsuleArtifact = writeCanaryArtifact(store, runId, 'sealed-evidence-capsule', {
    role: 'evidence-capsule',
    content: stableJson(config.evidenceCapsule)
  });
  state.evidenceArtifacts = {
    benchmark: { id: benchmarkArtifact.id, sha256: benchmarkArtifact.sha256 },
    capsule: { id: capsuleArtifact.id, sha256: capsuleArtifact.sha256 }
  };
  store.save(state);

  const block = (code, message) => {
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.updatedAt = clock();
    store.save(state);
    state.verification = verifyCanaryRun(store, runId);
    state.outcome = state.verification.outcome || null;
    store.save(state);
    const reportPath = store.writeRunFile(runId, 'canary-report.md', renderCanaryReport(state));
    state.reportPath = reportPath;
    store.save(state);
    return { status: 'BLOCKED', code, message, runId, reportPath, verification: state.verification };
  };

  const proposalContract = compilePhaseContract('loop-de-loop', 1, {
    kind: 'proposal',
    route: config.routes[0],
    task: 'Produce the single predeclared canary challenger. Do not evaluate or score it.',
    target,
    hypothesis,
    frozenCases: config.benchmark.cases,
    evidenceCapsule: config.evidenceCapsule,
    toolPolicy: 'none'
  });
  const proposalDispatch = dispatchWorker(proposalContract, worker, {
    maxRetries: REAL_TEST_CANARY.retriesPerDispatch,
    onVerdict: (event) => state.verdictEvents.push({
      kind: 'proposal',
      accepted: event.accepted,
      reasons: event.reasons,
      attempt: event.attempt,
      invocation: event.invocation || null
    })
  });
  store.save(state);
  if (!proposalDispatch.accepted) {
    state.failureEvidence.push(persistRejectedDispatch(
      store,
      runId,
      proposalDispatch.packet,
      config.routes[0],
      {
        artifactPrefix: 'proposal-failed',
        kind: 'proposal',
        reasons: proposalDispatch.reasons,
        attempt: proposalDispatch.attempt
      }
    ));
    store.save(state);
    return block('PROPOSAL_INVALID', proposalDispatch.reasons.join(','));
  }
  const proposal = persistCanaryProposal(store, runId, proposalDispatch.packet, config.routes[0]);
  if (!proposal.ok) return block('PROPOSAL_RECEIPT_INVALID', proposal.reason);
  state.proposal = proposal.record;
  state.updatedAt = clock();
  store.save(state);

  const procedures = {
    baseline: config.target.baselineContent,
    challenger: proposal.revisedContent,
    sham: config.target.shamContent
  };
  const evaluationTarget = {
    findingId: target.findingId,
    title: target.title,
    baselineArtifactId: target.baselineArtifactId,
    baselineSha256: target.baselineSha256,
    evidenceRefs: target.evidenceRefs
  };
  const evaluationHypothesis = { id: hypothesis.id };
  const schedule = expectedCanarySchedule(plan);
  for (const item of schedule) {
    const route = config.routes[item.replicate];
    const procedureContent = procedures[item.armRole];
    const procedureSha256 = sha256(procedureContent);
    const contract = compilePhaseContract('loop-de-loop', 1, {
      kind: 'evaluation',
      evaluationArm: item.blindArm,
      route,
      task: 'Apply the active procedure to every frozen case. Return observations only; do not compare arms or report a score.',
      target: evaluationTarget,
      hypothesis: evaluationHypothesis,
      frozenCases: config.benchmark.cases,
      evidenceCapsule: config.evidenceCapsule,
      procedureContent,
      procedureSha256,
      toolPolicy: 'none'
    });
    const dispatch = dispatchWorker(contract, worker, {
      maxRetries: REAL_TEST_CANARY.retriesPerDispatch,
      onVerdict: (event) => state.verdictEvents.push({
        kind: 'evaluation',
        armRole: item.armRole,
        blindArm: item.blindArm,
        replicate: item.replicate,
        position: item.position,
        accepted: event.accepted,
        reasons: event.reasons,
        attempt: event.attempt,
        invocation: event.invocation || null
      })
    });
    store.save(state);
    if (!dispatch.accepted) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        dispatch.packet,
        route,
        {
          artifactPrefix: `eval-r${item.replicate + 1}-p${item.position + 1}-failed`,
          kind: 'evaluation',
          reasons: dispatch.reasons,
          attempt: dispatch.attempt,
          context: {
            armRole: item.armRole,
            blindArm: item.blindArm,
            replicate: item.replicate,
            position: item.position
          }
        }
      ));
      store.save(state);
      return block(
        'EVALUATION_INVALID',
        `${item.armRole} replicate ${item.replicate + 1}: ${dispatch.reasons.join(',')}`
      );
    }
    const persisted = persistCanaryEvaluation(store, runId, dispatch.packet, route, {
      artifactPrefix: `eval-r${item.replicate + 1}-p${item.position + 1}`,
      oracle: config.benchmark.oracle,
      ...item,
      procedureSha256
    });
    if (!persisted.ok) {
      return block(
        'EVALUATION_RECEIPT_INVALID',
        `${item.armRole} replicate ${item.replicate + 1}: ${persisted.reason}`
      );
    }
    state.evaluations.push(persisted.record);
    state.updatedAt = clock();
    store.save(state);
  }

  state.status = 'QUEUE_DRAINED';
  state.completedAt = clock();
  state.updatedAt = state.completedAt;
  store.save(state);
  state.verification = verifyCanaryRun(store, runId);
  state.outcome = state.verification.outcome;
  store.save(state);
  const reportPath = store.writeRunFile(runId, 'canary-report.md', renderCanaryReport(state));
  state.reportPath = reportPath;
  store.save(state);
  return {
    status: 'OK',
    runId,
    reportPath,
    statePath: `${store.runDir(runId)}/state.json`,
    experimentValid: state.verification.experimentValid,
    outcome: state.outcome,
    verification: state.verification
  };
}
