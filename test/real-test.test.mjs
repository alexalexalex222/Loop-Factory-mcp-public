import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCaseResultsContent } from '../src/measure.mjs';
import { runRealTestCanary, verifyCanaryRun } from '../src/canary-runner.mjs';
import {
  REAL_TEST_LIMITS,
  REAL_TEST_MODEL,
  REAL_TEST_CANARY,
  buildRealTestCanaryPlan,
  buildRealTestPlan,
  evaluateRealTestCanaryOutcome,
  qualifyRealTestFinding,
  resolveEvidenceCapsule,
  resolveEvidenceManifest,
  validateRealTestCanaryConfig,
  validateRealTestConfig,
  withRealTestProfile
} from '../src/real-test.mjs';
import { compilePhaseContract, runSupervisedCampaign, validateWorkerPacket } from '../src/supervisor.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  buildExecutorPrompt,
  executorWorker,
  schemaPathForContract
} from '../src/executor.mjs';
import { sha256 } from '../src/util.mjs';
import { BASELINE_BODY, freshEngine } from './helpers.mjs';
import { createFakeCli } from './fixtures/fake-cli.mjs';

const ROUTES = ['gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-sol'];
const EVIDENCE_SOURCES = ['src/supervisor.mjs'];
const EVIDENCE_CONTENT = [
  'export function compilePhaseContract() {}',
  'export function validateWorkerPacket() {}',
  'captured phase-skip scenario',
  'captured metric scenario',
  'captured promotion scenario'
].join('\n');
const EVIDENCE_MANIFEST = [{
  path: 'src/supervisor.mjs',
  bytes: Buffer.byteLength(EVIDENCE_CONTENT),
  sha256: sha256(EVIDENCE_CONTENT)
}];
const EVIDENCE_CAPSULE = [{ ...EVIDENCE_MANIFEST[0], content: EVIDENCE_CONTENT }];
const BENCHMARK = {
  name: 'strict-real-test',
  taskValueDimensions: ['case_accuracy', 'evidence_quality'],
  resourceDimensions: ['tokenCost'],
  cases: [
    { id: 'working', prompt: 'Inspect fixture working and return one structured case result.' },
    { id: 'boundary', prompt: 'Inspect fixture boundary and return one structured case result.' }
  ],
  oracle: {
    kind: 'case-results-v2',
    passMark: 1,
    cases: [
      { caseId: 'working', accepted: false, code: 'CASE_ONE_OK', requiredEvidencePaths: ['fixture/working.json'] },
      { caseId: 'boundary', accepted: false, code: 'CASE_TWO_OK', requiredEvidencePaths: ['fixture/boundary.json'] }
    ]
  },
  negativeControl: {
    content: 'NEGATIVE CONTROL: irrelevant output with no required case evidence.',
    passMark: 0.6
  },
  routeIndependence: 'required',
  requiredRoutes: 3,
  outputClass: 'prose'
};

function approvedConfig(overrides = {}) {
  const raw = {
    task: 'Find evidence-backed loops, then improve them on the frozen cases.',
    routes: ROUTES,
    remineOnEmpty: false,
    noImprovePolicy: 30,
    benchmark: BENCHMARK,
    evidenceSources: EVIDENCE_SOURCES,
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceCapsule: EVIDENCE_CAPSULE,
    targets: [{ kind: 'mine', routes: ROUTES }],
    ...overrides
  };
  const prepared = withRealTestProfile(raw);
  return withRealTestProfile(raw, prepared.plan.sha256);
}

function strictReceipt(contract, rawResultText) {
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = '/tmp/loop-factory-test-capsule';
  return {
    binaryFamily: 'codex',
    argv: buildArgs('codex', null, contract.route, {
      strictIsolation: true,
      schemaPath,
      workspaceRoot
    }),
    strictIsolation: true,
    disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
    workspaceRoot,
    outputSchemaSha256: sha256(readFileSync(schemaPath)),
    rawResultSha256: sha256(rawResultText),
    resultNormalization: 'json-schema-v1'
  };
}

function measuredPacket(contract, label = '') {
  const caseResults = BENCHMARK.oracle.cases.map((item) => ({
    caseId: item.caseId,
    disposition: item.accepted ? 'ACCEPTED' : 'BLOCKED',
    code: item.code,
    evidencePaths: item.requiredEvidencePaths
  }));
  const payload = contract.kind === 'proposal'
    ? {
        findingId: contract.target.findingId,
        hypothesisId: contract.hypothesis.id,
        baselineSha256: contract.target.baselineSha256,
        revisedContent: `${contract.target.baselineContent}\n\n## Measured Revision\n${contract.hypothesis.operation}\n\nThe revision binds ${contract.hypothesis.title} to ${contract.hypothesis.bottleneck} and preserves the locked acceptance criteria.`,
        changeSummary: `${contract.hypothesis.title}: ${contract.hypothesis.operation}`
      }
    : (contract.kind === 'evaluation'
        ? {
            arm: contract.evaluationArm,
            findingId: contract.target.findingId,
            hypothesisId: contract.hypothesis ? contract.hypothesis.id : '',
            baselineSha256: contract.target.baselineSha256,
            procedureSha256: contract.procedureSha256,
            caseResults
          }
        : (contract.kind === 'baseline'
            ? {
                findingId: contract.target.findingId,
                baselineSha256: contract.target.baselineSha256,
                caseResults
              }
            : {
                findingId: contract.target.findingId,
                hypothesisId: contract.hypothesis.id,
                baselineSha256: contract.target.baselineSha256,
                revisedContent: `${contract.target.baselineContent}\n\n## Measured Revision\nApply ${contract.hypothesis.operation} while preserving the locked acceptance criteria.`,
                changeSummary: `${contract.hypothesis.title}: ${contract.hypothesis.expectedMovement}`,
                caseResults
              }));
  const tag = contract.kind === 'proposal' || contract.kind === 'challenger'
    ? 'IMPROVEMENT'
    : (contract.kind === 'evaluation' ? 'EVALUATION' : 'BASELINE_RESULT');
  const finalOutput = `<${tag}>${JSON.stringify(payload)}</${tag}>`;
  const rawResultText = JSON.stringify(payload);
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({ type: 'agent_message', text: rawResultText }),
    JSON.stringify({ type: 'token_count', input_tokens: 120, output_tokens: 80 })
  ].join('\n');
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: rawStdout }],
    executorOwned: true,
    rawStdout,
    finalOutput,
    isolation: { status: 'PASS', toolCalls: [], reasons: [] },
    invocation: {
      requestedModel: contract.route,
      reportedModel: contract.route,
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'cli-reported',
      reportedModelMatchesRequest: true,
      exitCode: 0,
      stdoutSha256: sha256(rawStdout),
      resultSha256: sha256(finalOutput),
      tokenUsage: 200,
      tokenUsageDetails: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
      durationMs: 25,
      ...strictReceipt(contract, rawResultText),
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  };
}

function miningPacket(contract, candidates, output = capturedCandidates(candidates)) {
  const finalOutput = output;
  let captured = [];
  try {
    captured = JSON.parse(finalOutput.match(/<CANDIDATES>([\s\S]*?)<\/CANDIDATES>/i)?.[1] || '[]');
  } catch { /* malformed capture remains empty and fails qualification */ }
  const rawResultText = JSON.stringify({ candidates: captured });
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({ type: 'agent_message', text: rawResultText }),
    JSON.stringify({ type: 'token_count', input_tokens: 90, output_tokens: 60 })
  ].join('\n');
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: rawStdout }],
    executorOwned: true,
    rawStdout,
    finalOutput,
    candidates,
    isolation: { status: 'PASS', toolCalls: [], reasons: [] },
    invocation: {
      requestedModel: contract.route,
      reportedModel: contract.route,
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'cli-reported',
      reportedModelMatchesRequest: true,
      exitCode: 0,
      stdoutSha256: sha256(rawStdout),
      resultSha256: sha256(finalOutput),
      tokenUsage: 150,
      tokenUsageDetails: { inputTokens: 90, outputTokens: 60, totalTokens: 150 },
      durationMs: 20,
      ...strictReceipt(contract, rawResultText),
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  };
}

