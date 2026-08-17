import { isIP } from 'node:net';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { validateVNextFailureArtifact } from './vnext-failure.mjs';
import { validateHybridRetrievalReceipt } from './hybrid-retrieval.mjs';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from './vnext-model-contracts.mjs';
import { createExternalResearchPlan } from './vnext-external-research-worker.mjs';

export const VNEXT_EXTERNAL_RESEARCH_POLICY_SCHEMA =
  'vnext-external-research-policy-v1';
export const VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_SCHEMA =
  'vnext-external-research-discovery-contract-v1';

const SHA256 = /^[a-f0-9]{64}$/;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function publicHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return lower.length > 0
    && lower.length <= 253
    && /^[a-z0-9.-]+$/.test(lower)
    && !lower.startsWith('.')
    && !lower.endsWith('.')
    && !lower.includes('..')
    && lower !== 'localhost'
    && !lower.endsWith('.localhost')
    && !lower.endsWith('.local')
    && isIP(lower) === 0;
}

function policyCore(input) {
  if (!exactKeys(input, [
    'allowlist', 'createdAt', 'maximumPerSourceBytes', 'maximumQueries',
    'maximumSources', 'maximumTotalBytes', 'networkEnabled', 'policyId',
    'sealedMode', 'timeoutMs'
  ])
      || !isSafeId(input.policyId)
      || typeof input.createdAt !== 'string'
      || !Number.isFinite(Date.parse(input.createdAt))
      || input.networkEnabled !== true
      || input.sealedMode !== false
      || !Array.isArray(input.allowlist)
      || input.allowlist.length < 1
      || input.allowlist.length > 64
      || !input.allowlist.every(publicHostname)
      || new Set(input.allowlist.map((host) => host.toLowerCase())).size
        !== input.allowlist.length
      || !Number.isInteger(input.maximumQueries)
      || input.maximumQueries < 1
      || input.maximumQueries > 32
      || !Number.isInteger(input.maximumSources)
      || input.maximumSources < 1
      || input.maximumSources > 32
      || !Number.isInteger(input.maximumPerSourceBytes)
      || input.maximumPerSourceBytes < 1024
      || input.maximumPerSourceBytes > 1024 * 1024
      || !Number.isInteger(input.maximumTotalBytes)
      || input.maximumTotalBytes < input.maximumPerSourceBytes
      || input.maximumTotalBytes > 8 * 1024 * 1024
      || !Number.isInteger(input.timeoutMs)
      || input.timeoutMs < 250
      || input.timeoutMs > 60_000) return null;
  return {
    schemaVersion: VNEXT_EXTERNAL_RESEARCH_POLICY_SCHEMA,
    policyId: input.policyId,
    createdAt: new Date(input.createdAt).toISOString(),
    allowlist: input.allowlist.map((host) => host.toLowerCase()).sort(),
    maximumQueries: input.maximumQueries,
    maximumSources: input.maximumSources,
    maximumPerSourceBytes: input.maximumPerSourceBytes,
    maximumTotalBytes: input.maximumTotalBytes,
    timeoutMs: input.timeoutMs,
    networkEnabled: true,
    sealedMode: false,
    discoveryToolPolicy: 'research-web-read-only',
    activationAuthority: false,
    promotionAuthority: false
  };
}

export function createExternalResearchPolicy(input = {}) {
  if (input.sealedMode === true || input.networkEnabled !== true) {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_POLICY_FORBIDDEN',
      'External research requires an explicitly network-enabled, unsealed policy.'
    );
  }
  const core = policyCore(input);
  return core
    ? { status: 'OK', policy: { ...core, policySha256: sha256(canonicalVNextJson(core)) } }
    : refused('VNEXT_EXTERNAL_RESEARCH_POLICY_INVALID', 'External research policy is invalid or unbounded.');
}

export function validateExternalResearchPolicy(policy) {
  if (!plainObject(policy) || !SHA256.test(String(policy.policySha256 || ''))) {
    return refused('VNEXT_EXTERNAL_RESEARCH_POLICY_INVALID', 'External research policy shape is invalid.');
  }
  const input = structuredClone(policy);
  delete input.schemaVersion;
  delete input.discoveryToolPolicy;
  delete input.activationAuthority;
  delete input.promotionAuthority;
  delete input.policySha256;
  const rebuilt = policyCore(input);
  const actualCore = structuredClone(policy);
  delete actualCore.policySha256;
  return rebuilt
      && canonicalVNextJson(rebuilt) === canonicalVNextJson(actualCore)
      && sha256(canonicalVNextJson(actualCore)) === policy.policySha256
    ? { status: 'OK', policy: structuredClone(policy) }
    : refused('VNEXT_EXTERNAL_RESEARCH_POLICY_TAMPERED', 'External research policy failed semantic or hash replay.');
}

