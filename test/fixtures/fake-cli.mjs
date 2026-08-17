import { chmodSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Create a Node-backed fake CLI plus the platform wrapper expected by PATH lookup. */
export function createFakeCli(dir, name, options = {}) {
  const driverName = `${name}-fixture.mjs`;
  const driver = join(dir, driverName);
  const config = JSON.stringify({
    stdout: '', stderr: '', exitCode: 0, delayMs: 0,
    captureArgvEnv: null, captureStdinEnv: null, authorityEcho: false,
    authCredentialEcho: false,
    countFileEnv: null, pidFileEnv: null, pidFilePath: null,
    spawnDescendantEnv: null, descendantDelayMs: 0, responses: [],
    ...options
  });
  writeFileSync(driver, `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = ${config};
const stdin = readFileSync(0, 'utf8');
const argv = process.argv.slice(2);
const response = Array.isArray(config.responses)
  ? config.responses.find((item) => (
    Array.isArray(item.argv)
    && JSON.stringify(item.argv.map(String)) === JSON.stringify(argv)
  ))
  : null;
const active = response ? { ...config, ...response } : config;
if (config.captureArgvEnv && process.env[config.captureArgvEnv]) {
  writeFileSync(process.env[config.captureArgvEnv], argv.join('\\n') + '\\n');
}
if (config.captureStdinEnv && process.env[config.captureStdinEnv]) {
  writeFileSync(process.env[config.captureStdinEnv], stdin);
}
if (config.countFileEnv && process.env[config.countFileEnv]) {
  const path = process.env[config.countFileEnv];
  let count = 0;
  try { count = Number(readFileSync(path, 'utf8')) || 0; } catch {}
  writeFileSync(path, String(count + 1));
}
if (config.pidFileEnv && process.env[config.pidFileEnv]) {
  writeFileSync(process.env[config.pidFileEnv], String(process.pid));
}
if (config.pidFilePath) writeFileSync(config.pidFilePath, String(process.pid));
if (config.spawnDescendantEnv && process.env[config.spawnDescendantEnv]) {
  const descendant = spawn(process.execPath, ['-e', [
    "const { writeFileSync } = require('node:fs')",
    "setTimeout(() => writeFileSync(process.env.LOOP_FACTORY_DESCENDANT_SENTINEL, 'survived'), Number(process.env.LOOP_FACTORY_DESCENDANT_DELAY_MS)), Number(process.env.LOOP_FACTORY_DESCENDANT_DELAY_MS) + 1000)"
  ].join(';')], {
    env: {
      ...process.env,
      LOOP_FACTORY_DESCENDANT_SENTINEL: process.env[config.spawnDescendantEnv],
      LOOP_FACTORY_DESCENDANT_DELAY_MS: String(config.descendantDelayMs || 1000)
    },
    stdio: 'ignore'
  });
  descendant.unref();
}
if (active.delayMs) await new Promise((resolve) => setTimeout(resolve, active.delayMs));
if (active.authorityEcho) {
  process.stdout.write(JSON.stringify({ type: 'agent_message', text: \`${'${process.env.SUPER_LOOP_OPERATOR_AUTHORITY || "clean"}'}:${'${process.env.SUPER_LOOP_REAL_TEST_APPROVAL || "clean"}'}\` }) + '\\n');
} else if (active.authCredentialEcho) {
  process.stdout.write(JSON.stringify({ type: 'agent_message', text: \`${'${process.env.OPENAI_API_KEY || "clean"}'}:${'${process.env.OPENAI_BASE_URL || "clean"}'}:${'${process.env.CODEX_ACCESS_TOKEN || "clean"}'}:${'${process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256 || "clean"}'}\` }) + '\\n');
} else {
  if (active.stdout) process.stdout.write(active.stdout);
  if (active.stderr) process.stderr.write(active.stderr);
}
process.exitCode = active.exitCode;
`.trimStart());

  const windowsPath = join(dir, `${name}.cmd`);
  writeFileSync(windowsPath, `@echo off\r\n"${process.execPath}" "%~dp0${driverName}" %*\r\n`);
  if (process.platform === 'win32') return windowsPath;

  const unixPath = join(dir, name);
  // Keep the extensionless PATH executable independent of module detection;
  // the imported driver remains explicitly ESM.
  writeFileSync(unixPath, `#!${process.execPath}\nimport('./${basename(driver)}').catch((error) => { console.error(error); process.exitCode = 1; });\n`);
  chmodSync(unixPath, 0o755);
  return unixPath;
}

export function createFakeCodexAuthorityCli(dir, {
  version = 'codex-cli 0.0.0-test',
  loginStatus = 'Logged in using ChatGPT',
  catalog = { models: [] },
  ...options
} = {}) {
  return createFakeCli(
    dir,
    process.platform === 'win32' ? 'codex' : 'codex.real',
    {
      exitCode: 64,
      responses: [
        { argv: ['--version'], stdout: `${version}\n`, exitCode: 0 },
        { argv: ['login', 'status'], stdout: `${loginStatus}\n`, exitCode: 0 },
        {
          argv: ['debug', 'models'],
          stdout: `${typeof catalog === 'string' ? catalog : JSON.stringify(catalog)}\n`,
          exitCode: 0
        }
      ],
      ...options
    }
  );
}
