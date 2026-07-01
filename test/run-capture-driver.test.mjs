// STEP 5 — run-capture driver: trajectory capture after a milestone + the verify-trajectory CLI.
// Harvest-partition run → a verifiable file appears in the run dir. Gate-partition (held-out)
// run → no file. The verifier exits 0 on the real hash, 1 on a tampered one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { freshEngine, SPECIFIC_TASK, BASELINE_BODY } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import { sha256 } from '../src/util.mjs';
import {
  captureTrajectory,
  campaignHasCaptureMilestone,
  isGatePartitioned
} from '../scripts/trajectory-capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, '..', 'scripts', 'verify-trajectory.mjs');

const BENCH = {
  name: 'precision',
  taskValueDimensions: ['q'],
  resourceDimensions: ['cost'],
  cases: [{ id: 'c1' }],
  oracle: DEFAULT_QUALITY_ORACLE
};

// Light init: enough to seal a run with a recorded trajectory (init + baseline).
function initRun(engine, runId) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
  engine.artifact_record({ runId, role: 'baseline', content: BASELINE_BODY });
}

// Mirror export-trajectories.test.mjs: this exact sequence yields a non-empty trajectory.
function initWithTrajectory(engine, runId) {
  initRun(engine, runId);
  engine.loop_start({ runId, loop: 'strip-miner' });
  engine.request_next_phase({ runId });
}

test('harvest run: capture writes <runDir>/trajectory-<ts>.jsonl with a verifiable hash', () => {
  const { engine, store } = freshEngine();
  initWithTrajectory(engine, 'cap-harvest');
  const cap = captureTrajectory(engine, 'cap-harvest', { store, ts: 'FIXED-TS' });
  assert.equal(cap.captured, true);
  assert.ok(cap.lines >= 1, 'expected a non-empty trajectory');
  const file = join(store.runDir('cap-harvest'), 'trajectory-FIXED-TS.jsonl');
  assert.ok(existsSync(file), 'trajectory file should exist in the run dir');
  assert.equal(cap.path, file);
  assert.equal(cap.sha256, sha256(readFileSync(file, 'utf8')));
});

test('gate run: capture is refused and NO trajectory file is written', () => {
  const { engine, store } = freshEngine();
  initRun(engine, 'cap-gate');
  engine.benchmark_freeze_maker({ runId: 'cap-gate', benchmark: BENCH, benchPartition: 'gate' });
  assert.equal(isGatePartitioned(store.load('cap-gate')), true);
  const cap = captureTrajectory(engine, 'cap-gate', { store, ts: 'FIXED-TS' });
  assert.equal(cap.captured, false);
  assert.match(cap.reason, /gate/i);
  const files = readdirSync(store.runDir('cap-gate')).filter((f) => f.startsWith('trajectory-'));
  assert.deepEqual(files, [], 'no trajectory file may be written for a held-out (gate) run');
});

test('gate run: the engine backstops even without the store pre-check', () => {
  const { engine, store } = freshEngine();
  initRun(engine, 'cap-gate2');
  engine.benchmark_freeze_maker({ runId: 'cap-gate2', benchmark: BENCH, benchPartition: 'gate' });
  // Omit `store` so firewall #1 is skipped — the engine's own gate must still refuse.
  const cap = captureTrajectory(engine, 'cap-gate2', { ts: 'FIXED-TS' });
  assert.equal(cap.captured, false);
  const files = readdirSync(store.runDir('cap-gate2')).filter((f) => f.startsWith('trajectory-'));
  assert.deepEqual(files, []);
});

test('verify-trajectory CLI: exit 0 on the real hash, exit 1 on a tampered hash', () => {
  const { engine, store } = freshEngine();
  initWithTrajectory(engine, 'cap-verify');
  const cap = captureTrajectory(engine, 'cap-verify', { store, ts: 'VTS' });
  assert.equal(cap.captured, true);

  const good = spawnSync(process.execPath, [VERIFY, '--file', cap.path, '--expected-sha256', cap.sha256], { encoding: 'utf8' });
  assert.equal(good.status, 0, `expected exit 0 on the real hash; stderr=${good.stderr}`);

  const tampered = 'deadbeef'.repeat(8); // 64 hex chars, not the real digest
  const bad = spawnSync(process.execPath, [VERIFY, '--file', cap.path, '--expected-sha256', tampered], { encoding: 'utf8' });
  assert.equal(bad.status, 1, 'expected exit 1 on a mismatched hash');
});

test('verify-trajectory CLI: missing/unreadable file exits 2 (usage), never a false match', () => {
  const r = spawnSync(process.execPath, [VERIFY, '--file', '/nonexistent/trajectory.jsonl', '--expected-sha256', 'deadbeef'.repeat(8)], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('campaignHasCaptureMilestone: true for a promotion or branch-retired step, false otherwise', () => {
  assert.equal(campaignHasCaptureMilestone([{ step: 'mine_candidates' }, { step: 'branch_retired' }]), true);
  assert.equal(campaignHasCaptureMilestone([{ step: 'promotion_queued' }]), true);
  assert.equal(campaignHasCaptureMilestone([{ step: 'stone_banked' }]), true);
  assert.equal(campaignHasCaptureMilestone([{ step: 'mine_saturation' }, { step: 'subjective_win_queued' }]), false);
  assert.equal(campaignHasCaptureMilestone([]), false);
  assert.equal(campaignHasCaptureMilestone(), false);
});
