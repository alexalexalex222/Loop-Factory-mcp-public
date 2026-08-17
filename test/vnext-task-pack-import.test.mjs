import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  importVNextTaskPackFromExecutableCanary,
  verifyVNextTaskPackImport
} from '../src/vnext-task-pack-import.mjs';

function legacyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-task-import-'));
  mkdirSync(join(root, 'tasks'));
  const tasks = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const phase = index < 5 ? 'qualification' : 'confirmation';
    const domain = ['support', 'summary', 'code-review'][index % 3];
    const id = `${phase}-${domain}-${number}`;
    const rootKey = `domain${number}`;
    const interfaceContract = {
      schemaVersion: 'executable-interface-contract-v2',
      exportName: 'decide',
      inputPaths: [`${rootKey}.baselineQuality`, `${rootKey}.candidateQuality`],
      decisions: ['ACCEPT', 'REJECT'],
      codes: [
        { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
        { value: 'NO_GAIN', meaning: 'Quality did not increase.' }
      ],
      roleBindings: [
        { role: 'baseline.quality', path: `${rootKey}.baselineQuality` },
        { role: 'candidate.quality', path: `${rootKey}.candidateQuality` }
      ]
    };
    const caseSet = {
      schemaVersion: 'executable-case-set-v1',
      exportName: 'decide',
      cases: [
        {
          id: `target-${number}-1`,
          group: 'target',
          input: { [rootKey]: { baselineQuality: 1, candidateQuality: 2 } },
          expected: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
        },
        {
          id: `target-${number}-2`,
          group: 'target',
          input: { [rootKey]: { baselineQuality: 2, candidateQuality: 3 } },
          expected: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
        },
        {
          id: `target-${number}-3`,
          group: 'target',
          input: { [rootKey]: { baselineQuality: 3, candidateQuality: 4 } },
          expected: { decision: 'ACCEPT', code: 'QUALITY_GAIN' }
        },
        {
          id: `control-${number}-1`,
          group: 'control',
          input: { [rootKey]: { baselineQuality: 2, candidateQuality: 1 } },
          expected: { decision: 'REJECT', code: 'NO_GAIN' }
        },
        {
          id: `control-${number}-2`,
          group: 'control',
          input: { [rootKey]: { baselineQuality: 3, candidateQuality: 1 } },
          expected: { decision: 'REJECT', code: 'NO_GAIN' }
        }
      ]
    };
    const paths = {
      sourcePath: `tasks/source-${number}.mjs`,
      specPath: `tasks/incident-${number}.md`,
      interfacePath: `tasks/interface-${number}.json`,
      oraclePath: `tasks/oracle-${number}.json`,
      referencePath: `tasks/reference-${number}.mjs`
    };
    writeFileSync(join(root, paths.sourcePath), `export function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; } // ${number}\n`);
    writeFileSync(join(root, paths.specPath), `Repair incident ${number}.\n`);
    writeFileSync(join(root, paths.interfacePath), `${JSON.stringify(interfaceContract)}\n`);
    writeFileSync(join(root, paths.oraclePath), `${JSON.stringify(caseSet)}\n`);
    writeFileSync(join(root, paths.referencePath), `secret reference answer ${number}\n`);
    return {
      id,
      phase,
      title: `${domain} incident ${number}`,
      ...paths
    };
  });
  const config = {
    schemaVersion: 'adaptive-executable-canary-v4',
    model: 'gpt-5.6-sol',
    fixtureOnly: false,
    tasks
  };
  return { root, sourceConfigBytes: JSON.stringify(config) };
}

test('legacy executable tasks become a baseline-failure-bound portable VNext pack', () => {
  const fixture = legacyFixture();
  const imported = importVNextTaskPackFromExecutableCanary({
    artifactRoot: fixture.root,
    sourceConfigBytes: fixture.sourceConfigBytes,
    packId: 'development-pack-1',
    partition: 'development',
    createdAt: '2026-08-05T14:00:00.000Z',
    builderId: 'legacy-task-importer'
  });
  assert.equal(
    imported.status,
    'OK',
    `${imported.code || 'UNKNOWN'}: ${imported.message || 'no message'}`
  );
  assert.equal(imported.pack.tasks.length, 10);
  assert.equal(imported.bundle.materials.length, 10);
  assert.equal(imported.receipt.qualificationTaskIds.length, 5);
  assert.equal(imported.receipt.confirmationTaskIds.length, 5);
  assert.equal(imported.receipt.referenceContentImported, false);
  assert.equal(imported.pack.tasks.every((task) => (
    task.baselineFailure.status === 'VERIFIED_FAILURE'
    && task.baselineFailure.targetFailureIds.length > 0
    && task.baselineFailure.controlPassIds.length >= 2
  )), true);
  assert.equal(verifyVNextTaskPackImport({
    sourceConfigBytes: fixture.sourceConfigBytes,
    pack: imported.pack,
    bundle: imported.bundle,
    receipt: imported.receipt
  }).status, 'OK');

  const overlap = importVNextTaskPackFromExecutableCanary({
    artifactRoot: fixture.root,
    sourceConfigBytes: fixture.sourceConfigBytes,
    packId: 'validation-pack-1',
    partition: 'validation',
    createdAt: '2026-08-05T14:01:00.000Z',
    builderId: 'legacy-task-importer',
    priorIdentities: imported.identities
  });
  assert.equal(overlap.code, 'TASK_PACK_NOT_DISJOINT');
});

test('import receipt tampering and final-partition use fail closed', () => {
  const fixture = legacyFixture();
  assert.equal(importVNextTaskPackFromExecutableCanary({
    artifactRoot: fixture.root,
    sourceConfigBytes: fixture.sourceConfigBytes,
    packId: 'final-pack-1',
    partition: 'final',
    createdAt: '2026-08-05T14:00:00.000Z',
    builderId: 'legacy-task-importer'
  }).status, 'REFUSED');

  const imported = importVNextTaskPackFromExecutableCanary({
    artifactRoot: fixture.root,
    sourceConfigBytes: fixture.sourceConfigBytes,
    packId: 'development-pack-2',
    partition: 'development',
    createdAt: '2026-08-05T14:00:00.000Z',
    builderId: 'legacy-task-importer'
  });
  const tampered = {
    ...imported.receipt,
    referenceContentImported: true
  };
  assert.equal(verifyVNextTaskPackImport({
    sourceConfigBytes: fixture.sourceConfigBytes,
    pack: imported.pack,
    bundle: imported.bundle,
    receipt: tampered
  }).status, 'REFUSED');
});
