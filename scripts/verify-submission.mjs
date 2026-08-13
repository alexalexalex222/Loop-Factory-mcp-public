#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCanaryRun } from '../src/canary-runner.mjs';
import { parseTokenUsage } from '../src/executor.mjs';
import {
  buildRealTestCanaryPlan,
  validateRealTestCanaryConfig
} from '../src/real-test.mjs';
import { createStore } from '../src/store.mjs';
import { isMainModule, sha256 } from '../src/util.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_BUNDLE_ROOT = join(
  PACKAGE_ROOT,
  'submission',
  'evidence',
  'context-isolation-canary-20260719'
);
const DEFAULT_PRODUCTION_BUNDLE_ROOT = join(
  PACKAGE_ROOT,
  'submission',
  'evidence',
  'production-frontier-20260720'
);
const MANIFEST_NAME = 'bundle-manifest.json';
const EXPECTED_MANIFEST_SHA256 = 'b0ec6646ab7c385518ca72e66ba3749cf0992710fff6a38ac7a5f5f38689bff5';
const EXPECTED_PRODUCTION_MANIFEST_SHA256 = '62f351372d9a9fe27399ac37e7b855a1357823952716ab1f1d398cffd83aa803';
const EXPECTED = Object.freeze({
  bundleId: 'loop-factory-build-week-context-isolation-canary-20260719',
  runId: 'context-isolation-canary-20260719',
  model: 'gpt-5.6-sol',
  sourceConfigSha256: '562a481a2eb8899039eec313acf6433733e679035d6874e380d741c9de816974',
  sourceStateSha256: '5704e9f5d1385fe8ce459e3e48d673edd512b65693b4c20536f2a4e07ccb14b7',
  sourcePlanSha256: '112da9ae56754d364dcb5a833f976aba09d6ec3ef06471b5ee9f36cea10f0550',
  publicPlanSha256: 'b8e75584c62ddf7e3d1a467db397a78d0f0fdeba24e4b9e9d140ca4319956b3d',
  proposalCount: 1,
  evaluationCount: 15,
  callCount: 16,
  protectedArtifactCount: 47,
  armCounts: Object.freeze({ baseline: 5, challenger: 5, sham: 5 }),
  pairedTargetWins: 5,
  shamWins: 0,
  controlRegressions: 0,
  proposalTokens: 28368,
  evaluationTokens: 413259,
  totalTokens: 441627
});
const EXPECTED_PRODUCTION = Object.freeze({
  bundleId: 'loop-factory-build-week-production-frontier-20260720',
  runId: 'production-frontier-20260720-r3',
  childRunId: 'production-frontier-20260720-r3-t1',
  model: 'gpt-5.6-sol',
  callCount: 12,
  totalTokens: 724453,
  artifactCount: 34,
  baselineQuality: 0.619,
  h1Quality: 1,
  h2Quality: 1,
  recommendedReviewId: 'rev-001',
  verifierEvidenceSha256: '07866647944a6b291eab0e2c8f8c677728039d94fbb86c6ab3e381bc22b9bd74',
  fileCount: 10
});

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(current, entry.name);
      return entry.isDirectory()
        ? listFiles(root, full)
        : [relative(root, full).split(sep).join('/')];
    })
    .sort();
}

