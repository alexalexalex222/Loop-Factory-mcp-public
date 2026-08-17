import { isSafeId, round, sha256 } from './util.mjs';
import { stableJson } from './canary-runner.mjs';
import {
  ADAPTIVE_EXECUTABLE_CANARY,
  ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4,
  verifyAdaptiveExecutableCanaryRun
} from './adaptive-executable-canary.mjs';
import { REAL_TEST_MODEL } from './real-test.mjs';
import {
  canonicalAdaptiveJson,
  createAdaptiveCanaryImportRecord,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { createAdaptiveMeasurementRecord } from './adaptive-measurement-v2.mjs';

export const ADAPTIVE_CANARY_IMPORT_REQUIRED_GATES = Object.freeze([
  'configIntegrity',
  'implementationIntegrity',
  'interfaceCoverage',
  'mechanismCompileCoverage',
  'shamReplay',
  'partitionIsolation',
  'privateEvidenceWithheld',
  'preflight',
  'receipts',
  'modelAuthority',
  'strictIsolation',
  'promptBinding',
  'treatmentBinding',
  'treatmentParity',
  'schedule',
  'sandboxAuthority',
  'measurementDerivation',
  'artifactHashes',
  'failureEvidenceIntegrity',
  'noRetries',
  'noPromotion',
  'stateConsistency'
]);

const ARMS = Object.freeze(['baseline', 'routed', 'sham']);
const SHA256_RE = /^[a-f0-9]{64}$/;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function artifactValid(artifact) {
  return artifact
    && typeof artifact.content === 'string'
    && SHA256_RE.test(String(artifact.sha256 || ''))
    && artifact.sha256 === sha256(artifact.content)
    && (artifact.bytes == null || artifact.bytes === Buffer.byteLength(artifact.content));
}

function parseArtifactJson(artifact) {
  if (!artifactValid(artifact)) return null;
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

function verifierHashValid(verification) {
  if (!SHA256_RE.test(String(verification?.evidenceSha256 || ''))) return false;
  const payload = { ...verification };
  delete payload.evidenceSha256;
  return verification.evidenceSha256 === sha256(stableJson(payload));
}

function fullRepair(row) {
  return row.targetQuality === 1 && row.controlQuality === 1;
}

function percentDelta(baseline, challenger) {
  return baseline > 0 ? round((challenger - baseline) / baseline) : null;
}

function hashRows(rows) {
  return sha256(canonicalAdaptiveJson(rows));
}

function confirmationPairs(config, verification) {
  const taskIds = (Array.isArray(config.tasks) ? config.tasks : [])
    .filter((task) => task.phase === 'confirmation')
    .map((task) => task.id);
  if (taskIds.length !== ADAPTIVE_EXECUTABLE_CANARY.confirmationTasks
      || new Set(taskIds).size !== taskIds.length) {
    return refused(
      'CANARY_CONFIRMATION_SET_INVALID',
      'The V4 confirmation task set is incomplete or duplicated.'
    );
  }
  const armRows = Object.fromEntries(ARMS.map((arm) => {
    const rows = (Array.isArray(verification.series?.[arm])
      ? verification.series[arm]
      : []).filter((row) => row.stage === 'confirmation');
    return [arm, rows];
  }));
  const byArm = Object.fromEntries(ARMS.map((arm) => {
    return [arm, new Map(armRows[arm].map((row) => [row.taskId, row]))];
  }));
  if (ARMS.some((arm) => (
    armRows[arm].length !== taskIds.length
    || byArm[arm].size !== taskIds.length
    || taskIds.some((taskId) => !byArm[arm].has(taskId))
  ))) {
    return refused(
      'CANARY_CONFIRMATION_PAIRING_INVALID',
      'Baseline, routed, and sham arms must contain the same complete confirmation task set.'
    );
  }
  const pairs = taskIds.map((taskId) => ({
    taskId,
    baseline: byArm.baseline.get(taskId),
    routed: byArm.routed.get(taskId),
    sham: byArm.sham.get(taskId)
  }));
  for (const pair of pairs) {
    for (const arm of ARMS) {
      const row = pair[arm];
      if (!row || row.taskId !== pair.taskId
          || !Number.isFinite(row.targetQuality)
          || !Number.isFinite(row.controlQuality)
          || row.targetQuality < 0 || row.targetQuality > 1
          || row.controlQuality < 0 || row.controlQuality > 1
          || !Number.isInteger(row.tokenCost) || row.tokenCost <= 0
          || !isSafeId(row.artifactRef)) {
        return refused(
          'CANARY_CONFIRMATION_MEASUREMENT_INVALID',
          'Every confirmation arm needs finite bounded quality, a positive token receipt, and a persisted evaluation reference.'
        );
      }
    }
  }
  return ok({ taskIds, pairs });
}

function measurementFromPairs(pairs) {
  const baselineFullRepairs = pairs.filter((pair) => fullRepair(pair.baseline)).length;
  const routedFullRepairs = pairs.filter((pair) => fullRepair(pair.routed)).length;
  const shamFullRepairs = pairs.filter((pair) => fullRepair(pair.sham)).length;
  const routedWins = pairs.filter((pair) => (
    !fullRepair(pair.baseline) && fullRepair(pair.routed)
  )).length;
  const targetRegressions = pairs.filter((pair) => (
    pair.routed.targetQuality < pair.baseline.targetQuality
  )).length;
  const controlRegressions = pairs.filter((pair) => (
    pair.routed.controlQuality < pair.baseline.controlQuality
  )).length;
  const shamWins = pairs.filter((pair) => (
    Number(fullRepair(pair.sham)) > Number(fullRepair(pair.baseline))
  )).length;
  const count = pairs.length;
  const baselineTokens = pairs.reduce((sum, pair) => sum + pair.baseline.tokenCost, 0);
  const routedTokens = pairs.reduce((sum, pair) => sum + pair.routed.tokenCost, 0);
  const shamTokens = pairs.reduce((sum, pair) => sum + pair.sham.tokenCost, 0);
  return {
    confirmationCaseCount: count,
    baselineFullRepairs,
    routedFullRepairs,
    shamFullRepairs,
    routedWins,
    qualityDelta: round((routedFullRepairs - baselineFullRepairs) / count),
    shamMovement: round((shamFullRepairs - baselineFullRepairs) / count),
    targetRegressions,
    controlRegressions,
    shamWins,
    tokens: {
      baseline: baselineTokens,
      routed: routedTokens,
      sham: shamTokens,
      routedDeltaPct: percentDelta(baselineTokens, routedTokens),
      shamDeltaPct: percentDelta(baselineTokens, shamTokens)
    }
  };
}

function evidenceArtifacts({ state, config, verification, readArtifact }) {
  const rows = ARMS.flatMap((arm) => (
    (Array.isArray(verification.series?.[arm]) ? verification.series[arm] : [])
      .map((row) => ({ arm, ...row }))
  ));
  if (rows.length !== ADAPTIVE_EXECUTABLE_CANARY.maximumCalls
      || new Set(rows.map((row) => `${row.arm}:${row.stage}:${row.taskId}`)).size
        !== rows.length
      || new Set(rows.map((row) => row.artifactRef)).size !== rows.length
      || rows.some((row) => (
        !Number.isInteger(row.tokenCost) || row.tokenCost <= 0
        || !Number.isFinite(row.targetQuality)
        || !Number.isFinite(row.controlQuality)
      ))) {
    return refused(
      'CANARY_EVALUATION_SET_INVALID',
      'A passing V4 import must expose the complete unique evaluation schedule.'
    );
  }
  const evaluations = [];
  const measurementEvaluations = [];
  for (const row of rows) {
    if (!isSafeId(row.artifactRef)) {
      return refused('CANARY_EVALUATION_REF_INVALID', 'An evaluation artifact reference is invalid.');
    }
    const artifact = readArtifact(row.artifactRef);
    if (!artifactValid(artifact)) {
      return refused(
        'CANARY_EVALUATION_ARTIFACT_INVALID',
        `Evaluation artifact ${row.artifactRef} is missing or hash-invalid.`
      );
    }
    const evaluation = parseArtifactJson(artifact);
    if (!evaluation
        || !Array.isArray(evaluation.results)
        || evaluation.targetQuality !== row.targetQuality
        || evaluation.controlQuality !== row.controlQuality) {
      return refused(
        'CANARY_EVALUATION_CONTENT_INVALID',
        `Evaluation artifact ${row.artifactRef} does not reproduce its verifier series row.`
      );
    }
    evaluations.push({
      arm: row.arm,
      stage: row.stage,
      taskId: row.taskId,
      artifactSha256: artifact.sha256
    });
    measurementEvaluations.push({
      arm: row.arm,
      stage: row.stage,
      taskId: row.taskId,
      artifactRef: row.artifactRef,
      artifactSha256: artifact.sha256,
      tokenCost: row.tokenCost,
      results: evaluation.results
    });
  }
  const evaluatorRef = state.evidenceArtifacts?.evaluatorAuthority?.id;
  const evaluatorArtifact = isSafeId(evaluatorRef) ? readArtifact(evaluatorRef) : null;
  const evaluatorConfig = parseArtifactJson(evaluatorArtifact);
  if (!artifactValid(evaluatorArtifact)
      || state.evidenceArtifacts?.evaluatorAuthority?.sha256 !== evaluatorArtifact.sha256
      || !evaluatorConfig
      || canonicalAdaptiveJson(evaluatorConfig)
        !== canonicalAdaptiveJson(config.evaluatorAuthority)) {
    return refused(
      'CANARY_EVALUATOR_ARTIFACT_INVALID',
      'The sealed executable evaluator authority is missing, hash-invalid, or not bound to the verified config.'
    );
  }
  const seriesBySlot = new Map(rows.map((row) => [
    `${row.arm}:${row.stage}:${row.taskId}`,
    row
  ]));
  const calls = Array.isArray(state.calls) ? state.calls : [];
  if (calls.length !== rows.length
      || new Set(calls.map((call) => (
        `${call.armRole}:${call.stage}:${call.taskId}`
      ))).size !== calls.length
      || new Set(calls.map((call) => call.rawArtifactRef)).size !== calls.length) {
    return refused(
      'CANARY_TOKEN_RECEIPT_SET_INVALID',
      'The accepted call set does not contain one unique raw token receipt per scheduled slot.'
    );
  }
  const tokenReceipts = [];
  for (const call of calls) {
    const slot = `${call.armRole}:${call.stage}:${call.taskId}`;
    const seriesRow = seriesBySlot.get(slot);
    const raw = isSafeId(call.rawArtifactRef)
      ? readArtifact(call.rawArtifactRef)
      : null;
    const result = isSafeId(call.resultArtifactRef)
      ? readArtifact(call.resultArtifactRef)
      : null;
    if (!seriesRow || !artifactValid(raw) || !artifactValid(result)
        || call.cliReportedTotalTokens !== seriesRow.tokenCost
        || !Number.isInteger(call.cliReportedTotalTokens)
        || call.cliReportedTotalTokens <= 0) {
      return refused(
        'CANARY_TOKEN_RECEIPT_INVALID',
        'A scheduled call is missing its hash-bound raw/result token receipt.'
      );
    }
    tokenReceipts.push({
      arm: call.armRole,
      stage: call.stage,
      taskId: call.taskId,
      tokenCost: call.cliReportedTotalTokens,
      rawArtifactSha256: raw.sha256,
      resultArtifactSha256: result.sha256
    });
  }
  tokenReceipts.sort((left, right) => (
    `${left.arm}:${left.stage}:${left.taskId}`.localeCompare(
      `${right.arm}:${right.stage}:${right.taskId}`
    )
  ));
  return ok({
    evaluations,
    evaluatorAuthoritySha256: evaluatorArtifact.sha256,
    measurementEvaluations,
    tokenReceipts
  });
}

function planEvidence(state) {
  const tasks = Array.isArray(state.plan?.tasks) ? state.plan.tasks : [];
  if (tasks.length !== ADAPTIVE_EXECUTABLE_CANARY.qualificationTasks
      + ADAPTIVE_EXECUTABLE_CANARY.confirmationTasks) {
    return refused('CANARY_PLAN_TASKS_INVALID', 'The verified V4 plan task set is incomplete.');
  }
  const requiredHashes = [
    'oracleSha256',
    'interfaceSha256',
    'interfaceCoverageSha256',
    'routedCompilationSha256',
    'shamCompilationSha256'
  ];
  if (tasks.some((task) => (
    !isSafeId(task.id)
    || requiredHashes.some((field) => !SHA256_RE.test(String(task[field] || '')))
    || task.routedCompileCoverage !== 1
    || task.shamCompileCoverage !== 1
  ))) {
    return refused(
      'CANARY_PLAN_EVIDENCE_INVALID',
      'The verified V4 plan does not bind complete cases, interfaces, and compiled treatments.'
    );
  }
  return ok({
    caseSetSha256: hashRows(tasks.map((task) => ({
      taskId: task.id,
      oracleSha256: task.oracleSha256
    }))),
    interfaceSetSha256: hashRows(tasks.map((task) => ({
      taskId: task.id,
      interfaceSha256: task.interfaceSha256,
      interfaceCoverageSha256: task.interfaceCoverageSha256
    }))),
    compilationSetSha256: hashRows(tasks.map((task) => ({
      taskId: task.id,
      routedCompilationSha256: task.routedCompilationSha256,
      shamCompilationSha256: task.shamCompilationSha256
    })))
  });
}

export function buildAdaptiveCanaryImport({
  state,
  configArtifact,
  verification,
  readArtifact,
  automatic = false
} = {}) {
  try {
    if (!state || state.kind !== 'adaptive-executable-canary'
        || !isSafeId(state.runId) || typeof readArtifact !== 'function') {
      return refused('CANARY_STATE_INVALID', 'A persisted executable canary state and artifact reader are required.');
    }
    if (!artifactValid(configArtifact)
        || state.evidenceArtifacts?.config?.sha256 !== configArtifact.sha256) {
      return refused('CANARY_CONFIG_ARTIFACT_INVALID', 'The sealed executable canary config is missing or hash-invalid.');
    }
    const config = parseArtifactJson(configArtifact);
    if (!config) return refused('CANARY_CONFIG_INVALID', 'The sealed executable canary config is not valid JSON.');
    if (config.schemaVersion !== ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4
        || state.plan?.profile !== ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4) {
      return refused('CANARY_V4_REQUIRED', 'Only the V4 executable canary contract may enter adaptive memory.');
    }
    if (config.fixtureOnly !== false || state.plan?.fixtureOnly !== false) {
      return refused('CANARY_FIXTURE_REFUSED', 'Fixture-only canary evidence cannot enter active adaptive routing.');
    }
    if (automatic === true && config.adaptiveMemoryImportEnabled !== true) {
      return refused(
        'CANARY_IMPORT_NOT_PREDECLARED',
        'Automatic import must be enabled in the sealed canary config before launch.'
      );
    }
    if (!verifierHashValid(verification)
        || verification.runId !== state.runId
        || verification.status !== 'PASS'
        || verification.experimentValid !== true
        || verification.causalPass !== true
        || verification.activationEligible !== false
        || ADAPTIVE_CANARY_IMPORT_REQUIRED_GATES.some((gate) => (
          verification.gates?.[gate] !== true
        ))) {
      return refused(
        'CANARY_VERIFICATION_FAILED',
        'The independently recomputed V4 verifier did not clear every import gate.'
      );
    }
    if (config.model !== REAL_TEST_MODEL
        || verification.modelAuthority?.requestedModel !== REAL_TEST_MODEL
        || verification.modelAuthority?.authMode !== 'chatgpt-oauth'
        || verification.modelAuthority?.launchAuthority !== true) {
      return refused('CANARY_MODEL_AUTHORITY_INVALID', 'Exact GPT-5.6 Sol OAuth launch authority is required.');
    }
    if (verification.tokenUsage?.unmeasuredCalls !== 0
        || verification.tokenUsage?.measuredCalls !== ADAPTIVE_EXECUTABLE_CANARY.maximumCalls
        || !Number.isInteger(verification.tokenUsage?.total)
        || verification.tokenUsage.total <= 0) {
      return refused('CANARY_TOKEN_EVIDENCE_INCOMPLETE', 'Every accepted canary call needs a measured token receipt.');
    }
    if (state.promotion?.enabled !== false || state.promotion?.recorded !== false) {
      return refused('CANARY_PROMOTION_RECORDED', 'Canary import refuses experiments that enabled or recorded promotion.');
    }
    const paired = confirmationPairs(config, verification);
    if (paired.status !== 'OK') return paired;
    const measurement = measurementFromPairs(paired.pairs);
    const routedControlFailures = paired.pairs.filter((pair) => (
      pair.routed.controlQuality < 1
    )).length;
    const outcome = object(verification.outcome);
    if (outcome.status !== 'PASS'
        || outcome.repairFailureMetric !== 'full-repair'
        || outcome.routedPairedWins !== measurement.routedWins
        || outcome.shamPairedWins !== measurement.shamWins
        || outcome.routedAdvantage !== measurement.routedWins - measurement.shamWins
        || outcome.routedTargetRegressions !== measurement.targetRegressions
        || outcome.routedPairwise?.control?.regressed !== measurement.controlRegressions
        || outcome.routedControlFailures !== routedControlFailures
        || routedControlFailures !== 0) {
      return refused(
        'CANARY_OUTCOME_MISMATCH',
        'The verifier outcome does not match the independently paired confirmation series.'
      );
    }
    if (measurement.targetRegressions > 0) {
      return refused('CANARY_TARGET_REGRESSION', 'A routed confirmation regressed below its paired target baseline.');
    }
    if (measurement.controlRegressions > 0) {
      return refused('CANARY_CONTROL_REGRESSION', 'A routed confirmation regressed below its paired control baseline.');
    }
    if (measurement.shamWins > 0 || measurement.shamMovement !== 0) {
      return refused('CANARY_SHAM_MOVEMENT', 'The schema-matched sham moved the full-repair endpoint.');
    }
    if (!(measurement.qualityDelta > 0)
        || measurement.tokens.routedDeltaPct == null) {
      return refused('CANARY_CAUSAL_LIFT_MISSING', 'The paired confirmation series does not contain positive routed causal lift.');
    }
    const artifacts = evidenceArtifacts({ state, config, verification, readArtifact });
    if (artifacts.status !== 'OK') return artifacts;
    const plan = planEvidence(state);
    if (plan.status !== 'OK') return plan;
    const mechanism = object(config.mechanismContext);
    const routedItems = Array.isArray(mechanism.routedCapsule?.items)
      ? mechanism.routedCapsule.items
      : [];
    if (routedItems.length !== 1 || routedItems[0].semantics !== 'positive-transfer') {
      return refused('CANARY_ROUTED_MECHANISM_INVALID', 'The verified canary must contain exactly one positive routed mechanism.');
    }
    const routedItem = routedItems[0];
    const family = (Array.isArray(mechanism.families) ? mechanism.families : [])
      .find((candidate) => candidate.familyId === routedItem.familyId);
    if (!family || validateAdaptiveRecord(family).status !== 'OK'
        || family.familySha256 !== routedItem.familySha256
        || !family.causalFingerprint?.program) {
      return refused('CANARY_FAMILY_MISMATCH', 'The routed mechanism does not bind one valid executable family record.');
    }
    const familyProgramSha256 = sha256(canonicalAdaptiveJson(
      family.causalFingerprint.program
    ));
    const measurementV2Built = createAdaptiveMeasurementRecord({
      source: {
        kind: ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4,
        runId: state.runId,
        verifierEvidenceSha256: verification.evidenceSha256,
        evaluatorAuthoritySha256: artifacts.evaluatorAuthoritySha256,
        caseSetSha256: plan.caseSetSha256
      },
      profile: 'retrieval-causal-v1',
      armRoles: {
        baseline: 'baseline',
        parent: null,
        sham: 'sham',
        treatment: 'routed'
      },
      mechanismBindings: {
        baseline: null,
        parent: null,
        sham: null,
        treatment: familyProgramSha256
      },
      tasks: paired.pairs.map((pair) => ({
        taskId: pair.taskId,
        arms: Object.fromEntries(ARMS.map((arm) => {
          const evaluation = artifacts.measurementEvaluations.find((item) => (
            item.arm === arm
            && item.stage === 'confirmation'
            && item.taskId === pair.taskId
          ));
          return [arm, evaluation && {
            evaluationArtifactRef: evaluation.artifactRef,
            evaluationArtifactSha256: evaluation.artifactSha256,
            tokenCost: evaluation.tokenCost,
            results: evaluation.results.map((result) => ({
              id: result.id,
              group: result.group,
              pass: result.pass,
              decisionPass: result.decisionPass,
              codePass: result.codePass
            }))
          }];
        }))
      }))
    });
    if (measurementV2Built.status !== 'OK') {
      return refused(
        'CANARY_MEASUREMENT_V2_INVALID',
        measurementV2Built.message,
        { causeCode: measurementV2Built.code }
      );
    }
    const exactCaseDelta = measurementV2Built.record
      .contrasts.treatmentVsBaseline.metrics.exact.delta;
    if (!(exactCaseDelta > 0)) {
      return refused(
        'CANARY_CONTINUOUS_LIFT_MISSING',
        'The full-repair gate passed without positive exact-case causal lift.'
      );
    }
    const decision = object(mechanism.routingDecision);
    const scheduled = Array.isArray(decision.allocationSchedule)
      ? decision.allocationSchedule[routedItem.position]
      : null;
    if (!scheduled || scheduled.position !== routedItem.position
        || scheduled.familyId !== family.familyId
        || scheduled.allocation === 'control'
        || decision.mechanismCapsuleSha256
          !== mechanism.routedCapsule.mechanismCapsuleSha256) {
      return refused('CANARY_ROUTING_BINDING_INVALID', 'The routed family does not match its verified allocation schedule.');
    }
    const evaluationArtifactSha256s = artifacts.evaluations
      .map((item) => item.artifactSha256)
      .sort();
    const pairEvidence = paired.pairs.map((pair) => Object.fromEntries([
      ['taskId', pair.taskId],
      ...ARMS.map((arm) => [arm, {
        targetQuality: pair[arm].targetQuality,
        controlQuality: pair[arm].controlQuality,
        tokenCost: pair[arm].tokenCost,
        evaluationArtifactRef: pair[arm].artifactRef
      }])
    ]));
    const measurementSha256 = hashRows({
      pairs: pairEvidence,
      aggregate: measurement
    });
    const evaluationArtifactSetSha256 = hashRows(artifacts.evaluations);
    const tokenReceiptSetSha256 = hashRows(artifacts.tokenReceipts);
    const tokenReceiptArtifactSha256s = artifacts.tokenReceipts
      .map((item) => item.rawArtifactSha256)
      .sort();
    const shamEvidenceSha256 = hashRows(artifacts.evaluations.filter((item) => (
      item.arm === 'sham'
    )));
    const built = createAdaptiveCanaryImportRecord({
      familyId: family.familyId,
      source: {
        kind: ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4,
        runId: state.runId
      },
      context: {
        ...object(mechanism.routingTarget),
        targetSha256: decision.targetSha256
      },
      routing: {
        routingDecisionId: decision.routingDecisionId,
        routingDecisionSha256: decision.routingDecisionSha256,
        routingPacketSha256: decision.routingPacketSha256,
        policyEpochId: decision.policyEpochId,
        policyEpochSha256: decision.policyEpochSha256,
        allocation: scheduled.allocation,
        schedulePosition: scheduled.position
      },
      outcome: {
        qualityDelta: exactCaseDelta,
        tokenCostDeltaPct: measurement.tokens.routedDeltaPct,
        shamMovement: measurement.shamMovement,
        controlRegressions: measurement.controlRegressions,
        targetRegressions: measurement.targetRegressions,
        shamWins: measurement.shamWins,
        transferChecks: [{
          kind: 'heldOut',
          attempted: true,
          passed: true,
          evidenceSha256: verification.evidenceSha256
        }, {
          kind: 'negativeControl',
          attempted: true,
          passed: true,
          evidenceSha256: shamEvidenceSha256
        }, {
          kind: 'freshReplay',
          attempted: true,
          passed: true,
          evidenceSha256: measurementSha256
        }]
      },
      authority: {
        profile: ADAPTIVE_EXECUTABLE_CANARY_SCHEMA_VERSION_V4,
        model: REAL_TEST_MODEL,
        authMode: 'chatgpt-oauth',
        fixtureOnly: false,
        verificationStatus: 'PASS',
        experimentValid: true,
        causalPass: true,
        allVerifierGatesPassed: true,
        retries: 0,
        promotionRecorded: false,
        activation: 'routing-only'
      },
      evidence: {
        configSha256: configArtifact.sha256,
        planSha256: state.plan.sha256,
        verifierEvidenceSha256: verification.evidenceSha256,
        familySha256: family.familySha256,
        programSha256: familyProgramSha256,
        evaluatorAuthoritySha256: artifacts.evaluatorAuthoritySha256,
        interfaceSetSha256: plan.interfaceSetSha256,
        caseSetSha256: plan.caseSetSha256,
        compilationSetSha256: plan.compilationSetSha256,
        evaluationArtifactSetSha256,
        tokenReceiptSetSha256,
        measurementSha256,
        mechanismCapsuleSha256: mechanism.routedCapsule.mechanismCapsuleSha256,
        confirmationCaseCount: measurement.confirmationCaseCount,
        evaluationArtifactCount: artifacts.evaluations.length,
        evaluationArtifactSha256s,
        tokenReceiptArtifactCount: artifacts.tokenReceipts.length,
        tokenReceiptArtifactSha256s
      }
    });
    if (built.status !== 'OK') return built;
    return ok({
      family,
      record: built.record,
      measurement,
      measurementV2: measurementV2Built.record,
      verification: {
        evidenceSha256: verification.evidenceSha256,
        status: verification.status,
        experimentValid: verification.experimentValid,
        causalPass: verification.causalPass
      }
    });
  } catch (error) {
    return refused('CANARY_IMPORT_BUILD_FAILED', error.message);
  }
}

export function deriveAdaptiveCanaryImport({
  sourceStore,
  runId,
  automatic = false
} = {}) {
  if (!sourceStore || typeof sourceStore.load !== 'function'
      || typeof sourceStore.readArtifact !== 'function' || !isSafeId(runId)) {
    return refused('CANARY_IMPORT_INPUT_INVALID', 'A source store and safe canary run ID are required.');
  }
  const verification = verifyAdaptiveExecutableCanaryRun(sourceStore, runId);
  const state = sourceStore.load(runId);
  const configRef = state?.evidenceArtifacts?.config?.id;
  const configArtifact = isSafeId(configRef)
    ? sourceStore.readArtifact(runId, configRef)
    : null;
  return buildAdaptiveCanaryImport({
    state,
    configArtifact,
    verification,
    readArtifact: (artifactId) => sourceStore.readArtifact(runId, artifactId),
    automatic
  });
}
