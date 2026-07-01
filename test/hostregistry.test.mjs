// Step 2: the host runtime registry (hosts/registry.json) loads as pure data, and
// the loader resolves an alias/env value to a canonical host id + profile, falling
// back to the 'unknown' entry. A consistency lock keeps the registry's continuous
// driver command in step with constants.CONTINUOUS_MODE_BY_HOST during the gradual
// migration, so the two sources can never silently drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHostRegistry, resolveHostId, hostProfile, hostMatrix } from '../src/host.mjs';
import { CONTINUOUS_MODE_BY_HOST } from '../src/constants.mjs';

test('the registry loads and is shaped as pure data', () => {
  const reg = loadHostRegistry();
  assert.equal(typeof reg.version, 'number');
  assert.ok(Array.isArray(reg.hosts) && reg.hosts.length >= 3);
  for (const id of ['claude-code', 'codex', 'unknown']) {
    assert.ok(reg.hosts.some((h) => h.id === id), `registry has ${id}`);
  }
  // every entry carries the fields the later steps consume
  for (const h of reg.hosts) {
    assert.equal(typeof h.id, 'string');
    assert.ok('driverFamily' in h, `${h.id} has driverFamily`);
    assert.ok('tier' in h, `${h.id} has tier`);
    assert.ok(h.primaryDriver && 'command' in h.primaryDriver, `${h.id} has primaryDriver.command`);
    assert.ok(Array.isArray(h.aliases), `${h.id} has aliases[]`);
  }
});

test('aliases resolve to the canonical host id', () => {
  assert.equal(resolveHostId('claude'), 'claude-code');
  assert.equal(resolveHostId('claude-code'), 'claude-code');
  assert.equal(resolveHostId('ClaudeCode'), 'claude-code');
  assert.equal(resolveHostId('codex'), 'codex');
  assert.equal(resolveHostId('gpt'), 'codex');
  assert.equal(resolveHostId('openai'), 'codex');
});

test('an unknown / empty alias falls back to "unknown"', () => {
  assert.equal(resolveHostId(''), 'unknown');
  assert.equal(resolveHostId(null), 'unknown');
  assert.equal(resolveHostId('some-host-we-do-not-know'), 'unknown');
});

test('hostProfile returns the full entry, or the unknown entry as fallback', () => {
  assert.equal(hostProfile('claude').id, 'claude-code');
  assert.equal(hostProfile('claude').primaryDriver.command, '/goal');
  assert.equal(hostProfile('claude').driverFamily, 'goal_progress');
  assert.equal(hostProfile('codex').primaryDriver.command, '/goal');
  const fb = hostProfile('nonsense');
  assert.equal(fb.id, 'unknown');
  assert.equal(fb.primaryDriver.command, null);
});

test('an explicit fixture path bypasses the cache', () => {
  const url = new URL('../hosts/registry.json', import.meta.url);
  const a = loadHostRegistry(url);
  assert.ok(Array.isArray(a.hosts));
  // distinct object from the cached default load (proves the path branch ran)
  assert.notEqual(a, loadHostRegistry());
});

test('consistency lock: registry driver command matches CONTINUOUS_MODE_BY_HOST (no drift)', () => {
  // The short engine keys map onto canonical registry ids. Commands must agree so a
  // future buildHostSetup() consolidation onto the registry is behavior-preserving.
  const pairs = [['claude', 'claude-code'], ['codex', 'codex'], ['unknown', 'unknown']];
  for (const [shortKey, regId] of pairs) {
    const mode = CONTINUOUS_MODE_BY_HOST[shortKey];
    const prof = hostProfile(regId);
    assert.equal(prof.primaryDriver.command, mode.command, `${regId} command matches constants ${shortKey}`);
  }
});

// ---- Step 3: 10-host registry + driver families + matrix ------------------

test('registry carries driver families, tiers, and a CLI fallback', () => {
  const reg = loadHostRegistry();
  assert.equal(typeof reg.families, 'object');
  for (const fam of ['goal_progress', 'mcp_reactive', 'auto_continue', 'orchestrator', 'internal_loop', 'cli_autonomous']) {
    assert.ok(reg.families[fam], `family ${fam} described`);
  }
  assert.equal(typeof reg.tiers, 'object');
  assert.equal(reg.cliFallback, 'super-loop-run');
  // every host's driverFamily is one the families map describes
  for (const h of reg.hosts) {
    assert.ok(reg.families[h.driverFamily], `${h.id} driverFamily "${h.driverFamily}" is described`);
  }
});

test('the 8 added hosts resolve via their aliases', () => {
  const cases = [
    ['zcode', 'zcode'], ['z-code', 'zcode'],
    ['opencode', 'opencode'],
    ['cursor', 'cursor'],
    ['kilo', 'kilocode'], ['kilocode', 'kilocode'],
    ['openclaw', 'openclaw'],
    ['hermes', 'hermes'],
    ['droid', 'factory-droid'], ['factory-droid', 'factory-droid'],
    ['mini-agent', 'mini-agent'], ['minimax-mini-agent', 'mini-agent']
  ];
  for (const [alias, id] of cases) assert.equal(resolveHostId(alias), id, `${alias} -> ${id}`);
});

test('registry now has at least 10 hosts (+ unknown fallback)', () => {
  const reg = loadHostRegistry();
  const ids = reg.hosts.map((h) => h.id);
  for (const id of ['claude-code', 'codex', 'zcode', 'opencode', 'cursor', 'kilocode', 'openclaw', 'hermes', 'factory-droid', 'mini-agent', 'unknown']) {
    assert.ok(ids.includes(id), `registry includes ${id}`);
  }
});

test('unverified hosts are marked verified:false with no guessed slash command claim of certainty', () => {
  const reg = loadHostRegistry();
  // claude-code / codex / unknown are confirmed; the 8 added hosts are not.
  for (const id of ['claude-code', 'codex', 'unknown']) {
    assert.equal(reg.hosts.find((h) => h.id === id).verified, true, `${id} verified`);
  }
  for (const id of ['zcode', 'opencode', 'cursor', 'kilocode', 'openclaw', 'hermes', 'factory-droid', 'mini-agent']) {
    assert.equal(reg.hosts.find((h) => h.id === id).verified, false, `${id} not yet verified`);
  }
});

test('hostMatrix lists every recognized host (not the unknown fallback) with the matrix fields', () => {
  const rows = hostMatrix();
  assert.ok(rows.length >= 10, `matrix has >= 10 rows, got ${rows.length}`);
  assert.ok(!rows.some((r) => r.id === 'unknown'), 'unknown fallback is excluded from the matrix');
  for (const r of rows) {
    assert.equal(typeof r.id, 'string');
    assert.ok('driverFamily' in r && 'tier' in r && 'command' in r && 'verified' in r);
    assert.equal(r.cliFallback, 'super-loop-run');
  }
  const claude = rows.find((r) => r.id === 'claude-code');
  assert.equal(claude.command, '/goal');
  assert.equal(claude.tier, 1);
});
