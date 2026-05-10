#!/usr/bin/env node
/**
 * Standalone MCP server — desktop.ts
 *
 * Port of ubik-desktop-mcp/server.py (~2.5k LOC Python) to TypeScript.
 * Proxies HTTP calls to three local backends:
 *   - UBIK_DESKTOP_URL          (default http://127.0.0.1:7891)  — Tauri sidecar
 *   - UBIK_DESKTOP_SIDECAR_URL  (default http://127.0.0.1:8510)  — desktop-tools sidecar
 *   - PAPERCLIP_API_URL         (default http://127.0.0.1:3100/api) — Paperclip
 *
 * Tools registered (40+):
 *   activity_*  · claude_* (PTY) · ide_shortcut_* · ide_memory_*
 *   project_*   · system_*       · ubik_*         · codir_*
 *
 * No UBIK-RELEASE deps. Imports: @modelcontextprotocol/sdk, zod, dotenv, node:*.
 * Each tool defines its zod schema then proxies the call. Logic that lived only
 * in server.py (Unix socket wakeup, ~/.claude.json pre-trust, agent registry
 * file IO) is intentionally NOT ported — it requires the Python sidecar's
 * filesystem state. The TS server stays a pure HTTP-router.
 */

import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

// ── Backend URLs ─────────────────────────────────────────────────────────────
const DESKTOP_URL = process.env.UBIK_DESKTOP_URL ?? "http://127.0.0.1:7891";
const SIDECAR_URL = process.env.UBIK_DESKTOP_SIDECAR_URL ?? "http://127.0.0.1:8510";
const PAPERCLIP_URL = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100/api";

const HTTP_TIMEOUT_MS = 15_000;

// ── Generic HTTP helper using fetch (Node 20+) ───────────────────────────────
async function httpJson(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  body?: unknown,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!text) return { ok: res.ok, status: res.status };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: res.ok, status: res.status, raw: text };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

const desktopHttp = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  httpJson(`${DESKTOP_URL}${path}`, method, body);

const paperclipHttp = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  httpJson(`${PAPERCLIP_URL}${path}`, method, body);

// Sidecar tools call: POST /api/tools/{tool} with {args} body.
// The sidecar wraps the result as a JSON-encoded string under "result".
async function sidecarToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const payload = await httpJson(`${SIDECAR_URL}/api/tools/${tool}`, "POST", { args });
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  if (p.ok === false) return { error: p.error ?? "unknown sidecar error" };
  const result = p.result;
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return { raw: result };
    }
  }
  return result ?? p;
}

