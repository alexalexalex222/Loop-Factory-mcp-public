#!/usr/bin/env node
// Verify a captured trajectory file against an expected sha256. Mirrors the digest the engine
// stamps in export_trajectories: sha256 of the file body read as utf8, via the SAME src/util.mjs
// sha256 — so a match here proves the bytes are exactly what the engine sealed.
//
//   node scripts/verify-trajectory.mjs --file <path> --expected-sha256 <hex>
//
// exit 0 = match · exit 1 = mismatch (tamper) · exit 2 = usage / unreadable file.
import { readFileSync } from 'node:fs';
import { sha256 } from '../src/util.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('usage: node scripts/verify-trajectory.mjs --file <path> --expected-sha256 <hex>\n  exit 0 match · 1 mismatch · 2 usage/IO error\n');
  process.exit(0);
}

const file = arg('--file');
const expected = (arg('--expected-sha256') || '').toLowerCase().trim();
if (!file || !expected) {
  process.stderr.write('error: both --file <path> and --expected-sha256 <hex> are required\n');
  process.exit(2);
}

let body;
try {
  body = readFileSync(file, 'utf8');
} catch (e) {
  process.stderr.write(`error: cannot read ${file}: ${e.message}\n`);
  process.exit(2);
}

const actual = sha256(body);
if (actual === expected) {
  process.stdout.write(`OK ${file}\n  sha256 ${actual} matches expected.\n`);
  process.exit(0);
}
process.stderr.write(`MISMATCH ${file}\n  expected ${expected}\n  actual   ${actual}\n`);
process.exit(1);
