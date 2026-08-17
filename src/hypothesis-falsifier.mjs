import { sha256 } from './util.mjs';
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
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';
import { validateVNextAblationProfile } from './vnext-ablation-profile.mjs';

export const VNEXT_FALSIFIER_CONTRACT_SCHEMA = 'vnext-falsifier-contract-v1';

const FORBIDDEN_INPUT_KEYS = [
  'finalTasks',
  'sealedTasks',
  'futureResults',
  'armLabels',
  'proposerConversation',
  'hiddenEvaluatorMaterial'
];

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasForbiddenContext(input) {
  return FORBIDDEN_INPUT_KEYS.some((key) => input[key] != null);
}

function containsForbiddenKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, seen));
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_INPUT_KEYS.includes(key) || containsForbiddenKey(child, seen)
  ));
}

function validatedArtifact(value, stage) {
  const valid = validateVNextStageArtifact(value);
  return valid.status === 'OK' && value.stage === stage && value.status === 'OK' ? value : null;
}

export function buildHypothesisFalsifierContract(input = {}) {
  if (hasForbiddenContext(input) || !validIso(input.createdAt)
      || containsForbiddenKey(input.architectureFacts)
      || containsForbiddenKey(input.publicMeasurementContract)) {
    return refused('FALSIFIER_CONTEXT_BOUNDARY', 'Fresh falsifier context contains forbidden or invalid information.');
  }
  const hypothesisArtifact = validatedArtifact(input.hypothesisArtifact, VNEXT_STAGE.HYPOTHESIS);
  const dossierArtifact = validatedArtifact(input.dossierArtifact, VNEXT_STAGE.DOSSIER);
  const hypothesis = hypothesisArtifact?.payload?.hypothesis ?? hypothesisArtifact?.payload;
  const hypothesisOutput = validateVNextModelOutput(hypothesis, VNEXT_MODEL_SCHEMA.HYPOTHESIS);
  if (!hypothesisArtifact || !dossierArtifact || hypothesisOutput.status !== 'OK'
      || [hypothesisArtifact.createdAt, dossierArtifact.createdAt]
        .some((createdAt) => Date.parse(createdAt) > Date.parse(input.createdAt))
      || !plainObject(input.architectureFacts) || !plainObject(input.publicMeasurementContract)) {
    return refused('FALSIFIER_CONTRACT_INVALID', 'Falsifier requires frozen hypothesis/dossier artifacts and public deterministic context.');
  }
  if (!Array.isArray(input.evidenceRecords ?? [])) {
    return refused('FALSIFIER_EVIDENCE_INVALID', 'Falsifier evidence must be an array.');
  }
  const evidence = [];
  for (const record of input.evidenceRecords ?? []) {
    const valid = validateVNextEvidenceRecord(record, {
      allowFixtureRecords: input.allowFixtureRecords === true
    });
    if (valid.status !== 'OK' || !record.verifierEligible || record.lifecycle.quarantined
        || Date.parse(record.availableAt) > Date.parse(input.createdAt)) {
      return refused('FALSIFIER_EVIDENCE_INVALID', 'Falsifier evidence must be intact, unquarantined, and chronologically available.');
    }
    evidence.push({
      recordId: record.recordId,
      recordSha256: record.recordSha256,
      kind: record.kind,
      availableAt: record.availableAt,
      compatibility: record.compatibility,
      content: record.content
    });
  }
  evidence.sort((a, b) => a.recordId.localeCompare(b.recordId));
  const dossierIds = [
    ...(dossierArtifact.payload.items ?? []).map((item) => item.id),
    ...(dossierArtifact.payload.sourceIndex ?? []).map((item) => item.id)
  ];
  const allowedEvidenceIds = [...new Set([
    ...dossierIds,
    ...evidence.map((record) => record.recordId)
  ])].sort();
  const allowedEvidence = new Set(allowedEvidenceIds);
  if (hypothesisOutput.output.evidenceIds.some((id) => !allowedEvidence.has(id))
      || new Set(evidence.map((record) => record.recordId)).size !== evidence.length) {
    return refused('FALSIFIER_EVIDENCE_ID_MISSING', 'Hypothesis or selected evidence ids are absent from the fresh falsifier context.');
  }
  const core = {
    schemaVersion: VNEXT_FALSIFIER_CONTRACT_SCHEMA,
    createdAt: input.createdAt,
    hypothesisRef: {
      id: hypothesisArtifact.artifactId,
      sha256: hypothesisArtifact.artifactSha256
    },
    dossierRef: {
      id: dossierArtifact.artifactId,
      sha256: dossierArtifact.artifactSha256
    },
    hypothesis: hypothesisOutput.output,
    dossier: dossierArtifact.payload,
    evidence,
    architectureFacts: structuredClone(input.architectureFacts),
    publicMeasurementContract: structuredClone(input.publicMeasurementContract),
    allowedEvidenceIds,
    permittedInformation: ['frozen hypothesis', 'frozen dossier', 'architecture facts', 'public measurement contract'],
    forbiddenInformation: ['final sealed tasks', 'future results', 'arm labels', 'proposer conversation', 'hidden evaluator material', 'admission authority']
  };
  const contractSha256 = sha256(canonicalVNextJson(core));
  return { status: 'OK', contract: deepFreeze({ ...core, contractSha256 }) };
}

