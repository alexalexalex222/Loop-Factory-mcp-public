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
export const CASE_RESULTS_ORACLE_KIND = 'case-results-v1';
export const CASE_RESULTS_ORACLE_KIND_V2 = 'case-results-v2';

const BLOCKED_DISPOSITIONS = new Set(['BLOCKED', 'REJECTED', 'DENIED', 'REFUSED', 'STAGED']);
const ACCEPTED_DISPOSITIONS = new Set(['ACCEPTED', 'ALLOWED', 'PASS', 'PASSED']);

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

export function isCaseResultsOracle(oracle) {
  if (!oracle || !Array.isArray(oracle.cases) || oracle.cases.length === 0) return false;
  if (oracle.kind === CASE_RESULTS_ORACLE_KIND) {
    return oracle.cases.every((item) => typeof item?.disposition === 'string' && item.disposition.trim());
  }
  if (oracle.kind === CASE_RESULTS_ORACLE_KIND_V2) {
    return oracle.cases.every((item) => typeof item?.accepted === 'boolean');
  }
  return false;
}

function parseJsonBlock(text, tag) {
  const matches = [...String(text || '').matchAll(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'gi'))];
  if (matches.length !== 1) return null;
  try { return JSON.parse(matches[0][1]); } catch { return null; }
}

export function parseCaseResults(content, { allowProposalWrappers = true } = {}) {
  const text = String(content == null ? '' : content);
  const direct = parseJsonBlock(text, 'CASE_RESULTS');
  if (Array.isArray(direct)) return { ok: true, wrapper: 'CASE_RESULTS', results: direct };
  const evaluation = parseJsonBlock(text, 'EVALUATION');
  if (evaluation && typeof evaluation === 'object' && Array.isArray(evaluation.caseResults)) {
    return { ok: true, wrapper: 'EVALUATION', results: evaluation.caseResults, payload: evaluation };
  }
  if (!allowProposalWrappers) return { ok: false, wrapper: null, results: [] };
  const baseline = parseJsonBlock(text, 'BASELINE_RESULT');
  if (baseline && typeof baseline === 'object' && Array.isArray(baseline.caseResults)) {
    return { ok: true, wrapper: 'BASELINE_RESULT', results: baseline.caseResults, payload: baseline };
  }
  const improvement = parseJsonBlock(text, 'IMPROVEMENT');
  if (improvement && typeof improvement === 'object'
    && (Array.isArray(improvement.caseResults) || typeof improvement.revisedContent === 'string')) {
    return {
      ok: true,
      wrapper: 'IMPROVEMENT',
      results: Array.isArray(improvement.caseResults) ? improvement.caseResults : [],
      payload: improvement
    };
  }
  return { ok: false, wrapper: null, results: [] };
}

