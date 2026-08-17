import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const RESOURCE_BUDGET_SCHEMA = 'loop-factory-resource-budget-v1';
export const RESOURCE_BUDGET_LEDGER_SCHEMA = 'loop-factory-resource-budget-ledger-v1';

const SHA256 = /^[a-f0-9]{64}$/;

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function policyPayload(policy) {
  return {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    maxCalls: policy.maxCalls,
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
    maxTotalTokens: policy.maxTotalTokens,
    maxUsdMicros: policy.maxUsdMicros,
    inputUsdMicrosPerMillionTokens: policy.inputUsdMicrosPerMillionTokens,
    outputUsdMicrosPerMillionTokens: policy.outputUsdMicrosPerMillionTokens,
    billingMode: policy.billingMode,
    currency: policy.currency
  };
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function createResourceBudgetPolicy(input = {}) {
  const base = {
    schemaVersion: RESOURCE_BUDGET_SCHEMA,
    policyId: String(input.policyId || ''),
    maxCalls: input.maxCalls,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    maxTotalTokens: input.maxTotalTokens,
    maxUsdMicros: input.maxUsdMicros,
    inputUsdMicrosPerMillionTokens: input.inputUsdMicrosPerMillionTokens,
    outputUsdMicrosPerMillionTokens: input.outputUsdMicrosPerMillionTokens,
    billingMode: input.billingMode,
    currency: input.currency || 'USD'
  };
  if (!isSafeId(base.policyId)
      || !integer(base.maxCalls, 1)
      || !integer(base.maxInputTokens, 1)
      || !integer(base.maxOutputTokens, 1)
      || !integer(base.maxTotalTokens, 1)
      || base.maxTotalTokens > base.maxInputTokens + base.maxOutputTokens
      || !integer(base.maxUsdMicros)
      || !integer(base.inputUsdMicrosPerMillionTokens)
      || !integer(base.outputUsdMicrosPerMillionTokens)
      || !['metered', 'subscription-no-metered-usd'].includes(base.billingMode)
      || base.currency !== 'USD') {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_POLICY_INVALID' };
  }
  if (base.billingMode === 'subscription-no-metered-usd'
      && (base.maxUsdMicros !== 0
        || base.inputUsdMicrosPerMillionTokens !== 0
        || base.outputUsdMicrosPerMillionTokens !== 0)) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_SUBSCRIPTION_COST_INVALID' };
  }
  return {
    status: 'OK',
    policy: {
      ...base,
      policySha256: sha256(canonicalVNextJson(base))
    }
  };
}

function usdMicros(policy, inputTokens, outputTokens) {
  return Math.ceil((inputTokens * policy.inputUsdMicrosPerMillionTokens
    + outputTokens * policy.outputUsdMicrosPerMillionTokens) / 1000000);
}

function entryPayload(entry) {
  const { entrySha256, ...payload } = entry;
  return payload;
}

function sealEntry(entry) {
  return { ...entry, entrySha256: sha256(canonicalVNextJson(entry)) };
}

export function createResourceBudgetLedger({ policy, runId, createdAt } = {}) {
  const checked = createResourceBudgetPolicy(policy);
  const normalized = checked.status === 'OK' ? checked.policy : policy;
  if (!normalized || normalized.policySha256 !== sha256(canonicalVNextJson(policyPayload(normalized)))
      || !isSafeId(runId)
      || !Number.isFinite(Date.parse(createdAt))) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_LEDGER_INVALID' };
  }
  const base = {
    schemaVersion: RESOURCE_BUDGET_LEDGER_SCHEMA,
    runId,
    policy: structuredClone(normalized),
    createdAt,
    entries: []
  };
  return {
    status: 'OK',
    ledger: { ...base, ledgerSha256: sha256(canonicalVNextJson(base)) }
  };
}