export function validateHypothesisFalsifierContract(contract) {
  if (!plainObject(contract) || contract.schemaVersion !== VNEXT_FALSIFIER_CONTRACT_SCHEMA
      || typeof contract.contractSha256 !== 'string') {
    return refused('FALSIFIER_CONTRACT_INVALID', 'Falsifier contract shape is invalid.');
  }
  const { contractSha256, ...core } = contract;
  if (sha256(canonicalVNextJson(core)) !== contractSha256
      || !Array.isArray(contract.allowedEvidenceIds)
      || new Set(contract.allowedEvidenceIds).size !== contract.allowedEvidenceIds.length) {
    return refused('FALSIFIER_CONTRACT_TAMPERED', 'Falsifier contract hash or evidence scope is invalid.');
  }
  return { status: 'OK', contract };
}

export function buildHypothesisFalsifierPrompt(contract) {
  if (validateHypothesisFalsifierContract(contract).status !== 'OK') return null;
  return [
    'Adversarially review this hypothesis using only the frozen context below.',
    'Return only JSON matching vnext-falsification-output-v1.',
    'Recommend exactly REJECT, REVISE, or TEST. You have no edit, admission, activation, or scoring authority.',
    'Cite only allowedEvidenceIds. Do not infer final tasks, future results, arm labels, or proposer context.',
    '',
    canonicalVNextJson(contract)
  ].join('\n');
}

export function parseHypothesisFalsifierOutput(value, contract) {
  const validContract = validateHypothesisFalsifierContract(contract);
  if (validContract.status !== 'OK') return validContract;
  let output = value;
  if (typeof value === 'string') {
    try {
      output = JSON.parse(value);
    } catch {
      return refused('FALSIFIER_OUTPUT_INVALID', 'Falsifier output is not JSON.');
    }
  }
  const valid = validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.FALSIFICATION);
  if (valid.status !== 'OK') return refused('FALSIFIER_OUTPUT_INVALID', 'Falsifier output violates vnext-falsification-output-v1.');
  const allowed = new Set(contract?.allowedEvidenceIds ?? []);
  if (output.evidenceIds.length === 0 || output.evidenceIds.some((id) => !allowed.has(id))) {
    return refused('FALSIFIER_EVIDENCE_ID_MISSING', 'Falsifier cited no evidence or an evidence id absent from its fresh context.');
  }
  return { status: 'OK', output: valid.output };
}

export function buildHypothesisFalsificationArtifact({ contract, output, authority } = {}) {
  const validContract = validateHypothesisFalsifierContract(contract);
  if (validContract.status !== 'OK') return validContract;
  const parsed = parseHypothesisFalsifierOutput(output, contract);
  if (parsed.status !== 'OK') return parsed;
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.FALSIFICATION,
    status: 'OK',
    createdAt: contract.createdAt,
    authority: authority ?? {
      actorId: 'vnext-hypothesis-falsifier',
      kind: 'fresh-context-worker',
      model: null,
      promptSha256: sha256(buildHypothesisFalsifierPrompt(contract)),
      toolPolicy: 'none'
    },
    inputRefs: [
      { id: contract.hypothesisRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.hypothesisRef.sha256 },
      { id: contract.dossierRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.dossierRef.sha256 },
      ...contract.evidence.map((record) => ({
        id: record.recordId,
        schemaVersion: 'vnext-evidence-record-v1',
        sha256: record.recordSha256
      }))
    ],
    permittedInformation: contract.permittedInformation,
    forbiddenInformation: contract.forbiddenInformation,
    provenance: contract.evidence.map((record) => ({
      id: record.recordId,
      kind: 'verifier-evidence-record',
      observedAt: record.availableAt,
      sha256: record.recordSha256,
      uri: null
    })),
    replay: { module: 'src/hypothesis-falsifier.mjs', exportName: 'buildHypothesisFalsificationArtifact', version: 'v1' },
    failure: null,
    payload: {
      contractSha256: contract.contractSha256,
      recommendationOnly: true,
      mayEdit: false,
      mayAdmit: false,
      falsification: parsed.output
    }
  });
  return artifact.status === 'OK' ? deepFreeze({ status: 'OK', artifact: artifact.artifact }) : artifact;
}