function capturedCandidates(candidates) {
  return `<CANDIDATES>${JSON.stringify(candidates)}</CANDIDATES>`;
}

function strictStructuredPacket(contract, payload, tag, {
  inputTokens = 120,
  outputTokens = 80
} = {}) {
  const rawResultText = JSON.stringify(payload);
  const finalOutput = `<${tag}>${rawResultText}</${tag}>`;
  const rawStdout = [
    JSON.stringify({ type: 'thread.started', model: contract.route }),
    JSON.stringify({ type: 'agent_message', text: rawResultText }),
    JSON.stringify({ type: 'token_count', input_tokens: inputTokens, output_tokens: outputTokens })
  ].join('\n');
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: rawStdout }],
    executorOwned: true,
    rawStdout,
    finalOutput,
    isolation: { status: 'PASS', toolCalls: [], reasons: [] },
    invocation: {
      requestedModel: contract.route,
      reportedModel: contract.route,
      modelSelectionAuthority: 'explicit-model-flag',
      modelIdentityAuthority: 'cli-reported',
      reportedModelMatchesRequest: true,
      exitCode: 0,
      stdoutSha256: sha256(rawStdout),
      resultSha256: sha256(finalOutput),
      tokenUsage: inputTokens + outputTokens,
      tokenUsageDetails: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      },
      durationMs: 25,
      ...strictReceipt(contract, rawResultText),
      isolation: { status: 'PASS', toolCalls: [], reasons: [] }
    }
  };
}

function substantiveHypotheses(index = 0) {
  return [
    {
      title: `Bind phase transitions to evidence ${index}`,
      bottleneck: 'The supervisor can advance without proving the active scenario produced repository-bound evidence.',
      operation: 'Require the phase output to name the frozen finding, baseline hash, and case-specific evidence before measurement.',
      expectedMovement: 'Malformed or cross-target phase outputs stop counting while valid structured results retain their measured score.',
      falsifier: 'A wrong finding or baseline hash still reaches the measurement ledger as a valid attempt.'
    },
    {
      title: `Separate measured output provenance ${index}`,
      bottleneck: 'Extracted answers and raw executor envelopes are not directly linked to the agent run that consumed the attempt.',
      operation: 'Persist and hash-link raw and extracted artifacts on each worker result before registering the measured batch.',
      expectedMovement: 'Every counted agent run can be traced directly to matching raw and final artifact hashes.',
      falsifier: 'A counted run lacks either direct artifact reference or survives a receipt hash mismatch.'
    }
  ];
}

function strictCandidate(index, overrides = {}) {
  return {
    loop: 'loop-de-loop',
    title: `candidate-${index}`,
    baselineContent: `${BASELINE_BODY}\n\n## Candidate ${index}\n${'specific source material '.repeat(12)}`,
    evidenceRefs: [{
      path: 'src/supervisor.mjs',
      locator: index % 2 === 0 ? 'validateWorkerPacket' : 'compilePhaseContract'
    }],
    hypotheses: substantiveHypotheses(index),
    ...overrides
  };
}

function recordCaseMeasurement(engine, runId, oracle, label, tokenCost, correctCount) {
  const scored = buildCaseResultsContent(oracle, (row, index) => (
    index < correctCount ? row : { ...row, code: `WRONG_${row.code}` }
  ));
  const targetLength = tokenCost * 4;
  assert.ok(scored.length <= targetLength, 'case fixture must fit inside requested token budget');
  return engine.artifact_record({
    runId,
    name: label,
    role: 'runlog',
    content: scored + '.'.repeat(targetLength - scored.length),
    measure: true
  }).artifactId;
}

function initializeStrictChild(engine, runId, findingId = 'finding-001') {
  const prepared = approvedConfig();
  engine.initialize_loop_run({
    runId,
    task: 'Test one grounded finding against the frozen strict benchmark.',
    answers: ['test the finding', 'improve', 'quality up', 'preserve evidence', 'defaults', 'keep moving'],
    model: prepared.config.model,
    modelPolicy: prepared.config.modelPolicy,
    config: {
      realTest: {
        ...prepared.config.realTest,
        findingId,
        parentRunId: 'strict-parent'
      }
    }
  });
  engine.artifact_record({ runId, role: 'baseline', content: BASELINE_BODY });
  engine.benchmark_freeze_maker({ runId, benchmark: BENCHMARK, benchPartition: 'gate' });
  const refs = ['a', 'b', 'c'].map((label, index) => (
    recordCaseMeasurement(engine, runId, BENCHMARK.oracle, `strict-base-${label}`, 800 + index * 20, 2)
  ));
  engine.benchmark_run({ runId, arm: 'baseline', measurementRefs: refs });
}

function boundContract(kind, overrides = {}) {
  const target = {
    findingId: 'finding-001',
    title: 'Ground supervisor output to the sealed target',
    baselineArtifactId: 'art-001',
    baselineSha256: 'a'.repeat(64),
    baselineContent: BASELINE_BODY,
    evidenceRefs: [{ path: 'fixture/source-1.json', locator: 'captured scenario' }]
  };
  const hypothesis = {
    id: 'finding-001-h1',
    ...substantiveHypotheses(1)[0]
  };
  return compilePhaseContract('loop-de-loop', kind === 'baseline' ? 0 : 1, {
    kind,
    route: REAL_TEST_MODEL,
    task: 'Run the frozen cases.',
    target,
    hypothesis: kind === 'challenger' ? hypothesis : null,
    frozenCases: BENCHMARK.cases,
    ...overrides
  });
}

function boundPacket(contract, overrides = {}) {
  const caseResults = BENCHMARK.oracle.cases.map((item) => ({
    caseId: item.caseId,
    disposition: item.accepted ? 'ACCEPTED' : 'BLOCKED',
    code: item.code,
    evidencePaths: item.requiredEvidencePaths
  }));
  const payload = contract.kind === 'baseline'
    ? {
        findingId: contract.target.findingId,
        baselineSha256: contract.target.baselineSha256,
        caseResults
      }
    : {
        findingId: contract.target.findingId,
        hypothesisId: contract.hypothesis.id,
        baselineSha256: contract.target.baselineSha256,
        revisedContent: `${contract.target.baselineContent}\n\n## Bound Revision\nApply the assigned operation to the frozen cases.`,
        changeSummary: 'Applied the assigned operation and preserved the locked acceptance criteria.',
        caseResults
      };
  Object.assign(payload, overrides);
  const tag = contract.kind === 'baseline' ? 'BASELINE_RESULT' : 'IMPROVEMENT';
  return {
    route: contract.route,
    artifacts: [{ role: 'runlog', content: 'captured worker envelope' }],
    finalOutput: `<${tag}>${JSON.stringify(payload)}</${tag}>`
  };
}

