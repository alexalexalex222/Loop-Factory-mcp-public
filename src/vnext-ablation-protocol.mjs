import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateAdaptiveRecord } from './adaptive-records.mjs';
import {
  validateEvaluatorSecurityQualification,
  validateEvaluatorWorkerFailure
} from './isolated-evaluator.mjs';
import { isSafeId, sha256 } from './util.mjs';
import {
  createVNextAblationProfile,
  vnextAblationPreparationMaximumCalls
} from './vnext-ablation-profile.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  resolveVNextEvaluatorProofImplementation,
  validateVNextEvaluatorProofPlan,
  validateVNextEvaluatorProofPlanForReplay,
  verifyVNextEvaluatorProofPlanImplementation,
  verifyVNextEvaluatorProofFromDisk
} from './vnext-evaluator-proof.mjs';
import {
  verifyVNextTaskPackImport
} from './vnext-task-pack-import.mjs';
import {
  validateVNextTaskPack,
  vnextTaskPackIdentities
} from './vnext-task-pack.mjs';
import { resolveVNextWaveImplementation } from './vnext-wave-runner.mjs';

export const VNEXT_ABLATION_PROTOCOL_SCHEMA =
  'loop-factory-vnext-ablation-protocol-v2';
export const VNEXT_ABLATION_PROTOCOL_R6_SCHEMA =
  'loop-factory-vnext-ablation-protocol-v3';
export const VNEXT_ABLATION_EVALUATOR_BINDING_SCHEMA =
  'loop-factory-vnext-evaluator-proof-binding-v1';
export const VNEXT_SEMANTIC_JUDGE_QUALIFICATION_BINDING_SCHEMA =
  'loop-factory-vnext-semantic-judge-qualification-binding-v1';
export const VNEXT_CONSUMED_EVALUATOR_PROOF_SCHEMA =
  'loop-factory-vnext-consumed-evaluator-proof-v1';

const INTERNAL_PHASES = Object.freeze([
  {
    phaseId: 'P0-component-construction',
    packRole: 'generation',
    mode: 'candidate-generation-and-four-arm-evaluation',
    arms: ['B0', 'B2', 'B3'],
    memoryPolicy: 'none',
    plansShareMemorySnapshot: true,
    continuationGate: 'all-planned-arms-experiment-valid'
  },
  {
    phaseId: 'P1-retrieval-attribution',
    packRole: 'retrieval',
    mode: 'candidate-generation-and-four-arm-evaluation',
    arms: ['B3', 'B4'],
    memoryPolicy: 'verifier-bank-snapshot-after-P0',
    plansShareMemorySnapshot: true,
    continuationGate: 'B3-and-B4-experiment-valid'
  },
  {
    phaseId: 'P2-generator-comparison',
    packRole: 'generator',
    mode: 'candidate-generation-and-four-arm-evaluation',
    arms: ['B5a', 'B5b', 'B5c'],
    memoryPolicy: 'verifier-bank-snapshot-after-P1',
    plansShareMemorySnapshot: true,
    continuationGate: 'at-least-one-generator-ready-and-experiment-valid'
  },
  {
    phaseId: 'P3-untouched-validation',
    packRole: 'validation',
    mode: 'one-selected-B6-candidate-generation-and-four-arm-evaluation',
    arms: ['B6'],
    memoryPolicy: 'verifier-bank-snapshot-after-P2',
    plansShareMemorySnapshot: true,
    continuationGate: 'selected-B6-causal-pass-with-zero-sham-and-control-regressions'
  },
  {
    phaseId: 'P4-disjoint-transfer',
    packRole: 'transfer',
    mode: 'frozen-candidate-four-arm-evaluation',
    arms: ['B6-frozen'],
    memoryPolicy: 'no-retrieval-or-regeneration',
    plansShareMemorySnapshot: true,
    continuationGate: 'exact-validation-candidate-causal-pass-on-transfer'
  }
]);

const PACK_ROLES = Object.freeze([
  'generation', 'retrieval', 'generator', 'validation', 'transfer'
]);
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTITY_LEDGER_SCHEMA = 'vnext-internal-identity-digest-ledger-v1';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildIdentityLedger(identities) {
  const digests = [...new Set(identities.map((identity) => sha256(identity)))].sort();
  const core = {
    schemaVersion: IDENTITY_LEDGER_SCHEMA,
    algorithm: 'sha256',
    identityCount: digests.length,
    identityDigests: digests
  };
  return {
    ...core,
    ledgerSha256: sha256(canonicalVNextJson(core))
  };
}

function validIdentityLedger(ledger) {
  if (!exactKeys(ledger, [
    'schemaVersion', 'algorithm', 'identityCount', 'identityDigests',
    'ledgerSha256'
  ]) || ledger.schemaVersion !== IDENTITY_LEDGER_SCHEMA
      || ledger.algorithm !== 'sha256'
      || !Number.isSafeInteger(ledger.identityCount)
      || ledger.identityCount < 1
      || !Array.isArray(ledger.identityDigests)
      || ledger.identityDigests.length !== ledger.identityCount
      || ledger.identityDigests.some((digest) => !SHA256.test(digest))
      || new Set(ledger.identityDigests).size !== ledger.identityDigests.length
      || canonicalVNextJson(ledger.identityDigests)
        !== canonicalVNextJson([...ledger.identityDigests].sort())) return false;
  const core = structuredClone(ledger);
  delete core.ledgerSha256;
  return ledger.ledgerSha256 === sha256(canonicalVNextJson(core));
}

export function vnextAblationInternalIdentityDigests(protocol) {
  return validateVNextAblationProtocol(protocol).status === 'OK'
    ? [...protocol.identityLedger.identityDigests]
    : null;
}

