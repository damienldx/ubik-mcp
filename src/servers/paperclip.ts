#!/usr/bin/env node
/**
 * UBIK Paperclip — standalone MCP stdio server.
 *
 * Ports the 27 tools from sidecars/desktop-tools/mcp_paperclip.py to TypeScript.
 * Tool names follow the canonical Paperclip MCP fleet nomenclature
 * (paperclip_whoami, paperclip_inbox, paperclip_thread_*, paperclip_approval_*, ...).
 *
 * Auth & config (env vars or .env):
 *   PAPERCLIP_API_URL      default "http://127.0.0.1:3100/api"
 *   PAPERCLIP_API_KEY      optional Bearer token (local_trusted mode skips auth)
 *   PAPERCLIP_COMPANY_ID   default companyId for list/create tools
 *   PAPERCLIP_AGENT_ID     default agentId for paperclip_thread_checkout
 *   PAPERCLIP_RUN_ID       attached as X-Paperclip-Run-Id on write methods
 *
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, node:* only.
 */

import { z } from "zod";
import { config } from "dotenv";
import { createMcpServer, runServer } from "../lib/server.js";

config();

// ─── Config ──────────────────────────────────────────────────────────────────

function apiUrl(): string {
  let raw = (process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100/api").trim();
  raw = raw.replace(/\/+$/, "");
  if (!raw.endsWith("/api")) raw = raw + "/api";
  return raw;
}

function apiKey(): string {
  return (process.env.PAPERCLIP_API_KEY || "").trim();
}

function defaultCompanyId(): string {
  return (process.env.PAPERCLIP_COMPANY_ID || "").trim();
}

function defaultAgentId(): string {
  return (process.env.PAPERCLIP_AGENT_ID || "").trim();
}

function runId(): string {
  return (process.env.PAPERCLIP_RUN_ID || "").trim();
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ─── HTTP core ───────────────────────────────────────────────────────────────

async function pcRequest(method: string, path: string, body?: any): Promise<string> {
  if (!path.startsWith("/")) {
    return `[error: path must start with '/': ${path}]`;
  }
  const m = method.toUpperCase();
  const url = apiUrl() + path;
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = apiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
  const rid = runId();
  if (rid && WRITE_METHODS.has(m)) headers["X-Paperclip-Run-Id"] = rid;

  let res: Response;
  try {
    res = await fetch(url, {
      method: m,
      headers,
      ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e: any) {
    return `[error: paperclip request failed: ${e?.message || String(e)}]`;
  }

  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (res.status >= 400) {
    if (parsed && typeof parsed === "object" && parsed.error) {
      return `[error: ${m} ${path} -> ${res.status}: ${parsed.error}]`;
    }
    return `[error: ${m} ${path} -> ${res.status}: ${text.substring(0, 500)}]`;
  }

  if (parsed === null) return "{}";
  if (typeof parsed === "string") return parsed;
  return JSON.stringify(parsed);
}

function q(value: string): string {
  return encodeURIComponent(value);
}

function queryString(params: Record<string, any>): string {
  const sp = new URLSearchParams();
  let any = false;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
    any = true;
  }
  return any ? `?${sp.toString()}` : "";
}

function resolveCompany(args: { companyId?: string }): string | null {
  const cid = (args.companyId || "").trim() || defaultCompanyId();
  return cid || null;
}

function resolveAgent(args: { agentId?: string }): string | null {
  const aid = (args.agentId || "").trim() || defaultAgentId();
  return aid || null;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createMcpServer("ubik-paperclip");

// ── Identity / inbox / agents ──────────────────────────────────────────────

server.tool(
  "paperclip_whoami",
  "Get the current authenticated Paperclip actor (agent) details.",
  {},
  async () => ok(await pcRequest("GET", "/agents/me"))
);

server.tool(
  "paperclip_inbox",
  "Get the current authenticated agent's inbox-lite assignment list.",
  {},
  async () => ok(await pcRequest("GET", "/agents/me/inbox-lite"))
);

server.tool(
  "paperclip_list_agents",
  "List agents in a company.",
  {
    companyId: z.string().optional().describe("Company UUID. Defaults to PAPERCLIP_COMPANY_ID."),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required (set PAPERCLIP_COMPANY_ID or pass companyId)]");
    return ok(await pcRequest("GET", `/companies/${q(cid)}/agents`));
  }
);

server.tool(
  "paperclip_agent_get",
  "Get a single agent by id.",
  {
    agentId: z.string().describe("Agent UUID"),
    companyId: z.string().optional(),
  },
  async (args) => {
    if (!args.agentId) return fail("[error: agentId required]");
    const qs = queryString({ companyId: args.companyId });
    return ok(await pcRequest("GET", `/agents/${q(args.agentId)}${qs}`));
  }
);

server.tool(
  "paperclip_agent_create",
  "Register a new agent in a company.",
  {
    name: z.string().describe("Agent display name (required)"),
    role: z.string().optional().describe("Agent role: engineer, manager, analyst... (default engineer)"),
    title: z.string().optional().describe("Agent title / specialty (optional)"),
    adapterType: z.string().optional().describe("Adapter type, default 'http'"),
    companyId: z.string().optional().describe("Company UUID (uses PAPERCLIP_COMPANY_ID if omitted)"),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required]");
    if (!args.name) return fail("[error: name required]");
    const body: Record<string, any> = {
      name: args.name,
      role: args.role || "engineer",
      adapterType: args.adapterType || "http",
    };
    if (args.title) body.title = args.title;
    return ok(await pcRequest("POST", `/companies/${q(cid)}/agents`, body));
  }
);

// ── Threads (issues) ───────────────────────────────────────────────────────

server.tool(
  "paperclip_thread_list",
  "List issues (threads) for a company with optional filters.",
  {
    companyId: z.string().optional(),
    status: z.string().optional(),
    projectId: z.string().optional(),
    assigneeAgentId: z.string().optional(),
    participantAgentId: z.string().optional(),
    assigneeUserId: z.string().optional(),
    touchedByUserId: z.string().optional(),
    labelId: z.string().optional(),
    executionWorkspaceId: z.string().optional(),
    originKind: z.string().optional(),
    originId: z.string().optional(),
    includeRoutineExecutions: z.boolean().optional(),
    q: z.string().optional().describe("Free-text search."),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required]");
    const { companyId, ...filters } = args;
    return ok(await pcRequest("GET", `/companies/${q(cid)}/issues${queryString(filters)}`));
  }
);

server.tool(
  "paperclip_thread_get",
  "Get a single issue (thread) by UUID or short identifier.",
  {
    issueId: z.string().describe("Issue UUID or short identifier"),
  },
  async ({ issueId }) => {
    if (!issueId) return fail("[error: issueId required]");
    return ok(await pcRequest("GET", `/issues/${q(issueId)}`));
  }
);

server.tool(
  "paperclip_thread_create",
  "Create a new issue (thread) in a company.",
  {
    title: z.string().describe("Issue title (required)"),
    body: z.string().optional().describe("Issue body / description"),
    companyId: z.string().optional().describe("Company UUID (uses PAPERCLIP_COMPANY_ID if omitted)"),
    assigneeId: z.string().optional().describe("Agent UUID to assign immediately"),
    labels: z.array(z.string()).optional().describe("Label names"),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required (set PAPERCLIP_COMPANY_ID or pass companyId)]");
    if (!args.title) return fail("[error: title required]");
    const body: Record<string, any> = { title: args.title };
    if (args.body !== undefined) body.body = args.body;
    if (args.labels !== undefined) body.labels = args.labels;
    if (args.assigneeId !== undefined) body.assigneeId = args.assigneeId;
    return ok(await pcRequest("POST", `/companies/${q(cid)}/issues`, body));
  }
);

