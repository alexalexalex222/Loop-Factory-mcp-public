#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVNextAblationProtocolR6,
  createVNextSemanticJudgeQualificationBinding,
  loadVNextAblationPackDescriptor,
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = {};
  const allowed = new Set([
    '--out', '--id', '--created-at', '--parent-config',
    '--qualification-disclosure', '--consumed-evaluator',
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
  process.stderr.write('usage: node scripts/build-vnext-ablation-protocol-r6.mjs --out <protocol.json> --id <protocol-id> --created-at <ISO> --parent-config <json> --qualification-disclosure <json> --consumed-evaluator <json> --generation-pack <dir> --retrieval-pack <dir> --generator-pack <dir> --validation-pack <dir> --transfer-pack <dir>\n');
  process.exit(2);
}
let parentConfig;
let disclosure;
let qualification;
let formPlans;
let consumedEvaluatorProofs;
try {
  parentConfig = JSON.parse(readFileSync(resolve(args['parent-config']), 'utf8'));
  disclosure = JSON.parse(readFileSync(
    resolve(args['qualification-disclosure']),
    'utf8'
  ));
  qualification = JSON.parse(readFileSync(disclosure.qualificationPath, 'utf8'));
  formPlans = disclosure.forms.map(({ planPath }) => (
    JSON.parse(readFileSync(planPath, 'utf8'))
  ));
  consumedEvaluatorProofs = JSON.parse(readFileSync(
    resolve(args['consumed-evaluator']),
    'utf8'
  ));
} catch (error) {
  fail({
    status: 'REFUSED',
    code: 'VNEXT_ABLATION_PROTOCOL_R6_JSON_INVALID',
    message: error.message
  }, 2);
}
const binding = createVNextSemanticJudgeQualificationBinding({
  qualification,
  formPlans,
  packageRoot: PACKAGE_ROOT
});
if (binding.status !== 'OK') fail(binding);
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
const built = createVNextAblationProtocolR6({
  packageRoot: PACKAGE_ROOT,
  protocolId: args.id,
  createdAt: args['created-at'],
  parentFamily: parentConfig.parentFamily,
  modelPolicy: {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    authMode: 'chatgpt-oauth'
  },
  semanticJudgeQualification: binding.binding,
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
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx'
});
renameSync(temporary, output);
process.stdout.write(`${JSON.stringify({
  status: 'OK',
  path: output,
  protocolSha256: built.protocol.protocolSha256,
  implementationSha256: built.protocol.implementationSha256,
  semanticJudgeQualificationSha256:
    built.protocol.semanticJudgeQualification.qualification.qualificationSha256,
  semanticJudgeFormPlanSha256s:
    built.protocol.semanticJudgeQualification.forms.map(({ planSha256 }) => (
      planSha256
    )),
  deterministicInternalMaximumCalls:
    built.protocol.exposure.internalMaximumCalls,
  securityQualificationMaximumCalls:
    built.protocol.exposure.semanticJudgeSecurityQualificationMaximumCalls,
  externalCustodianMaximumCalls:
    built.protocol.exposure.externalCustodianMaximumCalls,
  evidenceSha256: verified.evidenceSha256,
  workerLaunched: false,
  paidModelCalls: 0,
  outputDirectory: dirname(output)
}, null, 2)}\n`);
