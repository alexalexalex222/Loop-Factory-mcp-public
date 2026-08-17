import { validateAdaptiveRecord } from './adaptive-records.mjs';
import {
  normalizeMechanismProgram
} from './mechanism-compiler.mjs';
import {
  createMechanismMutationPlan,
  validateMechanismMutationPlan
} from './mechanism-mutation.mjs';
import {
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution
} from './mechanism-evolution.mjs';
import { validateMechanismEvolutionRecord } from './mechanism-evolution-records.mjs';
import {
  validateCandidateContract,
  validateCandidateVerification,
  verifyCandidateContractScope
} from './vnext-candidate-generators.mjs';
import { validateVNextPreparationResult } from './vnext-pipeline.mjs';
import { verifyVNextPreparationRun } from './vnext-preparation-store.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  validateVNextStageArtifact
} from './vnext-contracts.mjs';
import { isSafeId, sha256 } from './util.mjs';

export const VNEXT_MECHANISM_EXECUTION_BINDING_SCHEMA =
  'vnext-mechanism-execution-binding-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const COLLECTIONS = new Set([
  'bindings',
  'fallback',
  'forbiddenbindings',
  'metrics',
  'rules',
  'selectors'
]);
const COLLECTION_NAMES = Object.freeze({ forbiddenbindings: 'forbiddenBindings' });

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...keys].sort());
}

function parseOperation(operation) {
  const parts = String(operation.target || '').split('/');
  const rawCollection = parts[1];
  if (parts[0] !== 'mechanism-program'
      || !COLLECTIONS.has(rawCollection)
      || (rawCollection === 'fallback' ? parts.length !== 2 : parts.length !== 3)
      || !['add', 'delete', 'replace'].includes(operation.op)) return null;
  const collection = COLLECTION_NAMES[rawCollection] ?? rawCollection;
  if (collection === 'fallback' && operation.op !== 'replace') return null;
  let value = null;
  if (operation.op !== 'delete') {
    if (typeof operation.value !== 'string') return null;
    try { value = JSON.parse(operation.value); } catch { return null; }
    if (!plainObject(value)) return null;
  } else if (operation.value !== null) return null;
  return {
    action: operation.op === 'delete' ? 'remove' : operation.op,
    collection,
    expectedItemSha256: operation.beforeSha256,
    insertBeforeRuleId: null,
    value
  };
}

function candidateStage(result) {
  return [...result.stages].reverse().find((stage) => (
    stage.stage === VNEXT_STAGE.CANDIDATE
  )) ?? null;
}

function derive({
  preparationVerification,
  parentFamily,
  mutationObjective,
  reasonCodes,
  expectedEffectCode,
  interfaceContracts,
  behaviorMap,
  proposalRecordedAt,
  shadowRecordedAt,
  requireProduction
}) {
  const result = preparationVerification?.result;
  const candidateArtifact = result ? candidateStage(result) : null;
  const contract = result?.candidateContract;
  const candidate = candidateArtifact?.payload?.candidate;
  const candidateVerification = candidateArtifact?.payload?.verification;
  const checks = {
    preparation: preparationVerification?.status === 'OK',
    pipeline: validateVNextPreparationResult(result).status === 'OK',
    disposition: result?.disposition === 'CANDIDATE_READY_FOR_EXPERIMENT',
    candidateArtifact: validateVNextStageArtifact(candidateArtifact).status === 'OK',
    candidateContract: validateCandidateContract(contract).status === 'OK',
    candidateScope: verifyCandidateContractScope(contract, {
      behaviorMap,
      parentItemHashes: contract?.parentItems
    }).status === 'OK',
    candidateVerification: validateCandidateVerification(candidateVerification, {
        candidate,
        contract
      }).status === 'OK',
    component: contract?.allowedComponent === 'mechanism-program'
      && candidate?.component === 'mechanism-program',
    production: !requireProduction
      || preparationVerification?.evidence?.productionEvidence === true,
    parent: validateAdaptiveRecord(parentFamily).status === 'OK'
      && !!parentFamily?.causalFingerprint?.program,
    parentArtifact: contract?.parentArtifactSha256
      === sha256(canonicalVNextJson(parentFamily?.causalFingerprint?.program)),
    interfaces: Array.isArray(interfaceContracts) && interfaceContracts.length > 0,
    timestamps: Number.isFinite(Date.parse(proposalRecordedAt))
      && Number.isFinite(Date.parse(shadowRecordedAt))
      && Date.parse(shadowRecordedAt) > Date.parse(proposalRecordedAt)
  };
  if (Object.values(checks).some((passed) => !passed)) {
    return refused(
      'VNEXT_MECHANISM_EXECUTION_INPUT_INVALID',
      'Execution binding requires a verified mechanism-program candidate, exact parent, interfaces, and preparation proof.',
      { failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name) }
    );
  }
  const parentProgram = normalizeMechanismProgram(parentFamily.causalFingerprint.program);
  if (parentProgram.status !== 'OK') return parentProgram;
  const operations = candidate.operations.map(parseOperation);
  if (operations.some((operation) => operation == null)) {
    return refused(
      'VNEXT_MECHANISM_ADAPTER_UNSUPPORTED_OPERATION',
      'The mechanism adapter accepts only explicit add, delete, or replace operations on mechanism-program collections.'
    );
  }
  const mutation = createMechanismMutationPlan({
    parent: {
      familyId: parentFamily.familyId,
      familySha256: parentFamily.familySha256,
      programSha256: parentProgram.programSha256
    },
    objective: mutationObjective,
    operations,
    reasonCodes,
    expectedEffectCode
  });
  if (mutation.status !== 'OK') return mutation;
  const proposed = proposeMechanismEvolution({
    parentFamily,
    mutationPlan: mutation.plan,
    recordedAt: proposalRecordedAt
  });
  if (proposed.status !== 'OK') return proposed;
  const shadow = advanceMechanismEvolutionToShadow({
    currentRecord: proposed.record,
    parentFamily,
    candidateFamily: proposed.candidateFamily,
    interfaceContracts,
    recordedAt: shadowRecordedAt
  });
  if (shadow.status !== 'OK') return shadow;
  return {
    status: 'OK',
    result,
    candidateArtifact,
    contract,
    candidate,
    candidateVerification,
    mutationPlan: mutation.plan,
    candidateFamily: proposed.candidateFamily,
    evolutionRecord: shadow.record,
    treatmentDelta: shadow.treatmentDelta
  };
}

