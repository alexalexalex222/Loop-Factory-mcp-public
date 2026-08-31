#!/usr/bin/env node
// One-command Build Week judge path with an explicit caller opt-in:
// compatible Codex CLI -> exact GPT-5.6 Sol auth/model sentinel -> three controlled
// supervisor rejections -> evidence packet. No model fallback is permitted.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkerBinary, runWorker } from '../src/executor.mjs';
import { sha256 } from '../src/util.mjs';
import { runProof } from './build-week-gpt56-proof.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JUDGE_MODEL = 'gpt-5.6-sol';
export const MIN_CODEX_VERSION = '0.144.0';
const PREFLIGHT_SENTINEL = 'LOOP_FACTORY_SOL_READY';
const EXEC_OPT_IN_INSTRUCTION =
  'Explicit opt-in required: rerun as SUPER_LOOP_ALLOW_EXEC=1 npm run judge:gpt56-sol';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function atomicWrite(path, content) {
  const next = `${path}.new`;
  writeFileSync(next, content);
  renameSync(next, path);
}

function newEvidenceRoot(input) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolve(ROOT, String(input || `proof/build-week/judge-gpt56-sol-${stamp}`));
  const rel = relative(ROOT, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('judge evidence directory must be a new path inside the repository');
  }
  if (existsSync(target)) throw new Error(`judge evidence directory already exists: ${rel}`);
  mkdirSync(target, { recursive: true });
  return target;
}

export function parseCodexVersion(output) {
  const match = String(output || '').match(/\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])]
  };
}

export function versionAtLeast(actual, minimum = MIN_CODEX_VERSION) {
  const a = typeof actual === 'string' ? parseCodexVersion(`codex-cli ${actual}`) : actual;
  const m = parseCodexVersion(`codex-cli ${minimum}`);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] > m.parts[i]) return true;
    if (a.parts[i] < m.parts[i]) return false;
  }
  return true;
}

function candidateSource(path, env) {
  if (env.SUPER_LOOP_CODEX_BIN && resolve(env.SUPER_LOOP_CODEX_BIN) === resolve(path)) return 'operator-override';
  if (String(path).includes('/Applications/ChatGPT.app/Contents/Resources/')) return 'chatgpt-app-bundled';
  return 'path';
}

export function codexCandidatePaths(env = process.env, platform = process.platform) {
  if (env.SUPER_LOOP_CODEX_BIN) return [String(env.SUPER_LOOP_CODEX_BIN)];
  const paths = [];
  const resolved = resolveWorkerBinary(JUDGE_MODEL, { ...env, SUPER_LOOP_CODEX_BIN: undefined });
  if (resolved.binPath) paths.push(resolved.binPath);
  if (platform === 'darwin') paths.push('/Applications/ChatGPT.app/Contents/Resources/codex');
  return [...new Set(paths.map((path) => resolve(path)))];
}

export function inspectCodexCandidate(path, env = process.env) {
  const full = resolve(String(path || ''));
  try {
    if (!existsSync(full) || !statSync(full).isFile()) {
      return { path: full, source: candidateSource(full, env), ok: false, reason: 'missing', version: null };
    }
    const output = execFileSync(full, ['--version'], {
      env,
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true
    });
    const version = parseCodexVersion(output);
    return {
      path: full,
      source: candidateSource(full, env),
      ok: !!version && versionAtLeast(version),
      reason: version ? (versionAtLeast(version) ? null : `requires ${MIN_CODEX_VERSION}+`) : 'unparseable version',
      version: version ? version.raw : null
    };
  } catch (error) {
    return {
      path: full,
      source: candidateSource(full, env),
      ok: false,
      reason: error && error.message ? error.message.split('\n')[0] : 'version check failed',
      version: null
    };
  }
}

export function findCompatibleCodex({ env = process.env, platform = process.platform, candidates } = {}) {
  const checked = (candidates || codexCandidatePaths(env, platform)).map((path) => inspectCodexCandidate(path, env));
  const selected = checked.find((candidate) => candidate.ok);
  return { selected: selected || null, checked };
}

function blockedSummary({ reason, checked = [], preflight = null }) {
  return {
    status: 'BLOCKED',
    model: JUDGE_MODEL,
    fallbackAttempted: false,
    reason,
    checkedCodex: checked.map((candidate) => ({
      source: candidate.source,
      version: candidate.version,
      ok: candidate.ok,
      reason: candidate.reason
    })),
    preflight,
    noAuthFallback: 'npm run demo'
  };
}

function judgeMarkdown(summary) {
  return [
    '# Loop Factory Build Week judge packet',
    '',
    `Status: **${summary.status}**`,
    '',
    `Exact model: \`${summary.model}\``,
    `Codex CLI: \`${summary.codex.version}\` (${summary.codex.source})`,
    `Model fallback attempted: \`${summary.fallbackAttempted}\``,
    '',
    '## Fast judge path',
    '',
    '```bash',
    'SUPER_LOOP_ALLOW_EXEC=1 npm run judge:gpt56-sol',
    '```',
    '',
    'The command performs one exact-model auth sentinel, then three controlled',
    'adversarial fixtures: phase skip, self-reported metric, and self-promotion.',
    'Each worker proposal must be rejected by the matching supervisor code.',
    '',
    `Preflight stdout sha256: \`${summary.preflight.stdoutSha256}\``,
    `Proof summary: \`${summary.proof.summaryPath}\``,
    `Proof transcript: \`${summary.proof.transcriptPath}\``,
    '',
    'No-auth fallback:',
    '',
    '```bash',
    'npm run demo',
    '```',
    '',
    'The fallback is deterministic and does not claim a live GPT-5.6 Sol call.'
  ].join('\n') + '\n';
}

