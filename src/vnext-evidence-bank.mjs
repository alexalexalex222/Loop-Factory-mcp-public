import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_EVIDENCE_RECORD_SCHEMA = 'vnext-evidence-record-v1';
export const VNEXT_EVIDENCE_AUTHORITY_SCHEMA = 'vnext-evidence-authority-v1';
export const VNEXT_EVIDENCE_KINDS = Object.freeze([
  'positive',
  'no-improvement',
  'regression',
  'contradiction',
  'sham',
  'transfer',
  'failure'
]);

const KINDS = new Set(VNEXT_EVIDENCE_KINDS);
const LIFECYCLES = new Set(['observed', 'replicated', 'active', 'retired', 'contradicted']);
const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_MAX_BYTES = 64 * 1024;
const CALLER_CLAIMS_MAX_BYTES = 8 * 1024;
const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;
const SENSITIVE_KEY = new Set([
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'secrets',
  'accesstoken'
]);

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function finiteOrNull(value) {
  return value == null || Number.isFinite(value);
}

function stringSet(values, maximum = 128) {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const normalized = values.map((value) => String(value ?? '').trim());
  if (normalized.some((value) => !value || value.length > 240 || value.includes('\0'))) return null;
  return [...new Set(normalized)].sort();
}

function hashSet(values, maximum = 128) {
  const normalized = stringSet(values, maximum);
  return normalized && normalized.every((value) => SHA256.test(value))
    ? normalized
    : null;
}