function bindingCore({
  preparationRunId,
  taskPartition,
  taskPackSha256,
  preparationVerification,
  derived,
  proposalRecordedAt,
  shadowRecordedAt
}) {
  return {
    schemaVersion: VNEXT_MECHANISM_EXECUTION_BINDING_SCHEMA,
    adapterId: 'mechanism-program-v1',
    preparationRunId,
    taskPartition,
    taskPackSha256,
    preparationVerifierEvidenceSha256: preparationVerification.evidenceSha256,
    pipelineReceiptSha256: derived.result.receipt.receiptSha256,
    candidateArtifactSha256: derived.candidateArtifact.artifactSha256,
    candidateVerificationSha256: derived.candidateVerification.verificationSha256,
    candidateContractSha256: derived.contract.contractSha256,
    behaviorMapSha256: derived.contract.behaviorMapSha256,
    allowedTargetsSha256: sha256(canonicalVNextJson(derived.contract.allowedTargets)),
    parentFamilySha256: derived.evolutionRecord.parent.familySha256,
    mutationPlanSha256: derived.mutationPlan.mutationPlanSha256,
    candidateFamilySha256: derived.candidateFamily.familySha256,
    candidateProgramSha256: derived.evolutionRecord.candidate.programSha256,
    evolutionSha256: derived.evolutionRecord.evolutionSha256,
    treatmentDeltaSha256: derived.treatmentDelta.treatmentDeltaSha256,
    proposalRecordedAt,
    shadowRecordedAt,
    productionEvidence: preparationVerification.evidence.productionEvidence === true,
    executionAuthority: 'bounded-experiment-only',
    activationAuthority: false
  };
}

export function createVNextMechanismExecutionBinding(input = {}, {
  requireProduction = true
} = {}) {
  if (!isSafeId(input.preparationRunId)) {
    return refused('VNEXT_MECHANISM_PREPARATION_RUN_INVALID', 'A safe preparation proof run ID is required.');
  }
  if (!['development', 'validation'].includes(input.taskPartition)
      || !SHA256.test(String(input.taskPackSha256 || ''))) {
    return refused(
      'VNEXT_MECHANISM_TASK_PACK_BINDING_INVALID',
      'An exact development or validation task-pack binding is required.'
    );
  }
  const derived = derive({ ...input, requireProduction });
  if (derived.status !== 'OK') return derived;
  const core = bindingCore({ ...input, derived });
  const binding = {
    ...core,
    bindingSha256: sha256(canonicalVNextJson(core))
  };
  return {
    status: 'OK',
    binding,
    mutationPlan: derived.mutationPlan,
    parentFamily: input.parentFamily,
    candidateFamily: derived.candidateFamily,
    evolutionRecord: derived.evolutionRecord,
    treatmentDelta: derived.treatmentDelta
  };
}

