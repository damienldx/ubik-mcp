#!/usr/bin/env node
/**
 * UBIK System — MCP Server
 * Exposes system internals (status, cortex, skills, workflows, connectors, git dashboard, routines, experts)
 * as structured MCP tools for CLI agents (Claude, Gemini, Codex).
 *
 * Tools (9):
 *   ubik_system_status    — Server, DB, memory, tasks metrics
 *   ubik_cortex_ops       — Cortex memory operations (read, save, archive, search, types, stats)
 *   ubik_cortex_search    — Full-text search in Cortex archives with filters
 *   ubik_skill_search     — Search 23k+ skills (local keyword + domain listing)
 *   ubik_create_workflow   — Create orchestration plans with phases and tasks
 *   ubik_connector_status — Check OAuth connector validity for a service
 *   ubik_git_dashboard    — Git Collab dashboard (projects, tasks, stats from DB)
 *   ubik_routine_create   — Create/start a daemon routine
 *   ubik_load_expert      — Load an expert pattern (hardcoded or custom from API)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { config } from "dotenv";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth";

config({ path: path.join(process.cwd(), ".env") });

const auth = createMcpAuth("ubik-system");

const server = new McpServer({ name: "ubik-system", version: "1.0.0" });

const UBIK_API = process.env.UBIK_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const PROJECT_DIR = process.cwd();
const DB_PATH = path.join(PROJECT_DIR, "data", "ubik.db");
const SKILLS_DIR = path.join(PROJECT_DIR, "SKILLS");
const HOOKS_DIR = path.join(PROJECT_DIR, ".hooks", "commands");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// ─── Database helper (lazy singleton) ───

let _db: any = null;

function getDb() {
  if (!_db) {
    const Database = require("better-sqlite3");
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

function queryDb<T = any>(sql: string, params: any[] = []): T[] {
  try {
    return getDb().prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function queryOne<T = any>(sql: string, params: any[] = []): T | null {
  try {
    return getDb().prepare(sql).get(...params) as T ?? null;
  } catch {
    return null;
  }
}

// ─── API helper ───

async function ubikApi(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${UBIK_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...auth.getAuthHeaders(),
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`API ${path} failed (${res.status})`);
  return res.json();
}

// ═══════════════════════════════════════
// Tool 1: ubik_system_status
// ═══════════════════════════════════════

server.tool(
  "ubik_system_status",
  "System status dashboard: server health, DB metrics, memory counts, git tasks, threads, routines, connectors. Replaces @status shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    scope: z.enum(["overview", "full", "db", "memory", "tasks", "threads"]).default("overview").describe("Status scope: overview (quick), full (all details), db (tables), memory (cortex), tasks (git), threads (conversations)"),
  },
  async (args) => {
    try {
      const scope = args.scope;

      // Server health check
      let serverStatus = "offline";
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        await fetch(`${UBIK_API}/api/context?layer=global`, { signal: ctrl.signal });
        clearTimeout(timer);
        serverStatus = "online";
      } catch { /* offline */ }

      if (scope === "overview" || scope === "full") {
        const live = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM memory_live");
        const archive = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM memory_archive");
        const tasks = queryDb<{ status: string; c: number }>("SELECT status, COUNT(*) as c FROM git_tasks GROUP BY status");
        const threads = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM threads");
        const routines = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM routines WHERE enabled = 1");

        const result: Record<string, unknown> = {
          server: { status: serverStatus, port: process.env.PORT || 3001, api: UBIK_API },
          memory: { live: live?.c ?? 0, archive: archive?.c ?? 0 },
          gitTasks: Object.fromEntries(tasks.map(t => [t.status, t.c])),
          threads: threads?.c ?? 0,
          activeRoutines: routines?.c ?? 0,
          dbPath: DB_PATH,
        };

        if (scope === "full") {
          const connectors = queryDb<{ provider: string; c: number }>("SELECT provider, COUNT(*) as c FROM connectors GROUP BY provider");
          const totalRoutines = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM routines");
          result.connectors = Object.fromEntries(connectors.map(c => [c.provider, c.c]));
          result.totalRoutines = totalRoutines?.c ?? 0;
        }

        return ok(result);
      }

      if (scope === "db") {
        const tables = queryDb<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        const tableStats: Record<string, number> = {};
        for (const t of tables) {
          const row = queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM ${t.name}`);
          tableStats[t.name] = row?.c ?? 0;
        }
        return ok({ tables: tableStats });
      }

      if (scope === "memory") {
        const live = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM memory_live");
        const archive = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM memory_archive");
        const byType = queryDb<{ type: string; c: number }>("SELECT type, COUNT(*) as c FROM memory_archive GROUP BY type ORDER BY c DESC");
        const bySource = queryDb<{ source: string; c: number }>("SELECT source, COUNT(*) as c FROM memory_archive GROUP BY source ORDER BY c DESC");
        const recent = queryDb("SELECT type, title, source, created_at FROM memory_archive ORDER BY created_at DESC LIMIT 5");
        return ok({ live: live?.c ?? 0, archive: archive?.c ?? 0, byType, bySource, recent });
      }

      if (scope === "tasks") {
        const tasks = queryDb("SELECT id, title, status, assignee, reviewer, created_at FROM git_tasks ORDER BY created_at DESC LIMIT 15");
        return ok({ tasks });
      }

      if (scope === "threads") {
        const threads = queryDb("SELECT id, title, provider, model, message_count, updated_at FROM threads ORDER BY updated_at DESC LIMIT 15");
        return ok({ threads });
      }

      return ok({ error: "Unknown scope" });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 2: ubik_cortex_ops
// ═══════════════════════════════════════

server.tool(
  "ubik_cortex_ops",
  "Cortex memory operations: stats, read layers, browse archives, save entries, list types. Replaces @cortex shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    action: z.enum(["stats", "read", "archive", "save", "types"]).describe("Action: stats (dashboard), read (layer content), archive (browse recent), save (persist entry), types (archive type breakdown)"),
    layer: z.string().optional().describe("For 'read': global, projects, tasks, archive"),
    limit: z.number().optional().describe("For 'archive': number of entries (default 10)"),
    title: z.string().optional().describe("For 'save': entry title"),
    content: z.string().optional().describe("For 'save': entry content"),
    type: z.string().optional().describe("For 'save': entry type (decision, convention, bug_fix, architecture, observation)"),
  },
  async (args) => {
    try {
      switch (args.action) {
        case "stats": {
          const live = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM memory_live");
          const archive = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM memory_archive");
          const byType = queryDb<{ type: string; c: number }>("SELECT type, COUNT(*) as c FROM memory_archive GROUP BY type ORDER BY c DESC");
          const bySource = queryDb<{ source: string; c: number }>("SELECT source, COUNT(*) as c FROM memory_archive GROUP BY source ORDER BY c DESC");
          const recent = queryDb("SELECT type, title, source, created_at FROM memory_archive ORDER BY created_at DESC LIMIT 5");
          return ok({
            live: live?.c ?? 0,
            archive: archive?.c ?? 0,
            byType: Object.fromEntries(byType.map(t => [t.type, t.c])),
            bySource: Object.fromEntries(bySource.map(s => [s.source, s.c])),
            recentArchives: recent,
          });
        }

        case "read": {
          const layer = args.layer || "archive";
          const data = await ubikApi(`/api/context?layer=${encodeURIComponent(layer)}`);
          return ok(data);
        }

        case "archive": {
          const limit = args.limit || 10;
          const entries = queryDb(
            "SELECT id, type, title, source, content, created_at FROM memory_archive ORDER BY created_at DESC LIMIT ?",
            [limit]
          );
          return ok({ count: entries.length, entries: entries.map(e => ({ ...e, content: e.content?.slice(0, 300) })) });
        }

        case "save": {
          if (!args.title || !args.content) return ok({ error: "title and content are required for save" });
          const data = await ubikApi("/api/context", {
            method: "POST",
            body: JSON.stringify({
              action: "save",
              type: args.type || "observation",
              title: args.title,
              content: args.content,
              source: "claude",
            }),
          });
          return ok({ saved: true, ...data });
        }

        case "types": {
          const types = queryDb<{ type: string; c: number }>("SELECT type, COUNT(*) as c FROM memory_archive GROUP BY type ORDER BY c DESC");
          return ok({ types });
        }

        default:
          return ok({ error: "Unknown action" });
      }
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 3: ubik_cortex_search
// ═══════════════════════════════════════

server.tool(
  "ubik_cortex_search",
  "Full-text search in Cortex archives with type/source/tag filters. Replaces @search shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    query: z.string().describe("Search query (full-text, multiple terms AND)"),
    type: z.string().optional().describe("Filter by archive type: decision, convention, bug_fix, architecture, observation"),
    source: z.string().optional().describe("Filter by source: claude, gemini, codex, user"),
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (args) => {
    try {
      const params = new URLSearchParams({
        layer: "archive",
        search: args.query,
        limit: String(args.limit || 20),
      });
      if (args.type) params.set("type", args.type);
      if (args.source) params.set("source", args.source);
      if (args.tag) params.set("tag", args.tag);

      const result = await ubikApi(`/api/context?${params.toString()}`);
      const data = result.data || [];
      return ok({
        query: args.query,
        filters: { type: args.type, source: args.source, tag: args.tag },
        count: data.length,
        results: data.map((r: any) => ({
          type: r.type,
          title: r.title,
          source: r.source,
          date: (r.created_at || r.createdAt || "").split("T")[0],
          excerpt: (r.content || "").slice(0, 250),
        })),
      });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 4: ubik_skill_search
// ═══════════════════════════════════════

server.tool(
  "ubik_skill_search",
  "Search the 23k+ skill library: keyword search, domain listing, domain detail. Replaces @skill shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    action: z.enum(["search", "domains", "domain"]).default("search").describe("search: keyword search | domains: list/filter domains | domain: detail one domain"),
    query: z.string().optional().describe("For search: keywords to match. For domains: filter string. For domain: domain name."),
    limit: z.number().optional().describe("Max results for search (default 15)"),
  },
  async (args) => {
    try {
      const limit = args.limit || 15;

      if (args.action === "domains") {
        const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        const domains: Array<{ name: string; label: string; skillCount: number }> = [];
        const filter = (args.query || "").toLowerCase();

        for (const dir of dirs) {
          if (filter && !dir.name.toLowerCase().includes(filter)) continue;
          const djp = path.join(SKILLS_DIR, dir.name, "domain.json");
          if (!fs.existsSync(djp)) continue;
          try {
            const dd = JSON.parse(fs.readFileSync(djp, "utf-8"));
            domains.push({ name: dir.name, label: dd.name || dir.name, skillCount: (dd.skills || []).length });
          } catch { continue; }
        }

        return ok({ domainCount: domains.length, domains: domains.sort((a, b) => b.skillCount - a.skillCount) });
      }

      if (args.action === "domain") {
        if (!args.query) return ok({ error: "domain name required" });
        const djp = path.join(SKILLS_DIR, args.query, "domain.json");
        if (!fs.existsSync(djp)) return ok({ error: `Domain '${args.query}' not found` });

        const dd = JSON.parse(fs.readFileSync(djp, "utf-8"));
        const skills: Array<{ id: string; name: string; description: string; tags: string[] }> = [];
        for (const sid of (dd.skills || [])) {
          const sp = path.join(SKILLS_DIR, args.query, sid, "skill.json");
          if (!fs.existsSync(sp)) continue;
          try {
            const s = JSON.parse(fs.readFileSync(sp, "utf-8"));
            skills.push({
              id: sid,
              name: s.name || sid,
              description: (s.description || "").slice(0, 120),
              tags: (s.tags || []).slice(0, 5),
            });
          } catch { continue; }
        }
        return ok({ domain: args.query, label: dd.name || args.query, skills });
      }

      // search — keyword matching across all skills
      if (!args.query) return ok({ error: "query required for search" });
      const filterWords = args.query.toLowerCase().split(/\s+/);
      const results: Array<{ name: string; domain: string; description: string; tags: string[]; score: number }> = [];

      const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const dir of dirs) {
        const djp = path.join(SKILLS_DIR, dir.name, "domain.json");
        if (!fs.existsSync(djp)) continue;
        let dd: any;
        try { dd = JSON.parse(fs.readFileSync(djp, "utf-8")); } catch { continue; }

        for (const sid of (dd.skills || [])) {
          const sp = path.join(SKILLS_DIR, dir.name, sid, "skill.json");
          if (!fs.existsSync(sp)) continue;
          try {
            const s = JSON.parse(fs.readFileSync(sp, "utf-8"));
            const haystack = [s.name, s.description, ...(s.tags || []), dir.name].join(" ").toLowerCase();
            const matches = filterWords.filter(f => haystack.includes(f)).length;
            if (matches === filterWords.length) {
              results.push({
                name: s.name || sid,
                domain: dd.name || dir.name,
                description: (s.description || "").slice(0, 120),
                tags: (s.tags || []).slice(0, 5),
                score: matches,
              });
            }
          } catch { continue; }
        }
      }

      results.sort((a, b) => b.score - a.score);
      return ok({ query: args.query, count: results.length, results: results.slice(0, limit) });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 5: ubik_create_workflow
// ═══════════════════════════════════════

server.tool(
  "ubik_create_workflow",
  "Create an orchestration workflow with phases and tasks. Also list/status existing workflows. Replaces @workflow shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    action: z.enum(["create", "list", "status"]).default("create").describe("create: new workflow | list: all plans | status: overview counts"),
    title: z.string().optional().describe("For create: workflow title"),
    description: z.string().optional().describe("For create: workflow description/goal"),
    phases: z.string().optional().describe("For create: JSON array of phases [{ title, tasks: [{ title, prompt, suggestedModel?, temperature?, skillId?, skillDomain?, skillName? }] }]"),
    createdBy: z.string().optional().describe("Creator identifier (default: claude)"),
  },
  async (args) => {
    try {
      if (args.action === "list") {
        const data = await ubikApi("/api/workflows");
        const plans = data.plans || [];
        return ok({
          count: plans.length,
          plans: plans.map((p: any) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            phaseCount: (p.phases || []).length,
            taskCount: (p.phases || []).reduce((sum: number, ph: any) => sum + (ph.tasks || []).length, 0),
            createdBy: p.created_by || p.createdBy,
          })),
        });
      }

      if (args.action === "status") {
        const data = await ubikApi("/api/workflows");
        const plans = data.plans || [];
        const counts: Record<string, number> = {};
        for (const p of plans) {
          counts[p.status] = (counts[p.status] || 0) + 1;
        }
        return ok({ total: plans.length, byStatus: counts });
      }

      // create
      if (!args.title || !args.phases) return ok({ error: "title and phases are required for create" });
      const phases = JSON.parse(args.phases);

      const data = await ubikApi("/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          title: args.title,
          description: args.description || "",
          createdBy: args.createdBy || "claude",
          phases,
        }),
      });

      return ok({ created: true, ...data });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 6: ubik_connector_status
// ═══════════════════════════════════════

server.tool(
  "ubik_connector_status",
  "Check OAuth connector status for a service/provider. Returns whether a valid token exists. Replaces check-connector.sh.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    service: z.string().describe("Service name: gmail, calendar, drive, outlook, linkedin, teams, onedrive, etc."),
    provider: z.enum(["google", "microsoft", "linkedin"]).default("google").describe("OAuth provider"),
  },
  async (args) => {
    try {
      const res = await fetch(
        `${UBIK_API}/api/connectors/token?service=${encodeURIComponent(args.service)}&provider=${encodeURIComponent(args.provider)}`,
        {
          headers: auth.getAuthHeaders(),
        },
      );

      if (!res.ok) {
        return ok({ service: args.service, provider: args.provider, connected: false, reason: `HTTP ${res.status}` });
      }

      const data = await res.json();
      const hasToken = !!(data.token);
      return ok({
        service: args.service,
        provider: args.provider,
        connected: hasToken,
        email: data.email || null,
      });
    } catch (err) {
      return ok({ service: args.service, provider: args.provider, connected: false, reason: "Server unreachable" });
    }
  },
);

// ═══════════════════════════════════════
// Tool 7: ubik_git_dashboard
// ═══════════════════════════════════════

server.tool(
  "ubik_git_dashboard",
  "Git Collab dashboard: project count, task breakdown by status, recent tasks with details. Enriches @git with DB-side data the MCP git tools don't expose.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    scope: z.enum(["overview", "tasks", "projects"]).default("overview").describe("overview: counts + recent | tasks: full task list | projects: project list"),
    limit: z.number().optional().describe("Max entries (default 15)"),
  },
  async (args) => {
    try {
      const limit = args.limit || 15;

      if (args.scope === "overview") {
        const projects = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM git_projects");
        const tasksByStatus = queryDb<{ status: string; c: number }>("SELECT status, COUNT(*) as c FROM git_tasks GROUP BY status");
        const totalTasks = queryOne<{ c: number }>("SELECT COUNT(*) as c FROM git_tasks");
        const recentTasks = queryDb(
          "SELECT id, title, status, assignee, reviewer, created_at FROM git_tasks ORDER BY created_at DESC LIMIT ?",
          [5]
        );

        return ok({
          projects: projects?.c ?? 0,
          totalTasks: totalTasks?.c ?? 0,
          tasksByStatus: Object.fromEntries(tasksByStatus.map(t => [t.status, t.c])),
          recentTasks,
        });
      }

      if (args.scope === "tasks") {
        const tasks = queryDb(
          "SELECT id, title, status, assignee, reviewer, description, created_at, updated_at FROM git_tasks ORDER BY created_at DESC LIMIT ?",
          [limit]
        );
        return ok({ count: tasks.length, tasks });
      }

      if (args.scope === "projects") {
        const projects = queryDb(
          "SELECT id, name, path, description, created_at FROM git_projects ORDER BY created_at DESC LIMIT ?",
          [limit]
        );
        return ok({ count: projects.length, projects });
      }

      return ok({ error: "Unknown scope" });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 8: ubik_routine_create
// ═══════════════════════════════════════

server.tool(
  "ubik_routine_create",
  "Create, start, stop, or check status of daemon routines. Replaces @routine shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    action: z.enum(["create", "stop", "status", "list"]).default("create").describe("create: new routine | stop: stop current | status: current routine state | list: all routines"),
    template: z.string().optional().describe("For create: routine template (custom, crm-pipeline, git-review, gmail-watch, outlook-watch, etc.)"),
    interval: z.string().optional().describe("For create: execution interval (e.g., '5m', '15m', '1h', '30s')"),
    prompt: z.string().optional().describe("For create: routine description/instructions"),
    model: z.string().optional().describe("For create: suggested model (claude-sonnet-4-6, gemini-2.5-flash, etc.)"),
  },
  async (args) => {
    try {
      if (args.action === "list") {
        const routines = queryDb(
          "SELECT id, name, template, interval, enabled, created_at, updated_at FROM routines ORDER BY updated_at DESC LIMIT 20"
        );
        const active = routines.filter((r: any) => r.enabled === 1);
        return ok({ total: routines.length, active: active.length, routines });
      }

      if (args.action === "status") {
        const active = queryDb("SELECT id, name, template, interval, prompt, enabled, updated_at FROM routines WHERE enabled = 1");
        return ok({ activeCount: active.length, routines: active });
      }

      if (args.action === "stop") {
        return ok({
          instruction: "Emit this block to stop the daemon:",
          block: '```ubik-routine\n{"action":"stop"}\n```',
        });
      }

      // create
      if (!args.prompt) return ok({ error: "prompt is required to describe what the routine should do" });

      return ok({
        instruction: "Emit this block to start the daemon:",
        block: `\`\`\`ubik-routine\n${JSON.stringify({
          action: "start",
          template: args.template || "custom",
          interval: args.interval || "10m",
          prompt: args.prompt,
          model: args.model || "claude-sonnet-4-6",
        }, null, 2)}\n\`\`\``,
        config: {
          template: args.template || "custom",
          interval: args.interval || "10m",
          prompt: args.prompt,
          model: args.model || "claude-sonnet-4-6",
        },
      });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 9: ubik_load_expert
