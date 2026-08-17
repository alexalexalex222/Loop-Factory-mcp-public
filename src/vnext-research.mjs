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
import { validateVNextFailureArtifact } from './vnext-failure.mjs';
import { validateHybridRetrievalReceipt } from './hybrid-retrieval.mjs';
import {
  VNEXT_EXTERNAL_RESEARCH_EVIDENCE_SCHEMA,
  verifyExternalResearchPortableEvidence
} from './vnext-external-research-worker.mjs';
import { validateVNextAblationProfile } from './vnext-ablation-profile.mjs';

export const VNEXT_EXTERNAL_RESEARCH_SCHEMA = 'vnext-external-research-v1';
export const VNEXT_RESEARCH_CONTRACT_SCHEMA = 'vnext-research-contract-v1';

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

function sourceRows(values, createdAt, allowlist) {
  if (!Array.isArray(values) || values.length > 64 || !Array.isArray(allowlist)) return null;
  const hosts = new Set(allowlist.map((value) => String(value).toLowerCase()));
  if ([...hosts].some((host) => !host || host.includes('/') || host.includes(':'))) return null;
  const rows = values.map((source) => {
    let url;
    try {
      url = new URL(source?.url);
    } catch {
      return null;
    }
    const content = typeof source.content === 'string' ? source.content.trim() : '';
    const contentSha256 = sha256(content);
    if (!plainObject(source) || !isSafeId(source.id)
        || source.authorityClass !== 'primary'
        || url.protocol !== 'https:' || url.username || url.password
        || !hosts.has(url.hostname.toLowerCase())
        || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 500
        || !content || content.length > 32_000
        || typeof source.retrievedAt !== 'string'
        || !Number.isFinite(Date.parse(source.retrievedAt))
        || Date.parse(source.retrievedAt) > Date.parse(createdAt)
        || source.contentSha256 !== contentSha256) return null;
    return {
      id: source.id,
      url: url.toString(),
      title: source.title.trim(),
      authorityClass: 'primary',
      retrievedAt: source.retrievedAt,
      content,
      contentSha256
    };
  });
  if (rows.some((row) => row == null)) return null;
  rows.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(rows.map(({ id }) => id)).size !== rows.length
      || Buffer.byteLength(canonicalVNextJson(rows)) > 256 * 1024) return null;
  return rows;
}

export function freezeExternalResearch(input = {}) {
  const createdAt = input.createdAt;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    return refused('EXTERNAL_RESEARCH_TIME_INVALID', 'External research requires a frozen decision time.');
  }
  const sealedMode = input.sealedMode === true;
  if (sealedMode && (input.sources?.length ?? 0) > 0) {
    return refused('EXTERNAL_RESEARCH_SEALED', 'External sources are forbidden during sealed evaluation.');
  }
  const enabled = input.enabled === true && !sealedMode;
  const sources = enabled
    ? sourceRows(input.sources ?? [], createdAt, input.allowlist ?? [])
    : [];
  if (!sources) return refused('EXTERNAL_RESEARCH_SOURCE_INVALID', 'External research sources failed primary-source provenance checks.');
  const payload = {
    schemaVersion: VNEXT_EXTERNAL_RESEARCH_SCHEMA,
    requested: input.enabled === true,
    enabled,
    sealedMode,
    disabledReason: enabled ? null : (sealedMode ? 'SEALED_MODE' : 'FEATURE_DISABLED'),
    sources,
    networkFetchPerformedByStage: false,
    fetchPlanSha256: null,
    fetchReceiptSha256: null,
    fetchEvidenceSha256: null,
    activationAuthority: false
  };
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.EXTERNAL_RESEARCH,
    status: 'OK',
    createdAt,
    authority: input.authority ?? {
      actorId: 'vnext-external-research-freezer',
      kind: 'deterministic-source-freezer',
      model: null,
      promptSha256: null,
      toolPolicy: 'no-network'
    },
    inputRefs: sources.map((source) => ({
      id: source.id,
      schemaVersion: 'primary-source-capture-v1',
      sha256: source.contentSha256
    })),
    permittedInformation: enabled ? ['already-fetched primary sources'] : [],
    forbiddenInformation: ['final sealed tasks', 'hidden evaluator material', 'live network access'],
    provenance: sources.map((source) => ({
      id: source.id,
      kind: 'primary-source',
      observedAt: source.retrievedAt,
      sha256: source.contentSha256,
      uri: source.url
    })),
    replay: { module: 'src/vnext-research.mjs', exportName: 'freezeExternalResearch', version: 'v1' },
    failure: null,
    payload
  });
  return artifact.status === 'OK' ? { status: 'OK', artifact: artifact.artifact } : artifact;
}

