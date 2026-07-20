#!/usr/bin/env node
// Standalone autonomous harness = the Loop Factory SUPERVISOR driven to completion-or-stop.
// Unlike the MCP (reactive — a host calls its tools), this OWNS the control loop:
// intake → mine → improve targets → validate every worker → bank Stones →
// advance/retire → re-mine — and only stops when the operator drops the stop-file.
// Requires SUPER_LOOP_ALLOW_EXEC=1 (a self-driving harness must run real workers).
//
// Usage:
//   SUPER_LOOP_ALLOW_EXEC=1 node scripts/run-campaign.mjs --config campaign.json [--run-id ID] [--stop-file PATH] [--max-batches N] [--home DIR]
//
// campaign.json:
//   { "task":"...", "routes":["claude-opus-4-8","glm-5.2","claude-opus-4-8"],
//     "benchmark": { "name":"...", "taskValueDimensions":["..."], "resourceDimensions":["..."], "cases":[{"id":"c1"}], "oracle":"..." },
//     "targets": [
//       { "kind":"mine", "routes":["..."] },
//       { "kind":"improve", "loop":"loop-de-loop", "baselineContent":"<loop text>", "benchmark":{...}, "routes":["..."] }
//     ],
//     "remineOnEmpty": true }
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../src/server.mjs';
import {
  campaignTargetInboxPath,
  createCampaignIdleWait,
  DEFAULT_IDLE_POLL_MS,
  normalizeCampaignIdlePollMs
} from '../src/campaign-inbox.mjs';
import { runSupervisedCampaign } from '../src/supervisor.mjs';
import { executorWorker, isExecEnabled } from '../src/executor.mjs';
import { campaignHasCaptureMilestone, captureTrajectory } from './trajectory-capture.mjs';
import {
  REAL_TEST_LIMITS,
  resolveEvidenceCapsule,
  validateRealTestConfig,
  withRealTestProfile
} from '../src/real-test.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const configPath = arg('--config');
if (!configPath) { process.stderr.write('error: --config <campaign.json> is required\n'); process.exit(2); }

let config = JSON.parse(readFileSync(configPath, 'utf8'));
const realTestMode = process.argv.includes('--real-test');
if (realTestMode) {
  const approvedPlan = arg('--approved-plan');
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const resolvedEvidence = resolveEvidenceCapsule(repositoryRoot, config.evidenceSources);
  config = {
    ...config,
    evidenceManifest: resolvedEvidence.manifest,
    evidenceCapsule: resolvedEvidence.capsule
  };
  if (!resolvedEvidence.ok) {
    process.stderr.write('REAL_TEST_EVIDENCE BLOCKED\n');
    for (const error of resolvedEvidence.errors) process.stderr.write(`- ${error}\n`);
    process.stderr.write('No worker was launched and no fallback was attempted.\n');
    process.exit(4);
  }
  const prepared = withRealTestProfile(config, approvedPlan);
  config = prepared.config;
  process.stdout.write('strict real-test plan\n');
  process.stdout.write(`plan sha256: ${prepared.plan.sha256}\n`);
  process.stdout.write(`benchmark sha256: ${prepared.plan.benchmarkSha256 || 'missing'}\n`);
  process.stdout.write(`limits: ${REAL_TEST_LIMITS.maxFindings} accepted findings / ${REAL_TEST_LIMITS.maxImprovementAttempts} valid improvement attempts\n`);
  process.stdout.write('benchmark authority: maker-frozen · baseline: 3-5 route batch · invalid batches: excluded\n');
  const check = validateRealTestConfig(config);
  if (!check.ok) {
    process.stderr.write('REAL_TEST_CONFIG BLOCKED\n');
    for (const error of check.errors) process.stderr.write(`- ${error}\n`);
    if (!approvedPlan || approvedPlan !== prepared.plan.sha256) {
      process.stderr.write(`\nOperator action required: review the config and rerun with --approved-plan ${prepared.plan.sha256}\n`);
      process.stderr.write('No worker was launched and no fallback was attempted.\n');
    }
    process.exit(4);
  }
}
if (!isExecEnabled()) { process.stderr.write('error: set SUPER_LOOP_ALLOW_EXEC=1 - the autonomous harness must run real workers\n'); process.exit(3); }
const runId = arg('--run-id', config.runId || `run-${Math.abs([...configPath].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(16)}`);
const stopFile = arg('--stop-file', config.stopFile || null);
const maxBatchesArg = arg('--max-batches');
const maxBatches = realTestMode
  ? REAL_TEST_LIMITS.maxImprovementAttempts
  : (maxBatchesArg != null ? Number(maxBatchesArg) : Infinity);
