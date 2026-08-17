#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeGuardedCodeCandidate } from '../src/vnext-code-worktree.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

try {
  const packetValue = flag('--packet');
  if (!packetValue || process.argv.length !== 4) {
    throw new Error('usage: run-vnext-code-candidate --packet <packet.json>');
  }
  const packetPath = resolve(packetValue);
  const stat = lstatSync(packetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw new Error('packet must be a regular JSON file no larger than 2 MiB');
  }
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
  const result = executeGuardedCodeCandidate(packet);
  if (result.status !== 'OK') throw new Error(`${result.code}: ${result.message}`);
  process.stdout.write(`${JSON.stringify({
    status: 'OK',
    runId: result.receipt.runId,
    receiptPath: `${result.statePath}/receipt.json`,
    receiptSha256: result.receipt.receiptSha256,
    patchSha256: result.receipt.patchSha256,
    patchBytes: result.receipt.patchBytes,
    requiredTests: result.receipt.tests.length,
    networkAllowed: false,
    activationAuthority: false,
    promotionAuthority: false
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
