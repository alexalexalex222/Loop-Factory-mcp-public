import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/util.mjs';
import {
  buildVNextTaskPack,
  loadVNextTaskPackMaterials,
  validateVNextTaskMaterialBundle,
  validateVNextTaskPack
} from '../src/vnext-task-pack.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

const executableEvaluatorTest = process.platform === 'darwin' ? test : test.skip;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-task-pack-'));
  mkdirSync(join(root, 'tasks'));
  const tasks = [1, 2].map((number) => {
    const source = `tasks/source-${number}.txt`;
    const incident = `tasks/incident-${number}.txt`;
    const interfacePath = `tasks/interface-${number}.json`;
    const oracle = `tasks/oracle-${number}.txt`;
    const interfaceContract = {
      schemaVersion: 'executable-interface-contract-v2',
      exportName: 'decide',
      inputPaths: [`task${number}.baselineQuality`, `task${number}.candidateQuality`],
      decisions: ['ACCEPT', 'REJECT'],
      codes: [
        { value: 'QUALITY_GAIN', meaning: 'Quality increased.' },
        { value: 'NO_GAIN', meaning: 'Quality did not increase.' }
      ],
      roleBindings: [
        { role: 'baseline.quality', path: `task${number}.baselineQuality` },
        { role: 'candidate.quality', path: `task${number}.candidateQuality` }
      ]
    };
    const row = (id, group, baselineQuality, candidateQuality, decision, code) => ({
      id, group,
      input: { [`task${number}`]: { baselineQuality, candidateQuality } },
      expected: { decision, code }
    });
    const bytes = {
      source: `export function decide() { return { decision: 'REJECT', code: 'NO_GAIN' }; } // ${number}\n`,
      incident: `observed baseline failure ${number}`,
      interface: JSON.stringify(interfaceContract),
      oracle: JSON.stringify({
        schemaVersion: 'executable-case-set-v1', exportName: 'decide',
        cases: [
          row(`target-${number}-1`, 'target', 1, 2, 'ACCEPT', 'QUALITY_GAIN'),
          row(`target-${number}-2`, 'target', 2, 3, 'ACCEPT', 'QUALITY_GAIN'),
          row(`target-${number}-3`, 'target', 3, 4, 'ACCEPT', 'QUALITY_GAIN'),
          row(`control-${number}-1`, 'control', 4, 2, 'REJECT', 'NO_GAIN'),
          row(`control-${number}-2`, 'control', 5, 1, 'REJECT', 'NO_GAIN')
        ]
      })
    };
    writeFileSync(join(root, source), bytes.source);
    writeFileSync(join(root, incident), bytes.incident);
    writeFileSync(join(root, interfacePath), bytes.interface);
    writeFileSync(join(root, oracle), bytes.oracle);
    return {
      taskId: `task-${number}`,
      clusterId: `cluster-${number}`,
      domain: 'synthetic',
      tags: ['control'],
      source: { id: `source-${number}`, path: source, sha256: sha256(bytes.source) },
      incident: { id: `incident-${number}`, path: incident, sha256: sha256(bytes.incident) },
      interface: { id: `interface-${number}`, path: interfacePath, sha256: sha256(bytes.interface) },
      oracle: { id: `oracle-${number}`, path: oracle, sha256: sha256(bytes.oracle) },
      interfaceContractSha256: sha256(canonicalVNextJson(interfaceContract)),
      publicTaskSpecSha256: 'b'.repeat(64),
      baselineFailure: {
        status: 'VERIFIED_FAILURE',
        taskId: `task-${number}`,
        artifactId: `baseline-${number}`,
        artifactSha256: 'c'.repeat(64),
        verifierEvidenceSha256: 'd'.repeat(64),
        baselineArtifactSha256: 'e'.repeat(64)
      }
    };
  });
  return { root, tasks };
}

