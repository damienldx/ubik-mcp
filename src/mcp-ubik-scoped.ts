#!/usr/bin/env tsx
/**
 * mcp-ubik-scoped.ts — Phase 3 POC (plan_af2a4e47): per-agent, role-scoped STDIO
 * gateway proxy. CLIENT-ONLY: consumes the shared :8902 union gateway as a
 * read-only MCP client (one extra session, like any consumer) and re-exposes a
 * ROLE-FILTERED tools/list over stdio. It NEVER modifies the :8902 server
 * (gateway.ts / http-server.ts untouched) — so zero cross-vehicle blast radius
 * (Primus's :8902 stays byte-identical for everyone else).
 *
 * A fleet slot mounts THIS as its `ubik` MCP server (command:tsx, args:[this],
 * env:{UBIK_GATEWAY_ROLE|UBIK_ROLE, UBIK_GATEWAY_SCOPE_FILE}) instead of the
 * remote http gateway — a deployment step OUTSIDE this POC (console_meca/Oscar).
 *
 * OPT-IN scoping (Primus gate: header/role-absent = no-op):
 *   • no role AND no scope file → perimeter inactive → tools/list = FULL union
 *     (identity passthrough, today's behaviour byte-identical).
 *   • role set (or scope file with [gateway]) → filter the union to the role's
 *     perimeter (see scoped-filter.ts). tools/call is always forwarded verbatim.
 */
import * as readline from "node:readline";
import * as fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolvePerimeter, filterTools } from "./scoped-filter.js";

const GW_URL = process.env.UBIK_GATEWAY_URL || "http://127.0.0.1:8902/mcp";
const ROLE = (process.env.UBIK_GATEWAY_ROLE || process.env.UBIK_ROLE || "").trim();

// Scope file : explicite (UBIK_GATEWAY_SCOPE_FILE) sinon DÉRIVÉ PAR CONVENTION du
// rôle depuis la table role-bundles/ (SOURCE UNIQUE, la même que console_meca/M1).
// Rend le proxy data-driven pour N rôles : console_meca n'a qu'à fournir UBIK_GATEWAY_ROLE,
// le chemin du tools.scope suit la convention role-bundles/<role>/tools.scope.
function resolveScopeFile(): string | undefined {
  const explicit = (process.env.UBIK_GATEWAY_SCOPE_FILE || "").trim();
  if (explicit) return explicit;
  if (!ROLE) return undefined;
  const home = process.env.HOME || "";
  const conv = `${home}/.ubik-memory/role-bundles/${ROLE}/tools.scope`;
  try { return fs.existsSync(conv) ? conv : undefined; } catch { return undefined; }
}
const SCOPE_FILE = resolveScopeFile();

type Tool = { name: string; description?: string; inputSchema?: unknown };

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// ── Upstream (read-only client to the shared :8902 union) ────────────────────
let upstream: Client | null = null;
let unionCache: Tool[] | null = null;

async function getUpstream(): Promise<Client> {
  if (upstream) return upstream;
  const c = new Client({ name: "ubik-mcp-scoped", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(GW_URL)));
  upstream = c;
  return c;
}

async function getUnion(): Promise<Tool[]> {
  if (unionCache) return unionCache;
  const c = await getUpstream();
  unionCache = ((await c.listTools()).tools ?? []) as Tool[];
  console.error(`[ubik-mcp-scoped] union ${unionCache.length} tools from ${GW_URL}`);
  return unionCache;
}

// ── stdio JSON-RPC 2.0 (manual, same shape as mcp-ubik-local.ts) ─────────────
const rl = readline.createInterface({ input: process.stdin });

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
        serverInfo: { name: "ubik-mcp-scoped", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list": {
      try {
        const union = await getUnion();
        const perimeter = resolvePerimeter(ROLE, SCOPE_FILE, readFileSafe);
        const tools = filterTools(union, perimeter);
        if (perimeter.active) {
          console.error(`[ubik-mcp-scoped] role=${ROLE || "?"} scoped ${union.length}→${tools.length} tools`);
        }
        send(id, { tools });
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[ubik-mcp-scoped] tools/list failed: ${m}`);
        send(id, { tools: [] });
      }
      break;
    }

    case "tools/call": {
      try {
        const name = params?.name as string;
        const args = (params?.arguments as Record<string, unknown>) || {};
        const c = await getUpstream();
        const result = await c.callTool({ name, arguments: args });
        send(id, { content: result.content ?? [], isError: !!result.isError });
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        sendErr(id, -32000, `Tool call failed: ${m}`);
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
    .catch((err: unknown) => console.error(`[ubik-mcp-scoped] ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { pending--; if (closed && pending === 0) process.exit(0); });
});
rl.on("close", () => { closed = true; if (pending === 0) process.exit(0); });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
