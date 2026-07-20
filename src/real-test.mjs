// Strict pre-publication test profile. This module owns the plan hash and the
// truth conditions behind the "5 findings / 10 improvement attempts" run.
import { checkBaselineIntegrity, checkHypothesisIntegrity } from './baseline-integrity.mjs';
import {
  CASE_RESULTS_ORACLE_KIND_V2,
  isDeterministicOracle,
  isCaseResultsOracle
} from './measure.mjs';
import { sha256 } from './util.mjs';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const REAL_TEST_LIMITS = Object.freeze({
  maxFindings: 5,
  maxImprovementAttempts: 10
});
export const REAL_TEST_MODEL = 'gpt-5.6-sol';
export const REAL_TEST_CANARY = Object.freeze({
  maxFindings: 1,
  realHypotheses: 1,
  replicatesPerArm: 5,
  minCases: 6,
  maxCases: 10,
  arms: Object.freeze(['baseline', 'challenger', 'sham']),
  blinded: true,
  retriesPerDispatch: 0,
  promotionEnabled: false
});
export const REAL_TEST_CANARY_SCHEDULE = Object.freeze([
  Object.freeze(['baseline', 'challenger', 'sham']),
  Object.freeze(['challenger', 'sham', 'baseline']),
  Object.freeze(['sham', 'baseline', 'challenger']),
  Object.freeze(['baseline', 'sham', 'challenger']),
  Object.freeze(['challenger', 'baseline', 'sham'])
]);

function strictModelPolicy() {
  return {
    source: 'operator-init',
    primary: REAL_TEST_MODEL,
    testRoutes: [REAL_TEST_MODEL],
    builderRoutes: [REAL_TEST_MODEL],
    judgeRoute: REAL_TEST_MODEL,
    banlist: { mode: 'default', extraDeny: [], extraAllow: [] },
    allowUnknownFrontier: true
  };
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

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function resolveEvidenceManifest(repositoryRoot, evidenceSources = []) {
  const root = resolve(String(repositoryRoot || '.'));
  const sources = Array.isArray(evidenceSources) ? evidenceSources.map((item) => String(item || '').trim()) : [];
  const errors = [];
  const seen = new Set();
  const seenResolved = new Set();
  const manifest = [];
  for (const source of sources) {
    if (!source || source.includes('\0') || isAbsolute(source)) {
      errors.push(`evidence source must be a repository-relative path: ${source || '<empty>'}`);
      continue;
    }
    if (seen.has(source)) {
      errors.push(`duplicate evidence source: ${source}`);
      continue;
    }
    seen.add(source);
    const full = resolve(root, source);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      errors.push(`evidence source escapes repository root: ${source}`);
      continue;
    }
    const normalizedPath = rel.split(sep).join('/');
    if (seenResolved.has(normalizedPath)) {
      errors.push(`duplicate evidence source resolves to the same file: ${source}`);
      continue;
    }
    seenResolved.add(normalizedPath);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) {
        errors.push(`evidence source is not a file: ${source}`);
        continue;
      }
      const bytes = readFileSync(full);
      manifest.push({ path: normalizedPath, bytes: bytes.length, sha256: sha256(bytes) });
    } catch {
      errors.push(`evidence source does not exist: ${source}`);
    }
  }
  return {
    ok: errors.length === 0 && manifest.length === sources.length,
    manifest: manifest.sort((a, b) => a.path.localeCompare(b.path)),
    errors
  };
}

export function resolveEvidenceCapsule(repositoryRoot, evidenceSources = []) {
  const resolved = resolveEvidenceManifest(repositoryRoot, evidenceSources);
  if (!resolved.ok) return { ...resolved, capsule: [] };
  const root = resolve(String(repositoryRoot || '.'));
  const capsule = resolved.manifest.map((item) => {
    const content = readFileSync(resolve(root, item.path), 'utf8');
    return { ...item, content };
  });
  return { ...resolved, capsule };
}

