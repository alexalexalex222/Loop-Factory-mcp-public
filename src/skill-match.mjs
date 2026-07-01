// Zero-dep keyword/metadata pre-filter for skill_fetch plan mode (Router 1).

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function fieldTokens(values) {
  const parts = [];
  for (const v of values) {
    if (Array.isArray(v)) parts.push(...v);
    else if (v != null) parts.push(String(v));
  }
  return tokenize(parts.join(' '));
}

/**
 * Score how well a skill index matches a query (higher = better).
 * Overlap on title, tags, supports_tasks, and each section title/purpose.
 */
export function scoreSkillAgainstQuery(indexObj, query) {
  const qTokens = tokenize(query);
  if (!qTokens.length) return 0;
  const qSet = new Set(qTokens);
  const corpus = [
    ...fieldTokens([indexObj.title]),
    ...fieldTokens(indexObj.tags),
    ...fieldTokens(indexObj.supports_tasks),
    ...fieldTokens((indexObj.sections || []).map((s) => `${s.title} ${s.purpose}`))
  ];
  let score = 0;
  for (const tok of corpus) {
    if (qSet.has(tok)) score += 1;
  }
  // Coverage bonus: fraction of query tokens hit at least once.
  let hits = 0;
  const corpusSet = new Set(corpus);
  for (const tok of qTokens) {
    if (corpusSet.has(tok)) hits += 1;
  }
  score += hits / qTokens.length;
  return score;
}

/**
 * Rank skill indices by query relevance. Empty query → all indices, sorted by skill_id.
 */
export function rankSkills(query, indices, topK = 5) {
  const list = Array.isArray(indices) ? indices.filter(Boolean) : [];
  const q = String(query || '').trim();
  if (!q) {
    return [...list].sort((a, b) => String(a.skill_id).localeCompare(String(b.skill_id))).slice(0, topK);
  }
  return [...list]
    .map((idx) => ({ idx, score: scoreSkillAgainstQuery(idx, q) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.idx.skill_id).localeCompare(String(b.idx.skill_id));
    })
    .slice(0, topK)
    .map((row) => row.idx);
}
