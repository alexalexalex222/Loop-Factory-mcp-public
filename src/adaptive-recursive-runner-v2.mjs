import { readFileSync } from 'node:fs';
import {
  ADAPTIVE_RECURSIVE_CANARY_V2,
  validateAdaptiveRecursiveCanaryV2Config
} from './adaptive-recursive-canary-v2.mjs';
import {
  buildRecursivePlaceboCalibration,
  buildRecursiveUntouchedConfirmation
} from './adaptive-recursive-statistics.mjs';
import { createAdaptiveMeasurementRecord } from './adaptive-measurement-v2.mjs';
import {
  buildAdaptiveExecutableCanaryPrompt,
  evaluateExecutableCandidate
} from './adaptive-executable-canary.mjs';
import {
  activateReplicatedMechanismEvolution,
  verifyReplicatedMechanismEvolution
} from './mechanism-evolution-admission-v2.mjs';
import { rejectMechanismEvolution } from './mechanism-evolution.mjs';
import {
  adaptiveRecursiveCanaryWorker,
  artifactMatches,
  callArtifacts,
  evidenceArtifact,
  invocationMatches,
  mechanismForArm,
  parseArtifactJson,
  persistEvaluation,
  persistInputs,
  proposalPayload,
  readArtifact,
  repairContract,
  sandboxRecord
} from './adaptive-recursive-runner.mjs';
import {
  persistCanaryProposal,
  persistRejectedDispatch,
  stableJson
} from './canary-runner.mjs';
import { parseTokenUsageDetails, schemaPathForContract } from './executor.mjs';
import { verifyPersistedProposalRun } from './run-verifier.mjs';
import { canonicalJson } from './real-test.mjs';
import { isSafeId, nowIso, sha256 } from './util.mjs';
import {
  createResourceBudgetLedger,
  reserveResourceBudget,
  settleResourceBudget,
  verifyResourceBudgetLedger
} from './resource-budget.mjs';
import {
  verifyVNextMechanismExecutionBindingFromStore
} from './vnext-mechanism-execution.mjs';
import {
  appendPaceTaskCluster,
  createPaceAcceptor,
  evaluatePaceV2Gates
} from './pace-acceptor.mjs';

export const ADAPTIVE_RECURSIVE_RUN_KIND_V2 = 'adaptive-recursive-canary-v2';

const ARMS = ADAPTIVE_RECURSIVE_CANARY_V2.arms;
const STAGES = ADAPTIVE_RECURSIVE_CANARY_V2.stages;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function flattenedConfig(config) {
  return {
    ...config,
    tasks: STAGES.flatMap((stage) => config[`${stage}Tasks`] || [])
  };
}

function stageMaterial(config, stage, taskId) {
  return (config.taskMaterials || []).find((material) => (
    material.stage === stage && material.id === taskId
  )) || null;
}

function stageTask(config, stage, taskId) {
  return (config[`${stage}Tasks`] || []).find((task) => task.id === taskId) || null;
}

function stageSchedule(plan, stage) {
  return stage === 'calibration' ? plan.calibrationCalls : plan.confirmationCalls;
}

function interfaceContracts(config) {
  return STAGES.flatMap((stage) => config[`${stage}Tasks`] || [])
    .map((task) => task.interfaceContract);
}

function replayVNextExecution(store, config) {
  return config.vnextBinding
    ? verifyVNextMechanismExecutionBindingFromStore({
        store,
        binding: config.vnextBinding,
        parentFamily: config.parentFamily,
        candidateFamily: config.candidateFamily,
        evolutionRecord: config.evolutionRecord,
        interfaceContracts: interfaceContracts(config),
        behaviorMap: config.vnextBehaviorMap,
        requireProduction: true
      })
    : { status: 'OK', evidenceSha256: null };
}

function scheduledShape(call) {
  return {
    callIndex: call.callIndex,
    stage: call.stage,
    taskId: call.taskId,
    replicate: call.replicate,
    arm: call.arm,
    treatmentPacketSha256: call.treatmentPacketSha256,
    outputSchemaKind: call.outputSchemaKind
  };
}

function expectedSchedule(plan, state) {
  if (state.status === 'CALIBRATION_DRAINED'
      || state.status === 'CALIBRATION_REJECTED') {
    return plan.calibrationCalls;
  }
  if (state.status === 'QUEUE_DRAINED') {
    return [...plan.calibrationCalls, ...plan.confirmationCalls];
  }
  return [...plan.calibrationCalls, ...plan.confirmationCalls]
    .slice(0, state.calls?.length || 0);
}

function syntheticTaskId(stage, taskId, replicate) {
  return `${stage.slice(0, 3)}-${sha256(`${taskId}:${replicate}`).slice(0, 24)}`;
}

function resultRows(evaluation) {
  return evaluation.results.map((result) => ({
    id: result.id,
    group: result.group,
    pass: result.pass,
    decisionPass: result.decisionPass,
    codePass: result.codePass
  }));
}

function exactRate(results) {
  return results.filter((result) => result.pass === true).length / results.length;
}

function objectiveReplayEvidenceSha256(state, calls) {
  return sha256(canonicalJson({
    schemaVersion: 'recursive-v2-objective-replay-evidence-v1',
    runId: state.runId,
    planSha256: state.plan.sha256,
    calls: calls.map((call) => ({
      callIndex: call.callIndex,
      evaluationSha256: call.evaluationSha256,
      candidateSha256: call.candidateSha256,
      stdoutSha256: call.stdoutSha256,
      resultSha256: call.resultSha256
    }))
  }));
}

function buildPaceCompanion({
  config,
  confirmationBlocks,
  confirmationAnalysis,
  objectiveEvidenceSha256
}) {
  if (!config.pacePolicy) {
    return {
      status: 'OK',
      required: false,
      passed: true,
      state: null,
      gateRecord: null,
      persistedStepSha256s: []
    };
  }
  if (!confirmationBlocks || !confirmationAnalysis) {
    return {
      status: 'OK',
      required: true,
      passed: null,
      state: null,
      gateRecord: null,
      persistedStepSha256s: []
    };
  }
  const created = createPaceAcceptor({
    candidateId: config.candidateFamily.familyId,
    outerAlphaAllocation: config.pacePolicy.outerAlphaAllocation,
    lambdaPolicy: config.pacePolicy.lambdaPolicy
  });
  if (created.status !== 'OK') return created;
  let state = created.state;
  const persistedStepSha256s = [];
  const taskIds = [...new Set(confirmationBlocks.map((block) => block.taskId))]
    .sort((left, right) => (
      sha256(`${config.pacePolicy.policySha256}:${left}`)
        .localeCompare(sha256(`${config.pacePolicy.policySha256}:${right}`))
    ));
  for (const taskId of taskIds) {
    if (state.stopped) break;
    const blocks = confirmationBlocks
      .filter((block) => block.taskId === taskId)
      .sort((left, right) => left.replicate - right.replicate);
    const updated = appendPaceTaskCluster(state, {
      taskId,
      objectiveVerified: true,
      replicates: blocks.map((block) => ({
        replicate: block.replicate,
        candidate: exactRate(block.arms.candidate.results)
          - exactRate(block.arms.sham.results),
        incumbent: exactRate(block.arms.parent.results)
          - exactRate(block.arms.cold.results)
      }))
    }, {
      persistStep(receipt) {
        persistedStepSha256s.push(sha256(canonicalJson(receipt)));
      }
    });
    if (updated.status !== 'OK') return updated;
    state = updated.state;
  }
  const gate = evaluatePaceV2Gates({
    state,
    shamMovement: {
      absoluteMovement: Math.abs(confirmationAnalysis.summary.shamVsCold.mean),
      maximumAllowed: config.pacePolicy.maximumShamMovement
    },
    regressions: {
      target: confirmationAnalysis.summary.targetRegressions,
      control: confirmationAnalysis.summary.controlRegressions
    },
    tokenCost: {
      candidateTokens: confirmationAnalysis.summary.arms.candidate.tokenCost,
      incumbentTokens: confirmationAnalysis.summary.arms.parent.tokenCost,
      maximumRelativeIncrease: config.pacePolicy.maximumRelativeTokenIncrease
    },
    objectiveVerification: {
      verified: true,
      evidenceSha256: objectiveEvidenceSha256
    },
    untouchedConfirmation: {
      passed: confirmationAnalysis.causalPass === true,
      untouched: true,
      evidenceSha256: confirmationAnalysis.analysisSha256
    }
  });
  return gate.status === 'OK'
    ? {
        status: 'OK',
        required: true,
        passed: gate.record.allV2GatesPassed,
        state,
        gateRecord: gate.record,
        persistedStepSha256s
      }
    : gate;
}

