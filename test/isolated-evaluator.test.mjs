import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildIsolatedEvaluatorRequest,
  buildEvaluatorSecurityQualification,
  createEvaluatorCounterbalanceSeedCommitment,
  createEvaluatorInvocationContract,
  runIsolatedEvaluator,
  runIsolatedEvaluatorProcess,
  verifyIsolatedEvaluatorFromDisk,
  validateEvaluatorReceipt,
  validateEvaluatorOutputAgainstRequest,
  validateEvaluatorSecurityAnswerKey,
  validateEvaluatorSecurityQualification,
  validateObservedEvaluatorIsolation,
  validateEvaluatorWorkerFailure,
  validatePairwiseOrderReceipt
} from '../src/isolated-evaluator.mjs';
import { validateVNextStageArtifact } from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';
import { createFakeCli } from './fixtures/fake-cli.mjs';

const hash = (character) => character.repeat(64);

function requestInput(overrides = {}) {
  return {
    taskSpecification: { instruction: 'Summarize the supplied incident.' },
    publicRubric: {
      dimensions: [{
        id: 'clarity',
        criterion: 'The incident summary is concise and internally coherent.'
      }],
      scale: { minimum: 0, maximum: 1 }
    },
    anonymousCandidateArtifact: { response: 'A concise incident summary.' },
    objectiveVerifierFacts: { evidenceIds: ['fact-1'], formatValid: true },
    taskLocalEvidence: [{ id: 'evidence-1', content: 'Public incident facts.' }],
    pairwise: null,
    ...overrides
  };
}

function invocationInput(request, overrides = {}) {
  return {
    taskId: 'task-1',
    anonymousArmId: 'anon-a',
    request,
    model: 'semantic-evaluator-v1',
    reasoningEffort: 'high',
    isolationPolicy: 'test-fixture-v1',
    tools: [],
    toolPolicy: 'none',
    outputSchema: { type: 'object', additionalProperties: false },
    prompt: 'Measure the anonymous artifact using only the supplied public rubric.',
    binaryIdentity: { basename: 'evaluator-cli', sha256: hash('b') },
    wrapperIdentity: {
      basename: 'vnext-evaluator-worker.mjs',
      sha256: hash('d')
    },
    stateRoot: mkdtempSync(join(tmpdir(), 'isolated-evaluator-test-')),
    ...overrides
  };
}

function evaluatorOutput(request, extra = {}) {
  return {
    schemaVersion: 'vnext-evaluator-output-v1',
    rubricSha256: request.rubricSha256,
    measurements: [{
      dimension: 'clarity',
      score: 0.8,
      evidenceRefs: ['evidence-1'],
      confidence: 0.7
    }],
    uncertainty: 0.3,
    protocolViolations: [],
    ...extra
  };
}

