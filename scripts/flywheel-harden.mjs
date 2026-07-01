#!/usr/bin/env node
// Skill-hardening flywheel — ONE hardening pass for a registered skill, wired entirely through
// the EXISTING gates. It adds NO new verdict logic:
//   • STEP 1 (baseline integrity floor): the candidate skill is recorded as the run's `baseline`
//     artifact, so a PLACEHOLDER/too-shallow candidate is rejected before it can become canonical.
//   • STEP 2 (dashboard approval): a human_review_request is queued; the canonical version is bumped
//     ONLY after the operator Approves it out of band (engine.operator.applyDashboardDecisions). The
//     script never resolves its own review.
// On approval, loop_register { role:"skill", overwrite:true } archives the prior version (built in,
// store.archiveSkill) and writes the bumped version; a lineage record is appended (append-only).
//
// There is deliberately NO manufactured quality delta: a knowledge skill has no executable benchmark,
// so the operator's dashboard approval IS the verdict — exactly as loop adoption already works
// (human_review_request loopContent → applyDashboardDecisions → adoptLoop). Inventing a measured score
// here would be the fabricated-evidence failure this whole hardening sequence exists to prevent.
//
// Two-phase (approval happens between them, on the dashboard):
//   propose:  node scripts/flywheel-harden.mjs --skill <id> --content-file <improved.md> [--home DIR]
//   apply:    node scripts/flywheel-harden.mjs --skill <id> --content-file <improved.md> --apply \
//                 --run-id <runId> --review <reviewId> [--home DIR]
// Importable: proposeSkillHardening / applySkillHardening are pure functions over (engine, store).
import { readFileSync, existsSync, appendFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../src/server.mjs';
import { parseSkillFile, serializeSkillMarkdown, validateSkillRecord } from '../src/skill-schema.mjs';
import { hash8 } from '../src/util.mjs';

// Operational ask-once answers for the hardening run (operational language only).
const HARDEN_ANSWERS = [
  'a measurably stronger version of this skill',
  'improve',
  'operator-approved quality at equal or lower risk',
  'keep authorship',
  'keep moving until the operator stops'
];

function blockResult(code, message, extra = {}) {
  return { status: 'BLOCKED', code, message, ...extra };
}

/**
 * Build the bumped candidate from the current skill + improved markdown. Pure/deterministic given
 * the current store state, so propose and apply derive the SAME bytes. Carries the prior skill's
 * provenance (license/source/…) forward unless the candidate overrides it; forces version = N+1 and
 * strips any stale sha256/registeredAt so the engine recomputes them.
 */
export function buildCandidate(store, skillId, improvedContent) {
  const prevIndex = store.readIndex(skillId);
  const prev = store.readSkill(skillId); // { frontmatter, body } or null
  const from_version = Number(prevIndex?.version) >= 1 ? Number(prevIndex.version) : 1;
  const from_sha = prevIndex?.sha256 || null;
  const to_version = from_version + 1;
  const parsed = parseSkillFile(improvedContent);
  const fm = { ...(prev?.frontmatter || {}), ...parsed.frontmatter, skill_id: skillId, version: to_version };
  delete fm.sha256;       // a stale sha would trip loop_register's tamper check; let it recompute
  delete fm.registeredAt; // fresh registration time on apply
  const candidateMd = serializeSkillMarkdown(fm, parsed.body);
  return { from_version, to_version, from_sha, fm, body: parsed.body, candidateMd };
}

/**
 * Phase A — gate the candidate through the integrity floor and queue an operator review.
 * Returns { status:'PROPOSED', runId, reviewId, from_version, to_version, from_sha } or a BLOCKED
 * result (the STEP 1 floor block is passed through verbatim).
 */
export function proposeSkillHardening(engine, store, { skillId, runId, improvedContent, task, answers } = {}) {
  if (!skillId || !store.skillExists(skillId)) {
    return blockResult('UNKNOWN_SKILL', `No skill "${skillId}". Register it first with loop_register { role:"skill" }.`);
  }
  const cand = buildCandidate(store, skillId, improvedContent);
  // Existing skill-schema validation (missing license/source/_synthesis, etc.) — reused, not re-implemented.
  try {
    validateSkillRecord(cand.fm, cand.body);
  } catch (e) {
    return blockResult('SKILL_MALFORMED', `Hardening candidate rejected: ${e.message}`);
  }
  // STEP 1 floor: record the candidate as the run's baseline. A placeholder/too-shallow candidate
  // blocks here (BASELINE_PLACEHOLDER / BASELINE_TOO_SHALLOW) and never reaches the dashboard.
  if (!store.exists(runId)) {
    engine.initialize_loop_run({
      runId,
      task: task || `Harden skill ${skillId} (v${cand.from_version} → v${cand.to_version}).`,
      answers: answers || HARDEN_ANSWERS
    });
  }
  const baseline = engine.artifact_record({ runId, role: 'baseline', content: cand.candidateMd });
  if (baseline.status !== 'OK') return baseline;
  // STEP 2 gate: queue the operator review. kind:'change' (no loopId/loopContent) → applyDashboardDecisions
  // simply flips it to APPROVED on operator Approve; the script can never resolve it itself.
  const review = engine.human_review_request({
    runId,
    action: 'add',
    item: {
      kind: 'change',
      title: `harden ${skillId} v${cand.from_version}→v${cand.to_version}`,
      summary: `Skill-hardening candidate for "${skillId}". Approve in the dashboard to bump the canonical version; Sludge to reject.`
    }
  });
  if (review.status !== 'OK') return review;
  return {
    status: 'PROPOSED', skillId, runId, reviewId: review.reviewId,
    from_version: cand.from_version, to_version: cand.to_version, from_sha: cand.from_sha
  };
}

/** Read prior lineage records for a skill (append-only ledger; [] if none). */
export function readLineage(store, skillId) {
  const path = join(dirname(store.skillPath(skillId)), `${skillId}.lineage.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Phase B — apply an operator-APPROVED hardening: register the bumped version (archives the prior
 * version via loop_register's built-in overwrite path) and append a lineage record. Refuses unless
 * the review is APPROVED. Idempotent on the same review (lineage is the dedup ledger).
 */
export function applySkillHardening(engine, store, { skillId, runId, reviewId, improvedContent } = {}) {
  if (!skillId || !store.skillExists(skillId)) {
    return blockResult('UNKNOWN_SKILL', `No skill "${skillId}".`);
  }
  if (!store.exists(runId)) return blockResult('UNKNOWN_RUN', `No run "${runId}".`);
  const state = store.load(runId);
  const review = (state.humanReviews || []).find((r) => r.id === reviewId);
  if (!review) return blockResult('NO_REVIEW', `No review "${reviewId}" in run "${runId}".`);
  if (review.status === 'SLUDGE') {
    return blockResult('PROMOTION_REJECTED', `Operator sludged review ${reviewId}; the skill was not hardened.`);
  }
  if (review.status !== 'APPROVED') {
    return blockResult('PROMOTION_NEEDS_APPROVAL', `Review ${reviewId} is ${review.status}. Approve it in the dashboard before the canonical version is bumped.`);
  }
  // Idempotency: a review already applied (its id is in the lineage ledger) is a no-op, not a re-bump.
  if (readLineage(store, skillId).some((r) => r.reviewId === reviewId)) {
    const idx = store.readIndex(skillId);
    return { status: 'OK', code: 'ALREADY_APPLIED', skillId, version: idx?.version, reviewId };
  }
  const cand = buildCandidate(store, skillId, improvedContent);
  // loop_register overwrite archives the prior version (store.archiveSkill) AND writes the bumped one.
  const reg = engine.loop_register({ runId, role: 'skill', id: skillId, content: cand.candidateMd, overwrite: true });
  if (reg.status !== 'OK') return reg;
  const to_version = reg.skill.version;
  const to_sha = reg.skill.sha256;
  const record = {
    skill_id: skillId, from_version: cand.from_version, to_version,
    from_sha: cand.from_sha, to_sha, runId, reviewId, promoted_at: new Date().toISOString()
  };
  const lineagePath = join(dirname(store.skillPath(skillId)), `${skillId}.lineage.jsonl`);
  appendFileSync(lineagePath, JSON.stringify(record) + '\n', 'utf8');
  return {
    status: 'PROMOTED', skillId, from_version: cand.from_version, to_version,
    from_sha: cand.from_sha, to_sha, reviewId, lineagePath, lineage: record
  };
}

// ---- CLI (only when run directly; importing this module has no side effects) ----------------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function runCli() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write([
      'usage:',
      '  propose: node scripts/flywheel-harden.mjs --skill <id> --content-file <improved.md> [--home DIR]',
      '  apply:   node scripts/flywheel-harden.mjs --skill <id> --content-file <improved.md> --apply --run-id <runId> --review <reviewId> [--home DIR]',
      '',
      'propose gates the candidate (integrity floor) and queues a dashboard review.',
      'Approve it in the dashboard, then re-run with --apply to bump the canonical version.',
      ''
    ].join('\n'));
    process.exit(0);
  }
  const skillId = arg('--skill');
  const contentFile = arg('--content-file');
  const home = arg('--home');
  const doApply = process.argv.includes('--apply');
  if (!skillId || !contentFile) {
    process.stderr.write('error: --skill <id> and --content-file <path> are required\n');
    process.exit(2);
  }
  if (!existsSync(contentFile)) {
    process.stderr.write(`error: cannot read --content-file ${contentFile}\n`);
    process.exit(2);
  }
  const improvedContent = readFileSync(contentFile, 'utf8');
  const runId = arg('--run-id', `harden-${skillId}-${hash8(improvedContent)}`);
  const { engine, store } = buildServer(home ? { home } : {});

  if (!doApply) {
    const r = proposeSkillHardening(engine, store, { skillId, runId, improvedContent });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    if (r.status === 'PROPOSED') {
      process.stdout.write(`\nApprove review ${r.reviewId} in the dashboard, then run:\n  node scripts/flywheel-harden.mjs --skill ${skillId} --content-file ${contentFile}${home ? ` --home ${home}` : ''} --apply --run-id ${runId} --review ${r.reviewId}\n`);
      process.exit(0);
    }
    process.exit(1);
  }
  const reviewId = arg('--review');
  if (!reviewId) { process.stderr.write('error: --apply requires --review <reviewId> (and --run-id <runId>)\n'); process.exit(2); }
  const r = applySkillHardening(engine, store, { skillId, runId, reviewId, improvedContent });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.status === 'PROMOTED' || r.code === 'ALREADY_APPLIED' ? 0 : 1);
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) runCli();
