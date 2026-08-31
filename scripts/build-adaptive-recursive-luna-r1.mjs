#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMechanismFamilyRecord } from '../src/adaptive-records.mjs';
import { createAdaptiveMeasurementRecord } from '../src/adaptive-measurement-v2.mjs';
import {
  advanceMechanismEvolutionToShadow,
  proposeMechanismEvolution
} from '../src/mechanism-evolution.mjs';
import {
  canonicalMechanismProgramJson,
  compileMechanismProgram,
  normalizeMechanismProgram
} from '../src/mechanism-compiler.mjs';
import { createMechanismMutationPlan } from '../src/mechanism-mutation.mjs';
import { canonicalJson } from '../src/real-test.mjs';
import { sha256 } from '../src/util.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const r5StatePath = join(
  root,
  'proof/adaptive-executable-canary-v3/full-repair-replication-20260724/state-r5/runs/ordered-frontier-v3-r5-20260724/state.json'
);
const r7ConfigPath = join(
  root,
  'proof/adaptive-executable-canary-v4/cross-domain-3way-20260725/executable-canary-r7.json'
);
const r6ConfigPath = join(
  root,
  'proof/adaptive-executable-canary-v4/compiled-mechanism-fresh-20260725-r6b/executable-canary-r6b.json'
);
const outputDir = join(root, 'proof/recursive-mechanism-v1/luna-max-r1');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readArtifact(statePath, state, artifactId) {
  return readJson(join(dirname(statePath), 'artifacts', `${artifactId}.json`));
}

function sealedConfig(statePath, state) {
  const artifact = readArtifact(statePath, state, state.evidenceArtifacts.config.id);
  if (artifact.sha256 !== sha256(artifact.content)) {
    throw new Error('historical R5 config artifact hash mismatch');
  }
  return JSON.parse(artifact.content);
}

function sourceMeasurementFromR5(statePath, state, config) {
  const calls = state.calls.filter((call) => call.stage === 'confirmation');
  const tasks = config.tasks.filter((task) => task.phase === 'confirmation');
  const measurementTasks = tasks.map((task) => ({
    taskId: task.id,
    arms: Object.fromEntries(['baseline', 'routed', 'sham'].map((arm) => {
      const call = calls.find((item) => item.taskId === task.id && item.armRole === arm);
      if (!call) throw new Error(`R5 is missing ${task.id} ${arm}`);
      const evaluationArtifact = readArtifact(statePath, state, call.evaluationArtifactRef);
      if (evaluationArtifact.sha256 !== call.evaluationSha256
          || evaluationArtifact.sha256 !== sha256(evaluationArtifact.content)) {
        throw new Error(`R5 evaluation hash mismatch for ${task.id} ${arm}`);
      }
      const evaluation = JSON.parse(evaluationArtifact.content);
      return [arm, {
        evaluationArtifactRef: `${task.id}-${arm}`,
        evaluationArtifactSha256: evaluationArtifact.sha256,
        tokenCost: call.cliReportedTotalTokens,
        results: evaluation.results.map((item) => ({
          id: item.id,
          group: item.group,
          pass: item.pass,
          decisionPass: item.decisionPass,
          codePass: item.codePass
        }))
      }];
    }))
  }));
  const family = config.mechanismContext.families[0];
  const built = createAdaptiveMeasurementRecord({
    source: {
      kind: 'historical-r5-replay',
      runId: state.runId,
      verifierEvidenceSha256: state.verification.evidenceSha256,
      evaluatorAuthoritySha256: config.evaluatorAuthority.authoritySha256,
      caseSetSha256: sha256(canonicalJson(tasks.map((task) => ({
        taskId: task.id,
        oracleSha256: config.oracleManifest.find((item) => item.path === task.oraclePath).sha256
      })).sort((left, right) => left.taskId.localeCompare(right.taskId))))
    },
    profile: 'retrieval-causal-v1',
    armRoles: {
      baseline: 'baseline',
      parent: null,
      treatment: 'routed',
      sham: 'sham'
    },
    mechanismBindings: {
      baseline: null,
      parent: null,
      treatment: family.familySha256,
      sham: sha256(canonicalJson(config.mechanismShamContext || config.mechanismContext))
    },
    tasks: measurementTasks
  });
  if (built.status !== 'OK') throw new Error(`${built.code}: ${built.message}`);
  return built.record;
}

