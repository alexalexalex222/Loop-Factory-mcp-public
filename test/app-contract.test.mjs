import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLoopFactoryEvidenceIndex,
  buildLoopFactoryEventFeed,
  buildLoopFactoryRunEnvelope,
  buildLoopFactoryRunList
} from '../src/app-contract.mjs';
import { canaryState } from './fixtures/canary-state.mjs';

function state(runId, updatedAt) {
  const value = structuredClone(canaryState());
  value.runId = runId;
  value.updatedAt = updatedAt;
  value.verification.runId = runId;
  return value;
}

test('app run and event feeds use bounded opaque cursor pages', () => {
  const newer = state('run-newer', '2026-08-05T02:00:00.000Z');
  const older = state('run-older', '2026-08-05T01:00:00.000Z');
  const first = buildLoopFactoryRunList([older, newer], { limit: 1 });
  assert.equal(first.status, 'OK');
  assert.equal(first.runs[0].runId, 'run-newer');
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^run-[a-f0-9]{32}$/);
  const second = buildLoopFactoryRunList([older, newer], {
    after: first.nextCursor,
    limit: 1
  });
  assert.equal(second.runs[0].runId, 'run-older');
  assert.equal(second.hasMore, false);
  assert.equal(buildLoopFactoryRunList([older, newer], {
    after: 'run-00000000000000000000000000000000'
  }).code, 'APP_RUN_CURSOR_UNKNOWN');

  const eventState = {
    runId: 'run-events',
    updatedAt: newer.updatedAt,
    runlog: Array.from({ length: 5 }, (_, index) => ({
      type: 'TEST_EVENT',
      at: `2026-08-05T02:00:0${index}.000Z`,
      detailSha256: String(index + 1).repeat(64),
      message: 'Bearer ordinary-key-secret-value',
      code: 'api_key=ordinary-key-secret-value'
    }))
  };
  const eventFirst = buildLoopFactoryEventFeed(eventState, { limit: 2 });
  assert.equal(eventFirst.status, 'OK');
  assert.equal(eventFirst.events.length, 2);
  assert.doesNotMatch(JSON.stringify(eventFirst), /ordinary-key-secret-value/);
  assert.equal(eventFirst.hasMore, true);
  const eventSecond = buildLoopFactoryEventFeed(eventState, {
    after: eventFirst.nextCursor,
    limit: 2
  });
  assert.equal(eventSecond.status, 'OK');
  assert.equal(eventSecond.events[0].sequence, 2);
  assert.equal(buildLoopFactoryEventFeed(eventState, {
    after: 'evt-00000000000000000000000000000000'
  }).code, 'APP_EVENT_CURSOR_UNKNOWN');
});

test('app envelope binds state revision and evidence stays metadata-only', () => {
  const current = state('run-evidence', '2026-08-05T02:00:00.000Z');
  const envelope = buildLoopFactoryRunEnvelope(current);
  assert.match(envelope.stateRevisionSha256, /^[a-f0-9]{64}$/);
  assert.equal(envelope.capabilities.evidenceIndex, true);
  assert.equal(envelope.capabilities.evidenceBodies, false);

  const evidence = buildLoopFactoryEvidenceIndex(current);
  assert.equal(evidence.status, 'OK');
  assert.equal(evidence.artifactBodiesExposed, false);
  assert.ok(evidence.entries.length > 0);
  assert.ok(evidence.entries.every((entry) => entry.artifactAvailable === false));
  assert.ok(evidence.entries.every((entry) => entry.verificationState === 'REFERENCE'));
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /PROMPT_SECRET|PROCEDURE_SECRET|\/Users\/operator/);

  const boundSha256 = '1'.repeat(64);
  const snapshot = structuredClone(envelope.snapshot);
  snapshot.recursive = {
    ...(snapshot.recursive || {}),
    verifier: { status: 'OK', seriesValid: true, evidenceSha256: boundSha256 }
  };
  snapshot.receipts = { arbitraryReceiptSha256: boundSha256 };
  const bound = buildLoopFactoryEvidenceIndex(current, { snapshot });
  assert.equal(
    bound.entries.find((entry) => entry.sha256 === boundSha256).verificationState,
    'BOUND'
  );
});
