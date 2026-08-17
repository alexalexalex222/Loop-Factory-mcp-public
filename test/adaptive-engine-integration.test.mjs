import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  createMechanismApplicationRecord,
  createMechanismFamilyRecord
} from '../src/adaptive-records.mjs';
import {
  ADAPTIVE_CONTROL_ARTIFACT_SOURCE_SCHEMA
} from '../src/adaptive-control-evidence.mjs';
import { buildConsoleSnapshot } from '../src/console.mjs';
import { renderDashboard } from '../src/dashboard.mjs';
import {
  listAdaptiveRecords,
  persistAdaptiveRecord
} from '../src/mechanism-catalog.mjs';
import { DEFAULT_QUALITY_ORACLE, buildMeasuredContent } from '../src/measure.mjs';
import {
  bindHypothesesToMechanismRouting,
  runSupervisedCampaign
} from '../src/supervisor.mjs';
import { sha256 } from '../src/util.mjs';
import { createEngine } from '../src/engine.mjs';
import { createVNextOperatorAction } from '../src/vnext-operator-actions.mjs';
import {
  applyAndPersistVNextOperatorControl,
  initializeVNextOperatorControl
} from '../src/vnext-operator-control.mjs';
import {
  BASELINE_BODY,
  SPECIFIC_TASK,
  freshEngine,
  recordMeasurement
} from './helpers.mjs';

const ROUTES = ['gpt-5.6-sol', 'claude-fable-5', 'gpt-5.6-terra'];
const EXECUTABLE_PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['candidate.quality'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [],
  rules: [{
    ruleId: 'accept-quality',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'role', id: 'candidate.quality' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_PRESENT' }
  }],
  fallback: { decision: 'REJECT', code: 'QUALITY_MISSING' }
};
const EXECUTABLE_INTERFACE = {
  schemaVersion: 'executable-interface-contract-v2',
  exportName: 'evaluateCandidate',
  inputPaths: ['candidate.quality'],
  decisions: ['ACCEPT', 'REJECT'],
  codes: [
    { value: 'QUALITY_PRESENT', meaning: 'Candidate quality is positive.' },
    { value: 'QUALITY_MISSING', meaning: 'Candidate quality is absent.' }
  ],
  roleBindings: [{ role: 'candidate.quality', path: 'candidate.quality' }]
};

function adaptiveControlBundle(engine, runId, testId, {
  controlRegression = false,
  shamTargetQuality = 0.5
} = {}) {
  const rows = {
    baseline: [{ caseId: 'case-1', targetQuality: 0.5, controlQuality: 1 }],
    routed: [{
      caseId: 'case-1',
      targetQuality: 0.8,
      controlQuality: controlRegression ? 0 : 1
    }],
    sham: [{ caseId: 'case-1', targetQuality: shamTargetQuality, controlQuality: 1 }]
  };
  const arms = {};
  for (const armRole of ['baseline', 'routed', 'sham']) {
    arms[armRole] = rows[armRole].map((row) => {
      const record = (metricRole, quality) => {
        const result = engine.artifact_record({
          runId,
          name: `${testId}-${armRole}-${row.caseId}-${metricRole}`,
          role: 'adaptive-control-measurement',
          content: buildMeasuredContent(100, quality, DEFAULT_QUALITY_ORACLE),
          measure: true,
          adaptiveControl: {
            testId,
            armRole,
            metricRole,
            caseId: row.caseId
          }
        });
        assert.equal(result.status, 'OK', result.message);
        return result.artifactId;
      };
      return {
        caseId: row.caseId,
        targetMeasurementRef: record('target', row.targetQuality),
        controlMeasurementRef: record('control', row.controlQuality)
      };
    });
  }
  return {
    sourceArtifactRefs: {
      schemaVersion: ADAPTIVE_CONTROL_ARTIFACT_SOURCE_SCHEMA,
      runId,
      testId,
      arms
    }
  };
}