function resolveEvidenceLocator(content, locator) {
  const text = String(content || '');
  const needle = String(locator || '').trim();
  if (!needle) return null;
  const exactAt = text.indexOf(needle);
  if (exactAt >= 0) {
    return {
      kind: 'exact',
      start: exactAt,
      end: exactAt + needle.length,
      content: needle
    };
  }
  const lineMatch = needle.match(/(?:^|(?:line|lines|l)\s*|:)(\d+)(?:\s*(?:-|–|to|:)\s*(\d+))?$/i);
  if (!lineMatch) return null;
  const lines = text.split(/\r?\n/);
  const startLine = Number(lineMatch[1]);
  const endLine = Number(lineMatch[2] || startLine);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine > lines.length) {
    return null;
  }
  return {
    kind: 'lines',
    lineStart: startLine,
    lineEnd: endLine,
    content: lines.slice(startLine - 1, endLine).join('\n')
  };
}

function benchmarkNegativeControl(benchmark) {
  const raw = benchmark && benchmark.negativeControl;
  return typeof raw === 'string'
    ? raw
    : (raw && typeof raw === 'object' ? raw.content : null);
}

export function buildRealTestPlan(config = {}) {
  const benchmark = config.benchmark || null;
  const targets = (Array.isArray(config.targets) ? config.targets : []).map((target) => ({
    kind: target.kind || null,
    loop: target.loop || null,
    baselineSha256: typeof target.baselineContent === 'string' && target.baselineContent.trim()
      ? sha256(target.baselineContent)
      : null,
    routes: Array.isArray(target.routes) ? target.routes : null
  }));
  const basis = {
    schemaVersion: 2,
    taskSha256: sha256(String(config.task || '')),
    model: config.model || null,
    modelPolicy: config.modelPolicy ? {
      primary: config.modelPolicy.primary || null,
      testRoutes: Array.isArray(config.modelPolicy.testRoutes) ? config.modelPolicy.testRoutes : [],
      builderRoutes: Array.isArray(config.modelPolicy.builderRoutes) ? config.modelPolicy.builderRoutes : [],
      judgeRoute: config.modelPolicy.judgeRoute || null
    } : null,
    routes: Array.isArray(config.routes) ? config.routes : [],
    requirements: Array.isArray(config.requirements)
      ? config.requirements.map((item) => String(item))
      : [],
    benchmarkSha256: benchmark ? sha256(canonicalJson(benchmark)) : null,
    evidenceManifest: Array.isArray(config.evidenceManifest)
      ? config.evidenceManifest.map((item) => ({
          path: item && item.path || null,
          bytes: Number.isInteger(item && item.bytes) ? item.bytes : null,
          sha256: item && item.sha256 || null
        })).sort((a, b) => String(a.path).localeCompare(String(b.path)))
      : [],
    targets,
    limits: REAL_TEST_LIMITS,
    remineOnEmpty: false,
    benchmarkAuthority: 'maker',
    baselineStrategy: 'route-batch'
  };
  return {
    ...basis,
    sha256: sha256(canonicalJson(basis))
  };
}

export function buildRealTestCanaryPlan(config = {}) {
  const target = config.target && typeof config.target === 'object' ? config.target : {};
  const hypothesis = target.hypothesis && typeof target.hypothesis === 'object' ? target.hypothesis : {};
  const benchmark = config.benchmark && typeof config.benchmark === 'object' ? config.benchmark : null;
  const evidenceRefs = (Array.isArray(target.evidenceRefs) ? target.evidenceRefs : [])
    .map((item) => ({
      path: item && item.path || null,
      locator: item && item.locator || null
    }))
    .sort((a, b) => `${a.path}:${a.locator}`.localeCompare(`${b.path}:${b.locator}`));
  const identity = {
    findingId: target.findingId || null,
    baselineSha256: typeof target.baselineContent === 'string' ? sha256(target.baselineContent) : null,
    hypothesisSha256: sha256(canonicalJson(hypothesis)),
    shamSha256: typeof target.shamContent === 'string' ? sha256(target.shamContent) : null,
    benchmarkSha256: benchmark ? sha256(canonicalJson(benchmark)) : null
  };
  const blindSeed = sha256(canonicalJson(identity));
  const blindLabels = Object.fromEntries(REAL_TEST_CANARY.arms.map((arm) => [
    arm,
    `arm-${sha256(`${blindSeed}:${arm}`).slice(0, 12)}`
  ]));
  const basis = {
    schemaVersion: 1,
    profile: 'one-finding-three-arm-canary',
    model: REAL_TEST_MODEL,
    ...identity,
    evidenceRefs,
    evidenceManifest: (Array.isArray(config.evidenceManifest) ? config.evidenceManifest : [])
      .map((item) => ({
        path: item && item.path || null,
        bytes: Number.isInteger(item && item.bytes) ? item.bytes : null,
        sha256: item && item.sha256 || null
      }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path))),
    routes: Array.isArray(config.routes) ? config.routes : [],
    contract: {
      ...REAL_TEST_CANARY,
      blindLabels,
      schedule: REAL_TEST_CANARY_SCHEDULE.map((row) => [...row])
    }
  };
  return { ...basis, sha256: sha256(canonicalJson(basis)) };
}

