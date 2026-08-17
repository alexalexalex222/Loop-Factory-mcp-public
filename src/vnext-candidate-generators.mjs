import { isSafeId, sha256 } from './util.mjs';
import { posix } from 'node:path';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact,
  validateVNextStageArtifact
} from './vnext-contracts.mjs';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from './vnext-model-contracts.mjs';
import {
  buildCandidateStrategyPrompt,
  createCandidateStrategyPlan,
  validateCandidateForStrategy,
  validateCandidateStrategyPlan
} from './vnext-candidate-strategies.mjs';

export const VNEXT_CANDIDATE_CONTRACT_SCHEMA_V1 = 'vnext-candidate-contract-v1';
export const VNEXT_CANDIDATE_CONTRACT_SCHEMA = 'vnext-candidate-contract-v2';
export const VNEXT_CANDIDATE_VERIFICATION_SCHEMA_V1 =
  'vnext-candidate-verification-v1';
export const VNEXT_CANDIDATE_VERIFICATION_SCHEMA =
  'vnext-candidate-verification-v2';
export const VNEXT_CANDIDATE_GENERATOR_FLAGS = Object.freeze({
  native: 'vnextCandidateNativeEnabled',
  'reflective-pareto': 'vnextCandidateReflectiveParetoEnabled',
  'bounded-skill': 'vnextCandidateBoundedSkillEnabled',
  'bank-recombination': 'vnextCandidateBankRecombinationEnabled',
  'code-level-experimental': 'vnextCandidateCodeLevelExperimentalEnabled'
});

const SHA256 = /^[a-f0-9]{64}$/;
const STRATEGIES = Object.freeze(Object.keys(VNEXT_CANDIDATE_GENERATOR_FLAGS));
export const MANDATORY_PROTECTED_SURFACES = Object.freeze([
  'benchmarks',
  'control',
  'evaluator',
  'promotion',
  'proof/sealed',
  'security-policy',
  'sealed-tasks',
  'sham',
  'source-hashes',
  'src/isolated-evaluator.mjs',
  'src/mechanism-evolution-admission-v2.mjs',
  'src/pace-acceptor.mjs',
  'src/run-verifier.mjs',
  'src/schemas',
  'src/vnext-evidence-bank.mjs',
  'src/vnext-model-identity.mjs',
  'statistics',
  'test/fixtures/sealed',
  'verifier'
]);
const CONTRACT_INPUT_KEYS = Object.freeze([
  'allowedComponent',
  'behaviorMap',
  'falsificationArtifact',
  'hypothesisArtifact',
  'maxOperations',
  'parentArtifact',
  'parentItemHashes',
  'protectedSurfaces',
  'retrievalArtifact',
  'selectedEvidence',
  'strategyState',
  'taskAgnostic'
]);
const LEGACY_CONTRACT_INPUT_KEYS = Object.freeze(
  CONTRACT_INPUT_KEYS.filter((key) => key !== 'strategyState')
);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function artifactRef(artifact, expectedStage) {
  const validation = validateVNextStageArtifact(artifact);
  if (validation.status !== 'OK'
      || artifact.stage !== expectedStage
      || artifact.status !== 'OK') return null;
  return {
    id: artifact.artifactId,
    schemaVersion: artifact.schemaVersion,
    sha256: artifact.artifactSha256
  };
}

function normalizeEvidence(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) return null;
  const normalized = values.map((value) => {
    if (!exactKeys(value, ['id', 'sha256'])
        || !isSafeId(value.id)
        || !SHA256.test(String(value.sha256 || ''))) return null;
    return { id: value.id, sha256: value.sha256 };
  });
  if (normalized.some((value) => value == null)) return null;
  normalized.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map((value) => value.id)).size !== normalized.length) return null;
  return normalized;
}

function canonicalMutationTarget(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
      || value.length > 500 || /[\0-\x1f\x7f]/.test(value)
      || /%(?:2e|2f|5c)/i.test(value)
      || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const slashed = value.replaceAll('\\', '/').toLowerCase();
  if (slashed.startsWith('/') || /^[a-z]:\//.test(slashed)
      || slashed.includes('//')) return null;
  const segments = slashed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const normalized = posix.normalize(slashed);
  return normalized === slashed && normalized !== '.' ? normalized : null;
}

