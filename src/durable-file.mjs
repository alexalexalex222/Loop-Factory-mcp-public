import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Apple requires this fcntl command when drive-power-loss ordering matters;
// ordinary fsync alone only guarantees that writes reached the device driver.
const DARWIN_FULLFSYNC_HELPER = fileURLToPath(
  new URL('./native/darwin-fullfsync', import.meta.url)
);
const DARWIN_FULLFSYNC_HELPER_SHA256 =
  '68aa24e687973840e5d3caa217aca661b6a52a32e58c9a48fdc509224a955c03';
const SUPPORTED_POWER_LOSS_PLATFORMS = new Set(['darwin', 'linux']);

export function supportsPowerLossDurability(platform = process.platform) {
  return SUPPORTED_POWER_LOSS_PLATFORMS.has(platform);
}

function darwinFullFsyncPathSync(path) {
  let helperSha256;
  try {
    helperSha256 = createHash('sha256')
      .update(readFileSync(DARWIN_FULLFSYNC_HELPER))
      .digest('hex');
  } catch (cause) {
    const error = new Error('Darwin F_FULLFSYNC helper is unavailable.', { cause });
    error.code = 'DURABLE_DARWIN_FULLFSYNC_UNAVAILABLE';
    throw error;
  }
  if (helperSha256 !== DARWIN_FULLFSYNC_HELPER_SHA256) {
    const error = new Error('Darwin F_FULLFSYNC helper failed its implementation hash.');
    error.code = 'DURABLE_DARWIN_FULLFSYNC_HELPER_TAMPERED';
    throw error;
  }
  try {
    execFileSync(DARWIN_FULLFSYNC_HELPER, [path], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL'
    });
  } catch (cause) {
    const error = new Error(`Darwin F_FULLFSYNC failed for ${path}`, { cause });
    error.code = 'DURABLE_DARWIN_FULLFSYNC_FAILED';
    throw error;
  }
}

const SYSTEM_IO = Object.freeze({
  closeSync,
  fullFsyncPathSync: process.platform === 'darwin'
    ? darwinFullFsyncPathSync
    : null,
  fsyncSync,
  openSync,
  platform: process.platform,
  randomUUID,
  renameSync,
  unlinkSync,
  writeFileSync
});

function assertSupportedPlatform(io) {
  if (!supportsPowerLossDurability(io.platform)) {
    const error = new Error(`Power-loss durability is unsupported on ${io.platform}.`);
    error.code = 'DURABLE_PLATFORM_UNSUPPORTED';
    throw error;
  }
}

function syncPathAgainstPowerLoss(path, io) {
  if (io.platform !== 'darwin') return;
  if (typeof io.fullFsyncPathSync !== 'function') {
    const error = new Error('Darwin durability requires F_FULLFSYNC support.');
    error.code = 'DURABLE_DARWIN_FULLFSYNC_UNAVAILABLE';
    throw error;
  }
  io.fullFsyncPathSync(path);
}

function syncDescriptor(path, flags, io) {
  const descriptor = io.openSync(path, flags);
  try {
    io.fsyncSync(descriptor);
  } finally {
    io.closeSync(descriptor);
  }
  syncPathAgainstPowerLoss(path, io);
}

function syncDirectory(path, io) {
  syncDescriptor(path, 'r', io);
}

function cleanupTemporary(path, io) {
  try {
    io.unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function durableAtomicWriteFileSync(
  path,
  contents,
  { encoding = 'utf8', mode = 0o600 } = {},
  io = SYSTEM_IO
) {
  assertSupportedPlatform(io);
  const parent = dirname(resolve(path));
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${io.randomUUID()}.tmp`
  );
  let renamed = false;
  try {
    const descriptor = io.openSync(temporary, 'wx', mode);
    try {
      io.writeFileSync(descriptor, contents, { encoding });
      io.fsyncSync(descriptor);
    } finally {
      io.closeSync(descriptor);
    }
    syncPathAgainstPowerLoss(temporary, io);
    io.renameSync(temporary, path);
    renamed = true;
    syncDirectory(parent, io);
    return path;
  } catch (error) {
    if (!renamed) cleanupTemporary(temporary, io);
    throw error;
  }
}

export function durableWriteExclusiveFileSync(
  path,
  contents,
  { encoding = 'utf8', mode = 0o600 } = {},
  io = SYSTEM_IO
) {
  assertSupportedPlatform(io);
  const descriptor = io.openSync(path, 'wx', mode);
  try {
    io.writeFileSync(descriptor, contents, { encoding });
    io.fsyncSync(descriptor);
  } finally {
    io.closeSync(descriptor);
  }
  syncPathAgainstPowerLoss(path, io);
  syncDirectory(dirname(resolve(path)), io);
  return path;
}

export function durableRenameSync(from, to, io = SYSTEM_IO) {
  assertSupportedPlatform(io);
  io.renameSync(from, to);
  syncDescriptor(to, 'r+', io);
  const sourceParent = dirname(resolve(from));
  const destinationParent = dirname(resolve(to));
  syncDirectory(destinationParent, io);
  if (sourceParent !== destinationParent) syncDirectory(sourceParent, io);
  return to;
}