export function buildExternalResearchDiscoveryContract(input = {}) {
  const failure = validateVNextFailureArtifact(input.failureArtifact).status === 'OK'
    ? input.failureArtifact : null;
  const retrieval = validateHybridRetrievalReceipt(input.retrievalArtifact).status === 'OK'
    ? input.retrievalArtifact : null;
  const policy = validateExternalResearchPolicy(input.policy);
  if (!failure || !retrieval || policy.status !== 'OK'
      || typeof input.createdAt !== 'string'
      || !Number.isFinite(Date.parse(input.createdAt))
      || Date.parse(failure.createdAt) > Date.parse(input.createdAt)
      || Date.parse(retrieval.createdAt) > Date.parse(input.createdAt)) {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_INVALID',
      'Research discovery requires chronological failure, retrieval, and policy evidence.'
    );
  }
  const core = {
    schemaVersion: VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_SCHEMA,
    createdAt: new Date(input.createdAt).toISOString(),
    failureRef: { id: failure.artifactId, sha256: failure.artifactSha256 },
    retrievalRef: { id: retrieval.artifactId, sha256: retrieval.artifactSha256 },
    policy: policy.policy,
    normalizedFailure: failure.payload,
    selectedEvidence: retrieval.payload.selection,
    permittedInformation: [
      'normalized failure',
      'eligible selected evidence',
      'public web sources inside the frozen host allowlist'
    ],
    forbiddenInformation: [
      'activation authority',
      'candidate arms',
      'final sealed tasks',
      'future outcomes',
      'hidden evaluator material',
      'local files',
      'shell execution'
    ],
    toolPolicy: 'research-web-read-only',
    activationAuthority: false,
    promotionAuthority: false
  };
  if (Buffer.byteLength(canonicalVNextJson(core)) > 512 * 1024) {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_TOO_LARGE',
      'Research discovery context exceeds its byte ceiling.'
    );
  }
  return {
    status: 'OK',
    contract: { ...core, contractSha256: sha256(canonicalVNextJson(core)) }
  };
}

export function validateExternalResearchDiscoveryContract(contract) {
  if (!exactKeys(contract, [
    'activationAuthority', 'contractSha256', 'createdAt', 'failureRef',
    'forbiddenInformation', 'normalizedFailure', 'permittedInformation',
    'policy', 'promotionAuthority', 'retrievalRef', 'schemaVersion',
    'selectedEvidence', 'toolPolicy'
  ])
      || contract.schemaVersion !== VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_SCHEMA
      || !Number.isFinite(Date.parse(contract.createdAt))
      || !exactKeys(contract.failureRef, ['id', 'sha256'])
      || !exactKeys(contract.retrievalRef, ['id', 'sha256'])
      || !isSafeId(contract.failureRef.id)
      || !isSafeId(contract.retrievalRef.id)
      || !SHA256.test(String(contract.failureRef.sha256 || ''))
      || !SHA256.test(String(contract.retrievalRef.sha256 || ''))
      || !Array.isArray(contract.selectedEvidence)
      || !Array.isArray(contract.permittedInformation)
      || !Array.isArray(contract.forbiddenInformation)
      || contract.toolPolicy !== 'research-web-read-only'
      || contract.activationAuthority !== false
      || contract.promotionAuthority !== false
      || !SHA256.test(String(contract.contractSha256 || ''))
      || validateExternalResearchPolicy(contract.policy).status !== 'OK') {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_INVALID',
      'Research discovery contract shape or authority is invalid.'
    );
  }
  const core = structuredClone(contract);
  delete core.contractSha256;
  return sha256(canonicalVNextJson(core)) === contract.contractSha256
    ? { status: 'OK', contract }
    : refused(
        'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_CONTRACT_TAMPERED',
        'Research discovery contract hash changed.'
      );
}

export function buildExternalResearchDiscoveryPrompt(contract) {
  if (validateExternalResearchDiscoveryContract(contract).status !== 'OK') return null;
  return [
    'Investigate the normalized failure using public primary sources only.',
    'You may use only the research web tools. Do not use shell, local files, plugins, subagents, or application state.',
    `Every proposed source hostname must exactly match one of: ${contract.policy.allowlist.join(', ')}.`,
    `Return at most ${contract.policy.maximumQueries} unique search queries and ${contract.policy.maximumSources} unique sources.`,
    'Prefer official papers, official repositories, standards, and authoritative technical documentation.',
    'Return strict JSON matching vnext-external-research-discovery-output-v1.',
    'Abstain when no relevant primary source can be located. You have no mutation, scoring, admission, activation, or deployment authority.',
    '',
    canonicalVNextJson(contract)
  ].join('\n');
}

export function materializeExternalResearchPlan({
  contract,
  output,
  planId,
  createdAt
} = {}) {
  if (validateExternalResearchDiscoveryContract(contract).status !== 'OK'
      || !isSafeId(planId)
      || typeof createdAt !== 'string'
      || !Number.isFinite(Date.parse(createdAt))) {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_INPUT_INVALID',
      'Research plan materialization requires a verified discovery contract and frozen identity.'
    );
  }
  const checked = validateVNextModelOutput(
    output,
    VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY
  );
  if (checked.status !== 'OK') return checked;
  if (checked.output.abstain) {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_ABSTAINED',
      checked.output.abstainReason,
      { output: checked.output }
    );
  }
  const policy = contract.policy;
  const allowed = new Set(policy.allowlist);
  if (checked.output.queries.length > policy.maximumQueries
      || checked.output.sources.length > policy.maximumSources
      || checked.output.sources.some((source) => {
        try { return !allowed.has(new URL(source.url).hostname.toLowerCase()); } catch { return true; }
      })) {
    return refused(
      'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_OUTSIDE_POLICY',
      'Research discovery output escaped the frozen query, source, or host bounds.'
    );
  }
  return createExternalResearchPlan({
    planId,
    createdAt,
    failureSha256: contract.failureRef.sha256,
    retrievalSha256: contract.retrievalRef.sha256,
    queries: checked.output.queries,
    allowlist: policy.allowlist,
    sources: checked.output.sources,
    maximumSources: policy.maximumSources,
    maximumPerSourceBytes: policy.maximumPerSourceBytes,
    maximumTotalBytes: policy.maximumTotalBytes,
    timeoutMs: policy.timeoutMs,
    networkEnabled: true,
    sealedMode: false
  });
}
