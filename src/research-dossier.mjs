import { isSafeId, sha256 } from './util.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact,
  validateVNextStageArtifact
} from './vnext-contracts.mjs';
import { validateVNextEvidenceRecord } from './vnext-evidence-bank.mjs';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from './vnext-model-contracts.mjs';
import { validateVNextFailureArtifact } from './vnext-failure.mjs';

export const VNEXT_RESEARCH_DOSSIER_SCHEMA = 'vnext-research-dossier-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORIES = Object.freeze([
  'failure',
  'architecture-constraint',
  'fact',
  'counterexample',
  'contradiction',
  'uncertainty',
  'unanswered-question'
]);

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

function normalizedText(value, maximum = 4000) {
  const result = String(value ?? '').trim();
  return result && result.length <= maximum && !result.includes('\0') ? result : null;
}

function normalizeStringList(values, maximum = 128) {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const normalized = values.map((value) => normalizedText(value, 2000));
  if (normalized.some((value) => value == null)) return null;
  return [...new Set(normalized)].sort();
}

function hashBoundValue(value, suppliedHash) {
  const digest = sha256(canonicalVNextJson(value));
  if (suppliedHash != null && (!SHA256.test(String(suppliedHash)) || suppliedHash !== digest)) {
    return null;
  }
  return digest;
}

function normalizeFailure(failure, decisionTime) {
  if (!plainObject(failure) || !isSafeId(failure.id)) return null;
  const schemaVersion = normalizedText(failure.schemaVersion, 120);
  const availableAt = failure.availableAt ?? failure.createdAt;
  if (!schemaVersion || !validIso(availableAt) || Date.parse(availableAt) > Date.parse(decisionTime)) {
    return null;
  }
  const content = plainObject(failure.content)
    ? structuredClone(failure.content)
    : Object.fromEntries(Object.entries(failure).filter(([key]) => ![
      'id', 'schemaVersion', 'sha256', 'artifactSha256', 'availableAt', 'createdAt'
    ].includes(key)));
  const bound = { id: failure.id, schemaVersion, availableAt, content };
  const digest = hashBoundValue(bound, failure.sha256 ?? failure.artifactSha256);
  return digest ? { ...bound, sha256: digest } : null;
}

