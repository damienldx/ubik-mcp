import { describe, it, expect, beforeAll, afterAll } from "vitest";

const describeDb = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

// Use a test PostgreSQL database — set DATABASE_URL before importing
// Falls back to default if not set
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://ubik:ubik_dev@localhost:5432/ubik_test";
}

// Now import the modules
import { getDb, closeDb, ensureTables } from "./connection";
import {
  createDag, getDag, addDagNode, updateNodeStatus,
  getSharedContext, commitNodeOutput, setSharedGlobal,
  publishEvent, getEventsForNode,
  createAgentPlan, listAgentPlans, getAgentPlan, updateAgentPlan, deleteAgentPlan,
  createAgentPhase, listAgentPhases, updateAgentPhase,
  createAgentTask, getAgentTask, listAgentTasks, updateAgentTask, deleteAgentTask,
  createRoutine, listRoutines, getRoutine, listRoutineLogs, addRoutineLog,
} from "./state-manager";

const USER_A = "user-alice-test";
const USER_B = "user-bob-test";

beforeAll(async () => {
  getDb();
  await ensureTables();
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════
// 1. DAG Isolation
// ═══════════════════════════════════════

describeDb("DAG isolation", () => {
  let dagIdA: string;

  beforeAll(async () => {
    dagIdA = await createDag(USER_A, "/workspace/a");
  });

  it("User A can access their own DAG", async () => {
    const dag = await getDag(USER_A, dagIdA);
    expect(dag).not.toBeNull();
    expect(dag!.id).toBe(dagIdA);
    expect(dag!.userId).toBe(USER_A);
  });

  it("User B cannot access User A's DAG", async () => {
    const dag = await getDag(USER_B, dagIdA);
    expect(dag).toBeNull();
  });

  it("User A can add a node to their DAG", async () => {
    const nodeId = await addDagNode(USER_A, dagIdA, "Build feature X");
    expect(nodeId).toBeTruthy();
  });

  it("User B cannot add nodes to User A's DAG", async () => {
    await expect(addDagNode(USER_B, dagIdA, "Hack into DAG")).rejects.toThrow(/access denied/i);
  });

  it("User B cannot update node status on User A's DAG", async () => {
    const nodeId = await addDagNode(USER_A, dagIdA, "Another task");
    await expect(updateNodeStatus(USER_B, dagIdA, nodeId, "running")).rejects.toThrow(/access denied/i);
  });

  it("User A can read their shared context", async () => {
    const ctx = await getSharedContext(USER_A, dagIdA);
    expect(ctx).not.toBeNull();
    expect(ctx!.dagId).toBe(dagIdA);
  });

  it("User B cannot read User A's shared context", async () => {
    await expect(getSharedContext(USER_B, dagIdA)).rejects.toThrow(/access denied/i);
  });

  it("User B cannot commit output to User A's DAG", async () => {
    await expect(commitNodeOutput(USER_B, dagIdA, {
      nodeId: "fake-node",
      summary: "hacked",
      artifacts: [],
      filesCreated: [],
      filesModified: [],
      decisions: [],
    })).rejects.toThrow(/access denied/i);
  });

  it("User B cannot set shared globals on User A's DAG", async () => {
    await expect(setSharedGlobal(USER_B, dagIdA, "key", "value")).rejects.toThrow(/access denied/i);
  });

  it("User A can publish events to their DAG", async () => {
    const eventId = await publishEvent(USER_A, dagIdA, "node-1", "REQUEST", "test payload");
    expect(eventId).toBeTruthy();
  });

  it("User B cannot publish events to User A's DAG", async () => {
    await expect(publishEvent(USER_B, dagIdA, "node-1", "REQUEST", "hack payload")).rejects.toThrow(/access denied/i);
  });

  it("User B cannot read events from User A's DAG", async () => {
    await expect(getEventsForNode(USER_B, dagIdA, "node-1")).rejects.toThrow(/access denied/i);
  });

  it("User A can read events from their own DAG", async () => {
    const events = await getEventsForNode(USER_A, dagIdA, "node-1");
    expect(Array.isArray(events)).toBe(true);
  });
});

// ═══════════════════════════════════════
// 2. Agent Plan Isolation
// ═══════════════════════════════════════

describeDb("Agent plan isolation", () => {
  let planIdA: string;
  let phaseIdA: string;
  let taskIdA: string;

  beforeAll(async () => {
    planIdA = await createAgentPlan(USER_A, {
      title: "Alice's plan",
      description: "Secret plan",
      createdBy: "alice-agent",
    });
    phaseIdA = await createAgentPhase(USER_A, {
      planId: planIdA,
      title: "Phase 1",
      orderIndex: 0,
    });
    taskIdA = await createAgentTask(USER_A, {
      phaseId: phaseIdA,
      title: "Task 1",
      prompt: "Do something",
      orderIndex: 0,
      createdBy: "alice-agent",
    });
  });

  // ─── Plans ───

  it("User A can list their own plans", async () => {
    const plans = await listAgentPlans(USER_A);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans.some(p => p.id === planIdA)).toBe(true);
  });

  it("User B cannot see User A's plans", async () => {
    const plans = await listAgentPlans(USER_B);
    expect(plans.some(p => p.id === planIdA)).toBe(false);
  });

  it("User A can get their own plan", async () => {
    const plan = await getAgentPlan(USER_A, planIdA);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("Alice's plan");
  });

  it("User B cannot get User A's plan", async () => {
    const plan = await getAgentPlan(USER_B, planIdA);
    expect(plan).toBeNull();
  });

  it("User A can update their own plan", async () => {
    await updateAgentPlan(USER_A, planIdA, { status: "running" });
    const plan = await getAgentPlan(USER_A, planIdA);
    expect(plan!.status).toBe("running");
  });

  it("User B's update on User A's plan has no effect", async () => {
    await updateAgentPlan(USER_B, planIdA, { status: "error" });
    const plan = await getAgentPlan(USER_A, planIdA);
    expect(plan!.status).toBe("running"); // unchanged
  });

  // ─── Phases ───

  it("User A can list their plan's phases", async () => {
    const phases = await listAgentPhases(USER_A, planIdA);
    expect(phases.length).toBeGreaterThanOrEqual(1);
  });

  it("User B cannot list User A's plan phases", async () => {
    await expect(listAgentPhases(USER_B, planIdA)).rejects.toThrow(/access denied/i);
  });

  it("User B cannot create a phase in User A's plan", async () => {
    await expect(createAgentPhase(USER_B, {
      planId: planIdA,
      title: "Hacked phase",
      orderIndex: 99,
    })).rejects.toThrow(/access denied/i);
  });

  it("User B cannot update User A's phase", async () => {
    await expect(updateAgentPhase(USER_B, phaseIdA, { status: "running" })).rejects.toThrow(/access denied/i);
  });

  // ─── Tasks ───

  it("User A can get their own task", async () => {
    const task = await getAgentTask(USER_A, taskIdA);
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Task 1");
  });

  it("User B cannot get User A's task", async () => {
    const task = await getAgentTask(USER_B, taskIdA);
    expect(task).toBeNull();
  });

  it("User A can list tasks in their phase", async () => {
    const tasks = await listAgentTasks(USER_A, phaseIdA);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("User B cannot list tasks in User A's phase", async () => {
    await expect(listAgentTasks(USER_B, phaseIdA)).rejects.toThrow(/access denied/i);
  });

  it("User B cannot update User A's task", async () => {
    await expect(updateAgentTask(USER_B, taskIdA, { status: "running" })).rejects.toThrow(/access denied/i);
  });

  it("User B cannot delete User A's task", async () => {
    await expect(deleteAgentTask(USER_B, taskIdA)).rejects.toThrow(/access denied/i);
  });

  it("User A can update their own task", async () => {
    await updateAgentTask(USER_A, taskIdA, { status: "approved" });
    const task = await getAgentTask(USER_A, taskIdA);
    expect(task!.status).toBe("approved");
  });

  it("User B's listAgentTasks without phaseId returns empty", async () => {
    const tasks = await listAgentTasks(USER_B);
    expect(tasks.some(t => t.id === taskIdA)).toBe(false);
  });
});

// ═══════════════════════════════════════
// 3. Routine Log Isolation
// ═══════════════════════════════════════

describeDb("Routine log isolation", () => {
  let routineIdA: string;

  beforeAll(async () => {
    const result = await createRoutine(USER_A, {
      name: "Alice's routine",
      systemPrompt: "Check emails",
      service: "gmail",
    });
    routineIdA = result.id;

    // Add some logs (addRoutineLog is daemon-level, no userId)
    await addRoutineLog({
      routineId: routineIdA,
      tickNumber: 1,
      status: "ok",
      inputSummary: "checked inbox",
    });
    await addRoutineLog({
      routineId: routineIdA,
      tickNumber: 2,
      status: "ok",
      inputSummary: "no new emails",
    });
  });

  it("User A can list their routines", async () => {
    const list = await listRoutines(USER_A);
    expect(list.some(r => r.id === routineIdA)).toBe(true);
  });

  it("User B cannot see User A's routines", async () => {
    const list = await listRoutines(USER_B);
    expect(list.some(r => r.id === routineIdA)).toBe(false);
  });

  it("User A can get their routine", async () => {
    const routine = await getRoutine(USER_A, routineIdA);
    expect(routine).not.toBeNull();
    expect(routine!.name).toBe("Alice's routine");
  });

  it("User B cannot get User A's routine", async () => {
    const routine = await getRoutine(USER_B, routineIdA);
    expect(routine).toBeNull();
  });

  it("User A can read their routine's logs", async () => {
    const logs = await listRoutineLogs(USER_A, routineIdA);
    expect(logs.length).toBe(2);
  });

  it("User B cannot read User A's routine logs", async () => {
    await expect(listRoutineLogs(USER_B, routineIdA)).rejects.toThrow(/access denied/i);
  });
});

// ═══════════════════════════════════════
// 4. Cross-user operations — complete isolation
// ═══════════════════════════════════════

describeDb("Cross-user operations throw errors", () => {
  let dagIdA: string;
  let nodeIdA: string;
  let planIdA: string;
  let phaseIdA: string;
  let taskIdA: string;

  beforeAll(async () => {
    dagIdA = await createDag(USER_A);
    nodeIdA = await addDagNode(USER_A, dagIdA, "User A node");

    planIdA = await createAgentPlan(USER_A, {
      title: "Cross-test plan",
      createdBy: "alice",
    });
    phaseIdA = await createAgentPhase(USER_A, {
      planId: planIdA,
      title: "Cross-test phase",
      orderIndex: 0,
    });
    taskIdA = await createAgentTask(USER_A, {
      phaseId: phaseIdA,
      title: "Cross-test task",
      prompt: "Do it",
      orderIndex: 0,
      createdBy: "alice",
    });
  });

  // DAG operations
  it("addDagNode throws for wrong user", async () => {
    await expect(addDagNode(USER_B, dagIdA, "hack")).rejects.toThrow();
  });

  it("updateNodeStatus throws for wrong user", async () => {
    await expect(updateNodeStatus(USER_B, dagIdA, nodeIdA, "failed")).rejects.toThrow();
  });

  it("getSharedContext throws for wrong user", async () => {
    await expect(getSharedContext(USER_B, dagIdA)).rejects.toThrow();
  });

  it("commitNodeOutput throws for wrong user", async () => {
    await expect(commitNodeOutput(USER_B, dagIdA, {
      nodeId: nodeIdA,
      summary: "hack",
      artifacts: [],
      filesCreated: [],
      filesModified: [],
      decisions: [],
    })).rejects.toThrow();
  });

  it("setSharedGlobal throws for wrong user", async () => {
    await expect(setSharedGlobal(USER_B, dagIdA, "k", "v")).rejects.toThrow();
  });

  it("publishEvent throws for wrong user", async () => {
    await expect(publishEvent(USER_B, dagIdA, "n1", "REQUEST", "p")).rejects.toThrow();
  });

  it("getEventsForNode throws for wrong user", async () => {
    await expect(getEventsForNode(USER_B, dagIdA, "n1")).rejects.toThrow();
  });

  // Agent plan operations
  it("createAgentPhase throws for wrong user", async () => {
    await expect(createAgentPhase(USER_B, {
      planId: planIdA, title: "hack", orderIndex: 0,
    })).rejects.toThrow();
  });

  it("listAgentPhases throws for wrong user", async () => {
    await expect(listAgentPhases(USER_B, planIdA)).rejects.toThrow();
  });

  it("updateAgentPhase throws for wrong user", async () => {
    await expect(updateAgentPhase(USER_B, phaseIdA, { status: "error" })).rejects.toThrow();
  });

  it("createAgentTask throws for wrong user (via phase ownership)", async () => {
    await expect(createAgentTask(USER_B, {
      phaseId: phaseIdA, title: "hack", prompt: "hack", orderIndex: 0, createdBy: "bob",
    })).rejects.toThrow();
  });

  it("updateAgentTask throws for wrong user", async () => {
    await expect(updateAgentTask(USER_B, taskIdA, { status: "error" })).rejects.toThrow();
  });

  it("deleteAgentTask throws for wrong user", async () => {
    await expect(deleteAgentTask(USER_B, taskIdA)).rejects.toThrow();
  });

  it("listAgentTasks throws for wrong user's phase", async () => {
    await expect(listAgentTasks(USER_B, phaseIdA)).rejects.toThrow();
  });

  // Routine operations
  it("listRoutineLogs throws for wrong user", async () => {
    const result = await createRoutine(USER_A, {
      name: "cross-routine",
      systemPrompt: "test",
      service: "test",
    });
    await expect(listRoutineLogs(USER_B, result.id)).rejects.toThrow();
  });
});

// ═══════════════════════════════════════
// 5. Users can manage their own resources independently
// ═══════════════════════════════════════

describeDb("Independent user resources", () => {
  it("Both users can create and manage separate DAGs", async () => {
    const dagA = await createDag(USER_A);
    const dagB = await createDag(USER_B);

    expect(dagA).not.toBe(dagB);

    // Each user can access their own
    expect(await getDag(USER_A, dagA)).not.toBeNull();
    expect(await getDag(USER_B, dagB)).not.toBeNull();

    // Neither can access the other's
    expect(await getDag(USER_A, dagB)).toBeNull();
    expect(await getDag(USER_B, dagA)).toBeNull();
  });

  it("Both users can create and manage separate agent plans", async () => {
    const planA = await createAgentPlan(USER_A, { title: "Plan A", createdBy: "a" });
    const planB = await createAgentPlan(USER_B, { title: "Plan B", createdBy: "b" });

    expect(planA).not.toBe(planB);

    const plansA = await listAgentPlans(USER_A);
    const plansB = await listAgentPlans(USER_B);

    expect(plansA.some(p => p.id === planA)).toBe(true);
    expect(plansA.some(p => p.id === planB)).toBe(false);
    expect(plansB.some(p => p.id === planB)).toBe(true);
    expect(plansB.some(p => p.id === planA)).toBe(false);
  });

  it("Both users can create separate routines", async () => {
    const rA = await createRoutine(USER_A, { name: "R-A", systemPrompt: "a", service: "a" });
    const rB = await createRoutine(USER_B, { name: "R-B", systemPrompt: "b", service: "b" });

    const listA = await listRoutines(USER_A);
    const listB = await listRoutines(USER_B);

    expect(listA.some(r => r.id === rA.id)).toBe(true);
    expect(listA.some(r => r.id === rB.id)).toBe(false);
    expect(listB.some(r => r.id === rB.id)).toBe(true);
    expect(listB.some(r => r.id === rA.id)).toBe(false);
  });
});
