// The MCP transport: handleMessage speaks JSON-RPC, lists every tool, dispatches
// tools/call to the engine, and 404s unknown methods/tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, TOOL_SPECS } from '../src/server.mjs';
import { freshEngine, SPECIFIC_TASK } from './helpers.mjs';

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize handshake echoes protocol + serverInfo', () => {
  const { engine } = freshEngine();
  const out = handleMessage(engine, rpc('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(out.result.serverInfo.name, 'super-loop');
  assert.equal(out.result.protocolVersion, '2025-06-18');
  assert.ok(out.result.capabilities.tools);
});

test('notifications/initialized produces no response', () => {
  const { engine } = freshEngine();
  const out = handleMessage(engine, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out, null);
});

test('tools/list returns every required tool', () => {
  const { engine } = freshEngine();
  const out = handleMessage(engine, rpc('tools/list'));
  const names = out.result.tools.map((t) => t.name);
  assert.equal(names.length, TOOL_SPECS.length);
  for (const required of [
    'initialize_loop_run', 'request_next_phase', 'register_hypotheses', 'test_hypothesis',
    'cycle_decision_request', 'update_dashboard', 'artifact_record', 'benchmark_propose',
    'benchmark_select', 'benchmark_run', 'reverify_run', 'promotion_request', 'continue_run', 'report_export',
    'loop_register', 'loop_library', 'skill_fetch', 'host_capability_preflight'
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
});

test('loop_start schema accepts custom loop ids, not only bundled enum values', () => {
  const { engine } = freshEngine();
  const out = handleMessage(engine, rpc('tools/list'));
  const loopStart = out.result.tools.find((t) => t.name === 'loop_start');
  assert.ok(loopStart);
  assert.equal(loopStart.inputSchema.properties.loop.type, 'string');
  assert.equal(loopStart.inputSchema.properties.loop.enum, undefined);
  assert.match(loopStart.inputSchema.properties.loop.description, /custom loop id/i);
});

test('tools/call dispatches to the engine and returns JSON content', () => {
  const { engine } = freshEngine();
  const out = handleMessage(engine, rpc('tools/call', { name: 'initialize_loop_run', arguments: { runId: 's1', task: SPECIFIC_TASK } }));
  assert.equal(out.result.isError, false);
  const payload = JSON.parse(out.result.content[0].text);
  assert.equal(payload.status, 'OK');
  assert.equal(payload.runId, 's1');
});

test('unknown method and unknown tool both 404', () => {
  const { engine } = freshEngine();
  const m = handleMessage(engine, rpc('does/not/exist'));
  assert.equal(m.error.code, -32601);
  const t = handleMessage(engine, rpc('tools/call', { name: 'no_such_tool', arguments: {} }));
  assert.equal(t.error.code, -32601);
});

test('a BLOCKED business result is content, not a protocol error', () => {
  const { engine } = freshEngine();
  handleMessage(engine, rpc('tools/call', { name: 'initialize_loop_run', arguments: { runId: 's2', task: 'vague' } }));
  const out = handleMessage(engine, rpc('tools/call', { name: 'loop_start', arguments: { runId: 's2', loop: 'strip-miner' } }));
  assert.equal(out.result.isError, false);
  const payload = JSON.parse(out.result.content[0].text);
  assert.equal(payload.status, 'BLOCKED');
  assert.equal(payload.code, 'NOT_INITIALIZED');
});
