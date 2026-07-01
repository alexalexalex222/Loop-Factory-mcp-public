import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshEngine, BASELINE_BODY, BASELINE_BODY_V2 } from './helpers.mjs';
import { driveImproveTargets } from '../examples/improve-driver.mjs';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'improve-targets.sample.json');

test('reference improve driver: one subRunId per target, benchmarkIds[0], no BASELINE_LOCKED', () => {
  const { engine } = freshEngine();
  const cfg = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const targets = cfg.targets.filter((t) => t.kind === 'improve');
  const out = driveImproveTargets(engine, 'ref-parent', targets);
  assert.equal(out.aborted, false, JSON.stringify(out, null, 2));
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].subRunId, 'ref-parent-t1');
  assert.equal(out.results[1].subRunId, 'ref-parent-t2');
  assert.ok(out.results[0].benchmarkId);
  assert.ok(out.results[1].benchmarkId);
  assert.equal(out.results[0].campaignStatus.campaignContinues, true);
});

test('reference improve driver: second target does not collide on baseline (fe853c48 class)', () => {
  const { engine } = freshEngine();
  const bench = {
    name: 'x-v1',
    taskValueDimensions: ['q'],
    resourceDimensions: ['tokenCost'],
    cases: [{ id: 'c1', prompt: 'x' }],
    oracle: { mustInclude: ['VERIFIED'], mustExclude: ['maybe'] }
  };
  const targets = [
    { kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY, benchmark: bench },
    { kind: 'improve', loop: 'loop-de-loop', baselineContent: BASELINE_BODY_V2, benchmark: { ...bench, name: 'y-v1' } }
  ];
  const out = driveImproveTargets(engine, 'collision-test', targets);
  assert.equal(out.aborted, false);
  assert.notEqual(out.results[0].baselineSha256, out.results[1].baselineSha256);
});