executableEvaluatorTest('task packs bind source, oracle, incident, baseline failure, and disjoint identity', () => {
  const { root, tasks } = fixture();
  const built = buildVNextTaskPack({
    artifactRoot: root,
    packId: 'pack-1',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks
  });
  assert.equal(built.status, 'OK');
  assert.equal(validateVNextTaskPack(built.pack).status, 'OK');
  const loaded = loadVNextTaskPackMaterials({ artifactRoot: root, pack: built.pack });
  assert.equal(loaded.status, 'OK');
  assert.equal(loaded.bundle.materials.length, 2);
  assert.equal(buildVNextTaskPack({
    artifactRoot: root,
    packId: 'pack-2',
    partition: 'validation',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks,
    priorIdentities: built.identities
  }).code, 'TASK_PACK_NOT_DISJOINT');
});

test('final packs reject non-custodian builders before evaluator launch', () => {
  const { root, tasks } = fixture();
  const built = buildVNextTaskPack({
    artifactRoot: root,
    packId: 'final-pack',
    partition: 'final',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks
  });
  assert.equal(built.status, 'REFUSED');
  assert.equal(built.code, 'TASK_PACK_REQUEST_INVALID');
});

test('task-pack build reports an unsupported evaluator host directly', {
  skip: process.platform === 'darwin'
}, () => {
  const { root, tasks } = fixture();
  const built = buildVNextTaskPack({
    artifactRoot: root,
    packId: 'unsupported-host-pack',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks
  });
  assert.equal(built.status, 'REFUSED');
  assert.equal(built.code, 'EXECUTABLE_SANDBOX_UNSUPPORTED');
});

executableEvaluatorTest('external custodians can build final packs', () => {
  const { root, tasks } = fixture();
  assert.equal(buildVNextTaskPack({
    artifactRoot: root,
    packId: 'final-pack',
    partition: 'final',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'custodian-1', kind: 'external-custodian' },
    tasks
  }).status, 'OK');
});

executableEvaluatorTest('task packs refuse oracle leakage, tampering, and symlinks', () => {
  const leaked = fixture();
  const oracle = readFileSync(join(leaked.root, 'tasks/oracle-1.txt'), 'utf8');
  writeFileSync(join(leaked.root, 'tasks/source-1.txt'), `public ${oracle}`);
  leaked.tasks[0].source.sha256 = sha256(`public ${oracle}`);
  assert.equal(buildVNextTaskPack({
    artifactRoot: leaked.root,
    packId: 'leaked-pack',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks: leaked.tasks
  }).code, 'TASK_PACK_ORACLE_LEAK');

  const linked = fixture();
  symlinkSync(join(linked.root, 'tasks/source-1.txt'), join(linked.root, 'tasks/link.txt'));
  linked.tasks[0].source = {
    ...linked.tasks[0].source,
    path: 'tasks/link.txt'
  };
  assert.equal(buildVNextTaskPack({
    artifactRoot: linked.root,
    packId: 'linked-pack',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks: linked.tasks
  }).code, 'TASK_PACK_BINDING_UNSAFE');

  const closed = fixture();
  const built = buildVNextTaskPack({
    artifactRoot: closed.root,
    packId: 'closed-pack',
    partition: 'development',
    createdAt: '2026-08-05T00:00:00.000Z',
    builderAuthority: { id: 'builder-1', kind: 'deterministic-tool' },
    tasks: closed.tasks
  }).pack;
  const malformed = structuredClone(built);
  malformed.tasks[0].source.unexpected = true;
  const payload = structuredClone(malformed);
  delete payload.packSha256;
  malformed.packSha256 = sha256(canonicalVNextJson(payload));
  assert.equal(validateVNextTaskPack(malformed).status, 'REFUSED');

  const loaded = loadVNextTaskPackMaterials({ artifactRoot: closed.root, pack: built });
  loaded.bundle.materials[0].source.content = 'tampered';
  const bundleCore = structuredClone(loaded.bundle);
  delete bundleCore.bundleSha256;
  loaded.bundle.bundleSha256 = sha256(canonicalVNextJson(bundleCore));
  assert.equal(validateVNextTaskMaterialBundle({
    bundle: loaded.bundle,
    pack: built
  }).status, 'REFUSED');
});
