#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  verifyExternalResearchFetchRun
} from '../src/vnext-external-research-worker.mjs';

const index = process.argv.indexOf('--run-dir');
const value = index >= 0 ? process.argv[index + 1] : null;
if (!value) {
  process.stderr.write('usage: verify-vnext-external-research --run-dir <absolute-dir>\n');
  process.exitCode = 1;
} else {
  const result = verifyExternalResearchFetchRun({ runDir: resolve(value) });
  const summary = result.status === 'OK'
    ? {
        status: 'OK',
        planId: result.receipt.planId,
        planSha256: result.receipt.planSha256,
        receiptSha256: result.receipt.receiptSha256,
        evidenceSha256: result.evidenceSha256,
        sourceCount: result.receipt.sourceCount,
        totalRawBytes: result.receipt.totalRawBytes,
        networkPerformed: result.receipt.networkPerformed,
        activationAuthority: false,
        promotionAuthority: false
      }
    : result;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.status !== 'OK') process.exitCode = 1;
}
