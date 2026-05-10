/**
 * Skill Search v3 — PostgreSQL-powered skill matching
 *
 * Replaces the in-memory JSON index with native PostgreSQL queries:
 * - tsvector full-text search (French language)
 * - pg_trgm trigram fuzzy matching
 * - JSONB @> containment for tag filtering
 * - Combined scoring with ts_rank + similarity
 *
 * No more 22 MB index in memory. No more LLM calls for tag extraction.
 */

import { getPool } from "./db/connection";

// ─── Public API (same interface as skill-search.ts) ───

export interface SkillMatch {
  id: string;
  name: string;
  domain: string;
  domainId: string;
  description: string;
  systemPrompt: string;
  temperature: number;
  score: number;
}

export interface SkillSearchOptions {
  limit?: number;
  category?: string;
  tags?: string[];
  model?: string;
  minScore?: number;
}

/**
 * Full-text + trigram search for skills in PostgreSQL.
 * Combines ts_rank (FTS relevance) with pg_trgm similarity for fuzzy matching.
 */
export async function searchSkillsDb(query: string, options: SkillSearchOptions = {}): Promise<SkillMatch[]> {
  const { limit = 5, category, tags, model, minScore = 0.01 } = options;
  const pool = getPool();

  const params: any[] = [query, query, limit];
  let whereExtra = "";
  let paramIdx = 4;

  if (category) {
    whereExtra += ` AND s.category = $${paramIdx}`;
    params.push(category);
    paramIdx++;
  }

  if (tags && tags.length > 0) {
    whereExtra += ` AND s.tags @> $${paramIdx}::jsonb`;
    params.push(JSON.stringify(tags));
    paramIdx++;
  }

  if (model) {
    whereExtra += ` AND s.model = $${paramIdx}`;
    params.push(model);
    paramIdx++;
  }

  const result = await pool.query(
    `SELECT
       s.id, s.name, s.description, s.system_prompt, s.temperature,
       s.domain_id, d.name as domain_name, s.category,
       (
         -- FTS rank (0-1 range, weighted)
         COALESCE(ts_rank(s.search_vector, plainto_tsquery('french', $1)), 0) * 10
         -- Trigram similarity on name (0-1 range)
         + COALESCE(similarity(s.name, $2), 0) * 5
         -- Trigram similarity on description
         + COALESCE(similarity(s.description, $2), 0) * 2
       ) AS score
     FROM skills s
     JOIN skill_domains d ON d.id = s.domain_id
     WHERE s.quality_tier IN ('core', 'extended')
     AND (
       s.search_vector @@ plainto_tsquery('french', $1)
       OR similarity(s.name, $2) > 0.1
       OR similarity(s.description, $2) > 0.05
     )${whereExtra}
     ORDER BY score DESC
     LIMIT $3`,
    params,
  );

  return result.rows
    .filter((r: any) => r.score >= minScore)
    .map((r: any) => ({
      id: r.id,
      name: r.name,
      domain: r.domain_name,
      domainId: r.domain_id,
      description: r.description,
      systemPrompt: r.system_prompt || "",
      temperature: r.temperature,
      score: parseFloat(r.score.toFixed(3)),
    }));
}

/**
 * Find the single best matching skill.
 */
export async function findBestSkillDb(query: string, options: SkillSearchOptions = {}): Promise<SkillMatch | null> {
  const results = await searchSkillsDb(query, { ...options, limit: 1 });
  return results.length > 0 ? results[0] : null;
}

/**
 * Search skills by exact tag match (JSONB containment).
 */
export async function searchSkillsByTags(tags: string[], limit = 10): Promise<SkillMatch[]> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT
       s.id, s.name, s.description, s.system_prompt, s.temperature,
       s.domain_id, d.name as domain_name,
       jsonb_array_length(s.tags) as tag_count
     FROM skills s
     JOIN skill_domains d ON d.id = s.domain_id
     WHERE s.tags @> $1::jsonb
     ORDER BY tag_count ASC
     LIMIT $2`,
    [JSON.stringify(tags), limit],
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    domain: r.domain_name,
    domainId: r.domain_id,
    description: r.description,
    systemPrompt: r.system_prompt || "",
    temperature: r.temperature,
    score: r.tag_count,
  }));
}

/**
 * List all domains with skill counts.
 */
export async function listDomains(filter?: string): Promise<Array<{ id: string; name: string; category: string; skillCount: number }>> {
  const pool = getPool();

  const params: any[] = [];
  let where = "";
  if (filter) {
    where = "WHERE d.name ILIKE $1 OR d.id ILIKE $1 OR d.category ILIKE $1";
    params.push(`%${filter}%`);
  }

  const result = await pool.query(
    `SELECT d.id, d.name, d.category, d.skill_count
     FROM skill_domains d
     ${where}
     ORDER BY d.skill_count DESC`,
    params,
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    skillCount: r.skill_count,
  }));
}

/**
 * Get skills in a specific domain.
 */
export async function getSkillsByDomain(domainId: string): Promise<SkillMatch[]> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT s.id, s.name, s.description, s.system_prompt, s.temperature,
            s.domain_id, d.name as domain_name
     FROM skills s
     JOIN skill_domains d ON d.id = s.domain_id
     WHERE s.domain_id = $1
     ORDER BY s.name`,
    [domainId],
  );

  return result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    domain: r.domain_name,
    domainId: r.domain_id,
    description: r.description,
    systemPrompt: r.system_prompt || "",
    temperature: r.temperature,
    score: 0,
  }));
}

/**
 * Get global stats about the skills library.
 */
export async function getSkillStats(): Promise<{
  totalSkills: number;
  totalDomains: number;
  categories: string[];
  topTags: Array<{ tag: string; count: number }>;
  modelDistribution: Array<{ model: string; count: number }>;
}> {
  const pool = getPool();

  const [skillCount, domainCount, categories, topTags, models] = await Promise.all([
    pool.query("SELECT COUNT(*) as cnt FROM skills"),
    pool.query("SELECT COUNT(*) as cnt FROM skill_domains"),
    pool.query("SELECT DISTINCT category FROM skill_domains ORDER BY category"),
    pool.query(`
      SELECT tag, COUNT(*) as cnt
      FROM skills, jsonb_array_elements_text(tags) AS tag
      GROUP BY tag
      ORDER BY cnt DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT model, COUNT(*) as cnt
      FROM skills
      GROUP BY model
      ORDER BY cnt DESC
    `),
  ]);

  return {
    totalSkills: parseInt(skillCount.rows[0].cnt),
    totalDomains: parseInt(domainCount.rows[0].cnt),
    categories: categories.rows.map((r: any) => r.category),
    topTags: topTags.rows.map((r: any) => ({ tag: r.tag, count: parseInt(r.cnt) })),
    modelDistribution: models.rows.map((r: any) => ({ model: r.model, count: parseInt(r.cnt) })),
  };
}

/**
 * Hybrid skill search: FTS + trigram + vector cosine similarity.
 * Uses pgvector embeddings when available, falls back to FTS + trigram only.
 *
 * Re-exported from vector-search.ts for convenience — callers can import from either.
 */
export { searchSkillsHybrid, type VectorSkillMatch } from "./vector-search";

/**
 * Record a skill usage event (for analytics).
 */
export async function recordSkillUsage(skillId: string, userId: string, score: number, success: boolean, durationMs: number): Promise<void> {
  const pool = getPool();
  const id = `su-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await pool.query(
    `INSERT INTO skill_usage (id, skill_id, user_id, score, success, duration_ms, invoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [id, skillId, userId, score, success, durationMs],
  );
}
