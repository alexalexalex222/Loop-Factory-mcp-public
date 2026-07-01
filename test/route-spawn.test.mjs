// Step 3 — wire OR block unspawnable hypothesizer routes. The opencode-driven routes
// (minimax-m3, deepseek-v4-pro, mimo-v2.5-pro) pass classifyRoute but can only be
// launched when opencode is on PATH. register_hypotheses now refuses an unspawnable
// route unless the caller explicitly records it manually WITH provenance, and a manual
// artifact for an un-executed hypothesis must carry provenance — so a hand-run result is
// traceable, never an invisible/unbacked claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshEngine, initThroughBaselineBar } from './helpers.mjs';

const H = (model, extra = {}) => ({ title: 'h', bottleneck: 'b', operation: 'o', expectedMovement: '+q', route: { model }, ...extra });
// claude/codex routes are spawnable regardless of PATH (their binary is resolved at launch),
// so they are stable "peers" that let a 3-hypothesis batch register around one opencode route.
const SPAWNABLE_PEERS = [H('claude-opus-4-8'), H('gpt-5.5')];

// An injected env whose PATH contains a fake executable `opencode` (resolveOnPath finds it).
function pathWithOpencode() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-opencode-'));
  const bin = join(dir, 'opencode');
  writeFileSync(bin, '#!/bin/sh\necho hi\n');
  chmodSync(bin, 0o755);
  return { PATH: dir };
}
// An injected env whose PATH has no opencode at all (deterministic regardless of the dev machine).
function pathWithoutOpencode() {
  return { PATH: mkdtempSync(join(tmpdir(), 'sl-empty-')) };
}

test('opencode on PATH → an opencode-driven route (minimax-m3) registers as spawnable with executor metadata', () => {
  const { engine, store } = freshEngine({ env: pathWithOpencode() });
  initThroughBaselineBar(engine, 'rs1');
  const reg = engine.register_hypotheses({ runId: 'rs1', hypotheses: [H('minimax-m3'), ...SPAWNABLE_PEERS] });
  assert.equal(reg.status, 'OK');
  const minimax = reg.executorBindings.find((b) => b.route === 'minimax-m3');
  assert.equal(minimax.executorBin, 'opencode');
  assert.equal(minimax.spawnable, true);
  const hyp = store.load('rs1').hypotheses.find((h) => h.route.model === 'minimax-m3');
  assert.equal(hyp.executorBin, 'opencode');
  assert.equal(hyp.spawnable, true);
  assert.equal(hyp.manualRecord, false);
});

test('opencode NOT on PATH + no manual override → ROUTE_UNSPAWNABLE (not silently accepted)', () => {
  const { engine, store } = freshEngine({ env: pathWithoutOpencode() });
  initThroughBaselineBar(engine, 'rs2');
  const reg = engine.register_hypotheses({ runId: 'rs2', hypotheses: [H('minimax-m3'), ...SPAWNABLE_PEERS] });
  assert.equal(reg.status, 'BLOCKED');
  assert.equal(reg.code, 'ROUTE_UNSPAWNABLE');
  assert.equal(reg.manualAllowed, true);
  assert.ok(reg.unspawnable.includes('minimax-m3'));
  assert.equal(store.load('rs2').hypotheses.length, 0, 'nothing was half-registered');
});

test('all three opencode routes are gated together when opencode is absent', () => {
  const { engine } = freshEngine({ env: pathWithoutOpencode() });
  initThroughBaselineBar(engine, 'rs2b');
  const reg = engine.register_hypotheses({ runId: 'rs2b', hypotheses: [H('minimax-m3'), H('deepseek-v4-pro'), H('mimo-v2.5-pro')] });
  assert.equal(reg.code, 'ROUTE_UNSPAWNABLE');
  assert.deepEqual(reg.unspawnable.sort(), ['deepseek-v4-pro', 'mimo-v2.5-pro', 'minimax-m3']);
});

