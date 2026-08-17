import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import {
  ADAPTIVE_SCHEMA,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { listAdaptiveRecords } from './mechanism-catalog.mjs';
import {
  applyVNextOperatorAction,
  listVNextOperatorActions,
  persistVNextOperatorAction,
  validateVNextOperatorAction
} from './vnext-operator-actions.mjs';
import {
  createInitialVNextOperatorControl,
  sealVNextOperatorControlProjection,
  validateVNextOperatorControlProjection,
  VNEXT_OPERATOR_CONTROL_SCHEMA
} from './vnext-operator-control-contract.mjs';

export {
  createInitialVNextOperatorControl,
  validateVNextOperatorControlProjection,
  VNEXT_OPERATOR_CONTROL_SCHEMA
} from './vnext-operator-control-contract.mjs';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function normalizedHome(homeDir) {
  return typeof homeDir === 'string'
    && homeDir.length > 0
    && !homeDir.includes('\0')
    && isAbsolute(homeDir)
    && normalize(homeDir) === homeDir
    ? resolve(homeDir)
    : null;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function projectionRoot(homeDir) {
  return resolve(homeDir, 'vnext', 'operator-control', 'projections');
}

function projectionPath(homeDir, projection) {
  return resolve(
    projectionRoot(homeDir),
    `${String(projection.revision).padStart(8, '0')}-${projection.projectionSha256}.json`
  );
}

function writeImmutable(path, bytes) {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8') === bytes
      ? { status: 'OK', path, idempotent: true }
      : refused('VNEXT_OPERATOR_CONTROL_CONFLICT', 'Immutable projection bytes conflict.');
  }
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  return { status: 'OK', path, idempotent: false };
}

function loadProjectionChain(homeDir) {
  const root = projectionRoot(homeDir);
  if (!existsSync(root)) return { status: 'OK', projections: [] };
  const names = readdirSync(root).filter((name) => name.endsWith('.json')).sort();
  const projections = [];
  for (const name of names) {
    let projection;
    try {
      projection = JSON.parse(readFileSync(resolve(root, name), 'utf8'));
    } catch (error) {
      return refused('VNEXT_OPERATOR_CONTROL_READ_FAILED', error.message);
    }
    const checked = validateVNextOperatorControlProjection(projection);
    if (checked.status !== 'OK'
        || name !== `${String(projection.revision).padStart(8, '0')}-${projection.projectionSha256}.json`
        || projection.revision !== projections.length
        || (projection.revision > 0
          && projection.previousProjectionSha256
            !== projections.at(-1).projectionSha256)) {
      return refused(
        'VNEXT_OPERATOR_CONTROL_CHAIN_INVALID',
        'Operator control history contains a gap, fork, or invalid projection.'
      );
    }
    projections.push(projection);
  }
  return { status: 'OK', projections };
}

function actionIndex(homeDir) {
  const listed = listVNextOperatorActions({ homeDir });
  return listed.status === 'OK'
    ? { status: 'OK', actions: new Map(listed.actions.map((action) => [action.actionId, action])) }
    : listed;
}

export function loadVNextOperatorControlProjection({ homeDir } = {}) {
  const home = normalizedHome(homeDir);
  if (!home) return refused('VNEXT_OPERATOR_CONTROL_HOME_INVALID', 'homeDir must be normalized and absolute.');
  const chain = loadProjectionChain(home);
  if (chain.status !== 'OK') return chain;
  if (!chain.projections.length) {
    return { status: 'NOT_INITIALIZED', projection: null, projections: [] };
  }
  const indexed = actionIndex(home);
  if (indexed.status !== 'OK') return indexed;
  const projectedActionIds = new Set();
  for (const projection of chain.projections.slice(1)) {
    const action = indexed.actions.get(projection.actionId);
    if (!action || action.actionSha256 !== projection.actionSha256) {
      return refused(
        'VNEXT_OPERATOR_CONTROL_ACTION_MISSING',
        'A control projection does not bind its immutable operator action.'
      );
    }
    projectedActionIds.add(action.actionId);
  }
  const pendingActions = [...indexed.actions.values()].filter((action) => (
    !projectedActionIds.has(action.actionId)
  ));
  if (pendingActions.length) {
    return refused(
      'VNEXT_OPERATOR_CONTROL_ACTION_PENDING',
      'A persisted operator action has not reached a durable projection.',
      { pendingActionIds: pendingActions.map((action) => action.actionId).sort() }
    );
  }
  return {
    status: 'OK',
    projection: chain.projections.at(-1),
    projections: chain.projections
  };
}

export function initializeVNextOperatorControl({ homeDir, createdAt } = {}) {
  const home = normalizedHome(homeDir);
  if (!home) return refused('VNEXT_OPERATOR_CONTROL_HOME_INVALID', 'homeDir must be normalized and absolute.');
  const chain = loadProjectionChain(home);
  if (chain.status !== 'OK') return chain;
  if (chain.projections.length) {
    return { status: 'OK', projection: chain.projections.at(-1), idempotent: true };
  }
  const built = createInitialVNextOperatorControl({ createdAt });
  if (built.status !== 'OK') return built;
  const root = projectionRoot(home);
  mkdirSync(root, { recursive: true });
  const stored = writeImmutable(
    projectionPath(home, built.projection),
    `${JSON.stringify(built.projection, null, 2)}\n`
  );
  return stored.status === 'OK'
    ? { ...stored, projection: built.projection }
    : stored;
}

function validRecords(homeDir, records) {
  if (records == null) {
    const listed = listAdaptiveRecords({ homeDir });
    return listed.status === 'OK' ? listed.records : null;
  }
  return Array.isArray(records)
    && records.every((record) => validateAdaptiveRecord(record).status === 'OK')
    ? records
    : null;
}

function currentTarget(action, projection, records) {
  if (action.target.type === 'family') {
    const family = records.find((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.FAMILY
      && record.familyId === action.target.id
      && record.familySha256 === action.target.sha256
    ));
    if (!family) return null;
    return {
      id: family.familyId,
      sha256: family.familySha256,
      revisionSha256: projection.projectionSha256,
      status: projection.quarantinedFamilyIds.includes(family.familyId)
        ? 'QUARANTINED'
        : projection.shadowOnlyFamilyIds.includes(family.familyId)
          ? 'SHADOW'
          : 'ACTIVE'
    };
  }
  if (action.target.type === 'policy') {
    const policies = records.filter((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH
    ));
    const target = policies.find((record) => (
      record.policyEpochId === action.target.id
      && record.policyEpochSha256 === action.target.sha256
    ));
    if (!target) return null;
    const scope = policies.filter((record) => record.policyScopeId === target.policyScopeId)
      .sort((left, right) => left.epochNumber - right.epochNumber);
    const effective = projection.policyOverride
      ? policies.find((record) => (
          record.policyEpochId === projection.policyOverride.id
          && record.policyEpochSha256 === projection.policyOverride.sha256
        ))
      : scope.at(-1);
    if (!effective
        || effective.policyEpochId !== target.policyEpochId
        || effective.policyEpochSha256 !== target.policyEpochSha256) return null;
    return {
      id: target.policyEpochId,
      sha256: target.policyEpochSha256,
      revisionSha256: projection.projectionSha256,
      status: 'ACTIVE',
      ancestors: scope.filter((record) => record.epochNumber < target.epochNumber)
        .map((record) => ({ id: record.policyEpochId, sha256: record.policyEpochSha256 }))
    };
  }
  return null;
}

function nextProjection({ projection, action, application, records }) {
  const quarantined = new Set(projection.quarantinedFamilyIds);
  const shadowOnly = new Set(projection.shadowOnlyFamilyIds);
  let policyOverride = projection.policyOverride;
  if (application.disposition === 'QUARANTINED') {
    quarantined.add(action.target.id);
    shadowOnly.delete(action.target.id);
  } else if (application.disposition === 'RELEASED_TO_SHADOW') {
    quarantined.delete(action.target.id);
    shadowOnly.add(action.target.id);
  } else if (application.disposition === 'ROLLED_BACK') {
    const target = records.find((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH
      && record.policyEpochId === application.rollbackTarget.id
      && record.policyEpochSha256 === application.rollbackTarget.sha256
    ));
    if (!target) return null;
    policyOverride = {
      id: target.policyEpochId,
      sha256: target.policyEpochSha256,
      scopeId: target.policyScopeId
    };
  }
  return sealVNextOperatorControlProjection({
    schemaVersion: VNEXT_OPERATOR_CONTROL_SCHEMA,
    revision: projection.revision + 1,
    previousProjectionSha256: projection.projectionSha256,
    actionId: action.actionId,
    actionSha256: action.actionSha256,
    appliedAt: action.createdAt,
    disposition: application.disposition,
    quarantinedFamilyIds: sortedUnique([...quarantined]),
    shadowOnlyFamilyIds: sortedUnique([...shadowOnly]),
    policyOverride,
    activationAuthorized: false,
    promotionAuthorized: false
  });
}

export function applyAndPersistVNextOperatorControl({
  homeDir,
  action,
  records = null,
  verifyReleaseEvidence = null
} = {}) {
  const home = normalizedHome(homeDir);
  if (!home || validateVNextOperatorAction(action).status !== 'OK') {
    return refused('VNEXT_OPERATOR_CONTROL_INPUT_INVALID', 'A valid home and operator action are required.');
  }
  let chain = loadProjectionChain(home);
  if (chain.status !== 'OK') return chain;
  if (!chain.projections.length) {
    const initialized = initializeVNextOperatorControl({ homeDir: home, createdAt: action.createdAt });
    if (initialized.status !== 'OK') return initialized;
    chain = loadProjectionChain(home);
  }
  const existing = chain.projections.find((projection) => projection.actionId === action.actionId);
  if (existing) {
    return existing.actionSha256 === action.actionSha256
      ? { status: 'OK', projection: existing, idempotent: true }
      : refused('VNEXT_OPERATOR_CONTROL_ACTION_CONFLICT', 'Action ID already binds different bytes.');
  }
  const projection = chain.projections.at(-1);
  const adaptiveRecords = validRecords(home, records);
  if (!adaptiveRecords) {
    return refused('VNEXT_OPERATOR_CONTROL_RECORDS_INVALID', 'Adaptive records failed validation.');
  }
  if (action.kind === 'release-quarantine') {
    if (typeof verifyReleaseEvidence !== 'function') {
      return refused(
        'VNEXT_OPERATOR_RELEASE_VERIFIER_REQUIRED',
        'Quarantine release requires an independently replayed verifier receipt.'
      );
    }
    const verified = verifyReleaseEvidence(action.verifierEvidenceSha256);
    if (!verified || verified.status !== 'OK'
        || verified.evidenceSha256 !== action.verifierEvidenceSha256) {
      return refused(
        'VNEXT_OPERATOR_RELEASE_EVIDENCE_INVALID',
        'Quarantine release evidence did not independently replay.'
      );
    }
  }
  const current = currentTarget(action, projection, adaptiveRecords);
  if (!current) {
    return refused(
      'VNEXT_OPERATOR_CONTROL_TARGET_NOT_CURRENT',
      'The action target is absent or is not the effective immutable revision.'
    );
  }
  const application = applyVNextOperatorAction({ action, current });
  if (application.status !== 'OK') return application;
  const next = nextProjection({
    projection,
    action,
    application,
    records: adaptiveRecords
  });
  if (!next || validateVNextOperatorControlProjection(next).status !== 'OK') {
    return refused('VNEXT_OPERATOR_CONTROL_PROJECTION_INVALID', 'Resulting control projection is invalid.');
  }
  const actionStored = persistVNextOperatorAction({ homeDir: home, action });
  if (actionStored.status !== 'OK') return actionStored;
  mkdirSync(projectionRoot(home), { recursive: true });
  const stored = writeImmutable(
    projectionPath(home, next),
    `${JSON.stringify(next, null, 2)}\n`
  );
  return stored.status === 'OK'
    ? {
        ...stored,
        projection: next,
        disposition: application.disposition,
        restrictive: application.restrictive === true
      }
    : stored;
}

export function operatorControlForRouting({ homeDir, records = null } = {}) {
  const loaded = loadVNextOperatorControlProjection({ homeDir });
  if (loaded.status === 'NOT_INITIALIZED') {
    return {
      status: 'OK',
      projection: null,
      quarantinedFamilyIds: [],
      shadowOnlyFamilyIds: [],
      policyOverride: null
    };
  }
  if (loaded.status !== 'OK') return loaded;
  const adaptiveRecords = validRecords(homeDir, records);
  if (!adaptiveRecords) {
    return refused('VNEXT_OPERATOR_CONTROL_RECORDS_INVALID', 'Adaptive records failed validation.');
  }
  let policyOverride = null;
  if (loaded.projection.policyOverride) {
    policyOverride = adaptiveRecords.find((record) => (
      record.schemaVersion === ADAPTIVE_SCHEMA.POLICY_EPOCH
      && record.policyEpochId === loaded.projection.policyOverride.id
      && record.policyEpochSha256 === loaded.projection.policyOverride.sha256
      && record.policyScopeId === loaded.projection.policyOverride.scopeId
    )) || null;
    if (!policyOverride) {
      return refused(
        'VNEXT_OPERATOR_CONTROL_POLICY_MISSING',
        'The bound rollback policy epoch is unavailable or invalid.'
      );
    }
  }
  return {
    status: 'OK',
    projection: loaded.projection,
    quarantinedFamilyIds: [...loaded.projection.quarantinedFamilyIds],
    shadowOnlyFamilyIds: [...loaded.projection.shadowOnlyFamilyIds],
    policyOverride
  };
}