export function freezeVerifiedExternalResearch({ evidence } = {}) {
  const replay = verifyExternalResearchPortableEvidence(evidence);
  if (replay.status !== 'OK') {
    return refused(
      'EXTERNAL_RESEARCH_FETCH_EVIDENCE_INVALID',
      'External research must replay from exact captured network bytes.'
    );
  }
  const { plan, receipt } = replay;
  const sources = receipt.sources.map((source) => ({
    id: source.id,
    url: source.url,
    title: source.title,
    authorityClass: 'primary',
    retrievedAt: source.retrievedAt,
    content: source.content,
    contentSha256: source.contentSha256
  }));
  const payload = {
    schemaVersion: VNEXT_EXTERNAL_RESEARCH_SCHEMA,
    requested: true,
    enabled: true,
    sealedMode: false,
    disabledReason: null,
    sources,
    networkFetchPerformedByStage: true,
    fetchPlanSha256: plan.planSha256,
    fetchReceiptSha256: receipt.receiptSha256,
    fetchEvidenceSha256: replay.evidenceSha256,
    activationAuthority: false
  };
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.EXTERNAL_RESEARCH,
    status: 'OK',
    createdAt: receipt.fetchedAt,
    authority: {
      actorId: 'vnext-external-research-fetch-verifier',
      kind: 'deterministic-network-evidence-replay',
      model: null,
      promptSha256: null,
      toolPolicy: 'captured-by-network-worker-replayed-without-network'
    },
    inputRefs: [
      {
        id: plan.planId,
        schemaVersion: plan.schemaVersion,
        sha256: plan.planSha256
      },
      {
        id: `${plan.planId}-fetch`,
        schemaVersion: receipt.schemaVersion,
        sha256: receipt.receiptSha256
      },
      ...receipt.sources.map((source) => ({
        id: source.id,
        schemaVersion: 'primary-source-capture-v1',
        sha256: source.rawSha256
      }))
    ],
    permittedInformation: ['verifier-replayed primary-source captures'],
    forbiddenInformation: [
      'final sealed tasks',
      'hidden evaluator material',
      'uncaptured network content'
    ],
    provenance: receipt.sources.map((source) => ({
      id: source.id,
      kind: 'primary-source-network-capture',
      observedAt: source.retrievedAt,
      sha256: source.rawSha256,
      uri: source.url
    })),
    replay: {
      module: 'src/vnext-research.mjs',
      exportName: 'freezeVerifiedExternalResearch',
      version: 'v1'
    },
    failure: null,
    payload
  });
  return artifact.status === 'OK'
    ? {
        status: 'OK',
        artifact: artifact.artifact,
        evidenceSchemaVersion: VNEXT_EXTERNAL_RESEARCH_EVIDENCE_SCHEMA
      }
    : artifact;
}

export function validateExternalResearchArtifact(artifact) {
  const valid = validateVNextStageArtifact(artifact);
  const payload = artifact?.payload;
  const captureHashesValid = payload?.networkFetchPerformedByStage === true
    ? [payload.fetchPlanSha256, payload.fetchReceiptSha256,
      payload.fetchEvidenceSha256].every((value) => SHA256.test(String(value || '')))
    : payload?.fetchPlanSha256 === null
      && payload?.fetchReceiptSha256 === null
      && payload?.fetchEvidenceSha256 === null;
  return valid.status === 'OK'
    && artifact.stage === VNEXT_STAGE.EXTERNAL_RESEARCH
    && payload?.schemaVersion === VNEXT_EXTERNAL_RESEARCH_SCHEMA
    && payload.activationAuthority === false
    && typeof payload.networkFetchPerformedByStage === 'boolean'
    && captureHashesValid
    ? artifact
    : null;
}

