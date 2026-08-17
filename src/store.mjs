// Local-first persistence. Everything lives on the operator's own disk under a
// home dir; nothing leaves the machine. State is plain JSON; artifacts (raw run
// logs the benchmark measures) are separate files so they can be re-hashed during
// reverify. Writes are process-atomic by default; paid VNext launchers opt into
// file-and-directory fsync so a power loss cannot roll back a dispatch barrier.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  durableAtomicWriteFileSync,
  durableRenameSync,
  supportsPowerLossDurability
} from './durable-file.mjs';
import { isPortableId, isSafeId, portableId, safeId } from './util.mjs';
import { parseSkillFile } from './skill-schema.mjs';

export const STORE_DURABILITY = Object.freeze({
  PROCESS_ATOMIC: 'process-atomic',
  POWER_LOSS: 'power-loss'
});

export function createStore(homeDir, {
  durability = STORE_DURABILITY.PROCESS_ATOMIC
} = {}) {
  if (!Object.values(STORE_DURABILITY).includes(durability)) {
    throw new Error(`Unsupported store durability: ${durability}`);
  }
  if (durability === STORE_DURABILITY.POWER_LOSS
      && !supportsPowerLossDurability()) {
    const error = new Error(
      `Power-loss durability is unsupported on ${process.platform}.`
    );
    error.code = 'DURABLE_PLATFORM_UNSUPPORTED';
    throw error;
  }
  const homeRoot = resolve(homeDir);
  const runsRoot = resolve(homeRoot, 'runs');
  const loopsRoot = resolve(homeRoot, 'custom-loops');
  const skillsRoot = resolve(homeRoot, 'skills');

  function assertWithin(base, target, label) {
    const rel = relative(base, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`${label} escaped the super-loop home`);
    }
  }

  function assertNoSymlinkPath(target, label) {
    assertWithin(homeRoot, target, label);
    if (!existsSync(homeRoot)) return;
    const homeStat = lstatSync(homeRoot);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
      throw new Error(`${label} traversed an unsafe store home`);
    }
    let current = homeRoot;
    const parts = relative(homeRoot, target).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      if (!existsSync(current)) break;
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} traversed a symbolic link`);
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`${label} traversed a non-directory path`);
      }
    }
  }

  function ensureDirectory(directory, label) {
    assertWithin(homeRoot, directory, label);
    if (!existsSync(homeRoot)) mkdirSync(homeRoot, { recursive: true });
    assertNoSymlinkPath(homeRoot, label);
    let current = homeRoot;
    for (const part of relative(homeRoot, directory).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (!existsSync(current)) mkdirSync(current);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} traversed a symbolic link`);
      if (!stat.isDirectory()) throw new Error(`${label} requires ordinary directories`);
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
    assertNoSymlinkPath(path, 'store write');
    if (durability === STORE_DURABILITY.POWER_LOSS) {
      durableAtomicWriteFileSync(path, contents);
      return;
    }
    const tmp = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      writeFileSync(tmp, contents, { flag: 'wx' });
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }

  function namesUnder(root) {
    if (!existsSync(root)) return [];
    assertNoSymlinkPath(root, 'store listing');
    try { return readdirSync(root); } catch { return []; }
  }

  function exactEntry(root, name) {
    return namesUnder(root).includes(name);
  }

  function caseCollision(root, name) {
    const folded = name.toLowerCase();
    return namesUnder(root).find((entry) => entry !== name && entry.toLowerCase() === folded) || null;
  }

  function assertNewPortableEntry(root, id, label, suffix = '') {
    const entry = `${id}${suffix}`;
    if (!isSafeId(id)) safeId(id, label);
    if (exactEntry(root, entry)) return;
    portableId(id, label);
    const collision = caseCollision(root, entry);
    if (collision) {
      throw new Error(`${label} "${id}" has a case-insensitive collision with "${collision.slice(0, suffix ? -suffix.length : undefined)}"`);
    }
  }

  return {
    homeDir,
    durability,
    runDir,

    runIdCollision(runId) {
      return caseCollision(runsRoot, String(runId));
    },

    exists(runId) {
      const path = statePath(runId);
      assertNoSymlinkPath(path, 'run state');
      return exactEntry(runsRoot, String(runId)) && existsSync(path);
    },

    save(state) {
      assertNewPortableEntry(runsRoot, state.runId, 'runId');
      ensureDirectory(runDir(state.runId), 'run directory');
      ensureDirectory(artifactsDir(state.runId), 'artifact directory');
      atomicWrite(statePath(state.runId), JSON.stringify(state, null, 2));
      return state;
    },

    load(runId) {
      if (!this.exists(runId)) return null;
      return JSON.parse(readFileSync(statePath(runId), 'utf8'));
    },

    listRuns() {
      if (!existsSync(runsRoot)) return [];
      assertNoSymlinkPath(runsRoot, 'run listing');
      return readdirSync(runsRoot).filter((name) => isSafeId(name) && existsSync(statePath(name)));
    },

    /** Persist a raw artifact (run log, baseline copy, measurement record). */
    writeArtifact(runId, artifactId, record) {
      ensureDirectory(artifactsDir(runId), 'artifact directory');
      atomicWrite(artifactPath(runId, artifactId), JSON.stringify(record, null, 2));
      return artifactId;
    },

    readArtifact(runId, artifactId) {
      const path = artifactPath(runId, artifactId);
      assertNoSymlinkPath(path, 'artifact read');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },

    /** Write a human-facing file (dashboard.html / report.md) into the run dir. */
    writeRunFile(runId, relPath, contents) {
      ensureDirectory(runDir(runId), 'run directory');
      const full = runFilePath(runId, relPath);
      ensureDirectory(dirname(full), 'run file directory');
      atomicWrite(full, contents);
      return full;
    },
    readRunFile(runId, relPath) {
      const full = runFilePath(runId, relPath);
      assertNoSymlinkPath(full, 'run file read');
      if (!existsSync(full)) return null;
      try { return readFileSync(full, 'utf8'); } catch { return null; }
    },
    runFileExists(runId, relPath) {
      const full = runFilePath(runId, relPath);
      assertNoSymlinkPath(full, 'run file existence check');
      return existsSync(full);
    },
    // Atomically move a run file (used to archive a consumed inbox so it is not re-applied).
    moveRunFile(runId, fromRel, toRel) {
      const from = runFilePath(runId, fromRel);
      assertNoSymlinkPath(from, 'run file move source');
      if (!existsSync(from)) return false;
      const to = runFilePath(runId, toRel);
      ensureDirectory(dirname(to), 'run file move destination');
      assertNoSymlinkPath(to, 'run file move destination');
      if (durability === STORE_DURABILITY.POWER_LOSS) {
        durableRenameSync(from, to);
      } else {
        renameSync(from, to);
      }
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
      return exactEntry(loopsRoot, `${loopId}.json`) && existsSync(this.loopPath(loopId));
    },
    loopIdCollision(loopId) {
      const hit = caseCollision(loopsRoot, `${loopId}.json`);
      return hit ? hit.slice(0, -5) : null;
    },
    writeLoop(record) {
      assertNewPortableEntry(loopsRoot, record.id, 'loopId', '.json');
      ensureDirectory(loopsRoot, 'loop library');
      atomicWrite(this.loopPath(record.id), JSON.stringify(record, null, 2));
      return record.id;
    },
    readLoop(loopId) {
      if (!isSafeId(loopId)) return null;
      const path = this.loopPath(loopId);
      assertNoSymlinkPath(path, 'loop read');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    listLoops() {
      if (!existsSync(loopsRoot)) return [];
      assertNoSymlinkPath(loopsRoot, 'loop listing');
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
      return exactEntry(skillsRoot, `${skillId}.md`) && existsSync(this.skillPath(skillId));
    },
    skillIdCollision(skillId) {
      const hit = caseCollision(skillsRoot, `${skillId}.md`);
      return hit ? hit.slice(0, -3) : null;
    },
    writeSkill(record) {
      assertNewPortableEntry(skillsRoot, record.id, 'skillId', '.md');
      ensureDirectory(skillsRoot, 'skill library');
      atomicWrite(this.skillPath(record.id), record.content);
      return record.id;
    },
    readSkill(skillId) {
      if (!isSafeId(skillId)) return null;
      const path = this.skillPath(skillId);
      assertNoSymlinkPath(path, 'skill read');
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf8');
      return splitSkillMarkdown(raw);
    },
    listSkills() {
      if (!existsSync(skillsRoot)) return [];
      assertNoSymlinkPath(skillsRoot, 'skill listing');
      return readdirSync(skillsRoot)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .filter((id) => isSafeId(id));
    },
    writeIndex(skillId, obj) {
      assertNewPortableEntry(skillsRoot, skillId, 'skillId', '.index.json');
      ensureDirectory(skillsRoot, 'skill library');
      atomicWrite(this.indexPath(skillId), JSON.stringify(obj, null, 2));
      return skillId;
    },
    readIndex(skillId) {
      if (!isSafeId(skillId)) return null;
      const path = this.indexPath(skillId);
      assertNoSymlinkPath(path, 'skill index read');
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    archiveSkill(skillId) {
      const archiveDir = join(skillsRoot, 'archive');
      ensureDirectory(archiveDir, 'skill archive');
      const mdPath = this.skillPath(skillId);
      assertNoSymlinkPath(mdPath, 'skill archive source');
      if (!existsSync(mdPath)) return false;
      const parsed = splitSkillMarkdown(readFileSync(mdPath, 'utf8'));
      const index = this.readIndex(skillId);
      const version = index?.version ?? parsed.frontmatter.version ?? 1;
      const digest = index?.sha256 ?? parsed.frontmatter.sha256 ?? 'unknown';
      const prefix = `${safeId(skillId, 'skillId')}-v${version}-${String(digest).slice(0, 12)}`;
      const archivedMarkdown = join(archiveDir, `${prefix}.md`);
      assertNoSymlinkPath(archivedMarkdown, 'skill archive destination');
      renameSync(mdPath, archivedMarkdown);
      const idxPath = this.indexPath(skillId);
      if (existsSync(idxPath)) {
        const archivedIndex = join(archiveDir, `${prefix}.index.json`);
        assertNoSymlinkPath(idxPath, 'skill index archive source');
        assertNoSymlinkPath(archivedIndex, 'skill index archive destination');
        renameSync(idxPath, archivedIndex);
      }
      return true;
    }
  };
}

/** Split a skill markdown file into frontmatter + body (shared parser in skill-schema). */
function splitSkillMarkdown(raw) {
  return parseSkillFile(raw);
}
