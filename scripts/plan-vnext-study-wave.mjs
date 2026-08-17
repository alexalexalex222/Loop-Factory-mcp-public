#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureExecutableEvaluatorAuthority } from '../src/adaptive-executable-canary.mjs';
import { captureCodexOAuthAuthority } from '../src/codex-oauth-authority.mjs';
import { resolveWorkerBinary } from '../src/executor.mjs';
import { createStore } from '../src/store.mjs';
import { createVNextEvidenceAuthorityVerifier } from '../src/vnext-evidence-authority.mjs';
import { readVNextEvidenceBank } from '../src/vnext-evidence-bank.mjs';
import {
  deriveVNextStrategyStateBundle,
  validateVNextStrategyStateBundle
} from '../src/vnext-strategy-state.mjs';
import {
  verifyVNextAblationProtocolFromDisk,
  vnextAblationProtocolPhase
} from '../src/vnext-ablation-protocol.mjs';
import {
  createVNextStudyWave,
  persistVNextStudyWave
} from '../src/vnext-study-plan.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = {
    arm: 'B3',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
    memoryMode: 'none',
    historicalTokenEstimate: 4_000_000
  };
  const flags = new Set([
    '--home', '--run', '--wave', '--arm', '--task-pack', '--materials',
    '--parent-config', '--model', '--reasoning', '--codex-bin',
    '--memory-mode', '--strategy-state', '--selected-generator-arm',
    '--created-at', '--historical-token-estimate', '--protocol', '--phase'
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!flags.has(key) || typeof value !== 'string') return null;
    const name = key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    out[name] = value;
  }
  out.historicalTokenEstimate = Number(out.historicalTokenEstimate);
  return out.home && out.run && out.wave && out.taskPack && out.materials
      && out.parentConfig && ['none', 'verified-bank'].includes(out.memoryMode)
      && Number.isSafeInteger(out.historicalTokenEstimate)
      && out.protocol && out.phase
    ? out
    : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fail(result, code = 1) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write([
    'usage: npm run vnext:study:plan --',
    '--home <proof-home> --run <series-run-id> --wave <wave-id>',
    '--task-pack <task-pack.json> --materials <materials.json>',
    '--parent-config <recursive-parent-config.json>',
    '--protocol <ablation-protocol.json> --phase <phase-id>',
    '[--arm B3] [--model gpt-5.6-sol] [--reasoning high]',
    '[--memory-mode none|verified-bank] [--strategy-state <derived-bundle.json>]',
    '[--selected-generator-arm B5a|B5b|B5c] [--codex-bin <absolute>]',
    '[--created-at <ISO>] [--historical-token-estimate 4000000]'
  ].join(' ') + '\n');
  process.exit(2);
}

let taskPack;
let taskMaterialBundle;
let parentConfig;
let protocol;
let candidateStrategyState = null;
try {
  taskPack = readJson(args.taskPack);
  taskMaterialBundle = readJson(args.materials);
  parentConfig = readJson(args.parentConfig);
  protocol = readJson(args.protocol);
  if (args.strategyState) candidateStrategyState = readJson(args.strategyState);
} catch (error) {
  fail({ status: 'REFUSED', code: 'VNEXT_STUDY_INPUT_JSON_INVALID', message: error.message }, 2);
}

const home = resolve(args.home);
const store = createStore(home);
const resolvedBinary = args.codexBin
  ? { binPath: resolve(args.codexBin) }
  : resolveWorkerBinary(args.model, process.env);
const runtimeAuthority = captureCodexOAuthAuthority({
  binaryPath: resolvedBinary.binPath,
  requestedModel: args.model,
  reasoningEffort: args.reasoning
});
if (runtimeAuthority.status !== 'OK') fail(runtimeAuthority);
const evaluatorAuthority = captureExecutableEvaluatorAuthority();
if (evaluatorAuthority.status !== 'OK') fail(evaluatorAuthority);

let evidenceRecords = [];
let evidenceLedgerSha256 = null;
if (args.memoryMode === 'verified-bank') {
  const authority = createVNextEvidenceAuthorityVerifier({
    sourceStore: store,
    homeDir: store.homeDir
  });
  if (authority.status !== 'OK') fail(authority);
  const bank = readVNextEvidenceBank(store.homeDir, {
    verifyAuthorities: true,
    authorityVerifier: authority.verifier
  });
  if (bank.status !== 'OK') fail(bank);
  evidenceRecords = bank.records;
  evidenceLedgerSha256 = bank.ledgerSha256;
}