function normalizeParentItems(values, allowedComponent) {
  if (!Array.isArray(values) || values.length > 256) return null;
  const normalized = values.map((value) => {
    const target = canonicalMutationTarget(value?.target);
    if (!exactKeys(value, ['component', 'sha256', 'target'])
        || value.component !== allowedComponent
        || target == null
        || !SHA256.test(String(value.sha256 || ''))) return null;
    return {
      target,
      component: value.component,
      sha256: value.sha256
    };
  });
  if (normalized.some((value) => value == null)) return null;
  normalized.sort((left, right) => left.target.localeCompare(right.target));
  if (new Set(normalized.map((value) => value.target)).size !== normalized.length) return null;
  return normalized;
}

function normalizeProtectedSurfaces(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) return null;
  const normalized = [...values, ...MANDATORY_PROTECTED_SURFACES]
    .map(canonicalMutationTarget);
  if (normalized.some((value) => value == null)) return null;
  return [...new Set(normalized)].sort();
}

function normalizeAllowedTargets(behaviorMap, allowedComponent, parentItems) {
  if (!plainObject(behaviorMap)
      || behaviorMap.schemaVersion !== 'vnext-harness-handbook-v1'
      || behaviorMap.authority !== 'descriptive-source-map-only'
      || behaviorMap.canAuthorizeEdits !== false
      || !SHA256.test(String(behaviorMap.behaviorMapSha256 || ''))
      || !Array.isArray(behaviorMap.behaviors)) return null;
  const mapCore = structuredClone(behaviorMap);
  delete mapCore.behaviorMapSha256;
  if (behaviorMap.behaviorMapSha256 !== sha256(canonicalVNextJson(mapCore))) return null;
  const behavior = behaviorMap.behaviors.find(({ id }) => id === allowedComponent);
  if (!plainObject(behavior) || !Array.isArray(behavior.locators)
      || behavior.locators.length < 1) return null;
  const parentByTarget = new Map(parentItems.map((item) => [item.target, item]));
  const targets = behavior.locators.map((locator) => {
    const target = canonicalMutationTarget(locator?.path);
    const locatorSha256 = String(locator?.locatorSha256 || '');
    const sourceSha256 = String(locator?.sourceSha256 || '');
    const parent = target == null ? null : parentByTarget.get(target) ?? null;
    if (target == null || !SHA256.test(locatorSha256) || !SHA256.test(sourceSha256)
        || (parent && parent.sha256 !== locatorSha256)) return null;
    return {
      target,
      component: allowedComponent,
      locatorSha256,
      sourceSha256,
      parentItemSha256: parent?.sha256 ?? null
    };
  });
  if (targets.some((target) => target == null)) return null;
  targets.sort((left, right) => left.target.localeCompare(right.target));
  return new Set(targets.map(({ target }) => target)).size === targets.length
    ? targets
    : null;
}

function candidateContractCore(strategy, input) {
  if (!STRATEGIES.includes(strategy)
      || (!exactKeys(input, CONTRACT_INPUT_KEYS)
        && !exactKeys(input, LEGACY_CONTRACT_INPUT_KEYS))
      || typeof input.allowedComponent !== 'string'
      || !input.allowedComponent.trim()
      || input.allowedComponent.length > 120
      || input.taskAgnostic !== true
      || !Number.isInteger(input.maxOperations)
      || input.maxOperations < 1
      || input.maxOperations > 3
      || !plainObject(input.behaviorMap)
      || !plainObject(input.parentArtifact)) return null;
  const hypothesisRef = artifactRef(input.hypothesisArtifact, VNEXT_STAGE.HYPOTHESIS);
  const falsificationRef = artifactRef(
    input.falsificationArtifact,
    VNEXT_STAGE.FALSIFICATION
  );
  const retrievalRef = artifactRef(input.retrievalArtifact, VNEXT_STAGE.RETRIEVAL);
  const selectedEvidence = normalizeEvidence(input.selectedEvidence);
  const parentItems = normalizeParentItems(
    input.parentItemHashes,
    input.allowedComponent
  );
  const protectedSurfaces = normalizeProtectedSurfaces(input.protectedSurfaces);
  const allowedTargets = parentItems == null
    ? null
    : normalizeAllowedTargets(
        input.behaviorMap,
        input.allowedComponent,
        parentItems
      );
  if (!hypothesisRef || !falsificationRef || !retrievalRef
      || !selectedEvidence || !parentItems || !protectedSurfaces
      || !allowedTargets) return null;
  const strategyPlan = createCandidateStrategyPlan(
    strategy,
    Object.hasOwn(input, 'strategyState') ? input.strategyState : null,
    {
      decisionTime: input.hypothesisArtifact.createdAt,
      selectedEvidence,
      allowedTargets,
      allowedComponent: input.allowedComponent,
      maximumOperations: input.maxOperations
    }
  );
  if (strategyPlan.status !== 'OK') return null;
  return {
    schemaVersion: VNEXT_CANDIDATE_CONTRACT_SCHEMA,
    strategy,
    generatorVersion: 'v1',
    featureFlag: VNEXT_CANDIDATE_GENERATOR_FLAGS[strategy],
    hypothesisRef,
    falsificationRef,
    retrievalRef,
    selectedEvidence,
    strategyPlan: strategyPlan.plan,
    strategyPlanSha256: strategyPlan.plan.planSha256,
    behaviorMapSha256: input.behaviorMap.behaviorMapSha256,
    allowedComponent: input.allowedComponent,
    allowedTargets,
    parentArtifactSha256: sha256(canonicalVNextJson(input.parentArtifact)),
    parentItems,
    maximumOperations: input.maxOperations,
    protectedSurfaces,
    taskAgnostic: true,
    activationAuthority: false
  };
}

