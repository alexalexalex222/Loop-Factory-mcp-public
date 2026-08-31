import { chmodSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Create a Node-backed fake CLI plus the platform wrapper expected by PATH lookup. */
export function createFakeCli(dir, name, options = {}) {
  const driverName = `${name}-fixture.mjs`;
  const driver = join(dir, driverName);
  const config = JSON.stringify({
    stdout: '', stderr: '', exitCode: 0, delayMs: 0,
    captureArgvEnv: null, captureStdinEnv: null, authorityEcho: false,
    countFileEnv: null, spawnDescendantEnv: null, descendantDelayMs: 0,
    ...options
  });
  writeFileSync(driver, `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = ${config};
const stdin = readFileSync(0, 'utf8');
if (config.captureArgvEnv && process.env[config.captureArgvEnv]) {
  writeFileSync(process.env[config.captureArgvEnv], process.argv.slice(2).join('\\n') + '\\n');
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
if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));
if (config.authorityEcho) {
  process.stdout.write(JSON.stringify({ type: 'agent_message', text: \`${'${process.env.SUPER_LOOP_OPERATOR_AUTHORITY || "clean"}'}:${'${process.env.SUPER_LOOP_REAL_TEST_APPROVAL || "clean"}'}\` }) + '\\n');
} else {
  if (config.stdout) process.stdout.write(config.stdout);
  if (config.stderr) process.stderr.write(config.stderr);
}
process.exitCode = config.exitCode;
`.trimStart());

  const windowsPath = join(dir, `${name}.cmd`);
  writeFileSync(windowsPath, `@echo off\r\n"${process.execPath}" "%~dp0${driverName}" %*\r\n`);
  if (process.platform === 'win32') return windowsPath;

  const unixPath = join(dir, name);
  // Keep the extensionless PATH executable compatible with Node 18, which
  // treats it as CommonJS even though the imported driver is ESM.
  writeFileSync(unixPath, `#!${process.execPath}\nimport('./${basename(driver)}').catch((error) => { console.error(error); process.exitCode = 1; });\n`);
  chmodSync(unixPath, 0o755);
  return unixPath;
}
