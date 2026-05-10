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

// ─── Agent vectors + manifest parsing ────────────────────────────────────────
//
// Agents are seeded by scripts/seed.py under keys `agent/<id>` with content
// JSON `{id, source, content (raw .md text)}`. We index a separate row per
// agent in the same `skill_vectors` table — the table doesn't care about the
// key prefix, so the vector store is shared but lookups stay scoped.

async function seedAgentVectorsIfEmpty(): Promise<void> {
  const db = getStore();
  // Count agents already vectorised vs total agents in context.
  const vecRow   = db.prepare("SELECT COUNT(*) AS n FROM skill_vectors WHERE key LIKE 'agent/%'").get() as { n: number };
  const totalRow = db.prepare("SELECT COUNT(*) AS n FROM context WHERE key LIKE 'agent/%'").get() as { n: number };
  if (vecRow.n >= totalRow.n && totalRow.n > 0) return;

  const embedder = await loadEmbedder();
  if (!embedder) return;

  const agents = db.prepare("SELECT key, content FROM context WHERE key LIKE 'agent/%'")
    .all() as { key: string; content: string }[];
  if (agents.length === 0) return;

  process.stderr.write(`[ubik-skills] generating vectors for ${agents.length} agents...\n`);

  const insert     = db.prepare("INSERT OR REPLACE INTO skill_vectors (key, vec) VALUES (?, ?)");
  const batchWrite = db.transaction((rows: Array<{ key: string; vec: Buffer }>) => {
    for (const r of rows) insert.run(r.key, r.vec);
  });

  const BATCH = 64;
  for (let i = 0; i < agents.length; i += BATCH) {
    const chunk = agents.slice(i, i + BATCH);
    const rows: Array<{ key: string; vec: Buffer }> = [];
    for (const a of chunk) {
      try {
        const parsed   = parseAgentContent(a.content);
        const manifest = parseAgentManifest(parsed.raw);
        const text     = [
          manifest.id ?? "",
          manifest.name ?? "",
          manifest.role ?? "",
          manifest.description ?? "",
          (manifest.tags ?? []).join(" "),
          manifest.body_excerpt,
        ].join(" ").trim();
        const vec = await embedText(text);
        if (vec) rows.push({ key: a.key, vec: Buffer.from(vec.buffer) });
      } catch { /**/ }
    }
    if (rows.length) batchWrite(rows);
    if (i % (BATCH * 8) === 0 && i > 0) {
      process.stderr.write(`[ubik-skills] agent vectors: ${i}/${agents.length}\n`);
    }
  }
  process.stderr.write(`[ubik-skills] agent vector seed complete (${agents.length} agents)\n`);
}

interface AgentManifest {
  id?:           string;
  name?:         string;
  role?:         string;
  autonomy?:     string;
  description?:  string;
  reports_to?:   string;
  tools_engine?: string[];
  tools_client?: string[];
  guardrails?:   Record<string, unknown>;
  runtime?:      Record<string, unknown>;
  metadata?:     Record<string, unknown>;
  tags?:         string[];
  body_markdown: string;
  body_excerpt:  string;          // first ~200 chars of body
  raw:           string;          // full .md content
}

function parseAgentContent(content: string): { id: string; raw: string } {
  try {
    const obj = JSON.parse(content) as { id?: string; content?: string; source?: string };
    return { id: obj.id ?? "", raw: obj.content ?? "" };
  } catch {
    return { id: "", raw: content };
  }
}

/** Minimal YAML frontmatter parser for agent .md files — no external dep.
 *  Handles flat key:value, nested 1-level (tools: \n   engine: [...]),
 *  inline JSON arrays/objects, and the body after the closing `---`. */
function parseAgentManifest(rawMd: string): AgentManifest {
  const result: AgentManifest = { body_markdown: rawMd, body_excerpt: "", raw: rawMd };
  if (!rawMd.startsWith("---")) {
    result.body_excerpt = rawMd.slice(0, 200).trim();
    return result;
  }
  const closeIdx = rawMd.indexOf("\n---", 4);
  if (closeIdx < 0) {
    result.body_excerpt = rawMd.slice(0, 200).trim();
    return result;
  }
  const fmText = rawMd.slice(4, closeIdx).trim();
  const body   = rawMd.slice(closeIdx + 4).trim();
  result.body_markdown = body;
  result.body_excerpt  = body.replace(/^#+\s*/, "").slice(0, 200).trim();

  // Walk the frontmatter line by line.
  const lines = fmText.split("\n");
  let currentKey: string | null = null;
  const nestedAcc: Record<string, Record<string, string>> = {};
  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let val   = trimmed.slice(colonIdx + 1).trim();

    if (indent === 0) {
      currentKey = key;
      if (val === "" || val === ">") {
        // multiline scalar (description: > then indented next lines)
        const collected: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const sub = lines[j];
          const subIndent = sub.match(/^(\s*)/)?.[1].length ?? 0;
          if (subIndent === 0 && sub.trim() !== "") break;
          collected.push(sub.trim());
        }
        val = collected.join(" ").trim();
      }
      assignManifestField(result, key, val);
    } else {
      // Nested under currentKey (e.g. tools.engine, guardrails.max_steps)
      if (!currentKey) continue;
      const bucket = nestedAcc[currentKey] ??= {};
      bucket[key] = val;
      // Apply nested accumulation immediately for the most useful cases:
      if (currentKey === "tools" && (key === "engine" || key === "client")) {
        const arr = parseInlineArray(val);
        if (key === "engine") result.tools_engine = arr;
        else                  result.tools_client = arr;
      }
    }
  }

  // Build guardrails / runtime / metadata from accumulated nested dicts
  if (nestedAcc.guardrails) {
    const g: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(nestedAcc.guardrails)) g[k] = parseInlineValue(v);
    result.guardrails = g;
  }
  if (nestedAcc.runtime) {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(nestedAcc.runtime)) r[k] = parseInlineValue(v);
    result.runtime = r;
  }
  if (nestedAcc.metadata) {
    const m: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(nestedAcc.metadata)) m[k] = parseInlineValue(v);
    result.metadata = m;
    // Tags often live under metadata.tags
    if (Array.isArray(m.tags)) result.tags = m.tags as string[];
  }
  return result;
}

