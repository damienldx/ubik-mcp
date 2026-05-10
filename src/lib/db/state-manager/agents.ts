import {
  agentJournal,
  agentPhases,
  agentPlans,
  agentSessions,
  agentState,
  agentTasks,
  and,
  desc,
  eq,
  genId,
  getDb,
  getPool,
  now,
  or,
} from "./shared";

export type AgentPlanStatus = "pending" | "running" | "paused" | "done" | "error";
export type AgentPhaseStatus = "pending" | "running" | "done" | "error";
export type AgentTaskStatus = "pending" | "approved" | "running" | "done" | "error" | "skipped";

export async function createAgentPlan(userId: string, params: { title: string; description?: string; createdBy: string }) {
  const db = getDb();
  const id = genId("plan");
  await db.insert(agentPlans).values({
    id,
    userId,
    title: params.title,
    description: params.description || "",
    status: "pending",
    createdBy: params.createdBy,
    createdAt: now(),
    updatedAt: now(),
  });
  console.log(`\x1b[36m[Agent]\x1b[0m Plan ${id} created — "${params.title}"`);
  return id;
}

export async function getAgentPlan(userId: string, id: string) {
  const [row] = await getDb().select().from(agentPlans).where(and(eq(agentPlans.id, id), eq(agentPlans.userId, userId))).limit(1);
  return row ?? null;
}

export async function listAgentPlans(userId: string, status?: AgentPlanStatus) {
  const db = getDb();
  if (status) return db.select().from(agentPlans).where(and(eq(agentPlans.status, status), eq(agentPlans.userId, userId))).orderBy(desc(agentPlans.createdAt));
  return db.select().from(agentPlans).where(eq(agentPlans.userId, userId)).orderBy(desc(agentPlans.createdAt));
}

export async function updateAgentPlan(userId: string, id: string, updates: Partial<{ status: AgentPlanStatus; title: string; description: string }>) {
  await getDb().update(agentPlans).set({ ...updates, updatedAt: now() } as any).where(and(eq(agentPlans.id, id), eq(agentPlans.userId, userId)));
}

export async function deleteAgentPlan(userId: string, id: string) {
  await getDb().delete(agentPlans).where(and(eq(agentPlans.id, id), eq(agentPlans.userId, userId)));
}

export async function createAgentPhase(userId: string, params: { planId: string; title: string; orderIndex: number }) {
  const db = getDb();
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, params.planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) throw new Error("Plan not found or access denied");
  const id = genId("phase");
  await db.insert(agentPhases).values({
    id,
    planId: params.planId,
    title: params.title,
    orderIndex: params.orderIndex,
    status: "pending",
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

export async function listAgentPhases(userId: string, planId: string) {
  const db = getDb();
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) throw new Error("Plan not found or access denied");
  return db.select().from(agentPhases).where(eq(agentPhases.planId, planId)).orderBy(agentPhases.orderIndex);
}

export async function updateAgentPhase(userId: string, id: string, updates: Partial<{ status: AgentPhaseStatus }>) {
  const db = getDb();
  const [phase] = await db.select().from(agentPhases).where(eq(agentPhases.id, id)).limit(1);
  if (!phase) throw new Error("Phase not found");
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, phase.planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) throw new Error("Plan not found or access denied");
  await db.update(agentPhases).set({ ...updates, updatedAt: now() } as any).where(eq(agentPhases.id, id));
}

export async function createAgentTask(userId: string, params: {
  phaseId: string;
  title: string;
  prompt: string;
  orderIndex: number;
  skillId?: string;
  skillDomain?: string;
  skillName?: string;
  suggestedModel?: string;
  temperature?: string;
  createdBy: string;
}) {
  const db = getDb();
  const [phase] = await db.select().from(agentPhases).where(eq(agentPhases.id, params.phaseId)).limit(1);
  if (!phase) throw new Error("Phase not found");
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, phase.planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) throw new Error("Plan not found or access denied");
  const id = genId("task");
  await db.insert(agentTasks).values({
    id,
    phaseId: params.phaseId,
    title: params.title,
    prompt: params.prompt,
    orderIndex: params.orderIndex,
    skillId: params.skillId,
    skillDomain: params.skillDomain,
    skillName: params.skillName,
    suggestedModel: params.suggestedModel,
    temperature: params.temperature,
    status: "pending",
    createdBy: params.createdBy,
    createdAt: now(),
    updatedAt: now(),
  });
  console.log(`\x1b[36m[Agent]\x1b[0m Task ${id} — "${params.title}"`);
  return id;
}

export async function getAgentTask(userId: string, id: string) {
  const db = getDb();
  const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
  if (!task) return null;
  const [phase] = await db.select().from(agentPhases).where(eq(agentPhases.id, task.phaseId)).limit(1);
  if (!phase) return null;
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, phase.planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) return null;
  return task;
}

