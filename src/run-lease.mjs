import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { verifyRunLeaseHeartbeat } from './run-lease-heartbeat.mjs';

export const RUN_LEASE_SCHEMA = 'loop-factory-run-lease-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const ARCHIVED_LEASE_RE = /^SUPERVISOR_LEASE\.(stale|renewed|released)-r(\d+)-([a-f0-9]{12})\.json$/;
const TRANSITION_SCHEMA = 'loop-factory-run-lease-transition-v1';
const TRANSITION_FILE = 'SUPERVISOR_LEASE.transition.json';

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function paths(homeDir, runId) {
  const root = resolve(homeDir, 'runs');
  const run = resolve(root, runId);
  if (!isSafeId(runId) || !within(root, run)) throw new Error('invalid run lease path');
  return {
    run,
    active: resolve(run, 'SUPERVISOR_LEASE.json'),
    mutex: resolve(run, 'SUPERVISOR_LEASE.lock'),
    transition: resolve(run, TRANSITION_FILE)
  };
}

function payload(record) {
  return {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    ownerId: record.ownerId,
    nonce: record.nonce,
    pid: record.pid,
    host: record.host,
    revision: record.revision,
    acquiredAt: record.acquiredAt,
    renewedAt: record.renewedAt,
    expiresAt: record.expiresAt,
    previousLeaseSha256: record.previousLeaseSha256
  };
}

export function validateRunLease(record, { now = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || canonicalVNextJson(Object.keys(record).sort()) !== canonicalVNextJson([
        'schemaVersion',
        'runId',
        'ownerId',
        'nonce',
        'pid',
        'host',
        'revision',
        'acquiredAt',
        'renewedAt',
        'expiresAt',
        'previousLeaseSha256',
        'leaseSha256'
      ].sort())
      || record.schemaVersion !== RUN_LEASE_SCHEMA
      || !isSafeId(record.runId)
      || !isSafeId(record.ownerId)
      || !isSafeId(record.nonce)
      || !Number.isInteger(record.pid)
      || record.pid < 1
      || typeof record.host !== 'string'
      || record.host.length < 1
      || record.host.length > 240
      || !Number.isInteger(record.revision)
      || record.revision < 1
      || !Number.isFinite(Date.parse(record.acquiredAt))
      || !Number.isFinite(Date.parse(record.renewedAt))
      || !Number.isFinite(Date.parse(record.expiresAt))
      || Date.parse(record.expiresAt) <= Date.parse(record.renewedAt)
      || (record.previousLeaseSha256 != null
        && !SHA256.test(String(record.previousLeaseSha256)))
      || record.leaseSha256 !== sha256(canonicalVNextJson(payload(record)))) {
    return { status: 'REFUSED', code: 'RUN_LEASE_INVALID' };
  }
  return {
    status: 'OK',
    lease: record,
    expired: now == null ? null : Date.parse(record.expiresAt) <= Date.parse(now)
  };
}

function mutexOwner(lockPath) {
  return resolve(lockPath, 'owner.json');
}

function acquireMutex(pathSet, nowMs, staleMutexMs) {
  mkdirSync(pathSet.run, { recursive: true });
  try {
    mkdirSync(pathSet.mutex);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = nowMs - statSync(pathSet.mutex).mtimeMs;
    if (age <= staleMutexMs) return null;
    const archive = resolve(pathSet.run, `SUPERVISOR_LEASE.lock.stale-${Math.floor(nowMs)}`);
    renameSync(pathSet.mutex, archive);
    mkdirSync(pathSet.mutex);
  }
  const token = randomUUID();
  writeFileSync(
    mutexOwner(pathSet.mutex),
    JSON.stringify({ pid: process.pid, at: nowMs, token }),
    { mode: 0o600 }
  );
  return { path: pathSet.mutex, token };
}