export function createCandidateContract(strategy, input = {}) {
  const core = candidateContractCore(strategy, input);
  if (!core) {
    return refused(
      'VNEXT_CANDIDATE_CONTRACT_INVALID',
      'Candidate contracts require verified hypothesis, falsification, retrieval, evidence, one component, exact parent items, and protected surfaces.'
    );
  }
  const contract = {
    ...core,
    contractSha256: sha256(canonicalVNextJson(core))
  };
  return deepFreeze({ status: 'OK', contract });
}

export function validateCandidateContract(contract) {
  const commonKeys = [
    'activationAuthority',
    'allowedComponent',
    'allowedTargets',
    'behaviorMapSha256',
    'contractSha256',
    'falsificationRef',
    'featureFlag',
    'generatorVersion',
    'hypothesisRef',
    'maximumOperations',
    'parentArtifactSha256',
    'parentItems',
    'protectedSurfaces',
    'retrievalRef',
    'schemaVersion',
    'selectedEvidence',
    'strategy',
    'taskAgnostic'
  ];
  const v2 = contract?.schemaVersion === VNEXT_CANDIDATE_CONTRACT_SCHEMA;
  const v1 = contract?.schemaVersion === VNEXT_CANDIDATE_CONTRACT_SCHEMA_V1;
  if ((!v2 && !v1)
      || !exactKeys(contract, v2
        ? [...commonKeys, 'strategyPlan', 'strategyPlanSha256']
        : commonKeys)
      || !SHA256.test(String(contract.contractSha256 || ''))) {
    return refused('VNEXT_CANDIDATE_CONTRACT_INVALID', 'Candidate contract shape is invalid.');
  }
  const core = structuredClone(contract);
  delete core.contractSha256;
  if (sha256(canonicalVNextJson(core)) !== contract.contractSha256) {
    return refused('VNEXT_CANDIDATE_CONTRACT_TAMPERED', 'Candidate contract hash does not match its content.');
  }
  const evidence = normalizeEvidence(contract.selectedEvidence);
  const parentItems = normalizeParentItems(
    contract.parentItems,
    contract.allowedComponent
  );
  const protectedSurfaces = normalizeProtectedSurfaces(contract.protectedSurfaces);
  const parentByTarget = new Map((parentItems ?? []).map((row) => [row.target, row]));
  const strategyPlan = v2
    ? validateCandidateStrategyPlan(contract.strategyPlan)
    : { status: 'OK' };
  if (!STRATEGIES.includes(contract.strategy)
      || contract.generatorVersion !== 'v1'
      || contract.featureFlag !== VNEXT_CANDIDATE_GENERATOR_FLAGS[contract.strategy]
      || typeof contract.allowedComponent !== 'string'
      || !contract.allowedComponent.trim()
      || contract.allowedComponent.length > 120
      || !Number.isInteger(contract.maximumOperations)
      || contract.maximumOperations < 1
      || contract.maximumOperations > 3
      || evidence == null
      || parentItems == null
      || protectedSurfaces == null
      || !Array.isArray(contract.allowedTargets)
      || contract.allowedTargets.length < 1
      || contract.allowedTargets.some((row) => !exactKeys(row, [
        'target', 'component', 'locatorSha256', 'sourceSha256', 'parentItemSha256'
      ])
        || canonicalMutationTarget(row.target) !== row.target
        || row.component !== contract.allowedComponent
        || !SHA256.test(String(row.locatorSha256 || ''))
        || !SHA256.test(String(row.sourceSha256 || ''))
        || (row.parentItemSha256 != null
          && !SHA256.test(String(row.parentItemSha256 || '')))
        || (parentByTarget.get(row.target)?.sha256 ?? null) !== row.parentItemSha256
        || (row.parentItemSha256 != null
          && row.locatorSha256 !== row.parentItemSha256))
      || new Set(contract.allowedTargets.map(({ target }) => target)).size
        !== contract.allowedTargets.length
      || canonicalVNextJson(evidence) !== canonicalVNextJson(contract.selectedEvidence)
      || canonicalVNextJson(parentItems) !== canonicalVNextJson(contract.parentItems)
      || canonicalVNextJson(protectedSurfaces) !== canonicalVNextJson(contract.protectedSurfaces)
      || ![contract.hypothesisRef, contract.falsificationRef, contract.retrievalRef]
        .every((ref) => exactKeys(ref, ['id', 'schemaVersion', 'sha256'])
          && isSafeId(ref.id)
          && typeof ref.schemaVersion === 'string'
          && ref.schemaVersion.length > 0
          && SHA256.test(String(ref.sha256 || '')))
      || !SHA256.test(String(contract.behaviorMapSha256 || ''))
      || !SHA256.test(String(contract.parentArtifactSha256 || ''))
      || strategyPlan.status !== 'OK'
      || (v2 && (
        contract.strategyPlan.strategy !== contract.strategy
          || contract.strategyPlanSha256 !== contract.strategyPlan.planSha256
      ))
      || contract.taskAgnostic !== true
      || contract.activationAuthority !== false) {
    return refused('VNEXT_CANDIDATE_CONTRACT_INVALID', 'Candidate contract semantics are invalid.');
  }
  return { status: 'OK', contract: structuredClone(contract) };
}