test('strict real-test plan is stable and refuses unapproved or weak benchmark configs', () => {
  const first = approvedConfig();
  const second = approvedConfig();
  assert.equal(first.plan.sha256, second.plan.sha256);
  assert.equal(first.plan.sha256, buildRealTestPlan(first.config).sha256);
  assert.equal(validateRealTestConfig(first.config).ok, true);
  assert.equal(first.config.model, REAL_TEST_MODEL);
  assert.deepEqual(first.config.modelPolicy.testRoutes, [REAL_TEST_MODEL]);
  assert.deepEqual(first.config.modelPolicy.builderRoutes, [REAL_TEST_MODEL]);
  assert.notEqual(
    first.plan.sha256,
    buildRealTestPlan({
      ...first.config,
      requirements: ['A changed worker-visible requirement must invalidate prior approval.']
    }).sha256
  );

  const unapproved = withRealTestProfile({
    task: 'x',
    routes: ROUTES,
    benchmark: BENCHMARK,
    targets: [{ kind: 'mine', routes: ROUTES }]
  });
  const blocked = validateRealTestConfig(unapproved.config);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.includes('real-test plan is not operator-approved'));

  const weak = approvedConfig({
    benchmark: { ...BENCHMARK, negativeControl: null, routeIndependence: null }
  });
  const weakCheck = validateRealTestConfig(weak.config);
  assert.equal(weakCheck.ok, false);
  assert.ok(weakCheck.errors.some((error) => /negativeControl/.test(error)));
  assert.ok(weakCheck.errors.some((error) => /routeIndependence/.test(error)));

  const legacyMarker = approvedConfig({
    benchmark: {
      ...BENCHMARK,
      oracle: { mustInclude: ['CASE_ONE_OK'] }
    }
  });
  assert.ok(validateRealTestConfig(legacyMarker.config).errors.some((error) => /case-results-v2/.test(error)));

  const wrongRoute = approvedConfig({ routes: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.6-sol'] });
  const wrongRouteCheck = validateRealTestConfig({
    ...wrongRoute.config,
    routes: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.6-sol']
  });
  assert.equal(wrongRouteCheck.ok, false);
  assert.ok(wrongRouteCheck.errors.includes('every worker route must be gpt-5.6-sol'));

  const shortTarget = approvedConfig({
    targets: [{ kind: 'mine', routes: ['gpt-5.6-sol'] }]
  });
  const shortTargetCheck = validateRealTestConfig(shortTarget.config);
  assert.equal(shortTargetCheck.ok, false);
  assert.ok(shortTargetCheck.errors.includes('target mine routes must contain 3-5 worker runs'));
});

test('explicit evidence manifests are root-bound and source byte drift changes the approved plan hash', () => {
  const repo = mkdtempSync(join(tmpdir(), 'loop-factory-manifest-'));
  const source = join(repo, 'evidence.txt');
  try {
    writeFileSync(source, 'first sealed bytes');
    const first = resolveEvidenceManifest(repo, ['evidence.txt']);
    assert.equal(first.ok, true);
    const capsule = resolveEvidenceCapsule(repo, ['evidence.txt']);
    assert.equal(capsule.ok, true);
    assert.equal(capsule.capsule[0].content, 'first sealed bytes');
    const firstPlan = buildRealTestPlan({
      ...approvedConfig().config,
      evidenceSources: ['evidence.txt'],
      evidenceManifest: first.manifest
    });
    writeFileSync(source, 'second sealed bytes');
    const second = resolveEvidenceManifest(repo, ['evidence.txt']);
    const secondPlan = buildRealTestPlan({
      ...approvedConfig().config,
      evidenceSources: ['evidence.txt'],
      evidenceManifest: second.manifest
    });
    assert.notEqual(first.manifest[0].sha256, second.manifest[0].sha256);
    assert.notEqual(firstPlan.sha256, secondPlan.sha256);
    assert.equal(resolveEvidenceManifest(repo, ['../outside.txt']).ok, false);
    assert.equal(resolveEvidenceManifest(repo, ['evidence.txt', 'evidence.txt']).ok, false);
    assert.equal(resolveEvidenceManifest(repo, ['evidence.txt', './evidence.txt']).ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('strict finding evidence must remain inside the sealed source manifest', () => {
  const candidate = strictCandidate(1, {
    evidenceRefs: [{ path: 'src/outside-manifest.mjs', locator: 'unsealed source' }]
  });
  const result = qualifyRealTestFinding(candidate, new Set(), {
    capturedOutput: capturedCandidates([candidate]),
    capturedArtifactId: 'art-001',
    capturedCandidates: [candidate],
    findingId: 'finding-001',
    evidenceManifest: EVIDENCE_MANIFEST
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FINDING_EVIDENCE_OUTSIDE_MANIFEST');
});

test('strict finding locators must resolve inside the sealed evidence bytes', () => {
  const candidate = strictCandidate(1, {
    evidenceRefs: [{ path: 'src/supervisor.mjs', locator: 'symbol-that-does-not-exist' }]
  });
  const result = qualifyRealTestFinding(candidate, new Set(), {
    capturedOutput: capturedCandidates([candidate]),
    capturedArtifactId: 'art-final',
    capturedRawArtifactId: 'art-raw',
    capturedCandidates: [candidate],
    findingId: 'finding-001',
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceCapsule: EVIDENCE_CAPSULE
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'FINDING_EVIDENCE_UNRESOLVED');
});

test('strict hypothesis registration rejects shape-only placeholders and accepts two substantive assigned hypotheses', () => {
  const { engine } = freshEngine();
  initializeStrictChild(engine, 'strict-hypotheses');
  const shallow = engine.register_hypotheses({
    runId: 'strict-hypotheses',
    hypotheses: [
      { id: 'finding-001-h1', title: 'h0', bottleneck: 'b', operation: 'o', expectedMovement: '+q', falsifier: 'x', route: { model: REAL_TEST_MODEL } },
      { id: 'finding-001-h2', title: 'h1', bottleneck: 'b', operation: 'o', expectedMovement: '+q', falsifier: 'x', route: { model: REAL_TEST_MODEL } }
    ]
  });
  assert.equal(shallow.status, 'BLOCKED');
  assert.equal(shallow.code, 'HYPOTHESIS_TOO_SHALLOW');

  const substantive = substantiveHypotheses(1).map((hypothesis, index) => ({
    id: `finding-001-h${index + 1}`,
    ...hypothesis,
    route: { model: REAL_TEST_MODEL }
  }));
  const accepted = engine.register_hypotheses({ runId: 'strict-hypotheses', hypotheses: substantive });
  assert.equal(accepted.status, 'OK');
  assert.deepEqual(accepted.hypothesisIds, ['finding-001-h1', 'finding-001-h2']);
});

test('grounded contracts carry the exact target and hypothesis and render every executor section', () => {
  const baseline = boundContract('baseline');
  const challenger = boundContract('challenger');
  assert.equal(baseline.target.baselineSha256, 'a'.repeat(64));
  assert.equal(baseline.target.baselineContent, BASELINE_BODY);
  assert.equal(baseline.hypothesis, null);
  assert.equal(challenger.target.baselineContent, BASELINE_BODY);
  assert.equal(challenger.hypothesis.id, 'finding-001-h1');
  assert.equal(challenger.hypothesis.operation, substantiveHypotheses(1)[0].operation);

  const prompt = buildExecutorPrompt(challenger);
  for (const section of [
    'TARGET',
    'LOCKED BASELINE',
    'EVIDENCE SOURCES',
    'HYPOTHESIS',
    'FROZEN CASES',
    'REQUIRED OUTPUT SCHEMA',
    'FORBIDDEN OUTPUTS'
  ]) {
    assert.match(prompt, new RegExp(`^${section}$`, 'm'));
  }
  assert.match(prompt, /finding-001-h1/);
  assert.match(prompt, new RegExp(challenger.target.baselineSha256));
});

test('phase output validation accepts mining only in mining and enforces bound baseline/challenger wrappers', () => {
  const mining = compilePhaseContract('strip-miner', 0, {
    kind: 'mine',
    route: REAL_TEST_MODEL,
    mustProduceComparableOutput: false
  });
  const miningPacket = {
    route: REAL_TEST_MODEL,
    artifacts: [{ role: 'runlog', content: 'captured' }],
    finalOutput: capturedCandidates([strictCandidate(1)])
  };
  assert.equal(validateWorkerPacket(mining, miningPacket).accepted, true);

  const baseline = boundContract('baseline');
  const challenger = boundContract('challenger');
  assert.deepEqual(validateWorkerPacket(baseline, miningPacket).reasons, ['WRONG_PHASE_OUTPUT']);
  assert.deepEqual(validateWorkerPacket(challenger, miningPacket).reasons, ['WRONG_PHASE_OUTPUT']);
  assert.equal(validateWorkerPacket(baseline, boundPacket(baseline)).accepted, true);
  assert.equal(validateWorkerPacket(challenger, boundPacket(challenger)).accepted, true);

  const wrongSha = validateWorkerPacket(challenger, boundPacket(challenger, { baselineSha256: 'b'.repeat(64) }));
  assert.ok(wrongSha.reasons.includes('TARGET_UNBOUND'));
  const unchanged = validateWorkerPacket(challenger, boundPacket(challenger, {
    revisedContent: challenger.target.baselineContent
  }));
  assert.ok(unchanged.reasons.includes('TARGET_UNBOUND'));
});

test('strict proposal and evaluation are separate, hypothesis-bound contracts', () => {
  const target = boundContract('challenger').target;
  const hypothesis = boundContract('challenger').hypothesis;
  const proposal = compilePhaseContract('loop-de-loop', 1, {
    kind: 'proposal',
    route: REAL_TEST_MODEL,
    target,
    hypothesis,
    evidenceCapsule: EVIDENCE_CAPSULE,
    toolPolicy: 'none'
  });
  const unrelated = measuredPacket(proposal);
  const unrelatedPayload = JSON.parse(unrelated.finalOutput.match(/<IMPROVEMENT>([\s\S]*?)<\/IMPROVEMENT>/)[1]);
  unrelatedPayload.revisedContent = `${target.baselineContent}\n\n## Documentation\nReformat headings and punctuation only while preserving every behavior.`;
  unrelatedPayload.changeSummary = 'Documentation formatting only.';
  unrelated.finalOutput = `<IMPROVEMENT>${JSON.stringify(unrelatedPayload)}</IMPROVEMENT>`;
  unrelated.invocation.resultSha256 = sha256(unrelated.finalOutput);
  assert.ok(validateWorkerPacket(proposal, unrelated).reasons.includes('HYPOTHESIS_UNLINKED'));

  const evaluation = compilePhaseContract('loop-de-loop', 1, {
    kind: 'evaluation',
    evaluationArm: 'challenger',
    route: REAL_TEST_MODEL,
    target,
    hypothesis,
    procedureContent: `${target.baselineContent}\n\n## Revision\n${hypothesis.operation}`,
    procedureSha256: 'd'.repeat(64),
    evidenceCapsule: EVIDENCE_CAPSULE,
    toolPolicy: 'none'
  });
  assert.equal(validateWorkerPacket(evaluation, measuredPacket(evaluation)).accepted, true);
  const proposalAsEvaluation = validateWorkerPacket(evaluation, measuredPacket(proposal));
  assert.ok(proposalAsEvaluation.reasons.includes('WRONG_PHASE_OUTPUT'));
});

test('strict packets must echo the active phase and nested self-authority aliases fail closed', () => {
  const evaluation = compilePhaseContract('loop-de-loop', 1, {
    kind: 'evaluation',
    evaluationArm: 'challenger',
    route: REAL_TEST_MODEL,
    target: boundContract('challenger').target,
    hypothesis: boundContract('challenger').hypothesis,
    procedureContent: `${BASELINE_BODY}\n\n## Revision\nApply the assigned hypothesis.`,
    procedureSha256: 'd'.repeat(64),
    evidenceCapsule: EVIDENCE_CAPSULE,
    toolPolicy: 'none'
  });
  const noPhase = measuredPacket(evaluation);
  delete noPhase.phase;
  assert.ok(validateWorkerPacket(evaluation, noPhase).reasons.includes('PHASE_SKIP'));

  const wrongPhase = measuredPacket(evaluation);
  wrongPhase.phase = 0;
  assert.ok(validateWorkerPacket(evaluation, wrongPhase).reasons.includes('PHASE_SKIP'));

  const metricAlias = measuredPacket(evaluation);
  metricAlias.claim = { review: { evaluationResult: { score: 1 } } };
  assert.ok(validateWorkerPacket(evaluation, metricAlias).reasons.includes('MODEL_REPORTED_METRIC'));

  const promotionAlias = measuredPacket(evaluation);
  promotionAlias.claim = { authority: { approvedChampion: true } };
  assert.ok(validateWorkerPacket(evaluation, promotionAlias).reasons.includes('SELF_PROMOTION'));

  const stopAlias = measuredPacket(evaluation);
  stopAlias.claim = { lifecycle: { terminalState: 'done' } };
  assert.ok(validateWorkerPacket(evaluation, stopAlias).reasons.includes('SELF_STOP'));
});

test('strict real-test accepts at most five unique evidenced findings and exactly ten valid measured attempts', () => {
  const { engine, store, home } = freshEngine();
  const candidates = Array.from({ length: 7 }, (_, index) => strictCandidate(index));
  const worker = (contract) => {
    if (contract.kind === 'mine') {
      return miningPacket(contract, candidates);
    }
    return measuredPacket(contract);
  };
  const prepared = approvedConfig();
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-5x10'
  }, { worker, maxBatches: 99 });

  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.match(result.stoppedBy, /real-test-improvement-cap|queue-drained/);
  assert.deepEqual(result.realTest.limits, REAL_TEST_LIMITS);
  assert.equal(result.realTest.findingsAccepted, 5);
  assert.equal(result.realTest.findingsRejected, 2);
  assert.equal(result.realTest.improvementAttempts, 10);
  assert.equal(result.realTest.invalidAttempts, 0);
  assert.equal(result.realTest.findingsTested, 5);
  assert.equal(result.realTest.findingsBlocked, 0);
  assert.equal(result.realTest.attemptsPlanned, 10);
  assert.equal(result.realTest.attemptsValid, 10);
  assert.equal(result.realTest.coverage.length, 5);
  assert.ok(result.realTest.coverage.every((entry) => (
    entry.valid === 2 && entry.status === 'COVERED' && entry.hypothesisIds.length === 2
  )));
  for (let index = 1; index <= 5; index++) assert.equal(store.exists(`real-5x10-t${index}`), true);

  const top = store.load('real-5x10');
  assert.equal(top.realTest.status, 'QUEUE_DRAINED');
  assert.equal(top.realTest.findingsAccepted, 5);
  assert.equal(top.realTest.improvementAttempts, 10);
  assert.deepEqual(top.realTest.coverage.map((entry) => entry.valid), [2, 2, 2, 2, 2]);
  assert.equal(top.config.model.primary, REAL_TEST_MODEL);
  assert.deepEqual(top.config.modelPolicy.builderRoutes, [REAL_TEST_MODEL]);
  const firstBranch = store.load('real-5x10-t1');
  assert.equal(firstBranch.config.model.primary, REAL_TEST_MODEL);
  assert.deepEqual(firstBranch.config.modelPolicy.testRoutes, [REAL_TEST_MODEL]);
  assert.equal(firstBranch.benchmark.def.benchSource, 'maker');
  assert.equal(firstBranch.benchmark.def.benchPartition, 'gate');
  assert.equal(firstBranch.benchmark.baselineScore.n, 3);
  assert.equal(firstBranch.benchmark.baselineScore.measurementRefs.length, 3);
  assert.ok(firstBranch.supervisionEvents.length >= 6, 'baseline and challenger receipts persisted');
  const firstAgentRun = firstBranch.tests[0].agentRuns[0];
  assert.ok(firstAgentRun.rawArtifactRef);
  assert.ok(firstAgentRun.resultArtifactRef);
  assert.ok(firstAgentRun.evaluationArtifactRef);
  assert.equal(firstAgentRun.measurementRef, firstAgentRun.evaluationArtifactRef);
  assert.equal(store.readArtifact('real-5x10-t1', firstAgentRun.rawArtifactRef).sha256, firstAgentRun.stdoutSha256);
  assert.equal(store.readArtifact('real-5x10-t1', firstAgentRun.resultArtifactRef).sha256, firstAgentRun.resultSha256);
  assert.equal(firstAgentRun.requestedModel, REAL_TEST_MODEL);
  assert.ok(Number.isFinite(firstAgentRun.artifactOutputTokenEstimate));
  assert.equal(firstAgentRun.cliReceiptTokenCost, 200);
  assert.equal(firstAgentRun.cliReportedTotalTokens, 200);
  assert.equal(firstAgentRun.durationMs, 25);
  assert.ok(firstBranch.hypotheses.every((hypothesis) => hypothesis.executorRan === true));
  assert.equal(top.realTest.experimentValidity.publicationEligible, true);
  assert.match(top.realTest.experimentValidity.evidenceSha256, /^[a-f0-9]{64}$/);
  const verified = spawnSync(process.execPath, [
    'scripts/verify-run.mjs',
    '--home', home,
    '--run', 'real-5x10'
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).publicationEligible, true);
  const childReport = store.readRunFile('real-5x10-t1', 'report.md');
  assert.match(childReport, /## Finding coverage/);
  assert.match(childReport, /cliReceiptTokenCost/);
  assert.match(childReport, /artifactOutputTokenEstimate/);
  assert.match(childReport, /cliReportedTotalTokens=200/);
  assert.match(childReport, /durationMs=25/);
  assert.match(childReport, /requested via explicit -m flag; backend-reported model: gpt-5\.6-sol/);
  assert.match(childReport, /answerSource: operator=0; config=0; default=/);
});

test('machine validity fails closed when a persisted child receipt artifact is tampered', () => {
  const { engine, store } = freshEngine();
  const candidates = [strictCandidate(1)];
  const prepared = approvedConfig();
  runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-tamper'
  }, {
    worker: (contract) => contract.kind === 'mine'
      ? miningPacket(contract, candidates)
      : measuredPacket(contract),
    maxBatches: 10
  });
  const before = store.load('real-tamper');
  assert.equal(before.realTest.experimentValidity.publicationEligible, true);
  const child = store.load('real-tamper-t1');
  const run = child.tests[0].agentRuns[0];
  const raw = store.readArtifact('real-tamper-t1', run.rawArtifactRef);
  store.writeArtifact('real-tamper-t1', run.rawArtifactRef, {
    ...raw,
    content: `${raw.content}\nTAMPERED`
  });
  const exported = engine.report_export({ runId: 'real-tamper' });
  assert.equal(exported.status, 'OK');
  const after = store.load('real-tamper');
  assert.equal(after.realTest.experimentValidity.execution.status, 'FAIL');
  assert.equal(after.realTest.experimentValidity.publicationEligible, false);
});

test('fake-metric worker packets are rejected and do not consume the ten-attempt budget', () => {
  const { engine, store } = freshEngine();
  const prepared = approvedConfig();
  const worker = (contract) => {
    if (contract.kind === 'mine') {
      const candidates = [{
        ...strictCandidate(1),
        title: 'candidate',
        baselineContent: BASELINE_BODY
      }];
      return miningPacket(contract, candidates);
    }
    if (contract.kind !== 'evaluation' || contract.evaluationArm === 'baseline') return measuredPacket(contract, 'baseline');
    return {
      ...measuredPacket(contract, 'fake'),
      claim: { metricsSelfReported: true, metrics: { quality: 1 } }
    };
  };
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-fake'
  }, { worker, maxBatches: 99 });

  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.realTest.improvementAttempts, 0);
  assert.equal(result.realTest.invalidAttempts, 3);
  assert.equal(result.realTest.coverage[0].status, 'BLOCKED');
  assert.equal(result.realTest.coverage[0].valid, 0);
  assert.equal(result.realTest.coverage[0].invalid, 3);
  assert.ok(result.transcript.some((entry) => entry.step === 'improve_blocked' && entry.reason === 'WORKERS_UNUSABLE'));
  const branch = store.load('real-fake-t1');
  assert.equal(branch.counters.test, 0);
  assert.ok(branch.supervisionEvents.every((event) => event.accepted === true || event.code === 'MODEL_REPORTED_METRIC'));
});

test('a proposal with an unverifiable strict launch receipt cannot consume an improvement attempt', () => {
  const { engine } = freshEngine();
  const prepared = approvedConfig();
  const candidates = [strictCandidate(1)];
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-proposal-receipt'
  }, {
    worker: (contract) => {
      if (contract.kind === 'mine') return miningPacket(contract, candidates);
      const packet = measuredPacket(contract);
      if (contract.kind === 'proposal') {
        packet.invocation.disabledFeatures = [];
      }
      return packet;
    },
    maxBatches: 10
  });
  assert.equal(result.realTest.improvementAttempts, 0);
  assert.equal(result.realTest.invalidAttempts, 3);
  assert.equal(result.realTest.coverage[0].status, 'BLOCKED');
});