function historicalMechanism(home, { program = null } = {}) {
  const family = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'unbound-evidence',
      interventionKind: 'precondition-binding',
      operationKind: 'bind-before-generation',
      expectedEffectKind: 'fewer-false-improvements',
      preconditions: ['frozen-baseline', 'frozen-benchmark'],
      ...(program ? { program } : {}),
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['loop-de-loop'],
        taskValueDimensions: ['candidate-precision'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(family.status, 'OK', family.message);
  const application = createMechanismApplicationRecord({
    familyId: family.record.familyId,
    appliedAt: '2026-07-22T20:00:00.000Z',
    partition: 'harvest',
    source: {
      runId: 'historical-run',
      hypothesisId: 'historical-hypothesis',
      testId: 'historical-test'
    },
    context: {
      targetSha256: sha256('historical-target'),
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
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
      tokenCostDeltaPct: -0.1,
      shamMovement: 0,
      controlRegressions: 0,
      reverified: true,
      transferChecks: [{
        kind: 'heldOut',
        attempted: true,
        passed: true,
        evidenceSha256: sha256('historical-held-out')
      }],
      contradictionCodes: []
    },
    credit: {
      confidence: 0.9,
      authority: 'tool-computed'
    },
    provenance: {
      legacyReceiptId: `receipt-${sha256('historical-receipt').slice(0, 24)}`,
      legacyReceiptSha256: sha256('historical-legacy'),
      benchmarkSha256: sha256('historical-benchmark'),
      artifactSetSha256: sha256('historical-artifacts'),
      evidenceSetSha256: sha256('historical-evidence')
    }
  });
  assert.equal(application.status, 'OK', application.message);
  for (const record of [family.record, application.record]) {
    assert.equal(persistAdaptiveRecord({ homeDir: home, record }).status, 'OK');
  }
  return family.record;
}

function hypotheses(count = ROUTES.length) {
  return Array.from({ length: count }, (_, index) => {
    const model = ROUTES[index % ROUTES.length];
    return {
    title: `Bound adaptive hypothesis ${index + 1}`,
    bottleneck: 'The current procedure can generate a plausible change without binding it to a reusable causal mechanism and frozen evidence.',
    operation: 'Generate one evidence-bound intervention while preserving the frozen objective, benchmark, and integrity gates.',
    expectedMovement: 'Increase tool-computed candidate precision at equal or lower token cost.',
    falsifier: 'Reject the intervention if its artifacts do not reverify or the frozen scorecard does not move.',
    evidenceRefs: [{
      path: 'test/adaptive-engine-integration.test.mjs',
      locator: `hypotheses:${index + 1}`
    }],
    route: { model }
    };
  });
}

function bindHypotheses(input, prepared) {
  return bindHypothesesToMechanismRouting(input, prepared, {
    loop: 'loop-de-loop',
    benchmark: {
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
}

function initializeActiveRun(engine, runId) {
  const initialized = engine.initialize_loop_run({
    runId,
    task: SPECIFIC_TASK,
    config: {
      metaLearning: {
        enabled: true,
        mode: 'active-canary',
        seed: 'adaptive-engine-seed'
      }
    }
  });
  assert.equal(initialized.status, 'OK', initialized.message);
  assert.equal(engine.loop_start({ runId, loop: 'loop-de-loop' }).status, 'OK');
  assert.equal(engine.artifact_record({
    runId,
    role: 'baseline',
    name: 'baseline.md',
    content: BASELINE_BODY
  }).status, 'OK');
  const proposed = engine.benchmark_propose({
    runId,
    benchmarks: [{
      name: 'adaptive-engine-benchmark',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost'],
      cases: [{ id: 'case-1', input: 'sealed-corpus', expect: 'qualified candidates' }],
      oracle: DEFAULT_QUALITY_ORACLE
    }]
  });
  assert.equal(proposed.status, 'OK');
  assert.equal(engine.benchmark_select({
    runId,
    benchmarkId: proposed.benchmarkIds[0]
  }).status, 'OK');
  const baseline = recordMeasurement(engine, runId, 'baseline-bar', 1000, 0.7);
  assert.equal(engine.benchmark_run({
    runId,
    arm: 'baseline',
    measurementRef: baseline
  }).status, 'OK');
}

test('active routing is operator-only, precedes hypotheses, and enforces exact bindings', () => {
  const { engine, store, home } = freshEngine();
  const historicalFamily = historicalMechanism(home);
  const unknown = engine.operator.prepareMechanismRouting({
    runId: 'missing-adaptive-run',
    hypothesisCount: 3
  });
  assert.equal(unknown.status, 'BLOCKED');
  assert.equal(unknown.code, 'UNKNOWN_RUN');
  initializeActiveRun(engine, 'adaptive-engine');

  assert.equal(engine.prepareMechanismRouting, undefined);
  const unbound = engine.register_hypotheses({
    runId: 'adaptive-engine',
    hypotheses: hypotheses()
  });
  assert.equal(unbound.status, 'BLOCKED');
  assert.equal(unbound.code, 'ADAPTIVE_ROUTING_REQUIRED');

  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-engine',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  assert.equal(prepared.decision.affectedExecution, true);
  assert.ok(prepared.decision.allocationSchedule.some((item) => item.allocation === 'control'));
  assert.ok(prepared.decision.allocationSchedule.some(
    (item) => item.familyId === historicalFamily.familyId
  ));

  const bound = bindHypotheses(hypotheses(), prepared);
  const tampered = structuredClone(bound);
  tampered[0].routingBinding.routingPacketSha256 = '0'.repeat(64);
  const refused = engine.register_hypotheses({
    runId: 'adaptive-engine',
    hypotheses: tampered
  });
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.code, 'ADAPTIVE_BINDING_MISMATCH');

  const registered = engine.register_hypotheses({
    runId: 'adaptive-engine',
    hypotheses: bound
  });
  assert.equal(registered.status, 'OK', registered.message);
  assert.equal(registered.hypothesisIds.length, 3);

  const state = store.load('adaptive-engine');
  assert.equal(state.adaptiveIntelligence.affectedExecution, true);
  assert.equal(state.adaptiveIntelligence.routing.status, 'CONSUMED');
  assert.equal(state.adaptiveIntelligence.routing.current.consumed, true);
  assert.ok(state.hypotheses.every((hypothesis) => (
    hypothesis.routingBinding.routingDecisionId === prepared.decision.routingDecisionId
    && hypothesis.mechanismFamilyId
  )));
  assert.equal(
    store.runFileExists(
      'adaptive-engine',
      `adaptive-routing/${prepared.decision.routingDecisionId}.capsule.json`
    ),
    true
  );
  const decisions = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.ROUTING_DECISION
  });
  assert.equal(decisions.status, 'OK');
  assert.equal(decisions.records.length, 1);
});

test('engine routing replays the operator quarantine projection before generation', () => {
  const { engine, store, home } = freshEngine();
  const historicalFamily = historicalMechanism(home);
  const initializedControl = initializeVNextOperatorControl({
    homeDir: home,
    createdAt: '2026-08-05T00:00:00.000Z'
  });
  assert.equal(initializedControl.status, 'OK');
  const quarantine = createVNextOperatorAction({
    actionId: 'engine-quarantine-family',
    runId: 'adaptive-operator-quarantine',
    kind: 'quarantine-family',
    target: {
      type: 'family',
      id: historicalFamily.familyId,
      sha256: historicalFamily.familySha256
    },
    expectedRevisionSha256: initializedControl.projection.projectionSha256,
    reasonCode: 'CONTROL_REGRESSION',
    evidenceSha256: sha256('engine-quarantine-evidence'),
    authority: { operatorId: 'operator-1', sessionId: 'session-1' },
    createdAt: '2026-08-05T00:01:00.000Z'
  });
  assert.equal(quarantine.status, 'OK');
  const records = listAdaptiveRecords({ homeDir: home });
  assert.equal(records.status, 'OK');
  const applied = applyAndPersistVNextOperatorControl({
    homeDir: home,
    action: quarantine.action,
    records: records.records
  });
  assert.equal(applied.status, 'OK');

  initializeActiveRun(engine, 'adaptive-operator-quarantine');
  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-operator-quarantine',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  assert.ok(prepared.decision.allocationSchedule.every((item) => (
    item.familyId !== historicalFamily.familyId
  )));
  assert.equal(
    prepared.capsule.operatorControlSha256,
    applied.projection.projectionSha256
  );
  const state = store.load('adaptive-operator-quarantine');
  assert.equal(state.adaptiveIntelligence.operatorControl.active, true);
  assert.deepEqual(
    state.adaptiveIntelligence.operatorControl.quarantinedFamilyIds,
    [historicalFamily.familyId]
  );
});