// ═══════════════════════════════════════

server.tool(
  "ubik_load_expert",
  "Load an expert pattern: list available experts, or load a specific expert's systemPrompt and reference documents. Replaces @expert shell command.",
  {
    _ubikUserId: z.string().optional().describe("Internal — do not set"),
    action: z.enum(["list", "load"]).default("list").describe("list: available experts | load: get a specific expert's prompt + docs"),
    name: z.string().optional().describe("For load: expert name (e.g., 'data-analyst', 'auditeur-code', 'comptable')"),
  },
  async (args) => {
    try {
      // Discover hardcoded experts from .hooks/commands/expert-*.sh
      const hardcodedExperts: Array<{ name: string; description: string; source: string }> = [];
      if (fs.existsSync(HOOKS_DIR)) {
        const files = fs.readdirSync(HOOKS_DIR).filter(f => f.startsWith("expert-") && f.endsWith(".sh"));
        for (const f of files) {
          const name = f.replace("expert-", "").replace(".sh", "");
          const content = fs.readFileSync(path.join(HOOKS_DIR, f), "utf-8");
          const descMatch = content.match(/^#\s*@expert-\S+\s*—\s*(.+)/m);
          hardcodedExperts.push({
            name,
            description: descMatch?.[1]?.trim() || "no description",
            source: "hardcoded",
          });
        }
      }

      // Discover custom experts from API
      let customExperts: Array<{ name: string; description: string; source: string }> = [];
      try {
        const data = await ubikApi("/api/experts");
        customExperts = (data.patterns || []).map((p: any) => ({
          name: (p.name || "").replace(/\s+/g, "-").toLowerCase(),
          description: p.description || "",
          source: "custom",
        }));
      } catch { /* API unavailable */ }

      if (args.action === "list") {
        return ok({
          hardcoded: hardcodedExperts,
          custom: customExperts,
          total: hardcodedExperts.length + customExperts.length,
        });
      }

      // load specific expert
      if (!args.name) return ok({ error: "name required for load" });
      const expertName = args.name.toLowerCase();

      // Try hardcoded first — extract the protocol from the shell script
      const scriptPath = path.join(HOOKS_DIR, `expert-${expertName}.sh`);
      if (fs.existsSync(scriptPath)) {
        const content = fs.readFileSync(scriptPath, "utf-8");
        // Extract the PROTOCOL heredoc content
        const protocolMatch = content.match(/cat\s*<<'?PROTOCOL'?\n([\s\S]*?)PROTOCOL/);
        return ok({
          name: expertName,
          source: "hardcoded",
          protocol: protocolMatch?.[1]?.trim() || content,
        });
      }

      // Try custom from API
      try {
        const data = await ubikApi("/api/experts");
        const pattern = (data.patterns || []).find(
          (p: any) => (p.name || "").replace(/\s+/g, "-").toLowerCase() === expertName
        );

        if (pattern) {
          return ok({
            name: expertName,
            source: "custom",
            displayName: pattern.name,
            description: pattern.description,
            systemPrompt: pattern.systemPrompt,
            documentCount: (pattern.documents || []).length,
            documents: (pattern.documents || []).map((d: any) => ({
              name: d.name,
              contentPreview: (d.content || "").slice(0, 200),
            })),
          });
        }
      } catch { /* API unavailable */ }

      return ok({ error: `Expert '${expertName}' not found`, availableHardcoded: hardcodedExperts.map(e => e.name) });
    } catch (err) { return fail(err); }
  },
);

// ═══════════════════════════════════════
// Tool 10: Reflection emit → PlanReflectionPanel
// ═══════════════════════════════════════

server.tool(
  "ubik_reflection_emit",
  "Émettre un événement reflection vers le PlanReflectionPanel du front UBIK (thinking, plan, tool_use, etc.)",
  {
    type: z.enum(["plan_steps", "thinking", "tool_use", "tool_result", "done", "error", "user_send"]).describe("Type d'événement reflection"),
    content: z.string().optional().describe("Contenu textuel (thinking, error message, etc.)"),
    name: z.string().optional().describe("Nom de l'outil (pour tool_use/tool_result)"),
    input: z.any().optional().describe("Input de l'outil (pour tool_use)"),
    steps: z.array(z.string()).optional().describe("Liste des étapes du plan (pour plan_steps)"),
  },
  async (params) => {
    try {
      const res = await fetch(`${UBIK_API}/api/reflection`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth.getAuthHeaders() },
        body: JSON.stringify({
          ...params,
          source: "mcp-cli",
          timestamp: Date.now(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { content: [{ type: "text" as const, text: `✓ reflection:${params.type}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `✗ reflection failed: ${err.message}` }] };
    }
  },
);

// ═══════════════════════════════════════
// Server startup
// ═══════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  wrapTransportWithAuth(transport, auth);
  console.error("[ubik-system] MCP server running — 10 tools ready");
}

main().catch((err) => {
  console.error("[ubik-system] Fatal:", err);
  process.exit(1);
});
