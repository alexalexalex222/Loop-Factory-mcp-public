import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { verifySubmission } from '../scripts/verify-submission.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(ROOT, 'submission', 'evidence', 'context-isolation-canary-20260719');
const PRODUCTION_BUNDLE = join(
  ROOT,
  'submission',
  'evidence',
  'production-frontier-20260720'
);

test('the public submission bundle rederives the sealed canary result', () => {
  const result = verifySubmission({ bundleRoot: BUNDLE });
  assert.equal(result.status, 'PASS', JSON.stringify(result, null, 2));
  assert.equal(result.metrics.calls.total, 16);
  assert.deepEqual(result.metrics.arms, { baseline: 5, challenger: 5, sham: 5 });
  assert.equal(result.metrics.outcome.pairedTargetWins, 5);
  assert.equal(result.metrics.outcome.shamWins, 0);
  assert.equal(result.metrics.outcome.controlRegressions, 0);
  assert.equal(result.metrics.outcome.targetFullySolved, false);
  assert.equal(result.metrics.tokens.total, 441627);
  assert.equal(result.metrics.promotion.recorded, false);
  assert.equal(result.metrics.experimentValid, true);
  assert.equal(result.metrics.productionFrontier.calls, 12);
  assert.equal(result.metrics.productionFrontier.tokens, 724453);
  assert.equal(result.metrics.productionFrontier.baselineQuality, 0.619);
  assert.equal(result.metrics.productionFrontier.h1Quality, 1);
  assert.equal(result.metrics.productionFrontier.h2Quality, 1);
  assert.equal(result.metrics.productionFrontier.recommendedReviewId, 'rev-001');
  assert.equal(result.metrics.productionFrontier.promotionCount, 0);
  assert.equal(result.metrics.productionFrontier.publicationEligible, true);
});

test('changing one protected artifact makes submission verification exit nonzero', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'loop-factory-submission-tamper-'));
  const tamperedBundle = join(scratch, 'evidence');
  cpSync(BUNDLE, tamperedBundle, { recursive: true });
  const artifact = join(
    tamperedBundle,
    'state',
    'runs',
    'context-isolation-canary-20260719',
    'artifacts',
    'eval-r1-p1-evaluation.json'
  );
  appendFileSync(artifact, '\n');

  const direct = verifySubmission({ bundleRoot: tamperedBundle });
  assert.equal(direct.status, 'FAIL');
  assert.equal(direct.gates.bundleManifest.status, 'FAIL');

  const cli = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'verify-submission.mjs'),
    '--bundle',
    tamperedBundle
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr || cli.stdout);
  assert.equal(JSON.parse(cli.stdout).status, 'FAIL');
  assert.notEqual(readFileSync(artifact, 'utf8').length, 0);
});

test('machine-specific temporary capsule paths fail the public privacy gate', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'loop-factory-submission-privacy-'));
  const leakedBundle = join(scratch, 'evidence');
  cpSync(BUNDLE, leakedBundle, { recursive: true });
  appendFileSync(
    join(leakedBundle, 'README.md'),
    '\nLeaked capsule: /var/folders/zz/private/T/loop-factory-worker-secret\n'
  );

  const result = verifySubmission({ bundleRoot: leakedBundle });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.gates.privacy.status, 'FAIL');
  assert.ok(result.gates.privacy.reasons.some((reason) => (
    reason === 'darwin-temp-path: README.md'
  )));
});

test('changing the production supplement fails the integrated submission gate', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'loop-factory-production-tamper-'));
  const tamperedBundle = join(scratch, 'production-evidence');
  cpSync(PRODUCTION_BUNDLE, tamperedBundle, { recursive: true });
  appendFileSync(join(tamperedBundle, 'summary.json'), '\n');

  const result = verifySubmission({ productionBundleRoot: tamperedBundle });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.gates.productionSupplement.status, 'FAIL');
  assert.ok(result.gates.productionSupplement.reasons.some((reason) => (
    reason === 'production bundle manifest hash does not match the verifier-pinned hash'
      || reason === 'production manifest hash or byte count failed: summary.json'
  )));
});