function releaseMutex(handle) {
  const lockPath = handle?.path;
  if (!lockPath || !existsSync(lockPath)) return false;
  const owner = mutexOwner(lockPath);
  let ownerRecord;
  try {
    ownerRecord = JSON.parse(readFileSync(owner, 'utf8'));
  } catch {
    return false;
  }
  if (ownerRecord.token !== handle.token) return false;
  if (existsSync(owner)) {
    const ownerBytes = readFileSync(owner);
    renameSync(
      owner,
      `${lockPath}.owner-released-${sha256(ownerBytes).slice(0, 12)}.json`
    );
  }
  try {
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function acquireRunLeaseMutex({
  homeDir,
  runId,
  nowMs = Date.now(),
  staleMutexMs = 30000
} = {}) {
  try {
    if (!Number.isFinite(nowMs) || !Number.isFinite(staleMutexMs)
        || staleMutexMs < 1) {
      return { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_REQUEST_INVALID' };
    }
    const handle = acquireMutex(paths(homeDir, runId), nowMs, staleMutexMs);
    return handle
      ? { status: 'OK', handle }
      : { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_HELD' };
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_ACQUIRE_FAILED', message: error.message };
  }
}

export function releaseRunLeaseMutex(handle) {
  return releaseMutex(handle)
    ? { status: 'OK' }
    : { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_RELEASE_CONFLICT' };
}

function readLease(active) {
  if (!existsSync(active) || lstatSync(active).isSymbolicLink()) return null;
  try { return JSON.parse(readFileSync(active, 'utf8')); } catch { return null; }
}

function leaseFiles(pathSet) {
  if (!existsSync(pathSet.run)) return [];
  const records = [];
  for (const name of readdirSync(pathSet.run).sort()) {
    const archived = name.match(ARCHIVED_LEASE_RE);
    if (name !== 'SUPERVISOR_LEASE.json' && !archived) continue;
    const path = resolve(pathSet.run, name);
    if (!within(pathSet.run, path) || lstatSync(path).isSymbolicLink()) {
      throw new Error(`unsafe run lease history entry: ${name}`);
    }
    const bytes = readFileSync(path);
    let lease;
    try { lease = JSON.parse(bytes); } catch {
      throw new Error(`invalid run lease history JSON: ${name}`);
    }
    records.push({
      name,
      kind: name === 'SUPERVISOR_LEASE.json' ? 'active' : archived[1],
      revisionFromName: archived ? Number(archived[2]) : null,
      hashPrefixFromName: archived ? archived[3] : null,
      contentSha256: sha256(bytes),
      lease
    });
  }
  return records;
}

export function verifyRunLeaseHistory({ homeDir, runId } = {}) {
  try {
    const pathSet = paths(homeDir, runId);
    const files = leaseFiles(pathSet);
    if (files.length === 0) {
      return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_MISSING' };
    }
    for (const file of files) {
      if (validateRunLease(file.lease).status !== 'OK'
          || (file.kind !== 'active'
            && (file.revisionFromName !== file.lease.revision
              || file.hashPrefixFromName !== file.lease.leaseSha256.slice(0, 12)))) {
        return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_INVALID' };
      }
    }
    files.sort((left, right) => left.lease.revision - right.lease.revision);
    if (files.filter((file) => file.kind === 'active').length > 1
        || files[0].lease.revision !== 1
        || files[0].lease.previousLeaseSha256 !== null) {
      return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_CHAIN_INVALID' };
    }
    for (let index = 1; index < files.length; index += 1) {
      const previous = files[index - 1].lease;
      const current = files[index].lease;
      if (current.revision !== previous.revision + 1
          || current.previousLeaseSha256 !== previous.leaseSha256) {
        return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_CHAIN_INVALID' };
      }
    }
    const active = files.filter((file) => file.kind === 'active');
    if (active.length === 1 && active[0] !== files.at(-1)) {
      return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_ACTIVE_NOT_LATEST' };
    }
    const history = files.map((file) => ({
      name: file.name,
      kind: file.kind,
      revision: file.lease.revision,
      leaseSha256: file.lease.leaseSha256,
      contentSha256: file.contentSha256,
      ownerBindingSha256: sha256(canonicalVNextJson({
        ownerId: file.lease.ownerId,
        nonce: file.lease.nonce,
        pid: file.lease.pid,
        host: file.lease.host,
        acquiredAt: file.lease.acquiredAt
      }))
    }));
    return {
      status: 'OK',
      history,
      latestLease: files.at(-1).lease,
      latestKind: files.at(-1).kind,
      historySha256: sha256(canonicalVNextJson(history))
    };
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_FAILED', message: error.message };
  }
}

function writeExclusive(path, record) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(record, null, 2));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function newRecord({ runId, ownerId, nonce, pid, host, revision, acquiredAt, renewedAt, expiresAt, previousLeaseSha256 }) {
  const base = {
    schemaVersion: RUN_LEASE_SCHEMA,
    runId,
    ownerId,
    nonce,
    pid,
    host,
    revision,
    acquiredAt,
    renewedAt,
    expiresAt,
    previousLeaseSha256
  };
  return { ...base, leaseSha256: sha256(canonicalVNextJson(base)) };
}

function transitionPayload(transition) {
  const { transitionSha256, ...payload } = transition;
  return payload;
}

function validateTransition(transition) {
  const keys = [
    'schemaVersion', 'runId', 'kind', 'previousLeaseSha256',
    'archiveName', 'nextLease', 'createdAt', 'transitionSha256'
  ];
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)
      || Object.keys(transition).length !== keys.length
      || !keys.every((key) => Object.hasOwn(transition, key))
      || transition.schemaVersion !== TRANSITION_SCHEMA
      || !isSafeId(transition.runId)
      || !['renewed', 'stale'].includes(transition.kind)
      || !SHA256.test(String(transition.previousLeaseSha256 || ''))
      || transition.archiveName !== `SUPERVISOR_LEASE.${transition.kind}-r${transition.nextLease?.revision - 1}-${String(transition.previousLeaseSha256).slice(0, 12)}.json`
      || validateRunLease(transition.nextLease).status !== 'OK'
      || transition.nextLease.runId !== transition.runId
      || transition.nextLease.previousLeaseSha256 !== transition.previousLeaseSha256
      || !Number.isFinite(Date.parse(transition.createdAt))
      || transition.transitionSha256
        !== sha256(canonicalVNextJson(transitionPayload(transition)))) {
    return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_INVALID' };
  }
  return { status: 'OK', transition };
}

function readTransition(pathSet) {
  if (!existsSync(pathSet.transition) || lstatSync(pathSet.transition).isSymbolicLink()) {
    return null;
  }
  try { return JSON.parse(readFileSync(pathSet.transition, 'utf8')); } catch { return null; }
}

function transitionArchive(pathSet, transition) {
  const archive = resolve(pathSet.run, transition.archiveName);
  return within(pathSet.run, archive) ? archive : null;
}

function completeTransition(pathSet, transition) {
  const checked = validateTransition(transition);
  const archive = checked.status === 'OK' ? transitionArchive(pathSet, transition) : null;
  if (checked.status !== 'OK' || !archive) return checked;
  let active = readLease(pathSet.active);
  if (active && active.leaseSha256 === transition.previousLeaseSha256) {
    if (existsSync(archive)) {
      return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_DUPLICATE_ARCHIVE' };
    }
    renameSync(pathSet.active, archive);
    active = null;
  }
  if (!active) {
    if (!existsSync(archive) || lstatSync(archive).isSymbolicLink()) {
      return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_ARCHIVE_MISSING' };
    }
    const predecessor = JSON.parse(readFileSync(archive, 'utf8'));
    if (validateRunLease(predecessor).status !== 'OK'
        || predecessor.leaseSha256 !== transition.previousLeaseSha256) {
      return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_PREDECESSOR_INVALID' };
    }
    writeExclusive(pathSet.active, transition.nextLease);
    active = transition.nextLease;
  }
  if (active.leaseSha256 !== transition.nextLease.leaseSha256) {
    return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_SUCCESSOR_CONFLICT' };
  }
  const completed = resolve(
    pathSet.run,
    `SUPERVISOR_LEASE.transition-complete-r${transition.nextLease.revision}-${transition.transitionSha256.slice(0, 12)}.json`
  );
  if (existsSync(completed)) {
    return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_RECEIPT_CONFLICT' };
  }
  renameSync(pathSet.transition, completed);
  return { status: 'OK', lease: active, transitionRecovered: true };
}

function recoverTransition(pathSet) {
  if (!existsSync(pathSet.transition)) return { status: 'OK', recovered: false };
  const transition = readTransition(pathSet);
  if (!transition) return { status: 'REFUSED', code: 'RUN_LEASE_TRANSITION_JSON_INVALID' };
  return completeTransition(pathSet, transition);
}

function createTransition({ pathSet, current, next, kind, createdAt, observer }) {
  const core = {
    schemaVersion: TRANSITION_SCHEMA,
    runId: current.runId,
    kind,
    previousLeaseSha256: current.leaseSha256,
    archiveName: `SUPERVISOR_LEASE.${kind}-r${current.revision}-${current.leaseSha256.slice(0, 12)}.json`,
    nextLease: next,
    createdAt
  };
  const transition = {
    ...core,
    transitionSha256: sha256(canonicalVNextJson(core))
  };
  writeExclusive(pathSet.transition, transition);
  observer?.('after-transition-write', transition);
  const archive = transitionArchive(pathSet, transition);
  renameSync(pathSet.active, archive);
  observer?.('after-archive-rename', transition);
  writeExclusive(pathSet.active, next);
  observer?.('after-active-write', transition);
  const completed = resolve(
    pathSet.run,
    `SUPERVISOR_LEASE.transition-complete-r${next.revision}-${transition.transitionSha256.slice(0, 12)}.json`
  );
  renameSync(pathSet.transition, completed);
  observer?.('after-transition-complete', transition);
  return { status: 'OK', lease: next };
}

function heartbeatProtects(homeDir, lease, now) {
  return verifyRunLeaseHeartbeat({
    homeDir,
    runId: lease.runId,
    lease,
    now
  }).status === 'OK';
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function heartbeatProvesLocalOrphan(homeDir, lease, now) {
  if (lease.host !== hostname() || processAlive(lease.pid)) return false;
  const heartbeat = verifyRunLeaseHeartbeat({
    homeDir,
    runId: lease.runId,
    lease,
    now,
    requireFresh: false
  });
  return heartbeat.status === 'OK' && heartbeat.fresh === false;
}

export function acquireRunLease({
  homeDir,
  runId,
  ownerId,
  nonce,
  pid = process.pid,
  host = hostname(),
  now = new Date().toISOString(),
  ttlMs = 120000,
  staleMutexMs = 30000,
  transitionObserver = null
} = {}) {
  try {
    if (!isSafeId(ownerId) || !isSafeId(nonce)
        || !Number.isInteger(ttlMs) || ttlMs < 1000
        || !Number.isFinite(Date.parse(now))
        || !(transitionObserver == null || typeof transitionObserver === 'function')) {
      return { status: 'REFUSED', code: 'RUN_LEASE_REQUEST_INVALID' };
    }
    const pathSet = paths(homeDir, runId);
    const nowMs = Date.parse(now);
    const mutex = acquireMutex(pathSet, nowMs, staleMutexMs);
    if (!mutex) return { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_HELD' };
    try {
      const recovered = recoverTransition(pathSet);
      if (recovered.status !== 'OK') return recovered;
      const current = readLease(pathSet.active);
      let predecessor = current;
      if (!current) {
        const names = existsSync(pathSet.run) ? readdirSync(pathSet.run) : [];
        const hasHistory = names.some((name) => ARCHIVED_LEASE_RE.test(name));
        if (hasHistory) {
          const history = verifyRunLeaseHistory({ homeDir, runId });
          if (history.status !== 'OK') {
            return { status: 'REFUSED', code: 'RUN_LEASE_HISTORY_INVALID' };
          }
          const latest = validateRunLease(history.latestLease, { now });
          const orphanedTransition = ['renewed', 'stale'].includes(history.latestKind)
            && latest.status === 'OK'
            && latest.expired
            && !heartbeatProtects(homeDir, history.latestLease, now);
          if (history.latestKind !== 'released' && !orphanedTransition) {
            return {
              status: 'REFUSED',
              code: 'RUN_LEASE_ORPHAN_TRANSITION_LIVE'
            };
          }
          predecessor = history.latestLease;
        }
      }
      if (current) {
        const checked = validateRunLease(current, { now });
        if (checked.status !== 'OK') {
          return { status: 'REFUSED', code: 'RUN_LEASE_ACTIVE_INVALID' };
        }
        const localOrphan = heartbeatProvesLocalOrphan(homeDir, current, now);
        if (!checked.expired && !localOrphan) {
          if (current.ownerId === ownerId && current.nonce === nonce) {
            return { status: 'OK', lease: current, idempotent: true };
          }
          return {
            status: 'REFUSED',
            code: 'RUN_LEASE_HELD',
            ownerId: current.ownerId,
            expiresAt: current.expiresAt
          };
        }
        if (heartbeatProtects(homeDir, current, now)) {
          return {
            status: 'REFUSED',
            code: 'RUN_LEASE_HEARTBEAT_LIVE',
            ownerId: current.ownerId,
            expiresAt: current.expiresAt
          };
        }
      }
      const record = newRecord({
        runId,
        ownerId,
        nonce,
        pid,
        host,
        revision: predecessor ? predecessor.revision + 1 : 1,
        acquiredAt: now,
        renewedAt: now,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        previousLeaseSha256: predecessor?.leaseSha256 || null
      });
      if (current) {
        const transitioned = createTransition({
          pathSet,
          current,
          next: record,
          kind: 'stale',
          createdAt: now,
          observer: transitionObserver
        });
        if (transitioned.status !== 'OK') return transitioned;
      } else {
        writeExclusive(pathSet.active, record);
      }
      return { status: 'OK', lease: record, idempotent: false };
    } finally {
      releaseMutex(mutex);
    }
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_ACQUIRE_FAILED', message: error.message };
  }
}

export function renewRunLease({
  homeDir,
  runId,
  ownerId,
  nonce,
  expectedLeaseSha256,
  now = new Date().toISOString(),
  ttlMs = 120000,
  staleMutexMs = 30000,
  transitionObserver = null
} = {}) {
  try {
    const pathSet = paths(homeDir, runId);
    const nowMs = Date.parse(now);
    const mutex = acquireMutex(pathSet, nowMs, staleMutexMs);
    if (!mutex) return { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_HELD' };
    try {
      const recovered = recoverTransition(pathSet);
      if (recovered.status !== 'OK') return recovered;
      const current = readLease(pathSet.active);
      const checked = validateRunLease(current, { now });
      if (checked.status !== 'OK'
          || (checked.expired && !heartbeatProtects(homeDir, current, now))
          || current.ownerId !== ownerId
          || current.nonce !== nonce
          || current.leaseSha256 !== expectedLeaseSha256
          || !(transitionObserver == null || typeof transitionObserver === 'function')) {
        return { status: 'REFUSED', code: 'RUN_LEASE_RENEW_CONFLICT' };
      }
      const record = newRecord({
        runId,
        ownerId,
        nonce,
        pid: current.pid,
        host: current.host,
        revision: current.revision + 1,
        acquiredAt: current.acquiredAt,
        renewedAt: now,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        previousLeaseSha256: current.leaseSha256
      });
      return createTransition({
        pathSet,
        current,
        next: record,
        kind: 'renewed',
        createdAt: now,
        observer: transitionObserver
      });
    } finally {
      releaseMutex(mutex);
    }
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_RENEW_FAILED', message: error.message };
  }
}

export function releaseRunLease({ homeDir, runId, ownerId, nonce, expectedLeaseSha256 } = {}) {
  try {
    const pathSet = paths(homeDir, runId);
    const mutex = acquireMutex(pathSet, Date.now(), 30000);
    if (!mutex) return { status: 'REFUSED', code: 'RUN_LEASE_MUTEX_HELD' };
    try {
      const recovered = recoverTransition(pathSet);
      if (recovered.status !== 'OK') return recovered;
      const current = readLease(pathSet.active);
      if (validateRunLease(current).status !== 'OK'
          || current.ownerId !== ownerId
          || current.nonce !== nonce
          || current.leaseSha256 !== expectedLeaseSha256) {
        return { status: 'REFUSED', code: 'RUN_LEASE_RELEASE_CONFLICT' };
      }
      const archived = resolve(
        pathSet.run,
        `SUPERVISOR_LEASE.released-r${current.revision}-${current.leaseSha256.slice(0, 12)}.json`
      );
      renameSync(pathSet.active, archived);
      return { status: 'OK', archivedPath: archived };
    } finally {
      releaseMutex(mutex);
    }
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_RELEASE_FAILED', message: error.message };
  }
}

export function signalRunLeaseOwner({
  homeDir,
  runId,
  signal = 'SIGTERM',
  localHost = hostname(),
  sendSignal = process.kill.bind(process)
} = {}) {
  try {
    if (!['SIGINT', 'SIGTERM'].includes(signal) || typeof sendSignal !== 'function') {
      return { status: 'REFUSED', code: 'RUN_LEASE_SIGNAL_REQUEST_INVALID' };
    }
    const current = readLease(paths(homeDir, runId).active);
    if (!current) {
      return { status: 'OK', disposition: 'NO_ACTIVE_SUPERVISOR', signaled: false };
    }
    const checked = validateRunLease(current);
    if (checked.status !== 'OK') {
      return { status: 'REFUSED', code: 'RUN_LEASE_SIGNAL_ACTIVE_INVALID' };
    }
    if (current.host !== localHost) {
      return {
        status: 'OK',
        disposition: 'REMOTE_SUPERVISOR_STOP_FILE_ONLY',
        signaled: false
      };
    }
    if (checked.expired || verifyRunLeaseHeartbeat({
      homeDir,
      runId,
      lease: current
    }).status !== 'OK') {
      return {
        status: 'OK',
        disposition: 'SUPERVISOR_HEARTBEAT_NOT_LIVE',
        signaled: false
      };
    }
    try {
      sendSignal(current.pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') {
        return { status: 'OK', disposition: 'SUPERVISOR_ALREADY_EXITED', signaled: false };
      }
      throw error;
    }
    sendSignal(current.pid, signal);
    return {
      status: 'OK',
      disposition: 'SUPERVISOR_SIGNALLED',
      signaled: true,
      pid: current.pid,
      signal,
      leaseSha256: current.leaseSha256
    };
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_SIGNAL_FAILED', message: error.message };
  }
}