export function verifyCandidateContractScope(contract, {
  behaviorMap,
  parentItemHashes
} = {}) {
  const valid = validateCandidateContract(contract);
  const parentItems = normalizeParentItems(
    parentItemHashes,
    contract?.allowedComponent
  );
  const allowedTargets = parentItems == null
    ? null
    : normalizeAllowedTargets(
        behaviorMap,
        contract.allowedComponent,
        parentItems
      );
  if (valid.status !== 'OK' || !parentItems || !allowedTargets
      || contract.behaviorMapSha256 !== behaviorMap.behaviorMapSha256
      || canonicalVNextJson(contract.parentItems) !== canonicalVNextJson(parentItems)
      || canonicalVNextJson(contract.allowedTargets) !== canonicalVNextJson(allowedTargets)) {
    return refused(
      'VNEXT_CANDIDATE_SCOPE_REPLAY_INVALID',
      'Candidate scope does not replay to the exact behavior-map locators and parent items.'
    );
  }
  return { status: 'OK', contract: structuredClone(contract) };
}

function parseCandidate(output) {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function normalizeCandidateOutput(strategy, output, contract) {
  const contractValidation = validateCandidateContract(contract);
  const parsed = parseCandidate(output);
  const modelValidation = validateVNextModelOutput(
    parsed,
    VNEXT_MODEL_SCHEMA.CANDIDATE
  );
  if (contractValidation.status !== 'OK'
      || modelValidation.status !== 'OK'
      || modelValidation.output.strategy !== strategy
      || contract.strategy !== strategy) {
    return refused('VNEXT_CANDIDATE_OUTPUT_INVALID', 'Candidate output is not valid for this generator contract.');
  }
  return { status: 'OK', candidate: modelValidation.output };
}

function protectedTouch(target, protectedSurfaces) {
  const normalized = canonicalMutationTarget(target);
  if (normalized == null) return true;
  return protectedSurfaces.some((surface) => (
    normalized === surface
    || normalized.startsWith(`${surface}/`)
    || surface.startsWith(`${normalized}/`)
  ));
}

function verificationCore(candidate, contract) {
  if (candidate.component !== contract.allowedComponent
      || candidate.taskAgnostic !== true
      || candidate.operations.length > contract.maximumOperations
      || candidate.operations.length > 3
      || candidate.operations.length < 1
      || candidate.protectedSurfaceTouches.length !== 0
      || !candidate.prediction.trim()
      || !candidate.falsifier.trim()
      || !candidate.rollback.trim()) return null;
  const evidenceIds = new Set(contract.selectedEvidence.map((item) => item.id));
  if (candidate.evidenceIds.length < 1
      || candidate.evidenceIds.some((id) => !evidenceIds.has(id))) return null;
  const parentItems = new Map(contract.parentItems.map((item) => (
    [item.target, item.sha256]
  )));
  const allowedTargets = new Map(contract.allowedTargets.map((item) => (
    [item.target, item]
  )));
  const touchedTargets = new Set();
  for (const operation of candidate.operations) {
    const target = canonicalMutationTarget(operation.target);
    const allowed = target == null ? null : allowedTargets.get(target);
    if (target == null || touchedTargets.has(target)
        || !allowed
        || protectedTouch(operation.target, contract.protectedSurfaces)) return null;
    touchedTargets.add(target);
    const before = parentItems.get(target);
    if (contract.strategy === 'code-level-experimental') {
      if (!['delete', 'replace'].includes(operation.op)
          || operation.beforeSha256 !== allowed.sourceSha256) return null;
      continue;
    }
    if ((before ?? null) !== allowed.parentItemSha256) return null;
    if (['add', 'emit'].includes(operation.op)) {
      if (before != null || operation.beforeSha256 !== null) return null;
    } else if (before == null || operation.beforeSha256 !== before) return null;
  }
  const v2 = contract.schemaVersion === VNEXT_CANDIDATE_CONTRACT_SCHEMA;
  return {
    schemaVersion: v2
      ? VNEXT_CANDIDATE_VERIFICATION_SCHEMA
      : VNEXT_CANDIDATE_VERIFICATION_SCHEMA_V1,
    contractSha256: contract.contractSha256,
    candidateSha256: sha256(canonicalVNextJson(candidate)),
    hypothesisSha256: contract.hypothesisRef.sha256,
    falsificationSha256: contract.falsificationRef.sha256,
    retrievalSha256: contract.retrievalRef.sha256,
    parentArtifactSha256: contract.parentArtifactSha256,
    parentItemHashesSha256: sha256(canonicalVNextJson(contract.parentItems)),
    allowedTargetsSha256: sha256(canonicalVNextJson(contract.allowedTargets)),
    evidenceSha256: sha256(canonicalVNextJson(contract.selectedEvidence)),
    ...(v2 ? { strategyPlanSha256: contract.strategyPlanSha256 } : {}),
    oneComponent: true,
    taskAgnostic: true,
    boundedOperations: true,
    protectedSurfaceTouches: [],
    activationAuthority: false
  };
}

export function verifyCandidateAgainstContract(candidate, contract) {
  const normalized = normalizeCandidateOutput(contract?.strategy, candidate, contract);
  if (normalized.status !== 'OK') return normalized;
  if (contract.schemaVersion === VNEXT_CANDIDATE_CONTRACT_SCHEMA) {
    const strategy = validateCandidateForStrategy(
      normalized.candidate,
      contract.strategyPlan
    );
    if (strategy.status !== 'OK') return strategy;
  }
  const core = verificationCore(normalized.candidate, contract);
  if (!core) {
    return refused(
      'VNEXT_CANDIDATE_CONTRACT_VIOLATION',
      'Candidate escaped evidence, parent hash, component, operation, task-agnostic, or protected-surface bounds.'
    );
  }
  return deepFreeze({
    status: 'OK',
    candidate: normalized.candidate,
    verification: {
      ...core,
      verificationSha256: sha256(canonicalVNextJson(core))
    }
  });
}

export function validateCandidateVerification(verification, {
  candidate = null,
  contract = null
} = {}) {
  const commonKeys = [
    'activationAuthority',
    'allowedTargetsSha256',
    'boundedOperations',
    'candidateSha256',
    'contractSha256',
    'evidenceSha256',
    'falsificationSha256',
    'hypothesisSha256',
    'oneComponent',
    'parentArtifactSha256',
    'parentItemHashesSha256',
    'protectedSurfaceTouches',
    'retrievalSha256',
    'schemaVersion',
    'taskAgnostic',
    'verificationSha256'
  ];
  const v2 = verification?.schemaVersion === VNEXT_CANDIDATE_VERIFICATION_SCHEMA;
  const v1 = verification?.schemaVersion === VNEXT_CANDIDATE_VERIFICATION_SCHEMA_V1;
  if ((!v2 && !v1)
      || !exactKeys(verification, v2
        ? [...commonKeys, 'strategyPlanSha256']
        : commonKeys)
      || verification.activationAuthority !== false
      || verification.oneComponent !== true
      || verification.taskAgnostic !== true
      || verification.boundedOperations !== true
      || !Array.isArray(verification.protectedSurfaceTouches)
      || verification.protectedSurfaceTouches.length !== 0
      || !SHA256.test(String(verification.verificationSha256 || ''))) {
    return refused('VNEXT_CANDIDATE_VERIFICATION_INVALID', 'Candidate verification receipt is invalid.');
  }
  const core = structuredClone(verification);
  delete core.verificationSha256;
  if (sha256(canonicalVNextJson(core)) !== verification.verificationSha256) {
    return refused('VNEXT_CANDIDATE_VERIFICATION_TAMPERED', 'Candidate verification receipt hash does not match its content.');
  }
  if (candidate != null
      && verification.candidateSha256 !== sha256(canonicalVNextJson(candidate))) {
    return refused('VNEXT_CANDIDATE_VERIFICATION_BINDING_MISMATCH', 'Candidate bytes do not match the verification receipt.');
  }
  if (contract != null) {
    const contractValidation = validateCandidateContract(contract);
    if (contractValidation.status !== 'OK'
        || verification.contractSha256 !== contract.contractSha256
        || verification.hypothesisSha256 !== contract.hypothesisRef.sha256
        || verification.falsificationSha256 !== contract.falsificationRef.sha256
        || verification.retrievalSha256 !== contract.retrievalRef.sha256
        || verification.parentArtifactSha256 !== contract.parentArtifactSha256
        || verification.parentItemHashesSha256
          !== sha256(canonicalVNextJson(contract.parentItems))
        || verification.allowedTargetsSha256
          !== sha256(canonicalVNextJson(contract.allowedTargets))
        || verification.evidenceSha256
          !== sha256(canonicalVNextJson(contract.selectedEvidence))
        || (contract.schemaVersion === VNEXT_CANDIDATE_CONTRACT_SCHEMA
          && (!v2
            || verification.strategyPlanSha256 !== contract.strategyPlanSha256))) {
      return refused('VNEXT_CANDIDATE_VERIFICATION_BINDING_MISMATCH', 'Candidate contract evidence does not match the verification receipt.');
    }
  }
  return { status: 'OK', verification: structuredClone(verification) };
}

export function buildCandidateGeneratorPrompt(contract) {
  if (validateCandidateContract(contract).status !== 'OK') return null;
  if (contract.schemaVersion === VNEXT_CANDIDATE_CONTRACT_SCHEMA) {
    return buildCandidateStrategyPrompt(contract.strategyPlan, contract);
  }
  return [
    `Generate one ${contract.strategy} candidate under the frozen contract.`,
    'Return strict JSON matching vnext-candidate-output-v1.',
    'Target exactly one allowed component, keep the edit task-agnostic, cite only selected evidence, and stay within the operation limit.',
    'Declare a measurable prediction, falsifier, and exact rollback. Never touch a protected surface.',
    'You have no execution, scoring, admission, activation, or deployment authority.',
    '',
    canonicalVNextJson(contract)
  ].join('\n');
}

export function buildCandidateStageArtifact({
  candidate,
  verification,
  contract,
  createdAt,
  authority
} = {}) {
  if (validateCandidateContract(contract).status !== 'OK'
      || validateCandidateVerification(verification, { candidate, contract }).status !== 'OK'
      || typeof createdAt !== 'string'
      || !Number.isFinite(Date.parse(createdAt))) {
    return refused('VNEXT_CANDIDATE_ARTIFACT_INVALID', 'Candidate stage requires a replayable contract and verification receipt.');
  }
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.CANDIDATE,
    status: 'OK',
    createdAt,
    authority: authority ?? {
      actorId: `vnext-candidate-${contract.strategy}`,
      kind: 'fresh-context-worker',
      model: null,
      promptSha256: sha256(buildCandidateGeneratorPrompt(contract)),
      toolPolicy: 'none'
    },
    inputRefs: [
      { id: contract.hypothesisRef.id, schemaVersion: contract.hypothesisRef.schemaVersion, sha256: contract.hypothesisRef.sha256 },
      { id: contract.falsificationRef.id, schemaVersion: contract.falsificationRef.schemaVersion, sha256: contract.falsificationRef.sha256 },
      { id: contract.retrievalRef.id, schemaVersion: contract.retrievalRef.schemaVersion, sha256: contract.retrievalRef.sha256 }
    ],
    permittedInformation: ['frozen hypothesis', 'independent falsification', 'eligible retrieval', 'source-bound behavior map', 'bounded parent artifact'],
    forbiddenInformation: ['activation authority', 'evaluator state', 'final sealed tasks', 'hidden tests', 'promotion authority', 'statistical gate'],
    provenance: contract.selectedEvidence.map((row) => ({
      id: row.id,
      kind: 'selected-evidence',
      observedAt: createdAt,
      sha256: row.sha256,
      uri: null
    })),
    replay: { module: 'src/vnext-candidate-generators.mjs', exportName: 'buildCandidateStageArtifact', version: 'v1' },
    failure: null,
    payload: {
      strategy: contract.strategy,
      contractSha256: contract.contractSha256,
      strategyPlanSha256: contract.strategyPlanSha256 ?? null,
      candidate,
      verification,
      executionAuthority: false,
      activationAuthority: false
    }
  });
  return artifact.status === 'OK' ? { status: 'OK', artifact: artifact.artifact } : artifact;
}

