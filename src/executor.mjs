// OPTIONAL live worker executor — OFF BY DEFAULT.
//
// The default super-loop posture is "the server never executes commands" (audited).
// This module adds the missing supervisor capability the operator asked for: Loop Factory
// itself LAUNCHES the frontier worker and CAPTURES its output, so the evidence is
// tool-owned end-to-end and there is no model-supplied recording step to fabricate.
//
// It is gated behind an explicit operator opt-in (SUPER_LOOP_ALLOW_EXEC=1) so that
// anyone who does not turn it on keeps the no-execution posture unchanged.
//
// Safety properties (all enforced here):
//   - every native executable runs through a fixed process-tree guardian. On
//     Windows only, an already allowlisted .cmd/.bat shim first uses the narrow
//     adapter in process-launch.mjs. Neither path accepts a shell string.
//   - arguments are fixed ARRAYS the MCP builds; the prompt is delivered on STDIN and
//     never placed on argv, so untrusted text cannot become a flag or a command.
//   - a fixed binary ALLOWLIST: a route maps to one of {claude, codex, glm}; a route
//     that maps to nothing is refused and nothing runs.
//   - PATH resolution by filesystem stat (reused from host.mjs); a missing binary is
//     refused, not guessed.
//   - hard timeout + process-tree cleanup, bounded output buffer.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveOnPath } from './host.mjs';
import { buildProcessLaunch, executeProcessSync } from './process-launch.mjs';
import { sha256 } from './util.mjs';

export const STRICT_CODEX_REASONING_EFFORT = 'high';
const EXECUTABLE_EVIDENCE_CACHE = new Map();
const GUARDED_EXEC_PATH = fileURLToPath(
  new URL('../scripts/vnext-guarded-exec.mjs', import.meta.url)
);

function executableEvidence(path) {
  const stat = statSync(path);
  const cacheKey = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = EXECUTABLE_EVIDENCE_CACHE.get(cacheKey);
  if (cached) return cached;
  const evidence = {
    basename: basename(path),
    sha256: sha256(readFileSync(path)),
    bytes: stat.size
  };
  EXECUTABLE_EVIDENCE_CACHE.clear();
  EXECUTABLE_EVIDENCE_CACHE.set(cacheKey, evidence);
  return evidence;
}

// Resolve worker binaries robustly even when the MCP server was launched with a
// minimal PATH (the common case: a GUI/launchd-spawned host hands the stdio server
// an env with no Homebrew/nvm/~/.local bin dirs, so claude/codex/gemini silently
// fail to launch and every batch dies as BINARY_MISSING). This does NOT widen the
// allowlist — only the four named binaries can ever run — it widens WHERE those
// exact binaries are looked up. Returns the inherited PATH with well-known frontier
// CLI install dirs appended (existing dirs only, de-duplicated, inherited PATH first).
function augmentedPath(env = process.env) {
  if (process.platform === 'win32') return env.PATH || env.Path || '';
  const home = env.HOME || homedir() || '';
  const extra = [
    dirname(process.execPath),          // the node running this server (e.g. ~/.local/bin)
    home && join(home, '.local', 'bin'),
    '/opt/homebrew/bin',                 // Apple Silicon Homebrew
    '/usr/local/bin',                    // Intel Homebrew / general
    '/usr/bin', '/bin',
    home && join(home, '.bun', 'bin')
  ].filter(Boolean);
  // nvm installs CLIs under a version-specific bin (claude commonly lives here).
  const nvmRoot = home && join(home, '.nvm', 'versions', 'node');
  if (nvmRoot && existsSync(nvmRoot)) {
    try {
      for (const v of readdirSync(nvmRoot)) {
        const b = join(nvmRoot, v, 'bin');
        if (existsSync(b) && statSync(b).isDirectory()) extra.push(b);
      }
    } catch { /* unreadable nvm dir → just skip it */ }
  }
  const seen = new Set();
  const dirs = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  for (const d of extra) if (existsSync(d)) dirs.push(d);
  return dirs.filter((d) => (seen.has(d) ? false : (seen.add(d), true))).join(delimiter);
}

// Route family → the ONE binary allowed to run it.
//
// IMPORTANT — family mapping ≠ model-policy endorsement. Banlist mode "off" may
// accept haiku/mini/etc. as *named routes* for measurement gates, but execution
// still requires a known family here. Mapping `haiku` → the `claude` binary only
// means "if this route is launched, use the claude CLI" — it does not endorse haiku
// as a frontier route. Unknown routes that match no family return null from
// execBinaryForRoute → NOT_ALLOWLISTED / ROUTE_UNSPAWNABLE / EXEC_FAILED. Never
// free-form binary execution from a route string.
//
// Builds/in-loop gating are restricted elsewhere (active modelPolicy.builderRoutes).
// Execution of a *test* worker may use codex for a gpt-5.x route. Order matters:
// most specific first. The opencode-driven families carry a `slug` and are only
// spawnable when opencode is on PATH.
const EXEC_FAMILIES = [
  { match: /minimax[-_ ]?m3/i, bin: 'opencode', slug: 'minimax-anthropic-api/minimax-m3' },
  { match: /deepseek[-_ ]?v4[-_ ]?pro/i, bin: 'opencode', slug: 'deepseek-api/deepseek-v4-pro' },
  { match: /mimo[-_ ]?v?2\.5[-_ ]?pro/i, bin: 'opencode', slug: 'mimo-token-plan-api/mimo-v2.5-pro' },
  { match: /claude|opus|sonnet|fable|haiku/i, bin: 'claude' }, // haiku maps to claude binary for exec safety only — not a policy endorsement
  { match: /glm/i, bin: 'glm' },
  { match: /gpt|codex|o[34]/i, bin: 'codex' },
  { match: /gemini/i, bin: 'gemini' }
];

