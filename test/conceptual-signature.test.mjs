import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModelAssistedConceptualReview,
  buildConceptualReviewPacket,
  compareConceptualSignatures,
  createConceptualSignature
} from '../src/conceptual-signature.mjs';

function learning(id, overrides = {}) {
  return {
    id,
    text: 'Keep failure records available during routing.',
    structuralTags: ['failure-routing', 'negative-evidence'],
    mechanismComponent: 'evidence router',
    pathology: {
      where: 'retrieval selection',
      why: 'failure evidence is omitted'
    },
    stance: 'supports',
    ...overrides
  };
}

function signature(record) {
  const built = createConceptualSignature(record);
  assert.equal(built.status, 'OK');
  return built.signature;
}

test('canonical normalization identifies exact clones while preserving both originals', () => {
  const left = signature(learning('learning-a'));
  const right = signature(learning('learning-b', {
    text: '  KEEP failure records available during routing!  '
  }));
  const result = compareConceptualSignatures(left, right);
  assert.equal(result.status, 'OK');
  assert.equal(result.comparison.classification, 'exact-clone');
  assert.equal(result.comparison.recommendation.action, 'alias');
  assert.deepEqual(
    result.comparison.originals.map(({ recordId }) => recordId),
    ['learning-a', 'learning-b']
  );
  assert.deepEqual(result.comparison.originals[0].record, learning('learning-a'));
});

test('synonym and paraphrase candidates become probable clones only with structural support', () => {
  const left = signature(learning('learning-a'));
  const right = signature(learning('learning-b', {
    text: 'Preserve negative evidence for route selection.',
    structuralTags: ['negative precedents', 'routing failures']
  }));
  const result = compareConceptualSignatures(left, right);
  assert.equal(result.comparison.classification, 'probable-clone');
  assert.equal(result.comparison.prefiltered, true);
  assert.equal(result.comparison.recommendation.action, 'alias');
  assert.equal(result.comparison.recommendation.mode, 'append-only');
});

test('false-merge controls with shared coordinates do not emit aliases', () => {
  const left = signature(learning('learning-a', {
    text: 'Delete credentials after execution.'
  }));
  const right = signature(learning('learning-b', {
    text: 'Cache task inputs before execution.'
  }));
  const result = compareConceptualSignatures(left, right);
  assert.ok(['distinct', 'uncertain'].includes(result.comparison.classification));
  assert.notEqual(result.comparison.recommendation.action, 'alias');
});

test('opposing records remain distinct and produce an append-only contradiction recommendation', () => {
  const leftRecord = learning('learning-a', {
    text: 'Preserve failure evidence during routing.'
  });
  const rightRecord = learning('learning-b', {
    text: 'Remove failure evidence during routing.',
    stance: 'contradicts'
  });
  const result = compareConceptualSignatures(signature(leftRecord), signature(rightRecord));
  assert.equal(result.comparison.classification, 'distinct');
  assert.equal(result.comparison.recommendation.action, 'record-contradiction');
  assert.equal(result.comparison.recommendation.mode, 'append-only');
  assert.deepEqual(result.comparison.originals.map(({ record }) => record), [leftRecord, rightRecord]);
});

test('embedding dimension mismatch stays uncertain instead of forcing a clone', () => {
  const left = signature(learning('learning-a', { embedding: [1, 0, 0] }));
  const right = signature(learning('learning-b', { embedding: [1, 0] }));
  const result = compareConceptualSignatures(left, right);
  assert.equal(result.comparison.classification, 'uncertain');
  assert.equal(result.comparison.recommendation.action, 'manual-review');
  assert.equal(
    result.comparison.evidence.find(({ code }) => code === 'EMBEDDING_SIMILARITY').value,
    'dimension-mismatch'
  );
});

