import { spawnSync } from 'node:child_process';

const ACTIVE = new Map();
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
let handlersInstalled = false;
let signalShutdown = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function processTreeAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function terminateProcessTree(pid, signal = 'SIGKILL') {
  if (!Number.isInteger(pid) || pid < 1) return false;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    try { process.kill(pid, signal); } catch { /* taskkill is authoritative */ }
    return true;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return false;
    }
  }
  return true;
}

export async function waitForProcessTreeExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeAlive(pid)) return true;
    await sleep(20);
  }
  return !processTreeAlive(pid);
}

function removeHandlersWhenIdle() {
  if (!handlersInstalled || ACTIVE.size > 0 || signalShutdown) return;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  handlersInstalled = false;
}

async function shutdownForSignal(signal) {
  if (signalShutdown) return signalShutdown;
  signalShutdown = (async () => {
    const records = [...ACTIVE.values()];
    for (const record of records) {
      try { record.onSignalCleanup?.(signal); } catch { /* cleanup is best effort */ }
      record.terminate(`PROCESS_TREE_PARENT_${signal}`, 'SIGTERM');
    }
    const exited = await Promise.all(records.map((record) => record.waitForExit(5_000)));
    exited.forEach((done, index) => {
      if (!done) terminateProcessTree(records[index].child.pid, 'SIGKILL');
    });
    await Promise.all(records.map((record) => record.waitForExit(5_000)));
    process.exit(SIGNAL_EXIT[signal]);
  })();
  return signalShutdown;
}

function onSigint() {
  void shutdownForSignal('SIGINT');
}

function onSigterm() {
  void shutdownForSignal('SIGTERM');
}

function installHandlers() {
  if (handlersInstalled) return;
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  handlersInstalled = true;
}

export function superviseProcessTree(child, { onSignalCleanup = null } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid < 1) {
    throw new Error('a launched child PID is required for process-tree supervision');
  }
  const record = {
    child,
    onSignalCleanup: typeof onSignalCleanup === 'function' ? onSignalCleanup : null,
    terminationCode: null,
    terminate(code, signal = 'SIGKILL') {
      if (record.terminationCode != null) return false;
      record.terminationCode = code;
      terminateProcessTree(child.pid, signal);
      return true;
    },
    waitForExit(timeoutMs = 10_000) {
      return waitForProcessTreeExit(child.pid, timeoutMs);
    }
  };
  ACTIVE.set(child.pid, record);
  installHandlers();
  return {
    get terminationCode() {
      return record.terminationCode;
    },
    terminate: record.terminate,
    waitForExit: record.waitForExit,
    release() {
      ACTIVE.delete(child.pid);
      removeHandlersWhenIdle();
    }
  };
}

export function activeProcessTreeCount() {
  return ACTIVE.size;
}
