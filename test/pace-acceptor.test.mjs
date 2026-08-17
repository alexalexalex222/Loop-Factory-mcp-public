import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPaceTaskCluster,
  compareOfflineAcceptors,
  createPaceAcceptor,
  evaluatePaceV2Gates,
  validatePaceState,
  validatePaceV2GateRecord
} from '../src/pace-acceptor.mjs';

const sha = (character) => character.repeat(64);

function config(overrides = {}) {
  return {
    candidateId: 'fixed-candidate-1',
    outerAlphaAllocation: {
      allocationId: 'generation-1',
      alpha: 0.05,
      familyAlpha: 0.05,
      policySha256: sha('a')
    },
    lambdaPolicy: { kind: 'fixed', value: 0.5 },
    ...overrides
  };
}

function cluster(taskId, outcomes) {
  return {
    taskId,
    objectiveVerified: true,
    replicates: outcomes.map(([candidate, incumbent], replicate) => ({
      replicate,
      candidate,
      incumbent
    }))
  };
}

function winningCluster(taskId, replicateCount = 3) {
  return cluster(taskId, Array.from({ length: replicateCount }, () => [1, 0]));
}

function runStream(stream, paceConfig = config()) {
  let state = createPaceAcceptor(paceConfig).state;
  const persisted = [];
  for (const task of stream) {
    if (state.stopped) break;
    const updated = appendPaceTaskCluster(state, task, {
      persistStep: (receipt) => persisted.push(receipt)
    });
    assert.equal(updated.status, 'OK');
    state = updated.state;
  }
  return { state, persisted };
}

function passingGates(state, overrides = {}) {
  return {
    state,
    shamMovement: { absoluteMovement: 0.01, maximumAllowed: 0.02 },
    regressions: { target: 0, control: 0 },
    tokenCost: {
      candidateTokens: 1100,
      incumbentTokens: 1000,
      maximumRelativeIncrease: 0.25
    },
    objectiveVerification: { verified: true, evidenceSha256: sha('b') },
    untouchedConfirmation: {
      passed: true,
      untouched: true,
      evidenceSha256: sha('c')
    },
    ...overrides
  };
}

test('replicates aggregate inside one task-cluster betting observation', () => {
  const created = createPaceAcceptor(config());
  const persisted = [];
  const updated = appendPaceTaskCluster(
    created.state,
    cluster('task-1', [[1, 0], [0, 1], [1, 0]]),
    { persistStep: (receipt) => persisted.push(receipt) }
  );
  assert.equal(updated.status, 'OK');
  assert.equal(updated.state.taskCount, 1);
  assert.equal(updated.state.discordantCount, 1);
  assert.equal(updated.step.replicateCount, 3);
  assert.equal(updated.step.candidateMean, 0.666666666667);
  assert.equal(updated.step.incumbentMean, 0.333333333333);
  assert.equal(persisted.length, 1);
});

test('optional stopping occurs exactly at the predeclared 1/alpha threshold', () => {
  const stream = Array.from({ length: 12 }, (_, index) => (
    winningCluster(`task-${index + 1}`)
  ));
  const { state, persisted } = runStream(stream);
  assert.equal(state.stoppingThreshold, 20);
  assert.equal(state.taskCount, 8);
  assert.equal(state.wealth, 25.62890625);
  assert.equal(state.paceGatePassed, true);
  assert.equal(state.crossedAtTask, 'task-8');
  assert.equal(persisted.length, 8);
  assert.equal(validatePaceState(state).status, 'OK');
  assert.equal(
    appendPaceTaskCluster(state, winningCluster('task-9'), {
      persistStep: () => {}
    }).code,
    'PACE_ALREADY_STOPPED'
  );
});

test('ties and no-improvement streams do not manufacture evidence', () => {
  const ties = Array.from({ length: 20 }, (_, index) => (
    cluster(`tie-${index + 1}`, [[1, 1], [0, 0], [1, 1]])
  ));
  const tied = runStream(ties).state;
  assert.equal(tied.taskCount, 20);
  assert.equal(tied.discordantCount, 0);
  assert.equal(tied.wealth, 1);
  assert.equal(tied.paceGatePassed, false);

  const alternating = Array.from({ length: 20 }, (_, index) => (
    index % 2 === 0
      ? winningCluster(`alt-${index + 1}`)
      : cluster(`alt-${index + 1}`, [[0, 1], [0, 1], [0, 1]])
  ));
  const restrained = runStream(alternating).state;
  assert.equal(restrained.paceGatePassed, false);
  assert.ok(restrained.wealth < 1);
});