test('blank-context requests are identical and contain no hidden identity fields', () => {
  const first = buildIsolatedEvaluatorRequest(requestInput());
  const second = buildIsolatedEvaluatorRequest(requestInput());
  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(first.request.anonymousArtifacts[0].slot, 'item-1');
  const serialized = JSON.stringify(first.request);
  for (const forbidden of ['lineage', 'hypothesis', 'research', 'priorScore', 'modelIdentity']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('labels, prior scores, promotion fields, and unsafe evidence paths fail closed', () => {
  for (const mutation of [
    { objectiveVerifierFacts: { arm: 'anon-a' } },
    { objectiveVerifierFacts: { note: 'This is the baseline output.' } },
    { objectiveVerifierFacts: { priorScore: 0.9 } },
    { objectiveVerifierFacts: { otherArms: ['A'] } },
    { objectiveVerifierFacts: { modelIdentity: 'hidden-system' } },
    { objectiveVerifierFacts: { promote: true } },
    { taskLocalEvidence: [{ id: 'evidence-1', path: '/tmp/leak.json' }] }
  ]) {
    assert.equal(
      buildIsolatedEvaluatorRequest(requestInput(mutation)).status,
      'REFUSED'
    );
  }
});

test('seeded pair ordering is deterministic and receipt-bound', () => {
  const input = requestInput({
    pairwise: {
      secondAnonymousArtifact: { response: 'Another concise summary.' },
      seed: 'fixed-pair-seed'
    }
  });
  const first = buildIsolatedEvaluatorRequest(input);
  const second = buildIsolatedEvaluatorRequest(input);
  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(first.request.anonymousArtifacts.length, 2);
  assert.deepEqual(
    first.request.anonymousArtifacts.map(({ slot }) => slot),
    ['item-1', 'item-2']
  );
  assert.equal(first.request.pairwiseOrderReceiptSha256, first.pairwiseReceipt.receiptSha256);
  assert.equal(
    validatePairwiseOrderReceipt(first.pairwiseReceipt, first.request).status,
    'OK'
  );

  const tampered = structuredClone(first.pairwiseReceipt);
  tampered.orderedArtifactSha256.reverse();
  assert.equal(
    validatePairwiseOrderReceipt(tampered, first.request).status,
    'REFUSED'
  );

  const changed = buildIsolatedEvaluatorRequest({
    ...input,
    pairwise: { ...input.pairwise, seed: 'different-pair-seed' }
  });
  assert.notEqual(
    first.pairwiseReceipt.randomizationSha256,
    changed.pairwiseReceipt.randomizationSha256
  );

  const swapped = buildIsolatedEvaluatorRequest({
    ...input,
    anonymousCandidateArtifact: input.pairwise.secondAnonymousArtifact,
    pairwise: {
      secondAnonymousArtifact: input.anonymousCandidateArtifact,
      seed: input.pairwise.seed
    }
  });
  assert.equal(swapped.status, 'OK');
  assert.deepEqual(swapped.request.anonymousArtifacts, first.request.anonymousArtifacts);
  assert.deepEqual(swapped.pairwiseReceipt, first.pairwiseReceipt);
});

test('semantic-judge qualification counterbalances truth behind neutral public IDs', () => {
  const supportedArtifact = { text: 'The evidence-supported incident summary.' };
  const contradictedArtifact = { text: 'A summary contradicted by the evidence.' };
  let built = null;
  for (let index = 1; index < 100 && !built; index += 1) {
    const seeds = ['qualification-seed-0', `qualification-seed-${index}`];
    const commitment = createEvaluatorCounterbalanceSeedCommitment({
      qualificationId: 'semantic-judge-r6',
      seeds,
      committedAt: '2026-08-16T00:00:00.000Z'
    });
    const candidate = buildEvaluatorSecurityQualification({
      seedCommitment: commitment.commitment,
      seeds,
      supportedArtifact,
      contradictedArtifact,
      objectiveVerifierFacts: { formatValid: true },
      taskLocalEvidence: [{ id: 'evidence-1', content: 'Frozen public facts.' }],
      criteria: [
        'Every factual statement is supported by task-local evidence.',
        'The item covers the required facts.',
        'The item is concise and internally coherent.'
      ],
      scale: { minimum: 0, maximum: 1 }
    });
    if (candidate.status === 'OK') built = candidate;
  }
  assert.ok(built);
  assert.deepEqual(
    new Set(built.answerKey.mappings.map(({ supportedItem }) => supportedItem)),
    new Set(['item-1', 'item-2'])
  );
  assert.equal(built.qualification.forms.length, 2);
  assert.equal(validateEvaluatorSecurityQualification(
    built.qualification
  ).status, 'OK');
  assert.equal(validateEvaluatorSecurityAnswerKey(built.answerKey).status, 'OK');
  assert.equal(built.qualification.exposure.maximumCalls, 2);
  const publicBytes = JSON.stringify(built.qualification);
  assert.equal(publicBytes.includes('supportedItem'), false);
  assert.equal(publicBytes.includes('contradictedItem'), false);
  assert.equal(publicBytes.includes('"slot":"A"'), false);
  assert.equal(publicBytes.includes('A-factual-fidelity'), false);
  assert.deepEqual(
    built.qualification.forms[0].request.publicRubric.dimensions
      .map(({ id }) => id),
    [
      'criterion-01', 'criterion-02', 'criterion-03',
      'criterion-04', 'criterion-05', 'criterion-06'
    ]
  );
});

test('observed isolation fails closed on status or disallowed tool evidence', () => {
  const clean = {
    status: 'PASS',
    toolCalls: [],
    disallowedToolCalls: [],
    contextDiagnostics: [],
    malformedLines: 0,
    reasons: []
  };
  assert.equal(validateObservedEvaluatorIsolation({
    isolation: { ...clean, status: 'FAIL', reasons: ['TOOL_POLICY_FAILED'] }
  }, 'none').status, 'REFUSED');
  assert.equal(validateObservedEvaluatorIsolation({
    isolation: {
      ...clean,
      toolCalls: ['shell'],
      disallowedToolCalls: ['shell']
    }
  }, 'none').status, 'REFUSED');
});

test('every task and anonymous arm receives a distinct state directory with no conversation', () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const root = mkdtempSync(join(tmpdir(), 'isolated-evaluator-state-'));
  const first = createEvaluatorInvocationContract(invocationInput(built.request, {
    stateRoot: root,
    anonymousArmId: 'anon-a'
  }));
  const second = createEvaluatorInvocationContract(invocationInput(built.request, {
    stateRoot: root,
    anonymousArmId: 'anon-b'
  }));
  assert.equal(first.status, 'OK');
  assert.equal(second.status, 'OK');
  assert.notEqual(first.contract.stateDirectory, second.contract.stateDirectory);
  assert.equal(first.contract.stateDirectory.includes('anon-a'), false);
  assert.equal(JSON.stringify(first.contract).includes('anon-a'), false);
  assert.equal(first.contract.freshConversation, true);
  assert.equal(first.contract.conversationId, null);
  assert.equal(second.contract.conversationId, null);
});

test('prompt, rubric, and tool drift invalidate an evaluator receipt', () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const input = invocationInput(built.request);
  const run = runIsolatedEvaluator(input, {
    allowTestWorker: true,
    clock: () => '2026-08-05T00:00:00.000Z',
    worker: ({ invocation }) => ({
      processIdentity: `pid-${invocation.stateDirectoryIdentitySha256.slice(0, 12)}`,
      output: evaluatorOutput(built.request)
    })
  });
  assert.equal(run.status, 'OK');
  assert.equal(validateEvaluatorReceipt(run.receipt, run.invocation).status, 'OK');

  const drifts = [
    { prompt: `${input.prompt} Changed.` },
    { tools: ['read-task-local-evidence'], toolPolicy: 'read-only-task-local' },
    { outputSchema: { type: 'object', required: ['measurements'] } }
  ];
  for (const drift of drifts) {
    const changed = createEvaluatorInvocationContract({ ...input, ...drift });
    assert.equal(changed.status, 'OK');
    assert.equal(
      validateEvaluatorReceipt(run.receipt, changed.contract).code,
      'EVALUATOR_RECEIPT_BINDING_MISMATCH'
    );
  }

  const changedRubric = buildIsolatedEvaluatorRequest(requestInput({
    publicRubric: {
      dimensions: [
        { id: 'clarity', criterion: 'The summary is concise.' },
        { id: 'accuracy', criterion: 'The summary is accurate.' }
      ],
      scale: { minimum: 0, maximum: 1 }
    }
  }));
  const rubricInvocation = createEvaluatorInvocationContract({
    ...input,
    request: changedRubric.request
  });
  assert.equal(
    validateEvaluatorReceipt(run.receipt, rubricInvocation.contract).code,
    'EVALUATOR_RECEIPT_BINDING_MISMATCH'
  );
});

test('evaluator generation sampling is honestly disclosed as backend default', () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const invocation = createEvaluatorInvocationContract(invocationInput(built.request));
  assert.equal(invocation.status, 'OK');
  assert.equal(Object.hasOwn(invocation.contract, 'sampling'), false);
  assert.equal(Object.hasOwn(invocation.contract, 'samplingSha256'), false);
});

