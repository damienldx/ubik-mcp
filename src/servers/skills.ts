#!/usr/bin/env node
/**
 * skills MCP server — local SQLite-backed context store + read-only DB inspection.
 *
 * Tools (9):
 *   - skills_outline_file      Returns a structural outline of a source file.
 *   - skills_save_context      Upserts a (key, content) pair in the local store.
 *   - skills_read_context      Returns content for a given key.
 *   - skills_list_context      Lists keys, optionally filtered by prefix.
 *   - skills_query_database    Runs a read-only SELECT against an external SQLite file.
 *   - skills_analyze_schema    Returns tables, columns, and indexes of an external SQLite file.
 *   - skills_search_tools      BM25 keyword search over gateway tool catalog.
 *   - skills_add_skill         Upserts a skill in the local skill library.
 *   - skills_recall            Semantic (or keyword fallback) search over skill library.
 *
 * Storage: ~/.ubik-mcp/skills.db — auto-seeded from data/skills-seed.json on first start.
 * Vectors: skill_vectors table populated async on first start via all-MiniLM-L6-v2.
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, better-sqlite3, @xenova/transformers, node:* only.
 */
import { z } from "zod";
import { config } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import Database from "better-sqlite3";
import { createMcpServer, runServer } from "../lib/server.js";

config({ path: path.join(process.cwd(), ".env") });

const STORE_DIR  = path.join(os.homedir(), ".ubik-mcp");
const STORE_PATH = path.join(STORE_DIR, "skills.db");

// Seed file bundled in the repo — resolved relative to this source file.
const SEED_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "../../data/skills-seed.json");

let _store: Database.Database | null = null;

function seedIfEmpty(db: Database.Database): void {
  if (!fs.existsSync(SEED_PATH)) return;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM context WHERE key LIKE 'skill/%'").get() as { n: number }).n;
  if (count > 0) return;

  try {
    const raw   = fs.readFileSync(SEED_PATH, "utf-8");
    const data  = JSON.parse(raw) as { skills: Array<{ id: string; domain: string; name: string; description: string; system_prompt: string; tools: string[]; tags: string[] }> };
    const now   = new Date().toISOString();
    const upsert = db.prepare(
      "INSERT INTO context (key, content, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING"
    );
    const seedAll = db.transaction((skills: typeof data.skills) => {
      for (const s of skills) {
        const key     = `skill/${s.domain}/${s.id}`;
        const content = JSON.stringify({ name: s.name, domain: s.domain, description: s.description, system_prompt: s.system_prompt, tools: s.tools, tags: s.tags });
        upsert.run(key, content, now, now);
      }
    });
    seedAll(data.skills);
    process.stderr.write(`[ubik-skills] seeded ${data.skills.length} skills from bundled data\n`);
  } catch {
    // Non-fatal: seed failure doesn't break the server
  }
}