test('one invalid strict batch is retried without stealing either finding attempt', () => {
  const { engine } = freshEngine();
  const prepared = approvedConfig();
  const candidates = [strictCandidate(1), strictCandidate(2)];
  let invalidDispatches = 3;
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-retry'
  }, {
    worker: (contract) => {
      if (contract.kind === 'mine') {
        return miningPacket(contract, candidates);
      }
      if (contract.kind === 'evaluation'
        && contract.evaluationArm === 'challenger'
        && contract.target.findingId === 'finding-001'
        && contract.hypothesis.id === 'finding-001-h1'
        && invalidDispatches-- > 0) {
        return { route: contract.route, summaryOnly: true, artifacts: [], finalOutput: '' };
      }
      return measuredPacket(contract);
    },
    maxBatches: 10
  });
  assert.equal(result.realTest.findingsAccepted, 2);
  assert.equal(result.realTest.improvementAttempts, 4);
  assert.equal(result.realTest.invalidAttempts, 1);
  assert.deepEqual(result.realTest.coverage.map((entry) => entry.valid), [2, 2]);
  assert.deepEqual(result.realTest.coverage.map((entry) => entry.status), ['COVERED', 'COVERED']);
});

test('a blocked finding leaves coverage failed while later findings continue', () => {
  const { engine, store } = freshEngine();
  const prepared = approvedConfig();
  const candidates = [strictCandidate(1), strictCandidate(2)];
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-blocked'
  }, {
    worker: (contract) => {
      if (contract.kind === 'mine') {
        return miningPacket(contract, candidates);
      }
      if (contract.kind === 'evaluation'
        && contract.evaluationArm === 'challenger'
        && contract.target.findingId === 'finding-001') {
        return { route: contract.route, summaryOnly: true, artifacts: [], finalOutput: '' };
      }
      return measuredPacket(contract);
    },
    maxBatches: 10
  });
  assert.deepEqual(result.realTest.coverage.map((entry) => entry.status), ['BLOCKED', 'COVERED']);
  assert.deepEqual(result.realTest.coverage.map((entry) => entry.valid), [0, 2]);
  assert.equal(result.realTest.findingsBlocked, 1);
  assert.equal(result.realTest.findingsTested, 1);
  assert.equal(store.exists('real-blocked-t2'), true, 'scheduler continued to the later finding');
});

