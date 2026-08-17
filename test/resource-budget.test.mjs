import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResourceBudgetLedger,
  createResourceBudgetPolicy,
  reserveResourceBudget,
  settleResourceBudget,
  verifyResourceBudgetLedger
} from '../src/resource-budget.mjs';
import { sha256 } from '../src/util.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';

function ledger() {
  const policy = createResourceBudgetPolicy({
    policyId: 'budget-1',
    maxCalls: 2,
    maxInputTokens: 100,
    maxOutputTokens: 50,
    maxTotalTokens: 150,
    maxUsdMicros: 200,
    inputUsdMicrosPerMillionTokens: 1000000,
    outputUsdMicrosPerMillionTokens: 2000000,
    billingMode: 'metered',
    currency: 'USD'
  });
  assert.equal(policy.status, 'OK');
  return createResourceBudgetLedger({
    policy: policy.policy,
    runId: 'run-1',
    createdAt: '2026-08-05T00:00:00.000Z'
  }).ledger;
}

test('budget reservations fail before a call that exceeds a hard ceiling', () => {
  const first = reserveResourceBudget(ledger(), {
    callId: 'call-1',
    maxInputTokens: 60,
    maxOutputTokens: 20,
    createdAt: '2026-08-05T00:00:01.000Z'
  });
  assert.equal(first.status, 'OK');
  assert.equal(reserveResourceBudget(first.ledger, {
    callId: 'call-2',
    maxInputTokens: 41,
    maxOutputTokens: 1,
    createdAt: '2026-08-05T00:00:02.000Z'
  }).code, 'RESOURCE_BUDGET_RESERVATION_EXCEEDS_HARD_CAP');
});

test('settlement requires trusted usage and blocks over-reservation receipts', () => {
  const reserved = reserveResourceBudget(ledger(), {
    callId: 'call-1',
    maxInputTokens: 60,
    maxOutputTokens: 20,
    createdAt: '2026-08-05T00:00:01.000Z'
  });
  assert.equal(settleResourceBudget(reserved.ledger, {
    reservationId: reserved.reservation.reservationId,
    inputTokens: 1,
    outputTokens: 1,
    settledAt: '2026-08-05T00:00:02.000Z',
    usageAuthority: 'caller'
  }).status, 'REFUSED');
  const breached = settleResourceBudget(reserved.ledger, {
    reservationId: reserved.reservation.reservationId,
    inputTokens: 61,
    outputTokens: 20,
    settledAt: '2026-08-05T00:00:02.000Z',
    usageAuthority: 'cli-receipt'
  });
  assert.equal(breached.status, 'BLOCKED');
  assert.equal(verifyResourceBudgetLedger(breached.ledger).status, 'REFUSED');
});

test('valid ledgers replay across restart and detect tampering', () => {
  const reserved = reserveResourceBudget(ledger(), {
    callId: 'call-1',
    maxInputTokens: 60,
    maxOutputTokens: 20,
    createdAt: '2026-08-05T00:00:01.000Z'
  });
  const settled = settleResourceBudget(reserved.ledger, {
    reservationId: reserved.reservation.reservationId,
    inputTokens: 50,
    outputTokens: 10,
    settledAt: '2026-08-05T00:00:02.000Z',
    usageAuthority: 'provider-receipt'
  });
  assert.equal(settled.status, 'OK');
  const reopened = JSON.parse(JSON.stringify(settled.ledger));
  assert.equal(verifyResourceBudgetLedger(reopened).status, 'OK');
  reopened.entries[1].inputTokens = 49;
  assert.equal(verifyResourceBudgetLedger(reopened).status, 'REFUSED');
});

test('subscription OAuth budgets still require explicit zero USD ceilings', () => {
  const result = createResourceBudgetPolicy({
    policyId: 'oauth-budget',
    maxCalls: 1,
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxTotalTokens: 200,
    maxUsdMicros: 0,
    inputUsdMicrosPerMillionTokens: 0,
    outputUsdMicrosPerMillionTokens: 0,
    billingMode: 'subscription-no-metered-usd',
    currency: 'USD'
  });
  assert.equal(result.status, 'OK');
});

test('policy substitution and duplicate call IDs fail before settlement', () => {
  const first = reserveResourceBudget(ledger(), {
    callId: 'same-call',
    maxInputTokens: 20,
    maxOutputTokens: 10,
    createdAt: '2026-08-05T00:00:01.000Z'
  });
  assert.equal(first.status, 'OK');
  assert.equal(reserveResourceBudget(first.ledger, {
    callId: 'same-call',
    maxInputTokens: 20,
    maxOutputTokens: 10,
    createdAt: '2026-08-05T00:00:02.000Z'
  }).code, 'RESOURCE_BUDGET_DUPLICATE_RESERVATION');

  const substituted = structuredClone(first.ledger);
  substituted.policy.maxCalls += 1;
  const core = structuredClone(substituted);
  delete core.ledgerSha256;
  substituted.ledgerSha256 = sha256(canonicalVNextJson(core));
  assert.equal(settleResourceBudget(substituted, {
    reservationId: first.reservation.reservationId,
    inputTokens: 1,
    outputTokens: 1,
    settledAt: '2026-08-05T00:00:03.000Z',
    usageAuthority: 'cli-receipt'
  }).status, 'REFUSED');
});
