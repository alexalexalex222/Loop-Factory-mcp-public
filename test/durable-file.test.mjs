import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  durableAtomicWriteFileSync,
  durableRenameSync,
  durableWriteExclusiveFileSync
} from '../src/durable-file.mjs';

const PROOF_ROOT = resolve('/proof');
const proofPath = (name) => join(PROOF_ROOT, name);

function recordingIo({
  failFsyncAt = null,
  failFullFsyncAt = null,
  platform = 'darwin'
} = {}) {
  const operations = [];
  let nextDescriptor = 10;
  let fsyncCount = 0;
  let fullFsyncCount = 0;
  const io = {
    platform,
    randomUUID: () => 'fixed-nonce',
    openSync(path, flags, mode) {
      operations.push(['open', path, flags, mode]);
      nextDescriptor += 1;
      return nextDescriptor;
    },
    writeFileSync(descriptor, contents) {
      operations.push(['write', descriptor, String(contents)]);
    },
    fsyncSync(descriptor) {
      fsyncCount += 1;
      operations.push(['fsync', descriptor]);
      if (fsyncCount === failFsyncAt) {
        const error = new Error('simulated fsync failure');
        error.code = 'EIO';
        throw error;
      }
    },
    fullFsyncPathSync(path) {
      fullFsyncCount += 1;
      operations.push(['fullfsync', path]);
      if (fullFsyncCount === failFullFsyncAt) {
        const error = new Error('simulated F_FULLFSYNC failure');
        error.code = 'EIO';
        throw error;
      }
    },
    closeSync(descriptor) {
      operations.push(['close', descriptor]);
    },
    renameSync(from, to) {
      operations.push(['rename', from, to]);
    },
    unlinkSync(path) {
      operations.push(['unlink', path]);
    }
  };
  return { io, operations };
}

test('durable atomic write flushes bytes before rename and directory after rename', () => {
  const { io, operations } = recordingIo();
  durableAtomicWriteFileSync(proofPath('launch.json'), 'launch', {}, io);
  assert.deepEqual(operations.map(([operation]) => operation), [
    'open', 'write', 'fsync', 'close', 'fullfsync', 'rename',
    'open', 'fsync', 'close', 'fullfsync'
  ]);
  assert.equal(dirname(operations[0][1]), PROOF_ROOT);
  assert.match(basename(operations[0][1]), /^\.launch\.json\..+\.tmp$/);
  assert.equal(operations[4][1], operations[0][1]);
  assert.deepEqual(operations[5].slice(1), [operations[0][1], proofPath('launch.json')]);
  assert.deepEqual(operations[6].slice(1, 3), [PROOF_ROOT, 'r']);
  assert.equal(operations[9][1], PROOF_ROOT);
});

test('durable atomic write refuses to rename when the file flush fails', () => {
  const { io, operations } = recordingIo({ failFsyncAt: 1 });
  assert.throws(
    () => durableAtomicWriteFileSync(proofPath('dispatch.json'), 'dispatch', {}, io),
    { code: 'EIO' }
  );
  assert.equal(operations.some(([operation]) => operation === 'rename'), false);
  assert.equal(operations.at(-1)[0], 'unlink');
});

test('durable atomic write refuses to rename when Darwin full flush fails', () => {
  const { io, operations } = recordingIo({ failFullFsyncAt: 1 });
  assert.throws(
    () => durableAtomicWriteFileSync(proofPath('dispatch.json'), 'dispatch', {}, io),
    { code: 'EIO' }
  );
  assert.equal(operations.some(([operation]) => operation === 'rename'), false);
  assert.equal(operations.at(-1)[0], 'unlink');
});

test('Darwin durable writes fail closed without a full flush adapter', () => {
  const { io, operations } = recordingIo();
  delete io.fullFsyncPathSync;
  assert.throws(
    () => durableAtomicWriteFileSync(proofPath('dispatch.json'), 'dispatch', {}, io),
    { code: 'DURABLE_DARWIN_FULLFSYNC_UNAVAILABLE' }
  );
  assert.equal(operations.some(([operation]) => operation === 'rename'), false);
  assert.equal(operations.at(-1)[0], 'unlink');
});

test('durable atomic write does not return after an unflushed rename', () => {
  const { io, operations } = recordingIo({ failFsyncAt: 2 });
  assert.throws(
    () => durableAtomicWriteFileSync(proofPath('dispatch.json'), 'dispatch', {}, io),
    { code: 'EIO' }
  );
  assert.equal(operations.some(([operation]) => operation === 'rename'), true);
  assert.equal(operations.some(([operation]) => operation === 'unlink'), false);
});

test('durable exclusive creation and rename both flush their directory boundary', () => {
  const exclusive = recordingIo();
  durableWriteExclusiveFileSync(proofPath('launch.json'), 'launch', {}, exclusive.io);
  assert.deepEqual(exclusive.operations.map(([operation]) => operation), [
    'open', 'write', 'fsync', 'close', 'fullfsync',
    'open', 'fsync', 'close', 'fullfsync'
  ]);

  const moved = recordingIo();
  durableRenameSync(proofPath('pending.json'), proofPath('consumed.json'), moved.io);
  assert.deepEqual(moved.operations.map(([operation]) => operation), [
    'rename', 'open', 'fsync', 'close', 'fullfsync',
    'open', 'fsync', 'close', 'fullfsync'
  ]);
  assert.deepEqual(moved.operations[1].slice(1, 3), [proofPath('consumed.json'), 'r+']);
  assert.deepEqual(moved.operations[5].slice(1, 3), [PROOF_ROOT, 'r']);
});

test('Linux uses fsync and Windows power-loss durability fails closed', () => {
  const linux = recordingIo({ platform: 'linux' });
  durableAtomicWriteFileSync(proofPath('linux.json'), 'linux', {}, linux.io);
  assert.equal(linux.operations.some(([operation]) => operation === 'fullfsync'), false);
  assert.deepEqual(linux.operations.at(-3).slice(1, 3), [PROOF_ROOT, 'r']);

  const windows = recordingIo({ platform: 'win32' });
  assert.throws(
    () => durableAtomicWriteFileSync('C:\\proof\\windows.json', 'windows', {}, windows.io),
    { code: 'DURABLE_PLATFORM_UNSUPPORTED' }
  );
  assert.deepEqual(windows.operations, []);
});

test('unsupported platforms fail before touching a dispatch barrier', () => {
  const unsupported = recordingIo({ platform: 'freebsd' });
  assert.throws(
    () => durableAtomicWriteFileSync(proofPath('dispatch.json'), 'dispatch', {}, unsupported.io),
    { code: 'DURABLE_PLATFORM_UNSUPPORTED' }
  );
  assert.deepEqual(unsupported.operations, []);
});

test('durable file operations replay through the real filesystem', () => {
  const root = mkdtempSync(join(tmpdir(), 'durable-file-'));
  const current = join(root, 'current.json');
  const archived = join(root, 'archived.json');
  if (process.platform === 'win32') {
    assert.throws(
      () => durableAtomicWriteFileSync(current, 'one'),
      { code: 'DURABLE_PLATFORM_UNSUPPORTED' }
    );
    return;
  }
  durableAtomicWriteFileSync(current, 'one');
  durableAtomicWriteFileSync(current, 'two');
  assert.equal(readFileSync(current, 'utf8'), 'two');
  durableRenameSync(current, archived);
  assert.equal(readFileSync(archived, 'utf8'), 'two');
  writeFileSync(current, 'ordinary');
  assert.throws(
    () => durableWriteExclusiveFileSync(current, 'replacement'),
    { code: 'EEXIST' }
  );
});
