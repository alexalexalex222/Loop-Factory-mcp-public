import { isSafeId, sha256 } from './util.mjs';
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
import { validateResearchDossier } from './research-dossier.mjs';
import { validateHybridRetrievalReceipt } from './hybrid-retrieval.mjs';
import { validateTaskAgentFeedbackArtifact } from './task-agent-feedback.mjs';

export const VNEXT_HYPOTHESIS_CONTRACT_SCHEMA = 'vnext-hypothesis-contract-v1';

const SHA256 = /^[a-f0-9]{64}$/;

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function stage(value, expected) {
  const valid = validateVNextStageArtifact(value);
  return valid.status === 'OK' && value.stage === expected && value.status === 'OK'
    ? value : null;
}

function behaviorContext(map, targetIds) {
  if (!plainObject(map) || !SHA256.test(String(map.behaviorMapSha256 || ''))
      || map.authority !== 'descriptive-source-map-only'
      || map.canAuthorizeEdits !== false
      || !Array.isArray(map.behaviors)
      || !Array.isArray(targetIds)
      || targetIds.length < 1 || targetIds.length > 8) return null;
  const wanted = [...new Set(targetIds)].sort();
  if (wanted.some((id) => !isSafeId(id))) return null;
  const byId = new Map(map.behaviors.map((behavior) => [behavior.id, behavior]));
  const selected = wanted.map((id) => byId.get(id));
  const mapCore = structuredClone(map);
  delete mapCore.behaviorMapSha256;
  if (sha256(canonicalVNextJson(mapCore)) !== map.behaviorMapSha256
      || selected.some((behavior) => !plainObject(behavior)
        || !isSafeId(behavior.id)
        || !Array.isArray(behavior.locators)
        || !Array.isArray(behavior.tests))) return null;
  const context = {
    behaviorMapSha256: map.behaviorMapSha256,
    authority: map.authority,
    canAuthorizeEdits: false,
    behaviors: structuredClone(selected)
  };
  return Buffer.byteLength(canonicalVNextJson(context)) <= 256 * 1024
    ? context : null;
}

function feedbackRows(values, createdAt) {
  if (!Array.isArray(values) || values.length > 64) return null;
  const rows = values.map((artifact) => (
    validateTaskAgentFeedbackArtifact(artifact).status === 'OK'
      && Date.parse(artifact.collectedAt) <= Date.parse(createdAt)
      ? {
          artifactId: artifact.artifactId,
          artifactSha256: artifact.artifactSha256,
          collectedAt: artifact.collectedAt,
          feedback: structuredClone(artifact.feedback),
          authority: 'noisy-future-hypothesis-evidence-only'
        }
      : null
  ));
  if (rows.some((row) => row == null)) return null;
  rows.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  return new Set(rows.map(({ artifactId }) => artifactId)).size === rows.length
    ? rows : null;
}