test('request-aware evaluator semantics reject incomplete or invented measurements', () => {
  const publicRubric = {
    dimensions: [
      { id: 'A-factual-fidelity', criterion: 'A factual fidelity.' },
      { id: 'A-coverage', criterion: 'A coverage.' },
      { id: 'A-clarity', criterion: 'A clarity.' },
      { id: 'B-factual-fidelity', criterion: 'B factual fidelity.' },
      { id: 'B-coverage', criterion: 'B coverage.' },
      { id: 'B-clarity', criterion: 'B clarity.' }
    ],
    scale: { minimum: 0, maximum: 1 }
  };
  const request = buildIsolatedEvaluatorRequest(requestInput({
    publicRubric,
    taskLocalEvidence: [
      { id: 'incident-window', content: 'Incident timing.' },
      { id: 'incident-impact', content: 'Incident impact.' },
      { id: 'incident-response', content: 'Incident response.' },
      { id: 'incident-data', content: 'Incident data outcome.' }
    ],
    pairwise: {
      secondAnonymousArtifact: { response: 'A second anonymous summary.' },
      seed: 'semantic-validator-fixed-pair'
    }
  })).request;
  const dimensions = publicRubric.dimensions.map(({ id }) => id);
  const validOutput = {
    schemaVersion: 'vnext-evaluator-output-v1',
    rubricSha256: request.rubricSha256,
    measurements: dimensions.map((dimension) => ({
      dimension,
      score: 0.5,
      evidenceRefs: ['incident-window'],
      confidence: 0.8
    })),
    uncertainty: 0.2,
    protocolViolations: []
  };
  assert.equal(
    validateEvaluatorOutputAgainstRequest(validOutput, request).status,
    'OK'
  );
  const validRun = runIsolatedEvaluator(invocationInput(request), {
    allowTestWorker: true,
    clock: () => '2026-08-05T00:00:00.000Z',
    worker: ({ invocation }) => ({
      processIdentity: `pid-${invocation.stateDirectoryIdentitySha256.slice(0, 12)}`,
      output: validOutput
    })
  });
  assert.equal(validRun.status, 'OK');
  assert.equal(validRun.artifact.payload.semanticMeasurementOnly, true);

  const mutations = [
    ['missing dimension', (value) => value.measurements.pop()],
    ['extra dimension', (value) => value.measurements.push({
      dimension: 'invented-dimension', score: 0.5,
      evidenceRefs: ['incident-window'], confidence: 0.8
    })],
    ['duplicate dimension', (value) => {
      value.measurements[1].dimension = value.measurements[0].dimension;
    }],
    ['score below minimum', (value) => { value.measurements[0].score = -0.01; }],
    ['score above maximum', (value) => { value.measurements[0].score = 1.01; }],
    ['empty evidence refs', (value) => { value.measurements[0].evidenceRefs = []; }],
    ['unknown evidence id', (value) => {
      value.measurements[0].evidenceRefs = ['invented-evidence'];
    }],
    ['duplicate evidence id', (value) => {
      value.measurements[0].evidenceRefs = ['incident-window', 'incident-window'];
    }],
    ['wrong rubric semantics', (value) => {
      value.measurements = value.measurements.map((measurement, index) => ({
        ...measurement,
        dimension: `wrong-${index}`
      }));
    }]
  ];
  for (const [name, mutate] of mutations) {
    const output = structuredClone(validOutput);
    mutate(output);
    const result = validateEvaluatorOutputAgainstRequest(output, request);
    assert.equal(result.status, 'REFUSED', name);
    assert.equal(result.code, 'EVALUATOR_OUTPUT_SEMANTICS_INVALID', name);
    const run = runIsolatedEvaluator(invocationInput(request), {
      allowTestWorker: true,
      worker: ({ invocation }) => ({
        processIdentity: `pid-${invocation.stateDirectoryIdentitySha256.slice(0, 12)}`,
        output
      })
    });
    assert.equal(run.status, 'REFUSED', `${name} finalization`);
    assert.equal(
      run.code,
      'EVALUATOR_OUTPUT_SEMANTICS_INVALID',
      `${name} finalization`
    );
  }
});

