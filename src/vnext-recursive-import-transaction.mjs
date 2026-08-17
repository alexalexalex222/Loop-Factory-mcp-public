import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import {
  readVNextEvidenceBank,
  validateVNextEvidenceRecord,
  vnextEvidenceBankPaths
} from './vnext-evidence-bank.mjs';

export const VNEXT_RECURSIVE_IMPORT_PENDING_SCHEMA =
  'vnext-recursive-import-pending-v1';
export const VNEXT_RECURSIVE_IMPORT_COMMIT_SCHEMA =
  'vnext-recursive-import-commit-v1';
export const VNEXT_RECURSIVE_IMPORT_GATE_SCHEMA =
  'vnext-recursive-import-gate-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const DIRECTORY = 'import-transactions';

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function verifierRecordMatches({ record, runId, partition, verifierEvidenceSha256 }) {
  return record?.verifierEligible === true
    && record.authority?.kind === 'verifier-owned'
    && record.authority.sourceRunId === runId
    && record.authority.primaryEvidenceSha256 === verifierEvidenceSha256
    && record.content?.sourceRunId === runId
    && record.content?.partition === partition
    && record.verifierEvidenceHashes.includes(verifierEvidenceSha256);
}

function transactionPaths(homeDir, transactionId = null) {
  const bank = vnextEvidenceBankPaths(homeDir);
  if (bank.status !== 'OK') return bank;
  const directory = join(bank.directory, DIRECTORY);
  return transactionId == null
    ? { status: 'OK', ...bank, transactionsDirectory: directory }
    : {
        status: 'OK',
        ...bank,
        transactionsDirectory: directory,
        pending: join(directory, `${transactionId}.pending.json`),
        commit: join(directory, `${transactionId}.commit.json`)
      };
}

