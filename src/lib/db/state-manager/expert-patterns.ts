import {
  and,
  desc,
  eq,
  ExpertDocumentRef,
  expertEmbeddings,
  expertPatterns,
  genId,
  getDb,
  getPool,
  now,
  sql,
} from "./shared";

export async function createExpertPattern(userId: string, params: {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt: string;
  documents?: ExpertDocumentRef[];
}) {
  const db = getDb();
  const id = genId("expert");
  await db.insert(expertPatterns).values({
    id,
    userId,
    name: params.name,
    description: params.description || "",
    icon: params.icon || "Briefcase",
    color: params.color || "text-cyan-400",
    systemPrompt: params.systemPrompt,
    documents: params.documents || [],
    isBuiltin: false,
  });
  return id;
}

export async function listExpertPatterns(userId: string) {
  return getDb().select().from(expertPatterns).where(eq(expertPatterns.userId, userId)).orderBy(desc(expertPatterns.updatedAt));
}

export async function getExpertPattern(userId: string, id: string) {
  const [row] = await getDb().select().from(expertPatterns).where(and(eq(expertPatterns.id, id), eq(expertPatterns.userId, userId))).limit(1);
  return row ?? null;
}

export async function updateExpertPattern(userId: string, id: string, updates: {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  systemPrompt?: string;
  documents?: ExpertDocumentRef[];
}) {
  const db = getDb();
  const [existing] = await db.select().from(expertPatterns).where(and(eq(expertPatterns.id, id), eq(expertPatterns.userId, userId))).limit(1);
  if (!existing) return null;
  await db.update(expertPatterns).set({ ...updates, updatedAt: now() }).where(eq(expertPatterns.id, id));
  return id;
}

export async function deleteExpertPattern(userId: string, id: string) {
  const db = getDb();
  const [existing] = await db.select().from(expertPatterns)
    .where(and(eq(expertPatterns.id, id), eq(expertPatterns.userId, userId), eq(expertPatterns.isBuiltin, false)))
    .limit(1);
  if (!existing) return false;
  await db.delete(expertPatterns).where(eq(expertPatterns.id, id));
  await db.delete(expertEmbeddings).where(eq(expertEmbeddings.patternId, id));
  return true;
}

function chunkText(text: string, maxWords = 400): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const chunk = words.slice(i, i + maxWords).join(" ");
    if (chunk.trim()) chunks.push(chunk.trim());
  }
  return chunks;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

export async function indexExpertDocument(patternId: string, docName: string, content: string) {
  const pool = getPool();
  const chunks = chunkText(content);
  await pool.query(`DELETE FROM expert_embeddings WHERE pattern_id = $1 AND doc_name = $2`, [patternId, docName]);
  for (let i = 0; i < chunks.length; i++) {
    const id = genId("emb");
    const embedding = await generateEmbedding(chunks[i]);
    const vectorStr = `[${embedding.join(",")}]`;
    await pool.query(
      `INSERT INTO expert_embeddings (id, pattern_id, doc_name, chunk_index, chunk_text, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)`,
      [id, patternId, docName, i, chunks[i], vectorStr, new Date().toISOString()],
    );
  }
  return chunks.length;
}

export async function searchExpertDocs(patternId: string, query: string, limit = 5): Promise<{ docName: string; chunkText: string; similarity: number }[]> {
  const pool = getPool();
  const queryEmbedding = await generateEmbedding(query);
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const result = await pool.query(
    `SELECT doc_name, chunk_text, 1 - (embedding <=> $1::vector) AS similarity
     FROM expert_embeddings
     WHERE pattern_id = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, patternId, limit],
  );
  return result.rows.map((row: { doc_name: string; chunk_text: string; similarity: number }) => ({
    docName: row.doc_name,
    chunkText: row.chunk_text,
    similarity: row.similarity,
  }));
}

export async function hasExpertEmbeddings(patternId: string): Promise<boolean> {
  const [row] = await getDb().select({ count: sql<number>`count(*)` }).from(expertEmbeddings).where(eq(expertEmbeddings.patternId, patternId)).limit(1);
  return (row?.count ?? 0) > 0;
}
