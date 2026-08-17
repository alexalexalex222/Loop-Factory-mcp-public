import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildVNextReleasePackage } from '../scripts/build-vnext-release-package.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATED_AT = '2026-08-05T07:00:00.000Z';

function writePassingTestLog(root) {
  const path = join(root, 'fixture-test.log');
  writeFileSync(path, [
    'tests 1',
    'pass 1',
    'fail 0',
    'cancelled 0',
    'skipped 0',
    'todo 0',
    ''
  ].join('\n'));
  return path;
}

test('release builder emits a blocked plan-only package deterministically', () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'loop-factory-vnext-release-'));
  try {
    const testLog = writePassingTestLog(outputRoot);
    const first = buildVNextReleasePackage({
      generatedAt: GENERATED_AT,
      outputRoot,
      testLog
    });
    const firstManifest = readFileSync(join(outputRoot, 'BENCHMARK_MANIFEST.json'), 'utf8');
    const second = buildVNextReleasePackage({
      generatedAt: GENERATED_AT,
      outputRoot,
      testLog
    });
    const secondManifest = readFileSync(join(outputRoot, 'BENCHMARK_MANIFEST.json'), 'utf8');

    assert.deepEqual(second, first);
    assert.equal(secondManifest, firstManifest);
    const manifest = JSON.parse(secondManifest);
    assert.equal(manifest.status, 'BLOCKED_PENDING_LIVE_ABLATIONS_AND_EXTERNAL_CUSTODIAN');
    assert.equal(manifest.sealedBenchmark.finalTaskBytesPresent, false);
    assert.equal(manifest.sealedBenchmark.result, null);
    assert.equal(manifest.sealedBenchmark.generalizedImprovementClaim, false);
    assert.equal(manifest.sealedBenchmark.promotionEnabled, false);
    assert.equal(manifest.executionPolicy.exactCallCount, 120);
    assert.equal(manifest.executionPolicy.exactTaskClusters, 10);
    assert.equal(manifest.executionPolicy.localReceiptLedgerTokenCeiling, 4800000);
    assert.equal(manifest.executionPolicy.providerEnforcedOutputTokenLimit, null);
    assert.match(manifest.executionPolicy.tokenCeilingEnforcement, /no provider-side/);
    assert.equal(manifest.executionPolicy.meteredUsdCeiling, 0);
    assert.equal(manifest.executionPolicy.retriesPerInvocation, 0);
    assert.equal(
      manifest.executionPolicy.exposureStatus,
      'UNFROZEN_PUBLIC_PLAN_ONLY'
    );
    assert.deepEqual(
      manifest.executionPolicy.ablationArms,
      ['B0', 'B2', 'B3', 'B4', 'B5a', 'B5b', 'B5c', 'B6']
    );
    assert.deepEqual(
      manifest.executionPolicy.nonCausalQualifications,
      ['SQ1-semantic-judge-security']
    );
    assert.equal(manifest.evidence.acceptorArtifactSha256, null);
    assert.equal(
      manifest.evidence.acceptorAuthority,
      'not-in-public-source-release'
    );
    assert.equal(manifest.evidence.slingIntegration, null);
    assert.equal(first.paidModelCalls, 0);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('release builder requires an explicit timestamp', () => {
  assert.throws(
    () => buildVNextReleasePackage({}),
    /explicit ISO-8601 timestamp/
  );
});
