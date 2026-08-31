// Tiny shared helpers. No state, no surprises.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** sha256 hex of a string or Buffer. */
export function sha256(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return createHash('sha256').update(buf).digest('hex');
}

/** First 8 hex chars of a sha256 — used to seed deterministic ids. */
export function hash8(input) {
  return sha256(input).slice(0, 8);
}

/** Structured deep clone via JSON (state is plain JSON, so this is safe). */
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Wall-clock ISO timestamp. Injectable so tests stay deterministic. */
export function nowIso() {
  return new Date().toISOString();
}

/** Word count of free text (used by the ask-once sufficiency heuristic). */
export function wordCount(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

/** Round to n decimals without floating dust. */
export function round(n, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Mean of a numeric array (0 for empty). */
export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation (0 for <2 samples). */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// Filesystem-facing ids must never become paths. Keep them boring and portable.
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const WINDOWS_DEVICE_ID_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function isSafeId(value) {
  return SAFE_ID_PATTERN.test(String(value || ''));
}

export function safeId(value, label = 'id') {
  const id = String(value || '');
  if (!isSafeId(id)) {
    throw new Error(`${label} must match ${SAFE_ID_PATTERN.source} (letters/numbers plus . _ -, no slashes or traversal)`);
  }
  return id;
}

/** True when the module is the process entrypoint, including symlinked temp paths. */
export function isMainModule(metaUrl, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Safe for creating a new filename on Windows, macOS, and Linux. */
export function isPortableId(value) {
  const id = String(value || '');
  return isSafeId(id)
    && !id.endsWith('.')
    && !WINDOWS_DEVICE_ID_PATTERN.test(id);
}

export function portableId(value, label = 'id') {
  const id = String(value || '');
  if (!isPortableId(id)) {
    throw new Error(`${label} must be a portable filesystem id (not a Windows device name and no trailing period)`);
  }
  return id;
}

/** Minimal HTML escaping so untrusted transcript text can never become markup. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
