#!/usr/bin/env node
/**
 * UBIK MCP Server — Local variant (no SSH tunnel).
 * Connects directly to the UBIK backend running on localhost:8765.
 * Drop-in replacement for mcp-ubik-ssh.ts when running on dev-station-02.
 */

import * as readline from "readline";

const UBIK_URL = process.env.UBIK_URL || "http://127.0.0.1:8765";
const UBIK_TOKEN = process.env.UBIK_API_KEY || "ubik";

// ─── UBIK API ───────────────────────────────────────────────────────────────

async function ubikFetch(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${UBIK_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "x-ubik-agent-token": UBIK_TOKEN,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`UBIK ${res.status}: ${text.substring(0, 300)}`);
  }

  return res.json();
}

async function listUbikTools(): Promise<unknown[]> {
  const data = await ubikFetch("/api/tools/discover") as { tools?: unknown[] };
  return data?.tools || [];
}

async function callUbikTool(name: string, args: unknown): Promise<unknown> {
  return ubikFetch("/api/tools/execute", { tool: name, input: args });
}

// ─── MCP Stdio Server (JSON-RPC 2.0) ────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });
let toolsCache: unknown[] | null = null;

function send(id: string | number | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", result, id }) + "\n");
}

function sendErr(id: string | number | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }) + "\n");
}

async function handle(raw: string): Promise<void> {
  let msg: { method: string; params?: Record<string, unknown>; id?: string | number | null };
  try { msg = JSON.parse(raw); } catch { return; }

  const { method, params, id = null } = msg;

  switch (method) {
    case "initialize":
      send(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ubik-mcp-local", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list": {
      try {
        if (!toolsCache) {
          const tools = await listUbikTools();
          toolsCache = (tools as Array<{ name: string; description?: string; inputSchema?: unknown }>).map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          }));
          console.error(`[ubik-mcp-local] ${toolsCache.length} tools discovered from ${UBIK_URL}`);
        }
        send(id, { tools: toolsCache });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ubik-mcp-local] Tool discovery failed: ${message}`);
        send(id, { tools: [] });
      }
      break;
    }

    case "tools/call": {
      try {
        const toolName = params?.name as string;
        const toolArgs = params?.arguments || {};
        const result = await callUbikTool(toolName, toolArgs) as { result?: unknown };
        const text = result?.result
          ? (typeof result.result === "string" ? result.result : JSON.stringify(result.result))
          : JSON.stringify(result);
        send(id, { content: [{ type: "text", text }] });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendErr(id, -32000, `Tool call failed: ${message}`);
      }
      break;
    }

    default:
      if (id !== null) sendErr(id, -32601, `Method not found: ${method}`);
  }
}

let pending = 0;
let closed = false;

rl.on("line", (line) => {
  pending++;
  handle(line)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ubik-mcp-local] Error: ${message}`);
    })
    .finally(() => {
      pending--;
      if (closed && pending === 0) process.exit(0);
    });
});

rl.on("close", () => {
  closed = true;
  if (pending === 0) process.exit(0);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
