import {
  and,
  desc,
  eq,
  genId,
  getDb,
  getPool,
  memoryArchive,
  memoryLive,
  now,
  qubikCache,
  qubikFeedback,
} from "./shared";

const LIVE_MEMORY_THRESHOLD = 30;
let autoArchiveRunning = false;
const MAX_ARCHIVE_CONTENT_LENGTH = 4000;

export async function writeToLiveMemory(userId: string, params: {
  sessionId: string;
  type: "command" | "file_op" | "error" | "agent_decision";
  source: string;
  content: string;
}) {
  const db = getDb();
  const id = genId("live");
  await db.insert(memoryLive).values({
    id,
    userId,
    sessionId: params.sessionId,
    type: params.type,
    source: params.source,
    content: params.content,
    createdAt: now(),
  });

  if (!autoArchiveRunning) {
    const rows = await db.select({ id: memoryLive.id }).from(memoryLive).where(eq(memoryLive.userId, userId));
    const count = rows.length;
    if (count >= LIVE_MEMORY_THRESHOLD) {
      autoArchiveRunning = true;
      try {
        await clearLiveMemory(userId);
        console.log(`[CORTEX] Auto-archived ${count} live entries for user ${userId}`);
      } finally {
        autoArchiveRunning = false;
      }
    }
  }

  return id;
}

export async function getLiveMemory(userId: string, limit = 100) {
  return getDb().select().from(memoryLive).where(eq(memoryLive.userId, userId)).orderBy(desc(memoryLive.createdAt)).limit(limit);
}

export async function purgeLiveMemory(userId: string) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await getPool().query("DELETE FROM memory_live WHERE user_id = $1 AND created_at < $2", [userId, cutoff]);
}

