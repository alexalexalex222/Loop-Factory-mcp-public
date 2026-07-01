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
//   - execFileSync ONLY — never `exec`, never a shell string, so shell metacharacters
//     can never be interpreted (no command injection).
//   - arguments are fixed ARRAYS the MCP builds; the prompt is delivered on STDIN and
//     never placed on argv, so untrusted text cannot become a flag or a command.
//   - a fixed binary ALLOWLIST: a route maps to one of {claude, codex, glm}; a route
//     that maps to nothing is refused and nothing runs.
//   - PATH resolution by filesystem stat (reused from host.mjs); a missing binary is
//     refused, not guessed.
//   - hard timeout + kill, bounded output buffer.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { resolveOnPath } from './host.mjs';

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

// Route family → the ONE binary allowed to run it. Builds/in-loop gating are
// restricted elsewhere (Opus/GLM); execution of a *test* worker may use codex for a
// gpt-5.x frontier route. Order matters: most specific first. The opencode-driven
// families carry a `slug` (the `opencode -m <slug>` model id) and are only spawnable
// when opencode is actually on PATH — execBinaryForRoute gates them so a route that
// looks frontier but cannot be launched is refused at register time, not silently accepted.
const EXEC_FAMILIES = [
  { match: /minimax[-_ ]?m3/i, bin: 'opencode', slug: 'minimax-anthropic-api/minimax-m3' },
  { match: /deepseek[-_ ]?v4[-_ ]?pro/i, bin: 'opencode', slug: 'deepseek-api/deepseek-v4-pro' },
  { match: /mimo[-_ ]?v?2\.5[-_ ]?pro/i, bin: 'opencode', slug: 'openrouter-api/mimo-v2.5-pro' },
  { match: /claude|opus|sonnet|fable|haiku/i, bin: 'claude' },
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
function buildArgs(bin, slug) {
  switch (bin) {
    case 'claude': return ['-p', '--output-format', 'json'];
    // `codex exec` refuses to run outside a trusted/git directory unless told to skip
    // that check; the supervisor's run dir is not a git repo, so the flag is required.
    case 'codex': return ['exec', '--json', '--skip-git-repo-check'];
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

// Adapter: turn the real executor into a supervisor worker(contract) → packet. The
// supervisor sends only the phase SLICE; this runs the allowlisted CLI on it and
// returns the captured output as a packet. A failed launch yields an empty packet
// that the supervisor's validator rejects (→ invalid batch, does not count).
export function executorWorker(contract, env = process.env) {
  const prompt = `${contract.slice || ''}\n\nTASK: ${contract.task || ''}\n${(contract.requirements || []).map((r) => `- ${r}`).join('\n')}\n\nHARD EXECUTION CONTRACT (you are a single benchmark worker, not an open-ended agent): produce your deliverable as your SINGLE final message in ONE turn. Do NOT spawn subagents or sub-tasks, do NOT open-endedly explore the filesystem or web, and do NOT call any super-loop / campaign tools. Be concise and finish quickly. Your final message IS the artifact that will be scored.`;
  const r = runWorker({ model: contract.route, prompt, env });
  if (!r.ok) return { route: contract.route, __execReason: r.reason, artifacts: [], finalOutput: '' };
  // runlog = the raw captured envelope (evidence); finalOutput = the comparable answer text
  return { route: contract.route, artifacts: [{ role: 'runlog', content: r.stdout }], finalOutput: r.resultText || r.stdout, realTokenUsage: r.tokenUsage };
}

/**
 * Launch ONE allowlisted worker and capture its output. Synchronous on purpose
 * (matches the rest of the engine; one tool call runs at a time over stdio).
 * @returns {{ ok, model, bin, binPath, stdout, exitCode, timedOut, tokenUsage, reason? }}
 */
export function runWorker({ model, prompt, timeoutMs = 600000, cwd, env = process.env } = {}) {
  if (!isExecEnabled(env)) {
    return { ok: false, model, bin: null, reason: 'EXEC_DISABLED', message: 'Live execution is off. Set SUPER_LOOP_ALLOW_EXEC=1 to let Loop Factory launch and meter workers itself.' };
  }
  const bin = execBinaryForRoute(model);
  if (!bin) {
    return { ok: false, model, bin: null, reason: 'NOT_ALLOWLISTED', message: `route "${model}" maps to no allowlisted executor binary (claude/codex/glm/gemini only)` };
  }
  // Resolve against the AUGMENTED path (Homebrew/nvm/bun/~/.local/bin), not just the
  // raw inherited PATH — a GUI/launchd-minimal PATH otherwise fails every launch with
  // BINARY_MISSING. This widens only WHERE the four allowlisted binaries are looked up,
  // never the allowlist itself (the env.PATH dirs are still searched first).
  const binPath = resolveOnPath(bin, augmentedPath(env), process.platform === 'win32');
  if (!binPath) {
    return { ok: false, model, bin, reason: 'BINARY_MISSING', message: `allowlisted binary "${bin}" not found on PATH (cannot execute route ${model})` };
  }
  const args = buildArgs(bin, execSlugForRoute(model));
  // codex's wrapper alias unsets OPENAI_BASE_URL; replicate that for the child so a
  // stray base-url env can't redirect the worker to the wrong endpoint.
  const childEnv = { ...env };
  if (bin === 'codex') delete childEnv.OPENAI_BASE_URL;
  const startNs = process.hrtime.bigint();
  try {
    const stdout = execFileSync(binPath, args, {
      input: String(prompt == null ? '' : prompt), // prompt on STDIN, never argv → no injection
      cwd: cwd || undefined,
      env: childEnv,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true
      // No `shell` option → execFile semantics → args passed literally, never parsed
      // by a shell. With the prompt on stdin, there is no untrusted text on argv at all.
    });
    const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
    return { ok: true, model, bin, binPath, stdout: String(stdout), resultText: extractResult(bin, stdout), exitCode: 0, timedOut: false, tokenUsage: parseTokenUsage(stdout), durationMs };
  } catch (e) {
    const durationMs = Number((process.hrtime.bigint() - startNs) / 1000000n);
    const timedOut = e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' || e.killed === true);
    return {
      ok: false, model, bin, binPath,
      reason: timedOut ? 'TIMEOUT' : 'EXEC_FAILED',
      message: timedOut ? `worker ${bin} exceeded ${timeoutMs}ms and was killed` : `worker ${bin} failed: ${e && e.message ? e.message.split('\n')[0] : 'unknown error'}`,
      stdout: e && e.stdout ? String(e.stdout) : '',
      exitCode: e && typeof e.status === 'number' ? e.status : null,
      timedOut, durationMs
    };
  }
}