test('ordinary active routing compiles executable families before registration', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home, { program: EXECUTABLE_PROGRAM });
  initializeActiveRun(engine, 'adaptive-compiled-treatment');
  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-compiled-treatment',
    hypothesisCount: 3,
    interfaceContract: EXECUTABLE_INTERFACE,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  assert.ok(['COMPILED', 'MIXED'].includes(prepared.treatment.treatmentMode));
  const planned = bindHypotheses(hypotheses(3), prepared);
  const compiled = planned.find((item) => item.routingBinding.treatmentKind === 'compiled');
  const control = planned.find((item) => item.routingBinding.treatmentKind === 'control');
  assert.equal(compiled.mechanismCapsule.schemaVersion, 'compiled-mechanism-v1');
  assert.match(compiled.routingBinding.treatmentSha256, /^[a-f0-9]{64}$/);
  assert.match(compiled.routingBinding.interfaceSha256, /^[a-f0-9]{64}$/);
  assert.equal(control.mechanismCapsule, null);

  const tampered = structuredClone(planned);
  tampered.find((item) => item.routingBinding.treatmentKind === 'compiled')
    .routingBinding.treatmentSha256 = sha256('tampered-treatment');
  const refused = engine.register_hypotheses({
    runId: 'adaptive-compiled-treatment',
    hypotheses: tampered
  });
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.code, 'ADAPTIVE_BINDING_MISMATCH');

  const registered = engine.register_hypotheses({
    runId: 'adaptive-compiled-treatment',
    hypotheses: planned
  });
  assert.equal(registered.status, 'OK', registered.message);
  const state = store.load('adaptive-compiled-treatment');
  assert.equal(state.adaptiveIntelligence.routing.status, 'CONSUMED');
  assert.equal(state.adaptiveIntelligence.affectedExecution, true);
});

