import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildHarnessHandbook } from '../src/harness-handbook.mjs';
import {
  VNEXT_CANDIDATE_GENERATOR_FLAGS,
  createCandidateGeneratorRegistry,
  getCandidateGenerator
} from '../src/vnext-candidate-generators.mjs';
import {
  VNEXT_CODE_SANDBOX_PLATFORM,
  buildCodeSandboxProfile,
  executeGuardedCodeCandidate,
  verifyGuardedCodeWorktreeRun
} from '../src/vnext-code-worktree.mjs';
import {
  VNEXT_STAGE,
  canonicalVNextJson,
  createVNextStageArtifact
} from '../src/vnext-contracts.mjs';
import { sha256 } from '../src/util.mjs';

const NOW = '2026-08-05T12:00:00.000Z';
const RUN_SCRIPT = fileURLToPath(new URL(
  '../scripts/run-vnext-code-candidate.mjs',
  import.meta.url
));
const VERIFY_SCRIPT = fileURLToPath(new URL(
  '../scripts/verify-vnext-code-candidate.mjs',
  import.meta.url
));

function git(cwd, args, env = {}) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  }).trim();
}

function stage(stageName, suffix) {
  return createVNextStageArtifact({
    stage: stageName,
    status: 'OK',
    createdAt: NOW,
    authority: {
      actorId: `code-stage-${suffix}`,
      kind: 'test-fixture',
      model: null,
      promptSha256: null,
      toolPolicy: 'none'
    },
    inputRefs: [],
    permittedInformation: ['development source'],
    forbiddenInformation: ['sealed tasks'],
    provenance: [],
    replay: { module: 'test', exportName: 'stage', version: 'v1' },
    failure: null,
    payload: { suffix }
  }).artifact;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vnext-code-source-'));
  const outputRoot = mkdtempSync(join(tmpdir(), 'vnext-code-output-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  const source = 'export const answer = 1;\n';
  writeFileSync(join(root, 'src', 'answer.mjs'), source);
  writeFileSync(join(root, 'test', 'answer.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { answer } from '../src/answer.mjs';",
    "test('answer', () => assert.equal(answer, 2));",
    ''
  ].join('\n'));
  git(root, ['init']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture'], {
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture'
  });
  const baseCommit = git(root, ['rev-parse', 'HEAD']);
  const map = buildHarnessHandbook({
    repositoryRoot: root,
    behaviors: [{
      id: 'answer-behavior',
      description: 'Returns the bounded fixture answer.',
      generatedSummary: null,
      locators: [{ path: 'src/answer.mjs', symbol: 'answer', startLine: 1, endLine: 1 }],
      tests: [{ path: 'test/answer.test.mjs', symbol: 'answer', startLine: 1, endLine: 4 }],
      dependencies: [],
      permissions: []
    }]
  }).behaviorMap;
  const locator = map.behaviors[0].locators[0];
  const executable = process.execPath;
  const registry = createCandidateGeneratorRegistry({
    [VNEXT_CANDIDATE_GENERATOR_FLAGS['code-level-experimental']]: true
  });
  const plugin = getCandidateGenerator(registry, 'code-level-experimental').plugin;
  const contract = plugin.createContract({
    hypothesisArtifact: stage(VNEXT_STAGE.HYPOTHESIS, 'hypothesis'),
    falsificationArtifact: stage(VNEXT_STAGE.FALSIFICATION, 'falsification'),
    retrievalArtifact: stage(VNEXT_STAGE.RETRIEVAL, 'retrieval'),
    selectedEvidence: [{ id: 'evidence-1', sha256: 'e'.repeat(64) }],
    behaviorMap: map,
    allowedComponent: 'answer-behavior',
    parentArtifact: { schemaVersion: 'fixture-parent-v1' },
    parentItemHashes: [{
      target: locator.path,
      component: 'answer-behavior',
      sha256: locator.locatorSha256
    }],
    maxOperations: 1,
    protectedSurfaces: ['evaluator', 'verifier', 'statistics', 'sealed-tasks', 'promotion'],
    taskAgnostic: true,
    strategyState: {
      disposableWorktree: true,
      maximumFiles: 1,
      maximumPatchBytes: 4096,
      requiredTests: [{
        testId: 'answer-test',
        executable,
        executableSha256: sha256(readFileSync(executable)),
        args: ['--test', 'test/answer.test.mjs'],
        timeoutMs: 120000
      }]
    }
  });
  assert.equal(contract.status, 'OK');
  const candidate = {
    schemaVersion: 'vnext-candidate-output-v1',
    strategy: 'code-level-experimental',
    targetBehavior: 'return the corrected bounded answer',
    component: 'answer-behavior',
    taskAgnostic: true,
    prediction: 'the answer fixture test passes',
    falsifier: 'the answer fixture test fails',
    operations: [{
      op: 'replace',
      target: 'src/answer.mjs',
      beforeSha256: sha256(source),
      value: 'export const answer = 2;\n'
    }],
    evidenceIds: ['evidence-1'],
    rollback: 'restore the exact source hash from the frozen commit',
    protectedSurfaceTouches: []
  };
  const verified = plugin.verifyCandidate(candidate, contract.contract);
  assert.equal(verified.status, 'OK');
  return {
    baseCommit,
    candidate,
    contract: contract.contract,
    outputRoot,
    plugin,
    root,
    source,
    verification: verified.verification
  };
}

test('guarded code strategy executes and replays in a detached network-denied worktree', {
  skip: process.platform !== VNEXT_CODE_SANDBOX_PLATFORM
}, () => {
  const f = fixture();
  try {
    const result = executeGuardedCodeCandidate({
      repositoryRoot: f.root,
      outputRoot: f.outputRoot,
      runId: 'code-run-1',
      baseCommit: f.baseCommit,
      candidate: f.candidate,
      contract: f.contract,
      verification: f.verification,
      createdAt: NOW
    });
    assert.equal(result.status, 'OK', `${result.code || ''} ${result.message || ''}`);
    assert.equal(result.receipt.tests[0].exitCode, 0);
    assert.equal(result.receipt.networkAllowed, false);
    assert.equal(result.receipt.activationAuthority, false);
    assert.equal(result.receipt.promotionAuthority, false);
    assert.equal(readFileSync(join(f.root, 'src', 'answer.mjs'), 'utf8'), f.source);
    assert.equal(
      readFileSync(join(result.worktreePath, 'src', 'answer.mjs'), 'utf8'),
      'export const answer = 2;\n'
    );
    const replay = verifyGuardedCodeWorktreeRun({
      receiptPath: join(result.statePath, 'receipt.json')
    });
    assert.equal(replay.status, 'OK', JSON.stringify(replay));
    const receipt = JSON.parse(readFileSync(join(result.statePath, 'receipt.json'), 'utf8'));
    receipt.patchSha256 = '0'.repeat(64);
    writeFileSync(join(result.statePath, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
    assert.equal(
      verifyGuardedCodeWorktreeRun({
        receiptPath: join(result.statePath, 'receipt.json')
      }).status,
      'REFUSED'
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.outputRoot, { recursive: true, force: true });
  }
});

test('code worktree refuses when the frozen source hash differs from the commit', {
  skip: process.platform !== VNEXT_CODE_SANDBOX_PLATFORM
}, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src', 'answer.mjs'), 'export const answer = 99;\n');
    const map = buildHarnessHandbook({
      repositoryRoot: f.root,
      behaviors: [{
        id: 'answer-behavior', description: 'Drifted answer.', generatedSummary: null,
        locators: [{ path: 'src/answer.mjs', symbol: 'answer', startLine: 1, endLine: 1 }],
        tests: [], dependencies: [], permissions: []
      }]
    }).behaviorMap;
    assert.notEqual(
      map.behaviors[0].locators[0].sourceSha256,
      f.contract.strategyPlan.context.sourceTargets[0].sourceSha256
    );
    const locator = map.behaviors[0].locators[0];
    const contract = f.plugin.createContract({
      hypothesisArtifact: stage(VNEXT_STAGE.HYPOTHESIS, 'drift-hypothesis'),
      falsificationArtifact: stage(VNEXT_STAGE.FALSIFICATION, 'drift-falsification'),
      retrievalArtifact: stage(VNEXT_STAGE.RETRIEVAL, 'drift-retrieval'),
      selectedEvidence: [{ id: 'evidence-1', sha256: 'e'.repeat(64) }],
      behaviorMap: map,
      allowedComponent: 'answer-behavior',
      parentArtifact: { schemaVersion: 'fixture-parent-v1' },
      parentItemHashes: [{
        target: locator.path,
        component: 'answer-behavior',
        sha256: locator.locatorSha256
      }],
      maxOperations: 1,
      protectedSurfaces: ['evaluator', 'verifier', 'statistics', 'sealed-tasks', 'promotion'],
      taskAgnostic: true,
      strategyState: {
        disposableWorktree: true,
        maximumFiles: 1,
        maximumPatchBytes: 4096,
        requiredTests: [{
          testId: 'answer-test', executable: process.execPath,
          executableSha256: sha256(readFileSync(process.execPath)),
          args: ['--test', 'test/answer.test.mjs'], timeoutMs: 120000
        }]
      }
    });
    assert.equal(contract.status, 'OK');
    const candidate = {
      ...f.candidate,
      operations: [{
        ...f.candidate.operations[0],
        beforeSha256: locator.sourceSha256
      }]
    };
    const verified = f.plugin.verifyCandidate(candidate, contract.contract);
    assert.equal(verified.status, 'OK');
    const result = executeGuardedCodeCandidate({
      repositoryRoot: f.root,
      outputRoot: f.outputRoot,
      runId: 'code-run-drift',
      baseCommit: f.baseCommit,
      candidate,
      contract: contract.contract,
      verification: verified.verification,
      createdAt: NOW
    });
    assert.equal(result.status, 'REFUSED');
    assert.equal(result.code, 'VNEXT_CODE_SOURCE_DRIFT');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.outputRoot, { recursive: true, force: true });
  }
});

