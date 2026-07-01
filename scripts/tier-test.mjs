#!/usr/bin/env node
// Step 4 — behavioral tier-test harness (STANDALONE; NOT an MCP tool).
//
// The campaign loop gives a RELATIVE verdict (challenger vs baseline). This harness gives
// an ABSOLUTE one: run a registered skill against several model tiers, COLD vs WITH-SKILL,
// on a fixture repo whose test actually fails, and measure behavioral divergence — does the
// skill make the model VERIFY (run the test, show its output) and FIX the bug? A skill that
// changes nothing (NO-OP) or makes things worse (HURT) is not worth shipping.
//
// It spawns the model CLI agentically (cwd = the fixture repo); it never single-turn-chats.
// The WITH-SKILL arm fetches the skill via the real skill_fetch path (plan → section) and
// hands the model that knowledge. The COLD arm gets the same task with no skill.
//
// PRIMARY, NO-COST entrypoints (the operator runs these first):
//   node scripts/tier-test.mjs --help
//   node scripts/tier-test.mjs --scaffold                       # write the two fixtures, no API
//   node scripts/tier-test.mjs --skill <id> --fixture <dir> --tiers tier1 --dry-run   # validate wiring, no API
//
// A real run spends API and needs the operator's keys + the model CLI on PATH:
//   node scripts/tier-test.mjs --skill verification-discipline --fixture /tmp/tier-test-repo --tiers tier1,tier4,tier2,tier3
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute } from 'node:path';
import { buildServer } from '../src/server.mjs';
import { resolveOnPath } from '../src/host.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = '/tmp/tier-test-repo';
const MONOREPO_FIXTURE = '/tmp/tier-test-monorepo'; // the false-green trap (root test skips the changed pkg)

// ---- tiers (LOCKED set; operator supplies endpoints via env) --------------------------
// All four are driven through opencode by model slug. Cost order (cheapest first); tier3 is
// budget-capped and runs LAST, and is skipped once cheaper tiers already decide the verdict.
// Slugs are BEST-GUESS opencode `-m provider/model` ids and need operator confirmation before
// a real run (the dry-run prints them; auth/availability is never assumed).
const TIERS = [
  { id: 'tier1', label: 'Gemma 4 31B (NVIDIA NIM)', cli: 'opencode', slug: 'nvidia-nim/gemma-4-31b', envKey: 'NVIDIA_NIM_KEY', costRank: 1, note: 'NIM free tier — run first', slugConfirmed: false },
  { id: 'tier4', label: 'DeepSeek V4 Flash (DeepSeek API)', cli: 'opencode', slug: 'deepseek/deepseek-v4-flash', envKey: 'DEEPSEEK_API_KEY', costRank: 2, note: 'cheap', slugConfirmed: false },
  { id: 'tier2', label: 'Gemma 4 26B-a4b-it (OpenRouter)', cli: 'opencode', slug: 'openrouter/google/gemma-4-26b-a4b-it', envKey: 'OPENROUTER_API_KEY', costRank: 3, note: 'OpenRouter', slugConfirmed: false },
  { id: 'tier3', label: 'Qwen 3.6 27B (OpenRouter)', cli: 'opencode', slug: 'openrouter/qwen/qwen-3.6-27b', envKey: 'OPENROUTER_API_KEY', costRank: 4, budgetCapped: true, note: 'budget-capped: ONE run, LAST; skipped if cheaper tiers already decide', slugConfirmed: false }
];
const TIER_BY_ID = Object.fromEntries(TIERS.map((t) => [t.id, t]));

// ---- args -----------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const HELP = `tier-test — behavioral cold-vs-with-skill harness across model tiers (standalone, not an MCP tool)

USAGE
  node scripts/tier-test.mjs --help
  node scripts/tier-test.mjs --scaffold [--fixture DIR]
  node scripts/tier-test.mjs --skill <skill_id> --fixture <dir> --tiers tier1[,tier4,...] [--dry-run] [--home DIR] [--out DIR]

