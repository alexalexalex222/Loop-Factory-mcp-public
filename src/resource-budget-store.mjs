import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { verifyResourceBudgetLedger } from './resource-budget.mjs';
import { isAbsoluteOnAnyPlatform, isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';
import { STORE_DURABILITY } from './store.mjs';

export const RESOURCE_BUDGET_CHECKPOINT_SCHEMA =
  'loop-factory-resource-budget-checkpoint-v1';
export const RESOURCE_BUDGET_BREACH_SCHEMA =
  'loop-factory-resource-budget-breach-v1';

const FILE_RE = /^(\d{4})-([a-f0-9]{64})\.json$/;

function within(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validCheckpointRoot(checkpointRoot) {
  return typeof checkpointRoot === 'string'
    && !isAbsoluteOnAnyPlatform(checkpointRoot)
    && checkpointRoot.split(/[\\/]/).every((part) => part && part !== '..');
}

function rootPath(store, runId, checkpointRoot) {
  if (!store || !isSafeId(runId)
      || !validCheckpointRoot(checkpointRoot)) return null;
  const run = store.runDir(runId);
  const root = resolve(run, checkpointRoot);
  return within(run, root) ? root : null;
}

function breachPath(checkpointRoot, reservationId) {
  return `${checkpointRoot}-breaches/${reservationId}.json`;
}

function payload(record) {
  const { checkpointSha256, ...core } = record;
  return core;
}

export function validateResourceBudgetCheckpoint(record) {
  const keys = [
    'schemaVersion', 'runId', 'sequence', 'kind', 'callId', 'ledger',
    'ledgerSha256', 'previousCheckpointSha256', 'recordedAt',
    'checkpointSha256'
  ];
  const checked = verifyResourceBudgetLedger(record?.ledger);
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== keys.length
      || !keys.every((key) => Object.hasOwn(record, key))
      || record.schemaVersion !== RESOURCE_BUDGET_CHECKPOINT_SCHEMA
      || !isSafeId(record.runId)
      || !Number.isInteger(record.sequence) || record.sequence < 1
      || !['reservation', 'settlement'].includes(record.kind)
      || !isSafeId(record.callId)
      || checked.status !== 'OK'
      || record.ledgerSha256 !== record.ledger.ledgerSha256
      || !(record.previousCheckpointSha256 == null
        || /^[a-f0-9]{64}$/.test(record.previousCheckpointSha256))
      || !Number.isFinite(Date.parse(record.recordedAt))
      || record.checkpointSha256 !== sha256(canonicalVNextJson(payload(record)))) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_INVALID' };
  }
  const latest = record.ledger.entries.at(-1);
  if (!latest || latest.kind !== record.kind) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_ENTRY_INVALID' };
  }
  const reservation = latest.kind === 'reservation'
    ? latest
    : record.ledger.entries.find((entry) => (
        entry.kind === 'reservation' && entry.reservationId === latest.reservationId
      ));
  return reservation?.callId === record.callId
    ? { status: 'OK', checkpoint: record, budget: checked }
    : { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_CALL_INVALID' };
}

function records(store, runId, checkpointRoot) {
  const root = rootPath(store, runId, checkpointRoot);
  if (!root || !existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error('unsafe resource budget checkpoint directory');
  }
  return readdirSync(root).sort().map((name) => {
    const match = name.match(FILE_RE);
    const path = resolve(root, name);
    if (!match || !within(root, path) || lstatSync(path).isSymbolicLink()) {
      throw new Error(`unsafe resource budget checkpoint: ${name}`);
    }
    const text = readFileSync(path, 'utf8');
    return { name, sequence: Number(match[1]), nameHash: match[2], text, record: JSON.parse(text) };
  });
}