test('persisted pending hypotheses must resume before a replacement route is prepared', () => {
  const { engine, home } = freshEngine();
  historicalMechanism(home);
  initializeActiveRun(engine, 'adaptive-routing-resume');
  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-routing-resume',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  const registered = engine.register_hypotheses({
    runId: 'adaptive-routing-resume',
    hypotheses: bindHypotheses(hypotheses(), prepared)
  });
  assert.equal(registered.status, 'OK', registered.message);

  const resume = engine.operator.resumeMechanismRouting({
    runId: 'adaptive-routing-resume'
  });
  assert.equal(resume.status, 'OK', resume.message);
  assert.equal(resume.resume.status, 'PENDING_TESTS');
  assert.equal(resume.resume.pendingHypotheses.length, 3);
  assert.deepEqual(
    resume.resume.pendingHypotheses.map((item) => item.id),
    registered.hypothesisIds
  );

  const replacement = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-routing-resume',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(replacement.status, 'BLOCKED');
  assert.equal(replacement.code, 'ADAPTIVE_ROUTING_RESUME_REQUIRED');
  assert.deepEqual(replacement.pendingHypothesisIds, registered.hypothesisIds);

  const abandoned = engine.operator.retireMechanismRouting({
    runId: 'adaptive-routing-resume',
    routingDecisionId: prepared.decision.routingDecisionId,
    reasonCode: 'SUPERVISOR_RESTART'
  });
  assert.equal(abandoned.status, 'BLOCKED');
  assert.equal(abandoned.code, 'ADAPTIVE_ROUTING_PENDING_TESTS');
});

test('an unused route retires only through an immutable operator receipt', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home);
  initializeActiveRun(engine, 'adaptive-routing-retire');
  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-routing-retire',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);

  const refused = engine.operator.retireMechanismRouting({
    runId: 'adaptive-routing-retire',
    routingDecisionId: prepared.decision.routingDecisionId,
    reasonCode: 'MAKE_TEST_GREEN'
  });
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.code, 'BAD_INPUT');

  const retired = engine.operator.retireMechanismRouting({
    runId: 'adaptive-routing-retire',
    routingDecisionId: prepared.decision.routingDecisionId,
    reasonCode: 'TARGET_CHANGED'
  });
  assert.equal(retired.status, 'OK', retired.message);
  assert.match(retired.retirement.retirementSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    store.runFileExists(
      'adaptive-routing-retire',
      `adaptive-routing/${prepared.decision.routingDecisionId}.retirement.json`
    ),
    true
  );
  const repeated = engine.operator.retireMechanismRouting({
    runId: 'adaptive-routing-retire',
    routingDecisionId: prepared.decision.routingDecisionId,
    reasonCode: 'TARGET_CHANGED'
  });
  assert.equal(repeated.status, 'OK');
  assert.equal(repeated.idempotent, true);

  const replacement = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-routing-retire',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(replacement.status, 'OK', replacement.message);
  assert.notEqual(
    replacement.decision.routingDecisionId,
    prepared.decision.routingDecisionId
  );
});

test('missing executable interface refuses before route persistence or consumption', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home, { program: EXECUTABLE_PROGRAM });
  initializeActiveRun(engine, 'adaptive-missing-interface');
  const refused = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-missing-interface',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(refused.status, 'BLOCKED');
  assert.equal(refused.code, 'ADAPTIVE_TREATMENT_REFUSED');
  assert.equal(refused.reasonCode, 'INTERFACE_CONTRACT_INVALID');
  const state = store.load('adaptive-missing-interface');
  assert.equal(state.adaptiveIntelligence.routing.current, null);
  const decisions = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.ROUTING_DECISION
  });
  assert.equal(decisions.status, 'OK');
  assert.equal(decisions.records.length, 0);
});