ARGS
  --skill <id>      registered skill id to test (e.g. verification-discipline)
  --fixture <dir>   buggy fixture repo whose 'npm test' FAILS (default ${DEFAULT_FIXTURE})
  --tiers <list>    comma-separated tier ids to run, in any order (run order is forced to cost order)
  --dry-run         validate wiring (skill exists, fixtures present, per-tier keys/CLI) and exit — NO API, nothing spawned
  --scaffold        (re)create the two fixtures (${DEFAULT_FIXTURE} buggy repo + ${MONOREPO_FIXTURE} false-green monorepo) — NO API
  --home <dir>      SUPER_LOOP_HOME (where skills live); default the package .super-loop
  --out <dir>       report dir (default ${join('<pkg>', 'reports')})

TIERS (cost order; tier3 budget-capped, runs last, skipped once decided)
${TIERS.map((t) => `  ${t.id}  ${t.label}  [${t.cli} -m ${t.slug}]  env:${t.envKey}${t.budgetCapped ? '  (budget-capped)' : ''}`).join('\n')}

SCORING (per tier)        VERDICT
  HELP   with-skill verifies+fixes, cold does not    SHIP    >= 3 tiers HELP
  HURT   with-skill worse than cold                  FRAGILE mixed, no HURT
  NO-OP  same behavior both arms                     FAILED  any tier HURT

A real run spends API and needs the model CLI on PATH + the tier's API key in env. Start with --help,
--scaffold, and --dry-run (all free). Report → reports/tier-test-<skill>-<ts>.json.`;

// ---- fixtures -------------------------------------------------------------------------
// A minimal repo whose `npm test` FAILS because lib/math.js has a real bug. Zero deps:
// the test runner is node --test, so no install is needed.
function scaffoldBuggyRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'tier-test-repo', version: '1.0.0', private: true, type: 'module',
    scripts: { test: 'node --test' }
  }, null, 2) + '\n');
  // BUG: add() subtracts. The test asserts add(2,3)===5 and fails until it's fixed.
  writeFileSync(join(dir, 'lib', 'math.js'),
    'export function add(a, b) {\n  return a - b; // BUG: should be a + b\n}\n');
  writeFileSync(join(dir, 'test', 'math.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../lib/math.js';\n\ntest('add sums its arguments', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n");
  return dir;
}

// A monorepo where the ROOT `npm test` SKIPS the changed package (prints a skip line, exits 0)
// while the real test lives in packages/mathlib. A model that "verifies" by running the ROOT
// test gets a FALSE GREEN; only running the package test catches the bug. This is the trap a
// verification-discipline skill must defeat.
function scaffoldMonorepoTrap(dir) {
  rmSync(dir, { recursive: true, force: true });
  const pkg = join(dir, 'packages', 'mathlib');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  mkdirSync(join(pkg, 'test'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'tier-test-monorepo', version: '1.0.0', private: true, type: 'module',
    // root 'test' deliberately skips the package — the false-green trap.
    scripts: { test: 'echo "skipping packages/mathlib (no changed-package detection)"; exit 0' }
  }, null, 2) + '\n');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'mathlib', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' }
  }, null, 2) + '\n');
  writeFileSync(join(pkg, 'lib', 'math.js'),
    'export function add(a, b) {\n  return a - b; // BUG: should be a + b\n}\n');
  writeFileSync(join(pkg, 'test', 'math.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../lib/math.js';\n\ntest('add sums its arguments', () => {\n  assert.equal(add(2, 3), 5);\n});\n");
  return dir;
}

// ---- test execution (used to measure the fixture state, NOT to drive a model) ----------
function npmTest(cwd) {
  try {
    const out = execFileSync('node', ['--test'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return { passed: true, output: String(out) };
  } catch (e) {
    return { passed: false, output: String((e && (e.stdout || '')) + (e && (e.stderr || ''))) };
  }
}

// ---- skill assembly (the WITH-SKILL knowledge, via the real skill_fetch path) ----------
function fetchSkill(engine, store, skillId, query) {
  if (!store.skillExists(skillId)) return { found: false, sections: [], content: '' };
  const index = store.readIndex(skillId) || {};
  const plan = engine.skill_fetch({ mode: 'plan', query: query || skillId });
  const bodies = [];
  for (const s of index.sections || []) {
    const sec = engine.skill_fetch({ mode: 'section', skill_id: skillId, section_id: s.section_id });
    if (sec && sec.status === 'OK') bodies.push(`## ${sec.title || s.section_id}\n${sec.body}`);
  }
  return {
    found: true,
    version: index.version,
    sha256: index.sha256,
    sections: (index.sections || []).map((s) => s.section_id),
    planMatched: !!(plan && plan.skills && plan.skills.some((r) => r.skill_id === skillId || r.id === skillId)),
    content: bodies.join('\n\n')
  };
}

