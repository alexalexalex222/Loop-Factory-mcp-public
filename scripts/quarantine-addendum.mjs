#!/usr/bin/env node
// Integrity Gate req 7 — APPEND-ONLY quarantine addendum. Classifies prior suspect
// promotions WITHOUT deleting or rewriting any run evidence. It writes a new timestamped
// addendum file and appends one pointer line to a never-truncated ledger. It never edits
// or removes anything under proof/ or .super-loop/. Canonical loop changes remain operator
// authority only.
//
// Usage:  node scripts/quarantine-addendum.mjs [--suspects path/to/suspects.json]
// suspects.json (optional): [{ id, category, evidenceRef, why }]. Without it, the addendum
// records the four demonstrated suspect categories and the explicit R3/R5 keep-out.
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/util.mjs';
import { SEALED, ARTIFACT_CLASS } from '../src/integrity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = join(repo, 'proof', 'integrity');

// Deterministic, sortable timestamp for the filename. A plain Node script may read the
// clock (this is not a resumable workflow).
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const flagIdx = process.argv.indexOf('--suspects');
let suspects = null;
if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
  suspects = JSON.parse(readFileSync(process.argv[flagIdx + 1], 'utf8'));
}

// The four demonstrated suspect categories (used when no suspects file is supplied).
const DEMONSTRATED = [
  { id: 'H/Q-marker-receipts', category: 'marker_only_receipt_promotion', sealed: SEALED.ANSWER_KEY_ECHO_GUARD,
    why: 'Promotions won by emitting H61/H63 receipt marker tokens — the answer key became the task. Marker presence is not evidence.' },
  { id: 'identical-route-prose', category: 'identical_route_output', sealed: SEALED.ROUTE_SHA_COLLAPSE,
    why: 'Prose/receipt tests whose multiple "independent" routes produced byte-identical output (same SHA) — route independence was never established.' },
  { id: 'no-marker-baseline-vs-marker-candidate', category: 'answer_without_solution', sealed: SEALED.ANSWER_WITHOUT_SOLUTION,
    why: 'A marker-bearing candidate beat a no-marker baseline with no solution-pressure check (held-out / metamorphic / perturbation / replay / binding) — it answered the benchmark without solving the task.' },
  { id: 'receipt-as-frontier', category: 'receipt_maintenance_as_improvement', sealed: SEALED.STONE_INELIGIBLE,
    why: `Receipt/dashboard/report/manifest parity artifacts (artifactClass ${ARTIFACT_CLASS.RECEIPT_MAINTENANCE}) counted as quality-frontier loop improvements. Receipt maintenance is not a Stone unless it proves a real source-level behavior change.` }
];

// R3/R5 data-ingest portability candidates are explicitly KEPT OUT of quarantine. Framing
// matters: their capability was PRESERVED at quality 1.0 AND delivered at LOWER cost — nothing
// was lost. They kept solving the actual task across variants (all task-value probes present,
// held-out boundary transferred), which is exactly the solution-pressure the gate rewards.
const KEEP_OUT = [
  { id: 'R3-data-ingest-portability', why: 'Repaired R2 (reconciliation categories): capability PRESERVED at quality 1.0 and delivered at LOWER cost; held-out boundary transferred. Nothing lost — a real solution, not answer-key recognition.' },
  { id: 'R5-data-ingest-portability', why: 'Repaired R4 (non-destructive/canonical boundary): capability PRESERVED at quality 1.0 and delivered at LOWER cost; held-out boundary transferred. Nothing lost — a real solution, not answer-key recognition.' }
];

const items = (suspects || DEMONSTRATED);

const lines = [];
lines.push('# Integrity Gate — Quarantine Addendum (APPEND-ONLY)');
lines.push('');
lines.push(`- Generated: ${ts}`);
lines.push(`- Source: ${suspects ? process.argv[flagIdx + 1] : 'demonstrated suspect categories (no --suspects file supplied)'}`);
lines.push('');
lines.push('## Status of every item below');
lines.push('- **Preserved for forensic evidence.** Nothing here is deleted.');
lines.push('- **Not canonical.** This addendum changes no canonical loop file.');
lines.push('- **Not Stone-eligible** unless rescued by a later audit.');
lines.push('- **Canonical loop changes still require explicit operator authority** (dashboard).');
lines.push('');
lines.push('## Quarantined (suspect prior promotions)');
for (const s of items) {
  lines.push(`### ${s.id}`);
  lines.push(`- category: \`${s.category || 'unspecified'}\``);
  if (s.sealed) lines.push(`- sealed reason (ledger): \`${s.sealed}\``);
  if (s.evidenceRef) lines.push(`- evidence (preserved): \`${s.evidenceRef}\``);
  lines.push(`- why: ${s.why || '(unspecified)'}`);
  lines.push('- disposition: QUARANTINED — preserved, not deleted, not canonical, not Stone-eligible unless rescued by later audit.');
  lines.push('');
}
lines.push('## Explicitly KEPT OUT of quarantine (PRESERVED — capability held at 1.0, at lower cost)');
for (const k of KEEP_OUT) lines.push(`- **${k.id}** — disposition: PRESERVED (not quarantined). ${k.why}`);
lines.push('');
lines.push('> Solution-not-answer is the law; negative control is the cop. These items either answered the benchmark without solving the task, or were maintenance miscounted as improvement. The data-ingest cluster solved the task across variants and is retained.');
lines.push('');

const body = lines.join('\n');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `quarantine-addendum-${ts}.md`);
if (existsSync(outPath)) { console.error(`refusing to overwrite existing ${outPath}`); process.exit(2); }
writeFileSync(outPath, body); // a new, uniquely-named file → append-only by construction
const digest = sha256(readFileSync(outPath));

// Append a pointer to the never-truncated ledger (open in append mode; never rewritten).
const ledger = join(outDir, 'QUARANTINE-LEDGER.md');
if (!existsSync(ledger)) writeFileSync(ledger, '# Quarantine ledger (append-only)\n\n');
appendFileSync(ledger, `- ${ts} · ${items.length} item(s) · sha256 ${digest} · ${outPath}\n`);

console.log(`quarantine addendum written (append-only): ${outPath}`);
console.log(`sha256: ${digest}`);
console.log(`ledger: ${ledger}`);
console.log(`quarantined: ${items.length} · kept out: ${KEEP_OUT.length}`);