test('model review is pair-bound, closed, and rejects hallucinated evidence', () => {
  const left = signature(learning('learning-a'));
  const right = signature(learning('learning-b', {
    text: 'Preserve negative evidence for route selection.'
  }));
  const compared = compareConceptualSignatures(left, right).comparison;
  const hallucinated = applyModelAssistedConceptualReview({
    comparison: compared,
    output: {
      schemaVersion: 'vnext-conceptual-review-output-v1',
      pairSha256: compared.pairSha256,
      verdict: 'PROBABLE_CLONE',
      evidenceCodes: ['INVENTED_MODEL_FACT'],
      uncertainty: 0.1
    }
  });
  assert.equal(hallucinated.code, 'CONCEPTUAL_REVIEW_HALLUCINATED_EVIDENCE');

  const attemptedAuthority = applyModelAssistedConceptualReview({
    comparison: compared,
    output: {
      schemaVersion: 'vnext-conceptual-review-output-v1',
      pairSha256: compared.pairSha256,
      verdict: 'PROBABLE_CLONE',
      evidenceCodes: ['TEXT_TOKEN_SIMILARITY'],
      uncertainty: 0.1,
      merge: true
    }
  });
  assert.equal(attemptedAuthority.code, 'CONCEPTUAL_REVIEW_OUTPUT_INVALID');
});

test('model review packets expose only the bounded semantic contract', () => {
  const left = signature(learning('learning-a', {
    verifierEvidenceHashes: ['a'.repeat(64)],
    apiKey: 'must-never-reach-review-context',
    developmentConversation: ['hidden pipeline state']
  }));
  const right = signature(learning('learning-b', {
    text: 'Preserve negative evidence for route selection.'
  }));
  const compared = compareConceptualSignatures(left, right).comparison;
  const built = buildConceptualReviewPacket(compared);
  assert.equal(built.status, 'OK');
  const serialized = JSON.stringify(built.packet);
  assert.equal(serialized.includes('must-never-reach-review-context'), false);
  assert.equal(serialized.includes('hidden pipeline state'), false);
  assert.equal(built.packet.records[0].verifierEvidenceHashes.length, 1);
  assert.equal(built.packet.activationAuthority, false);
});

test('model review cannot upgrade an uncertain pair or inspect an unfiltered pair', () => {
  const uncertain = compareConceptualSignatures(
    signature(learning('learning-a')),
    signature(learning('learning-b', {
      text: 'Preserve route budgets for every task.'
    }))
  ).comparison;
  assert.equal(uncertain.classification, 'uncertain');
  assert.equal(uncertain.prefiltered, true);
  const reviewed = applyModelAssistedConceptualReview({
    comparison: uncertain,
    output: {
      schemaVersion: 'vnext-conceptual-review-output-v1',
      pairSha256: uncertain.pairSha256,
      verdict: 'PROBABLE_CLONE',
      evidenceCodes: ['TEXT_TOKEN_SIMILARITY', 'MECHANISM_MATCH'],
      uncertainty: 0.05
    }
  });
  assert.equal(reviewed.status, 'OK');
  assert.equal(reviewed.comparison.classification, 'uncertain');
  assert.equal(reviewed.comparison.recommendation.action, 'manual-review');

  const unfiltered = compareConceptualSignatures(
    signature(learning('learning-c', {
      text: 'Delete credentials after execution.',
      mechanismComponent: 'credential cleanup',
      pathology: { where: 'shutdown', why: 'credentials persist' }
    })),
    signature(learning('learning-d', {
      text: 'Cache task inputs before execution.',
      mechanismComponent: 'input cache',
      pathology: { where: 'startup', why: 'inputs load slowly' }
    }))
  ).comparison;
  assert.equal(unfiltered.prefiltered, false);
  assert.equal(
    applyModelAssistedConceptualReview({
      comparison: unfiltered,
      output: {
        schemaVersion: 'vnext-conceptual-review-output-v1',
        pairSha256: unfiltered.pairSha256,
        verdict: 'PROBABLE_CLONE',
        evidenceCodes: [],
        uncertainty: 0
      }
    }).code,
    'CONCEPTUAL_REVIEW_NOT_ALLOWED'
  );
});

test('conceptual comparison replay is deterministic and input-order invariant', () => {
  const left = signature(learning('learning-a'));
  const right = signature(learning('learning-b', {
    text: 'Preserve negative evidence for route selection.'
  }));
  assert.deepEqual(
    compareConceptualSignatures(left, right),
    compareConceptualSignatures(right, left)
  );
});
