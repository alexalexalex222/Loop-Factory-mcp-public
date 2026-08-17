import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeId, sha256 } from './util.mjs';
import { validateVNextAblationProtocol } from './vnext-ablation-protocol.mjs';
import { verifyVNextCampaignSeries } from './vnext-campaign-driver.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  validateVNextStudyDisclosure,
  verifyVNextStudyPlanFromDisk
} from './vnext-study-plan.mjs';
import {
  VNEXT_WAVE_IMPLEMENTATION_PATHS,
  verifyVNextCampaignWave
} from './vnext-wave-runner.mjs';

export const VNEXT_MATCHED_PHASE_PLAN_SCHEMA =
  'loop-factory-vnext-matched-phase-plan-v1';
export const VNEXT_MATCHED_PHASE_IMPLEMENTATION_PATHS = Object.freeze([
  ...new Set([
    ...VNEXT_WAVE_IMPLEMENTATION_PATHS,
    'src/vnext-matched-phase.mjs',
    'scripts/build-vnext-matched-phase.mjs',
    'scripts/verify-vnext-matched-phase.mjs',
    'src/schemas/vnext-matched-phase-plan-v1.schema.json'
  ])
].sort());

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAN_FILE = 'plan.json';
const SHA256 = /^[a-f0-9]{64}$/;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function within(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function implementationManifest(packageRoot = PACKAGE_ROOT) {
  try {
    const root = realpathSync(resolve(packageRoot));
    const manifest = VNEXT_MATCHED_PHASE_IMPLEMENTATION_PATHS.map((path) => {
      const full = resolve(root, path);
      if (!within(root, full) || !existsSync(full)
          || lstatSync(full).isSymbolicLink() || !lstatSync(full).isFile()) {
        throw new Error(`Matched-phase dependency is missing or unsafe: ${path}`);
      }
      const bytes = readFileSync(full);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    });
    return {
      status: 'OK',
      manifest,
      implementationSha256: sha256(canonicalVNextJson(manifest))
    };
  } catch (error) {
    return refused('MATCHED_PHASE_IMPLEMENTATION_INVALID', error.message);
  }
}

function phaseDirectory(home, protocolSha256, phaseId, { create = false } = {}) {
  if (!isAbsolute(String(home || '')) || !SHA256.test(String(protocolSha256 || ''))
      || !isSafeId(phaseId)) return null;
  try {
    const resolvedHome = realpathSync(resolve(home));
    const rootPath = resolve(resolvedHome, 'matched-phases');
    if (create) mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    if (!existsSync(rootPath) || lstatSync(rootPath).isSymbolicLink()) return null;
    const root = realpathSync(rootPath);
    const directory = resolve(
      root,
      `phase-${sha256(`${protocolSha256}:${phaseId}`).slice(0, 24)}`
    );
    if (!within(root, directory)) return null;
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return null;
    return realpathSync(directory);
  } catch {
    return null;
  }
}

function pristine(state, waveId) {
  return state?.status === 'READY'
    && state.currentWave == null
    && state.queue?.length === 1
    && state.queue[0].waveId === waveId
    && state.completedWaves?.length === 0
    && state.operatorStop === false;
}

function childFingerprint(verified) {
  const { disclosure, planned } = verified;
  const config = planned.inputs.config;
  return {
    armId: disclosure.armId,
    seriesRunId: disclosure.seriesRunId,
    waveId: disclosure.waveId,
    disclosureSha256: disclosure.disclosureSha256,
    wavePlanSha256: disclosure.wavePlanSha256,
    waveInputEvidenceSha256: planned.inputs.evidenceSha256,
    configSha256: disclosure.configSha256,
    taskPackSha256: disclosure.taskPack.packSha256,
    taskIdentitySetSha256: disclosure.taskPack.taskIdentitySetSha256,
    taskMaterialBundleSha256: planned.inputs.taskMaterialBundle.bundleSha256,
    parentFamilySha256: disclosure.parentMechanism.familySha256,
    mutationObjectiveSha256: disclosure.parentMechanism.mutationObjectiveSha256,
    modelBindingSha256: sha256(canonicalVNextJson(disclosure.model)),
    evaluatorAuthoritySha256: disclosure.evaluatorAuthoritySha256,
    implementationSha256: disclosure.implementationSha256,
    memoryLedgerSha256: disclosure.studyBinding.memoryLedgerSha256,
    evidenceSnapshotSha256: sha256(canonicalVNextJson(
      config.preparation.evidenceRecords
    )),
    strategyStateBundleSha256:
      config.preparation.architectureFacts.strategyStateBundleSha256,
    maximumCalls: disclosure.exposure.maximumCalls,
    maximumTotalTokens: disclosure.exposure.maximumTotalTokens,
    disclosureCreatedAt: disclosure.createdAt,
    pristineAtFreeze: pristine(planned.series.state, disclosure.waveId)
  };
}

function commonFingerprint(children) {
  const first = children[0];
  return {
    taskPackSha256: first.taskPackSha256,
    taskIdentitySetSha256: first.taskIdentitySetSha256,
    taskMaterialBundleSha256: first.taskMaterialBundleSha256,
    parentFamilySha256: first.parentFamilySha256,
    mutationObjectiveSha256: first.mutationObjectiveSha256,
    modelBindingSha256: first.modelBindingSha256,
    evaluatorAuthoritySha256: first.evaluatorAuthoritySha256,
    implementationSha256: first.implementationSha256,
    memoryLedgerSha256: first.memoryLedgerSha256,
    evidenceSnapshotSha256: first.evidenceSnapshotSha256,
    strategyStateBundleSha256: first.strategyStateBundleSha256,
    disclosureCreatedAt: first.disclosureCreatedAt
  };
}

function commonMatches(child, common) {
  return Object.entries(common).every(([key, value]) => (
    canonicalVNextJson(child[key]) === canonicalVNextJson(value)
  ));
}

function exactArmSet(actual, expected) {
  return canonicalVNextJson([...actual].sort())
    === canonicalVNextJson([...expected].sort());
}

export function createVNextMatchedPhasePlan({
  store,
  protocol,
  phaseId,
  children,
  packageRoot = PACKAGE_ROOT
} = {}) {
  const validProtocol = validateVNextAblationProtocol(protocol);
  const phase = validProtocol.status === 'OK'
    ? protocol.phases.find((row) => row.phaseId === phaseId)
    : null;
  const implementation = implementationManifest(packageRoot);
  if (!store || !phase || phaseId === 'P4-disjoint-transfer'
      || !Array.isArray(children) || children.length !== phase.arms.length
      || implementation.status !== 'OK') {
    return refused('MATCHED_PHASE_INPUT_INVALID', 'Matched planning supports exact P0-P3 study-wave children under one frozen protocol.');
  }
  const verified = children.map(({ seriesRunId, waveId }) => (
    verifyVNextStudyPlanFromDisk({ store, seriesRunId, waveId })
  ));
  if (verified.some((result) => result.status !== 'OK')) {
    return refused('MATCHED_PHASE_CHILD_INVALID', 'A child study plan failed independent replay.', {
      failures: verified.filter((result) => result.status !== 'OK')
    });
  }
  const fingerprints = verified.map(childFingerprint)
    .sort((left, right) => left.armId.localeCompare(right.armId));
  const common = commonFingerprint(fingerprints);
  const strategyBundleValues = new Set(fingerprints.map((row) => (
    row.strategyStateBundleSha256
  )));
  if (!exactArmSet(fingerprints.map((row) => row.armId), phase.arms)
      || fingerprints.some((row) => row.pristineAtFreeze !== true)
      || fingerprints.some((row) => !commonMatches(row, common))
      || fingerprints.some((row) => row.taskPackSha256 !== phase.packSha256)
      || common.taskIdentitySetSha256 !== phase.taskIdentitySetSha256
      || common.implementationSha256 !== protocol.implementationSha256
      || fingerprints.reduce((sum, row) => sum + row.maximumCalls, 0)
        !== phase.maximumCalls
      || verified.some(({ disclosure }) => (
        disclosure.model.requestedModel !== protocol.modelPolicy.model
        || disclosure.model.reasoningEffort !== protocol.modelPolicy.reasoningEffort
        || disclosure.model.authMode !== protocol.modelPolicy.authMode
        || disclosure.model.fallbackModels.length !== 0
      ))
      || fingerprints.some((row) => (
        verified.find(({ disclosure }) => disclosure.armId === row.armId)
          .disclosure.studyBinding.protocolSha256 !== protocol.protocolSha256
      ))
      || fingerprints.some((row) => (
        verified.find(({ disclosure }) => disclosure.armId === row.armId)
          .disclosure.studyBinding.phaseId !== phaseId
      ))
      || (phase.memoryPolicy === 'none'
        ? common.memoryLedgerSha256 !== null
        : !SHA256.test(String(common.memoryLedgerSha256 || '')))
      || (phaseId === 'P2-generator-comparison'
        && (strategyBundleValues.size !== 1
          || !SHA256.test(String(common.strategyStateBundleSha256 || ''))))) {
    return refused(
      'MATCHED_PHASE_NOT_MATCHED',
      'Children must be pristine and share the exact pack, materials, parent, evidence snapshot, timestamp, model, evaluator, memory ledger, and strategy-state snapshot.'
    );
  }
  const core = {
    schemaVersion: VNEXT_MATCHED_PHASE_PLAN_SCHEMA,
    protocol,
    protocolSha256: protocol.protocolSha256,
    phaseId,
    phaseMode: phase.mode,
    memoryPolicy: phase.memoryPolicy,
    proofHome: realpathSync(store.homeDir),
    common,
    children: fingerprints,
    exposure: {
      maximumCalls: fingerprints.reduce((sum, row) => sum + row.maximumCalls, 0),
      maximumTotalTokens: fingerprints.reduce((sum, row) => (
        sum + row.maximumTotalTokens
      ), 0),
      retries: 0,
      hardUsdCeiling: 0,
      billingMode: 'subscription-no-metered-usd',
      childApprovalsRequired: fingerprints.length,
      combinedLaunchApprovalSupported: false
    },
    implementationManifest: implementation.manifest,
    implementationSha256: implementation.implementationSha256,
    authority: {
      workerLaunchedAtFreeze: false,
      paidModelCallsAtFreeze: 0,
      promotionAuthorized: false,
      generalizedClaimAuthority: false,
      eachChildRequiresExactDisclosureApproval: true
    }
  };
  const plan = { ...core, planSha256: sha256(canonicalVNextJson(core)) };
  return validateVNextMatchedPhasePlan(plan).status === 'OK'
    ? { status: 'OK', plan }
    : refused('MATCHED_PHASE_PLAN_INVALID', 'Constructed matched-phase plan failed replay.');
}

export function validateVNextMatchedPhasePlan(plan) {
  if (!exactKeys(plan, [
    'schemaVersion', 'protocol', 'protocolSha256', 'phaseId', 'phaseMode',
    'memoryPolicy', 'proofHome', 'common', 'children', 'exposure',
    'implementationManifest', 'implementationSha256', 'authority',
    'planSha256'
  ]) || plan.schemaVersion !== VNEXT_MATCHED_PHASE_PLAN_SCHEMA
      || validateVNextAblationProtocol(plan.protocol).status !== 'OK'
      || plan.protocolSha256 !== plan.protocol.protocolSha256
      || !isSafeId(plan.phaseId) || !isAbsolute(String(plan.proofHome || ''))
      || !Array.isArray(plan.children) || plan.children.length < 1
      || !exactArmSet(
        plan.children.map((row) => row.armId),
        plan.protocol.phases.find((row) => row.phaseId === plan.phaseId)?.arms ?? []
      )
      || plan.children.some((row) => row.pristineAtFreeze !== true)
      || plan.children.some((row) => !commonMatches(row, plan.common))
      || plan.exposure?.retries !== 0
      || plan.exposure?.hardUsdCeiling !== 0
      || plan.exposure?.combinedLaunchApprovalSupported !== false
      || plan.authority?.workerLaunchedAtFreeze !== false
      || plan.authority?.paidModelCallsAtFreeze !== 0
      || plan.authority?.promotionAuthorized !== false
      || plan.authority?.generalizedClaimAuthority !== false
      || plan.authority?.eachChildRequiresExactDisclosureApproval !== true
      || !Array.isArray(plan.implementationManifest)
      || plan.implementationSha256
        !== sha256(canonicalVNextJson(plan.implementationManifest))
      || !SHA256.test(String(plan.planSha256 || ''))) {
    return refused('MATCHED_PHASE_PLAN_INVALID', 'Matched-phase shape or scientific authority is invalid.');
  }
  const core = structuredClone(plan);
  delete core.planSha256;
  return plan.planSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', plan }
    : refused('MATCHED_PHASE_PLAN_TAMPERED', 'Matched-phase plan hash failed replay.');
}

export function persistVNextMatchedPhasePlan({ store, plan } = {}) {
  const valid = validateVNextMatchedPhasePlan(plan);
  const directory = valid.status === 'OK'
    ? phaseDirectory(store.homeDir, plan.protocolSha256, plan.phaseId, { create: true })
    : null;
  if (!directory || realpathSync(store.homeDir) !== plan.proofHome) {
    return valid.status === 'OK'
      ? refused('MATCHED_PHASE_DIRECTORY_INVALID', 'Matched-phase proof home is unbound.')
      : valid;
  }
  const path = join(directory, PLAN_FILE);
  const bytes = `${canonicalVNextJson(plan)}\n`;
  if (existsSync(path)) {
    return readFileSync(path, 'utf8') === bytes
      ? { status: 'OK', path, plan, idempotent: true }
      : refused('MATCHED_PHASE_PLAN_CONFLICT', 'Immutable matched-phase bytes conflict.');
  }
  writeFileSync(path, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { status: 'OK', path, plan, idempotent: false };
}

export function loadVNextMatchedPhasePlan({ store, protocolSha256, phaseId } = {}) {
  const directory = store
    ? phaseDirectory(store.homeDir, protocolSha256, phaseId)
    : null;
  if (!directory) return refused('MATCHED_PHASE_DIRECTORY_INVALID', 'Matched-phase directory is missing or unsafe.');
  try {
    const plan = JSON.parse(readFileSync(join(directory, PLAN_FILE), 'utf8'));
    const valid = validateVNextMatchedPhasePlan(plan);
    const current = implementationManifest();
    if (valid.status !== 'OK') return valid;
    if (plan.protocolSha256 !== protocolSha256 || plan.phaseId !== phaseId
        || current.status !== 'OK'
        || current.implementationSha256 !== plan.implementationSha256
        || canonicalVNextJson(current.manifest)
          !== canonicalVNextJson(plan.implementationManifest)) {
      return refused('MATCHED_PHASE_IMPLEMENTATION_DRIFT', 'Matched-phase implementation changed after freeze.');
    }
    return { status: 'OK', directory, plan };
  } catch {
    return refused('MATCHED_PHASE_PLAN_MISSING', 'Matched-phase plan is missing or malformed.');
  }
}

function replayChildren(store, plan) {
  const results = plan.children.map((child) => {
    const verified = verifyVNextStudyPlanFromDisk({
      store,
      seriesRunId: child.seriesRunId,
      waveId: child.waveId
    });
    if (verified.status !== 'OK') return { child, verified, fingerprint: null };
    const fingerprint = childFingerprint(verified);
    fingerprint.pristineAtFreeze = child.pristineAtFreeze;
    return { child, verified, fingerprint };
  });
  return results.every(({ fingerprint, child }) => (
    fingerprint && canonicalVNextJson(fingerprint) === canonicalVNextJson(child)
  ))
    ? { status: 'OK', results }
    : refused('MATCHED_PHASE_CHILD_DRIFT', 'A frozen child disclosure or study input changed.');
}

export function verifyVNextMatchedPhasePlanFromDisk({
  store,
  protocolSha256,
  phaseId
} = {}) {
  const loaded = loadVNextMatchedPhasePlan({ store, protocolSha256, phaseId });
  if (loaded.status !== 'OK') return loaded;
  const replayed = replayChildren(store, loaded.plan);
  if (replayed.status !== 'OK') return replayed;
  const ready = replayed.results.every(({ verified }) => (
    pristine(verified.planned.series.state, verified.disclosure.waveId)
  ));
  return {
    status: 'OK',
    readyToLaunch: ready,
    planSha256: loaded.plan.planSha256,
    phaseId,
    children: loaded.plan.children.map((child) => ({
      armId: child.armId,
      seriesRunId: child.seriesRunId,
      waveId: child.waveId,
      disclosureSha256: child.disclosureSha256,
      pristine: pristine(
        replayed.results.find(({ child: row }) => row.armId === child.armId)
          .verified.planned.series.state,
        child.waveId
      )
    })),
    evidenceSha256: sha256(canonicalVNextJson({
      planSha256: loaded.plan.planSha256,
      childDisclosureSha256s: loaded.plan.children
        .map((child) => child.disclosureSha256).sort()
    }))
  };
}

export function verifyVNextMatchedPhaseResults({
  store,
  protocolSha256,
  phaseId
} = {}) {
  const loaded = loadVNextMatchedPhasePlan({ store, protocolSha256, phaseId });
  if (loaded.status !== 'OK') return loaded;
  const replayed = replayChildren(store, loaded.plan);
  if (replayed.status !== 'OK') return replayed;
  const results = loaded.plan.children.map((child) => {
    const series = verifyVNextCampaignSeries({
      store,
      seriesRunId: child.seriesRunId
    });
    const wave = verifyVNextCampaignWave({
      store,
      seriesRunId: child.seriesRunId,
      waveId: child.waveId
    });
    return {
      armId: child.armId,
      seriesRunId: child.seriesRunId,
      waveId: child.waveId,
      seriesValid: series.status === 'OK' && series.seriesValid === true,
      waveValid: wave.status === 'OK',
      disposition: wave.disposition ?? null,
      causalPass: wave.causalPass ?? false,
      activationEligible: wave.activationEligible ?? false,
      calls: wave.calls ?? null,
      waveEvidenceSha256: wave.evidenceSha256 ?? null,
      seriesEvidenceSha256: series.evidenceSha256 ?? null
    };
  });
  const phaseValid = results.every((row) => row.seriesValid && row.waveValid);
  const evidence = {
    planSha256: loaded.plan.planSha256,
    phaseId,
    phaseValid,
    results
  };
  return {
    status: phaseValid ? 'OK' : 'REFUSED',
    phaseValid,
    generalizedClaimAuthority: false,
    results,
    evidenceSha256: sha256(canonicalVNextJson(evidence))
  };
}
