import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalVNextJson, validateVNextStageArtifact } from '../src/vnext-contracts.mjs';
import { buildResearchDossier, validateResearchDossier } from '../src/research-dossier.mjs';
import {
  createVNextEvidenceRecord,
  createVNextFixtureEvidenceAuthority
} from '../src/vnext-evidence-bank.mjs';

const NOW = '2026-08-05T00:00:00.000Z';
const FIXTURE_AUTHORITY = createVNextFixtureEvidenceAuthority('research-dossier-tests').authority;

function fixtureEvidence(recordId, availableAt, content, hashCharacter = 'a') {
  return createVNextEvidenceRecord({
    recordId,
    kind: 'failure',
    availableAt,
    createdAt: availableAt,
    sourceIds: [`source-${recordId}`],
    verifierEvidenceHashes: [hashCharacter.repeat(64)],
    authority: FIXTURE_AUTHORITY,
    compatibility: {
      domains: ['routing'], tags: ['negative'], component: 'retrieval',
      schemaVersions: ['failure-v1'], models: [], harnessSha256s: [],
      toolEnvironmentSha256s: [], permissions: [], securityRequirements: [],
      versionConstraints: []
    },
    lifecycle: { state: 'replicated', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: null, costUsd: 0, latencyMs: 1, tokenCost: 1, uncertainty: 0.2 },
    content,
    callerClaims: {}
  }, { allowFixtureRecords: true }).record;
}

function baseInput(overrides = {}) {
  return {
    createdAt: NOW,
    decisionTime: NOW,
    failure: {
      id: 'failure-1',
      schemaVersion: 'normalized-failure-v1',
      availableAt: '2026-08-04T23:00:00.000Z',
      content: { summary: 'retrieval omitted a negative precedent' }
    },
    failureSummary: 'retrieval omitted a negative precedent',
    internalEvidence: [fixtureEvidence(
      'evidence-old',
      '2026-08-04T23:30:00.000Z',
      { finding: 'reserve one negative precedent' }
    )],
    allowFixtureRecords: true,
    architectureConstraints: ['reranking cannot change eligibility'],
    facts: [{
      id: 'fact-1',
      statement: 'negative evidence is verifier eligible',
      sourceIds: ['evidence-old'],
      confidence: 'high'
    }],
    counterexamples: ['a positive-only query can hide a regression'],
    contradictions: ['caller aggregate claims are not verifier evidence'],
    uncertainties: ['transfer behavior is not yet measured'],
    unansweredQuestions: ['which pathology cell is closest'],
    maximumItems: 32,
    maximumBytes: 16_000,
    ...overrides
  };
}

test('dossier excludes chronologically unavailable internal evidence', () => {
  const input = baseInput();
  input.internalEvidence.push(fixtureEvidence(
    'evidence-future',
    '2026-08-05T00:00:01.000Z',
    { future: true },
    'b'
  ));
  const result = buildResearchDossier(input);
  assert.equal(result.status, 'OK');
  assert.deepEqual(
    result.artifact.payload.sourceIndex.map((row) => row.id),
    ['failure-1', 'evidence-old']
  );
  assert.equal(validateVNextStageArtifact(result.artifact).status, 'OK');
});

test('dossier consumes intact verifier-eligible evidence-bank records directly', () => {
  const bankRecord = createVNextEvidenceRecord({
    recordId: 'bank-evidence-1',
    kind: 'failure',
    availableAt: '2026-08-04T23:30:00.000Z',
    createdAt: NOW,
    sourceIds: ['measurement-1'],
    verifierEvidenceHashes: ['d'.repeat(64)],
    authority: FIXTURE_AUTHORITY,
    compatibility: { domains: ['routing'], tags: ['negative'], component: 'retrieval', schemaVersions: ['failure-v1'] },
    lifecycle: { state: 'replicated', quarantined: false, quarantineReason: null },
    metrics: { qualityDelta: null, costUsd: 0, latencyMs: 1, tokenCost: 1, uncertainty: 0.2 },
    content: { finding: 'negative precedent was omitted' },
    callerClaims: {}
  }, { allowFixtureRecords: true }).record;
  const input = baseInput({
    internalEvidence: [bankRecord],
    facts: [{ id: 'fact-bank', statement: 'bank evidence is available', sourceIds: ['bank-evidence-1'], confidence: 'high' }]
  });
  const result = buildResearchDossier(input);
  assert.equal(result.status, 'OK');
  assert.equal(result.artifact.payload.sourceIndex[1].sha256, bankRecord.recordSha256);
});

test('sealed mode disables and ignores optional external research records', () => {
  const result = buildResearchDossier(baseInput({
    sealedMode: true,
    externalResearchEnabled: true,
    externalSourceAllowlist: ['example.test'],
    externalSources: [{ url: 'http://not-allowed.invalid', content: 'untrusted' }]
  }));
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.artifact.payload.externalResearch, {
    requested: true,
    enabled: false,
    disabledReason: 'SEALED_MODE'
  });
  assert.equal(result.artifact.provenance.some((row) => row.kind === 'primary-source'), false);
});

test('already-fetched external research requires primary HTTPS provenance and content hash', () => {
  const result = buildResearchDossier(baseInput({
    externalResearchEnabled: true,
    externalSourceAllowlist: ['example.test'],
    externalSources: [{
      id: 'paper-1',
      url: 'https://example.test/paper',
      title: 'Primary paper',
      authorityClass: 'primary',
      retrievedAt: '2026-08-04T22:00:00.000Z',
      content: 'Bounded already-fetched source content.',
      factIds: ['fact-1']
    }]
  }));
  assert.equal(result.status, 'OK');
  assert.equal(result.artifact.payload.sourceIndex.at(-1).kind, 'primary-source');
  assert.equal(validateResearchDossier(result.artifact).status, 'OK');

  const tampered = baseInput({
    externalResearchEnabled: true,
    externalSourceAllowlist: ['example.test'],
    externalSources: [{
      id: 'paper-1',
      url: 'https://example.test/paper',
      title: 'Primary paper',
      authorityClass: 'primary',
      retrievedAt: '2026-08-04T22:00:00.000Z',
      content: 'changed',
      contentSha256: 'c'.repeat(64),
      factIds: []
    }]
  });
  assert.equal(buildResearchDossier(tampered).code, 'DOSSIER_INPUT_INVALID');
});

test('dossier enforces item and byte caps with progressive disclosure', () => {
  const result = buildResearchDossier(baseInput({ maximumItems: 2, maximumBytes: 5000 }));
  assert.equal(result.status, 'OK');
  assert.equal(result.artifact.payload.items.length, 2);
  assert.ok(result.artifact.payload.progressiveDisclosure.omittedItemIds.length > 0);
  const bytes = Buffer.byteLength(canonicalVNextJson(result.artifact.payload));
  assert.ok(bytes <= 5000, `${bytes} exceeds exact byte cap`);
  assert.equal(result.artifact.payload.budget.payloadBytes, bytes);
  assert.equal(result.artifact.payload.budget.itemCount, 2);
  assert.equal(Object.isFrozen(result.artifact), true);
});
