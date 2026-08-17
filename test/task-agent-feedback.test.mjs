import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTaskAgentFeedback,
  createTaskAgentFeedbackContract,
  validateTaskAgentFeedbackArtifact
} from '../src/task-agent-feedback.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function contractInput(overrides = {}) {
  return {
    collectionId: 'feedback-attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    issuedAt: '2026-08-05T01:00:00.000Z',
    ttlMs: 60_000,
    contextRefs: [{
      id: 'task-input-1',
      kind: 'task-input',
      schemaVersion: 'task-input-v1',
      sha256: HASH_A
    }, {
      id: 'task-output-1',
      kind: 'task-output',
      schemaVersion: 'task-output-v1',
      sha256: HASH_B
    }],
    ...overrides
  };
}

function feedback(overrides = {}) {
  return {
    schemaVersion: 'vnext-task-feedback-output-v1',
    helped: ['The failure locator made the relevant branch easy to find.'],
    obstructed: ['The dependency name did not explain its role.'],
    timing: ['The map was useful before source inspection.'],
    missing: ['No example covered the empty-input path.'],
    irrelevant: ['The unrelated cache note was not needed.'],
    rediscovered: ['The source hash changed after the map was built.'],
    uncertainty: 0.25,
    ...overrides
  };
}

function allKeys(value, into = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => allKeys(item, into));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      allKeys(child, into);
    }
  }
  return into;
}

test('fresh task-agent feedback is deterministic, bounded, and uncertainty preserving', () => {
  const firstContract = createTaskAgentFeedbackContract(contractInput());
  const secondContract = createTaskAgentFeedbackContract(contractInput({
    contextRefs: [...contractInput().contextRefs].reverse()
  }));
  assert.equal(firstContract.status, 'OK');
  assert.deepEqual(firstContract, secondContract);
  assert.deepEqual(firstContract.contract.permittedInformation, [
    'task-local input',
    'task-local output'
  ]);
  assert.ok(firstContract.contract.forbiddenInformation.includes('final sealed tasks'));

  const collectedAt = '2026-08-05T01:00:30.000Z';
  const first = collectTaskAgentFeedback({
    contract: firstContract.contract,
    output: feedback(),
    collectedAt
  });
  const second = collectTaskAgentFeedback({
    contract: secondContract.contract,
    output: feedback(),
    collectedAt
  });
  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(first.artifact.feedback.uncertainty, 0.25);
  assert.equal(validateTaskAgentFeedbackArtifact(first.artifact).status, 'OK');
});

test('feedback context rejects raw, sealed, and non-task-local material', () => {
  const extraRawContext = createTaskAgentFeedbackContract({
    ...contractInput(),
    rawContext: 'sealed task material'
  });
  assert.equal(extraRawContext.code, 'TASK_FEEDBACK_CONTRACT_INVALID');

  const sealedRef = createTaskAgentFeedbackContract(contractInput({
    contextRefs: [
      ...contractInput().contextRefs,
      {
        id: 'sealed-task-1',
        kind: 'final-sealed-task',
        schemaVersion: 'final-task-v1',
        sha256: 'c'.repeat(64)
      }
    ]
  }));
  assert.equal(sealedRef.code, 'TASK_FEEDBACK_CONTEXT_INVALID');
});

test('feedback artifacts export no scoring, admission, promotion, or policy mutation authority', () => {
  const built = createTaskAgentFeedbackContract(contractInput());
  const collected = collectTaskAgentFeedback({
    contract: built.contract,
    output: feedback(),
    collectedAt: '2026-08-05T01:00:30.000Z'
  });
  const forbiddenAuthority = /score|admission|promot|policy|mutation/i;
  assert.equal(allKeys(collected.artifact).some((key) => forbiddenAuthority.test(key)), false);

  const inventedAuthority = feedback({ promote: true });
  assert.equal(
    collectTaskAgentFeedback({
      contract: built.contract,
      output: inventedAuthority,
      collectedAt: '2026-08-05T01:00:30.000Z'
    }).code,
    'TASK_FEEDBACK_OUTPUT_INVALID'
  );
});

test('feedback collection refuses expired and tampered contracts', () => {
  const built = createTaskAgentFeedbackContract(contractInput());
  assert.equal(
    collectTaskAgentFeedback({
      contract: built.contract,
      output: feedback(),
      collectedAt: '2026-08-05T01:02:00.000Z'
    }).code,
    'TASK_FEEDBACK_CONTRACT_EXPIRED'
  );

  const tampered = structuredClone(built.contract);
  tampered.contextRefs[0].sha256 = 'f'.repeat(64);
  assert.equal(
    collectTaskAgentFeedback({
      contract: tampered,
      output: feedback(),
      collectedAt: '2026-08-05T01:00:30.000Z'
    }).code,
    'TASK_FEEDBACK_CONTRACT_TAMPERED'
  );
});
