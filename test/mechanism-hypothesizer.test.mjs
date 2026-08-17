import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import { createInitialAdaptiveContextPolicy } from '../src/adaptive-context-policy.mjs';
import { buildLosslessContextProjection } from '../src/adaptive-context-compaction.mjs';
import {
  buildMechanismMutationContract,
  buildMechanismMutationPrompt,
  executeMechanismMutationHypothesis,
  parseMechanismMutationOutput
} from '../src/mechanism-hypothesizer.mjs';
import { normalizeMechanismProgram } from '../src/mechanism-compiler.mjs';
import { createCodexOAuthAuthorityRecord } from '../src/codex-oauth-authority.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  schemaPathForContract
} from '../src/executor.mjs';
import { sha256 } from '../src/util.mjs';

const PROGRAM = {
  schemaVersion: 'mechanism-program-v1',
  bindingPolicy: 'closed-world',
  roles: ['baseline.quality', 'candidate.quality'],
  selectors: [],
  bindings: [],
  forbiddenBindings: [],
  metrics: [{
    metricId: 'quality-delta',
    operator: 'subtract',
    leftRole: 'candidate.quality',
    rightRole: 'baseline.quality'
  }],
  rules: [{
    ruleId: 'accept-quality',
    kind: 'decision',
    exceptionOf: null,
    when: {
      operator: 'greater-than',
      left: { kind: 'metric', id: 'quality-delta' },
      right: { kind: 'literal', value: 0 }
    },
    emit: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
  }],
  fallback: { decision: 'REJECT', code: 'NO_GAIN' }
};

function parentFamily() {
  const built = createMechanismFamilyRecord({
    causalFingerprint: {
      bottleneckKind: 'coarse-fallback',
      interventionKind: 'evidence-bound-fallback',
      operationKind: 'bounded-program-mutation',
      expectedEffectKind: 'more-exact-dispositions',
      preconditions: ['paired-measurement'],
      procedureSteps: ['measure', 'mutate', 'verify'],
      program: PROGRAM,
      applicability: {
        taskModes: ['improve'],
        loopRoles: ['supervisor'],
        taskValueDimensions: ['exactness'],
        resourceDimensions: ['token-cost']
      }
    }
  });
  assert.equal(built.status, 'OK');
  return built.record;
}

function contextProjection() {
  const policy = createInitialAdaptiveContextPolicy({
    scopeId: 'hypothesizer-test',
    minInputTokens: 100,
    initialInputTokens: 1000,
    maxInputTokens: 2000,
    permanentControlFraction: 0.2,
    recordedAt: '2026-08-05T02:00:00.000Z'
  });
  assert.equal(policy.status, 'OK');
  const content = JSON.stringify({ lesson: 'Make equal-value fallback explicit.' });
  const projection = buildLosslessContextProjection({
    policy: policy.record,
    records: [{
      recordId: 'memory-equal-fallback',
      artifactRef: 'memory-artifact-equal-fallback',
      artifactSha256: sha256(content),
      content,
      priority: 1,
      lifecycle: 'verified',
      semanticSha256: sha256('equal-fallback')
    }]
  });
  assert.equal(projection.status, 'OK');
  return projection.record;
}

function objective() {
  return {
    measurementId: `measurement-${sha256('hypothesis-source').slice(0, 24)}`,
    measurementSha256: sha256('hypothesis-source-measurement'),
    failureCaseSetSha256: sha256('hypothesis-failures'),
    successCaseSetSha256: sha256('hypothesis-successes'),
    targetMetric: 'exact-case-rate',
    direction: 'increase'
  };
}

function authority(model, reasoningEffort) {
  const built = createCodexOAuthAuthorityRecord({
    binaryPath: '/opt/codex/codex.real',
    binaryBytes: Buffer.from('hypothesizer-codex'),
    versionOutput: 'codex-cli 0.200.0',
    loginStatusOutput: 'Logged in using ChatGPT',
    catalogOutput: JSON.stringify({
      models: [{
        slug: model,
        display_name: model,
        visibility: 'list',
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: reasoningEffort, description: 'fixture' }],
        default_reasoning_level: reasoningEffort,
        service_tiers: []
      }]
    }),
    requestedModel: model,
    reasoningEffort
  });
  assert.equal(built.status, 'OK');
  return built.record;
}

