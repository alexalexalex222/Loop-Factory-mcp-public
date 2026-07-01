// Local-first persistence. Everything lives on the operator's own disk under a
// home dir; nothing leaves the machine. State is plain JSON; artifacts (raw run
// logs the benchmark measures) are separate files so they can be re-hashed during
// reverify. Writes are atomic (tmp file + rename) so a crash can't corrupt state.
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSafeId, safeId } from './util.mjs';

export function createStore(homeDir) {
  const runsRoot = resolve(homeDir, 'runs');
  const loopsRoot = resolve(homeDir, 'custom-loops');
  const skillsRoot = resolve(homeDir, 'skills');

  function assertWithin(base, target, label) {
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`${label} escaped the super-loop home`);
    }
  }

  function runDir(runId) {
    const target = resolve(runsRoot, safeId(runId, 'runId'));
    assertWithin(runsRoot, target, 'runId');
    return target;
  }
  function statePath(runId) {
    return join(runDir(runId), 'state.json');
  }
  function artifactsDir(runId) {
    return join(runDir(runId), 'artifacts');
  }
  function artifactPath(runId, artifactId) {
    return join(artifactsDir(runId), `${safeId(artifactId, 'artifactId')}.json`);
  }
  function runFilePath(runId, relPath) {
    const relPathString = String(relPath || '');
    if (!relPathString || relPathString.includes('\0') || isAbsolute(relPathString)) {
      throw new Error('run file path must be a relative path inside the run directory');
    }
    const base = runDir(runId);
    const full = resolve(base, relPathString);
    assertWithin(base, full, 'run file path');
    return full;
  }

  function atomicWrite(path, contents) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  }

  return {
    homeDir,
    runDir,

    exists(runId) {
      return existsSync(statePath(runId));
    },

    save(state) {
      mkdirSync(runDir(state.runId), { recursive: true });
      mkdirSync(artifactsDir(state.runId), { recursive: true });
      atomicWrite(statePath(state.runId), JSON.stringify(state, null, 2));
      return state;
    },

    load(runId) {
      if (!this.exists(runId)) return null;
      return JSON.parse(readFileSync(statePath(runId), 'utf8'));
    },

    listRuns() {
      if (!existsSync(runsRoot)) return [];
      return readdirSync(runsRoot).filter((name) => isSafeId(name) && existsSync(statePath(name)));
    },

    /** Persist a raw artifact (run log, baseline copy, measurement record). */
    writeArtifact(runId, artifactId, record) {
      mkdirSync(artifactsDir(runId), { recursive: true });
      atomicWrite(artifactPath(runId, artifactId), JSON.stringify(record, null, 2));
      return artifactId;
    },

    readArtifact(runId, artifactId) {
      const path = artifactPath(runId, artifactId);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },

    /** Write a human-facing file (dashboard.html / report.md) into the run dir. */
    writeRunFile(runId, relPath, contents) {
      mkdirSync(runDir(runId), { recursive: true });
      const full = runFilePath(runId, relPath);
      mkdirSync(dirname(full), { recursive: true });
      atomicWrite(full, contents);
      return full;
    },
    readRunFile(runId, relPath) {
      const full = runFilePath(runId, relPath);
      if (!existsSync(full)) return null;
      try { return readFileSync(full, 'utf8'); } catch { return null; }
    },
    runFileExists(runId, relPath) {
      return existsSync(runFilePath(runId, relPath));
    },
    // Atomically move a run file (used to archive a consumed inbox so it is not re-applied).
    moveRunFile(runId, fromRel, toRel) {
      const from = runFilePath(runId, fromRel);
      if (!existsSync(from)) return false;
      const to = runFilePath(runId, toRel);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return true;
    },

    // ---- custom local loop library (user-added loops) ----------------------
    // Lives under <home>/custom-loops, separate from runs. The mandated, bundled
    // loops are NEVER stored here — they stay hash-locked in src/loops + constants.
    loopPath(loopId) {
      const target = resolve(loopsRoot, `${safeId(loopId, 'loopId')}.json`);
      assertWithin(loopsRoot, target, 'loopId');
      return target;
    },
    loopExists(loopId) {
      return existsSync(this.loopPath(loopId));
    },
    writeLoop(record) {
      mkdirSync(loopsRoot, { recursive: true });
      atomicWrite(this.loopPath(record.id), JSON.stringify(record, null, 2));
      return record.id;
    },
    readLoop(loopId) {
      if (!isSafeId(loopId)) return null;
      const path = this.loopPath(loopId);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    listLoops() {
      if (!existsSync(loopsRoot)) return [];
      return readdirSync(loopsRoot)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .filter((id) => isSafeId(id));
    },

    // ---- local skill library (retrievable knowledge files) ----------------
    skillPath(skillId) {
      const target = resolve(skillsRoot, `${safeId(skillId, 'skillId')}.md`);
      assertWithin(skillsRoot, target, 'skillId');
      return target;
    },
    indexPath(skillId) {
      const target = resolve(skillsRoot, `${safeId(skillId, 'skillId')}.index.json`);
      assertWithin(skillsRoot, target, 'skillId');
      return target;
    },
    skillExists(skillId) {
      return existsSync(this.skillPath(skillId));
    },
    writeSkill(record) {
      mkdirSync(skillsRoot, { recursive: true });
      atomicWrite(this.skillPath(record.id), record.content);
      return record.id;
    },
    readSkill(skillId) {
      if (!isSafeId(skillId)) return null;
      const path = this.skillPath(skillId);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      return splitSkillMarkdown(raw);
    },
    listSkills() {
      if (!existsSync(skillsRoot)) return [];
      return readdirSync(skillsRoot)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .filter((id) => isSafeId(id));
    },
    writeIndex(skillId, obj) {
      mkdirSync(skillsRoot, { recursive: true });
      atomicWrite(this.indexPath(skillId), JSON.stringify(obj, null, 2));
      return skillId;
    },
    readIndex(skillId) {
      if (!isSafeId(skillId)) return null;
      const path = this.indexPath(skillId);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    archiveSkill(skillId) {
      const archiveDir = join(skillsRoot, 'archive');
      mkdirSync(archiveDir, { recursive: true });
      const mdPath = this.skillPath(skillId);
      if (!existsSync(mdPath)) return false;
      const parsed = splitSkillMarkdown(readFileSync(mdPath, 'utf8'));
      const index = this.readIndex(skillId);
      const version = index?.version ?? parsed.frontmatter.version ?? 1;
      const digest = index?.sha256 ?? parsed.frontmatter.sha256 ?? 'unknown';
      const prefix = `${safeId(skillId, 'skillId')}-v${version}-${String(digest).slice(0, 12)}`;
      renameSync(mdPath, join(archiveDir, `${prefix}.md`));
      const idxPath = this.indexPath(skillId);
      if (existsSync(idxPath)) {
        renameSync(idxPath, join(archiveDir, `${prefix}.index.json`));
      }
      return true;
    }
  };
}

/** Split a skill markdown file into frontmatter object + body (minimal line parser). */
function splitSkillMarkdown(raw) {
  const text = String(raw);
  if (!text.startsWith('---')) {
    return { frontmatter: {}, body: text };
  }
  const close = text.indexOf('\n---', 3);
  if (close === -1) {
    return { frontmatter: {}, body: text };
  }
  const fmBlock = text.slice(4, close);
  const body = text.slice(close + 4).replace(/^\n+/, '');
  return { frontmatter: parseFrontmatterLines(fmBlock), body };
}

/** Minimal YAML-subset parser: string, integer, and [] array values only. */
function parseFrontmatterLines(block) {
  const fm = {};
  let key = null;
  let arrayMode = false;
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const arrayStart = trimmed.match(/^([A-Za-z0-9_]+):\s*\[(.*)$/);
    if (arrayStart) {
      key = arrayStart[1];
      const rest = arrayStart[2];
      if (rest.includes(']')) {
        const inner = rest.slice(0, rest.indexOf(']')).trim();
        fm[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) : [];
        key = null;
        arrayMode = false;
      } else {
        fm[key] = [];
        arrayMode = true;
        const first = rest.trim();
        if (first) fm[key].push(first.replace(/^['"]|['"]$/g, ''));
      }
      continue;
    }
    if (arrayMode && key) {
      if (trimmed === ']') {
        arrayMode = false;
        key = null;
        continue;
      }
      const item = trimmed.replace(/^-\s*/, '').replace(/,$/, '').replace(/^['"]|['"]$/g, '');
      fm[key].push(item);
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const val = kv[2].trim();
    if (/^-?\d+$/.test(val)) {
      fm[key] = Number(val);
    } else {
      fm[key] = val.replace(/^['"]|['"]$/g, '');
    }
    key = null;
  }
  return fm;
}