export function isExecEnabled(env = process.env) {
  return env.SUPER_LOOP_ALLOW_EXEC === '1';
}

/**
 * Map a route string to its allowlisted binary, or null if none is allowed / it cannot
 * be spawned here. An opencode-driven route is spawnable ONLY when opencode resolves on
 * PATH — the SAME filesystem-stat check the host preflight uses (env.PATH, no exec) — so a
 * deterministic, injectable test can force on/off PATH. A non-opencode family returns its
 * binary unconditionally (its PATH is resolved at launch, as before).
 * @param {string} model
 * @param {object} [env] injectable env (defaults to process.env) — only env.PATH matters
 */
export function execBinaryForRoute(model, env = process.env) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return null;
  const fam = EXEC_FAMILIES.find((f) => f.match.test(m));
  if (!fam) return null;
  if (fam.bin === 'opencode') {
    return resolveOnPath('opencode', env.PATH || env.Path, process.platform === 'win32') ? 'opencode' : null;
  }
  return fam.bin;
}

export function resolveWorkerBinary(model, env = process.env) {
  const bin = execBinaryForRoute(model, env);
  if (!bin) return { bin: null, binPath: null, reason: 'NOT_ALLOWLISTED' };
  if (bin === 'codex' && env.SUPER_LOOP_CODEX_BIN) {
    const candidate = String(env.SUPER_LOOP_CODEX_BIN).trim();
    const allowedBasenames = process.platform === 'win32'
      ? new Set(['codex', 'codex.exe', 'codex.cmd', 'codex.bat', 'codex.real'])
      : new Set(['codex', 'codex.real']);
    if (!isAbsolute(candidate) || !allowedBasenames.has(basename(candidate).toLowerCase())) {
      return { bin, binPath: null, reason: 'BINARY_OVERRIDE_INVALID' };
    }
    const full = resolve(candidate);
    try {
      if (!existsSync(full) || !statSync(full).isFile()) {
        return { bin, binPath: null, reason: 'BINARY_OVERRIDE_INVALID' };
      }
    } catch {
      return { bin, binPath: null, reason: 'BINARY_OVERRIDE_INVALID' };
    }
    return { bin, binPath: full, reason: null };
  }
  return {
    bin,
    binPath: resolveOnPath(bin, augmentedPath(env), process.platform === 'win32'),
    reason: null
  };
}

/** The `opencode -m <slug>` model id for an opencode-driven route, else null. */
export function execSlugForRoute(model) {
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return null;
  const fam = EXEC_FAMILIES.find((f) => f.match.test(m));
  return fam && fam.slug ? fam.slug : null;
}

// Build the per-binary argv (flags only). The prompt is delivered on STDIN, never on
// argv — so untrusted text can never become a flag or be parsed by a shell. Verified
// against the real CLIs: `claude -p --output-format json` reads the prompt from stdin
// and returns a JSON array; `codex exec --json` runs non-interactively.
export const STRICT_CODEX_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'multi_agent',
  'multi_agent_v2',
  'hooks',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'memories',
  'apps',
  'goals',
  'tool_suggest',
  'workspace_dependencies'
]);

export const STRICT_CODEX_RESEARCH_ENABLED_FEATURES = Object.freeze([
  'browser_use',
  'browser_use_external'
]);

export const STRICT_CODEX_RESEARCH_DISABLED_FEATURES = Object.freeze(
  STRICT_CODEX_DISABLED_FEATURES.filter((feature) => (
    !STRICT_CODEX_RESEARCH_ENABLED_FEATURES.includes(feature)
  ))
);

const STRICT_SCHEMA_BY_KIND = Object.freeze({
  mine: 'mine-output.schema.json',
  'mechanism-mutation': 'mechanism-mutation-output.schema.json',
  'vnext-candidate': 'vnext-candidate-output-v1.schema.json',
  'vnext-external-research-discovery': 'vnext-external-research-discovery-output-v1.schema.json',
  'vnext-evaluation': 'vnext-evaluator-output-v1.schema.json',
  'vnext-falsification': 'vnext-falsification-output-v1.schema.json',
  'vnext-feedback': 'vnext-task-feedback-output-v1.schema.json',
  'vnext-hypothesis': 'vnext-hypothesis-output-v1.schema.json',
  'vnext-reranker': 'vnext-reranker-output-v1.schema.json',
  'vnext-research': 'vnext-research-output-v1.schema.json',
  proposal: 'proposal-output.schema.json',
  evaluation: 'evaluation-output.schema.json',
  baseline: 'baseline-output.schema.json',
  challenger: 'challenger-output.schema.json'
});

export function schemaPathForContract(contract = {}) {
  const filename = STRICT_SCHEMA_BY_KIND[contract.kind];
  return filename
    ? fileURLToPath(new URL(`./schemas/${filename}`, import.meta.url))
    : null;
}