test('code candidate CLI launches once and the independent CLI verifier replays it', {
  skip: process.platform !== VNEXT_CODE_SANDBOX_PLATFORM
}, () => {
  const f = fixture();
  try {
    const packetPath = join(f.outputRoot, 'packet.json');
    writeFileSync(packetPath, `${JSON.stringify({
      repositoryRoot: f.root,
      outputRoot: f.outputRoot,
      runId: 'code-cli-run',
      baseCommit: f.baseCommit,
      candidate: f.candidate,
      contract: f.contract,
      verification: f.verification,
      createdAt: NOW
    }, null, 2)}\n`);
    const launched = JSON.parse(execFileSync(process.execPath, [
      RUN_SCRIPT,
      '--packet',
      packetPath
    ], { encoding: 'utf8' }));
    assert.equal(launched.status, 'OK');
    assert.equal(launched.networkAllowed, false);
    const verified = JSON.parse(execFileSync(process.execPath, [
      VERIFY_SCRIPT,
      '--receipt',
      launched.receiptPath
    ], { encoding: 'utf8' }));
    assert.equal(verified.status, 'OK');
    assert.equal(verified.receiptSha256, launched.receiptSha256);
    assert.equal(verified.activationAuthority, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.outputRoot, { recursive: true, force: true });
  }
});