export function buildVNextHypothesisContract(input = {}) {
  const createdAtValid = typeof input.createdAt === 'string'
    && Number.isFinite(Date.parse(input.createdAt));
  const dossier = validateResearchDossier(input.dossierArtifact).status === 'OK'
    ? input.dossierArtifact : null;
  const retrieval = validateHybridRetrievalReceipt(input.retrievalArtifact).status === 'OK'
    ? input.retrievalArtifact : null;
  const research = stage(input.researchArtifact, VNEXT_STAGE.INTERNAL_RESEARCH);
  const behaviors = behaviorContext(input.behaviorMap, input.targetBehaviorIds);
  const feedback = createdAtValid
    ? feedbackRows(input.feedbackArtifacts ?? [], input.createdAt)
    : null;
  const priorHypothesis = input.priorHypothesisArtifact == null
    ? null : stage(input.priorHypothesisArtifact, VNEXT_STAGE.HYPOTHESIS);
  const falsification = input.falsificationArtifact == null
    ? null : stage(input.falsificationArtifact, VNEXT_STAGE.FALSIFICATION);
  const revisionNumber = input.revisionNumber ?? 0;
  const suppliedRequiredEvidenceIds = input.requiredEvidenceIds ?? [];
  const requiredEvidenceIds = Array.isArray(suppliedRequiredEvidenceIds)
      && suppliedRequiredEvidenceIds.length <= 32
      && suppliedRequiredEvidenceIds.every(isSafeId)
      && new Set(suppliedRequiredEvidenceIds).size === suppliedRequiredEvidenceIds.length
    ? [...suppliedRequiredEvidenceIds].sort()
    : null;
  const lineageArtifacts = [dossier, retrieval, research, priorHypothesis, falsification]
    .filter(Boolean);
  if (!dossier || !retrieval || !research || !behaviors || !feedback
      || requiredEvidenceIds == null
      || !createdAtValid
      || lineageArtifacts.some((artifact) => (
        Date.parse(artifact.createdAt) > Date.parse(input.createdAt)
      ))
      || !SHA256.test(String(input.parentArtifactSha256 || ''))
      || !Number.isInteger(revisionNumber) || revisionNumber < 0 || revisionNumber > 1
      || (revisionNumber === 0 && (priorHypothesis || falsification))
      || (revisionNumber === 1 && (!priorHypothesis || !falsification
        || !falsification.inputRefs.some((ref) => (
          ref.id === priorHypothesis.artifactId
          && ref.sha256 === priorHypothesis.artifactSha256
        ))))) {
    return refused('HYPOTHESIS_CONTRACT_INVALID', 'Hypothesis contracts require frozen research, retrieval, behavior, feedback, and bounded revision context.');
  }
  const allowedEvidenceIds = [...new Set([
    ...dossier.payload.items.map(({ id }) => id),
    ...dossier.payload.sourceIndex.map(({ id }) => id),
    ...retrieval.payload.selection.map(({ recordId }) => recordId),
    ...research.payload.research.facts.map(({ id }) => id),
    ...feedback.map(({ artifactId }) => artifactId),
    ...(falsification?.payload?.falsification?.evidenceIds ?? [])
  ])].sort();
  if (requiredEvidenceIds.some((id) => !allowedEvidenceIds.includes(id))) {
    return refused(
      'HYPOTHESIS_REQUIRED_EVIDENCE_UNAVAILABLE',
      'The frozen candidate strategy requires evidence absent from the hypothesis context.'
    );
  }
  const core = {
    schemaVersion: VNEXT_HYPOTHESIS_CONTRACT_SCHEMA,
    createdAt: input.createdAt,
    revisionNumber,
    dossierRef: { id: dossier.artifactId, sha256: dossier.artifactSha256 },
    retrievalRef: { id: retrieval.artifactId, sha256: retrieval.artifactSha256 },
    researchRef: { id: research.artifactId, sha256: research.artifactSha256 },
    priorHypothesisRef: priorHypothesis
      ? { id: priorHypothesis.artifactId, sha256: priorHypothesis.artifactSha256 }
      : null,
    priorHypothesisOutputSha256: priorHypothesis
      ? sha256(canonicalVNextJson(priorHypothesis.payload.hypothesis))
      : null,
    falsificationRef: falsification
      ? { id: falsification.artifactId, sha256: falsification.artifactSha256 }
      : null,
    parentArtifactSha256: input.parentArtifactSha256,
    dossier: dossier.payload,
    retrievalSelection: retrieval.payload.selection,
    research: research.payload.research,
    behaviors,
    feedback,
    revisionEvidence: falsification?.payload?.falsification ?? null,
    allowedComponents: behaviors.behaviors.map(({ id }) => id).sort(),
    allowedEvidenceIds,
    requiredEvidenceIds,
    permittedInformation: ['frozen research dossier', 'eligible retrieval', 'source-bound behavior map', 'noisy task-agent feedback', ...(revisionNumber ? ['prior hypothesis and independent falsification'] : [])],
    forbiddenInformation: ['activation authority', 'arm labels', 'final sealed tasks', 'future outcomes', 'hidden evaluator material', 'prior scores'],
    activationAuthority: false
  };
  if (Buffer.byteLength(canonicalVNextJson(core)) > 768 * 1024) {
    return refused('HYPOTHESIS_CONTRACT_TOO_LARGE', 'Hypothesis context exceeds the hard byte ceiling.');
  }
  return {
    status: 'OK',
    contract: deepFreeze({ ...core, contractSha256: sha256(canonicalVNextJson(core)) })
  };
}

export function validateVNextHypothesisContract(contract) {
  if (!plainObject(contract) || contract.schemaVersion !== VNEXT_HYPOTHESIS_CONTRACT_SCHEMA
      || !SHA256.test(String(contract.contractSha256 || ''))) {
    return refused('HYPOTHESIS_CONTRACT_INVALID', 'Hypothesis contract shape is invalid.');
  }
  const core = structuredClone(contract);
  delete core.contractSha256;
  return sha256(canonicalVNextJson(core)) === contract.contractSha256
    && contract.activationAuthority === false
    ? { status: 'OK', contract }
    : refused('HYPOTHESIS_CONTRACT_TAMPERED', 'Hypothesis contract failed replay.');
}