export function loadVNextAblationPackDescriptor({ role, directory } = {}) {
  if (!PACK_ROLES.includes(role) || !isAbsolute(String(directory || ''))) {
    return refused('VNEXT_ABLATION_PACK_INPUT_INVALID', 'A declared role and absolute imported-pack directory are required.');
  }
  try {
    const root = realpathSync(resolve(directory));
    if (lstatSync(root).isSymbolicLink()) throw new Error('pack directory is a symlink');
    const files = {
      sourceConfig: join(root, 'source-config.json'),
      taskPack: join(root, 'task-pack.json'),
      materials: join(root, 'materials.json'),
      receipt: join(root, 'import-receipt.json')
    };
    if (Object.values(files).some((path) => !existsSync(path)
        || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) {
      throw new Error('pack artifacts are missing or unsafe');
    }
    const sourceConfigBytes = readFileSync(files.sourceConfig, 'utf8');
    const taskPack = readJson(files.taskPack);
    const bundle = readJson(files.materials);
    const receipt = readJson(files.receipt);
    const verified = verifyVNextTaskPackImport({
      sourceConfigBytes,
      pack: taskPack,
      bundle,
      receipt
    });
    if (verified.status !== 'OK') return verified;
    const descriptor = {
      role,
      directory: root,
      packId: taskPack.packId,
      partition: taskPack.partition,
      packSha256: taskPack.packSha256,
      taskIdentitySetSha256: taskPack.taskIdentitySetSha256,
      materialBundleSha256: bundle.bundleSha256,
      importReceiptSha256: receipt.receiptSha256,
      sourceConfigSha256: receipt.sourceConfigSha256,
      taskCount: taskPack.tasks.length,
      referenceContentImported: false
    };
    return {
      status: 'OK',
      descriptor,
      taskPack,
      bundle,
      identities: vnextTaskPackIdentities(taskPack)
    };
  } catch (error) {
    return refused('VNEXT_ABLATION_PACK_LOAD_FAILED', error.message);
  }
}

function phaseMaximumCalls(phase) {
  return phase.arms.reduce((sum, armId) => {
    if (armId === 'B6-frozen') return sum + 120;
    if (armId === 'B6') return sum + 127;
    const profile = createVNextAblationProfile({ armId });
    return profile.status === 'OK'
      ? sum + 120 + vnextAblationPreparationMaximumCalls(profile.profile)
      : Number.NaN;
  }, 0);
}

function protocolSelectionRule() {
  return {
    developmentAuthority: 'selection-only-no-generalized-claim',
    eligibleGeneratorArms: ['B5a', 'B5b', 'B5c'],
    requiredBeforeSelection: [
      'experimentValid', 'causalPass', 'zero-control-regressions',
      'zero-sham-movement', 'trusted-token-usage'
    ],
    order: [
      'highest-confirmation-adjusted-mean',
      'lowest-total-token-usage',
      'lexicographically-smallest-arm-id'
    ],
    abstainWhenNoEligibleArm: true,
    selectedCandidateCount: 1
  };
}

function protocolInferencePolicy() {
  return {
    developmentResultsAreNotFinalClaims: true,
    finalValidationCandidateCount: 1,
    validationAlpha: 0.05,
    transferRequiresExactFrozenCandidate: true,
    transferMayRegenerateCandidate: false,
    generalizedClaimRequiresValidationAndTransfer: true,
    finalCustodianConfirmationStillRequired: true,
    taskClusterIsStatisticalUnit: true,
    noRepeatedFinalOpening: true
  };
}

function protocolAuthority() {
  return {
    implementationAgentMayAccessInternalPacks: true,
    implementationAgentMayAccessFinalCustodianPack: false,
    activationAuthority: false,
    promotionAuthorized: false
  };
}

function protocolPhases(packs) {
  const byRole = new Map(packs.map((pack) => [pack.role, pack]));
  return INTERNAL_PHASES.map((phase) => ({
    ...phase,
    packSha256: byRole.get(phase.packRole)?.packSha256,
    taskIdentitySetSha256: byRole.get(phase.packRole)?.taskIdentitySetSha256,
    maximumCalls: phaseMaximumCalls(phase),
    promotionEnabled: false
  }));
}

function protocolExposure(phases, evaluatorCalls) {
  return {
    liveEvaluatorCalls: evaluatorCalls,
    internalMaximumCalls: phases.reduce((sum, phase) => (
      sum + phase.maximumCalls
    ), evaluatorCalls),
    externalCustodianMaximumCalls: 120,
    retriesPerCall: 0,
    hardUsdCeiling: 0,
    billingMode: 'subscription-no-metered-usd',
    stagedApprovalRequired: true
  };
}

function protocolR6Exposure(phases, qualification, consumedEvaluatorCalls) {
  return {
    liveEvaluatorCalls: 0,
    semanticJudgeSecurityQualificationMaximumCalls:
      qualification.maximumCalls,
    historicalConsumedEvaluatorCalls: consumedEvaluatorCalls,
    internalMaximumCalls: phases.reduce((sum, phase) => (
      sum + phase.maximumCalls
    ), 0),
    externalCustodianMaximumCalls: 120,
    retriesPerCall: 0,
    hardUsdCeiling: 0,
    billingMode: 'subscription-no-metered-usd',
    stagedApprovalRequired: true
  };
}

function validEvaluatorProofBinding(binding) {
  return exactKeys(binding, [
    'schemaVersion', 'proofHome', 'proofId', 'planSha256', 'resultSha256',
    'evidenceSha256', 'implementationSha256', 'productionEvidence',
    'activationAuthority'
  ])
    && binding.schemaVersion === VNEXT_ABLATION_EVALUATOR_BINDING_SCHEMA
    && isAbsolute(String(binding.proofHome || ''))
    && isSafeId(binding.proofId)
    && SHA256.test(String(binding.planSha256 || ''))
    && SHA256.test(String(binding.resultSha256 || ''))
    && SHA256.test(String(binding.evidenceSha256 || ''))
    && SHA256.test(String(binding.implementationSha256 || ''))
    && binding.productionEvidence === true
    && binding.activationAuthority === false;
}

function validConsumedEvaluatorProof(record) {
  return exactKeys(record, [
    'schemaVersion', 'proofHome', 'proofId', 'planSha256', 'planFileSha256',
    'launchSha256', 'launchFileSha256', 'failureEvidencePath',
    'failureEvidenceSha256', 'status', 'maximumCalls', 'retriesAuthorized'
  ])
    && record.schemaVersion === VNEXT_CONSUMED_EVALUATOR_PROOF_SCHEMA
    && isAbsolute(String(record.proofHome || ''))
    && isSafeId(record.proofId)
    && SHA256.test(String(record.planSha256 || ''))
    && SHA256.test(String(record.planFileSha256 || ''))
    && SHA256.test(String(record.launchSha256 || ''))
    && SHA256.test(String(record.launchFileSha256 || ''))
    && typeof record.failureEvidencePath === 'string'
    && record.failureEvidencePath.length > 0
    && !isAbsolute(record.failureEvidencePath)
    && SHA256.test(String(record.failureEvidenceSha256 || ''))
    && record.status === 'CONSUMED_FAILURE_NO_RETRY'
    && record.maximumCalls === 1
    && record.retriesAuthorized === false;
}

export function replayConsumedEvaluatorProof(record) {
  if (!validConsumedEvaluatorProof(record)) {
    return refused(
      'VNEXT_CONSUMED_EVALUATOR_PROOF_INVALID',
      'Consumed evaluator evidence is malformed.'
    );
  }
  try {
    const home = realpathSync(resolve(record.proofHome));
    const directory = realpathSync(resolve(home, record.proofId));
    const planPath = resolve(directory, 'plan.json');
    const launchPath = resolve(directory, 'launch.json');
    const failurePath = resolve(directory, record.failureEvidencePath);
    if (!within(home, directory) || !within(directory, failurePath)
        || existsSync(resolve(directory, 'result.json'))
        || [planPath, launchPath, failurePath].some((path) => (
          !existsSync(path) || lstatSync(path).isSymbolicLink()
        ))) {
      throw new Error('consumed evaluator paths are missing, unsafe, or contain a result');
    }
    const planText = readFileSync(planPath, 'utf8');
    const launchText = readFileSync(launchPath, 'utf8');
    const failureText = readFileSync(failurePath, 'utf8');
    const plan = JSON.parse(planText);
    const launch = JSON.parse(launchText);
    const failure = JSON.parse(failureText);
    const launchCore = structuredClone(launch);
    delete launchCore.launchSha256;
    if (validateVNextEvaluatorProofPlanForReplay(plan).status !== 'OK'
        || plan.proofHome !== home
        || plan.proofId !== record.proofId
        || plan.planSha256 !== record.planSha256
        || sha256(planText) !== record.planFileSha256
        || !exactKeys(launch, [
          'schemaVersion', 'proofId', 'planSha256', 'startedAt',
          'executionAuthority', 'maximumCalls', 'retriesAuthorized',
          'launchSha256'
        ])
        || launch.schemaVersion
          !== 'loop-factory-vnext-evaluator-proof-launch-v1'
        || launch.proofId !== record.proofId
        || launch.planSha256 !== record.planSha256
        || launch.launchSha256 !== record.launchSha256
        || launch.launchSha256 !== sha256(canonicalVNextJson(launchCore))
        || launch.maximumCalls !== 1
        || launch.retriesAuthorized !== false
        || sha256(launchText) !== record.launchFileSha256
        || sha256(failureText) !== record.failureEvidenceSha256
        || validateEvaluatorWorkerFailure(failure).status !== 'OK'
        || failure.executorInvocation?.exitCode === 0) {
      throw new Error('consumed evaluator evidence failed hash or semantic replay');
    }
    return { status: 'OK', record };
  } catch (error) {
    return refused(
      'VNEXT_CONSUMED_EVALUATOR_PROOF_REPLAY_FAILED',
      error.message
    );
  }
}

export function createVNextAblationEvaluatorProofBinding(verification = {}) {
  const binding = {
    schemaVersion: VNEXT_ABLATION_EVALUATOR_BINDING_SCHEMA,
    proofHome: verification.plan?.proofHome,
    proofId: verification.plan?.proofId,
    planSha256: verification.plan?.planSha256,
    resultSha256: verification.result?.resultSha256,
    evidenceSha256: verification.evidenceSha256,
    implementationSha256: verification.plan?.implementationSha256,
    productionEvidence: verification.result?.productionEvidence,
    activationAuthority: verification.result?.activationAuthority
  };
  return verification.status === 'OK' && validEvaluatorProofBinding(binding)
    ? { status: 'OK', binding }
    : refused(
        'VNEXT_ABLATION_EVALUATOR_PROOF_INVALID',
        'Protocol requires a successfully replayed production evaluator result.'
      );
}

function validSemanticJudgeQualificationBinding(binding) {
  if (!exactKeys(binding, [
    'schemaVersion', 'role', 'status', 'qualification', 'forms',
    'maximumCalls', 'paidCallsCompleted', 'retriesPerCall',
    'causalScoringAuthority', 'requiredForDeterministicPhases',
    'requiredBeforeSemanticJudging', 'bindingSha256'
  ])
      || binding.schemaVersion
        !== VNEXT_SEMANTIC_JUDGE_QUALIFICATION_BINDING_SCHEMA
      || binding.role !== 'semantic-judge-security-qualification'
      || binding.status !== 'PLANNED_UNLAUNCHED'
      || validateEvaluatorSecurityQualification(binding.qualification).status !== 'OK'
      || !Array.isArray(binding.forms)
      || binding.forms.length !== 2
      || binding.forms.some((form, index) => (
        !exactKeys(form, [
          'formId', 'proofHome', 'proofId', 'planSha256', 'requestSha256',
          'implementationSha256'
        ])
        || form.formId !== `form-${index + 1}`
        || !isAbsolute(String(form.proofHome || ''))
        || !isSafeId(form.proofId)
        || ![
          form.planSha256,
          form.requestSha256,
          form.implementationSha256
        ].every((value) => SHA256.test(String(value || '')))
        || form.requestSha256
          !== binding.qualification.forms[index].request.requestSha256
      ))
      || new Set(binding.forms.map(({ proofId }) => proofId)).size !== 2
      || new Set(binding.forms.map(({ implementationSha256 }) => (
        implementationSha256
      ))).size !== 1
      || binding.maximumCalls !== 2
      || binding.paidCallsCompleted !== 0
      || binding.retriesPerCall !== 0
      || binding.causalScoringAuthority !== false
      || binding.requiredForDeterministicPhases !== false
      || binding.requiredBeforeSemanticJudging !== true
      || !SHA256.test(String(binding.bindingSha256 || ''))) return false;
  const core = structuredClone(binding);
  delete core.bindingSha256;
  return binding.bindingSha256 === sha256(canonicalVNextJson(core));
}

export function createVNextSemanticJudgeQualificationBinding({
  qualification,
  formPlans,
  packageRoot
} = {}) {
  if (validateEvaluatorSecurityQualification(qualification).status !== 'OK'
      || !Array.isArray(formPlans)
      || formPlans.length !== 2) {
    return refused(
      'VNEXT_SEMANTIC_JUDGE_QUALIFICATION_INPUT_INVALID',
      'Qualification binding requires two counterbalanced evaluator plans.'
    );
  }
  const forms = [];
  for (let index = 0; index < formPlans.length; index += 1) {
    const plan = formPlans[index];
    const valid = validateVNextEvaluatorProofPlan(plan);
    const implementation = valid.status === 'OK'
      ? verifyVNextEvaluatorProofPlanImplementation({ plan, packageRoot })
      : valid;
    const publicForm = qualification.forms[index];
    if (implementation.status !== 'OK'
        || canonicalVNextJson(plan.request)
          !== canonicalVNextJson(publicForm.request)
        || canonicalVNextJson(plan.pairwiseReceipt)
          !== canonicalVNextJson(publicForm.pairwiseReceipt)
        || plan.exposure.maximumCalls !== 1
        || plan.exposure.retries !== 0
        || plan.approval.workerLaunchedAtPlanning !== false
        || plan.approval.paidModelCallsAtPlanning !== 0) {
      return refused(
        'VNEXT_SEMANTIC_JUDGE_FORM_PLAN_INVALID',
        'A semantic-judge form plan drifted from its public counterbalanced request.'
      );
    }
    forms.push({
      formId: publicForm.formId,
      proofHome: plan.proofHome,
      proofId: plan.proofId,
      planSha256: plan.planSha256,
      requestSha256: plan.request.requestSha256,
      implementationSha256: plan.implementationSha256
    });
  }
  const core = {
    schemaVersion: VNEXT_SEMANTIC_JUDGE_QUALIFICATION_BINDING_SCHEMA,
    role: 'semantic-judge-security-qualification',
    status: 'PLANNED_UNLAUNCHED',
    qualification,
    forms,
    maximumCalls: 2,
    paidCallsCompleted: 0,
    retriesPerCall: 0,
    causalScoringAuthority: false,
    requiredForDeterministicPhases: false,
    requiredBeforeSemanticJudging: true
  };
  const binding = {
    ...core,
    bindingSha256: sha256(canonicalVNextJson(core))
  };
  return validSemanticJudgeQualificationBinding(binding)
    ? { status: 'OK', binding }
    : refused(
        'VNEXT_SEMANTIC_JUDGE_QUALIFICATION_INVALID',
        'Constructed semantic-judge qualification binding failed replay.'
      );
}

export function verifyVNextSemanticJudgeQualificationBinding({
  binding,
  packageRoot
} = {}) {
  if (!validSemanticJudgeQualificationBinding(binding)) {
    return refused(
      'VNEXT_SEMANTIC_JUDGE_QUALIFICATION_INVALID',
      'Semantic-judge qualification binding is malformed.'
    );
  }
  try {
    for (let index = 0; index < binding.forms.length; index += 1) {
      const form = binding.forms[index];
      const home = realpathSync(resolve(form.proofHome));
      const directory = realpathSync(resolve(home, form.proofId));
      const planPath = resolve(directory, 'plan.json');
      if (!within(home, directory)
          || !within(directory, planPath)
          || !existsSync(planPath)
          || lstatSync(planPath).isSymbolicLink()) {
        throw new Error('semantic-judge plan path is missing or unsafe');
      }
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      const implementation = verifyVNextEvaluatorProofPlanImplementation({
        plan,
        packageRoot
      });
      const publicForm = binding.qualification.forms[index];
      if (implementation.status !== 'OK'
          || plan.proofHome !== home
          || plan.proofId !== form.proofId
          || plan.planSha256 !== form.planSha256
          || plan.request.requestSha256 !== form.requestSha256
          || plan.implementationSha256 !== form.implementationSha256
          || canonicalVNextJson(plan.request)
            !== canonicalVNextJson(publicForm.request)
          || canonicalVNextJson(plan.pairwiseReceipt)
            !== canonicalVNextJson(publicForm.pairwiseReceipt)) {
        throw new Error('semantic-judge plan failed binding or implementation replay');
      }
    }
    return { status: 'OK', binding };
  } catch (error) {
    return refused(
      'VNEXT_SEMANTIC_JUDGE_QUALIFICATION_REPLAY_FAILED',
      error.message
    );
  }
}

function prepareProtocolPacks(packs) {
  if (packs.length !== PACK_ROLES.length
      || new Set(packs.map((pack) => pack.descriptor?.role)).size
        !== PACK_ROLES.length
      || packs.some((pack) => pack.status !== 'OK'
        || validateVNextTaskPack(pack.taskPack).status !== 'OK')) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_PACKS_INVALID',
      'Protocol requires five verified, disjoint task packs.'
    );
  }
  const byRole = new Map(packs.map((pack) => [pack.descriptor.role, pack]));
  if (byRole.get('validation')?.taskPack.partition !== 'validation'
      || PACK_ROLES.filter((role) => role !== 'validation')
        .some((role) => byRole.get(role)?.taskPack.partition !== 'development')) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_PARTITION_INVALID',
      'Only the validation role may use the validation partition.'
    );
  }
  const identityOwner = new Map();
  const collisions = [];
  for (const role of PACK_ROLES) {
    for (const identity of byRole.get(role).identities) {
      if (identityOwner.has(identity)) {
        collisions.push({
          identity,
          first: identityOwner.get(identity),
          second: role
        });
      } else identityOwner.set(identity, role);
    }
  }
  return collisions.length
    ? refused(
        'VNEXT_ABLATION_PROTOCOL_TASK_REUSE',
        'A task, cluster, source, or oracle identity is reused across phases.',
        { collisions }
      )
    : {
        status: 'OK',
        descriptors: PACK_ROLES.map((role) => byRole.get(role).descriptor),
        identityLedger: buildIdentityLedger([...identityOwner.keys()])
      };
}

