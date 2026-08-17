#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.mjs';
import {
  buildVNextCustodianPackage
} from '../src/vnext-custodian-package.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = {};
  const flags = new Set([
    '--output', '--package-id', '--generated-at', '--protocol',
    '--source-home', '--source-run', '--transfer-home', '--transfer-study'
  ]);
  if (argv.length % 2 !== 0) return null;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!flags.has(key) || typeof value !== 'string') return null;
    const name = key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[name] = value;
  }
  return Object.values(out).length === flags.size ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write([
    'usage: npm run vnext:custodian:build --',
    '--output <new-package-directory> --package-id <id> --generated-at <ISO>',
    '--protocol <protocol.json> --source-home <validation-proof-home>',
    '--source-run <B6-run-id> --transfer-home <transfer-proof-home>',
    '--transfer-study <transfer-study-id>'
  ].join(' ') + '\n');
  process.exit(2);
}

let protocol;
try {
  protocol = JSON.parse(readFileSync(resolve(args.protocol), 'utf8'));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED',
    code: 'CUSTODIAN_PROTOCOL_JSON_INVALID',
    message: error.message
  }, null, 2)}\n`);
  process.exit(2);
}

const sourceHome = resolve(args.sourceHome);
const result = buildVNextCustodianPackage({
  packageRoot: PACKAGE_ROOT,
  outputRoot: resolve(args.output),
  packageId: args.packageId,
  generatedAt: args.generatedAt,
  protocol,
  sourceStore: createStore(sourceHome),
  sourceRunId: args.sourceRun,
  transferProofHome: resolve(args.transferHome),
  transferStudyId: args.transferStudy
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
