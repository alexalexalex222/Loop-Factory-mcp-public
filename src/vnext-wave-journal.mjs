import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_WAVE_EVENT_SCHEMA = 'loop-factory-vnext-wave-event-v1';

export const VNEXT_WAVE_EVENT = Object.freeze({
  STARTED: 'WAVE_STARTED',
  PREPARATION_DISPATCHED: 'PREPARATION_DISPATCHED',
  PREPARATION_PERSISTED: 'PREPARATION_PERSISTED',
  PREPARATION_REJECTED: 'PREPARATION_REJECTED',
  EXECUTION_BOUND: 'EXECUTION_BOUND',
  EXPERIMENT_DISPATCHED: 'EXPERIMENT_DISPATCHED',
  EXPERIMENT_VERIFIED: 'EXPERIMENT_VERIFIED',
  IMPORT_PERSISTED: 'IMPORT_PERSISTED',
  RESULT_PERSISTED: 'RESULT_PERSISTED',
  BLOCKED: 'WAVE_BLOCKED'
});

const TRANSITIONS = new Map([
  [null, [VNEXT_WAVE_EVENT.STARTED]],
  [VNEXT_WAVE_EVENT.STARTED, [VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED, [VNEXT_WAVE_EVENT.PREPARATION_PERSISTED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.PREPARATION_PERSISTED, [VNEXT_WAVE_EVENT.PREPARATION_REJECTED, VNEXT_WAVE_EVENT.EXECUTION_BOUND, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.PREPARATION_REJECTED, [VNEXT_WAVE_EVENT.RESULT_PERSISTED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.EXECUTION_BOUND, [VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED, [VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED, [VNEXT_WAVE_EVENT.IMPORT_PERSISTED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.IMPORT_PERSISTED, [VNEXT_WAVE_EVENT.RESULT_PERSISTED, VNEXT_WAVE_EVENT.BLOCKED]],
  [VNEXT_WAVE_EVENT.RESULT_PERSISTED, []],
  [VNEXT_WAVE_EVENT.BLOCKED, []]
]);

function refused(code, message) {
  return { status: 'REFUSED', code, message };
}

function pathFor(waveId) {
  return `campaign-series/waves/${waveId}/events.jsonl`;
}

function payload(event) {
  const core = structuredClone(event);
  delete core.eventSha256;
  return core;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

const DETAIL_KEYS = Object.freeze({
  [VNEXT_WAVE_EVENT.STARTED]: ['wavePlanSha256', 'waveInputEvidenceSha256'],
  [VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED]: ['preparationRunId', 'budgetPolicySha256'],
  [VNEXT_WAVE_EVENT.PREPARATION_PERSISTED]: ['preparationRunId', 'preparationEvidenceSha256'],
  [VNEXT_WAVE_EVENT.PREPARATION_REJECTED]: ['disposition', 'preparationEvidenceSha256'],
  [VNEXT_WAVE_EVENT.EXECUTION_BOUND]: ['bindingSha256', 'candidateFamilySha256', 'evolutionSha256'],
  [VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED]: ['experimentRunId', 'experimentPlanSha256', 'maximumCalls'],
  [VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED]: ['experimentRunId', 'experimentEvidenceSha256', 'leaseEvidenceSha256'],
  [VNEXT_WAVE_EVENT.IMPORT_PERSISTED]: ['recordId', 'recordSha256', 'evidenceLedgerSha256', 'catalogRecordSetSha256'],
  [VNEXT_WAVE_EVENT.RESULT_PERSISTED]: ['receiptSha256'],
  [VNEXT_WAVE_EVENT.BLOCKED]: ['code', 'message']
});

function detailValid(type, detail) {
  const keys = DETAIL_KEYS[type];
  if (!keys || !exactKeys(detail, keys)) return false;
  const hashes = Object.entries(detail)
    .filter(([key]) => key.toLowerCase().endsWith('sha256'))
    .map(([, value]) => value);
  if (hashes.some((value) => !/^[a-f0-9]{64}$/.test(String(value || '')))) return false;
  if ([VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED,
    VNEXT_WAVE_EVENT.PREPARATION_PERSISTED].includes(type)) {
    return isSafeId(detail.preparationRunId);
  }
  if ([VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED,
    VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED].includes(type)) {
    return isSafeId(detail.experimentRunId)
      && (type !== VNEXT_WAVE_EVENT.EXPERIMENT_DISPATCHED
        || Number.isSafeInteger(detail.maximumCalls) && detail.maximumCalls > 0);
  }
  if (type === VNEXT_WAVE_EVENT.IMPORT_PERSISTED) {
    return isSafeId(detail.recordId);
  }
  if (type === VNEXT_WAVE_EVENT.PREPARATION_REJECTED) {
    return typeof detail.disposition === 'string' && detail.disposition.length > 0;
  }
  if (type === VNEXT_WAVE_EVENT.BLOCKED) {
    return isSafeId(detail.code)
      && typeof detail.message === 'string'
      && detail.message.length > 0
      && detail.message.length <= 1000;
  }
  return true;
}

export function loadVNextWaveJournal({ store, seriesRunId, waveId } = {}) {
  try {
    if (!store || !isSafeId(seriesRunId) || !isSafeId(waveId)) {
      return refused('VNEXT_WAVE_JOURNAL_INPUT_INVALID', 'Safe series and wave IDs are required.');
    }
    const raw = store.readRunFile(seriesRunId, pathFor(waveId)) ?? '';
    const events = [];
    let previous = null;
    for (const [sequence, line] of raw.split('\n').filter(Boolean).entries()) {
      let event;
      try { event = JSON.parse(line); } catch {
        return refused('VNEXT_WAVE_JOURNAL_JSON_INVALID', `Wave event ${sequence} is invalid JSON.`);
      }
      const allowed = TRANSITIONS.get(previous?.type ?? null) ?? [];
      if (!exactKeys(event, [
        'schemaVersion', 'sequence', 'seriesRunId', 'waveId', 'type', 'at',
        'detail', 'detailSha256', 'previousEventSha256', 'eventSha256'
      ])
          || event.schemaVersion !== VNEXT_WAVE_EVENT_SCHEMA
          || event.sequence !== sequence
          || event.seriesRunId !== seriesRunId
          || event.waveId !== waveId
          || !allowed.includes(event.type)
          || !Number.isFinite(Date.parse(event.at))
          || !detailValid(event.type, event.detail)
          || event.detailSha256 !== sha256(canonicalVNextJson(event.detail))
          || event.previousEventSha256 !== (previous?.eventSha256 ?? null)
          || event.eventSha256 !== sha256(canonicalVNextJson(payload(event)))) {
        return refused('VNEXT_WAVE_JOURNAL_TAMPERED', `Wave event ${sequence} failed replay.`);
      }
      events.push(event);
      previous = event;
    }
    return {
      status: 'OK',
      events,
      latest: events.at(-1) ?? null,
      journalSha256: sha256(raw)
    };
  } catch (error) {
    return refused('VNEXT_WAVE_JOURNAL_LOAD_FAILED', error.message);
  }
}

export function appendVNextWaveEvent({
  store,
  seriesRunId,
  waveId,
  type,
  at,
  detail = {}
} = {}) {
  const loaded = loadVNextWaveJournal({ store, seriesRunId, waveId });
  if (loaded.status !== 'OK'
      || !Number.isFinite(Date.parse(at))
      || !detailValid(type, detail)) {
    return refused('VNEXT_WAVE_EVENT_INPUT_INVALID', 'Wave event input or existing journal is invalid.');
  }
  const allowed = TRANSITIONS.get(loaded.latest?.type ?? null) ?? [];
  if (!allowed.includes(type)) {
    return loaded.latest?.type === type
        && canonicalVNextJson(loaded.latest.detail) === canonicalVNextJson(detail)
      ? { status: 'OK', event: loaded.latest, idempotent: true }
      : refused('VNEXT_WAVE_EVENT_TRANSITION_INVALID', `Cannot append ${type} after ${loaded.latest?.type ?? 'empty journal'}.`);
  }
  const core = {
    schemaVersion: VNEXT_WAVE_EVENT_SCHEMA,
    sequence: loaded.events.length,
    seriesRunId,
    waveId,
    type,
    at,
    detail,
    detailSha256: sha256(canonicalVNextJson(detail)),
    previousEventSha256: loaded.latest?.eventSha256 ?? null
  };
  const event = { ...core, eventSha256: sha256(canonicalVNextJson(core)) };
  const next = [...loaded.events, event]
    .map((row) => canonicalVNextJson(row)).join('\n');
  store.writeRunFile(seriesRunId, pathFor(waveId), `${next}\n`);
  const reopened = loadVNextWaveJournal({ store, seriesRunId, waveId });
  return reopened.status === 'OK'
      && reopened.latest?.eventSha256 === event.eventSha256
    ? { status: 'OK', event, idempotent: false, journalSha256: reopened.journalSha256 }
    : refused('VNEXT_WAVE_EVENT_REOPEN_FAILED', 'Persisted wave event failed cold replay.');
}
