import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VNEXT_STAGE,
  createVNextStageArtifact,
  validateVNextStageArtifact
} from '../src/vnext-contracts.mjs';

function validInput() {
  return {
    stage: VNEXT_STAGE.DOSSIER,
    status: 'OK',
    createdAt: '2026-08-05T00:00:00.000Z',
    authority: {
      actorId: 'researcher-1',
      kind: 'deterministic-builder',
      model: null,
      promptSha256: null,
      toolPolicy: 'read-only-primary-sources'
    },
    inputRefs: [{
      id: 'failure-1',
      schemaVersion: 'failure-v1',
      sha256: 'a'.repeat(64)
    }],
    permittedInformation: ['normalized failure', 'public source'],
    forbiddenInformation: ['sealed tasks'],
    provenance: [{
      id: 'source-1',
      kind: 'repository-artifact',
      observedAt: '2026-08-05T00:00:00.000Z',
      sha256: 'b'.repeat(64),
      uri: null
    }],
    replay: {
      module: 'src/research-dossier.mjs',
      exportName: 'buildResearchDossier',
      version: 'v1'
    },
    failure: null,
    payload: { facts: ['one'] }
  };
}

test('VNext stage artifacts are deterministic and tamper evident', () => {
  const first = createVNextStageArtifact(validInput());
  const second = createVNextStageArtifact(validInput());
  assert.equal(first.status, 'OK');
  assert.deepEqual(first, second);
  assert.equal(validateVNextStageArtifact(first.artifact).status, 'OK');
  first.artifact.payload.facts.push('tampered');
  assert.equal(
    validateVNextStageArtifact(first.artifact).code,
    'VNEXT_STAGE_ARTIFACT_TAMPERED'
  );
});

test('VNext stage artifacts fail closed on authority and boundary drift', () => {
  const missingAuthority = validInput();
  delete missingAuthority.authority.toolPolicy;
  assert.equal(createVNextStageArtifact(missingAuthority).status, 'REFUSED');

  const invalidBoundary = validInput();
  invalidBoundary.forbiddenInformation = ['sealed tasks', 'sealed tasks'];
  const built = createVNextStageArtifact(invalidBoundary);
  assert.equal(built.status, 'OK');
  assert.deepEqual(built.artifact.forbiddenInformation, ['sealed tasks']);
});

test('non-OK artifacts require a bounded failure receipt', () => {
  const refused = validInput();
  refused.status = 'REFUSED';
  assert.equal(createVNextStageArtifact(refused).status, 'REFUSED');
  refused.failure = { code: 'RESEARCH_DISABLED', message: 'External research is disabled.' };
  const built = createVNextStageArtifact(refused);
  assert.equal(built.status, 'OK');
  assert.equal(validateVNextStageArtifact(built.artifact).status, 'OK');
});