function getStore(): Database.Database {
  if (_store) return _store;
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  const db = new Database(STORE_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS context (
      key        TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_vectors (
      key TEXT PRIMARY KEY,
      vec BLOB NOT NULL
    )
  `);
  seedIfEmpty(db);
  _store = db;
  return db;
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM   = 384;

type EmbedFn = (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>;
let _embedder: EmbedFn | null = null;
let _embedderReady             = false;
let _embedderLoading           = false;

async function loadEmbedder(): Promise<EmbedFn | null> {
  if (_embedder) return _embedder;
  if (_embedderLoading) return null;
  _embedderLoading = true;
  try {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache  = false;
    const pipe    = await pipeline("feature-extraction", EMBED_MODEL);
    _embedder      = pipe as unknown as EmbedFn;
    _embedderReady = true;
    process.stderr.write(`[ubik-skills] embedder ready (${EMBED_MODEL})\n`);
    return _embedder;
  } catch (err) {
    process.stderr.write(`[ubik-skills] embedder unavailable: ${err}\n`);
    return null;
  } finally {
    _embedderLoading = false;
  }
}

async function embedText(text: string): Promise<Float32Array | null> {
  const fn = await loadEmbedder();
  if (!fn) return null;
  try {
    const out = await fn(text, { pooling: "mean", normalize: true });
    return out.data;
  } catch {
    return null;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Agent manifest helpers ───────────────────────────────────────────────────

function extractAgentMarkdown(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: string };
    return parsed?.content ?? content;
  } catch { return content; }
}

type AgentFrontmatter = {
  id?: string; name?: string; role?: string; description?: string;
  autonomy?: string; reports_to?: string;
  tools_engine?: string[]; tools_client?: string[];
  guardrails?: Record<string, string | number | string[]>;
  tags?: string[];
};

function parseAgentFrontmatter(md: string): AgentFrontmatter {
  const out: AgentFrontmatter = {};
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return out;
  const scalar = (key: string) => fm.match(new RegExp(`^${key}\\s*:\\s*(?:"([^"]*)"|(.+?))\\s*$`, "m"))?.[1] ?? fm.match(new RegExp(`^${key}\\s*:\\s*(?:"([^"]*)"|(.+?))\\s*$`, "m"))?.[2];
  const strList = (key: string): string[] => {
    const block = fm.match(new RegExp(`^${key}\\s*:\\s*\\n((?:\\s+-[^\\n]+\\n?)+)`, "m"))?.[1];
    if (block) return block.match(/- (.+)/g)?.map((s) => s.slice(2).trim()) ?? [];
    const inline = fm.match(new RegExp(`^${key}\\s*:\\s*\\[([^\\]]+)\\]`, "m"))?.[1];
    if (inline) return inline.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    return [];
  };
  out.id          = scalar("id");
  out.name        = scalar("name");
  out.role        = scalar("role");
  out.autonomy    = scalar("autonomy");
  out.reports_to  = scalar("reports_to");
  out.tags        = strList("tags");
  out.tools_engine = strList("tools_engine");
  out.tools_client = strList("tools_client");
  const descBlock = fm.match(/^description\s*:\s*>\s*\n((?:\s+.+\n?)+)/m)?.[1];
  out.description = descBlock
    ? descBlock.split("\n").map((s) => s.trim()).filter(Boolean).join(" ")
    : scalar("description");
  return out;
}

function embeddableTextFor(key: string, content: string): string {
  if (key.startsWith("skill/")) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(content); } catch { /**/ }
    return [p.name ?? "", p.description ?? "", ((p.tags as string[]) ?? []).join(" ")].join(" ").trim();
  }
  if (key.startsWith("agent/")) {
    const md = extractAgentMarkdown(content);
    const fm = parseAgentFrontmatter(md);
    return [fm.name ?? "", fm.role ?? "", fm.description ?? ""].filter(Boolean).join(" ").trim() || md.slice(0, 600);
  }
  return content.slice(0, 600);
}

// ─────────────────────────────────────────────────────────────────────────────

async function seedVectorsIfEmpty(): Promise<void> {
  const db       = getStore();
  const vecCount = (db.prepare("SELECT COUNT(*) AS n FROM skill_vectors").get() as { n: number }).n;
  const sklCount = (db.prepare("SELECT COUNT(*) AS n FROM context WHERE key LIKE 'skill/%'").get() as { n: number }).n;
  const agtCount = (db.prepare("SELECT COUNT(*) AS n FROM context WHERE key LIKE 'agent/%'").get() as { n: number }).n;
  const target   = sklCount + agtCount;
  if (vecCount >= target && target > 0) return;

  const embedder = await loadEmbedder();
  if (!embedder) return;

  const rows = db.prepare(
    "SELECT key, content FROM context WHERE key LIKE 'skill/%' OR key LIKE 'agent/%'"
  ).all() as { key: string; content: string }[];

  if (rows.length === 0) return;
  process.stderr.write(`[ubik-skills] generating vectors for ${rows.length} entries (skills + agents)...\n`);

  const insert     = db.prepare("INSERT OR REPLACE INTO skill_vectors (key, vec) VALUES (?, ?)");
  const batchWrite = db.transaction((batch: Array<{ key: string; vec: Buffer }>) => {
    for (const r of batch) insert.run(r.key, r.vec);
  });

  const BATCH = 64;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const out: Array<{ key: string; vec: Buffer }> = [];
    for (const r of chunk) {
      try {
        const text = embeddableTextFor(r.key, r.content);
        if (!text) continue;
        const vec = await embedText(text);
        if (vec) out.push({ key: r.key, vec: Buffer.from(vec.buffer) });
      } catch { /**/ }
    }
    if (out.length) batchWrite(out);
    if (i % (BATCH * 8) === 0 && i > 0) {
      process.stderr.write(`[ubik-skills] vectors: ${i}/${rows.length}\n`);
    }
  }
  process.stderr.write(`[ubik-skills] vector seed complete (${rows.length} entries)\n`);
}

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

const server = createMcpServer("ubik-skills");

// Eager init — triggers auto-seed on first install before any tool call.
getStore();
// Background: load embedder + generate skill vectors (non-blocking).
seedVectorsIfEmpty().catch(() => {});

server.tool(
  "skills_outline_file",
  "Returns a structural outline of a source file: top-level functions, classes, exports, and imports. Heuristic regex-based — best on JS, TS, Python, Go.",
  {
    path: z.string().describe("Absolute or workspace-relative path to the file"),
    maxLines: z.number().int().positive().optional().describe("Hard cap on lines scanned (default 5000)"),
  },
  async (args) => {
    try {
      const filePath = path.isAbsolute(args.path)
        ? args.path
        : path.join(process.cwd(), args.path);
      if (!fs.existsSync(filePath)) {
        return fail(new Error(`File not found: ${filePath}`));
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return fail(new Error(`Not a regular file: ${filePath}`));

      const cap = args.maxLines ?? 5000;
      const text = fs.readFileSync(filePath, "utf-8");
      const lines = text.split(/\r?\n/).slice(0, cap);

      const imports: { line: number; text: string }[] = [];
      const exports: { line: number; text: string }[] = [];
      const functions: { line: number; name: string; signature: string }[] = [];
      const classes: { line: number; name: string }[] = [];

      const fnPatterns: RegExp[] = [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
        /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
        /^\s*def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:/,
        /^\s*func\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/,
      ];
      const classPatterns: RegExp[] = [
        /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
        /^\s*class\s+([A-Za-z_][\w]*)/,
        /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/,
      ];

      lines.forEach((raw, i) => {
        const line = i + 1;
        const trimmed = raw.trim();
        if (!trimmed) return;

        if (/^(?:import |from\s+\S+\s+import\s)/.test(trimmed) || /^\s*const\s+\w+\s*=\s*require\(/.test(raw)) {
          imports.push({ line, text: trimmed });
          return;
        }
        if (/^export\s/.test(trimmed) && !/^export\s+(?:default\s+)?(?:class|function|const|interface)\b/.test(trimmed)) {
          exports.push({ line, text: trimmed });
        }

        for (const re of fnPatterns) {
          const m = raw.match(re);
          if (m) {
            functions.push({ line, name: m[1], signature: m[0].trim() });
            return;
          }
        }
        for (const re of classPatterns) {
          const m = raw.match(re);
          if (m) {
            classes.push({ line, name: m[1] });
            return;
          }
        }
      });

      return ok({
        path: filePath,
        lineCount: lines.length,
        truncated: text.split(/\r?\n/).length > cap,
        imports,
        exports,
        functions,
        classes,
      });
    } catch (err) { return fail(err); }
  },
);

server.tool(
  "skills_save_context",
  "Upserts a (key, content) pair in the local SQLite context store.",
  {
    key:     z.string().min(1).describe("Unique key. Convention: namespace/identifier (e.g. 'project/ubik-mcp/notes')"),
    content: z.string().describe("Free-form content (markdown, JSON, raw text). Stored as-is."),
  },
  async (args) => {
    try {
      const db = getStore();
      const now = new Date().toISOString();
      const existing = db.prepare("SELECT key FROM context WHERE key = ?").get(args.key);
      if (existing) {
        db.prepare("UPDATE context SET content = ?, updated_at = ? WHERE key = ?")
          .run(args.content, now, args.key);
      } else {
        db.prepare("INSERT INTO context (key, content, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(args.key, args.content, now, now);
      }
      return ok({ saved: true, key: args.key, length: args.content.length, replaced: !!existing });
    } catch (err) { return fail(err); }
  },
);

server.tool(
  "skills_read_context",
  "Returns content for a given key from the local SQLite context store.",
  {
    key: z.string().min(1).describe("Key to read"),
  },
  async (args) => {
    try {
      const db = getStore();
      const row = db.prepare("SELECT key, content, created_at, updated_at FROM context WHERE key = ?").get(args.key) as
        | { key: string; content: string; created_at: string; updated_at: string }
        | undefined;
      if (!row) return ok({ found: false, key: args.key });
      return ok(row);
    } catch (err) { return fail(err); }
  },
);

server.tool(
  "skills_list_context",
  "Lists keys in the local SQLite context store, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Prefix filter applied to the start of the key"),
    limit:  z.number().int().positive().optional().describe("Max entries returned (default 100)"),
  },
  async (args) => {
    try {
      const db = getStore();
      const limit = args.limit ?? 100;
      let rows: { key: string; updated_at: string; size: number }[];
      if (args.prefix) {
        rows = db.prepare(
          "SELECT key, updated_at, length(content) AS size FROM context WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?"
        ).all(`${args.prefix}%`, limit) as typeof rows;
      } else {
        rows = db.prepare(
          "SELECT key, updated_at, length(content) AS size FROM context ORDER BY updated_at DESC LIMIT ?"
        ).all(limit) as typeof rows;
      }
      return ok({ count: rows.length, entries: rows });
    } catch (err) { return fail(err); }
  },
);

server.tool(
  "skills_query_database",
  "Runs a read-only SELECT against an external SQLite file. Refuses non-SELECT statements and multiple statements.",
  {
    path:   z.string().describe("Absolute path to the SQLite database file"),
    query:  z.string().describe("Single SELECT statement"),
    params: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe("Bound parameters for the SELECT"),
    limit:  z.number().int().positive().optional().describe("Max rows returned (default 200)"),
  },
  async (args) => {
    try {
      const trimmed = args.query.trim().replace(/;+\s*$/, "");
      if (!/^select\b/i.test(trimmed)) {
        return fail(new Error("skills_query_database refuses non-SELECT statements"));
      }
      if (/;/.test(trimmed)) {
        return fail(new Error("Only a single statement is allowed"));
      }
      if (!fs.existsSync(args.path)) return fail(new Error(`Database not found: ${args.path}`));

      const db = new Database(args.path, { readonly: true });
      try {
        const stmt = db.prepare(trimmed);
        const rows = stmt.all(...(args.params ?? [])) as Record<string, unknown>[];
        const cap = args.limit ?? 200;
        return ok({ rowCount: rows.length, truncated: rows.length > cap, rows: rows.slice(0, cap) });
      } finally {
        db.close();
      }
    } catch (err) { return fail(err); }
  },
);

server.tool(
  "skills_analyze_schema",
  "Returns tables, columns, indexes, and row counts of an external SQLite file. Read-only.",
  {
    path: z.string().describe("Absolute path to the SQLite database file"),
  },
  async (args) => {
    try {
      if (!fs.existsSync(args.path)) return fail(new Error(`Database not found: ${args.path}`));
      const db = new Database(args.path, { readonly: true });
      try {
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all() as { name: string }[];

        const result = tables.map((t) => {
          const tn = `"${t.name.replace(/"/g, '""')}"`;
          const columns = db.prepare(`PRAGMA table_info(${tn})`).all() as Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: unknown;
            pk: number;
          }>;
          const indexes = db.prepare(`PRAGMA index_list(${tn})`).all() as Array<{
            name: string;
            unique: number;
          }>;
          let rowCount: number | null = null;
          try {
            const r = db.prepare(`SELECT COUNT(*) AS c FROM ${tn}`).get() as { c: number } | undefined;
            rowCount = r?.c ?? null;
          } catch {
            rowCount = null;
          }
          return { table: t.name, columns, indexes, rowCount };
        });

        return ok({ path: args.path, tableCount: result.length, schema: result });
      } finally {
        db.close();
      }
    } catch (err) { return fail(err); }
  },
);

