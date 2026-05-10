#!/usr/bin/env node
/**
 * ubik-mcp HTTP gateway
 *
 * Spawns each stdio MCP server in src/servers/ as a subprocess, agrégates
 * their tools through MCP Client + StdioClientTransport, and re-exposes the
 * union via an SSE-backed McpServer on http://127.0.0.1:8902.
 *
 * Routes:
 *   GET /health   — JSON status (servers connected, tools count, uptime)
 *   GET /mcp      — SSE endpoint for MCP clients
 *   POST /mcp     — message endpoint (paired with the SSE session)
 *
 * No dependency on UBIK-RELEASE. Imports limited to @modelcontextprotocol/sdk,
 * dotenv, and node built-ins.
 */
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { jsonSchemaToZodShape } from "./lib/jsonschema-to-zod";

config({ path: path.join(process.cwd(), ".env") });

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const HOST = process.env.UBIK_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.UBIK_GATEWAY_PORT || 8902);

const STARTED_AT = Date.now();

// ── Logging helper ───────────────────────────────────────────────────────────
//  All gateway logs go through `log()` so they share a consistent shape:
//    [<ISO timestamp>] [gateway] [<level>] <message>
//  Levels: info | warn | error. No logic — just structure.
type LogLevel = "info" | "warn" | "error";
function log(level: LogLevel, msg: string): void {
  const stamp = new Date().toISOString();
  process.stderr.write(`[${stamp}] [gateway] [${level}] ${msg}\n`);
}
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack && process.env.UBIK_DEBUG ? err.stack : `${err.name}: ${err.message}`;
  }
  return String(err);
}

interface UpstreamServer {
  name:    string;
  command: string;
  args:    string[];
  client?: Client;
  tools:   Array<{ name: string; description?: string; inputSchema?: unknown }>;
  error?:  string;
}

// Resolve absolute paths to subprocess servers. tsx is invoked so .ts files
// can be run without a separate compile step (matches package.json scripts).
const SERVERS: UpstreamServer[] = [
  { name: "skills",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "skills.ts")],    tools: [] },
  { name: "system",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "system.ts")],    tools: [] },
  { name: "crawl",     command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "crawl.ts")],     tools: [] },
  { name: "review",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "review.ts")],    tools: [] },
  { name: "formation", command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "formation.ts")], tools: [] },
  { name: "github",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "github.ts")],    tools: [] },
  { name: "google",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "google.ts")],    tools: [] },
  { name: "linkedin",  command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "linkedin.ts")],  tools: [] },
  { name: "microsoft", command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "microsoft.ts")], tools: [] },
  { name: "desktop",   command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "desktop.ts")],   tools: [] },
  { name: "gps",       command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "gps.ts")],       tools: [] },
];

async function connectUpstream(srv: UpstreamServer): Promise<void> {
  try {
    const transport = new StdioClientTransport({
      command: srv.command,
      args:    srv.args,
      env:     { ...process.env } as Record<string, string>,
      stderr:  "pipe",
    });
    const client = new Client(
      { name: `ubik-gateway-client/${srv.name}`, version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const list = await client.listTools();
    srv.client = client;
    srv.tools  = (list.tools ?? []).map((t) => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    log("info", `upstream "${srv.name}" connected — ${srv.tools.length} tool(s)`);
  } catch (err) {
    srv.error = err instanceof Error ? err.message : String(err);
    log("error", `upstream "${srv.name}" failed to connect: ${describeError(err)}`);
  }
}

function buildAggregator(): McpServer {
  const agg = new McpServer({ name: "ubik-mcp-gateway", version: "1.0.0" });

  for (const srv of SERVERS) {
    if (!srv.client) continue;
    for (const tool of srv.tools) {
      const exposedName = `${srv.name}.${tool.name}`;
      // Forward the upstream tool's input schema so clients see real param
      // requirements — and so the MCP SDK doesn't strip args before they
      // reach the handler. An empty shape would advertise no params AND
      // reject every property under strict validation, breaking any tool
      // that requires arguments (gps_lookup, github_*, gmail_*, …). The
      // handler still routes raw args to upstream.callTool.
      const shape = jsonSchemaToZodShape(tool.inputSchema);
      agg.tool(
        exposedName,
        tool.description || `Routed to ${srv.name}.${tool.name}`,
        shape,
        async (args: Record<string, unknown>) => {
          if (!srv.client) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `upstream ${srv.name} not connected` }) }], isError: true };
          }
          try {
            const result = await srv.client.callTool({ name: tool.name, arguments: args });
            return {
              content: (result.content as { type: "text"; text: string }[]) ?? [],
              isError: !!result.isError,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
          }
        },
      );
    }
  }

  return agg;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

