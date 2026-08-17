#!/usr/bin/env node

import { resolve } from 'node:path';
import { createStore, STORE_DURABILITY } from '../src/store.mjs';
import { isSafeId, sha256 } from '../src/util.mjs';
import { canonicalVNextJson } from '../src/vnext-contracts.mjs';
import { loadCampaignSeriesStore } from '../src/campaign-series-store.mjs';
import { signalRunLeaseOwner } from '../src/run-lease.mjs';
import {
  createVNextCampaignStopReceipt,
  validateVNextCampaignStopReceipt
} from '../src/vnext-campaign-driver.mjs';
import {
  cancelVNextCampaignLaunchAuthorization
} from '../src/vnext-campaign-launch-authorization.mjs';

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--home', '--run'].includes(argv[index]) || !argv[index + 1]) return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out.home && isSafeId(out.run) ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:campaign:stop -- --home <proof-home> --run <series-run-id>\n');
  process.exit(2);
}
const store = createStore(resolve(args.home), {
  durability: STORE_DURABILITY.POWER_LOSS
});
const current = store.readRunFile(args.run, 'campaign-series/STOP');
const loaded = loadCampaignSeriesStore({ store, runId: args.run });
let receipt;
if (current == null) {
  const created = createVNextCampaignStopReceipt({
    seriesRunId: args.run,
    state: loaded.status === 'OK' ? loaded.state : null
  });
  if (created.status !== 'OK') {
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    process.exit(1);
  }
  receipt = created.receipt;
} else {
  try { receipt = JSON.parse(current); } catch { receipt = null; }
  const checked = validateVNextCampaignStopReceipt(receipt);
  if (checked.status !== 'OK' || receipt.runId !== args.run) {
    process.stdout.write(`${JSON.stringify(
      checked.status === 'OK'
        ? { status: 'REFUSED', code: 'VNEXT_CAMPAIGN_STOP_RUN_MISMATCH' }
        : checked,
      null,
      2
    )}\n`);
    process.exit(1);
  }
}
const content = current ?? `${canonicalVNextJson(receipt)}\n`;
const path = current == null
  ? store.writeRunFile(args.run, 'campaign-series/STOP', content)
  : `${store.runDir(args.run)}/campaign-series/STOP`;
const cancelled = receipt.waveId
  ? cancelVNextCampaignLaunchAuthorization({
      store,
      seriesRunId: args.run,
      waveId: receipt.waveId
    })
  : { status: 'OK', disposition: 'NO_WAVE' };
const signaled = signalRunLeaseOwner({
  homeDir: store.homeDir,
  runId: args.run,
  signal: 'SIGTERM'
});
process.stdout.write(`${JSON.stringify({
  status: 'OK', runId: args.run, path,
  stopSha256: sha256(content), idempotent: current != null,
  waveId: receipt.waveId,
  launchAuthorization: cancelled,
  supervisorSignal: signaled
}, null, 2)}\n`);
