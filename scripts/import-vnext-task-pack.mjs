#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  importVNextTaskPackFromExecutableCanary
} from '../src/vnext-task-pack-import.mjs';
import {
  validateVNextTaskPack,
  vnextTaskPackIdentities
} from '../src/vnext-task-pack.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

function parse(argv) {
  const values = { 'prior-pack': [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (![
      '--source-root', '--config', '--out', '--pack-id', '--partition',
      '--created-at', '--builder-id', '--prior-pack'
    ].includes(key) || typeof value !== 'string') return null;
    const name = key.slice(2);
    if (name === 'prior-pack') values[name].push(value);
    else if (Object.hasOwn(values, name)) return null;
    else values[name] = value;
  }
  for (const key of [
    'source-root', 'config', 'out', 'pack-id', 'partition', 'created-at',
    'builder-id'
  ]) {
    if (!values[key]) return null;
  }
  return values;
}

function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:task-pack:import -- --source-root <repo> --config <legacy-canary.json> --out <dir> --pack-id <id> --partition <development|validation> --created-at <iso> --builder-id <id> [--prior-pack <pack.json>]...\n');
  process.exit(2);
}

const sourceRoot = realpathSync(resolve(args['source-root']));
const configPath = realpathSync(resolve(args.config));
if (!lstatSync(configPath).isFile()) {
  process.stderr.write('TASK_PACK_IMPORT_CONFIG_INVALID: config must be a regular file\n');
  process.exit(3);
}
const sourceConfigBytes = readFileSync(configPath, 'utf8');
let priorIdentities = [];
for (const path of args['prior-pack']) {
  const prior = JSON.parse(readFileSync(realpathSync(resolve(path)), 'utf8'));
  if (validateVNextTaskPack(prior).status !== 'OK') {
    process.stderr.write('TASK_PACK_IMPORT_PRIOR_INVALID: prior pack failed replay\n');
    process.exit(3);
  }
  priorIdentities.push(...vnextTaskPackIdentities(prior));
}
priorIdentities = [...new Set(priorIdentities)].sort();
const imported = importVNextTaskPackFromExecutableCanary({
  artifactRoot: sourceRoot,
  sourceConfigBytes,
  packId: args['pack-id'],
  partition: args.partition,
  createdAt: args['created-at'],
  builderId: args['builder-id'],
  priorIdentities
});
if (imported.status !== 'OK') {
  process.stderr.write(`${imported.code}: ${imported.message || 'task-pack import refused'}\n`);
  process.exit(4);
}
const out = resolve(args.out);
if (existsSync(out)) {
  const entries = ['source-config.json', 'task-pack.json', 'materials.json', 'import-receipt.json'];
  if (entries.some((name) => existsSync(resolve(out, name)))) {
    process.stderr.write('TASK_PACK_IMPORT_OUTPUT_EXISTS: immutable output files already exist\n');
    process.exit(4);
  }
} else {
  mkdirSync(out, { recursive: true, mode: 0o700 });
}
if (realpathSync(out) !== out || realpathSync(dirname(out)) !== dirname(out)) {
  process.stderr.write('TASK_PACK_IMPORT_OUTPUT_UNSAFE: output directory must be real and non-symlinked\n');
  process.exit(4);
}
atomicWrite(resolve(out, 'source-config.json'), sourceConfigBytes);
atomicWrite(resolve(out, 'task-pack.json'), `${canonicalVNextJson(imported.pack)}\n`);
atomicWrite(resolve(out, 'materials.json'), `${canonicalVNextJson(imported.bundle)}\n`);
atomicWrite(resolve(out, 'import-receipt.json'), `${canonicalVNextJson(imported.receipt)}\n`);
process.stdout.write(`${JSON.stringify({
  status: 'OK',
  out,
  packId: imported.pack.packId,
  partition: imported.pack.partition,
  taskCount: imported.pack.tasks.length,
  packSha256: imported.pack.packSha256,
  materialBundleSha256: imported.bundle.bundleSha256,
  receiptSha256: imported.receipt.receiptSha256,
  referenceContentImported: false,
  workerLaunched: false,
  paidModelCalls: 0
}, null, 2)}\n`);