interface SseSession {
  transport: SSEServerTransport;
}

const sessions = new Map<string, SseSession>();
let aggServer: McpServer | null = null;

function healthPayload() {
  return {
    ok:        true,
    version:   "1.0.0",
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    upstreams: SERVERS.map((s) => ({
      name:       s.name,
      connected:  !!s.client,
      toolCount:  s.tools.length,
      error:      s.error ?? null,
    })),
    totalTools: SERVERS.reduce((acc, s) => acc + (s.client ? s.tools.length : 0), 0),
    sessions:   sessions.size,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, healthPayload());
    return;
  }

  if (req.method === "GET" && url.pathname === "/tools") {
    const tools = SERVERS.flatMap((s) =>
      s.client
        ? s.tools.map((t) => ({ server: s.name, name: t.name, description: t.description ?? "" }))
        : []
    );
    sendJson(res, 200, { totalTools: tools.length, tools });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tools/call") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { tool, args } = JSON.parse(body) as { tool: string; args: Record<string, unknown> };
        const srv = SERVERS.find((s) => s.client && s.tools.some((t) => t.name === tool));
        if (!srv?.client) { sendJson(res, 404, { ok: false, error: `tool not found: ${tool}` }); return; }
        const result = await srv.client.callTool({ name: tool, arguments: args ?? {} });
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: describeError(err) });
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/mcp") {
    if (!aggServer) {
      sendJson(res, 503, { ok: false, error: "aggregator not ready" });
      return;
    }
    const transport = new SSEServerTransport("/mcp", res);
    sessions.set(transport.sessionId, { transport });
    log("info", `SSE session opened (sessionId=${transport.sessionId}, total=${sessions.size})`);
    transport.onclose = () => {
      sessions.delete(transport.sessionId);
      log("info", `SSE session closed (sessionId=${transport.sessionId}, remaining=${sessions.size})`);
    };
    try {
      await aggServer.connect(transport);
    } catch (err) {
      log("error", `SSE connect failed (sessionId=${transport.sessionId}): ${describeError(err)}`);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) { sendJson(res, 400, { ok: false, error: "missing sessionId" }); return; }
    const session = sessions.get(sessionId);
    if (!session) { sendJson(res, 404, { ok: false, error: "session not found" }); return; }
    try {
      await session.transport.handlePostMessage(req, res);
    } catch (err) {
      log("error", `SSE post failed (sessionId=${sessionId}): ${describeError(err)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "post handler failed" });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${url.pathname}` });
}

async function main(): Promise<void> {
  log("info", `starting on http://${HOST}:${PORT} (pid=${process.pid}, node=${process.version})`);
  log("info", `connecting ${SERVERS.length} upstream server(s) in parallel…`);
  await Promise.all(SERVERS.map(connectUpstream));

  const connected = SERVERS.filter((s) => s.client);
  const failed    = SERVERS.filter((s) => !s.client);
  log("info", `upstream connect summary: ${connected.length} ok, ${failed.length} failed` +
              (failed.length > 0 ? ` (failed: ${failed.map((s) => s.name).join(", ")})` : ""));

  aggServer = buildAggregator();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log("error", `unhandled request error (${req.method} ${req.url}): ${describeError(err)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal" });
    });
  });

  server.listen(PORT, HOST, () => {
    const total = SERVERS.reduce((acc, s) => acc + (s.client ? s.tools.length : 0), 0);
    const breakdown = connected
      .map((s) => `${s.name}=${s.tools.length}`)
      .join(" ");
    log("info", `ready on http://${HOST}:${PORT} — ${total} aggregated tool(s) across ${connected.length} upstream(s) [${breakdown}]`);
  });

  const shutdown = async (signal: string) => {
    log("info", `shutdown requested (signal=${signal}), closing ${SERVERS.length} upstream(s)`);
    for (const srv of SERVERS) {
      try { await srv.client?.close(); } catch { /* ignore */ }
    }
    server.close(() => {
      log("info", "shutdown complete, exiting");
      process.exit(0);
    });
    setTimeout(() => {
      log("warn", "shutdown timeout (3s) — forcing exit");
      process.exit(1);
    }, 3000).unref();
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log("error", `fatal: ${describeError(err)}`);
  process.exit(1);
});
