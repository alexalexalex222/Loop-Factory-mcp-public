import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import {
  appendVNextWaveEvent,
  loadVNextWaveJournal,
  VNEXT_WAVE_EVENT
} from '../src/vnext-wave-journal.mjs';

test('wave journal is append-only, transition-checked, and cold-replayable', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'vnext-wave-journal-')));
  const input = { store, seriesRunId: 'series-1', waveId: 'wave-1' };
  assert.equal(appendVNextWaveEvent({
    ...input, type: VNEXT_WAVE_EVENT.STARTED,
    at: '2026-08-05T00:00:00.000Z',
    detail: {
      wavePlanSha256: 'a'.repeat(64),
      waveInputEvidenceSha256: 'b'.repeat(64)
    }
  }).status, 'OK');
  assert.equal(appendVNextWaveEvent({
    ...input, type: VNEXT_WAVE_EVENT.PREPARATION_DISPATCHED,
    at: '2026-08-05T00:00:01.000Z',
    detail: {
      preparationRunId: 'prep-1',
      budgetPolicySha256: 'c'.repeat(64)
    }
  }).status, 'OK');
  assert.equal(appendVNextWaveEvent({
    ...input, type: VNEXT_WAVE_EVENT.EXPERIMENT_VERIFIED,
    at: '2026-08-05T00:00:02.000Z', detail: {}
  }).status, 'REFUSED');
  assert.equal(loadVNextWaveJournal(input).events.length, 2);

  const path = 'campaign-series/waves/wave-1/events.jsonl';
  store.writeRunFile('series-1', path, store.readRunFile('series-1', path)
    .replace('PREPARATION_DISPATCHED', 'EXPERIMENT_DISPATCHED'));
  assert.equal(loadVNextWaveJournal(input).status, 'REFUSED');
});
