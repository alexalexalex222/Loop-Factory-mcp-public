#!/usr/bin/env node

import { runLeaseHeartbeatWorker } from '../src/run-lease-heartbeat.mjs';

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--home', '--run', '--control-sha256'].includes(key) || value == null) return null;
    values[key.slice(2)] = value;
  }
  return values.home && values.run && /^[a-f0-9]{64}$/.test(values['control-sha256'])
    ? values
    : null;
}

const parsed = parse(process.argv.slice(2));
if (!parsed) process.exit(2);
const result = runLeaseHeartbeatWorker({
  homeDir: parsed.home,
  runId: parsed.run,
  controlSha256: parsed['control-sha256']
});
if (result.status !== 'OK') process.exit(1);