function buildStageBlocks(calls, config, stage) {
  const blocks = [];
  for (const task of config[`${stage}Tasks`] || []) {
    for (let replicate = 0;
      replicate < ADAPTIVE_RECURSIVE_CANARY_V2.replicatesPerArm;
      replicate += 1) {
      const arms = {};
      for (const arm of ARMS) {
        const call = calls.find((item) => (
          item.stage === stage
          && item.taskId === task.id
          && item.replicate === replicate
          && item.arm === arm
        ));
        if (!call?.evaluation || !Number.isInteger(call.cliReportedTotalTokens)) {
          return refused(
            'RECURSIVE_V2_BLOCK_INCOMPLETE',
            `${stage} block ${task.id}:${replicate} is incomplete.`
          );
        }
        arms[arm] = {
          results: resultRows(call.evaluation),
          tokenCost: call.cliReportedTotalTokens
        };
      }
      blocks.push({ taskId: task.id, replicate, arms });
    }
  }
  return ok({ blocks });
}

function stageMeasurementInput(calls, config, stage, verifierEvidenceSha256) {
  const tasks = [];
  for (const task of config[`${stage}Tasks`] || []) {
    for (let replicate = 0;
      replicate < ADAPTIVE_RECURSIVE_CANARY_V2.replicatesPerArm;
      replicate += 1) {
      const arms = {};
      for (const arm of ARMS) {
        const call = calls.find((item) => (
          item.stage === stage
          && item.taskId === task.id
          && item.replicate === replicate
          && item.arm === arm
        ));
        if (!call?.evaluation) {
          return refused(
            'RECURSIVE_V2_MEASUREMENT_INCOMPLETE',
            `${stage} measurement is missing ${task.id}:${replicate}:${arm}.`
          );
        }
        arms[arm] = {
          evaluationArtifactRef: call.evaluationArtifactRef,
          evaluationArtifactSha256: call.evaluationSha256,
          tokenCost: call.cliReportedTotalTokens,
          results: resultRows(call.evaluation)
        };
      }
      tasks.push({
        taskId: syntheticTaskId(stage, task.id, replicate),
        arms
      });
    }
  }
  const materials = (config.taskMaterials || [])
    .filter((material) => material.stage === stage)
    .map((material) => ({
      taskId: material.id,
      caseSetSha256: material.caseSetSha256
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  return createAdaptiveMeasurementRecord({
    source: {
      kind: `recursive-v2-${stage}`,
      runId: config.__runId,
      verifierEvidenceSha256,
      evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
      caseSetSha256: sha256(canonicalJson(materials))
    },
    profile: 'recursive-causal-v1',
    armRoles: {
      baseline: 'cold',
      parent: 'parent',
      treatment: 'candidate',
      sham: 'sham'
    },
    mechanismBindings: {
      baseline: null,
      parent: config.evolutionRecord.parent.programSha256,
      treatment: config.evolutionRecord.candidate.programSha256,
      sham: config.evolutionRecord.candidate.programSha256
    },
    tasks
  });
}

function verifierEvidencePayload(state, config, calls, pace) {
  return {
    schemaVersion: 'adaptive-recursive-v2-verifier-evidence-v1',
    runId: state.runId,
    planSha256: state.plan.sha256,
    configSha256: state.plan.configSha256,
    runtimeAuthoritySha256: config.runtimeAuthority.authoritySha256,
    evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
    vnextExecutionBindingSha256: config.vnextBinding?.bindingSha256 ?? null,
    vnextPreparationEvidenceSha256:
      config.vnextBinding?.preparationVerifierEvidenceSha256 ?? null,
    pacePolicySha256: config.pacePolicy?.policySha256 ?? null,
    paceStateSha256: pace?.state?.stateSha256 ?? null,
    paceGateRecordSha256: pace?.gateRecord?.recordSha256 ?? null,
    implementationManifestSha256: sha256(canonicalJson(config.implementationManifest)),
    calls: calls.map((call) => ({
      callIndex: call.callIndex,
      stage: call.stage,
      taskId: call.taskId,
      replicate: call.replicate,
      arm: call.arm,
      treatmentPacketSha256: call.treatmentPacketSha256,
      promptArtifactSha256: call.promptArtifactSha256,
      rawArtifactSha256:
        readArtifact(state.__store, state.runId, call.rawArtifactRef)?.sha256 || null,
      resultArtifactSha256:
        readArtifact(state.__store, state.runId, call.resultArtifactRef)?.sha256 || null,
      candidateSha256: call.candidateSha256,
      evaluationSha256: call.evaluationSha256,
      tokenCost: call.cliReportedTotalTokens,
      budgetReservationId: call.budgetReservationId ?? null,
      budgetSettlementSha256: call.budgetSettlementSha256 ?? null
    }))
  };
}

function verificationFailure(runId, reason) {
  const base = {
    schemaVersion: 2,
    runId,
    status: 'FAIL',
    experimentValid: false,
    checkpointValid: false,
    causalPass: false,
    activationEligible: false,
    gates: {},
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

function expectedDerivedRecords(verification) {
  return {
    calibrationMeasurement: verification.calibrationMeasurement,
    calibrationAnalysis: verification.calibrationAnalysis,
    confirmationMeasurement: verification.confirmationMeasurement,
    confirmationAnalysis: verification.confirmationAnalysis,
    verifiedAdmission: verification.verifiedAdmission,
    activeAdmission: verification.activeAdmission,
    rejectedAdmission: verification.rejectedAdmission,
    rejectedEvolution: verification.rejectedEvolution,
    paceState: verification.paceState,
    paceGateRecord: verification.paceGateRecord,
    resourceBudgetLedger: verification.resourceBudgetLedger,
    vnextExecutionEvidence: verification.vnextExecutionEvidence
  };
}

function derivedArtifactsMatch(store, runId, state, records) {
  if (state.derivationsSealed !== true) return false;
  const refs = state.derivedArtifacts || {};
  for (const [key, record] of Object.entries(records)) {
    const ref = refs[key];
    if (record == null) {
      if (ref != null) return false;
      continue;
    }
    const artifact = ref?.id ? readArtifact(store, runId, ref.id) : null;
    if (!artifactMatches(artifact)
        || artifact.sha256 !== ref.sha256
        || artifact.content !== canonicalJson(record)) return false;
  }
  return true;
}

function terminalStatusValid(state, calibrationAnalysis, confirmationAnalysis) {
  if (state.status === 'CALIBRATION_REJECTED') {
    return calibrationAnalysis?.qualified === false
      && confirmationAnalysis == null
      && state.calls.length === ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls;
  }
  if (state.status === 'QUEUE_DRAINED') {
    return calibrationAnalysis?.qualified === true
      && confirmationAnalysis != null
      && state.calls.length === ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls;
  }
  return false;
}

function tokenUsage(calls) {
  const byStage = Object.fromEntries(STAGES.map((stage) => {
    const rows = calls.filter((call) => call.stage === stage);
    return [stage, {
      calls: rows.length,
      total: rows.length > 0
        && rows.every((call) => Number.isInteger(call.cliReportedTotalTokens))
        ? rows.reduce((sum, call) => sum + call.cliReportedTotalTokens, 0)
        : null
    }];
  }));
  const byArm = Object.fromEntries(ARMS.map((arm) => {
    const rows = calls.filter((call) => call.arm === arm);
    return [arm, {
      calls: rows.length,
      total: rows.length > 0
        && rows.every((call) => Number.isInteger(call.cliReportedTotalTokens))
        ? rows.reduce((sum, call) => sum + call.cliReportedTotalTokens, 0)
        : null
    }];
  }));
  return {
    observedCalls: calls.length,
    measuredCalls: calls.filter((call) => Number.isInteger(call.cliReportedTotalTokens)).length,
    total: calls.length > 0
      && calls.every((call) => Number.isInteger(call.cliReportedTotalTokens))
      ? calls.reduce((sum, call) => sum + call.cliReportedTotalTokens, 0)
      : null,
    byStage,
    byArm
  };
}

export function verifyAdaptiveRecursiveCanaryV2Run(store, runId) {
  const state = store.load(runId);
  if (!state || state.kind !== ADAPTIVE_RECURSIVE_RUN_KIND_V2) {
    return verificationFailure(runId, 'recursive V2 state is missing or has the wrong kind');
  }
  const configArtifact = readArtifact(store, runId, state.evidenceArtifacts?.config?.id);
  const config = parseArtifactJson(configArtifact);
  if (!config) return verificationFailure(runId, 'sealed recursive V2 config is invalid');
  config.__runId = runId;
  const flat = flattenedConfig(config);
  const validation = validateAdaptiveRecursiveCanaryV2Config(config, {
    requireApproval: false
  });
  const plan = validation.plan;
  const vnextExecution = replayVNextExecution(store, config);
  const calls = Array.isArray(state.calls) ? state.calls : [];
  const events = Array.isArray(state.verdictEvents) ? state.verdictEvents : [];
  const intents = Array.isArray(state.dispatchIntents) ? state.dispatchIntents : [];
  let promptBinding = true;
  let treatmentBinding = true;
  let privateEvidenceWithheld = true;
  let receipts = true;
  let modelAuthority = true;
  let strictIsolation = true;
  let measurementReplay = true;
  const receiptBudgetUsage = new Map();
  let artifactHashes = artifactMatches(configArtifact);
  const replayedCalls = [];
  const allPrivateEvidence = (config.taskMaterials || []).flatMap((material) => [
    material.oracle?.path,
    material.oracle?.content
  ]).filter(Boolean);
  for (const call of calls) {
    const task = stageTask(config, call.stage, call.taskId);
    const material = stageMaterial(config, call.stage, call.taskId);
    const expectedContract = task ? repairContract(flat, task, call.arm) : null;
    const artifacts = callArtifacts(store, runId, call);
    const contract = parseArtifactJson(artifacts.contract);
    const evaluation = parseArtifactJson(artifacts.evaluation);
    const proposal = verifyPersistedProposalRun(store, runId, call, {
      normalizationContract: expectedContract
    });
    if (!proposal.ok) receipts = false;
    const expectedPrompt = artifacts.prompt?.content || null;
    const rebuiltPrompt = expectedContract
      ? buildAdaptiveExecutableCanaryPrompt(expectedContract)
      : null;
    if (!expectedContract
        || stableJson(contract) !== stableJson(expectedContract)
        || expectedPrompt !== rebuiltPrompt
        || artifacts.prompt?.sha256 !== call.promptArtifactSha256
        || call.promptSha256 !== call.promptArtifactSha256) promptBinding = false;
    const expectedTreatment = task ? mechanismForArm(flat, task, call.arm) : null;
    if (stableJson(contract?.mechanismCapsule || null) !== stableJson(expectedTreatment)
        || call.treatmentPacketSha256 !== (expectedTreatment?.packetSha256 || null)) {
      treatmentBinding = false;
    }
    if (allPrivateEvidence.some((needle) => artifacts.prompt?.content?.includes(needle))) {
      privateEvidenceWithheld = false;
    }
    if (!invocationMatches(config, call)) modelAuthority = false;
    if (call.strictIsolation !== true
        || call.isolation?.status !== 'PASS'
        || (call.isolation?.toolCalls || []).length) strictIsolation = false;
    const replay = artifacts.candidate && material
      ? evaluateExecutableCandidate({
          source: artifacts.candidate.content,
          caseSet: material.caseSet,
          authority: config.evaluatorAuthority,
          taskId: call.taskId,
          diagnostics: true
        })
      : null;
    const replayRecord = replay?.instrumentValid ? sandboxRecord(replay) : null;
    if (!replayRecord
        || stableJson(replayRecord) !== stableJson(evaluation)
        || artifacts.candidate?.sha256 !== call.candidateSha256
        || artifacts.evaluation?.sha256 !== call.evaluationSha256
        || artifacts.sandboxStdout?.sha256 !== call.sandboxStdoutSha256
        || artifacts.sandboxStderr?.sha256 !== call.sandboxStderrSha256) {
      measurementReplay = false;
    }
    if (Object.values(artifacts).some((artifact) => !artifactMatches(artifact))) {
      artifactHashes = false;
    }
    if (config.resourceBudgetPolicy) {
      const usage = parseTokenUsageDetails(artifacts.raw?.content || '');
      const inputTokens = Number(usage?.inputTokens ?? 0)
        + Number(usage?.cacheCreationInputTokens ?? 0)
        + Number(usage?.cacheReadInputTokens ?? 0);
      const outputTokens = Number(usage?.outputTokens);
      const recordedUsage = call.cliReportedTokenUsage;
      const recordedInputTokens = Number(recordedUsage?.inputTokens ?? 0)
        + Number(recordedUsage?.cacheCreationInputTokens ?? 0)
        + Number(recordedUsage?.cacheReadInputTokens ?? 0);
      const recordedOutputTokens = Number(recordedUsage?.outputTokens);
      receiptBudgetUsage.set(call.callIndex, {
        inputTokens,
        outputTokens,
        valid: Number.isSafeInteger(inputTokens)
          && inputTokens >= 0
          && Number.isSafeInteger(outputTokens)
          && outputTokens >= 0
          && recordedInputTokens === inputTokens
          && recordedOutputTokens === outputTokens
          && Number(recordedUsage?.totalTokens) === Number(usage?.totalTokens)
      });
    }
    replayedCalls.push({ ...call, evaluation });
  }
  const sealedConfig = structuredClone(config);
  delete sealedConfig.__runId;
  const initialBudget = config.resourceBudgetPolicy
    ? createResourceBudgetLedger({
        policy: config.resourceBudgetPolicy,
        runId,
        createdAt: state.createdAt
      })
    : null;
  const sealedExpected = {
    config: sealedConfig,
    plan,
    runtimeAuthority: config.runtimeAuthority,
    evaluatorAuthority: config.evaluatorAuthority,
    implementation: config.implementationCapsule,
    taskMaterials: config.taskMaterials,
    proposalSchema: readFileSync(schemaPathForContract({ kind: 'proposal' }), 'utf8'),
    ...(config.resourceBudgetPolicy ? {
      resourceBudgetPolicy: config.resourceBudgetPolicy,
      initialResourceBudgetLedger: initialBudget?.status === 'OK'
        ? initialBudget.ledger
        : null
    } : {}),
    ...(config.vnextBinding ? {
      vnextExecutionBinding: config.vnextBinding
    } : {}),
    ...(config.pacePolicy ? {
      pacePolicy: config.pacePolicy
    } : {})
  };
  let sealedInputs = true;
  for (const [key, expected] of Object.entries(sealedExpected)) {
    const ref = state.evidenceArtifacts?.[key];
    const artifact = ref?.id ? readArtifact(store, runId, ref.id) : null;
    const content = typeof expected === 'string' ? expected : canonicalJson(expected);
    if (!artifactMatches(artifact)
        || artifact.sha256 !== ref?.sha256
        || artifact.content !== content) sealedInputs = false;
  }
  const scheduleExpected = plan ? expectedSchedule(plan, state) : [];
  const schedule = stableJson(calls.map(scheduledShape))
      === stableJson(scheduleExpected.map(scheduledShape))
    && events.length === calls.length
    && events.every((event, index) => (
      stableJson(scheduledShape(event)) === stableJson(scheduledShape(calls[index]))
      && event.accepted === true
      && event.attempt === 0
    ));
  const noRetries = events.length === calls.length
    && events.every((event) => event.attempt === 0)
    && new Set(events.map((event) => (
      `${event.stage}:${event.taskId}:${event.replicate}:${event.arm}`
    ))).size === events.length;
  const dispatchJournal = intents.length === calls.length
    && intents.every((intent, index) => (
      stableJson(scheduledShape(intent)) === stableJson(scheduledShape(calls[index]))
      && intent.attempt === 0
      && intent.contractArtifactRef === calls[index].contractArtifactRef
      && intent.promptArtifactRef === calls[index].promptArtifactRef
      && intent.promptArtifactSha256 === calls[index].promptArtifactSha256
      && intent.budgetReservationId === (calls[index].budgetReservationId ?? null)
    ));
  const noPromotion = state.promotion?.enabled === false
    && state.promotion?.recorded === false;
  const budgetReplay = config.resourceBudgetPolicy
    ? verifyResourceBudgetLedger(state.resourceBudgetLedger)
    : { status: state.resourceBudgetLedger == null ? 'OK' : 'REFUSED', totals: null };
  const budgetReservations = config.resourceBudgetPolicy
    ? new Map((state.resourceBudgetLedger?.entries || [])
      .filter((entry) => entry.kind === 'reservation')
      .map((entry) => [entry.reservationId, entry]))
    : new Map();
  const budgetSettlements = config.resourceBudgetPolicy
    ? new Map((state.resourceBudgetLedger?.entries || [])
      .filter((entry) => entry.kind === 'settlement')
      .map((entry) => [entry.reservationId, entry]))
    : new Map();
  const resourceBudget = !config.resourceBudgetPolicy || (
    budgetReplay.status === 'OK'
    && budgetReplay.totals.callsReserved === calls.length
    && budgetReplay.totals.callsSettled === calls.length
    && calls.every((call) => {
      const reservation = budgetReservations.get(call.budgetReservationId);
      const settlement = budgetSettlements.get(call.budgetReservationId);
      const usage = receiptBudgetUsage.get(call.callIndex);
      return reservation?.callId === `call-${String(call.callIndex + 1).padStart(3, '0')}`
        && settlement?.entrySha256 === call.budgetSettlementSha256
        && settlement?.withinReservation === true
        && settlement?.usageAuthority === 'cli-receipt'
        && usage?.valid === true
        && settlement?.inputTokens === usage.inputTokens
        && settlement?.outputTokens === usage.outputTokens;
    })
  );
  const preAnalysisGates = {
    configIntegrity: validation.ok,
    sealedInputs,
    promptBinding,
    treatmentBinding,
    privateEvidenceWithheld,
    receipts,
    modelAuthority,
    strictIsolation,
    measurementReplay,
    artifactHashes,
    schedule,
    noRetries,
    dispatchJournal,
    noPromotion,
    resourceBudget,
    vnextExecutionBinding: vnextExecution.status === 'OK',
    approvedPlan: state.approvedPlanSha256 === plan?.sha256
      && state.plan?.sha256 === plan?.sha256
  };
  const preAnalysisValid = Object.values(preAnalysisGates).every(Boolean);
  const calibrationBlocks = preAnalysisValid
      && calls.length >= ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls
    ? buildStageBlocks(replayedCalls, config, 'calibration')
    : refused('RECURSIVE_V2_CALIBRATION_BLOCKED', 'Calibration replay gates failed.');
  const calibration = calibrationBlocks.status === 'OK'
    ? buildRecursivePlaceboCalibration(calibrationBlocks.blocks)
    : (calibrationBlocks.status === 'OK'
        ? refused('RECURSIVE_V2_VERIFIER_EVIDENCE_MISSING', 'Calibration measurement lacks verifier evidence.')
        : calibrationBlocks);
  let confirmationBlocks = null;
  let confirmation = null;
  if (state.status === 'QUEUE_DRAINED' && calibration.record?.qualified === true) {
    confirmationBlocks = buildStageBlocks(replayedCalls, config, 'confirmation');
    confirmation = confirmationBlocks.status === 'OK'
      ? buildRecursiveUntouchedConfirmation({
          calibration: calibration.record,
          blocks: confirmationBlocks.blocks
        })
      : confirmationBlocks;
  }
  const objectiveEvidenceSha256 = preAnalysisValid
    ? objectiveReplayEvidenceSha256(state, calls)
    : null;
  const pace = preAnalysisValid
    ? buildPaceCompanion({
        config,
        confirmationBlocks: confirmationBlocks?.status === 'OK'
          ? confirmationBlocks.blocks
          : null,
        confirmationAnalysis: confirmation?.status === 'OK'
          ? confirmation.record
          : null,
        objectiveEvidenceSha256
      })
    : refused('PACE_PRECONDITIONS_FAILED', 'Objective replay failed before PACE.');
  const paceEvidenceValid = pace.status === 'OK'
    && (!config.pacePolicy
      || state.status !== 'QUEUE_DRAINED'
      || (pace.state != null && pace.gateRecord != null));
  const commonGates = {
    ...preAnalysisGates,
    paceEvidence: paceEvidenceValid
  };
  const checkpointValid = Object.values(commonGates).every(Boolean)
    && calls.length === ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls
    && ['CALIBRATION_DRAINED', 'CALIBRATION_REJECTED'].includes(state.status);
  const resumeValid = Object.values(commonGates).every(Boolean)
    && ['RUNNING', 'CALIBRATION_DRAINED', 'OPERATOR_STOP'].includes(state.status)
    && calls.length <= ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls;
  const evidencePayload = Object.values(commonGates).every(Boolean)
    ? verifierEvidencePayload({ ...state, __store: store }, config, calls, pace)
    : null;
  const verifierEvidenceSha256 = evidencePayload
    ? sha256(canonicalJson(evidencePayload))
    : null;
  const calibrationMeasurement = calibrationBlocks.status === 'OK'
      && verifierEvidenceSha256
    ? stageMeasurementInput(
        replayedCalls,
        config,
        'calibration',
        verifierEvidenceSha256
      )
    : (calibrationBlocks.status === 'OK'
        ? refused('RECURSIVE_V2_VERIFIER_EVIDENCE_MISSING', 'Calibration measurement lacks verifier evidence.')
        : calibrationBlocks);
  const confirmationMeasurement = confirmationBlocks?.status === 'OK'
      && verifierEvidenceSha256
    ? stageMeasurementInput(
        replayedCalls,
        config,
        'confirmation',
        verifierEvidenceSha256
      )
    : (confirmationBlocks?.status === 'OK'
        ? refused('RECURSIVE_V2_VERIFIER_EVIDENCE_MISSING', 'Confirmation measurement lacks verifier evidence.')
        : confirmationBlocks);
  let verifiedAdmission = null;
  let activeAdmission = null;
  let rejectedAdmission = null;
  let rejectedEvolution = null;
  if (state.status === 'CALIBRATION_REJECTED'
      && calibration.record?.qualified === false
      && verifierEvidenceSha256) {
    const rejected = rejectMechanismEvolution({
      currentRecord: config.evolutionRecord,
      parentFamily: config.parentFamily,
      candidateFamily: config.candidateFamily,
      rejectionEvidenceSha256: verifierEvidenceSha256,
      reasonCodes: ['REPLICATED_CALIBRATION_FAILED'],
      recordedAt: state.completedAt
    });
    if (rejected.status === 'OK') rejectedEvolution = rejected.record;
  }
  if (state.status === 'QUEUE_DRAINED'
      && calibrationMeasurement.status === 'OK'
      && confirmationMeasurement?.status === 'OK'
      && calibration.status === 'OK'
      && confirmation?.status === 'OK') {
    const admission = verifyReplicatedMechanismEvolution({
      currentRecord: config.evolutionRecord,
      parentFamily: config.parentFamily,
      candidateFamily: config.candidateFamily,
      calibrationMeasurement: calibrationMeasurement.record,
      confirmationMeasurement: confirmationMeasurement.record,
      calibrationAnalysis: calibration.record,
      confirmationAnalysis: confirmation.record,
      verifierEvidenceSha256,
      recordedAt: state.completedAt,
      companionGatePassed: !config.pacePolicy || pace.passed === true,
      companionFailureReason: 'PACE_COMPANION_GATES_FAILED'
    });
    if (admission.status === 'OK' && admission.record.state === 'VERIFIED') {
      verifiedAdmission = admission.record;
      const activated = activateReplicatedMechanismEvolution({
        currentAdmission: verifiedAdmission,
        activationEvidenceSha256: verifierEvidenceSha256,
        recordedAt: state.completedAt
      });
      if (activated.status === 'OK') activeAdmission = activated.record;
    } else if (admission.status === 'OK') {
      rejectedAdmission = admission.record;
    }
  }
  const derivedRecords = {
    calibrationMeasurement:
      calibrationMeasurement.status === 'OK' ? calibrationMeasurement.record : null,
    calibrationAnalysis: calibration.status === 'OK' ? calibration.record : null,
    confirmationMeasurement:
      confirmationMeasurement?.status === 'OK' ? confirmationMeasurement.record : null,
    confirmationAnalysis: confirmation?.status === 'OK' ? confirmation.record : null,
    verifiedAdmission,
    activeAdmission,
    rejectedAdmission,
    rejectedEvolution,
    paceState: pace.status === 'OK' ? pace.state : null,
    paceGateRecord: pace.status === 'OK' ? pace.gateRecord : null,
    resourceBudgetLedger: config.resourceBudgetPolicy ? state.resourceBudgetLedger : null,
    vnextExecutionEvidence: config.vnextBinding
      ? {
          bindingSha256: config.vnextBinding.bindingSha256,
          preparationVerifierEvidenceSha256:
            config.vnextBinding.preparationVerifierEvidenceSha256,
          executionEvidenceSha256: vnextExecution.status === 'OK'
            ? vnextExecution.evidenceSha256
            : null
        }
      : null
  };
  const terminalState = terminalStatusValid(
    state,
    derivedRecords.calibrationAnalysis,
    derivedRecords.confirmationAnalysis
  );
  const terminal = ['CALIBRATION_REJECTED', 'QUEUE_DRAINED'].includes(state.status);
  const derivations = terminal
    ? derivedArtifactsMatch(store, runId, state, derivedRecords)
    : true;
  const gates = {
    ...commonGates,
    terminalState,
    calibrationBuilt: derivedRecords.calibrationMeasurement != null
      && derivedRecords.calibrationAnalysis != null,
    confirmationGate: state.status === 'CALIBRATION_REJECTED'
      ? derivedRecords.confirmationMeasurement == null
        && derivedRecords.confirmationAnalysis == null
      : derivedRecords.confirmationMeasurement != null
        && derivedRecords.confirmationAnalysis != null,
    dispositionBuilt: state.status === 'CALIBRATION_REJECTED'
      ? rejectedEvolution != null
      : activeAdmission != null || rejectedAdmission != null,
    derivedArtifacts: derivations
  };
  const experimentValid = terminal && Object.values(gates).every(Boolean);
  const causalPass = experimentValid && activeAdmission != null;
  const reasons = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => `${name} gate failed`);
  if (experimentValid && !causalPass) {
    reasons.push(state.status === 'CALIBRATION_REJECTED'
      ? 'candidate did not clear replicated placebo calibration'
      : 'candidate did not pass untouched recursive confirmation');
  }
  const base = {
    schemaVersion: 2,
    runId,
    status: experimentValid ? 'PASS' : 'FAIL',
    runDisposition: state.status,
    experimentValid,
    checkpointValid,
    resumeValid,
    calibrationQualified: derivedRecords.calibrationAnalysis?.qualified ?? null,
    causalPass,
    activationEligible: causalPass,
    promotionEnabled: false,
    modelAuthority: {
      requestedModel: config.model,
      reasoningEffort: config.reasoningEffort,
      authMode: config.runtimeAuthority.authMode,
      observedCalls: calls.length,
      backendReportedCalls: calls.filter((call) => call.reportedModel != null).length
    },
    gates,
    verifierEvidenceSha256,
    ...derivedRecords,
    tokenUsage: tokenUsage(calls),
    reasons
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

function renderReport(state, verification) {
  const calibration = verification.calibrationAnalysis;
  const confirmation = verification.confirmationAnalysis;
  return [
    '# Adaptive Recursive Canary V2',
    '',
    `- run: \`${state.runId}\``,
    `- disposition: **${state.status}**`,
    `- experiment valid: **${verification.experimentValid}**`,
    `- calibration qualified: **${verification.calibrationQualified}**`,
    `- untouched confirmation pass: **${verification.causalPass}**`,
    `- PACE companion: **${verification.paceGateRecord?.disposition ?? 'not required'}**`,
    `- active routing eligible: **${verification.activationEligible}**`,
    `- model: \`${verification.modelAuthority.requestedModel}\``,
    `- reasoning: \`${verification.modelAuthority.reasoningEffort}\``,
    `- calls: ${verification.tokenUsage.observedCalls}/${ADAPTIVE_RECURSIVE_CANARY_V2.maximumCalls} maximum`,
    `- verifier evidence: \`${verification.evidenceSha256}\``,
    '',
    '## Calibration',
    '',
    `- candidate vs parent mean: ${calibration?.summary?.candidateVsParent?.mean ?? 'unmeasured'}`,
    `- candidate lower 95%: ${calibration?.summary?.candidateVsParent?.lower95 ?? 'unmeasured'}`,
    `- sham vs cold mean: ${calibration?.summary?.shamVsCold?.mean ?? 'unmeasured'}`,
    `- frozen placebo upper 95%: ${calibration?.placeboUpper95 ?? 'unmeasured'}`,
    '',
    '## Untouched Confirmation',
    '',
    `- adjusted mean: ${confirmation?.summary?.adjusted?.mean ?? 'not launched'}`,
    `- task sign-test p: ${confirmation?.summary?.adjustedTaskSignTest?.pOneSided ?? 'not launched'}`,
    `- target regressions: ${confirmation?.summary?.targetRegressions ?? 'not launched'}`,
    `- control regressions: ${confirmation?.summary?.controlRegressions ?? 'not launched'}`,
    '',
    'Promotion remained disabled. A causal pass only activates the descendant for bounded routing.',
    ''
  ].join('\n');
}

function persistDerivedArtifacts(store, runId, state, verification) {
  const roles = {
    calibrationMeasurement: 'calibration-measurement-v2',
    calibrationAnalysis: 'calibration-analysis-v2',
    confirmationMeasurement: 'confirmation-measurement-v2',
    confirmationAnalysis: 'confirmation-analysis-v2',
    verifiedAdmission: 'verified-admission-v2',
    activeAdmission: 'active-admission-v2',
    rejectedAdmission: 'rejected-admission-v2',
    rejectedEvolution: 'rejected-evolution-v1',
    paceState: 'pace-task-cluster-state-v1',
    paceGateRecord: 'pace-v2-gate-record-v1',
    resourceBudgetLedger: 'resource-budget-ledger-v1',
    vnextExecutionEvidence: 'vnext-execution-evidence-v1'
  };
  state.derivedArtifacts = {};
  for (const [key, record] of Object.entries(expectedDerivedRecords(verification))) {
    if (record == null) continue;
    state.derivedArtifacts[key] = evidenceArtifact(
      store,
      runId,
      `derived-${key.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`,
      roles[key],
      record
    );
  }
  state.derivationsSealed = true;
  store.save(state);
}

function executeStage({
  store,
  state,
  config,
  plan,
  stage,
  worker,
  clock,
  block,
  onCallPersisted,
  onDispatchPersisted,
  shouldStop
}) {
  const flat = flattenedConfig(config);
  for (const scheduled of stageSchedule(plan, stage)) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      return { status: 'OPERATOR_STOP' };
    }
    const existing = state.calls.find((call) => call.callIndex === scheduled.callIndex);
    if (existing) continue;
    const ambiguous = state.dispatchIntents.find((intent) => (
      intent.callIndex === scheduled.callIndex
    ));
    if (ambiguous) {
      return block(
        'AMBIGUOUS_DISPATCH_NOT_RETRIED',
        `${stage} ${scheduled.taskId} has a persisted dispatch intent without a completed receipt.`
      );
    }
    const task = stageTask(config, stage, scheduled.taskId);
    const contract = repairContract(flat, task, scheduled.arm);
    const prefix = `call-${String(scheduled.callIndex + 1).padStart(3, '0')}`;
    const inputs = persistInputs(store, state.runId, prefix, contract);
    let budgetReservation = null;
    if (config.resourceBudgetPolicy) {
      const reserved = reserveResourceBudget(state.resourceBudgetLedger, {
        callId: prefix,
        maxInputTokens: config.perCallBudget.maxInputTokens,
        maxOutputTokens: config.perCallBudget.maxOutputTokens,
        createdAt: clock()
      });
      if (reserved.status !== 'OK') {
        return block(
          reserved.code || 'RESOURCE_BUDGET_RESERVATION_FAILED',
          `${stage} ${scheduled.taskId} could not reserve its frozen resource budget.`,
          null,
          { ...scheduled, ...inputs }
        );
      }
      state.resourceBudgetLedger = reserved.ledger;
      budgetReservation = reserved.reservation;
    }
    state.dispatchIntents.push({
      ...scheduled,
      attempt: 0,
      createdAt: clock(),
      contractArtifactRef: inputs.contractArtifactRef,
      contractSha256: inputs.contractSha256,
      promptArtifactRef: inputs.promptArtifactRef,
      promptArtifactSha256: inputs.promptArtifactSha256,
      budgetReservationId: budgetReservation?.reservationId ?? null,
      budgetReservationSha256: budgetReservation?.entrySha256 ?? null
    });
    state.updatedAt = clock();
    store.save(state);
    if (typeof onDispatchPersisted === 'function') {
      onDispatchPersisted(state.dispatchIntents.at(-1));
    }
    let packet;
    try {
      packet = worker({ ...contract, attempt: 0 });
    } catch (error) {
      packet = {
        __execReason: 'WORKER_THROW',
        __error: String(error?.message || error)
      };
    }
    let budgetSettlement = null;
    if (config.resourceBudgetPolicy) {
      const details = packet?.invocation?.tokenUsageDetails;
      const inputTokens = Number(details?.inputTokens ?? 0)
        + Number(details?.cacheCreationInputTokens ?? 0)
        + Number(details?.cacheReadInputTokens ?? 0);
      const outputTokens = Number(details?.outputTokens);
      if (!Number.isInteger(inputTokens) || inputTokens < 0
          || !Number.isInteger(outputTokens) || outputTokens < 0
          || packet?.invocation?.tokenUsageAuthority !== 'cli-reported') {
        return block(
          'RESOURCE_BUDGET_USAGE_UNAVAILABLE',
          `${stage} ${scheduled.taskId} did not return trusted input/output token usage.`,
          packet,
          { ...scheduled, ...inputs, budgetReservationId: budgetReservation.reservationId }
        );
      }
      const settled = settleResourceBudget(state.resourceBudgetLedger, {
        reservationId: budgetReservation.reservationId,
        inputTokens,
        outputTokens,
        settledAt: clock(),
        usageAuthority: 'cli-receipt'
      });
      state.resourceBudgetLedger = settled.ledger;
      budgetSettlement = settled.settlement;
      state.updatedAt = clock();
      store.save(state);
      if (settled.status !== 'OK') {
        return block(
          settled.code || 'RESOURCE_BUDGET_SETTLEMENT_FAILED',
          `${stage} ${scheduled.taskId} exceeded its frozen call reservation.`,
          packet,
          { ...scheduled, ...inputs, budgetReservationId: budgetReservation.reservationId }
        );
      }
    }
    const payload = proposalPayload(contract, packet);
    const accepted = !!payload && invocationMatches(config, packet?.invocation);
    state.verdictEvents.push({
      ...scheduled,
      accepted,
      attempt: 0,
      reasons: accepted
        ? []
        : [payload ? 'MODEL_AUTHORITY_UNPROVEN' : 'REPAIR_OUTPUT_INVALID'],
      invocation: packet?.invocation || null
    });
    store.save(state);
    if (!payload) {
      return block(
        'REPAIR_OUTPUT_INVALID',
        `${stage} ${task.id} replicate ${scheduled.replicate} returned an invalid bound repair.`,
        packet,
        { ...scheduled, ...inputs }
      );
    }
    if (!invocationMatches(config, packet.invocation)) {
      return block(
        'MODEL_AUTHORITY_UNPROVEN',
        `${stage} ${task.id} model authority or isolation did not match the sealed plan.`,
        packet,
        { ...scheduled, ...inputs }
      );
    }
    const persisted = persistCanaryProposal(store, state.runId, packet, config.model, {
      artifactPrefix: prefix,
      normalizationContract: contract
    });
    if (!persisted.ok) {
      return block(
        'REPAIR_RECEIPT_INVALID',
        `${stage} ${task.id}: ${persisted.reason}`,
        packet,
        { ...scheduled, ...inputs }
      );
    }
    const material = stageMaterial(config, stage, task.id);
    const evaluation = evaluateExecutableCandidate({
      source: persisted.revisedContent,
      caseSet: material.caseSet,
      authority: config.evaluatorAuthority,
      taskId: task.id,
      diagnostics: true
    });
    if (!evaluation.instrumentValid) {
      return block(
        'EXECUTABLE_EVALUATOR_INVALID',
        `${stage} ${task.id}: ${evaluation.code}`,
        packet,
        { ...scheduled, ...inputs }
      );
    }
    const measured = persistEvaluation(
      store,
      state.runId,
      prefix,
      persisted.revisedContent,
      evaluation
    );
    state.calls.push({
      ...persisted.record,
      ...inputs,
      ...scheduled,
      sourceSha256: material.source.sha256,
      incidentSha256: material.incident.sha256,
      interfaceSha256: material.interface.semanticSha256,
      oracleSha256: material.oracle.sha256,
      budgetReservationId: budgetReservation?.reservationId ?? null,
      budgetSettlementSha256: budgetSettlement?.entrySha256 ?? null,
      candidateArtifactRef: measured.candidateArtifactRef,
      candidateSha256: measured.candidateSha256,
      sandboxStdoutArtifactRef: measured.sandboxStdoutArtifactRef,
      sandboxStdoutSha256: measured.sandboxStdoutSha256,
      sandboxStderrArtifactRef: measured.sandboxStderrArtifactRef,
      sandboxStderrSha256: measured.sandboxStderrSha256,
      evaluationArtifactRef: measured.evaluationArtifactRef,
      evaluationSha256: measured.evaluationSha256
    });
    state.updatedAt = clock();
    store.save(state);
    if (typeof onCallPersisted === 'function') onCallPersisted(state.calls.at(-1));
  }
  return ok();
}

export function runAdaptiveRecursiveCanaryV2(store, config, {
  runId,
  worker = adaptiveRecursiveCanaryWorker,
  clock = nowIso,
  onCallPersisted = null,
  onDispatchPersisted = null,
  shouldStop = () => false
} = {}) {
  if (!isSafeId(runId)) return refused('BAD_RUN_ID', 'A safe recursive V2 --run-id is required.');
  if (typeof worker !== 'function') return refused('NO_WORKER', 'Recursive V2 requires a worker backend.');
  const validation = validateAdaptiveRecursiveCanaryV2Config(config);
  if (!validation.ok) {
    return refused('RECURSIVE_V2_CONFIG_INVALID', validation.errors.join('; '), {
      errors: validation.errors,
      plan: validation.plan
    });
  }
  if (config.vnextBinding) {
    if (config.vnextBinding.preparationRunId === runId) {
      return refused(
        'VNEXT_PREPARATION_RUN_COLLISION',
        'The preparation proof and recursive experiment must use different run IDs.'
      );
    }
    const vnextExecution = replayVNextExecution(store, config);
    if (vnextExecution.status !== 'OK') {
      return refused(
        'VNEXT_EXECUTION_BINDING_INVALID',
        'The persisted preparation proof does not rederive this executable candidate.',
        { verification: vnextExecution }
      );
    }
  }
  const resuming = store.exists(runId);
  let state;
  if (resuming) {
    state = store.load(runId);
    const sealed = parseArtifactJson(readArtifact(
      store,
      runId,
      state?.evidenceArtifacts?.config?.id
    ));
    if (state?.kind !== ADAPTIVE_RECURSIVE_RUN_KIND_V2
        || stableJson(sealed) !== stableJson(config)
        || state.plan?.sha256 !== validation.plan.sha256) {
      return refused(
        'RECURSIVE_V2_RESUME_BINDING_MISMATCH',
        'Existing recursive V2 state does not match the supplied sealed config and plan.'
      );
    }
    if (['CALIBRATION_REJECTED', 'QUEUE_DRAINED'].includes(state.status)) {
      const verification = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
      return {
        status: 'OK',
        runId,
        reportPath: state.reportPath,
        statePath: `${store.runDir(runId)}/state.json`,
        experimentValid: verification.experimentValid,
        calibrationQualified: verification.calibrationQualified,
        causalPass: verification.causalPass,
        activationEligible: verification.activationEligible,
        idempotent: true,
        verification
      };
    }
    if (state.status === 'BLOCKED') {
      return refused('RECURSIVE_V2_RUN_BLOCKED', 'A blocked recursive V2 run cannot be retried.');
    }
  } else {
    const createdAt = clock();
    state = {
      schemaVersion: 2,
      kind: ADAPTIVE_RECURSIVE_RUN_KIND_V2,
      runId,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      status: 'RUNNING',
      approvedPlanSha256: config.approvedPlanSha256,
      plan: validation.plan,
      evidenceArtifacts: {},
      derivedArtifacts: {},
      derivationsSealed: false,
      dispatchIntents: [],
      calls: [],
      verdictEvents: [],
      failureEvidence: [],
      promotion: { enabled: false, recorded: false },
      verification: null,
      outcome: null,
      blocker: null,
      resourceBudgetLedger: null,
      reportPath: null
    };
    if (config.resourceBudgetPolicy) {
      const budget = createResourceBudgetLedger({
        policy: config.resourceBudgetPolicy,
        runId,
        createdAt
      });
      if (budget.status !== 'OK') {
        return refused('RESOURCE_BUDGET_LEDGER_INVALID', 'VNext recursive V2 budget ledger could not be initialized.');
      }
      state.resourceBudgetLedger = budget.ledger;
    }
    store.save(state);
    state.evidenceArtifacts = {
      config: evidenceArtifact(store, runId, 'sealed-recursive-v2-config', 'config', config),
      plan: evidenceArtifact(store, runId, 'sealed-recursive-v2-plan', 'plan', validation.plan),
      runtimeAuthority: evidenceArtifact(store, runId, 'sealed-recursive-v2-oauth', 'runtime-authority', config.runtimeAuthority),
      evaluatorAuthority: evidenceArtifact(store, runId, 'sealed-recursive-v2-evaluator', 'evaluator-authority', config.evaluatorAuthority),
      implementation: evidenceArtifact(store, runId, 'sealed-recursive-v2-implementation', 'implementation', config.implementationCapsule),
      taskMaterials: evidenceArtifact(store, runId, 'sealed-recursive-v2-task-materials', 'task-materials', config.taskMaterials),
      proposalSchema: evidenceArtifact(
        store,
        runId,
        'recursive-v2-proposal-schema',
        'output-schema',
        readFileSync(schemaPathForContract({ kind: 'proposal' }), 'utf8')
      ),
      ...(config.resourceBudgetPolicy ? {
        resourceBudgetPolicy: evidenceArtifact(
          store,
          runId,
          'sealed-recursive-v2-resource-budget-policy',
          'resource-budget-policy',
          config.resourceBudgetPolicy
        ),
        initialResourceBudgetLedger: evidenceArtifact(
          store,
          runId,
          'sealed-recursive-v2-initial-resource-budget-ledger',
          'resource-budget-ledger-initial',
          state.resourceBudgetLedger
        )
      } : {}),
      ...(config.vnextBinding ? {
        vnextExecutionBinding: evidenceArtifact(
          store,
          runId,
          'sealed-vnext-execution-binding',
          'vnext-execution-binding',
          config.vnextBinding
        )
      } : {}),
      ...(config.pacePolicy ? {
        pacePolicy: evidenceArtifact(
          store,
          runId,
          'sealed-vnext-pace-policy',
          'pace-policy',
          config.pacePolicy
        )
      } : {})
    };
    store.save(state);
  }

  const block = (code, message, packet = null, context = {}) => {
    if (packet) {
      state.failureEvidence.push(persistRejectedDispatch(
        store,
        runId,
        packet,
        config.model,
        {
          artifactPrefix: `failed-${String(state.verdictEvents.length).padStart(3, '0')}`,
          kind: 'recursive-v2-repair',
          reasons: [code],
          attempt: 0,
          context
        }
      ));
    }
    state.status = 'BLOCKED';
    state.blocker = { code, message };
    state.updatedAt = clock();
    store.save(state);
    const verification = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
    state.verification = verification;
    state.outcome = { experimentValid: false, causalPass: false };
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-recursive-canary-v2-report.md',
      renderReport(state, verification)
    );
    store.save(state);
    return {
      status: 'BLOCKED',
      code,
      message,
      runId,
      verification,
      reportPath: state.reportPath
    };
  };

  const stop = () => {
    state.status = 'OPERATOR_STOP';
    state.updatedAt = clock();
    store.save(state);
    const verification = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
    state.verification = verification;
    state.outcome = { experimentValid: false, causalPass: false };
    state.reportPath = store.writeRunFile(
      runId,
      'adaptive-recursive-canary-v2-report.md',
      renderReport(state, verification)
    );
    store.save(state);
    return {
      status: 'OPERATOR_STOP',
      runId,
      experimentValid: false,
      causalPass: false,
      verification,
      reportPath: state.reportPath
    };
  };

  if (resuming) {
    const completedCallIndexes = new Set(state.calls.map((call) => call.callIndex));
    const unresolvedIntents = state.dispatchIntents.filter((intent) => (
      !completedCallIndexes.has(intent.callIndex)
    ));
    if (unresolvedIntents.length > 0) {
      const budget = config.resourceBudgetPolicy
        ? verifyResourceBudgetLedger(state.resourceBudgetLedger)
        : null;
      const unresolved = new Map((budget?.unresolvedReservations || []).map((row) => (
        [row.reservationId, row]
      )));
      const budgetBound = !config.resourceBudgetPolicy || unresolvedIntents.every((intent) => (
        unresolved.get(intent.budgetReservationId)?.entrySha256
          === intent.budgetReservationSha256
      ));
      return block(
        budgetBound
          ? 'AMBIGUOUS_DISPATCH_NOT_RETRIED'
          : 'AMBIGUOUS_DISPATCH_BUDGET_INVALID',
        budgetBound
          ? 'A persisted dispatch intent has no completed receipt and will not be retried.'
          : 'An ambiguous dispatch is not bound to one durable unresolved budget reservation.'
      );
    }
    const replay = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
    if (!replay.resumeValid) {
      return block(
        'RECURSIVE_V2_RESUME_INVALID',
        `Persisted recursive V2 prefix failed replay: ${replay.reasons.join('; ')}`
      );
    }
  }

  if (state.calls.length < ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls) {
    const calibrationRun = executeStage({
      store,
      state,
      config,
      plan: validation.plan,
      stage: 'calibration',
      worker,
      clock,
      block,
      onCallPersisted,
      onDispatchPersisted,
      shouldStop
    });
    if (calibrationRun.status === 'OPERATOR_STOP') return stop();
    if (calibrationRun.status !== 'OK') return calibrationRun;
  }

  if (state.calls.length === ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls) {
    state.status = 'CALIBRATION_DRAINED';
    state.updatedAt = clock();
    store.save(state);
  }
  const checkpoint = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
  const calibrationReplayValid = state.calls.length
      === ADAPTIVE_RECURSIVE_CANARY_V2.calibrationCalls
    ? checkpoint.checkpointValid
    : checkpoint.resumeValid;
  if (!calibrationReplayValid
      || typeof checkpoint.calibrationQualified !== 'boolean') {
    return block(
      'CALIBRATION_REPLAY_INVALID',
      `Independent calibration replay failed: ${checkpoint.reasons.join('; ')}`
    );
  }

  if (!checkpoint.calibrationQualified) {
    state.status = 'CALIBRATION_REJECTED';
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
  } else {
    const confirmationRun = executeStage({
      store,
      state,
      config,
      plan: validation.plan,
      stage: 'confirmation',
      worker,
      clock,
      block,
      onCallPersisted,
      onDispatchPersisted,
      shouldStop
    });
    if (confirmationRun.status === 'OPERATOR_STOP') return stop();
    if (confirmationRun.status !== 'OK') return confirmationRun;
    state.status = 'QUEUE_DRAINED';
    state.completedAt = clock();
    state.updatedAt = state.completedAt;
    store.save(state);
  }

  let verification = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
  persistDerivedArtifacts(store, runId, state, verification);
  verification = verifyAdaptiveRecursiveCanaryV2Run(store, runId);
  state.verification = verification;
  state.outcome = {
    experimentValid: verification.experimentValid,
    calibrationQualified: verification.calibrationQualified,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible
  };
  state.reportPath = store.writeRunFile(
    runId,
    'adaptive-recursive-canary-v2-report.md',
    renderReport(state, verification)
  );
  store.save(state);
  return {
    status: 'OK',
    runId,
    reportPath: state.reportPath,
    statePath: `${store.runDir(runId)}/state.json`,
    experimentValid: verification.experimentValid,
    calibrationQualified: verification.calibrationQualified,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible,
    verification
  };
}