export function verifyResourceBudgetCheckpointHistory({
  store,
  runId,
  checkpointRoot
} = {}) {
  try {
    const rows = records(store, runId, checkpointRoot);
    if (rows.length === 0) {
      return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_HISTORY_MISSING' };
    }
    let previous = null;
    let previousLedger = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const checked = validateResourceBudgetCheckpoint(row.record);
      if (checked.status !== 'OK'
          || row.sequence !== index + 1
          || row.record.sequence !== row.sequence
          || row.record.ledger.entries.length !== row.sequence
          || row.nameHash !== row.record.checkpointSha256
          || row.record.previousCheckpointSha256 !== previous
          || (previousLedger && canonicalVNextJson(
            row.record.ledger.entries.slice(0, previousLedger.entries.length)
          ) !== canonicalVNextJson(previousLedger.entries))) {
        return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_HISTORY_INVALID' };
      }
      previous = row.record.checkpointSha256;
      previousLedger = row.record.ledger;
    }
    const latest = rows.at(-1).record;
    const budget = verifyResourceBudgetLedger(latest.ledger);
    return {
      status: 'OK',
      checkpoints: rows.map((row) => row.record),
      latest,
      latestCheckpointSha256: latest.checkpointSha256,
      ledger: latest.ledger,
      unresolvedReservations: budget.unresolvedReservations
    };
  } catch (error) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_HISTORY_FAILED', message: error.message };
  }
}

export function persistResourceBudgetCheckpoint({
  store,
  runId,
  checkpointRoot,
  kind,
  callId,
  ledger,
  recordedAt = new Date().toISOString()
} = {}) {
  const root = rootPath(store, runId, checkpointRoot);
  const checked = verifyResourceBudgetLedger(ledger);
  if (!root || checked.status !== 'OK' || !['reservation', 'settlement'].includes(kind)
      || !isSafeId(callId) || !Number.isFinite(Date.parse(recordedAt))) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_REQUEST_INVALID' };
  }
  try {
    const prior = records(store, runId, checkpointRoot);
    const sequence = prior.length + 1;
    const previousCheckpointSha256 = prior.at(-1)?.record?.checkpointSha256 ?? null;
    const core = {
      schemaVersion: RESOURCE_BUDGET_CHECKPOINT_SCHEMA,
      runId,
      sequence,
      kind,
      callId,
      ledger,
      ledgerSha256: ledger.ledgerSha256,
      previousCheckpointSha256,
      recordedAt
    };
    const checkpoint = {
      ...core,
      checkpointSha256: sha256(canonicalVNextJson(core))
    };
    if (validateResourceBudgetCheckpoint(checkpoint).status !== 'OK') {
      return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_INVALID' };
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const relativePath = `${checkpointRoot}/${String(sequence).padStart(4, '0')}-${checkpoint.checkpointSha256}.json`;
    const existing = store.readRunFile(runId, relativePath);
    const content = `${canonicalVNextJson(checkpoint)}\n`;
    if (existing != null && existing !== content) {
      return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_CONFLICT' };
    }
    if (existing == null) store.writeRunFile(runId, relativePath, content);
    const replay = verifyResourceBudgetCheckpointHistory({ store, runId, checkpointRoot });
    return replay.status === 'OK'
        && replay.latestCheckpointSha256 === checkpoint.checkpointSha256
      ? { status: 'OK', checkpoint, history: replay }
      : replay;
  } catch (error) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_CHECKPOINT_WRITE_FAILED', message: error.message };
  }
}

function breachPayload(record) {
  const { breachSha256, ...core } = record;
  return core;
}

export function validateResourceBudgetBreachEvidence(record) {
  const keys = [
    'schemaVersion', 'runId', 'checkpointRoot', 'callId', 'reservationId',
    'reservationEntrySha256', 'settlement', 'ledger', 'ledgerSha256',
    'previousCheckpointSha256', 'recordedAt', 'breachSha256'
  ];
  const checked = verifyResourceBudgetLedger(record?.ledger);
  const latest = record?.ledger?.entries?.at(-1);
  const reservation = record?.ledger?.entries?.find((entry) => (
    entry.kind === 'reservation' && entry.reservationId === record?.reservationId
  ));
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).length !== keys.length
      || !keys.every((key) => Object.hasOwn(record, key))
      || record.schemaVersion !== RESOURCE_BUDGET_BREACH_SCHEMA
      || !isSafeId(record.runId) || !isSafeId(record.callId)
      || !isSafeId(record.reservationId)
      || !validCheckpointRoot(record.checkpointRoot)
      || checked.status !== 'REFUSED'
      || checked.code !== 'RESOURCE_BUDGET_EXCEEDED'
      || record.ledgerSha256 !== record.ledger?.ledgerSha256
      || latest?.kind !== 'settlement' || latest.withinReservation !== false
      || canonicalVNextJson(record.settlement) !== canonicalVNextJson(latest)
      || latest.reservationId !== record.reservationId
      || reservation?.callId !== record.callId
      || reservation.entrySha256 !== record.reservationEntrySha256
      || !/^[a-f0-9]{64}$/.test(String(record.previousCheckpointSha256 || ''))
      || !Number.isFinite(Date.parse(record.recordedAt))
      || Date.parse(record.recordedAt) < Date.parse(latest.settledAt)
      || record.breachSha256 !== sha256(canonicalVNextJson(breachPayload(record)))) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_INVALID' };
  }
  return { status: 'OK', evidence: record, budget: checked };
}