// ─── skills_search_tools ─────────────────────────────────────────────────────
server.tool(
  "skills_search_tools",
  "Searches the ubik-mcp gateway tool catalog by keyword. Returns the most relevant tools with their server and description. Useful for discovering which tool to use for a given task.",
  {
    query:   z.string().min(1).describe("Space-separated keywords to search across tool names and descriptions"),
    limit:   z.number().int().positive().optional().describe("Max results returned (default 10)"),
    gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:8910)"),
  },
  async (args) => {
    try {
      const base  = (args.gateway ?? "http://127.0.0.1:8910").replace(/\/$/, "");
      const res   = await fetch(`${base}/tools`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return fail(new Error(`Gateway /tools returned ${res.status}`));

      const catalog = await res.json() as {
        totalTools: number;
        tools: Array<{ server: string; name: string; description: string }>;
      };

      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const limit = args.limit ?? 10;

      type Hit = { server: string; name: string; description: string; score: number };
      const hits: Hit[] = [];

      for (const tool of catalog.tools) {
        const score = terms.reduce((acc, t) => {
          // name match = weight 2, description match = weight 1
          const inName = tool.name.toLowerCase().includes(t) ? 2 : 0;
          const inDesc = tool.description.toLowerCase().includes(t) ? 1 : 0;
          return acc + inName + inDesc;
        }, 0);
        if (score > 0) hits.push({ server: tool.server, name: tool.name, description: tool.description, score });
      }

      hits.sort((a, b) => b.score - a.score);

      return ok({
        query:       args.query,
        totalTools:  catalog.totalTools,
        resultCount: Math.min(hits.length, limit),
        results:     hits.slice(0, limit).map(h => ({
          server:      h.server,
          name:        h.name,
          description: h.description,
          score:       h.score,
        })),
        tip: hits.length === 0
          ? "No matches found. Try broader terms or use skills_list_context with prefix 'tools/' to browse the catalog."
          : undefined,
      });
    } catch (err) { return fail(err); }
  },
);