test('fewer than five mined findings receive exactly two attempts each without invention', () => {
  const { engine } = freshEngine();
  const prepared = approvedConfig();
  const candidates = [strictCandidate(1), strictCandidate(2), strictCandidate(3)];
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-three'
  }, {
    worker: (contract) => contract.kind === 'mine'
      ? miningPacket(contract, candidates)
      : measuredPacket(contract),
    maxBatches: 10
  });
  assert.equal(result.realTest.findingsAccepted, 3);
  assert.equal(result.realTest.coverage.length, 3);
  assert.equal(result.realTest.improvementAttempts, 6);
  assert.ok(result.realTest.coverage.every((entry) => entry.valid === 2 && entry.status === 'COVERED'));
});

test('structured findings absent from the sealed mining output do not count as progress', () => {
  const { engine } = freshEngine();
  const prepared = approvedConfig();
  const result = runSupervisedCampaign(engine, {
    ...prepared.config,
    runId: 'real-uncaptured'
  }, {
    worker: (contract) => contract.kind === 'mine'
      ? miningPacket(contract, [strictCandidate('hidden', {
          title: 'hidden candidate',
          baselineContent: BASELINE_BODY
        })], '<CANDIDATES>[]</CANDIDATES>')
      : measuredPacket(contract),
    maxBatches: 99
  });
  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.realTest.findingsAccepted, 0);
  assert.equal(result.realTest.findingsRejected, 1);
  assert.equal(result.realTest.improvementAttempts, 0);
  assert.ok(result.transcript.some((entry) => entry.step === 'finding_rejected' && entry.reason === 'FINDING_NOT_IN_CAPTURE'));
});