function replay(ledger) {
  const totals = {
    callsReserved: 0,
    callsSettled: 0,
    inputReserved: 0,
    outputReserved: 0,
    inputUsed: 0,
    outputUsed: 0,
    usdReserved: 0,
    usdUsed: 0,
    breached: false
  };
  const reservations = new Map();
  const callIds = new Set();
  let previousEntrySha256 = null;
  for (let index = 0; index < ledger.entries.length; index += 1) {
    const entry = ledger.entries[index];
    if (!entry || entry.index !== index
        || entry.previousEntrySha256 !== previousEntrySha256
        || entry.entrySha256 !== sha256(canonicalVNextJson(entryPayload(entry)))) {
      return { status: 'REFUSED', code: 'RESOURCE_BUDGET_LEDGER_TAMPERED' };
    }
    if (entry.kind === 'reservation') {
      if (reservations.has(entry.reservationId) || callIds.has(entry.callId)) {
        return { status: 'REFUSED', code: 'RESOURCE_BUDGET_DUPLICATE_RESERVATION' };
      }
      reservations.set(entry.reservationId, { entry, settled: false });
      callIds.add(entry.callId);
      totals.callsReserved += 1;
      totals.inputReserved += entry.maxInputTokens;
      totals.outputReserved += entry.maxOutputTokens;
      totals.usdReserved += entry.maxUsdMicros;
    } else if (entry.kind === 'settlement') {
      const reservation = reservations.get(entry.reservationId);
      if (!reservation || reservation.settled) {
        return { status: 'REFUSED', code: 'RESOURCE_BUDGET_SETTLEMENT_ORPHAN' };
      }
      reservation.settled = true;
      totals.callsSettled += 1;
      totals.inputUsed += entry.inputTokens;
      totals.outputUsed += entry.outputTokens;
      totals.usdUsed += entry.usdMicros;
      totals.breached ||= entry.withinReservation !== true;
    } else {
      return { status: 'REFUSED', code: 'RESOURCE_BUDGET_ENTRY_KIND_INVALID' };
    }
    previousEntrySha256 = entry.entrySha256;
  }
  return { status: 'OK', totals, reservations, previousEntrySha256 };
}

function resealLedger(ledger) {
  const base = {
    schemaVersion: ledger.schemaVersion,
    runId: ledger.runId,
    policy: ledger.policy,
    createdAt: ledger.createdAt,
    entries: ledger.entries
  };
  return { ...base, ledgerSha256: sha256(canonicalVNextJson(base)) };
}

export function verifyResourceBudgetLedger(ledger) {
  const checkedPolicy = createResourceBudgetPolicy(ledger?.policy);
  if (!ledger || ledger.schemaVersion !== RESOURCE_BUDGET_LEDGER_SCHEMA
      || !exactKeys(ledger, [
        'schemaVersion', 'runId', 'policy', 'createdAt', 'entries', 'ledgerSha256'
      ])
      || !exactKeys(ledger.policy, [
        'schemaVersion', 'policyId', 'maxCalls', 'maxInputTokens',
        'maxOutputTokens', 'maxTotalTokens', 'maxUsdMicros',
        'inputUsdMicrosPerMillionTokens', 'outputUsdMicrosPerMillionTokens',
        'billingMode', 'currency', 'policySha256'
      ])
      || checkedPolicy.status !== 'OK'
      || checkedPolicy.policy.policySha256 !== ledger.policy?.policySha256
      || ledger.ledgerSha256 !== sha256(canonicalVNextJson({
        schemaVersion: ledger.schemaVersion,
        runId: ledger.runId,
        policy: ledger.policy,
        createdAt: ledger.createdAt,
        entries: ledger.entries
      }))) return { status: 'REFUSED', code: 'RESOURCE_BUDGET_LEDGER_HASH' };
  const result = replay(ledger);
  if (result.status !== 'OK') return result;
  const p = ledger.policy;
  const t = result.totals;
  const withinPolicy = !t.breached
    && t.callsReserved <= p.maxCalls
    && t.inputReserved <= p.maxInputTokens
    && t.outputReserved <= p.maxOutputTokens
    && t.inputReserved + t.outputReserved <= p.maxTotalTokens
    && t.usdReserved <= p.maxUsdMicros;
  const unresolvedReservations = [...result.reservations.values()]
    .filter((reservation) => !reservation.settled)
    .map((reservation) => ({
      reservationId: reservation.entry.reservationId,
      callId: reservation.entry.callId,
      entrySha256: reservation.entry.entrySha256
    }));
  return {
    status: withinPolicy ? 'OK' : 'REFUSED',
    code: withinPolicy ? null : 'RESOURCE_BUDGET_EXCEEDED',
    totals: t,
    unresolvedReservations
  };
}

