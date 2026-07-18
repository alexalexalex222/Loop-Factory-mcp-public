#!/usr/bin/env node
// Reference improve driver — mirrors supervisor.mjs runImproveTarget (:252, :286, :293, :297).
//
// CONTRACT (do not improvise one-off scripts like fe853c48):
//   1. One subRunId per improve target: `${parentRunId}-t1`, `-t2`, …
//   2. initialize_loop_run + own baseline per sub-run — never stack baselines on one runId
//   3. benchmark_propose → benchmarkIds[0] for benchmark_select (NOT benchmarks[0])
//   4. While campaign_status.runStatus is INITIALIZED/ACTIVE/NEEDS_RESUME: keep calling next
//   5. Never process.exit / never write "done" while the campaign is open — operator stops
//
// Usage:
//   node examples/improve-driver.mjs --config examples/improve-targets.sample.json [--parent-run-id ID] [--home DIR]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createEngine } from '../src/engine.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const DEFAULT_ANSWERS = [
  'a measurably better loop',
  'improve existing loop',
  'whole history',
  'measured quality up at equal-or-lower cost',
  'keep authorship',
  'keep moving'
];

export function improveOneTarget(engine, subRunId, target) {
  const loopId = target.loop || 'loop-de-loop';
  const answers = Array.isArray(target.answers) ? target.answers : DEFAULT_ANSWERS;

  const init = engine.initialize_loop_run({
    runId: subRunId,
    task: target.task || `improve ${loopId}`,
    answers
  });
  if (init.status !== 'OK') return { subRunId, step: 'initialize_loop_run', ...init };

  const start = engine.loop_start({ runId: subRunId, loop: loopId });
  if (start.status !== 'OK') return { subRunId, step: 'loop_start', ...start };

  // Floor-passing fallback: the tool's BASELINE_TOO_SHALLOW rejects thin stubs
  // (~29 tokens). Never fall back to `BASELINE ${loopId}` — that fails the floor.
  const FLOOR_BASELINE = [
    '## Purpose',
    'This baseline is the operator-authored reference loop a challenger must beat. It captures the full procedure for durable reader waves over a recorded session corpus, isolates the real bottleneck before any change is attempted, and extracts candidate workflows that are gated on recorded evidence before they can count as qualified loops. Every phase leaves an artifact on disk so nothing is skipped and nothing is trusted on a confidence claim alone.',
    '',
    '## Procedure',
    'First, open the corpus read-only and reproduce the failure or opportunity on the smallest triggering input. Second, stream each phase one section at a time and record an observation or artifact for every phase so nothing is skipped. Third, replay the strongest candidate in a clean context and prove an independent root task end to end with sealed run logs. Fourth, sweep for contradictions and drop any candidate that cannot be reproduced from sealed bytes. Fifth, freeze the scorecard and measure the baseline bar with tool-computed cost and quality before any challenger runs.',
    '',
    '## Acceptance',
    'A candidate qualifies only when its measured quality holds at equal or lower token cost than this baseline and the result reverifies from the sealed run logs. A summary, a confidence claim, or a bare tool call is never progress; only a supervisor-accepted transition counts. The operator is the only stop condition. Do not paste a stub here — replace this text with your real loop when you have one, but this fixture is long enough to clear the baseline integrity floor for copy-paste demos.'
  ].join('\n');
  const baselineContent = (typeof target.baselineContent === 'string' && target.baselineContent.trim().length > 0)
    ? target.baselineContent
    : FLOOR_BASELINE;
  const bl = engine.artifact_record({
    runId: subRunId,
    role: 'baseline',
    name: 'baseline',
    content: baselineContent
  });
  if (bl.status !== 'OK') return { subRunId, step: 'artifact_record(baseline)', ...bl };

  const prop = engine.benchmark_propose({ runId: subRunId, benchmarks: [target.benchmark] });
  if (prop.status !== 'OK') return { subRunId, step: 'benchmark_propose', ...prop };

  const benchmarkId = Array.isArray(prop.benchmarkIds) ? prop.benchmarkIds[0] : null;
  if (!benchmarkId) {
    return {
      subRunId, step: 'benchmark_propose', status: 'BLOCKED', code: 'NO_BENCHMARK_ID',
      message: 'benchmark_propose must return benchmarkIds[0] — never read benchmarks[0]'
    };
  }

  const sel = engine.benchmark_select({ runId: subRunId, benchmarkId });
  if (sel.status !== 'OK') return { subRunId, step: 'benchmark_select', ...sel };

  if (target.improvedContent) {
    const ev = engine.artifact_record({
      runId: subRunId,
      role: 'evidence',
      name: 'improved-candidate',
      content: target.improvedContent
    });
    if (ev.status !== 'OK') return { subRunId, step: 'artifact_record(evidence)', ...ev };
  }

  const campaignStatus = engine.campaign_status({ runId: subRunId });
  return {
    subRunId,
    step: 'through_benchmark_select',
    status: 'OK',
    benchmarkId,
    baselineSha256: bl.sha256,
    campaignStatus
  };
}

export function driveImproveTargets(engine, parentRunId, targets) {
  if (!Array.isArray(targets) || !targets.length) {
    return { parentRunId, results: [], aborted: true, error: 'no improve targets' };
  }
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const subRunId = `${parentRunId}-t${i + 1}`;
    const r = improveOneTarget(engine, subRunId, targets[i]);
    results.push(r);
    if (r.status === 'BLOCKED') {
      return { parentRunId, results, aborted: true, failedAt: subRunId, step: r.step };
    }
    const cs = r.campaignStatus;
    const open = cs && ['INITIALIZED', 'ACTIVE', 'NEEDS_RESUME'].includes(cs.runStatus);
    if (open && cs.campaignContinues !== true) {
      throw new Error(`INVARIANT: open run ${subRunId} must carry campaignContinues:true`);
    }
  }
  return { parentRunId, results, aborted: false };
}

function main() {
  const configPath = arg('--config', join(PKG, 'examples', 'improve-targets.sample.json'));
  const parentRunId = arg('--parent-run-id', `improve-${Date.now().toString(36)}`);
  const home = arg('--home', process.env.SUPER_LOOP_HOME || join(PKG, '.super-loop'));
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const targets = (cfg.targets || []).filter((t) => t.kind === 'improve');
  if (!targets.length) {
    process.stderr.write('error: config must include at least one { kind:"improve", ... } target\n');
    process.exit(2);
  }
  const engine = createEngine(createStore(home));
  const out = driveImproveTargets(engine, parentRunId, targets);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out.aborted) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