server.tool(
  "paperclip_thread_checkout",
  "Checkout an issue (thread) for an agent.",
  {
    issueId: z.string(),
    agentId: z.string().optional().describe("Defaults to PAPERCLIP_AGENT_ID."),
    expectedStatuses: z.array(z.string()).optional(),
  },
  async (args) => {
    if (!args.issueId) return fail("[error: issueId required]");
    const aid = resolveAgent(args);
    if (!aid) return fail("[error: agentId required (set PAPERCLIP_AGENT_ID or pass agentId)]");
    const body = {
      agentId: aid,
      expectedStatuses: args.expectedStatuses ?? ["todo", "backlog", "blocked"],
    };
    return ok(await pcRequest("POST", `/issues/${q(args.issueId)}/checkout`, body));
  }
);

server.tool(
  "paperclip_thread_release",
  "Release an issue (thread) checkout.",
  {
    issueId: z.string(),
  },
  async ({ issueId }) => {
    if (!issueId) return fail("[error: issueId required]");
    return ok(await pcRequest("POST", `/issues/${q(issueId)}/release`, {}));
  }
);

server.tool(
  "paperclip_thread_update",
  "Patch an issue/thread (title, status, assignee, labels...). Optionally include a comment.",
  {
    issueId: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    assigneeAgentId: z.string().optional(),
    assigneeUserId: z.string().optional(),
    labels: z.array(z.string()).optional(),
    comment: z.string().optional(),
  },
  async (args) => {
    if (!args.issueId) return fail("[error: issueId required]");
    const { issueId, ...body } = args;
    return ok(await pcRequest("PATCH", `/issues/${q(issueId)}`, body));
  }
);

