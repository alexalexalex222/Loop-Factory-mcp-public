// Tool-computed measurement. The hardening this module exists for: a measurement
// must be DERIVED by the MCP from the recorded raw bytes, not a number the model
// typed. `artifact_record` runs deriveMeasurement() over the run-log content the
// caller committed; `reverify_run` re-derives from the sealed bytes. To claim a
// token cost you must commit a run log that actually tokenizes to it, and to claim
// a quality you must commit output a frozen deterministic oracle actually scores.
//
// THE HONEST BOUNDARY (documented, not pretended):
//   - tokenCost is a deterministic function of the recorded bytes. The MCP owns
//     it and reverify re-derives it — but it does NOT prove those bytes came from
//     a real frontier-agent run. True external-runner authority (the MCP spawning
//     agents and metering real tokens) is out of v0 scope and cannot be enforced
//     by an MCP alone without executing untrusted commands.
//   - quality is tool-computed ONLY when the frozen benchmark carries a
//     deterministic oracle the MCP can re-evaluate against the bytes. Subjective
//     quality (is this site/copy actually better) is NOT tool-computable; it is
//     'caller-reported' authority and routes to the dashboard for a human — it can
//     never auto-promote. deterministic → tool-measured, subjective → dashboard.
import { round } from './util.mjs';

export const TOOL_AUTHORITY = 'tool-computed';
export const CALLER_AUTHORITY = 'caller-reported';

// Canonical deterministic quality oracle: 100 fixed-width, prefix-free probe
// tokens. A benchmark may freeze this (or its own probe set) as the rubric the
// MCP scores every measured run against. quality = distinct probes present / total.
export const QUALITY_PROBES = Array.from({ length: 100 }, (_, i) => `QP${String(i).padStart(3, '0')}`);
export const DEFAULT_QUALITY_ORACLE = { kind: 'probe', probes: QUALITY_PROBES };

/**
 * Deterministic token estimate of recorded bytes. ~4 chars/token, the common
 * rule of thumb; the exact constant does not matter as long as it is fixed and
 * reproducible, because baseline and challenger are measured by the same function.
 */
export function estimateTokens(content) {
  const len = String(content == null ? '' : content).length;
  return Math.max(1, Math.round(len / 4));
}

/** Is this benchmark oracle a deterministic spec the MCP can actually evaluate? */
export function isDeterministicOracle(oracle) {
  if (!oracle || typeof oracle !== 'object') return false;
  if (oracle.kind === 'probe' && Array.isArray(oracle.probes) && oracle.probes.length > 0) return true;
  if (Array.isArray(oracle.mustInclude) && oracle.mustInclude.length > 0) return true;
  return false;
}

/**
 * Score content in [0,1] against a deterministic oracle, or null if the oracle is
 * not tool-evaluable (e.g. a free-text rubric string → subjective → dashboard).
 */
export function scoreOracle(content, oracle) {
  const text = String(content == null ? '' : content);
  if (oracle && oracle.kind === 'probe' && Array.isArray(oracle.probes) && oracle.probes.length > 0) {
    let present = 0;
    for (const p of oracle.probes) if (text.includes(p)) present++;
    return round(present / oracle.probes.length);
  }
  if (Array.isArray(oracle?.mustInclude) && oracle.mustInclude.length > 0) {
    const must = oracle.mustInclude;
    const forbid = Array.isArray(oracle.mustExclude) ? oracle.mustExclude : [];
    let hits = 0;
    for (const m of must) if (text.includes(String(m))) hits++;
    let penalty = 0;
    for (const f of forbid) if (text.includes(String(f))) penalty++;
    const raw = (hits - penalty) / must.length;
    return round(Math.max(0, Math.min(1, raw)));
  }
  return null;
}

/**
 * Derive a measurement from recorded bytes. tokenCost is always tool-computed.
 * quality is tool-computed iff `oracle` is deterministic; otherwise the caller's
 * reported quality is retained but flagged caller-reported (dashboard authority).
 * @returns {{tokenCost:number, quality:number|null, tokenCostAuthority:string,
 *   qualityAuthority:string, claimed:{tokenCost:number|null, quality:number|null},
 *   oracleScored:boolean}}
 */
export function deriveMeasurement(content, oracle, claimed = {}) {
  const tokenCost = estimateTokens(content);
  const oracleScored = isDeterministicOracle(oracle);
  const claimedQuality = Number.isFinite(Number(claimed.quality)) ? Number(claimed.quality) : null;
  let quality = oracleScored ? scoreOracle(content, oracle) : claimedQuality;
  if (!(Number.isFinite(quality) && quality >= 0 && quality <= 1)) quality = oracleScored ? 0 : null;
  return {
    tokenCost,
    quality,
    tokenCostAuthority: TOOL_AUTHORITY,
    qualityAuthority: oracleScored ? TOOL_AUTHORITY : CALLER_AUTHORITY,
    claimed: {
      tokenCost: Number.isFinite(Number(claimed.tokenCost)) ? Number(claimed.tokenCost) : null,
      quality: claimedQuality
    },
    oracleScored
  };
}

/**
 * Build a run-log body whose tool-derived measurement equals (tokenCost, quality)
 * under the given probe oracle. Used by the demo, tests, and any host that wants
 * to hand the MCP a conformant raw run log instead of a bare number. Deterministic.
 */
export function buildMeasuredContent(tokenCost, quality, oracle = DEFAULT_QUALITY_ORACLE) {
  const probes = (oracle && oracle.kind === 'probe' && Array.isArray(oracle.probes)) ? oracle.probes : QUALITY_PROBES;
  const n = Math.max(0, Math.min(probes.length, Math.round(Number(quality) * probes.length)));
  const head = `RUN-LOG tokenCost~${tokenCost} quality~${quality}\n` + probes.slice(0, n).join(' ') + '\n';
  const targetLen = Math.max(head.length, Math.round(Number(tokenCost) * 4));
  return head + '.'.repeat(targetLen - head.length);
}
