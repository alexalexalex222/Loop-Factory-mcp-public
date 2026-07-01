// Loop registry + phase-gating source of truth. The full loop text lives INSIDE
// the server (bundled, hash-locked). Callers never receive the whole loop at once;
// they receive one section at a time via the engine's phase gate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MANDATED_LOOPS } from './constants.mjs';
import { sha256 } from './util.mjs';

const LOOPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'loops');

const cache = new Map();

/** Resolve an id or alias to a canonical MANDATED loop id, or null. */
export function resolveLoopId(idOrAlias) {
  if (!idOrAlias) return null;
  const key = String(idOrAlias).toLowerCase().trim();
  for (const meta of Object.values(MANDATED_LOOPS)) {
    if (meta.id === key) return meta.id;
    if (meta.aka.includes(key)) return meta.id;
  }
  return null;
}

/** Does this id/alias collide with a hash-locked mandated loop? (loop_register guard) */
export function isMandatedId(idOrAlias) {
  return resolveLoopId(idOrAlias) !== null;
}

/**
 * Build a streamable loop object from a stored CUSTOM loop record, re-hashing its
 * bytes and refusing on drift — the same hash-lock the mandated loops get, applied
 * to a user-added loop. Shape matches loadLoop() so the engine's phase-gate code is
 * shared. The mandated 345-line miner / 75-line hardener are never touched by this.
 */
export function makeCustomLoop(record) {
  if (!record || typeof record.content !== 'string') throw new Error('custom loop record missing content');
  const text = record.content;
  const digest = sha256(text);
  if (record.sha256 && digest !== record.sha256) {
    throw new Error(`custom loop ${record.id} hash mismatch: stored ${digest} != registered ${record.sha256} (refusing to run a tampered local loop)`);
  }
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const sections = sectionize(text);
  const meta = {
    id: record.id,
    file: `custom:${record.id}`,
    sha256: digest,
    lines,
    trigger: record.trigger || `/loop ${record.id}`,
    aka: Array.isArray(record.aka) ? record.aka : [],
    role: record.role || 'custom',
    title: record.title || record.id,
    origin: 'custom',
    bigMinerMarkers: []
  };
  return { id: record.id, meta, text, sha256: digest, lines, sections };
}

/**
 * Load a bundled loop, verifying its sha256 + line count against the mandated
 * contract. A mismatch (e.g. someone swapped in the short GitHub miner) throws —
 * the server must not run on the wrong source.
 */
export function loadLoop(id) {
  const cid = resolveLoopId(id);
  if (!cid) throw new Error(`unknown loop: ${id}`);
  if (cache.has(cid)) return cache.get(cid);

  const meta = MANDATED_LOOPS[cid];
  const text = readFileSync(join(LOOPS_DIR, meta.file), 'utf8');
  const digest = sha256(text);
  if (digest !== meta.sha256) {
    throw new Error(`loop ${cid} hash mismatch: bundled ${digest} != mandated ${meta.sha256} (refusing to run on the wrong source)`);
  }
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines !== meta.lines) {
    throw new Error(`loop ${cid} line count ${lines} != mandated ${meta.lines}`);
  }
  for (const marker of meta.bigMinerMarkers) {
    if (!text.includes(marker)) {
      throw new Error(`loop ${cid} missing required section "${marker}" — this looks like a truncated/short variant, not the full local source`);
    }
  }
  const sections = sectionize(text);
  const entry = { id: cid, meta, text, sha256: digest, lines, sections };
  cache.set(cid, entry);
  return entry;
}

/** Detect a section header: a markdown heading or an ALL-CAPS title line. */
function isHeader(line) {
  const t = line.trim();
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (t.length < 4 || t.length > 80) return false;
  if (!/^[A-Z0-9][A-Z0-9 ,/&'’.\-]*$/.test(t)) return false; // caps, digits, light punctuation only
  if (/[a-z]/.test(t)) return false; // any lowercase disqualifies
  return t.includes(' ') || t.length >= 6; // avoid matching a stray uppercase token
}

/**
 * Split a loop into ordered sections for phase-gated streaming.
 * - If the text has >= 3 header lines (the miner), sections are header-delimited,
 *   with any preamble before the first header as section 0.
 * - Otherwise (the hardener) sections are blank-line-separated paragraphs.
 * Deterministic; the same bytes always produce the same sections.
 * @returns {{index:number, title:string, body:string, chars:number}[]}
 */
export function sectionize(text) {
  const lines = text.split('\n');
  const headerIdx = lines.map((l, i) => (isHeader(l) ? i : -1)).filter((i) => i >= 0);

  let blocks;
  if (headerIdx.length >= 3) {
    blocks = [];
    if (headerIdx[0] > 0) {
      blocks.push({ title: 'Overview', body: lines.slice(0, headerIdx[0]).join('\n').trim() });
    }
    for (let h = 0; h < headerIdx.length; h++) {
      const start = headerIdx[h];
      const end = h + 1 < headerIdx.length ? headerIdx[h + 1] : lines.length;
      const title = lines[start].trim().replace(/^#{1,6}\s+/, '');
      const body = lines.slice(start, end).join('\n').trim();
      blocks.push({ title, body });
    }
  } else {
    blocks = text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => ({ title: paragraphTitle(b), body: b }));
  }

  return blocks
    .filter((b) => b.body.length > 0)
    .map((b, index) => ({ index, title: b.title, body: b.body, chars: b.body.length }));
}

function paragraphTitle(block) {
  const firstLine = block.split('\n')[0].trim();
  const words = firstLine.split(/\s+/).slice(0, 8).join(' ');
  return words.length < firstLine.length ? `${words}…` : words;
}

/** Load + verify both mandated loops; returns a manifest. Used at startup and in tests. */
export function verifyAllLoops() {
  return Object.keys(MANDATED_LOOPS).map((id) => {
    const l = loadLoop(id);
    return {
      id: l.id, file: l.meta.file, sha256: l.sha256, lines: l.lines,
      trigger: l.meta.trigger, role: l.meta.role, title: l.meta.title, sections: l.sections.length
    };
  });
}

/** A compact, loggable summary (no full body). */
export function loopSummary(id) {
  const l = loadLoop(id);
  return {
    id: l.id, trigger: l.meta.trigger, role: l.meta.role, title: l.meta.title,
    sha256: l.sha256, lines: l.lines, totalPhases: l.sections.length,
    aka: l.meta.aka
  };
}
