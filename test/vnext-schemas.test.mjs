import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS } from '../src/adaptive-recursive-canary-v2.mjs';
import { VNEXT_WAVE_IMPLEMENTATION_PATHS } from '../src/vnext-wave-runner.mjs';
import {
  VNEXT_FROZEN_CANDIDATE_IMPLEMENTATION_PATHS
} from '../src/vnext-frozen-candidate-study.mjs';
import {
  VNEXT_CUSTODIAN_IMPLEMENTATION_PATHS
} from '../src/vnext-custodian-package.mjs';
import {
  VNEXT_MATCHED_PHASE_IMPLEMENTATION_PATHS
} from '../src/vnext-matched-phase.mjs';
import {
  VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS,
  VNEXT_EVALUATOR_PROOF_ROOT_PATHS
} from '../src/vnext-evaluator-proof.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(PACKAGE_ROOT, 'src', 'schemas');

function objectNodes(value, path = '#', rows = []) {
  if (!value || typeof value !== 'object') return rows;
  const types = Array.isArray(value.type) ? value.type : [value.type];
  if (types.includes('object')) rows.push({ path, value });
  for (const [key, child] of Object.entries(value)) {
    objectNodes(child, `${path}/${key}`, rows);
  }
  return rows;
}

test('every VNext JSON schema declares its object extension boundary', () => {
  const files = readdirSync(ROOT)
    .filter((name) => name.startsWith('vnext-') && name.endsWith('.schema.json'))
    .sort();
  assert.ok(files.length >= 20);
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    const open = objectNodes(schema).filter(({ value }) => (
      !Object.hasOwn(value, 'additionalProperties')
    ));
    assert.deepEqual(open.map(({ path }) => path), [], `${file} has implicit open objects`);
  }
});

test('wave-event and operator-action schemas bind discriminants to closed payloads', () => {
  const wave = JSON.parse(readFileSync(
    join(ROOT, 'vnext-wave-event-v1.schema.json'),
    'utf8'
  ));
  assert.equal(wave.allOf[0].oneOf.length, 10);
  assert.deepEqual(
    wave.allOf[0].oneOf.map((variant) => variant.properties.type.const).sort(),
    wave.properties.type.enum.slice().sort()
  );
  for (const name of [
    'startedDetail',
    'preparationDispatchedDetail',
    'preparationPersistedDetail',
    'preparationRejectedDetail',
    'executionBoundDetail',
    'experimentDispatchedDetail',
    'experimentVerifiedDetail',
    'importPersistedDetail',
    'resultPersistedDetail',
    'blockedDetail'
  ]) assert.equal(wave.$defs[name].additionalProperties, false);

  const action = JSON.parse(readFileSync(
    join(ROOT, 'vnext-operator-action-v1.schema.json'),
    'utf8'
  ));
  assert.equal(action.allOf[0].oneOf.length, 4);
  assert.equal(action.$defs.rollbackTarget.additionalProperties, false);
});

test('critical VNext wave, campaign, budget, journal, and control schemas ship together', () => {
  const files = new Set(readdirSync(ROOT));
  for (const name of [
    'vnext-wave-config-v1.schema.json',
    'vnext-wave-result-v1.schema.json',
    'vnext-wave-materialization-v1.schema.json',
    'vnext-wave-verifier-evidence-v1.schema.json',
    'vnext-wave-event-v1.schema.json',
    'vnext-resource-budget-v1.schema.json',
    'vnext-resource-budget-ledger-v1.schema.json',
    'vnext-campaign-series-plan-v1.schema.json',
    'vnext-campaign-series-state-v1.schema.json',
    'vnext-campaign-series-checkpoint-v1.schema.json',
    'vnext-campaign-series-wave-input-v1.schema.json',
    'vnext-campaign-verifier-v1.schema.json',
    'vnext-operator-action-v1.schema.json',
    'vnext-operator-control-v1.schema.json',
    'vnext-candidate-strategy-plan-v1.schema.json',
    'vnext-code-worktree-run-v1.schema.json',
    'vnext-external-research-discovery-output-v1.schema.json',
    'vnext-external-research-policy-v1.schema.json',
    'vnext-external-research-plan-v1.schema.json',
    'vnext-external-research-fetch-v1.schema.json',
    'vnext-study-disclosure-v1.schema.json',
    'vnext-evaluator-proof-plan-v1.schema.json',
    'vnext-evaluator-proof-plan-v2.schema.json',
    'vnext-strategy-state-bundle-v1.schema.json',
    'vnext-ablation-protocol-v2.schema.json',
    'vnext-ablation-protocol-v3.schema.json',
    'vnext-frozen-candidate-study-plan-v1.schema.json',
    'vnext-custodian-package-v1.schema.json',
    'vnext-matched-phase-plan-v1.schema.json'
  ]) assert.ok(files.has(name), `${name} is missing`);
});