server.tool(
  "paperclip_thread_comment",
  "Add a comment to an issue (thread).",
  {
    issueId: z.string(),
    body: z.string(),
  },
  async (args) => {
    if (!args.issueId) return fail("[error: issueId required]");
    const { issueId, ...body } = args;
    return ok(await pcRequest("POST", `/issues/${q(issueId)}/comments`, body));
  }
);

server.tool(
  "paperclip_thread_comment_get",
  "Get a specific issue comment by id.",
  {
    issueId: z.string(),
    commentId: z.string(),
  },
  async ({ issueId, commentId }) => {
    if (!issueId || !commentId) return fail("[error: issueId and commentId required]");
    return ok(await pcRequest("GET", `/issues/${q(issueId)}/comments/${q(commentId)}`));
  }
);

server.tool(
  "paperclip_thread_list_comments",
  "List issue comments with incremental pagination.",
  {
    issueId: z.string(),
    after: z.string().optional().describe("Comment UUID cursor"),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().optional(),
  },
  async ({ issueId, after, order, limit }) => {
    if (!issueId) return fail("[error: issueId required]");
    const qs = queryString({ after, order, limit });
    return ok(await pcRequest("GET", `/issues/${q(issueId)}/comments${qs}`));
  }
);

server.tool(
  "paperclip_thread_doc_upsert",
  "Create or update an issue document (markdown).",
  {
    issueId: z.string(),
    key: z.string().describe("Stable key, max 64 chars"),
    title: z.string().optional(),
    format: z.enum(["markdown"]).optional(),
    body: z.string(),
    changeSummary: z.string().optional(),
    baseRevisionId: z.string().optional(),
  },
  async (args) => {
    if (!args.issueId || !args.key || args.body === undefined) {
      return fail("[error: issueId, key and body required]");
    }
    const { issueId, key, ...body } = args;
    return ok(await pcRequest("PUT", `/issues/${q(issueId)}/documents/${q(key)}`, body));
  }
);

server.tool(
  "paperclip_thread_doc_revisions",
  "List revisions of an issue document.",
  {
    issueId: z.string(),
    key: z.string(),
  },
  async ({ issueId, key }) => {
    if (!issueId || !key) return fail("[error: issueId and key required]");
    return ok(await pcRequest("GET", `/issues/${q(issueId)}/documents/${q(key)}/revisions`));
  }
);

server.tool(
  "paperclip_thread_doc_restore",
  "Restore a prior revision of an issue document.",
  {
    issueId: z.string(),
    key: z.string(),
    revisionId: z.string(),
  },
  async ({ issueId, key, revisionId }) => {
    if (!issueId || !key || !revisionId) return fail("[error: issueId, key, revisionId required]");
    return ok(
      await pcRequest("POST", `/issues/${q(issueId)}/documents/${q(key)}/revisions/${q(revisionId)}/restore`, {})
    );
  }
);

// ── Projects / Goals ───────────────────────────────────────────────────────

server.tool(
  "paperclip_project_list",
  "List projects in a company.",
  {
    companyId: z.string().optional(),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required]");
    return ok(await pcRequest("GET", `/companies/${q(cid)}/projects`));
  }
);

server.tool(
  "paperclip_project_get",
  "Get a project by id or company-scoped short reference.",
  {
    projectId: z.string(),
    companyId: z.string().optional(),
  },
  async ({ projectId, companyId }) => {
    if (!projectId) return fail("[error: projectId required]");
    const qs = queryString({ companyId });
    return ok(await pcRequest("GET", `/projects/${q(projectId)}${qs}`));
  }
);