test('the code sandbox profile denies loopback network connections', {
  skip: process.platform !== VNEXT_CODE_SANDBOX_PLATFORM
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'vnext-code-sandbox-'));
  const state = mkdtempSync(join(tmpdir(), 'vnext-code-sandbox-state-'));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    execFileSync('/usr/bin/nc', ['-z', '127.0.0.1', String(port)], {
      stdio: 'ignore'
    });
    const profile = buildCodeSandboxProfile({ worktreePath: root, statePath: state });
    const blocked = spawnSync('/usr/bin/sandbox-exec', [
      '-p', profile, '/usr/bin/nc', '-z', '127.0.0.1', String(port)
    ]);
    assert.notEqual(blocked.status, 0);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('code candidate execution refuses unsupported platforms before filesystem access', {
  skip: process.platform === VNEXT_CODE_SANDBOX_PLATFORM
}, () => {
  const result = executeGuardedCodeCandidate({
    repositoryRoot: '/does-not-exist',
    outputRoot: '/also-does-not-exist',
    runId: 'unsupported-platform',
    baseCommit: '0'.repeat(40),
    candidate: {},
    contract: {},
    verification: {},
    createdAt: NOW
  });
  assert.equal(result.status, 'REFUSED');
  assert.equal(result.code, 'VNEXT_CODE_SANDBOX_UNSUPPORTED');
});
