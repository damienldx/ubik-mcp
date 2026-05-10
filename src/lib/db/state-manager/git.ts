import { and, desc, eq, genId, getDb, gitProjects, gitTasks, now } from "./shared";

export type GitTaskStatus = "assigned" | "coding" | "committed" | "reviewing" | "approved" | "rejected" | "merged" | "failed";

export async function createGitProject(userId: string, data: {
  name: string;
  path: string;
  description?: string;
  defaultBranch?: string;
}) {
  const db = getDb();
  const id = genId("gproj");
  const timestamp = now();
  await db.insert(gitProjects).values({
    id,
    userId,
    name: data.name,
    path: data.path,
    description: data.description || "",
    defaultBranch: data.defaultBranch || "main",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  console.log(`\x1b[33m[Git]\x1b[0m Project ${id} created — ${data.name}`);
  return { id };
}

export async function listGitProjects(userId: string) {
  return getDb().select().from(gitProjects).where(eq(gitProjects.userId, userId)).orderBy(desc(gitProjects.createdAt));
}

export async function getGitProject(userId: string, projectId: string) {
  const [row] = await getDb().select().from(gitProjects)
    .where(and(eq(gitProjects.id, projectId), eq(gitProjects.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function updateGitProject(userId: string, projectId: string, updates: Partial<{
  name: string;
  path: string;
  description: string;
  defaultBranch: string;
}>) {
  await getDb().update(gitProjects).set({ ...updates, updatedAt: now() } as any)
    .where(and(eq(gitProjects.id, projectId), eq(gitProjects.userId, userId)));
}

export async function deleteGitProject(userId: string, projectId: string) {
  const db = getDb();
  await db.delete(gitTasks).where(and(eq(gitTasks.projectId, projectId), eq(gitTasks.userId, userId)));
  await db.delete(gitProjects).where(and(eq(gitProjects.id, projectId), eq(gitProjects.userId, userId)));
  console.log(`\x1b[33m[Git]\x1b[0m Project ${projectId} deleted`);
}

export async function createGitTask(userId: string, params: {
  projectPath: string;
  description: string;
  branch: string;
  assignee: string;
  assigneeSessionId?: string;
  reviewer: string;
  reviewerSessionId?: string;
  projectId?: string;
  targetProvider?: string;
  targetDriveId?: string;
  targetType?: string;
  targetName?: string;
}) {
  const db = getDb();
  const id = genId("gtask");
  await db.insert(gitTasks).values({
    id,
    userId,
    projectId: params.projectId,
    projectPath: params.projectPath,
    description: params.description,
    branch: params.branch,
    assignee: params.assignee,
    assigneeSessionId: params.assigneeSessionId,
    reviewer: params.reviewer,
    reviewerSessionId: params.reviewerSessionId,
    status: "assigned",
    targetProvider: params.targetProvider,
    targetDriveId: params.targetDriveId,
    targetType: params.targetType,
    targetName: params.targetName,
    createdAt: now(),
    updatedAt: now(),
  });
  console.log(`\x1b[33m[Git]\x1b[0m Task ${id} created — ${params.assignee} → ${params.branch}`);
  return id;
}

export async function getGitTask(userId: string, id: string) {
  const [row] = await getDb().select().from(gitTasks).where(and(eq(gitTasks.id, id), eq(gitTasks.userId, userId))).limit(1);
  return row ?? null;
}

export async function listGitTasks(userId: string, status?: GitTaskStatus) {
  const db = getDb();
  if (status) return db.select().from(gitTasks).where(and(eq(gitTasks.status, status), eq(gitTasks.userId, userId))).orderBy(desc(gitTasks.createdAt));
  return db.select().from(gitTasks).where(eq(gitTasks.userId, userId)).orderBy(desc(gitTasks.createdAt));
}

export async function listGitTasksByProject(userId: string, projectId: string) {
  return getDb().select().from(gitTasks)
    .where(and(eq(gitTasks.projectId, projectId), eq(gitTasks.userId, userId)))
    .orderBy(desc(gitTasks.createdAt));
}

export async function updateGitTask(userId: string, id: string, updates: Partial<{
  status: GitTaskStatus;
  assigneeSessionId: string;
  reviewerSessionId: string;
  commitHash: string;
  reviewFeedback: string;
  diffSummary: string;
  targetProvider: string;
  targetDriveId: string;
  targetType: string;
  targetName: string;
}>) {
  await getDb().update(gitTasks).set({ ...updates, updatedAt: now() } as any).where(and(eq(gitTasks.id, id), eq(gitTasks.userId, userId)));
}

export async function deleteGitTask(userId: string, id: string) {
  await getDb().delete(gitTasks).where(and(eq(gitTasks.id, id), eq(gitTasks.userId, userId)));
}