// ─── skills_add_skill ────────────────────────────────────────────────────────
server.tool(
  "skills_add_skill",
  "Adds or updates a skill in the local skill library (~/.ubik-mcp/skills.db). Skills define specialist personas that agents can adopt for specific mission types. No external dependency.",
  {
    id:            z.string().min(1).describe("Unique skill identifier, e.g. 'api-security-auditor'"),
    domain:        z.string().min(1).describe("Skill domain, e.g. 'security', 'devops', 'frontend'"),
    name:          z.string().min(1).describe("Human-readable skill name"),
    description:   z.string().describe("What this skill does and when to use it (1-3 sentences)"),
    system_prompt: z.string().describe("Persona instructions for the agent adopting this skill"),
    tools:         z.array(z.string()).optional().describe("MCP tool names this skill relies on"),
    tags:          z.array(z.string()).optional().describe("Searchable tags"),
  },
  async (args) => {
    try {
      const db  = getStore();
      const key = `skill/${args.domain}/${args.id}`;
      const content = JSON.stringify({
        name:          args.name,
        domain:        args.domain,
        description:   args.description,
        system_prompt: args.system_prompt,
        tools:         args.tools ?? [],
        tags:          args.tags  ?? [],
      });
      const now      = new Date().toISOString();
      const existing = db.prepare("SELECT key FROM context WHERE key = ?").get(key);
      if (existing) {
        db.prepare("UPDATE context SET content = ?, updated_at = ? WHERE key = ?").run(content, now, key);
      } else {
        db.prepare("INSERT INTO context (key, content, created_at, updated_at) VALUES (?, ?, ?, ?)").run(key, content, now, now);
      }
      return ok({ saved: true, key, name: args.name, domain: args.domain, replaced: !!existing });
    } catch (err) { return fail(err); }
  },
);

