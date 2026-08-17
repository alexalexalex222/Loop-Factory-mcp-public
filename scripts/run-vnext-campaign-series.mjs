#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, STORE_DURABILITY } from '../src/store.mjs';
import {
  runVNextCampaignSeriesContinuous,
  runVNextCampaignSeriesTick
} from '../src/vnext-campaign-driver.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = { once: false, pollMs: 5000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--once') out.once = true;
    else if (['--home', '--run', '--poll-ms', '--protocol'].includes(key) && argv[index + 1]) {
      out[key.slice(2).replace('-', '')] = argv[index + 1];
      index += 1;
    } else return null;
  }
  out.pollMs = Number(out.pollms ?? out.pollMs);
  return out.home && out.run && Number.isInteger(out.pollMs) ? out : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:campaign -- --home <proof-home> --run <series-run-id> [--protocol <ablation-protocol.json>] [--once] [--poll-ms 5000]\n');
  process.exit(2);
}
const store = createStore(resolve(args.home), {
  durability: STORE_DURABILITY.POWER_LOSS
});
let protocol = null;
try {
  protocol = args.protocol
    ? JSON.parse(readFileSync(resolve(args.protocol), 'utf8'))
    : null;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED',
    code: 'VNEXT_CAMPAIGN_PROTOCOL_JSON_INVALID',
    message: error.message
  }, null, 2)}\n`);
  process.exit(2);
}
const result = args.once
  ? await runVNextCampaignSeriesTick({
      store,
      seriesRunId: args.run,
      protocol,
      packageRoot: PACKAGE_ROOT
    })
  : await runVNextCampaignSeriesContinuous({
      store,
      seriesRunId: args.run,
      pollIntervalMs: args.pollMs,
      protocol,
      packageRoot: PACKAGE_ROOT
    });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.status === 'OK' ? 0 : 1);
