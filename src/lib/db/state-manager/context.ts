import {
  and,
  atoms,
  desc,
  eq,
  genId,
  getDb,
  globalContext,
  interactions,
  now,
  projects,
  tasks,
} from "./shared";

export async function createAtom(userId: string, params: {
  taskId?: string;
  type: "function" | "block" | "interface" | "intent" | "observation" | "variable" | "snippet" | "decision";
  source: string;
  content: string;
  summary?: string;
  tags?: string[];
}) {
  const db = getDb();
  const id = genId("atom");
  await db.insert(atoms).values({
    id,
    userId,
    taskId: params.taskId,
    type: params.type,
    source: params.source,
    content: params.content,
    summary: params.summary,
    tags: params.tags ?? [],
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

export async function getAtom(userId: string, id: string) {
  const [row] = await getDb().select().from(atoms).where(and(eq(atoms.id, id), eq(atoms.userId, userId))).limit(1);
  return row ?? null;
}

export async function getAtomsByTask(userId: string, taskId: string) {
  return getDb().select().from(atoms).where(and(eq(atoms.taskId, taskId), eq(atoms.userId, userId)));
}

export async function searchAtoms(userId: string, query: { type?: string; source?: string; tag?: string; limit?: number }) {
  const db = getDb();
  const conditions = [eq(atoms.userId, userId)];
  if (query.type) conditions.push(eq(atoms.type, query.type as any));
  if (query.source) conditions.push(eq(atoms.source, query.source));
  const where = and(...conditions);
  let q = db.select().from(atoms).$dynamic();
  if (where) q = q.where(where);
  q = q.orderBy(desc(atoms.createdAt));
  if (query.limit) q = q.limit(query.limit);
  return q;
}

export async function createTask(userId: string, params: { projectId?: string; dagId?: string; description: string }) {
  const db = getDb();
  const id = genId("task");
  await db.insert(tasks).values({
    id,
    userId,
    projectId: params.projectId,
    dagId: params.dagId,
    description: params.description,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

export async function getTask(userId: string, id: string) {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId))).limit(1);
  return row ?? null;
}

export async function listTasks(userId: string, projectId?: string) {
  const db = getDb();
  if (projectId) return db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.userId, userId)));
  return db.select().from(tasks).where(eq(tasks.userId, userId));
}

export async function updateTaskStatus(userId: string, id: string, status: "active" | "completed" | "archived") {
  await getDb().update(tasks).set({ status, updatedAt: now() }).where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
}

export async function createProject(userId: string, params: {
  name: string;
  description?: string;
  architecture?: string;
  conventions?: string[];
  rootPath?: string;
}) {
  const db = getDb();
  const id = genId("proj");
  await db.insert(projects).values({
    id,
    userId,
    name: params.name,
    description: params.description ?? "",
    architecture: params.architecture ?? "",
    conventions: params.conventions ?? [],
    rootPath: params.rootPath,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

export async function getProject(userId: string, id: string) {
  const [row] = await getDb().select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1);
  return row ?? null;
}

export async function listProjects(userId: string) {
  return getDb().select().from(projects).where(eq(projects.userId, userId));
}

export async function updateProject(userId: string, id: string, updates: Partial<{
  name: string;
  description: string;
  architecture: string;
  conventions: string[];
  dependencies: Record<string, string>;
}>) {
  await getDb().update(projects).set({ ...updates, updatedAt: now() } as any).where(and(eq(projects.id, id), eq(projects.userId, userId)));
}

export async function getGlobalContext(userId: string) {
  const db = getDb();
  const [ctx] = await db.select().from(globalContext).where(eq(globalContext.userId, userId)).limit(1);
  if (ctx) return ctx;
  const id = `ctx-${userId}`;
  await db.insert(globalContext).values({ id, userId, preferences: {}, longTermGoals: [], activeProjectIds: [], updatedAt: now() });
  const [newCtx] = await db.select().from(globalContext).where(eq(globalContext.userId, userId)).limit(1);
  return newCtx!;
}

export async function updateGlobalContext(userId: string, updates: Partial<{
  preferences: Record<string, string>;
  longTermGoals: string[];
  activeProjectIds: string[];
}>) {
  await getGlobalContext(userId);
  await getDb().update(globalContext).set({ ...updates, updatedAt: now() } as any).where(eq(globalContext.userId, userId));
}

export async function getActiveThreadId(userId: string): Promise<string | null> {
  const ctx = await getGlobalContext(userId);
  const prefs = (ctx.preferences as Record<string, string>) || {};
  return prefs.activeThreadId || null;
}

export async function setActiveThreadId(userId: string, threadId: string): Promise<void> {
  const ctx = await getGlobalContext(userId);
  const prefs = { ...((ctx.preferences as Record<string, string>) || {}), activeThreadId: threadId };
  await getDb().update(globalContext).set({ preferences: prefs, updatedAt: now() } as any).where(eq(globalContext.userId, userId));
}

export async function recordInteraction(userId: string, params: {
  type: "command" | "edit" | "chat" | "review" | "debug";
  summary: string;
  contextRefs?: string[];
}) {
  const db = getDb();
  const id = genId("int");
  await db.insert(interactions).values({
    id,
    userId,
    type: params.type,
    summary: params.summary,
    contextRefs: params.contextRefs ?? [],
    timestamp: now(),
  });
  return id;
}

export async function getRecentInteractions(userId: string, limit = 50) {
  const db = getDb();
  return db.select().from(interactions).where(eq(interactions.userId, userId)).orderBy(interactions.timestamp).limit(limit);
}