test('five causally admitted attempts advance policy while provisional attempts do not', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home);
  initializeActiveRun(engine, 'adaptive-policy-run');
  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-policy-run',
    hypothesisCount: 5,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  const registered = engine.register_hypotheses({
    runId: 'adaptive-policy-run',
    hypotheses: bindHypotheses(hypotheses(5), prepared)
  });
  assert.equal(registered.status, 'OK', registered.message);

  for (let index = 0; index < registered.hypothesisIds.length; index++) {
    const scheduled = prepared.decision.allocationSchedule[index];
    const quality = scheduled.allocation === 'control' ? 0.7 : 0.84;
    const cost = scheduled.allocation === 'control' ? 1000 : 920;
    const agentRuns = ROUTES.map((model, runIndex) => ({
      model,
      measurementRef: recordMeasurement(
        engine,
        'adaptive-policy-run',
        `adaptive-${index}-${runIndex}`,
        cost,
        quality
      )
    }));
    const tested = engine.test_hypothesis({
      runId: 'adaptive-policy-run',
      hypothesisId: registered.hypothesisIds[index],
      fullTest: { agentRuns }
    });
    assert.equal(tested.status, 'OK', tested.message);
    assert.equal(tested.adaptiveApplication.status, 'OK');
    assert.equal(engine.reverify_run({
      runId: 'adaptive-policy-run',
      testId: tested.testId
    }).status, 'OK');
    const controls = engine.operator.recordAdaptiveControlEvidence(
      adaptiveControlBundle(engine, 'adaptive-policy-run', tested.testId)
    );
    assert.equal(controls.status, 'OK', controls.message);
  }

  const applications = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.APPLICATION
  });
  assert.equal(applications.status, 'OK');
  assert.equal(
    applications.records.length,
    16,
    'each live application retains provisional, reverified, and control-bound revisions'
  );
  const liveApplications = applications.records.filter(
    (record) => record.source.runId === 'adaptive-policy-run'
  );
  assert.equal(liveApplications.length, 15);
  assert.equal(new Set(liveApplications.map((record) => record.applicationId)).size, 5);
  assert.ok(liveApplications.every((record) => (
    record.routing.routingDecisionId === prepared.decision.routingDecisionId
    && record.routing.policyEpochId === prepared.decision.policyEpochId
  )));

  const epochs = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.POLICY_EPOCH
  });
  assert.equal(epochs.status, 'OK');
  const scoped = epochs.records
    .filter((record) => record.policyScopeId === 'adaptive-policy-run')
    .sort((left, right) => left.epochNumber - right.epochNumber);
  assert.equal(scoped.length, 2);
  assert.equal(scoped[1].epochNumber, 1);
  assert.equal(scoped[1].previousEpochSha256, scoped[0].policyEpochSha256);
  assert.ok(scoped[1].changes.every((change) => Math.abs(change.delta) <= 0.05));

  const state = store.load('adaptive-policy-run');
  assert.equal(state.adaptiveIntelligence.policy.current.epochNumber, 1);
  assert.equal(state.adaptiveIntelligence.status, 'READY');

  const nextRouting = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-policy-run',
    hypothesisCount: 5,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(nextRouting.status, 'OK', nextRouting.message);
  assert.equal(
    nextRouting.decision.candidatePoolCount,
    1,
    'no-memory control applications inform policy but never enter the mechanism pool'
  );
  const regressionHypotheses = engine.register_hypotheses({
    runId: 'adaptive-policy-run',
    hypotheses: bindHypotheses(hypotheses(5), nextRouting)
  });
  assert.equal(regressionHypotheses.status, 'OK', regressionHypotheses.message);
  for (let index = 0; index < regressionHypotheses.hypothesisIds.length; index++) {
    const scheduled = nextRouting.decision.allocationSchedule[index];
    const quality = scheduled.allocation === 'control' ? 0.7 : 0.4;
    const agentRuns = ROUTES.map((model, runIndex) => ({
      model,
      measurementRef: recordMeasurement(
        engine,
        'adaptive-policy-run',
        `regression-${index}-${runIndex}`,
        1000,
        quality
      )
    }));
    const tested = engine.test_hypothesis({
      runId: 'adaptive-policy-run',
      hypothesisId: regressionHypotheses.hypothesisIds[index],
      fullTest: { agentRuns }
    });
    assert.equal(tested.status, 'OK', tested.message);
    assert.equal(engine.reverify_run({
      runId: 'adaptive-policy-run',
      testId: tested.testId
    }).status, 'OK');
    const controls = engine.operator.recordAdaptiveControlEvidence(
      adaptiveControlBundle(engine, 'adaptive-policy-run', tested.testId, {
        controlRegression: scheduled.allocation !== 'control'
      })
    );
    assert.equal(controls.status, 'OK', controls.message);
  }

  const afterRollback = store.load('adaptive-policy-run');
  assert.equal(afterRollback.adaptiveIntelligence.policy.current.epochNumber, 2);
  assert.equal(afterRollback.adaptiveIntelligence.policy.current.trigger, 'rollback');
  assert.equal(afterRollback.adaptiveIntelligence.rollback.status, 'ACTIVATED');
  assert.equal(
    afterRollback.adaptiveIntelligence.rollback.targetEpochId,
    scoped[0].policyEpochId
  );
  assert.equal(afterRollback.status, 'ACTIVE');
  assert.equal(
    afterRollback.continuation.required,
    false,
    'a policy rollback does not fabricate a promotion continuation obligation'
  );
});

