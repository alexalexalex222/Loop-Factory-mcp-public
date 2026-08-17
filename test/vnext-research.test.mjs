import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVNextFailure } from '../src/vnext-failure.mjs';
import {
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority
} from '../src/vnext-evidence-bank.mjs';
import { buildHybridRetrieval } from '../src/hybrid-retrieval.mjs';
import {
  buildResearchSynthesisArtifact,
  buildResearchSynthesisContract,
  freezeExternalResearch
} from '../src/vnext-research.mjs';

const NOW = '2026-08-05T02:00:00.000Z';
const FUTURE = '2026-08-05T02:00:01.000Z';
const FIXTURE_AUTHORITY = createVNextFixtureEvidenceAuthority('vnext-research-tests').authority;

function failure() {
  return normalizeVNextFailure({
    failureId: 'failure-1', observedAt: NOW, summary: 'Negative precedent omitted.',
    behavior: 'retrieval', component: 'retrieval', symptoms: ['missing warning'],
    environment: { model: 'gpt-5.6-sol' },
    sourceEvidence: [{ id: 'source-1', schemaVersion: 'measurement-v1', sha256: 'a'.repeat(64), availableAt: NOW, locator: 'proof/run.json#failure' }]
  }).artifact;
}

function evidence() {
  return createVNextEvidenceRecord({
    recordId: 'evidence-1', kind: 'regression', availableAt: NOW, createdAt: NOW,
    sourceIds: ['source-1'], verifierEvidenceHashes: ['b'.repeat(64)],
    authority: FIXTURE_AUTHORITY,
    compatibility: { domains: [], tags: ['negative'], component: 'retrieval', schemaVersions: [], models: [], harnessSha256s: [], toolEnvironmentSha256s: [], permissions: [], securityRequirements: [], versionConstraints: [] },
    lifecycle: { state: 'replicated', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: -0.1, costUsd: 0, latencyMs: 1, tokenCost: 1, uncertainty: 0.1 },
    content: { statement: 'Omitting contradictions regressed transfer.' }, callerClaims: {}
  }, { allowFixtureRecords: true }).record;
}

async function fixtures() {
  const retrieval = await buildHybridRetrieval({
    records: [evidence()],
    query: { summary: 'negative precedent omitted' },
    queryAt: NOW,
    allowFixtureRecords: true
  });
  const external = freezeExternalResearch({
    createdAt: NOW, enabled: true, sealedMode: false, allowlist: ['example.org'],
    sources: [{ id: 'paper-1', url: 'https://example.org/paper', title: 'Primary paper', authorityClass: 'primary', retrievedAt: NOW, content: 'Primary evidence.', contentSha256: '8be907dbe38ff1cda481b249cae99da990b2265b400fc6e3e11da2b290386cc7' }]
  });
  return { retrieval: retrieval.artifact, external: external.artifact };
}

test('research contracts bind failure, retrieval, and primary sources', async () => {
  const { retrieval, external } = await fixtures();
  const built = buildResearchSynthesisContract({ createdAt: NOW, failureArtifact: failure(), retrievalArtifact: retrieval, externalResearchArtifact: external, architectureFacts: { router: 'deterministic hard filter' } });
  assert.equal(built.status, 'OK');
  const output = {
    schemaVersion: 'vnext-research-output-v1',
    facts: [{ id: 'fact-1', statement: 'A negative precedent exists.', confidence: 'high', sourceIds: ['evidence-1'] }],
    counterexamples: ['A task may have no compatible negative evidence.'],
    uncertainties: ['Transfer depends on environment compatibility.'],
    unansweredQuestions: ['Does the same mechanism transfer?']
  };
  const artifact = buildResearchSynthesisArtifact({ contract: built.contract, output });
  assert.equal(artifact.status, 'OK');
  assert.equal(artifact.artifact.payload.activationAuthority, false);
});

test('sealed external research and hallucinated source ids fail closed', async () => {
  assert.equal(freezeExternalResearch({ createdAt: NOW, enabled: true, sealedMode: true, sources: [{ id: 'x' }] }).status, 'REFUSED');
  const { retrieval, external } = await fixtures();
  const built = buildResearchSynthesisContract({ createdAt: NOW, failureArtifact: failure(), retrievalArtifact: retrieval, externalResearchArtifact: external, architectureFacts: {} });
  const invalid = buildResearchSynthesisArtifact({
    contract: built.contract,
    output: { schemaVersion: 'vnext-research-output-v1', facts: [{ id: 'fact-1', statement: 'Invented.', confidence: 'high', sourceIds: ['future'] }], counterexamples: [], uncertainties: [], unansweredQuestions: [] }
  });
  assert.equal(invalid.status, 'REFUSED');
});

test('research contracts reject future failure, retrieval, and external artifacts', async () => {
  const current = await fixtures();
  const futureFailure = normalizeVNextFailure({
    failureId: 'future-failure', observedAt: FUTURE,
    summary: 'Future failure.', behavior: 'retrieval', component: 'retrieval',
    symptoms: ['future'], environment: {},
    sourceEvidence: [{
      id: 'future-source', schemaVersion: 'measurement-v1',
      sha256: 'f'.repeat(64), availableAt: FUTURE,
      locator: 'proof/future.json#failure'
    }]
  }).artifact;
  assert.equal(buildResearchSynthesisContract({
    createdAt: NOW, failureArtifact: futureFailure,
    retrievalArtifact: current.retrieval,
    externalResearchArtifact: current.external,
    architectureFacts: {}
  }).status, 'REFUSED');

  const futureRetrieval = await buildHybridRetrieval({
    records: [evidence()], query: { summary: 'negative precedent omitted' },
    queryAt: FUTURE, allowFixtureRecords: true
  });
  assert.equal(buildResearchSynthesisContract({
    createdAt: NOW, failureArtifact: failure(),
    retrievalArtifact: futureRetrieval.artifact,
    externalResearchArtifact: current.external,
    architectureFacts: {}
  }).status, 'REFUSED');

  const futureExternal = freezeExternalResearch({
    createdAt: FUTURE, enabled: false, sealedMode: false
  });
  assert.equal(buildResearchSynthesisContract({
    createdAt: NOW, failureArtifact: failure(),
    retrievalArtifact: current.retrieval,
    externalResearchArtifact: futureExternal.artifact,
    architectureFacts: {}
  }).status, 'REFUSED');
});