export function runJudgeKit({
  outDir,
  runId,
  env = process.env,
  candidates,
  worker = runWorker,
  proof = runProof
} = {}) {
  if (env.SUPER_LOOP_ALLOW_EXEC !== '1') {
    throw Object.assign(new Error(EXEC_OPT_IN_INSTRUCTION), {
      code: 'EXEC_OPT_IN_REQUIRED'
    });
  }
  const evidenceRoot = newEvidenceRoot(outDir);
  const compatibility = findCompatibleCodex({ env, candidates });
  if (!compatibility.selected) {
    const reason = `No compatible Codex CLI found; GPT-5.6 in Codex requires ${MIN_CODEX_VERSION}+`;
    const summary = blockedSummary({ reason, checked: compatibility.checked });
    atomicWrite(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    throw Object.assign(new Error(reason), { evidenceRoot });
  }

  const selected = compatibility.selected;
  const liveEnv = {
    ...env,
    SUPER_LOOP_CODEX_BIN: selected.path
  };
  const preflight = worker({
    model: JUDGE_MODEL,
    prompt: `Reply with exactly ${PREFLIGHT_SENTINEL} and nothing else.`,
    cwd: ROOT,
    timeoutMs: 120000,
    env: liveEnv
  });
  atomicWrite(join(evidenceRoot, 'preflight.jsonl'), String(preflight && preflight.stdout || ''));
  const preflightRecord = {
    status: preflight && preflight.ok && String(preflight.resultText || '').trim() === PREFLIGHT_SENTINEL ? 'PASS' : 'BLOCKED',
    requestedModel: JUDGE_MODEL,
    resultSha256: preflight && preflight.invocation ? preflight.invocation.resultSha256 : null,
    stdoutSha256: preflight && preflight.invocation ? preflight.invocation.stdoutSha256 : sha256(String(preflight && preflight.stdout || '')),
    tokenUsage: preflight && preflight.invocation ? preflight.invocation.tokenUsage : null,
    modelSelectionAuthority: preflight && preflight.invocation ? preflight.invocation.modelSelectionAuthority : null,
    reason: preflight && preflight.ok
      ? (String(preflight.resultText || '').trim() === PREFLIGHT_SENTINEL ? null : 'sentinel mismatch')
      : (preflight && (preflight.reason || preflight.message)) || 'preflight failed'
  };
  atomicWrite(join(evidenceRoot, 'preflight.json'), `${JSON.stringify(preflightRecord, null, 2)}\n`);
  if (preflightRecord.status !== 'PASS') {
    const summary = blockedSummary({
      reason: `GPT-5.6 Sol auth/model preflight failed: ${preflightRecord.reason}`,
      checked: compatibility.checked,
      preflight: preflightRecord
    });
    atomicWrite(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    throw Object.assign(new Error(summary.reason), { evidenceRoot });
  }

  let proofSummary;
  try {
    proofSummary = proof({
      model: JUDGE_MODEL,
      outDir: join(evidenceRoot, 'proof'),
      runId,
      env: liveEnv,
      runner: (args) => worker({ ...args, env: liveEnv })
    });
  } catch (error) {
    const summary = blockedSummary({
      reason: `controlled proof failed: ${error.message}`,
      checked: compatibility.checked,
      preflight: preflightRecord
    });
    atomicWrite(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    throw Object.assign(error, { evidenceRoot });
  }

  const summary = {
    status: 'PASS',
    model: JUDGE_MODEL,
    fallbackAttempted: false,
    codex: { source: selected.source, version: selected.version },
    preflight: preflightRecord,
    proof: {
      status: proofSummary.status,
      scenarios: proofSummary.scenarios,
      allExpectedCodesObserved: proofSummary.allExpectedCodesObserved,
      summaryPath: relative(ROOT, join(evidenceRoot, 'proof', 'summary.json')),
      transcriptPath: proofSummary.transcriptPath
    },
    noAuthFallback: 'npm run demo'
  };
  atomicWrite(join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(join(evidenceRoot, 'JUDGE.md'), judgeMarkdown(summary));
  return { ...summary, evidenceRoot: relative(ROOT, evidenceRoot) };
}

function main() {
  const summary = runJudgeKit({
    outDir: arg('--out'),
    runId: arg('--run-id')
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error.code === 'EXEC_OPT_IN_REQUIRED') {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    const evidence = error.evidenceRoot ? ` Evidence: ${relative(ROOT, error.evidenceRoot)}.` : '';
    process.stderr.write(`Build Week judge kit blocked: ${error.message}.${evidence}\n`);
    process.stderr.write('No model fallback was attempted. Run `npm run demo` for the deterministic no-auth path.\n');
    process.exit(1);
  }
}