export function validateRealTestCanaryConfig(config = {}) {
  const errors = [];
  const target = config.target && typeof config.target === 'object' ? config.target : {};
  const hypothesis = target.hypothesis && typeof target.hypothesis === 'object' ? target.hypothesis : {};
  const benchmark = config.benchmark && typeof config.benchmark === 'object' ? config.benchmark : null;
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const evidenceSources = Array.isArray(config.evidenceSources) ? config.evidenceSources : [];
  const evidenceManifest = Array.isArray(config.evidenceManifest) ? config.evidenceManifest : [];
  const evidenceCapsule = Array.isArray(config.evidenceCapsule) ? config.evidenceCapsule : [];
  const evidenceRefs = Array.isArray(target.evidenceRefs) ? target.evidenceRefs : [];
  const cases = Array.isArray(benchmark && benchmark.cases) ? benchmark.cases : [];
  const oracleCases = Array.isArray(benchmark && benchmark.oracle && benchmark.oracle.cases)
    ? benchmark.oracle.cases
    : [];
  const plan = buildRealTestCanaryPlan(config);
  if (config.model !== REAL_TEST_MODEL) errors.push(`model must be ${REAL_TEST_MODEL}`);
  if (routes.length !== REAL_TEST_CANARY.replicatesPerArm
    || routes.some((route) => route !== REAL_TEST_MODEL)) {
    errors.push(`canary routes must contain exactly ${REAL_TEST_CANARY.replicatesPerArm} ${REAL_TEST_MODEL} entries`);
  }
  if (!/^finding-\d{3}$/.test(String(target.findingId || ''))) errors.push('canary target requires one immutable findingId');
  if (!checkBaselineIntegrity(target.baselineContent).ok) errors.push('canary target requires a valid immutable baselineContent');
  if (!checkBaselineIntegrity(target.shamContent).ok
    || String(target.shamContent || '') === String(target.baselineContent || '')) {
    errors.push('canary target requires a distinct, floor-valid shamContent');
  }
  if (!checkHypothesisIntegrity(hypothesis, [hypothesis]).ok) errors.push('canary target requires one substantive hypothesis');
  if (!benchmark || benchmark.oracle?.kind !== CASE_RESULTS_ORACLE_KIND_V2
    || !isCaseResultsOracle(benchmark.oracle)) {
    errors.push('canary benchmark must use case-results-v2');
  }
  if (cases.length < REAL_TEST_CANARY.minCases || cases.length > REAL_TEST_CANARY.maxCases) {
    errors.push(`canary benchmark must contain ${REAL_TEST_CANARY.minCases}-${REAL_TEST_CANARY.maxCases} cases`);
  }
  if (oracleCases.length !== cases.length) errors.push('canary visible cases and hidden oracle cases must have identical counts');
  const visibleCaseIds = cases.map((item) => String(item && item.id || ''));
  const oracleCaseIds = oracleCases.map((item) => String(item && item.caseId || ''));
  if (new Set(visibleCaseIds).size !== visibleCaseIds.length
    || new Set(oracleCaseIds).size !== oracleCaseIds.length
    || visibleCaseIds.some((caseId) => !caseId || !oracleCaseIds.includes(caseId))) {
    errors.push('canary visible and oracle case IDs must be unique and identical');
  }
  const groups = new Set(oracleCases.map((item) => String(item && item.group || '')));
  for (const required of ['target', 'control']) {
    if (!groups.has(required)) errors.push(`canary oracle requires at least one ${required} case`);
  }
  if (/\[(?:OPERATOR|REPLACE|REAL_|CASE_|ORACLE_|SUBSTANTIAL|EXPECTED)|PLACEHOLDER|TODO/i.test(canonicalJson({
    target,
    benchmark
  }))) {
    errors.push('canary target and benchmark must not contain unresolved placeholders');
  }
  if (!evidenceSources.length || new Set(evidenceSources).size !== evidenceSources.length) {
    errors.push('canary evidenceSources must contain unique repository-relative paths');
  }
  const manifestByPath = new Map();
  for (const item of evidenceManifest) {
    const path = String(item && item.path || '');
    if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')
      || !Number.isInteger(item && item.bytes) || item.bytes < 0
      || !/^[a-f0-9]{64}$/i.test(String(item && item.sha256 || ''))
      || manifestByPath.has(path)) {
      errors.push(`invalid canary evidenceManifest entry: ${path || '<missing>'}`);
      continue;
    }
    manifestByPath.set(path, item);
  }
  if (evidenceManifest.length !== evidenceSources.length
    || evidenceSources.some((path) => !manifestByPath.has(path))) {
    errors.push('canary evidenceManifest must seal every evidenceSources path exactly once');
  }
  const capsuleByPath = new Map();
  for (const item of evidenceCapsule) {
    const path = String(item && item.path || '');
    const content = item && typeof item.content === 'string' ? item.content : null;
    const sealed = manifestByPath.get(path);
    if (!sealed || content == null || capsuleByPath.has(path)
      || Buffer.byteLength(content) !== sealed.bytes
      || sha256(Buffer.from(content)) !== String(sealed.sha256 || '').toLowerCase()) {
      errors.push(`canary evidenceCapsule does not match the sealed manifest: ${path || '<missing>'}`);
      continue;
    }
    capsuleByPath.set(path, item);
  }
  if (evidenceCapsule.length !== evidenceManifest.length) {
    errors.push('canary evidenceCapsule must include every sealed source');
  }
  if (!evidenceRefs.length) {
    errors.push('canary target requires at least one evidenceRef');
  } else {
    for (const ref of evidenceRefs) {
      const path = String(ref && ref.path || '');
      const locator = String(ref && ref.locator || '').trim();
      const source = capsuleByPath.get(path);
      if (!source || !locator || !resolveEvidenceLocator(source.content, locator)) {
        errors.push(`canary evidenceRef does not resolve inside the sealed capsule: ${path || '<missing>'}`);
      }
    }
  }
  if (config.approvedPlanSha256 !== plan.sha256) errors.push('canary plan is not operator-approved');
  return { ok: errors.length === 0, errors, plan };
}