test('rounding is conservative for tiny losses and alpha thresholds', () => {
  const tinyLoss = runStream([
    cluster('tiny-loss', [[1, 1 + 1e-13]])
  ]).state;
  assert.equal(tinyLoss.losses, 1);
  assert.equal(tinyLoss.ties, 0);
  assert.ok(tinyLoss.wealth < 1);

  const created = createPaceAcceptor(config({
    outerAlphaAllocation: {
      allocationId: 'generation-rounding',
      alpha: 0.03,
      familyAlpha: 0.05,
      policySha256: sha('d')
    }
  }));
  assert.ok(created.state.stoppingThreshold >= 1 / 0.03);
});

test('predictable lambda depends only on prior task outcomes', () => {
  const paceConfig = config({
    lambdaPolicy: {
      kind: 'predictable-empirical',
      maximum: 0.75,
      priorWins: 1,
      priorLosses: 1
    }
  });
  const first = runStream([
    winningCluster('task-1'),
    winningCluster('task-2')
  ], paceConfig).state;
  const second = runStream([
    winningCluster('task-1'),
    winningCluster('task-2')
  ], paceConfig).state;
  assert.deepEqual(first.steps.map((step) => step.lambda), [0, 0.333333333333]);
  assert.deepEqual(first.steps.map((step) => step.lambda), second.steps.map((step) => step.lambda));
});

test('sham, regression, cost, objective, and untouched confirmation gates fail closed', () => {
  const state = runStream(Array.from({ length: 8 }, (_, index) => (
    winningCluster(`task-${index + 1}`)
  ))).state;
  const passing = evaluatePaceV2Gates(passingGates(state));
  assert.equal(passing.status, 'OK');
  assert.equal(passing.record.allV2GatesPassed, true);
  assert.equal(passing.record.v2GateOnly, true);
  assert.equal(passing.record.fullAdaptiveRunControl, false);
  assert.equal(passing.record.activationAuthority, false);

  const failures = [
    { shamMovement: { absoluteMovement: 0.03, maximumAllowed: 0.02 } },
    { regressions: { target: 1, control: 0 } },
    { regressions: { target: 0, control: 1 } },
    {
      tokenCost: {
        candidateTokens: 1300,
        incumbentTokens: 1000,
        maximumRelativeIncrease: 0.25
      }
    },
    { objectiveVerification: { verified: false, evidenceSha256: sha('b') } },
    {
      untouchedConfirmation: {
        passed: true,
        untouched: false,
        evidenceSha256: sha('c')
      }
    }
  ];
  for (const failure of failures) {
    const result = evaluatePaceV2Gates(passingGates(state, failure));
    assert.equal(result.status, 'OK');
    assert.equal(result.record.allV2GatesPassed, false);
    assert.equal(result.record.disposition, 'REJECTED');
  }

  const justOver = evaluatePaceV2Gates(passingGates(state, {
    tokenCost: {
      candidateTokens: 1001,
      incumbentTokens: 1000,
      maximumRelativeIncrease: 0.0009999999996
    }
  }));
  assert.equal(justOver.record.gates.tokenCostBounded, false);
});

test('offline greedy, fixed-delta, and PACE compare one predeclared stream', () => {
  const stream = Array.from({ length: 8 }, (_, index) => (
    winningCluster(`offline-${index + 1}`)
  ));
  const compared = compareOfflineAcceptors({
    ...config(),
    stream,
    fixedDelta: 0.5
  });
  assert.equal(compared.status, 'OK');
  assert.equal(compared.comparison.noModelCalls, true);
  assert.equal(compared.comparison.samePredeclaredStream, true);
  assert.equal(compared.comparison.greedy.accepted, true);
  assert.equal(compared.comparison.fixedDelta.accepted, true);
  assert.equal(compared.comparison.pace.accepted, true);
  assert.equal(compared.comparison.persistedStepCount, 8);
});

test('PACE state and V2 gate records are tamper evident', () => {
  const state = runStream([winningCluster('task-1')]).state;
  const tamperedState = structuredClone(state);
  tamperedState.steps[0].outcome = 'loss';
  assert.notEqual(validatePaceState(tamperedState).status, 'OK');

  const gate = evaluatePaceV2Gates(passingGates(state));
  const tamperedGate = structuredClone(gate.record);
  tamperedGate.gates.shamMovementBounded = false;
  assert.equal(
    validatePaceV2GateRecord(tamperedGate).code,
    'PACE_V2_GATE_RECORD_TAMPERED'
  );
});
