import {
  and,
  desc,
  eq,
  genId,
  getDb,
  getPool,
  now,
  routineLogs,
  routines,
  webhookEvents,
} from "./shared";

export async function createRoutine(userId: string, data: {
  name: string;
  templateId?: string;
  systemPrompt: string;
  context?: string;
  model?: string;
  runtime?: string;
  daemonId?: string;
  intervalMs?: number;
  service: string;
  triggerType?: string;
  webhookToken?: string;
  webhookSecret?: string;
  deliverTo?: string;
  serverManaged?: boolean;
  enabled?: boolean;
  triggerEvent?: string;
  triggerConfig?: string;
}) {
  const db = getDb();
  const id = genId("routine");
  await db.insert(routines).values({
    id,
    userId,
    name: data.name,
    templateId: data.templateId || null,
    systemPrompt: data.systemPrompt,
    context: data.context || "",
    model: data.model || "gemini-2.5-flash",
    runtime: data.runtime || "api",
    daemonId: data.daemonId || null,
    intervalMs: data.intervalMs || 60000,
    service: data.service,
    triggerType: (data.triggerType as "timer" | "webhook" | "both") || "timer",
    webhookToken: data.webhookToken || null,
    webhookSecret: data.webhookSecret || null,
    deliverTo: data.deliverTo || null,
    serverManaged: data.serverManaged || false,
    triggerEvent: data.triggerEvent || null,
    triggerConfig: data.triggerConfig || "{}",
    enabled: data.enabled ?? false,
    createdAt: now(),
    updatedAt: now(),
  });
  return { id };
}

export async function listRoutines(userId: string) {
  return getDb().select().from(routines).where(eq(routines.userId, userId)).orderBy(desc(routines.createdAt));
}

export async function getRoutine(userId: string, routineId: string) {
  const [row] = await getDb().select().from(routines).where(and(eq(routines.id, routineId), eq(routines.userId, userId))).limit(1);
  return row ?? null;
}

export async function updateRoutine(userId: string, routineId: string, updates: Record<string, any>) {
  const allowed = ["name", "system_prompt", "context", "model", "runtime", "daemon_id", "interval_ms", "enabled", "last_tick_at", "last_cursor", "last_error", "total_ticks", "total_cost", "trigger_type", "webhook_token", "webhook_secret", "deliver_to", "server_managed", "trigger_event", "trigger_config"];
  const sets: string[] = [];
  const vals: any[] = [];
  let paramIdx = 1;
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = $${paramIdx}`);
      vals.push(value);
      paramIdx++;
    }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = $${paramIdx}`);
  vals.push(now());
  const idIdx = ++paramIdx;
  vals.push(routineId);
  const userIdx = ++paramIdx;
  vals.push(userId);
  await getPool().query(`UPDATE routines SET ${sets.join(", ")} WHERE id = $${idIdx} AND user_id = $${userIdx}`, vals);
}

export async function deleteRoutine(userId: string, routineId: string) {
  await getPool().query("DELETE FROM routine_logs WHERE routine_id = $1", [routineId]);
  await getDb().delete(routines).where(and(eq(routines.id, routineId), eq(routines.userId, userId)));
}

export async function listAllEnabledRoutines() {
  return getDb().select().from(routines).where(eq(routines.enabled, true));
}

export async function updateRoutineTick(routineId: string, updates: Record<string, any>) {
  const allowed = ["last_tick_at", "last_cursor", "last_error", "total_ticks", "total_cost", "enabled"];
  const sets: string[] = [];
  const vals: any[] = [];
  let paramIdx = 1;
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = $${paramIdx}`);
      vals.push(value);
      paramIdx++;
    }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = $${paramIdx}`);
  vals.push(now());
  const idIdx = ++paramIdx;
  vals.push(routineId);
  await getPool().query(`UPDATE routines SET ${sets.join(", ")} WHERE id = $${idIdx}`, vals);
}

export async function addRoutineLog(data: {
  routineId: string;
  tickNumber: number;
  status: string;
  inputSummary?: string;
  llmResponse?: string;
  actionsTaken?: string;
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
  durationMs?: number;
  error?: string;
}) {
  const db = getDb();
  const id = genId("rlog");
  await db.insert(routineLogs).values({
    id,
    routineId: data.routineId,
    tickNumber: data.tickNumber,
    status: data.status,
    inputSummary: data.inputSummary || null,
    llmResponse: data.llmResponse || null,
    actionsTaken: data.actionsTaken || null,
    tokensInput: data.tokensInput || 0,
    tokensOutput: data.tokensOutput || 0,
    cost: data.cost || 0,
    durationMs: data.durationMs || 0,
    error: data.error || null,
    createdAt: now(),
  });
  return { id };
}

export async function listRoutineLogs(userId: string, routineId: string, limit = 20, offset = 0) {
  const db = getDb();
  const [routine] = await db.select().from(routines).where(and(eq(routines.id, routineId), eq(routines.userId, userId))).limit(1);
  if (!routine) throw new Error("Routine not found or access denied");
  return db.select().from(routineLogs).where(eq(routineLogs.routineId, routineId)).orderBy(desc(routineLogs.createdAt)).limit(limit).offset(offset);
}

export async function addWebhookEvent(data: {
  routineId: string;
  token: string;
  source?: string;
  event?: string;
  status: string;
  signatureValid?: boolean | null;
  httpStatus?: number;
  payloadSize?: number;
  payloadPreview?: string;
  error?: string;
  durationMs?: number;
  retryCount?: number;
  ip?: string;
}) {
  const db = getDb();
  const id = genId("whe");
  await db.insert(webhookEvents).values({
    id,
    routineId: data.routineId,
    token: data.token,
    source: data.source || null,
    event: data.event || null,
    status: data.status,
    signatureValid: data.signatureValid ?? null,
    httpStatus: data.httpStatus || null,
    payloadSize: data.payloadSize || null,
    payloadPreview: data.payloadPreview || null,
    error: data.error || null,
    durationMs: data.durationMs || null,
    retryCount: data.retryCount || 0,
    ip: data.ip || null,
    createdAt: now(),
  });
  return { id };
}

export async function updateWebhookEvent(eventId: string, updates: Partial<{ status: string; error: string; durationMs: number; retryCount: number }>) {
  const pool = getPool();
  const sets: string[] = [];
  const vals: any[] = [];
  let paramIdx = 1;
  for (const [key, value] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    sets.push(`${col} = $${paramIdx}`);
    vals.push(value);
    paramIdx++;
  }
  if (sets.length === 0) return;
  vals.push(eventId);
  await pool.query(`UPDATE webhook_events SET ${sets.join(", ")} WHERE id = $${paramIdx}`, vals);
}

export async function listWebhookEvents(routineId: string, limit = 50, offset = 0) {
  const db = getDb();
  return db.select().from(webhookEvents).where(eq(webhookEvents.routineId, routineId)).orderBy(desc(webhookEvents.createdAt)).limit(limit).offset(offset);
}