function boundedJson(value, maximumBytes, { rejectSensitiveKeys = false } = {}) {
  const seen = new Set();
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return false;
    if (item == null || typeof item === 'boolean' || typeof item === 'string') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 2_048) return false;
      const valid = item.every((child) => visit(child, depth + 1));
      seen.delete(item);
      return valid;
    }
    if (!plainObject(item) || Object.keys(item).length > 2_048) return false;
    for (const [key, child] of Object.entries(item)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
      if (!key || key.length > 240 || key.includes('\0')
          || (rejectSensitiveKeys && SENSITIVE_KEY.has(normalizedKey))
          || !visit(child, depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  };
  if (!visit(value, 0)) return null;
  let canonical;
  try {
    canonical = canonicalVNextJson(value);
  } catch {
    return null;
  }
  return Buffer.byteLength(canonical, 'utf8') <= maximumBytes ? canonical : null;
}

function payloadOf(record) {
  const { recordSha256: ignored, ...payload } = record;
  return payload;
}

function authorityPayload(authority) {
  const { authoritySha256: ignored, ...payload } = authority;
  return payload;
}

function sealAuthority(core) {
  return deepFreeze({
    ...core,
    authoritySha256: sha256(canonicalVNextJson(core))
  });
}

function unverifiedAuthority() {
  return sealAuthority({
    schemaVersion: VNEXT_EVIDENCE_AUTHORITY_SCHEMA,
    kind: 'unverified'
  });
}

export function createVNextFixtureEvidenceAuthority(fixtureId) {
  if (!isSafeId(fixtureId)) {
    return refused('EVIDENCE_FIXTURE_AUTHORITY_INVALID', 'Fixture authority requires a safe explicit fixture ID.');
  }
  return {
    status: 'OK',
    authority: sealAuthority({
      schemaVersion: VNEXT_EVIDENCE_AUTHORITY_SCHEMA,
      kind: 'fixture',
      fixtureId
    })
  };
}

export function createVerifierOwnedVNextEvidenceAuthority({
  sourceRunId,
  sourceCompletedAt,
  primaryEvidenceSha256,
  leaseEvidenceSha256,
  preparationEvidenceSha256
} = {}) {
  if (!isSafeId(sourceRunId) || !validIso(sourceCompletedAt)
      || ![primaryEvidenceSha256, leaseEvidenceSha256, preparationEvidenceSha256]
        .every((value) => SHA256.test(String(value || '')))) {
    return refused(
      'EVIDENCE_VERIFIER_AUTHORITY_INVALID',
      'Verifier authority requires one completed source run and its replayable proof hashes.'
    );
  }
  return {
    status: 'OK',
    authority: sealAuthority({
      schemaVersion: VNEXT_EVIDENCE_AUTHORITY_SCHEMA,
      kind: 'verifier-owned',
      verifierId: 'adaptive-recursive-canary-v2-replay',
      sourceRunId,
      sourceCompletedAt,
      primaryEvidenceSha256,
      leaseEvidenceSha256,
      preparationEvidenceSha256
    })
  };
}

function validateAuthority(authority, { allowFixtureRecords = false } = {}) {
  if (!plainObject(authority)
      || authority.schemaVersion !== VNEXT_EVIDENCE_AUTHORITY_SCHEMA
      || !SHA256.test(String(authority.authoritySha256 || ''))
      || authority.authoritySha256 !== sha256(canonicalVNextJson(authorityPayload(authority)))) {
    return null;
  }
  if (authority.kind === 'unverified') {
    return exactKeys(authority, ['schemaVersion', 'kind', 'authoritySha256'])
      ? authority
      : null;
  }
  if (authority.kind === 'fixture') {
    return allowFixtureRecords
      && exactKeys(authority, ['schemaVersion', 'kind', 'fixtureId', 'authoritySha256'])
      && isSafeId(authority.fixtureId)
      ? authority
      : null;
  }
  if (authority.kind === 'verifier-owned') {
    return exactKeys(authority, [
      'schemaVersion', 'kind', 'verifierId', 'sourceRunId', 'sourceCompletedAt',
      'primaryEvidenceSha256', 'leaseEvidenceSha256', 'preparationEvidenceSha256',
      'authoritySha256'
    ])
      && authority.verifierId === 'adaptive-recursive-canary-v2-replay'
      && isSafeId(authority.sourceRunId)
      && validIso(authority.sourceCompletedAt)
      && [authority.primaryEvidenceSha256, authority.leaseEvidenceSha256,
        authority.preparationEvidenceSha256].every((value) => SHA256.test(String(value || '')))
      ? authority
      : null;
  }
  return null;
}

function normalizedHome(homeDir) {
  if (typeof homeDir !== 'string' || !homeDir || homeDir.includes('\0') || !isAbsolute(homeDir)) return null;
  if (normalize(homeDir) !== homeDir) return null;
  const resolved = resolve(homeDir);
  try {
    if (!statSync(resolved).isDirectory()) return null;
    const real = realpathSync(resolved);
    const macosVarAlias = resolved.startsWith('/var/') && real === `/private${resolved}`;
    return real === resolved || macosVarAlias ? real : null;
  } catch {
    return null;
  }
}

function assertNoSymlink(path) {
  return !existsSync(path) || !lstatSync(path).isSymbolicLink();
}

export function vnextEvidenceBankPaths(homeDir) {
  const home = normalizedHome(homeDir);
  if (!home || !assertNoSymlink(home)) {
    return refused('EVIDENCE_BANK_HOME_INVALID', 'Evidence bank home must be a normalized absolute non-symlink path.');
  }
  const directory = join(home, 'vnext-evidence-bank');
  const ledger = join(directory, 'records.jsonl');
  const lock = join(directory, '.write.lock');
  if (![directory, ledger, lock].every((path) => path.startsWith(`${home}${sep}`))) {
    return refused('EVIDENCE_BANK_PATH_ESCAPE', 'Evidence bank paths escaped the caller-provided home.');
  }
  return { status: 'OK', home, directory, ledger, lock };
}

export function createVNextEvidenceRecord(input = {}, {
  allowFixtureRecords = false
} = {}) {
  const compatibility = plainObject(input.compatibility) ? input.compatibility : {};
  const lifecycle = plainObject(input.lifecycle) ? input.lifecycle : {};
  const metrics = plainObject(input.metrics) ? input.metrics : {};
  const domains = stringSet(compatibility.domains ?? []);
  const tags = stringSet(compatibility.tags ?? []);
  const schemaVersions = stringSet(compatibility.schemaVersions ?? []);
  const models = stringSet(compatibility.models ?? []);
  const harnessSha256s = hashSet(compatibility.harnessSha256s ?? []);
  const toolEnvironmentSha256s = hashSet(compatibility.toolEnvironmentSha256s ?? []);
  const permissions = stringSet(compatibility.permissions ?? []);
  const securityRequirements = stringSet(compatibility.securityRequirements ?? []);
  const versionConstraints = stringSet(compatibility.versionConstraints ?? []);
  const verifierEvidenceHashes = hashSet(input.verifierEvidenceHashes ?? [], 64);
  const sourceIds = stringSet(input.sourceIds ?? [], 128);
  const createdAt = input.createdAt ?? input.availableAt;
  const contentCanonical = boundedJson(input.content, CONTENT_MAX_BYTES, {
    rejectSensitiveKeys: true
  });
  const callerClaims = plainObject(input.callerClaims) ? input.callerClaims : {};
  const callerClaimsCanonical = boundedJson(callerClaims, CALLER_CLAIMS_MAX_BYTES, {
    rejectSensitiveKeys: true
  });
  const authority = input.authority == null
    ? unverifiedAuthority()
    : validateAuthority(input.authority, { allowFixtureRecords });
  if (!KINDS.has(input.kind) || !validIso(input.availableAt) || !validIso(createdAt)
      || Date.parse(input.availableAt) > Date.parse(createdAt)
      || !domains || !tags || !schemaVersions || !models || !harnessSha256s
      || !toolEnvironmentSha256s || !permissions || !securityRequirements
      || !versionConstraints || !verifierEvidenceHashes || !sourceIds
      || !authority
      || sourceIds.some((id) => !isSafeId(id))
      || !LIFECYCLES.has(lifecycle.state)
      || typeof lifecycle.quarantined !== 'boolean'
      || (lifecycle.quarantineReason != null
        && (typeof lifecycle.quarantineReason !== 'string'
          || !lifecycle.quarantineReason.trim()
          || lifecycle.quarantineReason.length > 1000))
      || !plainObject(input.content) || contentCanonical == null
      || callerClaimsCanonical == null
      || !finiteOrNull(metrics.qualityDelta ?? null)
      || !finiteOrNull(metrics.costUsd ?? null)
      || !finiteOrNull(metrics.latencyMs ?? null)
      || !finiteOrNull(metrics.tokenCost ?? null)
      || !finiteOrNull(metrics.uncertainty ?? null)
      || [metrics.costUsd, metrics.latencyMs, metrics.tokenCost]
        .some((value) => value != null && value < 0)
      || (metrics.uncertainty != null && (metrics.uncertainty < 0 || metrics.uncertainty > 1))) {
    return refused('EVIDENCE_RECORD_INVALID', 'Evidence record fields violate the closed VNext contract.');
  }
  const recordId = input.recordId ?? `evidence-${sha256(canonicalVNextJson({
    kind: input.kind,
    availableAt: input.availableAt,
    content: input.content,
    verifierEvidenceHashes,
    authoritySha256: authority.authoritySha256
  })).slice(0, 24)}`;
  if (!isSafeId(recordId)) return refused('EVIDENCE_RECORD_ID_INVALID', 'Evidence record id is unsafe.');
  const component = compatibility.component == null ? null : String(compatibility.component).trim();
  if (component != null && (!component || component.length > 120)) {
    return refused('EVIDENCE_RECORD_COMPATIBILITY_INVALID', 'Compatibility component is invalid.');
  }
  const verifierEligible = authority.kind === 'verifier-owned'
    || authority.kind === 'fixture';
  const payload = {
    schemaVersion: VNEXT_EVIDENCE_RECORD_SCHEMA,
    recordId,
    kind: input.kind,
    availableAt: input.availableAt,
    createdAt,
    sourceIds,
    verifierEvidenceHashes,
    verifierEligible,
    authority,
    compatibility: {
      domains,
      tags,
      component,
      schemaVersions,
      models,
      harnessSha256s,
      toolEnvironmentSha256s,
      permissions,
      securityRequirements,
      versionConstraints
    },
    lifecycle: {
      state: lifecycle.state,
      quarantined: lifecycle.quarantined,
      quarantineReason: lifecycle.quarantineReason ?? null
    },
    metrics: {
      qualityDelta: metrics.qualityDelta ?? null,
      costUsd: metrics.costUsd ?? null,
      latencyMs: metrics.latencyMs ?? null,
      tokenCost: metrics.tokenCost ?? null,
      uncertainty: metrics.uncertainty ?? null
    },
    content: JSON.parse(contentCanonical),
    callerClaims: JSON.parse(callerClaimsCanonical)
  };
  return { status: 'OK', record: deepFreeze({ ...payload, recordSha256: sha256(canonicalVNextJson(payload)) }) };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireWriteLock(paths, { clock, staleLockMs } = {}) {
  const now = typeof clock === 'function' ? clock() : Date.now();
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const timeoutMs = staleLockMs ?? LOCK_STALE_AFTER_MS;
  if (!Number.isFinite(nowMs) || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return refused('EVIDENCE_BANK_LOCK_POLICY_INVALID', 'Evidence bank lock policy is invalid.');
  }
  if (existsSync(paths.lock)) {
    if (!assertNoSymlink(paths.lock)) {
      return refused('EVIDENCE_BANK_SYMLINK', 'Evidence bank lock may not be a symlink.');
    }
    let existing;
    try {
      existing = JSON.parse(readFileSync(paths.lock, 'utf8'));
    } catch {
      return refused('EVIDENCE_BANK_LOCKED', 'Evidence bank has an unreadable active lock.');
    }
    const stale = Number.isFinite(existing?.createdAtMs)
      && nowMs - existing.createdAtMs > timeoutMs
      && !processAlive(existing.pid);
    if (!stale) return refused('EVIDENCE_BANK_LOCKED', 'Evidence bank is locked by another writer.');
    const archive = join(
      paths.directory,
      `.write.lock.stale.${Math.trunc(nowMs)}.${sha256(canonicalVNextJson(existing)).slice(0, 12)}`
    );
    try {
      renameSync(paths.lock, archive);
    } catch (error) {
      return refused('EVIDENCE_BANK_LOCKED', 'Evidence bank stale-lock recovery lost a race.', {
        errno: error.code ?? null
      });
    }
  }
  const lock = {
    schemaVersion: 'vnext-evidence-bank-lock-v1',
    pid: process.pid,
    createdAtMs: nowMs,
    nonce: sha256(`${process.pid}:${nowMs}:${paths.ledger}`)
  };
  try {
    const descriptor = openSync(paths.lock, 'wx', 0o600);
    writeFileSync(descriptor, canonicalVNextJson(lock), 'utf8');
    return { status: 'OK', descriptor, lock };
  } catch (error) {
    return refused('EVIDENCE_BANK_LOCKED', 'Evidence bank is locked by another writer.', {
      errno: error.code ?? null
    });
  }
}

function releaseWriteLock(paths, acquired) {
  if (acquired?.descriptor != null) closeSync(acquired.descriptor);
  if (!existsSync(paths.lock)) return;
  try {
    const current = JSON.parse(readFileSync(paths.lock, 'utf8'));
    if (current.nonce === acquired?.lock?.nonce) unlinkSync(paths.lock);
  } catch {
    // Leave an unreadable or replaced lock in place for fail-closed inspection.
  }
}

export function validateVNextEvidenceRecord(record, {
  allowFixtureRecords = false
} = {}) {
  if (!exactKeys(record, [
    'schemaVersion', 'recordId', 'recordSha256', 'kind', 'availableAt', 'createdAt',
    'sourceIds', 'verifierEvidenceHashes', 'verifierEligible', 'authority', 'compatibility',
    'lifecycle', 'metrics', 'content', 'callerClaims'
  ]) || record.schemaVersion !== VNEXT_EVIDENCE_RECORD_SCHEMA || !isSafeId(record.recordId)
      || !SHA256.test(String(record.recordSha256 ?? ''))) {
    return refused('EVIDENCE_RECORD_SHAPE', 'Evidence record shape or identity is invalid.');
  }
  const rebuilt = createVNextEvidenceRecord(record, { allowFixtureRecords });
  if (rebuilt.status !== 'OK') return rebuilt;
  const expected = sha256(canonicalVNextJson(payloadOf(record)));
  if (expected !== record.recordSha256 || rebuilt.record.recordSha256 !== expected
      || rebuilt.record.verifierEligible !== record.verifierEligible) {
    return refused('EVIDENCE_RECORD_TAMPERED', 'Evidence record hash or derived eligibility does not match.');
  }
  return { status: 'OK', record };
}

export function verifyVNextEvidenceRecordAuthority(record, {
  allowFixtureRecords = false,
  authorityVerifier = null
} = {}) {
  const valid = validateVNextEvidenceRecord(record, { allowFixtureRecords });
  if (valid.status !== 'OK') return valid;
  if (record.authority.kind === 'unverified') {
    return { status: 'OK', verifierEligible: false, authority: record.authority };
  }
  if (record.authority.kind === 'fixture') {
    return allowFixtureRecords
      ? { status: 'OK', verifierEligible: true, authority: record.authority, fixtureOnly: true }
      : refused('EVIDENCE_FIXTURE_AUTHORITY_FORBIDDEN', 'Fixture evidence is disabled outside explicit tests and offline benchmarks.');
  }
  if (typeof authorityVerifier !== 'function') {
    return refused(
      'EVIDENCE_AUTHORITY_REPLAY_REQUIRED',
      'Verifier-owned evidence requires the trusted production replay adapter.'
    );
  }
  try {
    const replay = authorityVerifier(deepFreeze(structuredClone(record)));
    if (!plainObject(replay)
        || replay.status !== 'OK'
        || replay.verifierEligible !== true
        || replay.authoritySha256 !== record.authority.authoritySha256
        || replay.sourceCompletedAt !== record.authority.sourceCompletedAt
        || replay.verificationEvidenceSha256
          !== record.authority.primaryEvidenceSha256) {
      return refused(
        'EVIDENCE_AUTHORITY_REPLAY_FAILED',
        'Verifier-owned evidence did not replay to the same completed run, lease, preparation, partition, and task pack.'
      );
    }
    return replay;
  } catch (error) {
    return refused('EVIDENCE_AUTHORITY_REPLAY_FAILED', error.message);
  }
}

function parseLedger(text, {
  allowFixtureRecords = false,
  verifyAuthorities = true,
  authorityVerifier = null
} = {}) {
  if (!text.trim()) return { status: 'OK', records: [] };
  const records = [];
  const ids = new Set();
  for (const line of text.trimEnd().split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return refused('EVIDENCE_BANK_CORRUPT', 'Evidence bank contains invalid JSON.');
    }
    const valid = validateVNextEvidenceRecord(record, { allowFixtureRecords });
    if (valid.status !== 'OK' || ids.has(record.recordId)) {
      return refused('EVIDENCE_BANK_CORRUPT', 'Evidence bank contains invalid or duplicate records.');
    }
    if (verifyAuthorities && record.verifierEligible) {
      const authority = verifyVNextEvidenceRecordAuthority(record, {
        allowFixtureRecords,
        authorityVerifier
      });
      if (authority.status !== 'OK') {
        return refused(
          'EVIDENCE_BANK_AUTHORITY_INVALID',
          'Evidence bank contains a verifier-eligible record whose source proof no longer replays.',
          { recordId: record.recordId, authority }
        );
      }
    }
    ids.add(record.recordId);
    records.push(deepFreeze(record));
  }
  return { status: 'OK', records };
}

export function readVNextEvidenceBank(homeDir, {
  allowFixtureRecords = false,
  verifyAuthorities = true,
  authorityVerifier = null
} = {}) {
  const paths = vnextEvidenceBankPaths(homeDir);
  if (paths.status !== 'OK') return paths;
  if (existsSync(paths.directory)
      && (!assertNoSymlink(paths.directory) || !lstatSync(paths.directory).isDirectory())) {
    return refused('EVIDENCE_BANK_STORAGE_INVALID', 'Evidence bank storage must be a real directory.');
  }
  if (!existsSync(paths.ledger)) return { status: 'OK', records: [], ledgerSha256: sha256('') };
  if (!assertNoSymlink(paths.directory) || lstatSync(paths.ledger).isSymbolicLink()) {
    return refused('EVIDENCE_BANK_SYMLINK', 'Evidence bank storage may not use symlinks.');
  }
  const text = readFileSync(paths.ledger, 'utf8');
  const parsed = parseLedger(text, {
    allowFixtureRecords,
    verifyAuthorities,
    authorityVerifier
  });
  return parsed.status === 'OK'
    ? deepFreeze({ ...parsed, ledgerSha256: sha256(text) })
    : parsed;
}

export function appendVNextEvidenceRecord(homeDir, candidate, options = {}) {
  const paths = vnextEvidenceBankPaths(homeDir);
  if (paths.status !== 'OK') return paths;
  const allowFixtureRecords = options.allowFixtureRecords === true;
  const authorityVerifier = options.authorityVerifier ?? null;
  const valid = validateVNextEvidenceRecord(candidate, { allowFixtureRecords });
  if (valid.status !== 'OK') return valid;
  if (candidate.verifierEligible) {
    const authority = verifyVNextEvidenceRecordAuthority(candidate, {
      allowFixtureRecords,
      authorityVerifier
    });
    if (authority.status !== 'OK') return authority;
  }
  try {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refused('EVIDENCE_BANK_STORAGE_INVALID', 'Evidence bank directory could not be prepared.', { errno: error.code ?? null });
  }
  if (!assertNoSymlink(paths.directory) || !lstatSync(paths.directory).isDirectory()) {
    return refused('EVIDENCE_BANK_STORAGE_INVALID', 'Evidence bank storage must be a real directory.');
  }
  if ((existsSync(paths.ledger) && !assertNoSymlink(paths.ledger))
      || (existsSync(paths.lock) && !assertNoSymlink(paths.lock))) {
    return refused('EVIDENCE_BANK_SYMLINK', 'Evidence bank ledger and lock may not be symlinks.');
  }
  const acquired = acquireWriteLock(paths, options);
  if (acquired.status !== 'OK') return acquired;
  const temporary = join(paths.directory, `.records.${process.pid}.${candidate.recordSha256.slice(0, 12)}.tmp`);
  try {
    const currentText = existsSync(paths.ledger) ? readFileSync(paths.ledger, 'utf8') : '';
    const parsed = parseLedger(currentText, {
      allowFixtureRecords,
      verifyAuthorities: true,
      authorityVerifier
    });
    if (parsed.status !== 'OK') return parsed;
    const existing = parsed.records.find((record) => record.recordId === candidate.recordId);
    if (existing) {
      return existing.recordSha256 === candidate.recordSha256
        ? { status: 'OK', record: existing, appended: false, ledgerSha256: sha256(currentText) }
        : refused('EVIDENCE_RECORD_CONFLICT', 'An immutable record id already exists with different bytes.');
    }
    const nextText = `${currentText}${currentText && !currentText.endsWith('\n') ? '\n' : ''}${canonicalVNextJson(candidate)}\n`;
    writeFileSync(temporary, nextText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, paths.ledger);
    return { status: 'OK', record: candidate, appended: true, ledgerSha256: sha256(nextText) };
  } catch (error) {
    return refused('EVIDENCE_BANK_WRITE_FAILED', 'Evidence bank persistence failed.', { errno: error.code ?? null });
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    releaseWriteLock(paths, acquired);
  }
}