export function createVNextAblationProtocolR6(input = {}) {
  const packs = Array.isArray(input.packs) ? input.packs : [];
  const consumedEvaluatorProofs = Array.isArray(input.consumedEvaluatorProofs)
    ? input.consumedEvaluatorProofs
    : [];
  const qualification = verifyVNextSemanticJudgeQualificationBinding({
    binding: input.semanticJudgeQualification,
    packageRoot: input.packageRoot
  });
  const consumedEvaluatorReplays = consumedEvaluatorProofs.map(
    replayConsumedEvaluatorProof
  );
  const parent = validateAdaptiveRecord(input.parentFamily);
  const implementation = resolveVNextWaveImplementation({
    packageRoot: input.packageRoot
  });
  const packContext = prepareProtocolPacks(packs);
  if (!isSafeId(input.protocolId)
      || !Number.isFinite(Date.parse(input.createdAt))
      || parent.status !== 'OK'
      || input.parentFamily.schemaVersion !== 'mechanism-family-v1'
      || !exactKeys(input.modelPolicy, ['model', 'reasoningEffort', 'authMode'])
      || input.modelPolicy.model !== 'gpt-5.6-sol'
      || input.modelPolicy.reasoningEffort !== 'high'
      || input.modelPolicy.authMode !== 'chatgpt-oauth'
      || qualification.status !== 'OK'
      || consumedEvaluatorProofs.some((record) => !validConsumedEvaluatorProof(record))
      || consumedEvaluatorReplays.some((result) => result.status !== 'OK')
      || new Set(consumedEvaluatorProofs.map((record) => record.proofId)).size
        !== consumedEvaluatorProofs.length
      || consumedEvaluatorProofs.some((record) => (
        qualification.binding.forms.some((form) => form.proofId === record.proofId)
      ))
      || implementation.status !== 'OK'
      || packContext.status !== 'OK') {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_R6_INPUT_INVALID',
      'Protocol r6 requires deterministic phases plus one non-causal semantic-judge security qualification.',
      { qualification, packContext }
    );
  }
  const phases = protocolPhases(packContext.descriptors);
  const core = {
    schemaVersion: VNEXT_ABLATION_PROTOCOL_R6_SCHEMA,
    protocolId: input.protocolId,
    createdAt: input.createdAt,
    parentFamilyId: input.parentFamily.familyId,
    parentFamilySha256: input.parentFamily.familySha256,
    modelPolicy: input.modelPolicy,
    semanticJudgeQualification: qualification.binding,
    consumedEvaluatorProofs,
    implementationSha256: implementation.implementationSha256,
    packs: packContext.descriptors,
    identityLedger: packContext.identityLedger,
    phases,
    selectionRule: protocolSelectionRule(),
    inferencePolicy: protocolInferencePolicy(),
    exposure: protocolR6Exposure(
      phases,
      qualification.binding,
      consumedEvaluatorProofs.length
    ),
    authority: protocolAuthority()
  };
  const protocol = {
    ...core,
    protocolSha256: sha256(canonicalVNextJson(core))
  };
  return validateVNextAblationProtocol(protocol).status === 'OK'
    ? { status: 'OK', protocol }
    : refused(
        'VNEXT_ABLATION_PROTOCOL_R6_INVALID',
        'Constructed protocol r6 failed replay.'
      );
}