export function buildArgs(bin, slug, model, {
  strictIsolation = false,
  schemaPath = null,
  workspaceRoot = null,
  toolPolicy = 'none',
  reasoningEffort = STRICT_CODEX_REASONING_EFFORT
} = {}) {
  switch (bin) {
    case 'claude': return [
      '-p',
      '--output-format', 'json',
      '--model', String(model || '')
    ];
    // `codex exec` refuses to run outside a trusted/git directory unless told to skip
    // that check; the supervisor's run dir is not a git repo, so the flag is required.
    case 'codex': {
      const args = [
        'exec',
        '-m', String(model || ''),
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-rules',
        '-s', 'read-only',
        '-c', 'suppress_unstable_features_warning=true'
      ];
      if (strictIsolation) {
        const researchOnly = toolPolicy === 'research-web-read-only';
        const disabledFeatures = researchOnly
          ? STRICT_CODEX_RESEARCH_DISABLED_FEATURES
          : STRICT_CODEX_DISABLED_FEATURES;
        args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        args.push('--ignore-user-config');
        for (const feature of disabledFeatures) args.push('--disable', feature);
        if (researchOnly) {
          for (const feature of STRICT_CODEX_RESEARCH_ENABLED_FEATURES) {
            args.push('--enable', feature);
          }
        }
        if (schemaPath) args.push('--output-schema', schemaPath);
        if (workspaceRoot) args.push('-C', workspaceRoot);
        args.push('--color', 'never');
      }
      return args;
    }
    // opencode drives the minimax/deepseek/mimo routes by model slug. `run` is its
    // non-interactive entry; the prompt is delivered on STDIN (never argv) like the others.
    // NOTE: opencode's exact non-interactive argv/stdin behavior is UNVERIFIED here (no live
    // run was made); this follows the documented `opencode -m <slug>` form and may need a tweak.
    case 'opencode': return ['run', '-m', String(slug || '')];
    case 'glm': return ['-p'];
    case 'gemini': return ['-p'];
    default: return ['-p'];
  }
}

export function parseReportedModel(bin, stdout) {
  const raw = String(stdout || '');
  const candidates = [];
  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of ['model', 'model_id', 'modelId']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) candidates.push(obj[key].trim());
    }
    if (obj.thread && typeof obj.thread === 'object') collect(obj.thread);
    if (obj.item && typeof obj.item === 'object') collect(obj.item);
    if (obj.message && typeof obj.message === 'object') collect(obj.message);
  };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) parsed.forEach(collect);
    else collect(parsed);
  } catch {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { collect(JSON.parse(line)); } catch { /* non-JSON line */ }
    }
  }
  return candidates.length ? candidates[candidates.length - 1] : null;
}

// Extract the comparable FINAL OUTPUT (the answer text) from a CLI's structured
// output, so benchmarks score the real result — not the metadata envelope. Falls
// back to raw stdout for shapes we do not recognize.
export function extractResult(bin, stdout) {
  const raw = String(stdout || '');
  // codex `exec --json` emits JSON Lines (one object per line), not a single doc, so
  // a whole-string JSON.parse fails. Walk the lines from the end for the final
  // agent_message — that is the comparable answer, not the metadata/usage envelope.
  if (bin === 'codex') {
    const lines = raw.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const it = o && o.item ? o.item : o;
        if (it && (it.type === 'agent_message' || it.role === 'assistant') && typeof it.text === 'string') return it.text;
      } catch { /* non-JSON line → keep scanning */ }
    }
    // no agent_message found → fall through to the generic handling / raw
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const result = [...parsed].reverse().find((o) => o && o.type === 'result' && typeof o.result === 'string');
      if (result) return result.result;
      const asst = [...parsed].reverse().find((o) => o && (o.type === 'assistant' || o.role === 'assistant'));
      if (asst && asst.text) return String(asst.text);
    } else if (parsed && typeof parsed === 'object') {
      if (typeof parsed.result === 'string') return parsed.result;
      if (typeof parsed.output === 'string') return parsed.output;
    }
  } catch { /* not JSON — use raw */ }
  return raw;
}

// Best-effort REAL token usage from the worker's own structured output. Parse the
// envelope and read the AUTHORITATIVE FINAL usage (claude's result object / the last
// stream message / the last codex token_count), summing EVERY token component INCLUDING
// cache tokens. Returns a number when the CLI reports it, else null → the caller falls
// back to a deterministic byte estimate and LABELS it an estimate.
const USAGE_TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'prompt_tokens', 'completion_tokens'];

function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (Number.isFinite(Number(usage.total_tokens))) return Number(usage.total_tokens);
  let sum = 0; let any = false;
  for (const k of USAGE_TOKEN_KEYS) {
    const v = Number(usage[k]);
    if (Number.isFinite(v)) { sum += v; any = true; }
  }
  return any ? sum : null;
}

function pickUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.usage && typeof obj.usage === 'object') return obj.usage;
  if (obj.message && obj.message.usage && typeof obj.message.usage === 'object') return obj.message.usage;
  if ('total_tokens' in obj || 'input_tokens' in obj || 'output_tokens' in obj || 'prompt_tokens' in obj) return obj;
  return null;
}

function finalUsage(s) {
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) { const u = pickUsage(parsed[i]); if (u) return u; }
    } else {
      const u = pickUsage(parsed); if (u) return u;
    }
  } catch { /* not a single JSON doc → try JSON Lines below */ }
  const lines = s.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      const u = pickUsage(o && o.item ? o.item : o) || (o && o.msg ? pickUsage(o.msg) : null);
      if (u) return u;
    } catch { /* skip non-JSON line */ }
  }
  return null;
}

export function parseTokenUsage(stdout) {
  const s = String(stdout || '');
  const total = usageTotal(finalUsage(s));
  if (Number.isFinite(total) && total > 0) return total;
  const explicit = s.match(/"total_tokens"\s*:\s*(\d+)/i);
  if (explicit) return Number(explicit[1]);
  const plain = s.match(/\btokens?\s*[:=]\s*(\d+)/i);
  if (plain) return Number(plain[1]);
  return null;
}

