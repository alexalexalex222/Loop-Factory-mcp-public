import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const RUN_LEASE_HEARTBEAT_SCHEMA = 'loop-factory-run-lease-heartbeat-v1';
export const RUN_LEASE_HEARTBEAT_CONTROL_SCHEMA =
  'loop-factory-run-lease-heartbeat-control-v1';
export const RUN_LEASE_HEARTBEAT_STOP_SCHEMA =
  'loop-factory-run-lease-heartbeat-stop-v1';

const ACTIVE_FILE = 'SUPERVISOR_HEARTBEAT.json';
const CONTROL_FILE = 'SUPERVISOR_HEARTBEAT.control.json';
const STOPPED_FILE = 'SUPERVISOR_HEARTBEAT.stopped.json';
const WORKER_PATH = fileURLToPath(
  new URL('../scripts/run-lease-heartbeat.mjs', import.meta.url)
);

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function paths(homeDir, runId) {
  const root = resolve(homeDir, 'runs');
  const run = resolve(root, runId);
  if (!isSafeId(runId) || !within(root, run)) throw new Error('invalid heartbeat path');
  return {
    run,
    active: resolve(run, ACTIVE_FILE),
    control: resolve(run, CONTROL_FILE),
    stopped: resolve(run, STOPPED_FILE)
  };
}

function atomicWrite(path, content, mode = 0o600) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { mode, flag: 'wx' });
  renameSync(temporary, path);
}

function heartbeatPayload(record) {
  const { heartbeatSha256, ...payload } = record;
  return payload;
}

export function createRunLeaseHeartbeatBinding(lease) {
  if (!lease || !isSafeId(lease.runId) || !isSafeId(lease.ownerId)
      || !isSafeId(lease.nonce) || !Number.isInteger(lease.pid) || lease.pid < 1
      || typeof lease.host !== 'string' || !Number.isFinite(Date.parse(lease.acquiredAt))) {
    return null;
  }
  const core = {
    runId: lease.runId,
    ownerId: lease.ownerId,
    nonce: lease.nonce,
    supervisorPid: lease.pid,
    supervisorHost: lease.host,
    acquiredAt: lease.acquiredAt
  };
  const authority = {
    ownerId: lease.ownerId,
    nonce: lease.nonce,
    pid: lease.pid,
    host: lease.host,
    acquiredAt: lease.acquiredAt
  };
  return { ...core, authoritySha256: sha256(canonicalVNextJson(authority)) };
}

export function validateRunLeaseHeartbeat(record) {
  const keys = [
    'schemaVersion', 'runId', 'ownerId', 'nonce', 'supervisorPid',
    'supervisorHost', 'acquiredAt', 'authoritySha256', 'heartbeatPid',
    'sequence', 'observedAt', 'expiresAt', 'previousHeartbeatSha256',
    'heartbeatSha256'
  ];
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== keys.length
      || !keys.every((key) => Object.hasOwn(record, key))
      || record.schemaVersion !== RUN_LEASE_HEARTBEAT_SCHEMA
      || !isSafeId(record.runId) || !isSafeId(record.ownerId) || !isSafeId(record.nonce)
      || !Number.isInteger(record.supervisorPid) || record.supervisorPid < 1
      || typeof record.supervisorHost !== 'string' || record.supervisorHost.length < 1
      || !Number.isFinite(Date.parse(record.acquiredAt))
      || !/^[a-f0-9]{64}$/.test(String(record.authoritySha256 || ''))
      || !Number.isInteger(record.heartbeatPid) || record.heartbeatPid < 1
      || !Number.isInteger(record.sequence) || record.sequence < 0
      || !Number.isFinite(Date.parse(record.observedAt))
      || !Number.isFinite(Date.parse(record.expiresAt))
      || Date.parse(record.expiresAt) <= Date.parse(record.observedAt)
      || !(record.previousHeartbeatSha256 == null
        || /^[a-f0-9]{64}$/.test(record.previousHeartbeatSha256))
      || record.heartbeatSha256 !== sha256(canonicalVNextJson(heartbeatPayload(record)))) {
    return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_INVALID' };
  }
  const binding = createRunLeaseHeartbeatBinding({
    runId: record.runId,
    ownerId: record.ownerId,
    nonce: record.nonce,
    pid: record.supervisorPid,
    host: record.supervisorHost,
    acquiredAt: record.acquiredAt
  });
  return binding?.authoritySha256 === record.authoritySha256
    ? { status: 'OK', heartbeat: record, binding }
    : { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_AUTHORITY_INVALID' };
}