export function createVNextAblationProtocol(input = {}) {
  const packs = Array.isArray(input.packs) ? input.packs : [];
  const consumedEvaluatorProofs = Array.isArray(input.consumedEvaluatorProofs)
    ? input.consumedEvaluatorProofs
    : [];
  const evaluatorProofReplay = validEvaluatorProofBinding(input.evaluatorProof)
    ? verifyVNextEvaluatorProofFromDisk({
        proofHome: input.evaluatorProof.proofHome,
        proofId: input.evaluatorProof.proofId
      })
    : null;
  const replayedEvaluatorBinding = evaluatorProofReplay?.status === 'OK'
    ? createVNextAblationEvaluatorProofBinding(evaluatorProofReplay)
    : null;
  const consumedEvaluatorReplays = consumedEvaluatorProofs.map(
    replayConsumedEvaluatorProof
  );
  const parent = validateAdaptiveRecord(input.parentFamily);
  const implementation = resolveVNextWaveImplementation({
    packageRoot: input.packageRoot
  });
  const evaluatorImplementation = resolveVNextEvaluatorProofImplementation({
    packageRoot: input.packageRoot
  });
  if (!isSafeId(input.protocolId)
      || !Number.isFinite(Date.parse(input.createdAt))
      || parent.status !== 'OK'
      || input.parentFamily.schemaVersion !== 'mechanism-family-v1'
      || !exactKeys(input.modelPolicy, ['model', 'reasoningEffort', 'authMode'])
      || input.modelPolicy.model !== 'gpt-5.6-sol'
      || input.modelPolicy.reasoningEffort !== 'high'
      || input.modelPolicy.authMode !== 'chatgpt-oauth'
      || !validEvaluatorProofBinding(input.evaluatorProof)
      || consumedEvaluatorProofs.some((record) => !validConsumedEvaluatorProof(record))
      || replayedEvaluatorBinding?.status !== 'OK'
      || canonicalVNextJson(replayedEvaluatorBinding?.binding)
        !== canonicalVNextJson(input.evaluatorProof)
      || consumedEvaluatorReplays.some((result) => result.status !== 'OK')
      || new Set(consumedEvaluatorProofs.map((record) => record.proofId)).size
        !== consumedEvaluatorProofs.length
      || consumedEvaluatorProofs.some((record) => (
        record.proofId === input.evaluatorProof?.proofId
      ))
      || evaluatorImplementation.status !== 'OK'
      || input.evaluatorProof.implementationSha256
        !== evaluatorImplementation.implementationSha256
      || implementation.status !== 'OK'
      || packs.length !== PACK_ROLES.length
      || new Set(packs.map((pack) => pack.descriptor?.role)).size !== PACK_ROLES.length
      || packs.some((pack) => pack.status !== 'OK'
        || validateVNextTaskPack(pack.taskPack).status !== 'OK')) {
    return refused('VNEXT_ABLATION_PROTOCOL_INPUT_INVALID', 'Protocol requires five verified packs, the frozen parent, exact model policy, one successful evaluator result, and implementation.');
  }
  const byRole = new Map(packs.map((pack) => [pack.descriptor.role, pack]));
  if (byRole.get('validation').taskPack.partition !== 'validation'
      || PACK_ROLES.filter((role) => role !== 'validation')
        .some((role) => byRole.get(role).taskPack.partition !== 'development')) {
    return refused('VNEXT_ABLATION_PROTOCOL_PARTITION_INVALID', 'Only the validation role may use the validation partition.');
  }
  const identityOwner = new Map();
  const collisions = [];
  for (const role of PACK_ROLES) {
    for (const identity of byRole.get(role).identities) {
      if (identityOwner.has(identity)) {
        collisions.push({ identity, first: identityOwner.get(identity), second: role });
      } else identityOwner.set(identity, role);
    }
  }
  if (collisions.length) {
    return refused('VNEXT_ABLATION_PROTOCOL_TASK_REUSE', 'A task, cluster, source, or oracle identity is reused across study phases.', { collisions });
  }
  const descriptors = PACK_ROLES.map((role) => byRole.get(role).descriptor);
  const phases = protocolPhases(descriptors);
  const evaluatorCalls = 1 + consumedEvaluatorProofs.length;
  const core = {
    schemaVersion: VNEXT_ABLATION_PROTOCOL_SCHEMA,
    protocolId: input.protocolId,
    createdAt: input.createdAt,
    parentFamilyId: input.parentFamily.familyId,
    parentFamilySha256: input.parentFamily.familySha256,
    modelPolicy: input.modelPolicy,
    evaluatorProof: input.evaluatorProof,
    consumedEvaluatorProofs,
    implementationSha256: implementation.implementationSha256,
    packs: descriptors,
    identityLedger: buildIdentityLedger([...identityOwner.keys()]),
    phases,
    selectionRule: protocolSelectionRule(),
    inferencePolicy: protocolInferencePolicy(),
    exposure: protocolExposure(phases, evaluatorCalls),
    authority: protocolAuthority()
  };
  const protocol = {
    ...core,
    protocolSha256: sha256(canonicalVNextJson(core))
  };
  return validateVNextAblationProtocol(protocol).status === 'OK'
    ? { status: 'OK', protocol }
    : refused('VNEXT_ABLATION_PROTOCOL_INVALID', 'Constructed protocol failed replay.');
}

