import {
  and,
  busEvents,
  dagNodes,
  dags,
  eq,
  genId,
  getDb,
  isNull,
  NodeOutputJSON,
  now,
  or,
  sharedContexts,
} from "./shared";

export async function createDag(userId: string, workspace?: string) {
  const db = getDb();
  const id = genId("dag");
  await db.insert(dags).values({ id, userId, status: "pending", workspace, createdAt: now(), updatedAt: now() });
  await db.insert(sharedContexts).values({ dagId: id, nodeOutputs: {}, globals: {}, updatedAt: now() });
  console.log(`\x1b[35m[Cerveau Collectif]\x1b[0m DAG ${id} created (user: ${userId})`);
  return id;
}

export async function getDag(userId: string, dagId: string) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) return null;
  const nodes = await db.select().from(dagNodes).where(eq(dagNodes.dagId, dagId));
  return { ...dag, nodes };
}

export async function updateDagStatus(
  userId: string,
  dagId: string,
  status: "pending" | "running" | "completed" | "failed",
) {
  const db = getDb();
  await db.update(dags).set({ status, updatedAt: now() }).where(and(eq(dags.id, dagId), eq(dags.userId, userId)));
}

export async function addDagNode(userId: string, dagId: string, taskDescription: string, dependencies: string[] = []) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  const id = genId("node");
  await db.insert(dagNodes).values({
    id,
    dagId,
    taskDescription,
    status: "pending",
    dependencies,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

export async function updateNodeStatus(
  userId: string,
  dagId: string,
  nodeId: string,
  status: "pending" | "running" | "completed" | "failed",
  result?: string,
  logs?: string,
) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  const updates: Record<string, unknown> = { status, updatedAt: now() };
  if (result !== undefined) updates.result = result;
  if (logs !== undefined) updates.logs = logs;
  await db.update(dagNodes).set(updates).where(and(eq(dagNodes.id, nodeId), eq(dagNodes.dagId, dagId)));
}

export async function getSharedContext(userId: string, dagId: string) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  const [ctx] = await db.select().from(sharedContexts).where(eq(sharedContexts.dagId, dagId)).limit(1);
  return ctx ?? null;
}

export async function commitNodeOutput(userId: string, dagId: string, output: NodeOutputJSON) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  const [ctx] = await db.select().from(sharedContexts).where(eq(sharedContexts.dagId, dagId)).limit(1);
  if (!ctx) throw new Error(`SharedContext introuvable pour DAG ${dagId}`);

  const outputs = { ...ctx.nodeOutputs, [output.nodeId]: output };
  await db.update(sharedContexts).set({ nodeOutputs: outputs, updatedAt: now() }).where(eq(sharedContexts.dagId, dagId));
  console.log(`\x1b[35m[Cerveau Collectif]\x1b[0m Output ${output.nodeId} committed`);
}

export async function setSharedGlobal(userId: string, dagId: string, key: string, value: string) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  const [ctx] = await db.select().from(sharedContexts).where(eq(sharedContexts.dagId, dagId)).limit(1);
  if (!ctx) return;
  const globals = { ...ctx.globals, [key]: value };
  await db.update(sharedContexts).set({ globals, updatedAt: now() }).where(eq(sharedContexts.dagId, dagId));
}

export async function getContextForNode(userId: string, dagId: string, nodeId: string): Promise<Record<string, NodeOutputJSON>> {
  const db = getDb();
  const [dagRow] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dagRow) return {};
  const nodes = await db.select().from(dagNodes).where(eq(dagNodes.dagId, dagId));
  const dag = { ...dagRow, nodes };
  const [ctx] = await db.select().from(sharedContexts).where(eq(sharedContexts.dagId, dagId)).limit(1);
  if (!ctx) return {};

  const resolved = new Set<string>();
  const resolve = (nid: string) => {
    const node = dag.nodes.find((entry) => entry.id === nid);
    if (!node) return;
    for (const dep of node.dependencies ?? []) {
      if (!resolved.has(dep)) {
        resolved.add(dep);
        resolve(dep);
      }
    }
  };
  resolve(nodeId);

  const relevantOutputs: Record<string, NodeOutputJSON> = {};
  for (const depId of resolved) {
    if (ctx.nodeOutputs[depId]) relevantOutputs[depId] = ctx.nodeOutputs[depId];
  }
  return relevantOutputs;
}

export async function publishEvent(
  userId: string,
  dagId: string,
  sourceNodeId: string,
  type: "REQUEST" | "ACKNOWLEDGE" | "CONFLICT" | "REVIEW" | "REJECTED" | "APPROVED",
  payload: string,
  targetNodeId?: string,
) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  const id = genId("evt");
  await db.insert(busEvents).values({
    id,
    dagId,
    sourceNodeId,
    targetNodeId,
    type,
    payload,
    processed: false,
    timestamp: now(),
  });
  console.log(`\x1b[35m[Event Bus]\x1b[0m ${type} from ${sourceNodeId} → ${targetNodeId || "broadcast"}`);
  return id;
}

export async function getEventsForNode(userId: string, dagId: string, nodeId: string) {
  const db = getDb();
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  return db.select().from(busEvents).where(
    and(
      eq(busEvents.dagId, dagId),
      or(eq(busEvents.targetNodeId, nodeId), isNull(busEvents.targetNodeId)),
      eq(busEvents.processed, false),
    ),
  );
}

export async function markEventProcessed(userId: string, eventId: string) {
  const db = getDb();
  const [event] = await db.select().from(busEvents).where(eq(busEvents.id, eventId)).limit(1);
  if (!event) throw new Error("Event not found");
  const [dag] = await db.select().from(dags).where(and(eq(dags.id, event.dagId), eq(dags.userId, userId))).limit(1);
  if (!dag) throw new Error("DAG not found or access denied");
  await db.update(busEvents).set({ processed: true }).where(eq(busEvents.id, eventId));
}