export function parseTokenUsageDetails(stdout) {
  const usage = finalUsage(String(stdout || ''));
  if (!usage) return null;
  const read = (key) => Number.isFinite(Number(usage[key])) ? Number(usage[key]) : 0;
  const details = {
    inputTokens: read('input_tokens') || read('prompt_tokens'),
    outputTokens: read('output_tokens') || read('completion_tokens'),
    cacheCreationInputTokens: read('cache_creation_input_tokens'),
    cacheReadInputTokens: read('cache_read_input_tokens')
  };
  details.totalTokens = usageTotal(usage);
  return details.totalTokens && details.totalTokens > 0 ? details : null;
}

const TOOL_EVENT_TYPES = new Set([
  'tool_use',
  'tool_result',
  'command_execution',
  'mcp_tool_call',
  'web_search',
  'web_search_request',
  'web_fetch',
  'file_search',
  'computer_use',
  'shell'
]);

const CONTEXT_DIAGNOSTIC_PATTERNS = Object.freeze([
  Object.freeze({
    code: 'WORKER_HOOK_CONTEXT',
    pattern: /\bhooks?\s+(?:config|context|trust)\b|failed to parse hooks config/i
  }),
  Object.freeze({
    code: 'WORKER_SKILL_CONTEXT',
    pattern: /\bskill descriptions?\b|\bskills? context budget\b|can still see every skill/i
  }),
  Object.freeze({
    code: 'WORKER_PLUGIN_CONTEXT',
    pattern: /\bplugins?\s+(?:catalog|context|loaded|loading)\b/i
  })
]);

function researchToolCallAllowed(call) {
  if (['web_search', 'web_search_request', 'web_fetch'].includes(call.type)) return true;
  return ['mcp_tool_call', 'tool_use', 'tool_result'].includes(call.type)
    && /(?:browser|web)(?:[._:-]|$)/i.test(String(call.name || ''));
}

export function inspectWorkerIsolation(stdout, { toolPolicy = 'none' } = {}) {
  const events = [];
  const contextDiagnostics = [];
  const seenDiagnostics = new Set();
  let malformedLines = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
    if (TOOL_EVENT_TYPES.has(type)) {
      events.push({
        type,
        name: String(value.name || value.tool_name || value.toolName || value.command || '').slice(0, 160) || null
      });
    }
    const message = typeof value.message === 'string' ? value.message : '';
    for (const diagnostic of CONTEXT_DIAGNOSTIC_PATTERNS) {
      if (!message || !diagnostic.pattern.test(message)) continue;
      const key = `${diagnostic.code}:${message}`;
      if (seenDiagnostics.has(key)) continue;
      seenDiagnostics.add(key);
      contextDiagnostics.push({
        code: diagnostic.code,
        message: message.slice(0, 320)
      });
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  const raw = String(stdout || '');
  try {
    visit(JSON.parse(raw));
  } catch {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { visit(JSON.parse(line)); } catch { malformedLines++; }
    }
  }
  const disallowedEvents = toolPolicy === 'research-web-read-only'
    ? events.filter((event) => !researchToolCallAllowed(event))
    : events;
  const reasons = [];
  if (disallowedEvents.length) reasons.push('WORKER_TOOL_CALL');
  if (malformedLines) reasons.push('WORKER_TRANSCRIPT_UNPARSEABLE');
  reasons.push(...new Set(contextDiagnostics.map((item) => item.code)));
  return {
    status: disallowedEvents.length === 0
      && malformedLines === 0
      && contextDiagnostics.length === 0 ? 'PASS' : 'FAIL',
    toolCalls: events,
    disallowedToolCalls: disallowedEvents,
    contextDiagnostics,
    malformedLines,
    reasons
  };
}