test('missing controls queue review, then a hash-bound safe receipt auto-banks internally', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home);
  initializeActiveRun(engine, 'adaptive-auto-bank');
  const prepared = engine.operator.prepareMechanismRouting({
    runId: 'adaptive-auto-bank',
    hypothesisCount: 3,
    target: {
      taskMode: 'improve',
      loopRole: 'loop-de-loop',
      taskValueDimensions: ['candidate-precision'],
      resourceDimensions: ['token-cost']
    }
  });
  assert.equal(prepared.status, 'OK', prepared.message);
  const registered = engine.register_hypotheses({
    runId: 'adaptive-auto-bank',
    hypotheses: bindHypotheses(hypotheses(), prepared)
  });
  assert.equal(registered.status, 'OK', registered.message);
  const routedPosition = prepared.decision.allocationSchedule.findIndex(
    (item) => item.allocation !== 'control'
  );
  assert.ok(routedPosition >= 0);
  const hypothesisId = registered.hypothesisIds[routedPosition];
  const agentRuns = ROUTES.map((model, index) => ({
    model,
    measurementRef: recordMeasurement(
      engine,
      'adaptive-auto-bank',
      `auto-bank-${index}`,
      900,
      0.85
    )
  }));
  const tested = engine.test_hypothesis({
    runId: 'adaptive-auto-bank',
    hypothesisId,
    fullTest: { agentRuns }
  });
  assert.equal(tested.status, 'OK', tested.message);
  assert.equal(tested.verdict, 'MOVED_FRONTIER');
  assert.equal(engine.reverify_run({
    runId: 'adaptive-auto-bank',
    testId: tested.testId
  }).status, 'OK');

  const queued = engine.promotion_request({
    runId: 'adaptive-auto-bank',
    hypothesisId
  });
  assert.equal(queued.status, 'BLOCKED');
  assert.equal(queued.code, 'PROMOTION_NEEDS_APPROVAL');
  assert.ok(queued.automaticReasonCodes.some((code) => (
    code.includes('CONTROL_REGRESSIONS') || code.includes('SHAM_STABILITY')
  )));

  const callerAggregate = engine.operator.recordAdaptiveControlEvidence({
    runId: 'adaptive-auto-bank',
    testId: tested.testId,
    controlRegressions: 0,
    shamMovement: 0,
    evidenceSha256: sha256('caller-claimed-safe-controls')
  });
  assert.equal(callerAggregate.status, 'BLOCKED');
  assert.equal(callerAggregate.code, 'ADAPTIVE_CONTROL_EVIDENCE_REFUSED');
  assert.equal(callerAggregate.reasonCode, 'ARTIFACT_SOURCE_REQUIRED');

  const validControlBundle = adaptiveControlBundle(
    engine,
    'adaptive-auto-bank',
    tested.testId
  );
  const reusedArtifact = structuredClone(validControlBundle);
  reusedArtifact.sourceArtifactRefs.arms.routed[0].targetMeasurementRef =
    reusedArtifact.sourceArtifactRefs.arms.baseline[0].targetMeasurementRef;
  const reused = engine.operator.recordAdaptiveControlEvidence(reusedArtifact);
  assert.equal(reused.status, 'BLOCKED');
  assert.equal(reused.code, 'ADAPTIVE_CONTROL_EVIDENCE_REFUSED');
  assert.equal(reused.reasonCode, 'ARTIFACT_REFERENCE_REUSED');

  const relabeledArtifact = structuredClone(validControlBundle);
  relabeledArtifact.sourceArtifactRefs.arms.routed[0].targetMeasurementRef =
    recordMeasurement(
      engine,
      'adaptive-auto-bank',
      'unbound-control-artifact',
      100,
      0.8
    );
  const relabeled = engine.operator.recordAdaptiveControlEvidence(relabeledArtifact);
  assert.equal(relabeled.status, 'BLOCKED');
  assert.equal(relabeled.code, 'ADAPTIVE_CONTROL_EVIDENCE_REFUSED');
  assert.equal(relabeled.reasonCode, 'MEASUREMENT_ARTIFACT_UNTRUSTED');

  const controls = engine.operator.recordAdaptiveControlEvidence(validControlBundle);
  assert.equal(controls.status, 'OK', controls.message);
  const promoted = engine.promotion_request({
    runId: 'adaptive-auto-bank',
    hypothesisId
  });
  assert.equal(promoted.status, 'OK', promoted.message);
  assert.equal(promoted.automatic, true);
  assert.ok(promoted.automaticPromotionDecisionId);

  const decisions = listAdaptiveRecords({
    homeDir: home,
    schemaVersion: ADAPTIVE_SCHEMA.AUTO_PROMOTION
  });
  assert.equal(decisions.status, 'OK');
  assert.equal(decisions.records.length, 2);
  assert.deepEqual(
    decisions.records.map((record) => record.disposition).sort(),
    ['AUTO_BANK_INTERNAL', 'QUEUE_HUMAN_REVIEW']
  );
  const state = store.load('adaptive-auto-bank');
  assert.equal(state.promotions.length, 1);
  assert.equal(state.promotions[0].canonicalChange, false);
  assert.equal(state.promotions[0].authority, 'deterministic-supervisor-auto-bank');
  assert.equal(state.humanReviews[0].status, 'AUTO_APPROVED');

  state.adaptiveIntelligence.privatePath = '/Users/operator/private/adaptive.json';
  state.adaptiveIntelligence.privateMechanism = 'PRIVATE_CAUSAL_MECHANISM_PROSE';
  store.save(state);
  const snapshot = buildConsoleSnapshot(store.load('adaptive-auto-bank'));
  assert.equal(snapshot.learning.mode, 'active-canary');
  assert.equal(snapshot.learning.affectedExecution, true);
  assert.ok(snapshot.learning.active.selections.length > 0);
  assert.ok(snapshot.learning.hypotheses.some((item) => item.affectedExecution));
  assert.equal(snapshot.learning.automatic.latest.disposition, 'AUTO_BANK_INTERNAL');
  assert.equal(snapshot.learning.rollback.status, 'NONE');
  const publicJson = JSON.stringify(snapshot.learning);
  for (const forbidden of [
    '/Users/operator',
    'PRIVATE_CAUSAL_MECHANISM_PROSE',
    'Use this as evidence-backed',
    'historical-run',
    'test/adaptive-engine-integration.test.mjs'
  ]) {
    assert.equal(publicJson.includes(forbidden), false);
  }
  const html = renderDashboard(store.load('adaptive-auto-bank'));
  assert.match(html, /Evidence-bound pre-generation routing/);
  assert.match(html, /Active routing influenced hypothesis generation/);
  assert.match(html, /AUTO_BANK_INTERNAL/);
  assert.match(html, /no-memory control/);
  assert.doesNotMatch(
    html,
    /PRIVATE_CAUSAL_MECHANISM_PROSE|\/Users\/operator|Use this as evidence-backed|historical-run/
  );
});