export function evaluateRealTestCanaryOutcome(input = {}) {
  const baseline = Array.isArray(input.baseline) ? input.baseline : [];
  const challenger = Array.isArray(input.challenger) ? input.challenger : [];
  const sham = Array.isArray(input.sham) ? input.sham : [];
  const gates = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const seriesValid = [baseline, challenger, sham].every((series) => (
    series.length === REAL_TEST_CANARY.replicatesPerArm
    && series.every((row) => Number.isFinite(row && row.targetQuality)
      && Number.isFinite(row && row.controlQuality))
  ));
  const pairedTargetWins = seriesValid
    ? challenger.filter((row, index) => row.targetQuality > baseline[index].targetQuality).length
    : 0;
  const shamWins = seriesValid
    ? sham.filter((row, index) => row.targetQuality > baseline[index].targetQuality).length
    : 0;
  const controlRegressions = seriesValid
    ? challenger.filter((row, index) => row.controlQuality < baseline[index].controlQuality).length
    : REAL_TEST_CANARY.replicatesPerArm;
  const requiredGates = [
    'scorerFixtures',
    'receipts',
    'isolation',
    'schemaIdentity',
    'stateConsistency'
  ];
  const failedGates = requiredGates.filter((name) => gates[name] !== true);
  const pass = seriesValid
    && failedGates.length === 0
    && pairedTargetWins >= 4
    && shamWins === 0
    && controlRegressions === 0;
  return {
    status: pass ? 'PASS' : 'FAIL',
    promotionEnabled: false,
    seriesValid,
    pairedTargetWins,
    shamWins,
    controlRegressions,
    failedGates,
    reasons: [
      ...(!seriesValid ? ['Each arm must contain exactly five paired target/control measurements.'] : []),
      ...(pairedTargetWins < 4 ? ['The challenger must beat baseline on target cases in at least four of five paired evaluations.'] : []),
      ...(shamWins > 0 ? ['The irrelevant-edit sham beat baseline and the harness remains gameable.'] : []),
      ...(controlRegressions > 0 ? ['The challenger regressed at least one paired control evaluation.'] : []),
      ...failedGates.map((gate) => `Required canary gate failed: ${gate}.`)
    ]
  };
}

