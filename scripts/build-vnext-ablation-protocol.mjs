#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVNextAblationEvaluatorProofBinding,
  createVNextAblationProtocol,
  loadVNextAblationPackDescriptor,
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import {
  verifyVNextEvaluatorProofFromDisk
} from '../src/vnext-evaluator-proof.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = {};
  const allowed = new Set([
    '--out', '--id', '--created-at', '--parent-config', '--evaluator-home',
    '--evaluator-id', '--consumed-evaluator',
    '--generation-pack', '--retrieval-pack', '--generator-pack',
    '--validation-pack', '--transfer-pack'
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || typeof argv[index + 1] !== 'string') return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return [...allowed].every((key) => out[key.slice(2)]) ? out : null;
}

function fail(result, code = 1) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:ablation:protocol -- --out <protocol.json> --id <protocol-id> --created-at <ISO> --parent-config <json> --evaluator-home <dir> --evaluator-id <proof-id> --consumed-evaluator <json> --generation-pack <dir> --retrieval-pack <dir> --generator-pack <dir> --validation-pack <dir> --transfer-pack <dir>\n');
  process.exit(2);
}
let parentConfig;
let consumedEvaluatorProofs;
try {
  parentConfig = JSON.parse(readFileSync(resolve(args['parent-config']), 'utf8'));
  consumedEvaluatorProofs = JSON.parse(readFileSync(
    resolve(args['consumed-evaluator']),
    'utf8'
  ));
} catch (error) {
  fail({ status: 'REFUSED', code: 'VNEXT_ABLATION_PROTOCOL_JSON_INVALID', message: error.message }, 2);
}
const packs = [
  ['generation', args['generation-pack']],
  ['retrieval', args['retrieval-pack']],
  ['generator', args['generator-pack']],
  ['validation', args['validation-pack']],
  ['transfer', args['transfer-pack']]
].map(([role, directory]) => loadVNextAblationPackDescriptor({
  role,
  directory: resolve(directory)
}));
const evaluatorVerification = verifyVNextEvaluatorProofFromDisk({
  proofHome: resolve(args['evaluator-home']),
  proofId: args['evaluator-id']
});
const evaluatorProof = createVNextAblationEvaluatorProofBinding(
  evaluatorVerification
);
if (evaluatorProof.status !== 'OK') fail(evaluatorProof);
const built = createVNextAblationProtocol({
  packageRoot: PACKAGE_ROOT,
  protocolId: args.id,
  createdAt: args['created-at'],
  parentFamily: parentConfig.parentFamily,
  modelPolicy: {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    authMode: 'chatgpt-oauth'
  },
  evaluatorProof: evaluatorProof.binding,
  consumedEvaluatorProofs,
  packs
});
if (built.status !== 'OK') fail(built);
const verified = verifyVNextAblationProtocolFromDisk({
  protocol: built.protocol,
  packageRoot: PACKAGE_ROOT
});
if (verified.status !== 'OK') fail(verified);
const output = resolve(args.out);
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${canonicalVNextJson(built.protocol)}\n`, {
  encoding: 'utf8', mode: 0o600, flag: 'wx'
});
renameSync(temporary, output);
process.stdout.write(`${JSON.stringify({
  status: 'OK',
  path: output,
  protocolSha256: built.protocol.protocolSha256,
  implementationSha256: built.protocol.implementationSha256,
  evaluatorProofResultSha256: built.protocol.evaluatorProof.resultSha256,
  evaluatorProofImplementationSha256:
    built.protocol.evaluatorProof.implementationSha256,
  evaluatorCalls: built.protocol.exposure.liveEvaluatorCalls,
  internalMaximumCalls: built.protocol.exposure.internalMaximumCalls,
  externalCustodianMaximumCalls:
    built.protocol.exposure.externalCustodianMaximumCalls,
  taskPackSha256s: built.protocol.packs.map(({ packSha256 }) => packSha256),
  evidenceSha256: verified.evidenceSha256,
  workerLaunched: false,
  paidModelCalls: 0,
  outputDirectory: dirname(output)
}, null, 2)}\n`);