function validateVNextAblationProtocolV2(protocol) {
  const consumedEvaluatorProofs = Array.isArray(protocol?.consumedEvaluatorProofs)
    ? protocol.consumedEvaluatorProofs
    : [];
  const expectedPhases = Array.isArray(protocol?.packs)
    ? protocolPhases(protocol.packs)
    : [];
  const expectedExposure = protocolExposure(
    expectedPhases,
    1 + consumedEvaluatorProofs.length
  );
  if (!exactKeys(protocol, [
    'schemaVersion', 'protocolId', 'createdAt', 'parentFamilyId',
    'parentFamilySha256', 'modelPolicy', 'evaluatorProof',
    'consumedEvaluatorProofs', 'implementationSha256', 'packs',
    'identityLedger', 'phases', 'selectionRule', 'inferencePolicy', 'exposure',
    'authority', 'protocolSha256'
  ]) || protocol.schemaVersion !== VNEXT_ABLATION_PROTOCOL_SCHEMA
      || !isSafeId(protocol.protocolId)
      || !Number.isFinite(Date.parse(protocol.createdAt))
      || !SHA256.test(String(protocol.protocolSha256 || ''))
      || !validEvaluatorProofBinding(protocol.evaluatorProof)
      || !Array.isArray(protocol.consumedEvaluatorProofs)
      || protocol.consumedEvaluatorProofs.some((record) => (
        !validConsumedEvaluatorProof(record)
      ))
      || new Set(protocol.consumedEvaluatorProofs.map((record) => record.proofId)).size
        !== protocol.consumedEvaluatorProofs.length
      || protocol.consumedEvaluatorProofs.some((record) => (
        record.proofId === protocol.evaluatorProof.proofId
      ))
      || !validIdentityLedger(protocol.identityLedger)
      || canonicalVNextJson(protocol.phases)
        !== canonicalVNextJson(expectedPhases)
      || canonicalVNextJson(protocol.selectionRule)
        !== canonicalVNextJson(protocolSelectionRule())
      || canonicalVNextJson(protocol.inferencePolicy)
        !== canonicalVNextJson(protocolInferencePolicy())
      || canonicalVNextJson(protocol.exposure)
        !== canonicalVNextJson(expectedExposure)
      || canonicalVNextJson(protocol.authority)
        !== canonicalVNextJson(protocolAuthority())) {
    return refused('VNEXT_ABLATION_PROTOCOL_INVALID', 'Protocol shape or scientific authority boundary is invalid.');
  }
  const core = structuredClone(protocol);
  delete core.protocolSha256;
  return protocol.protocolSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', protocol }
    : refused('VNEXT_ABLATION_PROTOCOL_TAMPERED', 'Protocol hash failed replay.');
}

