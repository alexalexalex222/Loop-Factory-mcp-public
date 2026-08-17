#!/usr/bin/env node

import { resolve } from 'node:path';
import {
  verifyVNextCustodianPackage
} from '../src/vnext-custodian-package.mjs';

const index = process.argv.indexOf('--package-root');
const root = index >= 0 ? process.argv[index + 1] : null;
if (!root) {
  process.stderr.write('usage: npm run verify:vnext:custodian -- --package-root <directory>\n');
  process.exit(2);
}

const result = verifyVNextCustodianPackage({ packageRoot: resolve(root) });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
