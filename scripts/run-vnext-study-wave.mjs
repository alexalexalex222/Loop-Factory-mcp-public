#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, STORE_DURABILITY } from '../src/store.mjs';
import {
  verifyVNextAblationProtocolFromDisk
} from '../src/vnext-ablation-protocol.mjs';
import {
  runVNextCampaignSeriesTick,
  verifyVNextCampaignSeries
} from '../src/vnext-campaign-driver.mjs';
import {
  persistVNextCampaignLaunchAuthorization
} from '../src/vnext-campaign-launch-authorization.mjs';
import { verifyVNextStudyPlanFromDisk } from '../src/vnext-study-plan.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--home', '--run', '--wave', '--approved-plan', '--protocol'].includes(argv[index])
        || typeof argv[index + 1] !== 'string') return null;
    const name = argv[index].slice(2).replace('-', '');
    out[name] = argv[index + 1];
  }
  return out.home && out.run && out.wave && out.approvedplan && out.protocol
    ? out
    : null;
}

const args = parse(process.argv.slice(2));
if (!args) {
  process.stderr.write('usage: npm run vnext:study:run -- --home <proof-home> --run <series-run-id> --wave <wave-id> --approved-plan <study-disclosure-sha256> --protocol <ablation-protocol.json>\n');
  process.exit(2);
}

const store = createStore(resolve(args.home), {
  durability: STORE_DURABILITY.POWER_LOSS
});
let protocol;
try {
  protocol = JSON.parse(readFileSync(resolve(args.protocol), 'utf8'));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED',
    code: 'VNEXT_STUDY_PROTOCOL_JSON_INVALID',
    message: error.message
  }, null, 2)}\n`);
  process.exit(2);
}
const protocolReplay = verifyVNextAblationProtocolFromDisk({
  protocol,
  packageRoot: PACKAGE_ROOT
});
if (protocolReplay.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(protocolReplay, null, 2)}\n`);
  process.exit(1);
}
const approved = verifyVNextStudyPlanFromDisk({
  store,
  seriesRunId: args.run,
  waveId: args.wave,
  approvedPlanSha256: args.approvedplan,
  requireApproval: true
});
if (approved.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(approved, null, 2)}\n`);
  process.exit(1);
}
if (approved.disclosure.studyBinding.protocolSha256 !== protocol.protocolSha256) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED',
    code: 'VNEXT_STUDY_PROTOCOL_BINDING_MISMATCH',
    message: 'The approved study disclosure is bound to a different protocol.'
  }, null, 2)}\n`);
  process.exit(1);
}
const state = approved.planned.series.state;
if (state.status !== 'READY' || state.currentWave !== null
    || state.queue.length !== 1 || state.queue[0].waveId !== args.wave
    || state.completedWaves.length !== 0 || state.operatorStop) {
  process.stdout.write(`${JSON.stringify({
    status: 'REFUSED',
    code: 'VNEXT_STUDY_NOT_FRESHLY_QUEUED',
    message: 'An approved study wave may be launched exactly once from its pristine READY checkpoint.'
  }, null, 2)}\n`);
  process.exit(1);
}

const launchAuthorization = persistVNextCampaignLaunchAuthorization({
  store,
  seriesRunId: args.run,
  waveId: args.wave,
  approvedPlanSha256: args.approvedplan,
  protocolSha256: protocol.protocolSha256
});
if (launchAuthorization.status !== 'OK') {
  process.stdout.write(`${JSON.stringify(launchAuthorization, null, 2)}\n`);
  process.exit(1);
}

const runtime = approved.planned.inputs.config.runtimeAuthority;
process.env.SUPER_LOOP_ALLOW_EXEC = '1';
process.env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH = '1';
process.env.SUPER_LOOP_CODEX_BIN = runtime.binary.path;
process.env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256 = runtime.binary.sha256;
process.env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256 = runtime.authoritySha256;

const result = await runVNextCampaignSeriesTick({
  store,
  seriesRunId: args.run,
  protocol,
  launchAuthorizationSha256:
    launchAuthorization.authorization.authorizationSha256,
  packageRoot: PACKAGE_ROOT
});
const verification = verifyVNextCampaignSeries({
  store,
  seriesRunId: args.run
});
const ok = result.status === 'OK'
  && verification.status === 'OK'
  && verification.seriesValid === true;
process.stdout.write(`${JSON.stringify({
  status: ok ? 'OK' : 'REFUSED',
  approvalPlanSha256: args.approvedplan,
  result,
  independentVerification: verification
}, null, 2)}\n`);
process.exit(ok ? 0 : 1);