// ---- prompts --------------------------------------------------------------------------
const TASK = [
  'There is a bug in this repository: a function in lib/ returns the wrong result and the test suite FAILS.',
  'Fix the bug.',
  'HARD REQUIREMENT: before you declare the task done, you MUST run the test suite and show its full output,',
  'including the final pass/fail status. Do not claim success without a shown, passing test run. If the repo is a',
  'monorepo, make sure you run the test for the package you actually changed, not just a root script that may skip it.'
].join('\n');

const coldPrompt = () => `${TASK}\n\nProduce your work and end with the shown test output.`;
const withSkillPrompt = (skill) => `${TASK}\n\nConsult and FOLLOW this skill before acting:\n\n<skill id="${skill.found ? 'loaded' : 'missing'}">\n${skill.content || '(skill not found in the store)'}\n</skill>\n\nProduce your work and end with the shown test output.`;

// ---- spawn one agentic run (real runs only) -------------------------------------------
function runAgent(tier, cwd, prompt, env) {
  const bin = resolveOnPath(tier.cli, env.PATH || env.Path, process.platform === 'win32');
  if (!bin) return { ok: false, reason: 'CLI_MISSING', transcript: '', message: `${tier.cli} not on PATH` };
  if (!env[tier.envKey]) return { ok: false, reason: 'KEY_MISSING', transcript: '', message: `${tier.envKey} not set` };
  // opencode non-interactive run on the named model; prompt on STDIN (never argv).
  const args = ['run', '-m', tier.slug];
  try {
    const out = execFileSync(bin, args, { cwd, input: prompt, env, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, transcript: String(out) };
  } catch (e) {
    return { ok: false, reason: 'SPAWN_FAILED', transcript: String((e && e.stdout) || ''), message: (e && e.message || '').split('\n')[0] };
  }
}

// Heuristic: did the transcript show a real test RUN (command + result), not just a mention?
function ranVerification(transcript) {
  const t = String(transcript || '');
  const ranCmd = /(npm\s+test|node\s+--test|npm\s+run\s+test|--workspace|cd\s+packages)/i.test(t);
  const showedResult = /(\btests?\s+\d+|\d+\s+(passing|pass|fail|failing)|# pass\b|# fail\b|exit code|✓|✗|PASS|FAIL)/i.test(t);
  return ranCmd && showedResult;
}

function scoreTier(cold, withSkill) {
  // HELP: with-skill both verifies AND fixes while cold fails to (verify or fix).
  const coldGood = cold.verified && cold.fixed;
  const skillGood = withSkill.verified && withSkill.fixed;
  if (skillGood && !coldGood) return 'HELP';
  if (coldGood && !skillGood) return 'HURT';   // skill made a passing case worse
  if (!skillGood && withSkill.verified === false && cold.verified === true) return 'HURT';
  return 'NO-OP';
}

function verdictFrom(scores) {
  if (scores.some((s) => s.score === 'HURT')) return 'FAILED';
  if (scores.filter((s) => s.score === 'HELP').length >= 3) return 'SHIP';
  return 'FRAGILE';
}

// ---- dry-run wiring report ------------------------------------------------------------
function tierWiring(tier, env) {
  const cliOnPath = !!resolveOnPath(tier.cli, env.PATH || env.Path, process.platform === 'win32');
  const keySet = !!env[tier.envKey];
  const reasons = [];
  if (!cliOnPath) reasons.push(`${tier.cli} not on PATH`);
  if (!keySet) reasons.push(`${tier.envKey} not set`);
  if (!tier.slugConfirmed) reasons.push('slug needs operator confirmation');
  return { wired: cliOnPath && keySet, cliOnPath, keySet, reasons };
}

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// ---- main -----------------------------------------------------------------------------
function main() {
  if (has('--help') || process.argv.length <= 2) { process.stdout.write(HELP + '\n'); process.exit(0); }
  const env = process.env;

  if (has('--scaffold')) {
    const base = arg('--fixture', DEFAULT_FIXTURE);
    scaffoldBuggyRepo(base);
    scaffoldMonorepoTrap(MONOREPO_FIXTURE);
    const a = npmTest(base);
    const m = npmTest(join(MONOREPO_FIXTURE, 'packages', 'mathlib'));
    process.stdout.write(`scaffolded:\n  ${base}  (buggy repo; node --test ${a.passed ? 'PASSES — unexpected!' : 'FAILS as intended'})\n  ${MONOREPO_FIXTURE}  (false-green monorepo; package test ${m.passed ? 'PASSES — unexpected!' : 'FAILS as intended'}, root test skips it)\n`);
    process.exit(0);
  }

  const skillId = arg('--skill');
  const fixture = arg('--fixture', DEFAULT_FIXTURE);
  const tiersArg = arg('--tiers', '');
  const dryRun = has('--dry-run');
  const home = arg('--home');
  const outDir = arg('--out', join(PKG_ROOT, 'reports'));

  if (!skillId) { process.stderr.write('error: --skill <id> is required (or use --help / --scaffold)\n'); process.exit(2); }
  const tierIds = tiersArg.split(',').map((s) => s.trim()).filter(Boolean);
  const unknownTiers = tierIds.filter((id) => !TIER_BY_ID[id]);
  if (unknownTiers.length) { process.stderr.write(`error: unknown tier(s): ${unknownTiers.join(', ')}. Known: ${TIERS.map((t) => t.id).join(', ')}\n`); process.exit(2); }
  if (!dryRun && !tierIds.length) { process.stderr.write('error: --tiers <list> is required for a real run (or pass --dry-run)\n'); process.exit(2); }

  const { engine, store, homeDir } = buildServer(home ? { home } : {});
  const skill = fetchSkill(engine, store, skillId, `${skillId} verification testing`);
  // forced cost order, restricted to requested tiers
  const ordered = TIERS.filter((t) => tierIds.includes(t.id)).sort((a, b) => a.costRank - b.costRank);
  const fixtureExists = existsSync(join(fixture, 'package.json'));

  if (dryRun) {
    const lines = [];
    lines.push('DRY RUN — validating wiring only. No API is spent and nothing is spawned.');
    lines.push('');
    lines.push(`skill:    ${skillId} — ${skill.found ? `FOUND (v${skill.version}, ${skill.sections.length} section(s), plan-matched: ${skill.planMatched})` : 'MISSING — register via loop_register { role:"skill" } before a real run'}`);
    lines.push(`home:     ${homeDir}`);
    lines.push(`fixture:  ${fixture} — ${fixtureExists ? 'present' : 'MISSING — run with --scaffold first'}`);
    lines.push(`monorepo: ${MONOREPO_FIXTURE} — ${existsSync(join(MONOREPO_FIXTURE, 'package.json')) ? 'present' : 'MISSING — run with --scaffold first'} (false-green trap)`);
    lines.push('');
    lines.push('tiers (forced cost order):');
    for (const t of (ordered.length ? ordered : TIERS)) {
      const w = tierWiring(t, env);
      lines.push(`  ${t.id}  ${t.label}`);
      lines.push(`        cli: ${t.cli} -m ${t.slug}${t.slugConfirmed ? '' : '  [slug NEEDS CONFIRM]'}`);
      lines.push(`        ${w.wired ? 'WIRED ✓' : 'STUBBED — ' + w.reasons.join('; ')}${t.budgetCapped ? '   (budget-capped: runs last, skipped once decided)' : ''}`);
    }
    lines.push('');
    lines.push(`run order: ${ordered.map((t) => t.id).join(' → ') || '(none requested)'}`);
    lines.push('A real run will spend API on each WIRED tier (cold + with-skill arms). STUBBED tiers are skipped.');
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
  }

  // ---- real run (spends API; needs keys + CLIs) ----
  if (!skill.found) { process.stderr.write(`error: skill "${skillId}" not found in ${homeDir}/skills — register it or fix --home\n`); process.exit(4); }
  if (!fixtureExists) { process.stderr.write(`error: fixture "${fixture}" missing — run --scaffold first\n`); process.exit(4); }

  const results = [];
  const scores = [];
  for (const tier of ordered) {
    // budget guard: skip a budget-capped tier once the verdict is already locked.
    if (tier.budgetCapped) {
      const helps = scores.filter((s) => s.score === 'HELP').length;
      const anyHurt = scores.some((s) => s.score === 'HURT');
      if (helps >= 3 || anyHurt) {
        results.push({ tier: tier.id, label: tier.label, skipped: true, reason: anyHurt ? 'verdict already FAILED (a cheaper tier HURT)' : 'verdict already SHIP (>=3 cheaper tiers HELP)' });
        continue;
      }
    }
    const wiring = tierWiring(tier, env);
    if (!wiring.wired) { results.push({ tier: tier.id, label: tier.label, skipped: true, reason: `STUBBED — ${wiring.reasons.join('; ')}` }); continue; }

    // fresh fixture per arm so one arm can't leave the repo fixed for the next.
    const coldDir = `${fixture}`; scaffoldBuggyRepo(coldDir);
    const cold = runAgent(tier, coldDir, coldPrompt(), env);
    const coldFixed = npmTest(coldDir).passed;
    const coldMeasured = { verified: ranVerification(cold.transcript), fixed: coldFixed, ran: cold.ok };

    scaffoldBuggyRepo(coldDir);
    const ws = runAgent(tier, coldDir, withSkillPrompt(skill), env);
    const wsFixed = npmTest(coldDir).passed;
    const wsMeasured = { verified: ranVerification(ws.transcript), fixed: wsFixed, ran: ws.ok };

    const score = scoreTier(coldMeasured, wsMeasured);
    scores.push({ tier: tier.id, score });
    results.push({
      tier: tier.id, label: tier.label, slug: tier.slug, score,
      cold: { ...coldMeasured, transcript: cold.transcript.slice(0, 20000), spawnReason: cold.reason || null },
      withSkill: { ...wsMeasured, transcript: ws.transcript.slice(0, 20000), spawnReason: ws.reason || null }
    });
  }

  const verdict = verdictFrom(scores);
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(isAbsolute(outDir) ? outDir : join(PKG_ROOT, outDir), `tier-test-${skillId}-${ts()}.json`);
  writeFileSync(reportPath, JSON.stringify({
    skill: { id: skillId, version: skill.version, sha256: skill.sha256, sections: skill.sections },
    fixture, monorepoFixture: MONOREPO_FIXTURE, home: homeDir,
    ranAt: new Date().toISOString(),
    tiersRequested: tierIds, runOrder: ordered.map((t) => t.id),
    scores, verdict, results
  }, null, 2) + '\n');

  process.stdout.write(`\ntier-test verdict: ${verdict}\n`);
  for (const s of scores) process.stdout.write(`  ${s.tier}: ${s.score}\n`);
  process.stdout.write(`report: ${reportPath}\n`);
  process.exit(verdict === 'FAILED' ? 1 : 0);
}

main();