export function reserveResourceBudget(ledger, {
  callId,
  maxInputTokens,
  maxOutputTokens,
  createdAt
} = {}) {
  const checked = verifyResourceBudgetLedger(ledger);
  if (checked.status !== 'OK'
      || !isSafeId(callId)
      || !integer(maxInputTokens, 1)
      || !integer(maxOutputTokens, 1)
      || !Number.isFinite(Date.parse(createdAt))) {
    return { status: 'REFUSED', code: checked.code || 'RESOURCE_BUDGET_RESERVATION_INVALID' };
  }
  if (ledger.entries.some((entry) => (
    entry.kind === 'reservation' && entry.callId === callId
  ))) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_DUPLICATE_RESERVATION' };
  }
  const p = ledger.policy;
  const maxUsdMicros = usdMicros(p, maxInputTokens, maxOutputTokens);
  const t = checked.totals;
  if (t.callsReserved + 1 > p.maxCalls
      || t.inputReserved + maxInputTokens > p.maxInputTokens
      || t.outputReserved + maxOutputTokens > p.maxOutputTokens
      || t.inputReserved + t.outputReserved + maxInputTokens + maxOutputTokens > p.maxTotalTokens
      || t.usdReserved + maxUsdMicros > p.maxUsdMicros) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_RESERVATION_EXCEEDS_HARD_CAP' };
  }
  const index = ledger.entries.length;
  const reservationId = `reservation-${index}-${sha256(`${callId}:${createdAt}`).slice(0, 16)}`;
  const entry = sealEntry({
    index,
    kind: 'reservation',
    reservationId,
    callId,
    maxInputTokens,
    maxOutputTokens,
    maxUsdMicros,
    createdAt,
    previousEntrySha256: ledger.entries.at(-1)?.entrySha256 || null
  });
  const next = resealLedger({ ...ledger, entries: [...ledger.entries, entry] });
  return { status: 'OK', ledger: next, reservation: entry };
}

export function settleResourceBudget(ledger, {
  reservationId,
  inputTokens,
  outputTokens,
  settledAt,
  usageAuthority
} = {}) {
  const checked = verifyResourceBudgetLedger(ledger);
  if (checked.status !== 'OK') return checked;
  const replayed = replay(ledger);
  const reservation = replayed.status === 'OK'
    ? replayed.reservations.get(reservationId)
    : null;
  if (!reservation || reservation.settled
      || !integer(inputTokens)
      || !integer(outputTokens)
      || !Number.isFinite(Date.parse(settledAt))
      || !['cli-receipt', 'provider-receipt'].includes(usageAuthority)) {
    return { status: 'REFUSED', code: 'RESOURCE_BUDGET_SETTLEMENT_INVALID' };
  }
  const usd = usdMicros(ledger.policy, inputTokens, outputTokens);
  const withinReservation = inputTokens <= reservation.entry.maxInputTokens
    && outputTokens <= reservation.entry.maxOutputTokens
    && usd <= reservation.entry.maxUsdMicros;
  const index = ledger.entries.length;
  const entry = sealEntry({
    index,
    kind: 'settlement',
    reservationId,
    inputTokens,
    outputTokens,
    usdMicros: usd,
    usageAuthority,
    settledAt,
    withinReservation,
    previousEntrySha256: ledger.entries.at(-1)?.entrySha256 || null
  });
  const next = resealLedger({ ...ledger, entries: [...ledger.entries, entry] });
  return {
    status: withinReservation ? 'OK' : 'BLOCKED',
    code: withinReservation ? null : 'RESOURCE_BUDGET_RESERVATION_BREACHED',
    ledger: next,
    settlement: entry
  };
}