const home = arg('--home');

const { engine, store } = buildServer(home ? { home } : {});
const continuousMode = config.remineOnEmpty === true && !realTestMode;
const idlePollMs = normalizeCampaignIdlePollMs(
  Number.isFinite(Number(config.idlePollMs)) ? Number(config.idlePollMs) : DEFAULT_IDLE_POLL_MS
);
const idleWait = continuousMode
  ? createCampaignIdleWait({
      store,
      runId,
      pollMs: idlePollMs,
      log: (message) => process.stdout.write(message + '\n')
    })
  : null;

process.stdout.write(`super-loop autonomous supervisor · run ${runId}\n`);
process.stdout.write(stopFile ? `stop condition: create ${stopFile} (you are the only stop)\n` : 'stop condition: Ctrl-C (no stop-file set; you are the only stop)\n');
if (continuousMode) {
  process.stdout.write(`idle policy: zero inference after one saturated mining pass; poll ${idlePollMs}ms\n`);
  process.stdout.write(`target inbox: ${campaignTargetInboxPath(store, runId)}\n`);
}

// Serve the dashboard so review is explicit and hash-bound: choose Approve/Deny,
// confirm the queue action, then let this campaign's per-tick drain revalidate it.
// One command, no files. Disable with --no-dashboard.
let dashChild = null;
if (!process.argv.includes('--no-dashboard')) {
  const dashPort = arg('--dashboard-port', process.env.SUPER_LOOP_DASHBOARD_PORT || '8787');
  const dashArgs = [fileURLToPath(new URL('./dashboard-server.mjs', import.meta.url)), '--port', String(dashPort)];
  if (home) dashArgs.push('--home', home);
  try {
    dashChild = spawn(process.execPath, dashArgs, { stdio: 'inherit' });
    const killDash = () => { try { if (dashChild && !dashChild.killed) dashChild.kill(); } catch { /* ignore */ } };
    process.on('exit', killDash);
    process.on('SIGINT', () => { killDash(); process.exit(130); });
    process.on('SIGTERM', () => { killDash(); process.exit(143); });
    process.stdout.write(`dashboard: http://127.0.0.1:${dashPort} — choose Approve/Deny, confirm the session-authorized queue action, then watch persisted state. No files.\n`);
  } catch (e) { process.stdout.write(`(dashboard server not started: ${e.message})\n`); }
}

const result = runSupervisedCampaign(engine, { ...config, runId }, {
  worker: executorWorker,
  maxBatches,
  stopCheck: stopFile ? () => existsSync(stopFile) : () => false,
  idleWait,
  log: (m) => process.stdout.write(m + '\n')
});

if (result === 'MISSING_FULL_PRIVATE_LOOPS') { process.stdout.write('MISSING_FULL_PRIVATE_LOOPS\n'); process.exit(1); }

// Run-capture (Step 5): if the campaign hit a promotion or a lane pivot, snapshot the run's
// recorded trajectory to <runDir>/trajectory-<ts>.jsonl for offline reuse. Gate-partitioned
// (held-out) runs are skipped — never captured. Read-only; a failure here never fails the run.
if (campaignHasCaptureMilestone(result.transcript)) {
  try {
    const cap = captureTrajectory(engine, runId, { store, reason: 'campaign-milestone' });
    if (cap.captured) process.stdout.write(`trajectory captured: ${cap.path} (${cap.lines} lines, sha256 ${cap.sha256.slice(0, 12)}…)\n`);
    else process.stdout.write(`trajectory NOT captured (${cap.reason})${cap.reason === 'gate-partitioned' ? ' — held-out run, never exported' : ''}\n`);
  } catch (e) { process.stdout.write(`(trajectory capture skipped: ${e.message})\n`); }
}

process.stdout.write('\n=== campaign halted ===\n');
process.stdout.write(`stoppedBy: ${result.stoppedBy || result.code || result.status}\n`);
process.stdout.write(`Stones banked: ${(result.stones || []).length} · valid FullTestBatches: ${result.batchesTotal ?? 0}\n`);
if (result.realTest) {
  process.stdout.write(`Real-test findings: ${result.realTest.findingsAccepted}/${result.realTest.limits.maxFindings} accepted (${result.realTest.findingsRejected} rejected)\n`);
  process.stdout.write(`Real-test improvement attempts: ${result.realTest.improvementAttempts}/${result.realTest.limits.maxImprovementAttempts} valid (${result.realTest.invalidAttempts} invalid excluded)\n`);
}
process.exit(result.status === 'OK' ? 0 : 1);