function boundTask(task, parentProgram) {
  const source = readFileSync(join(root, task.sourcePath), 'utf8');
  const incident = readFileSync(join(root, task.specPath), 'utf8');
  const interfaceContent = readFileSync(join(root, task.interfacePath), 'utf8');
  const oracle = readFileSync(join(root, task.oraclePath), 'utf8');
  const interfaceContract = JSON.parse(interfaceContent);
  const compiled = compileMechanismProgram({
    program: parentProgram,
    interfaceContract
  });
  if (compiled.status !== 'OK') throw new Error(`${task.id}: ${compiled.code} ${compiled.message}`);
  return {
    id: task.id,
    source: { path: task.sourcePath, sha256: sha256(source) },
    incident: { path: task.specPath, sha256: sha256(incident) },
    interface: {
      path: task.interfacePath,
      sha256: compiled.compilation.interfaceSha256
    },
    oracle: { path: task.oraclePath, sha256: sha256(oracle) },
    interfaceContract
  };
}

const r5State = readJson(r5StatePath);
const r5Config = sealedConfig(r5StatePath, r5State);
const sourceMeasurement = sourceMeasurementFromR5(r5StatePath, r5State, r5Config);
const r6 = readJson(r6ConfigPath);
const r7 = readJson(r7ConfigPath);
const provenFamily = r6.mechanismContext.families[0];
const candidateProgram = provenFamily.causalFingerprint.program;
const restoredRule = candidateProgram.rules.find((rule) => (
  rule.ruleId === 'quality-first-exception'
));
if (!restoredRule) throw new Error('quality-first-exception is missing from the proven mechanism');
const parentProgram = {
  ...candidateProgram,
  rules: candidateProgram.rules.filter((rule) => rule.ruleId !== restoredRule.ruleId)
};
const parentBuilt = createMechanismFamilyRecord({
  causalFingerprint: {
    ...provenFamily.causalFingerprint,
    program: parentProgram
  }
});
if (parentBuilt.status !== 'OK') throw new Error(`${parentBuilt.code}: ${parentBuilt.message}`);
const normalizedParent = normalizeMechanismProgram(parentProgram);
if (normalizedParent.status !== 'OK') throw new Error(normalizedParent.message);
const failureCases = r5State.calls
  .filter((call) => call.stage === 'confirmation' && call.armRole === 'routed')
  .map((call) => ({ taskId: call.taskId, evaluationSha256: call.evaluationSha256 }))
  .sort((left, right) => left.taskId.localeCompare(right.taskId));
const r6StatePath = join(
  root,
  'proof/adaptive-executable-canary-v4/compiled-mechanism-fresh-20260725-r6b/state-r6b/runs/compiled-mechanism-v4-r6b-20260725/state.json'
);
const r6State = readJson(r6StatePath);
const successCases = r6State.calls
  .filter((call) => call.stage === 'confirmation' && call.armRole === 'routed')
  .map((call) => ({ taskId: call.taskId, evaluationSha256: call.evaluationSha256 }))
  .sort((left, right) => left.taskId.localeCompare(right.taskId));
