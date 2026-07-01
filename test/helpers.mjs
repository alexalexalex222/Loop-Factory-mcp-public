// Shared test helpers. Each engine gets an isolated temp home and a deterministic
// monotonic clock so runs never collide and timestamps are reproducible.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createEngine } from '../src/engine.mjs';
import { DEFAULT_QUALITY_ORACLE, buildMeasuredContent } from '../src/measure.mjs';

export function freshEngine({ operatorAuthority = 'operator', env } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'superloop-'));
  const store = createStore(home);
  let t = 0;
  const clock = () => `2026-06-23T00:00:${String(t++ % 60).padStart(2, '0')}.000Z`;
  // env is injectable so route-spawnability ("is opencode on PATH") is deterministic in tests,
  // independent of what's installed on the dev machine. Undefined → engine defaults to process.env.
  const engine = createEngine(store, { clock, operatorAuthority, ...(env ? { env } : {}) });
  return { engine, store, home };
}

// Floor-passing baseline bodies (Step 1 integrity floor): >=200 tokens, >=3 markdown
// headers, no placeholder markers. Used wherever a test records a baseline purely as a
// precondition, so the fixture is a realistic reference rather than a trivial stub.
export const BASELINE_BODY = [
  '## Purpose',
  'This baseline captures the current loop as the reference a challenger must beat. It runs durable reader waves over the recorded session corpus, isolates the real bottleneck before any change, and extracts candidate workflows that are gated on recorded evidence before they can count as qualified loops.',
  '',
  '## Procedure',
  'First, open the corpus read-only and reproduce the failure or opportunity on the smallest triggering input. Second, stream each phase one section at a time and record an observation or artifact for every phase so nothing is skipped. Third, replay the strongest candidate in a clean context and prove an independent root task end to end. Fourth, sweep for contradictions and drop any candidate that cannot be reproduced from sealed bytes.',
  '',
  '## Acceptance',
  'A candidate qualifies only when its measured quality holds at equal or lower token cost than this baseline and the result reverifies from the sealed run logs. A summary, a confidence claim, or a bare tool call is never progress; only a supervisor-accepted transition counts. The operator is the only stop condition.'
].join('\n');

export const BASELINE_BODY_V2 = [
  '## Objective',
  'This alternate baseline describes the improvement loop used when a loop already exists and the goal is to harden it. The reference here is the loop text plus its measured cost and quality on the frozen scorecard, so a challenger has a concrete bar to beat rather than a vague impression of better.',
  '',
  '## Method',
  'Lock the current loop by hash, freeze a task-specific scorecard with a deterministic oracle where possible, and measure the baseline on a real worker before any challenger runs. Then register three to five frontier hypotheses, run each as a full measured batch, and compute the delta from the recorded bytes rather than any number a worker typed.',
  '',
  '## Promotion',
  'A challenger is promoted only after it moves the frontier on the same yardstick, survives a deep reverify from the sealed bytes, and clears the dashboard gate. No regression in cost or quality is accepted, and no worker may approve its own result.'
].join('\n');

// A fully-specified task so initialize_loop_run skips the ask-once questions.
export const SPECIFIC_TASK =
  'Improve the strip-miner loop to raise candidate precision by at least 10% while keeping token cost under the current benchmark.';

/**
 * Record a TOOL-COMPUTED raw artifact and return its id (the reverifiable
 * measurementRef). The run-log content is sized + probe-seeded so the MCP DERIVES
 * exactly (tokenCost, quality) from the bytes against the frozen probe oracle —
 * the model never hands the MCP a bare number.
 */
export function recordMeasurement(engine, runId, label, tokenCost, quality) {
  const r = engine.artifact_record({
    runId, name: label, role: 'runlog',
    content: buildMeasuredContent(tokenCost, quality, DEFAULT_QUALITY_ORACLE),
    measurement: { tokenCost, quality }
  });
  return r.artifactId;
}

/** Record an explicitly CALLER-REPORTED (weak) measurement — used to prove the gates refuse it. */
export function recordCallerReported(engine, runId, label, tokenCost, quality) {
  const r = engine.artifact_record({
    runId, name: label, role: 'runlog',
    content: `caller-reported run ${label}`,
    measurement: { tokenCost, quality }, callerReported: true
  });
  return r.artifactId;
}

/** Drive init → baseline lock → frozen benchmark (with a deterministic oracle) → measured baseline bar. */
export function initThroughBaselineBar(engine, runId, { baseQuality = 0.7, baseCost = 1000 } = {}) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK, userMessages: ['build it', 'use the full loops'] });
  engine.artifact_record({ runId, role: 'baseline', name: 'baseline.md', content: BASELINE_BODY });
  const prop = engine.benchmark_propose({
    runId,
    benchmarks: [{
      name: 'miner-precision',
      taskValueDimensions: ['candidate-precision', 'evidence-fidelity'],
      resourceDimensions: ['token-cost'],
      cases: [{ id: 'c1', input: 'session-corpus-A', expect: '3 qualified loops' }],
      oracle: DEFAULT_QUALITY_ORACLE
    }]
  });
  engine.benchmark_select({ runId, benchmarkId: prop.benchmarkIds[0] });
  const ref = recordMeasurement(engine, runId, 'baseline-bar', baseCost, baseQuality);
  engine.benchmark_run({ runId, arm: 'baseline', measurementRef: ref });
}

export function parseToolText(callResult) {
  return JSON.parse(callResult.content[0].text);
}

/**
 * Drive a promotion through the Step 2 dashboard-approval gate the way the operator
 * would: first promotion_request queues a PENDING promotion review and returns
 * PROMOTION_NEEDS_APPROVAL; the operator Approves out of band (applyDashboardDecisions —
 * NOT a model-callable tool); the second promotion_request then records the champion.
 * If the first call blocks for any OTHER reason (integrity seal, pareto, NOT_REVERIFIED),
 * that block is returned unchanged — those gates run before the approval gate.
 */
export function promoteWithApproval(engine, runId, hypothesisId, extra = {}) {
  const first = engine.promotion_request({ runId, hypothesisId, ...extra });
  if (!(first.status === 'BLOCKED' && first.code === 'PROMOTION_NEEDS_APPROVAL')) return first;
  engine.operator.applyDashboardDecisions({ runId, decisions: { [first.queuedReviewId]: { decision: 'approve' } } });
  return engine.promotion_request({ runId, hypothesisId, ...extra });
}
