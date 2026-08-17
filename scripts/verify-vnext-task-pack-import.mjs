#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  verifyVNextTaskPackImport
} from '../src/vnext-task-pack-import.mjs';

function directory(argv) {
  return argv.length === 2 && argv[0] === '--dir' ? argv[1] : null;
}

const value = directory(process.argv.slice(2));
if (!value) {
  process.stderr.write('usage: npm run verify:vnext:task-pack -- --dir <import-dir>\n');
  process.exit(2);
}
const root = realpathSync(resolve(value));
const sourceConfigBytes = readFileSync(resolve(root, 'source-config.json'), 'utf8');
const pack = JSON.parse(readFileSync(resolve(root, 'task-pack.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(resolve(root, 'materials.json'), 'utf8'));
const receipt = JSON.parse(readFileSync(resolve(root, 'import-receipt.json'), 'utf8'));
const result = verifyVNextTaskPackImport({
  sourceConfigBytes,
  pack,
  bundle,
  receipt
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  code: result.code || null,
  packId: result.pack?.packId || null,
  partition: result.pack?.partition || null,
  taskCount: result.pack?.tasks?.length || 0,
  packSha256: result.pack?.packSha256 || null,
  materialBundleSha256: result.bundle?.bundleSha256 || null,
  receiptSha256: result.receipt?.receiptSha256 || null,
  referenceContentImported: result.receipt?.referenceContentImported ?? null,
  activationAuthority: result.receipt?.activationAuthority ?? null
}, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
