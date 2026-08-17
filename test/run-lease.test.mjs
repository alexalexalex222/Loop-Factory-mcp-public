import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRunLease,
  acquireRunLeaseMutex,
  releaseRunLease,
  releaseRunLeaseMutex,
  renewRunLease,
  signalRunLeaseOwner,
  validateRunLease,
  verifyRunLeaseHistory
} from '../src/run-lease.mjs';
import {
  createRunLeaseHeartbeatBinding,
  persistRunLeaseHeartbeat,
  startRunLeaseHeartbeat,
  verifyRunLeaseHeartbeat
} from '../src/run-lease-heartbeat.mjs';

function home() {
  return mkdtempSync(join(tmpdir(), 'loop-factory-lease-'));
}

test('only one supervisor acquires a live run lease', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-1',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 60000
  });
  const second = acquireRunLease({
    homeDir,
    runId: 'run-1',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    now: '2026-08-05T00:00:01.000Z',
    ttlMs: 60000
  });
  assert.equal(first.status, 'OK');
  assert.equal(second.code, 'RUN_LEASE_HELD');
  assert.equal(validateRunLease(first.lease).status, 'OK');
});

test('stale leases are archived and hash-chain into the new lease', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-2',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 1000
  });
  const second = acquireRunLease({
    homeDir,
    runId: 'run-2',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    now: '2026-08-05T00:00:02.000Z',
    ttlMs: 1000
  });
  assert.equal(second.status, 'OK');
  assert.equal(second.lease.revision, 2);
  assert.equal(second.lease.previousLeaseSha256, first.lease.leaseSha256);
});

test('renew and release use owner, nonce, and expected-hash CAS', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-3',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 60000
  });
  assert.equal(renewRunLease({
    homeDir,
    runId: 'run-3',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    expectedLeaseSha256: 'f'.repeat(64),
    now: '2026-08-05T00:00:01.000Z'
  }).status, 'REFUSED');
  const renewed = renewRunLease({
    homeDir,
    runId: 'run-3',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    expectedLeaseSha256: first.lease.leaseSha256,
    now: '2026-08-05T00:00:01.000Z'
  });
  assert.equal(renewed.status, 'OK');
  assert.equal(releaseRunLease({
    homeDir,
    runId: 'run-3',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    expectedLeaseSha256: renewed.lease.leaseSha256
  }).status, 'OK');
});

test('tampered active leases fail closed', () => {
  const homeDir = home();
  acquireRunLease({
    homeDir,
    runId: 'run-4',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 60000
  });
  const path = join(homeDir, 'runs', 'run-4', 'SUPERVISOR_LEASE.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.ownerId = 'owner-b';
  writeFileSync(path, JSON.stringify(record));
  assert.equal(acquireRunLease({
    homeDir,
    runId: 'run-4',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    now: '2026-08-05T00:00:01.000Z',
    ttlMs: 60000
  }).code, 'RUN_LEASE_ACTIVE_INVALID');
});

test('release and reacquire preserve one replayable revision chain', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-5',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 60000
  });
  assert.equal(first.status, 'OK');
  assert.equal(releaseRunLease({
    homeDir,
    runId: 'run-5',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    expectedLeaseSha256: first.lease.leaseSha256
  }).status, 'OK');
  const second = acquireRunLease({
    homeDir,
    runId: 'run-5',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    now: '2026-08-05T00:00:01.000Z',
    ttlMs: 60000
  });
  assert.equal(second.status, 'OK');
  assert.equal(second.lease.revision, 2);
  assert.equal(second.lease.previousLeaseSha256, first.lease.leaseSha256);
  const history = verifyRunLeaseHistory({ homeDir, runId: 'run-5' });
  assert.equal(history.status, 'OK');
  assert.equal(history.history.length, 2);
  assert.equal(history.latestKind, 'active');
});

test('a stale mutex owner cannot release its successor lock', () => {
  const homeDir = home();
  const oldOwner = acquireRunLeaseMutex({
    homeDir, runId: 'run-mutex-cas', nowMs: 1_000, staleMutexMs: 100
  });
  assert.equal(oldOwner.status, 'OK');
  const lockPath = join(
    homeDir,
    'runs',
    'run-mutex-cas',
    'SUPERVISOR_LEASE.lock'
  );
  utimesSync(lockPath, new Date(0), new Date(0));
  const successor = acquireRunLeaseMutex({
    homeDir, runId: 'run-mutex-cas', nowMs: 10_000, staleMutexMs: 100
  });
  assert.equal(successor.status, 'OK');
  assert.notEqual(successor.handle.token, oldOwner.handle.token);
  assert.equal(releaseRunLeaseMutex(oldOwner.handle).status, 'REFUSED');
  assert.equal(existsSync(lockPath), true);
  const currentOwner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
  assert.equal(currentOwner.token, successor.handle.token);
  assert.equal(releaseRunLeaseMutex(successor.handle).status, 'OK');
});

