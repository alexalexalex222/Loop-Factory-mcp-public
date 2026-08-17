import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  VNEXT_CANDIDATE_CONTRACT_SCHEMA,
  validateCandidateContract,
  validateCandidateVerification
} from './vnext-candidate-generators.mjs';

export const VNEXT_CODE_WORKTREE_RUN_SCHEMA = 'vnext-code-worktree-run-v1';
export const VNEXT_CODE_SANDBOX_PLATFORM = 'darwin';

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function atomicWrite(path, content, mode = null) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.new`;
  if (existsSync(next)) throw new Error(`atomic staging path already exists: ${next}`);
  writeFileSync(next, content);
  if (mode != null) chmodSync(next, mode);
  renameSync(next, path);
}

function git(cwd, args, options = {}) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
}

function sandboxQuote(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function buildCodeSandboxProfile({ worktreePath, statePath } = {}) {
  if (typeof worktreePath !== 'string' || typeof statePath !== 'string'
      || !worktreePath.startsWith('/') || !statePath.startsWith('/')) return null;
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)',
    `(allow file-write* (subpath "${sandboxQuote(worktreePath)}") (subpath "${sandboxQuote(statePath)}") (literal "/dev/null"))`,
    '(deny network*)'
  ].join('\n');
}

function receiptCoreValid(receipt) {
  return exactKeys(receipt, [
    'activationAuthority', 'baseCommit', 'candidateSha256', 'contractSha256',
    'createdAt', 'diffCheckPassed', 'gitStatus', 'mutations', 'networkAllowed',
    'inputPacketSha256', 'patchBytes', 'patchSha256', 'promotionAuthority',
    'receiptSha256', 'repositoryRoot', 'runId', 'sandboxExecutableSha256',
    'sandboxProfileSha256', 'schemaVersion', 'statePath', 'status', 'tests',
    'verificationSha256', 'worktreePath'
  ])
    && receipt.schemaVersion === VNEXT_CODE_WORKTREE_RUN_SCHEMA
    && receipt.status === 'PASS'
    && isSafeId(receipt.runId)
    && COMMIT.test(String(receipt.baseCommit || ''))
    && [receipt.candidateSha256, receipt.contractSha256,
      receipt.verificationSha256, receipt.patchSha256,
      receipt.inputPacketSha256, receipt.sandboxExecutableSha256,
      receipt.sandboxProfileSha256, receipt.receiptSha256]
      .every((value) => SHA256.test(String(value || '')))
    && receipt.activationAuthority === false
    && receipt.promotionAuthority === false
    && receipt.networkAllowed === false
    && receipt.diffCheckPassed === true
    && Number.isInteger(receipt.patchBytes)
    && receipt.patchBytes > 0
    && typeof receipt.createdAt === 'string'
    && Number.isFinite(Date.parse(receipt.createdAt))
    && [receipt.repositoryRoot, receipt.worktreePath, receipt.statePath]
      .every((value) => typeof value === 'string' && value.startsWith('/'))
    && typeof receipt.gitStatus === 'string'
    && Array.isArray(receipt.mutations)
    && receipt.mutations.length > 0
    && receipt.mutations.every((mutation) => exactKeys(mutation, [
      'afterBytes', 'afterSha256', 'beforeSha256', 'target'
    ])
      && typeof mutation.target === 'string'
      && mutation.target.length > 0
      && !mutation.target.startsWith('/')
      && !mutation.target.split('/').includes('..')
      && SHA256.test(String(mutation.beforeSha256 || ''))
      && SHA256.test(String(mutation.afterSha256 || ''))
      && Number.isInteger(mutation.afterBytes)
      && mutation.afterBytes > 0)
    && Array.isArray(receipt.tests)
    && receipt.tests.length > 0
    && receipt.tests.every((test) => exactKeys(test, [
      'args', 'argsSha256', 'elapsedMs', 'executable', 'executableSha256',
      'exitCode', 'signal', 'stderrPath', 'stderrSha256', 'stdoutPath',
      'stdoutSha256', 'testId', 'timedOut', 'timeoutMs'
    ])
      && isSafeId(test.testId)
      && typeof test.executable === 'string'
      && test.executable.startsWith('/')
      && SHA256.test(String(test.executableSha256 || ''))
      && Array.isArray(test.args)
      && test.args.every((arg) => typeof arg === 'string')
      && test.argsSha256 === sha256(canonicalVNextJson(test.args))
      && Number.isInteger(test.timeoutMs)
      && test.timeoutMs > 0
      && Number.isInteger(test.elapsedMs)
      && test.elapsedMs >= 0
      && test.exitCode === 0
      && test.signal === null
      && test.timedOut === false
      && [test.stdoutSha256, test.stderrSha256]
        .every((value) => SHA256.test(String(value || '')))
      && [test.stdoutPath, test.stderrPath]
        .every((value) => typeof value === 'string' && value.startsWith('/')));
}

function runTest(test, { profile, statePath, worktreePath }) {
  if (!existsSync(test.executable)
      || lstatSync(test.executable).isSymbolicLink()
      || sha256(readFileSync(test.executable)) !== test.executableSha256) {
    return refused('VNEXT_CODE_TEST_EXECUTABLE_DRIFT', `Executable identity failed for ${test.testId}.`);
  }
  const home = join(statePath, 'home');
  const temp = join(statePath, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const startedAt = Date.now();
  const child = spawnSync(SANDBOX_EXEC, [
    '-p', profile, test.executable, ...test.args
  ], {
    cwd: worktreePath,
    encoding: 'utf8',
    env: {
      CI: '1',
      HOME: home,
      NO_COLOR: '1',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: temp
    },
    timeout: test.timeoutMs,
    maxBuffer: 2 * 1024 * 1024
  });
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  const logRoot = join(statePath, 'tests');
  const stdoutPath = join(logRoot, `${test.testId}.stdout.txt`);
  const stderrPath = join(logRoot, `${test.testId}.stderr.txt`);
  atomicWrite(stdoutPath, stdout);
  atomicWrite(stderrPath, stderr);
  return {
    status: 'OK',
    test: {
      testId: test.testId,
      executable: test.executable,
      executableSha256: test.executableSha256,
      args: [...test.args],
      argsSha256: sha256(canonicalVNextJson(test.args)),
      timeoutMs: test.timeoutMs,
      elapsedMs: Date.now() - startedAt,
      exitCode: Number.isInteger(child.status) ? child.status : null,
      signal: child.signal ?? null,
      timedOut: child.error?.code === 'ETIMEDOUT',
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      stdoutPath,
      stderrPath
    }
  };
}

export function executeGuardedCodeCandidate(input = {}) {
  if (!exactKeys(input, [
    'baseCommit', 'candidate', 'contract', 'createdAt', 'outputRoot',
    'repositoryRoot', 'runId', 'verification'
  ])) {
    return refused(
      'VNEXT_CODE_WORKTREE_INPUT_INVALID',
      'Code execution input must use the closed worktree packet contract.'
    );
  }
  if (process.platform !== VNEXT_CODE_SANDBOX_PLATFORM) {
    return refused(
      'VNEXT_CODE_SANDBOX_UNSUPPORTED',
      'Code candidate execution requires the macOS sandbox-exec boundary.'
    );
  }
  const {
    repositoryRoot,
    outputRoot,
    runId,
    baseCommit,
    candidate,
    contract,
    verification,
    createdAt
  } = input;
  const contractValidation = validateCandidateContract(contract);
  const verificationValidation = validateCandidateVerification(verification, {
    candidate,
    contract
  });
  if (!isSafeId(runId)
      || !COMMIT.test(String(baseCommit || ''))
      || typeof createdAt !== 'string'
      || !Number.isFinite(Date.parse(createdAt))
      || contractValidation.status !== 'OK'
      || verificationValidation.status !== 'OK'
      || contract.schemaVersion !== VNEXT_CANDIDATE_CONTRACT_SCHEMA
      || contract.strategy !== 'code-level-experimental'
      || contract.strategyPlan.policy.disposableWorktree !== true
      || contract.strategyPlan.policy.networkDuringExecution !== false) {
    return refused('VNEXT_CODE_WORKTREE_INPUT_INVALID', 'Code execution requires a verified V2 code-level candidate, frozen commit, and disposable network-denied policy.');
  }
  if (typeof repositoryRoot !== 'string' || typeof outputRoot !== 'string'
      || !repositoryRoot.startsWith('/') || !outputRoot.startsWith('/')) {
    return refused('VNEXT_CODE_WORKTREE_PATH_INVALID', 'Repository and output roots must be absolute.');
  }

  let repository;
  try {
    repository = realpathSync(repositoryRoot);
    if (realpathSync(git(repository, ['rev-parse', '--show-toplevel'])) !== repository) {
      return refused('VNEXT_CODE_REPOSITORY_INVALID', 'Repository root is not the Git top level.');
    }
    git(repository, ['cat-file', '-e', `${baseCommit}^{commit}`]);
  } catch (error) {
    return refused('VNEXT_CODE_REPOSITORY_INVALID', error.message);
  }
  const output = resolve(outputRoot);
  if (output === repository || inside(repository, output)) {
    return refused('VNEXT_CODE_OUTPUT_INSIDE_REPOSITORY', 'Disposable worktrees must live outside the source repository.');
  }
  const worktreePath = join(output, 'worktrees', runId);
  const statePath = join(output, 'runs', runId);
  if (existsSync(worktreePath) || existsSync(statePath)) {
    return refused('VNEXT_CODE_RUN_ALREADY_EXISTS', 'Code worktree run paths already exist.');
  }
  mkdirSync(dirname(worktreePath), { recursive: true });
  mkdirSync(statePath, { recursive: true });
  const inputPacket = {
    schemaVersion: 'vnext-code-worktree-input-v1',
    repositoryRoot,
    outputRoot,
    runId,
    baseCommit,
    candidate,
    contract,
    verification,
    createdAt: new Date(createdAt).toISOString()
  };
  const inputPacketText = canonicalVNextJson(inputPacket);
  atomicWrite(join(statePath, 'input.json'), `${inputPacketText}\n`);

  try {
    git(repository, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
  } catch (error) {
    return refused('VNEXT_CODE_WORKTREE_CREATE_FAILED', error.message, { statePath, worktreePath });
  }

  try {
    if (git(worktreePath, ['rev-parse', 'HEAD']) !== baseCommit) {
      return refused('VNEXT_CODE_WORKTREE_HEAD_MISMATCH', 'Disposable worktree checked out the wrong commit.', { statePath, worktreePath });
    }
    const sourceByTarget = new Map(
      contract.strategyPlan.context.sourceTargets.map((row) => [row.target, row.sourceSha256])
    );
    const mutations = [];
    for (const operation of candidate.operations) {
      const path = resolve(worktreePath, operation.target);
      if (!inside(worktreePath, path)
          || operation.op !== 'replace'
          || !sourceByTarget.has(operation.target)
          || !existsSync(path)) {
        return refused('VNEXT_CODE_MUTATION_TARGET_INVALID', 'Candidate escaped the frozen replace-only source target set.', { statePath, worktreePath });
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return refused('VNEXT_CODE_MUTATION_TARGET_INVALID', 'Code mutation targets must be regular files.', { statePath, worktreePath });
      }
      const before = readFileSync(path);
      const beforeSha256 = sha256(before);
      if (beforeSha256 !== operation.beforeSha256
          || beforeSha256 !== sourceByTarget.get(operation.target)) {
        return refused('VNEXT_CODE_SOURCE_DRIFT', 'Disposable source bytes do not match the frozen candidate plan.', { statePath, worktreePath });
      }
      atomicWrite(path, operation.value, stat.mode);
      mutations.push({
        target: operation.target,
        beforeSha256,
        afterSha256: sha256(operation.value),
        afterBytes: Buffer.byteLength(operation.value)
      });
    }

    const changed = git(worktreePath, ['diff', '--name-only', '--'])
      .split('\n').filter(Boolean).sort();
    const expected = mutations.map(({ target }) => target).sort();
    if (canonicalVNextJson(changed) !== canonicalVNextJson(expected)) {
      return refused('VNEXT_CODE_CHANGED_PATH_MISMATCH', 'Git changed paths do not match the candidate targets.', { changed, expected, statePath, worktreePath });
    }
    git(worktreePath, ['diff', '--check']);
    const profile = buildCodeSandboxProfile({ worktreePath, statePath });
    atomicWrite(join(statePath, 'sandbox.sb'), `${profile}\n`);
    const tests = [];
    for (const test of contract.strategyPlan.context.requiredTests) {
      const result = runTest(test, { profile, statePath, worktreePath });
      if (result.status !== 'OK') return { ...result, statePath, worktreePath };
      tests.push(result.test);
      if (result.test.exitCode !== 0 || result.test.timedOut) {
        return refused('VNEXT_CODE_REQUIRED_TEST_FAILED', `Required test ${test.testId} failed.`, { statePath, test: result.test, worktreePath });
      }
    }

    const changedAfterTests = git(worktreePath, ['diff', '--name-only', '--'])
      .split('\n').filter(Boolean).sort();
    if (canonicalVNextJson(changedAfterTests) !== canonicalVNextJson(expected)) {
      return refused('VNEXT_CODE_TEST_MUTATED_SCOPE', 'Required tests changed files outside the candidate scope.', { changedAfterTests, expected, statePath, worktreePath });
    }
    for (const mutation of mutations) {
      if (sha256(readFileSync(join(worktreePath, mutation.target))) !== mutation.afterSha256) {
        return refused('VNEXT_CODE_TEST_MUTATED_CANDIDATE', 'Required tests changed candidate bytes.', { statePath, worktreePath });
      }
    }
    git(worktreePath, ['diff', '--check']);
    const patch = execFileSync('/usr/bin/git', ['diff', '--binary', '--no-ext-diff', '--'], {
      cwd: worktreePath,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const patchBytes = Buffer.byteLength(patch);
    if (patchBytes > contract.strategyPlan.policy.maximumPatchBytes) {
      return refused('VNEXT_CODE_PATCH_BUDGET_EXCEEDED', 'Persisted Git patch exceeds the frozen patch-byte budget.', { patchBytes, statePath, worktreePath });
    }
    const patchPath = join(statePath, 'candidate.patch');
    atomicWrite(patchPath, patch);
    const core = {
      schemaVersion: VNEXT_CODE_WORKTREE_RUN_SCHEMA,
      status: 'PASS',
      runId,
      createdAt: new Date(createdAt).toISOString(),
      repositoryRoot: repository,
      worktreePath,
      statePath,
      baseCommit,
      contractSha256: contract.contractSha256,
      candidateSha256: sha256(canonicalVNextJson(candidate)),
      verificationSha256: verification.verificationSha256,
      inputPacketSha256: sha256(inputPacketText),
      sandboxExecutableSha256: sha256(readFileSync(SANDBOX_EXEC)),
      sandboxProfileSha256: sha256(profile),
      networkAllowed: false,
      mutations,
      tests,
      gitStatus: git(worktreePath, ['status', '--porcelain=v1']),
      diffCheckPassed: true,
      patchSha256: sha256(patch),
      patchBytes,
      activationAuthority: false,
      promotionAuthority: false
    };
    const receipt = {
      ...core,
      receiptSha256: sha256(canonicalVNextJson(core))
    };
    atomicWrite(join(statePath, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return { status: 'OK', receipt, patchPath, statePath, worktreePath };
  } catch (error) {
    return refused('VNEXT_CODE_WORKTREE_EXECUTION_FAILED', error.message, { statePath, worktreePath });
  }
}

export function verifyGuardedCodeWorktreeRun({ receiptPath } = {}) {
  try {
    if (typeof receiptPath !== 'string' || !receiptPath.startsWith('/')
        || !existsSync(receiptPath) || lstatSync(receiptPath).isSymbolicLink()) {
      return refused('VNEXT_CODE_RECEIPT_INVALID', 'Code worktree receipt path is invalid.');
    }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (!receiptCoreValid(receipt)) {
      return refused('VNEXT_CODE_RECEIPT_INVALID', 'Code worktree receipt shape is invalid.');
    }
    if (resolve(receiptPath) !== join(resolve(receipt.statePath), 'receipt.json')
        || !existsSync(receipt.worktreePath)
        || !existsSync(receipt.statePath)
        || lstatSync(receipt.worktreePath).isSymbolicLink()
        || lstatSync(receipt.statePath).isSymbolicLink()) {
      return refused('VNEXT_CODE_RECEIPT_REPLAY_FAILED', 'Code worktree receipt paths are not bound to the run state.');
    }
    const core = structuredClone(receipt);
    delete core.receiptSha256;
    const inputText = readFileSync(join(receipt.statePath, 'input.json'), 'utf8').trimEnd();
    const input = JSON.parse(inputText);
    const profile = readFileSync(join(receipt.statePath, 'sandbox.sb'), 'utf8').trimEnd();
    const patch = readFileSync(join(receipt.statePath, 'candidate.patch'));
    const currentPatch = execFileSync(
      '/usr/bin/git',
      ['diff', '--binary', '--no-ext-diff', '--'],
      { cwd: receipt.worktreePath, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    const contractValidation = validateCandidateContract(input.contract);
    const verificationValidation = validateCandidateVerification(input.verification, {
      candidate: input.candidate,
      contract: input.contract
    });
    const checks = {
      receiptHash: sha256(canonicalVNextJson(core)) === receipt.receiptSha256,
      inputSchema: input.schemaVersion === 'vnext-code-worktree-input-v1',
      inputHash: sha256(inputText) === receipt.inputPacketSha256,
      runBinding: input.runId === receipt.runId,
      commitBinding: input.baseCommit === receipt.baseCommit,
      timeBinding: input.createdAt === receipt.createdAt,
      repositoryBinding: realpathSync(input.repositoryRoot) === receipt.repositoryRoot,
      outputBinding: resolve(input.outputRoot) === resolve(receipt.statePath, '..', '..'),
      contractValid: contractValidation.status === 'OK',
      verificationValid: verificationValidation.status === 'OK',
      contractBinding: input.contract.contractSha256 === receipt.contractSha256,
      candidateBinding: sha256(canonicalVNextJson(input.candidate))
        === receipt.candidateSha256,
      verificationBinding: input.verification.verificationSha256
        === receipt.verificationSha256,
      sandboxExecutable: sha256(readFileSync(SANDBOX_EXEC))
        === receipt.sandboxExecutableSha256,
      sandboxProfile: profile === buildCodeSandboxProfile({
        worktreePath: receipt.worktreePath,
        statePath: receipt.statePath
      }),
      sandboxProfileHash: sha256(profile) === receipt.sandboxProfileSha256,
      patchBytes: patch.length === receipt.patchBytes,
      patchHash: sha256(patch) === receipt.patchSha256,
      patchReplay: currentPatch === patch.toString('utf8'),
      worktreeCommit: git(receipt.worktreePath, ['rev-parse', 'HEAD'])
        === receipt.baseCommit,
      worktreeStatus: git(receipt.worktreePath, ['status', '--porcelain=v1'])
        === receipt.gitStatus
    };
    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length) {
      return refused(
        'VNEXT_CODE_RECEIPT_REPLAY_FAILED',
        'Code worktree receipt failed disk replay.',
        { failedChecks }
      );
    }
    for (const mutation of receipt.mutations) {
      if (sha256(readFileSync(join(receipt.worktreePath, mutation.target))) !== mutation.afterSha256) {
        return refused('VNEXT_CODE_RECEIPT_REPLAY_FAILED', 'Code worktree candidate bytes changed after verification.');
      }
    }
    for (const test of receipt.tests) {
      if (!inside(receipt.statePath, resolve(test.stdoutPath))
          || !inside(receipt.statePath, resolve(test.stderrPath))
          || !existsSync(test.executable)
          || lstatSync(test.executable).isSymbolicLink()
          || sha256(readFileSync(test.executable)) !== test.executableSha256
          || sha256(readFileSync(test.stdoutPath)) !== test.stdoutSha256
          || sha256(readFileSync(test.stderrPath)) !== test.stderrSha256) {
        return refused('VNEXT_CODE_RECEIPT_REPLAY_FAILED', 'Code worktree test output changed after verification.');
      }
    }
    return { status: 'OK', receipt, evidenceSha256: sha256(canonicalVNextJson(receipt)) };
  } catch (error) {
    return refused('VNEXT_CODE_RECEIPT_REPLAY_FAILED', error.message);
  }
}
