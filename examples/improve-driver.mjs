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

  const bl = engine.artifact_record({
    runId: subRunId,
    role: 'baseline',
    name: 'baseline',
    content: target.baselineContent || `BASELINE ${loopId}`
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
