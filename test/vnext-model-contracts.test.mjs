import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VNEXT_MODEL_SCHEMA,
  validateVNextModelOutput
} from '../src/vnext-model-contracts.mjs';

test('external research discovery accepts only primary HTTPS source proposals', () => {
  const output = {
    schemaVersion: VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY,
    abstain: false,
    abstainReason: null,
    searchSummary: 'Official evidence found.',
    queries: ['official agent retrieval paper'],
    sources: [{
      sourceId: 'paper-1',
      url: 'https://arxiv.org/abs/2501.00001',
      title: 'Primary paper',
      reason: 'Official paper source.',
      authorityClass: 'primary'
    }],
    uncertainties: []
  };
  assert.equal(validateVNextModelOutput(
    output,
    VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY
  ).status, 'OK');
  output.sources[0].url = 'http://example.com/paper';
  assert.equal(validateVNextModelOutput(
    output,
    VNEXT_MODEL_SCHEMA.EXTERNAL_RESEARCH_DISCOVERY
  ).status, 'REFUSED');
});

test('candidate contract is shared, bounded, and protected-surface closed', () => {
  const candidate = {
    schemaVersion: VNEXT_MODEL_SCHEMA.CANDIDATE,
    strategy: 'bounded-skill',
    targetBehavior: 'preserve negative evidence',
    component: 'retrieval',
    taskAgnostic: true,
    prediction: 'negative precedent recall increases without a positive recall loss',
    falsifier: 'negative recall is unchanged or positive recall regresses',
    operations: [{
      op: 'add',
      target: 'negative-selection-rule',
      beforeSha256: null,
      value: 'reserve one negative precedent'
    }],
    evidenceIds: ['failure-1'],
    rollback: 'remove the added rule',
    protectedSurfaceTouches: []
  };
  assert.equal(
    validateVNextModelOutput(candidate, VNEXT_MODEL_SCHEMA.CANDIDATE).status,
    'OK'
  );
  candidate.protectedSurfaceTouches.push('evaluator');
  assert.equal(
    validateVNextModelOutput(candidate, VNEXT_MODEL_SCHEMA.CANDIDATE).status,
    'REFUSED'
  );
});

test('reranker output cannot duplicate candidates or escape probability bounds', () => {
  const row = {
    recordId: 'record-1',
    applicability: 0.8,
    structuralSimilarity: 0.7,
    expectedBenefit: 0.6,
    transferUncertainty: 0.2,
    contradictionRisk: 0.1,
    reason: 'same failure structure',
    confidence: 0.7
  };
  const output = {
    schemaVersion: VNEXT_MODEL_SCHEMA.RERANKER,
    rankings: [row],
    abstain: false,
    abstainReason: null
  };
  assert.equal(
    validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.RERANKER).status,
    'OK'
  );
  output.rankings.push({ ...row });
  assert.equal(
    validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.RERANKER).status,
    'REFUSED'
  );
});

test('semantic evaluator output has no promotion or lineage fields', () => {
  const output = {
    schemaVersion: VNEXT_MODEL_SCHEMA.EVALUATOR,
    rubricSha256: 'a'.repeat(64),
    measurements: [{
      dimension: 'clarity',
      score: 0.8,
      evidenceRefs: ['evidence-1'],
      confidence: 0.7
    }],
    uncertainty: 0.3,
    protocolViolations: []
  };
  assert.equal(
    validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.EVALUATOR).status,
    'OK'
  );
  assert.equal(validateVNextModelOutput({
    ...output,
    protocolViolations: ['raw confidential evidence must not be echoed']
  }, VNEXT_MODEL_SCHEMA.EVALUATOR).status, 'REFUSED');
  output.promote = true;
  assert.equal(
    validateVNextModelOutput(output, VNEXT_MODEL_SCHEMA.EVALUATOR).status,
    'REFUSED'
  );
});
