#!/usr/bin/env node
/**
 * ubik-desktop MCP server — standalone, no UBIK-DESKTOP dependency.
 *
 * Two backends only:
 *   UBIK_URL   (default http://127.0.0.1:8765) — sessions, projects
 *   RELAY_URL  (default http://127.0.0.1:7892) — agents, activity, messaging
 *
 * 22 tools:
 *   ubik_*      (8) — agent/session management
 *   activity_*  (7) — fleet activity stream
 *   project_*   (7) — project + fork management
 */
import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

const UBIK_URL  = (process.env.UBIK_URL  ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const RELAY_URL = (process.env.RELAY_URL ?? "http://127.0.0.1:7892").replace(/\/$/, "");
const TIMEOUT   = 15_000;

async function httpJson(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res  = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body:    body !== undefined ? JSON.stringify(body) : undefined,
      signal:  ctrl.signal,
    });
    const text = await res.text();
    if (!text) return { ok: res.ok, status: res.status };
    try { return JSON.parse(text); } catch { return { ok: res.ok, raw: text }; }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(tid);
  }
}

const ubik  = (m: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", p: string, b?: unknown) =>
  httpJson(`${UBIK_URL}${p}`, m, b);

const relay = (m: "GET"|"POST", p: string, b?: unknown) =>
  httpJson(`${RELAY_URL}${p}`, m, b);

type TR = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok   = (d: unknown): TR => ({ content: [{ type: "text", text: JSON.stringify(d, null, 2) }] });
const fail = (e: unknown): TR => ({ content: [{ type: "text", text: JSON.stringify({ error: String(e) }) }], isError: true });

const server = createMcpServer("ubik-desktop", "3.0.0");

// ═══ ubik_* ══════════════════════════════════════════════════════════════════

server.tool("ubik_list_agents",
  "List fleet agents registered on the relay.",
  {},
  async () => { try { return ok(await relay("GET", "/agents")); } catch(e) { return fail(e); } });

server.tool("ubik_list_sessions",
  "List active UBIK sessions.",
  {},
  async () => { try { return ok(await ubik("GET", "/sessions")); } catch(e) { return fail(e); } });

server.tool("ubik_create_session",
  "Create a UBIK session for an agent.",
  {
    agent_id: z.string().describe("Agent identifier"),
    cwd:      z.string().optional().describe("Working directory"),
    provider: z.string().optional().describe("LLM provider"),
  },
  async (args) => { try { return ok(await ubik("POST", `/sessions/${encodeURIComponent(args.agent_id)}`, { cwd: args.cwd, provider: args.provider })); } catch(e) { return fail(e); } });

server.tool("ubik_write",
  "Send a message to an agent via the relay.",
  {
    to:      z.string().describe("Target agent_id or 'all'"),
    message: z.string().describe("Message to send"),
    from:    z.string().optional().describe("Sender agent_id"),
  },
  async (args) => { try { return ok(await relay("POST", `/send/${encodeURIComponent(args.to)}`, { from: args.from ?? "ubik-mcp", message: args.message })); } catch(e) { return fail(e); } });

server.tool("ubik_read",
  "Read pending messages for an agent from the relay.",
  {
    agent_id: z.string().describe("Agent identifier"),
  },
  async (args) => { try { return ok(await relay("GET", `/read/${encodeURIComponent(args.agent_id)}`)); } catch(e) { return fail(e); } });

server.tool("ubik_kill_session",
  "Delete a UBIK session.",
  {
    agent_id: z.string().describe("Agent identifier"),
  },
  async (args) => { try { return ok(await ubik("DELETE", `/sessions/${encodeURIComponent(args.agent_id)}`)); } catch(e) { return fail(e); } });

server.tool("ubik_interrupt",
  "Send an interrupt signal to an agent via the relay.",
  {
    agent_id: z.string().describe("Agent to interrupt"),
    from:     z.string().optional().describe("Sender agent_id (defaults to 'ubik-mcp')"),
  },
  async (args) => { try { return ok(await relay("POST", `/send/${encodeURIComponent(args.agent_id)}`, { from: args.from ?? "ubik-mcp", message: "__interrupt__" })); } catch(e) { return fail(e); } });

server.tool("ubik_route_agent",
  "Route a task to an agent via the relay.",
  {
    to:      z.string().describe("Target agent_id"),
    message: z.string().describe("Task description"),
    from:    z.string().optional().describe("Sender agent_id (defaults to 'ubik-mcp')"),
  },
  async (args) => { try { return ok(await relay("POST", `/send/${encodeURIComponent(args.to)}`, { from: args.from ?? "ubik-mcp", message: args.message })); } catch(e) { return fail(e); } });

// ═══ activity_* ══════════════════════════════════════════════════════════════

server.tool("activity_emit",
  "Broadcast an activity event to the fleet.",
  {
    to:      z.string().default("all").describe("Target agent or 'all'"),
    message: z.string().describe("Activity message"),
    from:    z.string().optional().describe("Sender agent_id (defaults to 'ubik-mcp')"),
  },
  async (args) => { try { return ok(await relay("POST", `/send/${encodeURIComponent(args.to)}`, { from: args.from ?? "ubik-mcp", message: args.message })); } catch(e) { return fail(e); } });

server.tool("activity_read",
  "Read the relay activity stream.",
  {
    limit: z.number().int().positive().optional().describe("Max events (relay returns last ~100)"),
  },
  async (args) => {
    try {
      const data = await relay("GET", "/activity") as unknown[];
      const items = Array.isArray(data) ? data : [];
      return ok(args.limit ? items.slice(-args.limit) : items);
    } catch(e) { return fail(e); }
  });

server.tool("activity_live",
  "Get the latest activity events from the relay.",
  {},
  async () => {
    try {
      const data = await relay("GET", "/activity") as unknown[];
      const items = Array.isArray(data) ? data : [];
      return ok(items.slice(-20));
    } catch(e) { return fail(e); }
  });

server.tool("activity_agents",
  "List fleet agents with their status (alias of ubik_list_agents).",
  {},
  async () => { try { return ok(await relay("GET", "/agents")); } catch(e) { return fail(e); } });

server.tool("activity_sessions",
  "List active UBIK sessions (alias of ubik_list_sessions).",
  {},
  async () => { try { return ok(await ubik("GET", "/sessions")); } catch(e) { return fail(e); } });

server.tool("activity_tasks",
  "List recent agent task events from the relay.",
  {},
  async () => { try { return ok(await relay("GET", "/agent-events")); } catch(e) { return fail(e); } });

server.tool("activity_health",
  "Return fleet health status reported by the relay.",
  {},
  async () => { try { return ok(await relay("GET", "/health")); } catch(e) { return fail(e); } });

// ═══ project_* ═══════════════════════════════════════════════════════════════

server.tool("project_list",
  "List all UBIK projects.",
  {},
  async () => { try { return ok(await ubik("GET", "/projects")); } catch(e) { return fail(e); } });

server.tool("project_status",
  "Get details and forks for a project.",
  {
    project_id: z.string().describe("Project UUID"),
  },
  async (args) => { try { return ok(await ubik("GET", `/projects/${encodeURIComponent(args.project_id)}`)); } catch(e) { return fail(e); } });

server.tool("project_approve",
  "Select a winning fork for a project.",
  {
    project_id: z.string().describe("Project UUID"),
    fork_id:    z.string().describe("Fork UUID to approve"),
  },
  async (args) => { try { return ok(await ubik("POST", `/projects/${encodeURIComponent(args.project_id)}/select/${encodeURIComponent(args.fork_id)}`)); } catch(e) { return fail(e); } });

server.tool("project_link",
  "Update project metadata. Pass only the fields to change.",
  {
    project_id:  z.string().describe("Project UUID"),
    title:       z.string().optional().describe("New project title"),
    description: z.string().optional().describe("New project description"),
    status:      z.string().optional().describe("New status (e.g. 'active', 'paused', 'archived')"),
    repo:        z.string().optional().describe("Linked git repository (owner/name or URL)"),
  },
  async ({ project_id, ...patch }) => { try { return ok(await ubik("PATCH", `/projects/${encodeURIComponent(project_id)}`, patch)); } catch(e) { return fail(e); } });

server.tool("project_pause",
  "Pause a project.",
  {
    project_id: z.string().describe("Project UUID"),
  },
  async (args) => { try { return ok(await ubik("PATCH", `/projects/${encodeURIComponent(args.project_id)}`, { status: "paused" })); } catch(e) { return fail(e); } });

server.tool("project_resume",
  "Resume a paused project.",
  {
    project_id: z.string().describe("Project UUID"),
  },
  async (args) => { try { return ok(await ubik("PATCH", `/projects/${encodeURIComponent(args.project_id)}`, { status: "active" })); } catch(e) { return fail(e); } });

server.tool("project_events",
  "Get events/history for a project.",
  {
    project_id: z.string().describe("Project UUID"),
  },
  async (args) => {
    try {
      const p = await ubik("GET", `/projects/${encodeURIComponent(args.project_id)}`) as Record<string, unknown>;
      return ok((p as Record<string, unknown>).events ?? p);
    } catch(e) { return fail(e); }
  });

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-desktop] fatal: ${err}\n`);
  process.exit(1);
});