function normalizedDisposition(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function acceptedFromDisposition(value) {
  const normalized = normalizedDisposition(value);
  const leadingDecision = normalized.match(/^[A-Z]+/)?.[0] || '';
  if (BLOCKED_DISPOSITIONS.has(normalized) || BLOCKED_DISPOSITIONS.has(leadingDecision)) return false;
  if (ACCEPTED_DISPOSITIONS.has(normalized) || ACCEPTED_DISPOSITIONS.has(leadingDecision)) return true;
  return null;
}

function expectedDisposition(item, oracle) {
  return oracle?.kind === CASE_RESULTS_ORACLE_KIND_V2
    ? (item.accepted ? 'ACCEPTED' : 'BLOCKED')
    : String(item.disposition);
}

function splitEvidencePath(value) {
  const raw = String(value == null ? '' : value).trim().replaceAll('\\', '/');
  const doubleColon = raw.match(/^(.*?)(?:\s*::\s*)(.+)$/);
  if (doubleColon) return { path: doubleColon[1], locator: doubleColon[2] };
  const lineSuffix = raw.match(/^(.*?):(\d+(?:-\d+)?)$/);
  if (lineSuffix) return { path: lineSuffix[1], locator: `lines ${lineSuffix[2]}` };
  return { path: raw, locator: null };
}

function normalizeEvidenceList(row) {
  const structured = Array.isArray(row && row.evidence) ? row.evidence : [];
  const legacy = Array.isArray(row && row.evidencePaths) ? row.evidencePaths : [];
  return [
    ...structured.map((item) => ({
      path: splitEvidencePath(item && item.path).path,
      locator: String(item && item.locator || '').trim() || null
    })),
    ...legacy.map(splitEvidencePath)
  ].filter((item) => item.path);
}

function expectedEvidenceList(item) {
  const structured = Array.isArray(item && item.requiredEvidence) ? item.requiredEvidence : [];
  const legacy = Array.isArray(item && item.requiredEvidencePaths) ? item.requiredEvidencePaths : [];
  return [
    ...structured.map((entry) => ({
      path: splitEvidencePath(entry && entry.path).path,
      locator: String(entry && entry.locator || '').trim() || null
    })),
    ...legacy.map((entry) => ({ path: splitEvidencePath(entry).path, locator: null }))
  ].filter((entry) => entry.path);
}

function dispositionMatches(row, item, oracle) {
  if (oracle?.kind === CASE_RESULTS_ORACLE_KIND_V2) {
    return acceptedFromDisposition(row && row.disposition) === item.accepted;
  }
  const actual = normalizedDisposition(row && row.disposition);
  const allowed = Array.isArray(item && item.acceptedDispositions)
    ? item.acceptedDispositions.map(normalizedDisposition)
    : [normalizedDisposition(item && item.disposition)];
  return allowed.includes(actual);
}

export function canonicalCaseResultsContent(content) {
  const parsed = parseCaseResults(content, { allowProposalWrappers: false });
  if (!parsed.ok) return null;
  const rows = parsed.results.map((row) => ({
    caseId: String(row && row.caseId || ''),
    disposition: normalizedDisposition(row && row.disposition),
    code: String(row && row.code || '').trim(),
    evidence: normalizeEvidenceList(row)
  }));
  return `<CASE_RESULTS>${JSON.stringify(rows)}</CASE_RESULTS>`;
}

export function buildCaseResultsContent(oracle, mutate = (item) => item) {
  const rows = (oracle?.cases || []).map((item, index, all) => mutate({
    caseId: String(item.caseId),
    disposition: expectedDisposition(item, oracle),
    code: String(item.code),
    evidence: expectedEvidenceList(item)
  }, index, all));
  return `<CASE_RESULTS>${JSON.stringify(rows)}</CASE_RESULTS>`;
}

export function scoreCaseResults(content, oracle) {
  if (!isCaseResultsOracle(oracle)) return null;
  const parsed = parseCaseResults(content, { allowProposalWrappers: false });
  if (!parsed.ok) return 0;
  const expected = oracle.cases;
  const rows = parsed.results;
  const expectedIds = new Set(expected.map((item) => String(item.caseId)));
  const seen = new Set();
  for (const row of rows) {
    const id = String(row && row.caseId == null ? '' : row.caseId);
    if (!id || seen.has(id) || !expectedIds.has(id)) return 0;
    seen.add(id);
  }
  if (seen.size !== expectedIds.size || rows.length !== expected.length) return 0;
  let correct = 0;
  for (const item of expected) {
    const row = rows.find((candidate) => String(candidate.caseId) === String(item.caseId));
    if (!row) continue;
    const actualEvidence = normalizeEvidenceList(row);
    const evidenceOk = expectedEvidenceList(item).every((required) => actualEvidence.some((actual) => (
      actual.path === required.path && (!required.locator || actual.locator === required.locator)
    )));
    if (dispositionMatches(row, item, oracle)
      && String(row.code) === String(item.code)
      && evidenceOk) correct++;
  }
  return round(correct / expected.length);
}

export function evaluateCaseResultsGameability(oracle) {
  if (!isCaseResultsOracle(oracle)) {
    return { ok: false, reason: 'strict real-test oracle must use case-results-v1' };
  }
  const passMark = Number.isFinite(Number(oracle.passMark)) ? Number(oracle.passMark) : 1;
  const markerEcho = (oracle.cases || []).flatMap((item) => [
    item.caseId, expectedDisposition(item, oracle), item.code, ...(item.requiredEvidencePaths || [])
  ]).join(' ') + ' independent evidence '.repeat(20);
  const reversed = buildCaseResultsContent(oracle, (row) => ({
    ...row,
    disposition: row.disposition === 'BLOCKED' ? 'ACCEPTED' : 'BLOCKED'
  }));
  const wrongMapping = buildCaseResultsContent(oracle, (row, index, all) => {
    if (all.length < 2) return { ...row, code: `WRONG_${row.code}` };
    const other = all[(index + 1) % all.length];
    return {
      ...row,
      code: String(other.code),
      evidencePaths: (other.requiredEvidencePaths || []).map(String)
    };
  });
  const correct = buildCaseResultsContent(oracle);
  const proposalSham = `<IMPROVEMENT>${JSON.stringify({
    findingId: 'finding-001',
    hypothesisId: 'finding-001-h1',
    baselineSha256: '0'.repeat(64),
    revisedContent: 'Reformat documentation headings and change no behavior.',
    changeSummary: 'Documentation formatting only.',
    caseResults: parseCaseResults(correct).results
  })}</IMPROVEMENT>`;
  const scores = {
    markerEcho: scoreCaseResults(markerEcho, oracle),
    reversed: scoreCaseResults(reversed, oracle),
    wrongMapping: scoreCaseResults(wrongMapping, oracle),
    proposalSham: scoreCaseResults(proposalSham, oracle),
    correct: scoreCaseResults(correct, oracle)
  };
  if (oracle.kind === CASE_RESULTS_ORACLE_KIND_V2) {
    const semanticEquivalent = buildCaseResultsContent(oracle, (row) => ({
      ...row,
      disposition: row.disposition === 'BLOCKED' ? 'REJECTED' : 'ALLOWED'
    }));
    const unknownDecision = buildCaseResultsContent(oracle, (row) => ({
      ...row,
      disposition: 'UNRESOLVED'
    }));
    scores.semanticEquivalent = scoreCaseResults(semanticEquivalent, oracle);
    scores.unknownDecision = scoreCaseResults(unknownDecision, oracle);
  }
  const adversarialKeys = ['markerEcho', 'reversed', 'wrongMapping', 'proposalSham'];
  if (oracle.kind === CASE_RESULTS_ORACLE_KIND_V2) adversarialKeys.push('unknownDecision');
  const adversarialPassed = adversarialKeys
    .filter((key) => scores[key] >= passMark);
  const semanticEquivalentFailed = oracle.kind === CASE_RESULTS_ORACLE_KIND_V2
    && scores.semanticEquivalent < passMark;
  return {
    ok: adversarialPassed.length === 0 && scores.correct >= passMark && !semanticEquivalentFailed,
    passMark,
    scores,
    adversarialPassed,
    reason: adversarialPassed.length
      ? `adversarial control(s) passed: ${adversarialPassed.join(', ')}`
      : (scores.correct < passMark
          ? 'known-correct control failed'
          : (semanticEquivalentFailed ? 'semantic-equivalent disposition control failed' : null))
  };
}

/** Is this benchmark oracle a deterministic spec the MCP can actually evaluate? */
export function isDeterministicOracle(oracle) {
  if (!oracle || typeof oracle !== 'object') return false;
  if (isCaseResultsOracle(oracle)) return true;
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
  if (isCaseResultsOracle(oracle)) return scoreCaseResults(text, oracle);
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