function immutableWrite(path, contents) {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8') === contents
      ? { status: 'OK', idempotent: true }
      : refused(
          'VNEXT_RECURSIVE_IMPORT_TRANSACTION_CONFLICT',
          'An immutable import transaction artifact already has different bytes.'
        );
  }
  const temporary = `${path}.${process.pid}.${sha256(contents).slice(0, 12)}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    linkSync(temporary, path);
    return { status: 'OK', idempotent: false };
  } catch (error) {
    if (error.code === 'EEXIST' && existsSync(path)) {
      return readFileSync(path, 'utf8') === contents
        ? { status: 'OK', idempotent: true }
        : refused(
            'VNEXT_RECURSIVE_IMPORT_TRANSACTION_CONFLICT',
            'A concurrent import transaction wrote different immutable bytes.'
          );
    }
    return refused(
      'VNEXT_RECURSIVE_IMPORT_TRANSACTION_WRITE_FAILED',
      'Import transaction artifact could not be written.',
      { errno: error.code ?? null }
    );
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function validateVNextRecursiveImportPending(pending) {
  if (!exactKeys(pending, [
    'schemaVersion', 'transactionId', 'runId', 'partition', 'createdAt',
    'evidenceRecordId', 'evidenceRecordSha256', 'verifierEvidenceSha256',
    'transactionSha256'
  ])
      || pending.schemaVersion !== VNEXT_RECURSIVE_IMPORT_PENDING_SCHEMA
      || !isSafeId(pending.transactionId)
      || !isSafeId(pending.runId)
      || !['development', 'validation'].includes(pending.partition)
      || !Number.isFinite(Date.parse(pending.createdAt))
      || !isSafeId(pending.evidenceRecordId)
      || ![
        pending.evidenceRecordSha256,
        pending.verifierEvidenceSha256,
        pending.transactionSha256
      ].every((value) => SHA256.test(String(value || '')))) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_PENDING_INVALID',
      'VNext import pending transaction is malformed.'
    );
  }
  const core = structuredClone(pending);
  delete core.transactionSha256;
  return pending.transactionSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', pending }
    : refused(
        'VNEXT_RECURSIVE_IMPORT_PENDING_TAMPERED',
        'VNext import pending transaction hash failed replay.'
      );
}

export function validateVNextRecursiveImportCommit(commit) {
  if (!exactKeys(commit, [
    'schemaVersion', 'transactionId', 'transactionSha256', 'runId',
    'evidenceRecordId', 'evidenceRecordSha256', 'evidenceLedgerSha256',
    'committedAt', 'commitSha256'
  ])
      || commit.schemaVersion !== VNEXT_RECURSIVE_IMPORT_COMMIT_SCHEMA
      || !isSafeId(commit.transactionId)
      || !isSafeId(commit.runId)
      || !isSafeId(commit.evidenceRecordId)
      || ![
        commit.transactionSha256,
        commit.evidenceRecordSha256,
        commit.evidenceLedgerSha256,
        commit.commitSha256
      ].every((value) => SHA256.test(String(value || '')))
      || !Number.isFinite(Date.parse(commit.committedAt))) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_COMMIT_INVALID',
      'VNext import commit is malformed.'
    );
  }
  const core = structuredClone(commit);
  delete core.commitSha256;
  return commit.commitSha256 === sha256(canonicalVNextJson(core))
    ? { status: 'OK', commit }
    : refused(
        'VNEXT_RECURSIVE_IMPORT_COMMIT_TAMPERED',
        'VNext import commit hash failed replay.'
      );
}

export function persistVNextRecursiveImportPending({
  homeDir,
  runId,
  partition,
  record,
  verifierEvidenceSha256,
  createdAt = new Date().toISOString()
} = {}) {
  const recordValid = validateVNextEvidenceRecord(record);
  if (!isSafeId(runId)
      || !['development', 'validation'].includes(partition)
      || recordValid.status !== 'OK'
      || !SHA256.test(String(verifierEvidenceSha256 || ''))
      || !verifierRecordMatches({
        record,
        runId,
        partition,
        verifierEvidenceSha256
      })
      || !Number.isFinite(Date.parse(createdAt))) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_PENDING_INPUT_INVALID',
      'Pending import requires one valid VNext evidence record and verifier proof.'
    );
  }
  const transactionId = `vnext-import-${sha256(canonicalVNextJson({
    runId,
    evidenceRecordSha256: record.recordSha256
  })).slice(0, 24)}`;
  const paths = transactionPaths(homeDir, transactionId);
  if (paths.status !== 'OK') return paths;
  try {
    mkdirSync(paths.transactionsDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_TRANSACTION_STORAGE_INVALID',
      'Import transaction directory could not be prepared.',
      { errno: error.code ?? null }
    );
  }
  if (lstatSync(paths.transactionsDirectory).isSymbolicLink()
      || (existsSync(paths.pending) && lstatSync(paths.pending).isSymbolicLink())
      || (existsSync(paths.commit) && lstatSync(paths.commit).isSymbolicLink())) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_TRANSACTION_SYMLINK',
      'Import transaction storage may not use symlinks.'
    );
  }
  const existingText = existsSync(paths.pending)
    ? readFileSync(paths.pending, 'utf8')
    : null;
  if (existingText != null) {
    try {
      const existing = JSON.parse(existingText);
      return validateVNextRecursiveImportPending(existing).status === 'OK'
          && existing.runId === runId
          && existing.partition === partition
          && existing.evidenceRecordId === record.recordId
          && existing.evidenceRecordSha256 === record.recordSha256
          && existing.verifierEvidenceSha256 === verifierEvidenceSha256
        ? { status: 'OK', pending: existing, idempotent: true }
        : refused(
            'VNEXT_RECURSIVE_IMPORT_TRANSACTION_CONFLICT',
            'Existing pending import binds different evidence.'
          );
    } catch {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_TRANSACTION_CONFLICT',
        'Existing pending import is not valid JSON.'
      );
    }
  }
  const core = {
    schemaVersion: VNEXT_RECURSIVE_IMPORT_PENDING_SCHEMA,
    transactionId,
    runId,
    partition,
    createdAt,
    evidenceRecordId: record.recordId,
    evidenceRecordSha256: record.recordSha256,
    verifierEvidenceSha256
  };
  const pending = {
    ...core,
    transactionSha256: sha256(canonicalVNextJson(core))
  };
  const written = immutableWrite(paths.pending, `${canonicalVNextJson(pending)}\n`);
  return written.status === 'OK'
    ? { status: 'OK', pending, idempotent: written.idempotent }
    : written;
}

function readTransaction(homeDir, transactionId) {
  if (!isSafeId(transactionId)) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_TRANSACTION_ID_INVALID',
      'Import transaction ID is invalid.'
    );
  }
  const paths = transactionPaths(homeDir, transactionId);
  if (paths.status !== 'OK') return paths;
  try {
    if (!existsSync(paths.pending) || lstatSync(paths.pending).isSymbolicLink()) {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_PENDING_MISSING',
        'Import pending transaction is missing or unsafe.'
      );
    }
    const pending = JSON.parse(readFileSync(paths.pending, 'utf8'));
    const valid = validateVNextRecursiveImportPending(pending);
    return valid.status === 'OK' ? { status: 'OK', paths, pending } : valid;
  } catch (error) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_TRANSACTION_READ_FAILED',
      error.message
    );
  }
}

export function commitVNextRecursiveImportTransaction({
  homeDir,
  transactionId,
  evidenceLedgerSha256,
  committedAt = new Date().toISOString()
} = {}) {
  const loaded = readTransaction(homeDir, transactionId);
  if (loaded.status !== 'OK') return loaded;
  if (!SHA256.test(String(evidenceLedgerSha256 || ''))
      || !Number.isFinite(Date.parse(committedAt))) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_COMMIT_INPUT_INVALID',
      'Import commit requires the durable evidence ledger receipt and timestamp.'
    );
  }
  const bank = readVNextEvidenceBank(homeDir, { verifyAuthorities: false });
  const record = bank.status === 'OK'
    ? bank.records.find((candidate) => (
        candidate.recordId === loaded.pending.evidenceRecordId
      ))
    : null;
  if (!record
      || record.recordSha256 !== loaded.pending.evidenceRecordSha256
      || !verifierRecordMatches({
        record,
        runId: loaded.pending.runId,
        partition: loaded.pending.partition,
        verifierEvidenceSha256: loaded.pending.verifierEvidenceSha256
      })) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_EVIDENCE_NOT_DURABLE',
      'The exact VNext evidence record is not present, so catalog commit is forbidden.'
    );
  }
  if (existsSync(loaded.paths.commit)) {
    try {
      const existing = JSON.parse(readFileSync(loaded.paths.commit, 'utf8'));
      return validateVNextRecursiveImportCommit(existing).status === 'OK'
          && existing.transactionId === transactionId
          && existing.transactionSha256 === loaded.pending.transactionSha256
          && existing.runId === loaded.pending.runId
          && existing.evidenceRecordId === loaded.pending.evidenceRecordId
          && existing.evidenceRecordSha256 === loaded.pending.evidenceRecordSha256
        ? { status: 'OK', pending: loaded.pending, commit: existing, idempotent: true }
        : refused(
            'VNEXT_RECURSIVE_IMPORT_TRANSACTION_CONFLICT',
            'Existing import commit binds different evidence.'
          );
    } catch {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_TRANSACTION_CONFLICT',
        'Existing import commit is not valid JSON.'
      );
    }
  }
  const core = {
    schemaVersion: VNEXT_RECURSIVE_IMPORT_COMMIT_SCHEMA,
    transactionId,
    transactionSha256: loaded.pending.transactionSha256,
    runId: loaded.pending.runId,
    evidenceRecordId: loaded.pending.evidenceRecordId,
    evidenceRecordSha256: loaded.pending.evidenceRecordSha256,
    evidenceLedgerSha256,
    committedAt
  };
  const commit = {
    ...core,
    commitSha256: sha256(canonicalVNextJson(core))
  };
  const written = immutableWrite(
    loaded.paths.commit,
    `${canonicalVNextJson(commit)}\n`
  );
  return written.status === 'OK'
    ? { status: 'OK', pending: loaded.pending, commit, idempotent: written.idempotent }
    : written;
}

export function verifyVNextRecursiveImportCommit({
  homeDir,
  transactionId,
  commitSha256 = null
} = {}) {
  const loaded = readTransaction(homeDir, transactionId);
  if (loaded.status !== 'OK') return loaded;
  try {
    if (!existsSync(loaded.paths.commit)
        || lstatSync(loaded.paths.commit).isSymbolicLink()) {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_COMMIT_REQUIRED',
        'VNext catalog persistence requires a durable evidence commit.'
      );
    }
    const commit = JSON.parse(readFileSync(loaded.paths.commit, 'utf8'));
    const valid = validateVNextRecursiveImportCommit(commit);
    const bank = valid.status === 'OK'
      ? readVNextEvidenceBank(homeDir, { verifyAuthorities: false })
      : null;
    const record = bank?.status === 'OK'
      ? bank.records.find((candidate) => (
          candidate.recordId === loaded.pending.evidenceRecordId
        ))
      : null;
    if (valid.status !== 'OK'
        || (commitSha256 != null && commit.commitSha256 !== commitSha256)
        || commit.transactionId !== loaded.pending.transactionId
        || commit.transactionSha256 !== loaded.pending.transactionSha256
        || commit.runId !== loaded.pending.runId
        || commit.evidenceRecordId !== loaded.pending.evidenceRecordId
        || commit.evidenceRecordSha256 !== loaded.pending.evidenceRecordSha256
        || record?.recordSha256 !== loaded.pending.evidenceRecordSha256
        || !verifierRecordMatches({
          record,
          runId: loaded.pending.runId,
          partition: loaded.pending.partition,
          verifierEvidenceSha256: loaded.pending.verifierEvidenceSha256
        })) {
      return refused(
        'VNEXT_RECURSIVE_IMPORT_COMMIT_REPLAY_FAILED',
        'VNext import commit does not replay to the exact durable evidence record.'
      );
    }
    return { status: 'OK', pending: loaded.pending, commit, record };
  } catch (error) {
    return refused('VNEXT_RECURSIVE_IMPORT_COMMIT_REPLAY_FAILED', error.message);
  }
}

export function readVNextRecursiveImportGate(homeDir) {
  const paths = transactionPaths(homeDir);
  if (paths.status !== 'OK') return paths;
  if (!existsSync(paths.transactionsDirectory)) {
    const core = { schemaVersion: VNEXT_RECURSIVE_IMPORT_GATE_SCHEMA, transactions: [] };
    return {
      status: 'OK',
      ready: true,
      transactions: [],
      gateSha256: sha256(canonicalVNextJson(core))
    };
  }
  if (lstatSync(paths.transactionsDirectory).isSymbolicLink()) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_TRANSACTION_SYMLINK',
      'Import transaction directory may not be a symlink.'
    );
  }
  const files = readdirSync(paths.transactionsDirectory);
  const pendingFiles = files.filter((name) => name.endsWith('.pending.json')).sort();
  const commitFiles = new Set(files.filter((name) => name.endsWith('.commit.json')));
  const transactions = [];
  for (const filename of pendingFiles) {
    const transactionId = filename.slice(0, -'.pending.json'.length);
    const replay = verifyVNextRecursiveImportCommit({ homeDir, transactionId });
    if (replay.status === 'OK') {
      transactions.push({
        transactionId,
        transactionSha256: replay.pending.transactionSha256,
        commitSha256: replay.commit.commitSha256,
        state: 'COMMITTED'
      });
      commitFiles.delete(`${transactionId}.commit.json`);
    } else if (replay.code === 'VNEXT_RECURSIVE_IMPORT_COMMIT_REQUIRED') {
      const loaded = readTransaction(homeDir, transactionId);
      if (loaded.status !== 'OK') return loaded;
      transactions.push({
        transactionId,
        transactionSha256: loaded.pending.transactionSha256,
        commitSha256: null,
        state: 'PENDING'
      });
    } else return replay;
  }
  if (commitFiles.size > 0) {
    return refused(
      'VNEXT_RECURSIVE_IMPORT_ORPHAN_COMMIT',
      'An import commit exists without its immutable pending transaction.'
    );
  }
  transactions.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  const core = { schemaVersion: VNEXT_RECURSIVE_IMPORT_GATE_SCHEMA, transactions };
  return {
    status: 'OK',
    ready: transactions.every((transaction) => transaction.state === 'COMMITTED'),
    transactions,
    gateSha256: sha256(canonicalVNextJson(core))
  };
}

export function requireVNextRecursiveImportGate(homeDir) {
  const gate = readVNextRecursiveImportGate(homeDir);
  return gate.status !== 'OK'
    ? gate
    : gate.ready
      ? gate
      : refused(
          'VNEXT_RECURSIVE_IMPORT_INCOMPLETE',
          'Adaptive catalog access is blocked until every pending VNext evidence import commits.',
          { gateSha256: gate.gateSha256, transactions: gate.transactions }
        );
}