test('lease transitions recover after every durable rename/write boundary', () => {
  for (const boundary of [
    'after-transition-write',
    'after-archive-rename',
    'after-active-write',
    'after-transition-complete'
  ]) {
    const homeDir = home();
    const first = acquireRunLease({
      homeDir,
      runId: 'run-transition',
      ownerId: 'owner-a',
      nonce: 'nonce-a',
      pid: 999999,
      now: '2026-08-05T00:00:00.000Z',
      ttlMs: 1000
    });
    assert.equal(first.status, 'OK');
    const interrupted = renewRunLease({
      homeDir,
      runId: 'run-transition',
      ownerId: 'owner-a',
      nonce: 'nonce-a',
      expectedLeaseSha256: first.lease.leaseSha256,
      now: '2026-08-05T00:00:00.500Z',
      ttlMs: 1000,
      transitionObserver(point) {
        if (point === boundary) throw new Error(`simulated crash at ${point}`);
      }
    });
    assert.equal(interrupted.status, 'REFUSED');
    const recovered = acquireRunLease({
      homeDir,
      runId: 'run-transition',
      ownerId: 'owner-b',
      nonce: 'nonce-b',
      pid: 999998,
      now: '2026-08-05T00:00:03.000Z',
      ttlMs: 1000
    });
    assert.equal(recovered.status, 'OK', `${boundary}: ${recovered.code}`);
    assert.equal(recovered.lease.ownerId, 'owner-b');
    const history = verifyRunLeaseHistory({ homeDir, runId: 'run-transition' });
    assert.equal(history.status, 'OK', boundary);
    assert.equal(history.latestKind, 'active');
    assert.equal(
      existsSync(join(homeDir, 'runs', 'run-transition', 'SUPERVISOR_LEASE.transition.json')),
      false
    );
  }
});

test('legacy rename-without-successor residue becomes one expired orphan transition', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-legacy-orphan',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    pid: 999999,
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 1000
  });
  renewRunLease({
    homeDir,
    runId: 'run-legacy-orphan',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    expectedLeaseSha256: first.lease.leaseSha256,
    now: '2026-08-05T00:00:00.500Z',
    ttlMs: 1000,
    transitionObserver(point) {
      if (point === 'after-archive-rename') throw new Error('legacy crash');
    }
  });
  rmSync(join(
    homeDir,
    'runs',
    'run-legacy-orphan',
    'SUPERVISOR_LEASE.transition.json'
  ));
  const recovered = acquireRunLease({
    homeDir,
    runId: 'run-legacy-orphan',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    pid: 999998,
    now: '2026-08-05T00:00:03.000Z',
    ttlMs: 1000
  });
  assert.equal(recovered.status, 'OK');
  assert.equal(recovered.lease.previousLeaseSha256, first.lease.leaseSha256);
  assert.equal(verifyRunLeaseHistory({
    homeDir,
    runId: 'run-legacy-orphan'
  }).status, 'OK');
});

test('a fresh bound heartbeat prevents expired-lease takeover and permits owner renewal', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-heartbeat',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 1000
  });
  const binding = createRunLeaseHeartbeatBinding(first.lease);
  assert.equal(persistRunLeaseHeartbeat({
    homeDir,
    binding,
    heartbeatPid: process.pid,
    now: '2026-08-05T00:00:01.500Z',
    timeoutMs: 10_000
  }).status, 'OK');
  assert.equal(acquireRunLease({
    homeDir,
    runId: 'run-heartbeat',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    now: '2026-08-05T00:00:02.000Z',
    ttlMs: 1000
  }).code, 'RUN_LEASE_HEARTBEAT_LIVE');
  const renewed = renewRunLease({
    homeDir,
    runId: 'run-heartbeat',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    expectedLeaseSha256: first.lease.leaseSha256,
    now: '2026-08-05T00:00:02.000Z',
    ttlMs: 1000
  });
  assert.equal(renewed.status, 'OK');
});

test('a stale heartbeat plus dead local owner permits early orphan takeover', () => {
  const homeDir = home();
  const first = acquireRunLease({
    homeDir,
    runId: 'run-heartbeat-orphan',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    pid: 999999,
    now: '2026-08-05T00:00:00.000Z',
    ttlMs: 60_000
  });
  assert.equal(persistRunLeaseHeartbeat({
    homeDir,
    binding: createRunLeaseHeartbeatBinding(first.lease),
    heartbeatPid: 999998,
    now: '2026-08-05T00:00:00.000Z',
    timeoutMs: 1000
  }).status, 'OK');
  const recovered = acquireRunLease({
    homeDir,
    runId: 'run-heartbeat-orphan',
    ownerId: 'owner-b',
    nonce: 'nonce-b',
    pid: 999997,
    now: '2026-08-05T00:00:02.000Z',
    ttlMs: 60_000
  });
  assert.equal(recovered.status, 'OK');
  assert.equal(recovered.lease.ownerId, 'owner-b');
});