export function validateVNextMechanismExecutionBinding(binding) {
  if (!exactKeys(binding, [
    'schemaVersion', 'adapterId', 'preparationRunId',
    'taskPartition', 'taskPackSha256',
    'preparationVerifierEvidenceSha256', 'pipelineReceiptSha256',
    'candidateArtifactSha256', 'candidateVerificationSha256',
    'candidateContractSha256', 'behaviorMapSha256', 'allowedTargetsSha256',
    'parentFamilySha256', 'mutationPlanSha256',
    'candidateFamilySha256', 'candidateProgramSha256', 'evolutionSha256',
    'treatmentDeltaSha256', 'proposalRecordedAt', 'shadowRecordedAt',
    'productionEvidence', 'executionAuthority', 'activationAuthority',
    'bindingSha256'
  ])
      || binding.schemaVersion !== VNEXT_MECHANISM_EXECUTION_BINDING_SCHEMA
      || binding.adapterId !== 'mechanism-program-v1'
      || !isSafeId(binding.preparationRunId)
      || !['development', 'validation'].includes(binding.taskPartition)
      || ![
        binding.taskPackSha256,
        binding.preparationVerifierEvidenceSha256,
        binding.pipelineReceiptSha256,
        binding.candidateArtifactSha256,
        binding.candidateVerificationSha256,
        binding.candidateContractSha256,
        binding.behaviorMapSha256,
        binding.allowedTargetsSha256,
        binding.parentFamilySha256,
        binding.mutationPlanSha256,
        binding.candidateFamilySha256,
        binding.candidateProgramSha256,
        binding.evolutionSha256,
        binding.treatmentDeltaSha256,
        binding.bindingSha256
      ].every((value) => SHA256.test(String(value || '')))
      || !Number.isFinite(Date.parse(binding.proposalRecordedAt))
      || !Number.isFinite(Date.parse(binding.shadowRecordedAt))
      || Date.parse(binding.shadowRecordedAt) <= Date.parse(binding.proposalRecordedAt)
      || typeof binding.productionEvidence !== 'boolean'
      || binding.executionAuthority !== 'bounded-experiment-only'
      || binding.activationAuthority !== false) {
    return refused('VNEXT_MECHANISM_EXECUTION_BINDING_INVALID', 'Execution binding shape or authority is invalid.');
  }
  const core = structuredClone(binding);
  delete core.bindingSha256;
  return binding.bindingSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', binding }
    : refused('VNEXT_MECHANISM_EXECUTION_BINDING_TAMPERED', 'Execution binding hash drifted.');
}

export function verifyVNextMechanismExecutionBinding({
  binding,
  preparationVerification,
  parentFamily,
  candidateFamily,
  evolutionRecord,
  interfaceContracts,
  behaviorMap,
  requireProduction = true
} = {}) {
  if (validateVNextMechanismExecutionBinding(binding).status !== 'OK'
      || (requireProduction && binding.productionEvidence !== true)
      || validateAdaptiveRecord(candidateFamily).status !== 'OK'
      || validateMechanismEvolutionRecord(evolutionRecord).status !== 'OK'
      || validateMechanismMutationPlan(evolutionRecord?.mutationPlan).status !== 'OK') {
    return refused('VNEXT_MECHANISM_EXECUTION_REPLAY_INVALID', 'Execution binding inputs are invalid.');
  }
  const rebuilt = createVNextMechanismExecutionBinding({
    preparationRunId: binding.preparationRunId,
    taskPartition: binding.taskPartition,
    taskPackSha256: binding.taskPackSha256,
    preparationVerification,
    parentFamily,
    mutationObjective: evolutionRecord.mutationPlan.objective,
    reasonCodes: evolutionRecord.mutationPlan.reasonCodes,
    expectedEffectCode: evolutionRecord.mutationPlan.expectedEffectCode,
    interfaceContracts,
    behaviorMap,
    proposalRecordedAt: binding.proposalRecordedAt,
    shadowRecordedAt: binding.shadowRecordedAt
  }, { requireProduction });
  if (rebuilt.status !== 'OK'
      || canonicalVNextJson(rebuilt.binding) !== canonicalVNextJson(binding)
      || canonicalVNextJson(rebuilt.candidateFamily) !== canonicalVNextJson(candidateFamily)
      || canonicalVNextJson(rebuilt.evolutionRecord) !== canonicalVNextJson(evolutionRecord)) {
    return refused(
      'VNEXT_MECHANISM_EXECUTION_BINDING_MISMATCH',
      'The candidate preparation does not rederive the supplied executable descendant.'
    );
  }
  return {
    status: 'OK',
    binding,
    preparationVerification,
    mutationPlan: rebuilt.mutationPlan,
    candidateFamily,
    evolutionRecord,
    evidenceSha256: sha256(canonicalVNextJson({
      bindingSha256: binding.bindingSha256,
      preparationVerifierEvidenceSha256: preparationVerification.evidenceSha256,
      evolutionSha256: evolutionRecord.evolutionSha256
    }))
  };
}

export function verifyVNextMechanismExecutionBindingFromStore({
  store,
  binding,
  parentFamily,
  candidateFamily,
  evolutionRecord,
  interfaceContracts,
  behaviorMap,
  requireProduction = true
} = {}) {
  const preparationVerification = verifyVNextPreparationRun(
    store,
    binding?.preparationRunId
  );
  return verifyVNextMechanismExecutionBinding({
    binding,
    preparationVerification,
    parentFamily,
    candidateFamily,
    evolutionRecord,
    interfaceContracts,
    behaviorMap,
    requireProduction
  });
}
