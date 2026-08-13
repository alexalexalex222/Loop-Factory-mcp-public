import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_SPECS } from '../src/server.mjs';
import { isExecEnabled } from '../src/executor.mjs';
import { verifyAllLoops } from '../src/loops.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = [
  'initialize_loop_run', 'loop_start', 'request_next_phase', 'loop_next',
  'observation_record', 'artifact_record', 'benchmark_propose', 'benchmark_select',
  'benchmark_freeze_maker', 'benchmark_run', 'register_hypotheses', 'test_hypothesis',
  'execute_full_test', 'reverify_run', 'promotion_request', 'cycle_decision_request',
  'run_campaign', 'report_saturation', 'campaign_status', 'continue_run',
  'human_review_request', 'update_dashboard', 'report_export', 'export_trajectories',
  'loop_register', 'loop_library', 'skill_fetch', 'host_capability_preflight',
  'host_runtime_detect'
];

test('portability contract freezes bundled loop hashes and line counts', () => {
  const loops = Object.fromEntries(verifyAllLoops().map((loop) => [loop.id, loop]));
  assert.equal(loops['strip-miner'].sha256, '5270d691319120758423503e74c5aa6b378409b55f30bc6d2f2f7ca283ed9ec9');
  assert.equal(loops['strip-miner'].lines, 345);
  assert.equal(loops['loop-de-loop'].sha256, '70090e033e995374710722771372d1afb17b6f0f823b2ce2911d9bfd38022b44');
  assert.equal(loops['loop-de-loop'].lines, 75);
});

test('portability contract freezes tool names and package binary names', () => {
  assert.deepEqual(TOOL_SPECS.map((tool) => tool.name), EXPECTED_TOOLS);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, {
    'super-loop-mcp': 'src/server.mjs',
    'super-loop-run': 'scripts/run-campaign.mjs'
  });
});

test('worker execution remains opt-in and disabled by default', () => {
  assert.equal(isExecEnabled({}), false);
  assert.equal(isExecEnabled({ SUPER_LOOP_ALLOW_EXEC: '0' }), false);
  assert.equal(isExecEnabled({ SUPER_LOOP_ALLOW_EXEC: '1' }), true);
});