export function verifyResourceBudgetBreachEvidenceFromDisk({
  store,
  runId,
  checkpointRoot,
  reservationId
} = {}) {
  if (!rootPath(store, runId, checkpointRoot) || !isSafeId(reservationId)) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_INPUT_INVALID' };
  }
  let evidence;
  try {
    evidence = JSON.parse(
      store.readRunFile(runId, breachPath(checkpointRoot, reservationId)) || ''
    );
  } catch {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_MISSING' };
  }
  const checked = validateResourceBudgetBreachEvidence(evidence);
  const history = verifyResourceBudgetCheckpointHistory({ store, runId, checkpointRoot });
  return checked.status === 'OK'
      && evidence.runId === runId
      && evidence.checkpointRoot === checkpointRoot
      && evidence.reservationId === reservationId
      && history.status === 'OK'
      && history.latestCheckpointSha256 === evidence.previousCheckpointSha256
      && history.unresolvedReservations.some((row) => (
        row.reservationId === reservationId && row.callId === evidence.callId
      ))
    ? { status: 'OK', evidence, history }
    : { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_REPLAY_FAILED' };
}

export function persistResourceBudgetBreachEvidence({
  store,
  runId,
  checkpointRoot,
  callId,
  ledger,
  settlement,
  recordedAt = new Date().toISOString()
} = {}) {
  if (store?.durability !== STORE_DURABILITY.POWER_LOSS
      || !rootPath(store, runId, checkpointRoot)
      || !isSafeId(callId)
      || !Number.isFinite(Date.parse(recordedAt))) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_REQUEST_INVALID' };
  }
  const history = verifyResourceBudgetCheckpointHistory({ store, runId, checkpointRoot });
  const reservationId = settlement?.reservationId;
  const reservation = ledger?.entries?.find((entry) => (
    entry.kind === 'reservation' && entry.reservationId === reservationId
  ));
  if (history.status !== 'OK' || !isSafeId(reservationId)
      || reservation?.callId !== callId) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_HISTORY_INVALID' };
  }
  const core = {
    schemaVersion: RESOURCE_BUDGET_BREACH_SCHEMA,
    runId,
    checkpointRoot,
    callId,
    reservationId,
    reservationEntrySha256: reservation.entrySha256,
    settlement,
    ledger,
    ledgerSha256: ledger.ledgerSha256,
    previousCheckpointSha256: history.latestCheckpointSha256,
    recordedAt
  };
  const evidence = {
    ...core,
    breachSha256: sha256(canonicalVNextJson(core))
  };
  if (validateResourceBudgetBreachEvidence(evidence).status !== 'OK') {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_INVALID' };
  }
  const relativePath = breachPath(checkpointRoot, reservationId);
  const content = `${canonicalVNextJson(evidence)}\n`;
  const existing = store.readRunFile(runId, relativePath);
  if (existing != null && existing !== content) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_BREACH_EVIDENCE_CONFLICT' };
  }
  if (existing == null) store.writeRunFile(runId, relativePath, content);
  const replay = verifyResourceBudgetBreachEvidenceFromDisk({
    store,
    runId,
    checkpointRoot,
    reservationId
  });
  return replay.status === 'OK'
    ? { status: 'OK', evidence, path: relativePath, idempotent: existing != null }
    : replay;
}
