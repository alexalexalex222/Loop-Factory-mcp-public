#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyVNextAblationProtocolFromDisk } from '../src/vnext-ablation-protocol.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--protocol') {
  process.stderr.write('usage: npm run verify:vnext:ablation -- --protocol <protocol.json>\n');
  process.exit(2);
}
let protocol;
try {
  protocol = JSON.parse(readFileSync(resolve(argv[1]), 'utf8'));
} catch {
  process.stderr.write('protocol is missing or malformed\n');
  process.exit(2);
}
const result = verifyVNextAblationProtocolFromDisk({
  protocol,
  packageRoot: PACKAGE_ROOT
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
