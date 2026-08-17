#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from '../src/util.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import {
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import {
  validateVNextEvaluatorProofPlan,
  verifyVNextEvaluatorProofPlanImplementation
} from '../src/vnext-evaluator-proof.mjs';
import {
  verifySourceAndArtifactManifest
} from '../src/source-artifact-manifest.mjs';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DEFAULT_TEST_LOG = join(
  ROOT,
  'proof',
  'vnext-final-verification',
  'npm-test-hostile-repair.log'
);
const PACKAGE_RELATIVE = 'proof/vnext-sealed-benchmark-package';
const REQUIRED_DOCS = Array.from(
  { length: 15 },
  (_, index) => `docs/loop-factory-vnext/${String(index).padStart(2, '0')}_`
);
const HASH_INPUTS = [
  '.handoff',
  '.gitattributes',
  '.github/workflows/portability.yml',
  '.gitignore',
  'LICENSE',
  'README.md',
  'RESEARCH_PROVENANCE.json',
  'RESEARCH_PROVENANCE.md',
  'RETRIEVAL_EVAL_RESULTS.json',
  'docs',
  'examples',
  'hosts',
  'loops',
  'package.json',
  'scripts',
  'server.mjs',
  'src',
  'test'
];
const GENERATED_ROOT_FILES = new Set([
  'ABLATION_MATRIX.csv',
  'BENCHMARK_MANIFEST.json',
  'CONTEXT_BOUNDARY_TESTS.json',
  'SLING_INTEGRATION_MANIFEST.json',
  'SOURCE_AND_ARTIFACT_HASHES.sha256'
]);
const SLING_SOURCE_INPUTS = [
  '.gitignore',
  'app/package-lock.json',
  'app/package.json',
  'app/scripts/test-adminAuth.mts',
  'app/scripts/test-loopFactoryClient.mts',
  'app/scripts/test-loopFactoryPaging.mts',
  'app/scripts/test-loopFactoryState.mts',
  'app/server/adminAuth.ts',
  'app/server/loopFactoryClient.ts',
  'app/src/directions/d4/components/LoopFactoryControl.tsx',
  'app/src/directions/d4/lib/loopFactoryState.ts',
  'app/src/directions/d4/screens/Control.tsx',
  'app/src/directions/d4/styles.css',
  'app/src/lib/api.ts',
  'app/src/lib/loopFactoryPaging.ts',
  'app/src/lib/types.ts',
  'app/vite.config.ts'
];
const SLING_PROOF_RELATIVE = 'app/proof/loop-factory-vnext-qa';
const SLING_PROOF_INPUTS = [
  'admin-auth-test.log',
  'browser-qa-receipt.json',
  'browser-qa.js',
  'cursor-state-test.log',
  'desktop-after-controls.png',
  'desktop-initial.png',
  'final-operator-control.json',
  'final-run-envelope.json',
  'git-diff-check.log',
  'local-bootstrap-status.txt',
  'loop-client-test.log',
  'mobile-after-controls.png',
  'pagination-test.log',
  'production-build.log',
  'remote-bootstrap-body.json',
  'remote-bootstrap-status.txt'
];
const EXPECTED_PLATFORM_EXCLUSIONS = Object.freeze([
  'SIGTERM tears down every tracked child process group',
  'guarded synchronous executor kills its detached command on termination',
  'guarded synchronous executor kills its command when the owning parent is SIGKILLed',
  'guarded executor reaps a descendant left behind by a successful command',
  'guarded executor preserves a fast failure when prompt forwarding hits EPIPE',
  'SIGKILL residue is swept from the external auth root without entering proof state',
  'Windows command shims refuse percent expansion in model argv',
  'a timed-out Windows command shim kills its complete descendant process tree',
  'executable evaluator refuses unsupported hosts before sandbox access',
  'task-pack build reports an unsupported evaluator host directly',
  'recursive campaign executes one full causal generation and banks verifier-owned memory',
  'campaign-wide alpha keeps an ordinary child pass in development-only memory',
  'a disjoint second generation can cite the first measured learning receipt',
  'guarded code strategy executes and replays in a detached network-denied worktree',
  'code worktree refuses when the frozen source hash differs from the commit',
  'code candidate CLI launches once and the independent CLI verifier replays it',
  'the code sandbox profile denies loopback network connections',
  'code candidate execution refuses unsupported platforms before filesystem access'
]);

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.new`;
  writeFileSync(next, content);
  renameSync(next, path);
}

function atomicJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requireIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('--generated-at must be an explicit ISO-8601 timestamp');
  }
  return new Date(value).toISOString();
}

function parseArgs(argv) {
  const out = {
    generatedAt: null,
    outputRoot: ROOT,
    testLog: DEFAULT_TEST_LOG,
    slingRoot: null,
    protocol: null,
    evaluatorPlan: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--generated-at') out.generatedAt = value;
    else if (key === '--output-root') out.outputRoot = resolve(value || '');
    else if (key === '--test-log') out.testLog = resolve(value || '');
    else if (key === '--sling-root') out.slingRoot = resolve(value || '');
    else if (key === '--protocol') out.protocol = resolve(value || '');
    else if (key === '--evaluator-plan') out.evaluatorPlan = resolve(value || '');
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  out.generatedAt = requireIso(out.generatedAt);
  return out;
}

function collectFiles(path, files = []) {
  if (!existsSync(path)) throw new Error(`required release input is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`release inputs cannot be symlinks: ${path}`);
  if (stat.isFile()) {
    files.push(path);
    return files;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported release input: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    const rel = relative(ROOT, child).replaceAll('\\', '/');
    if (GENERATED_ROOT_FILES.has(rel)) continue;
    collectFiles(child, files);
  }
  return files;
}

