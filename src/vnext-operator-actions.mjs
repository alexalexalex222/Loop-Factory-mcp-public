import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_OPERATOR_ACTION_SCHEMA = 'loop-factory-vnext-operator-action-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const KINDS = new Set([
  'deny-review',
  'quarantine-family',
  'rollback-policy',
  'release-quarantine'
]);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function actionPayload(action) {
  return {
    schemaVersion: action.schemaVersion,
    actionId: action.actionId,
    runId: action.runId,
    kind: action.kind,
    target: action.target,
    expectedRevisionSha256: action.expectedRevisionSha256,
    rollbackTarget: action.rollbackTarget,
    reasonCode: action.reasonCode,
    evidenceSha256: action.evidenceSha256,
    verifierEvidenceSha256: action.verifierEvidenceSha256,
    authority: action.authority,
    createdAt: action.createdAt
  };
}

export function createVNextOperatorAction(input = {}) {
  const base = {
    schemaVersion: VNEXT_OPERATOR_ACTION_SCHEMA,
    actionId: input.actionId,
    runId: input.runId,
    kind: input.kind,
    target: input.target,
    expectedRevisionSha256: input.expectedRevisionSha256,
    rollbackTarget: input.rollbackTarget ?? null,
    reasonCode: input.reasonCode,
    evidenceSha256: input.evidenceSha256,
    verifierEvidenceSha256: input.verifierEvidenceSha256 ?? null,
    authority: input.authority,
    createdAt: input.createdAt
  };
  const targetValid = plainObject(base.target)
    && Object.keys(base.target).sort().join(',') === 'id,sha256,type'
    && isSafeId(base.target.id)
    && ['review', 'family', 'policy'].includes(base.target.type)
    && SHA256.test(String(base.target.sha256 || ''));
  const targetKindValid = (
    (base.kind === 'deny-review' && base.target?.type === 'review')
    || (['quarantine-family', 'release-quarantine'].includes(base.kind)
      && base.target?.type === 'family')
    || (base.kind === 'rollback-policy' && base.target?.type === 'policy')
  );
  const rollbackValid = base.kind === 'rollback-policy'
    ? plainObject(base.rollbackTarget)
      && Object.keys(base.rollbackTarget).sort().join(',') === 'id,sha256'
      && isSafeId(base.rollbackTarget.id)
      && SHA256.test(String(base.rollbackTarget.sha256 || ''))
    : base.rollbackTarget === null;
  if (!isSafeId(base.actionId)
      || !isSafeId(base.runId)
      || !KINDS.has(base.kind)
      || !targetValid
      || !targetKindValid
      || !rollbackValid
      || !SHA256.test(String(base.expectedRevisionSha256 || ''))
      || !isSafeId(base.reasonCode)
      || !SHA256.test(String(base.evidenceSha256 || ''))
      || (base.verifierEvidenceSha256 != null
        && !SHA256.test(String(base.verifierEvidenceSha256)))
      || (base.kind === 'release-quarantine' && base.verifierEvidenceSha256 == null)
      || !plainObject(base.authority)
      || Object.keys(base.authority).sort().join(',') !== 'operatorId,sessionId'
      || !isSafeId(base.authority.operatorId)
      || !isSafeId(base.authority.sessionId)
      || !Number.isFinite(Date.parse(base.createdAt))) {
    return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_INVALID' };
  }
  return {
    status: 'OK',
    action: {
      ...base,
      actionSha256: sha256(canonicalVNextJson(base))
    }
  };
}