export function withRealTestProfile(config = {}, approvedPlanSha256 = null) {
  const base = {
    ...config,
    model: REAL_TEST_MODEL,
    modelPolicy: strictModelPolicy(),
    remineOnEmpty: false,
    realTest: {
      enabled: true,
      maxFindings: REAL_TEST_LIMITS.maxFindings,
      maxImprovementAttempts: REAL_TEST_LIMITS.maxImprovementAttempts,
      benchmarkAuthority: 'maker',
      baselineStrategy: 'route-batch'
    }
  };
  const plan = buildRealTestPlan(base);
  const profiled = {
    ...base,
    engineConfig: {
      ...(base.engineConfig || {}),
      maxCycles: REAL_TEST_LIMITS.maxImprovementAttempts,
      realTest: {
        ...base.realTest,
        planSha256: plan.sha256,
        benchmarkSha256: plan.benchmarkSha256,
        approvedPlanSha256: approvedPlanSha256 || null,
        planApproved: approvedPlanSha256 === plan.sha256
      }
    },
    realTest: {
      ...base.realTest,
      planSha256: plan.sha256,
      benchmarkSha256: plan.benchmarkSha256,
      approvedPlanSha256: approvedPlanSha256 || null,
      planApproved: approvedPlanSha256 === plan.sha256
    }
  };
  return { config: profiled, plan };
}