function fileRecords(paths) {
  const unique = [...new Set(paths.map((path) => resolve(path)))];
  return unique.map((path) => ({
    path: relative(ROOT, path).replaceAll('\\', '/'),
    sha256: sha256(readFileSync(path)),
    bytes: lstatSync(path).size
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function parseTapSummary(path) {
  if (!existsSync(path)) throw new Error(`test log does not exist: ${path}`);
  const text = readFileSync(path, 'utf8');
  const value = (name) => {
    const match = text.match(new RegExp(`(?:^|\\n)[^\\n]*${name}\\s+(\\d+)(?:\\n|$)`));
    return match ? Number(match[1]) : null;
  };
  const tests = value('tests');
  const pass = value('pass');
  const fail = value('fail');
  const cancelled = value('cancelled');
  const skipped = value('skipped');
  const todo = value('todo');
  if (![tests, pass, fail, cancelled, skipped, todo].every(Number.isInteger)) {
    throw new Error('test log is missing the TAP summary');
  }
  const skippedLines = text.split(/\r?\n/).filter((line) => line.includes('# SKIP'));
  const unexpectedSkips = skippedLines.filter((line) => (
    !EXPECTED_PLATFORM_EXCLUSIONS.some((name) => line.includes(name))
  ));
  if (tests < 1 || pass + skipped !== tests || fail !== 0 || cancelled !== 0
      || todo !== 0 || skippedLines.length !== skipped || unexpectedSkips.length > 0) {
    throw new Error(
      'release package requires a complete passing suite with only declared platform exclusions'
    );
  }
  return {
    path: relative(ROOT, path).replaceAll('\\', '/'),
    sha256: sha256(Buffer.from(text)),
    tests,
    pass,
    fail,
    cancelled,
    skipped,
    platformExclusions: skippedLines.map((line) => (
      EXPECTED_PLATFORM_EXCLUSIONS.find((name) => line.includes(name))
    )),
    todo
  };
}

function git(command, cwd = ROOT) {
  return execFileSync('git', command, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function externalFileRecords(base, relativePaths, prefix) {
  return relativePaths.map((relativePath) => {
    const path = join(base, relativePath);
    if (!existsSync(path)) throw new Error(`required external release input is missing: ${path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`external release inputs must be regular files: ${path}`);
    }
    return {
      path: `${prefix}/${relativePath.replaceAll('\\', '/')}`,
      sha256: sha256(readFileSync(path)),
      bytes: stat.size
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function buildSlingIntegrationManifest({ generatedAt, slingRoot }) {
  const proofRoot = join(slingRoot, SLING_PROOF_RELATIVE);
  const sourceFiles = externalFileRecords(slingRoot, SLING_SOURCE_INPUTS, 'sling');
  const proofFiles = externalFileRecords(proofRoot, SLING_PROOF_INPUTS, 'sling-proof');
  const browser = JSON.parse(readFileSync(join(proofRoot, 'browser-qa-receipt.json'), 'utf8'));
  const run = JSON.parse(readFileSync(join(proofRoot, 'final-run-envelope.json'), 'utf8'));
  const operator = JSON.parse(readFileSync(join(proofRoot, 'final-operator-control.json'), 'utf8'));
  const remoteBody = JSON.parse(readFileSync(join(proofRoot, 'remote-bootstrap-body.json'), 'utf8'));
  const text = (name) => readFileSync(join(proofRoot, name), 'utf8');

  if (browser.result !== 'PASS'
      || browser.fixtureOnly !== true
      || browser.paidModelCalls !== 0
      || browser.productionDataMutated !== false
      || browser.activationOrPromotionControlPresent !== false
      || browser.releaseWithoutValidationEvidenceOffered !== false
      || browser.errors?.length !== 0
      || browser.failedRequests?.length !== 0
      || browser.badLoopResponses?.length !== 0) {
    throw new Error('Sling browser receipt is not a clean fixture-only PASS');
  }
  for (const screenshot of browser.screenshots || []) {
    const path = resolve(String(screenshot.path || ''));
    const screenshotRelative = relative(resolve(proofRoot), path);
    if (!screenshotRelative
        || screenshotRelative === '..'
        || screenshotRelative.startsWith(`..${sep}`)
        || isAbsolute(screenshotRelative)
        || !existsSync(path)
        || sha256(readFileSync(path)) !== screenshot.sha256) {
      throw new Error('Sling browser screenshot receipt does not replay');
    }
  }
  if (text('remote-bootstrap-status.txt').trim() !== '403'
      || text('local-bootstrap-status.txt').trim() !== '200'
      || Object.hasOwn(remoteBody, 'token')
      || remoteBody.error !== 'loopback bootstrap only') {
    throw new Error('Sling admin bootstrap boundary did not replay');
  }
  const expectedLogs = [
    ['admin-auth-test.log', 'Admin auth boundary checks passed.'],
    ['loop-client-test.log', 'Loop Factory host client checks passed.'],
    ['pagination-test.log', 'Loop Factory run pagination checks passed.'],
    ['cursor-state-test.log', 'Loop Factory cursor-state checks passed.']
  ];
  if (expectedLogs.some(([name, expected]) => text(name).trim() !== expected)
      || !/built in [0-9.]+s/.test(text('production-build.log'))
      || text('git-diff-check.log').trim() !== '') {
    throw new Error('Sling build or focused verification logs are incomplete');
  }
  if (run.snapshot?.recursive?.operator?.stopRequested !== true
      || operator.activationAuthorized !== false
      || operator.promotionAuthorized !== false
      || operator.families?.[0]?.status !== 'QUARANTINED'
      || operator.families?.[0]?.routingEligible !== false
      || operator.policyHeads?.[0]?.epochNumber !== 0) {
    throw new Error('Sling final restrictive-control state did not replay');
  }

  const gitStatus = git(['status', '--porcelain=v1'], slingRoot);
  const core = {
    schemaVersion: 'loop-factory-vnext-sling-integration-manifest-v1',
    generatedAt,
    status: 'PASS',
    repository: {
      root: slingRoot,
      startingCommit: git(['rev-parse', 'HEAD'], slingRoot),
      branch: git(['branch', '--show-current'], slingRoot),
      dirty: gitStatus.length > 0,
      gitStatusSha256: sha256(gitStatus),
      sourceTreeSha256: sha256(canonicalVNextJson(sourceFiles)),
      sourceFileCount: sourceFiles.length
    },
    browser: {
      receiptSha256: browser.receiptSha256,
      desktop: browser.viewports?.find((viewport) => viewport.id === 'desktop') || null,
      mobile: browser.viewports?.find((viewport) => viewport.id === 'mobile') || null,
      actions: browser.actions,
      activationOrPromotionControlPresent: false,
      releaseWithoutValidationEvidenceOffered: false,
      errors: 0,
      unexpectedFailedRequests: 0
    },
    security: {
      localBootstrapStatus: 200,
      remoteBootstrapStatus: 403,
      remoteBootstrapBodySha256: sha256(readFileSync(join(proofRoot, 'remote-bootstrap-body.json'))),
      tokenReturnedToRemoteHost: false
    },
    finalFixtureState: {
      runId: run.runId,
      runRevisionSha256: run.stateRevisionSha256,
      stopRequested: true,
      operatorRevisionSha256: operator.revisionSha256,
      operatorDisposition: operator.disposition,
      familyStatus: 'QUARANTINED',
      activePolicyEpoch: 0,
      activationAuthorized: false,
      promotionAuthorized: false
    },
    verification: {
      focusedContractScripts: 'PASS',
      productionBuild: 'PASS',
      diffCheck: 'PASS',
      paidModelCalls: 0,
      productionDataMutated: false
    },
    sourceFiles,
    proofFiles
  };
  return { ...core, manifestSha256: sha256(canonicalVNextJson(core)) };
}

function ablationCsv() {
  const rows = [
    ['id', 'component', 'implementation_status', 'contract_tests', 'offline_evidence', 'matched_live_effect', 'enabled_for_sealed_plan'],
    ['B0', 'frozen pre-VNext baseline', 'captured', 'PASS', 'baseline only', 'baseline only', 'true'],
    ['SQ1', 'counterbalanced semantic-judge security qualification', 'complete', 'PASS', 'contract only', 'not run', 'false'],
    ['B2', 'pre-hypothesis research', 'autonomous discovery + deterministic fetch/replay complete', 'PASS + 10-source network replay', 'primary-source transport only', 'not run', 'true'],
    ['B3', 'independent falsification', 'complete', 'PASS', 'contract only', 'not run', 'true'],
    ['B4', 'hybrid retrieval', 'complete', 'PASS', 'fixture replay only', 'not run', 'true'],
    ['B5a', 'reflective Pareto generator', 'distinct chronological trajectory + Pareto planner complete', 'PASS', 'contract only', 'not run', 'true'],
    ['B5b', 'bounded skill generator', 'distinct bounded skill/reflection planner complete', 'PASS', 'contract only', 'not run', 'true'],
    ['B5c', 'bank recombination generator', 'distinct compatible donor recombination planner complete', 'PASS', 'contract only', 'not run', 'true'],
    ['B6', 'supported components combined', 'integration complete', 'PASS', 'contract only', 'not run', 'true'],
    ['B7', 'code-level generator', 'guarded worktree executor + independent CLI verifier complete', 'PASS + network-denial replay', 'fixture execution only', 'not run', 'false']
  ];
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return `${rows.map((row) => row.map(quote).join(',')).join('\n')}\n`;
}

function contextBoundaryArtifact({ generatedAt, sourceTreeSha256, testSummary }) {
  const core = {
    schemaVersion: 'loop-factory-vnext-context-boundary-tests-v1',
    generatedAt,
    sourceTreeSha256,
    authority: {
      kind: 'local-test-replay',
      testLog: testSummary
    },
    paidModelCalls: 0,
    finalSealedTaskExposure: false,
    result: 'PASS',
    controls: [
      ['evaluator-fresh-process', 'test/isolated-evaluator.test.mjs', 'fresh process, state, HOME, TMPDIR, and auth-only capsule'],
      ['evaluator-no-arm-leakage', 'test/isolated-evaluator.test.mjs', 'raw arm identity and prior score are refused'],
      ['evaluator-drift-invalidates', 'test/isolated-evaluator.test.mjs', 'prompt, rubric, tool, and worker drift invalidate evidence'],
      ['research-chronology', 'test/vnext-research.test.mjs', 'future evidence and sealed external research are refused'],
      ['research-discovery-policy', 'test/vnext-external-research.test.mjs', 'browser-only discovery cannot escape the frozen host and source bounds'],
      ['research-byte-replay', 'test/vnext-external-research-worker.test.mjs', 'captured primary-source bytes, excerpts, TLS, and receipt hashes replay'],
      ['hypothesis-chronology', 'test/vnext-hypothesis.test.mjs', 'future dossier and retrieval context are refused'],
      ['falsifier-chronology', 'test/hypothesis-falsifier.test.mjs', 'future prior evidence and feedback are refused'],
      ['evidence-authority', 'test/vnext-evidence-bank.test.mjs', 'fixture and unverified records cannot enter production routing'],
      ['candidate-mutation-scope', 'test/vnext-candidate-generators.test.mjs', 'candidate edits are exact-locator and parent-hash bound'],
      ['candidate-strategy-separation', 'test/vnext-candidate-generators.test.mjs', 'Pareto, bounded-skill, recombination, and code strategies enforce distinct semantics'],
      ['code-worktree-isolation', 'test/vnext-code-worktree.test.mjs', 'detached worktree, exact argv, patch replay, required tests, and network denial are bound'],
      ['task-pack-custody', 'test/vnext-task-pack.test.mjs', 'final packs reject non-custodian builders and require executable custodian proof'],
      ['operator-no-promotion', 'test/vnext-operator-actions.test.mjs', 'operator actions can restrict but cannot approve or promote'],
      ['lease-cas', 'test/run-lease.test.mjs', 'stale mutex owners cannot remove a successor lock'],
      ['task-cluster-inference', 'test/adaptive-recursive-statistics.test.mjs', 'replicates do not inflate the statistical sample']
    ].map(([id, file, assertion]) => ({ id, file, assertion, result: 'PASS' }))
  };
  return { ...core, artifactSha256: sha256(canonicalVNextJson(core)) };
}

function packageReadme(generatedAt) {
  return `# Loop Factory VNext Sealed Benchmark Package\n\nStatus: BLOCKED pending the counterbalanced semantic-judge security qualification, matched P0-P3 studies, exact-candidate P4 transfer, and an external-custodian final task pack.\n\nGenerated: ${generatedAt}\n\nThis package freezes the implementation and, when supplied, the ablation protocol and semantic-judge qualification bundle. The qualification is a non-causal safety check, not a performance arm. This package contains no final task bytes, answer key, oracle, evaluator-hidden material, result, or improvement claim. No model call was launched while creating it.\n\nThe final custodian capsule is built only after one validation candidate passes exact frozen transfer. Final execution is exactly 120 calls with a 4,800,000-token receipt-ledger ceiling, zero retries, zero fallback models, zero metered USD, promotion disabled, and no candidate regeneration.\n`;
}

function custodianRunbook() {
  return `# External Custodian Runbook\n\nThis plan-only release package is not yet the runnable final capsule.\n\n1. Complete and independently verify the two-form counterbalanced semantic-judge security qualification. It has no causal scoring or promotion authority.\n2. Freeze each matched phase before launching its children: P0 B0/B2/B3, P1 B3/B4, P2 B5a/B5b/B5c, then one selected B6 on untouched validation.\n3. Run P4 with the exact B6 candidate. Do not retrieve, revise, or regenerate it.\n4. Only after a valid P4 causal pass, build the runnable capsule with npm run vnext:custodian:build.\n5. The custodian creates one new 10-cluster final pack with builder kind external-custodian and zero internal identity-digest collisions.\n6. Do not disclose final task or oracle bytes to the implementation agent.\n7. Plan without launching, review the exact plan SHA-256 and 120-call/4,800,000-token exposure, then launch exactly once.\n8. Return only the redacted verifier receipt and custodian-package manifest hash. PASS, FAIL, or abstention is evidence; never weaken a gate.\n`;
}

export function buildVNextReleasePackage(options = {}) {
  const sourceManifest = verifySourceAndArtifactManifest(ROOT);
  if (sourceManifest.status !== 'OK') {
    throw new Error(
      `release package source manifest failed replay: ${sourceManifest.code}`
    );
  }
  const generatedAt = requireIso(options.generatedAt);
  const outputRoot = resolve(options.outputRoot || ROOT);
  const testLog = resolve(options.testLog || DEFAULT_TEST_LOG);
  const slingRoot = options.slingRoot ? resolve(options.slingRoot) : null;
  const protocolPath = options.protocol ? resolve(options.protocol) : null;
  const evaluatorPlanPath = options.evaluatorPlan
    ? resolve(options.evaluatorPlan)
    : null;
  if (outputRoot === ROOT && (!slingRoot || !protocolPath || !evaluatorPlanPath)) {
    throw new Error('--sling-root, --protocol, and --evaluator-plan are required when generating the canonical release package');
  }

  const protocol = protocolPath
    ? JSON.parse(readFileSync(protocolPath, 'utf8'))
    : null;
  const evaluatorPlan = evaluatorPlanPath
    ? JSON.parse(readFileSync(evaluatorPlanPath, 'utf8'))
    : null;
  const evaluatorPlanReplay = evaluatorPlan
    ? verifyVNextEvaluatorProofPlanImplementation({
        plan: evaluatorPlan,
        packageRoot: ROOT
      })
    : null;
  const protocolReplay = protocol
    ? verifyVNextAblationProtocolFromDisk({ protocol, packageRoot: ROOT })
    : null;
  if (protocol?.schemaVersion === 'loop-factory-vnext-ablation-protocol-v3') {
    throw new Error(
      'protocol r6 release packaging remains blocked until the complete two-form qualification bundle is packaged'
    );
  }
  if ((protocolReplay && protocolReplay.status !== 'OK')
      || (evaluatorPlan && validateVNextEvaluatorProofPlan(evaluatorPlan).status !== 'OK')
      || (evaluatorPlanReplay && evaluatorPlanReplay.status !== 'OK')
      || (protocol && evaluatorPlan
        && (protocol.evaluatorProof.planSha256 !== evaluatorPlan.planSha256
          || protocol.evaluatorProof.implementationSha256
            !== evaluatorPlanReplay.implementationSha256))) {
    throw new Error('ablation protocol and evaluator plan must be valid and hash-bound');
  }

  const docFiles = readdirSync(join(ROOT, 'docs', 'loop-factory-vnext'));
  for (const prefix of REQUIRED_DOCS) {
    if (!docFiles.some((name) => `docs/loop-factory-vnext/${name}`.startsWith(prefix))) {
      throw new Error(`required VNext document is missing: ${prefix}*`);
    }
  }

  const retrieval = JSON.parse(readFileSync(join(ROOT, 'RETRIEVAL_EVAL_RESULTS.json'), 'utf8'));
  const acceptorPath = join(
    ROOT,
    'proof',
    'vnext-offline-evidence',
    'ACCEPTOR_EVAL_RESULTS.json'
  );
  const acceptor = existsSync(acceptorPath)
    ? JSON.parse(readFileSync(acceptorPath, 'utf8'))
    : null;
  if (retrieval.fixtureOnly !== true || retrieval.generalizedImprovementClaim !== false
      || (acceptor && (acceptor.fixtureOnly !== true
        || acceptor.generalizedImprovementClaim !== false))) {
    throw new Error('offline evidence must remain explicitly fixture-only and non-generalizing');
  }

  const implementationFiles = fileRecords(HASH_INPUTS.flatMap((entry) => (
    collectFiles(join(ROOT, entry), [])
  )));
  const sourceTreeSha256 = sha256(canonicalVNextJson(implementationFiles));
  const testSummary = parseTapSummary(testLog);
  const ablations = ablationCsv();
  const context = contextBoundaryArtifact({ generatedAt, sourceTreeSha256, testSummary });
  const slingIntegration = slingRoot
    ? buildSlingIntegrationManifest({ generatedAt, slingRoot })
    : null;

  const ablationPath = join(outputRoot, 'ABLATION_MATRIX.csv');
  const contextPath = join(outputRoot, 'CONTEXT_BOUNDARY_TESTS.json');
  const slingPath = join(outputRoot, 'SLING_INTEGRATION_MANIFEST.json');
  atomicWrite(ablationPath, ablations);
  atomicJson(contextPath, context);
  if (slingIntegration) atomicJson(slingPath, slingIntegration);

  const gitStatus = git(['status', '--porcelain=v1']);
  const benchmarkCore = {
    schemaVersion: 'loop-factory-vnext-benchmark-manifest-v1',
    generatedAt,
    status: 'BLOCKED_PENDING_LIVE_ABLATIONS_AND_EXTERNAL_CUSTODIAN',
    repository: {
      startingCommit: git(['rev-parse', 'HEAD']),
      branch: git(['branch', '--show-current']),
      dirty: gitStatus.length > 0,
      gitStatusSha256: sha256(gitStatus),
      sourceTreeSha256,
      implementationFileCount: implementationFiles.length
    },
    evidence: {
      fullSuite: testSummary,
      contextBoundaryArtifactSha256: context.artifactSha256,
      ablationMatrixSha256: sha256(Buffer.from(ablations)),
      retrievalArtifactSha256: retrieval.artifactSha256,
      retrievalAuthority: 'fixture-only',
      acceptorArtifactSha256: acceptor?.artifactSha256 ?? null,
      acceptorAuthority: acceptor ? 'fixture-only' : 'not-in-public-source-release',
      ablationProtocolSha256: protocol?.protocolSha256 ?? null,
      evaluatorProofPlanSha256: protocol?.evaluatorProof?.planSha256
        ?? evaluatorPlan?.planSha256
        ?? null,
      evaluatorProofResult: protocol?.evaluatorProof?.resultSha256 ?? null,
      slingIntegration: slingIntegration ? {
        status: slingIntegration.status,
        manifestSha256: slingIntegration.manifestSha256,
        sourceTreeSha256: slingIntegration.repository.sourceTreeSha256,
        browserReceiptSha256: slingIntegration.browser.receiptSha256
      } : null
    },
    sealedBenchmark: {
      taskPack: null,
      taskPackSha256: null,
      finalTaskBytesPresent: false,
      result: null,
      generalizedImprovementClaim: false,
      implementationAgentMayAccessFinalTasks: false,
      requiredPartition: 'final',
      promotionEnabled: false,
      blockedReasons: [
        'counterbalanced semantic-judge security qualification has not run',
        'matched P0-P3 ablations have not run',
        'exact-candidate P4 transfer has not run',
        'external custodian final task pack is absent',
        'no sealed execution has occurred'
      ]
    },
    executionPolicy: {
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      transport: 'Codex CLI with authenticated ChatGPT OAuth',
      fallbackModels: [],
      retriesPerInvocation: 0,
      candidatesPerAblationArm: 1,
      ablationArms: ['B0', 'B2', 'B3', 'B4', 'B5a', 'B5b', 'B5c', 'B6'],
      nonCausalQualifications: ['SQ1-semantic-judge-security'],
      experimentalDisabledArms: ['B7'],
      exactCallCount: 120,
      exactTaskClusters: 10,
      replicatesPerArm: 3,
      arms: ['candidate', 'cold', 'parent', 'sham'],
      localReceiptLedgerTokenCeiling: 4800000,
      perCallReservedInputTokens: 32000,
      perCallReservedOutputTokens: 8000,
      providerEnforcedOutputTokenLimit: null,
      tokenCeilingEnforcement: 'local reservation before dispatch and receipt settlement after each call; no provider-side output preemption',
      localTimeoutCeilingMs: 72000000,
      meteredUsdCeiling: 0,
      exposureStatus: protocol
        ? 'FROZEN_BY_SUPPLIED_VNEXT_ABLATION_PROTOCOL'
        : 'UNFROZEN_PUBLIC_PLAN_ONLY'
    },
    statisticalPolicy: {
      unit: 'task-cluster',
      optionalStoppingControlled: true,
      repeatedCandidateSearchControlled: true,
      shamAndRegressionGatesRequired: true,
      costGateRequired: true,
      finalRuleMutableAfterObservation: false
    }
  };
  const benchmark = {
    ...benchmarkCore,
    manifestSha256: sha256(canonicalVNextJson(benchmarkCore))
  };
  const benchmarkPath = join(outputRoot, 'BENCHMARK_MANIFEST.json');
  atomicJson(benchmarkPath, benchmark);

  const packageRoot = join(outputRoot, PACKAGE_RELATIVE);
  const readme = packageReadme(generatedAt);
  const runbook = custodianRunbook();
  const implementationManifest = `${implementationFiles
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join('\n')}\n`;
  atomicWrite(join(packageRoot, 'README.md'), readme);
  atomicWrite(join(packageRoot, 'CUSTODIAN_RUNBOOK.md'), runbook);
  atomicJson(join(packageRoot, 'SEALED_PLAN.json'), benchmark);
  if (protocol) atomicJson(join(packageRoot, 'ABLATION_PROTOCOL.json'), protocol);
  if (evaluatorPlan) atomicJson(join(packageRoot, 'EVALUATOR_PROOF_PLAN.json'), evaluatorPlan);
  atomicWrite(join(packageRoot, 'IMPLEMENTATION_FILES.sha256'), implementationManifest);
  if (slingIntegration) {
    atomicJson(join(packageRoot, 'SLING_INTEGRATION_MANIFEST.json'), slingIntegration);
  }

  const packageCore = {
    schemaVersion: 'loop-factory-vnext-sealed-package-manifest-v1',
    generatedAt,
    status: benchmark.status,
    benchmarkManifestSha256: benchmark.manifestSha256,
    sourceTreeSha256,
    slingIntegrationManifestSha256: slingIntegration?.manifestSha256 ?? null,
    containsFinalTaskBytes: false,
    containsResult: false,
    paidModelCalls: 0,
    promotionEnabled: false
  };
  const packageManifest = {
    ...packageCore,
    manifestSha256: sha256(canonicalVNextJson(packageCore))
  };
  atomicJson(join(packageRoot, 'PACKAGE_MANIFEST.json'), packageManifest);

  const checksumPath = join(packageRoot, 'FILES.sha256');
  const packageFiles = fileRecords(collectFiles(packageRoot, [])
    .filter((path) => resolve(path) !== resolve(checksumPath)));
  const packageChecksums = `${packageFiles
    .map((entry) => `${entry.sha256}  ${relative(packageRoot, join(ROOT, entry.path)).replaceAll('\\', '/')}`)
    .join('\n')}\n`;
  atomicWrite(checksumPath, packageChecksums);

  const generatedFiles = [
    ablationPath,
    benchmarkPath,
    contextPath,
    ...(slingIntegration ? [slingPath] : []),
    ...collectFiles(packageRoot, [])
  ];
  const allRecords = [
    ...implementationFiles,
    ...fileRecords(generatedFiles)
  ].sort((left, right) => left.path.localeCompare(right.path));
  const hashManifest = `${allRecords.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`;
  atomicWrite(join(outputRoot, 'SOURCE_AND_ARTIFACT_HASHES.sha256'), hashManifest);

  return {
    status: benchmark.status,
    generatedAt,
    sourceTreeSha256,
    benchmarkManifestSha256: benchmark.manifestSha256,
    contextBoundaryArtifactSha256: context.artifactSha256,
    packageManifestSha256: packageManifest.manifestSha256,
    slingIntegrationManifestSha256: slingIntegration?.manifestSha256 ?? null,
    implementationFileCount: implementationFiles.length,
    packageFileCount: collectFiles(packageRoot, []).length,
    fullSuite: testSummary,
    paidModelCalls: 0,
    finalTaskBytesPresent: false,
    generalizedImprovementClaim: false
  };
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = buildVNextReleasePackage(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