const mutation = createMechanismMutationPlan({
  parent: {
    familyId: parentBuilt.record.familyId,
    familySha256: parentBuilt.record.familySha256,
    programSha256: normalizedParent.programSha256
  },
  objective: {
    measurementId: sourceMeasurement.measurementId,
    measurementSha256: sourceMeasurement.measurementSha256,
    failureCaseSetSha256: sha256(canonicalJson(failureCases)),
    successCaseSetSha256: sha256(canonicalJson(successCases)),
    targetMetric: 'exact-case-rate',
    direction: 'increase'
  },
  operations: [{
    action: 'add',
    collection: 'rules',
    expectedItemSha256: null,
    insertBeforeRuleId: 'accept-quality-frontier',
    value: restoredRule
  }],
  reasonCodes: [
    'R5_NO_CAUSAL_LIFT',
    'R5_ROUTED_CONTROL_FAILURES',
    'RESTORE_ORDERED_QUALITY_FIRST_EXCEPTION'
  ],
  expectedEffectCode: 'MORE_EXACT_DISJOINT_REPAIRS'
});
if (mutation.status !== 'OK') throw new Error(`${mutation.code}: ${mutation.message}`);
const proposed = proposeMechanismEvolution({
  parentFamily: parentBuilt.record,
  mutationPlan: mutation.plan,
  recordedAt: '2026-08-03T23:00:00.000Z'
});
if (proposed.status !== 'OK') throw new Error(`${proposed.code}: ${proposed.message}`);
if (proposed.candidateFamily.familySha256 !== provenFamily.familySha256) {
  throw new Error('restored candidate does not reproduce the proven compiled family');
}
const targetTasks = r7.tasks.filter((task) => task.phase === 'confirmation');
if (targetTasks.length !== 5) throw new Error('R7 must provide exactly five confirmation tasks');
const tasks = targetTasks.map((task) => boundTask(task, parentProgram));
const shadow = advanceMechanismEvolutionToShadow({
  currentRecord: proposed.record,
  parentFamily: parentBuilt.record,
  candidateFamily: proposed.candidateFamily,
  interfaceContracts: tasks.map((task) => task.interfaceContract),
  recordedAt: '2026-08-03T23:01:00.000Z'
});
if (shadow.status !== 'OK') throw new Error(`${shadow.code}: ${shadow.message}`);
const config = {
  schemaVersion: 'adaptive-recursive-canary-v1',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'max',
  authMode: 'chatgpt-oauth',
  retries: 0,
  promotionEnabled: false,
  historicalTokenEstimate: 650000,
  parentFamily: parentBuilt.record,
  candidateFamily: proposed.candidateFamily,
  evolutionRecord: shadow.record,
  tasks
};
const preregistration = {
  schemaVersion: 'recursive-luna-r1-preregistration-v1',
  hypothesis:
    'Restoring the exact ordered quality-first exception improves disjoint exact repairs over the one-rule-ablated parent without moving the sham or regressing controls.',
  sourceEvidence: {
    r5StatePath: 'proof/adaptive-executable-canary-v3/full-repair-replication-20260724/state-r5/runs/ordered-frontier-v3-r5-20260724/state.json',
    r5VerifierEvidenceSha256: r5State.verification.evidenceSha256,
    sourceMeasurementId: sourceMeasurement.measurementId,
    sourceMeasurementSha256: sourceMeasurement.measurementSha256,
    failureCaseSetSha256: mutation.plan.objective.failureCaseSetSha256,
    r6StatePath: 'proof/adaptive-executable-canary-v4/compiled-mechanism-fresh-20260725-r6b/state-r6b/runs/compiled-mechanism-v4-r6b-20260725/state.json',
    r6VerifierEvidenceSha256: r6State.verification.evidenceSha256,
    successCaseSetSha256: mutation.plan.objective.successCaseSetSha256
  },
  treatment: {
    parentFamilyId: parentBuilt.record.familyId,
    parentProgramSha256: shadow.record.parent.programSha256,
    candidateFamilyId: proposed.candidateFamily.familyId,
    candidateProgramSha256: shadow.record.candidate.programSha256,
    mutationPlanId: mutation.plan.mutationPlanId,
    mutationPlanSha256: mutation.plan.mutationPlanSha256,
    treatmentDeltaSha256: shadow.record.evidence.treatmentDeltaSha256,
    operation: 'restore quality-first-exception before accept-quality-frontier'
  },
  heldOutTaskIds: tasks.map((task) => task.id),
  stoppingRule: 'one 20-call run, zero retries; valid FAIL is retained',
  promotionEnabled: false
};
mkdirSync(outputDir, { recursive: true });
const outputs = [
  ['source-measurement-v2.json', sourceMeasurement],
  ['recursive-canary-luna-max-r1.json', config],
  ['PREREGISTRATION.json', preregistration]
];
for (const [name, value] of outputs) {
  writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify({
  status: 'OK',
  outputDir,
  files: outputs.map(([name]) => ({
    path: join(outputDir, name),
    sha256: sha256(readFileSync(join(outputDir, name)))
  })),
  parentFamilyId: config.parentFamily.familyId,
  candidateFamilyId: config.candidateFamily.familyId,
  heldOutTaskIds: preregistration.heldOutTaskIds
}, null, 2)}\n`);