function validateVNextAblationProtocolR6(protocol) {
  const consumedEvaluatorProofs = Array.isArray(protocol?.consumedEvaluatorProofs)
    ? protocol.consumedEvaluatorProofs
    : [];
  const expectedPhases = Array.isArray(protocol?.packs)
    ? protocolPhases(protocol.packs)
    : [];
  const expectedExposure = validSemanticJudgeQualificationBinding(
    protocol?.semanticJudgeQualification
  )
    ? protocolR6Exposure(
        expectedPhases,
        protocol.semanticJudgeQualification,
        consumedEvaluatorProofs.length
      )
    : null;
  if (!exactKeys(protocol, [
    'schemaVersion', 'protocolId', 'createdAt', 'parentFamilyId',
    'parentFamilySha256', 'modelPolicy', 'semanticJudgeQualification',
    'consumedEvaluatorProofs', 'implementationSha256', 'packs',
    'identityLedger', 'phases', 'selectionRule', 'inferencePolicy', 'exposure',
    'authority', 'protocolSha256'
  ])
      || protocol.schemaVersion !== VNEXT_ABLATION_PROTOCOL_R6_SCHEMA
      || !isSafeId(protocol.protocolId)
      || !Number.isFinite(Date.parse(protocol.createdAt))
      || !isSafeId(protocol.parentFamilyId)
      || !SHA256.test(String(protocol.parentFamilySha256 || ''))
      || !SHA256.test(String(protocol.implementationSha256 || ''))
      || !SHA256.test(String(protocol.protocolSha256 || ''))
      || !exactKeys(protocol.modelPolicy, ['model', 'reasoningEffort', 'authMode'])
      || protocol.modelPolicy.model !== 'gpt-5.6-sol'
      || protocol.modelPolicy.reasoningEffort !== 'high'
      || protocol.modelPolicy.authMode !== 'chatgpt-oauth'
      || !validSemanticJudgeQualificationBinding(
        protocol.semanticJudgeQualification
      )
      || !Array.isArray(protocol.consumedEvaluatorProofs)
      || protocol.consumedEvaluatorProofs.some((record) => (
        !validConsumedEvaluatorProof(record)
      ))
      || new Set(protocol.consumedEvaluatorProofs.map((record) => record.proofId)).size
        !== protocol.consumedEvaluatorProofs.length
      || protocol.consumedEvaluatorProofs.some((record) => (
        protocol.semanticJudgeQualification.forms.some((form) => (
          form.proofId === record.proofId
        ))
      ))
      || !Array.isArray(protocol.packs)
      || protocol.packs.length !== PACK_ROLES.length
      || new Set(protocol.packs.map(({ role }) => role)).size !== PACK_ROLES.length
      || PACK_ROLES.some((role) => !protocol.packs.some((pack) => pack.role === role))
      || protocol.packs.some((pack) => (
        !isSafeId(pack.role)
        || !isSafeId(pack.packId)
        || !['development', 'validation'].includes(pack.partition)
        || ![
          pack.packSha256,
          pack.taskIdentitySetSha256,
          pack.materialBundleSha256,
          pack.importReceiptSha256,
          pack.sourceConfigSha256
        ].every((value) => SHA256.test(String(value || '')))
        || pack.taskCount !== 10
        || pack.referenceContentImported !== false
      ))
      || !validIdentityLedger(protocol.identityLedger)
      || canonicalVNextJson(protocol.phases)
        !== canonicalVNextJson(expectedPhases)
      || canonicalVNextJson(protocol.selectionRule)
        !== canonicalVNextJson(protocolSelectionRule())
      || canonicalVNextJson(protocol.inferencePolicy)
        !== canonicalVNextJson(protocolInferencePolicy())
      || canonicalVNextJson(protocol.exposure)
        !== canonicalVNextJson(expectedExposure)
      || canonicalVNextJson(protocol.authority)
        !== canonicalVNextJson(protocolAuthority())) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_R6_INVALID',
      'Protocol r6 shape or scientific authority boundary is invalid.'
    );
  }
  const core = structuredClone(protocol);
  delete core.protocolSha256;
  return protocol.protocolSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', protocol }
    : refused(
        'VNEXT_ABLATION_PROTOCOL_R6_TAMPERED',
        'Protocol r6 hash failed replay.'
      );
}

