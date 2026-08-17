import { readFileSync } from 'node:fs';
import {
  canonicalMechanismProgramJson,
  normalizeMechanismProgram
} from './mechanism-compiler.mjs';
import { createMechanismMutationPlan } from './mechanism-mutation.mjs';
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import {
  validateLosslessContextProjection
} from './adaptive-context-compaction.mjs';
import {
  STRICT_CODEX_DISABLED_FEATURES,
  buildArgs,
  runWorker,
  schemaPathForContract
} from './executor.mjs';
import {
  validateCodexOAuthAuthorityRecord
} from './codex-oauth-authority.mjs';
import { canonicalJson } from './real-test.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const MECHANISM_MUTATION_OUTPUT_SCHEMA = 'mechanism-mutation-output-v1';

const COLLECTIONS = Object.freeze([
  'selectors',
  'bindings',
  'forbiddenBindings',
  'metrics',
  'rules',
  'fallback'
]);
const ACTIONS = new Set(['add', 'remove', 'replace']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const REASON_RE = /^[A-Z0-9][A-Z0-9_]{0,119}$/;

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function itemInventory(program) {
  return COLLECTIONS.flatMap((collection) => {
    const items = collection === 'fallback' ? [program.fallback] : program[collection];
    return items.map((value, index) => ({
      collection,
      index,
      itemSha256: sha256(canonicalMechanismProgramJson(value)),
      value
    }));
  });
}

function visibleMemory(projection) {
  return projection.inlineRecords.map((record) => ({
    recordId: record.recordId,
    artifactSha256: record.artifactSha256,
    content: record.content
  }));
}

export function buildMechanismMutationPrompt(contract = {}) {
  return [
    'You are proposing one bounded mutation to a deterministic mechanism program.',
    'Return only JSON matching the supplied output schema.',
    'The supervisor owns all IDs, evidence bindings, lifecycle decisions, execution, and measurement.',
    'Do not claim that the mutation improves anything. It is only a hypothesis.',
    'Use at most the configured operation count. Every replace/remove must copy an exact itemSha256 from the inventory.',
    'Cite only inline memoryRecordIds whose content genuinely informed the operation. An empty list is valid.',
    '',
    canonicalJson({
      generation: contract.generation,
      objective: contract.objective,
      maximumOperations: contract.maximumOperations,
      allocatedInputTokens: contract.allocatedInputTokens,
      parent: contract.parent,
      itemInventory: contract.itemInventory,
      inlineMemory: contract.inlineMemory,
      referencedMemoryIndex: contract.referencedMemoryIndex
    })
  ].join('\n');
}

export function buildMechanismMutationContract({
  generation,
  model,
  reasoningEffort,
  parentFamily,
  objective,
  contextProjection,
  allocatedInputTokens,
  maximumOperations = 3
} = {}) {
  const parent = validateAdaptiveRecord(parentFamily);
  const projection = validateLosslessContextProjection(contextProjection);
  const normalized = normalizeMechanismProgram(parentFamily?.causalFingerprint?.program);
  if (!Number.isInteger(generation)
      || generation < 0
      || !isSafeId(model)
      || !['high', 'xhigh', 'max'].includes(reasoningEffort)
      || parent.status !== 'OK'
      || parentFamily.schemaVersion !== 'mechanism-family-v1'
      || projection.status !== 'OK'
      || normalized.status !== 'OK'
      || !Number.isInteger(allocatedInputTokens)
      || allocatedInputTokens < 1
      || !Number.isInteger(maximumOperations)
      || maximumOperations < 1
      || maximumOperations > 3
      || !plainObject(objective)) {
    return refused('MUTATION_CONTRACT_INVALID', 'Mutation contract inputs are invalid.');
  }
  const referencedMemoryIndex = contextProjection.entries
    .filter((entry) => entry.projection === 'REFERENCE')
    .map((entry) => ({
      recordId: entry.recordId,
      artifactRef: entry.artifactRef,
      artifactSha256: entry.artifactSha256,
      semanticSha256: entry.semanticSha256,
      lifecycle: entry.lifecycle
    }));
  const payload = {
    kind: 'mechanism-mutation',
    toolPolicy: 'none',
    generation,
    model,
    reasoningEffort,
    allocatedInputTokens,
    maximumOperations,
    objective: structuredClone(objective),
    parent: {
      familyId: parentFamily.familyId,
      familySha256: parentFamily.familySha256,
      programSha256: normalized.programSha256,
      program: normalized.program
    },
    itemInventory: itemInventory(normalized.program),
    inlineMemory: visibleMemory(contextProjection),
    referencedMemoryIndex,
    contextIndexSha256: contextProjection.indexSha256
  };
  const promptTokenEstimate = Math.ceil(
    Buffer.byteLength(buildMechanismMutationPrompt(payload)) / 4
  );
  if (promptTokenEstimate > allocatedInputTokens) {
    return refused(
      'MUTATION_PROMPT_BUDGET_EXCEEDED',
      'The complete mutation prompt exceeds the current context allocation.',
      { promptTokenEstimate, allocatedInputTokens }
    );
  }
  const boundPayload = { ...payload, promptTokenEstimate };
  return ok({
    contract: {
      ...boundPayload,
      contractSha256: sha256(canonicalJson(boundPayload))
    }
  });
}

function normalizeOutput(value, contract) {
  if (!exactKeys(value, [
    'operations',
    'reasonCodes',
    'expectedEffectCode',
    'memoryRecordIds',
    'explanation'
  ])
      || !Array.isArray(value.operations)
      || value.operations.length < 1
      || value.operations.length > contract.maximumOperations
      || !Array.isArray(value.reasonCodes)
      || value.reasonCodes.length < 1
      || value.reasonCodes.length > 12
      || value.reasonCodes.some((code) => !REASON_RE.test(String(code || '')))
      || new Set(value.reasonCodes).size !== value.reasonCodes.length
      || !REASON_RE.test(String(value.expectedEffectCode || ''))
      || !Array.isArray(value.memoryRecordIds)
      || value.memoryRecordIds.length > 8
      || new Set(value.memoryRecordIds).size !== value.memoryRecordIds.length
      || typeof value.explanation !== 'string'
      || !value.explanation.trim()
      || value.explanation.length > 2000) return null;
  const allowedMemory = new Set(contract.inlineMemory.map((record) => record.recordId));
  if (value.memoryRecordIds.some((recordId) => (
    !isSafeId(recordId) || !allowedMemory.has(recordId)
  ))) return null;
  const inventoryHashes = new Set(contract.itemInventory.map((item) => item.itemSha256));
  const operations = [];
  for (const operation of value.operations) {
    if (!exactKeys(operation, [
      'action',
      'collection',
      'expectedItemSha256',
      'insertBeforeRuleId',
      'value'
    ])
        || !ACTIONS.has(operation.action)
        || !COLLECTIONS.includes(operation.collection)
        || (operation.action === 'add' && operation.expectedItemSha256 != null)
        || (operation.action !== 'add'
          && !inventoryHashes.has(operation.expectedItemSha256))
        || (operation.insertBeforeRuleId != null
          && !isSafeId(operation.insertBeforeRuleId))
        || (operation.action === 'remove' && operation.value != null)
        || (operation.action !== 'remove' && !plainObject(operation.value))) return null;
    operations.push(structuredClone(operation));
  }
  return {
    operations,
    reasonCodes: [...value.reasonCodes],
    expectedEffectCode: value.expectedEffectCode,
    memoryRecordIds: [...value.memoryRecordIds],
    explanation: value.explanation.trim()
  };
}

export function parseMechanismMutationOutput(text, contract) {
  try {
    const value = JSON.parse(String(text || ''));
    const output = normalizeOutput(value, contract);
    return output
      ? ok({ output })
      : refused('MUTATION_OUTPUT_INVALID', 'Mutation output violates the bounded contract.');
  } catch {
    return refused('MUTATION_OUTPUT_INVALID', 'Mutation output is not JSON.');
  }
}

export function mutationInvocationMatches({
  runtimeAuthority,
  contract,
  invocation,
  requireSuccess = true
} = {}) {
  const authority = validateCodexOAuthAuthorityRecord(runtimeAuthority);
  const schemaPath = schemaPathForContract(contract);
  if (authority.status !== 'OK' || !schemaPath || !invocation) return false;
  const expectedArgv = buildArgs('codex', null, contract.model, {
    strictIsolation: true,
    schemaPath,
    workspaceRoot: invocation.workspaceRoot,
    reasoningEffort: contract.reasoningEffort
  });
  const reported = invocation.reportedModel == null
    ? null
    : String(invocation.reportedModel).toLowerCase();
  return invocation.requestedModel === contract.model
    && invocation.reasoningEffort === contract.reasoningEffort
    && invocation.binaryFamily === 'codex'
    && invocation.modelSelectionAuthority === 'explicit-model-flag'
    && invocation.executableBasename === authority.record.binary.basename
    && invocation.executableSha256 === authority.record.binary.sha256
    && invocation.executableBytes === authority.record.binary.bytes
    && invocation.authMode === 'chatgpt-oauth'
    && invocation.oauthAuthoritySha256 === authority.record.authoritySha256
    && canonicalJson(invocation.argv) === canonicalJson(expectedArgv)
    && invocation.strictIsolation === true
    && canonicalJson(invocation.disabledFeatures)
      === canonicalJson(STRICT_CODEX_DISABLED_FEATURES)
    && invocation.outputSchemaSha256 === sha256(readFileSync(schemaPath))
    && invocation.isolation?.status === 'PASS'
    && (invocation.isolation?.toolCalls || []).length === 0
    && (requireSuccess ? invocation.exitCode === 0 : Number.isInteger(invocation.exitCode))
    && (reported == null || reported === contract.model.toLowerCase())
    && invocation.reportedModelMatchesRequest !== false;
}

export function executeMechanismMutationHypothesis({
  contract,
  runtimeAuthority,
  env = process.env,
  worker = null
} = {}) {
  const prompt = buildMechanismMutationPrompt(contract);
  const result = typeof worker === 'function'
    ? worker({ contract, prompt })
    : runWorker({
        model: contract.model,
        prompt,
        timeoutMs: 10 * 60 * 1000,
        env,
        executionContract: contract
      });
  if (!result?.ok) {
    return refused(
      result?.reason || 'MUTATION_WORKER_FAILED',
      result?.message || 'Mutation worker failed.',
      { result }
    );
  }
  const parsed = parseMechanismMutationOutput(result.resultText, contract);
  if (parsed.status !== 'OK') return { ...parsed, result };
  if (!mutationInvocationMatches({
    runtimeAuthority,
    contract,
    invocation: result.invocation
  })) {
    return refused(
      'MUTATION_MODEL_AUTHORITY_UNPROVEN',
      'Mutation worker authority does not match the sealed contract.',
      { result }
    );
  }
  const plan = createMechanismMutationPlan({
    parent: {
      familyId: contract.parent.familyId,
      familySha256: contract.parent.familySha256,
      programSha256: contract.parent.programSha256
    },
    objective: contract.objective,
    operations: parsed.output.operations,
    reasonCodes: parsed.output.reasonCodes,
    expectedEffectCode: parsed.output.expectedEffectCode
  });
  if (plan.status !== 'OK') {
    return refused(plan.code, plan.message, { result, output: parsed.output });
  }
  return ok({
    prompt,
    output: parsed.output,
    plan: plan.plan,
    result
  });
}