function fixture() {
  const family = parentFamily();
  const built = buildMechanismMutationContract({
    generation: 0,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    parentFamily: family,
    objective: objective(),
    contextProjection: contextProjection(),
    allocatedInputTokens: 1000,
    maximumOperations: 3
  });
  assert.equal(built.status, 'OK', built.message);
  return { family, contract: built.contract };
}

function output(contract) {
  const fallback = contract.itemInventory.find((item) => item.collection === 'fallback');
  return {
    operations: [{
      action: 'replace',
      collection: 'fallback',
      expectedItemSha256: fallback.itemSha256,
      insertBeforeRuleId: null,
      value: { decision: 'REJECT', code: 'MANUAL_REVIEW' }
    }],
    reasonCodes: ['FAILED_FALLBACK_DISPOSITION'],
    expectedEffectCode: 'MORE_EXACT_CASES',
    memoryRecordIds: ['memory-equal-fallback'],
    explanation: 'Test the explicit equal-value fallback learned from prior evidence.'
  };
}

test('hypothesizer accepts bounded output and supervisor constructs the mutation plan', () => {
  const { contract } = fixture();
  const runtimeAuthority = authority(contract.model, contract.reasoningEffort);
  const value = output(contract);
  const resultText = JSON.stringify(value);
  const prompt = buildMechanismMutationPrompt(contract);
  const schemaPath = schemaPathForContract(contract);
  const workspaceRoot = '/tmp/hypothesizer-capsule';
  const rawStdout = JSON.stringify({ type: 'agent_message', text: resultText });
  const result = executeMechanismMutationHypothesis({
    contract,
    runtimeAuthority,
    worker: () => ({
      ok: true,
      resultText,
      stdout: rawStdout,
      invocation: {
        requestedModel: contract.model,
        reasoningEffort: contract.reasoningEffort,
        reportedModel: contract.model,
        binaryFamily: 'codex',
        argv: buildArgs('codex', null, contract.model, {
          strictIsolation: true,
          schemaPath,
          workspaceRoot,
          reasoningEffort: contract.reasoningEffort
        }),
        modelSelectionAuthority: 'explicit-model-flag',
        reportedModelMatchesRequest: true,
        executableBasename: runtimeAuthority.binary.basename,
        executableSha256: runtimeAuthority.binary.sha256,
        executableBytes: runtimeAuthority.binary.bytes,
        authMode: 'chatgpt-oauth',
        oauthAuthoritySha256: runtimeAuthority.authoritySha256,
        promptSha256: sha256(prompt),
        strictIsolation: true,
        disabledFeatures: [...STRICT_CODEX_DISABLED_FEATURES],
        workspaceRoot,
        outputSchemaSha256: sha256(readFileSync(schemaPath)),
        exitCode: 0,
        isolation: { status: 'PASS', toolCalls: [], reasons: [] },
        tokenUsage: 1000,
        tokenUsageDetails: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }
      }
    })
  });
  assert.equal(result.status, 'OK', result.message);
  assert.equal(result.plan.parent.familyId, contract.parent.familyId);
  assert.equal(result.plan.objective.measurementId, contract.objective.measurementId);
  assert.equal(result.plan.operations.length, 1);
});

test('hypothesizer refuses uncited references and invented target hashes', () => {
  const { contract } = fixture();
  const referenced = output(contract);
  referenced.memoryRecordIds = ['not-inline'];
  assert.equal(
    parseMechanismMutationOutput(JSON.stringify(referenced), contract).status,
    'REFUSED'
  );
  const invented = output(contract);
  invented.operations[0].expectedItemSha256 = sha256('invented-item');
  assert.equal(
    parseMechanismMutationOutput(JSON.stringify(invented), contract).status,
    'REFUSED'
  );
});

test('hypothesizer refuses before dispatch when the complete prompt exceeds allocation', () => {
  const family = parentFamily();
  const built = buildMechanismMutationContract({
    generation: 0,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    parentFamily: family,
    objective: objective(),
    contextProjection: contextProjection(),
    allocatedInputTokens: 10,
    maximumOperations: 3
  });
  assert.equal(built.code, 'MUTATION_PROMPT_BUDGET_EXCEEDED');
  assert.ok(built.promptTokenEstimate > built.allocatedInputTokens);
});

test('mechanism mutation output schema is closed and capped at three operations', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../src/schemas/mechanism-mutation-output.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.$id, 'mechanism-mutation-output-v1');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.operations.maxItems, 3);
  assert.equal(normalizeMechanismProgram(PROGRAM).status, 'OK');
});
