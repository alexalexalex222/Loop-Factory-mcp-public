#!/usr/bin/env node

import { resolve } from 'node:path';
import { createStore } from '../src/store.mjs';
import { verifyVNextCampaignSeries } from '../src/vnext-campaign-driver.mjs';
import { verifyVNextStudyPlanFromDisk } from '../src/vnext-study-plan.mjs';

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--home', '--run', '--wave'].includes(argv[index])
        || typeof argv[index + 1] !== 'string') return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out.home && out.run && out.wave ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run verify:vnext:study -- --home <proof-home> --run <series-run-id> --wave <wave-id>\n');
  process.exit(2);
}
const store = createStore(resolve(args.home));
const plan = verifyVNextStudyPlanFromDisk({
  store,
  seriesRunId: args.run,
  waveId: args.wave
});
const campaign = verifyVNextCampaignSeries({
  store,
  seriesRunId: args.run
});
const valid = plan.status === 'OK'
  && campaign.status === 'OK'
  && campaign.seriesValid === true;
process.stdout.write(`${JSON.stringify({
  status: valid ? 'OK' : 'REFUSED',
  studyPlanValid: plan.status === 'OK',
  campaignValid: campaign.seriesValid === true,
  plan,
  campaign
}, null, 2)}\n`);
process.exit(valid ? 0 : 1);
