#!/usr/bin/env node
/**
 * skills MCP server — local SQLite-backed context + read-only DB inspection.
 *
 * Tools (6):
 *   file_outline        — structural outline of a source file (functions, classes, exports).
 *   save_context        — persist a (key, content) pair in the local SQLite store.
 *   read_context        — read content for a key from the local store.
 *   list_context        — list keys, optionally filtered by prefix.
 *   read_database       — run a read-only SELECT against an external SQLite file.
 *   analyze_db_schema   — list tables + columns of an external SQLite file.
 *
 * Storage: ~/.ubik-mcp/skills.db (created on first save_context).
 * No dependency on UBIK-RELEASE. Imports limited to @modelcontextprotocol/sdk,
 * zod, dotenv, better-sqlite3, and node built-ins.
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

let _store: Database.Database | null = null;

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
  _store = db;
  return db;
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

// ─── file_outline ────────────────────────────────────────────────────────────
server.tool(
  "file_outline",
  "Return a structural outline of a source file: top-level functions, classes, exports, and import lines. Heuristic regex-based — best on JS/TS/Python/Go.",
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
        /^\s*def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:/,        // python
        /^\s*func\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/,           // go
      ];
      const classPatterns: RegExp[] = [
        /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
        /^\s*class\s+([A-Za-z_][\w]*)/,                        // python (already covered)
        /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/,              // go
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

// ─── save_context ────────────────────────────────────────────────────────────
server.tool(
  "save_context",
  "Persist a (key, content) pair in the local SQLite context store. Upsert — replaces existing key.",
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

// ─── read_context ────────────────────────────────────────────────────────────
server.tool(
  "read_context",
  "Read content for a key from the local SQLite context store.",
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

// ─── list_context ────────────────────────────────────────────────────────────
server.tool(
  "list_context",
  "List keys in the local SQLite context store, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Optional prefix filter (matches at start of key)"),
    limit:  z.number().int().positive().optional().describe("Max entries (default 100)"),
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

// ─── read_database ───────────────────────────────────────────────────────────
server.tool(
  "read_database",
  "Run a read-only SELECT against an external SQLite file. Refuses any non-SELECT statement.",
  {
    path:  z.string().describe("Absolute path to the SQLite database file"),
    query: z.string().describe("SQL query (SELECT only)"),
    params: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe("Bound parameters"),
    limit:  z.number().int().positive().optional().describe("Hard cap on rows returned (default 200)"),
  },
  async (args) => {
    try {
      const trimmed = args.query.trim().replace(/;+\s*$/, "");
      if (!/^select\b/i.test(trimmed)) {
        return fail(new Error("read_database refuses non-SELECT statements"));
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

// ─── analyze_db_schema ───────────────────────────────────────────────────────
server.tool(
  "analyze_db_schema",
  "List tables, columns, and indexes of an external SQLite file. Read-only.",
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
          const columns = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: unknown;
            pk: number;
          }>;
          const indexes = db.prepare(`PRAGMA index_list(${t.name})`).all() as Array<{
            name: string;
            unique: number;
          }>;
          let rowCount: number | null = null;
          try {
            const r = db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get() as { c: number } | undefined;
            rowCount = r?.c ?? null;
          } catch { /* table unreadable */ }
          return { table: t.name, columns, indexes, rowCount };
        });

        return ok({ path: args.path, tableCount: result.length, schema: result });
      } finally {
        db.close();
      }
    } catch (err) { return fail(err); }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-skills] fatal: ${err}\n`);
  process.exit(1);
});