test('strict baseline bar aggregates three unique captured measurements', () => {
  const { engine } = freshEngine();
  const aggregateOracle = {
    kind: 'case-results-v2',
    passMark: 1,
    cases: Array.from({ length: 5 }, (_, index) => ({
      caseId: `aggregate-${index + 1}`,
      accepted: false,
      code: `AGGREGATE_${index + 1}_OK`,
      requiredEvidencePaths: [`fixture/aggregate-${index + 1}.json`]
    }))
  };
  const caseBenchmark = {
    ...BENCHMARK,
    cases: aggregateOracle.cases.map((item) => ({ id: item.caseId, prompt: `Evaluate ${item.caseId}.` })),
    oracle: aggregateOracle,
    negativeControl: {
      content: 'NEGATIVE CONTROL: irrelevant output with no structured case results.',
      passMark: 0.6
    }
  };
  engine.initialize_loop_run({
    runId: 'real-bar',
    task: 'Improve strict baseline precision by at least 10% under the frozen token budget.',
    answers: ['measure the baseline', 'improve', 'quality up', 'preserve evidence', 'defaults', 'keep moving'],
    config: {
      realTest: {
        enabled: true,
        maxFindings: 5,
        maxImprovementAttempts: 10,
        planApproved: true,
        benchmarkAuthority: 'maker',
        baselineStrategy: 'route-batch'
      }
    }
  });
  engine.artifact_record({ runId: 'real-bar', role: 'baseline', content: BASELINE_BODY });
  engine.benchmark_freeze_maker({ runId: 'real-bar', benchmark: caseBenchmark, benchPartition: 'gate' });
  const refs = [
    recordCaseMeasurement(engine, 'real-bar', aggregateOracle, 'base-a', 800, 2),
    recordCaseMeasurement(engine, 'real-bar', aggregateOracle, 'base-b', 1000, 3),
    recordCaseMeasurement(engine, 'real-bar', aggregateOracle, 'base-c', 1200, 4)
  ];
  const bar = engine.benchmark_run({ runId: 'real-bar', arm: 'baseline', measurementRefs: refs });
  assert.equal(bar.status, 'OK');
  assert.equal(bar.baselineScore.n, 3);
  assert.equal(bar.baselineScore.quality, 0.6);
  assert.equal(bar.baselineScore.tokenCost, 1000);
  assert.equal(engine.benchmark_run({ runId: 'real-bar', arm: 'baseline', measurementRefs: [refs[0], refs[0], refs[1]] }).code, 'BAD_INPUT');
});

test('real-test CLI prints the plan hash and exits before workers without explicit approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-real-test-'));
  const path = join(dir, 'campaign.json');
  const raw = {
    task: 'Plan-only smoke test.',
    routes: ROUTES,
    benchmark: BENCHMARK,
    targets: [{ kind: 'mine', routes: ROUTES }]
  };
  writeFileSync(path, JSON.stringify(raw));
  try {
    const result = spawnSync(process.execPath, ['scripts/run-campaign.mjs', '--real-test', '--config', path], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, SUPER_LOOP_ALLOW_EXEC: '' }
    });
    assert.equal(result.status, 4);
    assert.match(result.stdout, /plan sha256: [a-f0-9]{64}/);
    assert.match(result.stderr, /Operator action required/);
    assert.match(result.stderr, /No worker was launched/);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['real-test'], 'node scripts/run-campaign.mjs --real-test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shipped 5x10 template is valid JSON but cannot run with unresolved operator placeholders', () => {
  const template = JSON.parse(readFileSync(new URL('../examples/real-test-5x10.template.json', import.meta.url), 'utf8'));
  assert.equal(template.benchmark.oracle.kind, 'case-results-v2');
  assert.ok(template.benchmark.oracle.cases.every((item) => typeof item.accepted === 'boolean'));
  const prepared = withRealTestProfile(template);
  const check = validateRealTestConfig(prepared.config);
  assert.equal(check.ok, false);
  assert.ok(check.errors.includes('task, benchmark, and targets must not contain unresolved placeholders'));
  const docs = readFileSync(new URL('../docs/REAL_TEST_5X10.md', import.meta.url), 'utf8');
  assert.match(docs, /Five accepted findings maximum/);
  assert.match(docs, /exactly two substantive hypotheses and valid attempts per accepted finding/);
  assert.match(docs, /ten valid attempts maximum globally/);
  assert.match(docs, /Do not pass --approved-plan yourself/);
});

test('one-finding canary plan is frozen and the sham arm is a hard negative control', () => {
  const canaryBenchmark = {
    ...BENCHMARK,
    cases: Array.from({ length: 6 }, (_, index) => ({
      id: `canary-${index + 1}`,
      prompt: `Evaluate canary case ${index + 1}.`
    })),
    oracle: {
      kind: 'case-results-v2',
      passMark: 1,
      cases: Array.from({ length: 6 }, (_, index) => ({
        caseId: `canary-${index + 1}`,
        accepted: false,
        code: `CANARY_${index + 1}`,
        requiredEvidencePaths: [`fixture/canary-${index + 1}.json`],
        group: index < 4 ? 'target' : 'control'
      }))
    }
  };
  const raw = {
    model: REAL_TEST_MODEL,
    routes: Array(REAL_TEST_CANARY.replicatesPerArm).fill(REAL_TEST_MODEL),
    benchmark: canaryBenchmark,
    evidenceSources: EVIDENCE_SOURCES,
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceCapsule: EVIDENCE_CAPSULE,
    target: {
      findingId: 'finding-001',
      baselineContent: BASELINE_BODY,
      evidenceRefs: [{ path: 'src/supervisor.mjs', locator: 'compilePhaseContract' }],
      shamContent: `${BASELINE_BODY}\n\n## Documentation Formatting\nRewrap paragraphs and rename headings without changing behavior.`,
      hypothesis: substantiveHypotheses(1)[0]
    }
  };
  const plan = buildRealTestCanaryPlan(raw);
  const approved = { ...raw, approvedPlanSha256: plan.sha256 };
  assert.equal(validateRealTestCanaryConfig(approved).ok, true);
  assert.deepEqual(plan.contract.arms, ['baseline', 'challenger', 'sham']);
  assert.equal(plan.contract.replicatesPerArm, 5);
  assert.equal(plan.contract.promotionEnabled, false);

  const baseline = Array.from({ length: 5 }, () => ({ targetQuality: 0.25, controlQuality: 1 }));
  const challenger = Array.from({ length: 5 }, () => ({ targetQuality: 0.75, controlQuality: 1 }));
  const sham = Array.from({ length: 5 }, () => ({ targetQuality: 0.25, controlQuality: 1 }));
  const gates = {
    scorerFixtures: true,
    receipts: true,
    isolation: true,
    schemaIdentity: true,
    stateConsistency: true
  };
  assert.equal(evaluateRealTestCanaryOutcome({ baseline, challenger, sham, gates }).status, 'PASS');
  sham[0] = { targetQuality: 0.5, controlQuality: 1 };
  const failed = evaluateRealTestCanaryOutcome({ baseline, challenger, sham, gates });
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.shamWins, 1);
  assert.ok(failed.reasons.some((reason) => /sham beat baseline/.test(reason)));
});