// ── Tool result wrapper ──────────────────────────────────────────────────────
type ToolReturn = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolReturn {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(msg: string): ToolReturn {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = createMcpServer("ubik-desktop-standalone", "2.0.0");

// ═══ ubik_* (PTY + agents on Tauri sidecar :7891) ═══════════════════════════

server.tool(
  "ubik_list_agents",
  "List the agents registered on the UBIK-DESKTOP sidecar (GET /agents).",
  {},
  async () => ok(await desktopHttp("GET", "/agents")),
);

server.tool(
  "ubik_list_sessions",
  "List active PTY sessions on the UBIK-DESKTOP sidecar (GET /pty/sessions).",
  {},
  async () => ok(await desktopHttp("GET", "/pty/sessions")),
);

server.tool(
  "ubik_create_session",
  "Create a new PTY session (POST /pty/spawn). Optional Paperclip wiring via `name`.",
  {
    workspace: z.string().optional().describe("Initial cwd"),
    cmd: z.string().optional().describe("Command to launch (default: bash)"),
    name: z.string().optional().describe("Paperclip agent name to wire (e.g. 'ubik-refactor-auth')"),
    role: z.string().optional().describe("Agent role"),
    model: z.string().optional().describe("Adapter type / model"),
  },
  async (args) => ok(await desktopHttp("POST", "/pty/spawn", args)),
);

server.tool(
  "ubik_write",
  "Write text to a PTY session (POST /pty/write). Caller is responsible for trailing \\r if needed.",
  {
    tab_id: z.string(),
    text: z.string(),
  },
  async ({ tab_id, text }) => ok(await desktopHttp("POST", "/pty/write", { tab_id, text })),
);

server.tool(
  "ubik_read",
  "Read pending output from a PTY session (POST /pty/read).",
  {
    tab_id: z.string(),
    timeout: z.number().optional().describe("Block until new output, in seconds"),
  },
  async (args) => ok(await desktopHttp("POST", "/pty/read", args)),
);

server.tool(
  "ubik_kill_session",
  "Kill a PTY session (DELETE /pty/{tab_id}).",
  { tab_id: z.string() },
  async ({ tab_id }) => ok(await desktopHttp("DELETE", `/pty/${encodeURIComponent(tab_id)}`)),
);

server.tool(
  "ubik_interrupt",
  "Send SIGINT then a follow-up message to a PTY session (POST /pty/interrupt/{tab_id} + write).",
  {
    tab_id: z.string(),
    message: z.string().describe("Text to send after the interrupt"),
  },
  async ({ tab_id, message }) => {
    await desktopHttp("POST", `/pty/interrupt/${encodeURIComponent(tab_id)}`);
    await desktopHttp("POST", "/pty/write", { tab_id, text: "" });
    const r = await desktopHttp("POST", "/pty/write", { tab_id, text: message.endsWith("\r") ? message : message + "\r" });
    return ok(r);
  },
);

server.tool(
  "ubik_route_agent",
  "Route a prompt to the best matching agent. Proxies to sidecar /api/route/agent.",
  { prompt: z.string() },
  async (args) => ok(await desktopHttp("POST", "/api/route/agent", args)),
);

// ═══ claude_* (PTY tools tuned for Claude CLI) ═══════════════════════════════

server.tool(
  "claude_spawn_terminal",
  "Spawn a terminal pre-configured for Claude CLI (POST /pty/spawn/claude).",
  {
    workspace: z.string().optional(),
    name: z.string().optional().describe("Paperclip agent name"),
    role: z.string().optional(),
    model: z.string().optional(),
  },
  async (args) => ok(await desktopHttp("POST", "/pty/spawn/claude", args)),
);

server.tool(
  "claude_run_task",
  "Run a one-shot task in a Claude PTY session.",
  {
    workspace: z.string(),
    prompt: z.string(),
    timeout: z.number().optional(),
  },
  async (args) => ok(await desktopHttp("POST", "/pty/claude/run", args)),
);

server.tool(
  "claude_list_terminals",
  "List active Claude PTY terminals.",
  {},
  async () => ok(await desktopHttp("GET", "/pty/claude/list")),
);

server.tool(
  "claude_write",
  "Write a prompt to a Claude PTY terminal (POST /pty/claude/write).",
  { tab_id: z.string(), text: z.string() },
  async (args) => ok(await desktopHttp("POST", "/pty/claude/write", args)),
);

server.tool(
  "claude_read",
  "Read the latest output from a Claude PTY terminal (POST /pty/claude/read).",
  { tab_id: z.string(), timeout: z.number().optional() },
  async (args) => ok(await desktopHttp("POST", "/pty/claude/read", args)),
);

server.tool(
  "claude_interrupt",
  "Interrupt the current Claude operation in a PTY (POST /pty/claude/interrupt).",
  { tab_id: z.string(), message: z.string().optional() },
  async (args) => ok(await desktopHttp("POST", "/pty/claude/interrupt", args)),
);

server.tool(
  "claude_kill",
  "Kill a Claude PTY terminal (DELETE /pty/claude/{tab_id}).",
  { tab_id: z.string() },
  async ({ tab_id }) => ok(await desktopHttp("DELETE", `/pty/claude/${encodeURIComponent(tab_id)}`)),
);

// ═══ activity_* ══════════════════════════════════════════════════════════════

server.tool(
  "activity_emit",
  "Emit an activity event (POST /activity).",
  {
    type: z.string(),
    actor: z.string().optional(),
    target: z.string().optional(),
    payload: z.record(z.unknown()).optional(),
  },
  async (args) => ok(await desktopHttp("POST", "/activity", args)),
);

server.tool(
  "activity_read",
  "Read recent activity events (GET /activity?limit=N).",
  { limit: z.number().int().min(1).max(500).default(50) },
  async ({ limit }) => ok(await desktopHttp("GET", `/activity?limit=${limit}`)),
);

server.tool(
  "activity_live",
  "Read live activity stream snapshot (GET /activity/live).",
  {},
  async () => ok(await desktopHttp("GET", "/activity/live")),
);

server.tool(
  "activity_agents",
  "List agents seen in the activity stream (GET /activity/agents).",
  {},
  async () => ok(await desktopHttp("GET", "/activity/agents")),
);

server.tool(
  "activity_sessions",
  "List sessions visible in activity (GET /activity/sessions).",
  {},
  async () => ok(await desktopHttp("GET", "/activity/sessions")),
);

server.tool(
  "activity_tasks",
  "List tasks visible in activity (GET /activity/tasks).",
  {},
  async () => ok(await desktopHttp("GET", "/activity/tasks")),
);

server.tool(
  "activity_health",
  "Health check of the activity service (GET /activity/health).",
  {},
  async () => ok(await desktopHttp("GET", "/activity/health")),
);

// ═══ ide_shortcut_* + ide_memory_* (proxied via desktop-tools sidecar :8510) ═

const ideShortcutTools = [
  "ide_shortcut_invoke",
  "ide_shortcut_run",
  "ide_shortcut_status",
  "ide_shortcut_result",
  "ide_shortcut_finish",
  "ide_shortcut_list",
] as const;

for (const tool of ideShortcutTools) {
  server.tool(
    tool,
    `IDE shortcut tool '${tool}' — proxied to sidecar /api/tools/${tool}. Args are passed through as-is.`,
    {
      args: z.record(z.unknown()).optional().describe("Arbitrary tool arguments — see UBIK-DESKTOP sidecar docs"),
    },
    async ({ args }) => ok(await sidecarToolCall(tool, args ?? {})),
  );
}

const ideMemoryTools = ["ide_memory_get", "ide_memory_list", "ide_memory_search"] as const;

for (const tool of ideMemoryTools) {
  server.tool(
    tool,
    `IDE memory tool '${tool}' — proxied to sidecar /api/tools/${tool}.`,
    {
      args: z.record(z.unknown()).optional(),
    },
    async ({ args }) => ok(await sidecarToolCall(tool, args ?? {})),
  );
}

// ═══ project_* (UBIK-DESKTOP local project store on :7891) ═══════════════════

server.tool(
  "project_list",
  "List projects (GET /projects).",
  {},
  async () => ok(await desktopHttp("GET", "/projects")),
);

server.tool(
  "project_status",
  "Get full status of one project (GET /projects/{id}).",
  { project_id: z.string() },
  async ({ project_id }) => ok(await desktopHttp("GET", `/projects/${encodeURIComponent(project_id)}`)),
);

server.tool(
  "project_approve",
  "Approve a project gating step (POST /projects/{id}/approve).",
  {
    project_id: z.string(),
    step: z.string(),
    note: z.string().optional(),
  },
  async ({ project_id, ...body }) =>
    ok(await desktopHttp("POST", `/projects/${encodeURIComponent(project_id)}/approve`, body)),
);

server.tool(
  "project_link",
  "Link a project to a repo + branch (POST /projects/{id}/link).",
  {
    project_id: z.string(),
    repo: z.string().optional(),
    branch: z.string().optional(),
    worktree: z.string().optional(),
  },
  async ({ project_id, ...body }) =>
    ok(await desktopHttp("POST", `/projects/${encodeURIComponent(project_id)}/link`, body)),
);

server.tool(
  "project_pause",
  "Pause a project (POST /projects/{id}/pause).",
  { project_id: z.string(), reason: z.string().optional() },
  async ({ project_id, ...body }) =>
    ok(await desktopHttp("POST", `/projects/${encodeURIComponent(project_id)}/pause`, body)),
);

server.tool(
  "project_resume",
  "Resume a paused project (POST /projects/{id}/resume).",
  { project_id: z.string() },
  async ({ project_id }) =>
    ok(await desktopHttp("POST", `/projects/${encodeURIComponent(project_id)}/resume`)),
);

server.tool(
  "project_events",
  "List events for a project (GET /projects/{id}/events?limit=N).",
  { project_id: z.string(), limit: z.number().int().min(1).max(500).default(50) },
  async ({ project_id, limit }) =>
    ok(await desktopHttp("GET", `/projects/${encodeURIComponent(project_id)}/events?limit=${limit}`)),
);

// ═══ system_* (Paperclip — multi-agent threads on :3100/api) ═════════════════

server.tool(
  "system_send_to_thread",
  "Post a message to a Paperclip thread on behalf of an agent (POST /threads/{id}/comments).",
  {
    thread_id: z.string(),
    message: z.string(),
    agent_id: z.string().optional().describe("Sender agent (default from PAPERCLIP_AGENT_ID env)"),
    company_id: z.string().optional(),
  },
  async ({ thread_id, ...body }) =>
    ok(await paperclipHttp("POST", `/threads/${encodeURIComponent(thread_id)}/comments`, body)),
);

server.tool(
  "system_interrupt_agent",
  "Send an interrupt signal to a Paperclip-wired agent (POST /agents/{id}/interrupt).",
  { agent_id: z.string(), reason: z.string().optional() },
  async ({ agent_id, ...body }) =>
    ok(await paperclipHttp("POST", `/agents/${encodeURIComponent(agent_id)}/interrupt`, body)),
);

server.tool(
  "system_stop_agent",
  "Stop a Paperclip agent and unregister it (POST /agents/{id}/stop).",
  { agent_id: z.string() },
  async ({ agent_id }) =>
    ok(await paperclipHttp("POST", `/agents/${encodeURIComponent(agent_id)}/stop`)),
);

server.tool(
  "system_list_agents",
  "List Paperclip-wired agents (GET /agents).",
  { company_id: z.string().optional() },
  async ({ company_id }) => {
    const qs = company_id ? `?companyId=${encodeURIComponent(company_id)}` : "";
    return ok(await paperclipHttp("GET", `/agents${qs}`));
  },
);

server.tool(
  "system_react_to_comment",
  "Add an emoji reaction to a Paperclip comment (POST /comments/{id}/reactions).",
  {
    threadId: z.string(),
    targetCommentId: z.string(),
    emoji: z.string(),
  },
  async ({ threadId, targetCommentId, emoji }) =>
    ok(
      await paperclipHttp("POST", `/threads/${encodeURIComponent(threadId)}/comments`, {
        message: `:reaction:${emoji}:${targetCommentId}`,
      }),
    ),
);

server.tool(
  "system_set_topic",
  "Set the topic of a Paperclip thread (PATCH /threads/{id}).",
  { thread_id: z.string(), topic: z.string() },
  async ({ thread_id, topic }) =>
    ok(await paperclipHttp("PATCH", `/threads/${encodeURIComponent(thread_id)}`, { topic })),
);

server.tool(
  "system_create_subthread",
  "Create a subthread under an existing Paperclip thread (POST /threads).",
  {
    parent_thread_id: z.string(),
    title: z.string(),
    topic: z.string().optional(),
    company_id: z.string().optional(),
  },
  async ({ parent_thread_id, title, topic, company_id }) =>
    ok(
      await paperclipHttp("POST", "/threads", {
        parentThreadId: parent_thread_id,
        title,
        topic,
        companyId: company_id,
      }),
    ),
);

// ═══ codir_* (delegate to a CODIR member terminal on the desktop sidecar) ════

const codirMembers = ["cto", "cdo", "ciso", "cpo", "coo"] as const;

for (const member of codirMembers) {
  server.tool(
    `codir_${member}`,
    `Delegate a strategic task to the ${member.toUpperCase()}. Spawns the dedicated terminal on UBIK-DESKTOP sidecar.`,
    {
      task: z.string().describe("Strategic brief: context, expected outcome, constraints"),
      context: z.string().optional().describe("Additional context"),
      workspace: z.string().optional().describe("Initial workspace dir"),
    },
    async (args) => ok(await desktopHttp("POST", `/codir/${member}/spawn`, args)),
  );
}

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-desktop-standalone] fatal: ${String(err)}\n`);
  process.exit(1);
});
