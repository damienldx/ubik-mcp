#!/usr/bin/env node
/**
 * system MCP server — runtime status + local skill catalog search.
 *
 * Tools (2):
 *   - system_status         Returns runtime status (uptime, version, memory, env subset).
 *   - system_search_skills  Searches a local JSON skill catalog by keyword.
 *
 * Skill catalog format: an array of {id, name, description, tags[]}, or
 * {skills: [...]}, or {entries: [...]}. Path defaults to UBIK_SKILLS_JSON
 * (env) or ~/.ubik-mcp/skills.json.
 *
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, node:* only.
 */
import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createMcpServer, runServer } from "../lib/server.js";

config({ path: path.join(process.cwd(), ".env") });

const PKG_VERSION = (() => {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return pkg.version || "unknown";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
})();

const DEFAULT_SKILL_CATALOG = process.env.UBIK_SKILLS_JSON
  ?? path.join(os.homedir(), ".ubik-mcp", "skills.json");

const SAFE_ENV_KEYS = [
  "NODE_ENV",
  "UBIK_BASE_URL",
  "UBIK_SKILLS_JSON",
  "PORT",
  "HOSTNAME",
  "LANG",
];

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

const server = createMcpServer("ubik-system");

server.tool(
  "system_status",
  "Returns runtime status: uptime, version, node version, memory usage, and a curated subset of env vars (no secrets).",
  {
    includeEnv: z.boolean().optional().describe("Include the curated env-var subset (default true)"),
  },
  async (args) => {
    try {
      const includeEnv = args.includeEnv ?? true;
      const mem = process.memoryUsage();
      const env: Record<string, string | undefined> = {};
      if (includeEnv) {
        for (const k of SAFE_ENV_KEYS) {
          if (process.env[k] !== undefined) env[k] = process.env[k];
        }
      }
      return ok({
        version:   PKG_VERSION,
        node:      process.version,
        platform:  process.platform,
        arch:      process.arch,
        pid:       process.pid,
        uptimeSec: Math.round(process.uptime()),
        cwd:       process.cwd(),
        memoryMB: {
          rss:       Math.round(mem.rss / (1024 * 1024)),
          heapTotal: Math.round(mem.heapTotal / (1024 * 1024)),
          heapUsed:  Math.round(mem.heapUsed / (1024 * 1024)),
          external:  Math.round(mem.external / (1024 * 1024)),
        },
        env,
      });
    } catch (err) { return fail(err); }
  },
);

interface SkillEntry {
  id?:          string;
  name?:        string;
  description?: string;
  tags?:        string[];
  domain?:      string;
  [key: string]: unknown;
}

function loadCatalog(filePath: string): SkillEntry[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill catalog not found: ${filePath}. Set UBIK_SKILLS_JSON or create the file.`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Skill catalog is not valid JSON: ${filePath}`);
  }
  if (Array.isArray(data)) return data as SkillEntry[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.skills))  return obj.skills as SkillEntry[];
    if (Array.isArray(obj.entries)) return obj.entries as SkillEntry[];
  }
  throw new Error(`Skill catalog must be an array or {skills|entries: array}, got ${typeof data}`);
}

server.tool(
  "system_search_skills",
  "Searches the local skill catalog by keyword. All terms must match (AND) across name, description, tags, and domain. Matches in name are scored higher.",
  {
    query:   z.string().min(1).describe("Whitespace-separated keywords (case-insensitive AND match)"),
    catalog: z.string().optional().describe(`Override catalog path (default: ${DEFAULT_SKILL_CATALOG})`),
    limit:   z.number().int().positive().optional().describe("Max results returned (default 20)"),
  },
  async (args) => {
    try {
      const filePath = args.catalog ?? DEFAULT_SKILL_CATALOG;
      const entries = loadCatalog(filePath);
      const limit = args.limit ?? 20;
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);

      type Hit = { entry: SkillEntry; score: number };
      const hits: Hit[] = [];

      for (const entry of entries) {
        const haystack = [
          entry.id ?? "",
          entry.name ?? "",
          entry.description ?? "",
          entry.domain ?? "",
          ...(Array.isArray(entry.tags) ? entry.tags : []),
        ].join(" ").toLowerCase();

        let matches = 0;
        for (const t of terms) if (haystack.includes(t)) matches++;
        if (matches === terms.length) {
          const nameHay = `${entry.name ?? ""} ${entry.id ?? ""}`.toLowerCase();
          const nameBoost = terms.filter((t) => nameHay.includes(t)).length;
          hits.push({ entry, score: matches + nameBoost });
        }
      }

      hits.sort((a, b) => b.score - a.score);

      return ok({
        catalog:     filePath,
        catalogSize: entries.length,
        query:       args.query,
        count:       hits.length,
        results: hits.slice(0, limit).map((h) => ({
          id:          h.entry.id ?? null,
          name:        h.entry.name ?? null,
          domain:      h.entry.domain ?? null,
          description: typeof h.entry.description === "string"
            ? h.entry.description.slice(0, 240)
            : null,
          tags:  Array.isArray(h.entry.tags) ? h.entry.tags.slice(0, 8) : [],
          score: h.score,
        })),
      });
    } catch (err) { return fail(err); }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-system] fatal: ${err}\n`);
  process.exit(1);
});