function assignManifestField(m: AgentManifest, key: string, val: string): void {
  switch (key) {
    case "id":          m.id          = stripQuotes(val); break;
    case "name":        m.name        = stripQuotes(val); break;
    case "role":        m.role        = stripQuotes(val); break;
    case "autonomy":    m.autonomy    = stripQuotes(val); break;
    case "description": m.description = stripQuotes(val); break;
    case "reports_to":  m.reports_to  = stripQuotes(val); break;
    case "tags": {
      const arr = parseInlineArray(val);
      if (arr.length) m.tags = arr;
      break;
    }
    default: /* ignore */
  }
}

function stripQuotes(v: string): string {
  return v.replace(/^["']|["']$/g, "").trim();
}

function parseInlineArray(v: string): string[] {
  const trimmed = v.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /**/ }
    // fallback CSV inside [...]
    return trimmed.slice(1, -1).split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
  }
  // YAML flow array on a single line, e.g. "- foo, - bar" — best-effort
  return trimmed.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
}

function parseInlineValue(v: string): unknown {
  const t = v.trim();
  if (t === "true")  return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("[")) return parseInlineArray(t);
  return stripQuotes(t);
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
// Background: generate agent vectors so agent_search can run semantic mode.
seedAgentVectorsIfEmpty().catch(() => {});

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

// ─── agent_search ────────────────────────────────────────────────────────────
//
// Returns an enriched shortlist of agents matching a mission description.
// Each entry carries: id, name, role, autonomy, top_3_tools, brief excerpt
// and a score. The agent caller can pick one and invoke `agent_train(id)`
// without having to load every manifest first.