export function buildResearchSynthesisContract(input = {}) {
  const failure = validateVNextFailureArtifact(input.failureArtifact).status === 'OK'
    ? input.failureArtifact : null;
  const retrieval = validateHybridRetrievalReceipt(input.retrievalArtifact).status === 'OK'
    ? input.retrievalArtifact : null;
  const external = validateExternalResearchArtifact(input.externalResearchArtifact);
  if (!failure || !retrieval || !external
      || typeof input.createdAt !== 'string'
      || !Number.isFinite(Date.parse(input.createdAt))
      || [failure.createdAt, retrieval.createdAt, external.createdAt]
        .some((createdAt) => Date.parse(createdAt) > Date.parse(input.createdAt))
      || !plainObject(input.architectureFacts)) {
    return refused('RESEARCH_CONTRACT_INVALID', 'Research synthesis requires frozen failure, retrieval, external-source, and architecture artifacts.');
  }
  const architectureCanonical = canonicalVNextJson(input.architectureFacts);
  if (Buffer.byteLength(architectureCanonical) > 32 * 1024) {
    return refused('RESEARCH_ARCHITECTURE_TOO_LARGE', 'Architecture facts exceed the bounded research context.');
  }
  const sourceIds = [...new Set([
    failure.artifactId,
    ...retrieval.payload.selection.map(({ recordId }) => recordId),
    ...external.payload.sources.map(({ id }) => id)
  ])].sort();
  const core = {
    schemaVersion: VNEXT_RESEARCH_CONTRACT_SCHEMA,
    createdAt: input.createdAt,
    failureRef: { id: failure.artifactId, sha256: failure.artifactSha256 },
    retrievalRef: { id: retrieval.artifactId, sha256: retrieval.artifactSha256 },
    externalResearchRef: { id: external.artifactId, sha256: external.artifactSha256 },
    failure: failure.payload,
    selectedEvidence: retrieval.payload.selection,
    externalSources: external.payload.sources,
    architectureFacts: structuredClone(input.architectureFacts),
    allowedSourceIds: sourceIds,
    permittedInformation: ['normalized failure', 'eligible selected evidence', 'already-fetched primary sources', 'public architecture facts'],
    forbiddenInformation: ['activation authority', 'arm labels', 'final sealed tasks', 'future outcomes', 'hidden evaluator material'],
    activationAuthority: false
  };
  if (Buffer.byteLength(canonicalVNextJson(core)) > 512 * 1024) {
    return refused('RESEARCH_CONTRACT_TOO_LARGE', 'Research synthesis context exceeds the hard byte ceiling.');
  }
  return {
    status: 'OK',
    contract: deepFreeze({
      ...core,
      contractSha256: sha256(canonicalVNextJson(core))
    })
  };
}

export function validateResearchSynthesisContract(contract) {
  if (!plainObject(contract) || contract.schemaVersion !== VNEXT_RESEARCH_CONTRACT_SCHEMA
      || !SHA256.test(String(contract.contractSha256 || ''))) {
    return refused('RESEARCH_CONTRACT_INVALID', 'Research synthesis contract shape is invalid.');
  }
  const core = structuredClone(contract);
  delete core.contractSha256;
  return sha256(canonicalVNextJson(core)) === contract.contractSha256
    && contract.activationAuthority === false
    ? { status: 'OK', contract }
    : refused('RESEARCH_CONTRACT_TAMPERED', 'Research synthesis contract failed replay.');
}

export function buildResearchSynthesisPrompt(contract) {
  if (validateResearchSynthesisContract(contract).status !== 'OK') return null;
  return [
    'Research the observed failure using only this frozen context.',
    'Return strict JSON matching vnext-research-output-v1.',
    'Facts must cite only allowedSourceIds. Separate known facts from counterexamples, uncertainties, and unanswered questions.',
    'You have no mutation, scoring, admission, activation, or deployment authority.',
    '',
    canonicalVNextJson(contract)
  ].join('\n');
}

