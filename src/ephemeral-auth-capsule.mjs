import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const EPHEMERAL_AUTH_CAPSULE_SCHEMA =
  'loop-factory-ephemeral-auth-capsule-v1';

const CAPSULE_PREFIX = 'evaluator-';
const DEFAULT_MAXIMUM_AGE_MS = 2 * 60 * 60 * 1000;

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function capsuleRoot(value = null) {
  const target = resolve(value || join(tmpdir(), 'loop-factory-vnext-auth-capsules'));
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) return null;
  const real = realpathSync(target);
  const macosAlias = target.startsWith('/var/') && real === `/private${target}`;
  return real === target || macosAlias ? real : null;
}

function markerPayload(marker) {
  const { markerSha256, ...payload } = marker;
  return payload;
}

export function validateEphemeralAuthCapsuleMarker(marker) {
  const expected = [
    'schemaVersion', 'capsuleId', 'ownerPid', 'ownerHost', 'createdAt',
    'sourceAuthSha256', 'markerSha256'
  ];
  return marker && typeof marker === 'object' && !Array.isArray(marker)
      && Object.keys(marker).length === expected.length
      && expected.every((key) => Object.hasOwn(marker, key))
      && marker.schemaVersion === EPHEMERAL_AUTH_CAPSULE_SCHEMA
      && typeof marker.capsuleId === 'string'
      && marker.capsuleId.startsWith(CAPSULE_PREFIX)
      && Number.isInteger(marker.ownerPid) && marker.ownerPid > 0
      && typeof marker.ownerHost === 'string' && marker.ownerHost.length > 0
      && Number.isFinite(Date.parse(marker.createdAt))
      && /^[a-f0-9]{64}$/.test(String(marker.sourceAuthSha256 || ''))
      && marker.markerSha256 === sha256(canonicalVNextJson(markerPayload(marker)))
    ? { status: 'OK', marker }
    : { status: 'REFUSED', code: 'EPHEMERAL_AUTH_CAPSULE_MARKER_INVALID' };
}

export function sweepEphemeralAuthCapsules({
  root = null,
  now = new Date().toISOString(),
  maximumAgeMs = DEFAULT_MAXIMUM_AGE_MS,
  isProcessAlive = pidAlive
} = {}) {
  try {
    const realRoot = capsuleRoot(root);
    const nowMs = Date.parse(now);
    if (!realRoot || !Number.isFinite(nowMs)
        || !Number.isInteger(maximumAgeMs) || maximumAgeMs < 1000
        || typeof isProcessAlive !== 'function') {
      return { status: 'REFUSED', code: 'EPHEMERAL_AUTH_SWEEP_INPUT_INVALID' };
    }
    const removed = [];
    const retained = [];
    for (const entry of readdirSync(realRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith(CAPSULE_PREFIX)) continue;
      const path = resolve(realRoot, entry.name);
      if (!within(realRoot, path) || entry.isSymbolicLink() || !entry.isDirectory()) {
        retained.push({ capsuleId: entry.name, reason: 'unsafe-entry' });
        continue;
      }
      let marker = null;
      try {
        marker = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
      } catch {
        marker = null;
      }
      const checked = validateEphemeralAuthCapsuleMarker(marker);
      const ageMs = checked.status === 'OK'
        ? nowMs - Date.parse(marker.createdAt)
        : nowMs - statSync(path).mtimeMs;
      const localOwner = checked.status === 'OK'
        && marker.ownerHost === hostname();
      const live = localOwner && isProcessAlive(marker.ownerPid);
      const removable = localOwner ? !live : ageMs >= maximumAgeMs;
      if (!removable) {
        retained.push({
          capsuleId: entry.name,
          reason: live ? 'live-owner' : 'not-stale'
        });
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      removed.push({
        capsuleId: entry.name,
        markerSha256: checked.status === 'OK' ? marker.markerSha256 : null
      });
    }
    return { status: 'OK', root: realRoot, removed, retained };
  } catch (error) {
    return { status: 'REFUSED', code: 'EPHEMERAL_AUTH_SWEEP_FAILED', message: error.message };
  }
}

export function prepareEphemeralCodexAuthCapsule({
  env = process.env,
  root = null,
  forbiddenRoot = null,
  ownerPid = process.pid,
  createdAt = new Date().toISOString()
} = {}) {
  let capsule = null;
  const sourceHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME
    ? resolve(env.CODEX_HOME)
    : (typeof env.HOME === 'string' && env.HOME
      ? join(resolve(env.HOME), '.codex')
      : null);
  const sourceAuth = sourceHome ? join(sourceHome, 'auth.json') : null;
  try {
    const realRoot = capsuleRoot(root);
    const forbidden = forbiddenRoot ? realpathSync(resolve(forbiddenRoot)) : null;
    if (!realRoot || !Number.isInteger(ownerPid) || ownerPid < 1
        || !Number.isFinite(Date.parse(createdAt))
        || (forbidden && within(forbidden, realRoot))
        || !sourceAuth || !existsSync(sourceAuth)
        || lstatSync(sourceAuth).isSymbolicLink()
        || !statSync(sourceAuth).isFile()
        || statSync(sourceAuth).size > 2 * 1024 * 1024) {
      return {
        status: 'REFUSED',
        code: 'EVALUATOR_CODEX_AUTH_INVALID',
        message: 'Codex evaluator auth must be one bounded regular file outside the proof tree.'
      };
    }
    capsule = mkdtempSync(join(realRoot, `${CAPSULE_PREFIX}${ownerPid}-`));
    chmodSync(capsule, 0o700);
    const sourceAuthSha256 = sha256(readFileSync(sourceAuth));
    const core = {
      schemaVersion: EPHEMERAL_AUTH_CAPSULE_SCHEMA,
      capsuleId: capsule.slice(realRoot.length + 1),
      ownerPid,
      ownerHost: hostname(),
      createdAt,
      sourceAuthSha256
    };
    const marker = {
      ...core,
      markerSha256: sha256(canonicalVNextJson(core))
    };
    writeFileSync(join(capsule, 'owner.json'), `${canonicalVNextJson(marker)}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
    const target = join(capsule, 'auth.json');
    copyFileSync(sourceAuth, target);
    chmodSync(target, 0o600);
    return {
      status: 'OK',
      root: realRoot,
      capsule,
      target,
      marker,
      cleanup() {
        if (existsSync(capsule)) rmSync(capsule, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (capsule && existsSync(capsule)) {
      rmSync(capsule, { recursive: true, force: true });
    }
    return {
      status: 'REFUSED',
      code: 'EVALUATOR_CODEX_AUTH_CAPSULE_FAILED',
      message: error.message
    };
  }
}
