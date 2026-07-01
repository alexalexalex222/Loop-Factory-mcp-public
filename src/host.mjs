// Host capability preflight. Answers "which frontier-agent CLIs are actually
// installed on this machine" so the model can pick real routes instead of naming
// models it can't drive. The hard rule: this NEVER executes anything. It resolves
// known binary names against PATH with a filesystem stat only — no spawn, no
// `--version`, no shell. Presence on PATH is reported honestly as presence on
// PATH, NOT as proof the CLI is authenticated/working, and NOT as web/SOTA
// research. An MCP cannot prove a CLI works without running it; we do not pretend.
import { accessSync, statSync, constants as FS, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

// Fixed allowlist of known frontier-agent CLIs. Hardcoded on purpose: the MCP
// only ever looks for THESE names, never a model-supplied command, so there is no
// path by which a model can have the MCP probe for arbitrary executables.
export const KNOWN_ROUTE_CLIS = [
  { name: 'claude', provider: 'Anthropic', note: 'Claude Code / claude CLI (Opus/Sonnet)' },
  { name: 'codex', provider: 'OpenAI', note: 'Codex CLI (GPT-5.x frontier)' },
  { name: 'gemini', provider: 'Google', note: 'Gemini CLI' },
  { name: 'opencode', provider: 'open-source', note: 'OpenCode agent CLI' },
  { name: 'glm', provider: 'Z.ai', note: 'optional GLM wrapper (GLM-5.x)' }
];

function isExecutableFile(path) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a bare command name against PATH without executing it. */
export function resolveOnPath(name, pathValue, isWindows) {
  const dirs = String(pathValue || '').split(delimiter).filter(Boolean);
  const candidates = isWindows
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  for (const dir of dirs) {
    for (const c of candidates) {
      const full = join(dir, c);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * Build a local capability report for the known frontier CLIs.
 * @param {{ env?: object, platform?: string }} [opts] injectable for tests
 */
export function detectHostCapabilities(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const isWindows = platform === 'win32';
  const routes = KNOWN_ROUTE_CLIS.map((cli) => {
    const path = resolveOnPath(cli.name, env.PATH || env.Path, isWindows);
    return { name: cli.name, provider: cli.provider, note: cli.note, installed: !!path, path: path || null };
  });
  const installed = routes.filter((r) => r.installed).map((r) => r.name);
  return {
    routes,
    installedCount: installed.length,
    installed,
    method: 'PATH presence (filesystem stat only; no command executed)',
    boundary: 'Presence on PATH is NOT proof the CLI is authenticated or functional, and is NOT web/SOTA research. Confirm auth out-of-band before relying on a route; web-search current SOTA separately.'
  };
}

// ---- host runtime registry ------------------------------------------------
// The HOST runtime is the agent the operator is driving (Claude Code, Codex,
// Cursor, …) — distinct from the worker CLIs above. Its profile (continuous-mode
// driver, driver family, MCP config paths, integration tier) lives as pure data in
// hosts/registry.json so a new host is added by editing JSON, not code. This loader
// resolves that file and answers alias → canonical id / profile. The registry is
// loaded once and cached; pass an explicit path/URL (tests) to bypass the cache.
const REGISTRY_URL = new URL('../hosts/registry.json', import.meta.url);
let _registryCache = null;

/** Load and cache the bundled host registry; pass a path/URL to load a fixture uncached. */
export function loadHostRegistry(pathOrUrl) {
  if (!pathOrUrl && _registryCache) return _registryCache;
  const reg = JSON.parse(readFileSync(pathOrUrl || REGISTRY_URL, 'utf8'));
  if (!Array.isArray(reg.hosts)) throw new Error('host registry: missing hosts[]');
  if (!pathOrUrl) _registryCache = reg;
  return reg;
}

/** Canonical host id for an alias/env value, or 'unknown' when unrecognized. */
export function resolveHostId(alias, registry) {
  const reg = registry || loadHostRegistry();
  const a = String(alias || '').toLowerCase().trim();
  if (!a) return 'unknown';
  for (const h of reg.hosts) {
    if (h.id.toLowerCase() === a) return h.id;
    if (Array.isArray(h.aliases) && h.aliases.some((x) => String(x).toLowerCase() === a)) return h.id;
  }
  return 'unknown';
}

/** Full host profile for an alias/id, falling back to the 'unknown' entry. */
export function hostProfile(alias, registry) {
  const reg = registry || loadHostRegistry();
  const id = resolveHostId(alias, reg);
  return reg.hosts.find((h) => h.id === id) || reg.hosts.find((h) => h.id === 'unknown') || null;
}

/**
 * Compact host-compatibility matrix (every recognized host, not the 'unknown'
 * fallback). Surfaced when the host is unknown so the agent can see which hosts are
 * supported, their driver family/tier, the continuous command (or null), and the
 * universal CLI fallback. Pure derivation over the registry — no I/O beyond the load.
 */
export function hostMatrix(registry) {
  const reg = registry || loadHostRegistry();
  return reg.hosts
    .filter((h) => h.id !== 'unknown')
    .map((h) => ({
      id: h.id,
      aliases: h.aliases || [],
      driverFamily: h.driverFamily,
      tier: h.tier,
      command: h.primaryDriver ? h.primaryDriver.command : null,
      verified: !!h.verified,
      cliFallback: h.cliFallback || reg.cliFallback || null
    }));
}

function expandHome(p, home) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/**
 * Advisory host-runtime detection: a READ-ONLY existence check of the registry's
 * mcpConfigPaths to guess which host the agent is running in. It NEVER reads file
 * contents and NEVER mutates anything. SUPER_LOOP_HOST, if set, is authoritative.
 * fileExists/env/home/registry are injectable for fixture tests.
 */
export function detectHostRuntime(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homedir();
  const fileExists = opts.fileExists || ((p) => { try { accessSync(p, FS.F_OK); return true; } catch { return false; } });
  const reg = opts.registry || loadHostRegistry();
  const explicitHost = env.SUPER_LOOP_HOST ? resolveHostId(env.SUPER_LOOP_HOST, reg) : null;
  const candidates = [];
  for (const h of reg.hosts) {
    if (h.id === 'unknown') continue;
    const found = (h.mcpConfigPaths || []).map((p) => expandHome(p, home)).filter((p) => fileExists(p));
    if (found.length) candidates.push({ id: h.id, driverFamily: h.driverFamily, tier: h.tier, evidence: found });
  }
  const explicitUsable = explicitHost && explicitHost !== 'unknown' ? explicitHost : null;
  const guess = explicitUsable || (candidates.length === 1 ? candidates[0].id : null);
  return {
    explicitHost,
    candidates,
    guess,
    cliFallback: reg.cliFallback || 'super-loop-run',
    method: 'read-only existence check of registry mcpConfigPaths (no file contents read, no mutation)',
    advisory: 'Advisory only — a config file existing is not proof you are running in that host. SUPER_LOOP_HOST overrides this guess, and nothing is ever auto-applied.'
  };
}