export function buildExecutorPrompt(contract = {}) {
  const target = contract.target || null;
  const hypothesis = contract.hypothesis || null;
  const kind = contract.kind || 'challenger';
  const targetText = target
    ? JSON.stringify({
        findingId: target.findingId,
        title: target.title,
        baselineArtifactId: target.baselineArtifactId,
        baselineSha256: target.baselineSha256
      }, null, 2)
    : 'NONE';
  const evidenceText = target && Array.isArray(target.evidenceRefs) && target.evidenceRefs.length
    ? target.evidenceRefs.map((ref) => `- ${ref.path} :: ${ref.locator}`).join('\n')
    : 'NONE';
  const capsuleText = Array.isArray(contract.evidenceCapsule) && contract.evidenceCapsule.length
    ? contract.evidenceCapsule.map((item) => [
        `--- ${item.path} (sha256 ${item.sha256}) ---`,
        String(item.content || ''),
        `--- end ${item.path} ---`
      ].join('\n')).join('\n\n')
    : 'NONE';
  const mechanismCapsuleText = contract.mechanismCapsule
    && typeof contract.mechanismCapsule === 'object'
    ? JSON.stringify(contract.mechanismCapsule, null, 2)
    : 'NONE';
  const hypothesisText = hypothesis ? JSON.stringify(hypothesis, null, 2) : 'NONE';
  const procedureText = typeof contract.procedureContent === 'string'
    ? contract.procedureContent
    : (target && target.baselineContent ? String(target.baselineContent) : 'NONE');
  const casesText = Array.isArray(contract.frozenCases) && contract.frozenCases.length
    ? JSON.stringify(contract.frozenCases, null, 2)
    : (contract.requirements || []).filter((item) => /FROZEN CASES/i.test(String(item))).join('\n') || 'NONE';
  const caseResultShape = '{"caseId":"case id","disposition":"ACCEPTED or REJECTED only","code":"observed supervisor code","evidencePaths":["repository-relative evidence path"]}';
  const structuredOutput = contract.outputSchemaMode === true;
  const treatmentBoundProposal = kind === 'proposal'
    && typeof contract.proposalTreatmentInstruction === 'string'
    && contract.proposalTreatmentInstruction.trim();
  const requiredSchema = kind === 'proposal'
    ? `${structuredOutput ? '' : '<IMPROVEMENT>\n'}{"findingId":"${target && target.findingId || ''}","hypothesisId":"${hypothesis && hypothesis.id || ''}","baselineSha256":"${target && target.baselineSha256 || ''}","revisedContent":"complete revised procedure","changeSummary":"${treatmentBoundProposal ? 'specific assigned-treatment change' : 'specific hypothesis-linked change'}"}${structuredOutput ? '' : '\n</IMPROVEMENT>'}`
    : (kind === 'evaluation'
        ? `${structuredOutput ? '' : '<EVALUATION>\n'}{"arm":"${contract.evaluationArm || ''}","findingId":"${target && target.findingId || ''}","hypothesisId":"${hypothesis && hypothesis.id || ''}","baselineSha256":"${target && target.baselineSha256 || ''}","procedureSha256":"${contract.procedureSha256 || ''}","caseResults":[${caseResultShape}]}${structuredOutput ? '' : '\n</EVALUATION>'}`
        : (kind === 'baseline'
            ? `${structuredOutput ? '' : '<BASELINE_RESULT>\n'}{"findingId":"${target && target.findingId || ''}","baselineSha256":"${target && target.baselineSha256 || ''}","caseResults":[${caseResultShape}]}${structuredOutput ? '' : '\n</BASELINE_RESULT>'}`
            : (kind === 'challenger'
                ? `${structuredOutput ? '' : '<IMPROVEMENT>\n'}{"findingId":"${target && target.findingId || ''}","hypothesisId":"${hypothesis && hypothesis.id || ''}","baselineSha256":"${target && target.baselineSha256 || ''}","revisedContent":"complete revised procedure","changeSummary":"specific change","caseResults":[${caseResultShape}]}${structuredOutput ? '' : '\n</IMPROVEMENT>'}`
                : (structuredOutput
                    ? '{"candidates":[{"loop":"loop-de-loop","title":"substantial finding","baselineContent":"complete baseline procedure","evidenceRefs":[{"path":"sealed/path","locator":"exact locator"}],"hypotheses":[{"title":"hypothesis one","bottleneck":"specific mechanism","operation":"specific change","expectedMovement":"predeclared movement","falsifier":"rejecting observation"},{"title":"hypothesis two","bottleneck":"specific mechanism","operation":"specific change","expectedMovement":"predeclared movement","falsifier":"rejecting observation"}]}]}'
                    : '<CANDIDATES>[...]</CANDIDATES>'))));
  const phaseInstruction = kind === 'proposal'
    ? (treatmentBoundProposal
        ? contract.proposalTreatmentInstruction.trim()
        : 'Revise the locked baseline only according to the assigned hypothesis. Do not evaluate cases in this proposal phase.')
    : (kind === 'evaluation'
        ? 'Apply the active procedure exactly as written to every frozen case. Do not revise the procedure or add proposal fields.'
        : (kind === 'baseline'
            ? 'Apply the locked baseline procedure exactly as written to every frozen case. Do not revise it.'
            : (kind === 'challenger'
                ? 'Revise the locked baseline only according to the assigned hypothesis, then apply that complete revised procedure to every frozen case.'
                : 'Perform only the assigned mining phase and emit evidence-backed candidates.')));
  return [
    'TARGET',
    targetText,
    '',
    'LOCKED BASELINE',
    target && target.baselineContent ? String(target.baselineContent) : 'NONE',
    '',
    'ACTIVE PROCEDURE',
    procedureText,
    '',
    'EVIDENCE SOURCES',
    evidenceText,
    '',
    'SEALED EVIDENCE CAPSULE',
    capsuleText,
    '',
    'ASSIGNED IMPROVEMENT MECHANISM',
    mechanismCapsuleText,
    '',
    'HYPOTHESIS',
    hypothesisText,
    '',
    'FROZEN CASES',
    casesText,
    '',
    'REQUIRED OUTPUT SCHEMA',
    requiredSchema,
    '',
    'FORBIDDEN OUTPUTS',
    '- Do not emit a mining <CANDIDATES> block during baseline or challenger work.',
    '- Do not emit a baseline wrapper during challenger work or an improvement wrapper during baseline work.',
    '- Do not combine proposal and evaluation fields in one output.',
    '- Do not grade yourself, report metrics, claim promotion, declare completion, or stop the campaign.',
    ...(structuredOutput ? ['- Return only the JSON object required by the CLI output schema. Do not add tags, fences, or prose.'] : []),
    '',
    'PHASE PROCEDURE',
    String(contract.slice || ''),
    '',
    'TASK',
    String(contract.task || ''),
    '',
    'REQUIREMENTS',
    (contract.requirements || []).map((requirement) => `- ${requirement}`).join('\n') || 'NONE',
    '',
    phaseInstruction,
    '',
    'HARD EXECUTION CONTRACT',
    'You are a single benchmark worker, not an open-ended agent. Produce the deliverable as your single final message in one turn. Do not spawn subagents or sub-tasks, call campaign tools, browse files, use memory, search the web, or manufacture evidence. Use only the sealed evidence capsule printed above. Be concise and finish quickly.'
  ].join('\n');
}

function parseStructuredObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeStructuredWorkerOutput(contract = {}, text = '') {
  const payload = parseStructuredObject(text);
  if (!payload) return null;
  const inferredKind = Array.isArray(payload.candidates)
    ? 'mine'
    : (payload.arm ? 'evaluation'
      : (payload.revisedContent ? (Array.isArray(payload.caseResults) ? 'challenger' : 'proposal')
        : (Array.isArray(payload.caseResults) ? 'baseline' : null)));
  const kind = contract.kind || inferredKind;
  if (kind === 'mine' && Array.isArray(payload.candidates)) {
    return `<CANDIDATES>${JSON.stringify(payload.candidates)}</CANDIDATES>`;
  }
  if (kind === 'proposal' && typeof payload.revisedContent === 'string' && !Array.isArray(payload.caseResults)) {
    return `<IMPROVEMENT>${JSON.stringify(payload)}</IMPROVEMENT>`;
  }
  if (kind === 'evaluation' && payload.arm && Array.isArray(payload.caseResults)) {
    return `<EVALUATION>${JSON.stringify(payload)}</EVALUATION>`;
  }
  if (kind === 'baseline' && Array.isArray(payload.caseResults)) {
    return `<BASELINE_RESULT>${JSON.stringify(payload)}</BASELINE_RESULT>`;
  }
  if (kind === 'challenger' && typeof payload.revisedContent === 'string' && Array.isArray(payload.caseResults)) {
    return `<IMPROVEMENT>${JSON.stringify(payload)}</IMPROVEMENT>`;
  }
  return null;
}

export function normalizeSupervisorBoundProposalOutput(contract = {}, text = '') {
  const payload = parseStructuredObject(text);
  if (!payload
      || typeof payload.revisedContent !== 'string'
      || !payload.revisedContent.trim()
      || typeof payload.changeSummary !== 'string'
      || !payload.changeSummary.trim()) return null;
  return `<IMPROVEMENT>${JSON.stringify({
    findingId: contract.target?.findingId,
    hypothesisId: contract.hypothesis?.id,
    baselineSha256: contract.target?.baselineSha256,
    revisedContent: payload.revisedContent,
    changeSummary: payload.changeSummary
  })}</IMPROVEMENT>`;
}

// Adapter: turn the real executor into a supervisor worker(contract) → packet. The
// supervisor sends only the phase SLICE; this runs the allowlisted CLI on it and
// returns the captured output as a packet. A failed launch preserves supervisor-
// owned diagnostics while the validator still rejects it as an invalid batch.
export function executorWorker(contract, env = process.env) {
  const strictCodex = contract.toolPolicy === 'none'
    && execBinaryForRoute(contract.route, env) === 'codex'
    && !!schemaPathForContract(contract);
  const effectiveContract = strictCodex ? { ...contract, outputSchemaMode: true } : contract;
  const prompt = buildExecutorPrompt(effectiveContract);
  const r = runWorker({
    model: contract.route,
    prompt,
    env,
    executionContract: strictCodex ? effectiveContract : null
  });
  if (!r.ok) {
    const failedRunlog = [
      r.stdout ? `STDOUT\n${r.stdout}` : '',
      r.stderr ? `STDERR\n${r.stderr}` : ''
    ].filter(Boolean).join('\n');
    return {
      route: contract.route,
      phase: contract.phase,
      __execReason: r.reason,
      artifacts: failedRunlog ? [{ role: 'runlog', content: failedRunlog }] : [],
      executorOwned: true,
      rawStdout: r.stdout || '',
      rawStderr: r.stderr || '',
      finalOutput: '',
      realTokenUsage: r.tokenUsage,
      isolation: r.isolation,
      invocation: r.invocation
    };
  }
  const finalOutput = strictCodex
    ? normalizeStructuredWorkerOutput(contract, r.resultText)
    : (r.resultText || r.stdout);
  if (!finalOutput) {
    return {
      route: contract.route,
      phase: contract.phase,
      __execReason: 'OUTPUT_SCHEMA_INVALID',
      artifacts: [{ role: 'runlog', content: r.stdout }],
      executorOwned: true,
      rawStdout: r.stdout,
      finalOutput: '',
      realTokenUsage: r.tokenUsage,
      isolation: r.isolation,
      invocation: r.invocation
    };
  }
  const invocation = strictCodex
    ? {
        ...r.invocation,
        rawResultSha256: r.invocation.resultSha256,
        resultSha256: sha256(finalOutput),
        resultNormalization: 'json-schema-v1'
      }
    : r.invocation;
  // runlog = the raw captured envelope (evidence); finalOutput = the comparable answer text
  return {
    route: contract.route,
    phase: contract.phase,
    artifacts: [{ role: 'runlog', content: r.stdout }],
    executorOwned: true,
    rawStdout: r.stdout,
    finalOutput,
    realTokenUsage: r.tokenUsage,
    isolation: r.isolation,
    invocation
  };
}

/**
 * Launch ONE allowlisted worker and capture its output. Synchronous on purpose
 * (matches the rest of the engine; one tool call runs at a time over stdio).
 * @returns {{ ok, model, bin, binPath, stdout, exitCode, timedOut, tokenUsage, reason? }}
 */