server.tool(
  "agent_search",
  "Searches the local agent library for personas matching a mission. Returns an enriched shortlist (id, name, role, autonomy, top_3_tools, excerpt, score). Pair with agent_train(id) to adopt the chosen agent's full manifest.",
  {
    mission: z.string().min(1).describe("Free-text description of what you're about to do, e.g. 'audit a Capacitor app for auth vulnerabilities'"),
    limit:   z.number().int().positive().max(20).optional().describe("Max shortlist entries (default 5)"),
  },
  async (args) => {
    try {
      const db    = getStore();
      const limit = args.limit ?? 5;

      type Hit = {
        key: string; id: string; name: string; role: string;
        autonomy: string; description: string;
        top_3_tools: string[]; brief: string; score: number;
      };

      function toHit(key: string, content: string, score: number): Hit {
        const parsed   = parseAgentContent(content);
        const manifest = parseAgentManifest(parsed.raw);
        const allTools = [
          ...(manifest.tools_engine ?? []),
          ...(manifest.tools_client ?? []),
        ];
        return {
          key,
          id:          manifest.id ?? parsed.id ?? key.replace(/^agent\//, ""),
          name:        manifest.name        ?? parsed.id ?? "(unnamed)",
          role:        manifest.role        ?? "",
          autonomy:    manifest.autonomy    ?? "",
          description: (manifest.description ?? "").slice(0, 280),
          top_3_tools: allTools.slice(0, 3),
          brief:       manifest.body_excerpt,
          score,
        };
      }

      // ── Semantic path ────────────────────────────────────────────────────
      const vecCount = (db.prepare("SELECT COUNT(*) AS n FROM skill_vectors WHERE key LIKE 'agent/%'")
                          .get() as { n: number }).n;
      if (vecCount > 0 && _embedderReady && _embedder) {
        const qvec = await embedText(args.mission);
        if (qvec) {
          const vecRows = db.prepare(
            "SELECT sv.key, sv.vec, c.content FROM skill_vectors sv JOIN context c ON c.key = sv.key WHERE sv.key LIKE 'agent/%'",
          ).all() as { key: string; vec: Buffer; content: string }[];

          const ranked = vecRows
            .map((r) => {
              const vec = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
              return { key: r.key, content: r.content, score: cosine(qvec, vec) };
            })
            .filter((r) => r.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

          const hits = ranked.map((r) => toHit(r.key, r.content, r.score));
          const recommendation = recommendTrainStrategy(hits);
          return ok({
            mission:           args.mission,
            mode:              "semantic",
            shortlist_count:   hits.length,
            shortlist:         hits,
            recommended_action: recommendation,
            tip: hits.length === 0
              ? "No agent matched semantically (cosine > 0.2). Try broader keywords."
              : "Pick one id and call agent_train(id) to adopt its full manifest.",
          });
        }
      }

      // ── Keyword fallback ─────────────────────────────────────────────────
      const rows = db.prepare(
        "SELECT key, content FROM context WHERE key LIKE 'agent/%' ORDER BY updated_at DESC LIMIT 4000",
      ).all() as { key: string; content: string }[];

      if (rows.length === 0) {
        return ok({
          mission: args.mission, mode: "keyword", shortlist_count: 0, shortlist: [],
          tip: "No agents in the library. Did you run scripts/seed.py?",
        });
      }

      const terms = args.mission.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
      const hits: Hit[] = [];
      for (const r of rows) {
        const parsed   = parseAgentContent(r.content);
        const manifest = parseAgentManifest(parsed.raw);
        const hay = [
          manifest.id ?? "", manifest.name ?? "", manifest.role ?? "",
          manifest.description ?? "", (manifest.tags ?? []).join(" "),
          manifest.body_excerpt,
        ].join(" ").toLowerCase();
        const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
        if (score === 0) continue;
        hits.push(toHit(r.key, r.content, score));
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, limit);
      return ok({
        mission:           args.mission,
        mode:              vecCount === 0 ? "keyword (vectors not ready yet)" : "keyword",
        shortlist_count:   top.length,
        shortlist:         top,
        recommended_action: recommendTrainStrategy(top),
        tip: top.length === 0
          ? "No keyword matches. Broaden your mission description."
          : "Pick one id and call agent_train(id).",
      });
    } catch (err) { return fail(err); }
  },
);

/** Heuristic recommendation: should the caller train_now (top-1 dominant)
 *  or skip_train (matches too weak / too tied)?
 *  - train_now      : top-1 score / sum top-3 ≥ 0.45 → clear signal
 *  - explore        : top-1 dominant but check second match too
 *  - skip_train     : weak signal — fall back to skill_recall instead */
function recommendTrainStrategy(hits: Array<{ score: number }>): string {
  if (hits.length === 0) return "skip_train";
  const total = hits.slice(0, 3).reduce((s, h) => s + h.score, 0);
  if (total <= 0) return "skip_train";
  const dominance = hits[0].score / total;
  if (dominance >= 0.45) return "train_now";
  if (dominance >= 0.30) return "explore";
  return "skip_train";
}

// ─── agent_train ─────────────────────────────────────────────────────────────
//
// Returns the full manifest of one agent — both structured (parsed
// frontmatter + body) and raw (.md content). The agent caller chooses
// whether to consume the structured fields or the raw markdown as a
// system_prompt extension.

server.tool(
  "agent_train",
  "Loads the full manifest of an agent by id. Returns structured fields (system_prompt, guardrails, tools.engine, tools.client) plus the raw .md content. Adopt this manifest as your operating context for the mission.",
  {
    id: z.string().min(1).describe("Agent id, e.g. 'orchestrateur-de-pipelines-ci-cd'. Use agent_search first if unknown."),
  },
  async ({ id }) => {
    try {
      const db  = getStore();
      const key = `agent/${id}`;
      const row = db.prepare("SELECT content FROM context WHERE key = ?").get(key) as { content: string } | undefined;
      if (!row) {
        return ok({
          ok: false, error: `Agent not found: ${id}`,
          hint: "Use agent_search(mission) to find a valid id.",
        });
      }

      const parsed   = parseAgentContent(row.content);
      const manifest = parseAgentManifest(parsed.raw);

      return ok({
        ok:   true,
        id:   manifest.id ?? parsed.id ?? id,
        adoption_instructions: [
          "1. Treat `system_prompt` as your additional persona prompt for this mission.",
          "2. Respect `guardrails` (max_steps, max_tokens, budget, forbidden_patterns) — these are operational bounds.",
          "3. Use `tools.engine` for code/infra actions, `tools.client` for UI/UX feedback.",
          "4. The `body_markdown` may carry a structured workflow (steps, checks, output schema) — follow it.",
        ],
        manifest: {
          id:           manifest.id,
          name:         manifest.name,
          role:         manifest.role,
          autonomy:     manifest.autonomy,
          description:  manifest.description,
          reports_to:   manifest.reports_to,
          tags:         manifest.tags ?? [],
          tools: {
            engine: manifest.tools_engine ?? [],
            client: manifest.tools_client ?? [],
          },
          guardrails:    manifest.guardrails ?? {},
          runtime:       manifest.runtime ?? {},
          metadata:      manifest.metadata ?? {},
          system_prompt: manifest.body_markdown,   // body of the .md = the persona
          body_excerpt:  manifest.body_excerpt,
        },
        raw: parsed.raw,
      });
    } catch (err) { return fail(err); }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-skills] fatal: ${err}\n`);
  process.exit(1);
});
