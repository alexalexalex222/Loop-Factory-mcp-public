#!/usr/bin/env node

import { resolve } from 'node:path';
import { createStore } from '../src/store.mjs';
import { verifyVNextCampaignSeries } from '../src/vnext-campaign-driver.mjs';

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--home', '--run'].includes(argv[index]) || !argv[index + 1]) return null;
    out[argv[index].slice(2)] = argv[index + 1];
  }
  return out.home && out.run ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run verify:vnext:campaign -- --home <proof-home> --run <series-run-id>\n');
  process.exit(2);
}
const result = verifyVNextCampaignSeries({
  store: createStore(resolve(args.home)),
  seriesRunId: args.run
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' && result.seriesValid === true ? 0 : 1);
