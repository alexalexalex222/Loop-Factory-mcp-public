import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVNextFailure } from '../src/vnext-failure.mjs';
import { buildHybridRetrieval } from '../src/hybrid-retrieval.mjs';
import {
  buildExternalResearchDiscoveryContract,
  buildExternalResearchDiscoveryPrompt,
  createExternalResearchPolicy,
  materializeExternalResearchPlan,
  validateExternalResearchDiscoveryContract,
  validateExternalResearchPolicy
} from '../src/vnext-external-research.mjs';

const NOW = '2026-08-05T12:00:00.000Z';

async function context() {
  const failure = normalizeVNextFailure({
    failureId: 'failure-research',
    observedAt: NOW,
    summary: 'The router misses structurally similar negative precedents.',
    behavior: 'retrieval',
    component: 'retrieval',
    symptoms: ['lexical-only matching misses related failures'],
    environment: { model: 'gpt-5.6-sol' },
    sourceEvidence: [{
      id: 'source-failure',
      schemaVersion: 'measurement-v1',
      sha256: 'a'.repeat(64),
      availableAt: NOW,
      locator: 'proof/retrieval.json#failure'
    }]
  });
  const retrieval = await buildHybridRetrieval({
    records: [],
    query: { summary: 'structurally similar negative precedent retrieval' },
    queryAt: NOW,
    allowFixtureRecords: true
  });
  return { failure: failure.artifact, retrieval: retrieval.artifact };
}

function policyInput(overrides = {}) {
  return {
    policyId: 'research-policy-1',
    createdAt: NOW,
    allowlist: ['arxiv.org', 'github.com'],
    maximumQueries: 4,
    maximumSources: 3,
    maximumPerSourceBytes: 64 * 1024,
    maximumTotalBytes: 128 * 1024,
    timeoutMs: 5000,
    networkEnabled: true,
    sealedMode: false,
    ...overrides
  };
}

function discoveryOutput(overrides = {}) {
  return {
    schemaVersion: 'vnext-external-research-discovery-output-v1',
    abstain: false,
    abstainReason: null,
    searchSummary: 'An official paper describes evidence-aware retrieval.',
    queries: ['site:arxiv.org evidence aware retrieval agents'],
    sources: [{
      sourceId: 'source-paper',
      url: 'https://arxiv.org/abs/2501.00001',
      title: 'Primary Research Paper',
      reason: 'Primary paper addressing retrieval behavior.',
      authorityClass: 'primary'
    }],
    uncertainties: ['Transfer to this harness must be measured.'],
    ...overrides
  };
}

test('research discovery binds a web-only model context to deterministic fetch policy', async () => {
  const artifacts = await context();
  const policy = createExternalResearchPolicy(policyInput());
  assert.equal(policy.status, 'OK');
  assert.equal(validateExternalResearchPolicy(policy.policy).status, 'OK');
  const built = buildExternalResearchDiscoveryContract({
    createdAt: NOW,
    failureArtifact: artifacts.failure,
    retrievalArtifact: artifacts.retrieval,
    policy: policy.policy
  });
  assert.equal(built.status, 'OK');
  assert.equal(validateExternalResearchDiscoveryContract(built.contract).status, 'OK');
  assert.match(buildExternalResearchDiscoveryPrompt(built.contract), /research web tools/);
  const plan = materializeExternalResearchPlan({
    contract: built.contract,
    output: discoveryOutput(),
    planId: 'external-research-1',
    createdAt: NOW
  });
  assert.equal(plan.status, 'OK');
  assert.equal(plan.plan.failureSha256, artifacts.failure.artifactSha256);
  assert.equal(plan.plan.retrievalSha256, artifacts.retrieval.artifactSha256);
  assert.equal(plan.plan.activationAuthority, false);
});

test('research discovery rejects private policy, host escape, abstention, and hash resealing', async () => {
  assert.equal(createExternalResearchPolicy(policyInput({
    allowlist: ['127.0.0.1']
  })).status, 'REFUSED');
  const artifacts = await context();
  const policy = createExternalResearchPolicy(policyInput()).policy;
  const built = buildExternalResearchDiscoveryContract({
    createdAt: NOW,
    failureArtifact: artifacts.failure,
    retrievalArtifact: artifacts.retrieval,
    policy
  });
  assert.equal(materializeExternalResearchPlan({
    contract: built.contract,
    output: discoveryOutput({
      sources: [{
        sourceId: 'escaped-source',
        url: 'https://example.com/paper',
        title: 'Outside allowlist',
        reason: 'Must be rejected.',
        authorityClass: 'primary'
      }]
    }),
    planId: 'escaped-plan',
    createdAt: NOW
  }).status, 'REFUSED');
  assert.equal(materializeExternalResearchPlan({
    contract: built.contract,
    output: discoveryOutput({
      abstain: true,
      abstainReason: 'No primary source found.',
      sources: []
    }),
    planId: 'abstained-plan',
    createdAt: NOW
  }).code, 'VNEXT_EXTERNAL_RESEARCH_DISCOVERY_ABSTAINED');
  const tampered = structuredClone(policy);
  tampered.maximumSources = 32;
  tampered.policySha256 = '0'.repeat(64);
  assert.equal(validateExternalResearchPolicy(tampered).status, 'REFUSED');
});
