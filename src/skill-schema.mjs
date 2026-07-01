// Skill format validation + section-id derivation (locked spec: conductor/SKILL_FORMAT_SPEC.md).
import { createHash } from 'node:crypto';
import { sectionize } from './loops.mjs';

export const SKILL_PARTITION = { WORKING: 'working', REFERENCE: 'reference' };

/** Split raw markdown into frontmatter object + body bytes. */
export function parseSkillFile(rawMd) {
  const text = String(rawMd);
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

/** sha256 of canonical body bytes (CRLF→LF normalized). */
export function computeSkillSha256(body) {
  const normalized = String(body).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex');
}

/** Canonical section_id slug per spec. */
export function slugify(title) {
  let s = String(title || '').normalize('NFKC').toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 64) s = s.slice(0, 64).replace(/-+$/, '');
  return s || 'section';
}

const SECTION_OVERRIDE_RE = /<!--\s*section_id:\s*([^\s]+)(?:\s+purpose:\s*(.*?))?\s*-->/;

/** Mirror src/loops.mjs isHeader — count header lines for auto-sectionize threshold. */
function isHeader(line) {
  const t = line.trim();
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (t.length < 4 || t.length > 80) return false;
  if (!/^[A-Z0-9][A-Z0-9 ,/&''.\-]*$/.test(t)) return false;
  if (/[a-z]/.test(t)) return false;
  return t.includes(' ') || t.length >= 6;
}

function headerLineCount(body) {
  return body.split('\n').filter((l) => isHeader(l)).length;
}

function parseSectionOverride(blockBody) {
  const m = blockBody.match(SECTION_OVERRIDE_RE);
  if (!m) return null;
  return { section_id: m[1], purpose: (m[2] || '').trim() };
}

function assignIds(sections, idMode) {
  const seen = new Map();
  return sections.map((sec) => {
    let baseId = idMode === 'index' ? `s${sec.index}` : slugify(sec.title);
    if (sec.overrideId) baseId = sec.overrideId;
    let section_id = baseId;
    const count = seen.get(baseId) || 0;
    if (count > 0) section_id = `${baseId}-${count + 1}`;
    seen.set(baseId, count + 1);
    const purpose = sec.overridePurpose ?? sec.title;
    const chars = sec.body.length;
    return { section_id, title: sec.title, purpose, chars, body: sec.body };
  });
}

/**
 * Derive section ids ONCE at ingest (frozen into index file afterward).
 * @returns {{section_id:string, title:string, purpose:string, chars:number, body:string}[]}
 */
export function deriveSectionIds(body) {
  const text = String(body);
  const useAuto = headerLineCount(text) < 3;
  const blocks = sectionize(text);
  const sections = blocks.map((b) => ({
    index: b.index,
    title: b.title,
    body: b.body,
    ...(() => {
      const override = parseSectionOverride(b.body);
      return override
        ? { overrideId: override.section_id, overridePurpose: override.purpose }
        : {};
    })()
  }));
  return assignIds(sections, useAuto ? 'index' : 'slug');
}

/** Validate provenance + structure; return normalized record or throw. */
export function validateSkillRecord(frontmatter, body) {
  const fm = { ...frontmatter };
  const license = String(fm.license || '').trim();
  if (!license) throw new Error('missing license');
  const source = String(fm.source || '').trim();
  if (!source) throw new Error('missing source');

  const computed = computeSkillSha256(body);
  if (fm.sha256 && String(fm.sha256) !== computed) {
    throw new Error(`sha256 mismatch: frontmatter ${fm.sha256} != computed ${computed}`);
  }
  fm.sha256 = computed;

  const sections = deriveSectionIds(body);
  const ids = sections.map((s) => s.section_id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate section_id: ${dup}`);

  if (!ids.includes('_synthesis')) {
    throw new Error('missing required _synthesis section');
  }

  const partition = fm.skillPartition || SKILL_PARTITION.WORKING;
  if (partition !== SKILL_PARTITION.WORKING && partition !== SKILL_PARTITION.REFERENCE) {
    throw new Error(`invalid skillPartition: ${partition}`);
  }

  return {
    frontmatter: fm,
    body,
    sections,
    sha256: computed,
    version: Number(fm.version) >= 1 ? Number(fm.version) : 1,
    skillPartition: partition,
    source_paths: Array.isArray(fm.source_paths) ? fm.source_paths : []
  };
}

/** Build Router-1 index view object (metadata only, no section bodies). */
export function buildSkillIndex(skillId, frontmatter, sections) {
  return {
    skill_id: skillId,
    title: frontmatter.title || skillId,
    version: Number(frontmatter.version) >= 1 ? Number(frontmatter.version) : 1,
    sha256: frontmatter.sha256,
    license: frontmatter.license,
    source: frontmatter.source,
    skillPartition: frontmatter.skillPartition || SKILL_PARTITION.WORKING,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    stack: Array.isArray(frontmatter.stack) ? frontmatter.stack : [],
    supports_tasks: Array.isArray(frontmatter.supports_tasks) ? frontmatter.supports_tasks : [],
    anti_patterns: Array.isArray(frontmatter.anti_patterns) ? frontmatter.anti_patterns : [],
    synthesis_guidance: frontmatter.synthesis_guidance || '',
    token_budget_hint: frontmatter.token_budget_hint ?? null,
    source_paths: Array.isArray(frontmatter.source_paths) ? frontmatter.source_paths : [],
    sections: sections.map(({ section_id, title, purpose, chars }) => ({
      section_id,
      title,
      purpose,
      chars,
      token_estimate: Math.ceil(chars / 4)
    }))
  };
}

/** Serialize frontmatter + body back to canonical markdown. */
export function serializeSkillMarkdown(frontmatter, body) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(frontmatter)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      lines.push(val.length === 0 ? `${key}: []` : `${key}: [${val.join(', ')}]`);
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---', '', body.replace(/^\n+/, ''));
  return lines.join('\n');
}

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