function gate(pass, reasons = [], details = {}) {
  const failures = (Array.isArray(reasons) ? reasons : [reasons]).filter(Boolean);
  return {
    status: pass ? 'PASS' : 'FAIL',
    reasons: pass ? [] : failures,
    ...details
  };
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function modelFlagMatches(argv, model) {
  const values = Array.isArray(argv) ? argv.map(String) : [];
  const indexes = values.flatMap((value, index) => value === '-m' ? [index] : []);
  return indexes.length === 1 && values[indexes[0] + 1] === model;
}

function schemaArgMatches(argv, schemaName) {
  const values = Array.isArray(argv) ? argv.map(String) : [];
  const index = values.indexOf('--output-schema');
  return index >= 0 && basename(values[index + 1] || '') === schemaName;
}

function artifactPath(runId, artifactId) {
  return ['state', 'runs', runId, 'artifacts', `${artifactId}.json`].join('/');
}

function collectPrivacyFindings(bundleRoot, files) {
  const patterns = [
    ['operator-home-path', /\/Users\/(?!\[USER\]\/)[A-Za-z0-9._-]+\//],
    ['linux-home-path', /\/home\/(?!\[USER\]\/)[A-Za-z0-9._-]+\//],
    ['darwin-temp-path', /\/(?:private\/)?var\/folders\/[^\s"'<>]+/],
    ['temporary-root-path', /\/(?:private\/)?tmp\/[^\s"'<>]+/],
    ['absolute-workspace-root', /"workspaceRoot"\s*:\s*"\//],
    ['absolute-cwd-argv', /"-C"\s*,\s*"\//],
    ['email-address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ['private-key', /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
    ['bearer-token', /Bearer\s+[A-Za-z0-9._-]{12,}/i],
    ['provider-key', /\b(?:sk|key)-[A-Za-z0-9_-]{20,}\b/],
    [
      'secret-json-value',
      /"(?:apiKey|accessToken|clientSecret|password|privateKey)"\s*:\s*"(?!unset|null|\[REDACTED\])[^"]{8,}"/i
    ]
  ];
  const findings = [];
  for (const file of files) {
    const content = readFileSync(join(bundleRoot, file), 'utf8');
    for (const [code, pattern] of patterns) {
      if (pattern.test(content)) findings.push({ code, file });
    }
  }
  return findings.sort((a, b) => `${a.file}:${a.code}`.localeCompare(`${b.file}:${b.code}`));
}

function verifyProductionSupplement(bundleRoot) {
  const resolvedBundleRoot = resolve(bundleRoot);
  const manifestPath = join(resolvedBundleRoot, MANIFEST_NAME);
  try {
    if (!existsSync(manifestPath)) {
      return {
        status: 'FAIL',
        reasons: ['production evidence manifest is missing'],
        manifestSha256: null,
        fileCount: 0,
        metrics: null
      };
    }

    const manifest = readJson(manifestPath);
    const manifestSha256 = sha256File(manifestPath);
    const manifestEntries = Array.isArray(manifest.files) ? manifest.files : [];
    const manifestByPath = new Map(manifestEntries.map((entry) => [entry.path, entry]));
    const actualFiles = listFiles(resolvedBundleRoot);
    const protectedFiles = actualFiles.filter((file) => file !== MANIFEST_NAME);
    const reasons = [];

    if (manifest.schemaVersion !== 1
      || manifest.bundleId !== EXPECTED_PRODUCTION.bundleId
      || manifest.runId !== EXPECTED_PRODUCTION.runId) {
      reasons.push('production bundle identity does not match the submission contract');
    }
    if (manifestSha256 !== EXPECTED_PRODUCTION_MANIFEST_SHA256) {
      reasons.push('production bundle manifest hash does not match the verifier-pinned hash');
    }
    if (manifestEntries.length !== EXPECTED_PRODUCTION.fileCount
      || !sameJson([...manifestByPath.keys()].sort(), protectedFiles)) {
      reasons.push('production bundle file set does not exactly match the manifest');
    }
    for (const entry of manifestEntries) {
      const full = join(resolvedBundleRoot, String(entry.path || ''));
      if (!existsSync(full) || !statSync(full).isFile()) {
        reasons.push(`production manifest file is missing: ${entry.path}`);
        continue;
      }
      if (statSync(full).size !== entry.bytes || sha256File(full) !== entry.sha256) {
        reasons.push(`production manifest hash or byte count failed: ${entry.path}`);
      }
    }

    const privacyFiles = actualFiles.filter((file) => /\.(?:json|jsonl|md|txt)$/i.test(file));
    const privacyFindings = collectPrivacyFindings(resolvedBundleRoot, privacyFiles);
    reasons.push(...privacyFindings.map((item) => (
      `production privacy ${item.code}: ${item.file}`
    )));

    const summary = readJson(join(resolvedBundleRoot, 'summary.json'));
    const verifier = readJson(join(resolvedBundleRoot, 'verifier.json'));
    const challengers = new Map(
      (Array.isArray(summary.challengers) ? summary.challengers : [])
        .map((row) => [row.id, row])
    );
    const h1 = challengers.get('finding-001-h1');
    const h2 = challengers.get('finding-001-h2');
    const summaryPass = summary.schemaVersion === 1
      && summary.bundleId === EXPECTED_PRODUCTION.bundleId
      && summary.runId === EXPECTED_PRODUCTION.runId
      && summary.childRunId === EXPECTED_PRODUCTION.childRunId
      && summary.model === EXPECTED_PRODUCTION.model
      && summary.reasoning === 'high'
      && summary.authentication === 'chatgpt-oauth-subscription'
      && summary.perCallApiBillingAsserted === false
      && summary.callCount === EXPECTED_PRODUCTION.callCount
      && sameJson(summary.callBreakdown, {
        mining: 1,
        baselineEvaluations: 3,
        proposals: 2,
        challengerEvaluations: 6
      })
      && summary.retries === 0
      && summary.attemptZeroCount === EXPECTED_PRODUCTION.callCount
      && summary.exitZeroCount === EXPECTED_PRODUCTION.callCount
      && summary.isolationPassCount === EXPECTED_PRODUCTION.callCount
      && summary.uniqueThreadCount === EXPECTED_PRODUCTION.callCount
      && summary.uniqueWorkspaceCount === EXPECTED_PRODUCTION.callCount
      && summary.cliReportedTokens === EXPECTED_PRODUCTION.totalTokens
      && summary.artifactCount === EXPECTED_PRODUCTION.artifactCount
      && summary.artifactProblems === 0
      && summary.baseline?.quality === EXPECTED_PRODUCTION.baselineQuality
      && summary.baseline?.replicates === 3
      && h1?.quality === EXPECTED_PRODUCTION.h1Quality
      && h1?.reverified === true
      && h1?.reviewStatus === 'PENDING'
      && h2?.quality === EXPECTED_PRODUCTION.h2Quality
      && h2?.reverified === true
      && h2?.reviewStatus === 'PENDING'
      && summary.recommendedReviewId === EXPECTED_PRODUCTION.recommendedReviewId
      && summary.promotionCount === 0
      && summary.publicationEligible === true
      && summary.verifierStatus === 'PASS'
      && summary.verifierEvidenceSha256 === EXPECTED_PRODUCTION.verifierEvidenceSha256
      && summary.rawReceiptsPublic === false
      && summary.portableCausalVerifier === 'npm run verify:submission';
    if (!summaryPass) reasons.push('production summary metrics do not match the sealed result');

    const verifierPass = verifier.runId === EXPECTED_PRODUCTION.runId
      && verifier.status === 'PASS'
      && verifier.publicationEligible === true
      && verifier.evidenceSha256 === EXPECTED_PRODUCTION.verifierEvidenceSha256
      && verifier.execution?.status === 'PASS'
      && verifier.targetGrounding?.status === 'PASS'
      && verifier.benchmark?.status === 'PASS'
      && verifier.isolation?.status === 'PASS'
      && verifier.comparability?.status === 'PASS'
      && verifier.coverage?.status === 'PASS'
      && verifier.promotionSafety?.status === 'N/A'
      && verifier.stateConsistency?.status === 'PASS';
    if (!verifierPass) reasons.push('production verifier result does not match the sealed result');

    return {
      status: reasons.length === 0 ? 'PASS' : 'FAIL',
      reasons,
      manifestSha256,
      fileCount: manifestEntries.length,
      metrics: {
        runId: summary.runId ?? null,
        calls: summary.callCount ?? null,
        tokens: summary.cliReportedTokens ?? null,
        baselineQuality: summary.baseline?.quality ?? null,
        h1Quality: h1?.quality ?? null,
        h2Quality: h2?.quality ?? null,
        recommendedReviewId: summary.recommendedReviewId ?? null,
        promotionCount: summary.promotionCount ?? null,
        publicationEligible: summary.publicationEligible === true,
        verifierEvidenceSha256: summary.verifierEvidenceSha256 ?? null
      }
    };
  } catch {
    return {
      status: 'FAIL',
      reasons: ['production evidence could not be parsed or integrity-checked'],
      manifestSha256: null,
      fileCount: 0,
      metrics: null
    };
  }
}

function failClosed(reason) {
  const base = {
    schemaVersion: 1,
    submission: 'Loop Factory: Make AI agents prove they got better.',
    status: 'FAIL',
    bundleId: EXPECTED.bundleId,
    runId: EXPECTED.runId,
    gates: {
      bundleReadable: gate(false, reason)
    },
    metrics: null,
    reasons: [reason]
  };
  return { ...base, evidenceSha256: sha256(stableJson(base)) };
}

export function verifySubmission({
  bundleRoot = DEFAULT_BUNDLE_ROOT,
  productionBundleRoot = DEFAULT_PRODUCTION_BUNDLE_ROOT
} = {}) {
  const resolvedBundleRoot = resolve(bundleRoot);
  const manifestPath = join(resolvedBundleRoot, MANIFEST_NAME);
  try {
    if (!existsSync(manifestPath)) return failClosed('submission evidence manifest is missing');

    const manifest = readJson(manifestPath);
    const manifestSha256 = sha256File(manifestPath);
    const manifestEntries = Array.isArray(manifest.files) ? manifest.files : [];
    const manifestByPath = new Map(manifestEntries.map((entry) => [entry.path, entry]));
    const actualFiles = listFiles(resolvedBundleRoot);
    const protectedFiles = actualFiles.filter((file) => file !== MANIFEST_NAME);
    const manifestReasons = [];

    if (manifest.schemaVersion !== 1) manifestReasons.push('bundle manifest schemaVersion must be 1');
    if (manifest.bundleId !== EXPECTED.bundleId || manifest.runId !== EXPECTED.runId) {
      manifestReasons.push('bundle identity does not match the submission contract');
    }
    if (manifestSha256 !== EXPECTED_MANIFEST_SHA256) {
      manifestReasons.push('bundle manifest hash does not match the verifier-pinned hash');
    }
    if (!sameJson([...manifestByPath.keys()].sort(), protectedFiles)) {
      manifestReasons.push('bundle file set does not exactly match the manifest');
    }
    for (const entry of manifestEntries) {
      const full = join(resolvedBundleRoot, String(entry.path || ''));
      if (!existsSync(full) || !statSync(full).isFile()) {
        manifestReasons.push(`manifest file is missing: ${entry.path}`);
        continue;
      }
      if (statSync(full).size !== entry.bytes || sha256File(full) !== entry.sha256) {
        manifestReasons.push(`manifest hash or byte count failed: ${entry.path}`);
      }
    }

    const privacyFindings = collectPrivacyFindings(resolvedBundleRoot, actualFiles);
    const config = readJson(join(resolvedBundleRoot, 'canary-inputs.json'));
    const stateHome = join(resolvedBundleRoot, 'state');
    const state = createStore(stateHome).load(EXPECTED.runId);
    const inputValidation = validateRealTestCanaryConfig(config);
    const publicPlan = buildRealTestCanaryPlan(config);
    const canaryVerification = verifyCanaryRun(createStore(stateHome), EXPECTED.runId);
    const projectionReasons = [];
    if (!inputValidation.ok) projectionReasons.push(...inputValidation.errors);
    if (publicPlan.sha256 !== EXPECTED.publicPlanSha256
      || config.approvedPlanSha256 !== EXPECTED.publicPlanSha256
      || !sameJson(publicPlan, state.plan)) {
      projectionReasons.push('public canary inputs, plan, and persisted state do not match');
    }
    if (config.submissionProjection?.sourceConfigSha256 !== EXPECTED.sourceConfigSha256
      || state.submissionProjection?.sourceStateSha256 !== EXPECTED.sourceStateSha256
      || state.submissionProjection?.sourceApprovedPlanSha256 !== EXPECTED.sourcePlanSha256) {
      projectionReasons.push('public projection does not identify the sealed source hashes');
    }
    if (state.verification !== null || state.outcome !== null || state.reportPath !== null) {
      projectionReasons.push('public state must omit precomputed verdict and report fields');
    }

    const proposalRecords = state.proposal ? [state.proposal] : [];
    const evaluationRecords = Array.isArray(state.evaluations) ? state.evaluations : [];
    const calls = [...proposalRecords, ...evaluationRecords];
    const events = Array.isArray(state.verdictEvents) ? state.verdictEvents : [];
    const eventKeys = events.map((event) => event.kind === 'proposal'
      ? 'proposal'
      : `${event.armRole}:${event.replicate}:${event.position}`);
    const callCountPass = proposalRecords.length === EXPECTED.proposalCount
      && evaluationRecords.length === EXPECTED.evaluationCount
      && calls.length === EXPECTED.callCount
      && events.length === EXPECTED.callCount
      && new Set(eventKeys).size === EXPECTED.callCount;

    const requestedModelPass = state.model === EXPECTED.model
      && state.plan.model === EXPECTED.model
      && state.plan.routes.length === EXPECTED.armCounts.baseline
      && state.plan.routes.every((route) => route === EXPECTED.model)
      && calls.every((record) => (
        record.requestedModel === EXPECTED.model
        && record.model === EXPECTED.model
        && (!record.reportedModel
          || String(record.reportedModel).toLowerCase() === EXPECTED.model.toLowerCase())
        && modelFlagMatches(record.argv, EXPECTED.model)
      ));
    const modelAuthorityPass = calls.every((record) => (
      record.modelSelectionAuthority === 'explicit-model-flag'
      && record.modelIdentityAuthority === 'explicit-model-flag'
      && record.strictIsolation === true
      && record.binaryFamily === 'codex'
    ));
    const exitCodesPass = calls.every((record) => Number(record.exitCode) === 0);
    const retriesPass = state.plan.contract.retriesPerDispatch === 0
      && events.every((event) => event.accepted === true && event.attempt === 0);
    const isolationPass = canaryVerification.gates?.isolation === true
      && calls.every((record) => (
        record.isolation?.status === 'PASS'
        && Array.isArray(record.isolation.toolCalls)
        && record.isolation.toolCalls.length === 0
      ));

    const proposalSchemaPath = join(PACKAGE_ROOT, 'src', 'schemas', 'proposal-output.schema.json');
    const evaluationSchemaPath = join(PACKAGE_ROOT, 'src', 'schemas', 'evaluation-output.schema.json');
    const proposalSchemaSha256 = sha256File(proposalSchemaPath);
    const evaluationSchemaSha256 = sha256File(evaluationSchemaPath);
    const schemasPass = state.proposal.outputSchemaSha256 === proposalSchemaSha256
      && schemaArgMatches(state.proposal.argv, 'proposal-output.schema.json')
      && state.proposal.resultNormalization === 'json-schema-v1'
      && evaluationRecords.every((record) => (
        record.outputSchemaSha256 === evaluationSchemaSha256
        && schemaArgMatches(record.argv, 'evaluation-output.schema.json')
        && record.resultNormalization === 'json-schema-v1'
      ))
      && canaryVerification.gates?.schemaIdentity === true;

    const referencedArtifactIds = new Set([
      state.proposal.rawArtifactRef,
      state.proposal.resultArtifactRef,
      ...evaluationRecords.flatMap((record) => [
        record.rawArtifactRef,
        record.resultArtifactRef,
        record.evaluationArtifactRef
      ])
    ]);
    const artifactReasons = [];
    if (referencedArtifactIds.size !== EXPECTED.protectedArtifactCount) {
      artifactReasons.push(`expected ${EXPECTED.protectedArtifactCount} unique protected artifacts`);
    }
    for (const artifactId of referencedArtifactIds) {
      const relPath = artifactPath(EXPECTED.runId, artifactId);
      const entry = manifestByPath.get(relPath);
      if (!entry || entry.bytePreserved !== true || entry.sourceSha256 !== entry.sha256) {
        artifactReasons.push(`artifact is not declared byte-preserved: ${artifactId}`);
        continue;
      }
      const artifact = readJson(join(resolvedBundleRoot, relPath));
      if (typeof artifact.content !== 'string' || sha256(artifact.content) !== artifact.sha256) {
        artifactReasons.push(`artifact content hash failed: ${artifactId}`);
      }
    }
    if (canaryVerification.gates?.receipts !== true) {
      artifactReasons.push('existing canary receipt and artifact verifier failed');
    }

    const expectedProcedureHashes = {
      baseline: state.target.baselineSha256,
      challenger: state.proposal.procedureSha256,
      sham: state.target.shamSha256
    };
    const procedureHashesPass = new Set(Object.values(expectedProcedureHashes)).size === 3
      && evaluationRecords.every((record) => (
        record.procedureSha256 === expectedProcedureHashes[record.armRole]
      ));
    const armCounts = canaryVerification.armCounts || {};
    const armCountsPass = sameJson(armCounts, EXPECTED.armCounts)
      && procedureHashesPass;

    const outcome = canaryVerification.outcome || {};
    const challengerTarget = (canaryVerification.series?.challenger || [])
      .map((row) => Number(row.targetQuality));
    const maxChallengerTargetQuality = challengerTarget.length
      ? Math.max(...challengerTarget)
      : null;
    const pairedOutcomePass = outcome.pairedTargetWins === EXPECTED.pairedTargetWins
      && outcome.shamWins === EXPECTED.shamWins
      && outcome.controlRegressions === EXPECTED.controlRegressions
      && maxChallengerTargetQuality > 0
      && maxChallengerTargetQuality < 1;

    const store = createStore(stateHome);
    const tokenRows = calls.map((record) => {
      const raw = store.readArtifact(EXPECTED.runId, record.rawArtifactRef);
      return {
        recorded: Number(record.cliReportedTotalTokens),
        rederived: raw ? parseTokenUsage(raw.content) : null
      };
    });
    const proposalTokens = tokenRows[0]?.rederived ?? null;
    const evaluationTokens = tokenRows.slice(1)
      .reduce((total, row) => total + Number(row.rederived || 0), 0);
    const totalTokens = Number(proposalTokens || 0) + evaluationTokens;
    const tokenUsagePass = tokenRows.every((row) => (
      Number.isFinite(row.rederived)
      && row.rederived > 0
      && row.rederived === row.recorded
    ))
      && proposalTokens === EXPECTED.proposalTokens
      && evaluationTokens === EXPECTED.evaluationTokens
      && totalTokens === EXPECTED.totalTokens;

    const promotionPass = state.plan.contract.promotionEnabled === false
      && state.promotion?.enabled === false
      && state.promotion?.recorded === false
      && outcome.promotionEnabled === false;
    const experimentValidityPass = canaryVerification.experimentValid === true
      && canaryVerification.status === 'PASS'
      && Object.values(canaryVerification.gates || {}).every(Boolean);

    const productionSupplement = verifyProductionSupplement(productionBundleRoot);
    const gates = {
      bundleManifest: gate(manifestReasons.length === 0, manifestReasons, {
        fileCount: manifestEntries.length,
        manifestSha256
      }),
      privacy: gate(privacyFindings.length === 0, privacyFindings.map((item) => (
        `${item.code}: ${item.file}`
      )), { findingCount: privacyFindings.length }),
      publicInputs: gate(projectionReasons.length === 0, projectionReasons, {
        publicPlanSha256: publicPlan.sha256,
        sourcePlanSha256: EXPECTED.sourcePlanSha256
      }),
      callCount: gate(callCountPass, 'expected one proposal plus fifteen unique evaluation dispatches', {
        proposal: proposalRecords.length,
        evaluations: evaluationRecords.length,
        total: calls.length
      }),
      requestedModel: gate(requestedModelPass, `every route and receipt must request ${EXPECTED.model}`),
      modelAuthority: gate(modelAuthorityPass, 'every receipt must use strict Codex explicit-model authority'),
      exitCodes: gate(exitCodesPass, 'every persisted worker exit code must be zero'),
      retries: gate(retriesPass, 'dispatch attempts must prove zero retries'),
      isolation: gate(isolationPass, 'strict launch or transcript isolation failed'),
      schemas: gate(schemasPass, 'schema identity or result normalization failed', {
        proposalSchemaSha256,
        evaluationSchemaSha256
      }),
      artifactHashes: gate(artifactReasons.length === 0, artifactReasons, {
        protectedArtifactCount: referencedArtifactIds.size
      }),
      armCounts: gate(armCountsPass, 'arm counts or procedure identities do not match the frozen design', {
        ...armCounts
      }),
      pairedOutcome: gate(pairedOutcomePass, 'paired movement, sham, control, or honesty boundary failed', {
        pairedTargetWins: outcome.pairedTargetWins ?? null,
        shamWins: outcome.shamWins ?? null,
        controlRegressions: outcome.controlRegressions ?? null,
        maxChallengerTargetQuality,
        targetFullySolved: maxChallengerTargetQuality === 1
      }),
      tokenUsage: gate(tokenUsagePass, 'CLI token usage did not rederive exactly from raw transcripts', {
        proposal: proposalTokens,
        evaluations: evaluationTokens,
        total: totalTokens
      }),
      promotion: gate(promotionPass, 'promotion must remain disabled and unrecorded'),
      experimentValidity: gate(experimentValidityPass, canaryVerification.reasons || []),
      productionSupplement: gate(
        productionSupplement.status === 'PASS',
        productionSupplement.reasons,
        {
          manifestSha256: productionSupplement.manifestSha256,
          fileCount: productionSupplement.fileCount
        }
      )
    };
    const reasons = Object.entries(gates).flatMap(([name, result]) => (
      result.status === 'FAIL' ? result.reasons.map((reason) => `${name}: ${reason}`) : []
    ));
    const base = {
      schemaVersion: 1,
      submission: 'Loop Factory: Make AI agents prove they got better.',
      status: reasons.length === 0 ? 'PASS' : 'FAIL',
      bundleId: manifest.bundleId || EXPECTED.bundleId,
      runId: EXPECTED.runId,
      gates,
      metrics: {
        calls: {
          proposal: proposalRecords.length,
          evaluations: evaluationRecords.length,
          total: calls.length
        },
        arms: armCounts,
        outcome: {
          pairedTargetWins: outcome.pairedTargetWins ?? null,
          shamWins: outcome.shamWins ?? null,
          controlRegressions: outcome.controlRegressions ?? null,
          maxChallengerTargetQuality,
          targetFullySolved: maxChallengerTargetQuality === 1
        },
        tokens: {
          proposal: proposalTokens,
          evaluations: evaluationTokens,
          total: totalTokens
        },
        promotion: {
          enabled: state.promotion?.enabled ?? null,
          recorded: state.promotion?.recorded ?? null
        },
        experimentValid: canaryVerification.experimentValid === true,
        productionFrontier: productionSupplement.metrics
      },
      reasons
    };
    return { ...base, evidenceSha256: sha256(stableJson(base)) };
  } catch {
    return failClosed('submission evidence could not be parsed or re-verified');
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const result = verifySubmission({
    bundleRoot: arg('--bundle', DEFAULT_BUNDLE_ROOT),
    productionBundleRoot: arg('--production-bundle', DEFAULT_PRODUCTION_BUNDLE_ROOT)
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'PASS' ? 0 : 1);
}
