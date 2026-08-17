import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSourceAndArtifactManifest,
  verifySourceAndArtifactManifest
} from '../src/source-artifact-manifest.mjs';

test('source manifest refuses byte and membership drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-artifact-manifest-'));
  const options = {
    manifestName: 'MANIFEST.sha256',
    rootFiles: ['a.txt'],
    optionalRootFiles: ['optional.txt'],
    sourceDirectories: [],
    proofInputs: []
  };
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    const built = buildSourceAndArtifactManifest(root, options);
    assert.equal(built.status, 'OK');
    writeFileSync(join(root, options.manifestName), built.text);
    assert.equal(verifySourceAndArtifactManifest(root, options).status, 'OK');

    writeFileSync(join(root, 'optional.txt'), 'optional\n');
    assert.equal(
      verifySourceAndArtifactManifest(root, options).code,
      'SOURCE_ARTIFACT_MANIFEST_DRIFT'
    );
    rmSync(join(root, 'optional.txt'));
    assert.equal(verifySourceAndArtifactManifest(root, options).status, 'OK');

    writeFileSync(join(root, 'a.txt'), 'changed\n');
    assert.equal(
      verifySourceAndArtifactManifest(root, options).code,
      'SOURCE_ARTIFACT_MANIFEST_DRIFT'
    );

    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    writeFileSync(join(root, 'b.txt'), 'beta\n');
    assert.equal(verifySourceAndArtifactManifest(root, {
      ...options,
      rootFiles: ['a.txt', 'b.txt']
    }).code, 'SOURCE_ARTIFACT_MANIFEST_DRIFT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