test('the autonomous supervisor routes before generation and keeps control workers capsule-free', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home);
  const contracts = [];
  const result = runSupervisedCampaign(engine, {
    runId: 'adaptive-supervisor',
    task: SPECIFIC_TASK,
    noImprovePolicy: 1,
    engineConfig: {
      metaLearning: {
        enabled: true,
        mode: 'active-canary',
        seed: 'adaptive-supervisor-seed'
      }
    },
    targets: [{
      kind: 'improve',
      loop: 'loop-de-loop',
      baselineContent: BASELINE_BODY,
      benchmark: {
        name: 'adaptive-supervisor-benchmark',
        taskValueDimensions: ['candidate-precision'],
        resourceDimensions: ['token-cost'],
        cases: [{ id: 'case-1', input: 'sealed-corpus', expect: 'qualified candidates' }],
        oracle: DEFAULT_QUALITY_ORACLE
      },
      routes: ROUTES
    }]
  }, {
    worker(contract) {
      contracts.push(structuredClone(contract));
      const output = buildMeasuredContent(1000, 0.7);
      return {
        route: contract.route,
        artifacts: [{ role: 'runlog', content: output }],
        finalOutput: output
      };
    },
    maxBatches: 3
  });
  assert.equal(result.status, 'OK');

  const baselineContracts = contracts.filter((contract) => contract.kind === 'baseline');
  const challengerContracts = contracts.filter((contract) => contract.kind === 'challenger');
  assert.equal(baselineContracts.length, 1);
  assert.equal(baselineContracts[0].mechanismCapsule, null);
  assert.equal(challengerContracts.length, 9);
  assert.ok(challengerContracts.every((contract) => (
    contract.hypothesis?.routingBinding?.routingDecisionId
  )));
  const routed = challengerContracts.filter((contract) => (
    contract.hypothesis.routingBinding.allocation !== 'control'
  ));
  const controls = challengerContracts.filter((contract) => (
    contract.hypothesis.routingBinding.allocation === 'control'
  ));
  assert.ok(routed.length > 0);
  assert.ok(routed.every((contract) => contract.mechanismCapsule?.item?.familyId));
  assert.ok(controls.length > 0);
  assert.ok(controls.every((contract) => contract.mechanismCapsule === null));

  const state = store.load('adaptive-supervisor-t1');
  const preparedIndex = state.log.findIndex((entry) => entry.event === 'adaptive_routing_prepared');
  const registeredIndex = state.log.findIndex((entry) => entry.event === 'hypotheses_registered');
  assert.ok(preparedIndex >= 0 && preparedIndex < registeredIndex);
  assert.equal(state.adaptiveIntelligence.affectedExecution, true);
  assert.equal(state.tests.length, 3);
});

