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

async function seedVectorsIfEmpty(): Promise<void> {
  const db       = getStore();
  const vecCount = (db.prepare("SELECT COUNT(*) AS n FROM skill_vectors").get() as { n: number }).n;
  const sklCount = (db.prepare("SELECT COUNT(*) AS n FROM context WHERE key LIKE 'skill/%'").get() as { n: number }).n;
  if (vecCount >= sklCount && sklCount > 0) return;

  const embedder = await loadEmbedder();
  if (!embedder) return;

  const skills = db.prepare("SELECT key, content FROM context WHERE key LIKE 'skill/%'")
    .all() as { key: string; content: string }[];

  if (skills.length === 0) return;
  process.stderr.write(`[ubik-skills] generating vectors for ${skills.length} skills...\n`);

  const insert     = db.prepare("INSERT OR REPLACE INTO skill_vectors (key, vec) VALUES (?, ?)");
  const batchWrite = db.transaction((rows: Array<{ key: string; vec: Buffer }>) => {
    for (const r of rows) insert.run(r.key, r.vec);
  });

  const BATCH = 64;
  for (let i = 0; i < skills.length; i += BATCH) {
    const chunk = skills.slice(i, i + BATCH);
    const rows: Array<{ key: string; vec: Buffer }> = [];
    for (const s of chunk) {
      try {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(s.content); } catch { /**/ }
        const text = [parsed.name ?? "", parsed.description ?? "", (parsed.tags as string[] ?? []).join(" ")]
          .join(" ").trim();
        const vec = await embedText(text);
        if (vec) rows.push({ key: s.key, vec: Buffer.from(vec.buffer) });
      } catch { /**/ }
    }
    if (rows.length) batchWrite(rows);
    if (i % (BATCH * 8) === 0 && i > 0) {
      process.stderr.write(`[ubik-skills] vectors: ${i}/${skills.length}\n`);
    }
  }
  process.stderr.write(`[ubik-skills] vector seed complete (${skills.length} skills)\n`);
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
    gateway: z.string().optional().describe("Gateway base URL (default http://127.0.0.1:8902)"),
  },
  async (args) => {
    try {
      const base  = (args.gateway ?? "http://127.0.0.1:8902").replace(/\/$/, "");
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

// ═══════════════════════════════════════════════════════════════════════════
//  agent_search + agent_train — fleet self-training via manifest injection
// ═══════════════════════════════════════════════════════════════════════════
//
//  Two-step "express training" flow:
//    1. agent_search(mission)  → ranked shortlist of agent candidates,
//                                each with a *fit summary* explaining
//                                where the match is strong and where it
//                                isn't (decision-aid, not just a score).
//    2. agent_train(id)        → returns the full markdown manifest of
//                                the chosen agent, framed by an
//                                activation banner + exit criteria so
//                                the calling agent has clear "in/out"
//                                signals.
//
//  Both tools read the same `context` rows seeded by `scripts/seed.py`
//  under the key prefix `agent/`. The store layout matches:
//    key     = "agent/<id>"
//    content = JSON { id, source, content }   // content = raw markdown
//
//  No new dependencies; no remote calls. Vector embeddings are not yet
//  produced for agents — keyword scoring with title/intro boosting is
//  used here, easy to swap to cosine-similarity once `agent_vectors`
//  exists (mirrors the `skills_recall` semantic path).

interface AgentRow {
  key:     string;
  id:      string;
  content: string; // raw markdown
  source:  string;
}

function parseAgentRow(key: string, raw: string): AgentRow | null {
  try {
    const obj = JSON.parse(raw) as { id?: string; content?: string; source?: string };
    if (typeof obj.content !== "string") return null;
    return {
      key,
      id:      obj.id     ?? key.replace(/^agent\//, ""),
      content: obj.content,
      source:  obj.source ?? "",
    };
  } catch {
    // Tolerate non-JSON content (older seeds may store the markdown directly).
    return { key, id: key.replace(/^agent\//, ""), content: raw, source: "" };
  }
}

function agentSummary(content: string): { title: string; intro: string } {
  const lines = content.split(/\r?\n/);
  let title = "";
  let intro = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!title && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (title && line && !line.startsWith("#") && !intro) {
      intro = line.slice(0, 240);
      break;
    }
  }
  if (!title) title = (lines[0] ?? "").slice(0, 120).trim();
  return { title, intro };
}

function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

server.tool(
  "agent_search",
  "Searches the bundled agent library (data/agents) and returns a ranked shortlist with a fit summary for each candidate. Use before agent_train when you want to pick a manifest yourself instead of accepting the top match blindly.",
  {
    mission: z.string().min(1).describe("Free-form description of what you're about to do — keywords, the briefing message, or both."),
    limit:   z.number().int().positive().optional().describe("Max candidates to return (default 5)."),
  },
  async (args) => {
    try {
      const db    = getStore();
      const limit = Math.min(args.limit ?? 5, 20);

      const rows = db.prepare(
        "SELECT key, content FROM context WHERE key LIKE 'agent/%' ORDER BY updated_at DESC LIMIT 5000"
      ).all() as { key: string; content: string }[];

      if (rows.length === 0) {
        return ok({
          mission:     args.mission,
          resultCount: 0,
          results:     [],
          tip: "Agent library empty — run `python3 scripts/seed.py --agents-only` to seed data/agents into ~/.ubik-mcp/skills.db.",
        });
      }

      const terms = tokenize(args.mission);
      if (terms.length === 0) {
        return ok({
          mission:     args.mission,
          resultCount: 0,
          results:     [],
          tip: "Mission text yielded no usable keywords (≥3 chars). Be more verbose.",
        });
      }

      type Hit = {
        key:     string;
        id:      string;
        title:   string;
        intro:   string;
        score:   number;
        matched_terms: string[];
        missing_terms: string[];
        title_hits: number;
        body_hits: number;
        size:    number;
        fit_summary: string;
      };

      const hits: Hit[] = [];
      for (const row of rows) {
        const ag = parseAgentRow(row.key, row.content);
        if (!ag) continue;
        const sum   = agentSummary(ag.content);
        const lcAll = (sum.title + " " + ag.id + " " + ag.content).toLowerCase();
        const lcTitle = (sum.title + " " + ag.id).toLowerCase();

        let titleHits = 0;
        let bodyHits  = 0;
        const matched: string[] = [];
        const missing: string[] = [];
        for (const t of terms) {
          if (lcTitle.includes(t)) {
            titleHits++;
            matched.push(t);
          } else if (lcAll.includes(t)) {
            bodyHits++;
            matched.push(t);
          } else {
            missing.push(t);
          }
        }
        if (titleHits + bodyHits === 0) continue;

        // Score: title hits weighted ×3, body hits ×1.
        // Coverage bonus when all terms matched (×1.5).
        const base     = titleHits * 3 + bodyHits;
        const coverage = matched.length === terms.length ? 1.5 : 1.0;
        const score    = base * coverage;

        const summary =
          missing.length === 0
            ? `Strong match (${titleHits} term${titleHits === 1 ? "" : "s"} in title/id, ${bodyHits} in body) — covers every keyword.`
            : titleHits > 0
              ? `Partial match (${titleHits} title hit${titleHits === 1 ? "" : "s"}, missing: ${missing.join(", ")}) — fits the topic but doesn't cover ${missing.length} term${missing.length === 1 ? "" : "s"}.`
              : `Loose match (body-only, missing: ${missing.join(", ")}) — same vocabulary, different focus.`;

        hits.push({
          key:           ag.key,
          id:            ag.id,
          title:         sum.title,
          intro:         sum.intro,
          score,
          matched_terms: matched,
          missing_terms: missing,
          title_hits:    titleHits,
          body_hits:     bodyHits,
          size:          ag.content.length,
          fit_summary:   summary,
        });
      }

      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, limit);

      return ok({
        mission:     args.mission,
        resultCount: top.length,
        candidates:  rows.length,
        terms,
        results:     top.map(({ score: _s, ...h }) => h),
        next_step: top.length > 0
          ? `Pick an id and call agent_train(id="${top[0].id}") to inject the full manifest. Use agent_search again with different keywords if none of these fit.`
          : "No candidate matched. Reformulate your mission with more domain words, or fall back to skills_recall for persona-only enrichment.",
      });
    } catch (err) { return fail(err); }
  },
);

server.tool(
  "agent_train",
  "Loads the full markdown manifest of a bundled agent and returns it framed by an activation banner + exit criteria. The calling agent should treat the manifest as 'who I am for this mission' and follow the workflow until the exit criteria fire.",
  {
    id:      z.string().min(1).describe("Agent id (slug, no extension), as returned by agent_search."),
    mission: z.string().optional().describe("Optional one-line description of the calling mission, echoed in the activation banner for traceability."),
  },
  async (args) => {
    try {
      const db = getStore();
      const key = args.id.startsWith("agent/") ? args.id : `agent/${args.id}`;
      const row = db.prepare("SELECT key, content FROM context WHERE key = ?").get(key) as
        | { key: string; content: string }
        | undefined;

      if (!row) {
        return ok({
          found: false,
          requested_id: args.id,
          tip: `No agent with id "${args.id}". Use agent_search first to discover available ids.`,
        });
      }

      const ag  = parseAgentRow(row.key, row.content);
      if (!ag) {
        return fail(new Error(`Agent ${args.id} payload is malformed (cannot parse).`));
      }
      const sum = agentSummary(ag.content);

      const banner =
        `🧠 **Agent activation — ${sum.title || ag.id}**\n` +
        (args.mission ? `Mission: ${args.mission.slice(0, 200)}\n` : "") +
        `From now on you operate under this manifest. Follow the workflow it ` +
        `prescribes; when in doubt, prefer the manifest over your default ` +
        `behaviour.\n` +
        `\n--- MANIFEST BEGIN ---\n`;

      const exit =
        `\n--- MANIFEST END ---\n\n` +
        `🚪 **Exit criteria** (release the persona when any of these are true):\n` +
        `  - the mission output is delivered (PR, report, decision posted);\n` +
        `  - the conversation drifts to an unrelated domain for ≥ 2 turns;\n` +
        `  - the user/operator explicitly retags you with a different role.\n` +
        `\nUntil one of those fires, stay in character.\n`;

      return ok({
        found:        true,
        id:           ag.id,
        title:        sum.title,
        size_chars:   ag.content.length,
        source:       ag.source,
        activation:   banner + ag.content + exit,
        raw_manifest: ag.content,
      });
    } catch (err) { return fail(err); }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-skills] fatal: ${err}\n`);
  process.exit(1);
});