export async function listAgentTasks(userId: string, phaseId?: string, status?: AgentTaskStatus) {
  const db = getDb();
  if (phaseId) {
    const [phase] = await db.select().from(agentPhases).where(eq(agentPhases.id, phaseId)).limit(1);
    if (!phase) throw new Error("Phase not found");
    const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, phase.planId), eq(agentPlans.userId, userId))).limit(1);
    if (!plan) throw new Error("Plan not found or access denied");
  }

  const conditions = [];
  if (phaseId) conditions.push(eq(agentTasks.phaseId, phaseId));
  if (status) conditions.push(eq(agentTasks.status, status));
  if (conditions.length > 0) return db.select().from(agentTasks).where(and(...conditions)).orderBy(agentTasks.orderIndex);

  const userPlans = await db.select().from(agentPlans).where(eq(agentPlans.userId, userId));
  if (userPlans.length === 0) return [];
  const userPhases = await db.select().from(agentPhases).where(or(...userPlans.map((plan) => eq(agentPhases.planId, plan.id))));
  if (userPhases.length === 0) return [];
  const phaseConditions = userPhases.map((phase) => eq(agentTasks.phaseId, phase.id));
  const whereClause = status ? and(or(...phaseConditions), eq(agentTasks.status, status)) : or(...phaseConditions);
  return db.select().from(agentTasks).where(whereClause).orderBy(desc(agentTasks.createdAt));
}

export async function updateAgentTask(userId: string, id: string, updates: Partial<{
  status: AgentTaskStatus;
  model: string;
  temperature: string;
  result: string;
  error: string;
  approvedAt: string;
  startedAt: string;
  completedAt: string;
}>) {
  const db = getDb();
  const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
  if (!task) throw new Error("Task not found");
  const [phase] = await db.select().from(agentPhases).where(eq(agentPhases.id, task.phaseId)).limit(1);
  if (!phase) throw new Error("Phase not found");
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, phase.planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) throw new Error("Plan not found or access denied");
  await db.update(agentTasks).set({ ...updates, updatedAt: now() } as any).where(eq(agentTasks.id, id));
}

export async function deleteAgentTask(userId: string, id: string) {
  const db = getDb();
  const [task] = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
  if (!task) throw new Error("Task not found");
  const [phase] = await db.select().from(agentPhases).where(eq(agentPhases.id, task.phaseId)).limit(1);
  if (!phase) throw new Error("Phase not found");
  const [plan] = await db.select().from(agentPlans).where(and(eq(agentPlans.id, phase.planId), eq(agentPlans.userId, userId))).limit(1);
  if (!plan) throw new Error("Plan not found or access denied");
  await db.delete(agentTasks).where(eq(agentTasks.id, id));
}

export async function createAgentSession(userId: string, agentId: string) {
  const id = genId("asess");
  await getDb().insert(agentSessions).values({ id, userId, agentId, status: "running", phaseReached: 0, startedAt: now() });
  return { id };
}

export async function getLatestAgentSession(userId: string, agentId: string) {
  const [row] = await getDb().select().from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.agentId, agentId)))
    .orderBy(desc(agentSessions.startedAt))
    .limit(1);
  return row ?? null;
}

export async function updateAgentSession(sessionId: string, userId: string, data: {
  status?: "running" | "done" | "error";
  phaseReached?: number;
  summary?: Record<string, unknown>;
  reportDriveId?: string;
  endedAt?: string;
}) {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (data.status !== undefined) { sets.push(`status = $${i++}`); vals.push(data.status); }
  if (data.phaseReached !== undefined) { sets.push(`phase_reached = $${i++}`); vals.push(data.phaseReached); }
  if (data.summary !== undefined) { sets.push(`summary = $${i++}`); vals.push(JSON.stringify(data.summary)); }
  if (data.reportDriveId !== undefined) { sets.push(`report_drive_id = $${i++}`); vals.push(data.reportDriveId); }
  if (data.endedAt !== undefined) { sets.push(`ended_at = $${i++}`); vals.push(data.endedAt); }
  if (sets.length === 0) return;
  vals.push(sessionId, userId);
  await pool.query(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = $${i++} AND user_id = $${i}`, vals);
}

export async function listAgentSessions(userId: string, agentId: string, limit = 10) {
  return getDb().select().from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.agentId, agentId)))
    .orderBy(desc(agentSessions.startedAt))
    .limit(limit);
}

export async function logAgentAction(userId: string, params: {
  sessionId: string;
  agentId: string;
  phase: number;
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  metrics?: Record<string, unknown>;
  notes?: string;
}) {
  const id = genId("ajrn");
  await getDb().insert(agentJournal).values({
    id,
    userId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    phase: params.phase,
    action: params.action,
    targetType: params.targetType || null,
    targetId: params.targetId || null,
    targetLabel: params.targetLabel || null,
    metrics: params.metrics || {},
    notes: params.notes || null,
    createdAt: now(),
  });
  return { id };
}

export async function getAgentJournal(userId: string, agentId: string, opts?: { sessionId?: string; limit?: number }) {
  const pool = getPool();
  if (opts?.sessionId) {
    const result = await pool.query(
      `SELECT * FROM agent_journal WHERE user_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [userId, opts.sessionId, opts.limit || 50],
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT * FROM agent_journal WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [userId, agentId, opts?.limit || 50],
  );
  return result.rows;
}

export async function getAgentState(userId: string, agentId: string, key: string) {
  const [row] = await getDb().select().from(agentState)
    .where(and(eq(agentState.userId, userId), eq(agentState.agentId, agentId), eq(agentState.key, key)))
    .limit(1);
  return row?.value ?? null;
}

export async function setAgentState(userId: string, agentId: string, key: string, value: unknown) {
  const pool = getPool();
  const id = genId("ast");
  await pool.query(`
    INSERT INTO agent_state (id, user_id, agent_id, key, value, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id, agent_id, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `, [id, userId, agentId, key, JSON.stringify(value), now()]);
}

export async function getAllAgentState(userId: string, agentId: string) {
  const rows = await getDb().select().from(agentState).where(and(eq(agentState.userId, userId), eq(agentState.agentId, agentId)));
  const result: Record<string, unknown> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}
