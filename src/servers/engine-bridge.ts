#!/usr/bin/env node
/**
 * UBIK Engine Bridge — MCP stdio server proxying ENGINE :8801 native tools.
 *
 * Exposes selected ENGINE Python modules (devops, git, review, media, formation)
 * as MCP tools via the gateway, routed through POST /v1/tools/call.
 *
 * Schemas are loaded from ../data/engine-bridge-schemas.json (dumped from
 * ~/.ubik-engine/data.db on 2026-05-28). Re-run the dump script after adding
 * tools to mcp_devops / mcp_git / mcp_review / mcp_media / mcp_formation.
 *
 * No filtering beyond the source modules — the dump itself constrains the set.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMcpServer, runServer } from "../lib/server.js";

const ENGINE_BASE = process.env.UBIK_ENGINE_URL || "http://127.0.0.1:8801";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_PATH = join(__dirname, "..", "..", "data", "engine-bridge-schemas.json");

type ToolSpec = {
  module: string;
  name: string;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
};

const schemas: ToolSpec[] = JSON.parse(readFileSync(SCHEMAS_PATH, "utf8"));

async function callEngine(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${ENGINE_BASE}/v1/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ENGINE ${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && "result" in j) return j.result;
    return j;
  } catch {
    return text;
  }
}

const server = createMcpServer("ubik-engine-bridge");

const seen = new Set<string>();
for (const s of schemas) {
  if (seen.has(s.name)) continue;
  seen.add(s.name);

  const props = (s.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const required = new Set(s.inputSchema?.required ?? []);

  const shape: Record<string, any> = {};
  for (const [key, raw] of Object.entries(props)) {
    const def = raw as { type?: string; description?: string };
    let zod: any;
    switch (def?.type) {
      case "string":  zod = z_string();  break;
      case "number":
      case "integer": zod = z_number();  break;
      case "boolean": zod = z_boolean(); break;
      case "array":   zod = z_array();   break;
      case "object":  zod = z_object_any(); break;
      default:        zod = z_any();
    }
    if (def?.description) zod = zod.describe(def.description);
    if (!required.has(key)) zod = zod.optional();
    shape[key] = zod;
  }

  server.tool(
    s.name,
    `[${s.module}] ${s.description}`.slice(0, 1000),
    shape,
    async (args: Record<string, unknown>) => {
      try {
        const result = await callEngine(s.name, args);
        const text =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

import { z } from "zod";
function z_string()     { return z.string(); }
function z_number()     { return z.number(); }
function z_boolean()    { return z.boolean(); }
function z_array()      { return z.array(z.any()); }
function z_object_any() { return z.record(z.any()); }
function z_any()        { return z.any(); }

process.stderr.write(`[ubik-engine-bridge] registered ${seen.size} tools\n`);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-engine-bridge] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