export async function clearLiveMemory(userId: string) {
  const db = getDb();
  const liveEntries = await db.select().from(memoryLive).where(eq(memoryLive.userId, userId)).orderBy(desc(memoryLive.createdAt));

  if (liveEntries.length > 0) {
    const byType: Record<string, typeof liveEntries> = {};
    for (const entry of liveEntries) (byType[entry.type] ??= []).push(entry);

    const typeMapping: Record<string, "observation" | "bug_fix" | "decision" | "convention"> = {
      command: "observation",
      file_op: "observation",
      error: "bug_fix",
      agent_decision: "decision",
    };

    const maxPurgeEntries = 20;
    const maxEntryContent = 200;
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

    for (const [type, entries] of Object.entries(byType)) {
      const archiveType = typeMapping[type] ?? "observation";
      const recent = entries.slice(0, maxPurgeEntries);
      const lines = recent.map((entry) => {
        const time = new Date(entry.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        const text = entry.content.length > maxEntryContent ? `${entry.content.slice(0, maxEntryContent)}...` : entry.content;
        return `- [${time}] ${text}`;
      });
      let content = lines.join("\n");
      if (entries.length > maxPurgeEntries) {
        content = `${entries.length} total entries (showing last ${maxPurgeEntries}):\n${content}`;
      }

      await db.insert(memoryArchive).values({
        id: genId("arch"),
        userId,
        type: archiveType,
        source: "purge",
        title: `${type} (${entries.length} entrees) — ${timestamp}`,
        content,
        tags: [type, "auto-purge"],
        createdAt: now(),
      });
    }
  }

  await getPool().query("DELETE FROM memory_live WHERE user_id = $1", [userId]);
}

export async function createArchiveEntry(userId: string, params: {
  type: "decision" | "convention" | "bug_fix" | "architecture" | "observation";
  source: string;
  title: string;
  content: string;
  tags?: string[];
}) {
  const db = getDb();
  const id = genId("arch");
  let content = params.content;
  if (content.length > MAX_ARCHIVE_CONTENT_LENGTH) {
    content = `${content.slice(0, MAX_ARCHIVE_CONTENT_LENGTH)}\n\n[... truncated: ${params.content.length} chars total]`;
  }
  await db.insert(memoryArchive).values({
    id,
    userId,
    type: params.type,
    source: params.source,
    title: params.title,
    content,
    tags: params.tags ?? [],
    createdAt: now(),
  });

  import("../../vector-search").then(({ embedArchiveEntry }) => {
    embedArchiveEntry(id, params.title, content, params.tags ?? []).catch(() => {});
  }).catch(() => {});

  return id;
}

export async function getArchiveEntries(userId: string, params?: { type?: string; limit?: number }) {
  const limit = params?.limit ?? 50;
  const conditions = [eq(memoryArchive.userId, userId)];
  if (params?.type) conditions.push(eq(memoryArchive.type, params.type as any));
  let q = getDb().select().from(memoryArchive).$dynamic();
  q = q.where(and(...conditions));
  q = q.orderBy(desc(memoryArchive.createdAt));
  q = q.limit(limit);
  return q;
}

export async function searchArchive(userId: string, params: {
  query: string;
  type?: string;
  source?: string;
  tag?: string;
  limit?: number;
}) {
  const pool = getPool();
  const limit = params.limit ?? 20;
  if (!params.query.trim()) return [];

  const ftsQuery = params.query.replace(/['"]/g, "").split(/\s+/).filter(Boolean).join(" & ");
  if (!ftsQuery) return [];

  try {
    let queryText = `
      SELECT id, type, source, title, content, tags, created_at,
        ts_rank(search_vector, plainto_tsquery('french', $1)) as rank
      FROM memory_archive
      WHERE search_vector @@ plainto_tsquery('french', $1)
        AND user_id = $2
    `;
    const queryParams: any[] = [params.query, userId];
    let paramIdx = 3;

    if (params.type) {
      queryText += ` AND type = $${paramIdx}`;
      queryParams.push(params.type);
      paramIdx++;
    }
    if (params.source) {
      queryText += ` AND source = $${paramIdx}`;
      queryParams.push(params.source);
      paramIdx++;
    }
    if (params.tag) {
      queryText += ` AND tags::text LIKE $${paramIdx}`;
      queryParams.push(`%${params.tag}%`);
      paramIdx++;
    }

    queryText += ` ORDER BY rank DESC LIMIT $${paramIdx}`;
    queryParams.push(limit);
    return (await pool.query(queryText, queryParams)).rows;
  } catch {
    let queryText = `
      SELECT id, type, source, title, content, tags, created_at, 0 as rank
      FROM memory_archive
      WHERE user_id = $1
        AND (title LIKE $2 OR content LIKE $2 OR tags::text LIKE $2)
    `;
    const likeQ = `%${params.query}%`;
    const queryParams: any[] = [userId, likeQ];
    let paramIdx = 3;

    if (params.type) {
      queryText += ` AND type = $${paramIdx}`;
      queryParams.push(params.type);
      paramIdx++;
    }
    if (params.source) {
      queryText += ` AND source = $${paramIdx}`;
      queryParams.push(params.source);
      paramIdx++;
    }

    queryText += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    queryParams.push(limit);
    return (await pool.query(queryText, queryParams)).rows;
  }
}

export async function deleteArchiveEntry(userId: string, id: string) {
  await getDb().delete(memoryArchive).where(and(eq(memoryArchive.id, id), eq(memoryArchive.userId, userId)));
}

export async function lookupQubikCache(userId: string, queryHash: string, level?: string) {
  const db = getDb();
  const conditions = [eq(qubikCache.userId, userId), eq(qubikCache.queryHash, queryHash)];
  if (level) conditions.push(eq(qubikCache.level, level as any));

  const [row] = await db.select().from(qubikCache).where(and(...conditions)).limit(1);
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date()) {
    await db.delete(qubikCache).where(eq(qubikCache.id, row.id));
    return null;
  }
  await db.update(qubikCache).set({ hitCount: row.hitCount + 1, updatedAt: now() }).where(eq(qubikCache.id, row.id));
  return row;
}

export async function writeQubikCache(data: {
  userId: string;
  level: "L1_exact" | "L2_intent" | "L3_template";
  queryHash: string;
  query: string;
  intent?: string;
  entities?: string[];
  output: string;
  model?: string;
  toolsUsed?: string[];
  ttlSeconds?: number;
}) {
  const ttl = data.ttlSeconds || 3600;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const id = genId("qcache");
  await getDb().insert(qubikCache).values({
    id,
    userId: data.userId,
    level: data.level,
    queryHash: data.queryHash,
    query: data.query,
    intent: data.intent || null,
    entities: data.entities || [],
    output: data.output,
    model: data.model || "",
    toolsUsed: data.toolsUsed || [],
    hitCount: 0,
    avgSavingsTokens: 0,
    ttlSeconds: ttl,
    expiresAt,
    createdAt: now(),
    updatedAt: now(),
  });
  return { id };
}

export async function pruneQubikCache(userId?: string) {
  const current = now();
  if (userId) {
    await getPool().query("DELETE FROM qubik_cache WHERE user_id = $1 AND expires_at < $2", [userId, current]);
  } else {
    await getPool().query("DELETE FROM qubik_cache WHERE expires_at < $1", [current]);
  }
}

export async function recordQubikFeedback(data: {
  userId: string;
  queryHash: string;
  intent: string;
  complexity: number;
  predictedModel: string;
  actualModel: string;
  predictedTools?: string[];
  actualTools?: string[];
  predictedRounds?: number;
  actualRounds?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensSaved?: number;
  success?: boolean;
  shortCircuited?: boolean;
  durationMs?: number;
  qubikDurationMs?: number;
  layersActivated?: number;
  flashConfidence?: number;
  proVerdict?: string;
  escalationReason?: string;
  cascadeModels?: string[];
}) {
  const id = genId("qfb");
  await getDb().insert(qubikFeedback).values({
    id,
    userId: data.userId,
    queryHash: data.queryHash,
    intent: data.intent,
    complexity: data.complexity,
    predictedModel: data.predictedModel,
    actualModel: data.actualModel,
    predictedTools: data.predictedTools || [],
    actualTools: data.actualTools || [],
    predictedRounds: data.predictedRounds || 1,
    actualRounds: data.actualRounds || 1,
    tokensInput: data.tokensInput || 0,
    tokensOutput: data.tokensOutput || 0,
    tokensSaved: data.tokensSaved || 0,
    success: data.success !== false,
    shortCircuited: data.shortCircuited || false,
    durationMs: data.durationMs || 0,
    qubikDurationMs: data.qubikDurationMs || 0,
    layersActivated: data.layersActivated || 1,
    flashConfidence: data.flashConfidence ?? null,
    proVerdict: data.proVerdict ?? null,
    escalationReason: data.escalationReason ?? null,
    cascadeModels: data.cascadeModels || [],
    createdAt: now(),
  });
  return { id };
}

export async function getQubikFeedbackStats(userId: string, intent?: string) {
  const pool = getPool();
  if (intent) {
    const result = await pool.query(`
      SELECT intent,
        COUNT(*) as total,
        AVG(tokens_saved) as avg_tokens_saved,
        AVG(CASE WHEN predicted_model = actual_model THEN 1 ELSE 0 END) as model_accuracy,
        SUM(CASE WHEN short_circuited THEN 1 ELSE 0 END) as short_circuit_count,
        AVG(duration_ms) as avg_duration_ms
      FROM qubik_feedback
      WHERE user_id = $1 AND intent = $2
      GROUP BY intent
    `, [userId, intent]);
    return result.rows[0] ?? null;
  }

  const result = await pool.query(`
    SELECT intent,
      COUNT(*) as total,
      AVG(tokens_saved) as avg_tokens_saved,
      AVG(CASE WHEN predicted_model = actual_model THEN 1 ELSE 0 END) as model_accuracy,
      SUM(CASE WHEN short_circuited THEN 1 ELSE 0 END) as short_circuit_count,
      AVG(duration_ms) as avg_duration_ms
    FROM qubik_feedback
    WHERE user_id = $1
    GROUP BY intent
    ORDER BY total DESC
    LIMIT 20
  `, [userId]);
  return result.rows;
}

export async function getQubikFeedbackForIntent(userId: string, intent: string, limit = 5) {
  const result = await getPool().query(`
    SELECT actual_model, actual_tools, actual_rounds, tokens_input, tokens_output, success
    FROM qubik_feedback
    WHERE user_id = $1 AND intent = $2
    ORDER BY created_at DESC
    LIMIT $3
  `, [userId, intent, limit]);
  return result.rows;
}