test('a cold supervisor restart reuses the baseline and drains the persisted route', () => {
  const { engine, store, home } = freshEngine();
  historicalMechanism(home);
  const config = {
    runId: 'adaptive-supervisor-resume',
    task: SPECIFIC_TASK,
    noImprovePolicy: 10,
    engineConfig: {
      metaLearning: {
        enabled: true,
        mode: 'active-canary',
        seed: 'adaptive-supervisor-resume-seed'
      }
    },
    targets: [{
      kind: 'improve',
      loop: 'loop-de-loop',
      baselineContent: BASELINE_BODY,
      benchmark: {
        name: 'adaptive-supervisor-resume-benchmark',
        taskValueDimensions: ['candidate-precision'],
        resourceDimensions: ['token-cost'],
        cases: [{ id: 'case-1', input: 'sealed-corpus', expect: 'qualified candidates' }],
        oracle: DEFAULT_QUALITY_ORACLE
      },
      routes: ROUTES
    }]
  };
  const contracts = [];
  const worker = (contract) => {
    contracts.push(structuredClone(contract));
    const output = buildMeasuredContent(1000, 0.7);
    return {
      route: contract.route,
      artifacts: [{ role: 'runlog', content: output }],
      finalOutput: output
    };
  };

  const first = runSupervisedCampaign(engine, config, { worker, maxBatches: 1 });
  assert.equal(first.status, 'OK');
  assert.equal(first.batchesTotal, 1);
  assert.equal(contracts.filter((item) => item.kind === 'baseline').length, 1);
  assert.equal(contracts.filter((item) => item.kind === 'challenger').length, 3);
  let state = store.load('adaptive-supervisor-resume-t1');
  assert.equal(state.hypotheses.length, 3);
  assert.equal(state.tests.length, 1);
  assert.equal(
    engine.operator.resumeMechanismRouting({ runId: state.runId }).resume.status,
    'PENDING_TESTS'
  );

  contracts.length = 0;
  const second = runSupervisedCampaign(engine, config, { worker, maxBatches: 2 });
  assert.equal(second.status, 'OK');
  assert.equal(second.batchesTotal, 2);
  assert.equal(contracts.filter((item) => item.kind === 'baseline').length, 0);
  assert.equal(contracts.filter((item) => item.kind === 'challenger').length, 3);
  assert.ok(second.transcript.some((item) => item.step === 'baseline_reused'));
  state = store.load('adaptive-supervisor-resume-t1');
  assert.equal(state.hypotheses.length, 3);
  assert.equal(state.tests.length, 2);
  assert.equal(
    engine.operator.resumeMechanismRouting({ runId: state.runId }).resume.status,
    'PENDING_TESTS'
  );

  contracts.length = 0;
  assert.throws(() => runSupervisedCampaign(engine, config, {
    worker,
    maxBatches: 3,
    onSchedulerCheckpoint: ({ status, snapshot }) => {
      if (status === 'TARGET_STARTED' && snapshot.batchesTotal === 3) {
        throw new Error('simulated crash after the final child receipt');
      }
    }
  }), /simulated crash after the final child receipt/);
  assert.equal(contracts.filter((item) => item.kind === 'baseline').length, 0);
  assert.equal(contracts.filter((item) => item.kind === 'challenger').length, 3);
  state = store.load('adaptive-supervisor-resume-t1');
  assert.equal(state.tests.length, 3);
  assert.equal(
    engine.operator.resumeMechanismRouting({ runId: state.runId }).resume.status,
    'ROUTE_COMPLETE'
  );

  contracts.length = 0;
  const coldEngine = createEngine(store, { operatorAuthority: 'operator' });
  const recovered = runSupervisedCampaign(coldEngine, config, {
    worker,
    maxBatches: 4
  });
  assert.equal(recovered.status, 'OK', recovered.message);
  assert.equal(recovered.batchesTotal, 3);
  assert.equal(contracts.length, 0, 'route-complete recovery launches no duplicate worker');
  assert.ok(recovered.transcript.some((item) => (
    item.step === 'adaptive_route_recovered_complete'
    && item.testedHypotheses === 3
  )));
  assert.equal(recovered.scheduler.status, 'QUEUE_DRAINED');
});