test('evaluator output is measurement-only and cannot promote', () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const input = invocationInput(built.request);
  const invalid = runIsolatedEvaluator(input, {
    allowTestWorker: true,
    worker: () => ({
      processIdentity: 'pid-invalid',
      output: evaluatorOutput(built.request, { promote: true })
    })
  });
  assert.equal(invalid.status, 'REFUSED');

  const valid = runIsolatedEvaluator(input, {
    allowTestWorker: true,
    clock: () => '2026-08-05T00:00:00.000Z',
    worker: ({ invocation }) => ({
      processIdentity: `pid-${invocation.stateDirectoryIdentitySha256.slice(0, 12)}`,
      output: evaluatorOutput(built.request)
    })
  });
  assert.equal(valid.status, 'OK');
  assert.equal(valid.artifact.stage, 'semantic-evaluation');
  assert.equal(valid.artifact.payload.activationAuthority, false);
  assert.equal(validateVNextStageArtifact(valid.artifact).status, 'OK');
});

test('official evaluator wrapper proves a distinct OS process without a model call', async () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const result = await runIsolatedEvaluatorProcess(invocationInput(built.request), {
    allowTestFixture: true,
    testFixtureOutput: evaluatorOutput(built.request),
    timeoutMs: 10_000,
    clock: () => '2026-08-05T00:00:00.000Z'
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.receipt.executionMode, 'test-fixture-process');
  assert.equal(result.receipt.productionEvidence, false);
  assert.notEqual(result.receipt.workerPid, process.pid);
  assert.equal(result.artifact.payload.activationAuthority, false);
  assert.equal(
    JSON.parse(readFileSync(join(result.invocation.stateDirectory, 'worker-result.json'), 'utf8')).workerPid,
    result.receipt.workerPid
  );
  const workerInput = readFileSync(
    join(result.invocation.stateDirectory, 'worker-input.json'),
    'utf8'
  );
  assert.equal(workerInput.includes('anon-a'), false);
  assert.equal(result.invocation.environmentIsolation, 'isolated-home-no-auth-v1');
  assert.equal(verifyIsolatedEvaluatorFromDisk({
    invocation: result.invocation,
    receipt: result.receipt,
    artifact: result.artifact
  }).status, 'OK');
});

