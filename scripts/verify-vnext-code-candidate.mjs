#!/usr/bin/env node
import { resolve } from 'node:path';
import { verifyGuardedCodeWorktreeRun } from '../src/vnext-code-worktree.mjs';

const index = process.argv.indexOf('--receipt');
const value = index >= 0 ? process.argv[index + 1] : null;
if (!value || process.argv.length !== 4) {
  process.stderr.write('usage: verify-vnext-code-candidate --receipt <receipt.json>\n');
  process.exitCode = 1;
} else {
  const result = verifyGuardedCodeWorktreeRun({ receiptPath: resolve(value) });
  const summary = result.status === 'OK'
    ? {
        status: 'OK',
        runId: result.receipt.runId,
        receiptSha256: result.receipt.receiptSha256,
        evidenceSha256: result.evidenceSha256,
        patchSha256: result.receipt.patchSha256,
        patchBytes: result.receipt.patchBytes,
        requiredTests: result.receipt.tests.length,
        networkAllowed: false,
        activationAuthority: false,
        promotionAuthority: false
      }
    : result;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.status !== 'OK') process.exitCode = 1;
}