server.tool(
  "paperclip_goal_list",
  "List goals in a company.",
  {
    companyId: z.string().optional(),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required]");
    return ok(await pcRequest("GET", `/companies/${q(cid)}/goals`));
  }
);

server.tool(
  "paperclip_goal_get",
  "Get a goal by id.",
  {
    goalId: z.string(),
  },
  async ({ goalId }) => {
    if (!goalId) return fail("[error: goalId required]");
    return ok(await pcRequest("GET", `/goals/${q(goalId)}`));
  }
);

// ── Approvals ──────────────────────────────────────────────────────────────

server.tool(
  "paperclip_approval_inbox",
  "List approvals in a company.",
  {
    companyId: z.string().optional(),
    status: z.string().optional(),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required]");
    const qs = queryString({ status: args.status });
    return ok(await pcRequest("GET", `/companies/${q(cid)}/approvals${qs}`));
  }
);

server.tool(
  "paperclip_approval_get",
  "Get an approval by id.",
  {
    approvalId: z.string(),
  },
  async ({ approvalId }) => {
    if (!approvalId) return fail("[error: approvalId required]");
    return ok(await pcRequest("GET", `/approvals/${q(approvalId)}`));
  }
);

server.tool(
  "paperclip_request_approval",
  "Create a board approval request, optionally linked to issues.",
  {
    title: z.string(),
    kind: z.string().optional(),
    summary: z.string().optional(),
    payload: z.record(z.any()).optional(),
    issueIds: z.array(z.string()).optional(),
    companyId: z.string().optional(),
  },
  async (args) => {
    const cid = resolveCompany(args);
    if (!cid) return fail("[error: companyId required]");
    if (!args.title) return fail("[error: title required]");
    const { companyId, ...body } = args;
    return ok(await pcRequest("POST", `/companies/${q(cid)}/approvals`, body));
  }
);

server.tool(
  "paperclip_approval_decide",
  "Approve, reject, request revision, or resubmit an approval.",
  {
    approvalId: z.string(),
    action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
    decisionNote: z.string().optional(),
    payloadJson: z.string().optional().describe("JSON-string payload for resubmit only"),
  },
  async ({ approvalId, action, decisionNote, payloadJson }) => {
    if (!approvalId) return fail("[error: approvalId required]");
    let path: string;
    if (action === "approve") path = `/approvals/${q(approvalId)}/approve`;
    else if (action === "reject") path = `/approvals/${q(approvalId)}/reject`;
    else if (action === "requestRevision") path = `/approvals/${q(approvalId)}/request-revision`;
    else path = `/approvals/${q(approvalId)}/resubmit`;

    let body: Record<string, any>;
    if (action === "resubmit") {
      let payload: any = {};
      if (typeof payloadJson === "string" && payloadJson.trim()) {
        try {
          payload = JSON.parse(payloadJson);
        } catch {
          return fail("[error: payloadJson is not valid JSON]");
        }
      }
      body = { payload: payload || {} };
    } else {
      body = { decisionNote };
    }
    return ok(await pcRequest("POST", path, body));
  }
);

server.tool(
  "paperclip_approval_comment",
  "Add a comment to an approval.",
  {
    approvalId: z.string(),
    body: z.string(),
  },
  async ({ approvalId, body }) => {
    if (!approvalId || !body) return fail("[error: approvalId and body required]");
    return ok(await pcRequest("POST", `/approvals/${q(approvalId)}/comments`, { body }));
  }
);

// ── Escape hatch ───────────────────────────────────────────────────────────

server.tool(
  "paperclip_api_request",
  "Make a JSON request to any /api endpoint for unsupported operations.",
  {
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().describe("Must start with '/' and be relative to /api. No '..'."),
    jsonBody: z.string().optional().describe("JSON-stringified body for write methods."),
  },
  async ({ method, path, jsonBody }) => {
    if (!path.startsWith("/") || path.includes("..")) {
      return fail("[error: path must start with '/' (relative to /api) and must not contain '..']");
    }
    let body: any = undefined;
    if (typeof jsonBody === "string" && jsonBody.trim()) {
      try {
        body = JSON.parse(jsonBody);
      } catch {
        return fail("[error: jsonBody is not valid JSON]");
      }
    }
    return ok(await pcRequest(method, path, body));
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-paperclip] Fatal: ${err}\n`);
  process.exit(1);
});
