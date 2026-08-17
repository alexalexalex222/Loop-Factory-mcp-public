#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fetchExternalResearchPlan,
  validateExternalResearchPlan
} from '../src/vnext-external-research-worker.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

try {
  const planPath = flag('--plan');
  const stateRoot = flag('--state-root');
  if (!planPath || !stateRoot) throw new Error('usage: run-vnext-external-research --plan <plan.json> --state-root <absolute-dir>');
  const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
  const valid = validateExternalResearchPlan(plan);
  if (valid.status !== 'OK') throw new Error(valid.code);
  const result = await fetchExternalResearchPlan({
    plan: valid.plan,
    stateRoot: resolve(stateRoot)
  });
  if (result.status !== 'OK') {
    throw new Error([
      result.code,
      result.sourceId ?? null,
      Array.isArray(result.diagnostics) ? result.diagnostics.join(',') : null,
      result.message
    ].filter(Boolean).join(': '));
  }
  process.stdout.write(`${JSON.stringify({
    status: 'OK',
    runDir: result.runDir,
    sourceCount: result.receipt.sourceCount,
    totalRawBytes: result.receipt.totalRawBytes,
    receiptSha256: result.receipt.receiptSha256,
    activationAuthority: false
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