test('observed tool use cannot finalize otherwise-valid production evaluator evidence', async () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const root = mkdtempSync(join(tmpdir(), 'isolated-evaluator-observed-tool-'));
  const authHome = join(root, 'source-auth');
  mkdirSync(authHome);
  writeFileSync(join(authHome, 'auth.json'), '{}\n', { mode: 0o600 });
  const output = evaluatorOutput(built.request);
  const resultEvent = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(output) }
  });
  const bin = createFakeCli(root, 'codex', {
    stdout: [
      '{"type":"thread.started","thread_id":"thread-observed-tool"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"read forbidden ambient state"}}',
      resultEvent,
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":0,"output_tokens":8,"reasoning_output_tokens":0}}',
      ''
    ].join('\n')
  });
  const executableSha256 = sha256(readFileSync(bin));
  const result = await runIsolatedEvaluatorProcess(invocationInput(built.request, {
    stateRoot: root,
    model: 'gpt-5.6-sol'
  }), {
    env: {
      ...process.env,
      CODEX_HOME: authHome,
      SUPER_LOOP_ALLOW_EXEC: '1',
      SUPER_LOOP_CODEX_BIN: bin,
      SUPER_LOOP_REQUIRE_CHATGPT_OAUTH: '1',
      SUPER_LOOP_CODEX_EXECUTABLE_SHA256: executableSha256,
      SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256: hash('a')
    },
    timeoutMs: 10_000
  });

  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'EVALUATOR_EXECUTOR_RECEIPT_INVALID');
});