function plugin(strategy) {
  const plannerId = {
    native: 'native-evidence-edit-v1',
    'reflective-pareto': 'reflective-pareto-v1',
    'bounded-skill': 'bounded-skill-v1',
    'bank-recombination': 'bank-recombination-v1',
    'code-level-experimental': 'guarded-code-level-v1'
  }[strategy];
  return deepFreeze({
    id: strategy,
    version: 'v1',
    plannerId,
    featureFlag: VNEXT_CANDIDATE_GENERATOR_FLAGS[strategy],
    createContract(input) {
      return createCandidateContract(strategy, input);
    },
    normalizeOutput(output, contract) {
      return normalizeCandidateOutput(strategy, output, contract);
    },
    buildPrompt(contract) {
      return buildCandidateGeneratorPrompt(contract);
    },
    verifyCandidate(candidate, contract) {
      return verifyCandidateAgainstContract(candidate, contract);
    }
  });
}

const PLUGINS = Object.freeze(Object.fromEntries(STRATEGIES.map((strategy) => (
  [strategy, plugin(strategy)]
))));

export function createCandidateGeneratorRegistry(featureFlags = {}) {
  const enabled = Object.fromEntries(STRATEGIES.map((strategy) => [
    strategy,
    strategy === 'native'
      ? featureFlags[VNEXT_CANDIDATE_GENERATOR_FLAGS[strategy]] !== false
      : featureFlags[VNEXT_CANDIDATE_GENERATOR_FLAGS[strategy]] === true
  ]));
  return deepFreeze({
    schemaVersion: 'vnext-candidate-generator-registry-v1',
    plugins: PLUGINS,
    enabled,
    codeLevelExperimentalDefault: false
  });
}

export function getCandidateGenerator(registry, strategy) {
  if (!plainObject(registry)
      || registry.schemaVersion !== 'vnext-candidate-generator-registry-v1'
      || !STRATEGIES.includes(strategy)
      || registry.enabled?.[strategy] !== true) {
    return refused('VNEXT_CANDIDATE_STRATEGY_DISABLED', `Candidate strategy ${strategy} is disabled.`);
  }
  return { status: 'OK', plugin: registry.plugins[strategy] };
}

export function generateVNextCandidate({ registry, strategy, input, output } = {}) {
  const selected = getCandidateGenerator(registry, strategy);
  if (selected.status !== 'OK') return selected;
  const built = selected.plugin.createContract(input);
  if (built.status !== 'OK') return built;
  const normalized = selected.plugin.normalizeOutput(output, built.contract);
  if (normalized.status !== 'OK') return normalized;
  return selected.plugin.verifyCandidate(normalized.candidate, built.contract);
}

export const VNEXT_CANDIDATE_GENERATOR_REGISTRY =
  createCandidateGeneratorRegistry();
