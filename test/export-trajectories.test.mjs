// Run-trajectory export: export_trajectories, bench-maker freeze, bench partitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshEngine, SPECIFIC_TASK, BASELINE_BODY } from './helpers.mjs';
import { DEFAULT_QUALITY_ORACLE } from '../src/measure.mjs';
import { sha256 } from '../src/util.mjs';

const BENCH = {
  name: 'precision',
  taskValueDimensions: ['q'],
  resourceDimensions: ['cost'],
  cases: [{ id: 'c1' }],
  oracle: DEFAULT_QUALITY_ORACLE
};

function initRun(engine, runId) {
  engine.initialize_loop_run({ runId, task: SPECIFIC_TASK });
  engine.artifact_record({ runId, role: 'baseline', content: BASELINE_BODY });
}

test('export_trajectories writes Hermes JSONL with supervisor labels from recorded actions', () => {
  const { engine, store, home } = freshEngine();
  initRun(engine, 'tr1');
  engine.loop_start({ runId: 'tr1', loop: 'strip-miner' });
  const blocked = engine.request_next_phase({ runId: 'tr1' });
  assert.equal(blocked.code, 'PHASE_SKIP');
  const outRel = 'trajectory.jsonl';
  const exp = engine.export_trajectories({ runId: 'tr1', outPath: outRel });
  assert.equal(exp.status, 'OK');
  assert.equal(exp.lines, 4);
  assert.equal(exp.sha256, sha256(readFileSync(join(store.runDir('tr1'), outRel), 'utf8')));
  const lines = readFileSync(join(home, 'runs', 'tr1', outRel), 'utf8').trim().split('\n');
  const phaseLine = JSON.parse(lines.find((l) => l.includes('request_next_phase')));
  assert.equal(phaseLine.role, 'assistant');
  assert.equal(phaseLine.tool_calls[0].function.name, 'request_next_phase');
  assert.equal(phaseLine.label.verdict, 'blocked');
  assert.equal(phaseLine.label.code, 'PHASE_SKIP');
  assert.ok(phaseLine.label.reason);
});

test('gate-partitioned runs are never exported', () => {
  const { engine } = freshEngine();
  initRun(engine, 'tr-gate');
  engine.benchmark_freeze_maker({
    runId: 'tr-gate',
    benchmark: BENCH,
    benchPartition: 'gate'
  });
  const exp = engine.export_trajectories({ runId: 'tr-gate', outPath: 'trajectory.jsonl' });
  assert.equal(exp.status, 'BLOCKED');
  assert.equal(exp.code, 'BAD_INPUT');
  assert.match(exp.message, /gate-partitioned/i);
});

test('benchmark_freeze_maker freezes with benchSource maker and blocks worker propose', () => {
  const { engine, store } = freshEngine();
  initRun(engine, 'mk1');
  const fr = engine.benchmark_freeze_maker({ runId: 'mk1', benchmark: BENCH, benchPartition: 'gate' });
  assert.equal(fr.status, 'OK');
  assert.equal(fr.benchSource, 'maker');
  assert.equal(fr.benchPartition, 'gate');
  const st = store.load('mk1');
  assert.equal(st.benchmark.def.benchSource, 'maker');
  assert.equal(st.benchmark.def.benchPartition, 'gate');
  const noop = engine.benchmark_propose({ runId: 'mk1', benchmarks: [BENCH] });
  assert.equal(noop.status, 'OK');
  assert.equal(noop.makerFrozen, true);
  assert.deepEqual(noop.benchmarkIds, []);
});

test('worker benchmark_propose tags benchSource worker and benchPartition harvest by default', () => {
  const { engine, store } = freshEngine();
  initRun(engine, 'wp1');
  const prop = engine.benchmark_propose({ runId: 'wp1', benchmarks: [BENCH] });
  assert.equal(prop.status, 'OK');
  const proposal = store.load('wp1').benchmark.proposals[0];
  assert.equal(proposal.benchSource, 'worker');
  assert.equal(proposal.benchPartition, 'harvest');
});

test('worker cannot set benchSource maker via benchmark_propose', () => {
  const { engine } = freshEngine();
  initRun(engine, 'wp2');
  const r = engine.benchmark_propose({ runId: 'wp2', benchmarks: [{ ...BENCH, benchSource: 'maker' }] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'BAD_INPUT');
});
