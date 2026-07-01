#!/usr/bin/env node
// Proves the bundled loop sources are the mandated local files (hash + line count
// + big-miner section markers), and prints the section split used for streaming.
import { MANDATED_LOOPS } from '../src/constants.mjs';
import { verifyAllLoops, loadLoop } from '../src/loops.mjs';

let failed = false;
console.log('super-loop-mcp · bundled loop verification\n');

for (const meta of Object.values(MANDATED_LOOPS)) {
  try {
    const l = loadLoop(meta.id);
    const okHash = l.sha256 === meta.sha256;
    const okLines = l.lines === meta.lines;
    console.log(`• ${meta.id}  (${meta.file})`);
    console.log(`    sha256 ${l.sha256} ${okHash ? 'OK' : 'MISMATCH != ' + meta.sha256}`);
    console.log(`    lines  ${l.lines} ${okLines ? 'OK' : 'MISMATCH != ' + meta.lines}`);
    console.log(`    trigger ${meta.trigger}`);
    console.log(`    sections (phase-gated) ${l.sections.length}`);
    if (meta.bigMinerMarkers.length) {
      const present = meta.bigMinerMarkers.every((m) => l.text.includes(m));
      console.log(`    big-miner markers ${present ? 'present (NOT the short GitHub miner)' : 'MISSING'}`);
      if (!present) failed = true;
    }
    if (!okHash || !okLines) failed = true;
  } catch (e) {
    console.log(`• ${meta.id}: ERROR ${e.message}`);
    failed = true;
  }
  console.log('');
}

const manifest = verifyAllLoops();
console.log('manifest:', JSON.stringify(manifest, null, 2));

if (failed) {
  console.error('\nFAILED: bundled sources do not match the mandated contract.');
  process.exit(1);
}
console.log('\nAll bundled sources verified against the mandated hashes.');