test('failed evaluator process persists bounded redacted replayable diagnostics', async () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const root = mkdtempSync(join(tmpdir(), 'isolated-evaluator-failure-'));
  const authHome = join(root, 'source-auth');
  mkdirSync(authHome);
  writeFileSync(join(authHome, 'auth.json'), '{}\n', { mode: 0o600 });
  const bearer = 'Bearer diagnostic-secret-value';
  const apiKey = 'sk-diagnostic-secret-value';
  const prefixedKey = 'prefixed-api-secret-value';
  const accessToken = 'prefixed-access-secret-value';
  const idToken = 'quoted-id-secret-value';
  const cookie = 'session-cookie-secret-value';
  const sessionId = 'session-id-secret-value';
  const bin = createFakeCli(root, 'codex', {
    stdout: 'public stdout context before failure\n',
    stderr: [
      bearer,
      `api_key=${apiKey}`,
      `OPENAI_API_KEY=${prefixedKey}`,
      `CODEX_ACCESS_TOKEN=${accessToken}`,
      `"id_token": "${idToken}"`,
      `Cookie: ${cookie}`,
      `session_id=${sessionId}`,
      'x '.repeat(4999),
      ''
    ].join('\n'),
    exitCode: 23
  });
  const executableSha256 = sha256(readFileSync(bin));
  const result = await runIsolatedEvaluatorProcess(invocationInput(built.request, {
    stateRoot: root,
    model: 'gpt-5.6-sol'
  }), {
    env: {
      ...process.env,
      CODEX_HOME: authHome,
      SUPER_LOOP_ALLOW_EXEC: '1',
      SUPER_LOOP_CODEX_BIN: bin,
      SUPER_LOOP_REQUIRE_CHATGPT_OAUTH: '1',
      SUPER_LOOP_CODEX_EXECUTABLE_SHA256: executableSha256,
      SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256: hash('a')
    },
    timeoutMs: 10_000
  });

  assert.equal(result.code, 'EVALUATOR_WRAPPER_EXITED');
  assert.equal(result.exitCode, 2);
  assert.ok(result.failureEvidence);
  assert.equal(
    validateEvaluatorWorkerFailure(result.failureEvidence.record, {
      invocationSha256: result.failureEvidence.record.invocationSha256
    }).status,
    'OK'
  );
  assert.equal(result.failureEvidence.record.executorInvocation.exitCode, 23);
  assert.equal(result.failureEvidence.record.stdout.truncated, false);
  assert.equal(result.failureEvidence.record.stderr.truncated, true);
  assert.match(result.failureEvidence.record.stdout.text, /public stdout context/);
  assert.match(result.failureEvidence.record.stderr.text, /\[REDACTED\]/);
  assert.doesNotMatch(
    result.failureEvidence.record.stderr.text,
    /diagnostic-secret-value|prefixed-api-secret-value|prefixed-access-secret-value|quoted-id-secret-value|session-cookie-secret-value|session-id-secret-value/
  );
  assert.equal(result.failureEvidence.record.stderr.text.includes('\uFFFD'), false);
  assert.ok(result.failureEvidence.record.stderr.storedBytes <= 8 * 1024);
  assert.equal(
    result.failureEvidence.fileSha256,
    sha256(readFileSync(result.failureEvidence.path, 'utf8'))
  );
  const stateDirectory = readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith('slot-'));
  assert.ok(stateDirectory);
  assert.equal(existsSync(join(root, stateDirectory.name, 'auth-capsule')), false);
});

test('evaluator timeout kills and reaps the complete wrapper process group', async () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const root = mkdtempSync(join(tmpdir(), 'isolated-evaluator-timeout-'));
  const authHome = join(root, 'source-auth');
  const pidPath = join(root, 'codex.pid');
  mkdirSync(authHome);
  writeFileSync(join(authHome, 'auth.json'), '{}\n', { mode: 0o600 });
  const bin = createFakeCli(root, 'codex', {
    delayMs: 30_000,
    pidFilePath: pidPath
  });
  const executableSha256 = sha256(readFileSync(bin));
  const result = await runIsolatedEvaluatorProcess(invocationInput(built.request, {
    stateRoot: root,
    model: 'gpt-5.6-sol'
  }), {
    env: {
      ...process.env,
      CODEX_HOME: authHome,
      SUPER_LOOP_ALLOW_EXEC: '1',
      SUPER_LOOP_CODEX_BIN: bin,
      SUPER_LOOP_REQUIRE_CHATGPT_OAUTH: '1',
      SUPER_LOOP_CODEX_EXECUTABLE_SHA256: executableSha256,
      SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256: hash('a')
    },
    timeoutMs: 1_000
  });

  assert.equal(result.code, 'EVALUATOR_WRAPPER_TIMEOUT');
  const childPid = Number(readFileSync(pidPath, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  const stateDirectory = readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith('slot-'));
  assert.ok(stateDirectory);
  assert.equal(existsSync(join(root, stateDirectory.name, 'auth-capsule')), false);
});

test('the in-process evaluator seam refuses production use', () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const result = runIsolatedEvaluator(invocationInput(built.request), {
    worker: () => ({ processIdentity: 'fake', output: evaluatorOutput(built.request) })
  });
  assert.equal(result.code, 'EVALUATOR_PROCESS_REQUIRED');
});

test('production evaluator fails closed for non-Codex provider routes', async () => {
  const built = buildIsolatedEvaluatorRequest(requestInput());
  const result = await runIsolatedEvaluatorProcess(invocationInput(built.request, {
    model: 'claude-opus-4-1'
  }), { timeoutMs: 1_000 });
  assert.equal(result.code, 'EVALUATOR_PROVIDER_ISOLATION_UNSUPPORTED');
});