test('opencode NOT on PATH + manualRecord+provenance → accepted, tagged manual with provenance', () => {
  const { engine, store } = freshEngine({ env: pathWithoutOpencode() });
  initThroughBaselineBar(engine, 'rs3');
  const reg = engine.register_hypotheses({ runId: 'rs3', hypotheses: [
    H('minimax-m3', { manualRecord: true, provenance: 'ran: opencode -m minimax-anthropic-api/minimax-m3 @ 2026-06-28T12:00Z (operator hand-run)' }),
    ...SPAWNABLE_PEERS
  ] });
  assert.equal(reg.status, 'OK');
  const hyp = store.load('rs3').hypotheses.find((h) => h.route.model === 'minimax-m3');
  assert.equal(hyp.manualRecord, true);
  assert.equal(hyp.executorBin, null);
  assert.match(hyp.provenance, /operator hand-run/);
});

test('manualRecord WITHOUT provenance is NOT a valid override → still ROUTE_UNSPAWNABLE', () => {
  const { engine } = freshEngine({ env: pathWithoutOpencode() });
  initThroughBaselineBar(engine, 'rs3c');
  const reg = engine.register_hypotheses({ runId: 'rs3c', hypotheses: [
    H('minimax-m3', { manualRecord: true }), // no provenance
    ...SPAWNABLE_PEERS
  ] });
  assert.equal(reg.code, 'ROUTE_UNSPAWNABLE');
});

test('artifact_record for a manual (un-executed) hypothesis requires provenance', () => {
  const { engine, store } = freshEngine({ env: pathWithoutOpencode() });
  initThroughBaselineBar(engine, 'rs4');
  const reg = engine.register_hypotheses({ runId: 'rs4', hypotheses: [
    H('minimax-m3', { manualRecord: true, provenance: 'opencode -m minimax-anthropic-api/minimax-m3 @ ts' }),
    ...SPAWNABLE_PEERS
  ] });
  const manualHyp = reg.hypothesisIds[0];
  const noProv = engine.artifact_record({ runId: 'rs4', hypothesisId: manualHyp, role: 'runlog', name: 'manual-run', content: 'hand-run output of the loop on minimax-m3' });
  assert.equal(noProv.status, 'BLOCKED');
  assert.equal(noProv.code, 'MANUAL_PROVENANCE_REQUIRED');
  assert.equal(Object.hasOwn(noProv, 'artifactId'), false, 'nothing recorded when provenance is missing');

  const withProv = engine.artifact_record({ runId: 'rs4', hypothesisId: manualHyp, role: 'runlog', name: 'manual-run', content: 'hand-run output of the loop on minimax-m3', provenance: 'opencode -m minimax-anthropic-api/minimax-m3 @ 2026-06-28T12:05Z; output pasted by operator' });
  assert.equal(withProv.status, 'OK');
  const art = store.readArtifact('rs4', withProv.artifactId);
  assert.match(art.provenance, /pasted by operator/);
  assert.equal(art.hypothesisId, manualHyp);
});

test('a hypothesis WITH a Loop Factory-executed run on record does not require artifact provenance', () => {
  const { engine, store } = freshEngine({ env: pathWithOpencode() });
  initThroughBaselineBar(engine, 'rs5');
  const reg = engine.register_hypotheses({ runId: 'rs5', hypotheses: [H('claude-opus-4-8'), H('gpt-5.5'), H('glm-5.2')] });
  const hypId = reg.hypothesisIds[0];
  // simulate an executor run on record (what execute_full_test sets after launching)
  const st = store.load('rs5');
  st.hypotheses.find((h) => h.id === hypId).executorRan = true;
  store.save(st);
  const rec = engine.artifact_record({ runId: 'rs5', hypothesisId: hypId, role: 'runlog', name: 'run', content: 'executed output' });
  assert.equal(rec.status, 'OK', 'executed evidence is its own proof; no provenance demanded');
});

test('artifact_record with an unknown hypothesisId is rejected', () => {
  const { engine } = freshEngine();
  initThroughBaselineBar(engine, 'rs6');
  const r = engine.artifact_record({ runId: 'rs6', hypothesisId: 'hyp-nope', role: 'runlog', content: 'x', provenance: 'p' });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.code, 'UNKNOWN_HYPOTHESIS');
});