test('canonical npm test scope excludes generated proof capsules', () => {
  const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.mjs');
});

function localImportClosure(roots) {
  const seen = new Set();
  const visit = (file) => {
    const normalized = normalize(file).replaceAll('\\', '/');
    if (seen.has(normalized) || !existsSync(join(PACKAGE_ROOT, normalized))) return;
    seen.add(normalized);
    if (!normalized.endsWith('.mjs')) return;
    const source = readFileSync(join(PACKAGE_ROOT, normalized), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      let absolute = resolve(PACKAGE_ROOT, dirname(normalized), match[1]);
      if (!extname(absolute)) absolute += '.mjs';
      const child = relative(PACKAGE_ROOT, absolute).replaceAll('\\', '/');
      if (!child.startsWith('..')) visit(child);
    }
  };
  roots.forEach(visit);
  return [...seen].sort();
}

test('implementation manifests cover every local static import in the paid execution path', () => {
  const recursiveRoots = [
    'src/adaptive-recursive-canary-v2.mjs',
    'src/adaptive-recursive-runner-v2.mjs',
    'scripts/plan-adaptive-recursive-canary-v2.mjs',
    'scripts/run-adaptive-recursive-canary-v2.mjs',
    'scripts/verify-adaptive-recursive-canary-v2.mjs'
  ];
  const waveRoots = [
    'src/vnext-wave-runner.mjs',
    'src/vnext-campaign-driver.mjs',
    'scripts/run-vnext-campaign-series.mjs',
    'scripts/verify-vnext-campaign-series.mjs',
    'scripts/stop-vnext-campaign-series.mjs',
    'scripts/plan-vnext-study-wave.mjs',
    'scripts/run-vnext-study-wave.mjs',
    'scripts/verify-vnext-study-wave.mjs',
    'scripts/build-vnext-ablation-protocol.mjs',
    'scripts/verify-vnext-ablation-protocol.mjs'
  ];
  const frozenCandidateRoots = [
    'src/vnext-frozen-candidate-study.mjs',
    'scripts/plan-vnext-frozen-candidate-study.mjs',
    'scripts/run-vnext-frozen-candidate-study.mjs',
    'scripts/verify-vnext-frozen-candidate-study.mjs'
  ];
  const custodianRoots = [
    'src/vnext-custodian-package.mjs',
    'scripts/build-vnext-custodian-package.mjs',
    'scripts/plan-vnext-custodian-final.mjs',
    'scripts/verify-vnext-custodian-package.mjs'
  ];
  const matchedPhaseRoots = [
    'src/vnext-matched-phase.mjs',
    'scripts/build-vnext-matched-phase.mjs',
    'scripts/verify-vnext-matched-phase.mjs'
  ];
  const evaluatorClosure = localImportClosure(VNEXT_EVALUATOR_PROOF_ROOT_PATHS);
  assert.deepEqual(
    localImportClosure(recursiveRoots).filter((path) => (
      !ADAPTIVE_RECURSIVE_V2_IMPLEMENTATION_PATHS.includes(path)
    )),
    []
  );
  assert.deepEqual(
    localImportClosure(waveRoots).filter((path) => (
      !VNEXT_WAVE_IMPLEMENTATION_PATHS.includes(path)
    )),
    []
  );
  assert.deepEqual(
    localImportClosure(frozenCandidateRoots).filter((path) => (
      !VNEXT_FROZEN_CANDIDATE_IMPLEMENTATION_PATHS.includes(path)
    )),
    []
  );
  assert.deepEqual(
    localImportClosure(custodianRoots).filter((path) => (
      !VNEXT_CUSTODIAN_IMPLEMENTATION_PATHS.includes(path)
    )),
    []
  );
  assert.deepEqual(
    localImportClosure(matchedPhaseRoots).filter((path) => (
      !VNEXT_MATCHED_PHASE_IMPLEMENTATION_PATHS.includes(path)
    )),
    []
  );
  assert.deepEqual(
    VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS
      .filter((path) => path.endsWith('.mjs'))
      .slice()
      .sort(),
    evaluatorClosure
  );
  for (const path of [
    'hosts/registry.json',
    'src/schemas/vnext-evaluator-output-v1.schema.json',
    'src/schemas/vnext-evaluator-proof-plan-v2.schema.json'
  ]) assert.ok(VNEXT_EVALUATOR_PROOF_IMPLEMENTATION_PATHS.includes(path));
});