export function runWorker({
  model,
  prompt,
  timeoutMs = 600000,
  cwd,
  env = process.env,
  executionContract = null
} = {}) {
  if (!isExecEnabled(env)) {
    return { ok: false, model, bin: null, reason: 'EXEC_DISABLED', message: 'Live execution is off. Set SUPER_LOOP_ALLOW_EXEC=1 to let Loop Factory launch and meter workers itself.' };
  }
  const resolvedBinary = resolveWorkerBinary(model, env);
  const bin = resolvedBinary.bin;
  if (!bin) {
    return { ok: false, model, bin: null, reason: 'NOT_ALLOWLISTED', message: `route "${model}" maps to no allowlisted executor binary (claude/codex/glm/gemini only)` };
  }
  // Resolve against the AUGMENTED path (Homebrew/nvm/bun/~/.local/bin), not just the
  // raw inherited PATH — a GUI/launchd-minimal PATH otherwise fails every launch with
  // BINARY_MISSING. This widens only WHERE the four allowlisted binaries are looked up,
  // never the allowlist itself (the env.PATH dirs are still searched first).
  const binPath = resolvedBinary.binPath;
  if (!binPath) {
    if (resolvedBinary.reason === 'BINARY_OVERRIDE_INVALID') {
      return {
        ok: false,
        model,
        bin,
        reason: 'BINARY_OVERRIDE_INVALID',
        message: 'SUPER_LOOP_CODEX_BIN must be an absolute path to an existing codex or codex.real executable, or an allowlisted Windows Codex shim'
      };
    }
    return { ok: false, model, bin, reason: 'BINARY_MISSING', message: `allowlisted binary "${bin}" not found on PATH (cannot execute route ${model})` };
  }
  const toolPolicy = executionContract?.toolPolicy ?? null;
  const strictIsolation = bin === 'codex'
    && ['none', 'research-web-read-only'].includes(toolPolicy);
  const schemaPath = strictIsolation ? schemaPathForContract(executionContract) : null;
  const workspaceRoot = strictIsolation
    ? mkdtempSync(join(tmpdir(), 'loop-factory-worker-'))
    : (cwd || null);
  const args = buildArgs(bin, execSlugForRoute(model), model, {
    strictIsolation,
    schemaPath,
    workspaceRoot,
    toolPolicy,
    reasoningEffort: executionContract?.reasoningEffort
      || STRICT_CODEX_REASONING_EFFORT
  });
  let launch;
  try {
    launch = buildProcessLaunch({ binPath, args, env });
  } catch (error) {
    return {
      ok: false, model, bin, binPath, reason: 'EXEC_ADAPTER_REFUSED',
      message: `worker launch adapter refused the resolved binary: ${error.message}`
    };
  }
  // codex's wrapper alias unsets OPENAI_BASE_URL; replicate that for the child so a
  // stray base-url env can't redirect the worker to the wrong endpoint.
  const childEnv = { ...env };
  const requireChatGptOAuth = bin === 'codex'
    && env.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH === '1';
  if (bin === 'codex') {
    delete childEnv.OPENAI_BASE_URL;
    if (requireChatGptOAuth) {
      delete childEnv.OPENAI_API_KEY;
      delete childEnv.CODEX_ACCESS_TOKEN;
    }
  }
  // Operator-only authority and plan-lock values belong to the supervisor process,
  // never to a spawned worker. A worker cannot be allowed to inherit the credentials
  // that distinguish operator decisions from model proposals.
  delete childEnv.SUPER_LOOP_OPERATOR_AUTHORITY;
  delete childEnv.SUPER_LOOP_REAL_TEST_APPROVAL;
  delete childEnv.SUPER_LOOP_REQUIRE_CHATGPT_OAUTH;
  delete childEnv.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256;
  delete childEnv.SUPER_LOOP_CODEX_EXECUTABLE_SHA256;
  delete childEnv.SUPER_LOOP_CODEX_BIN;
  const executable = executableEvidence(binPath);
  const processGuardian = executableEvidence(GUARDED_EXEC_PATH);
  if (requireChatGptOAuth) {
    const authoritySha256 = String(
      env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256 || ''
    );
    const expectedExecutableSha256 = String(
      env.SUPER_LOOP_CODEX_EXECUTABLE_SHA256 || ''
    );
    if (!/^[a-f0-9]{64}$/.test(authoritySha256)
        || expectedExecutableSha256 !== executable.sha256) {
      return {
        ok: false,
        model,
        bin,
        binPath,
        reason: 'OAUTH_AUTHORITY_MISMATCH',
        message: 'ChatGPT OAuth execution requires the sealed authority and executable hashes before launch'
      };
    }
  }
  const receiptBase = {
    requestedModel: String(model || ''),
    reasoningEffort: strictIsolation
      ? String(executionContract?.reasoningEffort || STRICT_CODEX_REASONING_EFFORT)
      : null,
    binaryFamily: bin,
    argv: [...args],
    promptSha256: sha256(String(prompt == null ? '' : prompt)),
    modelSelectionAuthority: (bin === 'codex' || bin === 'claude')
      ? 'explicit-model-flag'
      : (bin === 'opencode' ? 'explicit-model-slug' : 'route-to-allowlisted-binary'),
    executableBasename: executable.basename,
    executableSha256: executable.sha256,
    executableBytes: executable.bytes,
    authMode: requireChatGptOAuth ? 'chatgpt-oauth' : null,
    oauthAuthoritySha256: requireChatGptOAuth
      ? String(env.SUPER_LOOP_CODEX_OAUTH_AUTHORITY_SHA256)
      : null,
    strictIsolation,
    toolPolicy,
    disabledFeatures: strictIsolation
      ? [...(toolPolicy === 'research-web-read-only'
          ? STRICT_CODEX_RESEARCH_DISABLED_FEATURES
          : STRICT_CODEX_DISABLED_FEATURES)]
      : [],
    enabledFeatures: strictIsolation && toolPolicy === 'research-web-read-only'
      ? [...STRICT_CODEX_RESEARCH_ENABLED_FEATURES]
      : [],
    workspaceRoot,
    outputSchemaSha256: schemaPath ? sha256(readFileSync(schemaPath)) : null,
    processAdapter: launch.adapter,
    launchedFile: launch.file,
    launchedArgv: [...launch.args],
    processGuardianSha256: processGuardian.sha256,
    timeoutCleanup: launch.requiresTreeTermination
      ? 'windows-taskkill-process-tree-before-return'
      : 'guarded-process-tree-before-return'
  };
  const startNs = process.hrtime.bigint();
  try {
    const executionOptions = {
      input: String(prompt == null ? '' : prompt), // prompt on STDIN, never argv -> no injection
      cwd: workspaceRoot || undefined,
      env: childEnv,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8'
    };
    const stdout = launch.requiresTreeTermination
      ? executeProcessSync(launch, { ...executionOptions, timeoutMs })
      : execFileSync(process.execPath, [
          GUARDED_EXEC_PATH,
          '--parent-pid', String(process.pid),
          '--timeout-ms', String(timeoutMs),
          '--',
          launch.file,
          ...launch.args
        ], {
          ...executionOptions,
          timeout: timeoutMs + 15_000,
          killSignal: 'SIGTERM'
        });
    const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
    const stdoutText = String(stdout);
    const resultText = extractResult(bin, stdoutText);
    const reportedModel = parseReportedModel(bin, stdoutText);
    const tokenUsage = parseTokenUsage(stdoutText);
    const tokenUsageDetails = parseTokenUsageDetails(stdoutText);
    const isolation = inspectWorkerIsolation(stdoutText, { toolPolicy });
    return {
      ok: true, model, bin, binPath, stdout: stdoutText, resultText,
      exitCode: 0, timedOut: false, tokenUsage, tokenUsageDetails, durationMs, isolation,
      invocation: {
        ...receiptBase,
        reportedModel,
        modelIdentityAuthority: reportedModel ? 'cli-reported' : receiptBase.modelSelectionAuthority,
        reportedModelMatchesRequest: reportedModel == null ? null : reportedModel.toLowerCase() === String(model || '').toLowerCase(),
        durationMs,
        exitCode: 0,
        stdoutSha256: sha256(stdoutText),
        resultSha256: sha256(resultText),
        tokenUsage,
        tokenUsageDetails,
        tokenUsageAuthority: tokenUsage == null ? 'unavailable' : 'cli-reported',
        isolation
      }
    };
  } catch (e) {
    const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
    const timedOut = e?.loopFactoryTimeout === true
      || (!launch.requiresTreeTermination && e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' || e.killed === true));
    const cleanupFailed = e?.loopFactoryCleanupFailed === true;
    const outputLimit = e?.loopFactoryOutputLimit === true;
    const stdoutText = e && e.stdout ? String(e.stdout) : '';
    const stderrText = e && e.stderr ? String(e.stderr) : '';
    const exitCode = e && typeof e.status === 'number' ? e.status : null;
    const processErrorCode = e && typeof e.code === 'string' ? e.code : null;
    const reportedModel = parseReportedModel(bin, stdoutText);
    const tokenUsage = parseTokenUsage(stdoutText);
    const tokenUsageDetails = parseTokenUsageDetails(stdoutText);
    const isolation = inspectWorkerIsolation(stdoutText, { toolPolicy });
    const reason = timedOut
      ? 'TIMEOUT'
      : (cleanupFailed ? 'TIMEOUT_CLEANUP_FAILED' : (outputLimit ? 'OUTPUT_LIMIT' : 'EXEC_FAILED'));
    const message = timedOut
      ? `worker ${bin} exceeded ${timeoutMs}ms and its process tree was killed`
      : (cleanupFailed
        ? `worker ${bin} exceeded its execution boundary but complete process-tree cleanup could not be confirmed`
        : (outputLimit
          ? `worker ${bin} exceeded the maximum captured output and its process tree was killed`
          : `worker ${bin} failed${exitCode == null ? '' : ` with exit code ${exitCode}`}${processErrorCode ? ` (${processErrorCode})` : ''}`));
    return {
      ok: false, model, bin, binPath,
      reason,
      message,
      stdout: stdoutText,
      stderr: stderrText,
      exitCode,
      timedOut, tokenUsage, tokenUsageDetails, durationMs, isolation,
      invocation: {
        ...receiptBase,
        reportedModel,
        modelIdentityAuthority: reportedModel ? 'cli-reported' : receiptBase.modelSelectionAuthority,
        reportedModelMatchesRequest: reportedModel == null
          ? null
          : reportedModel.toLowerCase() === String(model || '').toLowerCase(),
        durationMs,
        exitCode,
        processErrorCode,
        stdoutSha256: sha256(stdoutText),
        stderrSha256: sha256(stderrText),
        resultSha256: null,
        tokenUsage,
        tokenUsageDetails,
        tokenUsageAuthority: tokenUsage == null ? 'unavailable' : 'cli-reported',
        isolation
      }
    };
  }
}