export function validateRealTestConfig(config = {}) {
  const realTest = config.realTest || {};
  if (realTest.enabled !== true) return { ok: true, enabled: false, errors: [], plan: null };
  const errors = [];
  const plan = buildRealTestPlan(config);
  const benchmark = config.benchmark;
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const modelPolicy = config.modelPolicy || {};
  const cases = Array.isArray(benchmark && benchmark.cases) ? benchmark.cases : [];
  const negativeControl = benchmarkNegativeControl(benchmark);
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const evidenceSources = Array.isArray(config.evidenceSources) ? config.evidenceSources : [];
  const evidenceManifest = Array.isArray(config.evidenceManifest) ? config.evidenceManifest : [];
  const evidenceCapsule = Array.isArray(config.evidenceCapsule) ? config.evidenceCapsule : [];
  const placeholderText = canonicalJson({
    task: config.task,
    benchmark,
    targets
  });

  if (realTest.maxFindings !== REAL_TEST_LIMITS.maxFindings) errors.push(`maxFindings must be ${REAL_TEST_LIMITS.maxFindings}`);
  if (realTest.maxImprovementAttempts !== REAL_TEST_LIMITS.maxImprovementAttempts) errors.push(`maxImprovementAttempts must be ${REAL_TEST_LIMITS.maxImprovementAttempts}`);
  if (config.model !== REAL_TEST_MODEL) errors.push(`model must be ${REAL_TEST_MODEL}`);
  if (routes.some((route) => route !== REAL_TEST_MODEL)) errors.push(`every worker route must be ${REAL_TEST_MODEL}`);
  if (modelPolicy.primary !== REAL_TEST_MODEL
    || modelPolicy.judgeRoute !== REAL_TEST_MODEL
    || !Array.isArray(modelPolicy.testRoutes)
    || modelPolicy.testRoutes.length !== 1
    || modelPolicy.testRoutes.some((route) => route !== REAL_TEST_MODEL)
    || !Array.isArray(modelPolicy.builderRoutes)
    || modelPolicy.builderRoutes.length !== 1
    || modelPolicy.builderRoutes.some((route) => route !== REAL_TEST_MODEL)) {
    errors.push(`modelPolicy must be locked to ${REAL_TEST_MODEL}`);
  }
  if (config.remineOnEmpty !== false) errors.push('remineOnEmpty must be false');
  if (!benchmark || typeof benchmark !== 'object') errors.push('benchmark is required');
  if (benchmark && benchmark.mode === 'judge') errors.push('judge-mode benchmarks are subjective and are not allowed in strict real-test mode');
  if (!isDeterministicOracle(benchmark && benchmark.oracle)) errors.push('benchmark oracle must be deterministic');
  if (benchmark && (benchmark.oracle?.kind !== CASE_RESULTS_ORACLE_KIND_V2
    || !isCaseResultsOracle(benchmark.oracle))) {
    errors.push('strict real-test benchmark oracle must use case-results-v2');
  }
  if (!negativeControl || !String(negativeControl).trim()) errors.push('benchmark must include an explicit negativeControl');
  if (cases.length < 2) errors.push('benchmark must include at least two concrete cases');
  if (benchmark && benchmark.routeIndependence !== 'required') errors.push('benchmark routeIndependence must be "required"');
  if (!Number.isInteger(benchmark && benchmark.requiredRoutes) || benchmark.requiredRoutes < 3) errors.push('benchmark requiredRoutes must be at least 3');
  if (benchmark && benchmark.integrityOverride) errors.push('integrityOverride is not allowed in strict real-test mode');
  if (routes.length < 3 || routes.length > 5) errors.push('routes must contain 3-5 worker runs');
  if (targets.length < 1) errors.push('at least one target is required');
  if (evidenceSources.length < 1) errors.push('strict real-test evidenceSources are required');
  if (new Set(evidenceSources).size !== evidenceSources.length) errors.push('strict real-test evidenceSources must not contain duplicates');
  if (evidenceManifest.length !== evidenceSources.length) errors.push('strict real-test evidenceManifest must seal every evidenceSources path');
  const manifestPaths = new Set();
  for (const item of evidenceManifest) {
    const path = String(item && item.path || '');
    if (!path || isAbsolute(path) || path.includes('\0') || path === '..' || path.startsWith(`..${sep}`)
      || path.split(/[\\/]/).includes('..') || path.split(/[\\/]/).includes('.')
      || !Number.isInteger(item && item.bytes) || item.bytes < 0
      || !/^[a-f0-9]{64}$/i.test(String(item && item.sha256 || ''))) {
      errors.push(`invalid evidenceManifest entry: ${path || '<missing>'}`);
      continue;
    }
    if (manifestPaths.has(path)) errors.push(`duplicate evidenceManifest path: ${path}`);
    manifestPaths.add(path);
  }
  if (evidenceSources.some((path) => !manifestPaths.has(path))) errors.push('evidenceManifest paths must exactly match evidenceSources');
  if (evidenceCapsule.length !== evidenceManifest.length) {
    errors.push('strict real-test evidenceCapsule must include the sealed content for every evidenceManifest path');
  } else {
    const capsulePaths = new Set();
    for (const item of evidenceCapsule) {
      const path = String(item && item.path || '');
      const content = item && typeof item.content === 'string' ? item.content : null;
      const manifestItem = evidenceManifest.find((candidate) => String(candidate && candidate.path || '') === path);
      if (!manifestItem || content == null
        || Buffer.byteLength(content) !== manifestItem.bytes
        || sha256(Buffer.from(content)) !== String(manifestItem.sha256 || '').toLowerCase()) {
        errors.push(`evidenceCapsule content does not match the sealed manifest: ${path || '<missing>'}`);
        continue;
      }
      if (capsulePaths.has(path)) errors.push(`duplicate evidenceCapsule path: ${path}`);
      capsulePaths.add(path);
    }
  }
  if (!targets.some((target) => target.kind === 'mine')) errors.push('strict 5x10 mode requires a mining target');
  if (targets.some((target) => target.kind === 'improve')) errors.push('strict 5x10 mode starts from mining; preselected improve targets are not allowed');
  if (/\[(?:OPERATOR|REPLACE|REAL_|CASE_|ORACLE_)|PLACEHOLDER|TODO/i.test(placeholderText)) {
    errors.push('task, benchmark, and targets must not contain unresolved placeholders');
  }
  for (const target of targets) {
    if (Array.isArray(target.routes)) {
      if (target.routes.length < 3 || target.routes.length > 5) {
        errors.push(`target ${target.loop || target.kind || '<unknown>'} routes must contain 3-5 worker runs`);
      }
      if (target.routes.some((route) => route !== REAL_TEST_MODEL)) {
        errors.push(`target ${target.loop || target.kind || '<unknown>'} contains a non-${REAL_TEST_MODEL} route`);
      }
    }
    if (target.kind === 'improve') {
      const baseline = checkBaselineIntegrity(target.baselineContent);
      if (!baseline.ok) errors.push(`improve target ${target.loop || '<unknown>'} has no valid baseline: ${baseline.code}`);
    }
  }
  if (realTest.planSha256 !== plan.sha256) errors.push('realTest planSha256 does not match the current config');
  if (realTest.approvedPlanSha256 !== plan.sha256 || realTest.planApproved !== true) errors.push('real-test plan is not operator-approved');

  return { ok: errors.length === 0, enabled: true, errors, plan };
}

export function qualifyRealTestFinding(candidate, seen = new Set(), capture = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const baseline = checkBaselineIntegrity(c.baselineContent);
  if (!baseline.ok) return { ok: false, reason: baseline.code };
  const evidenceRefs = Array.isArray(c.evidenceRefs) ? c.evidenceRefs.map((ref) => ({
    path: String(ref && ref.path || '').trim(),
    locator: String(ref && ref.locator || '').trim()
  })) : [];
  if (!evidenceRefs.length || evidenceRefs.some((ref) => (
    !ref.path || !ref.locator || /[\0\r\n]/.test(ref.path) || /[\0\r\n]/.test(ref.locator)
      || ref.path.length > 240 || ref.locator.length > 320
  ))) {
    return { ok: false, reason: 'FINDING_EVIDENCE_REQUIRED' };
  }
  const sealedEvidencePaths = new Set((Array.isArray(capture.evidenceManifest) ? capture.evidenceManifest : [])
    .map((item) => String(item && item.path || ''))
    .filter(Boolean));
  if (sealedEvidencePaths.size && evidenceRefs.some((ref) => !sealedEvidencePaths.has(ref.path))) {
    return { ok: false, reason: 'FINDING_EVIDENCE_OUTSIDE_MANIFEST' };
  }
  const capsuleByPath = new Map((Array.isArray(capture.evidenceCapsule) ? capture.evidenceCapsule : [])
    .filter((item) => item && typeof item.path === 'string' && typeof item.content === 'string')
    .map((item) => [item.path, item]));
  const resolvedEvidenceRefs = [];
  for (const ref of evidenceRefs) {
    const source = capsuleByPath.get(ref.path);
    if (!source) return { ok: false, reason: 'FINDING_EVIDENCE_UNRESOLVED' };
    const resolvedLocator = resolveEvidenceLocator(source.content, ref.locator);
    if (!resolvedLocator || !resolvedLocator.content) {
      return { ok: false, reason: 'FINDING_EVIDENCE_UNRESOLVED' };
    }
    resolvedEvidenceRefs.push({
      ...ref,
      sourceSha256: source.sha256,
      resolvedSha256: sha256(resolvedLocator.content),
      resolution: resolvedLocator.kind,
      ...(resolvedLocator.kind === 'lines'
        ? { lineStart: resolvedLocator.lineStart, lineEnd: resolvedLocator.lineEnd }
        : {})
    });
  }
  const hypotheses = Array.isArray(c.hypotheses) ? c.hypotheses.map((hypothesis) => ({
    title: String(hypothesis && hypothesis.title || '').trim(),
    bottleneck: String(hypothesis && hypothesis.bottleneck || '').trim(),
    operation: String(hypothesis && hypothesis.operation || '').trim(),
    expectedMovement: String(hypothesis && hypothesis.expectedMovement || '').trim(),
    falsifier: String(hypothesis && hypothesis.falsifier || '').trim()
  })) : [];
  if (hypotheses.length !== 2) return { ok: false, reason: 'HYPOTHESIS_COUNT' };
  for (const hypothesis of hypotheses) {
    const integrity = checkHypothesisIntegrity(hypothesis, hypotheses);
    if (!integrity.ok) return { ok: false, reason: integrity.code };
  }
  const capturedOutput = String(capture.capturedOutput || '');
  const capturedArtifactId = String(capture.capturedArtifactId || '');
  const capturedRawArtifactId = String(capture.capturedRawArtifactId || '');
  if (!capturedOutput.trim() || !capturedArtifactId || !capturedRawArtifactId) {
    return { ok: false, reason: 'FINDING_CAPTURE_REQUIRED' };
  }
  const capturedCandidates = Array.isArray(capture.capturedCandidates) ? capture.capturedCandidates : [];
  const candidateShape = canonicalJson({
    loop: c.loop || 'loop-de-loop',
    title: c.title || c.loop || 'candidate',
    baselineContent: String(c.baselineContent),
    evidenceRefs,
    hypotheses
  });
  const captured = capturedCandidates.some((item) => canonicalJson({
    loop: item.loop || 'loop-de-loop',
    title: item.title || item.loop || 'candidate',
    baselineContent: String(item.baselineContent || ''),
    evidenceRefs: item.evidenceRefs || [],
    hypotheses: item.hypotheses || []
  }) === candidateShape);
  if (!captured) {
    return { ok: false, reason: 'FINDING_NOT_IN_CAPTURE' };
  }
  const baselineSha256 = sha256(String(c.baselineContent));
  if (seen.has(baselineSha256)) return { ok: false, reason: 'DUPLICATE_FINDING', baselineSha256 };
  seen.add(baselineSha256);
  const findingId = String(capture.findingId || '');
  if (!/^finding-\d{3}$/.test(findingId)) return { ok: false, reason: 'FINDING_ID_REQUIRED' };
  return {
    ok: true,
    finding: {
      id: findingId,
      loop: c.loop || 'loop-de-loop',
      title: c.title || c.loop || 'candidate',
      baselineContent: String(c.baselineContent),
      baselineSha256,
      miningCaptureArtifactId: capturedArtifactId,
      miningRawArtifactId: capturedRawArtifactId,
      evidenceRefs: resolvedEvidenceRefs,
      hypotheses: hypotheses.map((hypothesis, index) => ({
        id: `${findingId}-h${index + 1}`,
        ...hypothesis
      }))
    }
  };
}

export function realTestBenchmarkRequirements(benchmark = {}) {
  const cases = Array.isArray(benchmark.cases) ? benchmark.cases : [];
  const frozenCases = cases.map((item, index) => ({
    id: item && item.id ? String(item.id) : `case-${index + 1}`,
    input: item && (item.prompt ?? item.input ?? item.task) != null
      ? String(item.prompt ?? item.input ?? item.task)
      : ''
  }));
  return [
    'Run every frozen benchmark case below. Return one clearly labeled result per case.',
    'Do not grade yourself, report a score, claim promotion, or describe the campaign as complete.',
    `FROZEN CASES: ${JSON.stringify(frozenCases)}`
  ];
}