export function buildVNextHypothesisPrompt(contract) {
  if (validateVNextHypothesisContract(contract).status !== 'OK') return null;
  return [
    contract.revisionNumber === 0
      ? 'Generate one task-agnostic, falsifiable harness-improvement hypothesis.'
      : 'Revise the prior hypothesis once in response to the independent falsification.',
    'Return strict JSON matching vnext-hypothesis-output-v1.',
    'Choose one allowed component, cite only allowedEvidenceIds, name controls, make one measurable prediction, and define a falsifier.',
    contract.requiredEvidenceIds.length
      ? 'Cite every requiredEvidenceIds entry so the predeclared candidate strategy remains provenance-bound.'
      : 'No candidate-strategy evidence ids are additionally required in this arm.',
    'Do not propose edits to protected surfaces. You have no execution, scoring, admission, activation, or deployment authority.',
    '',
    canonicalVNextJson(contract)
  ].join('\n');
}

export function buildVNextHypothesisArtifact({ contract, output, authority } = {}) {
  if (validateVNextHypothesisContract(contract).status !== 'OK') {
    return refused('HYPOTHESIS_CONTRACT_INVALID', 'Hypothesis contract failed replay.');
  }
  const valid = validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.HYPOTHESIS);
  const allowedEvidence = new Set(contract.allowedEvidenceIds);
  if (valid.status !== 'OK'
      || valid.output.taskAgnostic !== true
      || !contract.allowedComponents.includes(valid.output.component)
      || valid.output.evidenceIds.length < 1
      || valid.output.evidenceIds.some((id) => !allowedEvidence.has(id))
      || contract.requiredEvidenceIds.some((id) => (
        !valid.output.evidenceIds.includes(id)
      ))
      || valid.output.controls.length < 1) {
    return refused('HYPOTHESIS_OUTPUT_INVALID', 'Hypothesis output escaped its component, evidence, task-agnostic, or control boundary.');
  }
  if (contract.priorHypothesisRef
      && sha256(canonicalVNextJson(valid.output))
        === contract.priorHypothesisOutputSha256) {
    return refused('HYPOTHESIS_REVISION_UNCHANGED', 'A revision must not replay the prior hypothesis bytes.');
  }
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.HYPOTHESIS,
    status: 'OK',
    createdAt: contract.createdAt,
    authority: authority ?? {
      actorId: `vnext-hypothesizer-r${contract.revisionNumber}`,
      kind: 'fresh-context-worker',
      model: null,
      promptSha256: sha256(buildVNextHypothesisPrompt(contract)),
      toolPolicy: 'none'
    },
    inputRefs: [
      { id: contract.dossierRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.dossierRef.sha256 },
      { id: contract.retrievalRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.retrievalRef.sha256 },
      { id: contract.researchRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.researchRef.sha256 },
      ...(contract.priorHypothesisRef ? [{ id: contract.priorHypothesisRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.priorHypothesisRef.sha256 }] : []),
      ...(contract.falsificationRef ? [{ id: contract.falsificationRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.falsificationRef.sha256 }] : [])
    ],
    permittedInformation: contract.permittedInformation,
    forbiddenInformation: contract.forbiddenInformation,
    provenance: contract.feedback.map((row) => ({ id: row.artifactId, kind: 'noisy-task-agent-feedback', observedAt: row.collectedAt, sha256: row.artifactSha256, uri: null })),
    replay: { module: 'src/vnext-hypothesis.mjs', exportName: 'buildVNextHypothesisArtifact', version: 'v1' },
    failure: null,
    payload: {
      contractSha256: contract.contractSha256,
      revisionNumber: contract.revisionNumber,
      hypothesis: valid.output,
      recommendationOnly: true,
      activationAuthority: false
    }
  });
  return artifact.status === 'OK' ? { status: 'OK', artifact: artifact.artifact } : artifact;
}

export async function runVNextHypothesizer({ worker, authority, ...input } = {}) {
  if (typeof worker !== 'function') return refused('HYPOTHESIS_WORKER_REQUIRED', 'A fresh hypothesis worker is required.');
  const built = buildVNextHypothesisContract(input);
  if (built.status !== 'OK') return built;
  let output;
  try {
    output = await worker(deepFreeze({
      contract: built.contract,
      prompt: buildVNextHypothesisPrompt(built.contract)
    }));
  } catch {
    return refused('HYPOTHESIS_WORKER_FAILED', 'Hypothesis worker failed.');
  }
  return buildVNextHypothesisArtifact({ contract: built.contract, output, authority });
}
