#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildProcessLaunch } from '../src/process-launch.mjs';
import { TOOL_SPECS } from '../src/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) {
  throw new Error('package smoke must run through npm so npm_execpath identifies the current npm CLI');
}

const temp = mkdtempSync(join(tmpdir(), 'loop factory packed smoke '));
const packDir = join(temp, 'tarball output');
const installDir = join(temp, 'clean install');

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function installedCommand(binPath, args, { input = '', env = process.env } = {}) {
  const launch = buildProcessLaunch({ binPath, args, env });
  return spawnSync(launch.file, launch.args, {
    input,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    shell: false
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', packDir], ROOT));
  assert.equal(packed.length, 1);
  const tarball = join(packDir, packed[0].filename);
  assert.ok(existsSync(tarball), 'npm pack produced a tarball');

  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ private: true }));
  npm(['install', '--ignore-scripts', '--prefix', installDir, tarball], temp);

  const packageRoot = join(installDir, 'node_modules', 'super-loop-mcp');
  const required = [
    'package.json', 'LICENSE', 'README.md', 'hosts/registry.json',
    'examples/campaign.json', 'examples/campaign-improve-only.json',
    'loops/strip-miner.txt', 'loops/loop-de-loop.md',
    'src/server.mjs', 'scripts/run-campaign.mjs'
  ];
  for (const rel of required) assert.ok(existsSync(join(packageRoot, rel)), `packed file exists: ${rel}`);

  const installedPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(installedPackage.bin, {
    'super-loop-mcp': 'src/server.mjs',
    'super-loop-run': 'scripts/run-campaign.mjs'
  });
  const binRoot = join(installDir, 'node_modules', '.bin');
  const mcpBin = join(binRoot, process.platform === 'win32' ? 'super-loop-mcp.cmd' : 'super-loop-mcp');
  const runBin = join(binRoot, process.platform === 'win32' ? 'super-loop-run.cmd' : 'super-loop-run');
  assert.ok(existsSync(mcpBin), 'installed MCP command shim exists');
  assert.ok(existsSync(runBin), 'installed campaign command shim exists');

  const stateHome = join(temp, 'isolated state with spaces');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'ping', params: {} }
  ];
  const child = installedCommand(mcpBin, [], {
    input: `${requests.map(JSON.stringify).join('\n')}\n`,
    env: { ...process.env, SUPER_LOOP_HOME: stateHome }
  });
  assert.equal(child.status, 0, `installed MCP exits cleanly: ${child.stderr}`);
  const responses = child.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, 'super-loop');
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    TOOL_SPECS.map((tool) => tool.name)
  );
  assert.deepEqual(responses[2].result, {});

  const runHelp = installedCommand(runBin, []);
  assert.equal(runHelp.status, 2, `installed campaign command reaches its argument boundary: ${runHelp.stderr}`);
  assert.match(runHelp.stderr, /--config <campaign\.json> is required/);

  const loops = await import(pathToFileURL(join(packageRoot, 'src', 'loops.mjs')));
  const manifest = loops.verifyAllLoops();
  assert.deepEqual(manifest.map((loop) => [loop.id, loop.sha256, loop.lines]), [
    ['strip-miner', '5270d691319120758423503e74c5aa6b378409b55f30bc6d2f2f7ca283ed9ec9', 345],
    ['loop-de-loop', '70090e033e995374710722771372d1afb17b6f0f823b2ce2911d9bfd38022b44', 75]
  ]);

  const installedServer = await import(pathToFileURL(join(packageRoot, 'src', 'server.mjs')));
  const userRoot = join(temp, 'simulated user home');
  const installedEnv = {
    HOME: userRoot,
    USERPROFILE: userRoot,
    XDG_STATE_HOME: join(userRoot, 'state'),
    LOCALAPPDATA: join(userRoot, 'AppData', 'Local')
  };
  const first = installedServer.buildServer({ env: installedEnv });
  assert.equal(first.stateHomeSource, 'user-state');
  const initialized = first.engine.initialize_loop_run({
    runId: 'package-smoke',
    task: 'Verify packed Loop Factory persistence with a deterministic regression bar.'
  });
  assert.equal(initialized.status, 'OK');
  const second = installedServer.buildServer({ env: installedEnv });
  assert.equal(second.store.load('package-smoke').runId, 'package-smoke');
  assert.equal(existsSync(join(packageRoot, '.super-loop')), false, 'packed install never creates package-root state');

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    tarball: packed[0].filename,
    files: packed[0].files.length,
    packageBytes: packed[0].size,
    unpackedBytes: packed[0].unpackedSize,
    tools: TOOL_SPECS.length,
    loops: manifest.map((loop) => ({ id: loop.id, sha256: loop.sha256, lines: loop.lines })),
    stateRoundTrip: true,
    installedEntrypoints: ['super-loop-mcp', 'super-loop-run'],
    packageRootStateCreated: false,
    installPathContainedSpaces: true
  }, null, 2)}\n`);
} finally {
  if (process.env.KEEP_PACKAGE_SMOKE !== '1') rmSync(temp, { recursive: true, force: true });
}