function readHeartbeat(path) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function verifyRunLeaseHeartbeat({
  homeDir,
  runId,
  lease = null,
  binding = null,
  now = new Date().toISOString(),
  requireFresh = true
} = {}) {
  try {
    if (!Number.isFinite(Date.parse(now))) {
      return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_TIME_INVALID' };
    }
    const record = readHeartbeat(paths(homeDir, runId).active);
    const checked = validateRunLeaseHeartbeat(record);
    const expected = binding ?? createRunLeaseHeartbeatBinding(lease);
    if (checked.status !== 'OK' || !expected
        || record.authoritySha256 !== expected.authoritySha256
        || (requireFresh && Date.parse(record.expiresAt) <= Date.parse(now))) {
      return {
        status: 'REFUSED',
        code: checked.code || (record ? 'RUN_LEASE_HEARTBEAT_STALE' : 'RUN_LEASE_HEARTBEAT_MISSING')
      };
    }
    return {
      status: 'OK',
      heartbeat: record,
      heartbeatSha256: record.heartbeatSha256,
      fresh: Date.parse(record.expiresAt) > Date.parse(now)
    };
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_VERIFY_FAILED', message: error.message };
  }
}

export function persistRunLeaseHeartbeat({
  homeDir,
  binding,
  heartbeatPid = process.pid,
  now = new Date().toISOString(),
  timeoutMs = 30_000
} = {}) {
  try {
    if (!binding || !isSafeId(binding.runId)
        || !Number.isInteger(heartbeatPid) || heartbeatPid < 1
        || !Number.isFinite(Date.parse(now))
        || !Number.isInteger(timeoutMs) || timeoutMs < 1000) {
      return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_REQUEST_INVALID' };
    }
    const pathSet = paths(homeDir, binding.runId);
    mkdirSync(pathSet.run, { recursive: true });
    const previous = readHeartbeat(pathSet.active);
    const previousValid = validateRunLeaseHeartbeat(previous).status === 'OK'
      && previous.authoritySha256 === binding.authoritySha256;
    const core = {
      schemaVersion: RUN_LEASE_HEARTBEAT_SCHEMA,
      runId: binding.runId,
      ownerId: binding.ownerId,
      nonce: binding.nonce,
      supervisorPid: binding.supervisorPid,
      supervisorHost: binding.supervisorHost,
      acquiredAt: binding.acquiredAt,
      authoritySha256: binding.authoritySha256,
      heartbeatPid,
      sequence: previousValid ? previous.sequence + 1 : 0,
      observedAt: now,
      expiresAt: new Date(Date.parse(now) + timeoutMs).toISOString(),
      previousHeartbeatSha256: previousValid ? previous.heartbeatSha256 : null
    };
    const record = {
      ...core,
      heartbeatSha256: sha256(canonicalVNextJson(core))
    };
    atomicWrite(pathSet.active, `${canonicalVNextJson(record)}\n`);
    return { status: 'OK', heartbeat: record };
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_WRITE_FAILED', message: error.message };
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopPayload(record) {
  const { stopSha256, ...payload } = record;
  return payload;
}

function validateHeartbeatStop(record, { binding, controlSha256, heartbeatPid }) {
  const keys = [
    'schemaVersion', 'runId', 'authoritySha256', 'controlSha256',
    'heartbeatPid', 'stoppedAt', 'stopSha256'
  ];
  return record && typeof record === 'object' && !Array.isArray(record)
      && Object.keys(record).length === keys.length
      && keys.every((key) => Object.hasOwn(record, key))
      && record.schemaVersion === RUN_LEASE_HEARTBEAT_STOP_SCHEMA
      && record.runId === binding.runId
      && record.authoritySha256 === binding.authoritySha256
      && record.controlSha256 === controlSha256
      && record.heartbeatPid === heartbeatPid
      && Number.isFinite(Date.parse(record.stoppedAt))
      && record.stopSha256 === sha256(canonicalVNextJson(stopPayload(record)))
    ? { status: 'OK', receipt: record }
    : { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_STOP_INVALID' };
}

export function startRunLeaseHeartbeat({
  homeDir,
  lease,
  intervalMs = 5_000,
  timeoutMs = 30_000
} = {}) {
  try {
    const binding = createRunLeaseHeartbeatBinding(lease);
    if (!binding || !Number.isInteger(intervalMs) || intervalMs < 100
        || !Number.isInteger(timeoutMs) || timeoutMs < intervalMs * 2) {
      return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_CONFIG_INVALID' };
    }
    const pathSet = paths(homeDir, binding.runId);
    mkdirSync(pathSet.run, { recursive: true });
    if (existsSync(pathSet.stopped)) rmSync(pathSet.stopped, { force: true });
    const controlCore = {
      schemaVersion: RUN_LEASE_HEARTBEAT_CONTROL_SCHEMA,
      binding,
      intervalMs,
      timeoutMs
    };
    const control = {
      ...controlCore,
      controlSha256: sha256(canonicalVNextJson(controlCore))
    };
    atomicWrite(pathSet.control, `${canonicalVNextJson(control)}\n`);
    const child = spawn(process.execPath, [
      WORKER_PATH,
      '--home', resolve(homeDir),
      '--run', binding.runId,
      '--control-sha256', control.controlSha256
    ], {
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', () => {});
    child.unref();
    const deadline = Date.now() + 2_000;
    let checked = { status: 'REFUSED' };
    while (Date.now() < deadline) {
      checked = verifyRunLeaseHeartbeat({ homeDir, runId: binding.runId, binding });
      if (checked.status === 'OK') break;
      sleepSync(10);
    }
    if (checked.status !== 'OK') {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_START_FAILED' };
    }
    return {
      status: 'OK',
      binding,
      childPid: child.pid,
      intervalMs,
      timeoutMs,
      initialHeartbeatSha256: checked.heartbeatSha256,
      stop() {
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
        const deadline = Date.now() + 1_000;
        let stopped = null;
        while (Date.now() < deadline) {
          try { stopped = JSON.parse(readFileSync(pathSet.stopped, 'utf8')); } catch { stopped = null; }
          const checkedStop = validateHeartbeatStop(stopped, {
            binding,
            controlSha256: control.controlSha256,
            heartbeatPid: child.pid
          });
          if (checkedStop.status === 'OK') {
            const final = verifyRunLeaseHeartbeat({
              homeDir,
              runId: binding.runId,
              binding,
              requireFresh: false
            });
            return final.status === 'OK'
              ? {
                  ...final,
                  stopped: true,
                  childPid: child.pid,
                  stopReceiptSha256: checkedStop.receipt.stopSha256
                }
              : final;
          }
          sleepSync(20);
        }
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
        return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_STOP_FAILED' };
      }
    };
  } catch (error) {
    return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_START_FAILED', message: error.message };
  }
}

export function runLeaseHeartbeatWorker({
  homeDir,
  runId,
  controlSha256,
  clock = () => new Date().toISOString(),
  isParentAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  }
} = {}) {
  const pathSet = paths(homeDir, runId);
  const control = JSON.parse(readFileSync(pathSet.control, 'utf8'));
  const core = structuredClone(control);
  delete core.controlSha256;
  if (control.schemaVersion !== RUN_LEASE_HEARTBEAT_CONTROL_SCHEMA
      || control.controlSha256 !== controlSha256
      || control.controlSha256 !== sha256(canonicalVNextJson(core))
      || control.binding?.runId !== runId) {
    return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_CONTROL_INVALID' };
  }
  const beat = () => {
    if (!isParentAlive(control.binding.supervisorPid)) return false;
    return persistRunLeaseHeartbeat({
      homeDir,
      binding: control.binding,
      heartbeatPid: process.pid,
      now: clock(),
      timeoutMs: control.timeoutMs
    }).status === 'OK';
  };
  let stopping = false;
  let timer = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (timer != null) clearInterval(timer);
    const stoppedAt = clock();
    const core = {
      schemaVersion: RUN_LEASE_HEARTBEAT_STOP_SCHEMA,
      runId,
      authoritySha256: control.binding.authoritySha256,
      controlSha256,
      heartbeatPid: process.pid,
      stoppedAt
    };
    const receipt = {
      ...core,
      stopSha256: sha256(canonicalVNextJson(core))
    };
    atomicWrite(pathSet.stopped, `${canonicalVNextJson(receipt)}\n`);
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (!beat()) return { status: 'REFUSED', code: 'RUN_LEASE_HEARTBEAT_INITIAL_FAILED' };
  timer = setInterval(() => {
    if (!beat()) {
      clearInterval(timer);
      process.exit(0);
    }
  }, control.intervalMs);
  return { status: 'OK', timer };
}