export function validateVNextAblationProtocol(protocol) {
  return protocol?.schemaVersion === VNEXT_ABLATION_PROTOCOL_R6_SCHEMA
    ? validateVNextAblationProtocolR6(protocol)
    : validateVNextAblationProtocolV2(protocol);
}

export function vnextAblationProtocolPhase(protocol, phaseId, armId, packSha256) {
  if (validateVNextAblationProtocol(protocol).status !== 'OK') return null;
  const phase = protocol.phases.find((row) => row.phaseId === phaseId);
  return phase && phase.arms.includes(armId) && phase.packSha256 === packSha256
    ? phase
    : null;
}

export function verifyVNextAblationProtocolFromDisk({
  protocol,
  packageRoot
} = {}) {
  const valid = validateVNextAblationProtocol(protocol);
  if (valid.status !== 'OK') return valid;
  const loaded = protocol.packs.map((descriptor) => (
    loadVNextAblationPackDescriptor({
      role: descriptor.role,
      directory: descriptor.directory
    })
  ));
  if (loaded.some((result) => result.status !== 'OK')) {
    return refused('VNEXT_ABLATION_PROTOCOL_PACK_REPLAY_FAILED', 'An imported pack no longer replays.', {
      failures: loaded.filter((result) => result.status !== 'OK')
    });
  }
  if (loaded.some((result) => (
    canonicalVNextJson(result.descriptor)
      !== canonicalVNextJson(protocol.packs.find(({ role }) => (
        role === result.descriptor.role
      )))
  ))) {
    return refused('VNEXT_ABLATION_PROTOCOL_PACK_DRIFT', 'A pack descriptor changed after protocol freeze.');
  }
  const owners = new Map();
  for (const result of loaded) {
    for (const identity of result.identities) {
      if (owners.has(identity)) {
        return refused('VNEXT_ABLATION_PROTOCOL_TASK_REUSE', 'A frozen pack identity is reused across phases.');
      }
      owners.set(identity, result.descriptor.role);
    }
  }
  const replayedIdentityLedger = buildIdentityLedger([...owners.keys()]);
  if (canonicalVNextJson(replayedIdentityLedger)
      !== canonicalVNextJson(protocol.identityLedger)) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_IDENTITY_LEDGER_DRIFT',
      'The privacy-preserving internal identity digest ledger no longer replays.'
    );
  }
  const implementation = resolveVNextWaveImplementation({ packageRoot });
  if (implementation.status !== 'OK'
      || implementation.implementationSha256 !== protocol.implementationSha256) {
    return refused('VNEXT_ABLATION_PROTOCOL_IMPLEMENTATION_DRIFT', 'Wave implementation changed after protocol freeze.');
  }
  if (protocol.schemaVersion === VNEXT_ABLATION_PROTOCOL_R6_SCHEMA) {
    const qualification = verifyVNextSemanticJudgeQualificationBinding({
      binding: protocol.semanticJudgeQualification,
      packageRoot
    });
    const consumedEvaluatorReplays = protocol.consumedEvaluatorProofs.map(
      replayConsumedEvaluatorProof
    );
    const expectedCalls = protocol.phases.reduce((sum, phase) => (
      sum + phaseMaximumCalls(phase)
    ), protocol.exposure.liveEvaluatorCalls);
    if (qualification.status !== 'OK') return qualification;
    if (consumedEvaluatorReplays.some((result) => result.status !== 'OK')) {
      return refused(
        'VNEXT_ABLATION_PROTOCOL_CONSUMED_EVALUATOR_DRIFT',
        'Consumed evaluator failure evidence changed or no longer replays.',
        { failures: consumedEvaluatorReplays.filter((result) => result.status !== 'OK') }
      );
    }
    if (expectedCalls !== protocol.exposure.internalMaximumCalls) {
      return refused(
        'VNEXT_ABLATION_PROTOCOL_EXPOSURE_DRIFT',
        'Protocol r6 deterministic call exposure no longer replays.'
      );
    }
    return {
      status: 'OK',
      protocol,
      packs: loaded.map((result) => result.descriptor),
      implementationSha256: implementation.implementationSha256,
      evidenceSha256: sha256(canonicalVNextJson({
        protocolSha256: protocol.protocolSha256,
        implementationSha256: implementation.implementationSha256,
        semanticJudgeQualificationSha256:
          protocol.semanticJudgeQualification.qualification.qualificationSha256,
        semanticJudgeQualificationBindingSha256:
          protocol.semanticJudgeQualification.bindingSha256,
        semanticJudgeFormPlanSha256s:
          protocol.semanticJudgeQualification.forms
            .map(({ planSha256 }) => planSha256).sort(),
        semanticJudgeAnswerKeySha256:
          protocol.semanticJudgeQualification.qualification.answerKeySha256,
        consumedEvaluatorProofSha256s: protocol.consumedEvaluatorProofs
          .map((record) => sha256(canonicalVNextJson(record))).sort(),
        identityLedgerSha256: protocol.identityLedger.ledgerSha256,
        packSha256s: loaded.map((result) => result.descriptor.packSha256).sort(),
        taskIdentitySetSha256s: loaded
          .map((result) => result.descriptor.taskIdentitySetSha256).sort()
      }))
    };
  }
  const evaluatorImplementation = resolveVNextEvaluatorProofImplementation({
    packageRoot
  });
  if (evaluatorImplementation.status !== 'OK'
      || evaluatorImplementation.implementationSha256
        !== protocol.evaluatorProof.implementationSha256) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_EVALUATOR_IMPLEMENTATION_DRIFT',
      'Evaluator proof implementation changed after protocol freeze.'
    );
  }
  const evaluatorProof = verifyVNextEvaluatorProofFromDisk({
    proofHome: protocol.evaluatorProof.proofHome,
    proofId: protocol.evaluatorProof.proofId
  });
  const replayedEvaluatorBinding = createVNextAblationEvaluatorProofBinding(
    evaluatorProof
  );
  if (replayedEvaluatorBinding.status !== 'OK'
      || canonicalVNextJson(replayedEvaluatorBinding.binding)
        !== canonicalVNextJson(protocol.evaluatorProof)) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_EVALUATOR_RESULT_DRIFT',
      'Successful evaluator result evidence changed or no longer replays.'
    );
  }
  const consumedEvaluatorReplays = protocol.consumedEvaluatorProofs.map(
    replayConsumedEvaluatorProof
  );
  if (consumedEvaluatorReplays.some((result) => result.status !== 'OK')) {
    return refused(
      'VNEXT_ABLATION_PROTOCOL_CONSUMED_EVALUATOR_DRIFT',
      'Consumed evaluator failure evidence changed or no longer replays.',
      { failures: consumedEvaluatorReplays.filter((result) => result.status !== 'OK') }
    );
  }
  const expectedCalls = protocol.phases.reduce((sum, phase) => (
    sum + phaseMaximumCalls(phase)
  ), protocol.exposure.liveEvaluatorCalls);
  if (expectedCalls !== protocol.exposure.internalMaximumCalls) {
    return refused('VNEXT_ABLATION_PROTOCOL_EXPOSURE_DRIFT', 'Protocol call exposure no longer replays.');
  }
  return {
    status: 'OK',
    protocol,
    packs: loaded.map((result) => result.descriptor),
    implementationSha256: implementation.implementationSha256,
    evidenceSha256: sha256(canonicalVNextJson({
      protocolSha256: protocol.protocolSha256,
      implementationSha256: implementation.implementationSha256,
      evaluatorProofResultSha256: evaluatorProof.result.resultSha256,
      evaluatorProofEvidenceSha256: evaluatorProof.evidenceSha256,
      evaluatorProofImplementationSha256:
        evaluatorImplementation.implementationSha256,
      consumedEvaluatorProofSha256s: protocol.consumedEvaluatorProofs
        .map((record) => sha256(canonicalVNextJson(record))).sort(),
      identityLedgerSha256: protocol.identityLedger.ledgerSha256,
      packSha256s: loaded.map((result) => result.descriptor.packSha256).sort(),
      taskIdentitySetSha256s: loaded
        .map((result) => result.descriptor.taskIdentitySetSha256).sort()
    }))
  };
}