const createdAt = args.createdAt ?? new Date().toISOString();
const protocolReplay = verifyVNextAblationProtocolFromDisk({
  protocol,
  packageRoot: PACKAGE_ROOT
});
if (protocolReplay.status !== 'OK') fail(protocolReplay);
const phase = vnextAblationProtocolPhase(
  protocol,
  args.phase,
  args.arm,
  taskPack.packSha256
);
if (!phase) {
  fail({
    status: 'REFUSED',
    code: 'VNEXT_STUDY_PROTOCOL_PHASE_MISMATCH',
    message: 'The requested arm and task pack are not authorized in this frozen phase.'
  });
}
const requiresMemory = phase.memoryPolicy !== 'none';
if (requiresMemory !== (args.memoryMode === 'verified-bank')) {
  fail({
    status: 'REFUSED',
    code: 'VNEXT_STUDY_PROTOCOL_MEMORY_MISMATCH',
    message: 'The memory mode drifted from the frozen phase.'
  });
}
const strategyByArm = {
  B5a: 'reflective-pareto',
  B5b: 'bounded-skill',
  B5c: 'bank-recombination',
  B6: {
    B5a: 'reflective-pareto',
    B5b: 'bounded-skill',
    B5c: 'bank-recombination'
  }[args.selectedGeneratorArm]
};
let strategyStateBundle = null;
const automaticStrategy = strategyByArm[args.arm] ?? null;
if (automaticStrategy && candidateStrategyState != null) {
  const supplied = validateVNextStrategyStateBundle(candidateStrategyState);
  if (supplied.status !== 'OK'
      || supplied.bundle.states[automaticStrategy]?.ready !== true) {
    fail({
      status: 'REFUSED',
      code: 'VNEXT_STUDY_STRATEGY_BUNDLE_INVALID',
      message: 'B5/B6 --strategy-state must be a replayable derived bundle whose selected strategy is ready.'
    });
  }
  strategyStateBundle = supplied.bundle;
  candidateStrategyState = supplied.bundle.states[automaticStrategy].state;
}
if (automaticStrategy && candidateStrategyState == null) {
  if (args.memoryMode !== 'verified-bank') {
    fail({
      status: 'REFUSED',
      code: 'VNEXT_STUDY_STRATEGY_MEMORY_REQUIRED',
      message: 'B5/B6 strategy state can only be derived from the verified evidence bank.'
    });
  }
  const derived = deriveVNextStrategyStateBundle({
    sourceStore: store,
    homeDir: store.homeDir,
    records: evidenceRecords,
    decisionAt: createdAt,
    parentFamily: parentConfig.parentFamily
  });
  if (derived.status !== 'OK') fail(derived);
  const selected = derived.bundle.states[automaticStrategy];
  if (selected?.ready !== true) {
    fail({
      status: 'REFUSED',
      code: 'VNEXT_STUDY_STRATEGY_NOT_READY',
      strategy: automaticStrategy,
      reason: selected?.reason ?? null,
      bundleSha256: derived.bundle.bundleSha256
    });
  }
  strategyStateBundle = derived.bundle;
  candidateStrategyState = selected.state;
}
const built = createVNextStudyWave({
  packageRoot: PACKAGE_ROOT,
  seriesRunId: args.run,
  waveId: args.wave,
  armId: args.arm,
  selectedGeneratorArm: args.selectedGeneratorArm ?? null,
  createdAt,
  taskPack,
  taskMaterialBundle,
  parentFamily: parentConfig.parentFamily,
  mutationObjective: parentConfig.evolutionRecord?.mutationPlan?.objective,
  reasonCodes: ['VERIFIED_BASELINE_TARGET_FAILURES'],
  expectedEffectCode: 'MORE_EXACT_DISJOINT_REPAIRS',
  runtimeAuthority: runtimeAuthority.record,
  evaluatorAuthority: evaluatorAuthority.record,
  evidenceRecords,
  candidateStrategyState,
  strategyStateBundleSha256: strategyStateBundle?.bundleSha256 ?? null,
  historicalTokenEstimate: args.historicalTokenEstimate,
  studyBinding: {
    protocolSha256: protocol.protocolSha256,
    phaseId: phase.phaseId,
    memoryLedgerSha256: args.memoryMode === 'verified-bank'
      ? evidenceLedgerSha256
      : null
  }
});
if (built.status !== 'OK') fail(built);
const persisted = persistVNextStudyWave({ store, build: built.build });
if (persisted.status !== 'OK') fail(persisted);
if (strategyStateBundle) {
  const path = 'campaign-series/strategy-state-bundle.json';
  const bytes = `${canonicalVNextJson(strategyStateBundle)}\n`;
  const current = store.readRunFile(args.run, path);
  if (current != null && current !== bytes) {
    fail({ status: 'REFUSED', code: 'VNEXT_STUDY_STRATEGY_BUNDLE_CONFLICT' });
  }
  if (current == null) store.writeRunFile(args.run, path, bytes);
}

const approvedHash = persisted.disclosure.disclosureSha256;
const runScript = fileURLToPath(new URL('./run-vnext-study-wave.mjs', import.meta.url));
const verifyScript = fileURLToPath(new URL('./verify-vnext-study-wave.mjs', import.meta.url));
const launchCommand = [
  shellQuote(process.execPath),
  shellQuote(runScript),
  '--home', shellQuote(home),
  '--run', shellQuote(args.run),
  '--wave', shellQuote(args.wave),
  '--approved-plan', approvedHash,
  '--protocol', shellQuote(resolve(args.protocol))
].join(' ');
const verifyCommand = [
  shellQuote(process.execPath),
  shellQuote(verifyScript),
  '--home', shellQuote(home),
  '--run', shellQuote(args.run),
  '--wave', shellQuote(args.wave)
].join(' ');

process.stdout.write(`${JSON.stringify({
  status: 'OK',
  workerLaunched: false,
  paidModelCalls: 0,
  memoryMode: args.memoryMode,
  evidenceLedgerSha256,
  strategyStateBundleSha256: strategyStateBundle?.bundleSha256 ?? null,
  approvalPlanSha256: approvedHash,
  wavePlanSha256: persisted.disclosure.wavePlanSha256,
  disclosure: persisted.disclosure,
  exactLaunchCommand: launchCommand,
  exactVerifyCommand: verifyCommand
}, null, 2)}\n`);
