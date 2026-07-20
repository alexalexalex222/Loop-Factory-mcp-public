import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMPAIGN_TARGET_INBOX,
  campaignTargetInboxPath,
  createCampaignIdleWait,
  normalizeCampaignIdlePollMs,
  validateCampaignTargetInbox
} from '../src/campaign-inbox.mjs';
import { freshEngine, BASELINE_BODY } from './helpers.mjs';
import { sha256 } from '../src/util.mjs';

test('campaign target inbox validates explicit mine/improve work only', () => {
  assert.equal(normalizeCampaignIdlePollMs(1), 250);
  assert.equal(normalizeCampaignIdlePollMs(999_999), 60_000);
  assert.equal(normalizeCampaignIdlePollMs('not-a-number'), 1000);
  assert.equal(validateCampaignTargetInbox({ targets: [] }, 'run-1').ok, false);
  assert.equal(validateCampaignTargetInbox({
    runId: 'other-run',
    targets: [{ kind: 'mine' }]
  }, 'run-1').ok, false);
  assert.equal(validateCampaignTargetInbox({
    runId: 'run-1',
    targets: [{ kind: 'unknown' }]
  }, 'run-1').ok, false);
  assert.equal(validateCampaignTargetInbox({
    runId: 'run-1',
    targets: [{ kind: 'improve' }]
  }, 'run-1').ok, false);
  assert.equal(validateCampaignTargetInbox({
    runId: 'run-1',
    targets: [{ kind: 'mine' }, { kind: 'improve', loop: 'loop-de-loop' }]
  }, 'run-1').ok, true);
});

test('idle wait consumes, hashes, and archives a valid target inbox before returning work', () => {
  const { store } = freshEngine();
  const runId = 'target-inbox-ok';
  const payload = JSON.stringify({
    runId,
    targets: [{
      kind: 'improve',
      loop: 'loop-de-loop',
      baselineContent: BASELINE_BODY
    }]
  }, null, 2);
  store.writeRunFile(runId, CAMPAIGN_TARGET_INBOX, payload);
  const messages = [];
  const idleWait = createCampaignIdleWait({
    store,
    runId,
    pollMs: 250,
    log: (message) => messages.push(message),
    sleep: () => assert.fail('an immediately available inbox must not sleep')
  });

  const wake = idleWait();
  assert.equal(wake.targets.length, 1);
  assert.equal(wake.sourceSha256, sha256(payload));
  assert.match(wake.archivedAs, /^inbox-targets\.applied-/);
  assert.equal(store.runFileExists(runId, CAMPAIGN_TARGET_INBOX), false);
  assert.ok(readdirSync(store.runDir(runId)).some((name) => name === wake.archivedAs));
  assert.ok(messages.some((message) => message.includes('target_inbox_applied 1 target(s)')));
  assert.equal(campaignTargetInboxPath(store, runId), join(store.runDir(runId), CAMPAIGN_TARGET_INBOX));
});

test('idle wait archives a mismatched target inbox and returns no work', () => {
  const { store } = freshEngine();
  const runId = 'target-inbox-reject';
  store.writeRunFile(runId, CAMPAIGN_TARGET_INBOX, JSON.stringify({
    runId: 'wrong-run',
    targets: [{ kind: 'mine' }]
  }));
  let sleeps = 0;
  const idleWait = createCampaignIdleWait({
    store,
    runId,
    pollMs: 250,
    sleep: () => { sleeps++; }
  });

  assert.equal(idleWait(), null);
  assert.equal(sleeps, 1);
  assert.equal(store.runFileExists(runId, CAMPAIGN_TARGET_INBOX), false);
  assert.ok(readdirSync(store.runDir(runId)).some((name) => /^inbox-targets\.rejected-/.test(name)));
});