export function buildAblationBaselineFalsificationArtifact({
  contract,
  profile
} = {}) {
  if (validateHypothesisFalsifierContract(contract).status !== 'OK'
      || validateVNextAblationProfile(profile).status !== 'OK'
      || profile.hypothesisFalsificationEnabled !== false) {
    return refused(
      'FALSIFIER_ABLATION_BASELINE_INVALID',
      'A deterministic falsification baseline requires one intact profile with independent falsification disabled.'
    );
  }
  const output = {
    schemaVersion: VNEXT_MODEL_SCHEMA.FALSIFICATION,
    verdict: 'TEST',
    summary: 'Independent falsification is disabled in this frozen ablation arm; only blinded measurement may determine the result.',
    smallerEdit: 'Test the already bounded hypothesis without an adversarial revision.',
    distinct: false,
    falsifiers: [contract.hypothesis.falsifier],
    confounds: ['This arm omits an independent post-hypothesis falsifier.'],
    requiredControls: [...contract.hypothesis.controls],
    contradictions: [],
    evidenceIds: [...contract.hypothesis.evidenceIds]
  };
  const parsed = parseHypothesisFalsifierOutput(output, contract);
  if (parsed.status !== 'OK') return parsed;
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.FALSIFICATION,
    status: 'OK',
    createdAt: contract.createdAt,
    authority: {
      actorId: `vnext-ablation-${profile.armId.toLowerCase()}-falsifier`,
      kind: 'deterministic-ablation-baseline',
      model: null,
      promptSha256: null,
      toolPolicy: 'none'
    },
    inputRefs: [
      { id: contract.hypothesisRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.hypothesisRef.sha256 },
      { id: contract.dossierRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.dossierRef.sha256 },
      ...contract.evidence.map((record) => ({
        id: record.recordId,
        schemaVersion: 'vnext-evidence-record-v1',
        sha256: record.recordSha256
      })),
      { id: `ablation-${profile.armId.toLowerCase()}`, schemaVersion: profile.schemaVersion, sha256: profile.profileSha256 }
    ],
    permittedInformation: contract.permittedInformation,
    forbiddenInformation: contract.forbiddenInformation,
    provenance: contract.evidence.map((record) => ({
      id: record.recordId,
      kind: 'verifier-evidence-record',
      observedAt: record.availableAt,
      sha256: record.recordSha256,
      uri: null
    })),
    replay: {
      module: 'src/hypothesis-falsifier.mjs',
      exportName: 'buildAblationBaselineFalsificationArtifact',
      version: 'v1'
    },
    failure: null,
    payload: {
      contractSha256: contract.contractSha256,
      ablationProfileSha256: profile.profileSha256,
      falsificationDisabled: true,
      recommendationOnly: true,
      mayEdit: false,
      mayAdmit: false,
      falsification: parsed.output
    }
  });
  return artifact.status === 'OK'
    ? deepFreeze({ status: 'OK', artifact: artifact.artifact })
    : artifact;
}

export async function runHypothesisFalsifier({ worker, authority, ...contractInput } = {}) {
  if (typeof worker !== 'function') return refused('FALSIFIER_WORKER_REQUIRED', 'A caller-supplied fresh worker is required.');
  const built = buildHypothesisFalsifierContract(contractInput);
  if (built.status !== 'OK') return built;
  let output;
  try {
    output = await worker(deepFreeze({
      contract: built.contract,
      prompt: buildHypothesisFalsifierPrompt(built.contract)
    }));
  } catch {
    return refused('FALSIFIER_WORKER_FAILED', 'The fresh falsifier worker failed.');
  }
  return buildHypothesisFalsificationArtifact({ contract: built.contract, output, authority });
}