test('canary plan CLI is approval-gated, plan-only, and shipped with a five-route template', () => {
  const template = JSON.parse(readFileSync(new URL('../examples/real-test-canary.template.json', import.meta.url), 'utf8'));
  assert.equal(template.routes.length, 5);
  assert.ok(template.routes.every((route) => route === REAL_TEST_MODEL));
  assert.equal(template.benchmark.oracle.kind, 'case-results-v2');
  assert.ok(template.benchmark.oracle.cases.every((item) => typeof item.accepted === 'boolean'));
  assert.deepEqual(
    new Set(template.benchmark.oracle.cases.map((item) => item.group)),
    new Set(['target', 'control'])
  );
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['real-test:canary-plan'], 'node scripts/plan-real-test-canary.mjs');
  assert.equal(pkg.scripts['real-test:canary'], 'node scripts/run-real-test-canary.mjs');
  assert.equal(pkg.scripts['verify:canary'], 'node scripts/verify-canary.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-canary-'));
  const path = join(dir, 'canary.json');
  const cases = Array.from({ length: 6 }, (_, index) => ({
    id: `case-${index + 1}`,
    prompt: `Evaluate grounded case ${index + 1}.`
  }));
  const config = {
    model: REAL_TEST_MODEL,
    routes: Array(5).fill(REAL_TEST_MODEL),
    evidenceSources: ['src/supervisor.mjs'],
    target: {
      findingId: 'finding-001',
      baselineContent: BASELINE_BODY,
      evidenceRefs: [{ path: 'src/supervisor.mjs', locator: 'compilePhaseContract' }],
      hypothesis: substantiveHypotheses(1)[0],
      shamContent: `${BASELINE_BODY}\n\n## Cosmetic Only\nRewrap paragraphs without changing behavior.`
    },
    benchmark: {
      ...BENCHMARK,
      cases,
      oracle: {
        kind: 'case-results-v2',
        passMark: 1,
        cases: cases.map((item, index) => ({
          caseId: item.id,
          accepted: false,
          code: `CANARY_${index + 1}`,
          requiredEvidencePaths: ['src/supervisor.mjs'],
          group: index < 4 ? 'target' : 'control'
        }))
      },
      requiredRoutes: 5
    }
  };
  writeFileSync(path, JSON.stringify(config));
  try {
    const result = spawnSync(process.execPath, ['scripts/plan-real-test-canary.mjs', '--config', path], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    });
    assert.equal(result.status, 4);
    assert.match(result.stdout, /plan sha256: [a-f0-9]{64}/);
    assert.match(result.stdout, /promotion enabled: false/);
    assert.match(result.stderr, /Operator action required/);
    assert.match(result.stderr, /No worker was launched/);

    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
    const evidence = resolveEvidenceCapsule(repositoryRoot, config.evidenceSources);
    assert.equal(evidence.ok, true);
    const approvedConfig = {
      ...config,
      evidenceManifest: evidence.manifest,
      evidenceCapsule: evidence.capsule
    };
    const approvedPlan = buildRealTestCanaryPlan(approvedConfig);
    const home = join(dir, 'no-exec-home');
    const noExec = spawnSync(process.execPath, [
      'scripts/run-real-test-canary.mjs',
      '--config', path,
      '--approved-plan', approvedPlan.sha256,
      '--run-id', 'canary-noexec',
      '--home', home
    ], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, SUPER_LOOP_ALLOW_EXEC: '' }
    });
    assert.equal(noExec.status, 3);
    assert.match(noExec.stderr, /set SUPER_LOOP_ALLOW_EXEC=1/);
    assert.equal(existsSync(join(home, 'runs', 'canary-noexec', 'state.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function approvedCanaryConfig() {
  const cases = Array.from({ length: 6 }, (_, index) => ({
    id: `canary-${index + 1}`,
    prompt: `Apply the active procedure to captured canary case ${index + 1}.`
  }));
  const raw = {
    model: REAL_TEST_MODEL,
    routes: Array(REAL_TEST_CANARY.replicatesPerArm).fill(REAL_TEST_MODEL),
    benchmark: {
      ...BENCHMARK,
      name: 'executable-three-arm-canary',
      cases,
      oracle: {
        kind: 'case-results-v2',
        passMark: 1,
        cases: cases.map((item, index) => ({
          caseId: item.id,
          accepted: false,
          code: `CANARY_${index + 1}_OK`,
          requiredEvidencePaths: ['src/supervisor.mjs'],
          group: index < 4 ? 'target' : 'control'
        }))
      },
      requiredRoutes: 5
    },
    evidenceSources: EVIDENCE_SOURCES,
    evidenceManifest: EVIDENCE_MANIFEST,
    evidenceCapsule: EVIDENCE_CAPSULE,
    target: {
      findingId: 'finding-001',
      baselineContent: BASELINE_BODY,
      evidenceRefs: [{ path: 'src/supervisor.mjs', locator: 'compilePhaseContract' }],
      shamContent: `${BASELINE_BODY}\n\n## Cosmetic Only\nRewrap paragraphs and rename headings without changing enforcement behavior.`,
      hypothesis: substantiveHypotheses(7)[0]
    }
  };
  const plan = buildRealTestCanaryPlan(raw);
  return { ...raw, approvedPlanSha256: plan.sha256 };
}

function canaryWorker(config, { shamActsLikeChallenger = false, seenContracts = [] } = {}) {
  return (contract) => {
    seenContracts.push({
      kind: contract.kind,
      evaluationArm: contract.evaluationArm,
      procedureSha256: contract.procedureSha256,
      targetBaselineContent: contract.target?.baselineContent ?? null,
      hypothesisId: contract.hypothesis?.id ?? null,
      hypothesisTitle: contract.hypothesis?.title ?? null,
      hypothesisBottleneck: contract.hypothesis?.bottleneck ?? null,
      hypothesisOperation: contract.hypothesis?.operation ?? null,
      hypothesisExpectedMovement: contract.hypothesis?.expectedMovement ?? null,
      hypothesisFalsifier: contract.hypothesis?.falsifier ?? null
    });
    if (contract.kind === 'proposal') {
      const revisedContent = [
        contract.target.baselineContent,
        '',
        '## Canary Revision',
        contract.hypothesis.operation,
        contract.hypothesis.bottleneck,
        contract.hypothesis.expectedMovement
      ].join('\n');
      return strictStructuredPacket(contract, {
        findingId: contract.target.findingId,
        hypothesisId: contract.hypothesis.id,
        baselineSha256: contract.target.baselineSha256,
        revisedContent,
        changeSummary: `${contract.hypothesis.title}: ${contract.hypothesis.operation}`
      }, 'IMPROVEMENT');
    }
    const isBaseline = contract.procedureContent === config.target.baselineContent;
    const isSham = contract.procedureContent === config.target.shamContent;
    const challengerBehavior = !isBaseline && (!isSham || shamActsLikeChallenger);
    const rows = config.benchmark.oracle.cases.map((item, index) => ({
      caseId: item.caseId,
      disposition: item.accepted ? 'ACCEPTED' : 'BLOCKED',
      code: item.group === 'control' || challengerBehavior || index === 0
        ? item.code
        : `WRONG_${item.code}`,
      evidencePaths: item.requiredEvidencePaths
    }));
    return strictStructuredPacket(contract, {
      arm: contract.evaluationArm,
      findingId: contract.target.findingId,
      hypothesisId: contract.hypothesis.id,
      baselineSha256: contract.target.baselineSha256,
      procedureSha256: contract.procedureSha256,
      caseResults: rows
    }, 'EVALUATION');
  };
}

test('executable canary persists one proposal + fifteen arm-concealed evaluations and passes only real target movement', () => {
  const { store, home } = freshEngine();
  const config = approvedCanaryConfig();
  const seenContracts = [];
  const result = runRealTestCanary(store, config, {
    runId: 'canary-pass',
    worker: canaryWorker(config, { seenContracts })
  });
  assert.equal(result.status, 'OK', JSON.stringify(result, null, 2));
  assert.equal(result.experimentValid, true);
  assert.equal(result.outcome.status, 'PASS');
  assert.equal(result.outcome.pairedTargetWins, 5);
  assert.equal(result.outcome.shamWins, 0);
  assert.equal(result.outcome.controlRegressions, 0);
  const state = store.load('canary-pass');
  assert.equal(state.status, 'QUEUE_DRAINED');
  assert.equal(state.evaluations.length, 15);
  assert.equal(state.promotion.enabled, false);
  assert.equal(state.promotion.recorded, false);
  assert.ok(state.evaluations.every((item) => /^arm-[a-f0-9]{12}$/.test(item.blindArm)));
  assert.ok(seenContracts.filter((item) => item.kind === 'evaluation')
    .every((item) => !['baseline', 'challenger', 'sham'].includes(item.evaluationArm)));
  assert.ok(seenContracts.filter((item) => item.kind === 'evaluation')
    .every((item) => (
      item.targetBaselineContent === null
      && item.hypothesisId === 'finding-001-canary-h1'
      && item.hypothesisTitle === null
      && item.hypothesisBottleneck === null
      && item.hypothesisOperation === null
      && item.hypothesisExpectedMovement === null
      && item.hypothesisFalsifier === null
    )));
  assert.match(readFileSync(result.reportPath, 'utf8'), /paired challenger target wins: 5\/5/);
  const verification = spawnSync(process.execPath, [
    'scripts/verify-canary.mjs',
    '--home', home,
    '--run', 'canary-pass'
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(JSON.parse(verification.stdout).experimentValid, true);
});

test('a sham that moves target quality fails the canary without invalidating the completed experiment', () => {
  const { store } = freshEngine();
  const config = approvedCanaryConfig();
  const result = runRealTestCanary(store, config, {
    runId: 'canary-sham-fail',
    worker: canaryWorker(config, { shamActsLikeChallenger: true })
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.experimentValid, true);
  assert.equal(result.outcome.status, 'FAIL');
  assert.equal(result.outcome.shamWins, 5);
  assert.equal(store.load('canary-sham-fail').promotion.recorded, false);
});

test('independent canary verification accepts an absent reported model but rejects a conflicting one', () => {
  const { store } = freshEngine();
  const config = approvedCanaryConfig();
  const result = runRealTestCanary(store, config, {
    runId: 'canary-model-authority',
    worker: canaryWorker(config)
  });
  assert.equal(result.experimentValid, true);

  const state = store.load('canary-model-authority');
  const records = [state.proposal, ...state.evaluations];
  for (const record of records) {
    record.reportedModel = null;
    record.reportedModelMatchesRequest = null;
    record.modelIdentityAuthority = 'explicit-model-flag';
  }
  store.save(state);

  const absent = verifyCanaryRun(store, 'canary-model-authority');
  assert.equal(absent.experimentValid, true, JSON.stringify(absent, null, 2));
  assert.equal(absent.gates.receipts, true);

  state.proposal.reportedModel = 'gpt-5.5';
  state.proposal.reportedModelMatchesRequest = false;
  state.proposal.modelIdentityAuthority = 'cli-reported';
  store.save(state);

  const conflicting = verifyCanaryRun(store, 'canary-model-authority');
  assert.equal(conflicting.experimentValid, false);
  assert.equal(conflicting.gates.receipts, false);
  assert.ok(conflicting.failedReceipts.some((item) => (
    item.kind === 'proposal'
    && item.reasons.some((reason) => /model receipt/.test(reason))
  )));
});

test('a failed proposal launch remains blocked and persists hash-linked stdout and stderr evidence', () => {
  const { store } = freshEngine();
  const config = approvedCanaryConfig();
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-canary-failed-codex-'));
  const bin = createFakeCli(dir, 'codex', {
    stdout: '{"type":"thread.started","thread_id":"thread-proposal-failed-real-shape"}\n',
    stderr: 'deterministic canary launch failure\n',
    exitCode: 23
  });
  try {
    const result = runRealTestCanary(store, config, {
      runId: 'canary-proposal-launch-fail',
      worker: (contract) => executorWorker(contract, {
        ...process.env,
        SUPER_LOOP_ALLOW_EXEC: '1',
        SUPER_LOOP_CODEX_BIN: bin
      })
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.code, 'PROPOSAL_INVALID');
    assert.equal(result.verification.experimentValid, false);

    const state = store.load('canary-proposal-launch-fail');
    assert.equal(state.status, 'BLOCKED');
    assert.equal(state.proposal, null);
    assert.equal(state.evaluations.length, 0);
    assert.equal(state.verdictEvents.length, 1);
    assert.equal(state.verdictEvents[0].invocation.exitCode, 23);
    assert.equal(state.failureEvidence.length, 1);
    const failure = state.failureEvidence[0];
    assert.equal(failure.kind, 'proposal');
    assert.equal(failure.execReason, 'EXEC_FAILED');
    assert.equal(failure.invocation.reportedModel, null);
    assert.equal(failure.invocation.reportedModelMatchesRequest, null);
    assert.equal(failure.invocation.modelIdentityAuthority, 'explicit-model-flag');
    assert.equal(failure.stdout.matchesReceipt, true);
    assert.equal(failure.stderr.matchesReceipt, true);

    const stdout = store.readArtifact('canary-proposal-launch-fail', failure.stdout.artifactRef);
    const stderr = store.readArtifact('canary-proposal-launch-fail', failure.stderr.artifactRef);
    assert.equal(stdout.sha256, failure.invocation.stdoutSha256);
    assert.equal(stderr.sha256, failure.invocation.stderrSha256);
    assert.match(stdout.content, /thread\.started/);
    assert.equal(stderr.content, 'deterministic canary launch failure\n');
    assert.match(readFileSync(result.reportPath, 'utf8'), /proposal-failed-stderr/);
    assert.equal(state.promotion.enabled, false);
    assert.equal(state.promotion.recorded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed evaluation launch preserves its arm position and diagnostics after a valid proposal', () => {
  const { store } = freshEngine();
  const config = approvedCanaryConfig();
  const proposalWorker = canaryWorker(config);
  const dir = mkdtempSync(join(tmpdir(), 'loop-factory-canary-failed-evaluation-'));
  const bin = createFakeCli(dir, 'codex', {
    stdout: '{"type":"thread.started","thread_id":"thread-evaluation-failed-real-shape"}\n',
    stderr: 'deterministic evaluation launch failure\n',
    exitCode: 29
  });
  try {
    const result = runRealTestCanary(store, config, {
      runId: 'canary-evaluation-launch-fail',
      worker: (contract) => contract.kind === 'proposal'
        ? proposalWorker(contract)
        : executorWorker(contract, {
            ...process.env,
            SUPER_LOOP_ALLOW_EXEC: '1',
            SUPER_LOOP_CODEX_BIN: bin
          })
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.code, 'EVALUATION_INVALID');

    const state = store.load('canary-evaluation-launch-fail');
    assert.ok(state.proposal);
    assert.equal(state.evaluations.length, 0);
    assert.equal(state.verdictEvents.length, 2);
    assert.equal(state.failureEvidence.length, 1);
    const failure = state.failureEvidence[0];
    assert.equal(failure.kind, 'evaluation');
    assert.ok(['baseline', 'challenger', 'sham'].includes(failure.armRole));
    assert.match(failure.blindArm, /^arm-[a-f0-9]{12}$/);
    assert.equal(failure.replicate, 0);
    assert.equal(failure.position, 0);
    assert.equal(failure.invocation.exitCode, 29);
    assert.equal(failure.stderr.matchesReceipt, true);
    assert.equal(
      store.readArtifact('canary-evaluation-launch-fail', failure.stderr.artifactRef).content,
      'deterministic evaluation launch failure\n'
    );
    assert.equal(state.promotion.recorded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('independent canary verification fails closed after a persisted raw receipt is tampered', () => {
  const { store, home } = freshEngine();
  const config = approvedCanaryConfig();
  const result = runRealTestCanary(store, config, {
    runId: 'canary-tamper',
    worker: canaryWorker(config)
  });
  assert.equal(result.experimentValid, true);
  const state = store.load('canary-tamper');
  const first = state.evaluations[0];
  const raw = store.readArtifact('canary-tamper', first.rawArtifactRef);
  store.writeArtifact('canary-tamper', first.rawArtifactRef, {
    ...raw,
    content: `${raw.content}\nTAMPERED`
  });
  const verification = verifyCanaryRun(store, 'canary-tamper');
  assert.equal(verification.status, 'FAIL');
  assert.equal(verification.experimentValid, false);
  assert.equal(verification.gates.receipts, false);
  const cli = spawnSync(process.execPath, [
    'scripts/verify-canary.mjs',
    '--home', home,
    '--run', 'canary-tamper'
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).experimentValid, false);
});
