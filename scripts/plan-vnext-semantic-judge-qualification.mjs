#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { resolveWorkerBinary } from '../src/executor.mjs';
import {
  buildEvaluatorSecurityQualification,
  validateEvaluatorCounterbalanceSeedCommitment,
  validateEvaluatorSecurityAnswerKey,
  validateEvaluatorSecurityQualification
} from '../src/isolated-evaluator.mjs';
import {
  createVNextEvaluatorProofPlan,
  persistVNextEvaluatorProofPlan
} from '../src/vnext-evaluator-proof.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = { model: 'gpt-5.6-sol', reasoning: 'high' };
  const allowed = new Set([
    '--out', '--proof-home', '--id', '--input', '--seed-commitment',
    '--seed-file', '--model', '--reasoning', '--codex-bin', '--created-at'
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || typeof argv[index + 1] !== 'string') return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out.out && out['proof-home'] && out.id && out.input
    && out['seed-commitment'] && out['seed-file'] && out['created-at']
    ? out
    : null;
}

function fail(result, code = 1) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

function immutableWrite(path, value, mode = 0o600) {
  const bytes = `${canonicalVNextJson(value)}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes, { encoding: 'utf8', mode, flag: 'wx' });
  renameSync(temporary, path);
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: node scripts/plan-vnext-semantic-judge-qualification.mjs --out <directory> --proof-home <directory> --id <qualification-id> --input <qualification-input.json> --seed-commitment <commitment.json> --seed-file <private-seeds.json> --created-at <ISO> [--model gpt-5.6-sol] [--reasoning high] [--codex-bin <absolute>]\n');
  process.exit(2);
}
let input;
let seedCommitment;
let seeds;
try {
  input = JSON.parse(readFileSync(resolve(args.input), 'utf8'));
  seedCommitment = JSON.parse(readFileSync(resolve(args['seed-commitment']), 'utf8'));
  seeds = JSON.parse(readFileSync(resolve(args['seed-file']), 'utf8'));
} catch (error) {
  fail({
    status: 'REFUSED',
    code: 'VNEXT_SEMANTIC_JUDGE_INPUT_JSON_INVALID',
    message: error.message
  }, 2);
}
if (validateEvaluatorCounterbalanceSeedCommitment(seedCommitment).status !== 'OK'
    || seedCommitment.qualificationId !== args.id
    || !Number.isFinite(Date.parse(input.artifactsSelectedAt))
    || Date.parse(seedCommitment.committedAt) > Date.parse(input.artifactsSelectedAt)
    || statSync(resolve(args['seed-commitment'])).mtimeMs
      > statSync(resolve(args.input)).mtimeMs) {
  fail({
    status: 'REFUSED',
    code: 'VNEXT_SEMANTIC_JUDGE_SEED_ORDER_INVALID',
    message: 'The durable seed commitment must predate artifact selection.'
  });
}
const qualification = buildEvaluatorSecurityQualification({
  seedCommitment,
  seeds,
  supportedArtifact: input.supportedArtifact,
  contradictedArtifact: input.contradictedArtifact,
  objectiveVerifierFacts: input.objectiveVerifierFacts,
  taskLocalEvidence: input.taskLocalEvidence,
  criteria: input.criteria,
  scale: input.scale
});
if (qualification.status !== 'OK') fail(qualification);
const binary = args['codex-bin']
  ? { binPath: resolve(args['codex-bin']) }
  : resolveWorkerBinary(args.model, process.env);
const authority = captureCodexOAuthAuthority({
  binaryPath: binary.binPath,
  requestedModel: args.model,
  reasoningEffort: args.reasoning
});
if (authority.status !== 'OK') fail(authority);
const proofHome = resolve(args['proof-home']);
const plans = qualification.qualification.forms.map((form, index) => {
  const built = createVNextEvaluatorProofPlan({
    packageRoot: PACKAGE_ROOT,
    proofHome,
    proofId: `${args.id}-${form.formId}`,
    createdAt: args['created-at'],
    runtimeAuthority: authority.record,
    taskId: `${args.id}-${form.formId}`,
    anonymousArmId: `anonymous-${form.formId}`,
    prompt: 'Measure both visible items using only the supplied public evidence and every opaque rubric criterion. Return measurement JSON only.',
    timeoutMs: 600000,
    requestInput: {
      taskSpecification: form.request.taskSpecification,
      publicRubric: form.request.publicRubric,
      anonymousCandidateArtifact: input.supportedArtifact,
      objectiveVerifierFacts: input.objectiveVerifierFacts,
      taskLocalEvidence: input.taskLocalEvidence,
      pairwise: {
        secondAnonymousArtifact: input.contradictedArtifact,
        seed: seeds[index]
      }
    }
  });
  if (built.status !== 'OK') fail(built);
  const persisted = persistVNextEvaluatorProofPlan(built);
  if (persisted.status !== 'OK') fail(persisted);
  return built.plan;
});
if (validateEvaluatorSecurityQualification(qualification.qualification).status !== 'OK'
    || validateEvaluatorSecurityAnswerKey(qualification.answerKey).status !== 'OK') {
  fail({
    status: 'REFUSED',
    code: 'VNEXT_SEMANTIC_JUDGE_QUALIFICATION_REPLAY_FAILED'
  });
}
const output = resolve(args.out);
mkdirSync(output, { recursive: true, mode: 0o700 });
const qualificationPath = join(output, 'qualification.json');
const answerKeyPath = join(output, 'custodian-answer-key.json');
const disclosurePath = join(output, 'disclosure.json');
const disclosure = {
  schemaVersion: 'loop-factory-vnext-semantic-judge-disclosure-v1',
  qualificationId: args.id,
  createdAt: args['created-at'],
  status: 'PLANNED_UNLAUNCHED',
  role: 'semantic-judge-security-qualification',
  qualificationPath,
  qualificationSha256: qualification.qualification.qualificationSha256,
  answerKeyPath,
  answerKeySha256: qualification.answerKey.answerKeySha256,
  seedCommitmentSha256: seedCommitment.commitmentSha256,
  forms: plans.map((plan, index) => ({
    formId: `form-${index + 1}`,
    proofHome: plan.proofHome,
    proofId: plan.proofId,
    planPath: join(plan.proofHome, plan.proofId, 'plan.json'),
    planSha256: plan.planSha256,
    requestSha256: plan.request.requestSha256,
    implementationSha256: plan.implementationSha256
  })),
  exposure: {
    maximumCalls: 2,
    retriesPerCall: 0,
    paidCallsAtPlanning: 0,
    causalScoringAuthority: false,
    requiredForDeterministicPhases: false
  }
};
immutableWrite(qualificationPath, qualification.qualification);
immutableWrite(answerKeyPath, qualification.answerKey);
immutableWrite(disclosurePath, disclosure);
process.stdout.write(`${JSON.stringify({
  status: 'OK',
  disclosurePath,
  qualificationSha256: qualification.qualification.qualificationSha256,
  answerKeySha256: qualification.answerKey.answerKeySha256,
  formPlanSha256s: plans.map(({ planSha256 }) => planSha256),
  workerLaunched: false,
  paidModelCalls: 0
}, null, 2)}\n`);