function normalizeInternalEvidence(values, decisionTime, {
  allowFixtureRecords = false
} = {}) {
  if (!Array.isArray(values) || values.length > 512) return null;
  const rows = [];
  for (const value of values) {
    const bankRecord = validateVNextEvidenceRecord(value, { allowFixtureRecords });
    if (bankRecord.status === 'OK') {
      if (!value.verifierEligible || value.lifecycle.quarantined
          || Date.parse(value.availableAt) > Date.parse(decisionTime)) continue;
      rows.push({
        id: value.recordId,
        schemaVersion: value.schemaVersion,
        availableAt: value.availableAt,
        content: structuredClone(value.content),
        verifierEvidenceHashes: [...value.verifierEvidenceHashes],
        sha256: value.recordSha256
      });
      continue;
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeExternalSources(values, { decisionTime, enabled, allowlist }) {
  if (!enabled) return [];
  if (!Array.isArray(values) || values.length > 128 || !Array.isArray(allowlist)) return null;
  const allowedHosts = new Set(allowlist.map((value) => String(value).toLowerCase()));
  if (allowedHosts.size === 0 || [...allowedHosts].some((host) => !host || host.includes('/') || host.includes(':'))) {
    return null;
  }
  const rows = [];
  for (const value of values) {
    if (!plainObject(value) || !isSafeId(value.id) || !validIso(value.retrievedAt)
        || Date.parse(value.retrievedAt) > Date.parse(decisionTime)) return null;
    let url;
    try {
      url = new URL(value.url);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password
        || !allowedHosts.has(url.hostname.toLowerCase())
        || value.authorityClass !== 'primary') return null;
    const title = normalizedText(value.title, 500);
    const content = normalizedText(value.content ?? value.excerpt, 16_000);
    if (!title || !content) return null;
    const contentSha256 = sha256(content);
    if (value.contentSha256 != null && value.contentSha256 !== contentSha256) return null;
    const factIds = Array.isArray(value.factIds) ? [...new Set(value.factIds)].sort() : [];
    if (factIds.some((id) => !isSafeId(id))) return null;
    rows.push({
      id: value.id,
      url: url.toString(),
      title,
      authorityClass: 'primary',
      retrievedAt: value.retrievedAt,
      content,
      contentSha256,
      factIds
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function statementEntries(category, values, sourceIds) {
  return values.map((statement) => {
    const content = { category, statement, sourceIds };
    const itemSha256 = sha256(canonicalVNextJson(content));
    return {
      id: `${category}-${itemSha256.slice(0, 20)}`,
      category,
      statement,
      sourceIds,
      itemSha256
    };
  });
}

function factEntries(values, allowedSourceIds) {
  if (!Array.isArray(values) || values.length > 256) return null;
  const rows = [];
  for (const fact of values) {
    if (!plainObject(fact) || !isSafeId(fact.id)
        || !['high', 'medium', 'low'].includes(fact.confidence)) return null;
    const statement = normalizedText(fact.statement, 2000);
    const sourceIds = Array.isArray(fact.sourceIds) ? [...new Set(fact.sourceIds)].sort() : null;
    if (!statement || !sourceIds || sourceIds.some((id) => !allowedSourceIds.has(id))) return null;
    const content = { category: 'fact', statement, sourceIds, confidence: fact.confidence };
    rows.push({ id: fact.id, ...content, itemSha256: sha256(canonicalVNextJson(content)) });
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return null;
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function fitPayload(base, entries, maximumItems, maximumBytes) {
  const selected = [];
  const payloadFor = (items) => {
    const selectedIds = new Set(items.map((entry) => entry.id));
    const payload = {
      ...base,
      progressiveDisclosure: {
        ...base.progressiveDisclosure,
        omittedItemIds: base.progressiveDisclosure.index
          .filter((row) => !selectedIds.has(row.id))
          .map((row) => row.id)
      },
      items,
      budget: { maximumItems, maximumBytes, itemCount: items.length, payloadBytes: 0 }
    };
    stabilizePayloadBytes(payload);
    return payload;
  };
  for (const entry of entries) {
    if (selected.length >= maximumItems) break;
    const candidate = payloadFor([...selected, entry]);
    if (Buffer.byteLength(canonicalVNextJson(candidate)) <= maximumBytes) selected.push(entry);
  }
  return { payload: payloadFor(selected) };
}

function stabilizePayloadBytes(payload) {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = Buffer.byteLength(canonicalVNextJson(payload));
    payload.budget.payloadBytes = current;
    if (current === previous) break;
    previous = current;
  }
  return Buffer.byteLength(canonicalVNextJson(payload));
}

export function buildResearchDossier(input = {}) {
  const decisionTime = input.decisionTime ?? input.createdAt;
  const maximumItems = input.maximumItems ?? 64;
  const maximumBytes = input.maximumBytes ?? 32_768;
  if (!validIso(decisionTime) || !Number.isInteger(maximumItems) || maximumItems < 1
      || !Number.isInteger(maximumBytes) || maximumBytes < 512) {
    return refused('DOSSIER_BUDGET_INVALID', 'Dossier time and item/byte budgets must be explicit and bounded.');
  }
  const sealedMode = input.sealedMode === true;
  const externalResearchEnabled = input.externalResearchEnabled === true && !sealedMode;
  const researchArtifact = input.researchArtifact == null
    ? null
    : (validateVNextStageArtifact(input.researchArtifact).status === 'OK'
      && input.researchArtifact.stage === VNEXT_STAGE.INTERNAL_RESEARCH
      && input.researchArtifact.status === 'OK'
      && validateVNextModelOutput(
        input.researchArtifact.payload?.research,
        VNEXT_MODEL_SCHEMA.RESEARCH
      ).status === 'OK'
        ? input.researchArtifact
        : undefined);
  if (researchArtifact === undefined
      || (researchArtifact && Date.parse(researchArtifact.createdAt) > Date.parse(decisionTime))) {
    return refused('DOSSIER_RESEARCH_ARTIFACT_INVALID', 'Research artifact must be intact and chronologically available.');
  }
  const failureArtifact = input.failureArtifact == null
    ? null
    : (validateVNextFailureArtifact(input.failureArtifact).status === 'OK'
      && Date.parse(input.failureArtifact.createdAt) <= Date.parse(decisionTime)
        ? input.failureArtifact
        : undefined);
  if (failureArtifact === undefined) {
    return refused('DOSSIER_FAILURE_ARTIFACT_INVALID', 'Normalized failure artifact is invalid or from the future.');
  }
  const failure = failureArtifact
    ? {
        id: failureArtifact.artifactId,
        schemaVersion: failureArtifact.schemaVersion,
        availableAt: failureArtifact.createdAt,
        content: structuredClone(failureArtifact.payload),
        sha256: failureArtifact.artifactSha256
      }
    : normalizeFailure(input.failure, decisionTime);
  const internalEvidence = normalizeInternalEvidence(
    input.internalEvidence ?? [],
    decisionTime,
    { allowFixtureRecords: input.allowFixtureRecords === true }
  );
  const externalSources = normalizeExternalSources(input.externalSources ?? [], {
    decisionTime,
    enabled: externalResearchEnabled,
    allowlist: input.externalSourceAllowlist ?? []
  });
  const architectureConstraints = normalizeStringList(input.architectureConstraints ?? []);
  const researchOutput = researchArtifact?.payload?.research ?? null;
  const counterexamples = normalizeStringList(
    researchOutput?.counterexamples ?? input.counterexamples ?? []
  );
  const contradictions = normalizeStringList(input.contradictions ?? []);
  const uncertainties = normalizeStringList(
    researchOutput?.uncertainties ?? input.uncertainties ?? []
  );
  const unansweredQuestions = normalizeStringList(
    researchOutput?.unansweredQuestions ?? input.unansweredQuestions ?? []
  );
  if (!failure || !internalEvidence || !externalSources || !architectureConstraints
      || !counterexamples || !contradictions || !uncertainties || !unansweredQuestions) {
    return refused('DOSSIER_INPUT_INVALID', 'Dossier inputs failed chronology, integrity, or bounded-content validation.');
  }

  const sourceIds = new Set([
    failure.id,
    ...internalEvidence.map((row) => row.id),
    ...externalSources.map((row) => row.id),
    ...(researchArtifact ? [researchArtifact.artifactId] : [])
  ]);
  const facts = factEntries(researchOutput?.facts ?? input.facts ?? [], sourceIds);
  if (!facts) return refused('DOSSIER_FACT_INVALID', 'Facts must cite only chronologically available normalized sources.');

  const failureStatement = normalizedText(
    input.failureSummary ?? canonicalVNextJson(failure.content),
    4000
  );
  if (!failureStatement) return refused('DOSSIER_FAILURE_INVALID', 'Normalized failure summary is missing or oversized.');

  const entries = [
    ...statementEntries('failure', [failureStatement], [failure.id]),
    ...statementEntries('architecture-constraint', architectureConstraints, []),
    ...facts,
    ...statementEntries(
      'counterexample',
      counterexamples,
      researchArtifact ? [researchArtifact.artifactId] : []
    ),
    ...statementEntries('contradiction', contradictions, []),
    ...statementEntries(
      'uncertainty',
      uncertainties,
      researchArtifact ? [researchArtifact.artifactId] : []
    ),
    ...statementEntries(
      'unanswered-question',
      unansweredQuestions,
      researchArtifact ? [researchArtifact.artifactId] : []
    )
  ].sort((a, b) => {
    const category = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    return category || a.id.localeCompare(b.id);
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    return refused('DOSSIER_ITEM_ID_CONFLICT', 'Dossier item ids must be unique across every disclosure layer.');
  }
  const index = entries.map(({ id, category, itemSha256 }) => ({ id, category, itemSha256 }));
  const base = {
    schemaVersion: VNEXT_RESEARCH_DOSSIER_SCHEMA,
    decisionTime,
    sealedMode,
    externalResearch: {
      requested: input.externalResearchEnabled === true,
      enabled: externalResearchEnabled,
      disabledReason: externalResearchEnabled ? null : (sealedMode ? 'SEALED_MODE' : 'FEATURE_DISABLED')
    },
    sourceIndex: [
      { id: failure.id, kind: 'normalized-failure', availableAt: failure.availableAt, sha256: failure.sha256 },
      ...internalEvidence.map((row) => ({ id: row.id, kind: 'verifier-evidence', availableAt: row.availableAt, sha256: row.sha256 })),
      ...externalSources.map((row) => ({ id: row.id, kind: 'primary-source', availableAt: row.retrievedAt, sha256: row.contentSha256 })),
      ...(researchArtifact ? [{ id: researchArtifact.artifactId, kind: 'fresh-context-research', availableAt: researchArtifact.createdAt, sha256: researchArtifact.artifactSha256 }] : [])
    ],
    progressiveDisclosure: { index, omittedItemIds: [] }
  };
  const fitted = fitPayload(base, entries, maximumItems, maximumBytes);
  const actualBytes = stabilizePayloadBytes(fitted.payload);
  if (actualBytes > maximumBytes) {
    return refused('DOSSIER_BYTE_BUDGET_EXCEEDED', 'The fixed dossier metadata exceeds the exact byte budget.', { actualBytes, maximumBytes });
  }

  const artifact = createVNextStageArtifact({
    stage: VNEXT_STAGE.DOSSIER,
    status: 'OK',
    createdAt: decisionTime,
    authority: input.authority ?? {
      actorId: 'vnext-research-dossier',
      kind: 'deterministic-builder',
      model: null,
      promptSha256: null,
      toolPolicy: 'no-network'
    },
    inputRefs: [
      { id: failure.id, schemaVersion: failure.schemaVersion, sha256: failure.sha256 },
      ...internalEvidence.map((row) => ({ id: row.id, schemaVersion: row.schemaVersion, sha256: row.sha256 })),
      ...(researchArtifact ? [{ id: researchArtifact.artifactId, schemaVersion: researchArtifact.schemaVersion, sha256: researchArtifact.artifactSha256 }] : [])
    ],
    permittedInformation: ['normalized failure', 'verifier-eligible historical evidence', 'public architecture facts', ...(externalResearchEnabled ? ['already-fetched primary sources'] : [])],
    forbiddenInformation: ['final sealed tasks', 'future outcomes', 'hidden evaluator material', 'network access'],
    provenance: fitted.payload.sourceIndex.map((row) => ({
      id: row.id,
      kind: row.kind,
      observedAt: row.availableAt,
      sha256: row.sha256,
      uri: externalSources.find((source) => source.id === row.id)?.url ?? null
    })),
    replay: { module: 'src/research-dossier.mjs', exportName: 'buildResearchDossier', version: 'v1' },
    failure: null,
    payload: fitted.payload
  });
  return artifact.status === 'OK'
    ? deepFreeze({ status: 'OK', artifact: artifact.artifact })
    : artifact;
}


export function validateResearchDossier(artifact) {
  const valid = validateVNextStageArtifact(artifact);
  if (valid.status !== 'OK' || artifact.stage !== VNEXT_STAGE.DOSSIER
      || artifact.payload?.schemaVersion !== VNEXT_RESEARCH_DOSSIER_SCHEMA) {
    return refused('DOSSIER_ARTIFACT_INVALID', 'Research dossier stage artifact is invalid.');
  }
  const bytes = Buffer.byteLength(canonicalVNextJson(artifact.payload));
  if (bytes !== artifact.payload.budget?.payloadBytes
      || bytes > artifact.payload.budget?.maximumBytes
      || artifact.payload.items.length !== artifact.payload.budget?.itemCount
      || artifact.payload.items.length > artifact.payload.budget?.maximumItems) {
    return refused('DOSSIER_BUDGET_MISMATCH', 'Research dossier does not match its exact item and byte receipt.');
  }
  return { status: 'OK', artifact };
}