// ─── skills_recall ────────────────────────────────────────────────────────────
server.tool(
  "skills_recall",
  "Searches the local skill library by keyword. Returns matching skills with name, description, system_prompt, and tools list. Use at mission start to adopt a specialist persona and multiply output quality.",
  {
    query:  z.string().min(1).describe("Keywords describing what you're about to do, e.g. 'security audit api' or 'github pull request review'"),
    domain: z.string().optional().describe("Restrict search to a domain, e.g. 'security', 'devops'"),
    limit:  z.number().int().positive().optional().describe("Max results (default 5)"),
  },
  async (args) => {
    try {
      const db     = getStore();
      const limit  = args.limit ?? 5;
      const prefix = args.domain ? `skill/${args.domain}/` : "skill/";

      type Hit = {
        key: string; name: string; domain: string;
        description: string; system_prompt: string;
        tools: string[]; tags: string[]; score: number;
      };

      function parseSkill(key: string, content: string): Record<string, unknown> {
        try { return JSON.parse(content); } catch { return { description: content }; }
      }

      function toHit(key: string, parsed: Record<string, unknown>, score: number): Hit {
        return {
          key,
          name:          String(parsed.name          ?? key),
          domain:        String(parsed.domain        ?? ""),
          description:   String(parsed.description   ?? "").slice(0, 300),
          system_prompt: String(parsed.system_prompt ?? "").slice(0, 600),
          tools:         (parsed.tools as string[])  ?? [],
          tags:          (parsed.tags  as string[])  ?? [],
          score,
        };
      }

      // ── Semantic path ────────────────────────────────────────────────────────
      const vecCount = (db.prepare("SELECT COUNT(*) AS n FROM skill_vectors").get() as { n: number }).n;
      if (vecCount > 0 && _embedderReady && _embedder) {
        const qvec = await embedText(args.query);
        if (qvec) {
          const vecRows = db.prepare(
            "SELECT sv.key, sv.vec, c.content FROM skill_vectors sv JOIN context c ON c.key = sv.key WHERE sv.key LIKE ?"
          ).all(`${prefix}%`) as { key: string; vec: Buffer; content: string }[];

          const ranked = vecRows
            .map((r) => {
              const vec  = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
              const sim  = cosine(qvec, vec);
              return { key: r.key, content: r.content, score: sim };
            })
            .filter((r) => r.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

          const hits = ranked.map((r) => toHit(r.key, parseSkill(r.key, r.content), r.score));

          return ok({
            query:       args.query,
            mode:        "semantic",
            resultCount: hits.length,
            results:     hits.map(({ score: _s, ...h }) => h),
            tip: hits.length === 0
              ? "No semantic matches. Try different keywords or broaden your query."
              : undefined,
          });
        }
      }

      // ── Keyword fallback ─────────────────────────────────────────────────────
      const rows = db.prepare(
        "SELECT key, content FROM context WHERE key LIKE ? ORDER BY updated_at DESC LIMIT 500"
      ).all(`${prefix}%`) as { key: string; content: string }[];

      if (rows.length === 0) {
        return ok({ query: args.query, mode: "keyword", resultCount: 0, results: [],
          tip: "Skill library is empty. Populate it with skills_add_skill." });
      }

      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: Hit[] = [];

      for (const row of rows) {
        const parsed = parseSkill(row.key, row.content);
        const hay    = [row.key, parsed.name ?? "", parsed.domain ?? "",
                        parsed.description ?? "", JSON.stringify(parsed.tags ?? [])].join(" ").toLowerCase();
        const score  = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
        if (score === 0) continue;
        hits.push(toHit(row.key, parsed, score));
      }

      hits.sort((a, b) => b.score - a.score);

      return ok({
        query:       args.query,
        mode:        vecCount === 0 ? "keyword (vectors not ready yet)" : "keyword",
        resultCount: Math.min(hits.length, limit),
        results:     hits.slice(0, limit).map(({ score: _s, ...h }) => h),
        tip: hits.length === 0
          ? "No matches. Try broader keywords or list domains with skills_list_context(prefix='skill/')."
          : undefined,
      });
    } catch (err) { return fail(err); }
  },
);

// ── agent_search ─────────────────────────────────────────────────────────────

server.tool(
  "agent_search",
  "Returns a shortlist of bundled agents (data/agents/*.md) matching a mission description. Semantic search via vectors (same table as skills_recall) when available, keyword fallback otherwise. Each result includes autonomy, tools_count, guardrails, and a recommended_action so the caller can pick without reading every manifest.",
  {
    mission:  z.string().min(1).describe("What you're about to do — free-form, e.g. 'review a GitHub PR', 'tune database performance'."),
    top_k:    z.number().int().min(1).max(20).default(5).describe("Max candidates to return (default 5)."),
    autonomy: z.enum(["supervised", "autonomous"]).optional().describe("Filter by autonomy level."),
  },
  async (args) => {
    try {
      const db    = getStore();
      const top_k = args.top_k ?? 5;

      type Hit = {
        id: string; name: string; role: string; description: string;
        autonomy: string; tools_count: number;
        guardrails: Record<string, string | number | string[]>;
        score: number; recommended_action: "train_now" | "explore" | "skip_train";
      };

      function rowToHit(key: string, content: string, score: number): Hit {
        const md   = extractAgentMarkdown(content);
        const fm   = parseAgentFrontmatter(md);
        const tools = [...(fm.tools_engine ?? []), ...(fm.tools_client ?? [])];
        return {
          id:           fm.id ?? key.slice("agent/".length),
          name:         fm.name ?? "",
          role:         fm.role ?? "",
          description:  (fm.description ?? "").slice(0, 280),
          autonomy:     fm.autonomy ?? "",
          tools_count:  tools.length,
          guardrails:   fm.guardrails ?? {},
          score,
          recommended_action: "explore",
        };
      }

      function computeRecommended(hits: Hit[]): void {
        if (hits.length === 0) return;
        const top  = hits[0].score;
        const sum3 = hits.slice(0, 3).reduce((a, h) => a + h.score, 0);
        const ratio = sum3 > 0 ? top / sum3 : 0;
        hits[0].recommended_action = ratio >= 0.45 ? "train_now" : ratio >= 0.30 ? "explore" : "skip_train";
      }

      // Semantic path
      const vecCount = (db.prepare(
        "SELECT COUNT(*) AS n FROM skill_vectors WHERE key LIKE 'agent/%'"
      ).get() as { n: number }).n;

      if (vecCount > 0 && _embedderReady && _embedder) {
        const qvec = await embedText(args.mission);
        if (qvec) {
          const rows = db.prepare(
            "SELECT sv.key, sv.vec, c.content FROM skill_vectors sv JOIN context c ON c.key = sv.key WHERE sv.key LIKE 'agent/%'"
          ).all() as { key: string; vec: Buffer; content: string }[];

          const ranked = rows
            .map((r) => {
              const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
              return { key: r.key, content: r.content, score: cosine(qvec, v) };
            })
            .filter((r) => r.score > 0.18)
            .sort((a, b) => b.score - a.score);

          const hits: Hit[] = [];
          for (const r of ranked) {
            const h = rowToHit(r.key, r.content, r.score);
            if (args.autonomy && h.autonomy && h.autonomy !== args.autonomy) continue;
            hits.push(h);
            if (hits.length >= top_k) break;
          }
          computeRecommended(hits);
          return ok({
            mission: args.mission, mode: "semantic", result_count: hits.length, results: hits,
            tip: hits[0]?.recommended_action === "train_now"
              ? `Top match is strong — call agent_train(id="${hits[0].id}") to load the manifest.`
              : hits.length ? "Multiple candidates — review the shortlist before training." : "No matches. Broaden the query.",
          });
        }
      }

      // Keyword fallback
      const all   = db.prepare("SELECT key, content FROM context WHERE key LIKE 'agent/%'").all() as { key: string; content: string }[];
      const terms = args.mission.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
      const scored: Hit[] = [];
      for (const r of all) {
        const md  = extractAgentMarkdown(r.content);
        const fm  = parseAgentFrontmatter(md);
        const hay = [r.key, fm.name ?? "", fm.role ?? "", fm.description ?? ""].join(" ").toLowerCase();
        const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
        if (score === 0) continue;
        const h = rowToHit(r.key, r.content, score);
        if (args.autonomy && h.autonomy && h.autonomy !== args.autonomy) continue;
        scored.push(h);
      }
      scored.sort((a, b) => b.score - a.score);
      const hits = scored.slice(0, top_k);
      computeRecommended(hits);
      return ok({
        mission: args.mission, mode: "keyword (agent vectors not ready yet)",
        result_count: hits.length, results: hits,
        tip: hits[0]?.recommended_action === "train_now"
          ? `Call agent_train(id="${hits[0].id}") to load the manifest.`
          : hits.length ? "Multiple candidates — review before training." : "No matches.",
      });
    } catch (err) { return fail(err); }
  },
);

// ── agent_train ───────────────────────────────────────────────────────────────

server.tool(
  "agent_train",
  "Loads the full markdown manifest of a bundled agent by id (from agent_search). Returns the raw manifest, parsed metadata, adoption instructions, and exit criteria. Inject the manifest body as your operating identity for the current mission.",
  {
    id:      z.string().min(1).describe("Agent id — from agent_search results."),
    mission: z.string().optional().describe("Optional mission echo included in the activation banner."),
  },
  async (args) => {
    try {
      const db  = getStore();
      const key = `agent/${args.id}`;
      const row = db.prepare("SELECT content FROM context WHERE key = ?").get(key) as { content: string } | undefined;

      if (!row) {
        const available = (db.prepare("SELECT key FROM context WHERE key LIKE 'agent/%' LIMIT 10").all() as { key: string }[])
          .map((r) => r.key.slice("agent/".length));
        return fail(`Agent "${args.id}" not found. Available (sample): ${available.join(", ")}`);
      }

      const md = extractAgentMarkdown(row.content);
      const fm = parseAgentFrontmatter(md);

      const title = fm.name ?? fm.role ?? args.id;
      const missionLine = args.mission ? `\nMission: ${args.mission}` : "";

      const output = [
        `🧠 Agent activation — ${title}${missionLine}`,
        `Autonomy: ${fm.autonomy ?? "unspecified"} | Tools: ${[...(fm.tools_engine ?? []), ...(fm.tools_client ?? [])].length}`,
        "",
        "--- MANIFEST BEGIN ---",
        md,
        "--- MANIFEST END ---",
        "",
        "📋 Adoption instructions:",
        "1. Treat the manifest body as your operating system prompt for this mission.",
        "2. Respect guardrail limits (max_steps, scope, escalation rules) as hard constraints.",
        "3. Route tool calls through the declared engine/client channels.",
        "4. Follow any workflow steps defined in the manifest body in order.",
        "",
        "🚪 Exit criteria (when to release this persona):",
        "• Mission delivered and acknowledged.",
        "• Domain drift detected for ≥ 2 consecutive turns — retag explicitly.",
        "• Explicit retag instruction from orchestrator.",
      ].join("\n");

      return ok({
        id:       args.id,
        name:     fm.name,
        role:     fm.role,
        autonomy: fm.autonomy,
        tags:     fm.tags,
        tools:    { engine: fm.tools_engine ?? [], client: fm.tools_client ?? [] },
        guardrails: fm.guardrails ?? {},
        manifest: output,
        raw_md:   md,
      });
    } catch (err) { return fail(err); }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-skills] fatal: ${err}\n`);
  process.exit(1);
});
