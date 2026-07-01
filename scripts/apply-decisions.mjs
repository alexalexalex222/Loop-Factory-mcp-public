#!/usr/bin/env node
// Operator-only: APPLY the decisions you exported from the dashboard.
//
// The dashboard records your Approve / Sludge clicks and its "Export" button saves a
// decisions.json:
//   { "runId": "...", "decisions": { "<reviewId>": { "decision": "approve"|"sludge", "notes": null } } }
//
// This script consumes that file and ACTUALLY APPLIES it: approving a loop-adoption
// review installs the improved loop as a new VERSION of a custom loop (the prior
// version is archived for rollback), which `loop_start { loop:"<id>" }` then streams
// next cycle. The hash-locked mandated loops are never touched.
//
// This is the out-of-band human action the dashboard's Export was always meant to
// feed. A worker model can QUEUE a review but can NEVER run this — adoption is yours.
// Applying is non-blocking: it does not stop a running campaign.
//
//   node scripts/apply-decisions.mjs --file ./decisions.json [--run <runId>] [--home <dir>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createEngine } from '../src/engine.mjs';

function flag(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const file = flag('--file');
if (!file) {
  console.error('usage: node scripts/apply-decisions.mjs --file ./decisions.json [--run <runId>] [--home <dir>]');
  process.exit(2);
}
let payload;
try {
  payload = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`cannot read decisions file "${file}": ${e.message}`);
  process.exit(2);
}

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = flag('--home', process.env.SUPER_LOOP_HOME || join(PKG_ROOT, '.super-loop'));
const runId = flag('--run', payload.runId);
if (!runId) {
  console.error('no runId — pass --run <id> or include "runId" in the decisions file');
  process.exit(2);
}

const store = createStore(home);
const engine = createEngine(store);
const res = engine.operator.applyDashboardDecisions({ runId, decisions: payload.decisions || {} });
console.log(JSON.stringify(res, null, 2));
process.exit(res.ok ? 0 : 1);