export function buildResearchSynthesisArtifact({ contract, output, authority } = {}) {
  if (validateResearchSynthesisContract(contract).status !== 'OK') {
    return refused('RESEARCH_CONTRACT_INVALID', 'Research synthesis contract failed replay.');
  }
  const validated = validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.RESEARCH);
  const allowed = new Set(contract.allowedSourceIds);
  if (validated.status !== 'OK'
      || validated.output.facts.some((fact) => fact.sourceIds.length === 0
        || fact.sourceIds.some((id) => !allowed.has(id)))) {
    return refused('RESEARCH_OUTPUT_INVALID', 'Research output is invalid or cites evidence outside the frozen context.');
  }
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.INTERNAL_RESEARCH,
    status: 'OK',
    createdAt: contract.createdAt,
    authority: authority ?? {
      actorId: 'vnext-research-synthesizer',
      kind: 'fresh-context-worker',
      model: null,
      promptSha256: sha256(buildResearchSynthesisPrompt(contract)),
      toolPolicy: 'none'
    },
    inputRefs: [
      { id: contract.failureRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.failureRef.sha256 },
      { id: contract.retrievalRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.retrievalRef.sha256 },
      { id: contract.externalResearchRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.externalResearchRef.sha256 }
    ],
    permittedInformation: contract.permittedInformation,
    forbiddenInformation: contract.forbiddenInformation,
    provenance: [],
    replay: { module: 'src/vnext-research.mjs', exportName: 'buildResearchSynthesisArtifact', version: 'v1' },
    failure: null,
    payload: {
      contractSha256: contract.contractSha256,
      research: validated.output,
      recommendationOnly: true,
      activationAuthority: false
    }
  });
  return artifact.status === 'OK' ? { status: 'OK', artifact: artifact.artifact } : artifact;
}

export function buildAblationBaselineResearchArtifact({ contract, profile } = {}) {
  if (validateResearchSynthesisContract(contract).status !== 'OK'
      || validateVNextAblationProfile(profile).status !== 'OK'
      || profile.internalResearchEnabled !== false) {
    return refused(
      'RESEARCH_ABLATION_BASELINE_INVALID',
      'A deterministic research baseline requires one intact profile with internal research disabled.'
    );
  }
  const output = {
    schemaVersion: VNEXT_MODEL_SCHEMA.RESEARCH,
    facts: [],
    counterexamples: [],
    uncertainties: [],
    unansweredQuestions: []
  };
  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.INTERNAL_RESEARCH,
    status: 'OK',
    createdAt: contract.createdAt,
    authority: {
      actorId: `vnext-ablation-${profile.armId.toLowerCase()}-research`,
      kind: 'deterministic-ablation-baseline',
      model: null,
      promptSha256: null,
      toolPolicy: 'none'
    },
    inputRefs: [
      { id: contract.failureRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.failureRef.sha256 },
      { id: contract.retrievalRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.retrievalRef.sha256 },
      { id: contract.externalResearchRef.id, schemaVersion: 'loop-factory-vnext-stage-envelope-v1', sha256: contract.externalResearchRef.sha256 },
      { id: `ablation-${profile.armId.toLowerCase()}`, schemaVersion: profile.schemaVersion, sha256: profile.profileSha256 }
    ],
    permittedInformation: contract.permittedInformation,
    forbiddenInformation: contract.forbiddenInformation,
    provenance: [],
    replay: {
      module: 'src/vnext-research.mjs',
      exportName: 'buildAblationBaselineResearchArtifact',
      version: 'v1'
    },
    failure: null,
    payload: {
      contractSha256: contract.contractSha256,
      ablationProfileSha256: profile.profileSha256,
      researchDisabled: true,
      research: output,
      recommendationOnly: true,
      activationAuthority: false
    }
  });
  return artifact.status === 'OK'
    ? { status: 'OK', artifact: artifact.artifact }
    : artifact;
}

export async function runResearchSynthesis({ worker, authority, ...input } = {}) {
  if (typeof worker !== 'function') return refused('RESEARCH_WORKER_REQUIRED', 'A fresh research worker is required.');
  const built = buildResearchSynthesisContract(input);
  if (built.status !== 'OK') return built;
  let output;
  try {
    output = await worker(deepFreeze({
      contract: built.contract,
      prompt: buildResearchSynthesisPrompt(built.contract)
    }));
  } catch {
    return refused('RESEARCH_WORKER_FAILED', 'Research synthesis worker failed.');
  }
  return buildResearchSynthesisArtifact({ contract: built.contract, output, authority });
}