export function validateVNextOperatorAction(action) {
  if (!action
      || action.schemaVersion !== VNEXT_OPERATOR_ACTION_SCHEMA
      || action.actionSha256 !== sha256(canonicalVNextJson(actionPayload(action)))) {
    return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_TAMPERED' };
  }
  return createVNextOperatorAction(action).status === 'OK'
    ? { status: 'OK', action }
    : { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_INVALID' };
}

function rootFor(homeDir) {
  return resolve(homeDir, 'vnext', 'operator-actions');
}

function pathFor(homeDir, actionId) {
  const root = rootFor(homeDir);
  const path = resolve(root, `${actionId}.json`);
  if (!isSafeId(actionId) || !within(root, path)) throw new Error('invalid operator action path');
  return { root, path };
}

export function persistVNextOperatorAction({ homeDir, action } = {}) {
  try {
    if (validateVNextOperatorAction(action).status !== 'OK') {
      return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_INVALID' };
    }
    const { root, path } = pathFor(homeDir, action.actionId);
    mkdirSync(root, { recursive: true });
    const bytes = `${JSON.stringify(action, null, 2)}\n`;
    if (existsSync(path)) {
      return readFileSync(path, 'utf8') === bytes
        ? { status: 'OK', path, idempotent: true }
        : { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_CONFLICT' };
    }
    const descriptor = openSync(path, 'wx', 0o600);
    try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); }
    return { status: 'OK', path, idempotent: false };
  } catch (error) {
    return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_PERSIST_FAILED', message: error.message };
  }
}

export function listVNextOperatorActions({ homeDir } = {}) {
  try {
    const root = rootFor(homeDir);
    if (!existsSync(root)) return { status: 'OK', actions: [] };
    const actions = readdirSync(root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try { return JSON.parse(readFileSync(resolve(root, name), 'utf8')); } catch { return null; }
      })
      .filter((action) => validateVNextOperatorAction(action).status === 'OK')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.actionId.localeCompare(right.actionId));
    return { status: 'OK', actions };
  } catch (error) {
    return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_LIST_FAILED', message: error.message };
  }
}

export function applyVNextOperatorAction({ action, current } = {}) {
  if (validateVNextOperatorAction(action).status !== 'OK'
      || !plainObject(current)
      || current.id !== action.target.id
      || current.sha256 !== action.target.sha256
      || current.revisionSha256 !== action.expectedRevisionSha256) {
    return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_STALE_BINDING' };
  }
  if (action.kind === 'deny-review') {
    if (action.target.type !== 'review' || current.status !== 'PENDING') {
      return { status: 'REFUSED', code: 'VNEXT_OPERATOR_DENY_INVALID' };
    }
    return { status: 'OK', disposition: 'DENIED', restrictive: true };
  }
  if (action.kind === 'quarantine-family') {
    if (action.target.type !== 'family'
        || !['ACTIVE', 'VERIFIED', 'SHADOW'].includes(current.status)) {
      return { status: 'REFUSED', code: 'VNEXT_OPERATOR_QUARANTINE_INVALID' };
    }
    return { status: 'OK', disposition: 'QUARANTINED', restrictive: true };
  }
  if (action.kind === 'rollback-policy') {
    if (action.target.type !== 'policy'
        || !Array.isArray(current.ancestors)
        || !current.ancestors.some((ancestor) => (
          ancestor.id === action.rollbackTarget.id
          && ancestor.sha256 === action.rollbackTarget.sha256
        ))) {
      return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ROLLBACK_INVALID' };
    }
    return {
      status: 'OK',
      disposition: 'ROLLED_BACK',
      rollbackTarget: action.rollbackTarget,
      restrictive: true
    };
  }
  if (action.kind === 'release-quarantine') {
    if (action.target.type !== 'family'
        || current.status !== 'QUARANTINED'
        || action.verifierEvidenceSha256 == null) {
      return { status: 'REFUSED', code: 'VNEXT_OPERATOR_RELEASE_INVALID' };
    }
    return {
      status: 'OK',
      disposition: 'RELEASED_TO_SHADOW',
      restrictive: false,
      routingEligible: false
    };
  }
  return { status: 'REFUSED', code: 'VNEXT_OPERATOR_ACTION_UNKNOWN' };
}