test('heartbeat worker advances while the supervisor event loop is blocked', async () => {
  const homeDir = home();
  const now = new Date().toISOString();
  const lease = acquireRunLease({
    homeDir,
    runId: 'run-independent-heartbeat',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now,
    ttlMs: 1000
  }).lease;
  const heartbeat = startRunLeaseHeartbeat({
    homeDir,
    lease,
    intervalMs: 100,
    timeoutMs: 1000
  });
  assert.equal(heartbeat.status, 'OK');
  const initial = verifyRunLeaseHeartbeat({
    homeDir,
    runId: lease.runId,
    lease
  }).heartbeat.sequence;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  const advanced = verifyRunLeaseHeartbeat({
    homeDir,
    runId: lease.runId,
    lease
  });
  const stopped = heartbeat.stop();
  assert.equal(advanced.status, 'OK');
  assert.ok(advanced.heartbeat.sequence > initial);
  assert.equal(stopped.status, 'OK');
  assert.equal(stopped.stopped, true);
  const exitDeadline = Date.now() + 1_000;
  while (Date.now() < exitDeadline) {
    try { process.kill(heartbeat.childPid, 0); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(heartbeat.childPid, 0), { code: 'ESRCH' });
  assert.ok(readdirSync(join(homeDir, 'runs', lease.runId)).includes('SUPERVISOR_HEARTBEAT.json'));
});

test('operator stop signals only the locally bound active lease owner', () => {
  const homeDir = home();
  const now = new Date().toISOString();
  const acquired = acquireRunLease({
    homeDir,
    runId: 'run-stop-signal',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    pid: 4242,
    host: 'test-host',
    now,
    ttlMs: 60_000
  });
  assert.equal(persistRunLeaseHeartbeat({
    homeDir,
    binding: createRunLeaseHeartbeatBinding(acquired.lease),
    heartbeatPid: process.pid,
    now,
    timeoutMs: 30_000
  }).status, 'OK');
  const calls = [];
  const signaled = signalRunLeaseOwner({
    homeDir,
    runId: 'run-stop-signal',
    localHost: 'test-host',
    sendSignal(pid, signal) {
      calls.push([pid, signal]);
    }
  });
  assert.equal(signaled.status, 'OK');
  assert.equal(signaled.signaled, true);
  assert.deepEqual(calls, [[4242, 0], [4242, 'SIGTERM']]);
  const remote = signalRunLeaseOwner({
    homeDir,
    runId: 'run-stop-signal',
    localHost: 'other-host',
    sendSignal() {
      assert.fail('remote supervisors are never signalled');
    }
  });
  assert.equal(remote.disposition, 'REMOTE_SUPERVISOR_STOP_FILE_ONLY');
});

test('operator stop never signals a PID without a fresh bound heartbeat', () => {
  const homeDir = home();
  const now = new Date().toISOString();
  acquireRunLease({
    homeDir,
    runId: 'run-stop-no-heartbeat',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    pid: 5252,
    host: 'test-host',
    now,
    ttlMs: 60_000
  });
  const result = signalRunLeaseOwner({
    homeDir,
    runId: 'run-stop-no-heartbeat',
    localHost: 'test-host',
    sendSignal() {
      assert.fail('an unproven PID must not be signalled');
    }
  });
  assert.equal(result.status, 'OK');
  assert.equal(result.disposition, 'SUPERVISOR_HEARTBEAT_NOT_LIVE');
  assert.equal(result.signaled, false);
});

test('heartbeat verification refuses an invalid clock', () => {
  const homeDir = home();
  const now = new Date().toISOString();
  const lease = acquireRunLease({
    homeDir,
    runId: 'run-heartbeat-clock',
    ownerId: 'owner-a',
    nonce: 'nonce-a',
    now,
    ttlMs: 60_000
  }).lease;
  assert.equal(persistRunLeaseHeartbeat({
    homeDir,
    binding: createRunLeaseHeartbeatBinding(lease),
    now,
    timeoutMs: 30_000
  }).status, 'OK');
  assert.equal(verifyRunLeaseHeartbeat({
    homeDir,
    runId: lease.runId,
    lease,
    now: 'not-a-time'
  }).code, 'RUN_LEASE_HEARTBEAT_TIME_INVALID');
});
